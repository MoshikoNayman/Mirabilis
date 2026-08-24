import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { runAgent } from './agentLoop.js';
import { resolveEffort } from './effortProfiles.js';
import { createToolRegistry } from './tools.js';

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-fanout-'));
  await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\n', 'utf8');
  return dir;
}

/**
 * A model that fans out once, then finishes. Sub-agents immediately finish with
 * a per-goal answer so the test measures the fan-out, not the sub-agent.
 */
function fanoutModel(tasks) {
  const seen = { fanout: 0, subGoals: [] };
  // Match the goal HEADER, not a loose substring. The parent's later prompts
  // quote the sub-results, so `prompt.includes(task)` would count those too.
  const subGoalOf = (prompt) => tasks.find((t) => prompt.includes(`Goal:\n${t}`));
  return {
    seen,
    fn: async ({ messages, purpose }) => {
      const prompt = messages.map((m) => m.content).join('\n');
      if (purpose === 'validate') return { text: '{"pass":true}', tokens: 5 };
      if (purpose === 'plan') return { text: 'split the work', tokens: 5 };

      const sub = subGoalOf(prompt);
      if (sub) {
        if (!seen.subGoals.includes(sub)) seen.subGoals.push(sub);
        return { text: JSON.stringify({ action: 'finish', summary: `did: ${sub}` }), tokens: 8 };
      }
      // The parent: fan out once, then report.
      if (prompt.includes('spawn_agents') && seen.fanout === 0) {
        seen.fanout += 1;
        return {
          text: JSON.stringify({ action: 'tool', tool: 'spawn_agents', args: { tasks: tasks.map((g) => ({ goal: g })) } }),
          tokens: 10
        };
      }
      return { text: '{"action":"finish","summary":"synthesised the sub-agent results"}', tokens: 10 };
    }
  };
}

const run = async (dir, model, profile, onEvent) => runAgent({
  goal: 'audit three things',
  profile,
  registry: createToolRegistry({ fsRoot: dir }),
  makeRegistry: () => createToolRegistry({ fsRoot: dir }),
  callModel: model.fn,
  onEvent
});

test('fan-out runs every sub-task and returns their answers to the parent', async () => {
  const dir = await sandbox();
  const tasks = ['check alpha', 'check beta', 'check gamma'];
  const model = fanoutModel(tasks);
  const events = [];

  const out = await run(dir, model, resolveEffort('hour'), (e) => events.push(e));

  assert.equal(out.ok, true);
  assert.equal(model.seen.fanout, 1);
  assert.deepEqual(model.seen.subGoals.sort(), tasks.slice().sort(), 'every sub-task should have run');

  const fanTool = out.history.find((h) => h.tool === 'spawn_agents');
  assert.ok(fanTool, 'the fan-out should appear in the parent transcript');
  const observed = JSON.parse(fanTool.observation);
  assert.equal(observed.spawned, 3);
  assert.equal(observed.results.length, 3);
  for (const r of observed.results) assert.match(r.answer, /^did: check/);

  assert.ok(events.some((e) => e.type === 'fanout-start'));
  assert.ok(events.some((e) => e.type === 'fanout-end'));
});

test('sub-agents run in parallel, not one after another', async () => {
  const dir = await sandbox();
  const tasks = ['task one', 'task two', 'task three'];
  let inFlight = 0;
  let peak = 0;
  const model = {
    fn: async ({ messages, purpose }) => {
      const prompt = messages.map((m) => m.content).join('\n');
      if (purpose === 'validate') return { text: '{"pass":true}', tokens: 5 };
      if (purpose === 'plan') return { text: 'p', tokens: 5 };
      const sub = tasks.find((t) => prompt.includes(`Goal:\n${t}`));
      if (sub) {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 40));
        inFlight -= 1;
        return { text: JSON.stringify({ action: 'finish', summary: sub }), tokens: 5 };
      }
      if (prompt.includes('spawn_agents') && !prompt.includes('did:')) {
        return { text: JSON.stringify({ action: 'tool', tool: 'spawn_agents', args: { tasks } }), tokens: 5 };
      }
      return { text: '{"action":"finish","summary":"done"}', tokens: 5 };
    }
  };
  await run(dir, model, resolveEffort('hour'));
  assert.ok(peak >= 2, `expected concurrent sub-agents, peak was ${peak}`);
});

// ── the budget rules that stop fan-out being an escape hatch ───────────────

test('the sub-agent cap is enforced and the surplus is reported as deferred', async () => {
  const dir = await sandbox();
  // 'hour' allows 3 sub-agents; ask for 5.
  const tasks = ['t1', 't2', 't3', 't4', 't5'];
  const model = fanoutModel(tasks);
  const out = await run(dir, model, resolveEffort('hour'));

  const observed = JSON.parse(out.history.find((h) => h.tool === 'spawn_agents').observation);
  assert.equal(observed.spawned, 3, 'must not exceed the tier cap');
  assert.equal(observed.deferred.length, 2, 'the rest should be reported, not silently dropped');
  assert.equal(out.budget.subAgents, 3);
});

test('sub-agent spend is charged back to the parent budget', async () => {
  const dir = await sandbox();
  // Distinct names: a task called 'a' would prefix-match the parent's own
  // "Goal:\naudit three things" header and be mistaken for a sub-agent.
  const tasks = ['inspect the alpha module', 'inspect the beta module'];
  const model = fanoutModel(tasks);
  const out = await run(dir, model, resolveEffort('hour'));

  const observed = JSON.parse(out.history.find((h) => h.tool === 'spawn_agents').observation);
  assert.ok(observed.spent.tokens > 0, 'children burned tokens');
  // The parent's own generation plus everything the children spent.
  assert.ok(out.budget.outputTokens >= observed.spent.tokens,
    'delegating must not let a run escape its own token ceiling');
});

