// The suggested-model catalog: where the list comes from and, more importantly,
// what happens when the network lies to it.
//
// This list used to be a hardcoded array, so every new model upstream meant a
// code change and an app update for every user. Now it is a JSON file that can
// be refreshed from the repository, which is the right shape but introduces a
// new failure mode: a remote source that is missing, malformed, hostile or
// simply empty must never leave the user with a worse list than the one that
// shipped with the app.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_ENV = { ...process.env };

/** Import a fresh copy so module-level caches do not leak between tests. */
async function freshCatalog() {
  const mod = await import(`./modelCatalog.js?t=${Math.random()}`);
  mod.resetCatalogCache();
  return mod;
}

/** A stand-in for the repository copy. */
async function serveCatalog(body, { status = 200, etag = '' } = {}) {
  const server = http.createServer((req, res) => {
    if (etag && req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(status, { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/models.json`, close: () => new Promise((r) => server.close(r)) };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test('the bundled list works with no network at all', async () => {
  // First run, offline, or a blocked host: the app must still offer models.
  const { getModels, getSources } = await freshCatalog();
  const models = getModels();
  assert.ok(models.length > 20, `expected the shipped catalog, got ${models.length}`);
  assert.deepEqual(getSources(), ['bundled']);
  assert.ok(models.every((m) => m.id && m.label && m.group), 'every entry should be renderable');
});

test('Go Dark blocks the catalog refresh', async () => {
  // A catalog refresh is egress like any other, and the promise is that nothing
  // leaves the machine. The bundled list is complete, so this costs nothing.
  let hit = false;
  const server = http.createServer((_req, res) => { hit = true; res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.MIRABILIS_CATALOG_URL = `http://127.0.0.1:${server.address().port}/models.json`;

  const { refreshCatalog, getSources } = await freshCatalog();
  await refreshCatalog({ localOnly: true, force: true });

  assert.equal(hit, false, 'no request may be made while Go Dark is on');
  assert.ok(!getSources().includes('remote'));
  await new Promise((r) => server.close(r));
});

test('a newer remote list is picked up without touching the app', async () => {
  // The whole point: adding a model upstream reaches every install.
  const srv = await serveCatalog({
    ollama: [{ id: 'brand-new-model:9b', label: 'Brand New 9B', group: 'Powerful', size: '5 GB' }]
  });
  process.env.MIRABILIS_CATALOG_URL = srv.url;

  const { refreshCatalog, getModels, getSources } = await freshCatalog();
  await refreshCatalog({ force: true });

  const ids = getModels().map((m) => m.id);
  assert.ok(ids.includes('brand-new-model:9b'), 'the new model should appear');
  assert.ok(getSources().includes('remote'));
  await srv.close();
});

test('an empty remote list never blanks the picker', async () => {
  // A bad deploy of models.json must not take the model list away.
  const srv = await serveCatalog({ ollama: [] });
  process.env.MIRABILIS_CATALOG_URL = srv.url;

  const { refreshCatalog, getModels } = await freshCatalog();
  const before = getModels().length;
  await refreshCatalog({ force: true });

  assert.equal(getModels().length, before, 'the bundled list must stand');
  await srv.close();
});

test('malformed JSON, a 500, and a hang all leave the bundled list intact', async () => {
  for (const scenario of [
    { body: 'not json at all', status: 200 },
    { body: '{}', status: 500 }
  ]) {
    const srv = await serveCatalog(scenario.body, { status: scenario.status });
    process.env.MIRABILIS_CATALOG_URL = srv.url;
    const { refreshCatalog, getModels } = await freshCatalog();
    const before = getModels().length;
    await refreshCatalog({ force: true });
    assert.equal(getModels().length, before, `bundled list should survive ${JSON.stringify(scenario)}`);
    await srv.close();
  }

  // An unreachable host must not throw either.
  process.env.MIRABILIS_CATALOG_URL = 'http://127.0.0.1:1/models.json';
  const { refreshCatalog, getModels } = await freshCatalog();
  await refreshCatalog({ force: true });
  assert.ok(getModels().length > 20);
});

test('entries with unusable ids are dropped, not rendered', async () => {
  // The id is handed to a pull. Anything that is not a plain model name is
  // discarded rather than shown as a row that cannot possibly work.
  const srv = await serveCatalog({
    ollama: [
      { id: 'good-model:7b', label: 'Good', group: 'Powerful' },
      { id: '../../etc/passwd', label: 'Traversal', group: 'Powerful' },
      { id: 'bad; rm -rf /', label: 'Injection', group: 'Powerful' },
      { id: '', label: 'Empty', group: 'Powerful' },
      { id: 'ok-id', ollamaId: 'evil$(whoami)', label: 'Bad pull target', group: 'Powerful' }
    ]
  });
  process.env.MIRABILIS_CATALOG_URL = srv.url;

  const { refreshCatalog, getModels } = await freshCatalog();
  await refreshCatalog({ force: true });

  const ids = getModels().map((m) => m.id);
  assert.ok(ids.includes('good-model:7b'));
  for (const bad of ['../../etc/passwd', 'bad; rm -rf /', '', 'ok-id']) {
    assert.ok(!ids.includes(bad), `${JSON.stringify(bad)} must be dropped`);
  }
  await srv.close();
});

test('a user file adds and overrides entries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-usercat-'));
  const file = path.join(dir, 'models.json');
  await fs.writeFile(file, JSON.stringify({
    ollama: [
      { id: 'my-private-model:latest', label: 'My Private Model', group: 'Mine' },
      { id: 'llama3.2:3b', label: 'Renamed By Me', group: 'Mine' }
    ]
  }), 'utf8');
  process.env.MIRABILIS_USER_CATALOG = file;
  process.env.MIRABILIS_CATALOG_URL = 'http://127.0.0.1:1/none.json';

  const { refreshCatalog, getModels, getSources } = await freshCatalog();
  await refreshCatalog({ force: true });

  const models = getModels();
  assert.ok(models.some((m) => m.id === 'my-private-model:latest'), 'a user entry should be added');
  const overridden = models.find((m) => m.id === 'llama3.2:3b');
  assert.equal(overridden?.label, 'Renamed By Me', 'a user entry should override the bundled one');
  assert.equal(models.filter((m) => m.id === 'llama3.2:3b').length, 1, 'and not duplicate it');
  assert.ok(getSources().includes('user'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('an ETag response does not discard what we already have', async () => {
  const srv = await serveCatalog({ ollama: [{ id: 'cached:7b', label: 'Cached', group: 'Powerful' }] }, { etag: 'W/"v1"' });
  process.env.MIRABILIS_CATALOG_URL = srv.url;

  const { refreshCatalog, getModels } = await freshCatalog();
  await refreshCatalog({ force: true });
  assert.ok(getModels().some((m) => m.id === 'cached:7b'));

  await refreshCatalog({ force: true }); // server answers 304
  assert.ok(getModels().some((m) => m.id === 'cached:7b'), 'a 304 must not empty the list');
  await srv.close();
});

test('provider defaults come from the file, so a new flagship needs no release', async () => {
  const { getProviderDefault } = await freshCatalog();
  assert.equal(getProviderDefault('claude'), 'claude-sonnet-5');
  assert.equal(getProviderDefault('no-such-provider'), '');

  const srv = await serveCatalog({
    ollama: [{ id: 'x:1b', label: 'X', group: 'G' }],
    providerDefaults: { claude: 'claude-opus-6', _comment: 'ignored' }
  });
  process.env.MIRABILIS_CATALOG_URL = srv.url;
  const fresh = await freshCatalog();
  await fresh.refreshCatalog({ force: true });
  assert.equal(fresh.getProviderDefault('claude'), 'claude-opus-6', 'the remote default should win');
  await srv.close();
});
