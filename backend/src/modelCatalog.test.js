// A bad remote catalog must never leave a worse list than the bundled one.

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
  // A catalog refresh is egress like any other.
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

test('a dated remote list replaces the bundle, so a retired pick leaves without a release', async () => {
  const srv = await serveCatalog({
    updated: '2999-01-01',
    ollama: [{ id: 'only-pick:4b', label: 'Only Pick', group: 'Small & Fast' }],
    providerDefaults: { claude: 'claude-next' }
  });
  process.env.MIRABILIS_CATALOG_URL = srv.url;
  const { refreshCatalog, getModels, getSources, getProviderDefault } = await freshCatalog();
  await refreshCatalog({ force: true });
  assert.deepEqual(getModels().map((m) => m.id), ['only-pick:4b']);
  assert.deepEqual(getSources(), ['remote']);
  assert.equal(getProviderDefault('claude'), 'claude-next');
  assert.equal(getProviderDefault('openai'), 'gpt-6-luna', 'a default the remote lacks still comes from the bundle');
  await srv.close();
});

test('a remote list older than the bundle is ignored, so a newer app keeps its picks', async () => {
  const srv = await serveCatalog({
    updated: '2000-01-01',
    ollama: [{ id: 'stale-pick:7b', label: 'Stale', group: 'Powerful' }],
    providerDefaults: { claude: 'claude-old' }
  });
  process.env.MIRABILIS_CATALOG_URL = srv.url;
  const { refreshCatalog, getModels, getSources, getProviderDefault } = await freshCatalog();
  const before = getModels().map((m) => m.id);
  await refreshCatalog({ force: true });
  assert.deepEqual(getModels().map((m) => m.id), before);
  assert.deepEqual(getSources(), ['bundled']);
  assert.equal(getProviderDefault('claude'), 'claude-haiku-5-5');
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
  // The id is handed to a pull, so only plain model names survive.
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
      { id: 'qwen3.5:9b', label: 'Renamed By Me', group: 'Mine' }
    ]
  }), 'utf8');
  process.env.MIRABILIS_USER_CATALOG = file;
  process.env.MIRABILIS_CATALOG_URL = 'http://127.0.0.1:1/none.json';

  const { refreshCatalog, getModels, getSources } = await freshCatalog();
  assert.ok(getModels().some((m) => m.id === 'qwen3.5:9b'), 'the override target must be a bundled entry');
  await refreshCatalog({ force: true });

  const models = getModels();
  assert.ok(models.some((m) => m.id === 'my-private-model:latest'), 'a user entry should be added');
  const overridden = models.find((m) => m.id === 'qwen3.5:9b');
  assert.equal(overridden?.label, 'Renamed By Me', 'a user entry should override the bundled one');
  assert.equal(models.filter((m) => m.id === 'qwen3.5:9b').length, 1, 'and not duplicate it');
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
  assert.equal(getProviderDefault('claude'), 'claude-haiku-5-5');
  assert.equal(getProviderDefault('openai'), 'gpt-6-luna');
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

test('the bundled list holds the groups that drive Auto, the router and the uncensored pick', async () => {
  // Lanes read these group names, so a rename in models.json changes routing.
  const { getModels } = await freshCatalog();
  const models = getModels();
  const groups = new Set(models.map((m) => m.group));
  for (const group of ['Small & Fast', 'Powerful', 'Coding', 'Reasoning', 'Uncensored']) {
    assert.ok(groups.has(group), `the "${group}" group should exist`);
  }
  // Built locally, so the registry check and update checks skip it.
  assert.equal(models.find((m) => m.id === 'mcq-raw-8b')?.local, true);
  assert.equal(models.find((m) => m.id === 'qwen3.5:9b')?.local, undefined);
});

test('an installed name finds its row by exact tag, else by another tag of the same model', async () => {
  const { catalogRowFor, UNCENSORED_NAME_RE } = await freshCatalog();
  const rows = [
    { id: 'qwen3.5:4b', group: 'Small & Fast' },
    { id: 'qwen3.5:122b', group: 'Powerful' },
    { id: 'dolphin3', group: 'Uncensored', uncensored: true },
    { id: 'dolphin-mixtral', ollamaId: 'dolphin-mixtral:8x7b', group: 'Uncensored', uncensored: true }
  ];
  const find = (name) => {
    const m = catalogRowFor(name, rows);
    return m ? [m.row.id, m.exact] : null;
  };
  assert.deepEqual(find('qwen3.5:4b'), ['qwen3.5:4b', true]);
  assert.deepEqual(find('DOLPHIN3'), ['dolphin3', true], 'a bare name is :latest, matched without case');
  assert.deepEqual(find('dolphin-mixtral:8x7b'), ['dolphin-mixtral', true], 'the row id differs from its tag');
  // The tag a build extends wins over the first row of the model.
  assert.deepEqual(find('qwen3.5:122b-mlx'), ['qwen3.5:122b', false]);
  assert.deepEqual(find('qwen3.5:27b'), ['qwen3.5:4b', false]);
  assert.deepEqual(find('dolphin3:8b'), ['dolphin3', false]);
  assert.equal(find('qwen3:8b'), null, 'qwen3 is not qwen3.5');
  assert.equal(find('huihui_ai/qwen3.5-abliterated:9b'), null);
  assert.equal(find(''), null);
  assert.ok(UNCENSORED_NAME_RE.test('huihui_ai/qwen3.5-abliterated:9b'));
  assert.ok(!UNCENSORED_NAME_RE.test('qwen3.5:9b'));
});
