// @ts-check
// Tools of the built-in This computer MCP server: troubleshooting views of the machine it
// runs on, macOS, Linux or Windows, plus kill_process. Every probe is bounded in time and
// output, and a utility this system lacks is a plain error, never a crash.

import os from 'node:os';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';

import { getFsRoot, safeResolvePath } from '../agent/sandbox.js';
import {
  COMMAND_TIMEOUT_MS, clampInt, clip, createProbeRunner, createSystemTools, execRunner, firstLine,
  parseDfVolumes, scrub
} from '../agent/systemTools.js';
import { isLocalHost, readGoDark } from '../egress.js';

/**
 * Result text the agent keeps whole. Its observation holds 4,000 characters of the text
 * JSON-escaped inside {"text": ...}, so the escaped form has its own, larger limit.
 */
export const RESULT_BUDGET = 3_500;
const ESCAPED_BUDGET = 3_900;

export const GO_DARK_BLOCKED = 'Blocked by Go Dark';

const PS_TIMEOUT_MS = 20_000;
const DISK_BUDGET_MS = 20_000;
const DF_TIMEOUT_MS = 8_000;
const DISK_CONCURRENCY = 4;
// macOS asks before an app reads these, so a home listing names them instead of
// measuring them; passing one as the path measures it.
const MAC_ASK_FIRST = ['Desktop', 'Documents', 'Downloads'];
// Other apps' data and iCloud Drive inside ~/Library raise the same kind of prompt.
const MAC_LIBRARY_SKIP = ['Containers', 'Group Containers', 'Mobile Documents'];
const LOG_TIMEOUT_MS = 20_000;
/** The macOS log prints oldest first; this much of its newest output is kept. */
const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const MAC_LOG_MAX_MINUTES = 60;
const MAC_INFO_MAX_MINUTES = 10;
const LOG_LINE_CHARS = 200;
const KILL_WAIT_MS = 3_000;
const DNS_TIMEOUT_MS = 5_000;

/** launchd exit signals that mean a crash rather than a stop. */
const CRASH_SIGNALS = new Set([4, 5, 6, 7, 8, 10, 11, 12]);

/** Real host facts and calls; tests replace any of them. */
const DEFAULT_HOST = {
  homedir: () => os.homedir(),
  cpus: () => os.cpus(),
  totalmem: () => os.totalmem(),
  uid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
  pid: () => process.pid,
  ppid: () => process.ppid,
  /** True in the desktop app, whose runtime is Electron acting as Node. */
  electron: () => Boolean(process.versions.electron),
  /** @param {string} key */
  env: (key) => process.env[key],
  /** @param {number} pid @param {NodeJS.Signals|0} sig */
  kill: (pid, sig) => process.kill(pid, sig),
  /** @param {string} file */
  readText: (file) => fsp.readFile(file, 'utf8'),
  /** @param {string} dir */
  readdir: (dir) => fsp.readdir(dir, { withFileTypes: true }),
  /** @param {string} p */
  lstat: (p) => fsp.lstat(p),
  /** @param {string} p */
  stat: (p) => fsp.stat(p),
  /** @param {string} p */
  statfs: (p) => fsp.statfs(p),
  dnsServers: () => dns.getServers(),
  /** @param {string} name */
  lookup: (name) => dns.promises.lookup(name, { all: true }),
  /** @param {string} name @param {'A'|'AAAA'} type */
  resolve: (name, type) => new dns.promises.Resolver({ timeout: 2_000, tries: 1 }).resolve(name, type),
  /** @param {string} ip */
  reverse: (ip) => new dns.promises.Resolver({ timeout: 2_000, tries: 1 }).reverse(ip),
  /** @param {net.NetConnectOpts} opts */
  connect: (opts) => net.createConnection(opts)
};

/** @typedef {typeof DEFAULT_HOST} MachineHost */

/**
 * @typedef {object} MachineTool
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {Record<string, any>} inputSchema
 * @property {Record<string, boolean>} annotations
 */

/**
 * @typedef {object} ToolResult
 * @property {Array<{type: 'text', text: string}>} content
 * @property {boolean} [isError]
 */

// Small helpers

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {any} value @returns {any[]} */
const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

/** @param {string} p */
function baseName(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Sizes in decimal units, as Finder and drive labels show them. @param {number} bytes */
export function formatBytes(bytes) {
  const n = Math.max(0, Math.round(Number(bytes) || 0));
  if (n < 1000) return `${n} B`;
  /** @type {Array<[string, number]>} */
  const units = [['KB', 1e3], ['MB', 1e6], ['GB', 1e9], ['TB', 1e12]];
  let [unit, size] = units[0];
  for (const u of units) if (n >= u[1]) [unit, size] = u;
  const v = n / size;
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${unit}`;
}

/** Video memory in binary units, as GPU vendors label it. @param {number} bytes */
function formatVram(bytes) {
  const gb = Number(bytes) / 1024 ** 3;
  if (!(gb > 0)) return undefined;
  return gb >= 1 ? `${Math.round(gb * 10) / 10} GB` : `${Math.round(Number(bytes) / 1024 ** 2)} MB`;
}

/** @param {Date} d */
function clock(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** @param {Date} d */
function day(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A reason as a sentence: ends with one full stop. @param {string} text */
const sentence = (text) => (/[.!?]$/.test(String(text).trim()) ? String(text).trim() : `${String(text).trim()}.`);

/** The error text a tool returns: one plain line. @param {unknown} err */
function plainError(err) {
  const e = /** @type {any} */ (err);
  const text = String(e?.message || e || 'The tool failed.').replace(/\s+/g, ' ').trim();
  return clip(text, 400);
}

/**
 * Run fn over items, at most `limit` at a time, in order of start.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** @param {string} text */
function fitsBudget(text) {
  return text.length <= RESULT_BUDGET && JSON.stringify(text).length <= ESCAPED_BUDGET;
}

/**
 * JSON text of a result within the budget. Lists are shortened in the order given, from
 * the end or the start (logs keep their newest lines), and say how many they left out.
 * @param {Record<string, any>} out
 * @param {Array<[string, 'start'|'end']>} [lists]
 */
export function fitResult(out, lists = []) {
  let text = JSON.stringify(out);
  if (fitsBudget(text)) return text;
  const copy = structuredClone(out);
  /**
   * The largest count in [min, max] whose build fits, by bisection: a list of thousands
   * costs a few serializations, not one per item.
   * @param {number} min @param {number} max @param {(k: number) => string} build
   */
  const largest = (min, max, build) => {
    let lo = min;
    let hi = max;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fitsBudget(build(mid))) lo = mid;
      else hi = mid - 1;
    }
    return build(lo);
  };
  for (const [key, from] of lists) {
    const value = out[key];
    if (typeof value === 'string' && value.includes('\n')) {
      // A block of lines: keep the newest whole lines.
      const lines = value.split('\n');
      const n = lines.length;
      text = largest(1, n - 1, (k) => {
        copy[key] = lines.slice(n - k).join('\n');
        if (typeof out.shown === 'number') copy.shown = Math.max(0, out.shown - (n - k));
        copy.truncated = true;
        return JSON.stringify(copy);
      });
    } else if (Array.isArray(value) && value.length > 0) {
      const counter = `${key}NotShown`;
      const before = Number(out[counter]) || 0;
      const n = value.length;
      text = largest(0, n - 1, (k) => {
        copy[key] = from === 'start' ? value.slice(n - k) : value.slice(0, k);
        copy[counter] = before + (n - k);
        return JSON.stringify(copy);
      });
    }
    if (fitsBudget(text)) return text;
  }
  // Still over: shorten every long string, then cut as a last resort.
  /** @param {any} v @returns {any} */
  const shorten = (v) => {
    if (typeof v === 'string') return clip(v, 80);
    if (Array.isArray(v)) return v.map(shorten);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x)]));
    return v;
  };
  text = JSON.stringify(shorten(copy));
  while (!fitsBudget(text)) text = text.slice(0, Math.floor(text.length * 0.9));
  return text;
}

/**
 * A command runner like execRunner. With tailBytes it keeps only the newest output, so a
 * command that prints oldest first, such as the macOS log, still yields its latest lines.
 * @type {import('../agent/systemTools.js').RunCommand}
 */
export function machineRunner(command, args, opts = {}) {
  if (!opts.tailBytes) return execRunner(command, args, opts);
  const { timeoutMs = COMMAND_TIMEOUT_MS, env, signal } = opts;
  const tailBytes = opts.tailBytes;
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {Buffer[]} */
    const chunks = [];
    let held = 0;
    let dropped = 0;
    let stderr = '';
    let timedOut = false;
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, args, {
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    /** @param {Error|null} err @param {{stdout: string, stderr: string, dropped: number}} [value] */
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(/** @type {any} */ (value));
    };
    child.stdout?.on('data', (/** @type {Buffer} */ buf) => {
      chunks.push(buf);
      held += buf.length;
      while (chunks.length > 1 && held - chunks[0].length >= tailBytes) {
        held -= chunks[0].length;
        dropped += /** @type {Buffer} */ (chunks.shift()).length;
      }
    });
    child.stderr?.on('data', (/** @type {Buffer} */ buf) => {
      if (stderr.length < 64 * 1024) stderr += buf.toString('utf8');
    });
    child.on('error', (err) => settle(Object.assign(err, { stdout: '', stderr })));
    child.on('close', (code, sig) => {
      let out = Buffer.concat(chunks);
      if (out.length > tailBytes) {
        dropped += out.length - tailBytes;
        out = out.subarray(out.length - tailBytes);
      }
      let stdout = out.toString('utf8');
      // The oldest kept line starts mid-way.
      if (dropped) stdout = stdout.slice(stdout.indexOf('\n') + 1);
      if (code === 0) {
        settle(null, { stdout, stderr, dropped });
        return;
      }
      const reason = timedOut ? `${command} timed out after ${timeoutMs}ms`
        : signal?.aborted ? `${command} was cancelled` : `${command} exited with ${code ?? sig}`;
      settle(Object.assign(new Error(reason), { code, exitCode: code, stdout, stderr, dropped }));
    });
  });
}

/**
 * A host name or IP address as a user types it: no spaces, no leading dash that a command
 * could read as an option.
 * @param {unknown} value
 * @param {string} [field]
 */
export function parseHost(value, field = 'host') {
  let s = String(value ?? '').trim();
  if (!s) throw new Error(`${field} is required.`);
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (net.isIP(s.replace(/%[\w.-]+$/, ''))) return s;
  const name = s.replace(/\.$/, '');
  if (name.length > 253 || !/^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/.test(name) || name.includes('..')) {
    throw new Error(`${field} must be a host name or IP address.`);
  }
  return name;
}

// Parsers, exported for tests

/**
 * `launchctl list`: the jobs of the user's launchd domain.
 * @param {string} stdout
 */
export function parseLaunchctlList(stdout) {
  /** @type {Array<{label: string, pid: number|null, status: number|null}>} */
  const rows = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const m = line.match(/^\s*(-|\d+)\s+(-|-?\d+)\s+(\S.*?)\s*$/);
    if (!m) continue;
    rows.push({ label: m[3], pid: m[1] === '-' ? null : Number(m[1]), status: m[2] === '-' ? null : Number(m[2]) });
  }
  return rows;
}

/**
 * The services block of `launchctl print system`: system daemons, readable without root.
 * @param {string} stdout
 */
export function parseLaunchctlPrint(stdout) {
  /** @type {Array<{label: string, pid: number|null, status: number|null}>} */
  const rows = [];
  let inside = false;
  for (const line of String(stdout ?? '').split('\n')) {
    if (!inside) {
      if (/^\tservices = \{\s*$/.test(line)) inside = true;
      continue;
    }
    if (/^\t\}\s*$/.test(line)) break;
    const m = line.match(/^\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/);
    if (!m) continue;
    const pid = Number(m[1]);
    rows.push({ label: m[3], pid: pid > 0 ? pid : null, status: /^-?\d+$/.test(m[2]) ? Number(m[2]) : null });
  }
  return rows;
}

/**
 * Overrides from `launchctl print-disabled`: label to disabled.
 * @param {string} stdout
 */
export function parseLaunchctlDisabled(stdout) {
  /** @type {Map<string, boolean>} */
  const map = new Map();
  for (const m of String(stdout ?? '').matchAll(/"([^"]+)"\s*=>\s*(\w+)/g)) {
    map.set(m[1], m[2] === 'disabled' || m[2] === 'true');
  }
  return map;
}

/** @param {number|null} pid @param {number|null} status */
function launchdState(pid, status) {
  if (pid) return 'running';
  if (status == null || status === 0) return 'stopped';
  if (status > 0) return 'failed';
  return CRASH_SIGNALS.has(-status) ? 'failed' : 'stopped';
}

/** @param {number|null} status */
function launchdExit(status) {
  if (status == null || status === 0) return undefined;
  return status > 0 ? `exit ${status}` : `signal ${-status}`;
}

/** @param {string} s */
function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * What a launchd plist in XML form starts, and when.
 * @param {string} xml
 */
export function parseLaunchdPlist(xml) {
  const text = String(xml ?? '');
  const str = (/** @type {string} */ key) => {
    const m = text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return m ? decodeXml(m[1]) : undefined;
  };
  const bool = (/** @type {string} */ key) => {
    const m = text.match(new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`));
    return m ? m[1] === 'true' : undefined;
  };
  const block = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] || '';
  const argv = [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => decodeXml(m[1]));
  const program = str('Program') || argv[0] || '';
  const command = [baseName(program), ...argv.slice(1)].filter(Boolean).join(' ');
  let starts = 'on demand';
  if (/<key>KeepAlive<\/key>\s*(<true\s*\/>|<dict>)/.test(text)) starts = 'kept running';
  else if (bool('RunAtLoad')) starts = 'at load';
  else if (/<key>(StartInterval|StartCalendarInterval)<\/key>/.test(text)) starts = 'scheduled';
  else if (/<key>(WatchPaths|QueueDirectories|StartOnMount)<\/key>/.test(text)) starts = 'on change';
  return { label: str('Label'), command, starts, disabled: bool('Disabled') === true };
}

