// @ts-check
// Enforces effort budgets in code before each step. The model is told what
// remains so it can prioritise, but only this module decides when to stop.

/** Why a run stopped. `completed` is the only non-budget outcome. */
export const STOP_REASONS = /** @type {const} */ ({
  COMPLETED: 'completed',
  WALL_CLOCK: 'wall-clock-exhausted',
  ITERATIONS: 'iterations-exhausted',
  TOOL_CALLS: 'tool-calls-exhausted',
  TOKENS: 'token-budget-exhausted',
  CANCELLED: 'cancelled',
  FAILED: 'failed'
});

export class BudgetExhaustedError extends Error {
  /** @param {string} reason @param {object} snapshot */
  constructor(reason, snapshot) {
    super(`Effort budget exhausted: ${reason}`);
    this.name = 'BudgetExhaustedError';
    this.reason = reason;
    this.snapshot = snapshot;
  }
}

/**
 * @param {import('./effortProfiles.js').EffortProfile} profile
 * @param {{ signal?: AbortSignal, now?: () => number }} [opts]
 */
export function createBudget(profile, { signal, now = () => Date.now() } = {}) {
  const startedAt = now();
  let iterations = 0;
  let toolCalls = 0;
  let outputTokens = 0;
  let subAgents = 0;
  let repairs = 0;
  /** @type {string|null} */
  let stoppedBecause = null;

  const elapsed = () => now() - startedAt;

  /** Remaining headroom on every axis. Reported to the model so it can triage. */
  const remaining = () => ({
    wallMs: Math.max(0, profile.maxWallMs - elapsed()),
    iterations: Math.max(0, profile.maxIterations - iterations),
    toolCalls: Math.max(0, profile.maxToolCalls - toolCalls),
    outputTokens: Math.max(0, profile.maxOutputTokens - outputTokens),
    subAgents: Math.max(0, profile.maxSubAgents - subAgents),
    repairs: Math.max(0, profile.maxRepairAttempts - repairs)
  });

  const snapshot = () => ({
    effort: profile.id,
    elapsedMs: elapsed(),
    iterations,
    toolCalls,
    outputTokens,
    subAgents,
    repairs,
    limits: {
      maxWallMs: profile.maxWallMs,
      maxIterations: profile.maxIterations,
      maxToolCalls: profile.maxToolCalls,
      maxOutputTokens: profile.maxOutputTokens,
      maxSubAgents: profile.maxSubAgents,
      maxRepairAttempts: profile.maxRepairAttempts
    },
    remaining: remaining(),
    stoppedBecause
  });

  /**
   * Returns a stop reason, or null when there is still room.
   * @returns {string|null}
   */
  function checkStop() {
    if (stoppedBecause) return stoppedBecause;
    if (signal?.aborted) return (stoppedBecause = STOP_REASONS.CANCELLED);
    if (elapsed() >= profile.maxWallMs) return (stoppedBecause = STOP_REASONS.WALL_CLOCK);
    if (iterations >= profile.maxIterations) return (stoppedBecause = STOP_REASONS.ITERATIONS);
    if (toolCalls >= profile.maxToolCalls && profile.maxToolCalls > 0) return (stoppedBecause = STOP_REASONS.TOOL_CALLS);
    if (outputTokens >= profile.maxOutputTokens) return (stoppedBecause = STOP_REASONS.TOKENS);
    return null;
  }

  return {
    profile,
    startedAt,
    elapsed,
    remaining,
    snapshot,
    checkStop,

    /** True while there is room for more work. */
    canContinue: () => checkStop() === null,

    /** Claim one act/observe cycle. Throws when the budget is spent. */
    beginIteration() {
      const stop = checkStop();
      if (stop) throw new BudgetExhaustedError(stop, snapshot());
      iterations += 1;
      return iterations;
    },

    /**
     * Claim one tool invocation. Checked before the call so a run cannot exceed
     * its ceiling by one expensive command.
     */
    chargeToolCall() {
      if (profile.maxToolCalls <= 0) {
        throw new BudgetExhaustedError(STOP_REASONS.TOOL_CALLS, snapshot());
      }
      const stop = checkStop();
      if (stop) throw new BudgetExhaustedError(stop, snapshot());
      toolCalls += 1;
      return toolCalls;
    },

    /** Account for generated tokens. Never throws: the tokens already exist. */
    chargeTokens(n) {
      const count = Number(n);
      if (Number.isFinite(count) && count > 0) outputTokens += count;
      return outputTokens;
    },

    /** Claim a repair attempt after a failed validation. */
    chargeRepair() {
      if (repairs >= profile.maxRepairAttempts) return false;
      repairs += 1;
      return true;
    },

    /** Claim capacity for `n` sub-agents; returns how many were granted. */
    chargeSubAgents(n) {
      const want = Math.max(0, Math.floor(Number(n) || 0));
      const granted = Math.min(want, Math.max(0, profile.maxSubAgents - subAgents));
      subAgents += granted;
      return granted;
    },

    /** Record a terminal outcome. The first one wins. */
    finish(reason) {
      if (!stoppedBecause) stoppedBecause = reason;
      return snapshot();
    },

    /**
     * Budget line for the model's context. Concrete numbers get better triage
     * than "you are running low".
     */
    describeRemaining() {
      const r = remaining();
      const mins = Math.floor(r.wallMs / 60_000);
      const secs = Math.floor((r.wallMs % 60_000) / 1000);
      const time = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      return `Budget remaining: ${time} of wall clock, ${r.iterations} iteration(s), `
        + `${r.toolCalls} tool call(s). Prioritise finishing the goal over exploring; `
        + 'if the budget will not cover everything, do the highest-value part and say what is left.';
    }
  };
}
