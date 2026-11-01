// @ts-check
// Fetches the session token for privileged routes once and caches it, including
// the in-flight promise so parallel cold-start calls share one request.

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
