// @ts-check
// Client for /api/connectors (MCP servers Mirabilis uses as a client) and
// /api/mcp-endpoint (its own MCP server switch), plus the formatting rules the
// Connectors pane needs, kept here so they are testable.

import { API_BASE, apiFetch } from './api.js';

/** Creating or restarting waits up to 20 s for the server to come up. */
const SLOW_MS = 45000;

/** @typedef {'allow'|'ask'|'off'} ToolPermission */
/** @typedef {'off'|'starting'|'ready'|'error'} ConnectorState */

/**
 * @typedef {object} ConnectorTool
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {boolean} readOnly
 * @property {ToolPermission} permission
 */

/**
 * @typedef {object} ConnectorStatus
 * @property {ConnectorState} state
 * @property {number} toolCount
 * @property {string} serverName
 * @property {string} serverVersion
 * @property {string} error
 * @property {string} startedAt
 */

/**
 * @typedef {object} Connector
 * @property {string} id
 * @property {string} name
 * @property {'stdio'|'http'} transport
 * @property {string} command
 * @property {string[]} args
 * @property {string} cwd
 * @property {string} url
 * @property {boolean} enabled
 * @property {string|null} preset
 * @property {boolean} hasSecrets
 * @property {string[]} envKeys     names only; values never leave the backend
 * @property {string[]} headerKeys
 * @property {ConnectorStatus} status
 * @property {ConnectorTool[]} tools
 */

/**
 * @typedef {object} PresetField
 * @property {string} key
 * @property {string} label
 * @property {'path'|'paths'|'text'} kind
 * @property {string} placeholder
 * @property {boolean} required
 * @property {string} default      found on this machine by the backend, '' when not
 */

/**
 * @typedef {object} Preset
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} category
 * @property {string} command
 * @property {string[]} args       may hold {placeholders} named by fields
 * @property {PresetField[]} fields
 * @property {string} requires     'npx' | 'uvx' | 'python3'
 * @property {boolean} available   the required program is on PATH
 * @property {boolean} network
 * @property {string} docsUrl
 * @property {string} note
 * @property {string} installHint  how to get the missing program, from the backend
 */

export const TOOL_PERMISSIONS = /** @type {const} */ (['allow', 'ask', 'off']);
const STATES = ['off', 'starting', 'ready', 'error'];

/** Catalog sections in display order; unknown categories follow. */
export const CATEGORY_ORDER = ['Files', 'Developer', 'Network', 'Knowledge', 'Utilities'];

/** @param {unknown} v @returns {string} */
const str = (v) => (typeof v === 'string' ? v : '');

/** Names from a list of keys or an object's keys. @param {unknown} v @returns {string[]} */
function keysOf(v) {
  if (Array.isArray(v)) return v.filter((k) => typeof k === 'string' && k !== '');
  if (v && typeof v === 'object') return Object.keys(v);
  return [];
}

/** @param {any} raw @returns {ConnectorTool} */
function normalizeTool(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const readOnly = t.readOnly === true;
  const permission = TOOL_PERMISSIONS.includes(t.permission) ? t.permission : (readOnly ? 'allow' : 'ask');
  return {
    name: str(t.name),
    title: str(t.title),
    description: str(t.description),
    readOnly,
    permission
  };
}

/**
 * Fills every field the pane reads, so partial payloads cannot crash it.
 * @param {any} raw
 * @returns {Connector}
 */
