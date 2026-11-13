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
    // A thinking model otherwise spends the step's token cap on thoughts and answers nothing.
    assert.equal(calls[0].think, false, `${request.model} step thinks`);
  }
});

test('a rate-limited call is retried once, then the error stands', async () => {
  const RATE_LIMIT = 'Provider API error: 429 - Rate limit or quota exceeded for this API key.';
  /** An adapter whose provider plays `steps` in turn, repeating the last; counts the calls. */
  const playing = (steps) => {
    let calls = 0;
    const callModel = createModelAdapter({
      config: {},
      request: { provider: 'openai', model: 'gpt-6-luna' },
      retryDelayMs: () => 0,
      streamWithProvider: async (args) => {
        const step = steps[Math.min(calls, steps.length - 1)];
        calls += 1;
        await step(args);
      }
    });
    return { callModel, calls: () => calls };
  };
  const fail = (message, code) => async () => { throw Object.assign(new Error(message), code ? { code } : {}); };
  const answer = async (args) => { args.onToken('done'); };
  const ask = (adapter, extra = {}) => adapter.callModel({ messages: [{ role: 'user', content: 'x' }], purpose: 'decide', ...extra });

  const once = playing([fail(RATE_LIMIT), answer]);
  assert.equal((await ask(once)).text, 'done');
  assert.equal(once.calls(), 2);

  const twice = playing([fail(RATE_LIMIT)]);
  await assert.rejects(() => ask(twice), /429/);
  assert.equal(twice.calls(), 2, 'one retry, not a loop');

  // Output already reached the run, so a second attempt would repeat it.
  const midStream = playing([async (args) => { args.onToken('half'); throw new Error(RATE_LIMIT); }]);
  await assert.rejects(() => ask(midStream), /429/);
  assert.equal(midStream.calls(), 1);

  const dark = playing([fail(RATE_LIMIT, 'GO_DARK'), answer]);
  await assert.rejects(() => ask(dark), /429/);
  assert.equal(dark.calls(), 1, 'a Go Dark block is final');

  const busy = playing([fail('Ollama API error: 503 - server busy'), answer]);
  assert.equal((await ask(busy)).text, 'done');
  assert.equal(busy.calls(), 2);

  // Too little of the deadline left for a second attempt to finish.
  const late = playing([fail(RATE_LIMIT), answer]);
  await assert.rejects(() => ask(late, { timeoutMs: 10_000 }), /429/);
  assert.equal(late.calls(), 1);

  const other = playing([fail('Provider API error: 400 - bad request'), answer]);
  await assert.rejects(() => ask(other), /400/);
  assert.equal(other.calls(), 1, 'only a rate limit or a busy engine is retried');
});

test('a caller temperature stands unless the model rejects it', async () => {
  const older = recording({ provider: 'claude', model: 'claude-sonnet-4-5', temperature: 0.5 });
  await older.callModel({ messages: [{ role: 'user', content: 'x' }], purpose: 'step' });
  assert.equal(older.calls[0].temperature, 0.5);

  const newer = recording({ provider: 'claude', model: 'claude-haiku-5-5', temperature: 0.5 });
  await newer.callModel({ messages: [{ role: 'user', content: 'x' }], purpose: 'step' });
  assert.equal(newer.calls[0].temperature, undefined);
});
