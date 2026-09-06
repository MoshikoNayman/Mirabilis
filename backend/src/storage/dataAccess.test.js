// Permission failures, and whether the app says anything useful about them.
//
// The bug behind this file: launching the app once with sudo left chats.json
// owned by root, and from then on every attempt to start a chat failed with
// "EACCES: permission denied, open '/Users/.../chats.json'". Nothing explained
// that a file in the user's own home directory belonged to another account, and
// nothing suggested the one command that fixes it.
//
// Root-owned files cannot be created in a test, but the thing being tested is
// the same either way: a file that exists and cannot be written. chmod 000
// produces exactly that for a non-root process.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { checkDataAccess, describeStorageError, formatAccessProblems } from './dataAccess.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-access-'));
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('a healthy data directory reports no problems', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'chats.json'), '{"chats":[]}', 'utf8');
  const { ok, problems } = await checkDataAccess(dir);
  assert.equal(ok, true);
  assert.deepEqual(problems, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a missing file is not a problem: it gets created on first write', async () => {
  const dir = await tmp();
  const { ok } = await checkDataAccess(dir);
  assert.equal(ok, true, 'an empty data directory is the normal first-run state');
  await fs.rm(dir, { recursive: true, force: true });
});

test('an unwritable chats.json is reported as blocking, with the fix', { skip: isRoot ? 'root can write anything' : false }, async () => {
  const dir = await tmp();
  const file = path.join(dir, 'chats.json');
  await fs.writeFile(file, '{"chats":[]}', 'utf8');
  await fs.chmod(file, 0o000);

  const { ok, problems } = await checkDataAccess(dir);
  assert.equal(ok, false);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].critical, true, 'chat storage is not optional');
  assert.match(problems[0].file, /chats\.json$/);
  assert.match(problems[0].fix, /chown|takeown/, 'the fix must be a command, not advice');

  const text = formatAccessProblems(problems);
  assert.match(text, /blocking/);
  assert.match(text, /sudo/);
  assert.match(text, /chats\.json/);

  await fs.chmod(file, 0o600);
  await fs.rm(dir, { recursive: true, force: true });
});

test('an unwritable optional file is reported but not blocking', { skip: isRoot ? 'root can write anything' : false }, async () => {
  // Losing the ledger should not read as "the app is broken".
  const dir = await tmp();
  const file = path.join(dir, 'intelledger.json');
  await fs.writeFile(file, '{}', 'utf8');
  await fs.chmod(file, 0o000);

  const { ok, problems } = await checkDataAccess(dir);
  assert.equal(ok, false);
  assert.equal(problems[0].critical, false);

  await fs.chmod(file, 0o600);
  await fs.rm(dir, { recursive: true, force: true });
});

test('an unusable data directory is reported without probing inside it', async () => {
  // A path whose parent is a regular file: ENOTDIR everywhere, instantly.
  const base = await tmp();
  const asFile = path.join(base, 'not-a-directory');
  await fs.writeFile(asFile, 'x', 'utf8');

  const { ok, problems } = await checkDataAccess(path.join(asFile, 'data'));
  assert.equal(ok, false);
  assert.equal(problems.length, 1, 'report the directory once, not every file inside it');
  assert.equal(problems[0].critical, true);

  await fs.rm(base, { recursive: true, force: true });
});

test('every storage errno becomes a sentence, never a bare code', () => {
  const file = '/data/chats.json';
  const cases = [
    ['EACCES', /another user account/i],
    ['EPERM', /another user account/i],
    ['EROFS', /read only/i],
    ['ENOSPC', /disk is full/i],
    ['EMFILE', /too many open files/i],
    ['ENOTDIR', /not a directory/i]
  ];
  for (const [code, expected] of cases) {
    const message = describeStorageError({ code }, file);
    assert.match(message, expected, `${code} should be explained`);
    assert.ok(!/^[A-Z]+:/.test(message), `${code} should not lead with the raw errno`);
  }
});

test('a permission message carries a command that can be copied and run', () => {
  const message = describeStorageError({ code: 'EACCES' }, '/Users/someone/mirabilis-data/chats.json');
  assert.match(message, /chats\.json/);
  if (process.platform === 'win32') assert.match(message, /takeown/);
  else assert.match(message, /sudo chown .*mirabilis-data\/chats\.json/);
});

test('an unrecognised error still says something', () => {
  assert.equal(describeStorageError({ message: 'disk went away' }, '/x/chats.json'), 'disk went away');
  assert.match(describeStorageError({}, '/x/chats.json'), /Could not write chats\.json/);
});

test('formatting nothing produces nothing', () => {
  assert.equal(formatAccessProblems([]), '');
  assert.equal(formatAccessProblems(null), '');
});
