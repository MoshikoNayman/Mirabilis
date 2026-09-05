// A guard against one specific, expensive mistake.
//
// Three separate CI failures have had the same root cause: a test reached for
// an OS-special filesystem path (/proc, /sys) to mean "somewhere I cannot
// write". Those paths do not exist on macOS, so the call fails instantly and
// the test passes locally. On Linux they are real mounted filesystems, and the
// call does not fail instantly: the suite hung until the runner killed it,
// producing a two-minute timeout with no hint of which line was responsible.
//
// The portable way to say "cannot write here" is a path whose PARENT is a
// regular file, which fails ENOTDIR on every platform, immediately.
//
// This costs a few milliseconds and turns a mystery CI hang into a local
// failure that names the file and says what to do instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** Quoted string literals only: prose in a comment may name /proc freely. */
const FORBIDDEN = /['"`]\/(proc|sys)\b/;

async function testFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await testFiles(full));
    else if (entry.name.endsWith('.test.js')) found.push(full);
  }
  return found;
}

test('no test uses an OS-special filesystem path as a scratch target', async () => {
  const offenders = [];
  for (const file of await testFiles(SRC)) {
    if (file === fileURLToPath(import.meta.url)) continue;
    const text = await readFile(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (FORBIDDEN.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders, [],
    'A test refers to /proc or /sys. These are absent on macOS but real on Linux, ' +
    'so the test will pass locally and hang CI. To mean "cannot write here", use a ' +
    'path under a regular file (ENOTDIR everywhere):\n' +
    "  const f = path.join(dir, 'not-a-directory');\n" +
    "  await fs.writeFile(f, 'x');            // then use path.join(f, 'nested')\n\n" +
    offenders.join('\n')
  );
});
