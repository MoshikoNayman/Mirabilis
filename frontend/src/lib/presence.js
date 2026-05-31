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

// Probe a single provider's health. Returns one of the presence states.
export async function probeProvider(id, { signal } = {}) {
  try {
    const res = await fetch(`${API_BASE}/api/providers/health?provider=${encodeURIComponent(id)}`, { signal });
    if (!res.ok) {
      // 401/403 => reachable but auth missing => needs key
      if (res.status === 401 || res.status === 403) return 'needkey';
      return 'offline';
    }
    const data = await res.json().catch(() => ({}));
    if (data?.ok === true || data?.healthy === true || data?.status === 'ok') return 'online';
    if (data?.needsKey || data?.reason === 'missing-key') return 'needkey';
    if (data?.reachable === false) return 'offline';
    // Some health payloads only echo a status string.
    if (typeof data?.status === 'string' && /online|ready|healthy/i.test(data.status)) return 'online';
    return data?.ok === false ? 'offline' : 'online';
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
