// Which providers need the backend to physically swap a model, and which just
// need the page to remember a different id.
//
// The model picker used to POST /api/providers/switch-model for EVERY
// non-Ollama provider. That route exists only for locally hosted GGUF servers,
// which have to load a different file; it rejects everything else with a 400.
// So choosing a model was impossible for openai, claude, gemini, groq, grok,
// openrouter, cerebras, gpuaas, vllm and llamacpp: the dropdown stayed open,
// the selection never changed, and the raw 400 body appeared in the status bar.
//
// For every other provider the model id is simply sent with each request, so
// selecting one is a local state change and nothing more.

/**
 * Providers whose model is loaded server-side and must be switched there.
 * MUST match the allowlist in backend/src/server.js's /api/providers/switch-model.
 * providerCapabilities.test.js reads that route and fails if the two drift.
 */
export const SERVER_MODEL_SWITCH_PROVIDERS = ['openai-compatible', 'koboldcpp'];

/** @param {string} provider */
export function needsServerModelSwitch(provider) {
  return SERVER_MODEL_SWITCH_PROVIDERS.includes(provider);
}
