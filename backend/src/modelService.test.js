// The Ollama model list: every installed tag shows, and installed rows carry
// what Settings and the update checks read.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { listModels, resolveOllamaModel, getEffectiveModel } from './modelService.js';
import { getModels, getProviderDefault } from './modelCatalog.js';

/** A stand-in catalog, so these tests do not move with the shipped models.json. */
const CATALOG = [
  { id: 'qwen3.5:9b', label: 'Qwen 3.5 9B', group: 'Small & Fast', ollamaId: 'qwen3.5:9b' },
  { id: 'gemma4:e4b', label: 'Gemma 4 E4B', group: 'Small & Fast', ollamaId: 'gemma4:e4b' },
  { id: 'qwen3.8:27b', label: 'Qwen 3.8 27B', group: 'Powerful', ollamaId: 'qwen3.8:27b' },
  { id: 'glm-ocr', label: 'GLM-OCR', group: 'Vision', ollamaId: 'glm-ocr' },
  { id: 'dolphin3', label: 'Dolphin 3.0 8B', group: 'Uncensored', ollamaId: 'dolphin3', uncensored: true },
  { id: 'dolphin-mixtral', label: 'Dolphin Mixtral 8x7B', group: 'Uncensored', ollamaId: 'dolphin-mixtral:8x7b', uncensored: true }
];

const hex = (c) => c.repeat(64);

/**
 * A fake Ollama daemon. `show` maps a model name to its /api/show answer, or
 * to a number for an error status. Tracks the most /api/show calls in flight.
 */
async function fakeOllama(names, { show = {}, delayMs = 0 } = {}) {
  const stats = { inFlight: 0, maxInFlight: 0, shows: 0 };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/tags')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        models: names.map((name, i) => ({
          name,
          model: name,
          modified_at: `2026-11-0${(i % 9) + 1}T10:00:00.123456789-05:00`,
          size: (i + 1) * 1e9,
          digest: hex(String(i % 10)),
          details: { format: 'gguf', family: name.split(/[:.]/)[0], parameter_size: '8B', quantization_level: 'Q4_K_M' }
        }))
      }));
    }
    if (req.url.startsWith('/api/show')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        stats.shows += 1;
        stats.inFlight += 1;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        setTimeout(() => {
          stats.inFlight -= 1;
          const { model } = JSON.parse(raw || '{}');
          const answer = show[model] ?? { capabilities: ['completion'], model_info: { 'general.context_length': 32768 } };
          if (typeof answer === 'number') {
            res.writeHead(answer, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'boom' }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(answer));
        }, delayMs);
      });
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    config: { ollamaBaseUrl: `http://127.0.0.1:${port}`, ollamaModel: '' },
    stats,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

const byId = (list) => new Map(list.map((m) => [m.id, m]));

test('installed tags never vanish behind a catalog row with the same base name', async () => {
  const daemon = await fakeOllama(['qwen3.8:27b-mlx', 'qwen3.8:latest', 'gemma4:e2b', 'qwen3.5:9b']);
  try {
    const list = await listModels(daemon.config, 'ollama', { catalog: CATALOG });
    const rows = byId(list);
    // Only the exact tag marks a row installed.
    assert.equal(rows.get('qwen3.8:27b').available, false);
    assert.equal(rows.get('gemma4:e4b').available, false);
    assert.equal(rows.get('qwen3.5:9b').available, true);
    // Everything else is listed under its own name.
    const extras = list.filter((m) => m.group === 'Installed locally').map((m) => m.id);
    assert.deepEqual(extras, ['qwen3.8:27b-mlx', 'qwen3.8:latest', 'gemma4:e2b']);
    assert.ok(list.filter((m) => m.group === 'Installed locally').every((m) => m.available === true));
    assert.equal(list.filter((m) => m.id === 'qwen3.5:9b').length, 1, 'a catalog tag is not listed twice');
  } finally { await daemon.close(); }
});

