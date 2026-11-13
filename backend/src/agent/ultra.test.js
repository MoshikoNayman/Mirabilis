// Ultra: code splits the goal, runs one agent per part on the shared budget, checks
// every result by trying to refute it, and the lead merges.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { runAgent } from './agentLoop.js';
import { resolveEffort } from './effortProfiles.js';
import { createToolRegistry } from './tools.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-ultra-'));
  dirs.push(dir);
  return dir;
}

const FINISH_MERGED = '{"action":"finish","summary":"merged"}';

/**
 * A model keyed on purpose. The split call returns `split` (text, or a function that
 * may throw); an agent is known by its goal header and finishes "did: <part>"; any
 * other decide goes to `lead`. Every call is recorded with its reply. With `overlapMs`,
 * each agent step takes that long, so `peak()` shows how many ran at once.
 */
function ultraModel({ parts = [], split, agentAnswer = (part) => `did: ${part}`, lead = () => FINISH_MERGED, overlapMs = 0 } = {}) {
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  const reply = (call, text) => { call.reply = text; return { text, tokens: 10 }; };
  const fn = async ({ messages, purpose, timeoutMs }) => {
    const call = { purpose, timeoutMs, prompt: messages.map((m) => m.content).join('\n'), reply: '' };
    calls.push(call);
    if (purpose === 'split') {
      return reply(call, typeof split === 'function' ? split() : (split ?? JSON.stringify({ parts })));
    }
    if (purpose === 'validate') return reply(call, '{"pass":true}');
    if (purpose === 'plan') return reply(call, 'plan the work');
    const part = parts.find((p) => call.prompt.includes(`Goal:\n${p}`));
    if (part) {
      if (overlapMs) {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, overlapMs));
        inFlight -= 1;
      }
      return reply(call, JSON.stringify({ action: 'finish', summary: agentAnswer(part) }));
    }
    return reply(call, lead(calls));
  };
  return { calls, fn, peak: () => peak };
}

/** The lead's own decide calls: the ones no agent made. */
const leadDecides = (calls, parts) => calls.filter((c) => c.purpose === 'decide'
  && !parts.some((p) => c.prompt.includes(`Goal:\n${p}`)));

async function runUltra({ goal, model, profile = resolveEffort('ultra'), level, signal, onEvent, makeRegistry, now }) {
  const dir = await sandbox();
  const registry = createToolRegistry({ level, fsRoot: dir });
  const out = await runAgent({
    goal, profile, registry, signal, onEvent, now,
    makeRegistry: makeRegistry || (() => createToolRegistry({ level, fsRoot: dir })),
    callModel: model.fn
  });
  return { out, registry };
}

test('Ultra splits the goal in code and fans out without the model asking', async () => {
  const parts = ['count the source files', 'read the version file', 'list the open issues'];
  const model = ultraModel({ parts, overlapMs: 30 });
  const events = [];
  const { out } = await runUltra({ goal: 'audit the release', model, onEvent: (e) => events.push(e) });

  assert.equal(out.ok, true);
  // No concurrency passed, as on a local engine: two at a time.
  assert.equal(model.peak(), 2, `the agents should overlap, two at a time; peak was ${model.peak()}`);
  assert.equal(out.validated, true);
  assert.equal(out.answer, 'merged');
  assert.equal(out.history[0].tool, 'spawn_agents');
  const observed = JSON.parse(out.history[0].observation);
  assert.equal(observed.spawned, 3);
  assert.deepEqual(observed.results.map((r) => r.answer).sort(), parts.map((p) => `did: ${p}`).sort());

  assert.ok(!model.calls.some((c) => c.purpose === 'plan'), 'the parts are the plan');
  assert.ok(!model.calls.some((c) => c.purpose === 'decide' && c.reply.includes('spawn_agents')),
    'code fans out; the model never asked to');
  const lead = events.filter((e) => e.subAgent === undefined);
  assert.ok(lead.some((e) => e.type === 'phase' && e.phase === 'split'));
  assert.ok(lead.some((e) => e.type === 'split' && e.count === 3));
  assert.ok(lead.some((e) => e.type === 'fanout-start' && e.count === 3));
});

