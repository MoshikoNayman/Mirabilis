import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { installEgressGuard, loadGoDark, setGoDark, isGoDark, egressAllowed, isLocalHost, readGoDark, GO_DARK_FILE, EgressBlockedError } from './egress.js';

installEgressGuard();

test('off by default, and everything is allowed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-egress-'));
  assert.equal(await loadGoDark(dir), false);
  assert.equal(egressAllowed('https://api.openai.com/v1'), true);
});

test('on: public hosts are refused before any connection is made', async () => {
  await setGoDark(true);
  await assert.rejects(fetch('https://api.openai.com/v1/models'), (err) => err instanceof EgressBlockedError && /api\.openai\.com/.test(err.message));
  await assert.rejects(fetch(new URL('https://raw.githubusercontent.com/x')), EgressBlockedError);
  await setGoDark(false);
});

test('on: this machine and the LAN stay reachable', async () => {
  await setGoDark(true);
  for (const url of ['http://127.0.0.1:11434', 'http://localhost:4000', 'http://192.168.1.1', 'ssh://192.168.1.101', 'http://10.0.0.5:8000']) {
    assert.equal(egressAllowed(url), true, url);
  }
  const server = http.createServer((_q, r) => r.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await res.text(), 'ok');
  await new Promise((r) => server.close(r));
  await setGoDark(false);
});

test('the state survives a restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-egress-'));
  await loadGoDark(dir);
  await setGoDark(true);
  assert.equal(await loadGoDark(dir), true);
  assert.equal(isGoDark(), true);
  const mode = (await fs.stat(path.join(dir, 'go-dark.json'))).mode & 0o777;
  assert.equal(mode, 0o600);
  await setGoDark(false);
  assert.equal(await loadGoDark(dir), false);
});

test('isLocalHost classifies bare hosts exactly as URLs are classified', () => {
  for (const host of ['localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '127.1', '::1', '[::1]', '192.168.1.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', 'nas.local', 'app.localhost']) {
    assert.equal(isLocalHost(host), true, host);
  }
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '169.254.1.1', 'fd00::1', '::ffff:8.8.8.8', '', '  ', 'a b', 'user@10.0.0.1', '10.0.0.1/x', 'http://localhost', '[::1', 'local']) {
    assert.equal(isLocalHost(host), false, host);
  }
});

test('readGoDark reads the saved state fresh and treats anything unreadable as off', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-egress-'));
  assert.equal(await readGoDark(dir), false, 'no file yet');
  assert.equal(await readGoDark(''), false, 'no data folder');
  await fs.writeFile(path.join(dir, GO_DARK_FILE), JSON.stringify({ on: true }));
  assert.equal(await readGoDark(dir), true);
  await fs.writeFile(path.join(dir, GO_DARK_FILE), '{not json');
  assert.equal(await readGoDark(dir), false);
  await fs.writeFile(path.join(dir, GO_DARK_FILE), JSON.stringify({ on: 'yes' }));
  assert.equal(await readGoDark(dir), false, 'only a real true turns it on');
  // setGoDark writes what readGoDark reads.
  await loadGoDark(dir);
  await setGoDark(true);
  assert.equal(await readGoDark(dir), true);
  await setGoDark(false);
  assert.equal(await readGoDark(dir), false);
});
