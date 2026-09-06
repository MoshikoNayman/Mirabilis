// Looking a model up before pulling it.
//
// The interesting cases are the failure ones. "I could not check" and "that
// model does not exist" must stay distinct: the first must never stop someone
// installing a model they know is real, and the second is the whole reason the
// lookup exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelRef, formatSize, lookupModel } from './ollamaRegistry.js';

const manifest = (sizes) => ({
  ok: true, status: 200,
  json: async () => ({ layers: sizes.map((size) => ({ size })) })
});

test('a bare name resolves under library, like the daemon assumes', () => {
  assert.deepEqual(parseModelRef('llama3.2'), { repo: 'library/llama3.2', tag: 'latest' });
  assert.deepEqual(parseModelRef('qwen2.5:7b'), { repo: 'library/qwen2.5', tag: '7b' });
});

test('a namespaced name keeps its namespace', () => {
  assert.deepEqual(parseModelRef('someone/model:v2'), { repo: 'someone/model', tag: 'v2' });
  assert.deepEqual(parseModelRef('someone/model'), { repo: 'someone/model', tag: 'latest' });
});

test('anything that is not a plain model name is refused before any network call', () => {
  for (const bad of ['bad; rm -rf /', '../../etc/passwd', '', '   ', null, undefined, 'a'.repeat(200)]) {
    assert.equal(parseModelRef(bad), null, `${JSON.stringify(bad)} must not reach the registry`);
  }
});

test('sizes read the way a person would say them', () => {
  assert.equal(formatSize(4_683_086_845), '4.7 GB');
  assert.equal(formatSize(815_000_000), '815 MB');
  assert.equal(formatSize(0), '');
  assert.equal(formatSize(-1), '');
  assert.equal(formatSize(NaN), '');
});

test('a found model reports the total download size', async () => {
  const result = await lookupModel('qwen2.5:7b', {
    fetchImpl: async () => manifest([4_680_000_000, 1500, 200, 100])
  });
  assert.equal(result.status, 'found');
  assert.equal(result.size, '4.7 GB');
});

test('a 404 is a definite "no such model"', async () => {
  const result = await lookupModel('nope:1b', { fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(result.status, 'missing');
  assert.match(result.reason, /No model/);
});

test('an unreachable registry is "unknown", never "missing"', async () => {
  // This distinction is the point: being offline must not block an install of a
  // model the user knows exists.
  const thrown = await lookupModel('qwen2.5:7b', { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(thrown.status, 'unknown');

  const errored = await lookupModel('qwen2.5:7b', { fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(errored.status, 'unknown');
});

test('an invalid name never reaches the network', async () => {
  let called = false;
  const result = await lookupModel('bad; rm -rf /', { fetchImpl: async () => { called = true; return manifest([1]); } });
  assert.equal(result.status, 'invalid');
  assert.equal(called, false);
});

test('a malformed manifest does not throw', async () => {
  const result = await lookupModel('x:1b', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) })
  });
  assert.equal(result.status, 'found');
  assert.equal(result.sizeBytes, 0);
});