test('Ultra runs solo when the split has fewer than two parts', async () => {
  const replies = [
    () => '{"parts":[]}',
    () => '{"parts":["do the one thing"]}',
    () => 'cannot split this',
    () => { throw new Error('engine hiccup'); }
  ];
  for (const split of replies) {
    const model = ultraModel({ split });
    const events = [];
    const { out } = await runUltra({ goal: 'a small goal', model, onEvent: (e) => events.push(e) });
    const label = String(split);
    assert.ok(!events.some((e) => e.type === 'fanout-start'), `no fan-out for ${label}`);
    assert.ok(events.find((e) => e.type === 'split').count <= 1, label);
    assert.equal(model.calls.filter((c) => c.purpose === 'plan').length, 1, `the normal plan runs for ${label}`);
    assert.equal(out.ok, true, label);
  }
});

test('Ultra with one agent makes no split call', async () => {
  const model = ultraModel({ parts: ['first half', 'second half'] });
  const { out, registry } = await runUltra({
    goal: 'work alone', model, profile: resolveEffort('ultra', { maxSubAgents: 0 })
  });
  assert.ok(!model.calls.some((c) => c.purpose === 'split'));
  assert.equal(registry.has('spawn_agents'), false);
  assert.equal(out.ok, true);
});

test('more parts than agents fold into the allowed number', async () => {
  const parts = ['check alpha', 'check bravo', 'check charlie', 'check delta'];
  const model = ultraModel({ parts });
  const events = [];
  const { out } = await runUltra({
    goal: 'check four things', model, profile: resolveEffort('ultra', { maxSubAgents: 2 }),
    onEvent: (e) => events.push(e)
  });
  assert.equal(JSON.parse(out.history[0].observation).spawned, 2);
  const start = events.find((e) => e.type === 'fanout-start');
  assert.equal(start.agents.length, 2);
  for (const agent of start.agents) assert.match(agent.goal, /^Also: /m, 'no part is dropped');
});

test('Ultra in Chat only still splits, and its agents get no tools', async () => {
  const parts = ['explain the first idea', 'explain the second idea'];
  const model = ultraModel({ parts });
  const children = [];
  const dir = await sandbox();
  const events = [];
  const { out, registry } = await runUltra({
    goal: 'explain two ideas', model, level: 'chat', onEvent: (e) => events.push(e),
    makeRegistry: () => {
      const r = createToolRegistry({ level: 'chat', fsRoot: dir });
      children.push(r);
      return r;
    }
  });
  assert.equal(out.ok, true);
  assert.ok(events.some((e) => e.type === 'fanout-start'));
  assert.equal(registry.has('spawn_agents'), false, 'the model is never offered the tool in Chat only');
  assert.equal(children.length, 2);
  for (const r of children) assert.deepEqual(r.names(), []);
  const checks = model.calls.filter((c) => c.purpose === 'validate');
  assert.equal(checks.length, 3, 'each agent and the lead were checked');
  for (const c of checks) {
    assert.match(c.prompt, /judge the reasoning itself/);
    assert.match(c.prompt, /Missing evidence alone is no reason to fail it/);
    assert.ok(!c.prompt.includes('Claims that no tool result supports'), 'no tool evidence is asked for');
  }
  // An agent with nothing done gets no empty work log to fail it on; the lead keeps the agent results.
  const empty = checks.filter((c) => !c.prompt.includes('Work performed'));
  assert.equal(empty.length, 2, 'both agents were judged on their answer alone');
  assert.ok(checks.some((c) => c.prompt.includes('Work performed') && c.prompt.includes('spawn_agents')));
});

test('every agent result reaches the lead whole', async () => {
  const parts = ['survey part one', 'survey part two', 'survey part three', 'survey part four'];
  const marker = (part) => `MARK-${parts.indexOf(part)}-END`;
  const model = ultraModel({ parts, agentAnswer: (part) => `${marker(part)} ${'y'.repeat(5000)}` });
  const { out } = await runUltra({ goal: 'survey four parts', model });

  const observed = JSON.parse(out.history[0].observation);
  assert.equal(observed.results.length, 4);
  for (const r of observed.results) {
    assert.ok(r.answer.length <= 2000, `an answer of ${r.answer.length} chars`);
    assert.equal(typeof r.validated, 'boolean');
  }
  const [firstMerge] = leadDecides(model.calls, parts);
  for (const part of parts) assert.ok(firstMerge.prompt.includes(marker(part)), `${part} reached the lead`);
});

