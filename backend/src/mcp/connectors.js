// @ts-check
// Connectors: MCP servers Mirabilis uses as a client. Stores them in connectors.json,
// keeps the enabled ones running and offers their tools to agent runs. The built-in
// This computer connector is always listed first and can be switched off, not removed.

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_VERSION } from '../version.js';
import { redact } from '../agent/auditLog.js';
import { isLocalHostUrl } from '../security.js';
import { hardenFile } from '../storage/securePaths.js';
import { buildCatalog, connectorFromPreset, findPreset } from './catalog.js';
import { createHttpClient, isEgressBlocked } from './httpClient.js';
import { augmentPath, buildChildEnv, createStdioClient, expandTilde, pathOf } from './stdioClient.js';

export const PROTOCOL_VERSION = '2025-06-18';
export const GO_DARK_ERROR = 'Blocked by Go Dark';
export const THIS_COMPUTER_ID = 'this-computer';

/** Mirabilis's own MCP server for this machine, run by the This computer connector. */
const MACHINE_SERVER = fileURLToPath(new URL('./machineServer.js', import.meta.url));
const STORE_FILE = 'connectors.json';
const LEGACY_FILE = 'mcp-servers.json';
const INIT_TIMEOUT_MS = 20_000;
/** The first npx or uvx run downloads the package before the server can answer. */
const FIRST_RUN_INIT_TIMEOUT_MS = 120_000;
const PACKAGE_RUNNERS = new Set(['npx', 'uvx', 'bunx', 'pnpx', 'pipx']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'deno', 'bun', 'ruby', 'sh', 'bash']);
const LIST_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;
const CREATE_WAIT_MS = 20_000;
/** A switch flip answers quickly; the list keeps polling while the state is starting. */
const TOGGLE_WAIT_MS = 5_000;
const BOOT_STAGGER_MS = 400;
const LOG_LINES = 300;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_CONNECTORS = 100;
const MAX_TOOLS = 500;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** @typedef {'allow'|'ask'|'off'} Permission */
/** @type {Permission[]} */
const PERMISSIONS = ['allow', 'ask', 'off'];

/**
 * @typedef {object} ConnectorRecord
 * @property {string} id
 * @property {string} name
 * @property {'stdio'|'http'} transport
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string>} env
 * @property {string} cwd
 * @property {string} url
 * @property {Record<string, string>} headers
 * @property {boolean} enabled
 * @property {Record<string, Permission>} tools
 * @property {Record<string, {title: string, description: string, readOnly: boolean}>} toolInfo  last tool list, so a stopped connector still shows its tools
 * @property {string|null} preset
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {{defaultPermission: Permission|null, allowedTools: string[]|null}} [importRules]  from mcp-servers.json, applied once tools are known
 * @property {boolean} [builtin]  ships with Mirabilis: command computed at every start, only switch and permissions saved
 */

/**
 * A connector that ships with Mirabilis.
 * @typedef {object} BuiltinConnector
 * @property {string} id
 * @property {string} name
 * @property {boolean} [enabled]  the switch on first start; on unless false
 * @property {() => {command: string, args: string[], env: Record<string, string>, cwd: string}} spawn  called at every start
 */

/**
 * @typedef {object} StoreContents
 * @property {ConnectorRecord[]} records  custom connectors
 * @property {Map<string, any>} builtins  saved entries of built-in connectors, by id
 */

/**
 * @typedef {object} LiveTool
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {boolean} readOnly
 * @property {any} inputSchema
 */

/**
 * @typedef {object} Runtime
 * @property {any} client
 * @property {'off'|'starting'|'ready'|'error'} state
 * @property {string|null} error
 * @property {boolean} goDarkBlocked  error came from Go Dark, so it clears itself when Go Dark goes off
 * @property {string|null} serverName
 * @property {string|null} serverVersion
 * @property {string|null} startedAt
 * @property {number|null} pid
 * @property {LiveTool[]} tools
 * @property {string[]} logs
 * @property {number[]} restarts
 * @property {number} generation  bumped on every start and stop, so late events from an old process are ignored
 * @property {Promise<void>|null} starting
 * @property {ReturnType<typeof setTimeout>|null} restartTimer
 * @property {ReturnType<typeof setTimeout>|null} refreshTimer
 */

/** An error carrying the HTTP status the router answers with. */
export class ConnectorError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = 'ConnectorError';
    this.status = status;
  }
}

/** @param {string} message */
const badRequest = (message) => new ConnectorError(400, message);
const notFound = () => new ConnectorError(404, 'Connector not found.');
const nowIso = () => new Date().toISOString();

/** @param {string} p */
function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} p */
function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} value */
function asString(value) {
  return typeof value === 'string' ? value : '';
}

/** @param {unknown} value @returns {Record<string, string>} */
function asStringMap(value) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** @param {unknown} value @returns {value is Permission} */
const isPermission = (value) => PERMISSIONS.includes(/** @type {Permission} */ (value));

/** Lowercase [a-z0-9_] with single underscores, so `__` only ever joins connector and tool. */
export function slug(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'x';
}

/**
 * Agent tool name for a connector tool, at most 60 characters.
 * @param {string} connectorName
 * @param {string} toolName
 */
export function toolKey(connectorName, toolName) {
  let conn = slug(connectorName);
  let tool = slug(toolName);
  if (conn.length + 2 + tool.length > 60) {
    conn = conn.slice(0, Math.max(12, 58 - tool.length)).replace(/_+$/, '') || 'x';
    tool = tool.slice(0, 58 - conn.length).replace(/_+$/, '') || 'x';
  }
  return `${conn}__${tool}`;
}

/** A URL safe to show: no user info, query values masked. */
function displayUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    for (const key of new Set(u.searchParams.keys())) u.searchParams.set(key, '***');
    return u.toString();
  } catch {
    return '';
  }
}

/** @param {string} raw */
function urlHasSecrets(raw) {
  try {
    const u = new URL(raw);
    return Boolean(u.username || u.password || u.search);
  } catch {
    return false;
  }
}

/** @param {string} raw */
function hostName(raw) {
  try {
    return new URL(raw).host;
  } catch {
    return '';
  }
}

/**
 * A readable default name for a custom local command.
 * @param {string} command
 * @param {string[]} args
 */
function defaultStdioName(command, args) {
  const base = path.basename(command).replace(/\.(exe|cmd|bat)$/i, '');
  const first = args.find((a) => !a.startsWith('-')) || '';
  let name = base;
  if (first && PACKAGE_RUNNERS.has(base.toLowerCase())) name = (first.split('/').pop() || first).replace(/@[^@]*$/, '');
  else if (first && INTERPRETERS.has(base.toLowerCase())) name = path.basename(first).replace(/\.[^.]+$/, '');
  return name.slice(0, 60) || 'Connector';
}

