// Which providers need an API key, and whether one is available: either the
// backend store (hint.hasKey) or a page-held value. One check for all call sites.

/** Providers that cannot work without a key. */
export const KEY_REQUIRED_PROVIDERS = new Set([
  'openai', 'grok', 'groq', 'openrouter', 'gemini', 'cerebras', 'claude', 'gpuaas'
]);

/** Display names shared by every call site. */
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
 * Message shown when a required key is missing.
 * @param {string} provider
 */
export function missingKeyMessage(provider) {
  return `${providerLabel(provider)} API key missing. Add it in Configure endpoint.`;
}
