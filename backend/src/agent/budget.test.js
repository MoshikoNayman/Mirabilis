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

test('child spend is added on every axis and never throws', () => {
  // The children already spent it, so the charge-back must land even past a ceiling.
  const b = createBudget(resolveEffort('high', { maxToolCalls: 2 }));
  b.chargeToolCall();
  b.chargeToolCall();
  assert.doesNotThrow(() => b.chargeChildSpend({ toolCalls: 5, iterations: 4, outputTokens: 100 }));
  const counts = () => {
    const s = b.snapshot();
    return { toolCalls: s.toolCalls, iterations: s.iterations, outputTokens: s.outputTokens };
  };
  assert.deepEqual(counts(), { toolCalls: 7, iterations: 4, outputTokens: 100 });
  assert.equal(b.checkStop(), STOP_REASONS.TOOL_CALLS);

  b.chargeChildSpend({ toolCalls: -3, iterations: NaN });
  assert.deepEqual(counts(), { toolCalls: 7, iterations: 4, outputTokens: 100 }, 'nonsense spend changes nothing');
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

// overrides may only ever reduce the budget

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

test('count overrides are whole numbers and only lower', () => {
  assert.equal(resolveEffort('ultra', { maxSubAgents: 2.7 }).maxSubAgents, 2);
  assert.equal(resolveEffort('ultra', { maxSubAgents: 0.5 }).maxSubAgents, 0,
    'half an agent is none, not a grant that runs nothing and defers every task');
  assert.equal(resolveEffort('hour', { maxSubAgents: 99 }).maxSubAgents, 3);
  assert.equal(resolveEffort('ultra', { maxSubAgents: -1 }).maxSubAgents, 8);
  assert.equal(resolveEffort('ultra', /** @type {any} */ ({ maxSubAgents: '3' })).maxSubAgents, 3);
  assert.equal(resolveEffort('high', { maxIterations: 3.9 }).maxIterations, 3);
});

test('Ultra can be switched off by a caller but never on', () => {
  assert.notEqual(resolveEffort('hour', { ultra: true }).ultra, true,
    'a request argument must not turn another tier into Ultra');
  assert.equal(resolveEffort('ultra', { ultra: false }).ultra, false);
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

test('Ultra is an agentic tier between 1 hour and 5 hours with up to 8 agents', () => {
  const p = EFFORT_PROFILES.ultra;
  for (const key of ['agentic', 'plan', 'validate', 'ultra']) assert.equal(p[key], true, key);
  assert.equal(p.maxSubAgents, 8);
  assert.equal(p.maxWallMs, 2 * 60 * 60_000);
  assert.equal(EFFORT_ORDER.indexOf('ultra'), EFFORT_ORDER.indexOf('hour') + 1);
  assert.equal(EFFORT_ORDER.indexOf('ultra'), EFFORT_ORDER.indexOf('session') - 1);
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

// waiting for a user approval must not burn the work budget

test('pauseWhile excludes the awaited time from elapsed', async () => {
  const clock = fakeClock();
  const b = createBudget(resolveEffort('hour'), { now: clock.now });
  clock.advance(60_000); // one minute of real work
  assert.equal(b.elapsed(), 60_000);

  // Wait ten minutes for the user; the clock advances while the promise is pending.
  let release;
  const gate = b.pauseWhile(new Promise((resolve) => { release = resolve; }));
  clock.advance(10 * 60_000);
  release('allow');
  assert.equal(await gate, 'allow');
  assert.equal(b.elapsed(), 60_000, 'the ten paused minutes are not charged');

  clock.advance(60_000);
  assert.equal(b.elapsed(), 120_000, 'the clock runs again after the pause');
});

test('a pause keeps a run from exhausting its wall clock while it waits', async () => {
  const clock = fakeClock();
  const b = createBudget(resolveEffort('high', { maxWallMs: 5 * 60_000 }), { now: clock.now });
  let release;
  const gate = b.pauseWhile(new Promise((resolve) => { release = resolve; }));
  clock.advance(60 * 60_000); // an hour waiting for the user
  release(null);
  await gate;
  assert.equal(b.canContinue(), true, 'an hour of waiting did not spend a five minute budget');
});

test('elapsed accounts for a pause still in progress', async () => {
  const clock = fakeClock();
  const b = createBudget(resolveEffort('hour'), { now: clock.now });
  let release;
  const pending = b.pauseWhile(new Promise((resolve) => { release = resolve; }));
  clock.advance(5 * 60_000); // time passes while still waiting
  assert.equal(b.elapsed(), 0, 'an ongoing pause is subtracted immediately');
  release(null);
  await pending;
  assert.equal(b.elapsed(), 0);
});

test('concurrent pauses resume the clock only once all have settled', async () => {
  const clock = fakeClock();
  const b = createBudget(resolveEffort('hour'), { now: clock.now });
  let r1; let r2;
  const p1 = b.pauseWhile(new Promise((res) => { r1 = res; }));
  const p2 = b.pauseWhile(new Promise((res) => { r2 = res; }));
  clock.advance(2 * 60_000);
  r1(null); await p1;
  clock.advance(3 * 60_000); // still paused by p2
  r2(null); await p2;
  assert.equal(b.elapsed(), 0, 'no time is charged until the last pause ends');
  clock.advance(60_000);
  assert.equal(b.elapsed(), 60_000);
});