/**
 * `systemctl list-units --type=service --all --plain --no-legend`.
 * @param {string} stdout
 */
export function parseSystemctlUnits(stdout) {
  /** @type {Array<{unit: string, load: string, active: string, sub: string, description: string}>} */
  const rows = [];
  for (const raw of String(stdout ?? '').split('\n')) {
    // Failed and missing units carry a marker column: a dot, a cross or an asterisk.
    const line = raw.replace(/^\s*[\u{25CF}\u{D7}*]\s+/u, '').trim();
    const m = line.match(/^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (m) rows.push({ unit: m[1], load: m[2], active: m[3], sub: m[4], description: m[5].trim() });
  }
  return rows;
}

/**
 * The summary lines of ping on macOS, Linux (iputils and BusyBox) and Windows. Windows
 * output is localized, so it is read by shape: the reply lines are the block after the
 * first line, and only replies with a time are answers.
 * @param {string} stdout
 * @param {string} platform
 */
export function parsePing(stdout, platform) {
  const text = String(stdout ?? '').replace(/\r/g, '');
  /** @type {{address?: string, sent: number, received: number, lossPercent: number, rttMs?: {min: number, avg: number, max: number}}|null} */
  let out = null;
  if (platform === 'win32') {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.trim());
    if (start < 0) return null;
    const stats = text.match(/=\s*(\d+),[^=\n]*=\s*(\d+),[^=\n]*=\s*(\d+)\s*\((\d+)%/);
    if (!stats) return null;
    let received = 0;
    for (let i = start + 1; i < lines.length && lines[i].trim(); i += 1) {
      if (/[<=]\s?\d+\s?ms\b/i.test(lines[i])) received += 1;
    }
    const sent = Number(stats[1]);
    received = Math.min(received, Number(stats[2]));
    const address = lines[start].match(/\[([^\]]+)\]/)?.[1]
      || lines[start].match(/\s((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]*:[0-9a-f:]+)\s/i)?.[1];
    out = { sent, received, lossPercent: sent ? Math.round(((sent - received) / sent) * 100) : 100 };
    if (address) out.address = address;
    const rtt = text.match(/=\s*(\d+)\s?ms,[^=\n]*=\s*(\d+)\s?ms,[^=\n]*=\s*(\d+)\s?ms/i);
    // Windows prints minimum, maximum, average.
    if (rtt && received > 0) out.rttMs = { min: Number(rtt[1]), avg: Number(rtt[3]), max: Number(rtt[2]) };
    return out;
  }
  const stats = text.match(/(\d+) packets transmitted, (\d+) (?:packets )?received/);
  if (!stats) return null;
  const sent = Number(stats[1]);
  const received = Number(stats[2]);
  const loss = text.match(/([\d.]+)% packet loss/);
  out = { sent, received, lossPercent: loss ? Math.round(Number(loss[1])) : (sent ? Math.round(((sent - received) / sent) * 100) : 100) };
  // "PING host (address)" on Linux and macOS, "PING6(...) source --> address" from macOS ping6.
  const address = text.match(/^PING\s.*?\(([^)]+)\)/m)?.[1] || text.match(/^PING6.*-->\s*(\S+)/m)?.[1];
  if (address) out.address = address;
  const rtt = text.match(/= ([\d.]+)\/([\d.]+)\/([\d.]+)/);
  if (rtt && received > 0) out.rttMs = { min: Number(rtt[1]), avg: Number(rtt[2]), max: Number(rtt[3]) };
  return out;
}

/**
 * The replies of a ping stopped before its summary. macOS ping6 has no deadline flag
 * and waits 10s for a silent host, so it is stopped sooner and its replies counted. It
 * flushes its output at each reply only, so no output means no reply.
 * @param {string} stdout
 * @param {number} sent  pings sent, all of them by the time it was stopped
 */
export function parsePingReplies(stdout, sent) {
  const text = String(stdout ?? '');
  const times = [...text.matchAll(/\bbytes from .*?\btime[=<]\s?([\d.]+)\s?ms\b/g)].map((m) => Number(m[1]));
  const received = Math.min(times.length, sent);
  /** @type {{address?: string, sent: number, received: number, lossPercent: number, rttMs?: {min: number, avg: number, max: number}}} */
  const out = { sent, received, lossPercent: sent ? Math.round(((sent - received) / sent) * 100) : 100 };
  const address = text.match(/^PING6.*-->\s*(\S+)/m)?.[1] || text.match(/^PING\s.*?\(([^)]+)\)/m)?.[1];
  if (address) out.address = address;
  if (received > 0) {
    const ms = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;
    out.rttMs = { min: ms(Math.min(...times)), avg: ms(times.reduce((a, b) => a + b, 0) / times.length), max: ms(Math.max(...times)) };
  }
  return out;
}

/**
 * One entry per line of `log show --style compact`; continuation lines join the entry above.
 * @param {string} stdout
 */
export function parseMacLog(stdout) {
  const LEVELS = /** @type {Record<string, string>} */ ({ E: 'error', F: 'fault', Df: 'default', I: 'info', Db: 'debug' });
  /** @type {Array<{time: Date, level: string, process: string, pid: string, message: string}>} */
  const rows = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const m = line.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.\d+\s+(\S+)\s+(.+?)\[(\d+):[0-9a-fA-Fx]+\]\s?(.*)$/);
    if (m) {
      const time = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
      rows.push({ time, level: LEVELS[m[7]] || m[7].toLowerCase(), process: m[8].trim(), pid: m[9], message: m[10] });
    } else if (rows.length && line.trim() && !/^Timestamp\s/.test(line)) {
      const last = rows[rows.length - 1];
      if (last.message.length < LOG_LINE_CHARS) last.message += ` ${line.trim()}`;
    }
  }
  return rows;
}

const JOURNAL_LEVELS = ['critical', 'critical', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];

/**
 * `journalctl -o json`: one object per line.
 * @param {string} stdout
 */
export function parseJournal(stdout) {
  /** @type {Array<{time: Date, level: string, process: string, pid: string, message: string}>} */
  const rows = [];
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    let message = e.MESSAGE;
    // Binary messages arrive as byte arrays.
    if (Array.isArray(message)) message = Buffer.from(message.filter((b) => Number.isInteger(b))).toString('utf8');
    const micros = Number(e.__REALTIME_TIMESTAMP);
    rows.push({
      time: new Date(Number.isFinite(micros) ? Math.floor(micros / 1000) : 0),
      level: JOURNAL_LEVELS[Number(e.PRIORITY)] || 'info',
      process: String(e.SYSLOG_IDENTIFIER || e._COMM || e._SYSTEMD_UNIT || 'unknown'),
      pid: e._PID ? String(e._PID) : '',
      message: String(message ?? '')
    });
  }
  rows.sort((a, b) => a.time.getTime() - b.time.getTime());
  return rows;
}

const WIN_LEVELS = ['info', 'critical', 'error', 'warning', 'info', 'verbose'];

/**
 * Rows of the Get-WinEvent script, newest first as PowerShell returns them.
 * @param {any} json
 */
export function parseWinEvents(json) {
  const rows = asArray(json).filter((e) => e && typeof e === 'object').map((e) => ({
    time: new Date(String(e.time || '')),
    level: WIN_LEVELS[Number(e.level)] || 'info',
    process: `${String(e.source || 'unknown').replace(/^Microsoft-Windows-/, '')} ${e.id ?? ''}`.trim(),
    pid: '',
    message: String(e.message || '').trim() || `(no message, event ${e.id ?? '?'})`
  }));
  rows.sort((a, b) => a.time.getTime() - b.time.getTime());
  return rows;
}

