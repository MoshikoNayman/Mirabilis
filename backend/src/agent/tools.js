// @ts-check
// Agent tools and the gate every call passes: the Access level decides, approvals ask,
// writes keep a copy of the old bytes. Results are truncated to fit the context window.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isGoDark } from '../egress.js';
import { augmentPath, pathOf } from '../mcp/stdioClient.js';
import { expandHome } from '../paths.js';
import { runCommand } from '../services/proc.js';
import { ensureSecureDir, hardenFile } from '../storage/securePaths.js';
import { decide, lowerLevel, normalizeLevel } from './permissions.js';
import { getFsRoot, isSafeCommand, safeResolvePath } from './sandbox.js';

/** How much of any single tool result may enter the context. */
const MAX_RESULT_CHARS = 12_000;
const MAX_DIR_ENTRIES = 300;
const MAX_MATCHES = 100;
/** read_file reads at most this much of one file, so a huge file cannot exhaust memory. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** edit_file loads the whole file; past this, write_file is the tool. */
const MAX_EDIT_BYTES = 5 * 1024 * 1024;
/** A command's output is kept up to this many characters per stream, newest last. */
const MAX_CAPTURE_CHARS = 1_000_000;
const DIFF_MAX_LINES = 40;
const PREVIEW_LINES = 20;
/** Long argument strings are clipped in approval requests; detail carries the preview. */
const MAX_APPROVAL_ARG_CHARS = 2_000;
/** An approval preview is read by a person; a minified one-line file must not flood it. */
const MAX_DETAIL_CHARS = 4_000;
const KILL_GRACE_MS = 2_000;

/** Directories that are never worth searching. */
const SEARCH_EXCLUDE_DIRS = ['.git', 'node_modules', 'target', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache'];

/**
 * Backend process settings that are not the user's shell: an Electron flag that
 * turns any Electron app into plain Node, production mode that makes npm skip dev
 * dependencies, the backend's own port, and the session token.
 */
const BACKEND_ONLY_ENV = ['ELECTRON_RUN_AS_NODE', 'NODE_ENV', 'PORT', 'MIRABILIS_MCP_TOKEN'];

/** Where macOS and Linux keep sysctl, ifconfig, lsof and other admin tools. */
const SBIN_DIRS = ['/usr/sbin', '/sbin'];

/** @typedef {'read'|'write'|'command'|'connector'|'internal'} ToolKind */

/**
 * @typedef {object} ToolDef
 * @property {ToolKind} kind
 * @property {string} description
 * @property {Record<string, string>} parameters
 * @property {boolean} [mutating]
 * @property {boolean} [readOnly]
 * @property {'allow'|'ask'|'off'} [permission]
 * @property {string} [connectorId]
 * @property {string} [connectorName]
 * @property {string} [mcpTool]
 * @property {(args: any, ctx?: {signal?: AbortSignal}) => Promise<any>} execute
 */

/**
 * @typedef {object} RunRules
 * @property {boolean} allowWrites
 * @property {string[]} commandRules
 * @property {string[]} connectorTools
 * @property {Map<string, number>} [writeClaims]  file (claimKey) to the sub-agent changing it in the current fan-out
 */

/**
 * @typedef {object} Gate
 * @property {() => string[]} [allowCommands]  persisted "always allow" command rules
 * @property {() => boolean} [goDark]
 * @property {() => string} [storedLevel]      the saved level; lowering it applies to a run in progress
 * @property {RunRules} [runRules]              grants for this run, shared with its sub-agents
 * @property {any} [broker]                     from createApprovalBroker()
 * @property {(rule: string) => any} [persistAllowCommand]
 * @property {(toolName: string, permission: 'allow', tool: ToolDef) => any} [persistConnectorPermission]
 */

/** A fresh set of run-scoped grants. @returns {RunRules} */
export function createRunRules() {
  return { allowWrites: false, commandRules: [], connectorTools: [], writeClaims: new Map() };
}

/**
 * One write claim per file, however it is spelled: a symlinked folder resolves to where the
 * write lands, and case folds on macOS and Windows, whose disks ignore it by default.
 * @param {string} file  an absolute path
 * @param {string} platform
 */
function claimKey(file, platform) {
  let real = file;
  // A new file does not exist yet: resolve the nearest folder that does.
  for (let probe = file; ; probe = path.dirname(probe)) {
    try {
      real = realpathSync.native(probe) + file.slice(probe.length);
      break;
    } catch {
      if (path.dirname(probe) === probe) break;
    }
  }
  return platform === 'darwin' || platform === 'win32' ? real.toLowerCase() : real;
}

/** Keep the end of command output, where test runners print failures and summaries. */
function tail(text, limit = MAX_RESULT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return `[... ${s.length - limit} earlier characters omitted ...]\n${s.slice(-limit)}`;
}

function clip(text, limit = MAX_RESULT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= limit) return { text: s, truncated: false };
  return {
    text: s.slice(0, limit),
    truncated: true,
    note: `Output truncated at ${limit} characters (${s.length} total). Narrow the request if you need the rest.`
  };
}

