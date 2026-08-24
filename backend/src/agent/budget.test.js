import test from 'node:test';
import assert from 'node:assert/strict';

import { createBudget, BudgetExhaustedError, STOP_REASONS } from './budget.js';
import { resolveEffort, EFFORT_PROFILES, EFFORT_ORDER } from './effortProfiles.js';

/** A clock the test drives by hand, so an hour-long tier costs no wall time. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('a fresh budget permits work and reports its headroom', () => {
  const b = createBudget(resolveEffort('high'));
  assert.equal(b.canContinue(), true);
  assert.equal(b.checkStop(), null);
  assert.equal(b.remaining().iterations, EFFORT_PROFILES.high.maxIterations);
});

test('iterations are capped', () => {
  const profile = resolveEffort('high', { maxIterations: 3 });
  const b = createBudget(profile);
  for (let i = 1; i <= 3; i += 1) assert.equal(b.beginIteration(), i);
  assert.throws(() => b.beginIteration(), BudgetExhaustedError);
  assert.equal(b.checkStop(), STOP_REASONS.ITERATIONS);
});

test('tool calls are charged BEFORE the call, so the ceiling cannot be overshot', () => {
  const b = createBudget(resolveEffort('high', { maxToolCalls: 2 }));
  b.chargeToolCall();
  b.chargeToolCall();
  assert.throws(() => b.chargeToolCall(), BudgetExhaustedError);
  assert.equal(b.snapshot().toolCalls, 2, 'must never record more calls than the limit');
});

test('a non-agentic profile refuses tool calls outright', () => {
  const b = createBudget(resolveEffort('balanced'));
  assert.throws(() => b.chargeToolCall(), BudgetExhaustedError);
});

test('wall clock stops the run even with every other axis untouched', () => {
  const clock = fakeClock();
  const b = createBudget(resolveEffort('hour'), { now: clock.now });
  assert.equal(b.canContinue(), true);
  clock.advance(59 * 60_000);
  assert.equal(b.canContinue(), true, '59 minutes into an hour there should still be room');
  clock.advance(2 * 60_000);
  assert.equal(b.canContinue(), false);
  assert.equal(b.checkStop(), STOP_REASONS.WALL_CLOCK);
  assert.throws(() => b.beginIteration(), BudgetExhaustedError);
});

test('the five hour tier really is five hours', () => {
  const clock = fakeClock();
  const b = createBudget(resolveEffort('session'), { now: clock.now });
  clock.advance(4 * 60 * 60_000 + 59 * 60_000);
  assert.equal(b.canContinue(), true, 'must still be running at 4h59m');
  clock.advance(2 * 60_000);
  assert.equal(b.checkStop(), STOP_REASONS.WALL_CLOCK);
});

test('token spend stops the run', () => {
  const b = createBudget(resolveEffort('high', { maxOutputTokens: 100 }));
  b.chargeTokens(60);
  assert.equal(b.canContinue(), true);
  b.chargeTokens(60);
  assert.equal(b.checkStop(), STOP_REASONS.TOKENS);
});

test('an abort signal cancels immediately, ahead of every other limit', () => {
  const ac = new AbortController();
  const b = createBudget(resolveEffort('session'), { signal: ac.signal });
  assert.equal(b.canContinue(), true);
  ac.abort();
  assert.equal(b.checkStop(), STOP_REASONS.CANCELLED);
  assert.throws(() => b.beginIteration(), BudgetExhaustedError);
});

test('repairs and sub-agents are capped, and grants are partial rather than over-issued', () => {
  const b = createBudget(resolveEffort('hour')); // 4 repairs, 3 sub-agents
  for (let i = 0; i < 4; i += 1) assert.equal(b.chargeRepair(), true);
  assert.equal(b.chargeRepair(), false, 'the fifth repair must be refused');

  assert.equal(b.chargeSubAgents(2), 2);
  assert.equal(b.chargeSubAgents(5), 1, 'should grant only the one remaining slot');
  assert.equal(b.chargeSubAgents(1), 0);
});

test('the first terminal reason wins and is reported in the snapshot', () => {
  const b = createBudget(resolveEffort('high'));
  b.finish(STOP_REASONS.COMPLETED);
  b.finish(STOP_REASONS.FAILED);
  assert.equal(b.snapshot().stoppedBecause, STOP_REASONS.COMPLETED);
});

test('the remaining-budget line is concrete enough to triage against', () => {
  const clock = fakeClock();
  const b = createBudget(resolveEffort('hour'), { now: clock.now });
  clock.advance(30 * 60_000);
  const text = b.describeRemaining();
  assert.match(text, /29m|30m/, 'should state the real time left');
  assert.match(text, /iteration/);
  assert.match(text, /tool call/);
});

// ── overrides may only ever reduce the budget ───────────────────────────────

test('overrides can lower a budget but never raise it', () => {
  const lowered = resolveEffort('high', { maxIterations: 2 });
  assert.equal(lowered.maxIterations, 2);

  const inflated = resolveEffort('high', { maxIterations: 10_000, maxWallMs: 99 * 60 * 60_000 });
  assert.equal(inflated.maxIterations, EFFORT_PROFILES.high.maxIterations,
    'a client must not be able to request more work than the tier allows');
  assert.equal(inflated.maxWallMs, EFFORT_PROFILES.high.maxWallMs);
});

test('agentic can be switched off by a caller but never on', () => {
  assert.equal(resolveEffort('high', { agentic: false }).agentic, false);
  assert.equal(resolveEffort('balanced', { agentic: true }).agentic, false,
    'a non-agentic tier must not be upgraded into one by a request argument');
});

test('garbage input falls back to the default profile', () => {
  for (const bad of [undefined, null, '', 'not-a-tier', 42]) {
    assert.equal(resolveEffort(/** @type {any} */ (bad)).id, 'balanced');
  }
});

test('every listed tier exists and budgets increase monotonically across them', () => {
  let prevWall = -1;
  for (const id of EFFORT_ORDER) {
    const p = EFFORT_PROFILES[id];
    assert.ok(p, `${id} should be a real profile`);
    assert.ok(p.maxWallMs > prevWall, `${id} should allow more wall clock than the tier below it`);
    prevWall = p.maxWallMs;
  }
});

test('only the agentic tiers may use tools or sub-agents', () => {
  for (const id of EFFORT_ORDER) {
    const p = EFFORT_PROFILES[id];
    if (!p.agentic) {
      assert.equal(p.maxToolCalls, 0, `${id} is non-agentic and must not have a tool budget`);
      assert.equal(p.maxSubAgents, 0, `${id} is non-agentic and must not fan out`);
    } else {
      assert.ok(p.maxToolCalls > 0, `${id} is agentic and needs a tool budget`);
    }
  }
});
