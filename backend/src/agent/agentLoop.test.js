import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { runAgent } from './agentLoop.js';
import { resolveEffort } from './effortProfiles.js';
import { createToolRegistry } from './tools.js';
import { STOP_REASONS } from './budget.js';

/** A scripted model: each entry is the next reply. Records what it was asked. */
function scriptedModel(replies) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fn: async ({ messages, purpose }) => {
      calls.push({ purpose, prompt: messages.map((m) => m.content).join('\n') });
      const next = i < replies.length ? replies[i] : replies[replies.length - 1];
      i += 1;
      return { text: typeof next === 'function' ? next(calls.length) : next, tokens: 10 };
    }
  };
}

const collect = () => { const events = []; return { events, onEvent: (e) => events.push(e) }; };

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-loop-'));
  await fs.writeFile(path.join(dir, 'answer.txt'), 'the answer is 42\n', 'utf8');
  return dir;
}

// ── the happy path ──────────────────────────────────────────────────────────

test('the agent uses a tool, then finishes, and validation passes', async () => {
  const dir = await sandbox();
  const model = scriptedModel([
    'A plan: read the file, report the answer.',
    '{"thought":"read it","action":"tool","tool":"read_file","args":{"path":"answer.txt"}}',
    '{"thought":"got it","action":"finish","summary":"The answer is 42."}',
    '{"pass": true, "reason": "the tool output shows 42"}'
  ]);
  const { events, onEvent } = collect();

  const out = await runAgent({
    goal: 'Find the answer in answer.txt',
    profile: resolveEffort('high'),
    registry: createToolRegistry({ fsRoot: dir }),
    callModel: model.fn,
    onEvent
  });

  assert.equal(out.ok, true);
  assert.equal(out.stopReason, STOP_REASONS.COMPLETED);
  assert.equal(out.validated, true);
  assert.match(out.answer, /42/);
  assert.equal(out.steps, 1);

  const types = events.map((e) => e.type);
  for (const expected of ['run-start', 'plan', 'iteration', 'tool-call', 'tool-result', 'finish-proposed', 'validation', 'run-end']) {
    assert.ok(types.includes(expected), `expected a ${expected} event, got ${types.join(', ')}`);
  }
});

test('the tool actually ran: its real output reaches the transcript', async () => {
  const dir = await sandbox();
  const model = scriptedModel([
    'plan',
    '{"action":"tool","tool":"read_file","args":{"path":"answer.txt"}}',
    '{"action":"finish","summary":"done"}',
    '{"pass":true}'
  ]);
  const out = await runAgent({
    goal: 'read it', profile: resolveEffort('high'),
    registry: createToolRegistry({ fsRoot: dir }), callModel: model.fn
  });
  assert.match(out.history[0].observation, /the answer is 42/,
    'the observation must be the real file contents, not a model hallucination');
});

// ── budget enforcement is the whole feature ────────────────────────────────

test('the iteration ceiling stops a model that never finishes', async () => {
  const dir = await sandbox();
  // A model stuck in a loop: it always asks for another tool call.
  const model = scriptedModel(['plan', '{"action":"tool","tool":"list_dir","args":{"path":"."}}']);
  const out = await runAgent({
    goal: 'loop forever',
    profile: resolveEffort('high', { maxIterations: 5 }),
    registry: createToolRegistry({ fsRoot: dir }),
    callModel: model.fn
  });
  assert.equal(out.stopReason, STOP_REASONS.ITERATIONS);
  assert.equal(out.budget.iterations, 5, 'must stop exactly at the ceiling');
  assert.equal(out.ok, false);
});

test('the tool-call ceiling is enforced independently of iterations', async () => {
  const dir = await sandbox();
  const model = scriptedModel(['plan', '{"action":"tool","tool":"list_dir","args":{"path":"."}}']);
  const out = await runAgent({
    goal: 'spend tools',
    profile: resolveEffort('high', { maxIterations: 50, maxToolCalls: 3 }),
    registry: createToolRegistry({ fsRoot: dir }),
    callModel: model.fn
  });
  assert.equal(out.stopReason, STOP_REASONS.TOOL_CALLS);
  assert.equal(out.budget.toolCalls, 3);
});

