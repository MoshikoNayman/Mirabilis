// @ts-check
// MCP over stdio: newline-delimited JSON-RPC 2.0 with a local program. Each program
// leads its own process group, so stopping it also stops whatever it started.

import { spawn } from 'node:child_process';
import { accessSync, statSync, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Folders a Dock-launched app leaves off PATH. Tool folders go ahead of the system ones. */
const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin', '~/.cargo/bin'];
const SYSTEM_DIRS = ['/usr/bin', '/bin'];
const SYSTEM_DIR_SET = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);

/** What a local server may need from the backend's environment. Keys and tokens stay behind. */
const PASS_ENV_POSIX = [
  'HOME', 'LOGNAME', 'USER', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'
];
const PASS_ENV_WIN32 = [
  'APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP',
  'USERNAME', 'USERPROFILE', 'COMSPEC', 'WINDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'
];

const TAIL_LINES = 40;
const MAX_STDERR_LINE = 2000;
/** A server that writes megabytes without a newline is broken; drop it rather than grow forever. */
const MAX_PENDING_OUTPUT = 8 * 1024 * 1024;

/**
 * Expand a leading ~ to the home folder. No trimming: arguments keep their exact text.
 * @param {string} value
 * @param {string} [home]
 */
export function expandTilde(value, home = os.homedir()) {
  const s = String(value ?? '');
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return s;
}

/**
 * PATH plus the usual tool folders, so npx, uvx and Homebrew python3 resolve even
 * when the app starts with the minimal PATH a GUI launch gets.
 * @param {string|undefined} current
 * @param {{home?: string, platform?: string}} [opts]
 */
export function augmentPath(current, { home = os.homedir(), platform = process.platform } = {}) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const entries = String(current || '').split(delimiter).filter(Boolean);
  if (platform === 'win32') return entries.join(delimiter);
  const missing = TOOL_DIRS.map((dir) => expandTilde(dir, home)).filter((dir) => !entries.includes(dir));
  const firstSystem = entries.findIndex((dir) => SYSTEM_DIR_SET.has(dir));
  const merged = firstSystem < 0
    ? [...entries, ...missing]
    : [...entries.slice(0, firstSystem), ...missing, ...entries.slice(firstSystem)];
  for (const dir of SYSTEM_DIRS) if (!merged.includes(dir)) merged.push(dir);
  return merged.join(delimiter);
}

/**
 * The PATH value of an environment object. Windows spells the key Path.
 * @param {Record<string, string|undefined>|undefined} env
 */
export function pathOf(env) {
  if (!env) return '';
  if (typeof env.PATH === 'string') return env.PATH;
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? String(env[key] ?? '') : '';
}

/**
 * Environment for a local server: an allow list from the backend's environment,
 * then the connector's own variables, with PATH augmented.
 * @param {Record<string, string|undefined>} baseEnv
 * @param {Record<string, string>} [extra]
 * @param {{home?: string, platform?: string}} [opts]
 * @returns {Record<string, string>}
 */
export function buildChildEnv(baseEnv, extra = {}, { home = os.homedir(), platform = process.platform } = {}) {
  const win = platform === 'win32';
  const norm = (/** @type {string} */ k) => (win ? k.toUpperCase() : k);
  /** @type {Map<string, string>} */
  const keys = new Map();
  for (const key of Object.keys(baseEnv || {})) keys.set(norm(key), key);
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of win ? PASS_ENV_WIN32 : PASS_ENV_POSIX) {
    const key = keys.get(norm(name));
    const value = key == null ? undefined : baseEnv[key];
    if (value != null && value !== '') out[name] = String(value);
  }
  if (!win && !out.HOME) out.HOME = home;
  let pathValue = pathOf(baseEnv);
  for (const [key, value] of Object.entries(extra || {})) {
    if (key.toUpperCase() === 'PATH') pathValue = String(value);
    else out[key] = String(value);
  }
  out.PATH = augmentPath(pathValue, { home, platform });
  return out;
}

/**
 * Full path of an executable found on PATH (or the given path itself), else null.
 * @param {string} name
 * @param {string} pathValue
 * @param {string} [platform]
 */