export function normalizeConnector(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const s = c.status && typeof c.status === 'object' ? c.status : {};
  const tools = Array.isArray(c.tools) ? c.tools.map(normalizeTool).filter((t) => t.name) : [];
  const enabled = c.enabled !== false;
  const state = !enabled ? 'off' : (STATES.includes(s.state) ? s.state : 'off');
  return {
    id: str(c.id),
    name: str(c.name) || 'Unnamed connector',
    transport: c.transport === 'http' ? 'http' : 'stdio',
    command: str(c.command),
    args: Array.isArray(c.args) ? c.args.map(String) : [],
    cwd: str(c.cwd),
    url: str(c.url),
    enabled,
    preset: typeof c.preset === 'string' && c.preset ? c.preset : null,
    hasSecrets: c.hasSecrets === true,
    envKeys: keysOf(c.envKeys ?? c.env),
    headerKeys: keysOf(c.headerKeys ?? c.headers),
    status: {
      state: /** @type {ConnectorState} */ (state),
      toolCount: Number.isFinite(s.toolCount) ? Number(s.toolCount) : tools.length,
      serverName: str(s.serverName),
      serverVersion: str(s.serverVersion),
      error: str(s.error),
      startedAt: str(s.startedAt)
    },
    tools
  };
}

/** @param {any} raw @returns {PresetField} */
function normalizeField(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return {
    key: str(f.key),
    label: str(f.label) || str(f.key),
    kind: f.kind === 'paths' || f.kind === 'path' ? f.kind : 'text',
    placeholder: str(f.placeholder),
    required: f.required === true,
    default: str(f.default)
  };
}

/**
 * @param {any} raw
 * @returns {Preset|null}
 */
export function normalizePreset(raw) {
  const p = raw && typeof raw === 'object' ? raw : null;
  if (!p || !str(p.id)) return null;
  return {
    id: str(p.id),
    name: str(p.name) || str(p.id),
    description: str(p.description),
    category: str(p.category) || 'Utilities',
    command: str(p.command),
    args: Array.isArray(p.args) ? p.args.map(String) : [],
    fields: Array.isArray(p.fields) ? p.fields.map(normalizeField).filter((f) => f.key) : [],
    requires: str(p.requires),
    available: p.available !== false,
    network: p.network === true,
    docsUrl: /^https?:\/\//i.test(str(p.docsUrl)) ? str(p.docsUrl) : '',
    note: str(p.note),
    installHint: str(p.installHint)
  };
}

/** @param {string} id */
const enc = (id) => encodeURIComponent(id);

/** @param {{ signal?: AbortSignal }} [opts] @returns {Promise<Connector[]>} */
export async function listConnectors(opts = {}) {
  const p = await apiFetch('/api/connectors', { signal: opts.signal });
  return Array.isArray(p?.connectors) ? p.connectors.map(normalizeConnector) : [];
}

/** @param {{ signal?: AbortSignal }} [opts] @returns {Promise<Preset[]>} */
export async function getCatalog(opts = {}) {
  const p = await apiFetch('/api/connectors/catalog', { signal: opts.signal });
  const list = Array.isArray(p?.presets) ? p.presets.map(normalizePreset) : [];
  return /** @type {Preset[]} */ (list.filter(Boolean));
}

/**
 * Preset form: `{ presetId, fields }`. Custom: `{ name, transport, command, args,
 * env, cwd }` or `{ name, transport: 'http', url, headers }`.
 * @param {Record<string, any>} input
 * @returns {Promise<Connector>}
 */
export async function createConnector(input) {
  const p = await apiFetch('/api/connectors', { method: 'POST', body: input, timeoutMs: SLOW_MS });
  return normalizeConnector(p?.connector);
}

/**
 * @param {string} id
 * @param {Record<string, any>} patch e.g. `{ enabled: false }` or `{ tools: { read_file: 'allow' } }`
 * @returns {Promise<Connector>}
 */
export async function updateConnector(id, patch) {
  const p = await apiFetch(`/api/connectors/${enc(id)}`, { method: 'PATCH', body: patch, timeoutMs: SLOW_MS });
  return normalizeConnector(p?.connector);
}

/** @param {string} id @returns {Promise<boolean>} */
export async function removeConnector(id) {
  await apiFetch(`/api/connectors/${enc(id)}`, { method: 'DELETE' });
  return true;
}

/** @param {string} id @returns {Promise<Connector>} */
export async function restartConnector(id) {
  const p = await apiFetch(`/api/connectors/${enc(id)}/restart`, { method: 'POST', timeoutMs: SLOW_MS });
  return normalizeConnector(p?.connector);
}

