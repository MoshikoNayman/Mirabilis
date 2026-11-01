// @ts-check
// Picks the best installed model for a task lane within the memory ceiling. A
// keyword classifier picks the lane so the hot path needs no model call.

/** @typedef {import('./types.js').Lane} Lane */
/** @typedef {import('./types.js').RouteArgs} RouteArgs */
/** @typedef {import('./types.js').RouteResult} RouteResult */

// Case-insensitive substrings of model ids, in preference order.
/** @type {Record<Lane, string[]>} */
const LANE_PREFS = {
  coding:       ['coder', 'code', 'deepseek-coder', 'qwen2.5-coder', 'qwen3-coder'],
  reasoning:    ['qwq', 'r1', 'deepseek-r1', 'qwen3', 'reason', 'thinking'],
  experimental: ['abliterat', 'uncensored', 'dolphin', 'wizard-vicuna', 'openhermes'],
  general:      ['gemma4', 'gemma3', 'qwen3', 'qwen2.5', 'llama3', 'mistral']
};

const CODING_RE = /\b(code|function|bug|refactor|python|javascript|typescript|rust|golang|sql|regex|api|class|method|compile|stack ?trace|npm|git|docker|algorithm|leetcode|unit test|snippet)\b/i;
const REASONING_RE = /\b(reason|prove|step[- ]by[- ]step|think through|derive|logic|why does|explain how|trade[- ]?off|analyze|plan|strategy|math|calculate|solve)\b/i;

/** @param {string} [prompt] @returns {Lane} */
export function classifyLane(prompt) {
  const p = String(prompt || '');
  if (CODING_RE.test(p) || p.includes('```')) return 'coding';
  if (REASONING_RE.test(p)) return 'reasoning';
  return 'general';
}

/** @param {RouteArgs} [args] @returns {RouteResult} */
export function route({ prompt, lane, availableModels = [], ramGb = 16, uncensored = false } = {}) {
  const models = (availableModels || []).filter((m) => m && (m.id || m.name));
  /** @param {import('./types.js').AvailableModel} m */
  const idOf = (m) => String(m.id || m.name);
  if (!models.length) return { model: null, lane: lane || 'general', reason: 'no models installed' };

  // Explicit uncensored intent overrides the classifier.
  const resolvedLane = uncensored ? 'experimental' : (lane || classifyLane(prompt));

  // Only consider models whose weights leave room to actually run (~weights + KV/OS).
  /** @param {import('./types.js').AvailableModel} m */
  const fits = (m) => !m.sizeBytes || (m.sizeBytes / 1e9) < ramGb * 0.75;
  const runnable = models.filter(fits);
  const pool = runnable.length ? runnable : models;

  const prefs = LANE_PREFS[resolvedLane] || LANE_PREFS.general;
  for (const needle of prefs) {
    const hit = pool.find((m) => idOf(m).toLowerCase().includes(needle));
    if (hit) return { model: idOf(hit), lane: resolvedLane, reason: `matched "${needle}" for ${resolvedLane}` };
  }
  // Fallback: a general-family model, else the largest that fits.
  for (const needle of LANE_PREFS.general) {
    const hit = pool.find((m) => idOf(m).toLowerCase().includes(needle));
    if (hit) return { model: idOf(hit), lane: resolvedLane, reason: `no ${resolvedLane} model; fell back to general "${needle}"` };
  }
  const biggest = [...pool].sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))[0];
  return { model: idOf(biggest), lane: resolvedLane, reason: 'fell back to the largest fitting model' };
}
