// Update checks with stubbed registry and library lookups, the 6 h cache, Go Dark,
// the Ollama release lookup and install-method detection. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  checkModel, compareVersions, createModelUpdates, detectOllamaInstall, fetchLatestOllamaRelease, mapLimit,
  MODEL_UPDATES_FILE, OLLAMA_RELEASE_URL
} from './modelUpdates.js';

const LOCAL = '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41';
const OTHER = 'aaee06c39dcf0000000000000000000000000000000000000000000000000000';
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-updates-'));

/** A library stub that records what it was asked. */
function fakeLibrary({ rows = [], digests = [], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async tagRows(name) {
      calls.push(['tags', name]);
      if (fail) throw new Error('offline');
      return { goDark: false, stale: false, rows };
    },
    async tagDigests(name, tag) {
      calls.push(['tag', name, tag]);
      if (fail) throw new Error('offline');
      return { goDark: false, stale: false, digests };
    }
  };
}

const found = (digest) => async () => ({ status: 'found', digest });

test('current when the registry serves the installed manifest', async () => {
  const library = fakeLibrary();
  const result = await checkModel({ name: 'qwen3:8b', digest: LOCAL }, { headDigest: found(LOCAL), library });
  assert.deepEqual(result, { status: 'current' });
  assert.deepEqual(library.calls, [], 'a match needs no page from ollama.com');
});

test('current when the tags page lists the local digest for that tag (the other runtime build)', async () => {
  const library = fakeLibrary({ rows: [{ tag: '27b', digest: LOCAL.slice(0, 12) }, { tag: '27b-mlx', digest: 'x' }] });
  const result = await checkModel({ name: 'qwen3.8:27b', digest: LOCAL }, { headDigest: found(OTHER), library });
  assert.deepEqual(result, { status: 'current' });
  assert.deepEqual(library.calls, [['tags', 'qwen3.8']]);
});

test('current when the tag page lists the local digest as one of its runtimes', async () => {
  const library = fakeLibrary({ rows: [{ tag: '27b', digest: 'e118e4d12a70' }], digests: [LOCAL.slice(0, 12), 'aaee06c39dcf'] });
  const result = await checkModel({ name: 'qwen3.8:27b', digest: LOCAL }, { headDigest: found(OTHER), library });
  assert.deepEqual(result, { status: 'current' });
  assert.deepEqual(library.calls, [['tags', 'qwen3.8'], ['tag', 'qwen3.8', '27b']]);
});

test('an update when no source lists the local digest; the registry stands when ollama.com is down', async () => {
  const listed = fakeLibrary({ rows: [{ tag: '8b', digest: 'ffffffffffff' }], digests: ['ffffffffffff'] });
  assert.deepEqual(await checkModel({ name: 'qwen3:8b', digest: LOCAL }, { headDigest: found(OTHER), library: listed }), { status: 'update' });
  const down = fakeLibrary({ fail: true });
  assert.deepEqual(await checkModel({ name: 'qwen3:8b', digest: LOCAL }, { headDigest: found(OTHER), library: down }), { status: 'update' });
});

test('the tag only matches its own row, case aside, and a user model keeps its namespace', async () => {
  const library = fakeLibrary({ rows: [{ tag: 'latest', digest: LOCAL.slice(0, 12) }] });
  const result = await checkModel({ name: 'orcarouter/Ripple-65B-abliterated:latest', digest: LOCAL }, { headDigest: found(OTHER), library });
  assert.deepEqual(result, { status: 'current' });
  assert.deepEqual(library.calls, [['tags', 'orcarouter/ripple-65b-abliterated']]);
  const wrongRow = fakeLibrary({ rows: [{ tag: '8b-q8_0', digest: LOCAL.slice(0, 12) }] });
  assert.equal((await checkModel({ name: 'qwen3:8b', digest: LOCAL }, { headDigest: found(OTHER), library: wrongRow })).status, 'update');
});

test('unknown, with a reason, when there is nothing to compare against', async () => {
  const library = fakeLibrary();
  const gone = await checkModel({ name: 'old:1b', digest: LOCAL }, { headDigest: async () => ({ status: 'missing', reason: 'x' }), library });
  assert.deepEqual(gone, { status: 'unknown', reason: 'No longer in the library' });

  let asked = false;
  const hf = await checkModel({ name: 'hf.co/user/repo:Q4_K_M', digest: LOCAL }, {
    headDigest: async () => { asked = true; return { status: 'found', digest: LOCAL }; }, library
  });
  assert.deepEqual(hf, { status: 'unknown', reason: 'Not from the Ollama library' });
  assert.equal(asked, false);

  const offline = await checkModel({ name: 'qwen3:8b', digest: LOCAL }, { headDigest: async () => ({ status: 'unknown', reason: 'Registry unreachable' }), library });
  assert.deepEqual(offline, { status: 'unknown', reason: 'Registry unreachable', transient: true });
  assert.equal((await checkModel({ name: 'qwen3:8b', digest: '' }, { headDigest: found(LOCAL), library })).reason, 'No local digest');
});

