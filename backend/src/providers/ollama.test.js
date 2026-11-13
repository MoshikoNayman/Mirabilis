// Ollama listing and /api/show facts against a real local HTTP server.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { listOllamaModels, getOllamaModelInfo, streamOllamaChat } from './ollama.js';

/** One-off upstream on 127.0.0.1:0. Returns { baseUrl, close }. */
async function upstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

const QWEN_DIGEST = '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41';

test('listOllamaModels keeps the digest, time, family and format update checks need', async () => {
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      models: [{
        name: 'qwen3:8b',
        model: 'qwen3:8b',
        modified_at: '2026-09-06T23:05:46.272730223-04:00',
        size: 5225388164,
        digest: QWEN_DIGEST,
        details: { format: 'gguf', family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' }
      }, { name: 'bare:latest' }]
    }));
  });
  try {
    const [qwen, bare] = await listOllamaModels(up.baseUrl);
    assert.equal(qwen.name, 'qwen3:8b');
    assert.equal(qwen.sizeBytes, 5225388164);
    assert.equal(qwen.paramSize, '8.2B');
    assert.equal(qwen.quant, 'Q4_K_M');
    assert.equal(qwen.digest, QWEN_DIGEST);
    assert.equal(qwen.modifiedAt, '2026-09-07T03:05:46.272Z', 'nanosecond offsets become plain ISO');
    assert.equal(qwen.family, 'qwen3');
    assert.equal(qwen.format, 'gguf');
    // An older daemon or a sparse entry must not break the list.
    assert.equal(bare.digest, null);
    assert.equal(bare.modifiedAt, null);
    assert.equal(bare.family, null);
  } finally { await up.close(); }
});

test('listOllamaModels lists nothing when the daemon is down or answers junk', async () => {
  assert.deepEqual(await listOllamaModels('http://127.0.0.1:1'), []);
  const up = await upstream((_req, res) => { res.end('not json'); });
  try {
    assert.deepEqual(await listOllamaModels(up.baseUrl), []);
  } finally { await up.close(); }
});

test('an oversized tags body is refused, not buffered', async () => {
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"models":[],"pad":"');
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 80; i += 1) res.write(chunk); // 5 MB, past the cap
    res.end('"}');
  });
  try {
    assert.deepEqual(await listOllamaModels(up.baseUrl), []);
  } finally { await up.close(); }
});

test('model facts are re-read when the digest changes', async () => {
  // Pulling a model again can add tools or thinking; the old facts must not stick.
  let shows = 0;
  let capabilities = ['completion'];
  const up = await upstream((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      shows += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities, model_info: { 'qwen3.context_length': 40960 } }));
    });
  });
  try {
    const first = await getOllamaModelInfo(up.baseUrl, 'qwen3:8b', { digest: 'aaa' });
    assert.deepEqual(first.capabilities, ['completion']);
    assert.equal(first.contextWindow, 40960);
    await getOllamaModelInfo(up.baseUrl, 'qwen3:8b', { digest: 'aaa' });
    assert.equal(shows, 1, 'the same digest is served from the cache');

    capabilities = ['completion', 'tools', 'thinking'];
    const updated = await getOllamaModelInfo(up.baseUrl, 'qwen3:8b', { digest: 'bbb' });
    assert.equal(shows, 2, 'a new digest asks again');
    assert.deepEqual(updated.capabilities, capabilities);
    const byName = await getOllamaModelInfo(up.baseUrl, 'qwen3:8b');
    assert.deepEqual(byName.capabilities, capabilities, 'the send path sees the current pull too');
    assert.equal(shows, 2);
  } finally { await up.close(); }
});

test('a failed show answers with nulls and no capabilities', async () => {
  const up = await upstream((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    });
  });
  try {
    const info = await getOllamaModelInfo(up.baseUrl, 'broken:1b', { digest: 'ccc' });
    assert.deepEqual(info, { contextWindow: null, paramCount: null, capabilities: [], vision: false });
  } finally { await up.close(); }
});

test('streamOllamaChat sends think only when asked', async () => {
  const bodies = [];
  const up = await upstream((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ message: { content: 'ok' }, done: false })}\n${JSON.stringify({ done: true, eval_count: 1 })}\n`);
    });
  });
  try {
    const run = async (extra) => {
      let text = '';
      await streamOllamaChat({ baseUrl: up.baseUrl, model: 'qwen3:8b', messages: [{ role: 'user', content: 'x' }], onToken: (t) => { text += t; }, ...extra });
      return text;
    };
    assert.equal(await run({ think: false }), 'ok');
    assert.equal(await run({}), 'ok');
    assert.equal(bodies[0].think, false, 'an agent step asks a thinking model not to think');
    assert.equal('think' in bodies[1], false, 'chat leaves the model default alone');
  } finally { await up.close(); }
});