/** "npx -y pkg" typed into the command box: split on spaces, honoring quotes. */
function splitCommandLine(text) {
  /** @type {string[]} */
  const out = [];
  let current = '';
  let quote = '';
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

/** @param {unknown} value */
function cleanName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (name.length > 60) throw badRequest('Name must be 60 characters or fewer.');
  return name;
}

/** @param {unknown} value */
function cleanUrl(value) {
  const message = 'Enter the full URL of the server, starting with http:// or https://.';
  let parsed;
  try {
    parsed = new URL(String(value ?? '').trim());
  } catch {
    throw badRequest(message);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw badRequest(message);
  return parsed.toString();
}

/** @param {unknown} value */
function cleanArgs(value) {
  if (value == null || value === '') return [];
  /** @type {string[]} */
  let list;
  if (Array.isArray(value)) list = value.map((v) => String(v ?? ''));
  else if (typeof value === 'string') list = value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  else throw badRequest('Arguments must be a list of strings.');
  if (list.length > 100) throw badRequest('Use 100 arguments or fewer.');
  if (list.some((a) => a.length > 4000 || a.includes('\0'))) throw badRequest('An argument is too long or contains a null character.');
  return list;
}

/**
 * @param {unknown} value
 * @param {string} home
 */
function cleanCwd(value, home) {
  const cwd = String(value ?? '').trim();
  if (!cwd) return '';
  const full = path.resolve(home, expandTilde(cwd, home));
  if (!isDirectory(full)) throw badRequest(`Working folder not found: ${cwd}`);
  return cwd.startsWith('~') ? cwd : full;
}

/**
 * Env or header pairs from an object, an array of lines, or text with one per line.
 * A null value means "remove this key" when patching.
 * @param {unknown} value
 * @param {'env'|'headers'} kind
 * @returns {Record<string, string|null>}
 */
function readPairs(value, kind) {
  if (value == null || value === '') return {};
  const env = kind === 'env';
  /** @type {Record<string, string|null>} */
  const out = {};
  /** @param {string} line */
  const addLine = (line) => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return;
    // Names cannot hold the separator, so the first one ends the name.
    const at = env ? text.indexOf('=') : text.search(/[:=]/);
    if (at <= 0) throw badRequest(env ? `Write each variable as KEY=value: ${text.slice(0, 40)}` : `Write each header as Name: value: ${text.slice(0, 40)}`);
    out[text.slice(0, at).trim()] = text.slice(at + 1).trim();
  };
  if (typeof value === 'string') value.split(/\r?\n/).forEach(addLine);
  else if (Array.isArray(value)) value.forEach((v) => addLine(String(v ?? '')));
  else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) out[k] = v == null ? null : String(v);
  } else {
    throw badRequest(env ? 'Environment must be KEY=value pairs.' : 'Headers must be name and value pairs.');
  }
  const entries = Object.entries(out);
  if (entries.length > 100) throw badRequest(env ? 'Use 100 variables or fewer.' : 'Use 100 headers or fewer.');
  for (const [k, v] of entries) {
    if (!(env ? ENV_KEY_RE : HEADER_NAME_RE).test(k)) {
      throw badRequest(env ? `Not a valid variable name: ${k.slice(0, 40)}` : `Not a valid header name: ${k.slice(0, 40)}`);
    }
    if (v != null && (v.length > 8000 || (env ? /\0/ : /[\0\r\n]/).test(v))) {
      throw badRequest(`The value of ${k} is too long or contains a line break.`);
    }
  }
  return out;
}

/**
 * @param {Record<string, string>} base
 * @param {Record<string, string|null>} patch
 */
function mergePairs(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** @param {any} input */
function pickTransport(input) {
  const t = String(input.transport ?? '').trim().toLowerCase();
  if (['stdio', 'local', 'command'].includes(t)) return 'stdio';
  if (['http', 'streamable-http', 'remote', 'url'].includes(t)) return 'http';
  if (t) throw badRequest('Transport must be stdio (a local command) or http (a remote URL).');
  if (input.url && !input.command) return 'http';
  if (input.command) return 'stdio';
  throw badRequest('Enter a local command or a remote URL.');
}

/**
 * The stored shape of a custom connector, validated.
 * @param {any} input
 * @param {string} home
 */
function customDraft(input, home) {
  const transport = pickTransport(input);
  const name = cleanName(input.name);
  if (transport === 'http') {
    const url = cleanUrl(input.url);
    const headers = mergePairs({}, readPairs(input.headers, 'headers'));
    const token = String(input.bearerToken ?? input.token ?? '').trim();
    if (token) {
      if (/[\0\r\n]/.test(token) || token.length > 8000) throw badRequest('The token is too long or contains a line break.');
      headers.Authorization = /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
    }
    return { name: name || hostName(url) || 'Remote connector', transport, command: '', args: [], env: {}, cwd: '', url, headers };
  }
  let command = String(input.command ?? '').trim();
  let args = cleanArgs(input.args);
  if (!command) throw badRequest('Enter the command that starts the connector, for example npx.');
  if (/\s/.test(command) && args.length === 0 && !exists(path.resolve(home, expandTilde(command, home)))) {
    const parts = splitCommandLine(command);
    command = parts[0] || command;
    args = parts.slice(1);
  }
  const env = mergePairs({}, readPairs(input.env, 'env'));
  const cwd = cleanCwd(input.cwd, home);
  return { name: name || defaultStdioName(command, args), transport, command, args, env, cwd, url: '', headers: {} };
}

/** @param {any} raw @returns {ConnectorRecord|null} */
function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const transport = raw.transport === 'http' ? 'http' : raw.transport === 'stdio' ? 'stdio' : null;
  if (!transport) return null;
  /** @type {Record<string, Permission>} */
  const tools = {};
  for (const [name, perm] of Object.entries(raw.tools && typeof raw.tools === 'object' ? raw.tools : {})) {
    if (isPermission(perm)) tools[name] = perm;
  }
  /** @type {ConnectorRecord['toolInfo']} */
  const toolInfo = {};
  for (const [name, info] of Object.entries(raw.toolInfo && typeof raw.toolInfo === 'object' ? raw.toolInfo : {})) {
    if (!info || typeof info !== 'object') continue;
    toolInfo[name] = { title: asString(info.title) || name, description: asString(info.description), readOnly: info.readOnly === true };
  }
  const now = nowIso();
  /** @type {ConnectorRecord} */
  const record = {
    id: raw.id,
    name: (asString(raw.name).trim() || 'Connector').slice(0, 60),
    transport,
    command: asString(raw.command),
    args: Array.isArray(raw.args) ? raw.args.map((a) => String(a ?? '')) : [],
    env: asStringMap(raw.env),
    cwd: asString(raw.cwd),
    url: asString(raw.url),
    headers: asStringMap(raw.headers),
    enabled: raw.enabled !== false,
    tools,
    toolInfo,
    preset: typeof raw.preset === 'string' ? raw.preset : null,
    createdAt: asString(raw.createdAt) || now,
    updatedAt: asString(raw.updatedAt) || now
  };
  if (raw.importRules && typeof raw.importRules === 'object') {
    record.importRules = {
      defaultPermission: isPermission(raw.importRules.defaultPermission) ? raw.importRules.defaultPermission : null,
      allowedTools: Array.isArray(raw.importRules.allowedTools) ? raw.importRules.allowedTools.map(String) : null
    };
  }
  return record;
}