/** A counting headDigest that also tracks how many run at once. */
function countingHead(answer = LOCAL) {
  const state = { calls: /** @type {string[]} */ ([]), active: 0, peak: 0 };
  const fn = async (name) => {
    state.calls.push(name);
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    await new Promise((r) => setTimeout(r, 5));
    state.active -= 1;
    return { status: 'found', digest: answer };
  };
  return { state, fn };
}

test('results are cached for 6 hours per model and digest; refresh checks again', async () => {
  let clock = 1_000_000;
  const head = countingHead();
  const updates = createModelUpdates({ library: fakeLibrary(), headDigest: head.fn, now: () => clock });
  const models = [{ name: 'qwen3:8b', digest: LOCAL }, { name: 'dolphin3:latest', digest: LOCAL }];

  const first = await updates.check({ models });
  assert.deepEqual(first.results, { 'qwen3:8b': { status: 'current' }, 'dolphin3:latest': { status: 'current' } });
  assert.equal(first.goDark, false);
  assert.equal(first.checkedAt, new Date(1_000_000).toISOString());
  assert.equal(head.state.calls.length, 2);

  clock += 60 * 60 * 1000;
  await updates.check({ models });
  assert.equal(head.state.calls.length, 2, 'within 6 h nothing is asked again');

  // A new digest (the model was updated) drops that entry only.
  await updates.check({ models: [{ name: 'qwen3:8b', digest: OTHER }, models[1]] });
  assert.deepEqual(head.state.calls.slice(2), ['qwen3:8b']);

  await updates.check({ models, refresh: true });
  assert.equal(head.state.calls.length, 5);

  clock += 7 * 60 * 60 * 1000;
  await updates.check({ models });
  assert.equal(head.state.calls.length, 7, 'past 6 h every model is checked again');
});

test('at most 4 lookups run at once', async () => {
  const head = countingHead();
  const updates = createModelUpdates({ library: fakeLibrary(), headDigest: head.fn });
  const models = Array.from({ length: 11 }, (_, i) => ({ name: `m${i}:1b`, digest: LOCAL }));
  const out = await updates.check({ models });
  assert.equal(Object.keys(out.results).length, 11);
  assert.equal(head.state.peak, 4);
});

test('with the registry unreachable, one lookup answers for the rest', async () => {
  let calls = 0;
  const updates = createModelUpdates({
    library: fakeLibrary(),
    headDigest: async () => { calls += 1; return { status: 'unknown', reason: 'Registry unreachable' }; }
  });
  const models = Array.from({ length: 9 }, (_, i) => ({ name: `m${i}:1b`, digest: LOCAL }));
  const out = await updates.check({ models });
  assert.equal(calls, 1);
  assert.deepEqual(Object.values(out.results)[8], { status: 'unknown', reason: 'Registry unreachable' });
});

test('models built here are local and never looked up', async () => {
  const head = countingHead();
  const updates = createModelUpdates({ library: fakeLibrary(), headDigest: head.fn, isLocal: (n) => n.startsWith('mcq-') });
  const out = await updates.check({ models: [{ name: 'mcq-raw-8b:latest', digest: LOCAL }, { name: 'qwen3:8b', digest: LOCAL }] });
  assert.deepEqual(out.results['mcq-raw-8b:latest'], { status: 'local' });
  assert.deepEqual(head.state.calls, ['qwen3:8b']);
});

test('Go Dark returns the cache with goDark true and touches nothing', async () => {
  let dark = false;
  const head = countingHead();
  const updates = createModelUpdates({ library: fakeLibrary(), headDigest: head.fn, isGoDark: () => dark });
  await updates.check({ models: [{ name: 'qwen3:8b', digest: LOCAL }] });
  dark = true;
  const out = await updates.check({ models: [{ name: 'qwen3:8b', digest: LOCAL }, { name: 'new:1b', digest: LOCAL }], refresh: true });
  assert.equal(out.goDark, true);
  assert.deepEqual(out.results, { 'qwen3:8b': { status: 'current' }, 'new:1b': { status: 'unknown', reason: 'Not checked yet' } });
  assert.equal(head.state.calls.length, 1);
});

test('with Ollama down (no installed list) the cache is returned without lookups', async () => {
  const head = countingHead();
  const updates = createModelUpdates({ library: fakeLibrary(), headDigest: head.fn });
  await updates.check({ models: [{ name: 'qwen3:8b', digest: LOCAL }] });
  const out = await updates.check({ models: [] });
  assert.deepEqual(out.results, { 'qwen3:8b': { status: 'current' } });
  assert.equal(head.state.calls.length, 1);
});

test('a network failure is retried after 15 minutes, not 6 hours', async () => {
  let clock = 0;
  let online = false;
  let calls = 0;
  const updates = createModelUpdates({
    library: fakeLibrary(),
    now: () => clock,
    headDigest: async () => { calls += 1; return online ? { status: 'found', digest: LOCAL } : { status: 'unknown', reason: 'Registry unreachable' }; }
  });
  const models = [{ name: 'qwen3:8b', digest: LOCAL }];
  assert.deepEqual((await updates.check({ models })).results['qwen3:8b'], { status: 'unknown', reason: 'Registry unreachable' });
  clock += 16 * 60 * 1000;
  online = true;
  assert.deepEqual((await updates.check({ models })).results['qwen3:8b'], { status: 'current' });
  assert.equal(calls, 2);
});

