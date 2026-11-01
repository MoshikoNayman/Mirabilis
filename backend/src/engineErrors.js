// @ts-check
// Maps engine transport errors (e.g. undici "fetch failed") to a message that
// says how to fix them.

/** How to start each local engine, for the message. */
const START_HINTS = {
  ollama: 'Start it with `ollama serve`, or install it from ollama.com.',
  llamacpp: 'Start the llama.cpp server from the provider settings.',
  vllm: 'Start the vLLM server, or point the provider at a running one.',
  koboldcpp: 'Start KoboldCpp, or point the provider at a running one.'
};

const UNREACHABLE_RE = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network error|other side closed/i;
const TIMEOUT_RE = /timeout|timed out|UND_ERR_(HEADERS|BODY)_TIMEOUT|AbortError/i;

/**
 * @param {unknown} error
 * @param {{provider?: string, baseUrl?: string, model?: string}} [ctx]
 * @returns {string} a message worth showing a user
 */
export function describeEngineError(error, ctx = {}) {
  // String([]) is '', so the fallback must follow trim() to never show a blank error.
  const raw = String((error && /** @type {any} */ (error).message) || error || '').trim() || 'Unknown error';
  const provider = ctx.provider || 'the selected provider';
  const where = ctx.baseUrl ? ` at ${ctx.baseUrl}` : '';

  if (UNREACHABLE_RE.test(raw)) {
    const hint = START_HINTS[String(ctx.provider || '').toLowerCase()]
      || 'Start the engine, or pick a provider that is running.';
    return `Could not reach ${provider}${where}. ${hint}`;
  }
  if (TIMEOUT_RE.test(raw)) {
    return `${provider}${where} did not respond in time. It may be loading a model, or the model may be too large for this machine. `
      + 'Try again, or pick a smaller model.';
  }
  // Anything else is already a real message from the engine: pass it through.
  return raw;
}

/** True when the failure means "nothing is listening", not "the model erred". */
export function isEngineUnreachable(error) {
  const raw = String((error && /** @type {any} */ (error).message) || error || '');
  return UNREACHABLE_RE.test(raw);
}
