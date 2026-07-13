import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeHostGuard,
  makeMcpAuthGuard,
  isBlockedProviderHost,
  assertSafeProviderUrl,
} from './security.js';

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function run(mw, req) {
  const res = mockRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { res, nexted };
}

test('hostGuard allows loopback hosts', () => {
  const mw = makeHostGuard(['localhost', '127.0.0.1', '::1']);
  for (const host of ['localhost:4000', '127.0.0.1:4000', '[::1]:4000', 'LOCALHOST']) {
    const { nexted, res } = run(mw, { headers: { host } });
    assert.equal(nexted, true, `should allow ${host}`);
    assert.equal(res.statusCode, 0);
  }
});

test('hostGuard rejects a rebinding hostname', () => {
  const mw = makeHostGuard(['localhost', '127.0.0.1']);
  const { nexted, res } = run(mw, { headers: { host: 'evil.attacker.com' } });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});

test('hostGuard allows a missing Host header (non-browser tooling)', () => {
  const mw = makeHostGuard(['localhost']);
  const { nexted } = run(mw, { headers: {} });
  assert.equal(nexted, true);
});

test('mcpAuthGuard requires the exact bearer token', () => {
  const mw = makeMcpAuthGuard('secret-token');
  assert.equal(run(mw, { headers: { authorization: 'Bearer secret-token' } }).nexted, true);
  assert.equal(run(mw, { headers: { 'x-mirabilis-mcp-token': 'secret-token' } }).nexted, true);
  const bad = run(mw, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(bad.nexted, false);
  assert.equal(bad.res.statusCode, 401);
  assert.equal(run(mw, { headers: {} }).res.statusCode, 401);
});

test('isBlockedProviderHost blocks cloud metadata, allows local + LAN', () => {
  assert.equal(isBlockedProviderHost('http://169.254.169.254/latest/meta-data/'), true);
  assert.equal(isBlockedProviderHost('http://metadata.google.internal/'), true);
  // Local AI must remain reachable - these are legitimate provider targets.
  assert.equal(isBlockedProviderHost('http://127.0.0.1:11434'), false);
  assert.equal(isBlockedProviderHost('http://localhost:8000/v1'), false);
  assert.equal(isBlockedProviderHost('http://192.168.1.50:11434'), false);
  assert.equal(isBlockedProviderHost('https://api.openai.com/v1'), false);
});

test('assertSafeProviderUrl throws only for metadata endpoints', () => {
  assert.throws(() => assertSafeProviderUrl('http://169.254.169.254/'), /metadata/);
  assert.doesNotThrow(() => assertSafeProviderUrl('http://127.0.0.1:11434'));
});