/**
 * This computer: the troubleshooting server in machineServer.js, run by the
 * backend's own runtime, so the desktop app needs no Node of its own.
 * @param {object} opts
 * @param {string} opts.dataDir  where the server reads go-dark.json
 * @param {Record<string, string|undefined>} [opts.env]  the backend's environment
 * @param {string} [opts.script]  the server entry; tests point it elsewhere
 * @returns {BuiltinConnector}
 */
export function thisComputerConnector({ dataDir, env = process.env, script = MACHINE_SERVER }) {
  return {
    id: THIS_COMPUTER_ID,
    name: 'This computer',
    enabled: true,
    spawn: () => {
      /** @type {Record<string, string>} */
      const childEnv = {
        // The desktop backend runs on Electron's binary, which acts as Node only with
        // this set; without it the child opens a second app window. Node ignores it.
        ELECTRON_RUN_AS_NODE: '1',
        MIRABILIS_DATA_DIR: path.resolve(dataDir)
      };
      // The operator jail holds here as in agent runs: read_log resolves paths through it.
      if (env.MIRABILIS_MCP_FS_ROOT) childEnv.MIRABILIS_MCP_FS_ROOT = path.resolve(env.MIRABILIS_MCP_FS_ROOT);
      return { command: process.execPath, args: [script], env: childEnv, cwd: os.homedir() };
    }
  };
}

/**
 * A built-in connector as the manager holds it. Its switch and tool permissions
 * come from connectors.json; what it runs never does.
 * @param {BuiltinConnector} def
 * @param {any} saved  its entry in connectors.json, if any
 * @returns {ConnectorRecord}
 */
function builtinRecord(def, saved) {
  const record = /** @type {ConnectorRecord} */ (normalizeStored({
    id: def.id,
    name: def.name,
    transport: 'stdio',
    enabled: saved ? saved.enabled !== false : def.enabled !== false,
    tools: saved?.tools,
    toolInfo: saved?.toolInfo
  }));
  record.builtin = true;
  return record;
}

/** A record as connectors.json keeps it: all of a custom one, the switch and permissions of a built-in. */
function storedForm(record) {
  if (!record.builtin) return record;
  return { id: record.id, enabled: record.enabled, tools: record.tools, toolInfo: record.toolInfo };
}

/** @param {string} text @param {Set<string>} builtinIds @returns {StoreContents|null} */
function parseStore(text, builtinIds) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.connectors;
  if (!Array.isArray(list)) return null;
  /** @type {StoreContents} */
  const out = { records: [], builtins: new Map() };
  for (const raw of list) {
    if (raw && typeof raw === 'object' && builtinIds.has(raw.id)) {
      out.builtins.set(raw.id, raw);
      continue;
    }
    const record = normalizeStored(raw);
    if (record) out.records.push(record);
  }
  return out;
}

/**
 * Read connectors.json, falling back to .bak. An unreadable file with no usable
 * backup is moved aside (never overwritten) and the list starts empty.
 * @param {string} file
 * @param {Set<string>} builtinIds
 * @returns {Promise<StoreContents & {exists: boolean, rewrite?: boolean}>}
 */
async function loadStore(file, builtinIds) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { exists: false, records: [], builtins: new Map() };
    throw err;
  }
  const store = parseStore(text, builtinIds);
  if (store) return { exists: true, ...store };
  /** @type {StoreContents|null} */
  let backup = null;
  try {
    backup = parseStore(await readFile(`${file}.bak`, 'utf8'), builtinIds);
  } catch { /* no backup */ }
  // Move the bad file aside so the next save cannot rotate it over the good .bak.
  const quarantine = `${file}.corrupt-${Date.now()}`;
  try { await rename(file, quarantine); } catch { /* best effort */ }
  if (backup) {
    console.warn(`[connectors] ${file} was unreadable; recovered from ${file}.bak and moved the bad copy to ${quarantine}`);
    return { exists: true, ...backup, rewrite: true };
  }
  console.warn(`[connectors] ${file} was unreadable and had no usable backup; moved it to ${quarantine}`);
  return { exists: true, records: [], builtins: new Map(), rewrite: true };
}

/**
 * Temp file, fsync, rename, keeping the previous copy as .bak. Owner-only modes.
 * @param {string} file
 * @param {string} text
 */
async function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await hardenFile(tmp);
  try {
    await copyFile(file, `${file}.bak`);
    await hardenFile(`${file}.bak`);
  } catch { /* first write */ }
  await rename(tmp, file);
}

/**
 * HTTP servers from the old mcp-servers.json, as connector records.
 * @param {string} dataDir
 * @returns {Promise<ConnectorRecord[]|null>} null when there is no legacy file
 */
async function readLegacy(dataDir) {
  const file = path.join(dataDir, LEGACY_FILE);
  /** @type {any} */
  let parsed = null;
  for (const candidate of [file, `${file}.bak`]) {
    try {
      parsed = JSON.parse(await readFile(candidate, 'utf8'));
      break;
    } catch { /* missing or unreadable */ }
  }
  if (!parsed || !Array.isArray(parsed.servers)) return null;
  const now = nowIso();
  /** @type {ConnectorRecord[]} */
  const out = [];
  for (const server of parsed.servers) {
    if (!server || typeof server !== 'object') continue;
    let url;
    try {
      url = cleanUrl(server.url);
    } catch {
      continue;
    }
    const policy = server.toolPolicy && typeof server.toolPolicy === 'object' ? server.toolPolicy : {};
    // The old policy required approval unless it was switched off.
    const requireApproval = policy.requireApproval == null ? true : Boolean(policy.requireApproval);
    const allowedTools = policy.enforceAllowlist && Array.isArray(policy.allowedTools)
      ? policy.allowedTools.map((t) => String(t || '').trim()).filter(Boolean)
      : null;
    out.push({
      id: randomUUID(),
      name: (String(server.name || '').trim() || hostName(url) || 'Remote connector').slice(0, 60),
      transport: 'http',
      command: '',
      args: [],
      env: {},
      cwd: '',
      url,
      headers: server.authToken ? { Authorization: `Bearer ${String(server.authToken)}` } : {},
      enabled: server.enabled !== false,
      tools: {},
      toolInfo: {},
      preset: null,
      createdAt: asString(server.createdAt) || now,
      updatedAt: now,
      importRules: { defaultPermission: requireApproval ? 'ask' : null, allowedTools }
    });
  }
  return out;
}

