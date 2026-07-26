// @ts-check
// backend/src/providerScope.js
// Single source of truth for "does this provider send data off the device".
//
// Go Dark and the Privacy Receipt both need that answer, and getting it from the
// provider ID alone is wrong: openai-compatible, vllm and llamacpp all take an
// arbitrary base URL, so the same ID can point at localhost or at a cloud
// endpoint. Classification lives here so the server and its tests agree, and so
// adding a provider without classifying it fails a test rather than silently
// defaulting to "allowed under Go Dark".

import { isLocalHostUrl } from './security.js';

/** Every provider the app can select. Keep in sync with the frontend picker. */
export const ALL_PROVIDERS = /** @type {const} */ ([
  'ollama', 'llamacpp', 'koboldcpp', 'vllm', 'openai-compatible',
  'openai', 'claude', 'gemini', 'grok', 'groq', 'openrouter', 'cerebras', 'gpuaas'
]);

/** Always off-device: the endpoint belongs to the vendor. */
export const REMOTE_PROVIDERS = new Set([
  'openai', 'grok', 'groq', 'openrouter', 'gemini', 'cerebras', 'gpuaas', 'claude'
]);

/** Destination is whatever base URL the user typed, so it must be host-checked. */
export const BASE_URL_PROVIDERS = new Set(['openai-compatible', 'vllm', 'llamacpp']);

/** Always on-device. */
export const LOCAL_PROVIDERS = new Set(['ollama', 'koboldcpp']);

/** Endpoint used when the user left the base URL blank. */
/** @param {string} provider @returns {string} */
export function defaultBaseUrlForProvider(provider) {
  if (provider === 'vllm') return 'http://127.0.0.1:8000/v1';
  if (provider === 'llamacpp') return 'http://127.0.0.1:8080/v1';
  return '';
}

/**
 * Decide whether a send would leave the machine.
 * Returns { offDevice, reason }. `offDevice` true means Go Dark must block it.
 * Fails closed: an unknown provider or an unresolvable URL counts as off-device.
 * @param {string} provider
 * @param {string} [baseUrl] resolved base URL, if the user supplied one
 */
export function classifyProviderScope(provider, baseUrl) {
  const id = String(provider || '');
  if (LOCAL_PROVIDERS.has(id)) return { offDevice: false, reason: '' };
  if (REMOTE_PROVIDERS.has(id)) {
    return { offDevice: true, reason: `"${id}" is a remote provider.` };
  }
  if (BASE_URL_PROVIDERS.has(id)) {
    const resolved = String(baseUrl || '').trim() || defaultBaseUrlForProvider(id);
    if (isLocalHostUrl(resolved)) return { offDevice: false, reason: '' };
    return {
      offDevice: true,
      reason: `"${id}" is pointed at ${resolved || 'an unset endpoint'}, which is not on this machine or your LAN.`
    };
  }
  // Unknown provider: assume the worst rather than leaking.
  return { offDevice: true, reason: `"${id}" is not a known local provider.` };
}
