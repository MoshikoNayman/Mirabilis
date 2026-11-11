// @ts-check
// MCP over streamable HTTP: each JSON-RPC message is a POST answered with JSON or an
// SSE stream. The session id from initialize rides along on every later request.

import { formatMs, rpcError } from './stdioClient.js';

/** Plain words for the network errors people actually hit. */
const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'name lookup failed',
  ETIMEDOUT: 'connection timed out',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  CERT_HAS_EXPIRED: 'its certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'it uses a self-signed certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'its certificate is not trusted',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its certificate is not trusted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'its certificate does not match the host'
};

/**
 * True when Go Dark refused the request: the guarded global fetch throws EgressBlockedError.
 * @param {any} err
 */
export function isEgressBlocked(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
    if (e.name === 'EgressBlockedError' || e.code === 'GO_DARK') return true;
  }
  return false;
}

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).host || 'the server';
  } catch {
    return 'the server';
  }
}

/**
 * @param {any} err
 * @param {boolean} timedOut
 * @param {string} host
 * @param {number} timeoutMs
 */
function fetchFailure(err, timedOut, host, timeoutMs) {
  if (isEgressBlocked(err)) return err;
  if (timedOut) return new Error(`${host} did not answer within ${formatMs(timeoutMs)}.`);
  if (err?.name === 'AbortError') return new Error('Cancelled.');
  const code = err?.cause?.code || err?.code || '';
  const reason = NETWORK_REASONS[code] || err?.cause?.message || err?.message || 'unknown error';
  return new Error(`Could not reach ${host}: ${reason}.`, { cause: err });
}

/**
 * @param {number} status
 * @param {string} body
 * @param {boolean} hadSession
 * @param {string} host
 */
function httpFailure(status, body, hadSession, host) {
  // 404 on a request that carried a session id means the server dropped the session.
  if (status === 404 && hadSession) return Object.assign(new Error(`${host} ended the session.`), { sessionExpired: true, status });
  const snippet = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  let message;
  if (status === 401 || status === 403) message = `${host} refused the credentials (HTTP ${status}). Check the token.`;
  else if (status === 404) message = 'No MCP endpoint at this URL (HTTP 404).';
  else if (status === 405) message = `${host} does not accept MCP requests at this URL (HTTP 405).`;
  else message = `${host} answered HTTP ${status}${snippet ? `: ${snippet}` : ''}.`;
  return Object.assign(new Error(message), { status });
}

/**
 * @typedef {object} HttpClientOptions
 * @property {string} url
 * @property {Record<string, string>} [headers]
 * @property {typeof fetch} [fetch]  defaults to the global (Go Dark guarded) fetch
 * @property {(message: any) => void} [onNotification]
 */

/**
 * @param {HttpClientOptions} opts
 */