/** Models sometimes pass JSON file content as an object. @param {unknown} value */
function asText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  return String(value);
}

/** Matches of `needle`, overlapping ones included, so an ambiguous edit is refused. */
function countOccurrences(haystack, needle) {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    count += 1;
    if (count > 999) break;
  }
  return count;
}

/** @param {number} n */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** @param {string} text */
function capDetail(text) {
  if (text.length <= MAX_DETAIL_CHARS) return text;
  return `${text.slice(0, MAX_DETAIL_CHARS)}\n... (${text.length - MAX_DETAIL_CHARS} more characters)`;
}

/** The first lines of a text, with a count of what was left out. @param {string} text */
function headLines(text, max = PREVIEW_LINES) {
  const lines = text.split('\n');
  if (lines.length <= max) return capDetail(text);
  return capDetail(`${lines.slice(0, max).join('\n')}\n... (${plural(lines.length - max, 'more line')})`);
}

/** Removed lines then added lines, capped. @param {string} oldStr @param {string} newStr */
function compactDiff(oldStr, newStr) {
  const lines = [
    ...oldStr.split('\n').map((l) => `- ${l}`),
    ...(newStr === '' ? [] : newStr.split('\n').map((l) => `+ ${l}`))
  ];
  if (lines.length <= DIFF_MAX_LINES) return capDetail(lines.join('\n'));
  return capDetail(`${lines.slice(0, DIFF_MAX_LINES).join('\n')}\n... (${plural(lines.length - DIFF_MAX_LINES, 'more line')})`);
}

