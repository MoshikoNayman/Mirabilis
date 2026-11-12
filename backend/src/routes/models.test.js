// /api/models on a bare express app with a fake guard and a fake Ollama on loopback:
// the token on writes, Go Dark, the installed and update views, library search and
// tags, install jobs and uninstall. ollama.com and the registry are stubbed.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import path from 'node:path';

import { createInstallJobs, INSTALL_ERRORS } from '../modelInstallJobs.js';
import { createOllamaLibrary, LIBRARY_ERRORS } from '../ollamaLibrary.js';
import { createModelsRouter, OLLAMA_DOWNLOAD_URL, withTag } from './models.js';

const TOKEN = 'test-session-token';
const DIGEST = '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {Record<string, (req: http.IncomingMessage, res: http.ServerResponse, body: any) => any>} */
let ollamaRoutes = {};
/** @type {{ url: string, body: any }[]} */
let ollamaSeen = [];
let goDark = false;
/** @type {string[]} */
let libraryUrls = [];
let libraryAnswer = (_url) => new Response('', { status: 503 });
let listCalls = 0;
/** @type {any[]} */
let updateChecks = [];

/** @type {http.Server} */
let ollama;
/** @type {http.Server} */
let api;
let base = '';
let ollamaUrl = '';

const INSTALLED = [
  {
    name: 'qwen3:8b', sizeBytes: 5225388164, digest: `sha256:${DIGEST}`, modifiedAt: '2026-09-06T23:05:46.272730223-04:00',
    family: 'qwen3', format: 'gguf', paramSize: '8.2B', quant: 'Q4_K_M'
  },
  { name: 'dolphin3:latest', sizeBytes: 4920757726, digest: DIGEST, modifiedAt: '2026-07-19T18:30:26-04:00', family: 'llama', format: 'gguf', paramSize: '8.0B', quant: 'Q4_K_M' },
  { name: 'mcq-raw-8b:latest', sizeBytes: 4920757726, digest: DIGEST, modifiedAt: null, family: 'llama', format: 'gguf', paramSize: '8.0B', quant: 'Q4_K_M' },
  { name: 'huihui_ai/qwen3-abliterated:8b', sizeBytes: 5e9, digest: 'not-a-digest', modifiedAt: 'garbage' }
];

