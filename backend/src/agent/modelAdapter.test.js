// What the agent's single-shot call hands the provider, per model family.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelAdapter } from './modelAdapter.js';

/** An adapter over a provider stub that records each call and answers "done". */
function recording(request) {
  const calls = [];
  const callModel = createModelAdapter({
    config: {},
    request,
    streamWithProvider: async (args) => {
      calls.push(args);
      args.onToken('done');
      args.onStats({ evalCount: 3 });
    }
  });
  return { calls, callModel };
}

test('Claude 5 and later get no temperature and no trailing assistant turn', async () => {
  // Either one is a 400 on these models, which failed every agent run.
  for (const model of ['claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-6']) {
    const { calls, callModel } = recording({ provider: 'claude', model });
    const out = await callModel({
      messages: [{ role: 'user', content: 'goal' }, { role: 'assistant', content: 'Plan:' }],
      purpose: 'validate'
    });
    assert.deepEqual(out, { text: 'done', tokens: 3 });
    assert.equal(calls[0].temperature, undefined, `${model} must not get a temperature`);
    assert.deepEqual(calls[0].messages.map((m) => m.role), ['user'], `${model} must not end on an assistant turn`);
  }
});

test('older Claude and other providers keep the low step temperature', async () => {
  for (const request of [
    { provider: 'claude', model: 'claude-sonnet-4-5' },
    { provider: 'ollama', model: 'qwen3:8b' },
    // openaiCompatible.js drops it for OpenAI reasoning models itself.
    { provider: 'openai', model: 'gpt-6-luna' }
  ]) {
    const { calls, callModel } = recording(request);
    await callModel({ messages: [{ role: 'user', content: 'x' }], purpose: 'step' });
    await callModel({ messages: [{ role: 'user', content: 'x' }], purpose: 'validate' });
    assert.equal(calls[0].temperature, 0.2, `${request.model} step`);
    assert.equal(calls[1].temperature, 0, `${request.model} validate`);
    assert.equal(calls[0].maxTokens, 1500);
  }
});

test('a caller temperature stands unless the model rejects it', async () => {
  const older = recording({ provider: 'claude', model: 'claude-sonnet-4-5', temperature: 0.5 });
  await older.callModel({ messages: [{ role: 'user', content: 'x' }], purpose: 'step' });
  assert.equal(older.calls[0].temperature, 0.5);

  const newer = recording({ provider: 'claude', model: 'claude-haiku-5-5', temperature: 0.5 });
  await newer.callModel({ messages: [{ role: 'user', content: 'x' }], purpose: 'step' });
  assert.equal(newer.calls[0].temperature, undefined);
});
