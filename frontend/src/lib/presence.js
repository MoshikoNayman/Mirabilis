// @ts-check
// Provider catalog, and the mapping from provider health to the presence states
// the Buddy List and StatusOrb render.

import { API_BASE } from './api';

/** @typedef {import('../types.js').ProviderMeta} ProviderMeta */
/** @typedef {import('../types.js').PresenceState} PresenceState */

// Keep in sync with ChatApp's provider metadata.
/** @type {ProviderMeta[]} */
export const PROVIDERS = [
  { id: 'ollama', label: 'Ollama', scope: 'local', needsKey: false, requiresBinary: false, baseUrl: 'http://127.0.0.1:11434' },
  { id: 'openai-compatible', label: 'Custom endpoint', scope: 'local', needsKey: false, requiresBinary: true, baseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'koboldcpp', label: 'KoboldCpp', scope: 'local', needsKey: false, requiresBinary: true, baseUrl: 'http://127.0.0.1:5001/v1' },
  { id: 'openai', label: 'OpenAI', scope: 'remote', needsKey: true, baseUrl: 'https://api.openai.com/v1' },
  { id: 'claude', label: 'Claude', scope: 'remote', needsKey: true, baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', label: 'Gemini', scope: 'remote', needsKey: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'groq', label: 'Groq', scope: 'remote', needsKey: true, baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'grok', label: 'Grok', scope: 'remote', needsKey: true, baseUrl: 'https://api.x.ai/v1' },
  { id: 'openrouter', label: 'OpenRouter', scope: 'remote', needsKey: true, baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'cerebras', label: 'Cerebras', scope: 'remote', needsKey: true, baseUrl: 'https://api.cerebras.ai/v1' },
  { id: 'gpuaas', label: 'GPUaaS', scope: 'remote', needsKey: true, baseUrl: '' }
];

export const PRESENCE_LABELS = {
  online: 'Online',
  away: 'Needs setup',
  needkey: 'Needs API key',
  busy: 'Streaming',
  offline: 'Offline',
  dark: 'Dark',
  unknown: 'Checking...'
};

// Ollama models loaded in memory; empty when Ollama is cold or unreachable.
/** @param {{ signal?: AbortSignal }} [opts] @returns {Promise<string[]>} */
export async function probeOllamaWarmth({ signal } = {}) {
  try {
    const res = await fetch(`${API_BASE}/api/providers/ollama/ps`, { signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.models)
      ? data.models.filter((m) => m && m.warm).map((m) => m.name).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

// Aggregate a presence map into a single orb state for the title bar.
/** @param {Record<string, PresenceState>} map @param {boolean} [streaming] @returns {PresenceState} */
export function aggregatePresence(map, streaming = false) {
  if (streaming) return 'busy';
  const states = Object.values(map || {});
  if (states.some((s) => s === 'online')) return 'online';
  if (states.some((s) => s === 'away' || s === 'needkey')) return 'away';
  if (states.length && states.every((s) => s === 'offline')) return 'offline';
  return 'unknown';
}

// The backend answers a keyless remote with 400 and a hint such as
// "OpenAI API key is required.", which must read as needkey, not offline.
function looksLikeMissingKey(text) {
  return /api[\s_-]*key|missing[\s_-]*key|unauthor|invalid[\s_-]*key|credential|token[\s_-]*required/i.test(
    String(text || '')
  );
}

// A remote with no key is needkey; a local engine that is not running is offline.
/** @param {string} id @param {{ signal?: AbortSignal }} [opts] @returns {Promise<PresenceState>} */
export async function probeProvider(id, { signal } = {}) {
  const meta = PROVIDERS.find((p) => p.id === id) || /** @type {Partial<ProviderMeta>} */ ({});
  try {
    const res = await fetch(
      `${API_BASE}/api/providers/health?provider=${encodeURIComponent(id)}`,
      { signal }
    );
    const data = await res.json().catch(() => ({}));
    const hint = data?.hint || data?.error || data?.reason || data?.message || '';

    // Go Dark: the backend will not contact it.
    if (data?.dark === true) return 'dark';

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

/** @param {{ signal?: AbortSignal }} [opts] @returns {Promise<Record<string, PresenceState>>} */
export async function probeAll({ signal } = {}) {
  const entries = await Promise.all(
    PROVIDERS.map(async (p) => [p.id, await probeProvider(p.id, { signal })])
  );
  return Object.fromEntries(entries);
}
