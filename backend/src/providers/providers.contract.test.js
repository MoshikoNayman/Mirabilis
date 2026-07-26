// Contract tests for the provider stream adapters.
//
// These run against a real HTTP server on an ephemeral port rather than a mocked
// fetch, so they exercise the actual body reader, chunk boundaries and framing.
// The cases here are the ones that shipped as live defects: a mid-stream error
// frame that both parsers silently discarded, leaving the caller with an empty
// reply that the route then persisted as a successful answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { streamOllamaChat, getFittedOptions, clearFittedOptions } from './ollama.js';
import { streamOpenAICompatibleChat } from './openaiCompatible.js';
import { streamAnthropicChat } from './anthropic.js';

/**
 * Boot a one-off upstream. `handler(req, res)` writes whatever the test needs.
 * Returns { baseUrl, close } and always listens on 127.0.0.1:0.
 */
async function upstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

const ndjson = (obj) => JSON.stringify(obj) + '\n';
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

// ── Ollama ───────────────────────────────────────────────────────────────────

test('ollama: streams tokens from NDJSON frames', async () => {
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(ndjson({ message: { content: 'Hello' } }));
    res.write(ndjson({ message: { content: ', world' } }));
    res.end(ndjson({ done: true, eval_count: 2 }));
  });
  try {
    const tokens = [];
    await streamOllamaChat({
      baseUrl: up.baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }],
      onToken: (t) => tokens.push(t)
    });
    assert.equal(tokens.join(''), 'Hello, world');
  } finally { await up.close(); }
});

test('ollama: THROWS on a mid-stream error frame instead of ending empty', async () => {
  // The defect: a 200 response whose body carries {"error":...} was parsed
  // fine, matched neither the content nor the done branch, and was dropped. The
  // stream then ended with no text and the route saved that as a real reply.
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(ndjson({ message: { content: 'partial' } }));
    res.end(ndjson({ error: 'model runner has unexpectedly stopped' }));
  });
  try {
    const tokens = [];
    await assert.rejects(
      () => streamOllamaChat({
        baseUrl: up.baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }],
        onToken: (t) => tokens.push(t)
      }),
      /unexpectedly stopped/,
      'a mid-stream error frame must surface, not be swallowed'
    );
    assert.equal(tokens.join(''), 'partial', 'tokens seen before the error are still delivered');
  } finally { await up.close(); }
});

test('ollama: a split NDJSON frame across chunks is still parsed', async () => {
  // Guards the parse-failure path: a partial line must be buffered, not treated
  // as an error now that the error branch throws.
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const line = ndjson({ message: { content: 'chunked' } });
    res.write(line.slice(0, 12));
    setTimeout(() => { res.write(line.slice(12)); res.end(ndjson({ done: true })); }, 20);
  });
  try {
    const tokens = [];
    await streamOllamaChat({
      baseUrl: up.baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }],
      onToken: (t) => tokens.push(t)
    });
    assert.equal(tokens.join(''), 'chunked');
  } finally { await up.close(); }
});

test('ollama: surfaces exact metrics from the done frame', async () => {
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(ndjson({ message: { content: 'x' } }));
    res.end(ndjson({ done: true, eval_count: 42, eval_duration: 2_000_000_000, prompt_eval_count: 7 }));
  });
  try {
    let stats = null;
    await streamOllamaChat({
      baseUrl: up.baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }],
      onToken: () => {}, onStats: (s) => { stats = s; }
    });
    assert.equal(stats?.evalCount, 42);
    assert.equal(stats?.promptEvalCount, 7);
  } finally { await up.close(); }
});

