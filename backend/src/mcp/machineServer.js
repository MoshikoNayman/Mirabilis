// @ts-check
// The This computer MCP server: newline-delimited JSON-RPC 2.0 over stdio for the tools in
// machineTools.js. The connector manager starts it; stdout carries only the protocol and
// every log line goes to stderr. It exits when stdin closes.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { APP_SEMVER } from '../version.js';
import { createMachineTools } from './machineTools.js';

export const SERVER_NAME = 'mirabilis-machine';
/** Newest first; a client asking for another version gets the newest. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** Under the client's 30s call timeout, so a slow tool still answers in time. */
const CALL_DEADLINE_MS = 25_000;
/** Tools spawn commands; a burst of calls queues instead of loading the machine. */
const MAX_CONCURRENT_CALLS = 3;
/** No request is this long; dropping it keeps a runaway client from growing the buffer. */
const MAX_LINE_CHARS = 1024 * 1024;

/**
 * @typedef {object} Machine
 * @property {Array<Record<string, any>>} tools
 * @property {(name: string) => boolean} has
 * @property {(name: string, args: any, ctx: {signal?: AbortSignal}) => Promise<{content: any[], isError?: boolean}>} call
 */

/**
 * @typedef {object} ServeOptions
 * @property {NodeJS.ReadableStream} [input]
 * @property {NodeJS.WritableStream} [output]
 * @property {(line: string) => void} [log]
 * @property {Machine} [machine]
 * @property {number} [callDeadlineMs]
 * @property {number} [maxConcurrent]
 */

/**
 * Serve MCP on a pair of streams until the input ends.
 * @param {ServeOptions} [opts]
 * @returns {{closed: Promise<void>}}
 */
