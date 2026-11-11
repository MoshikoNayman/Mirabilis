// @ts-check
// Read-only views of this computer for troubleshooting: OS, processes, network, logs.
// Probes are bounded and report what they could not read; a missing utility never throws.

import os from 'node:os';
import dns from 'node:dns';
import path from 'node:path';
import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';

import { expandHome } from '../paths.js';
import { safeResolvePath } from './sandbox.js';
import { redact } from './auditLog.js';

/** Ceiling for any one subprocess. */
export const COMMAND_TIMEOUT_MS = 10_000;

/**
 * The agent loop keeps about 4000 characters of each observation, so text-heavy
 * results stay under that or their newest lines are the ones cut.
 */
export const TEXT_BUDGET = 3_200;
const MAX_LINE_CHARS = 400;

const LOG_DEFAULT_LINES = 200;
const LOG_MAX_LINES = 2_000;
const LOG_CHUNK_BYTES = 64 * 1024;
const LOG_MAX_SCAN_BYTES = 8 * 1024 * 1024;

const PROC_DEFAULT_LIMIT = 15;
const PROC_MAX_LIMIT = 50;
const MAX_LISTENERS = 30;
const MAX_DISKS = 8;

/** GUI-launched apps get a minimal PATH; these hold ps, lsof, ss and friends. */
const EXTRA_PATH = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** df rows that are not storage a user can fill. */
const PSEUDO_FS = new Set([
  'tmpfs', 'devtmpfs', 'udev', 'devfs', 'none', 'shm', 'proc', 'sysfs', 'cgroup', 'cgroup2',
  'efivarfs', 'ramfs', 'autofs', 'squashfs', 'overlay'
]);

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Credentials out of any text a tool returns: process command lines, log lines.
 * @param {unknown} text
 */
export function scrub(text) {
  return redact(String(text ?? ''));
}

/**
 * @typedef {(command: string, args: string[], opts?: {timeoutMs?: number, env?: Record<string, string>, signal?: AbortSignal}) => Promise<{stdout: string, stderr: string}>} RunCommand
 * Same contract as services/proc.js runCommand: resolves on exit 0, otherwise rejects
 * with an error carrying `code` ('ENOENT' when missing), `exitCode`, `stdout`, `stderr`.
 */

/** Real host facts; tests replace any of them. */
const DEFAULT_HOST = {
  cpus: () => os.cpus(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  loadavg: () => os.loadavg(),
  uptime: () => os.uptime(),
  hostname: () => os.hostname(),
  release: () => os.release(),
  version: () => os.version(),
  arch: () => os.arch(),
  homedir: () => os.homedir(),
  networkInterfaces: () => os.networkInterfaces(),
  dnsServers: () => dns.getServers(),
  nodeVersion: () => process.version,
  uid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
  shell: () => process.env.SHELL || process.env.ComSpec || safe(() => os.userInfo().shell, '') || '',
  /** @param {string} file */
  readText: (file) => fsp.readFile(file, 'utf8'),
  /** @param {string} p */
  statfs: (p) => fsp.statfs(p)
};

/** @typedef {typeof DEFAULT_HOST} HostApi */

/**
 * @template T
 * @param {() => T} fn
 * @param {T} fallback
 * @returns {T}
 */
function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/** @param {any} value @param {number} min @param {number} max @param {number} fallback */
function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** @param {string} text @param {number} limit */
function clip(text, limit) {
  const s = String(text ?? '');
  return s.length > limit ? `${s.slice(0, limit - 3)}...` : s;
}

/** @param {string} text */
function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0] || '';
}

const round1 = (/** @type {number} */ n) => Math.round(n * 10) / 10;
/** Disks in decimal GB, as Finder and drive labels show them. */
const diskGB = (/** @type {number} */ bytes) => round1(bytes / 1e9);
/** Memory in binary GB, as Activity Monitor and Task Manager show it. */
const memGB = (/** @type {number} */ bytes) => round1(bytes / 1024 ** 3);

/** @param {number} seconds */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

/** @param {string} p */
function baseName(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Bounded execFile with no shell and a hidden console on Windows.
 * @type {RunCommand}
 */
function execRunner(command, args, { timeoutMs = COMMAND_TIMEOUT_MS, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
      signal
    }, (error, stdout, stderr) => {
      if (!error) { resolve({ stdout, stderr }); return; }
      const err = /** @type {any} */ (error);
      if (err.killed && !signal?.aborted) err.message = `${command} timed out after ${timeoutMs}ms`;
      Object.assign(err, { exitCode: typeof err.code === 'number' ? err.code : null, stdout, stderr });
      reject(err);
    });
  });
}

/** @param {string} platform */
function subprocessEnv(platform) {
  if (platform === 'win32') return undefined;
  const parts = String(process.env.PATH || '').split(':').filter(Boolean);
  for (const dir of EXTRA_PATH) if (!parts.includes(dir)) parts.push(dir);
  // Numbers from ps and df stay parseable whatever the user's locale.
  return { PATH: parts.join(':'), LC_ALL: 'C' };
}