test('Ultra checks try to refute and other tiers do not', async () => {
  const parts = ['verify the first claim', 'verify the second claim'];
  const ultra = ultraModel({ parts });
  await runUltra({ goal: 'verify two claims', model: ultra });
  const ultraChecks = ultra.calls.filter((c) => c.purpose === 'validate');
  assert.equal(ultraChecks.length, 3);
  for (const c of ultraChecks) assert.match(c.prompt, /Try to refute it first/);

  // 1 hour: the model fans out itself, and no check is asked to refute.
  let fanned = false;
  const hour = ultraModel({
    parts,
    lead: () => {
      if (fanned) return FINISH_MERGED;
      fanned = true;
      return JSON.stringify({ action: 'tool', tool: 'spawn_agents', args: { tasks: parts.map((goal) => ({ goal })) } });
    }
  });
  const events = [];
  await runUltra({ goal: 'verify two claims', model: hour, profile: resolveEffort('hour'), onEvent: (e) => events.push(e) });
  assert.ok(events.some((e) => e.type === 'fanout-start'), 'the hour run fanned out');
  const hourChecks = hour.calls.filter((c) => c.purpose === 'validate');
  assert.equal(hourChecks.length, 3);
  for (const c of hourChecks) assert.ok(!c.prompt.includes('Try to refute it first'));
});

test('a stop after the agents finish keeps their results', async () => {
  const parts = ['gather the first facts', 'gather the second facts'];
  const ac = new AbortController();
  const model = ultraModel({
    parts,
    lead: () => {
      ac.abort();
      return '{"action":"tool","tool":"list_dir","args":{"path":"."}}';
    }
  });
  const { out } = await runUltra({ goal: 'gather facts', model, signal: ac.signal });
  assert.equal(out.stopReason, 'cancelled');
  assert.ok(out.answer.startsWith('[Stopped. Agent results so far:]'), out.answer);
  for (const part of parts) assert.ok(out.answer.includes(`did: ${part}`), part);
  assert.ok(!model.calls.some((c) => c.purpose === 'wrap-up'), 'no model call after a stop');
});

test('a run that ends with no answer from the lead still hands back the agent results', async () => {
  const parts = ['gather the first facts', 'gather the second facts'];
  const hasResults = (out, label) => {
    assert.ok(out.answer.startsWith('[Stopped. Agent results so far:]'), `${label}: ${out.answer}`);
    for (const part of parts) assert.ok(out.answer.includes(`did: ${part}`), `${label}: ${part}`);
  };

  // The lead's next call fails: the engine crashed, or Go Dark blocked a cloud provider.
  const failures = {
    'an engine error': () => { throw new Error('Ollama API error: 500 - llama runner process has terminated'); },
    'Go Dark': () => { throw Object.assign(new Error('Go Dark is on.'), { code: 'GO_DARK' }); }
  };
  for (const [label, lead] of Object.entries(failures)) {
    const { out } = await runUltra({ goal: 'gather facts', model: ultraModel({ parts, lead }) });
    assert.equal(out.stopReason, 'failed', label);
    hasResults(out, label);
  }

  // The time runs out during the merge, and the wrap-up times out too.
  let t = 0;
  const model = ultraModel({
    parts,
    lead: (calls) => {
      if (calls.at(-1).purpose === 'wrap-up') {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      t += 3 * 60 * 60_000;
      return '{"action":"tool","tool":"list_dir","args":{"path":"."}}';
    }
  });
  const { out } = await runUltra({ goal: 'gather facts', model, now: () => t });
  assert.equal(out.stopReason, 'wall-clock-exhausted');
  assert.ok(model.calls.some((c) => c.purpose === 'wrap-up'), 'the wrap-up was tried');
  hasResults(out, 'a failed wrap-up');
  assert.match(out.answer, /\[Stopped early: wall-clock-exhausted\./);
});