export function createHttpClient(opts) {
  const url = opts.url;
  const host = hostOf(url);
  let sessionId = '';
  let protocolVersion = '';
  /** @type {any} */
  let initParams;
  let nextId = 1;
  let closed = false;
  /** @type {typeof fetch} */
  const doFetch = (input, init) => (opts.fetch || globalThis.fetch)(input, init);

  /** @param {string} session */
  function headersFor(session) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(opts.headers || {})) {
      try { headers.set(name, value); } catch { /* validated on save */ }
    }
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json, text/event-stream');
    if (session) headers.set('mcp-session-id', session);
    if (protocolVersion) headers.set('mcp-protocol-version', protocolVersion);
    return headers;
  }

  /** @param {any} message */
  function emitNotification(message) {
    try { opts.onNotification?.(message); } catch { /* a hook must not break the client */ }
  }

  /**
   * The answer to `id` among parsed messages, or null. Notifications go to the hook.
   * @param {any} parsed
   * @param {number} id
   */
  function findAnswer(parsed, id) {
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!m || typeof m !== 'object') continue;
      if (m.id === id && ('result' in m || 'error' in m)) return m;
      if (typeof m.method === 'string' && (m.id === undefined || m.id === null)) emitNotification(m);
    }
    return null;
  }

  /** @param {any} answer */
  function unwrap(answer) {
    if (answer.error) throw rpcError(answer.error);
    return answer.result ?? {};
  }

  /**
   * Read an SSE stream until the answer to `id` arrives.
   * @param {Response} response
   * @param {number} id
   */
  async function readEventStream(response, id) {
    if (!response.body) throw new Error(`${host} sent an empty stream.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        if (done) buffer += `${decoder.decode()}\n\n`;
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = block.split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (!data.trim()) continue;
          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }
          const answer = findAnswer(parsed, id);
          if (answer) return unwrap(answer);
        }
        if (done) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    throw new Error(`${host} closed the stream without an answer.`);
  }

  /**
   * POST one message. Returns the result for a request, null for a notification.
   * @param {{jsonrpc: string, id?: number, method: string, params?: any}} message
   * @param {number} timeoutMs
   * @param {AbortSignal} [signal]
   */
  async function post(message, timeoutMs, signal) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const hadSession = Boolean(sessionId);
    try {
      let response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: headersFor(sessionId),
          body: JSON.stringify(message),
          signal: controller.signal,
          redirect: 'follow'
        });
      } catch (err) {
        throw fetchFailure(err, timedOut, host, timeoutMs);
      }
      const session = response.headers.get('mcp-session-id');
      if (session) sessionId = session;
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw httpFailure(response.status, body, hadSession, host);
      }
      if (message.id === undefined || response.status === 202 || response.status === 204) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      const type = (response.headers.get('content-type') || '').toLowerCase();
      try {
        if (type.includes('text/event-stream')) return await readEventStream(response, message.id);
        const text = await response.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error(`${host} did not answer with MCP JSON: ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
        }
        const answer = findAnswer(parsed, message.id);
        if (!answer) throw new Error(`${host} sent no answer to ${message.method}.`);
        return unwrap(answer);
      } catch (err) {
        if (controller.signal.aborted) throw fetchFailure(err, timedOut, host, timeoutMs);
        throw err;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Start a fresh session with the last initialize params. */
  async function reconnect(timeoutMs, signal) {
    sessionId = '';
    protocolVersion = '';
    const result = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: initParams }, timeoutMs, signal);
    protocolVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : '';
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs, signal).catch(() => {});
  }

  /**
   * @param {string} method
   * @param {any} [params]
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<any>}
   */
  async function request(method, params, { timeoutMs = 30_000, signal } = {}) {
    if (closed) throw new Error('The connector is not connected.');
    if (method === 'initialize') {
      initParams = params;
      sessionId = '';
      protocolVersion = '';
    }
    const message = { jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) };
    try {
      const result = await post(message, timeoutMs, signal);
      if (method === 'initialize') protocolVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : '';
      return result ?? {};
    } catch (err) {
      if (!err?.sessionExpired || method === 'initialize' || initParams === undefined) throw err;
      await reconnect(timeoutMs, signal);
      return (await post({ ...message, id: nextId++ }, timeoutMs, signal)) ?? {};
    }
  }

  /**
   * @param {string} method
   * @param {any} [params]
   */
  async function notify(method, params) {
    if (closed) throw new Error('The connector is not connected.');
    await post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }, 10_000);
  }

  /** End the session. Best effort: the server expires idle sessions anyway. */
  async function stop() {
    if (closed) return;
    closed = true;
    const session = sessionId;
    sessionId = '';
    if (!session) return;
    try {
      const response = await doFetch(url, { method: 'DELETE', headers: headersFor(session), signal: AbortSignal.timeout(3000) });
      await response.body?.cancel().catch(() => {});
    } catch { /* not supported, unreachable, or blocked by Go Dark */ }
  }

  return {
    start: async () => {},
    request,
    notify,
    stop,
    get pid() { return null; },
    get sessionId() { return sessionId; },
    stderrTail: () => /** @type {string[]} */ ([])
  };
}