/** Arguments for an approval request, long strings clipped. @param {Record<string, any>} args */
function clipArgs(args) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (typeof value === 'string' && value.length > MAX_APPROVAL_ARG_CHARS) {
      out[key] = `${value.slice(0, MAX_APPROVAL_ARG_CHARS)}... (${value.length} characters)`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * One file name for an absolute path, so every backup sits flat in before/.
 * @param {string} file
 */
export function backupName(file) {
  const flat = String(file)
    .replace(/^([A-Za-z]):/, '$1')
    .replace(/[\\/]+/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^_+/, '');
  if (flat.length <= 150) return flat || 'file';
  const hash = createHash('sha256').update(String(file)).digest('hex').slice(0, 10);
  return `${hash}_${flat.slice(-140)}`;
}

/** Folder that holds a run's pre-write copies. @param {string} dataDir @param {string} runId */
export function runBackupDir(dataDir, runId) {
  const safeId = String(runId).replace(/[^A-Za-z0-9_-]/g, '_') || 'run';
  return path.join(dataDir, 'agent-runs', safeId, 'before');
}

const RUN_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Remove pre-write copies older than `maxAgeDays`, like the audit logs beside them.
 * Only run-id folders are touched.
 * @param {string} auditDir  <dataDir>/agent-runs
 */
export async function pruneRunBackups(auditDir, { maxAgeDays = 30 } = {}) {
  let entries;
  try {
    entries = await readdir(auditDir, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_DIR_RE.test(entry.name)) continue;
    const dir = path.join(auditDir, entry.name);
    const info = await stat(dir).catch(() => null);
    if (!info || info.mtimeMs >= cutoff) continue;
    try { await rm(dir, { recursive: true, force: true }); removed += 1; } catch { /* in use or gone */ }
  }
  return { removed };
}

/** The user's environment for a command, minus the backend's own process settings. @param {string} platform */
function commandEnv(platform) {
  /** @type {Record<string, string|undefined>} */
  const env = { ...process.env };
  for (const key of BACKEND_ONLY_ENV) delete env[key];
  if (platform !== 'win32') {
    const dirs = augmentPath(pathOf(env), { platform }).split(':');
    for (const dir of SBIN_DIRS) if (!dirs.includes(dir)) dirs.push(dir);
    env.PATH = dirs.join(':');
  }
  return env;
}

/**
 * Run one shell command: /bin/sh -c on POSIX, cmd.exe /d /s /c on Windows. Output
 * is capped so a runaway command cannot exhaust memory. A timeout or abort stops the
 * whole process tree.
 * @param {string} command
 * @param {{cwd: string, timeoutMs: number, signal?: AbortSignal, platform: string}} opts
 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string, timedOut: boolean, droppedChars: number}>}
 */
export function runShell(command, { cwd, timeoutMs, signal, platform }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Run cancelled.')); return; }
    const win = platform === 'win32';
    const file = win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const args = win ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command];
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: commandEnv(platform),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group on POSIX, so a stop reaches forked children too.
        detached: !win,
        windowsHide: true,
        windowsVerbatimArguments: win
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let droppedChars = 0;
    let timedOut = false;
    let settled = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;

    /** @param {string} buf @param {string} chunk */
    const keep = (buf, chunk) => {
      const next = buf + chunk;
      if (next.length <= MAX_CAPTURE_CHARS) return next;
      droppedChars += next.length - MAX_CAPTURE_CHARS;
      return next.slice(-MAX_CAPTURE_CHARS);
    };

    const killTree = () => {
      const pid = child.pid;
      if (pid != null) {
        if (win) {
          try {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
          } catch { /* already gone */ }
        } else {
          try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
          setTimeout(() => {
            try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
          }, KILL_GRACE_MS).unref?.();
        }
      }
      // A grandchild that left the group can hold the pipes open; release them.
      try { child.stdout?.destroy(); } catch { /* closed */ }
      try { child.stderr?.destroy(); } catch { /* closed */ }
    };

    /** @param {() => void} fn */
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn();
    };

    function onAbort() {
      killTree();
      finish(() => reject(new Error('Run cancelled.')));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree();
        finish(() => resolve({ exitCode: null, stdout, stderr, timedOut, droppedChars }));
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk) => { stdout = keep(stdout, chunk.toString()); });
    child.stderr?.on('data', (chunk) => { stderr = keep(stderr, chunk.toString()); });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => resolve({ exitCode: code, stdout, stderr, timedOut, droppedChars })));
  });
}

/**
 * Build the tool set for one run.
 * @param {object} [opts]
 * @param {'chat'|'read'|'ask'|'bypass'|string} [opts.level]  Access level for this run.
 * @param {string} [opts.fsRoot]    Operator jail (MIRABILIS_MCP_FS_ROOT) only.
 * @param {string} [opts.workDir]   Project folder: default cwd and base for relative paths. Else home.
 * @param {string} [opts.dataDir]   Data folder; with runId, writes keep the old bytes there.
 * @param {string} [opts.runId]
 * @param {Record<string, any>} [opts.extraTools]  Self and connector tools.
 * @param {AbortSignal} [opts.signal] Cancels an in-flight tool call when the run stops.
 * @param {Gate} [opts.gate]
 * @param {number} [opts.commandTimeoutMs]
 * @param {string} [opts.platform]
 * @param {(kind: string, payload: object) => any} [opts.audit]  Audit log sink.
 */