test('ollama: an OOM on the first attempt retries with a reduced context', async () => {
  const seen = [];
  const up = await upstream((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body || '{}'));
      if (seen.length === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'failed to allocate memory: out of memory' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(ndjson({ message: { content: 'recovered' } }));
      res.end(ndjson({ done: true }));
    });
  });
  try {
    const tokens = [];
    const notices = [];
    await streamOllamaChat({
      baseUrl: up.baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }],
      options: { num_ctx: 8192 },
      onToken: (t) => tokens.push(t),
      onNotice: (n) => notices.push(n)
    });
    assert.equal(tokens.join(''), 'recovered', 'should succeed on the retry');
    assert.equal(seen.length, 2, 'should have retried exactly once');
    assert.ok(notices.some((n) => /Reduced to fit memory/.test(n)), 'user should be told it was reduced');
    const retriedCtx = seen[1]?.options?.num_ctx;
    assert.ok(retriedCtx < 8192, `retry should lower num_ctx (got ${retriedCtx})`);
  } finally { await up.close(); }
});

test('ollama: a non-2xx response throws with the upstream detail', async () => {
  const up = await upstream((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'model "nope" not found' }));
  });
  try {
    await assert.rejects(
      () => streamOllamaChat({
        baseUrl: up.baseUrl, model: 'nope', messages: [{ role: 'user', content: 'hi' }], onToken: () => {}
      }),
      /not found/
    );
  } finally { await up.close(); }
});

// ── OpenAI-compatible (llama-server, vLLM, KoboldCpp, cloud) ─────────────────

test('openai-compatible: streams tokens from SSE delta frames', async () => {
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { content: 'Hel' } }] }));
    res.write(sse({ choices: [{ delta: { content: 'lo' } }] }));
    res.end('data: [DONE]\n\n');
  });
  try {
    const tokens = [];
    await streamOpenAICompatibleChat({
      baseUrl: `${up.baseUrl}/v1`, apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }], onToken: (t) => tokens.push(t)
    });
    assert.equal(tokens.join(''), 'Hello');
  } finally { await up.close(); }
});

test('openai-compatible: THROWS on a mid-stream error frame', async () => {
  // Same defect class as the Ollama case: `data: {"error":...}` on an
  // already-200 response was skipped, leaving the reply silently empty.
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { content: 'partial' } }] }));
    res.end(sse({ error: { message: 'CUDA out of memory', type: 'server_error' } }));
  });
  try {
    const tokens = [];
    await assert.rejects(
      () => streamOpenAICompatibleChat({
        baseUrl: `${up.baseUrl}/v1`, apiKey: 'k', model: 'm',
        messages: [{ role: 'user', content: 'hi' }], onToken: (t) => tokens.push(t)
      }),
      /CUDA out of memory/,
      'a mid-stream error frame must surface, not be swallowed'
    );
    assert.equal(tokens.join(''), 'partial');
  } finally { await up.close(); }
});

test('openai-compatible: ignores [DONE] and non-data lines without erroring', async () => {
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': this is an SSE comment\n\n');
    res.write('event: ping\n\n');
    res.write(sse({ choices: [{ delta: { content: 'ok' } }] }));
    res.end('data: [DONE]\n\n');
  });
  try {
    const tokens = [];
    await streamOpenAICompatibleChat({
      baseUrl: `${up.baseUrl}/v1`, apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }], onToken: (t) => tokens.push(t)
    });
    assert.equal(tokens.join(''), 'ok');
  } finally { await up.close(); }
});

test('openai-compatible: an aborted stream resolves quietly rather than throwing', async () => {
  // Aborts are user-initiated (the stop button); they must not be reported as
  // failures, or the UI would show an error every time someone stops a reply.
  const up = await upstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { content: 'streaming' } }] }));
    // deliberately never ends
  });
  try {
    const controller = new AbortController();
    const done = streamOpenAICompatibleChat({
      baseUrl: `${up.baseUrl}/v1`, apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      onToken: () => controller.abort()
    });
    await done; // must resolve, not reject
  } finally { await up.close(); }
});

// ── OOM detection and memory memory ─────────────────────────────────────────

