import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { createProviderKeyStore, maskKey } from './providerKeys.js';

const tmpFile = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-keys-'));
  return path.join(dir, 'provider-keys.json');
};

test('a stored key is usable by the backend but never listed in full', async () => {
  const f = await tmpFile();
  const s = createProviderKeyStore(f);
  await s.init();
  await s.set('openai', 'sk-abcdefghijklmnop1234');

  assert.equal(s.get('openai'), 'sk-abcdefghijklmnop1234', 'the backend needs the real value to call out');

  const listed = s.listMasked();
  assert.deepEqual(listed, [{ provider: 'openai', hasKey: true, hint: 'sk-a...1234' }]);
  const asJson = JSON.stringify(listed);
  assert.ok(!asJson.includes('sk-abcdefghijklmnop1234'),
    'what the UI receives must never contain a usable key');

  await fs.rm(path.dirname(f), { recursive: true, force: true });
});

test('the key file is written 0600 and not readable by group or others', async () => {
  const f = await tmpFile();
  const s = createProviderKeyStore(f);
  await s.init();
  await s.set('claude', 'sk-ant-secret-value-here');

  const mode = (await fs.stat(f)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);

  await fs.rm(path.dirname(f), { recursive: true, force: true });
});

test('keys survive a restart', async () => {
  const f = await tmpFile();
  const a = createProviderKeyStore(f);
  await a.init();
  await a.set('groq', 'gsk_persisted_value_1234');

  const b = createProviderKeyStore(f);
  await b.init();
  assert.equal(b.get('groq'), 'gsk_persisted_value_1234');

  await fs.rm(path.dirname(f), { recursive: true, force: true });
});

test('setting an empty value removes the key rather than storing a blank', async () => {
  const f = await tmpFile();
  const s = createProviderKeyStore(f);
  await s.init();
  await s.set('openai', 'sk-something-1234');
  await s.set('openai', '   ');
  assert.equal(s.get('openai'), '');
  assert.deepEqual(s.listMasked(), []);
  await fs.rm(path.dirname(f), { recursive: true, force: true });
});

test('removing a key takes it off disk too', async () => {
  const f = await tmpFile();
  const s = createProviderKeyStore(f);
  await s.init();
  await s.set('gemini', 'AIzaSyD-secret-here-1234');
  await s.remove('gemini');

  const raw = await fs.readFile(f, 'utf8');
  assert.ok(!raw.includes('AIzaSyD-secret-here-1234'), 'a removed key must not linger in the file');

  const after = createProviderKeyStore(f);
  await after.init();
  assert.equal(after.get('gemini'), '');
  await fs.rm(path.dirname(f), { recursive: true, force: true });
});

test('an unknown provider reads as no key rather than undefined', async () => {
  const f = await tmpFile();
  const s = createProviderKeyStore(f);
  await s.init();
  assert.equal(s.get('never-configured'), '');
  assert.equal(s.get(undefined), '');
  await fs.rm(path.dirname(f), { recursive: true, force: true });
});

test('masking shows enough to recognise a key and never enough to use it', () => {
  assert.equal(maskKey('sk-abcdefghijklmnop1234'), 'sk-a...1234');
  assert.equal(maskKey('short'), '*****', 'a short value is fully hidden, not partially leaked');
  assert.equal(maskKey(''), '');
  assert.equal(maskKey(undefined), '');
  // The middle must never survive.
  assert.ok(!maskKey('sk-MIDDLESECRETPART-9999').includes('MIDDLESECRET'));
});

test('concurrent writes do not lose keys', async () => {
  const f = await tmpFile();
  const s = createProviderKeyStore(f);
  await s.init();
  await Promise.all(['openai', 'groq', 'claude', 'gemini', 'grok'].map((p, i) =>
    s.set(p, `key-for-${p}-${i}0000000`)
  ));
  const after = createProviderKeyStore(f);
  await after.init();
  assert.equal(after.listMasked().length, 5, 'every concurrent write must reach disk');
  await fs.rm(path.dirname(f), { recursive: true, force: true });
});

test('a corrupt file starts empty instead of throwing at boot', async () => {
  const f = await tmpFile();
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, '{ not json', 'utf8');
  const s = createProviderKeyStore(f);
  await s.init();
  assert.deepEqual(s.listMasked(), []);
  await fs.rm(path.dirname(f), { recursive: true, force: true });
});
