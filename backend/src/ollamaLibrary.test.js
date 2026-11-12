// Parsers against trimmed copies of real ollama.com pages (testdata/ollama), and
// the cache: TTL, stale fallback, Go Dark, bounds. No test touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createOllamaLibrary, isLibraryName, LIBRARY_CACHE_FILE, LIBRARY_ERRORS, LibraryError, normalizeLibraryName,
  normalizeSearch, parseContext, parseSearchPage, parseSize, parseTagPageDigests, parseTagsPage, publicTags,
  searchHeaders, searchUrl, tagPageUrl, tagsUrl
} from './ollamaLibrary.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'ollama');
const fixture = (name) => fs.readFile(path.join(FIXTURES, name), 'utf8');
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-library-'));
const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });

test('a search page parses to models with capabilities, sizes, counts and dates', async () => {
  const { results, hasMore, recognized } = parseSearchPage(await fixture('search-qwen.html'));
  assert.equal(recognized, true);
  assert.equal(hasMore, true);
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.deepEqual(byName['qwen3.8'], {
    name: 'qwen3.8',
    description: 'Qwen3.8 delivers substantial gains across coding, professional work, research, and long-horizon agentic tasks.',
    capabilities: ['vision', 'tools', 'thinking'],
    sizes: ['27b'],
    pulls: 6304540,
    tags: 13,
    updated: '2026-11-08'
  });
  assert.deepEqual(byName['qwen3.5'].sizes, ['0.8b', '2b', '4b', '9b', '27b', '35b', '122b']);
  assert.deepEqual(byName['qwen3-embedding'].capabilities, ['embedding']);
  assert.equal(byName['mimo-v2.6'].description.includes("Xiaomi MiMo's 9B"), true, 'entities decode');
  // "decision" is not one of the capabilities the app knows.
  assert.deepEqual(byName['pplx-decider-flash'].capabilities, ['vision']);
  assert.deepEqual(byName['gemma4'].capabilities, ['vision', 'tools', 'thinking', 'audio']);
});

test('cloud-only models are left out; a model with local tags and a cloud chip stays', async () => {
  const names = parseSearchPage(await fixture('search-qwen.html')).results.map((r) => r.name);
  assert.equal(names.includes('glm-5.3'), false, 'cloud chip, no sizes, no tags');
  assert.equal(names.includes('gemma4'), true);
  assert.equal(names.includes('qwen3.8-flash-next'), true, 'no size chips is not cloud-only');
});

test('a user model keeps its namespace and footer links are not models', async () => {
  const { results } = parseSearchPage(await fixture('search-qwen.html'));
  const user = results.find((r) => r.name === 'orcarouter/Ripple-65B-abliterated');
  assert.ok(user);
  assert.deepEqual(user.capabilities, []);
  assert.equal(user.pulls, 31);
  assert.equal(user.tags, 6);
  assert.equal(results.some((r) => r.name === 'blog'), false);
  assert.equal(results.length, 8);
});

test('an empty result page is recognized; a page that is not a search page is not', () => {
  const empty = parseSearchPage('<div hidden data-result-count="0" data-has-more="false"></div><ul role="list"></ul>');
  assert.deepEqual(empty, { results: [], hasMore: false, recognized: true });
  assert.equal(parseSearchPage('<html><body>Maintenance</body></html>').recognized, false);
  // The next page of results arrives as an htmx partial with only the sentinel.
  assert.equal(parseSearchPage('<li hx-get="/search?page=3&q=qwen" hx-trigger="revealed"></li>').hasMore, true);
});

test('tags: latest folds into the tag it points to; MLX from the badge or the tag name', async () => {
  const rows = parseTagsPage(await fixture('tags-qwen3.8.html'));
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], {
    name: 'qwen3.8:latest', family: 'qwen3.8', tag: 'latest', digest: 'e118e4d12a70', size: '18 GB', sizeBytes: 18e9,
    context: 262144, input: ['text', 'image'], mlx: false, latest: false, cloud: false
  });
  const tags = publicTags(rows);
  assert.deepEqual(tags.map((t) => t.tag), ['27b', '27b-mlx', '27b-nvfp4', '27b-q8_0']);
  assert.deepEqual(tags[0], {
    name: 'qwen3.8:27b', tag: '27b', digest: 'e118e4d12a70', sizeBytes: 18e9, size: '18 GB',
    context: 262144, input: ['text', 'image'], mlx: false, latest: true
  });
  assert.equal(tags[1].mlx, true);
  assert.equal(tags[2].mlx, true);
  assert.equal(tags[3].size, '30 GB');
  assert.equal(tags.filter((t) => t.latest).length, 1);
});

