// backend/src/modelRouter.js
// Capability-first model router: map a task LANE (general / reasoning / coding /
// experimental) to the best INSTALLED model, honoring the hardware ceiling. Keeps
// model management separate from inference-engine logic (the registry owns runtimes;
// this owns "which model for which job"). A cheap keyword classifier picks the lane
// when the caller does not specify one - no extra model call on the hot path.

// Lane -> ordered preference of model-name substrings (matched case-insensitively
// against installed model ids). First installed match wins; falls back to a general
// model, then the largest model that fits.
const LANE_PREFS = {
  coding:       ['coder', 'code', 'deepseek-coder', 'qwen2.5-coder', 'qwen3-coder'],
  reasoning:    ['qwq', 'r1', 'deepseek-r1', 'qwen3', 'reason', 'thinking'],
  experimental: ['abliterat', 'uncensored', 'dolphin', 'wizard-vicuna', 'openhermes'],
  general:      ['gemma4', 'gemma3', 'qwen3', 'qwen2.5', 'llama3', 'mistral']
};

const CODING_RE = /\b(code|function|bug|refactor|python|javascript|typescript|rust|golang|sql|regex|api|class|method|compile|stack ?trace|npm|git|docker|algorithm|leetcode|unit test|snippet)\b/i;
const REASONING_RE = /\b(reason|prove|step[- ]by[- ]step|think through|derive|logic|why does|explain how|trade[- ]?off|analyze|plan|strategy|math|calculate|solve)\b/i;

export function classifyLane(prompt) {
  const p = String(prompt || '');
  if (CODING_RE.test(p) || p.includes('```')) return 'coding';
  if (REASONING_RE.test(p)) return 'reasoning';
  return 'general';
}

// availableModels: [{ id, name, sizeBytes, paramSize, quant, uncensored }]
// ramGb: device memory ceiling (weights should leave headroom for KV+OS)
export function route({ prompt, lane, availableModels = [], ramGb = 16, uncensored = false } = {}) {
  const models = (availableModels || []).filter((m) => m && (m.id || m.name));
  const idOf = (m) => String(m.id || m.name);
  if (!models.length) return { model: null, lane: lane || 'general', reason: 'no models installed' };

  // Explicit uncensored intent overrides the classifier.
  const resolvedLane = uncensored ? 'experimental' : (lane || classifyLane(prompt));

  // Only consider models whose weights leave room to actually run (~weights + KV/OS).
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
