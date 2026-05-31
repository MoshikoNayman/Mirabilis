// frontend/src/lib/api.js
// Centralized API base + fetch helpers. Replaces the inline fetch + ad-hoc
// readJsonOrThrow logic scattered through the component tree.

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

export async function readJsonOrThrow(res, fallbackMessage) {
  const bodyText = await res.text();
  let payload = {};
  if (bodyText) {
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new Error(
        fallbackMessage || `Mirabilis returned a non-JSON response (${res.status}).`
      );
    }
  }
  if (!res.ok) {
    throw new Error(
      payload?.error || payload?.message || fallbackMessage || `Request failed (${res.status}).`
    );
  }
  return payload;
}

// Generic JSON fetch with timeout + abort support.
export async function apiFetch(path, { method = 'GET', body, signal, timeoutMs = 15000, headers } = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {})
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    return await readJsonOrThrow(res);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const getJSON = (path, opts) => apiFetch(path, { ...opts, method: 'GET' });
export const postJSON = (path, body, opts) => apiFetch(path, { ...opts, method: 'POST', body });
