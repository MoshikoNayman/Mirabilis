// The Mirabilis MCP endpoint's chat tool, driven through the JSON-RPC handler.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createMcpServerHandler } from './mcpServer.js';

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.end = () => res;
  return res;
}

test('mirabilis_chat without a model resolves one the way the chat route does', async () => {
  const asked = [];
  const handler = createMcpServerHandler({
    config: { aiProvider: 'ollama' },
    getEffectiveModel: async (opts) => { asked.push(opts); return 'qwen3:8b'; },
    streamWithProvider: async ({ model, onToken }) => { onToken(`hi from ${model}`); },
    listModels: async () => [],
    auditLogPath: path.join(os.tmpdir(), `mirabilis-mcp-test-${process.pid}`, 'audit.log')
  });
  const res = fakeRes();
  await handler({
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mirabilis_chat', arguments: { prompt: 'hello' } } },
    headers: {},
    ip: '127.0.0.1'
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].provider, 'ollama');
  assert.equal(asked[0].config.aiProvider, 'ollama');
  const result = JSON.parse(res.body.result.content[0].text);
  assert.equal(result.model, 'qwen3:8b');
  assert.equal(result.response, 'hi from qwen3:8b');
});