export function createToolRegistry({
  level = 'read',
  fsRoot,
  workDir,
  dataDir,
  runId,
  extraTools = {},
  signal,
  gate = {},
  commandTimeoutMs = 120_000,
  platform = process.platform,
  audit
} = {}) {
  const runLevel = normalizeLevel(level);
  const jail = fsRoot ? path.resolve(fsRoot) : undefined;
  const base = workDir ? path.resolve(expandHome(workDir)) : (jail || getFsRoot() || os.homedir());
  const runRules = gate.runRules || createRunRules();
  const broker = gate.broker || null;
  const allowCommands = () => {
    try { return (gate.allowCommands ? gate.allowCommands() : []) || []; } catch { return []; }
  };
  const goDark = () => {
    try { return gate.goDark ? Boolean(gate.goDark()) : isGoDark(); } catch { return true; }
  };
  /** The run's level, lowered at once when the saved level is lowered. */
  const currentLevel = () => {
    if (!gate.storedLevel) return runLevel;
    try { return lowerLevel(runLevel, gate.storedLevel()); } catch { return runLevel; }
  };
  const note = (kind, payload) => {
    try { audit?.(kind, payload); } catch { /* the audit log is a record, never a reason to fail */ }
  };

  /** ~ expands; relative paths start at the project folder; the operator jail applies. */
  const rp = (p) => {
    const raw = expandHome(String(p ?? '').trim() || '.');
    const abs = path.isAbsolute(raw) ? raw : path.resolve(base, raw);
    return safeResolvePath(abs, jail);
  };

  /**
   * Copy a file's current bytes to the run's before/ folder. A write without a
   * copy is refused, so every change stays recoverable.
   * @param {string} tool @param {string} file
   * @returns {Promise<string|null>} the copy, or null when there was nothing to keep
   */
  async function keepOldCopy(tool, file) {
    if (!dataDir || !runId) return null;
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) return null;
    const dir = runBackupDir(dataDir, runId);
    try {
      await ensureSecureDir(path.join(dataDir, 'agent-runs'));
      await ensureSecureDir(path.dirname(dir));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const name = backupName(file);
      for (let n = 1; n < 1000; n += 1) {
        const target = path.join(dir, n === 1 ? name : `${name}.${n}`);
        try {
          await copyFile(file, target, fsConstants.COPYFILE_EXCL);
        } catch (err) {
          if (err?.code === 'EEXIST') continue;
          throw err;
        }
        await hardenFile(target);
        note('backup', { tool, path: file, backup: target, bytes: info.size });
        return target;
      }
      throw new Error('too many copies of this file in one run');
    } catch (err) {
      throw new Error(`Could not keep a copy of ${file} before changing it, so nothing was changed: ${err?.message || err}`);
    }
  }

  /** Validate an edit and compute the new text, without writing. @param {string} file */
  async function planEdit(file, oldText, newText) {
    if (typeof oldText !== 'string' || oldText === '') {
      throw new Error('old is required: the exact text to replace, copied from the file.');
    }
    if (newText === undefined || newText === null) {
      throw new Error('new is required: the replacement text ("" deletes old).');
    }
    const newStr = asText(newText);
    const info = await stat(file).catch(() => null);
    if (!info) throw new Error(`No such file: ${file}. Use write_file to create a file.`);
    if (!info.isFile()) throw new Error(`${file} is not a file`);
    if (info.size > MAX_EDIT_BYTES) {
      throw new Error(`${file} is ${info.size} bytes, too large to edit in place. Use write_file or run_command.`);
    }
    const current = await readFile(file, 'utf8');
    const count = countOccurrences(current, oldText);
    if (count === 0) {
      const crlf = current.includes('\r\n') && !oldText.includes('\r\n')
        ? ' The file uses Windows line endings (CRLF).' : '';
      throw new Error(`old matches 0 places in ${file}. Read the file again and copy the text exactly.${crlf}`);
    }
    if (count > 1) {
      throw new Error(`old matches ${count} places in ${file}. Include more surrounding text so it matches exactly one.`);
    }
    const at = current.indexOf(oldText);
    return {
      current,
      next: current.slice(0, at) + newStr + current.slice(at + oldText.length),
      line: current.slice(0, at).split('\n').length,
      oldStr: oldText,
      newStr
    };
  }

  /** Where a command starts; a missing folder is named, not reported as "spawn ENOENT". @param {any} cwd */
  async function commandCwd(cwd) {
    const dir = cwd ? rp(cwd) : base;
    const info = await stat(dir).catch(() => null);
    if (!info || !info.isDirectory()) throw new Error(`Folder not found: ${dir}`);
    return dir;
  }

  /** The command line refused at every level but Bypass. @param {string} cmd */
  const assertNotBlocked = (cmd) => {
    if (currentLevel() !== 'bypass' && !isSafeCommand(cmd)) {
      throw new Error('Command blocked: it matches a destructive pattern (recursive rm, mkfs, dd to a disk, shutdown). '
        + 'Bypass permissions does not apply this check.');
    }
  };

  /** @type {Record<string, ToolDef>} */
  const builtins = {
    list_dir: {
      kind: 'read',
      description: 'List the entries of a directory. Relative paths start at the project folder, or your home folder.',
      parameters: { path: 'string (directory to list; ~ is your home folder)' },
      async execute({ path: dirPath } = {}) {
        const resolved = rp(dirPath || '.');
        const entries = await readdir(resolved, { withFileTypes: true });
        const listed = entries.slice(0, MAX_DIR_ENTRIES).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'link' : 'other'
        }));
        return {
          path: resolved,
          entries: listed,
          truncated: entries.length > MAX_DIR_ENTRIES,
          totalEntries: entries.length
        };
      }
    },

    read_file: {
      kind: 'read',
      description: 'Read a UTF-8 text file. Optionally a line range.',
      parameters: { path: 'string', startLine: 'number (optional, 1-based)', endLine: 'number (optional)' },
      async execute({ path: filePath, startLine, endLine } = {}) {
        if (!String(filePath ?? '').trim()) throw new Error('path is required');
        const resolved = rp(filePath);
        const info = await stat(resolved);
        if (!info.isFile()) throw new Error(`${resolved} is not a file`);
        let raw;
        let partial = false;
        if (info.size > MAX_READ_BYTES) {
          const handle = await open(resolved, 'r');
          try {
            const buf = Buffer.alloc(MAX_READ_BYTES);
            const { bytesRead } = await handle.read(buf, 0, MAX_READ_BYTES, 0);
            raw = buf.subarray(0, bytesRead).toString('utf8');
            partial = true;
          } finally {
            await handle.close();
          }
        } else {
          raw = await readFile(resolved, 'utf8');
        }
        let body = raw;
        if (startLine != null || endLine != null) {
          const lines = raw.split('\n');
          const from = Math.max(1, Number(startLine) || 1);
          const to = Math.min(lines.length, Number(endLine) || lines.length);
          body = lines.slice(from - 1, to).join('\n');
        }
        /** @type {Record<string, any>} */
        const out = { path: resolved, bytes: info.size, ...clip(body) };
        if (partial) out.note = `Only the first ${MAX_READ_BYTES} bytes of this ${info.size}-byte file were read.`;
        return out;
      }
    },

    search_files: {
      kind: 'read',
      description: 'Search file contents for a pattern, like grep. Case-insensitive by default. Use this before reading whole files.',
      parameters: {
        pattern: 'string (regex or literal)',
        path: 'string (dir to search)',
        glob: 'string (optional, e.g. *.js)',
        caseSensitive: 'boolean (optional, default false)'
      },
      async execute({ pattern, path: searchPath, glob, caseSensitive } = {}) {
        if (!pattern) throw new Error('pattern is required');
        const root = rp(searchPath || '.');
        // Case-insensitive by default: models search "error" in logs that say "ERROR"
        // and treat no match as no errors.
        const args = ['-rn', '--binary-files=without-match'];
        for (const dir of SEARCH_EXCLUDE_DIRS) args.push(`--exclude-dir=${dir}`);
        if (glob) args.push(`--include=${String(glob)}`);
        if (!caseSensitive) args.push('-i');
        args.push('-e', String(pattern), root);
        try {
          const { stdout } = await runCommand('grep', args, { timeoutMs: 30_000, signal });
          const lines = stdout.split('\n').filter(Boolean);
          return {
            root,
            matchCount: lines.length,
            matches: lines.slice(0, MAX_MATCHES).map((l) => l.replace(root, '.')),
            truncated: lines.length > MAX_MATCHES
          };
        } catch (err) {
          // grep exits 1 when nothing matched; that is an answer, not a failure.
          if (err?.exitCode === 1 || /exited with code 1/.test(String(err?.message))) {
            return { root, matchCount: 0, matches: [], truncated: false };
          }
          throw err;
        }
      }
    },

    write_file: {
      kind: 'write',
      mutating: true,
      description: 'Create or overwrite a text file. The old contents are kept in the run log folder.',
      parameters: { path: 'string', content: 'string (the whole new file)' },
      async execute({ path: filePath, content } = {}) {
        if (!String(filePath ?? '').trim()) throw new Error('path is required');
        const resolved = rp(filePath);
        const text = asText(content);
        const previous = await stat(resolved).catch(() => null);
        if (previous?.isDirectory()) throw new Error(`${resolved} is a folder, not a file.`);
        const backup = await keepOldCopy('write_file', resolved);
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, text, 'utf8');
        return {
          path: resolved,
          bytesWritten: Buffer.byteLength(text, 'utf8'),
          replacedExisting: previous != null,
          previousBytes: previous ? previous.size : 0,
          ...(backup ? { backup } : {})
        };
      }
    },

    edit_file: {
      kind: 'write',
      mutating: true,
      description: 'Replace one exact piece of text in a file. old must match exactly one place; '
        + 'include enough surrounding lines to make it unique. Prefer this to rewriting a whole file.',
      parameters: {
        path: 'string',
        old: 'string (the exact text to replace, copied from the file)',
        new: 'string (the replacement; "" deletes old)'
      },
      async execute({ path: filePath, old: oldText, new: newText } = {}) {
        if (!String(filePath ?? '').trim()) throw new Error('path is required');
        const resolved = rp(filePath);
        const plan = await planEdit(resolved, oldText, newText);
        const backup = await keepOldCopy('edit_file', resolved);
        await writeFile(resolved, plan.next, 'utf8');
        return {
          path: resolved,
          line: plan.line,
          bytesBefore: Buffer.byteLength(plan.current, 'utf8'),
          bytesAfter: Buffer.byteLength(plan.next, 'utf8'),
          ...(backup ? { backup } : {})
        };
      }
    },

    run_command: {
      kind: 'command',
      mutating: true,
      description: platform === 'win32'
        ? 'Run a command with cmd.exe and capture its output.'
        : 'Run a shell command with /bin/sh and capture its output. Read-only commands such as ps, df, ls, '
          + 'lsof, git status and brew list run without approval.',
      parameters: { command: 'string', cwd: 'string (optional; default the project folder, or your home folder)' },
      async execute({ command, cwd } = {}) {
        const cmd = String(command ?? '').trim();
        if (!cmd) throw new Error('command is required');
        assertNotBlocked(cmd);
        const execCwd = await commandCwd(cwd);
        const res = await runShell(cmd, { cwd: execCwd, timeoutMs: commandTimeoutMs, signal, platform });
        /** @type {Record<string, any>} */
        const out = {
          command: cmd,
          cwd: execCwd,
          exitCode: res.exitCode,
          stdout: tail(res.stdout),
          stderr: tail(res.stderr, 4000)
        };
        // A non-zero exit is information the agent needs, not a crash.
        if (res.exitCode !== 0) out.failed = true;
        if (res.timedOut) out.note = `The command did not finish within ${Math.round(commandTimeoutMs / 1000)}s and was stopped.`;
        if (res.droppedChars > 0) out.outputDropped = `${res.droppedChars} characters of earlier output were not kept.`;
        return out;
      }
    }
  };

  /** @type {Record<string, ToolDef>} */
  const all = { ...builtins };
  for (const [name, tool] of Object.entries(extraTools || {})) {
    // Built-ins keep their names; connector keys always contain "__".
    if (Object.prototype.hasOwnProperty.call(builtins, name)) continue;
    if (tool && typeof tool.execute === 'function') all[name] = tool;
  }

  /** In the prompt: nothing in Chat only; Off connector tools never; in Read only, read-only connector tools. */
  const visible = (/** @type {ToolDef} */ tool) => {
    if (runLevel === 'chat') return false;
    if (tool.kind === 'connector') {
      if (tool.permission === 'off') return false;
      if (runLevel === 'read' && tool.readOnly !== true) return false;
    }
    return true;
  };
  const visibleNames = () => Object.keys(all).filter((name) => visible(all[name]));

  /**
   * What the user sees before approving: the resolved path, sizes, a preview or a
   * diff. Throws for a call that would fail anyway, so the user is not asked about it.
   * @param {string} name @param {Record<string, any>} args
   * @returns {Promise<{detail?: string, cwd?: string}>}
   */
  async function prepareApproval(name, args) {
    if (name === 'write_file') {
      if (!String(args.path ?? '').trim()) throw new Error('path is required');
      const file = rp(args.path);
      const text = asText(args.content);
      const bytes = Buffer.byteLength(text, 'utf8');
      const previous = await stat(file).catch(() => null);
      if (previous?.isDirectory()) throw new Error(`${file} is a folder, not a file.`);
      const what = previous
        ? `Overwrites the existing file (${previous.size} bytes) with ${bytes} bytes.`
        : `Creates a new file of ${bytes} bytes.`;
      return { detail: `${file}\n${what}\n\n${headLines(text)}` };
    }
    if (name === 'edit_file') {
      if (!String(args.path ?? '').trim()) throw new Error('path is required');
      const file = rp(args.path);
      const plan = await planEdit(file, args.old, args.new);
      return { detail: `${file} (line ${plan.line})\n\n${compactDiff(plan.oldStr, plan.newStr)}` };
    }
    if (name === 'run_command') {
      const cmd = String(args.command ?? '').trim();
      if (!cmd) throw new Error('command is required');
      assertNotBlocked(cmd);
      return { cwd: await commandCwd(args.cwd) };
    }
    return {};
  }

  /** Record an "Always allow" for this run, and save it where it lasts. */
  async function applyAlways(rule, name, tool) {
    if (!rule) return;
    if (rule.type === 'writes') {
      runRules.allowWrites = true;
    } else if (rule.type === 'command' && rule.rule) {
      if (!runRules.commandRules.includes(rule.rule)) runRules.commandRules.push(rule.rule);
      try {
        await gate.persistAllowCommand?.(rule.rule);
      } catch (err) {
        note('persist-failed', { rule: rule.rule, error: String(err?.message || err) });
      }
    } else if (rule.type === 'connector') {
      const key = rule.tool || name;
      if (!runRules.connectorTools.includes(key)) runRules.connectorTools.push(key);
      try {
        await gate.persistConnectorPermission?.(key, 'allow', tool);
      } catch (err) {
        note('persist-failed', { tool: key, error: String(err?.message || err) });
      }
    }
  }

  return {
    level: runLevel,
    runRules,
    names: () => visibleNames(),

    /** Register a run-scoped tool after construction (used for spawn_agents). Never in Chat only. */
    addTool(name, tool) {
      if (runLevel === 'chat') return false;
      if (!tool || typeof tool.execute !== 'function') return false;
      all[name] = tool;
      return true;
    },

    /** Is this tool offered to the model? */
    has: (name) => Object.prototype.hasOwnProperty.call(all, name) && visible(all[name]),

    /** Would this tool change something? */
    isMutating: (name) => Boolean(all[name]?.mutating),

    /**
     * Run one tool through the gate. Failures, refusals and denials come back as
     * results with the reason, so the loop can adapt instead of ending the run.
     * @param {string} name
     * @param {any} [args]
     * @param {{pause?: (p: Promise<any>) => Promise<any>, iteration?: number, subAgent?: number}} [ctx]
     */
    async dispatch(name, args = {}, ctx = {}) {
      // A stop pressed during a decide step must not let the next tool call start.
      if (signal?.aborted) return { ok: false, error: 'Run cancelled.' };
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      // Small models drop the connector prefix: list_processes for this_computer__list_processes.
      if (!Object.prototype.hasOwnProperty.call(all, name)) {
        const matches = visibleNames().filter((n) => n.endsWith(`__${name}`));
        if (matches.length === 1) name = matches[0];
      }
      const tool = Object.prototype.hasOwnProperty.call(all, name) ? all[name] : null;
      if (!tool) {
        const available = visibleNames();
        return {
          ok: false,
          error: available.length
            ? `Unknown tool "${name}". Available: ${available.join(', ')}.`
            : `Unknown tool "${name}". No tools are available: Access is Chat only.`
        };
      }

      // One file, one agent: a sub-agent may not change a file another sub-agent claimed
      // in this fan-out. Claimed before anyone is asked; the lead is never checked.
      let newClaim = '';
      if (tool.kind === 'write' && Number.isInteger(ctx.subAgent) && runRules.writeClaims) {
        let claimPath = '';
        try { claimPath = String(input.path ?? '').trim() ? rp(input.path) : ''; } catch { claimPath = ''; }
        const key = claimPath ? claimKey(claimPath, platform) : '';
        const owner = key ? runRules.writeClaims.get(key) : undefined;
        if (owner !== undefined && owner !== ctx.subAgent) {
          return { ok: false, error: `Agent ${owner + 1} is changing ${claimPath}. Leave this file to that agent.` };
        }
        if (key && owner === undefined) {
          runRules.writeClaims.set(key, /** @type {number} */ (ctx.subAgent));
          newClaim = key;
        }
      }
      /** A write that did not happen gives its file back. */
      const release = () => { if (newClaim) runRules.writeClaims?.delete(newClaim); };

      const verdict = decide({
        level: /** @type {any} */ (currentLevel()),
        tool: name,
        args: input,
        info: {
          kind: tool.kind,
          readOnly: tool.readOnly === true,
          permission: tool.permission,
          connectorName: tool.connectorName,
          mcpTool: tool.mcpTool
        },
        runRules,
        allowCommands: allowCommands(),
        goDark: goDark(),
        platform
      });
      if (verdict.action === 'deny') {
        release();
        return { ok: false, error: verdict.reason, denied: true };
      }

      if (verdict.action === 'ask') {
        let prepared;
        try {
          prepared = await prepareApproval(name, input);
        } catch (err) {
          release();
          return { ok: false, error: String(err?.message || err) };
        }
        if (!broker) {
          release();
          return { ok: false, error: 'This action needs your approval, and this run has no way to ask. Run it yourself, or use Bypass permissions.' };
        }
        const request = {
          ...verdict.request,
          ...(prepared.detail ? { detail: prepared.detail } : {}),
          ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
          tool: name,
          args: clipArgs(input),
          ...(ctx.iteration != null ? { iteration: ctx.iteration } : {}),
          ...(ctx.subAgent != null ? { subAgent: ctx.subAgent } : {})
        };
        const pending = broker.request(request);
        // Waiting on the user is not work: the budget clock stops meanwhile.
        const decision = await (typeof ctx.pause === 'function' ? ctx.pause(pending) : pending);
        if (decision === 'cancelled' || signal?.aborted) {
          release();
          return { ok: false, error: 'Run cancelled.' };
        }
        if (decision !== 'allow' && decision !== 'always') {
          const why = broker.noteFor ? broker.noteFor(pending.approvalId) : '';
          release();
          return { ok: false, error: `The user denied this action.${why ? ` Note: ${why}` : ''}`, denied: true };
        }
        if (decision === 'always') await applyAlways(verdict.request?.alwaysRule, name, tool);
      }

      try {
        const result = await tool.execute(input, { signal });
        return { ok: true, result };
      } catch (error) {
        release();
        return { ok: false, error: String(error?.message || error) };
      }
    },

    /** The tool list as the model sees it. */
    describeForPrompt() {
      return visibleNames().map((name) => {
        const t = all[name];
        const entries = Object.entries(t.parameters || {});
        const params = entries.length
          ? entries.map(([k, v]) => `      ${k}: ${v}`).join('\n')
          : '      (no arguments)';
        return `  - ${name}: ${t.description}\n${params}`;
      }).join('\n');
    }
  };
}