/** Last stderr lines of a local connector. @param {string} id @returns {Promise<string[]>} */
export async function connectorLogs(id) {
  const p = await apiFetch(`/api/connectors/${enc(id)}/logs`);
  return Array.isArray(p?.lines) ? p.lines.map(String) : [];
}

/**
 * Runs one tool now. The click is the approval, so 'ask' tools run; 'off' do not.
 * @param {string} id
 * @param {string} tool
 * @param {Record<string, any>} [args]
 * @returns {Promise<{ text: string, isError: boolean }>}
 */
export async function callConnectorTool(id, tool, args = {}) {
  const p = await apiFetch(`/api/connectors/${enc(id)}/tools/${enc(tool)}/call`, {
    method: 'POST',
    body: { args },
    timeoutMs: SLOW_MS
  });
  const r = p?.result && typeof p.result === 'object' ? p.result : {};
  return { text: str(r.text), isError: r.isError === true };
}

/**
 * Status pill text and Badge tone.
 * @param {Connector} c
 * @returns {{ label: string, tone: 'success'|'neutral'|'danger' }}
 */
export function connectorStatus(c) {
  const state = c.enabled ? c.status.state : 'off';
  if (state === 'ready') {
    const n = c.status.toolCount;
    return { label: `Connected, ${n} tool${n === 1 ? '' : 's'}`, tone: 'success' };
  }
  if (state === 'starting') return { label: 'Starting', tone: 'neutral' };
  if (state === 'error') return { label: 'Error', tone: 'danger' };
  // Switched on but not running: "Off" would contradict the switch.
  return { label: c.enabled ? 'Stopped' : 'Off', tone: 'neutral' };
}

