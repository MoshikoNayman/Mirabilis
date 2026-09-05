import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { hardenFile, ensureSecureDir, hardenExistingData, SECURE_FILE_MODE, SECURE_DIR_MODE } from './securePaths.js';

const mode = async (p) => (await fs.stat(p)).mode & 0o777;
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-perms-'));

test('a world-readable file is brought down to owner-only', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'chats.json');
  await fs.writeFile(f, '{}', 'utf8');
  await fs.chmod(f, 0o644);
  assert.equal(await mode(f), 0o644, 'precondition: the default umask leaves it open');

  assert.equal(await hardenFile(f), true);
  assert.equal(await mode(f), SECURE_FILE_MODE);
  await fs.rm(dir, { recursive: true, force: true });
});

test('an existing install is fixed, not just new writes', async () => {
  // The whole point: every machine already running has world-readable history.
  const dir = await tmp();
  const nested = path.join(dir, 'agent-runs');
  await fs.mkdir(nested, { recursive: true });
  const files = [
    path.join(dir, 'chats.json'),
    path.join(dir, 'config-vault.json'),
    path.join(dir, 'personal-memory.json'),
    path.join(nested, 'run-1.jsonl')
  ];
  for (const f of files) { await fs.writeFile(f, '{}', 'utf8'); await fs.chmod(f, 0o644); }
  await fs.chmod(dir, 0o755);

  const { changed } = await hardenExistingData(dir);
  assert.equal(changed, files.length, 'every open file should be counted and fixed');
  for (const f of files) assert.equal(await mode(f), SECURE_FILE_MODE, `${path.basename(f)} should be 0600`);
  assert.equal(await mode(dir), SECURE_DIR_MODE, 'the directory listing should be private too');
  assert.equal(await mode(nested), SECURE_DIR_MODE, 'nested run logs too');

  await fs.rm(dir, { recursive: true, force: true });
});

test('files that are already private are left alone and not counted', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'already.json');
  await fs.writeFile(f, '{}', 'utf8');
  await fs.chmod(f, 0o600);
  const { changed } = await hardenExistingData(dir);
  assert.equal(changed, 0, 'no needless churn on an already-correct install');
  await fs.rm(dir, { recursive: true, force: true });
});

test('a group-readable file counts as open even when others cannot read it', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'group.json');
  await fs.writeFile(f, '{}', 'utf8');
  await fs.chmod(f, 0o640);
  const { changed } = await hardenExistingData(dir);
  assert.equal(changed, 1);
  assert.equal(await mode(f), SECURE_FILE_MODE);
  await fs.rm(dir, { recursive: true, force: true });
});

test('ensureSecureDir creates a private directory', async () => {
  const dir = await tmp();
  const sub = path.join(dir, 'deep', 'nested');
  assert.equal(await ensureSecureDir(sub), true);
  assert.equal(await mode(sub), SECURE_DIR_MODE);
  await fs.rm(dir, { recursive: true, force: true });
});

test('permission work never throws, whatever it is pointed at', async () => {
  // A permission fix must never be able to take the app down at boot.
  assert.equal(await hardenFile('/definitely/not/here.json'), false);
  assert.equal(await ensureSecureDir('/proc/cannot/create/this'), false);
  assert.deepEqual(await hardenExistingData('/definitely/not/a/directory'), { changed: 0 });
});