test('a bare catalog id is its :latest tag, and no other tag', async () => {
  const daemon = await fakeOllama(['dolphin3:latest', 'glm-ocr:latest', 'dolphin-mixtral:latest']);
  try {
    const list = await listModels(daemon.config, 'ollama', { catalog: CATALOG });
    const rows = byId(list);
    assert.equal(rows.get('dolphin3').available, true);
    assert.equal(rows.get('glm-ocr').available, true);
    // This row pulls 8x7b; :latest is a different tag, so it shows on its own.
    assert.equal(rows.get('dolphin-mixtral').available, false);
    const extras = list.filter((m) => m.group === 'Installed locally').map((m) => m.id);
    assert.deepEqual(extras, ['dolphin-mixtral:latest']);
  } finally { await daemon.close(); }

  const exact = await fakeOllama(['dolphin-mixtral:8x7b']);
  try {
    const rows = byId(await listModels(exact.config, 'ollama', { catalog: CATALOG }));
    assert.equal(rows.get('dolphin-mixtral').available, true);
    assert.equal(rows.get('dolphin-mixtral:8x7b'), undefined);
  } finally { await exact.close(); }
});

test('an extra is flagged uncensored by an uncensored row of the same model, or by its name', async () => {
  const daemon = await fakeOllama(['dolphin-mixtral:latest', 'huihui_ai/qwen3-abliterated:8b', 'qwen3.8:27b-mlx']);
  try {
    const rows = byId(await listModels(daemon.config, 'ollama', { catalog: CATALOG }));
    assert.equal(rows.get('dolphin-mixtral:latest').uncensored, true);
    assert.equal(rows.get('huihui_ai/qwen3-abliterated:8b').uncensored, true);
    assert.equal(rows.get('qwen3.8:27b-mlx').uncensored, undefined);
    assert.equal(rows.get('dolphin-mixtral:latest').group, 'Installed locally', 'the picker group does not move');
  } finally { await daemon.close(); }
});

test('installed rows carry digest, time, family, capabilities and context window', async () => {
  const daemon = await fakeOllama(['qwen3.5:9b', 'qwen3.8:27b-mlx'], {
    show: {
      'qwen3.5:9b': { capabilities: ['completion', 'vision', 'tools', 'thinking'], model_info: { 'qwen35.context_length': 262144 } },
      'qwen3.8:27b-mlx': { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'qwen38.context_length': 131072 } }
    }
  });
  try {
    const rows = byId(await listModels(daemon.config, 'ollama', { catalog: CATALOG }));
    const row = rows.get('qwen3.5:9b');
    assert.equal(row.digest, hex('0'));
    assert.equal(row.modifiedAt, '2026-11-01T15:00:00.123Z');
    assert.equal(row.family, 'qwen3');
    assert.equal(row.format, 'gguf');
    assert.equal(row.sizeBytes, 1e9);
    assert.deepEqual(row.capabilities, ['completion', 'vision', 'tools', 'thinking']);
    assert.equal(row.contextWindow, 262144);

    const extra = rows.get('qwen3.8:27b-mlx');
    assert.equal(extra.digest, hex('1'));
    assert.deepEqual(extra.capabilities, ['completion', 'tools', 'thinking']);
    assert.equal(extra.contextWindow, 131072);

    // Rows that are not installed have nothing to report.
    const missing = rows.get('gemma4:e4b');
    assert.equal(missing.available, false);
    assert.equal(missing.digest, undefined);
    assert.equal(missing.capabilities, undefined);
  } finally { await daemon.close(); }
});

test('a failed show leaves no capabilities and no context window', async () => {
  const daemon = await fakeOllama(['qwen3.5:9b', 'broken:1b'], { show: { 'broken:1b': 500 } });
  try {
    const rows = byId(await listModels(daemon.config, 'ollama', { catalog: CATALOG }));
    const broken = rows.get('broken:1b');
    assert.equal(broken.available, true, 'a model is still listed when show fails');
    assert.deepEqual(broken.capabilities, []);
    assert.equal(broken.contextWindow, null);
    assert.equal(broken.digest, hex('1'), 'the tags facts still arrive');
    assert.deepEqual(rows.get('qwen3.5:9b').capabilities, ['completion']);
  } finally { await daemon.close(); }
});

