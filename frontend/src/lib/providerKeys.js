// Which providers need an API key, and whether one is actually available.
//
// This exists because of a defect with the same shape as the tool-policy
// lockout: keys were moved out of the browser and into the backend, which was
// the right call, but the send path kept gating on the page-held copy that the
// same change had stopped populating. Every cloud provider became permanently
// unusable. Saving a key made the panel say "Stored in the app", and the next
// send still refused, because the two halves were looking at different places.
//
// The key can now live in either of two places, and either is sufficient:
//   - the backend store, reported to the page as a hint with hasKey
//   - a page-held value, which is only a legacy or in-session case
//
// Keeping that question in one named function means the send path, the health
// probe and the settings panel cannot drift apart again.

/** Providers that cannot work without a key. */
export const KEY_REQUIRED_PROVIDERS = new Set([
  'openai', 'grok', 'groq', 'openrouter', 'gemini', 'cerebras', 'claude', 'gpuaas'
]);

/** Display names, so the three call sites stop maintaining their own ladders. */
const PROVIDER_LABELS = {
  openai: 'OpenAI',
  grok: 'xAI',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  gemini: 'Google AI',
  cerebras: 'Cerebras',
  claude: 'Anthropic',
  gpuaas: 'GPUaaS endpoint'
};

export function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider || 'This provider';
}

export function providerNeedsKey(provider) {
  return KEY_REQUIRED_PROVIDERS.has(provider);
}

/**
 * Is a key available for this provider, from anywhere?
 *
 * @param {string} provider
 * @param {{pageKey?: string, hints?: Record<string, {hasKey?: boolean}>}} [sources]
 * @returns {boolean}
 */
export function hasUsableKey(provider, { pageKey = '', hints = {} } = {}) {
  if (!providerNeedsKey(provider)) return true;
  if (String(pageKey || '').trim()) return true;
  return hints?.[provider]?.hasKey === true;
}

/**
 * The message to show when a key really is missing.
 * @param {string} provider
 */
export function missingKeyMessage(provider) {
  return `${providerLabel(provider)} API key is required. Open Configure endpoint and paste your key.`;
}