/**
 * Newest lines of a text file, bounded by line count, bytes scanned and characters
 * returned. Lines are redacted and stripped of terminal color codes.
 * @param {string} file absolute path to a regular file
 * @param {{lines?: number, filter?: string, budget?: number}} [opts]
 */
export async function tailTextFile(file, { lines, filter, budget = TEXT_BUDGET } = {}) {
  // stat before open: opening a FIFO or a device would block or never end.
  const info = await fsp.stat(file);
  if (!info.isFile()) throw new Error(`${file} is not a regular file.`);
  const want = clampInt(lines, 1, LOG_MAX_LINES, LOG_DEFAULT_LINES);
  const needle = String(filter ?? '').trim().toLowerCase().slice(0, 200);

  /** @type {string[]} newest first */
  const newestFirst = [];
  let scanned = 0;
  const fh = await fsp.open(file, 'r');
  try {
    let pos = info.size;
    let carry = Buffer.alloc(0);
    let first = true;
    /** @param {Buffer} bytes */
    const take = (bytes) => {
      const line = bytes.toString('utf8').replace(ANSI_RE, '').replace(/\r$/, '');
      if (line.trim()) newestFirst.push(line);
    };
    while (pos > 0 && newestFirst.length < want && scanned < LOG_MAX_SCAN_BYTES) {
      const len = Math.min(LOG_CHUNK_BYTES, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      const fresh = buf.subarray(0, bytesRead);
      scanned += bytesRead;
      if (first) {
        first = false;
        if (fresh.includes(0)) {
          throw new Error(`${file} looks like a binary file, not a text log.`);
        }
      }
      const chunk = carry.length ? Buffer.concat([fresh, carry]) : fresh;
      // The carry holds no newline, so only the fresh bytes need scanning.
      let end = chunk.length;
      let i = fresh.length - 1;
      while (i >= 0 && newestFirst.length < want) {
        const nl = chunk.lastIndexOf(0x0a, i);
        if (nl < 0) break;
        take(chunk.subarray(nl + 1, end));
        end = nl;
        i = nl - 1;
      }
      carry = chunk.subarray(0, end);
    }
    if (pos === 0 && carry.length && newestFirst.length < want) take(carry);
  } finally {
    await fh.close().catch(() => {});
  }

  const matching = needle ? newestFirst.filter((l) => l.toLowerCase().includes(needle)) : newestFirst;
  const kept = [];
  let used = 0;
  for (const raw of matching) {
    const line = clip(scrub(raw), MAX_LINE_CHARS);
    if (used + line.length + 1 > budget && kept.length > 0) break;
    kept.push(line);
    used += line.length + 1;
  }
  kept.reverse();

  /** @type {Record<string, any>} */
  const out = {
    sizeBytes: info.size,
    modified: info.mtime.toISOString(),
    linesRead: newestFirst.length
  };
  if (needle) out.matched = matching.length;
  out.shown = kept.length;
  if (kept.length < matching.length) {
    out.truncated = true;
    out.note = `Showing the newest ${kept.length} of ${matching.length} lines to fit the output limit.`
      + (needle ? '' : ' Add a filter to find specific lines.');
  } else if (scanned >= LOG_MAX_SCAN_BYTES && newestFirst.length < want) {
    out.note = `Stopped after reading the last ${Math.round(LOG_MAX_SCAN_BYTES / 1024 / 1024)} MB of the file.`;
  }
  out.text = kept.join('\n');
  return out;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.platform]
 * @param {RunCommand} [opts.runCommand]  Injected in tests; defaults to a bounded execFile.
 * @param {Partial<HostApi>} [opts.host]  Host facts, replaceable in tests.
 * @param {string} [opts.workDir]         Base for relative log paths (default: home).
 */
export function createSystemTools({ platform = process.platform, runCommand, host, workDir } = {}) {
  const runner = typeof runCommand === 'function' ? runCommand : execRunner;
  /** @type {HostApi} */
  const h = { ...DEFAULT_HOST, ...(host || {}) };
  const env = subprocessEnv(platform);
  const isWin = platform === 'win32';
  const isMac = platform === 'darwin';

  /**
   * Run one probe. Never rejects: failures come back as a short reason.
   * @param {string} command
   * @param {string[]} args
   * @param {AbortSignal} [signal]
   */
  async function run(command, args, signal) {
    try {
      const res = await runner(command, args, { timeoutMs: COMMAND_TIMEOUT_MS, env, signal });
      return { ok: true, stdout: String(res?.stdout ?? ''), error: '' };
    } catch (err) {
      const e = /** @type {any} */ (err) || {};
      const message = String(e.message || e);
      let error;
      if (e.code === 'ENOENT') error = `${command} is not available on this system`;
      else if (/timed out/i.test(message)) error = `${command} did not finish within ${COMMAND_TIMEOUT_MS / 1000}s`;
      else error = `${command} failed: ${clip(firstLine(e.stderr) || firstLine(message), 160)}`;
      return { ok: false, stdout: String(e.stdout ?? ''), error };
    }
  }

  // Processes

  /**
   * @typedef {{pid: number, user: string|null, cpu: number|null, mem: number|null, rssKB: number, elapsed: string|null, comm: string, args: string}} ProcRow
   */

  /** @param {AbortSignal} [signal] @returns {Promise<{rows: ProcRow[], error: string, cpuKnown: boolean}>} */
  async function readProcesses(signal) {
    if (isWin) {
      const r = await run('tasklist', ['/fo', 'csv', '/nh'], signal);
      const total = safe(() => h.totalmem(), 0);
      /** @type {ProcRow[]} */
      const rows = [];
      for (const line of r.stdout.split(/\r?\n/)) {
        const cells = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
        if (cells.length < 5) continue;
        const pid = Number(cells[1]);
        if (!Number.isFinite(pid)) continue;
        const rssKB = Number(cells[4].replace(/[^\d]/g, '')) || 0;
        rows.push({
          pid, user: null, cpu: null,
          mem: total > 0 ? round1((rssKB * 1024 * 100) / total) : null,
          rssKB, elapsed: null, comm: cells[0], args: ''
        });
      }
      return { rows, error: rows.length ? '' : (r.error || 'tasklist returned no processes'), cpuKnown: false };
    }
    const [stats, cmds] = await Promise.all([
      run('ps', ['-A', '-o', 'pid=,user=,%cpu=,%mem=,rss=,etime=,comm='], signal),
      run('ps', ['-A', '-ww', '-o', 'pid=,args='], signal)
    ]);
    /** @type {Map<number, string>} */
    const argsByPid = new Map();
    for (const line of cmds.stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s?(.*)$/);
      if (m) argsByPid.set(Number(m[1]), m[2].trim());
    }
    /** @type {ProcRow[]} */
    const rows = [];
    for (const line of stats.stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      rows.push({
        pid, user: m[2], cpu: Number(m[3]), mem: Number(m[4]), rssKB: Number(m[5]),
        elapsed: m[6], comm: m[7].trim(), args: argsByPid.get(pid) || ''
      });
    }
    return { rows, error: rows.length ? '' : (stats.error || 'ps returned no processes'), cpuKnown: true };
  }

  /** Program name plus arguments, without the long install path. @param {ProcRow} p */
  function fullCommand(p) {
    let text;
    if (p.args && p.comm && p.args.startsWith(p.comm)) text = baseName(p.comm) + p.args.slice(p.comm.length);
    else if (p.args) text = p.args.replace(/^(\/\S*\/)(\S+)/, '$2');
    else text = baseName(p.comm);
    return text.replace(/\s+/g, ' ').trim();
  }

  /** @param {ProcRow[]} rows @param {'cpu'|'memory'} by */
  function sortRows(rows, by) {
    return [...rows].sort((a, b) => (by === 'cpu'
      ? ((b.cpu ?? 0) - (a.cpu ?? 0)) || (b.rssKB - a.rssKB)
      : (b.rssKB - a.rssKB) || ((b.cpu ?? 0) - (a.cpu ?? 0))));
  }

  /** @param {ProcRow} p @param {number} width @param {boolean} [full] */
  function procView(p, width, full = false) {
    /** @type {Record<string, any>} */
    const v = { pid: p.pid };
    if (full) v.user = p.user;
    v.cpu = p.cpu;
    v.mem = p.mem;
    v.rssMB = Math.round(p.rssKB / 1024);
    if (full) v.elapsed = p.elapsed;
    v.command = clip(scrub(fullCommand(p)), width);
    return v;
  }

  // System overview

  /** @param {string[]} notes @param {AbortSignal} [signal] */
  async function describeOs(notes, signal) {
    if (isMac) {
      const r = await run('sw_vers', [], signal);
      const get = (/** @type {string} */ k) => r.stdout.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]?.trim();
      const version = get('ProductVersion');
      if (version) {
        const build = get('BuildVersion');
        return `${get('ProductName') || 'macOS'} ${version}${build ? ` (${build})` : ''}`;
      }
      notes.push(`os version: ${r.error || 'sw_vers gave no version'}`);
      return 'macOS';
    }
    if (platform === 'linux') {
      try {
        const text = await h.readText('/etc/os-release');
        const pick = (/** @type {string} */ k) => text.match(new RegExp(`^${k}=("?)(.*)\\1\\s*$`, 'm'))?.[2];
        const name = pick('PRETTY_NAME') || [pick('NAME'), pick('VERSION')].filter(Boolean).join(' ');
        if (name) return name;
      } catch { /* not every distribution ships it */ }
      notes.push('os version: /etc/os-release is missing or empty');
      return 'Linux';
    }
    if (isWin) return `${safe(() => h.version(), 'Windows')} (build ${safe(() => h.release(), '?')})`;
    return `${platform} ${safe(() => h.release(), '')}`.trim();
  }

  /**
   * On macOS os.freemem() counts only idle pages, near zero on a healthy machine.
   * Used here is what Activity Monitor reports: app memory plus wired plus compressed.
   * @param {string[]} notes @param {AbortSignal} [signal]
   */
  async function describeMemory(notes, signal) {
    const total = safe(() => h.totalmem(), 0);
    let free = safe(() => h.freemem(), 0);
    /** @type {Record<string, any>} */
    const extra = {};
    if (isMac) {
      const [vm, sys] = await Promise.all([
        run('vm_stat', [], signal),
        run('sysctl', ['vm.swapusage', 'kern.memorystatus_vm_pressure_level'], signal)
      ]);
      const pageSize = Number(vm.stdout.match(/page size of (\d+) bytes/)?.[1]) || 4096;
      const pages = (/** @type {string} */ label) => Number(vm.stdout.match(new RegExp(`^${label}:\\s+(\\d+)`, 'm'))?.[1]);
      const anon = pages('Anonymous pages');
      const purgeable = pages('Pages purgeable') || 0;
      const wired = pages('Pages wired down');
      const compressed = pages('Pages occupied by compressor') || 0;
      const active = pages('Pages active');
      const appPages = Number.isFinite(anon) ? anon - purgeable : active;
      if (Number.isFinite(appPages) && Number.isFinite(wired) && total > 0) {
        const used = (appPages + wired + compressed) * pageSize;
        free = Math.max(0, total - used);
      } else {
        notes.push(`memory: ${vm.error || 'vm_stat output not understood'}; free is the strict free page count`);
      }
      const swap = sys.stdout.match(/vm\.swapusage:.*?used = ([\d.]+)M/);
      if (swap) extra.swapUsedGB = round1(Number(swap[1]) / 1024);
      const level = Number(sys.stdout.match(/kern\.memorystatus_vm_pressure_level:\s*(\d+)/)?.[1]);
      if (Number.isFinite(level)) extra.pressure = level >= 4 ? 'critical' : level >= 2 ? 'warning' : 'normal';
    } else if (platform === 'linux') {
      const r = await run('free', ['-k'], signal);
      const swap = r.stdout.match(/^Swap:\s+(\d+)\s+(\d+)/m);
      if (swap) extra.swapUsedGB = memGB(Number(swap[2]) * 1024);
    }
    return {
      totalGB: memGB(total),
      freeGB: memGB(free),
      usedPercent: total > 0 ? Math.round(((total - free) / total) * 100) : null,
      ...extra
    };
  }

  /** @param {string[]} notes @param {AbortSignal} [signal] */
  async function describeDisks(notes, signal) {
    if (isWin) {
      const drive = `${String(process.env.SystemDrive || 'C:').replace(/\\$/, '')}\\`;
      try {
        const s = await h.statfs(drive);
        const size = s.blocks * s.bsize;
        const avail = s.bavail * s.bsize;
        return [{ mount: drive, sizeGB: diskGB(size), usedGB: diskGB(size - avail), freeGB: diskGB(avail),
          usedPercent: size > 0 ? Math.round(((size - avail) / size) * 100) : null }];
      } catch (err) {
        notes.push(`disks: ${clip(String(/** @type {any} */ (err)?.message || err), 120)}`);
        return [];
      }
    }
    const r = await run('df', ['-kP'], signal);
    /** @type {Array<{fs: string, mount: string, size: number, used: number, avail: number, pct: number}>} */
    const rows = [];
    for (const line of r.stdout.split('\n').slice(1)) {
      const m = line.match(/^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\S.*)$/);
      if (!m) continue;
      const [, fs, sizeK, usedK, availK, pct, mountRaw] = m;
      const mount = mountRaw.trim();
      const size = Number(sizeK) * 1024;
      if (!(size > 0)) continue;
      if (fs.startsWith('map ') || fs.startsWith('/dev/loop')) continue;
      if (PSEUDO_FS.has(fs) && !(fs === 'overlay' && mount === '/')) continue;
      if (/^\/(dev|run|sys|proc|snap)(\/|$)/.test(mount) || mount.includes('/CoreSimulator/')) continue;
      rows.push({ fs, mount, size, used: Number(usedK) * 1024, avail: Number(availK) * 1024, pct: Number(pct) });
    }
    if (!rows.length) {
      notes.push(`disks: ${r.error || 'df listed no volumes'}`);
      return [];
    }
    /** @type {Array<{mount: string, size: number, used: number, avail: number, pct: number}>} */
    let disks;
    if (isMac) {
      // APFS volumes share their container's space, so "/" alone looks nearly
      // empty. One row per container, with the container's real usage.
      /** @type {Map<string, typeof rows>} */
      const groups = new Map();
      for (const row of rows) {
        const key = row.fs.match(/^\/dev\/(disk\d+)/)?.[1] || row.fs;
        const list = groups.get(key) || [];
        list.push(row);
        groups.set(key, list);
      }
      disks = [];
      for (const list of groups.values()) {
        const mounts = list.map((x) => x.mount);
        const mount = mounts.includes('/') ? '/'
          : mounts.includes('/System/Volumes/Data') ? '/System/Volumes/Data'
            : mounts.find((x) => !x.startsWith('/System/Volumes/'));
        if (!mount) continue;
        const size = Math.max(...list.map((x) => x.size));
        const avail = Math.min(...list.map((x) => x.avail));
        disks.push({ mount, size, used: size - avail, avail, pct: Math.round(((size - avail) / size) * 100) });
      }
    } else {
      disks = rows;
    }
    disks.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : b.size - a.size));
    return disks.slice(0, MAX_DISKS).map((d) => ({
      mount: d.mount, sizeGB: diskGB(d.size), usedGB: diskGB(d.used), freeGB: diskGB(d.avail), usedPercent: d.pct
    }));
  }

  /** @param {AbortSignal} [signal] */
  async function describeCpu(signal) {
    const cpus = safe(() => h.cpus(), []);
    /** @type {Record<string, any>} */
    const cpu = { model: String(cpus[0]?.model || '').trim() || null, cores: cpus.length || null };
    if (isMac) {
      const r = await run('sysctl', ['hw.perflevel0.physicalcpu', 'hw.perflevel1.physicalcpu'], signal);
      const perf = Number(r.stdout.match(/hw\.perflevel0\.physicalcpu:\s*(\d+)/)?.[1]);
      const eff = Number(r.stdout.match(/hw\.perflevel1\.physicalcpu:\s*(\d+)/)?.[1]);
      if (perf > 0 && eff > 0) { cpu.performanceCores = perf; cpu.efficiencyCores = eff; }
    }
    return cpu;
  }

  // Network

  /** @param {string} addr */
  const isLoopback = (addr) => /^(127\.|::1$|localhost$)/i.test(addr);

  /**
   * One row per (pid, port), addresses merged: IPv4 and IPv6 sockets of one server
   * are a single fact for the reader.
   * @param {Array<{port: number, address: string, process: string|null, pid: number|null}>} raw
   */
  function mergeListeners(raw) {
    /** @type {Map<string, {port: number, addresses: Set<string>, process: string|null, pid: number|null}>} */
    const byKey = new Map();
    for (const l of raw) {
      if (!Number.isFinite(l.port)) continue;
      const key = `${l.pid ?? '?'}|${l.port}`;
      const cur = byKey.get(key) || { port: l.port, addresses: new Set(), process: l.process, pid: l.pid };
      cur.addresses.add(l.address === '0.0.0.0' || l.address === '::' || l.address === '[::]' ? '*' : l.address);
      if (!cur.process && l.process) cur.process = l.process;
      byKey.set(key, cur);
    }
    const rows = [...byKey.values()].map((l) => {
      // IPv4 first, then IPv6, so the same server always reads the same way.
      const addrs = l.addresses.has('*') ? ['*']
        : [...l.addresses].sort((x, y) => Number(x.includes(':')) - Number(y.includes(':')) || x.localeCompare(y));
      return {
        port: l.port,
        address: addrs.join(', '),
        process: l.process,
        pid: l.pid,
        exposure: addrs.every(isLoopback) ? 'local' : 'network'
      };
    });
    rows.sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
    return rows;
  }

  /** "host:port" with optional brackets and zone. @param {string} s */
  function splitHostPort(s) {
    const m = String(s).match(/^\[?(.*?)\]?[:.](\d+|\*)$/);
    if (!m) return { address: s, port: NaN };
    return { address: m[1].replace(/%.*$/, '') || '*', port: Number(m[2]) };
  }

  function describeInterfaces() {
    const all = safe(() => h.networkInterfaces(), {});
    /** @type {Array<Record<string, any>>} */
    const shown = [];
    /** @type {Array<Record<string, any>>} */
    const internal = [];
    /** @type {string[]} */
    const linkLocalOnly = [];
    for (const [name, list] of Object.entries(all || {})) {
      const addrs = /** @type {any[]} */ (list || []);
      const v4 = addrs.filter((a) => a.family === 'IPv4' || a.family === 4).map((a) => a.cidr || a.address);
      const v6 = addrs.filter((a) => (a.family === 'IPv6' || a.family === 6) && !/^fe80:/i.test(a.address))
        .map((a) => a.cidr || a.address).slice(0, 4);
      /** @type {Record<string, any>} */
      const row = { name };
      if (v4.length) row.ipv4 = v4;
      if (v6.length) row.ipv6 = v6;
      if (addrs.length && addrs.every((a) => a.internal)) internal.push(row);
      else if (v4.length || v6.length) shown.push(row);
      else linkLocalOnly.push(name);
    }
    return { interfaces: shown.length ? shown : internal, linkLocalOnly };
  }

  /** @param {string[]} notes @param {AbortSignal} [signal] */
  async function probeNetworkMac(notes, signal) {
    const [route, scutil, lsof, netstat] = await Promise.all([
      run('route', ['-n', 'get', 'default'], signal),
      run('scutil', ['--dns'], signal),
      // +c 0 gives full process names; -F gives one field per line, safe to parse.
      run('lsof', ['-nP', '+c', '0', '-iTCP', '-sTCP:LISTEN', '-FpcLn'], signal),
      run('netstat', ['-an', '-p', 'tcp'], signal)
    ]);
    const gwAddr = route.stdout.match(/gateway:\s*(\S+)/)?.[1];
    const gateway = gwAddr ? { address: gwAddr, interface: route.stdout.match(/interface:\s*(\S+)/)?.[1] || null } : null;
    if (!gateway && !route.ok && !/not in table/i.test(route.error)) notes.push(`gateway: ${route.error}`);

    const dnsFound = [...new Set([...scutil.stdout.matchAll(/nameserver\[\d+\]\s*:\s*(\S+)/g)].map((m) => m[1]))];

    /** @type {Array<{port: number, address: string, process: string|null, pid: number|null}>} */
    const raw = [];
    /** @type {{pid: number, process: string}|null} */
    let cur = null;
    for (const line of lsof.stdout.split('\n')) {
      const tag = line[0];
      const val = line.slice(1);
      if (tag === 'p') cur = { pid: Number(val), process: '' };
      else if (cur && tag === 'c') cur.process = val;
      else if (cur && tag === 'n') raw.push({ ...splitHostPort(val), process: cur.process || null, pid: cur.pid });
    }
    // lsof exits 1 when nothing listens; only a missing or hung lsof is worth a note.
    if (!lsof.ok && /not available|did not finish/.test(lsof.error)) notes.push(`listening: ${lsof.error}`);
    // netstat sees every listener, including ones lsof cannot name without sudo.
    const known = new Set(raw.map((l) => l.port));
    let established = 0;
    for (const line of netstat.stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (!/^tcp/.test(cols[0] || '')) continue;
      const state = cols[cols.length - 1];
      if (state === 'ESTABLISHED') established += 1;
      else if (state === 'LISTEN') {
        const l = splitHostPort(cols[3] || '');
        if (Number.isFinite(l.port) && !known.has(l.port)) raw.push({ ...l, process: null, pid: null });
      }
    }
    if (!netstat.ok && !netstat.stdout) notes.push(`connections: ${netstat.error}`);
    return { gateway, dnsFound, raw, established: netstat.stdout ? established : null };
  }

  /** @param {string[]} notes @param {AbortSignal} [signal] */
  async function probeNetworkLinux(notes, signal) {
    const [route, resolv, ss, summary] = await Promise.all([
      run('ip', ['route', 'show', 'default'], signal),
      h.readText('/etc/resolv.conf').catch(() => ''),
      run('ss', ['-ltnp'], signal),
      run('ss', ['-s'], signal)
    ]);
    /** @type {{address: string, interface: string|null}|null} */
    let gateway = null;
    const viaIp = route.stdout.match(/default via (\S+)(?:.*?\bdev (\S+))?/);
    if (viaIp) gateway = { address: viaIp[1], interface: viaIp[2] || null };
    else {
      const rt = await run('route', ['-n'], signal);
      const m = rt.stdout.match(/^0\.0\.0\.0\s+(\S+)\s+0\.0\.0\.0\s+\S*G\S*\s+\S+\s+\S+\s+\S+\s+(\S+)/m);
      if (m) gateway = { address: m[1], interface: m[2] };
      else if (!route.ok && !rt.ok) notes.push(`gateway: ${route.error}`);
    }

    let dnsFound = [...String(resolv).matchAll(/^\s*nameserver\s+(\S+)/gm)].map((m) => m[1]);
    /** @type {string|null} */
    let dnsVia = null;
    if (dnsFound.length && dnsFound.every((s) => s.startsWith('127.0.0.5'))) {
      // systemd-resolved stub: the real upstream servers are behind it.
      // Lines look like "Link 2 (eth0): 192.168.1.1 fe80::1%eth0" or "Global: 1.1.1.1#one.one.one.one".
      const rc = await run('resolvectl', ['dns'], signal);
      const upstream = [];
      for (const line of rc.stdout.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        for (const token of line.slice(colon + 1).trim().split(/\s+/)) {
          const ip = token.replace(/[%#].*$/, '');
          if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || (/^[0-9a-f:]+$/i.test(ip) && ip.includes(':') && !/^fe80/i.test(ip))) {
            upstream.push(ip);
          }
        }
      }
      if (upstream.length) { dnsFound = [...new Set(upstream)]; dnsVia = 'systemd-resolved'; }
    }

    /** @type {Array<{port: number, address: string, process: string|null, pid: number|null}>} */
    const raw = [];
    let established = Number(summary.stdout.match(/estab\s+(\d+)/)?.[1]);
    if (ss.stdout.trim()) {
      for (const line of ss.stdout.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] !== 'LISTEN' || cols.length < 4) continue;
        const proc = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
        raw.push({ ...splitHostPort(cols[3]), process: proc ? proc[1] : null, pid: proc ? Number(proc[2]) : null });
      }
    } else {
      const [ns, conn] = await Promise.all([run('netstat', ['-ltnp'], signal), run('netstat', ['-tn'], signal)]);
      for (const line of ns.stdout.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (!/^tcp/.test(cols[0] || '') || cols[5] !== 'LISTEN') continue;
        const owner = (cols[6] || '').match(/^(\d+)\/(.+)$/);
        raw.push({ ...splitHostPort(cols[3]), process: owner ? owner[2] : null, pid: owner ? Number(owner[1]) : null });
      }
      if (!ns.stdout.trim()) notes.push(`listening: ${ss.error}; ${ns.error}`);
      if (!Number.isFinite(established) && conn.stdout) {
        established = conn.stdout.split('\n').filter((l) => /\bESTABLISHED\b/.test(l)).length;
      }
    }
    return { gateway, dnsFound, dnsVia, raw, established: Number.isFinite(established) ? established : null };
  }

  /** @param {string[]} notes @param {AbortSignal} [signal] */
  async function probeNetworkWindows(notes, signal) {
    const [route, netstat, tasks] = await Promise.all([
      run('route', ['print', '-4', '0.0.0.0'], signal),
      run('netstat', ['-ano'], signal),
      run('tasklist', ['/fo', 'csv', '/nh'], signal)
    ]);
    const gw = route.stdout.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\S+)/m);
    const gateway = gw ? { address: gw[1], interface: gw[2] } : null;
    if (!gateway && !route.ok) notes.push(`gateway: ${route.error}`);
    /** @type {Map<number, string>} */
    const names = new Map();
    for (const line of tasks.stdout.split(/\r?\n/)) {
      const cells = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      if (cells.length >= 2 && Number.isFinite(Number(cells[1]))) names.set(Number(cells[1]), cells[0]);
    }
    /** @type {Array<{port: number, address: string, process: string|null, pid: number|null}>} */
    const raw = [];
    let established = 0;
    for (const line of netstat.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/i);
      if (!m) continue;
      const pid = Number(m[4]);
      // A listener's foreign side is port 0 in every Windows language.
      if (/:0$/.test(m[2])) raw.push({ ...splitHostPort(m[1]), process: names.get(pid) || null, pid });
      else if (/ESTABLISHED/i.test(m[3])) established += 1;
    }
    if (!netstat.stdout) notes.push(`listening: ${netstat.error}`);
    return { gateway, dnsFound: [], raw, established: netstat.stdout ? established : null };
  }

  // Tools

  /** @type {Record<string, any>} */
  const tools = {
    system_overview: {
      kind: 'read',
      mutating: false,
      description: 'Snapshot of this computer: OS and version, CPU, load, memory, disks, uptime, '
        + 'and the top processes by CPU and by memory. Start here for "why is my computer slow".',
      parameters: {},
      async execute(_args = {}, ctx = {}) {
        const signal = ctx?.signal;
        /** @type {string[]} */
        const notes = [];
        const [osName, cpu, memory, disks, procs] = await Promise.all([
          describeOs(notes, signal),
          describeCpu(signal),
          describeMemory(notes, signal),
          describeDisks(notes, signal),
          readProcesses(signal)
        ]);
        if (procs.error) notes.push(`processes: ${procs.error}`);
        const load = isWin ? null : safe(() => h.loadavg().map((n) => Math.round(n * 100) / 100), null);
        /** @type {Record<string, any>} */
        const out = {
          os: osName,
          kernel: isWin ? null : `${isMac ? 'Darwin' : platform === 'linux' ? 'Linux' : platform} ${safe(() => h.release(), '')}`.trim(),
          arch: safe(() => h.arch(), process.arch),
          hostname: safe(() => h.hostname(), null),
          uptime: formatDuration(safe(() => h.uptime(), 0)),
          cpu,
          loadAverage: load ? { '1m': load[0], '5m': load[1], '15m': load[2] } : null,
          memory,
          disks,
          processCount: procs.rows.length || null,
          topCpu: procs.cpuKnown ? sortRows(procs.rows, 'cpu').slice(0, 5).map((p) => procView(p, 60)) : null,
          topMemory: sortRows(procs.rows, 'memory').slice(0, 5).map((p) => procView(p, 60)),
          node: safe(() => h.nodeVersion(), process.version),
          shell: safe(() => h.shell(), '') || null
        };
        if (platform === 'linux') notes.push('cpu% on Linux is averaged over each process lifetime');
        if (isWin) notes.push('Windows reports no load average or per-process CPU percent here');
        if (notes.length) out.notes = notes;
        return out;
      }
    },

    list_processes: {
      kind: 'read',
      mutating: false,
      description: 'List running processes with pid, owner, CPU %, memory %, resident memory, '
        + 'run time and command. Sort by cpu or memory, and filter by name.',
      parameters: {
        sortBy: 'string (optional: cpu or memory, default cpu)',
        filter: 'string (optional: only processes whose command or user contains this text)',
        limit: `number (optional, default ${PROC_DEFAULT_LIMIT}, max ${PROC_MAX_LIMIT})`
      },
      async execute(args = {}, ctx = {}) {
        const a = args || {};
        const limit = clampInt(a.limit, 1, PROC_MAX_LIMIT, PROC_DEFAULT_LIMIT);
        let sortBy = /** @type {'cpu'|'memory'} */ (String(a.sortBy || 'cpu').toLowerCase().startsWith('mem') ? 'memory' : 'cpu');
        const needle = String(a.filter ?? '').trim().toLowerCase();
        const procs = await readProcesses(ctx?.signal);
        if (!procs.rows.length) return { error: `Could not list processes: ${procs.error}`, processes: [] };
        /** @type {string[]} */
        const notes = [];
        if (sortBy === 'cpu' && !procs.cpuKnown) {
          sortBy = 'memory';
          notes.push('CPU percent is not available on this system; sorted by memory.');
        }
        const matched = needle
          ? procs.rows.filter((p) => `${fullCommand(p)} ${p.user || ''} ${p.pid}`.toLowerCase().includes(needle))
          : procs.rows;
        // Row keys cost about 85 characters, so long listings get shorter commands.
        const width = limit <= 20 ? 90 : limit <= 30 ? 60 : 40;
        /** @type {Record<string, any>} */
        const out = {
          sortBy,
          filter: needle || undefined,
          totalProcesses: procs.rows.length,
          matched: matched.length,
          processes: sortRows(matched, sortBy).slice(0, limit).map((p) => procView(p, width, true))
        };
        if (platform === 'linux') notes.push('cpu% on Linux is averaged over each process lifetime.');
        if (notes.length) out.notes = notes;
        return out;
      }
    },

    network_overview: {
      kind: 'read',
      mutating: false,
      description: 'Network state of this computer: interfaces and addresses, default gateway, DNS servers, '
        + 'listening TCP ports with the owning process, and the open connection count. Reads local state only.',
      parameters: {},
      async execute(_args = {}, ctx = {}) {
        const signal = ctx?.signal;
        /** @type {string[]} */
        const notes = [];
        const { interfaces, linkLocalOnly } = describeInterfaces();
        /** @type {{gateway: any, dnsFound: string[], dnsVia?: string|null, raw: any[], established: number|null}} */
        const probe = isMac ? await probeNetworkMac(notes, signal)
          : isWin ? await probeNetworkWindows(notes, signal)
            : await probeNetworkLinux(notes, signal);
        const dnsServers = probe.dnsFound.length ? probe.dnsFound : safe(() => h.dnsServers(), []);
        const listening = mergeListeners(probe.raw);
        /** @type {Record<string, any>} */
        const out = { interfaces };
        if (linkLocalOnly.length) out.linkLocalOnly = linkLocalOnly;
        out.gateway = probe.gateway;
        out.dns = dnsServers;
        if (probe.dnsVia) out.dnsVia = probe.dnsVia;
        out.listening = listening.slice(0, MAX_LISTENERS);
        if (listening.length > MAX_LISTENERS) out.listeningNotShown = listening.length - MAX_LISTENERS;
        out.establishedConnections = probe.established;
        if (!isWin && safe(() => h.uid(), -1) !== 0 && listening.some((l) => !l.process)) {
          notes.push('Ports without a process belong to other users or root; naming them needs sudo.');
        }
        if (notes.length) out.notes = notes;
        return out;
      }
    },

    read_log: {
      kind: 'read',
      mutating: false,
      description: 'Read the end of a text log file, optionally only lines containing some text (any case). '
        + (isMac ? 'For the macOS unified log use run_command with `log show --last 10m`.'
          : platform === 'linux' ? 'For the systemd journal use run_command with `journalctl -n 200 --no-pager`.' : ''),
      parameters: {
        path: 'string (log file path; ~ is your home folder)',
        lines: `number (optional: lines from the end to read, default ${LOG_DEFAULT_LINES}, max ${LOG_MAX_LINES})`,
        filter: 'string (optional: keep only lines containing this text)'
      },
      async execute(args = {}) {
        const a = args || {};
        const input = expandHome(String(a.path ?? '').trim());
        if (!input) throw new Error('path is required');
        const base = workDir || safe(() => h.homedir(), os.homedir());
        // The operator jail (MIRABILIS_MCP_FS_ROOT) applies here as everywhere.
        const file = safeResolvePath(path.isAbsolute(input) ? input : path.resolve(base, input));
        const requested = clampInt(a.lines, 1, LOG_MAX_LINES, LOG_DEFAULT_LINES);
        let tail;
        try {
          tail = await tailTextFile(file, { lines: requested, filter: a.filter });
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (e?.code === 'ENOENT') throw new Error(`No such file: ${file}`);
          // EPERM on macOS is the privacy layer (TCC), which sudo does not lift.
          if (e?.code === 'EPERM' && isMac) {
            throw new Error(`macOS privacy protection blocked reading ${file}. The app running Mirabilis needs Full Disk Access (System Settings, Privacy and Security).`);
          }
          if (e?.code === 'EACCES' || e?.code === 'EPERM') {
            throw new Error(`Permission denied reading ${file}. The user can run: sudo tail -n ${requested} "${file}"`);
          }
          throw err;
        }
        const { text, ...meta } = tail;
        return {
          path: file,
          ...meta,
          scope: `last ${requested} lines${String(a.filter ?? '').trim() ? `, filtered by "${clip(String(a.filter).trim(), 60)}"` : ''}`,
          text
        };
      }
    }
  };

  return tools;
}