/**
 * The text of a tools/call result. Non-text parts become short notes.
 * @param {any} result
 * @returns {{text: string, isError: boolean, raw: any}}
 */
export function formatToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  /** @type {string[]} */
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text') parts.push(String(item.text ?? ''));
    else if (item.type === 'image') parts.push('[image]');
    else if (item.type === 'audio') parts.push('[audio]');
    else if (item.type === 'resource_link') parts.push(`[resource: ${item.uri || 'link'}]`);
    else if (item.type === 'resource') {
      const res = item.resource || {};
      parts.push(typeof res.text === 'string' ? `[resource: ${res.uri || 'embedded'}]\n${res.text}` : `[resource: ${res.uri || 'embedded'}]`);
    } else parts.push(`[${item.type || 'content'}]`);
  }
  let text = parts.join('\n');
  if (!text && result?.structuredContent !== undefined) {
    try { text = JSON.stringify(result.structuredContent); } catch { text = ''; }
  }
  if (text.length > MAX_TEXT_CHARS) {
    text = `${text.slice(0, MAX_TEXT_CHARS)}\n[Truncated: showing ${MAX_TEXT_CHARS} of ${text.length} characters.]`;
  }
  return { text, isError: result?.isError === true, raw: result };
}

/** @param {any} prop @param {number} [depth] @returns {string} */
function typeLabel(prop, depth = 0) {
  if (!prop || typeof prop !== 'object' || depth > 3) return 'any';
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return `one of ${prop.enum.slice(0, 12).map((v) => JSON.stringify(v)).join(', ')}`;
  }
  if (Array.isArray(prop.type)) return prop.type.join(' or ');
  if (prop.type === 'array') return `array of ${typeLabel(prop.items, depth + 1)}`;
  if (typeof prop.type === 'string') return prop.type;
  const alternatives = prop.anyOf || prop.oneOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) return alternatives.map((a) => typeLabel(a, depth + 1)).join(' or ');
  return 'any';
}

/**
 * Prompt-sized parameter descriptions from a JSON schema.
 * @param {any} schema
 * @returns {Record<string, string>}
 */
export function describeParameters(schema) {
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, prop] of Object.entries(props).slice(0, 40)) {
    const flag = required.has(key) ? 'required' : 'optional';
    const description = String(prop?.description || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    out[key] = `${typeLabel(prop)} (${description ? `${flag}, ${description}` : flag})`;
  }
  return out;
}

/** @param {any} tool @returns {LiveTool} */
function normalizeTool(tool) {
  return {
    name: String(tool.name).slice(0, 200),
    title: String(tool.title || tool.annotations?.title || tool.name).slice(0, 200),
    description: String(tool.description || '').trim(),
    readOnly: tool.annotations?.readOnlyHint === true,
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }
  };
}

/** Every page of tools/list. */
async function listAllTools(client) {
  /** @type {LiveTool[]} */
  const tools = [];
  const seen = new Set();
  /** @type {string|undefined} */
  let cursor;
  for (let page = 0; page < 50; page += 1) {
    const result = await client.request('tools/list', cursor ? { cursor } : {}, { timeoutMs: LIST_TIMEOUT_MS });
    for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
      if (!tool || typeof tool.name !== 'string' || !tool.name || tools.some((t) => t.name === tool.name)) continue;
      tools.push(normalizeTool(tool));
      if (tools.length >= MAX_TOOLS) return tools;
    }
    const next = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : '';
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return tools;
}

