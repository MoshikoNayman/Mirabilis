// Which providers need the backend to swap the loaded model. All others send
// the model id with each request, so selecting one is a local state change.

/**
 * Providers whose model is loaded server-side and must be switched there.
 * Must match the allowlist in backend/src/server.js's /api/providers/switch-model.
 * providerCapabilities.test.js reads that route and fails if the two drift.
 */
export const SERVER_MODEL_SWITCH_PROVIDERS = ['openai-compatible', 'koboldcpp'];

/** @param {string} provider */
export function needsServerModelSwitch(provider) {
  return SERVER_MODEL_SWITCH_PROVIDERS.includes(provider);
}