test('the wall clock stops a long run, using an injected clock', async () => {
  const dir = await sandbox();
  let t = 1_000_000;
  // Every model call advances the clock by five minutes.
  const model = {
    fn: async () => { t += 5 * 60_000; return { text: '{"action":"tool","tool":"list_dir","args":{"path":"."}}', tokens: 10 }; }
  };
  const out = await runAgent({
    goal: 'burn an hour',
    profile: resolveEffort('hour'),
    registry: createToolRegistry({ fsRoot: dir }),
    callModel: model.fn,
    now: () => t
  });
  assert.equal(out.stopReason, STOP_REASONS.WALL_CLOCK);
  assert.ok(out.budget.elapsedMs >= 60 * 60_000);
  assert.ok(out.budget.iterations < 80, 'the clock, not the iteration count, should have stopped it');
});

test('an abort stops the run promptly', async () => {
  const dir = await sandbox();
  const ac = new AbortController();
  let n = 0;
  const model = { fn: async () => { if (++n === 3) ac.abort(); return { text: '{"action":"tool","tool":"list_dir","args":{"path":"."}}', tokens: 5 }; } };
  const out = await runAgent({
    goal: 'stop me', profile: resolveEffort('session'),
    registry: createToolRegistry({ fsRoot: dir }), callModel: model.fn, signal: ac.signal
  });
  assert.equal(out.stopReason, STOP_REASONS.CANCELLED);
  assert.ok(out.budget.iterations < 10);
});

// ── running out of budget must still produce useful work ───────────────────

test('an exhausted budget still returns a salvaged answer, not an empty failure', async () => {
  const dir = await sandbox();
  let call = 0;
  const model = {
    fn: async ({ purpose }) => {
      call += 1;
      if (purpose === 'wrap-up') {
        return { text: 'I read answer.txt and established the answer is 42. I did not finish cross-checking.', tokens: 20 };
      }
      return { text: '{"action":"tool","tool":"read_file","args":{"path":"answer.txt"}}', tokens: 10 };
    }
  };
  const out = await runAgent({
    goal: 'exhaustive research',
    profile: resolveEffort('high', { maxIterations: 3 }),
    registry: createToolRegistry({ fsRoot: dir }),
    callModel: model.fn
  });
  assert.equal(out.stopReason, STOP_REASONS.ITERATIONS);
  assert.ok(out.answer.length > 0, 'an hour of work must not return an empty answer');
  assert.match(out.answer, /42/, 'the salvaged answer should carry what was actually established');
  assert.match(out.answer, /Stopped early|budget/i, 'and must be honest that it stopped early');
  void call;
});

// ── validation and repair ──────────────────────────────────────────────────

test('a failed validation triggers a repair that reaches the model', async () => {
  const dir = await sandbox();
  const replies = [
    'plan',
    '{"action":"finish","summary":"It is 41."}',
    '{"pass": false, "reason": "41 does not match the file, which says 42"}',
    '{"action":"finish","summary":"It is 42."}',
    '{"pass": true, "reason": "matches"}'
  ];
  const model = scriptedModel(replies);
  const { events, onEvent } = collect();

  const out = await runAgent({
    goal: 'state the answer', profile: resolveEffort('high'),
    registry: createToolRegistry({ fsRoot: dir }), callModel: model.fn, onEvent
  });

  assert.equal(out.validated, true);
  assert.match(out.answer, /42/);
  assert.ok(events.some((e) => e.type === 'repair'), 'a repair event should have been emitted');

  const repairPrompt = model.calls.find((c) => c.prompt.includes('validation pass rejected'));
  assert.ok(repairPrompt, 'the critique must be fed back into the next decision');
  assert.match(repairPrompt.prompt, /41 does not match/);
});

