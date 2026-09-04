// Tests for the message a user sees when the engine is not there.
//
// This is the first-run path: install the app, type hello, and see what comes
// back. It used to be "Error: fetch failed", which names nothing and suggests
// nothing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeEngineError, isEngineUnreachable } from './engineErrors.js';

test('an unreachable local engine is named, located, and told how to start', () => {
  const msg = describeEngineError(new Error('fetch failed'), {
    provider: 'ollama', baseUrl: 'http://127.0.0.1:11434'
  });
  assert.match(msg, /ollama/i, 'must name the provider');
  assert.match(msg, /127\.0\.0\.1:11434/, 'must say where it looked');
  assert.match(msg, /ollama serve/, 'must say how to fix it');
  assert.ok(!/fetch failed/.test(msg), 'the raw transport error is not the message');
});

test('every transport failure shape produces the same actionable message', () => {
  for (const raw of ['fetch failed', 'connect ECONNREFUSED 127.0.0.1:11434',
                     'getaddrinfo ENOTFOUND host', 'socket hang up', 'other side closed']) {
    const msg = describeEngineError(new Error(raw), { provider: 'ollama' });
    assert.match(msg, /Could not reach/, `${raw} should be recognised as unreachable`);
  }
});

test('each local engine gets its own start hint', () => {
  assert.match(describeEngineError(new Error('fetch failed'), { provider: 'llamacpp' }), /llama\.cpp/i);
  assert.match(describeEngineError(new Error('fetch failed'), { provider: 'vllm' }), /vLLM/i);
  assert.match(describeEngineError(new Error('fetch failed'), { provider: 'koboldcpp' }), /KoboldCpp/i);
});

test('an unknown provider still gets a usable sentence rather than a stack trace', () => {
  const msg = describeEngineError(new Error('fetch failed'), { provider: 'something-new' });
  assert.match(msg, /Could not reach/);
  assert.match(msg, /Start the engine|pick a provider/i);
});

test('a timeout is distinguished from an unreachable engine', () => {
  const msg = describeEngineError(new Error('UND_ERR_HEADERS_TIMEOUT'), {
    provider: 'ollama', baseUrl: 'http://127.0.0.1:11434'
  });
  assert.match(msg, /did not respond in time/i);
  assert.match(msg, /smaller model|loading/i, 'should suggest what to do about it');
  assert.ok(!/Could not reach/.test(msg), 'a slow engine is not a missing one');
});

test('a real error from the engine is passed through untouched', () => {
  // The engine explaining itself is better than anything this module can add.
  const raw = 'model "nope" not found, try pulling it first';
  assert.equal(describeEngineError(new Error(raw), { provider: 'ollama' }), raw);
});

test('it never throws, whatever it is handed', () => {
  for (const junk of [null, undefined, '', 0, {}, [], new Error()]) {
    const msg = describeEngineError(/** @type {any} */ (junk), {});
    assert.equal(typeof msg, 'string');
    assert.ok(msg.length > 0, 'must always produce something showable');
  }
});

test('isEngineUnreachable separates "nothing is listening" from "the model erred"', () => {
  assert.equal(isEngineUnreachable(new Error('fetch failed')), true);
  assert.equal(isEngineUnreachable(new Error('ECONNREFUSED')), true);
  assert.equal(isEngineUnreachable(new Error('model not found')), false);
  assert.equal(isEngineUnreachable(null), false);
});