export function serveMachineMcp({
  input = process.stdin,
  output = process.stdout,
  log = (line) => { process.stderr.write(`${line}\n`); },
  machine,
  callDeadlineMs = CALL_DEADLINE_MS,
  maxConcurrent = MAX_CONCURRENT_CALLS
} = {}) {
  const tools = machine || createMachineTools({ dataDir: process.env.MIRABILIS_DATA_DIR || '' });
  /** In-flight calls by JSON-encoded id, so 1 and "1" stay apart. @type {Map<string, {controller: AbortController, cancelled: boolean}>} */
  const inflight = new Map();
  /** @type {Array<() => void>} */
  const waiting = [];
  let active = 0;
  let closed = false;
  let buffer = '';
  /** @type {() => void} */
  let markClosed = () => {};
  /** @type {Promise<void>} */
  const closedPromise = new Promise((resolve) => { markClosed = resolve; });

  /** @param {any} message */
  function send(message) {
    if (closed) return;
    try {
      output.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      log(`could not write a reply: ${/** @type {any} */ (err)?.message || err}`);
    }
  }

  /** @param {any} id @param {any} result */
  const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
  /** @param {any} id @param {number} code @param {string} message */
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  /** @param {AbortSignal} signal @returns {Promise<boolean>} false when cancelled while queued */
  function acquire(signal) {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const start = () => {
        signal.removeEventListener('abort', onAbort);
        active += 1;
        resolve(true);
      };
      const onAbort = () => {
        const i = waiting.indexOf(start);
        if (i >= 0) waiting.splice(i, 1);
        resolve(false);
      };
      waiting.push(start);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  /** @param {any} id @param {any} params */
  async function callTool(id, params) {
    const name = params?.name;
    if (typeof name !== 'string' || !name) return fail(id, -32602, 'tools/call needs a tool name.');
    if (!tools.has(name)) return fail(id, -32602, `Unknown tool: ${name.slice(0, 120)}`);
    const key = JSON.stringify(id);
    const entry = { controller: new AbortController(), cancelled: false };
    inflight.set(key, entry);
    const started = Date.now();
    /** @type {{content: any[], isError?: boolean}|null} */
    let result = null;
    try {
      if (!(await acquire(entry.controller.signal))) return null;
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let timer;
      try {
        const limit = callDeadlineMs < 1000 ? `${callDeadlineMs}ms` : `${Math.round(callDeadlineMs / 1000)}s`;
        // Settles at the deadline, or at once when the call is cancelled or the client goes.
        /** @type {Promise<{content: any[], isError: boolean}>} */
        const deadline = new Promise((resolve) => {
          timer = setTimeout(() => {
            resolve({ content: [{ type: 'text', text: `${name} did not finish within ${limit}.` }], isError: true });
            entry.controller.abort();
          }, callDeadlineMs);
          const cancelled = () => resolve({ content: [{ type: 'text', text: `${name} was cancelled.` }], isError: true });
          if (entry.controller.signal.aborted) cancelled();
          else entry.controller.signal.addEventListener('abort', cancelled, { once: true });
        });
        result = await Promise.race([tools.call(name, params?.arguments ?? {}, { signal: entry.controller.signal }), deadline]);
      } finally {
        clearTimeout(timer);
        release();
      }
    } finally {
      inflight.delete(key);
    }
    // A cancelled request gets no answer.
    if (entry.cancelled) return null;
    log(`${name} ${result?.isError ? 'failed' : 'ok'} in ${Date.now() - started}ms`);
    return reply(id, result);
  }

  /** @param {any} msg */
  function notification(msg) {
    if (msg.method === 'notifications/cancelled') {
      const entry = inflight.get(JSON.stringify(msg.params?.requestId));
      if (entry) {
        entry.cancelled = true;
        entry.controller.abort();
      }
    }
    // notifications/initialized and the rest need nothing.
  }

  /** @param {any} msg @returns {Promise<any>} a response, or null for none */
  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail(null, -32600, 'Invalid request.');
    const hasId = msg.id !== undefined;
    if (typeof msg.method !== 'string') {
      // A response to a request this server never sends.
      if (('result' in msg || 'error' in msg) && hasId) return null;
      return fail(hasId ? msg.id : null, -32600, 'Invalid request.');
    }
    if (!hasId) {
      notification(msg);
      return null;
    }
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: APP_SEMVER }
        });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: tools.tools });
      case 'tools/call':
        return callTool(id, params);
      default:
        return fail(id, -32601, `Method not found: ${method.slice(0, 120)}`);
    }
  }

  /** @param {any} msg */
  async function handleSafely(msg) {
    try {
      return await handle(msg);
    } catch (err) {
      log(`request failed: ${/** @type {any} */ (err)?.stack || err}`);
      return fail(msg && typeof msg === 'object' && msg.id !== undefined ? msg.id : null, -32603, 'Internal error.');
    }
  }

  /** @param {string} line */
  async function dispatch(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send(fail(null, -32700, 'Parse error.'));
      return;
    }
    if (Array.isArray(msg)) {
      if (!msg.length) {
        send(fail(null, -32600, 'Invalid request: empty batch.'));
        return;
      }
      const answers = (await Promise.all(msg.map(handleSafely))).filter(Boolean);
      if (answers.length) send(answers);
      return;
    }
    const answer = await handleSafely(msg);
    if (answer) send(answer);
  }

  /** @param {string|Buffer} chunk */
  function onData(chunk) {
    buffer += String(chunk);
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.trim()) void dispatch(line);
    }
    if (buffer.length > MAX_LINE_CHARS) {
      log(`dropped ${buffer.length} characters with no line break`);
      buffer = '';
      send(fail(null, -32700, 'Parse error: the request is too long.'));
    }
  }

  function shutdown() {
    if (closed) return;
    closed = true;
    for (const entry of inflight.values()) {
      entry.cancelled = true;
      entry.controller.abort();
    }
    markClosed();
  }

  input.setEncoding('utf8');
  input.on('data', onData);
  input.on('end', shutdown);
  input.on('close', shutdown);
  input.on('error', shutdown);
  // EPIPE once the client is gone.
  output.on('error', shutdown);
  return { closed: closedPromise };
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  // A stray console.log would corrupt the protocol.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  const log = (/** @type {string} */ line) => { process.stderr.write(`${line}\n`); };
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${/** @type {any} */ (err)?.stack || err}`));
  const server = serveMachineMcp({ log, machine: createMachineTools({ dataDir: process.env.MIRABILIS_DATA_DIR || '' }) });
  log(`${SERVER_NAME} ${APP_SEMVER} ready on ${process.platform}`);
  void server.closed.then(() => {
    // Let cancelled commands wind down, but never outlive the client by more than a second.
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