test('ollama: recognizes the OOM wordings Ollama actually emits', async () => {
  // Each of these is a real failure mode. If the pattern misses one, the retry
  // ladder never runs and the user gets a hard error where a smaller context
  // would have worked.
  const wordings = [
    'model requires more system memory (5.2 GiB) than is available (3.1 GiB)',
    'llama runner process has terminated: signal: killed',
    'cudaMalloc failed: out of memory',
    'failed to allocate buffer'
  ];
  for (const wording of wordings) {
    clearFittedOptions();
    let calls = 0;
    const up = await upstream((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls += 1;
        if (calls === 1) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: wording }));
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(ndjson({ message: { content: 'ok' } }));
        res.end(ndjson({ done: true }));
      });
    });
    try {
      const tokens = [];
      await streamOllamaChat({
        baseUrl: up.baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }],
        options: { num_ctx: 8192 }, onToken: (t) => tokens.push(t)
      });
      assert.equal(tokens.join(''), 'ok', `"${wording.slice(0, 40)}" should have triggered a retry`);
      assert.equal(calls, 2, `"${wording.slice(0, 40)}" should be treated as memory pressure`);
    } finally { await up.close(); }
  }
});

test('ollama: a non-memory error is NOT retried', async () => {
  clearFittedOptions();
  let calls = 0;
  const up = await upstream((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      calls += 1;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid template syntax' }));
    });
  });
  try {
    await assert.rejects(() => streamOllamaChat({
      baseUrl: up.baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }], onToken: () => {}
    }), /invalid template/);
    assert.equal(calls, 1, 'a non-memory failure must fail fast, not walk the ladder');
  } finally { await up.close(); }
});

test('ollama: options that fit are remembered so the next message skips the failed loads', async () => {
  clearFittedOptions();
  const seen = [];
  const up = await upstream((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      seen.push(parsed.options || {});
      // Anything above 4096 is "too big" for this fake machine.
      if ((parsed.options?.num_ctx ?? 0) > 4096) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'out of memory' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(ndjson({ message: { content: 'ok' } }));
      res.end(ndjson({ done: true }));
    });
  });
  try {
    const send = () => streamOllamaChat({
      baseUrl: up.baseUrl, model: 'big-model', messages: [{ role: 'user', content: 'hi' }],
      options: { num_ctx: 16384 }, onToken: () => {}
    });

    await send();
    const firstAttempts = seen.length;
    assert.ok(firstAttempts >= 2, 'the first message should have needed a retry');
    assert.ok(getFittedOptions(up.baseUrl, 'big-model'), 'the working options should be remembered');

    seen.length = 0;
    await send();
    assert.equal(
      seen.length, 1,
      'the second message should start from what fit, not re-walk the ladder'
    );
    assert.ok(seen[0].num_ctx <= 4096, `expected the remembered context, got ${seen[0].num_ctx}`);
  } finally { await up.close(); }
});

test('a remembered fit caps a larger request but respects a smaller one', async () => {
  // The contract: the learned value is empirical evidence about this machine, so
  // it caps a bigger ask. It must NOT raise a request that is already smaller.
  clearFittedOptions();
  const seen = [];
  const up = await upstream((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      seen.push(parsed.options || {});
      if ((parsed.options?.num_ctx ?? 0) > 4096) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'out of memory' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(ndjson({ message: { content: 'ok' } }) + ndjson({ done: true }));
    });
  });
  try {
    // Learn the fit.
    await streamOllamaChat({
      baseUrl: up.baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }],
      options: { num_ctx: 16384 }, onToken: () => {}
    });
    const learned = getFittedOptions(up.baseUrl, 'm');
    assert.ok(learned.num_ctx <= 4096, 'should have learned a working context');

    // A larger ask is capped down to what fits.
    seen.length = 0;
    await streamOllamaChat({
      baseUrl: up.baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }],
      options: { num_ctx: 16384 }, onToken: () => {}
    });
    assert.equal(seen.length, 1, 'a capped request should succeed first try');
    assert.ok(seen[0].num_ctx <= 4096, `expected the cap, got ${seen[0].num_ctx}`);

    // A smaller ask is honoured as-is, never raised.
    seen.length = 0;
    await streamOllamaChat({
      baseUrl: up.baseUrl, model: 'm', messages: [{ role: 'user', content: 'hi' }],
      options: { num_ctx: 2048 }, onToken: () => {}
    });
    assert.equal(seen[0].num_ctx, 2048, 'a smaller explicit value must be left alone');
  } finally { await up.close(); }
});

