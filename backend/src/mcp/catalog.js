// @ts-check
// Ready-made local connectors: a command, the fields a person fills in, and whether
// its launcher (npx, uvx, python3) is installed on this machine.

import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandTilde, findExecutable } from './stdioClient.js';

/**
 * @typedef {object} PresetField
 * @property {string} key
 * @property {string} label
 * @property {'path'|'paths'|'text'} kind
 * @property {string} placeholder
 * @property {boolean} required
 * @property {'dir'|'file'|'git'} [expect]  checked before saving, so a typo fails on Add
 */

/**
 * @typedef {object} Preset
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {'Files'|'Developer'|'Network'|'Knowledge'|'Utilities'} category
 * @property {'stdio'} transport
 * @property {string} command
 * @property {string[]} args  {key} placeholders; a whole-argument {key} of kind paths becomes one argument per path
 * @property {Record<string, string>} [env]  may use {dataDir}
 * @property {string} [cwdFrom]  run in the folder of this path field
 * @property {PresetField[]} fields
 * @property {'npx'|'uvx'|'python3'} requires
 * @property {boolean} network
 * @property {string} docsUrl
 * @property {string} note
 */

const SERVERS = 'https://github.com/modelcontextprotocol/servers/tree/main/src';

/** @type {Preset[]} */
export const PRESETS = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, search and edit files in the folders you choose.',
    category: 'Files',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{folders}'],
    fields: [
      { key: 'folders', label: 'Folders', kind: 'paths', placeholder: '~/Documents', required: true, expect: 'dir' }
    ],
    requires: 'npx',
    network: false,
    docsUrl: `${SERVERS}/filesystem`,
    note: 'It can reach only the folders listed here, one per line.'
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'A local knowledge graph the assistant can save facts to and recall later.',
    category: 'Knowledge',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: { MEMORY_FILE_PATH: '{dataDir}/connector-memory.jsonl' },
    fields: [],
    requires: 'npx',
    network: false,
    docsUrl: `${SERVERS}/memory`,
    note: 'Saved in connector-memory.jsonl in the Mirabilis data folder.'
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Lets the assistant work through a hard problem step by step and revise its steps.',
    category: 'Utilities',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    fields: [],
    requires: 'npx',
    network: false,
    docsUrl: `${SERVERS}/sequentialthinking`,
    note: ''
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Status, diffs, history, branches and commits for one local repository.',
    category: 'Developer',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '{repo}'],
    fields: [
      { key: 'repo', label: 'Repository folder', kind: 'path', placeholder: '~/Projects/my-repo', required: true, expect: 'git' }
    ],
    requires: 'uvx',
    network: false,
    docsUrl: `${SERVERS}/git`,
    note: ''
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetches web pages and turns them into text the assistant can read.',
    category: 'Network',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    fields: [],
    requires: 'uvx',
    network: true,
    docsUrl: `${SERVERS}/fetch`,
    note: 'It reaches the internet itself, so Go Dark does not filter it.'
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Current time and time zone conversions.',
    category: 'Utilities',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    fields: [],
    requires: 'uvx',
    network: false,
    docsUrl: `${SERVERS}/time`,
    note: ''
  },
  {
    id: 'junos',
    name: 'Junos',
    description: 'Run operational commands and read or change configuration on Juniper devices.',
    category: 'Network',
    transport: 'stdio',
    command: 'python3',
    args: ['{script}', '-f', '{devices}', '-t', 'stdio'],
    cwdFrom: 'script',
    fields: [
      { key: 'script', label: 'Server script (jmcp.py)', kind: 'path', placeholder: '~/junos-mcp-server/jmcp.py', required: true, expect: 'file' },
      { key: 'devices', label: 'Devices file', kind: 'path', placeholder: '~/junos-mcp-server/devices.json', required: true, expect: 'file' }
    ],
    requires: 'python3',
    network: true,
    docsUrl: 'https://github.com/Juniper/junos-mcp-server',
    note: 'Clone the repository and run pip install -r requirements.txt first. The devices file lists each device and how to log in to it.'
  },
  {
    id: 'everything',
    name: 'Everything',
    description: 'The MCP reference server, with sample tools, prompts and resources.',
    category: 'Developer',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    fields: [],
    requires: 'npx',
    network: false,
    docsUrl: `${SERVERS}/everything`,
    note: 'Reference server for testing'
  }
];

/**
 * @param {'npx'|'uvx'|'python3'} requires
 * @param {string} platform
 */