test('repairs are capped, and the answer says so instead of looping', async () => {
  const dir = await sandbox();
  // Keyed on purpose rather than call order: the agent always proposes a
  // finish, and the validator always rejects it, so the only thing that can
  // stop this run is the repair cap.
  const model = {
    fn: async ({ purpose }) => {
      if (purpose === 'validate') return { text: '{"pass": false, "reason": "not good enough"}', tokens: 5 };
      if (purpose === 'decide') return { text: '{"action":"finish","summary":"maybe"}', tokens: 5 };
      return { text: 'plan', tokens: 5 };
    }
  };
  const out = await runAgent({
    goal: 'never satisfy the validator',
    profile: resolveEffort('high', { maxRepairAttempts: 2 }),
    registry: createToolRegistry({ fsRoot: dir }),
    callModel: model.fn
  });
  assert.equal(out.budget.repairs, 2, 'should use exactly the allowed repairs');
  assert.match(out.answer, /Validation did not pass/);
});

test('validation is skipped when the profile does not ask for it', async () => {
  const dir = await sandbox();
  const model = scriptedModel(['{"action":"finish","summary":"quick answer"}']);
  const out = await runAgent({
    goal: 'be quick',
    profile: resolveEffort('high', { plan: false, validate: false }),
    registry: createToolRegistry({ fsRoot: dir }),
    callModel: model.fn
  });
  assert.equal(out.ok, true);
  assert.equal(out.validated, false);
  assert.equal(out.answer, 'quick answer');
  assert.ok(!model.calls.some((c) => c.purpose === 'validate'));
});

// ── robustness ─────────────────────────────────────────────────────────────

test('an unparseable reply is corrected in-band and still costs an iteration', async () => {
  const dir = await sandbox();
  const model = scriptedModel([
    'plan',
    'I think I should look at the files first.',        // no JSON
    '{"action":"finish","summary":"recovered"}',
    '{"pass":true}'
  ]);
  const { events, onEvent } = collect();
  const out = await runAgent({
    goal: 'recover from a bad reply', profile: resolveEffort('high'),
    registry: createToolRegistry({ fsRoot: dir }), callModel: model.fn, onEvent
  });
  assert.equal(out.ok, true);
  assert.equal(out.answer, 'recovered');
  assert.ok(events.some((e) => e.type === 'invalid-action'));
});

test('a model that only ever emits garbage terminates instead of spinning', async () => {
  const dir = await sandbox();
  const model = scriptedModel(['plan', 'no json here, ever']);
  const out = await runAgent({
    goal: 'never comply',
    profile: resolveEffort('high', { maxIterations: 4 }),
    registry: createToolRegistry({ fsRoot: dir }),
    callModel: model.fn
  });
  assert.equal(out.stopReason, STOP_REASONS.ITERATIONS);
  assert.equal(out.budget.iterations, 4);
});

test('a refused tool becomes an observation the agent can react to', async () => {
  const dir = await sandbox();
  const model = scriptedModel([
    'plan',
    '{"action":"tool","tool":"run_command","args":{"command":"echo hi"}}',  // not permitted read-only
    '{"action":"finish","summary":"could not run commands"}',
    '{"pass":true}'
  ]);
  const out = await runAgent({
    goal: 'try to exceed policy', profile: resolveEffort('high'),
    registry: createToolRegistry({ policy: 'read-only', fsRoot: dir }), callModel: model.fn
  });
  assert.match(out.history[0].observation, /ERROR.*not permitted/);
  assert.equal(out.ok, true);
});

test('a thrown model error is reported as a failed run, not an unhandled rejection', async () => {
  const dir = await sandbox();
  const model = { fn: async () => { throw new Error('engine died'); } };
  const out = await runAgent({
    goal: 'break', profile: resolveEffort('high'),
    registry: createToolRegistry({ fsRoot: dir }), callModel: model.fn
  });
  assert.equal(out.ok, false);
  assert.equal(out.stopReason, STOP_REASONS.FAILED);
  assert.match(out.error, /engine died/);
});

test('the model is told concretely how much budget remains', async () => {
  const dir = await sandbox();
  const model = scriptedModel(['plan', '{"action":"finish","summary":"ok"}', '{"pass":true}']);
  await runAgent({
    goal: 'check the prompt', profile: resolveEffort('hour'),
    registry: createToolRegistry({ fsRoot: dir }), callModel: model.fn
  });
  const decide = model.calls.find((c) => c.purpose === 'decide');
  assert.match(decide.prompt, /Budget remaining/);
  assert.match(decide.prompt, /iteration\(s\)/);
});