/** Wait for a promise, but no longer than `ms`. */
async function within(promise, ms) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  try {
    await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {() => boolean} [opts.isGoDark]
 * @param {Record<string, string|undefined>} [opts.env]  base environment for local servers (PATH and a short allow list)
 * @param {typeof fetch} [opts.fetch]  for remote connectors; defaults to the global, Go Dark guarded fetch
 * @param {BuiltinConnector[]} [opts.builtins]  connectors that ship with Mirabilis; defaults to This computer
 */
export function createConnectorManager({ dataDir, isGoDark = () => false, env = process.env, fetch: fetchImpl, builtins } = /** @type {any} */ ({})) {
  if (!dataDir) throw new TypeError('createConnectorManager needs dataDir.');
  /** @type {BuiltinConnector[]} */
  const builtinDefs = Array.isArray(builtins) ? builtins : [thisComputerConnector({ dataDir, env })];
  const builtinIds = new Set(builtinDefs.map((def) => def.id));
  const file = path.join(dataDir, STORE_FILE);
  const home = os.homedir();
  const platform = process.platform;
  /** @type {ConnectorRecord[]} */
  let records = [];
  /** @type {Map<string, Runtime>} */
  const runtimes = new Map();
  /** @type {Promise<void>|null} */
  let initPromise = null;
  let closed = false;
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve();

  const goDarkOn = () => {
    try {
      return Boolean(isGoDark());
    } catch {
      return false;
    }
  };

  /** @param {ConnectorRecord} record */
  const blockedByGoDark = (record) => record.transport === 'http' && goDarkOn() && !isLocalHostUrl(record.url);

  /** @param {string} id */
  const findRecord = (id) => records.find((r) => r.id === id) || null;

  /** @param {string} id */
  function mustGet(id) {
    const record = findRecord(String(id || ''));
    if (!record) throw notFound();
    return record;
  }

  /** @param {string} id @returns {Runtime} */
  function runtime(id) {
    let rt = runtimes.get(id);
    if (!rt) {
      rt = {
        client: null, state: 'off', error: null, goDarkBlocked: false, serverName: null, serverVersion: null,
        startedAt: null, pid: null, tools: [], logs: [], restarts: [], generation: 0,
        starting: null, restartTimer: null, refreshTimer: null
      };
      runtimes.set(id, rt);
    }
    return rt;
  }

  /** Serialized writes; the snapshot is taken now so order is preserved. */
  function persist() {
    const text = JSON.stringify({ version: 1, connectors: records.map(storedForm) }, null, 2);
    const run = writeChain.then(() => writeAtomic(file, text));
    writeChain = run.catch(() => {});
    return run;
  }

  /** Values that must never show up in logs or errors. */
  function secretsOf(record) {
    const values = [...Object.values(record.env), ...Object.values(record.headers)];
    for (const v of Object.values(record.headers)) {
      const m = /^\s*bearer\s+(.+)$/i.exec(v);
      if (m) values.push(m[1].trim());
    }
    return values.filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
  }

  /** @param {string} text @param {ConnectorRecord|null} record */
  function scrub(text, record) {
    let out = redact(String(text ?? ''));
    if (record) for (const secret of secretsOf(record)) out = out.split(secret).join('[redacted]');
    return out;
  }

  /** @param {Runtime} rt @param {ConnectorRecord} record @param {string} line */
  function log(rt, record, line) {
    rt.logs.push(scrub(String(line).slice(0, 2000), record));
    if (rt.logs.length > LOG_LINES) rt.logs.splice(0, rt.logs.length - LOG_LINES);
  }

  /** @param {Runtime} rt @param {ConnectorRecord} record @param {string} message @param {boolean} [goDark] */
  function fail(rt, record, message, goDark = false) {
    rt.state = 'error';
    rt.error = scrub(message, record).slice(0, 1200);
    rt.goDarkBlocked = goDark;
    rt.tools = [];
    rt.pid = null;
  }

  /** @param {ConnectorRecord} record @param {LiveTool} tool @returns {Permission} */
  function defaultPermission(record, tool) {
    const rules = record.importRules;
    if (rules?.allowedTools && !rules.allowedTools.includes(tool.name)) return 'off';
    if (rules?.defaultPermission) return rules.defaultPermission;
    return tool.readOnly ? 'allow' : 'ask';
  }

  /** @param {ConnectorRecord} record @param {string} name @returns {Permission} */
  const permissionOf = (record, name) => (isPermission(record.tools[name]) ? record.tools[name] : 'ask');

  /** Record the live tool list: new tools get their default permission, all get cached info. */
  async function applyTools(record, rt, tools) {
    rt.tools = tools;
    let changed = false;
    for (const tool of tools) {
      if (!isPermission(record.tools[tool.name])) {
        record.tools[tool.name] = defaultPermission(record, tool);
        changed = true;
      }
      const info = { title: tool.title, description: tool.description.slice(0, 300), readOnly: tool.readOnly };
      if (JSON.stringify(record.toolInfo[tool.name]) !== JSON.stringify(info)) {
        record.toolInfo[tool.name] = info;
        changed = true;
      }
    }
    // Forget cached info for tools the server dropped; their permission stays in case they return.
    for (const name of Object.keys(record.toolInfo)) {
      if (!tools.some((t) => t.name === name)) {
        delete record.toolInfo[name];
        changed = true;
      }
    }
    if (record.importRules) {
      delete record.importRules;
      changed = true;
    }
    if (changed) {
      try {
        await persist();
      } catch (err) {
        log(rt, record, `[mirabilis] Could not save the tool list: ${err?.message || err}`);
      }
    }
  }

  /**
   * What a local connector runs. A built-in's command is computed at every start,
   * so a stale or edited connectors.json cannot change it.
   * @param {ConnectorRecord} record
   */
  function spawnSpec(record) {
    if (!record.builtin) return { command: record.command, args: record.args, env: record.env, cwd: record.cwd };
    const def = /** @type {BuiltinConnector} */ (builtinDefs.find((d) => d.id === record.id));
    const spec = def.spawn();
    return { command: String(spec.command), args: (spec.args || []).map(String), env: { ...spec.env }, cwd: String(spec.cwd || '') };
  }

  /** @param {ConnectorRecord} record */
  function initTimeout(record) {
    if (record.transport !== 'stdio') return INIT_TIMEOUT_MS;
    const base = path.basename(record.command).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    return PACKAGE_RUNNERS.has(base) ? FIRST_RUN_INIT_TIMEOUT_MS : INIT_TIMEOUT_MS;
  }

  /**
   * @param {string} id
   * @param {number} generation
   * @param {any} message
   */
  function onNotification(id, generation, message) {
    const rt = runtimes.get(id);
    const record = findRecord(id);
    if (!rt || !record || rt.generation !== generation) return;
    if (message?.method === 'notifications/tools/list_changed') {
      if (rt.refreshTimer) clearTimeout(rt.refreshTimer);
      rt.refreshTimer = setTimeout(() => {
        rt.refreshTimer = null;
        if (rt.generation !== generation || rt.state !== 'ready' || !rt.client) return;
        listAllTools(rt.client)
          .then((tools) => (rt.generation === generation ? applyTools(record, rt, tools) : undefined))
          .catch((err) => log(rt, record, `[mirabilis] Could not refresh tools: ${err?.message || err}`));
      }, 200);
    } else if (message?.method === 'notifications/message') {
      const data = message.params?.data;
      log(rt, record, `[${message.params?.level || 'log'}] ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    }
  }

  /**
   * The program exited. Crashes after ready restart with backoff, at most
   * MAX_RESTARTS times per window; startup failures are reported by launch().
   * @param {string} id
   * @param {number} generation
   * @param {{code: number|null, signal: string|null, expected: boolean}} info
   */
  function onExit(id, generation, info) {
    const rt = runtimes.get(id);
    const record = findRecord(id);
    if (!rt || !record || rt.generation !== generation || info.expected || closed) return;
    const how = info.signal ? `was stopped by ${info.signal}` : `exited with code ${info.code}`;
    const tail = rt.client?.stderrTail?.(5) || [];
    rt.client = null;
    rt.pid = null;
    log(rt, record, `[mirabilis] The program ${how}.`);
    if (rt.state !== 'ready') return;
    const now = Date.now();
    rt.restarts = rt.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (rt.restarts.length >= MAX_RESTARTS) {
      const last = tail.length ? `\nLast output:\n${tail.join('\n')}` : '';
      fail(rt, record, `Stopped after ${MAX_RESTARTS} restarts in 5 minutes. The program ${how}.${last}`);
      log(rt, record, '[mirabilis] Not restarting again. Fix the problem, then press Restart.');
      return;
    }
    rt.restarts.push(now);
    rt.state = 'starting';
    rt.error = null;
    rt.tools = [];
    const delay = 500 * 2 ** (rt.restarts.length - 1);
    log(rt, record, `[mirabilis] Restarting in ${delay / 1000}s (restart ${rt.restarts.length} of ${MAX_RESTARTS}).`);
    rt.restartTimer = setTimeout(() => {
      rt.restartTimer = null;
      if (rt.generation === generation) void startConnector(id);
    }, delay);
  }

  /**
   * Start one connector and run the MCP handshake. Never rejects: failures
   * become state 'error' with a plain message.
   * @param {ConnectorRecord} record
   * @param {Runtime} rt
   * @param {number} generation
   */
  async function launch(record, rt, generation) {
    const current = () => rt.generation === generation && !closed;
    rt.state = 'starting';
    rt.error = null;
    rt.goDarkBlocked = false;
    rt.serverName = null;
    rt.serverVersion = null;
    rt.startedAt = nowIso();
    rt.pid = null;
    rt.tools = [];
    /** @type {any} */
    let client = null;
    try {
      if (record.transport === 'http') {
        if (blockedByGoDark(record)) {
          log(rt, record, `[mirabilis] Not connecting to ${hostName(record.url)}: Go Dark is on.`);
          fail(rt, record, GO_DARK_ERROR, true);
          return;
        }
        log(rt, record, `[mirabilis] Connecting to ${displayUrl(record.url)}`);
        client = createHttpClient({
          url: record.url,
          headers: record.headers,
          fetch: fetchImpl,
          onNotification: (m) => onNotification(record.id, generation, m)
        });
      } else {
        const spec = spawnSpec(record);
        const cwd = spec.cwd ? path.resolve(home, expandTilde(spec.cwd, home)) : home;
        if (!isDirectory(cwd)) {
          fail(rt, record, `Working folder not found: ${spec.cwd}`);
          log(rt, record, `[mirabilis] Working folder not found: ${spec.cwd}`);
          return;
        }
        log(rt, record, `[mirabilis] Starting ${[spec.command, ...spec.args].join(' ')}`);
        client = createStdioClient({
          command: spec.command,
          args: spec.args,
          env: buildChildEnv(env, spec.env, { home, platform }),
          cwd,
          onStderr: (line) => { if (rt.generation === generation) log(rt, record, line); },
          onNotification: (m) => onNotification(record.id, generation, m),
          onExit: (info) => onExit(record.id, generation, info)
        });
      }
      rt.client = client;
      await client.start();
      if (!current()) return;
      rt.pid = client.pid ?? null;
      const init = await client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mirabilis', version: APP_VERSION }
      }, { timeoutMs: initTimeout(record) });
      if (!current()) return;
      try {
        await client.notify('notifications/initialized');
      } catch { /* some servers manage without it */ }
      const tools = await listAllTools(client);
      if (!current()) return;
      await applyTools(record, rt, tools);
      if (!current()) return;
      rt.state = 'ready';
      rt.serverName = typeof init?.serverInfo?.name === 'string' ? init.serverInfo.name : null;
      rt.serverVersion = typeof init?.serverInfo?.version === 'string' ? init.serverInfo.version : null;
      const who = [rt.serverName, rt.serverVersion].filter(Boolean).join(' ') || record.name;
      log(rt, record, `[mirabilis] Ready: ${who}, ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}.`);
    } catch (err) {
      if (!current()) return;
      const blocked = isEgressBlocked(err);
      const tail = client?.stderrTail?.(5) || [];
      const message = blocked
        ? GO_DARK_ERROR
        : `${err?.message || err}${tail.length ? `\nLast output:\n${tail.join('\n')}` : ''}`;
      log(rt, record, `[mirabilis] ${blocked ? 'Blocked by Go Dark.' : String(err?.message || err)}`);
      fail(rt, record, message, blocked && goDarkOn());
      if (client) {
        if (rt.client === client) rt.client = null;
        await client.stop().catch(() => {});
      }
    }
  }

  /** Start if enabled and not already running. Resolves when ready or failed. */
  function startConnector(id) {
    const record = findRecord(id);
    if (!record || !record.enabled || closed) return Promise.resolve();
    const rt = runtime(id);
    if (rt.starting) return rt.starting;
    if (rt.state === 'ready' && rt.client) return Promise.resolve();
    if (rt.restartTimer) {
      clearTimeout(rt.restartTimer);
      rt.restartTimer = null;
    }
    rt.generation += 1;
    const run = launch(record, rt, rt.generation);
    rt.starting = run;
    run.finally(() => {
      if (rt.starting === run) rt.starting = null;
    });
    return run;
  }

  /** Stop the program or session and wait until it is gone. */
  async function stopConnector(id) {
    const rt = runtimes.get(id);
    if (!rt) return;
    rt.generation += 1;
    rt.starting = null;
    if (rt.restartTimer) clearTimeout(rt.restartTimer);
    if (rt.refreshTimer) clearTimeout(rt.refreshTimer);
    rt.restartTimer = null;
    rt.refreshTimer = null;
    const client = rt.client;
    rt.client = null;
    rt.state = 'off';
    rt.error = null;
    rt.goDarkBlocked = false;
    rt.pid = null;
    rt.startedAt = null;
    rt.tools = [];
    if (client) await client.stop().catch(() => {});
  }

  /** Follow Go Dark: a remote connector stops while it is on and comes back when it is off. */
  function reconcileGoDark() {
    if (closed) return;
    for (const record of records) {
      if (!record.enabled || record.transport !== 'http') continue;
      const rt = runtimes.get(record.id);
      if (!rt) continue;
      const blocked = blockedByGoDark(record);
      if (blocked && (rt.state === 'ready' || rt.state === 'starting')) {
        const client = rt.client;
        rt.generation += 1;
        rt.starting = null;
        rt.client = null;
        log(rt, record, '[mirabilis] Go Dark is on; disconnected.');
        fail(rt, record, GO_DARK_ERROR, true);
        if (client) void client.stop().catch(() => {});
      } else if (!blocked && rt.state === 'error' && rt.goDarkBlocked) {
        void startConnector(record.id);
      }
    }
  }

  /** @param {ConnectorRecord} record */
  function summarize(record) {
    const rt = runtimes.get(record.id);
    const live = rt?.state === 'ready' ? rt.tools : null;
    const tools = live
      ? live.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description.slice(0, 600),
          readOnly: t.readOnly,
          permission: permissionOf(record, t.name)
        }))
      : Object.entries(record.toolInfo).map(([name, info]) => ({
          name,
          title: info.title || name,
          description: info.description,
          readOnly: info.readOnly,
          permission: permissionOf(record, name)
        }));
    const envKeys = Object.keys(record.env);
    const headerKeys = Object.keys(record.headers);
    const state = record.enabled && rt ? rt.state : 'off';
    return {
      id: record.id,
      name: record.name,
      transport: record.transport,
      // A built-in's command, folder and variables are computed at start, so all show empty.
      builtin: record.builtin === true,
      command: record.command,
      args: [...record.args],
      cwd: record.cwd,
      url: record.transport === 'http' ? displayUrl(record.url) : '',
      enabled: record.enabled,
      preset: record.preset,
      // Names only, never values. env and headers carry the same lists under the spec's field names.
      envKeys,
      headerKeys,
      env: [...envKeys],
      headers: [...headerKeys],
      hasSecrets: envKeys.length > 0 || headerKeys.length > 0 || urlHasSecrets(record.url),
      status: {
        state,
        toolCount: tools.length,
        serverName: state === 'ready' ? rt?.serverName ?? null : null,
        serverVersion: state === 'ready' ? rt?.serverVersion ?? null : null,
        error: state === 'error' ? rt?.error ?? null : null,
        startedAt: state === 'off' ? null : rt?.startedAt ?? null,
        pid: state === 'off' ? null : rt?.pid ?? null
      },
      tools,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  }

  /** @param {string} wanted @param {string} [exceptId] */
  function uniqueName(wanted, exceptId) {
    const taken = new Set(records.filter((r) => r.id !== exceptId).map((r) => r.name.toLowerCase()));
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; n < 1000; n += 1) {
      const suffix = ` ${n}`;
      const candidate = `${wanted.slice(0, 60 - suffix.length)}${suffix}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return wanted;
  }

  function assertOpen() {
    if (closed) throw new ConnectorError(500, 'Connectors are shutting down.');
  }

  const manager = {
    /** Load the store (importing mcp-servers.json once) and start enabled connectors in the background. */
    init() {
      if (!initPromise) {
        initPromise = (async () => {
          await mkdir(dataDir, { recursive: true, mode: 0o700 });
          const loaded = await loadStore(file, builtinIds);
          let custom = loaded.records;
          // Rewrite at once after a recovery, so a missing file never re-runs the import.
          let rewrite = Boolean(loaded.rewrite);
          if (!loaded.exists) {
            const legacy = await readLegacy(dataDir);
            if (legacy) {
              custom = legacy;
              rewrite = true;
            }
          }
          // Built-ins first. One missing from the file is new, and starts with its default switch.
          const added = builtinDefs.some((def) => !loaded.builtins.has(def.id));
          records = [...builtinDefs.map((def) => builtinRecord(def, loaded.builtins.get(def.id))), ...custom];
          if (rewrite) {
            await persist();
          } else if (added) {
            // Best effort: a data folder that cannot be written must not keep the list from loading.
            await persist().catch((err) => console.warn(`[connectors] Could not save ${file}: ${err?.message || err}`));
          }
          // Staggered, so a boot with several connectors does not launch them all at once.
          records.filter((r) => r.enabled).forEach((record, i) => {
            if (i === 0) {
              void startConnector(record.id);
              return;
            }
            const rt = runtime(record.id);
            rt.state = 'starting';
            rt.restartTimer = setTimeout(() => {
              rt.restartTimer = null;
              void startConnector(record.id);
            }, i * BOOT_STAGGER_MS);
            rt.restartTimer.unref?.();
          });
        })();
        initPromise.catch(() => { initPromise = null; });
      }
      return initPromise;
    },

    /** Summaries for the UI. Never includes env or header values. */
    list() {
      reconcileGoDark();
      return records.map(summarize);
    },

    /** @param {string} id */
    get(id) {
      reconcileGoDark();
      const record = findRecord(String(id || ''));
      return record ? summarize(record) : null;
    },

    catalog() {
      return buildCatalog({ pathValue: augmentPath(pathOf(env), { home, platform }), platform, home });
    },

    /**
     * Add a connector from the catalog ({presetId, fields}, or {preset, fields}) or a
     * custom one. It is saved even when it fails to start; the summary says why.
     * @param {any} input
     */
    async create(input = {}) {
      await manager.init();
      assertOpen();
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Send the connector as a JSON object.');
      if (records.filter((r) => !r.builtin).length >= MAX_CONNECTORS) throw badRequest(`You can add up to ${MAX_CONNECTORS} connectors.`);
      let draft;
      const presetId = [input.presetId, input.preset].find((v) => v != null && v !== '');
      if (presetId !== undefined) {
        const preset = findPreset(String(presetId));
        if (!preset) throw badRequest(`Unknown catalog entry: ${String(presetId).slice(0, 60)}`);
        let built;
        try {
          built = connectorFromPreset(preset, input.fields, { dataDir, home, platform });
        } catch (err) {
          throw badRequest(String(err?.message || err));
        }
        draft = { ...built, name: cleanName(input.name) || built.name, url: '', headers: {} };
      } else {
        draft = { ...customDraft(input, home), preset: null };
      }
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw badRequest('enabled must be true or false.');
      const now = nowIso();
      /** @type {ConnectorRecord} */
      const record = {
        id: randomUUID(),
        name: uniqueName(draft.name),
        transport: /** @type {'stdio'|'http'} */ (draft.transport),
        command: draft.command,
        args: draft.args,
        env: draft.env,
        cwd: draft.cwd,
        url: draft.url,
        headers: draft.headers,
        enabled: input.enabled !== false,
        tools: {},
        toolInfo: {},
        preset: draft.preset,
        createdAt: now,
        updatedAt: now
      };
      records.push(record);
      try {
        await persist();
      } catch (err) {
        records = records.filter((r) => r.id !== record.id);
        throw new ConnectorError(500, `Could not save the connector: ${err?.message || err}`);
      }
      if (record.enabled) await within(startConnector(record.id), CREATE_WAIT_MS);
      return summarize(record);
    },

    /**
     * Change name, enabled, command, args, env, cwd, url, headers or per-tool
     * permissions. env and headers merge: a string sets a key, null removes it.
     * A built-in takes only enabled and tools.
     * @param {string} id
     * @param {any} patch
     */
    async update(id, patch = {}) {
      await manager.init();
      assertOpen();
      const record = mustGet(id);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('Send the changes as a JSON object.');
      if (record.builtin && Object.keys(patch).some((key) => patch[key] !== undefined && key !== 'enabled' && key !== 'tools')) {
        throw badRequest('Only on/off and tool permissions can change here.');
      }
      /** @type {ConnectorRecord} */
      const next = structuredClone(record);
      const has = (key) => patch[key] !== undefined;
      const empty = (v) => v === '' || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && Object.keys(v).length === 0);
      if (has('name')) {
        const name = cleanName(patch.name);
        if (!name) throw badRequest('Name cannot be empty.');
        next.name = name.toLowerCase() === record.name.toLowerCase() ? name : uniqueName(name, record.id);
      }
      if (has('enabled')) {
        if (typeof patch.enabled !== 'boolean') throw badRequest('enabled must be true or false.');
        next.enabled = patch.enabled;
      }
      if (String(patch.transport ?? '').trim() && pickTransport({ transport: patch.transport }) !== record.transport) {
        throw badRequest('A connector cannot switch between a local command and a remote URL. Add a new one instead.');
      }
      const stdioOnly = ['command', 'args', 'env', 'cwd'];
      const httpOnly = ['url', 'headers'];
      for (const key of record.transport === 'stdio' ? httpOnly : stdioOnly) {
        if (has(key) && !empty(patch[key])) {
          throw badRequest(record.transport === 'stdio' ? `${key} applies to remote connectors only.` : `${key} applies to local connectors only.`);
        }
      }
      if (record.transport === 'stdio') {
        if (has('command')) {
          const command = String(patch.command ?? '').trim();
          if (!command) throw badRequest('Enter the command that starts the connector, for example npx.');
          next.command = command;
        }
        if (has('args')) next.args = cleanArgs(patch.args);
        if (has('env')) next.env = mergePairs(record.env, readPairs(patch.env, 'env'));
        if (has('cwd')) next.cwd = cleanCwd(patch.cwd, home);
      } else {
        if (has('url')) next.url = cleanUrl(patch.url);
        if (has('headers')) next.headers = mergePairs(record.headers, readPairs(patch.headers, 'headers'));
      }
      if (has('tools')) {
        if (!patch.tools || typeof patch.tools !== 'object' || Array.isArray(patch.tools)) {
          throw badRequest('tools must map each tool name to allow, ask or off.');
        }
        for (const [name, permission] of Object.entries(patch.tools)) {
          if (!name || name.length > 200) throw badRequest('A tool name is empty or too long.');
          if (!isPermission(permission)) throw badRequest(`Permission for ${name.slice(0, 60)} must be allow, ask or off.`);
          next.tools[name] = permission;
        }
      }
      const configKey = (r) => JSON.stringify([r.command, r.args, r.env, r.cwd, r.url, r.headers]);
      const configChanged = configKey(next) !== configKey(record);
      const turnedOn = next.enabled && !record.enabled;
      next.updatedAt = nowIso();
      const previous = structuredClone(record);
      Object.assign(record, next);
      try {
        await persist();
      } catch (err) {
        Object.assign(record, previous);
        throw new ConnectorError(500, `Could not save the change: ${err?.message || err}`);
      }
      const rt = runtimes.get(record.id);
      if (!record.enabled) {
        await stopConnector(record.id);
      } else if (configChanged || turnedOn || (has('enabled') && rt?.state !== 'ready' && rt?.state !== 'starting')) {
        if (rt) rt.restarts = [];
        await stopConnector(record.id);
        await within(startConnector(record.id), TOGGLE_WAIT_MS);
      }
      return summarize(record);
    },

    /** @param {string} id */
    async remove(id) {
      await manager.init();
      const record = mustGet(id);
      if (record.builtin) throw badRequest('Built-in connectors cannot be removed. Switch it off.');
      await stopConnector(record.id);
      records = records.filter((r) => r.id !== record.id);
      runtimes.delete(record.id);
      await persist();
      return true;
    },

    /** @param {string} id */
    async restart(id) {
      await manager.init();
      assertOpen();
      const record = mustGet(id);
      if (!record.enabled) throw badRequest('This connector is off. Turn it on to start it.');
      runtime(record.id).restarts = [];
      await stopConnector(record.id);
      await within(startConnector(record.id), CREATE_WAIT_MS);
      return summarize(record);
    },

    /** The last lines of program output and connection events, secrets removed. @param {string} id */
    logs(id) {
      const record = mustGet(id);
      return [...(runtimes.get(record.id)?.logs || [])];
    },

    /**
     * Call one tool. Refuses tools set to off; 'ask' is the caller's business
     * (the agent gate asks, a click in the app is the approval).
     * @param {string} id
     * @param {string} toolName
     * @param {any} [args]
     * @param {{signal?: AbortSignal}} [opts]
     * @returns {Promise<{text: string, isError: boolean, raw: any}>}
     */
    async callTool(id, toolName, args = {}, { signal } = {}) {
      await manager.init();
      const record = mustGet(id);
      const name = String(toolName || '');
      const input = args == null ? {} : args;
      if (typeof input !== 'object' || Array.isArray(input)) throw badRequest('Tool arguments must be a JSON object.');
      if (!record.enabled) throw badRequest(`${record.name} is off. Turn it on first.`);
      reconcileGoDark();
      const rt = runtimes.get(record.id);
      if (!rt || rt.state !== 'ready' || !rt.client) {
        const why = rt?.state === 'starting' ? ' It is still starting.' : rt?.error ? ` ${rt.error}` : '';
        throw badRequest(`${record.name} is not connected.${why}`);
      }
      const tool = rt.tools.find((t) => t.name === name);
      if (!tool) throw new ConnectorError(404, `${record.name} has no tool named ${name.slice(0, 120)}.`);
      if (permissionOf(record, name) === 'off') throw badRequest(`${name} is turned off for ${record.name}.`);
      let result;
      try {
        result = await rt.client.request('tools/call', { name, arguments: input }, { timeoutMs: CALL_TIMEOUT_MS, signal });
      } catch (err) {
        if (isEgressBlocked(err)) {
          const client = rt.client;
          rt.generation += 1;
          rt.client = null;
          fail(rt, record, GO_DARK_ERROR, goDarkOn());
          if (client) void client.stop().catch(() => {});
          throw badRequest(`${record.name} is blocked by Go Dark. Turn Go Dark off to use it.`);
        }
        if (typeof err?.rpcCode === 'number') {
          const message = scrub(String(err.message), record);
          return { text: `Error: ${message}`, isError: true, raw: { error: { code: err.rpcCode, message } } };
        }
        throw new ConnectorError(500, scrub(`${name} failed: ${err?.message || err}`, record));
      }
      return formatToolResult(result);
    },

    /**
     * Agent tools for every ready connector, keyed `<connector>__<tool>`. Tools set
     * to off are not offered at all.
     * @returns {Record<string, any>}
     */
    agentTools() {
      reconcileGoDark();
      /** @type {Record<string, any>} */
      const out = {};
      for (const record of records) {
        const rt = runtimes.get(record.id);
        if (!record.enabled || !rt || rt.state !== 'ready' || !rt.client) continue;
        for (const tool of rt.tools) {
          if (permissionOf(record, tool.name) === 'off') continue;
          let key = toolKey(record.name, tool.name);
          for (let n = 2; Object.prototype.hasOwnProperty.call(out, key); n += 1) {
            const suffix = `_${n}`;
            key = `${toolKey(record.name, tool.name).slice(0, 60 - suffix.length)}${suffix}`;
          }
          out[key] = {
            kind: 'connector',
            description: `${(tool.description || tool.title || tool.name).slice(0, 300)} (connector: ${record.name})`,
            parameters: describeParameters(tool.inputSchema),
            readOnly: tool.readOnly,
            mutating: !tool.readOnly,
            // Live, so a permission change applies to the next call of a run already going.
            get permission() { return permissionOf(record, tool.name); },
            connectorId: record.id,
            connectorName: record.name,
            mcpTool: tool.name,
            async execute(callArgs, ctx) {
              const result = await manager.callTool(record.id, tool.name, callArgs || {}, { signal: ctx?.signal });
              // A tool-level error (bad arguments, a failed action) goes back as a failed
              // call, so the model sees ERROR and can correct its next try.
              if (result.isError) throw new Error(result.text || `${tool.name} failed.`);
              return { text: result.text };
            }
          };
        }
      }
      return out;
    },

    /** Stop every connector and wait for the programs to exit. */
    async shutdown() {
      closed = true;
      // Signal every program before the first await: an 'exit' handler cannot wait for the rest.
      for (const rt of runtimes.values()) rt.client?.terminate?.();
      await Promise.allSettled([...runtimes.keys()].map((id) => stopConnector(id)));
      await writeChain;
    }
  };
  return manager;
}
