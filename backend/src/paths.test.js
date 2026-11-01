import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { expandHome, resolveUserPath } from './paths.js';

test('~ expands to the home directory', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/.ssh/id_ed25519'), path.join(os.homedir(), '.ssh/id_ed25519'));
  assert.equal(expandHome('  ~/filesee '), path.join(os.homedir(), 'filesee'));
});

test('other paths are left alone', () => {
  assert.equal(expandHome('/etc/hosts'), '/etc/hosts');
  assert.equal(expandHome('a/~b'), 'a/~b');
  assert.equal(expandHome('~other/x'), '~other/x');
});

test('resolveUserPath returns an absolute path', () => {
  assert.equal(resolveUserPath('~/x'), path.join(os.homedir(), 'x'));
  assert.ok(path.isAbsolute(resolveUserPath('rel/dir')));
});
