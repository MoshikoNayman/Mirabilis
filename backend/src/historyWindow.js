// @ts-check
// backend/src/historyWindow.js
// Chooses which prior messages to resend with a new turn.
//
// The naive version recomputes the window from the newest message every request
// and stops when the budget runs out. That is correct but expensive: the FRONT
// of the prompt shifts forward by a message or two on every turn, and local
// engines key their KV cache on a prompt PREFIX. A prefix that changes every
// turn means the cache misses every turn, so a long chat re-prefills its entire
// history on each message.
//
// Instead we anchor the window. The start index is remembered on the chat and
// held still while the prompt fits. When it no longer fits, it jumps forward far
// enough to free a chunk of budget at once, then holds again. That converts a
// guaranteed miss every turn into one miss roughly every N turns.

/** Fraction of the budget to free when eviction is triggered. */
const EVICT_TO_FRACTION = 0.75;

/**
 * @param {Array<{content?: string}>} messages full chat history, oldest first
 * @param {object} opts
 * @param {number} opts.budgetTokens token budget for the history window
 * @param {number} [opts.startIndex] previously anchored start index
 * @param {number} [opts.maxMessages] hard cap on message count
 * @param {number} [opts.minMessages] always keep at least this many recent messages
 * @param {(text: string|undefined) => number} opts.estimateTokens
 * @returns {{ startIndex: number, messages: Array<any>, tokens: number, evicted: boolean }}
 */
export function selectHistoryWindow(messages, {
  budgetTokens,
  startIndex = 0,
  maxMessages = Infinity,
  minMessages = 6,
  estimateTokens
}) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return { startIndex: 0, messages: [], tokens: 0, evicted: false };

  // The anchor is only a hint. Branching, regeneration and deletion all rewrite
  // the array, so a stale index must never select the wrong slice.
  let start = Number.isInteger(startIndex) ? startIndex : 0;
  if (start < 0) start = 0;
  if (start > list.length - 1) start = Math.max(0, list.length - 1);

  const cost = list.map((m) => estimateTokens(m?.content));
  const sumFrom = (i) => {
    let total = 0;
    for (let k = i; k < list.length; k += 1) total += cost[k];
    return total;
  };

  let tokens = sumFrom(start);
  let evicted = false;

  if (tokens > budgetTokens) {
    // Over budget: advance in one jump to well under it, rather than trimming
    // the single message that would just barely make it fit. Trimming minimally
    // guarantees another eviction next turn, which is the behaviour that made
    // the prefix cache useless.
    const target = budgetTokens * EVICT_TO_FRACTION;
    const lastAllowedStart = Math.max(0, list.length - minMessages);
    while (start < lastAllowedStart && tokens > target) {
      tokens -= cost[start];
      start += 1;
      evicted = true;
    }
  }

  // Hard cap on message count, independent of tokens.
  if (list.length - start > maxMessages) {
    start = list.length - maxMessages;
    tokens = sumFrom(start);
    evicted = true;
  }

  return { startIndex: start, messages: list.slice(start), tokens, evicted };
}