test('tags: cloud tags are dropped and a GGUF plus MLX size range keeps the larger as bytes', async () => {
  const rows = parseTagsPage(await fixture('tags-gemma4.html'));
  assert.deepEqual(rows.filter((r) => r.cloud).map((r) => r.tag), ['cloud', '31b-cloud']);
  const tags = publicTags(rows);
  assert.deepEqual(tags.map((t) => t.tag), ['e2b', 'e4b', 'e4b-mlx']);
  const e4b = tags.find((t) => t.tag === 'e4b');
  assert.equal(e4b?.latest, true);
  assert.equal(e4b?.size, '6.6-9.5 GB');
  assert.equal(e4b?.sizeBytes, 9.5e9);
  assert.equal(e4b?.context, 131072);
});

test('tags: a user model without a latest badge keeps its latest row', async () => {
  const tags = publicTags(parseTagsPage(await fixture('tags-user.html')));
  assert.deepEqual(tags.map((t) => [t.name, t.latest]), [
    ['orcarouter/Ripple-65B-abliterated:latest', true],
    ['orcarouter/Ripple-65B-abliterated:mix-4bit', false]
  ]);
  assert.deepEqual(tags[0].input, ['text']);
});

test('tags: the live page writes raw bullet characters, not entities', () => {
  const row = (tag, sizeText) => `<a href="/library/x:${tag}" class="md:hidden flex flex-col">`
    + `<span class="group-hover:underline">x:${tag}</span>`
    + `<span class="font-mono">0123456789ab</span> \u2022 ${sizeText} \u2022 32K context window \u2022 Text input \u2022 2 days ago</a>`;
  const rows = parseTagsPage(row('7b', '4.7GB') + row('7b-gguf-nvfp4', '5.0GB') + row('7b-cloud', 'Low Usage'));
  assert.deepEqual(rows.map((r) => [r.tag, r.sizeBytes, r.context, r.mlx, r.cloud]), [
    ['7b', 4.7e9, 32768, false, false],
    ['7b-gguf-nvfp4', 5e9, 32768, false, false],
    ['7b-cloud', null, 32768, false, true]
  ]);
});

test('a tag page lists one digest per runtime', async () => {
  assert.deepEqual(parseTagPageDigests(await fixture('tag-qwen3.8-27b.html')), ['47951e4a6661', 'aaee06c39dcf']);
  assert.deepEqual(parseTagPageDigests('<p>d5ab9ae8e1f2 \u00b7 4.9GB</p>'), ['d5ab9ae8e1f2']);
  assert.deepEqual(parseTagPageDigests('<p>nothing here</p>'), []);
});

test('sizes and context windows read the way the site writes them', () => {
  assert.deepEqual(parseSize('304MB - 378MB'), { size: '304-378 MB', sizeBytes: 378e6 });
  assert.deepEqual(parseSize('990MB - 1.2GB'), { size: '990 MB-1.2 GB', sizeBytes: 1.2e9 });
  assert.deepEqual(parseSize('1.3TB'), { size: '1.3 TB', sizeBytes: 1.3e12 });
  assert.equal(parseSize('Low Usage'), null);
  assert.equal(parseContext('128K'), 131072);
  assert.equal(parseContext('1M'), 1048576);
  assert.equal(parseContext('512'), 512);
  assert.equal(parseContext('lots'), null);
});

test('a search always asks for local models and drops filters the site does not take', () => {
  const query = normalizeSearch({ q: '  qwen  ', capabilities: ['vision', 'TOOLS', 'cloud', 'decision'], size: '16', order: 'newest', page: '2' });
  assert.deepEqual(query, { q: 'qwen', capabilities: ['tools', 'vision'], size: '16', order: 'newest', page: 2 });
  assert.equal(searchUrl(query), 'https://ollama.com/search?q=qwen&c=local&c=tools&c=vision&s=16&o=newest&page=2');
  // Popular is the default order; o=popular would only redirect.
  assert.equal(searchUrl(normalizeSearch({})), 'https://ollama.com/search?c=local');
  assert.deepEqual(normalizeSearch({ capabilities: 'thinking', size: '12', order: 'name', page: 999 }),
    { q: '', capabilities: ['thinking'], size: '', order: 'popular', page: 50 });
  assert.equal(normalizeSearch({ q: 'x'.repeat(500) }).q.length, 100);
  assert.equal(normalizeSearch({ q: { nested: 'object' } }).q, '', 'a query string parsed into an object is no query');
});