export function findExecutable(name, pathValue, platform = process.platform) {
  const command = String(name || '').trim();
  if (!command) return null;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const exts = win && !/\.[a-z0-9]+$/i.test(command) ? ['.exe', '.cmd', '.bat', '.com', ''] : [''];
  const hasDir = command.includes('/') || (win && command.includes('\\'));
  const bases = hasDir
    ? [command]
    : String(pathValue || '').split(win ? ';' : ':').filter(Boolean).map((dir) => p.join(dir, command));
  for (const base of bases) {
    for (const ext of exts) {
      const full = base + ext;
      try {
        if (!statSync(full).isFile()) continue;
        if (!win) accessSync(full, fsConstants.X_OK);
        return full;
      } catch { /* not here */ }
    }
  }
  return null;
}

/** Quote one word for a cmd.exe /s /c line. */
function quoteForCmd(arg) {
  const s = String(arg);
  if (s && !/[\s"&|<>^%!()]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * A JSON-RPC error answer. rpcCode tells it apart from a transport failure.
 * @param {any} error
 */
export function rpcError(error) {
  const message = typeof error?.message === 'string' && error.message ? error.message : 'The server reported an error.';
  return Object.assign(new Error(message), {
    rpcCode: typeof error?.code === 'number' ? error.code : -32603,
    rpcData: error?.data
  });
}

/** @param {any} err @param {string} command */
function spawnError(err, command) {
  const code = err?.code;
  if (code === 'ENOENT') return Object.assign(new Error(`Command not found: ${command}. Install it, or enter its full path.`), { code });
  if (code === 'EACCES') return Object.assign(new Error(`Permission denied running ${command}. Check that it is executable.`), { code });
  return Object.assign(new Error(`Could not start ${command}: ${err?.message || err}`), { code });
}

/** @param {number} ms */
export function formatMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

/** @param {number} pid */
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** @param {() => boolean} check @param {number} ms */
async function waitUntil(check, ms) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/**
 * @typedef {object} StdioClientOptions
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string, string>} env  complete environment for the program (see buildChildEnv)
 * @property {string} [cwd]
 * @property {string} [platform]
 * @property {(line: string) => void} [onStderr]
 * @property {(message: any) => void} [onNotification]
 * @property {(info: {code: number|null, signal: string|null, expected: boolean}) => void} [onExit]
 */

/**
 * @param {StdioClientOptions} opts
 */
export function createStdioClient(opts) {
  const platform = opts.platform || process.platform;
  const win = platform === 'win32';
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let nextId = 1;
  /** @type {Map<number, {method: string, settle: (err: Error|null, value?: any) => void}>} */
  const pending = new Map();
  let stdoutBuf = '';
  let stderrBuf = '';
  /** @type {string[]} */
  const tail = [];
  let exited = false;
  let finished = false;
  let stopping = false;
  /** @type {{code: number|null, signal: string|null}} */
  let exitInfo = { code: null, signal: null };
  /** @type {() => void} */
  let markFinished = () => {};
  /** @type {Promise<void>} */
  const finishedPromise = new Promise((resolve) => { markFinished = resolve; });

  /** @param {string} line */
  function emitStderr(line) {
    const text = line.length > MAX_STDERR_LINE ? `${line.slice(0, MAX_STDERR_LINE)}...` : line;
    tail.push(text);
    if (tail.length > TAIL_LINES) tail.shift();
    try { opts.onStderr?.(text); } catch { /* a logging hook must not break the client */ }
  }

  /** @param {object} message */
  function send(message) {
    const stdin = child?.stdin;
    if (finished || !stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** @param {any} message */
  function handleMessage(message) {
    if (Array.isArray(message)) {
      for (const m of message) handleMessage(m);
      return;
    }
    if (!message || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === 'string') {
      if (!hasId) {
        try { opts.onNotification?.(message); } catch { /* a hook must not break the client */ }
        return;
      }
      // Requests from the server: answer ping, decline the rest (no client capabilities offered).
      if (message.method === 'ping') send({ jsonrpc: '2.0', id: message.id, result: {} });
      else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not supported: ${message.method}` } });
      return;
    }
    if (!hasId) return;
    const entry = pending.get(typeof message.id === 'number' ? message.id : Number(message.id));
    if (!entry) return;
    if (message.error) entry.settle(rpcError(message.error));
    else entry.settle(null, message.result ?? {});
  }

  /** @param {string} chunk */
  function onStdout(chunk) {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        emitStderr(`[stdout] ${line}`);
        continue;
      }
      handleMessage(message);
    }
    if (stdoutBuf.length > MAX_PENDING_OUTPUT) {
      emitStderr(`[mirabilis] Dropped ${stdoutBuf.length} characters of output with no line break.`);
      stdoutBuf = '';
    }
  }

  /** @param {string} chunk */
  function onStderrChunk(chunk) {
    stderrBuf += chunk;
    let nl;
    while ((nl = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.slice(0, nl).replace(/\r$/, '');
      stderrBuf = stderrBuf.slice(nl + 1);
      if (line.trim()) emitStderr(line);
    }
    if (stderrBuf.length > MAX_STDERR_LINE * 4) {
      emitStderr(stderrBuf);
      stderrBuf = '';
    }
  }

  function exitText() {
    if (exitInfo.signal) return `was stopped by ${exitInfo.signal}`;
    return exitInfo.code == null ? 'stopped' : `exited with code ${exitInfo.code}`;
  }

  /** Settle everything once the program is gone. Safe to call more than once. */
  function finalize() {
    if (finished) return;
    if (stdoutBuf) onStdout('\n');
    if (stderrBuf.trim()) emitStderr(stderrBuf.trim());
    stderrBuf = '';
    finished = true;
    const reason = stopping ? 'The connector was stopped.' : `The connector ${exitText()}.`;
    for (const entry of [...pending.values()]) entry.settle(new Error(reason));
    pending.clear();
    try { child?.stdout?.destroy(); } catch { /* already closed */ }
    try { child?.stderr?.destroy(); } catch { /* already closed */ }
    try { child?.stdin?.destroy(); } catch { /* already closed */ }
    try { child?.unref(); } catch { /* nothing to release */ }
    markFinished();
    try { opts.onExit?.({ ...exitInfo, expected: stopping }); } catch { /* a hook must not break the client */ }
  }

  /** @param {number|null} code @param {NodeJS.Signals|null} signal */
  function onProcessExit(code, signal) {
    if (exited) return;
    exited = true;
    exitInfo = { code, signal };
    // A crashed leader can leave children behind; stop() handles the planned case.
    const pid = child?.pid;
    if (!stopping && !win && pid != null && groupAlive(pid)) {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
      const reaper = setTimeout(() => {
        if (groupAlive(pid)) {
          try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }, 2000);
      reaper.unref?.();
    }
    // A grandchild can hold the pipes open, so do not wait for 'close' forever.
    const timer = setTimeout(finalize, 200);
    timer.unref?.();
    child?.once('close', () => { clearTimeout(timer); finalize(); });
  }

  /** @param {NodeJS.Signals} sig */
  function signalProgram(sig) {
    const pid = child?.pid;
    if (pid == null) return;
    if (win) {
      // No process groups here: kill the tree while the leader still exists to walk it.
      if (exited) return;
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          .on('error', () => { try { child?.kill(); } catch { /* already gone */ } });
      } catch {
        try { child?.kill(); } catch { /* already gone */ }
      }
      return;
    }
    try { process.kill(-pid, sig); } catch { /* group already gone */ }
    if (!exited) {
      try { process.kill(pid, sig); } catch { /* already gone */ }
    }
  }

  /** Spawn the program. Resolves once it is running; the MCP handshake is the caller's. */
  function start() {
    if (child) return Promise.reject(new Error('This connector is already running.'));
    const command = expandTilde(String(opts.command || '').trim());
    const args = (opts.args || []).map((a) => expandTilde(String(a)));
    const cwd = opts.cwd ? expandTilde(opts.cwd) : os.homedir();
    let file = command;
    let argv = args;
    let verbatim = false;
    if (win) {
      // Batch shims (npx.cmd) only run through cmd.exe.
      const resolved = findExecutable(command, pathOf(opts.env), 'win32') || command;
      if (/\.(cmd|bat)$/i.test(resolved)) {
        file = opts.env.COMSPEC || process.env.ComSpec || 'cmd.exe';
        argv = ['/d', '/s', '/c', `"${[resolved, ...args].map(quoteForCmd).join(' ')}"`];
        verbatim = true;
      } else {
        file = resolved;
      }
    }
    return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      let settled = false;
      /** @type {import('node:child_process').ChildProcess} */
      let proc;
      try {
        proc = spawn(file, argv, {
          cwd,
          env: opts.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: !win,
          windowsHide: true,
          windowsVerbatimArguments: verbatim
        });
      } catch (err) {
        reject(spawnError(err, command));
        return;
      }
      child = proc;
      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');
      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderrChunk);
      proc.stdin?.on('error', () => { /* EPIPE once the program is gone */ });
      proc.stdout?.on('error', () => {});
      proc.stderr?.on('error', () => {});
      proc.once('spawn', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      proc.on('error', (err) => {
        if (!settled) {
          settled = true;
          exited = true;
          finalize();
          reject(spawnError(err, command));
          return;
        }
        emitStderr(`[mirabilis] ${err.message}`);
      });
      proc.once('exit', onProcessExit);
    }));
  }

  /**
   * Send a request and wait for its answer.
   * @param {string} method
   * @param {any} [params]
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<any>}
   */
  function request(method, params, { timeoutMs = 30_000, signal } = {}) {
    if (!child) return Promise.reject(new Error('The connector is not running.'));
    if (exited || finished) {
      return Promise.reject(new Error(stopping ? 'The connector was stopped.' : `The connector ${exitText()}.`));
    }
    if (signal?.aborted) return Promise.reject(new Error('Cancelled.'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const cancelRemote = (/** @type {string} */ reason) => {
        if (method !== 'initialize') send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } });
      };
      const onAbort = () => {
        settle(new Error('Cancelled.'));
        cancelRemote('Cancelled by the user.');
      };
      /** @param {Error|null} err @param {any} [value] */
      const settle = (err, value) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(value);
      };
      pending.set(id, { method, settle });
      timer = setTimeout(() => {
        settle(new Error(`${method} timed out after ${formatMs(timeoutMs)}.`));
        cancelRemote('Timed out.');
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (!send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })) {
        settle(new Error('Could not write to the connector.'));
      }
    });
  }

  /**
   * @param {string} method
   * @param {any} [params]
   */
  async function notify(method, params) {
    if (!send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })) {
      throw new Error('Could not write to the connector.');
    }
  }

  /**
   * Close stdin, then SIGTERM the group, then SIGKILL after the grace period.
   * Resolves once the program and its group are gone.
   * @param {{graceMs?: number}} [options]
   */
  async function stop({ graceMs = 2000 } = {}) {
    if (!child) return;
    stopping = true;
    if (finished && (win || child.pid == null || !groupAlive(child.pid))) return;
    const pid = child.pid;
    const alive = () => !exited || (!win && pid != null && groupAlive(pid));
    try { child.stdin?.end(); } catch { /* already closed */ }
    if (!(await waitUntil(() => !alive(), 300))) {
      signalProgram('SIGTERM');
      if (!(await waitUntil(() => !alive(), graceMs))) {
        signalProgram('SIGKILL');
        await waitUntil(() => !alive(), 2000);
      }
    }
    if (exited) {
      await Promise.race([finishedPromise, new Promise((resolve) => setTimeout(resolve, 500))]);
    }
    finalize();
  }

  /** The synchronous first step of stop(), for exit handlers that cannot wait. */
  function terminate() {
    if (!child || finished) return;
    stopping = true;
    try { child.stdin?.end(); } catch { /* already closed */ }
    signalProgram('SIGTERM');
  }

  return {
    start,
    request,
    notify,
    stop,
    terminate,
    get pid() { return child?.pid ?? null; },
    get running() { return Boolean(child) && !exited; },
    /** The last stderr lines, for error messages. */
    stderrTail: (n = 5) => tail.slice(-n)
  };
}
