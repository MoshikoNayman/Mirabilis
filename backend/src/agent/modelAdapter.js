// @ts-check
// backend/src/agent/modelAdapter.js
// Turns the streaming provider interface into the single-shot call the loop wants.
//
// The loop asks closed questions ("what is your next action?") and needs the
// whole reply before it can act, so streaming buys nothing there. It does still
// stream underneath, because that is the only interface every provider shares,
// and because it keeps the abort signal wired all the way down to the engine:
// stopping a five-hour run has to actually stop the model, not just stop reading it.

/**
 * @param {object} deps
 * @param {Function} deps.streamWithProvider
 * @param {object} deps.config
 * @param {{provider?:string, model?:string, baseUrl?:string, apiKey?:string, temperature?:number, ollamaOptions?:object, keepAlive?:any}} deps.request
 * @param {AbortSignal} [deps.signal]
 * @returns {(req: {messages: Array<{role:string,content:string}>, maxTokens?: number, purpose: string, timeoutMs?: number}) => Promise<{text:string, tokens:number}>}
 */
export function createModelAdapter({ streamWithProvider, config, request, signal }) {
  return async function callModel({ messages, maxTokens, purpose, timeoutMs }) {
    let text = '';
    let reportedTokens = 0;

    // Combine the run's abort with this call's deadline so a stalled provider
    // cannot outlive the budget.
    const timers = [];
    let callSignal = signal;
    if (timeoutMs && Number.isFinite(timeoutMs)) {
      const deadline = AbortSignal.timeout(timeoutMs);
      callSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    }

    try {
      await streamWithProvider({
      provider: request.provider,
      model: request.model,
      messages,
      config,
      signal: callSignal,
      onToken: (token) => { text += token; },
      onStats: (stats) => {
        if (stats && typeof stats.evalCount === 'number') reportedTokens = stats.evalCount;
      },
      onNotice: () => { /* tuning notices are not the agent's concern */ },
      overrideBaseUrl: request.baseUrl || undefined,
      overrideApiKey: request.apiKey || undefined,
      // Deliberately low: the loop wants decisions, not essays. A model that
      // rambles for 4000 tokens per step burns the budget without advancing.
      temperature: purpose === 'validate' ? 0 : (request.temperature ?? 0.2),
      maxTokens: maxTokens ?? 1_500,
      ollamaOptions: request.ollamaOptions,
        keepAlive: request.keepAlive ?? '30m'
      });
    } catch (error) {
      timers.forEach((t) => clearTimeout(t));
      // A run that dies on its first call should say WHY. Bare "fetch failed"
      // from undici is the most common failure here (the local engine is not
      // running) and is the least useful thing to show someone.
      const raw = String(error?.message || error);
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(raw)) {
        const where = request.baseUrl || 'its default address';
        throw new Error(
          `Could not reach the "${request.provider}" engine at ${where}. `
          + 'Start the engine (for Ollama: run `ollama serve`), or pick a provider that is running. '
          + `Original error: ${raw}`
        );
      }
      throw error;
    }

    return { text, tokens: reportedTokens || Math.ceil(text.length / 4) };
  };
}
