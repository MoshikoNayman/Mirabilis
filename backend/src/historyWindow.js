// @ts-check
// Chooses which prior messages to resend with a new turn. The start index is
// anchored so the prompt prefix, and the engine's KV cache, stays stable across turns.

/** Fraction of the budget to free when eviction is triggered. */
const EVICT_TO_FRACTION = 0.75;

/**
 * @param {Array<{content?: string}>} messages full chat history, oldest first
 * @param {object} opts
 * @param {number} opts.budgetTokens token budget for the history window
 * @param {number} [opts.startIndex] previously anchored start index
 * @param {number} [opts.maxMessages] hard cap on message count
 * @param {number} [opts.minMessages] always keep at least this many recent messages
 * @param {(text: string|undefined, message?: any) => number} opts.estimateTokens
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

  const cost = list.map((m) => estimateTokens(m?.content, m));
  const sumFrom = (i) => {
    let total = 0;
    for (let k = i; k < list.length; k += 1) total += cost[k];
    return total;
  };

  let tokens = sumFrom(start);
  let evicted = false;

  if (tokens > budgetTokens) {
    // Jump well under budget. Trimming the minimum would evict again next turn
    // and miss the prefix cache every time.
    const target = budgetTokens * EVICT_TO_FRACTION;
    const lastAllowedStart = Math.max(0, list.length - minMessages);
    while (start < lastAllowedStart && tokens > target) {
      tokens -= cost[start];
      start += 1;
      evicted = true;
    }
  }

  if (list.length - start > maxMessages) {
    start = list.length - maxMessages;
    tokens = sumFrom(start);
    evicted = true;
  }

  return { startIndex: start, messages: list.slice(start), tokens, evicted };
}
