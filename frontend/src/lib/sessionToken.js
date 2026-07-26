// @ts-check
// frontend/src/lib/sessionToken.js
// Holds the local session token that privileged backend routes require (remote
// SSH control, workspace file access, config vault indexing).
//
// The backend mints the token at startup and serves it from
// GET /api/session/token, which answers only loopback callers on an allowed
// origin. We fetch it once, lazily, and cache it for the page lifetime. The
// in-flight promise is cached too, so a burst of parallel privileged calls on a
// cold start triggers exactly one bootstrap request.

import { API_BASE } from './api.js';

/** @type {string} */
let _token = '';
/** @type {Promise<string> | null} */
let _inFlight = null;

/**
 * Resolve the session token, fetching it on first use.
 * Returns '' when the bootstrap fails, so callers still send their request and
 * surface the backend's own 401 rather than failing with a confusing client error.
 * @returns {Promise<string>}
 */
export async function getSessionToken() {
  if (_token) return _token;
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/session/token`);
      if (!res.ok) return '';
      const payload = await res.json();
      _token = typeof payload?.token === 'string' ? payload.token : '';
      return _token;
    } catch {
      return '';
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

/** Token if already resolved, else '' (no fetch). For synchronous call sites. */
export function peekSessionToken() {
  return _token;
}