/** @param {string} text */
function maskNumbers(text) {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#')
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\d+/g, '#');
}

/**
 * Entries with the same source and message, numbers aside, become one line with a
 * count; lines stay in the order of their newest occurrence.
 * @param {Array<{time: Date, level: string, process: string, pid: string, message: string}>} rows oldest first
 */
export function groupLogEntries(rows) {
  /** @type {Map<string, {count: number, last: typeof rows[number]}>} */
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.process}\n${row.level}\n${maskNumbers(row.message)}`;
    const g = groups.get(key);
    if (g) {
      groups.delete(key);
      groups.set(key, { count: g.count + 1, last: row });
    } else {
      groups.set(key, { count: 1, last: row });
    }
  }
  return [...groups.values()];
}

/**
 * @param {string} name
 * @param {string} platform
 */
function vendorRank(name, platform) {
  return platform === 'darwin' && /^(com\.apple\.|application\.com\.apple\.)/.test(name) ? 1 : 0;
}

const STATE_RANK = /** @type {Record<string, number>} */ ({ failed: 0, running: 1 });

/**
 * @param {object} [opts]
 * @param {string} [opts.platform]
 * @param {import('../agent/systemTools.js').RunCommand} [opts.runCommand]  injected in tests
 * @param {Partial<MachineHost>} [opts.host]  host facts and calls, replaceable in tests
 * @param {string} [opts.dataDir]  where go-dark.json lives (MIRABILIS_DATA_DIR)
 * @param {() => number} [opts.now]  clock for time budgets
 */
export function createMachineTools({ platform = process.platform, runCommand, host, dataDir = '', now = () => Date.now() } = {}) {
  /** @type {MachineHost} */
  const h = { ...DEFAULT_HOST, ...(host || {}) };
  const isWin = platform === 'win32';
  const isMac = platform === 'darwin';
  const isLinux = platform === 'linux';
  const runner = typeof runCommand === 'function' ? runCommand : machineRunner;
  const run = createProbeRunner({ platform, runCommand: runner });
  const system = createSystemTools({ platform, runCommand: runner, host: /** @type {any} */ (host) });

  // Shared probes

  // Warnings would land in stdout ahead of the JSON; output is UTF-8 without a BOM.
  const PS_PRELUDE = "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='SilentlyContinue';$WarningPreference='SilentlyContinue';"
    + '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false;';

  /** Windows PowerShell 5.1 ships with Windows 10 and 11; the full path skips PATH. */
  function powershellPath() {
    const root = h.env('SystemRoot') || h.env('SYSTEMROOT') || h.env('windir');
    return root ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  }

  /**
   * Run a script and parse the JSON it prints. -EncodedCommand sidesteps the quoting
   * rules between Node, the Windows command line and PowerShell.
   * @param {string} script
   * @param {AbortSignal} [signal]
   * @param {number} [timeoutMs]
   */
  async function powershell(script, signal, timeoutMs = PS_TIMEOUT_MS) {
    const encoded = Buffer.from(PS_PRELUDE + script, 'utf16le').toString('base64');
    const r = await run(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], signal, { timeoutMs });
    const text = r.stdout.replace(/^\u{FEFF}/u, '').trim();
    if (!text) {
      if (r.ok) return null;
      if (r.missing) throw new Error('PowerShell is not available on this system.');
      if (r.timedOut) throw new Error(`PowerShell did not finish within ${Math.round(timeoutMs / 1000)}s.`);
      throw new Error(`PowerShell failed: ${clip(firstLine(r.stderr) || r.error, 160)}`);
    }
    // ConvertTo-Json -Compress prints one line; anything else a module printed is skipped.
    const json = text.split(/\r?\n/).reverse().find((l) => /^[[{]/.test(l.trim()));
    try {
      return JSON.parse(String(json));
    } catch {
      throw new Error(`PowerShell output was not understood: ${clip(firstLine(text), 120)}`);
    }
  }

  /**
   * Refuse a target outside this machine and the LAN while Go Dark is on. Read at call
   * time: the switch lives in the backend, this server only sees the saved file.
   * @param {string} target
   */
  async function assertReachable(target) {
    if (!(await readGoDark(dataDir))) return;
    if (!isLocalHost(target)) throw new Error(`${GO_DARK_BLOCKED}. Turn it off to reach ${target}.`);
  }

  /** @param {string} raw */
  function expandTildeHome(raw) {
    const home = h.homedir();
    if (raw === '~') return home;
    if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2));
    return raw;
  }

  /** @param {unknown} err @param {string} target @param {string} verb */
  function fsError(err, target, verb) {
    const code = /** @type {any} */ (err)?.code;
    if (code === 'ENOENT') return new Error(`No such folder: ${target}`);
    if (code === 'ENOTDIR') return new Error(`${target} is not a folder.`);
    if (code === 'EPERM' && isMac) {
      return new Error(`macOS privacy protection blocked ${verb} ${target}. Give the app running Mirabilis Full Disk Access.`);
    }
    if (code === 'EACCES' || code === 'EPERM') return new Error(`Permission denied ${verb} ${target}.`);
    return new Error(`Could not read ${target}: ${plainError(err)}`);
  }

  // Disk usage

  /**
   * Volumes with their usage; on Windows, logical disks from CIM.
   * @param {string[]} notes @param {AbortSignal} [signal]
   */
  async function readVolumes(notes, signal) {
    if (isWin) {
      try {
        const rows = asArray(await powershell(
          "$r=@(Get-CimInstance -ClassName Win32_LogicalDisk | Where-Object { $_.Size -gt 0 } | ForEach-Object {"
          + " [pscustomobject]@{'id'=$_.DeviceID;'type'=$_.DriveType;'size'=[double]$_.Size;'free'=[double]$_.FreeSpace;'label'=$_.VolumeName} });"
          + 'ConvertTo-Json -InputObject $r -Compress', signal, DF_TIMEOUT_MS * 2));
        const KIND = /** @type {Record<number, string>} */ ({ 2: 'removable', 4: 'network', 5: 'disc', 6: 'ram disk' });
        return rows.filter((d) => Number(d?.size) > 0).slice(0, 8).map((d) => {
          const size = Number(d.size);
          const free = Number(d.free) || 0;
          /** @type {Record<string, any>} */
          const v = { mount: `${d.id}\\`, sizeGB: Math.round(size / 1e8) / 10, usedGB: Math.round((size - free) / 1e8) / 10, freeGB: Math.round(free / 1e8) / 10, usedPercent: Math.round(((size - free) / size) * 100) };
          if (d.label) v.label = String(d.label);
          if (KIND[Number(d.type)]) v.kind = KIND[Number(d.type)];
          return v;
        });
      } catch (err) {
        notes.push(`volumes: ${plainError(err)}`);
        return [];
      }
    }
    const r = await run('df', ['-kP'], signal, { timeoutMs: DF_TIMEOUT_MS });
    const volumes = parseDfVolumes(r.stdout, platform);
    if (!volumes.length) notes.push(`volumes: ${r.error || 'df listed no volumes'}`);
    return volumes;
  }

  /**
   * Allocated bytes: what deleting the file would free.
   * @param {{size: number, blocks?: number}} st
   */
  function allocated(st) {
    return !isWin && Number.isFinite(st.blocks) && /** @type {number} */ (st.blocks) >= 0 ? /** @type {number} */ (st.blocks) * 512 : Number(st.size) || 0;
  }

  /**
   * Bytes under a folder by walking it, until the deadline. Links are not followed, so
   * Windows junctions and symlinked folders are not counted twice.
   * @param {string} root @param {number} deadline @param {AbortSignal} [signal]
   */
  async function walkSize(root, deadline, signal, skip = []) {
    let bytes = 0;
    let unreadable = false;
    const stack = [root];
    while (stack.length) {
      if (now() >= deadline || signal?.aborted) return { bytes, complete: false, unreadable };
      const dir = /** @type {string} */ (stack.pop());
      let entries;
      try {
        entries = await h.readdir(dir);
      } catch {
        unreadable = true;
        continue;
      }
      /** @type {string[]} */
      const files = [];
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!skip.includes(e.name)) stack.push(full); }
        else if (e.isFile()) files.push(full);
      }
      for (let i = 0; i < files.length; i += 64) {
        const stats = await Promise.all(files.slice(i, i + 64).map((f) => h.lstat(f).catch(() => null)));
        for (const st of stats) if (st) bytes += allocated(st);
        if (now() >= deadline) return { bytes, complete: false, unreadable };
      }
    }
    return { bytes, complete: true, unreadable };
  }

  /**
   * Size of one folder: `du -skx` on POSIX, a walk on Windows or when du is missing.
   * `late` means the time budget cut it short; `unreadable`, that some of it was refused.
   * `skip` names subfolders, at any depth, left out of the total.
   * @param {string} dir @param {number} deadline @param {{noDu: boolean}} state @param {AbortSignal} [signal]
   * @param {string[]} [skip]
   * @returns {Promise<{bytes: number|null, complete: boolean, unreadable: boolean, late: boolean}>}
   */
  async function folderSize(dir, deadline, state, signal, skip = []) {
    if (now() >= deadline) return { bytes: null, complete: false, unreadable: false, late: true };
    if (!isWin && !state.noDu) {
      const ignore = skip.flatMap((name) => ['-I', name]);
      const r = await run('du', ['-s', '-k', '-x', ...ignore, dir], signal, { timeoutMs: Math.max(500, deadline - now()) });
      // du still prints the total when some subfolders were refused, and exits 1.
      const kb = r.stdout.match(/^(\d+)\s/m);
      if (kb) return { bytes: Number(kb[1]) * 1024, complete: !skip.length, unreadable: !r.ok, late: false };
      if (r.timedOut || signal?.aborted) return { bytes: null, complete: false, unreadable: false, late: true };
      if (r.missing) state.noDu = true;
      else return { bytes: null, complete: false, unreadable: true, late: false };
    }
    const walked = await walkSize(dir, deadline, signal, skip);
    const late = !walked.complete;
    if (walked.complete && skip.length) return { ...walked, complete: false, late };
    return walked.complete || walked.bytes > 0 ? { ...walked, late } : { ...walked, bytes: null, late };
  }

  // Logs

  /**
   * @param {Array<{time: Date, level: string, process: string, pid: string, message: string}>} rows oldest first
   * @param {number} limit
   */
  function summarizeLog(rows, limit) {
    const groups = groupLogEntries(rows);
    /** @type {Map<string, number>} */
    const bySource = new Map();
    for (const r of rows) bySource.set(r.process, (bySource.get(r.process) || 0) + 1);
    const shown = groups.slice(-limit);
    const days = new Set(shown.map((g) => day(g.last.time)));
    const entries = shown.map(({ count, last }) => {
      const when = days.size > 1 ? `${day(last.time).slice(5)} ${clock(last.time)}` : clock(last.time);
      const who = last.pid ? `${last.process}[${last.pid}]` : last.process;
      const message = clip(scrub(last.message.replace(/\s+/g, ' ').trim()), LOG_LINE_CHARS);
      return `${when} ${last.level} ${clip(who, 60)}: ${message}${count > 1 ? ` (x${count})` : ''}`;
    });
    const top = [...bySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return {
      matched: rows.length,
      distinct: groups.length,
      shown: entries.length,
      ...(days.size === 1 && shown.length ? { date: [...days][0] } : {}),
      topSources: Object.fromEntries(top.map(([name, n]) => [clip(name, 40), n])),
      entries
    };
  }

  // Services and startup

  /** @param {AbortSignal} [signal] */
  async function launchdJobs(signal) {
    const [user, sys] = await Promise.all([
      run('launchctl', ['list'], signal),
      run('launchctl', ['print', 'system'], signal)
    ]);
    if (user.missing) throw new Error('launchctl is not available on this system.');
    return { user: parseLaunchctlList(user.stdout), system: parseLaunchctlPrint(sys.stdout), error: user.ok ? '' : user.error };
  }

  /** @param {string} file @param {AbortSignal} [signal] */
  async function readPlist(file, signal) {
    let text = '';
    try { text = await h.readText(file); } catch { return null; }
    if (text.startsWith('bplist')) {
      const r = await run('plutil', ['-convert', 'xml1', '-o', '-', file], signal);
      if (!r.ok) return null;
      text = r.stdout;
    }
    return parseLaunchdPlist(text);
  }

  /** Names directly in a folder, or [] when it is missing or unreadable. @param {string} dir */
  async function namesIn(dir) {
    try {
      return (await h.readdir(dir)).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }

  /** @param {string} text */
  function parseDesktopEntry(text) {
    const group = String(text).split(/^\[/m).find((s) => s.startsWith('Desktop Entry]')) || '';
    const get = (/** @type {string} */ key) => group.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
    return {
      name: get('Name'),
      command: (get('Exec') || '').replace(/\s+%[a-zA-Z]/g, '').trim(),
      disabled: get('Hidden') === 'true' || get('X-GNOME-Autostart-enabled') === 'false'
    };
  }

  // Hardware

  /** @param {string} s */
  const cleanVendor = (s) => {
    const v = String(s || '').replace(/^sppci_vendor_/i, '').replace(/\s*\(0x[0-9a-f]+\)\s*$/i, '').trim();
    const known = /** @type {Record<string, string>} */ ({ amd: 'AMD', ati: 'AMD', intel: 'Intel', nvidia: 'NVIDIA', apple: 'Apple' });
    return known[v.toLowerCase()] || v || undefined;
  };

  /** "1470 x 956 @ 60.00Hz" or "spdisplays_2560x1664Retina" to parts. @param {string} s */
  function splitResolution(s) {
    const m = String(s || '').match(/(\d+)\s*x\s*(\d+)(?:.*?@\s*([\d.]+)\s*Hz)?/i);
    return m ? { size: `${m[1]}x${m[2]}`, hz: m[3] ? Math.round(Number(m[3])) : undefined } : null;
  }

  /** @param {string[]} notes @param {AbortSignal} [signal] */
  async function hardwareMac(notes, signal) {
    const r = await run('system_profiler', ['-json', '-detailLevel', 'mini', 'SPHardwareDataType', 'SPDisplaysDataType'], signal, { timeoutMs: 20_000 });
    /** @type {any} */
    let data = null;
    try { data = JSON.parse(r.stdout); } catch { /* reported below */ }
    if (!data) notes.push(`system_profiler: ${r.error || 'output not understood'}`);
    const hw = data?.SPHardwareDataType?.[0] || {};
    const cpus = h.cpus();
    /** @type {Record<string, any>} */
    const cpu = { name: hw.chip_type || hw.cpu_type || String(cpus[0]?.model || '').trim() || null, threads: cpus.length || null };
    const split = String(hw.number_processors || '').match(/proc (\d+):(\d+):(\d+)/);
    if (split) Object.assign(cpu, { cores: Number(split[1]), performanceCores: Number(split[2]), efficiencyCores: Number(split[3]) });
    else if (Number(hw.number_processors) > 0) cpu.cores = Number(hw.number_processors);
    if (hw.current_processor_speed) cpu.speed = hw.current_processor_speed;
    const appleSilicon = Boolean(hw.chip_type) || /Apple/.test(cpu.name || '');
    /** @type {Record<string, any>[]} */
    const gpus = [];
    /** @type {Record<string, any>[]} */
    const displays = [];
    for (const g of asArray(data?.SPDisplaysDataType)) {
      /** @type {Record<string, any>} */
      const gpu = { name: g.sppci_model || g._name || 'GPU' };
      const vendor = cleanVendor(g.spdisplays_vendor);
      if (vendor) gpu.vendor = vendor;
      if (Number(g.sppci_cores) > 0) gpu.cores = Number(g.sppci_cores);
      if (g.spdisplays_vram) gpu.vram = String(g.spdisplays_vram);
      else if (g.spdisplays_vram_shared) gpu.vram = `${g.spdisplays_vram_shared} shared`;
      else if (appleSilicon) gpu.vram = 'unified memory';
      const metal = String(g.spdisplays_mtlgpufamilysupport || g.spdisplays_metal || '').replace(/^spdisplays_/, '');
      if (metal) gpu.metal = metal;
      gpus.push(gpu);
      for (const d of asArray(g.spdisplays_ndrvs)) {
        const looks = splitResolution(d._spdisplays_resolution);
        const pixels = splitResolution(d._spdisplays_pixels || d.spdisplays_pixelresolution);
        /** @type {Record<string, any>} */
        const view = { name: d._name || 'Display' };
        if (looks) view.resolution = looks.size;
        if (pixels && pixels.size !== looks?.size) view.pixels = pixels.size;
        if (looks?.hz) view.refreshHz = looks.hz;
        view.connection = d.spdisplays_connection_type === 'spdisplays_internal' ? 'internal' : 'external';
        if (d.spdisplays_main === 'spdisplays_yes') view.main = true;
        displays.push(view);
      }
    }
    const memory = hw.physical_memory ? String(hw.physical_memory) : `${Math.round(h.totalmem() / 1024 ** 3)} GB`;
    const model = [hw.machine_name, hw.machine_model ? `(${hw.machine_model})` : ''].filter(Boolean).join(' ') || null;
    return { model, cpu, memory: { total: memory }, gpus, displays };
  }

  /** @param {string} file */
  const readOr = async (file) => { try { return (await h.readText(file)).trim(); } catch { return ''; } };

  /** @param {string[]} notes @param {AbortSignal} [signal] */
  async function hardwareLinux(notes, signal) {
    const SYS = '/sys/class';
    const [lscpu, lspci, smi, meminfo, vendor, product, version, dtModel, drm] = await Promise.all([
      run('lscpu', [], signal),
      run('lspci', [], signal),
      run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], signal),
      readOr('/proc/meminfo'),
      readOr(`${SYS}/dmi/id/sys_vendor`),
      readOr(`${SYS}/dmi/id/product_name`),
      readOr(`${SYS}/dmi/id/product_version`),
      readOr('/proc/device-tree/model'),
      namesIn(`${SYS}/drm`)
    ]);
    /** @type {Record<string, string>} */
    const kv = {};
    for (const line of lscpu.stdout.split('\n')) {
      const m = line.match(/^\s*([^:]+?):\s+(.*)$/);
      if (m && !(m[1] in kv)) kv[m[1]] = m[2].trim();
    }
    if (!lscpu.ok && !lscpu.stdout) notes.push(`cpu: ${lscpu.error}`);
    const cpus = h.cpus();
    /** @type {Record<string, any>} */
    const cpu = { name: kv['Model name'] || String(cpus[0]?.model || '').trim() || null };
    if (kv.Architecture) cpu.arch = kv.Architecture;
    const sockets = Number(kv['Socket(s)']) || 1;
    const perSocket = Number(kv['Core(s) per socket']);
    if (perSocket > 0) cpu.cores = perSocket * sockets;
    cpu.threads = Number(kv['CPU(s)']) || cpus.length || null;
    const mhz = Math.round(Number(kv['CPU max MHz']));
    if (mhz > 0) cpu.maxMHz = mhz;

    const memKB = Number(meminfo.match(/^MemTotal:\s+(\d+)/m)?.[1]);
    const swapKB = Number(meminfo.match(/^SwapTotal:\s+(\d+)/m)?.[1]);
    /** @type {Record<string, any>} */
    const memory = { total: `${Math.round(((memKB > 0 ? memKB * 1024 : h.totalmem()) / 1024 ** 3) * 10) / 10} GB` };
    if (swapKB > 0) memory.swap = `${Math.round((swapKB / 1024 ** 2) * 10) / 10} GB`;

    /** @type {Record<string, any>[]} */
    const gpus = [];
    for (const line of lspci.stdout.split('\n')) {
      const m = line.match(/^\S+\s+(?:VGA compatible controller|3D controller|Display controller)(?: \[[0-9a-f]+\])?:\s+(.*?)(?:\s+\(rev [0-9a-f]+\))?\s*$/i);
      if (m) gpus.push({ name: m[1] });
    }
    if (!lspci.ok && !lspci.stdout) notes.push(`gpus: ${lspci.error}`);
    // nvidia-smi knows the video memory lspci does not; its cards pair with lspci's in order.
    const nvidia = smi.stdout.split('\n').map((l) => l.split(',').map((s) => s.trim())).filter((c) => c.length >= 3 && c[0]);
    const nvidiaRows = gpus.filter((g) => /nvidia/i.test(g.name));
    nvidia.forEach(([name, mib, driver], i) => {
      let target = nvidiaRows[i];
      if (!target) {
        target = { name };
        gpus.push(target);
      }
      target.name = name;
      const vram = formatVram(Number(mib) * 1024 ** 2);
      if (vram) target.vram = vram;
      if (driver) target.driver = driver;
    });
    /** @type {Record<string, any>[]} */
    const displays = [];
    const amd = [];
    for (const name of drm) {
      if (/^card\d+$/.test(name)) {
        const bytes = Number(await readOr(`${SYS}/drm/${name}/device/mem_info_vram_total`));
        if (bytes > 0) amd.push(bytes);
        continue;
      }
      const conn = name.match(/^card\d+-(.+)$/);
      if (!conn) continue;
      if ((await readOr(`${SYS}/drm/${name}/status`)) !== 'connected') continue;
      const mode = (await readOr(`${SYS}/drm/${name}/modes`)).split('\n')[0];
      /** @type {Record<string, any>} */
      const view = { name: conn[1] };
      if (mode) view.resolution = mode;
      view.connection = /^(eDP|LVDS|DSI)/i.test(conn[1]) ? 'internal' : 'external';
      displays.push(view);
    }
    const amdGpus = gpus.filter((g) => /\b(AMD|ATI)\b/.test(g.name) && !g.vram);
    amd.forEach((bytes, i) => { if (amdGpus[i]) amdGpus[i].vram = formatVram(bytes); });

    const junk = /^(To Be Filled|System Product Name|Default string|Not Specified|None)/i;
    const model = dtModel.replace(/\0/g, '')
      || [vendor, product, version].filter((s) => s && !junk.test(s)).join(' ') || null;
    return { model, cpu, memory, gpus, displays };
  }

  /** @param {AbortSignal} [signal] */
  async function hardwareWindows(signal) {
    const data = await powershell(
      '$cs=Get-CimInstance -ClassName Win32_ComputerSystem;'
      + "$cpu=@(Get-CimInstance -ClassName Win32_Processor | ForEach-Object { [pscustomobject]@{'name'=$_.Name;'cores'=$_.NumberOfCores;'threads'=$_.NumberOfLogicalProcessors;'mhz'=$_.MaxClockSpeed} });"
      // AdapterRAM is 32-bit and stops at 4 GB; the driver's qwMemorySize is the real size.
      + '$vram=@{};'
      + "foreach ($k in @(Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*')) {"
      + " try { $q=$k.'HardwareInformation.qwMemorySize'; if ($q -is [byte[]]) { $q=[BitConverter]::ToUInt64($q,0) };"
      + ' if ($q -and $k.DriverDesc) { $vram[[string]$k.DriverDesc]=[double]$q } } catch {} };'
      + '$gpu=@(Get-CimInstance -ClassName Win32_VideoController | ForEach-Object { $v=$vram[[string]$_.Name]; if (-not $v) { $v=$_.AdapterRAM };'
      + " [pscustomobject]@{'name'=$_.Name;'vram'=$v;'driver'=$_.DriverVersion;'width'=$_.CurrentHorizontalResolution;'height'=$_.CurrentVerticalResolution;'hz'=$_.CurrentRefreshRate} });"
      + "ConvertTo-Json -InputObject ([pscustomobject]@{'maker'=$cs.Manufacturer;'model'=$cs.Model;'memory'=$cs.TotalPhysicalMemory;'cpu'=$cpu;'gpu'=$gpu}) -Compress -Depth 4",
      signal
    );
    if (!data || typeof data !== 'object') throw new Error('PowerShell returned no hardware details.');
    const first = asArray(data.cpu)[0] || {};
    const cpuList = asArray(data.cpu);
    /** @type {Record<string, any>} */
    const cpu = { name: String(first.name || '').trim() || String(h.cpus()[0]?.model || '').trim() || null };
    const cores = cpuList.reduce((n, c) => n + (Number(c?.cores) || 0), 0);
    const threads = cpuList.reduce((n, c) => n + (Number(c?.threads) || 0), 0);
    if (cores) cpu.cores = cores;
    cpu.threads = threads || h.cpus().length || null;
    if (Number(first.mhz) > 0) cpu.maxMHz = Number(first.mhz);
    if (cpuList.length > 1) cpu.sockets = cpuList.length;
    /** @type {Record<string, any>[]} */
    const gpus = [];
    /** @type {Record<string, any>[]} */
    const displays = [];
    for (const g of asArray(data.gpu)) {
      if (!g?.name) continue;
      /** @type {Record<string, any>} */
      const gpu = { name: String(g.name) };
      const vram = formatVram(Number(g.vram));
      if (vram) gpu.vram = vram;
      if (g.driver) gpu.driver = String(g.driver);
      gpus.push(gpu);
      if (Number(g.width) > 0 && Number(g.height) > 0) {
        /** @type {Record<string, any>} */
        const view = { adapter: String(g.name), resolution: `${g.width}x${g.height}` };
        if (Number(g.hz) > 1) view.refreshHz = Number(g.hz);
        displays.push(view);
      }
    }
    const total = Number(data.memory) || h.totalmem();
    const model = [data.maker, data.model].filter((s) => s && !/^(To Be Filled|System Product Name|Default string)/i.test(String(s))).join(' ') || null;
    return { model, cpu, memory: { total: `${Math.round((total / 1024 ** 3) * 10) / 10} GB` }, gpus, displays };
  }

  // Processes

  /** @param {number} pid @param {AbortSignal} [signal] */
  async function processName(pid, signal) {
    if (isWin) {
      const r = await run('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], signal);
      const m = r.stdout.match(/^"([^"]+)","(\d+)"/m);
      return m && m[2] === String(pid) ? m[1] : '';
    }
    const r = await run('ps', ['-o', 'comm=', '-p', String(pid)], signal);
    return baseName(r.stdout.trim());
  }

  /**
   * Mirabilis's own processes: this server and the backend that started it. In the
   * desktop app also the app's main process and its direct children: the window helpers
   * and the frontend server. What the backend starts, such as a model runtime or an
   * agent's command, stays stoppable. Read at each call: a window helper can restart.
   * @param {AbortSignal} [signal]
   * @returns {Promise<Set<number>>}
   */
  async function mirabilisPids(signal) {
    const own = new Set([h.pid(), h.ppid()]);
    if (!h.electron()) return own;
    /** @type {Array<[number, number]>} */
    let table = [];
    if (isWin) {
      try {
        table = asArray(await powershell(
          "$r=@(Get-CimInstance -ClassName Win32_Process | ForEach-Object { [pscustomobject]@{'p'=$_.ProcessId;'pp'=$_.ParentProcessId} });"
          + 'ConvertTo-Json -InputObject $r -Compress', signal
        )).map((row) => [Number(row?.p), Number(row?.pp)]);
      } catch { /* fall back to the two known pids */ }
    } else {
      const r = await run('ps', ['-A', '-o', 'pid=,ppid='], signal);
      table = r.stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((c) => c.length === 2 && c.every(Number.isFinite))
        .map((c) => /** @type {[number, number]} */ ([c[0], c[1]]));
    }
    const app = table.find(([pid]) => pid === h.ppid())?.[1];
    if (!app || app <= 1) return own;
    return new Set([...own, app, ...table.filter(([, parent]) => parent === app).map(([pid]) => pid)]);
  }

  /** @param {number} pid */
  function alive(pid) {
    try {
      h.kill(pid, 0);
      return true;
    } catch (err) {
      return /** @type {any} */ (err)?.code === 'EPERM';
    }
  }

  // Tool table

  const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const NETWORK = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const logSource = isMac ? 'the macOS unified log' : isWin ? 'the Windows System and Application event logs' : 'the systemd journal';

  /**
   * @type {Array<MachineTool & {trim?: Array<[string, 'start'|'end']>, handler: (args: Record<string, any>, ctx: {signal?: AbortSignal}) => Promise<Record<string, any>>}>}
   */
  const table = [
    {
      name: 'system_overview',
      title: 'System overview',
      description: 'Snapshot of this computer: OS, CPU, load, memory, disks, uptime and the top processes by CPU and memory.',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ,
      trim: [['topCpu', 'end'], ['topMemory', 'end'], ['disks', 'end'], ['notes', 'end']],
      handler: (_args, ctx) => system.system_overview.execute({}, ctx)
    },
    {
      name: 'list_processes',
      title: 'Processes',
      description: 'Running processes with pid, owner, CPU, memory, run time and command, sorted and filtered.',
      inputSchema: {
        type: 'object',
        properties: {
          sortBy: { type: 'string', enum: ['cpu', 'memory'], description: 'Sort order, default cpu.' },
          filter: { type: 'string', description: 'Only processes whose command or user contains this text.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Rows to return, default 15.' }
        }
      },
      annotations: READ,
      trim: [['processes', 'end']],
      handler: async (args, ctx) => {
        const out = await system.list_processes.execute(args, ctx);
        if (out.error) throw new Error(sentence(out.error));
        return out;
      }
    },
    {
      name: 'network_overview',
      title: 'Network overview',
      description: 'Interfaces and addresses, default gateway, DNS servers, listening TCP ports with their process, and the connection count.',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ,
      trim: [['listening', 'end'], ['interfaces', 'end'], ['linkLocalOnly', 'end']],
      handler: (_args, ctx) => system.network_overview.execute({}, ctx)
    },
    {
      name: 'read_log',
      title: 'Read a log file',
      description: 'The newest lines of a text log file, optionally only lines containing some text.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Log file path; ~ is the home folder.' },
          lines: { type: 'integer', minimum: 1, maximum: 2000, description: 'Lines from the end to read, default 200.' },
          filter: { type: 'string', description: 'Keep only lines containing this text, any case.' }
        },
        required: ['path']
      },
      annotations: READ,
      trim: [['text', 'start']],
      handler: (args) => system.read_log.execute(args)
    },
    {
      name: 'disk_usage',
      title: 'Disk usage',
      description: 'Free space on each volume and the largest files and folders directly inside a folder, home by default.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder to measure; ~ is the home folder.' },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Largest entries to list, default 10.' }
        }
      },
      annotations: READ,
      trim: [['entries', 'end'], ['notMeasured', 'end'], ['volumes', 'end']],
      handler: async (args, { signal }) => {
        const limit = clampInt(args.limit, 1, 25, 10);
        const raw = expandTildeHome(String(args.path ?? '').trim());
        const base = raw ? (path.isAbsolute(raw) ? raw : path.resolve(h.homedir(), raw)) : (getFsRoot() || h.homedir());
        // The operator jail (MIRABILIS_MCP_FS_ROOT) holds here as for read_log.
        const target = safeResolvePath(base);
        let info;
        try { info = await h.stat(target); } catch (err) { throw fsError(err, target, 'reading'); }
        if (!info.isDirectory()) throw new Error(`${target} is not a folder.`);
        /** @type {string[]} */
        const notes = [];
        const atHome = isMac && path.resolve(target) === path.resolve(h.homedir());
        /** @type {string[]} */
        const askFirst = atHome ? MAC_ASK_FIRST : [];
        const deadline = now() + DISK_BUDGET_MS;
        const listing = (async () => {
          let entries;
          try { entries = await h.readdir(target); } catch (err) { throw fsError(err, target, 'listing'); }
          const state = { noDu: false };
          const dirs = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && !askFirst.includes(e.name));
          const files = entries.filter((e) => e.isFile());
          const fileSizes = await mapLimit(files, 32, async (e) => {
            if (now() >= deadline) return { name: e.name, type: 'file', bytes: null, complete: false, unreadable: false, late: true };
            try {
              return { name: e.name, type: 'file', bytes: allocated(await h.lstat(path.join(target, e.name))), complete: true, unreadable: false, late: false };
            } catch {
              return null;
            }
          });
          const dirSizes = await mapLimit(dirs, DISK_CONCURRENCY, async (e) => ({
            name: e.name,
            type: 'folder',
            ...(await folderSize(path.join(target, e.name), deadline, state, signal, atHome && e.name === 'Library' ? MAC_LIBRARY_SKIP : []))
          }));
          return { all: [...dirSizes, ...fileSizes].filter((x) => x !== null), state, names: entries.map((e) => e.name) };
        })();
        const [volumes, measured] = await Promise.all([readVolumes(notes, signal), listing]);
        const known = /** @type {Array<{name: string, type: string, bytes: number, complete: boolean, unreadable: boolean, late: boolean}>} */ (measured.all.filter((x) => x.bytes != null));
        const unknown = measured.all.filter((x) => x.bytes == null);
        known.sort((a, b) => b.bytes - a.bytes);
        const shown = known.slice(0, limit);
        const rest = known.slice(limit);
        // The volume holding the folder: the longest mount that contains it.
        const norm = (/** @type {string} */ p) => (isWin ? p.toLowerCase() : p);
        const holds = (/** @type {string} */ mount) => {
          const t = norm(target);
          const m = norm(mount);
          if (t === m || t === m.replace(/[\\/]+$/, '')) return true;
          return t.startsWith(/[\\/]$/.test(m) ? m : `${m}${isWin ? '\\' : '/'}`);
        };
        const holder = volumes.map((v) => v.mount).filter(holds).sort((a, b) => b.length - a.length)[0];
        /** @type {Record<string, any>} */
        const out = { path: target };
        if (holder) out.volume = holder;
        out.volumes = volumes;
        out.entries = shown.map((x) => ({ name: x.name, type: x.type, size: `${x.complete ? '' : 'over '}${formatBytes(x.bytes)}` }));
        if (rest.length) out.rest = { count: rest.length, size: formatBytes(rest.reduce((n, x) => n + x.bytes, 0)) };
        out.measured = formatBytes(known.reduce((n, x) => n + x.bytes, 0));
        const present = new Set(measured.names);
        const skipped = askFirst.filter((name) => present.has(name));
        if (unknown.length || skipped.length) out.notMeasured = [...skipped, ...unknown.map((x) => x.name)];
        if (unknown.length || skipped.length || known.some((x) => !x.complete)) out.partial = true;
        if (skipped.length) notes.push(`macOS asks before reading ${skipped.join(', ')}; pass one as the path to measure it.`);
        if (atHome && known.some((x) => x.name === 'Library')) notes.push("Library leaves out other apps' data and iCloud Drive.");
        if (measured.all.some((x) => x.late)) {
          notes.push(`Measuring stopped at ${Math.round(DISK_BUDGET_MS / 1000)}s; run disk_usage on one of these folders to see inside it.`);
        }
        if (measured.all.some((x) => x.unreadable)) notes.push('Some folders could not be read fully: permissions or privacy protection.');
        if (measured.state.noDu) notes.push('du is not available on this system; sizes come from walking the folders.');
        if (notes.length) out.notes = notes;
        return out;
      }
    },
    {
      name: 'system_logs',
      title: 'System logs',
      description: `Recent entries from ${logSource}, errors by default, with repeated messages counted once.`,
      inputSchema: {
        type: 'object',
        properties: {
          minutes: { type: 'integer', minimum: 1, maximum: 1440, description: `How far back to look, default 10${isMac ? ', at most 60 on macOS' : ''}.` },
          level: { type: 'string', enum: ['critical', 'error', 'warning', 'info'], description: 'Lowest severity to include, default error.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Distinct entries to return, newest last, default 20.' },
          filter: { type: 'string', description: 'Only entries whose source or message contains this text.' }
        }
      },
      annotations: READ,
      trim: [['entries', 'start']],
      handler: async (args, { signal }) => {
        const level = ['critical', 'error', 'warning', 'info'].includes(String(args.level)) ? String(args.level) : 'error';
        const limit = clampInt(args.limit, 1, 50, 20);
        let minutes = clampInt(args.minutes, 1, 1440, 10);
        const filter = String(args.filter ?? '').trim().slice(0, 200);
        const needle = filter.toLowerCase();
        /** @type {string[]} */
        const notes = [];
        /** @type {Array<{time: Date, level: string, process: string, pid: string, message: string}>} */
        let rows;
        let source;
        if (isMac) {
          source = 'log show';
          const cap = level === 'info' ? MAC_INFO_MAX_MINUTES : MAC_LOG_MAX_MINUTES;
          if (minutes > cap) {
            notes.push(`macOS logs are read at most ${cap} minutes back at this level.`);
            minutes = cap;
          }
          if (level === 'warning') notes.push('macOS has no warning level; showing errors and faults.');
          const levelPredicate = level === 'critical' ? 'messageType == fault'
            : level === 'info' ? '' : 'messageType == error OR messageType == fault';
          const esc = filter.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const filterPredicate = filter
            ? `(process CONTAINS[c] "${esc}" OR subsystem CONTAINS[c] "${esc}" OR composedMessage CONTAINS[c] "${esc}")` : '';
          const predicate = [levelPredicate && `(${levelPredicate})`, filterPredicate].filter(Boolean).join(' AND ');
          const r = await run('/usr/bin/log', ['show', '--last', `${minutes}m`, '--style', 'compact', ...(predicate ? ['--predicate', predicate] : [])],
            signal, { timeoutMs: LOG_TIMEOUT_MS, tailBytes: LOG_TAIL_BYTES });
          if (r.missing) throw new Error('The log command is not available on this system.');
          if (r.timedOut) throw new Error(`log show did not finish within ${LOG_TIMEOUT_MS / 1000}s. Try fewer minutes or a filter.`);
          if (!r.ok) throw new Error(sentence(r.error));
          rows = parseMacLog(r.stdout);
          if (r.dropped) notes.push(`Counted over the newest ${formatBytes(LOG_TAIL_BYTES)} of log output.`);
        } else if (isLinux) {
          source = 'journalctl';
          const priority = { critical: 'crit', error: 'err', warning: 'warning', info: 'info' }[level];
          const cap = filter ? 2000 : Math.max(limit * 20, 400);
          const r = await run('journalctl', ['--no-pager', '-o', 'json', '-p', String(priority), `--since=-${minutes}min`, '-n', String(cap)],
            signal, { timeoutMs: LOG_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
          if (r.missing) throw new Error('journalctl is not available on this system; use read_log on a file in /var/log.');
          if (r.timedOut) throw new Error(`journalctl did not finish within ${LOG_TIMEOUT_MS / 1000}s. Try fewer minutes.`);
          if (!r.ok && /insufficient permissions/i.test(r.stderr)) {
            throw new Error('This user cannot read the journal; add it to the systemd-journal group.');
          }
          if (!r.ok && !r.stdout.trim()) throw new Error(sentence(r.error));
          rows = parseJournal(r.stdout);
          if (/not seeing messages from other users and the system/i.test(r.stderr)) {
            notes.push('Only this user\'s entries: system entries need the systemd-journal or adm group.');
          }
          if (/No journal files were found/i.test(r.stderr)) notes.push('No journal files were found.');
          if (rows.length >= cap) notes.push(`Read the newest ${cap} entries.`);
        } else if (isWin) {
          source = 'event log';
          const levels = { critical: '1', error: '1,2', warning: '1,2,3', info: '0,1,2,3,4' }[level];
          const max = filter ? 300 : Math.max(limit * 5, 150);
          const json = await powershell(
            `$f=@{'LogName'=@('System','Application');'Level'=@(${levels});'StartTime'=(Get-Date).AddMinutes(-${minutes})};`
            + `$r=@(Get-WinEvent -FilterHashtable $f -MaxEvents ${max} | ForEach-Object {`
            + " $m=[string]$_.Message; if (-not $m) { $m='' }; $m=($m -split '\\r?\\n')[0]; if ($m.Length -gt 300) { $m=$m.Substring(0,300) };"
            + " [pscustomobject]@{'time'=$_.TimeCreated.ToString('o');'level'=[int]$_.Level;'source'=$_.ProviderName;'id'=$_.Id;'message'=$m} });"
            + 'ConvertTo-Json -InputObject $r -Compress', signal);
          rows = parseWinEvents(json);
          if (rows.length >= max) notes.push(`Read the newest ${max} events.`);
        } else {
          throw new Error(`System logs are not available on this system (${platform}).`);
        }
        if (needle && !isMac) rows = rows.filter((r) => `${r.process} ${r.message}`.toLowerCase().includes(needle));
        /** @type {Record<string, any>} */
        const out = { source, window: `last ${minutes} min`, level };
        if (filter) out.filter = filter;
        Object.assign(out, summarizeLog(rows, limit));
        if (notes.length) out.notes = notes;
        return out;
      }
    },
    {
      name: 'services',
      title: 'Services',
      description: isMac ? 'launchd jobs of this user and the system with their state: running, stopped or failed.'
        : isWin ? 'Windows services with their state, start mode and process.'
          : 'systemd services with their state: running, stopped or failed.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Only services whose name or description contains this text.' },
          state: { type: 'string', enum: ['all', 'running', 'stopped', 'failed'], description: 'Only services in this state, default all.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Rows to return, default 25; failed ones come first.' }
        }
      },
      annotations: READ,
      trim: [['services', 'end']],
      handler: async (args, { signal }) => {
        const want = ['running', 'stopped', 'failed'].includes(String(args.state)) ? String(args.state) : 'all';
        const limit = clampInt(args.limit, 1, 100, 25);
        const needle = String(args.filter ?? '').trim().toLowerCase();
        /** @type {Array<{name: string, state: string, group: string, description?: string, domain?: string, pid?: number, lastExit?: string, start?: string}>} */
        let rows = [];
        /** @type {string[]} */
        const notes = [];
        if (isMac) {
          const jobs = await launchdJobs(signal);
          if (!jobs.user.length && jobs.error) throw new Error(sentence(jobs.error));
          for (const [domain, list] of /** @type {const} */ ([['user', jobs.user], ['system', jobs.system]])) {
            for (const j of list) {
              const state = launchdState(j.pid, j.status);
              rows.push({ name: j.label, domain, state, group: state, ...(j.pid ? { pid: j.pid } : {}), ...(launchdExit(j.status) ? { lastExit: launchdExit(j.status) } : {}) });
            }
          }
          if (!jobs.system.length) notes.push('System daemons could not be listed.');
        } else if (isLinux) {
          const r = await run('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--no-legend', '--plain'], signal);
          if (r.missing) throw new Error('systemctl is not available on this system.');
          if (/not been booted with systemd|Failed to connect to bus/i.test(r.stderr)) throw new Error('systemd is not available on this system.');
          if (!r.ok && !r.stdout.trim()) throw new Error(sentence(r.error));
          for (const u of parseSystemctlUnits(r.stdout)) {
            if (u.load === 'not-found' && u.active !== 'failed') continue;
            const state = u.active === 'failed' ? 'failed' : u.sub === 'running' ? 'running' : u.active === 'inactive' ? 'stopped' : `${u.active} (${u.sub})`;
            // A oneshot that ran ("active (exited)") or one starting up is neither running nor stopped.
            rows.push({ name: u.unit.replace(/\.service$/, ''), state, group: ['failed', 'running', 'stopped'].includes(state) ? state : 'other', description: u.description });
          }
        } else if (isWin) {
          const json = await powershell(
            "$r=@(Get-CimInstance -ClassName Win32_Service | ForEach-Object { [pscustomobject]@{'name'=$_.Name;'display'=$_.DisplayName;'state'=$_.State;'start'=$_.StartMode;'pid'=$_.ProcessId;'exit'=$_.ExitCode} });"
            + 'ConvertTo-Json -InputObject $r -Compress', signal);
          for (const s of asArray(json)) {
            if (!s?.name) continue;
            const exit = Number(s.exit) || 0;
            const raw = String(s.state || 'Unknown');
            const failed = s.start === 'Auto' && raw !== 'Running' && exit !== 0 && exit !== 1077;
            const state = failed ? 'failed' : raw === 'Running' ? 'running' : raw === 'Stopped' ? 'stopped' : raw.toLowerCase();
            rows.push({
              name: String(s.name), state, group: ['failed', 'running', 'stopped'].includes(state) ? state : 'other',
              description: String(s.display || ''), start: String(s.start || '').toLowerCase(),
              ...(Number(s.pid) > 0 ? { pid: Number(s.pid) } : {}), ...(failed ? { lastExit: `exit ${exit}` } : {})
            });
          }
          if (!rows.length) throw new Error('Get-CimInstance listed no services.');
        } else {
          throw new Error(`Services are not available on this system (${platform}).`);
        }
        const counts = { total: rows.length, running: 0, failed: 0 };
        for (const r of rows) {
          if (r.group === 'running') counts.running += 1;
          if (r.state === 'failed') counts.failed += 1;
        }
        if (want !== 'all') rows = rows.filter((r) => r.group === want);
        if (needle) rows = rows.filter((r) => `${r.name} ${r.description || ''}`.toLowerCase().includes(needle));
        rows.sort((a, b) => ((STATE_RANK[a.group] ?? 2) - (STATE_RANK[b.group] ?? 2))
          || (vendorRank(a.name, platform) - vendorRank(b.name, platform)) || a.name.localeCompare(b.name));
        /** @type {Record<string, any>} */
        const out = { ...counts, state: want };
        if (needle) out.filter = needle;
        out.matched = rows.length;
        out.services = rows.slice(0, limit).map(({ group, description, ...r }) => ({
          ...r, ...(description ? { description: clip(scrub(description), 50) } : {})
        }));
        if (notes.length) out.notes = notes;
        return out;
      }
    },
    {
      name: 'startup_items',
      title: 'Startup items',
      description: isMac ? 'What starts automatically: launch agents and daemons outside macOS itself.'
        : isWin ? 'What starts automatically at sign-in: Run registry keys and Startup folders.'
          : 'What starts automatically: enabled systemd units, user units and desktop autostart entries.',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ,
      trim: isMac ? [['daemons', 'end'], ['agents', 'end'], ['loginAgents', 'end']]
        : isWin ? [['items', 'end']] : [['systemd', 'end'], ['userSystemd', 'end'], ['autostart', 'end']],
      handler: async (_args, { signal }) => {
        /** @type {string[]} */
        const notes = [];
        /** @type {Record<string, any>} */
        const out = {};
        if (isMac) {
          const home = h.homedir();
          const [jobs, userOff, systemOff] = await Promise.all([
            launchdJobs(signal).catch(() => ({ user: [], system: [], error: '' })),
            run('launchctl', ['print-disabled', `gui/${h.uid()}`], signal),
            run('launchctl', ['print-disabled', 'system'], signal)
          ]);
          const disabled = new Map([...parseLaunchctlDisabled(systemOff.stdout), ...parseLaunchctlDisabled(userOff.stdout)]);
          /** @param {Array<{label: string, pid: number|null}>} list */
          const pidsOf = (list) => new Map(list.map((j) => /** @type {[string, number|null]} */ ([j.label, j.pid])));
          const userPids = pidsOf(jobs.user);
          const systemPids = pidsOf(jobs.system);
          for (const [key, dir, pids] of /** @type {const} */ ([
            ['loginAgents', path.join(home, 'Library', 'LaunchAgents'), userPids],
            ['agents', '/Library/LaunchAgents', userPids],
            ['daemons', '/Library/LaunchDaemons', systemPids]
          ])) {
            const files = (await namesIn(dir)).filter((n) => n.endsWith('.plist'));
            const items = await mapLimit(files, 8, async (file) => {
              const plist = await readPlist(path.join(dir, file), signal);
              const name = plist?.label || file.replace(/\.plist$/, '');
              /** @type {Record<string, any>} */
              const item = { name };
              if (plist?.command) item.command = clip(scrub(plist.command), 90);
              if (plist) item.starts = plist.starts;
              if (pids.get(name)) item.running = true;
              if (disabled.get(name) ?? plist?.disabled) item.disabled = true;
              return item;
            });
            out[key] = items;
          }
          notes.push('Login items are kept where only root can read them; see System Settings, General, Login Items.');
        } else if (isLinux) {
          const home = h.homedir();
          const r = await run('systemctl', ['list-unit-files', '--state=enabled', '--no-pager', '--no-legend'], signal);
          if (r.missing) notes.push('systemctl is not available on this system.');
          else if (!r.ok && !r.stdout.trim()) notes.push(`systemd units: ${r.error}`);
          out.systemd = r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0])
            .filter((u) => u && /\.(service|timer|socket|path)$/.test(u)).sort();
          // Enabled user units are links in the .wants folders; reading them needs no bus.
          const userDir = path.join(h.env('XDG_CONFIG_HOME') || path.join(home, '.config'), 'systemd', 'user');
          /** @type {string[]} */
          const userUnits = [];
          for (const wants of (await namesIn(userDir)).filter((n) => n.endsWith('.wants'))) {
            for (const unit of await namesIn(path.join(userDir, wants))) if (!userUnits.includes(unit)) userUnits.push(unit);
          }
          out.userSystemd = userUnits.sort();
          const autostartDir = path.join(h.env('XDG_CONFIG_HOME') || path.join(home, '.config'), 'autostart');
          /** @type {Record<string, any>[]} */
          const autostart = [];
          for (const file of (await namesIn(autostartDir)).filter((n) => n.endsWith('.desktop'))) {
            const entry = parseDesktopEntry(await readOr(path.join(autostartDir, file)));
            /** @type {Record<string, any>} */
            const item = { name: entry.name || file.replace(/\.desktop$/, '') };
            if (entry.command) item.command = clip(scrub(entry.command), 90);
            if (entry.disabled) item.disabled = true;
            autostart.push(item);
          }
          out.autostart = autostart;
        } else if (isWin) {
          const json = await powershell(
            "$items=@(Get-CimInstance -ClassName Win32_StartupCommand | ForEach-Object { [pscustomobject]@{'name'=$_.Name;'command'=$_.Command;'location'=$_.Location;'user'=$_.User} });"
            // Task Manager's switch: an odd first byte in StartupApproved means disabled.
            + "$off=@(); $base='\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\';"
            + " foreach ($hive in 'HKCU:','HKLM:') { foreach ($sub in 'Run','Run32','StartupFolder') {"
            + ' $p=Get-ItemProperty -Path ($hive+$base+$sub); if ($p) { foreach ($prop in $p.PSObject.Properties) {'
            + ' $v=$prop.Value; if ($v -is [byte[]] -and $v.Length -gt 0 -and ($v[0] % 2) -eq 1) { $off+=$prop.Name } } } } };'
            + "ConvertTo-Json -InputObject ([pscustomobject]@{'items'=$items;'off'=$off}) -Compress -Depth 4", signal);
          const off = new Set(asArray(json?.off).map((s) => String(s).toLowerCase()));
          out.items = asArray(json?.items).filter((i) => i?.name).map((i) => {
            const loc = String(i.location || '');
            const key = /RunOnce/i.test(loc) ? 'RunOnce key' : 'Run key';
            const where = /startup/i.test(loc) ? (/common/i.test(loc) ? 'Startup folder, all users' : 'Startup folder')
              : /^HKLM/i.test(loc) ? `${key}, all users` : /^HK(U|CU)/i.test(loc) ? key : loc;
            /** @type {Record<string, any>} */
            const item = { name: String(i.name), where };
            if (i.command) item.command = clip(scrub(String(i.command)), 100);
            if (off.has(String(i.name).toLowerCase()) || off.has(`${String(i.name).toLowerCase()}.lnk`)) item.disabled = true;
            return item;
          });
          notes.push('Services that start automatically are listed by services.');
        } else {
          throw new Error(`Startup items are not available on this system (${platform}).`);
        }
        if (notes.length) out.notes = notes;
        return out;
      }
    },
    {
      name: 'hardware_info',
      title: 'Hardware',
      description: 'CPU, memory, GPUs with video memory, and connected displays.',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ,
      trim: [['displays', 'end'], ['gpus', 'end']],
      handler: async (_args, { signal }) => {
        /** @type {string[]} */
        const notes = [];
        /** @type {Record<string, any>} */
        let out;
        if (isMac) out = await hardwareMac(notes, signal);
        else if (isLinux) out = await hardwareLinux(notes, signal);
        else if (isWin) out = await hardwareWindows(signal);
        else throw new Error(`Hardware details are not available on this system (${platform}).`);
        if (!out.gpus.length) notes.push('No GPU was reported.');
        if (notes.length) out.notes = notes;
        return out;
      }
    },
    {
      name: 'ping_host',
      title: 'Ping',
      description: 'Ping a host 1 to 4 times and report packet loss and round-trip times.',
      inputSchema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Host name or IP address.' },
          count: { type: 'integer', minimum: 1, maximum: 4, description: 'Pings to send, default 3.' }
        },
        required: ['host']
      },
      annotations: NETWORK,
      handler: async (args, { signal }) => {
        const host = parseHost(args.host);
        const count = clampInt(args.count, 1, 4, 3);
        await assertReachable(host);
        const v6 = host.includes(':');
        // ping6 sends one ping a second and has no deadline flag: a second per ping, then 3s.
        const ping6 = isMac && v6;
        const timeoutMs = ping6 ? count * 1_000 + 3_000 : count * 2_500 + 3_000;
        /** @type {[string, string[]]} */
        let cmd;
        if (isWin) cmd = ['ping', ['-n', String(count), '-w', '2000', host]];
        else if (isMac) cmd = v6 ? ['ping6', ['-c', String(count), host]] : ['ping', ['-c', String(count), '-W', '2000', '-t', String(count * 2 + 2), host]];
        else cmd = ['ping', ['-n', '-c', String(count), '-W', '2', '-w', String(count * 2 + 2), host]];
        let r = await run(cmd[0], cmd[1], signal, { timeoutMs });
        // BusyBox ping has no -n.
        if (isLinux && !r.ok && /invalid option|unrecognized option/i.test(r.stderr)) {
          r = await run('ping', cmd[1].filter((a) => a !== '-n'), signal, { timeoutMs });
        }
        if (r.missing) throw new Error(`${cmd[0]} is not available on this system.`);
        const stats = parsePing(r.stdout, platform) || (ping6 && r.timedOut ? parsePingReplies(r.stdout, count) : null);
        if (!stats) {
          if (r.timedOut) throw new Error(`ping did not finish within ${Math.round(timeoutMs / 1000)}s.`);
          const why = firstLine(r.stderr) || firstLine(r.stdout.replace(/^\s+/, '')) || r.error;
          throw new Error(`ping failed: ${clip(why, 200)}`);
        }
        return { host, ...stats };
      }
    },
    {
      name: 'dns_lookup',
      title: 'DNS lookup',
      description: 'Resolve a name through the system resolver and the DNS servers, and list the configured DNS servers.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Host name, or an IP address for a reverse lookup.' } },
        required: ['name']
      },
      annotations: NETWORK,
      handler: async (args) => {
        const name = parseHost(args.name, 'name');
        await assertReachable(name);
        /** @type {string[]} */
        const notes = [];
        const servers = (() => { try { return h.dnsServers(); } catch { return []; } })();
        /** @param {Promise<any>} p */
        const bounded = (p) => {
          /** @type {ReturnType<typeof setTimeout>|undefined} */
          let timer;
          const late = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ETIMEOUT' })), DNS_TIMEOUT_MS);
          });
          return Promise.race([p, late]).finally(() => clearTimeout(timer));
        };
        /** @param {any} err */
        const why = (err) => {
          const code = String(err?.code || '');
          return ({ ENOTFOUND: 'not found', ENODATA: 'no records', ETIMEOUT: 'timed out', ESERVFAIL: 'server failure', EREFUSED: 'refused', ECONNREFUSED: 'refused', EAI_AGAIN: 'temporary failure' })[code]
            || clip(plainError(err), 80);
        };
        // With Go Dark on, ask the DNS servers only when they are on this network too.
        // A server on a non-default port reads "1.2.3.4:5353" or "[::1]:5353".
        const serverHost = (/** @type {string} */ s) => s.replace(/^\[([^\]]+)\]:\d+$/, '$1').replace(/^([\d.]+):\d+$/, '$1');
        const askServers = !(await readGoDark(dataDir)) || servers.every((s) => isLocalHost(serverHost(s)));
        if (!askServers) notes.push('Go Dark is on and a DNS server is outside this network, so only the system resolver was asked.');
        /** @type {Record<string, any>} */
        const out = { name };
        if (net.isIP(name.replace(/%.*$/, ''))) {
          if (askServers) {
            try { out.reverse = await bounded(h.reverse(name)); } catch (err) { out.reverse = why(err); }
          }
        } else {
          const [system, a, aaaa] = await Promise.allSettled([
            bounded(h.lookup(name)),
            askServers ? bounded(h.resolve(name, 'A')) : Promise.resolve(null),
            askServers ? bounded(h.resolve(name, 'AAAA')) : Promise.resolve(null)
          ]);
          out.system = system.status === 'fulfilled' ? [...new Set(asArray(system.value).map((x) => x?.address).filter(Boolean))] : why(system.reason);
          if (askServers) {
            out.A = a.status === 'fulfilled' ? a.value : why(a.reason);
            out.AAAA = aaaa.status === 'fulfilled' ? aaaa.value : why(aaaa.reason);
          }
        }
        out.servers = servers;
        if (notes.length) out.notes = notes;
        return out;
      }
    },
    {
      name: 'check_port',
      title: 'Check a port',
      description: 'Test whether a TCP port accepts connections: open, closed or timeout, with latency.',
      inputSchema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Host name or IP address.' },
          port: { type: 'integer', minimum: 1, maximum: 65535, description: 'TCP port.' },
          timeoutMs: { type: 'integer', minimum: 100, maximum: 10000, description: 'Wait for a connection, default 3000.' }
        },
        required: ['host', 'port']
      },
      annotations: NETWORK,
      handler: async (args, { signal }) => {
        const host = parseHost(args.host);
        const port = Number(args.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be a whole number from 1 to 65535.');
        const timeoutMs = clampInt(args.timeoutMs, 100, 10_000, 3_000);
        await assertReachable(host);
        const started = performance.now();
        /** @type {{state: string, address?: string, code?: string}} */
        const result = await new Promise((resolve) => {
          let done = false;
          const socket = h.connect({ host, port });
          /** @param {{state: string, address?: string, code?: string}} value */
          const finish = (value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            socket.destroy();
            resolve(value);
          };
          const onAbort = () => finish({ state: 'cancelled' });
          const timer = setTimeout(() => finish({ state: 'timeout' }), timeoutMs);
          signal?.addEventListener('abort', onAbort, { once: true });
          socket.once('connect', () => finish({ state: 'open', address: socket.remoteAddress }));
          socket.once('error', (/** @type {any} */ err) => {
            const code = String(err?.code || err?.errors?.[0]?.code || '');
            if (code === 'ECONNREFUSED' || code === 'ECONNRESET') finish({ state: 'closed' });
            else if (code === 'ETIMEDOUT') finish({ state: 'timeout' });
            else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') finish({ state: 'unreachable' });
            else finish({ state: 'error', code: code || plainError(err) });
          });
        });
        if (result.state === 'error' && /^(ENOTFOUND|EAI_AGAIN|EAI_NONAME)$/.test(String(result.code))) throw new Error(`Could not resolve ${host}.`);
        if (result.state === 'error') throw new Error(`Could not connect to ${host}:${port}: ${result.code}.`);
        if (result.state === 'cancelled') throw new Error('Cancelled.');
        /** @type {Record<string, any>} */
        const out = { host, port, state: result.state };
        if (result.state === 'open' || result.state === 'closed') out.latencyMs = Math.round((performance.now() - started) * 10) / 10;
        if (result.address) out.address = result.address;
        if (result.state === 'timeout') out.waitedMs = timeoutMs;
        return out;
      }
    },
    {
      name: 'kill_process',
      title: 'Stop a process',
      description: 'Stop a process by pid with SIGTERM, or SIGKILL when force is true; Mirabilis itself is refused.',
      inputSchema: {
        type: 'object',
        properties: {
          pid: { type: 'integer', minimum: 2, description: 'Process id, from list_processes.' },
          force: { type: 'boolean', description: 'Kill at once (SIGKILL) instead of asking it to quit.' }
        },
        required: ['pid']
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      handler: async (args, { signal }) => {
        // A number, or digits as text; null or true must not turn into 0 or 1.
        const raw = args.pid;
        const pid = typeof raw === 'number' || (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) ? Number(raw) : NaN;
        if (!Number.isInteger(pid) || pid < 0) throw new Error('pid must be a positive whole number.');
        // kill(0) would signal this server's whole group; pid 1 is init or launchd.
        if (pid <= 1) throw new Error(`Refusing to stop pid ${pid}: it is part of the operating system.`);
        if (pid === h.pid() || pid === h.ppid() || (await mirabilisPids(signal)).has(pid)) {
          throw new Error('Refusing to stop Mirabilis itself.');
        }
        const sig = args.force === true || args.force === 'true' ? 'SIGKILL' : 'SIGTERM';
        const name = await processName(pid, signal).catch(() => '');
        const label = name ? `${pid} (${name})` : String(pid);
        try {
          h.kill(pid, sig);
        } catch (err) {
          const code = /** @type {any} */ (err)?.code;
          if (code === 'ESRCH') throw new Error(`No process has pid ${pid}.`);
          if (code === 'EPERM') throw new Error(`Not permitted to stop ${label}: it belongs to another user or the system.`);
          throw new Error(`Could not stop ${label}: ${plainError(err)}`);
        }
        const deadline = now() + KILL_WAIT_MS;
        let exited = !alive(pid);
        while (!exited && now() < deadline && !signal?.aborted) {
          await delay(100);
          exited = !alive(pid);
        }
        if (!exited && !isWin) {
          // A process that has exited but not been reaped by its parent yet is done.
          const st = await run('ps', ['-o', 'stat=', '-p', String(pid)], signal);
          if (st.ok && /^Z/.test(st.stdout.trim())) exited = true;
        }
        /** @type {Record<string, any>} */
        const out = { pid, ...(name ? { name } : {}), signal: isWin ? 'terminate' : sig, exited };
        if (!exited) out.note = sig === 'SIGTERM' ? 'Still running; call again with force true to kill it.' : 'Still running after SIGKILL.';
        return out;
      }
    }
  ];

  /** @type {Map<string, typeof table[number]>} */
  const byName = new Map(table.map((t) => [t.name, t]));

  return {
    /** MCP tool definitions for tools/list. @type {MachineTool[]} */
    tools: table.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
    /** The raw handlers, for tests. */
    handlers: Object.fromEntries(table.map((t) => [t.name, t.handler])),
    /** @param {string} name */
    has: (name) => byName.has(name),
    /**
     * Run one tool. Failures come back as isError with one plain sentence.
     * @param {string} name
     * @param {any} args
     * @param {{signal?: AbortSignal}} [ctx]
     * @returns {Promise<ToolResult>}
     */
    async call(name, args, ctx = {}) {
      const tool = byName.get(name);
      if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${clip(String(name), 80)}` }], isError: true };
      if (args != null && (typeof args !== 'object' || Array.isArray(args))) {
        return { content: [{ type: 'text', text: 'Arguments must be a JSON object.' }], isError: true };
      }
      try {
        const value = await tool.handler(args || {}, { signal: ctx.signal });
        return { content: [{ type: 'text', text: fitResult(value, tool.trim) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: plainError(err) }], isError: true };
      }
    }
  };
}