// ── Anthropic ───────────────────────────────────────────────────────────────

const anthropicFrames = (frames) => frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('');

test('anthropic: streams incrementally instead of one blob at the end', async () => {
  // With stream:false the entire reply arrived in a single onToken call, so the
  // user saw nothing until generation finished and the receipt's
  // time-to-first-token was recorded at the moment the LAST token landed.
  let body = null;
  const up = await upstream((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      body = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(anthropicFrames([
        { type: 'message_start', message: { usage: { input_tokens: 11 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
        { type: 'message_delta', usage: { output_tokens: 5 } },
        { type: 'message_stop' }
      ]));
    });
  });
  try {
    const tokens = [];
    let stats = null;
    await streamAnthropicChat({
      baseUrl: up.baseUrl, apiKey: 'k', model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
      onToken: (t) => tokens.push(t), onStats: (s) => { stats = s; }
    });
    assert.equal(body.stream, true, 'must request a streaming response');
    assert.equal(tokens.length, 2, 'each delta should arrive as its own token');
    assert.equal(tokens.join(''), 'Hello');
    assert.equal(stats?.evalCount, 5, 'exact output token count should reach the receipt');
    assert.equal(stats?.promptEvalCount, 11, 'exact input token count should reach the receipt');
  } finally { await up.close(); }
});

test('anthropic: THROWS on a mid-stream error event', async () => {
  const up = await upstream((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(anthropicFrames([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
      ]));
    });
  });
  try {
    await assert.rejects(() => streamAnthropicChat({
      baseUrl: up.baseUrl, apiKey: 'k', model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }], onToken: () => {}
    }), /Overloaded/);
  } finally { await up.close(); }
});

test('anthropic: clamps temperature into the accepted range', async () => {
  // The UI slider goes to 2; Anthropic rejects anything above 1.
  let body = null;
  const up = await upstream((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      body = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(anthropicFrames([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }]));
    });
  });
  try {
    await streamAnthropicChat({
      baseUrl: up.baseUrl, apiKey: 'k', model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }], temperature: 1.9, onToken: () => {}
    });
    assert.equal(body.temperature, 1, 'temperature must be clamped to 1');
  } finally { await up.close(); }
});

test('anthropic: drops leading non-user turns so the conversation starts correctly', async () => {
  // The sliding history window can leave an assistant turn first, which
  // Anthropic rejects outright.
  let body = null;
  const up = await upstream((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      body = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(anthropicFrames([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }]));
    });
  });
  try {
    await streamAnthropicChat({
      baseUrl: up.baseUrl, apiKey: 'k', model: 'claude-x',
      messages: [
        { role: 'assistant', content: 'orphaned reply' },
        { role: 'user', content: 'real question' }
      ],
      onToken: () => {}
    });
    assert.equal(body.messages[0].role, 'user', 'the conversation must start on a user turn');
    assert.equal(body.messages.length, 1);
  } finally { await up.close(); }
});

test('anthropic: an empty stream is reported as a failure', async () => {
  const up = await upstream((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(anthropicFrames([{ type: 'message_stop' }]));
    });
  });
  try {
    await assert.rejects(() => streamAnthropicChat({
      baseUrl: up.baseUrl, apiKey: 'k', model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }], onToken: () => {}
    }), /no text content/);
  } finally { await up.close(); }
});