function installHint(requires, platform) {
  const mac = platform === 'darwin';
  if (requires === 'uvx') {
    return mac
      ? 'Needs uv. Install it with: brew install uv'
      : 'Needs uv. See https://docs.astral.sh/uv/getting-started/installation/';
  }
  if (requires === 'python3') return mac ? 'Needs Python 3. Install it with: brew install python' : 'Needs Python 3.';
  return 'Needs Node.js, which includes npx. Get it from https://nodejs.org';
}

/**
 * The catalog as the app shows it, with `available` checked against this PATH.
 * @param {{pathValue: string, platform?: string}} opts
 */
export function buildCatalog({ pathValue, platform = process.platform }) {
  /** @type {Map<string, boolean>} */
  const found = new Map();
  /** @param {string} bin */
  const has = (bin) => {
    if (!found.has(bin)) found.set(bin, findExecutable(bin, pathValue, platform) != null);
    return found.get(bin) === true;
  };
  return PRESETS.map((preset) => {
    const available = has(preset.requires);
    return {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      category: preset.category,
      transport: preset.transport,
      command: preset.command,
      args: [...preset.args],
      fields: preset.fields.map(({ key, label, kind, placeholder, required }) => ({ key, label, kind, placeholder, required })),
      requires: preset.requires,
      available,
      network: preset.network,
      docsUrl: preset.docsUrl,
      note: preset.note,
      installHint: available ? '' : installHint(preset.requires, platform)
    };
  });
}

/** @param {string} id */
export function findPreset(id) {
  return PRESETS.find((preset) => preset.id === id) || null;
}

/**
 * Field input as a list: an array, or text with one entry per line for kind paths.
 * @param {unknown} value
 * @param {PresetField['kind']} kind
 */
function readField(value, kind) {
  /** @type {string[]} */
  let list;
  if (Array.isArray(value)) list = value.map((v) => String(v ?? ''));
  else if (value == null) list = [];
  else list = kind === 'paths' ? String(value).split(/\r?\n/) : [String(value)];
  list = list.map((v) => v.trim()).filter(Boolean);
  return kind === 'paths' ? list : list.slice(0, 1);
}

/**
 * Check a path field and return it in stored form: ~ kept, anything else absolute.
 * @param {string} value
 * @param {PresetField} field
 * @param {string} home
 */
function checkPath(value, field, home) {
  const full = path.resolve(home, expandTilde(value, home));
  let info;
  try {
    info = statSync(full);
  } catch {
    throw new Error(`Not found: ${value}`);
  }
  if ((field.expect === 'dir' || field.expect === 'git') && !info.isDirectory()) throw new Error(`Not a folder: ${value}`);
  if (field.expect === 'file' && !info.isFile()) throw new Error(`Not a file: ${value}`);
  if (field.expect === 'git') {
    try {
      statSync(path.join(full, '.git'));
    } catch {
      throw new Error(`Not a git repository: ${value}`);
    }
  }
  return value.startsWith('~') ? value : full;
}

/**
 * Fill a preset's placeholders from the person's fields. Throws plain-worded errors.
 * @param {Preset} preset
 * @param {unknown} fields
 * @param {{dataDir: string, home?: string}} ctx
 */
export function connectorFromPreset(preset, fields, { dataDir, home = os.homedir() }) {
  const input = /** @type {Record<string, unknown>} */ (fields && typeof fields === 'object' ? fields : {});
  /** @type {Record<string, string[]>} */
  const values = { dataDir: [dataDir] };
  for (const field of preset.fields) {
    const list = readField(input[field.key], field.kind);
    if (field.required && list.length === 0) throw new Error(`${field.label} is required.`);
    values[field.key] = field.kind === 'text' ? list : list.map((v) => checkPath(v, field, home));
  }
  /** @type {string[]} */
  const args = [];
  for (const arg of preset.args) {
    const whole = /^\{(\w+)\}$/.exec(arg);
    if (whole && values[whole[1]]) {
      args.push(...values[whole[1]]);
      continue;
    }
    args.push(arg.replace(/\{(\w+)\}/g, (_m, key) => (values[key] || []).join(' ')));
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(preset.env || {})) {
    env[key] = value.replace(/\{(\w+)\}/g, (_m, name) => (values[name] || [''])[0]);
  }
  const anchor = preset.cwdFrom ? values[preset.cwdFrom]?.[0] : '';
  return {
    name: preset.name,
    transport: /** @type {'stdio'} */ ('stdio'),
    command: preset.command,
    args,
    env,
    cwd: anchor ? path.dirname(anchor) : '',
    preset: preset.id
  };
}