test('page 2 and later ask the way the site\'s own infinite scroll does', async () => {
  // Without the htmx header ollama.com answers page 2 with a redirect to page 1.
  assert.deepEqual(searchHeaders(normalizeSearch({ q: 'qwen' })), {});
  assert.deepEqual(searchHeaders(normalizeSearch({ q: 'qwen', page: 2 })), { 'HX-Request': 'true' });
  const page = await fixture('search-qwen.html');
  /** @type {{ url: string, headers: Record<string, string> }[]} */
  const seen = [];
  const lib = createOllamaLibrary({ fetchImpl: async (url, init) => { seen.push({ url: String(url), headers: /** @type {any} */ (init?.headers) || {} }); return html(page); } });
  await lib.search({ q: 'qwen' });
  await lib.search({ q: 'qwen', page: 2 });
  assert.deepEqual(seen.map((s) => [s.url, s.headers['HX-Request'] ?? null]), [
    ['https://ollama.com/search?q=qwen&c=local', null],
    ['https://ollama.com/search?q=qwen&c=local&page=2', 'true']
  ]);
});

test('model names: model or user/model, nothing that could leave the path', () => {
  assert.equal(normalizeLibraryName('library/qwen3'), 'qwen3');
  assert.equal(normalizeLibraryName('orcarouter/Ripple-65B-abliterated'), 'orcarouter/Ripple-65B-abliterated');
  for (const bad of ['', 'a/b/c', '../x', 'a/..', 'x y', 'x?y', '-x', 'a:b']) assert.equal(isLibraryName(bad), false, bad);
  assert.equal(tagsUrl('qwen3.5'), 'https://ollama.com/library/qwen3.5/tags');
  assert.equal(tagsUrl('user/model'), 'https://ollama.com/user/model/tags');
  assert.equal(tagPageUrl('qwen3.8', '27b'), 'https://ollama.com/library/qwen3.8:27b');
});

