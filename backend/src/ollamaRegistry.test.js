import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseModelRef, formatSize, lookupModel, headDigest, normalizeDigest, readBodyCapped } from './ollamaRegistry.js';

const DIGEST = '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41';

const manifest = (sizes) => new Response(JSON.stringify({ layers: sizes.map((size) => ({ size })) }), { status: 200 });
const status = (code) => new Response(code === 404 ? 'not found' : 'error', { status: code });

test('a bare name resolves under library, like the daemon assumes', () => {
  assert.deepEqual(parseModelRef('llama3.2'), { host: 'registry.ollama.ai', repo: 'library/llama3.2', tag: 'latest' });
  assert.deepEqual(parseModelRef('qwen2.5:7b'), { host: 'registry.ollama.ai', repo: 'library/qwen2.5', tag: '7b' });
});

test('a namespaced name keeps its namespace', () => {
  assert.deepEqual(parseModelRef('someone/model:v2'), { host: 'registry.ollama.ai', repo: 'someone/model', tag: 'v2' });
  assert.deepEqual(parseModelRef('someone/model'), { host: 'registry.ollama.ai', repo: 'someone/model', tag: 'latest' });
});

test('a Hugging Face name keeps its own host instead of landing under registry.ollama.ai', () => {
  assert.deepEqual(parseModelRef('hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M'), {
    host: 'hf.co', repo: 'bartowski/llama-3.2-1b-instruct-gguf', tag: 'q4_k_m'
  });
  assert.deepEqual(parseModelRef('registry.ollama.ai/library/qwen3:8b'), { host: 'registry.ollama.ai', repo: 'library/qwen3', tag: '8b' });
});

test('anything that is not a plain model name is refused before any network call', () => {
  for (const bad of ['bad; rm -rf /', '../../etc/passwd', 'a/../b', 'a//b', 'a/b/c/d', '', '   ', null, undefined, 'a'.repeat(200)]) {
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
  const result = await lookupModel('nope:1b', { fetchImpl: async () => status(404) });
  assert.equal(result.status, 'missing');
  assert.match(String(result.reason), /No model/);
});

test('an unreachable registry is "unknown", never "missing"', async () => {
  // Being offline must not block installing a model the user knows exists.
  const thrown = await lookupModel('qwen2.5:7b', { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(thrown.status, 'unknown');

  const errored = await lookupModel('qwen2.5:7b', { fetchImpl: async () => status(500) });
  assert.equal(errored.status, 'unknown');
});

test('an invalid name never reaches the network', async () => {
  let called = false;
  const result = await lookupModel('bad; rm -rf /', { fetchImpl: async () => { called = true; return manifest([1]); } });
  assert.equal(result.status, 'invalid');
  assert.equal(called, false);
});

test('a Hugging Face model is not looked up in the Ollama registry, so it is never called missing', async () => {
  let called = false;
  const result = await lookupModel('hf.co/user/repo:Q4_K_M', { fetchImpl: async () => { called = true; return status(404); } });
  assert.equal(result.status, 'unknown');
  assert.equal(called, false);
});

test('a malformed manifest does not throw', async () => {
  const result = await lookupModel('x:1b', {
    fetchImpl: async () => new Response(JSON.stringify({ nope: true }), { status: 200 })
  });
  assert.equal(result.status, 'found');
  assert.equal(result.sizeBytes, 0);
});

test('headDigest reads ollama-content-digest from a HEAD, with no ollama User-Agent', async () => {
  /** @type {any[]} */
  const calls = [];
  const result = await headDigest('qwen3:8b', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 200, headers: { 'ollama-content-digest': DIGEST } });
    }
  });
  assert.deepEqual(result, { status: 'found', digest: DIGEST });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://registry.ollama.ai/v2/library/qwen3/manifests/8b');
  assert.equal(calls[0].init.method, 'HEAD');
  assert.match(calls[0].init.headers.Accept, /manifest\.v2\+json/);
  // An "ollama/..." User-Agent gets a 401 asking for signed auth.
  assert.equal(Object.keys(calls[0].init.headers).some((h) => h.toLowerCase() === 'user-agent'), false);
});

test('headDigest falls back to docker-content-digest, prefix and case removed', async () => {
  const result = await headDigest('someone/model', {
    fetchImpl: async () => new Response(null, { status: 200, headers: { 'docker-content-digest': `sha256:${DIGEST.toUpperCase()}` } })
  });
  assert.deepEqual(result, { status: 'found', digest: DIGEST });
});

test('headDigest hashes the manifest body when no digest header comes back', async () => {
  const body = JSON.stringify({ schemaVersion: 2, layers: [{ size: 1 }] });
  /** @type {string[]} */
  const methods = [];
  const result = await headDigest('qwen3:8b', {
    fetchImpl: async (_url, init) => {
      methods.push(init?.method || 'GET');
      return init?.method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(body, { status: 200 });
    }
  });
  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.deepEqual(result, { status: 'found', digest: createHash('sha256').update(body).digest('hex') });
});

test('headDigest: 404 is gone from the library, anything else is unknown, nothing throws', async () => {
  assert.deepEqual(await headDigest('gone:1b', { fetchImpl: async () => status(404) }), { status: 'missing', reason: 'No longer in the library' });
  assert.equal((await headDigest('x:1b', { fetchImpl: async () => status(500) })).status, 'unknown');
  assert.equal((await headDigest('x:1b', { fetchImpl: async () => { throw new Error('offline'); } })).status, 'unknown');
  assert.equal((await headDigest('bad; rm', { fetchImpl: async () => status(200) })).status, 'invalid');
});

test('headDigest never asks registry.ollama.ai about another host', async () => {
  let called = false;
  const result = await headDigest('hf.co/user/repo:Q4_K_M', { fetchImpl: async () => { called = true; return status(200); } });
  assert.equal(result.status, 'unknown');
  assert.equal(called, false);
});

test('headDigest gives up at its timeout', async () => {
  const started = Date.now();
  const result = await headDigest('qwen3:8b', {
    timeoutMs: 50,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      // AbortSignal.timeout does not hold the event loop open; this timer does.
      const hold = setTimeout(() => {}, 5000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(hold); reject(init.signal?.reason); });
    })
  });
  assert.equal(result.status, 'unknown');
  assert.ok(Date.now() - started < 2000);
});

test('normalizeDigest accepts only a full sha256', () => {
  assert.equal(normalizeDigest(`sha256:${DIGEST}`), DIGEST);
  assert.equal(normalizeDigest(DIGEST.slice(0, 12)), '');
  assert.equal(normalizeDigest(null), '');
});

test('readBodyCapped refuses a body past its cap', async () => {
  const big = new Response('x'.repeat(5000), { status: 200 });
  await assert.rejects(readBodyCapped(big, 1000), (err) => /** @type {any} */ (err).code === 'TOO_LARGE');
  const declared = new Response('small', { status: 200, headers: { 'content-length': '999999' } });
  await assert.rejects(readBodyCapped(declared, 1000), (err) => /** @type {any} */ (err).code === 'TOO_LARGE');
  assert.equal((await readBodyCapped(new Response('ok', { status: 200 }), 1000)).toString(), 'ok');
});