test('show calls run a few at a time', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `model-${i}:1b`);
  const daemon = await fakeOllama(names, { delayMs: 25 });
  try {
    const list = await listModels(daemon.config, 'ollama', { catalog: CATALOG });
    assert.equal(daemon.stats.shows, 10);
    assert.ok(daemon.stats.maxInFlight <= 4, `at most 4 at once, saw ${daemon.stats.maxInFlight}`);
    assert.ok(list.filter((m) => m.group === 'Installed locally').every((m) => m.contextWindow === 32768));
  } finally { await daemon.close(); }
});

test('Ollama down: catalog rows stay, nothing is installed', async () => {
  const list = await listModels({ ollamaBaseUrl: 'http://127.0.0.1:1', ollamaModel: '' }, 'ollama', { catalog: CATALOG });
  assert.equal(list.length, CATALOG.length);
  assert.ok(list.every((m) => m.available === false && m.selected === false));
});

test('only the requested tag is selected when siblings are installed', async () => {
  const daemon = await fakeOllama(['qwen3.8:latest', 'qwen3.8:27b-mlx', 'qwen3.8:27b']);
  try {
    daemon.config.ollamaModel = 'qwen3.8:27b-mlx';
    const list = await listModels(daemon.config, 'ollama', { catalog: CATALOG });
    assert.deepEqual(list.filter((m) => m.selected).map((m) => m.id), ['qwen3.8:27b-mlx']);
  } finally { await daemon.close(); }
});

test('a requested model resolves to the tag that runs it', () => {
  const installed = ['qwen3.8:27b-mlx', 'qwen3.8:27b', 'dolphin-mixtral:8x7b', 'dolphin3:latest'];
  // Exact beats a sibling listed first.
  assert.equal(resolveOllamaModel(installed, 'qwen3.8:27b', CATALOG), 'qwen3.8:27b');
  // A catalog row id means the row's own tag.
  assert.equal(resolveOllamaModel(installed, 'dolphin-mixtral', CATALOG), 'dolphin-mixtral:8x7b');
  // A bare name is :latest.
  assert.equal(resolveOllamaModel(installed, 'dolphin3', CATALOG), 'dolphin3:latest');
  // Another tag of the same model, then the first installed.
  assert.equal(resolveOllamaModel(installed, 'qwen3.8:4b', CATALOG), 'qwen3.8:27b-mlx');
  assert.equal(resolveOllamaModel(installed, 'llama3', CATALOG), 'qwen3.8:27b-mlx');
  assert.equal(resolveOllamaModel(installed, '', CATALOG), 'qwen3.8:27b-mlx');
  assert.equal(resolveOllamaModel([], 'qwen3:8b', CATALOG), 'qwen3:8b');
});

test('the shipped catalog: each installed tag is a row or an extra, never both or neither', async () => {
  const shipped = getModels();
  const names = [...new Set([
    ...shipped.filter((m) => !m.local).slice(0, 6).map((m) => m.ollamaId || m.id),
    'qwen3.8:27b-mlx', 'qwen3.8:latest', 'gemma4:e2b', 'qwen3:8b'
  ])].map((n) => (n.includes(':') ? n : `${n}:latest`));
  const daemon = await fakeOllama(names);
  try {
    const list = await listModels(daemon.config, 'ollama');
    const tag = (m) => { const t = m.ollamaId || m.id; return t.includes(':') ? t : `${t}:latest`; };
    for (const name of names) {
      const asRow = list.filter((m) => m.group !== 'Installed locally' && m.available && tag(m) === name);
      const asExtra = list.filter((m) => m.group === 'Installed locally' && m.id === name);
      assert.equal(asRow.length + asExtra.length >= 1, true, `${name} must be listed`);
      assert.ok(!(asRow.length && asExtra.length), `${name} must not be listed twice`);
    }
    assert.ok(list.filter((m) => m.available).every((m) => names.includes(tag(m)) || names.includes(m.id)), 'nothing shows installed that is not');
  } finally { await daemon.close(); }
});

test('the Claude fallback comes from models.json', async () => {
  assert.equal(await getEffectiveModel({ provider: 'claude', config: {} }), getProviderDefault('claude'));
  assert.equal(await getEffectiveModel({ provider: 'claude', model: 'claude-opus-5-5', config: {} }), 'claude-opus-5-5');
});