test('the cache file is 0600, survives a restart and forgets removed models', async () => {
  const dataDir = await tmp();
  const head = countingHead();
  const updates = createModelUpdates({ dataDir, library: fakeLibrary(), headDigest: head.fn });
  await updates.check({ models: [{ name: 'qwen3:8b', digest: LOCAL }, { name: 'gone:1b', digest: LOCAL }] });
  await updates.flush();
  const file = path.join(dataDir, MODEL_UPDATES_FILE);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  const restarted = createModelUpdates({ dataDir, library: fakeLibrary(), headDigest: async () => { throw new Error('must not look up'); } });
  const out = await restarted.check({ models: [{ name: 'qwen3:8b', digest: LOCAL }] });
  assert.deepEqual(out.results, { 'qwen3:8b': { status: 'current' } });
  await restarted.flush();
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.models), ['qwen3:8b']);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('the latest Ollama release: v stripped, cached 12 h, never asked under Go Dark', async () => {
  let clock = 0;
  let dark = false;
  /** @type {string[]} */
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ tag_name: 'v0.40.16', body: 'notes' }), { status: 200 });
  };
  const updates = createModelUpdates({ library: fakeLibrary(), fetchImpl, now: () => clock, isGoDark: () => dark });
  assert.equal(await updates.latestOllama(), '0.40.16');
  assert.deepEqual(urls, [OLLAMA_RELEASE_URL]);
  clock += 11 * 60 * 60 * 1000;
  assert.equal(await updates.latestOllama(), '0.40.16');
  assert.equal(urls.length, 1);
  clock += 2 * 60 * 60 * 1000;
  dark = true;
  assert.equal(await updates.latestOllama(), '0.40.16', 'the cached value, no request');
  assert.equal(urls.length, 1);
  dark = false;
  await updates.latestOllama();
  assert.equal(urls.length, 2);
});

test('a failed release lookup is null and waits 30 minutes before trying again', async () => {
  let clock = 0;
  let calls = 0;
  const updates = createModelUpdates({
    library: fakeLibrary(),
    now: () => clock,
    fetchImpl: async () => { calls += 1; return new Response('rate limited', { status: 403 }); }
  });
  assert.equal(await updates.latestOllama(), null);
  clock += 10 * 60 * 1000;
  assert.equal(await updates.latestOllama(), null);
  assert.equal(calls, 1);
  clock += 25 * 60 * 1000;
  await updates.latestOllama();
  assert.equal(calls, 2);
  await assert.rejects(fetchLatestOllamaRelease({ fetchImpl: async () => new Response('{"tag_name":"nightly"}', { status: 200 }) }));
});

test('versions compare by number', () => {
  assert.ok(compareVersions('0.20.5', '0.40.16') < 0);
  assert.ok(compareVersions('0.40.16', '0.40.2') > 0);
  assert.equal(compareVersions('v1.2.0', '1.2'), 0);
  assert.equal(compareVersions('0.41.0-rc1', '0.41.0'), 0);
});

test('install method comes from the real path of the ollama binary', async () => {
  /** @param {Record<string, string>} links */
  const fakeRealpath = (links) => async (p) => {
    if (links[p]) return links[p];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  assert.deepEqual(await detectOllamaInstall({
    platform: 'darwin', env: { PATH: '/opt/homebrew/bin:/usr/bin' }, home: '/Users/me',
    realpathImpl: fakeRealpath({ '/opt/homebrew/bin/ollama': '/opt/homebrew/Cellar/ollama/0.20.5/bin/ollama' })
  }), { install: 'homebrew', updateCommand: 'brew upgrade ollama' });
  assert.deepEqual(await detectOllamaInstall({
    platform: 'darwin', env: { PATH: '/usr/bin' }, home: '/Users/me',
    realpathImpl: fakeRealpath({ '/usr/local/bin/ollama': '/Applications/Ollama.app/Contents/Resources/ollama' })
  }), { install: 'app', updateCommand: null });
  assert.deepEqual(await detectOllamaInstall({
    platform: 'linux', env: { PATH: '/usr/bin' }, home: '/home/me',
    realpathImpl: fakeRealpath({ '/usr/local/bin/ollama': '/usr/local/bin/ollama' })
  }), { install: 'script', updateCommand: 'curl -fsSL https://ollama.com/install.sh | sh' });
  assert.deepEqual(await detectOllamaInstall({ platform: 'win32' }), { install: 'windows', updateCommand: null });
  assert.deepEqual(await detectOllamaInstall({ platform: 'linux', env: { PATH: '' }, home: '/home/me', realpathImpl: fakeRealpath({}) }),
    { install: 'unknown', updateCommand: null });
});

test('mapLimit keeps input order', async () => {
  const out = await mapLimit([30, 10, 20], 2, async (ms, i) => { await new Promise((r) => setTimeout(r, ms)); return i; });
  assert.deepEqual(out, [0, 1, 2]);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});