test('a tier with no sub-agent allowance does not even offer the tool', async () => {
  const dir = await sandbox();
  const registry = createToolRegistry({ fsRoot: dir });
  const model = { fn: async () => ({ text: '{"action":"finish","summary":"x"}', tokens: 5 }) };
  await runAgent({
    goal: 'g',
    profile: resolveEffort('high'), // maxSubAgents: 0
    registry,
    makeRegistry: () => createToolRegistry({ fsRoot: dir }),
    callModel: model.fn
  });
  assert.ok(!registry.has('spawn_agents'), 'high effort must not expose fan-out');
});

test('sub-agents cannot spawn their own sub-agents', async () => {
  const dir = await sandbox();
  const registries = [];
  const tasks = ['deep one', 'deep two'];
  const model = fanoutModel(tasks);
  await runAgent({
    goal: 'g',
    profile: resolveEffort('session'),
    registry: createToolRegistry({ fsRoot: dir }),
    makeRegistry: () => { const r = createToolRegistry({ fsRoot: dir }); registries.push(r); return r; },
    callModel: model.fn
  });
  assert.ok(registries.length >= 2, 'sub-agents should have been given registries');
  for (const r of registries) {
    assert.ok(!r.has('spawn_agents'), 'a sub-agent must never receive the spawn tool: no recursion');
  }
});

test('fewer than two tasks is refused with a usable message', async () => {
  const dir = await sandbox();
  const model = {
    fn: async ({ messages, purpose }) => {
      const prompt = messages.map((m) => m.content).join('\n');
      if (purpose === 'validate') return { text: '{"pass":true}', tokens: 5 };
      if (purpose === 'plan') return { text: 'p', tokens: 5 };
      if (!prompt.includes('at least 2')) {
        return { text: JSON.stringify({ action: 'tool', tool: 'spawn_agents', args: { tasks: [{ goal: 'only one' }] } }), tokens: 5 };
      }
      return { text: '{"action":"finish","summary":"did it myself"}', tokens: 5 };
    }
  };
  const out = await run(dir, model, resolveEffort('hour'));
  assert.match(out.history[0].observation, /at least 2/);
  assert.equal(out.ok, true, 'the parent should recover and finish itself');
});

test('a sub-agent that fails does not sink the whole fan-out', async () => {
  const dir = await sandbox();
  const tasks = ['good task', 'bad task'];
  const model = {
    fn: async ({ messages, purpose }) => {
      const prompt = messages.map((m) => m.content).join('\n');
      if (purpose === 'validate') return { text: '{"pass":true}', tokens: 5 };
      if (purpose === 'plan') return { text: 'p', tokens: 5 };
      if (prompt.includes('Goal:\nbad task')) throw new Error('sub-agent engine died');
      if (prompt.includes('Goal:\ngood task')) return { text: '{"action":"finish","summary":"good result"}', tokens: 5 };
      if (prompt.includes('spawn_agents') && !prompt.includes('good result')) {
        return { text: JSON.stringify({ action: 'tool', tool: 'spawn_agents', args: { tasks } }), tokens: 5 };
      }
      return { text: '{"action":"finish","summary":"partial synthesis"}', tokens: 5 };
    }
  };
  const out = await run(dir, model, resolveEffort('hour'));
  const observed = JSON.parse(out.history.find((h) => h.tool === 'spawn_agents').observation);
  assert.equal(observed.results.length, 2);
  assert.ok(observed.results.some((r) => r.ok), 'the healthy sub-agent should still report');
  assert.ok(observed.results.some((r) => !r.ok), 'the failed one should be reported as failed');
  assert.equal(out.ok, true, 'the parent should still complete');
});

test('fan-out concurrency is capped so a weak machine is not stampeded', async () => {
  // Sub-agents share one local engine. Firing all six at once does not make
  // them faster (Ollama serialises per model) but does hold six live contexts,
  // which is how a 16 GB laptop ends up in swap.
  const dir = await sandbox();
  const tasks = ['task alpha', 'task bravo', 'task charlie', 'task delta', 'task echo', 'task foxtrot'];
  let inFlight = 0;
  let peak = 0;
  const model = {
    fn: async ({ messages, purpose }) => {
      const prompt = messages.map((m) => m.content).join('\n');
      if (purpose === 'validate') return { text: '{"pass":true}', tokens: 5 };
      if (purpose === 'plan') return { text: 'p', tokens: 5 };
      const sub = tasks.find((t) => prompt.includes(`Goal:\n${t}`));
      if (sub) {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return { text: JSON.stringify({ action: 'finish', summary: sub }), tokens: 5 };
      }
      if (prompt.includes('spawn_agents') && !prompt.includes('did:')) {
        return { text: JSON.stringify({ action: 'tool', tool: 'spawn_agents', args: { tasks } }), tokens: 5 };
      }
      return { text: '{"action":"finish","summary":"done"}', tokens: 5 };
    }
  };

  const out = await runAgent({
    goal: 'audit six things',
    profile: resolveEffort('session'),   // allows 6 sub-agents
    registry: createToolRegistry({ fsRoot: dir }),
    makeRegistry: () => createToolRegistry({ fsRoot: dir }),
    callModel: model.fn
  });

  const observed = JSON.parse(out.history.find((h) => h.tool === 'spawn_agents').observation);
  assert.equal(observed.spawned, 6, 'all six should still run');
  assert.ok(peak <= 2, `at most 2 should be mid-generation at once, peak was ${peak}`);
  assert.ok(peak >= 2, `they should still overlap rather than run one at a time, peak was ${peak}`);
});
