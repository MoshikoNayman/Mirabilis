// @ts-check
// Wraps the streaming provider interface as the single-shot call the agent loop needs.
// Streams underneath so the abort signal reaches the engine and stopping a run stops the model.

import { describeEngineError } from '../engineErrors.js';
import { isClaude5OrLater, withoutTrailingAssistant } from '../providers/anthropic.js';

/** A rate limit or a busy engine: worth one more try after a short wait. */
const RETRYABLE = /API error: (429|503|529)\b|rate.?limit|overloaded|too many requests/i;
/** With less of the call's deadline left than this, a retry would only time out. */
const MIN_RETRY_WINDOW_MS = 15_000;
const MAX_ATTEMPTS = 2;

/**
 * Wait `ms`, ending early when `signal` aborts. Never rejects; the caller checks the signal.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function waitFor(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(undefined); return; }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve(undefined);
    };
    const timer = setTimeout(done, Math.max(0, Number(ms) || 0));
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * @param {object} deps
 * @param {Function} deps.streamWithProvider
 * @param {object} deps.config
 * @param {{provider?:string, model?:string, baseUrl?:string, apiKey?:string, temperature?:number, ollamaOptions?:object, keepAlive?:any}} deps.request
 * @param {AbortSignal} [deps.signal]
 * @param {() => number} [deps.retryDelayMs]  Wait before the one retry; tests pass () => 0.
 * @returns {(req: {messages: Array<{role:string,content:string}>, maxTokens?: number, purpose: string, timeoutMs?: number}) => Promise<{text:string, tokens:number}>}
 */
export function createModelAdapter({
  streamWithProvider, config, request, signal,
  retryDelayMs = () => 2_000 + Math.floor(Math.random() * 3_000)
}) {
  // Claude 5 and later reject sampling parameters and an assistant prefill.
  const fixedSampling = request.provider === 'claude' && isClaude5OrLater(request.model);

  return async function callModel({ messages, maxTokens, purpose, timeoutMs }) {
    const startedAt = Date.now();
    const bounded = Boolean(timeoutMs && Number.isFinite(timeoutMs));

    // Combine the run's abort with this call's deadline so a stalled provider
    // cannot outlive the budget. A retry runs inside the same deadline.
    let callSignal = signal;
    if (bounded) {
      const deadline = AbortSignal.timeout(/** @type {number} */ (timeoutMs));
      callSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    }

    for (let attempt = 1; ; attempt += 1) {
      let text = '';
      let reportedTokens = 0;
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
          // Each step is a short JSON reply under a token cap. A thinking model spent
          // the whole cap thinking and answered nothing, so a split found no parts.
          think: false,
          ollamaOptions: request.ollamaOptions,
          keepAlive: request.keepAlive ?? '30m'
        });
        return { text, tokens: reportedTokens || Math.ceil(text.length / 4) };
      } catch (error) {
        // Parallel agents meet rate limits and busy engines; one retry absorbs a burst.
        // Not after output has streamed, on a stop, on a Go Dark block, or near the deadline.
        const left = bounded ? /** @type {number} */ (timeoutMs) - (Date.now() - startedAt) : Infinity;
        const retry = attempt < MAX_ATTEMPTS && text === '' && !callSignal?.aborted
          && error?.code !== 'GO_DARK' && RETRYABLE.test(String(error?.message || error))
          && left >= MIN_RETRY_WINDOW_MS;
        if (retry) {
          await waitFor(retryDelayMs(), callSignal);
          if (!callSignal?.aborted) continue;
        }
        // Turn undici's bare "fetch failed" into the same message the chat path shows.
        const friendly = describeEngineError(error, {
          provider: request.provider, baseUrl: request.baseUrl, model: request.model
        });
        if (friendly !== String(error?.message || error)) throw new Error(friendly);
        throw error;
      }
    }
  };
}
