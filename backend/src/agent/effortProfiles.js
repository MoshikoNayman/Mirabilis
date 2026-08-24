// @ts-check
// backend/src/agent/effortProfiles.js
// Execution-effort profiles.
//
// The pre-existing "effort" setting (instant/fast/balanced/thorough/deep) is a
// STYLE hint: it appends a sentence to the system prompt and changes how verbose
// the answer is. It cannot change how much WORK happens, because the chat path
// is single-shot.
//
// These profiles are the other axis: how much work the agent is allowed to do.
// A profile is a hard budget (wall clock, iterations, tool calls, tokens) plus a
// shape (does it plan, does it validate, may it fan out to sub-agents). The
// budget is enforced in code by budget.js, never by asking the model nicely,
// because a model that has lost the thread is exactly the one that will claim it
// needs "just one more" iteration.

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

/** Minutes and hours, spelled out so the numbers below stay readable. */
const MIN = 60_000;
const HOUR = 60 * MIN;

/** @type {Record<string, EffortProfile>} */
export const EFFORT_PROFILES = {
  // ── Non-agentic: today's behaviour, preserved exactly. ────────────────────
  // These stay single-shot on purpose. Most messages are a question, not a job,
  // and putting a planning pass in front of "what does this flag do" would make
  // the app feel broken.
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

  // ── Agentic: the loop runs, bounded by these numbers. ─────────────────────
  high: {
    id: 'high', label: 'High effort',
    description: 'Plan, execute with tools, validate, repair. Minutes.',
    agentic: true,
    // 30 minutes, not 10: twelve iterations with a validation pass and repairs
    // needs real room. Note the wall clock means different things either side of
    // this line. For the single-shot tiers above it is a safety timeout on one
    // generation; from here down it is an actual work budget.
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
  }
};

export const DEFAULT_EFFORT_ID = 'balanced';

/** Ordered for display: cheapest first, then the agentic tiers. */
export const EFFORT_ORDER = ['instant', 'fast', 'balanced', 'thorough', 'high', 'hour', 'session'];

/**
 * Resolve an effort id, optionally with caller overrides, into a concrete
 * profile. Overrides are clamped to the profile's own ceiling: a request can ask
 * for LESS work than the tier allows, never more. Otherwise "effort" would be a
 * suggestion again, and a client bug (or a prompt-injected argument) could hand
 * an agent an unbounded budget.
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
  // Booleans may only be turned OFF, for the same reason.
  for (const key of ['plan', 'validate', 'agentic']) {
    if (overrides[key] === false) out[key] = false;
  }
  return out;
}

/** @param {string} [id] */
export function isAgenticEffort(id) {
  return Boolean((EFFORT_PROFILES[String(id || '')] || {}).agentic);
}