/** @param {string} arg */
function quoteArg(arg) {
  if (arg === '') return '""';
  return /[\s"'\\$`]/.test(arg) ? `"${arg.replace(/(["\\$`])/g, '\\$1')}"` : arg;
}

/**
 * A command and its arguments as one readable shell-style line.
 * @param {string} command
 * @param {string[]} [args]
 */
export function commandLine(command, args = []) {
  return [command, ...args.map(quoteArg)].filter(Boolean).join(' ');
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/**
 * Kind label: Local is a command Mirabilis starts, Local URL a server on this
 * computer, Remote any other URL.
 * @param {{ transport?: string, url?: string }} c
 * @returns {'Local'|'Local URL'|'Remote'}
 */
export function connectorKind(c) {
  if (c?.transport !== 'http') return 'Local';
  let host = '';
  try { host = new URL(String(c.url || '')).hostname.toLowerCase(); } catch { /* not a URL */ }
  return LOOPBACK_HOSTS.includes(host) ? 'Local URL' : 'Remote';
}

/**
 * Row subtitle: what kind of connector and where it runs.
 * @param {Connector} c
 * @returns {{ kind: string, detail: string }}
 */
export function connectorSubtitle(c) {
  const kind = connectorKind(c);
  if (c.transport === 'http') {
    let host = c.url;
    try { host = new URL(c.url).host || c.url; } catch { /* keep the raw text */ }
    return { kind, detail: host };
  }
  return { kind, detail: commandLine(c.command, c.args) };
}

/**
 * One or two capital letters for the avatar.
 * @param {string} name
 */
export function monogram(name) {
  const words = String(name || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Non-empty trimmed lines.
 * @param {string} text
 * @returns {string[]}
 */
export function parseLines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * KEY=value lines; blank lines and # comments are skipped.
 * @param {string} text
 * @returns {{ env: Record<string, string>, error: string }}
 */
export function parseEnvLines(text) {
  /** @type {Record<string, string>} */
  const env = {};
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { env: {}, error: `Environment line ${i + 1}: use KEY=value.` };
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { env: {}, error: `Environment line ${i + 1}: ${key} is not a valid name.` };
    }
    env[key] = line.slice(eq + 1);
  }
  return { env, error: '' };
}

/** @param {string} url */
function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @typedef {object} CustomForm
 * @property {'stdio'|'http'} transport
 * @property {string} name
 * @property {string} command
 * @property {string} args     one per line
 * @property {string} env      KEY=value per line
 * @property {string} cwd
 * @property {string} url
 * @property {string} token    bearer token, optional
 */

/**
 * Validates the Custom form and builds the create body.
 * @param {CustomForm} form
 * @returns {{ input: Record<string, any>|null, error: string }}
 */
export function buildCustomConnector(form) {
  const name = String(form.name || '').trim();
  if (!name || name.length > 60) return { input: null, error: 'Enter a name, up to 60 characters.' };
  if (form.transport === 'http') {
    const url = String(form.url || '').trim();
    if (!isHttpUrl(url)) return { input: null, error: 'Enter a URL starting with http:// or https://.' };
    const token = String(form.token || '').trim().replace(/^Bearer\s+/i, '');
    return {
      input: { name, transport: 'http', url, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      error: ''
    };
  }
  const command = String(form.command || '').trim();
  if (!command) return { input: null, error: 'Enter a command.' };
  const { env, error } = parseEnvLines(form.env);
  if (error) return { input: null, error };
  const cwd = String(form.cwd || '').trim();
  return {
    input: { name, transport: 'stdio', command, args: parseLines(form.args), env, ...(cwd ? { cwd } : {}) },
    error: ''
  };
}

/**
 * Field values for a preset: 'paths' become a list, the rest trimmed strings.
 * Empty optional fields are left out.
 * @param {Preset} preset
 * @param {Record<string, string>} values raw form text keyed by field key
 * @returns {Record<string, string|string[]>}
 */
export function presetFieldValues(preset, values) {
  /** @type {Record<string, string|string[]>} */
  const out = {};
  for (const f of preset.fields) {
    const raw = String(values?.[f.key] ?? '');
    if (f.kind === 'paths') {
      const list = parseLines(raw);
      if (list.length) out[f.key] = list;
    } else if (raw.trim()) {
      out[f.key] = raw.trim();
    }
  }
  return out;
}

/**
 * Starting form values: whatever the backend found on this machine.
 * @param {Preset} preset
 * @returns {Record<string, string>}
 */
export function presetInitialValues(preset) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const f of preset.fields) {
    if (f.default) values[f.key] = f.default;
  }
  return values;
}

/**
 * First missing required field as a sentence, or ''.
 * @param {Preset} preset
 * @param {Record<string, string>} values
 */
export function presetFieldsError(preset, values) {
  const filled = presetFieldValues(preset, values);
  const missing = preset.fields.find((f) => f.required && !filled[f.key]);
  return missing ? `${missing.label} is required.` : '';
}

/**
 * The command a preset will run with the current values, for a preview line.
 * @param {Preset} preset
 * @param {Record<string, string>} values
 */
export function presetCommandPreview(preset, values) {
  const filled = presetFieldValues(preset, values);
  /** @param {string} text */
  const fill = (text) => text.replace(/\{(\w+)\}/g, (m, key) => {
    const v = filled[key];
    if (Array.isArray(v)) return v.join(' ');
    if (v) return v;
    const field = preset.fields.find((f) => f.key === key);
    return `<${field ? field.label.toLowerCase() : key}>`;
  });
  /** @type {string[]} */
  const args = [];
  for (const arg of preset.args) {
    const whole = arg.match(/^\{(\w+)\}$/);
    const val = whole ? filled[whole[1]] : undefined;
    if (whole && Array.isArray(val)) {
      args.push(...val);
      continue;
    }
    args.push(fill(arg));
  }
  // The command can use placeholders too, e.g. a server folder's venv python.
  return commandLine(fill(preset.command), args);
}

/**
 * Presets grouped by category in CATEGORY_ORDER.
 * @param {Preset[]} presets
 * @returns {{ category: string, presets: Preset[] }[]}
 */
export function groupPresets(presets) {
  /** @type {Map<string, Preset[]>} */
  const groups = new Map();
  for (const p of presets) {
    if (!groups.has(p.category)) groups.set(p.category, []);
    groups.get(p.category)?.push(p);
  }
  const rank = (/** @type {string} */ c) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, list]) => ({ category, presets: list }));
}

const REQUIREMENTS = {
  npx: { label: 'Node.js', url: 'https://nodejs.org/en/download' },
  uvx: { label: 'uv', url: 'https://docs.astral.sh/uv/getting-started/installation/' },
  python3: { label: 'Python 3', url: 'https://www.python.org/downloads/' }
};

/**
 * What a preset needs installed, for "Needs uv" notes.
 * @param {string} requires
 * @returns {{ label: string, url: string }}
 */
export function requirementInfo(requires) {
  const hit = /** @type {Record<string, {label: string, url: string}>} */ (REQUIREMENTS)[requires];
  return hit || { label: requires || 'a missing program', url: '' };
}

/**
 * Matches backend isLocalHostUrl: loopback and private LAN hosts stay reachable
 * under Go Dark.
 * @param {string} url
 */
export function isLocalUrl(url) {
  let host = '';
  try {
    host = new URL(String(url || '').trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '[::1]') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * @typedef {object} McpEndpoint
 * @property {boolean} enabled  whether POST /mcp answers
 * @property {string} path
 * @property {string[]} tools   names of the tools it offers
 */

/**
 * Only an explicit false is off, as in the backend.
 * @param {any} raw
 * @returns {McpEndpoint}
 */
export function normalizeMcpEndpoint(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: p.enabled !== false,
    path: str(p.path) || '/mcp',
    tools: Array.isArray(p.tools) ? p.tools.filter((t) => typeof t === 'string' && t !== '') : []
  };
}

/**
 * Mirabilis's own MCP server switch. Rejects on a backend without the route.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<McpEndpoint>}
 */
export async function fetchMcpEndpoint(opts = {}) {
  return normalizeMcpEndpoint(await apiFetch('/api/mcp-endpoint', { signal: opts.signal }));
}

/**
 * @param {{ enabled: boolean }} patch
 * @returns {Promise<McpEndpoint>} what the backend saved
 */
export async function saveMcpEndpoint(patch) {
  return normalizeMcpEndpoint(await apiFetch('/api/mcp-endpoint', { method: 'PUT', body: { enabled: patch.enabled } }));
}

/**
 * The Mirabilis MCP endpoint for other apps. The backend binds 127.0.0.1, and
 * some clients try IPv6 first for "localhost", so the address is spelled out.
 * @param {string} [base]
 */
export function mirabilisMcpUrl(base = API_BASE) {
  const root = String(base || '').replace(/\/+$/, '');
  return `${root.replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1')}/mcp`;
}

/**
 * Shows the ends of a token so it can be recognised without being readable.
 * @param {string} token
 */
export function maskToken(token) {
  const t = String(token || '');
  if (t.length <= 8) return '*'.repeat(t.length);
  return `${t.slice(0, 4)}${'*'.repeat(12)}${t.slice(-4)}`;
}

/** @typedef {'claude-code'|'cursor'|'vscode'} McpClientId */

export const MCP_CLIENTS = /** @type {const} */ ([
  { id: 'claude-code', label: 'Claude Code', hint: 'Run in a terminal' },
  { id: 'cursor', label: 'Cursor', hint: 'Add to ~/.cursor/mcp.json' },
  { id: 'vscode', label: 'VS Code', hint: 'Add to .vscode/mcp.json' }
]);

/**
 * Setup text for another MCP client.
 * @param {McpClientId} client
 * @param {string} url
 * @param {string} token
 */
export function clientSnippet(client, url, token) {
  const auth = `Bearer ${token}`;
  if (client === 'claude-code') {
    return `claude mcp add --transport http mirabilis ${url} --header "Authorization: ${auth}"`;
  }
  if (client === 'vscode') {
    return JSON.stringify({ servers: { mirabilis: { type: 'http', url, headers: { Authorization: auth } } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { mirabilis: { url, headers: { Authorization: auth } } } }, null, 2);
}
