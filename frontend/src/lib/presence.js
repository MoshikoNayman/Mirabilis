// frontend/src/lib/presence.js
// Provider catalog + presence mapping. Turns provider health/local-status into
// the ICQ-style presence states the Buddy List and StatusOrb render.

import { API_BASE } from './api';

// Mirrors ChatApp's provider metadata (kept here so the shell is self-contained).
export const PROVIDERS = [
  { id: 'ollama', label: 'Ollama', scope: 'local', needsKey: false, requiresBinary: false, baseUrl: 'http://127.0.0.1:11434' },
  { id: 'openai-compatible', label: 'Local / Custom', scope: 'local', needsKey: false, requiresBinary: true, baseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'koboldcpp', label: 'KoboldCpp', scope: 'local', needsKey: false, requiresBinary: true, baseUrl: 'http://127.0.0.1:5001/v1' },
  { id: 'openai', label: 'OpenAI', scope: 'remote', needsKey: true, baseUrl: 'https://api.openai.com/v1' },
  { id: 'claude', label: 'Claude', scope: 'remote', needsKey: true, baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', label: 'Gemini', scope: 'remote', needsKey: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'groq', label: 'Groq', scope: 'remote', needsKey: true, baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'grok', label: 'Grok', scope: 'remote', needsKey: true, baseUrl: 'https://api.x.ai/v1' },
  { id: 'openrouter', label: 'OpenRouter', scope: 'remote', needsKey: true, baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'gpuaas', label: 'GPUaaS', scope: 'remote', needsKey: true, baseUrl: '' }
];

export const PRESENCE_LABELS = {
  online: 'Online',
  away: 'Needs setup',
  needkey: 'Needs API key',
  busy: 'Streaming',
  offline: 'Offline',
  unknown: 'Checking…'
};

// Aggregate a presence map into a single orb state for the title bar.
export function aggregatePresence(map, streaming = false) {
  if (streaming) return 'busy';
  const states = Object.values(map || {});
  if (states.some((s) => s === 'online')) return 'online';
  if (states.some((s) => s === 'away' || s === 'needkey')) return 'away';
  if (states.length && states.every((s) => s === 'offline')) return 'offline';
  return 'unknown';
}

// True when a hint/error string indicates a missing/invalid credential rather
// than an unreachable service. The backend returns HTTP 400 with
// { ok:false, hint:"OpenAI API key is required." } for keyless remotes.
function looksLikeMissingKey(text) {
  return /api[\s_-]*key|missing[\s_-]*key|unauthor|invalid[\s_-]*key|credential|token[\s_-]*required/i.test(
    String(text || '')
  );
}

// Probe a single provider's health. Returns one of the presence states.
// Uses provider metadata so the result is semantically correct: a remote
// provider with no key is "needkey" (blue), a local provider whose binary
// isn't running is "offline" (gray), and a reachable engine is "online".
export async function probeProvider(id, { signal } = {}) {
  const meta = PROVIDERS.find((p) => p.id === id) || {};
  try {
    const res = await fetch(
      `${API_BASE}/api/providers/health?provider=${encodeURIComponent(id)}`,
      { signal }
    );
    const data = await res.json().catch(() => ({}));
    const hint = data?.hint || data?.error || data?.reason || data?.message || '';

    // Healthy in any of the shapes the backend uses.
    if (
      data?.reachable === true ||
      data?.healthy === true ||
      data?.status === 'ok' ||
      (typeof data?.status === 'string' && /online|ready|healthy/i.test(data.status)) ||
      (data?.ok === true && data?.reachable !== false)
    ) {
      return 'online';
    }

    // Explicit auth-missing signals.
    if (data?.needsKey || data?.reason === 'missing-key') return 'needkey';
    if (res.status === 401 || res.status === 403) return meta.needsKey ? 'needkey' : 'offline';

    // Keyless remote: backend says not reachable with an API-key hint.
    if (meta.needsKey && looksLikeMissingKey(hint)) return 'needkey';

    return 'offline';
  } catch {
    return 'offline';
  }
}

// Probe every provider with bounded concurrency; returns { [id]: state }.
export async function probeAll({ signal } = {}) {
  const entries = await Promise.all(
    PROVIDERS.map(async (p) => [p.id, await probeProvider(p.id, { signal })])
  );
  return Object.fromEntries(entries);
}