before(async () => {
  ollama = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    ollamaSeen.push({ url: `${req.method} ${req.url}`, body });
    const route = ollamaRoutes[`${req.method} ${String(req.url).split('?')[0]}`];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"no route"}');
      return;
    }
    await route(req, res, body);
  });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', () => r(undefined)));
  ollamaUrl = `http://127.0.0.1:${/** @type {any} */ (ollama.address()).port}`;

  /** @type {import('express').RequestHandler} */
  const guard = (req, res, next) => {
    if (req.headers.authorization === `Bearer ${TOKEN}`) next();
    else res.status(401).json({ error: 'Unauthorized' });
  };
  const library = createOllamaLibrary({
    isGoDark: () => goDark,
    fetchImpl: async (url) => { libraryUrls.push(String(url)); return libraryAnswer(String(url)); }
  });
  const app = express();
  app.use('/api/models', createModelsRouter({
    guard,
    ollamaBaseUrl: () => ollamaUrl,
    isGoDark: () => goDark,
    library,
    jobs: createInstallJobs({ ollamaBaseUrl: () => ollamaUrl }),
    updates: {
      check: async (input) => { updateChecks.push(input); return { checkedAt: null, goDark, results: { 'qwen3:8b': { status: 'current' } } }; },
      latestOllama: async () => '0.40.16',
      flush: async () => {}
    },
    listInstalled: async (baseUrl) => { listCalls += 1; assert.equal(baseUrl, ollamaUrl); return INSTALLED; },
    modelInfo: async (_baseUrl, name) => (name === 'qwen3:8b'
      ? { contextWindow: 40960, paramCount: 8e9, capabilities: ['completion', 'tools', 'thinking'], vision: false }
      : { contextWindow: null, paramCount: null, capabilities: [], vision: false }),
    catalog: () => [
      { id: 'dolphin3', label: 'Dolphin 3.0 8B', group: 'Uncensored', ollamaId: 'dolphin3', uncensored: true },
      { id: 'qwen3:8b', label: 'Qwen3 8B', group: 'Small & Fast', ollamaId: 'qwen3:8b' },
      { id: 'mcq-raw-8b', label: 'MCQ-Raw-8B', group: 'MCQ', ollamaId: 'mcq-raw-8b', uncensored: true, local: true }
    ],
    detectInstall: async () => ({ install: 'homebrew', updateCommand: 'brew upgrade ollama' }),
    statfsImpl: async (p) => {
      if (p !== path.resolve('/models/here')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { bsize: 4096, blocks: 1000, bavail: 250 };
    },
    host: { env: { OLLAMA_MODELS: '/models/here' }, platform: 'darwin', home: '/Users/me' }
  }));
  api = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${/** @type {any} */ (api.address()).port}/api/models`;
});

after(async () => {
  for (const s of [api, ollama]) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(() => r(undefined)));
  }
});

/**
 * @param {string} method
 * @param {string} route
 * @param {{ body?: any, auth?: boolean }} [opts]
 */
async function call(method, route, { body, auth = false } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const ollamaUp = () => {
  ollamaRoutes = {
    'GET /api/version': (_req, res) => res.end(JSON.stringify({ version: '0.20.5' })),
    'GET /api/ps': (_req, res) => res.end(JSON.stringify({ models: [{ name: 'qwen3:8b', size_vram: 1 }] }))
  };
};

test('the router will not mount without a guard', () => {
  assert.throws(() => createModelsRouter(/** @type {any} */ ({})), /guard/);
});

test('installing, canceling and deleting need the session token; reads do not', async () => {
  ollamaUp();
  for (const [method, route] of [['POST', '/install-jobs'], ['POST', '/install-jobs/x/cancel'], ['DELETE', '/qwen3%3A8b']]) {
    const res = await call(method, route, { body: method === 'DELETE' ? undefined : { modelId: 'qwen3:8b' } });
    assert.equal(res.status, 401, `${method} ${route}`);
  }
  assert.equal(ollamaSeen.some((s) => s.url.startsWith('DELETE')), false, 'nothing reached Ollama');
  for (const route of ['/installed', '/updates', '/install-jobs']) assert.equal((await call('GET', route)).status, 200, route);
});

test('Go Dark: install is refused with the sentence, discovery fetches nothing', async () => {
  goDark = true;
  libraryUrls = [];
  try {
    const install = await call('POST', '/install-jobs', { body: { modelId: 'qwen3:8b' } });
    assert.equal(install.status, 403);
    assert.equal(install.body.error, 'Blocked by Go Dark. Turn it off to install.');
    assert.deepEqual((await call('GET', '/library?q=qwen')).body, { page: 1, hasMore: false, goDark: true, stale: false, results: [] });
    assert.deepEqual((await call('GET', '/library/qwen3/tags')).body, { name: 'qwen3', goDark: true, stale: false, tags: [] });
    assert.deepEqual(libraryUrls, []);
  } finally {
    goDark = false;
  }
});

test('GET /installed: runtime, disk and every installed model with catalog, loaded and local flags', async () => {
  ollamaUp();
  const res = await call('GET', '/installed');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.runtime, {
    reachable: true, version: '0.20.5', latest: '0.40.16', updateAvailable: true,
    install: 'homebrew', updateCommand: 'brew upgrade ollama', downloadUrl: OLLAMA_DOWNLOAD_URL
  });
  assert.deepEqual(res.body.disk, { path: path.resolve('/models/here'), freeBytes: 250 * 4096, totalBytes: 1000 * 4096 });
  const [qwen, dolphin, mcq, user] = res.body.models;
  assert.deepEqual(qwen, {
    name: 'qwen3:8b', sizeBytes: 5225388164, digest: DIGEST, modifiedAt: '2026-09-07T03:05:46.272Z',
    family: 'qwen3', paramSize: '8.2B', quant: 'Q4_K_M', format: 'gguf',
    capabilities: ['completion', 'tools', 'thinking'], contextWindow: 40960, loaded: true,
    catalog: { id: 'qwen3:8b', label: 'Qwen3 8B', group: 'Small & Fast' }, uncensored: false, local: false
  });
  // A bare catalog id means :latest.
  assert.deepEqual(dolphin.catalog, { id: 'dolphin3', label: 'Dolphin 3.0 8B', group: 'Uncensored' });
  assert.equal(dolphin.uncensored, true);
  assert.equal(dolphin.loaded, false);
  assert.equal(mcq.local, true);
  assert.equal(user.catalog, null);
  assert.equal(user.uncensored, true, 'abliterated in the name');
  assert.equal(user.digest, null);
  assert.equal(user.modifiedAt, null);
  assert.equal(res.body.models.length, 4);
});

test('GET /installed with Ollama down: not reachable, no models, and nothing listed', async () => {
  ollamaRoutes = { 'GET /api/version': (_req, res) => { res.writeHead(500); res.end('boom'); } };
  listCalls = 0;
  const res = await call('GET', '/installed');
  assert.equal(res.status, 200);
  assert.equal(res.body.runtime.reachable, false);
  assert.equal(res.body.runtime.version, null);
  assert.equal(res.body.runtime.updateAvailable, false);
  assert.deepEqual(res.body.models, []);
  assert.equal(listCalls, 0);
});

test('GET /updates hands the installed digests to the checker, refresh included', async () => {
  updateChecks = [];
  const res = await call('GET', '/updates?refresh=1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { checkedAt: null, goDark: false, results: { 'qwen3:8b': { status: 'current' } } });
  assert.equal(updateChecks[0].refresh, true);
  assert.deepEqual(updateChecks[0].models[0], { name: 'qwen3:8b', digest: DIGEST });
  assert.equal(updateChecks[0].models[3].digest, '', 'a bad digest is passed as none');
  await call('GET', '/updates');
  assert.equal(updateChecks[1].refresh, false);
});

test('GET /library passes the filters to ollama.com and answers 502 when it is down', async () => {
  libraryUrls = [];
  libraryAnswer = () => new Response('<div hidden data-result-count="0" data-has-more="false"></div>', { status: 200 });
  const res = await call('GET', '/library?q=qwen&c=tools&c=vision&s=16&o=newest&page=2');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { page: 2, hasMore: false, goDark: false, stale: false, results: [] });
  assert.deepEqual(libraryUrls, ['https://ollama.com/search?q=qwen&c=local&c=tools&c=vision&s=16&o=newest&page=2']);

  libraryAnswer = () => { throw new TypeError('fetch failed'); };
  const down = await call('GET', '/library?q=llama');
  assert.equal(down.status, 502);
  assert.deepEqual(down.body, { error: LIBRARY_ERRORS.unreachable });
});

test('GET /library/:name/tags takes model and user/model, encoded or not', async () => {
  libraryUrls = [];
  const row = (name) => `<a href="/${name}:latest" class="md:hidden flex"><span class="font-mono">0123456789ab</span> \u2022 4.7GB \u2022 8K context window \u2022 Text input</a>`;
  libraryAnswer = (url) => new Response(row(url.includes('/library/') ? 'library/qwen3' : 'someone/model'), { status: 200 });
  const plain = await call('GET', '/library/qwen3/tags');
  assert.equal(plain.status, 200);
  assert.equal(plain.body.name, 'qwen3');
  assert.deepEqual(plain.body.tags.map((t) => [t.name, t.sizeBytes, t.context, t.latest]), [['qwen3:latest', 4.7e9, 8192, true]]);
  assert.equal((await call('GET', '/library/someone%2Fmodel/tags')).body.name, 'someone/model');
  assert.equal((await call('GET', '/library/someone/model/tags')).body.tags[0].name, 'someone/model:latest');
  assert.deepEqual(libraryUrls, ['https://ollama.com/library/qwen3/tags', 'https://ollama.com/someone/model/tags']);

  assert.equal((await call('GET', '/library/bad%20name/tags')).status, 400);
  libraryAnswer = () => new Response('missing', { status: 404 });
  const missing = await call('GET', '/library/nope/tags');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, LIBRARY_ERRORS.notFound);
});

test('install jobs: start, dedupe, list, poll, cancel', async () => {
  ollamaRoutes = {
    'POST /api/pull': async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (let i = 1; i < 400 && !res.destroyed; i += 1) {
        res.write(`${JSON.stringify({ status: 'pulling aaaa', digest: 'sha256:aaaa', total: 100000, completed: i * 10 })}\n`);
        await sleep(5);
      }
      res.end();
    }
  };
  const started = await call('POST', '/install-jobs', { body: { modelId: 'qwen3:8b' }, auth: true });
  assert.equal(started.status, 202);
  assert.equal(started.body.job.modelId, 'qwen3:8b');
  assert.equal(started.body.deduped, undefined);
  const again = await call('POST', '/install-jobs', { body: { modelId: 'qwen3:8b' }, auth: true });
  assert.deepEqual([again.status, again.body.deduped, again.body.job.id], [202, true, started.body.job.id]);

  await sleep(40);
  const polled = await call('GET', `/install-jobs/${started.body.job.id}`);
  assert.equal(polled.body.job.status, 'running');
  assert.equal(polled.body.job.totalBytes, 100000);
  assert.ok(polled.body.job.pct >= 0);
  assert.equal((await call('GET', '/install-jobs')).body.jobs[0].id, started.body.job.id);

  // A model being installed cannot be deleted under it.
  const busy = await call('DELETE', '/qwen3%3A8b', { auth: true });
  assert.deepEqual([busy.status, busy.body.error], [409, 'Install running. Cancel it, then delete.']);

  const canceled = await call('POST', `/install-jobs/${started.body.job.id}/cancel`, { auth: true });
  assert.equal(canceled.body.cancelRequested, true);
  for (let i = 0; i < 200 && (await call('GET', `/install-jobs/${started.body.job.id}`)).body.job.status !== 'canceled'; i += 1) await sleep(5);
  assert.equal((await call('GET', `/install-jobs/${started.body.job.id}`)).body.job.status, 'canceled');

  assert.equal((await call('GET', '/install-jobs/nope')).status, 404);
  assert.equal((await call('POST', '/install-jobs/nope/cancel', { auth: true })).status, 404);
  assert.equal((await call('POST', '/install-jobs', { body: { modelId: 'bad; rm -rf /' }, auth: true })).status, 400);
  assert.equal((await call('POST', '/install-jobs', { body: {}, auth: true })).status, 400);
});

test('DELETE: forwards the exact name, and failures are short sentences', async () => {
  ollamaSeen = [];
  ollamaRoutes = { 'DELETE /api/delete': (_req, res) => res.end('') };
  const ok = await call('DELETE', `/${encodeURIComponent('hf.co/user/repo:Q4_K_M')}`, { auth: true });
  assert.deepEqual([ok.status, ok.body], [200, { ok: true }]);
  assert.deepEqual(ollamaSeen.map((s) => [s.url, s.body]), [['DELETE /api/delete', { model: 'hf.co/user/repo:Q4_K_M' }]]);

  ollamaRoutes = { 'DELETE /api/delete': (_req, res) => { res.writeHead(404); res.end('{"error":"model \'gone:1b\' not found"}'); } };
  const gone = await call('DELETE', '/gone%3A1b', { auth: true });
  assert.deepEqual([gone.status, gone.body.error], [404, 'Not installed. Refresh the list.']);

  ollamaRoutes = { 'DELETE /api/delete': (_req, res) => { res.writeHead(500); res.end('{"error":"permission denied\\nmore"}'); } };
  const denied = await call('DELETE', '/x%3A1b', { auth: true });
  assert.deepEqual([denied.status, denied.body.error], [500, 'permission denied']);

  assert.equal((await call('DELETE', '/bad%3B%20rm', { auth: true })).status, 400);
});

test('DELETE with Ollama not running says so', async () => {
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {any} */ (closed.address()).port;
  await new Promise((r) => closed.close(() => r(undefined)));
  const app = express();
  app.use('/api/models', createModelsRouter({
    guard: (_req, _res, next) => next(),
    ollamaBaseUrl: () => `http://127.0.0.1:${port}`,
    library: createOllamaLibrary({ fetchImpl: async () => new Response('', { status: 500 }) }),
    updates: { check: async () => ({ checkedAt: null, goDark: false, results: {} }), latestOllama: async () => null, flush: async () => {} }
  }));
  const s = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  try {
    const res = await fetch(`http://127.0.0.1:${/** @type {any} */ (s).address().port}/api/models/qwen3%3A8b`, { method: 'DELETE' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, INSTALL_ERRORS.ollamaDown);
  } finally {
    /** @type {any} */ (s).closeAllConnections?.();
    await new Promise((r) => /** @type {any} */ (s).close(() => r(undefined)));
  }
});

test('a bare id is the :latest tag', () => {
  assert.equal(withTag('dolphin3'), 'dolphin3:latest');
  assert.equal(withTag('Qwen3:8B'), 'qwen3:8b');
  assert.equal(withTag('hf.co/u/r'), 'hf.co/u/r:latest');
  assert.equal(withTag(''), '');
});
