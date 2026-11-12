// @ts-check
// Wraps the streaming provider interface as the single-shot call the agent loop needs.
// Streams underneath so the abort signal reaches the engine and stopping a run stops the model.

import { describeEngineError } from '../engineErrors.js';
import { isClaude5OrLater, withoutTrailingAssistant } from '../providers/anthropic.js';

/**
 * @param {object} deps
 * @param {Function} deps.streamWithProvider
 * @param {object} deps.config
 * @param {{provider?:string, model?:string, baseUrl?:string, apiKey?:string, temperature?:number, ollamaOptions?:object, keepAlive?:any}} deps.request
 * @param {AbortSignal} [deps.signal]
 * @returns {(req: {messages: Array<{role:string,content:string}>, maxTokens?: number, purpose: string, timeoutMs?: number}) => Promise<{text:string, tokens:number}>}
 */
export function createModelAdapter({ streamWithProvider, config, request, signal }) {
  // Claude 5 and later reject sampling parameters and an assistant prefill.
  const fixedSampling = request.provider === 'claude' && isClaude5OrLater(request.model);

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
      messages: fixedSampling ? withoutTrailingAssistant(messages) : messages,
      config,
      signal: callSignal,
      onToken: (token) => { text += token; },
      onStats: (stats) => {
        if (stats && typeof stats.evalCount === 'number') reportedTokens = stats.evalCount;
      },
      onNotice: () => { /* tuning notices are not the agent's concern */ },
      overrideBaseUrl: request.baseUrl || undefined,
      overrideApiKey: request.apiKey || undefined,
      // Low temperature and token cap keep each step a short decision.
      temperature: fixedSampling ? undefined : (purpose === 'validate' ? 0 : (request.temperature ?? 0.2)),
      maxTokens: maxTokens ?? 1_500,
      ollamaOptions: request.ollamaOptions,
        keepAlive: request.keepAlive ?? '30m'
      });
    } catch (error) {
      timers.forEach((t) => clearTimeout(t));
      // Turn undici's bare "fetch failed" into the same message the chat path shows.
      const friendly = describeEngineError(error, {
        provider: request.provider, baseUrl: request.baseUrl, model: request.model
      });
      if (friendly !== String(error?.message || error)) throw new Error(friendly);
      throw error;
    }

    return { text, tokens: reportedTokens || Math.ceil(text.length / 4) };
  };
}
