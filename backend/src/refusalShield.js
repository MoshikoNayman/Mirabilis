// @ts-check
// The refusal shield of Uncensored mode. The start of a reply is held back until
// refusal.js can tell an answer from a refusal. An answer goes out and streams on
// live; a refusal is dropped and the turn is asked again as the plan says: the
// same model with the reply already begun (PREFILL), then another model.

import { PREFILL, refusalVerdict } from './refusal.js';

/** @typedef {{ model: string, prefill: boolean }} ShieldAttempt */
/** @typedef {{ signal: AbortSignal, onToken: (token: string) => void }} AttemptStream */
/** @typedef {'shown' | 'refused' | 'failed' | 'stopped'} AttemptOutcome */

/**
 * One chat turn through the plan's attempts, in order, until one does not open
 * with a refusal. A prefilled attempt reads as PREFILL and then its continuation.
 * The last attempt is shown even when it refuses. A retry that fails before it
 * shows anything is passed over, and with none left the last refusal is shown;
 * a first attempt that fails throws, as it would without the shield.
 * @param {object} opts
 * @param {ShieldAttempt[]} opts.plan
 * @param {(attempt: ShieldAttempt, stream: AttemptStream) => Promise<unknown>} opts.run
 *   streams one attempt into stream.onToken; resolves, not throws, once stream.signal aborts
 * @param {(token: string) => void} opts.onToken  the visible reply, in order
 * @param {(retry: { attempt: number, model: string }) => void} [opts.onRetry]
 *   before each attempt after the first; attempt counts from 1
 * @param {AbortSignal} [opts.signal]  the request's: an abort returns what was shown
 * @returns {Promise<{ text: string, model: string, retries: number }>}
 *   text: all onToken was given; model: whose text it is
 */
export async function streamShielded({ plan, run, onToken, onRetry, signal }) {
  let shown = '';
  /** @param {string} text */
  const show = (text) => {
    if (!text) return;
    shown += text;
    onToken(text);
  };

  /**
   * shown: its text went out. refused: dropped. failed: it threw before showing
   * anything. stopped: the request was aborted first.
   * @param {ShieldAttempt} attempt
   * @param {boolean} last
   * @returns {Promise<{ outcome: AttemptOutcome, held: string, error?: unknown }>}
   */
  async function attemptOnce(attempt, last) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    let held = attempt.prefill ? PREFILL : '';
    let state = /** @type {'pending' | 'shown' | 'refused'} */ ('pending');
    /** @param {boolean} final */
    const judge = (final) => {
      const verdict = refusalVerdict(held, { final });
      if (verdict === 'pending') return;
      if (verdict === 'refusal' && !last) {
        state = 'refused';
        controller.abort();
        return;
      }
      state = 'shown';
      show(held);
    };
    try {
      await run(attempt, {
        signal: controller.signal,
        onToken: (token) => {
          // Lines read before the abort can still arrive.
          if (controller.signal.aborted || !token) return;
          if (state === 'shown') {
            show(token);
            return;
          }
          held += token;
          judge(false);
        }
      });
    } catch (error) {
      if (signal?.aborted) return { outcome: state === 'shown' ? 'shown' : 'stopped', held };
      if (state === 'refused') return { outcome: 'refused', held };
      // An answer cut short fails as it would without the shield.
      if (state === 'shown') throw error;
      return { outcome: 'failed', held, error };
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    if (signal?.aborted) return { outcome: state === 'shown' ? 'shown' : 'stopped', held };
    // A reply that ended before a verdict is judged whole.
    if (state === 'pending') judge(true);
    return { outcome: state === 'refused' ? 'refused' : 'shown', held };
  }

  /** @type {{ text: string, model: string } | null} */
  let refusal = null;
  let model = plan[0]?.model || '';
  let retries = 0;
  for (let i = 0; i < plan.length && !signal?.aborted; i += 1) {
    const attempt = plan[i];
    if (i > 0) onRetry?.({ attempt: i + 1, model: attempt.model });
    model = attempt.model;
    retries = i;
    const { outcome, held, error } = await attemptOnce(attempt, i === plan.length - 1);
    if (outcome === 'shown' || outcome === 'stopped') return { text: shown, model, retries };
    if (outcome === 'refused') {
      refusal = { text: held, model };
    } else if (!refusal) {
      // Nothing to fall back on: what it said goes out, then the failure.
      show(held);
      throw error;
    }
  }
  // Every retry failed: the last refusal is the reply.
  if (refusal && !signal?.aborted) {
    show(refusal.text);
    return { text: shown, model: refusal.model, retries };
  }
  return { text: shown, model, retries };
}