test('search results are cached on disk, 0600, and a new process reads them back', async () => {
  const dataDir = await tmp();
  const page = await fixture('search-qwen.html');
  let calls = 0;
  const lib = createOllamaLibrary({ dataDir, fetchImpl: async () => { calls += 1; return html(page); } });
  const first = await lib.search({ q: 'qwen' });
  assert.equal(first.results.length, 8);
  assert.deepEqual([first.page, first.hasMore, first.goDark, first.stale], [1, true, false, false]);
  await lib.search({ q: 'qwen' });
  assert.equal(calls, 1, 'the second search is served from the cache');
  await lib.flush();

  const file = path.join(dataDir, LIBRARY_CACHE_FILE);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const again = createOllamaLibrary({ dataDir, fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal((await again.search({ q: 'qwen' })).results.length, 8);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('the first result is written at once; a burst lands by the next flush', async () => {
  const dataDir = await tmp();
  const page = await fixture('search-qwen.html');
  const lib = createOllamaLibrary({ dataDir, fetchImpl: async () => html(page) });
  const file = path.join(dataDir, LIBRARY_CACHE_FILE);
  const keys = async () => Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).entries);
  await lib.search({ q: 'a' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await keys()).length, 1, 'no waiting for a timer');
  await lib.search({ q: 'b' });
  await lib.search({ q: 'c' });
  await lib.flush();
  assert.equal((await keys()).length, 3);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('past the TTL a failed fetch serves the last good copy marked stale', async () => {
  let clock = 1_000_000;
  let fail = false;
  const page = await fixture('tags-qwen3.8.html');
  const lib = createOllamaLibrary({
    now: () => clock,
    fetchImpl: async () => { if (fail) throw new Error('offline'); return html(page); }
  });
  assert.equal((await lib.tags('qwen3.8')).stale, false);
  clock += 2 * 60 * 60 * 1000;
  fail = true;
  const stale = await lib.tags('qwen3.8');
  assert.equal(stale.stale, true);
  assert.equal(stale.tags.length, 4);
});

test('with nothing cached, a failure is a LibraryError with the short sentence', async () => {
  const offline = createOllamaLibrary({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(offline.search({ q: 'x' }), (err) => err instanceof LibraryError && err.message === LIBRARY_ERRORS.unreachable);

  const down = createOllamaLibrary({ fetchImpl: async () => html('oops', 503) });
  await assert.rejects(down.search({ q: 'x' }), (err) => err instanceof LibraryError && err.kind === 'unreachable');

  const missing = createOllamaLibrary({ fetchImpl: async () => html('not found', 404) });
  await assert.rejects(missing.tags('nope'), (err) => err instanceof LibraryError && err.message === LIBRARY_ERRORS.notFound);

  const changed = createOllamaLibrary({ fetchImpl: async () => html('<html><body>A new design</body></html>') });
  await assert.rejects(changed.search({ q: 'x' }), (err) => err instanceof LibraryError && err.message === LIBRARY_ERRORS.unreadable);
  await assert.rejects(changed.tags('qwen3'), (err) => err instanceof LibraryError && err.kind === 'unreadable');
});

test('a failure answers the same request for 30 seconds instead of waiting again', async () => {
  let clock = 0;
  let calls = 0;
  const lib = createOllamaLibrary({ now: () => clock, fetchImpl: async () => { calls += 1; throw new Error('offline'); } });
  await assert.rejects(lib.search({ q: 'x' }), LibraryError);
  clock += 10_000;
  await assert.rejects(lib.search({ q: 'x' }), LibraryError);
  assert.equal(calls, 1);
  clock += 25_000;
  await assert.rejects(lib.search({ q: 'x' }), LibraryError);
  assert.equal(calls, 2);
});

test('Go Dark: nothing is fetched and nothing is returned', async () => {
  let calls = 0;
  const lib = createOllamaLibrary({ isGoDark: () => true, fetchImpl: async () => { calls += 1; return html(''); } });
  assert.deepEqual(await lib.search({ q: 'qwen' }), { page: 1, hasMore: false, goDark: true, stale: false, results: [] });
  assert.deepEqual(await lib.tags('qwen3'), { name: 'qwen3', goDark: true, stale: false, tags: [] });
  assert.deepEqual(await lib.tagRows('qwen3'), { goDark: true });
  assert.deepEqual(await lib.tagDigests('qwen3', '8b'), { goDark: true });
  assert.equal(calls, 0);

  // Switched on mid-request: the egress guard's refusal reads as Go Dark, not an outage.
  const guarded = createOllamaLibrary({
    fetchImpl: async () => { throw Object.assign(new Error('Go Dark is on'), { code: 'GO_DARK' }); }
  });
  assert.equal((await guarded.search({ q: 'qwen' })).goDark, true);
});

test('every fetch is bounded: a page past 4 MB is refused, a silent host times out', async () => {
  const huge = createOllamaLibrary({ fetchImpl: async () => html('x'.repeat(4 * 1024 * 1024 + 10)) });
  await assert.rejects(huge.search({ q: 'x' }), (err) => err instanceof LibraryError && err.kind === 'unreadable');

  /** @type {any} */
  let seen = null;
  const silent = createOllamaLibrary({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      seen = init;
      // AbortSignal.timeout does not hold the event loop open; without this the
      // runner can drain the loop and cancel the test before the abort fires.
      const hold = setTimeout(() => {}, 5000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(hold); reject(init.signal?.reason); });
    })
  });
  const started = Date.now();
  await assert.rejects(silent.search({ q: 'x' }, { timeoutMs: 50 }), (err) => err instanceof LibraryError && err.kind === 'unreachable');
  assert.ok(Date.now() - started < 2000);
  assert.ok(seen?.signal instanceof AbortSignal);
});

test('identical requests in flight share one fetch', async () => {
  let calls = 0;
  const page = await fixture('search-qwen.html');
  const lib = createOllamaLibrary({ fetchImpl: async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return html(page); } });
  const [a, b] = await Promise.all([lib.search({ q: 'qwen' }), lib.search({ q: 'qwen' })]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
});

test('an unreadable cache file is ignored', async () => {
  const dataDir = await tmp();
  await fs.writeFile(path.join(dataDir, LIBRARY_CACHE_FILE), '{not json');
  const page = await fixture('search-qwen.html');
  const lib = createOllamaLibrary({ dataDir, fetchImpl: async () => html(page) });
  assert.equal((await lib.search({ q: 'qwen' })).results.length, 8);
  await lib.flush();
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, LIBRARY_CACHE_FILE), 'utf8')).version, 1);
  await fs.rm(dataDir, { recursive: true, force: true });
});
