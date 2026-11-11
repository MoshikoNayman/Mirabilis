// @ts-check
// Effort profiles: hard work budgets plus run shape (plan, validate, sub-agents).
// budget.js enforces the numbers in code; the model is never trusted to stop itself.

/**
 * @typedef {object} EffortProfile
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {boolean} agentic          Run the plan/act/validate loop at all.
 * @property {number} maxWallMs         Hard wall-clock ceiling for the whole run.
 * @property {number} maxIterations     Act/observe cycles.
 * @property {number} maxToolCalls      Total tool invocations.
 * @property {number} maxOutputTokens   Total generated tokens across the run.
 * @property {boolean} plan             Produce an explicit plan before acting.
 * @property {boolean} validate         Run a validation pass against the goal.
 * @property {number} maxRepairAttempts Re-attempts after a failed validation.
 * @property {number} maxSubAgents      Parallel sub-agents allowed (0 = none).
 * @property {string} [styleHint]       Appended to the system prompt.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** @type {Record<string, EffortProfile>} */
export const EFFORT_PROFILES = {
  // Single-shot tiers: most messages are questions, and a planning pass would
  // only add latency.
  instant: {
    id: 'instant', label: 'Instant',
    description: 'One shot, shortest correct answer.',
    agentic: false,
    maxWallMs: 2 * MIN, maxIterations: 1, maxToolCalls: 0, maxOutputTokens: 1_000,
    plan: false, validate: false, maxRepairAttempts: 0, maxSubAgents: 0,
    styleHint: 'Effort: instant. Give the shortest possible correct answer, one line if you can, no preamble.'
  },
  fast: {
    id: 'fast', label: 'Fast',
    description: 'One shot, concise and direct.',
    agentic: false,
    maxWallMs: 5 * MIN, maxIterations: 1, maxToolCalls: 0, maxOutputTokens: 2_000,
    plan: false, validate: false, maxRepairAttempts: 0, maxSubAgents: 0,
    styleHint: 'Effort: fast. Answer concisely and directly, skip preamble.'
  },
  balanced: {
    id: 'balanced', label: 'Balanced',
    description: 'One shot, normal depth. The default.',
    agentic: false,
    maxWallMs: 10 * MIN, maxIterations: 1, maxToolCalls: 0, maxOutputTokens: 4_000,
    plan: false, validate: false, maxRepairAttempts: 0, maxSubAgents: 0
  },
  thorough: {
    id: 'thorough', label: 'Thorough',
    description: 'One shot, complete and well structured.',
    agentic: false,
    maxWallMs: 15 * MIN, maxIterations: 1, maxToolCalls: 0, maxOutputTokens: 8_000,
    plan: false, validate: false, maxRepairAttempts: 0, maxSubAgents: 0,
    styleHint: 'Effort: thorough. Work through the key considerations and give a complete, well-structured answer.'
  },

  // Agentic: the loop runs, bounded by these numbers.
  high: {
    id: 'high', label: 'High effort',
    description: 'Plan, execute with tools, validate, repair. Minutes.',
    agentic: true,
    // On single-shot tiers maxWallMs is a timeout for one generation; from here
    // down it is a work budget sized for iterations plus validation and repairs.
    maxWallMs: 30 * MIN, maxIterations: 12, maxToolCalls: 60, maxOutputTokens: 40_000,
    plan: true, validate: true, maxRepairAttempts: 2, maxSubAgents: 0
  },
  hour: {
    id: 'hour', label: '1 hour',
    description: 'Keep working, validating and iterating, for up to an hour.',
    agentic: true,
    maxWallMs: 1 * HOUR, maxIterations: 80, maxToolCalls: 500, maxOutputTokens: 300_000,
    plan: true, validate: true, maxRepairAttempts: 4, maxSubAgents: 3
  },
  session: {
    id: 'session', label: '5 hours',
    description: 'A long autonomous work session with a large budget.',
    agentic: true,
    maxWallMs: 5 * HOUR, maxIterations: 400, maxToolCalls: 2_500, maxOutputTokens: 1_500_000,
    plan: true, validate: true, maxRepairAttempts: 8, maxSubAgents: 6
  },

  // A single-shot effort with Access above Chat only: a short tool loop, no plan or
  // validation. Not in EFFORT_ORDER; the route picks it and copies the effort's styleHint.
  assist: {
    id: 'assist', label: 'Assist',
    description: 'A short tool-using loop for a question about this computer or Mirabilis.',
    agentic: true,
    maxWallMs: 10 * MIN, maxIterations: 16, maxToolCalls: 40, maxOutputTokens: 60_000,
    plan: false, validate: false, maxRepairAttempts: 0, maxSubAgents: 0
  }
};

export const DEFAULT_EFFORT_ID = 'balanced';

/** Ordered for display: cheapest first, then the agentic tiers. */
export const EFFORT_ORDER = ['instant', 'fast', 'balanced', 'thorough', 'high', 'hour', 'session'];

/**
 * The profile for a run: an agentic effort keeps its own; a single-shot effort with
 * tools on gets `assist`, carrying the effort's styleHint. Overrides only lower limits.
 * @param {string} [id]
 * @param {Partial<EffortProfile>} [overrides]
 * @returns {EffortProfile}
 */
export function resolveRunProfile(id, overrides = {}) {
  if (isAgenticEffort(id)) return resolveEffort(id, overrides);
  const chosen = EFFORT_PROFILES[String(id || '')] || EFFORT_PROFILES[DEFAULT_EFFORT_ID];
  const profile = resolveEffort('assist', overrides);
  if (chosen.styleHint) profile.styleHint = chosen.styleHint;
  return profile;
}

/**
 * Resolve an effort id plus overrides into a concrete profile. Overrides can only
 * lower the tier's limits, so a client bug or injected argument cannot raise them.
 *
 * @param {string} [id]
 * @param {Partial<EffortProfile>} [overrides]
 * @returns {EffortProfile}
 */
export function resolveEffort(id, overrides = {}) {
  const base = EFFORT_PROFILES[String(id || DEFAULT_EFFORT_ID)] || EFFORT_PROFILES[DEFAULT_EFFORT_ID];
  /** @type {EffortProfile} */
  const out = { ...base };

  const clampNumber = (key) => {
    const raw = overrides[key];
    if (raw == null) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    out[key] = Math.min(n, base[key]);
  };
  for (const key of ['maxWallMs', 'maxIterations', 'maxToolCalls', 'maxOutputTokens', 'maxRepairAttempts', 'maxSubAgents']) {
    clampNumber(key);
  }
  // Booleans may only be turned off, for the same reason.
  for (const key of ['plan', 'validate', 'agentic']) {
    if (overrides[key] === false) out[key] = false;
  }
  return out;
}

/** @param {string} [id] */
export function isAgenticEffort(id) {
  return Boolean((EFFORT_PROFILES[String(id || '')] || {}).agentic);
}
