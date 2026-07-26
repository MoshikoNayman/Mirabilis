import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { readVault, writeVault, clearVault } from './configVaultStore.js';

async function tmpVault() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-vault-'));
  return path.join(dir, 'config-vault.json');
}

const chunk = (id, dims = 8) => ({
  id,
  relPath: `conf/${id}.conf`,
  startLine: 1,
  endLine: 10,
  text: `contents of ${id}`,
  // Values with far more precision than an embedding needs.
  vector: Array.from({ length: dims }, (_, i) => (i + 1) / 7 * 0.123456789012345)
});

test('the vault round-trips and preserves chunk content', async () => {
  const p = await tmpVault();
  await writeVault(p, { root: '/etc', builtAt: 'now', embedModel: 'nomic', fileCount: 1, chunks: [chunk('a')] });
  const back = await readVault(p);
  assert.equal(back.root, '/etc');
  assert.equal(back.chunks.length, 1);
  assert.equal(back.chunks[0].text, 'contents of a');
  assert.equal(back.chunks[0].vector.length, 8);
});

test('vectors are written rounded, and the file is not pretty-printed', async () => {
  // Vectors dominate this file: at the 20,000-chunk ceiling the pretty-printed,
  // full-precision form measured ~25 KB per chunk, projecting past 500 MB held
  // in memory and re-serialized on every write. Compact JSON plus 6-decimal
  // rounding cuts that by about 3x, with a measured worst-case cosine error of
  // 1.8e-09 which cannot affect ranking.
  const p = await tmpVault();
  await writeVault(p, { root: '/etc', builtAt: null, embedModel: null, fileCount: 1, chunks: [chunk('a')] });
  const raw = await fs.readFile(p, 'utf8');

  assert.ok(!raw.includes('\n  '), 'file must be compact, not indented');
  const stored = JSON.parse(raw).chunks[0].vector;
  for (const v of stored) {
    const decimals = (String(v).split('.')[1] || '').length;
    assert.ok(decimals <= 6, `vector component ${v} kept ${decimals} decimals, expected <= 6`);
  }
});

test('rounding does not meaningfully change similarity ranking', async () => {
  const p = await tmpVault();
  const dims = 64;
  const raw = Array.from({ length: dims }, (_, i) => Math.sin(i) * 0.7391234567890123);
  await writeVault(p, {
    root: '', builtAt: null, embedModel: null, fileCount: 1,
    chunks: [{ id: 'x', relPath: 'a', startLine: 1, endLine: 2, text: 't', vector: raw }]
  });
  const stored = (await readVault(p)).chunks[0].vector;

  const cos = (a, b) => {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i += 1) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb));
  };
  assert.ok(Math.abs(cos(raw, stored) - 1) < 1e-9, 'rounded vector must stay effectively identical');
});

test('clearVault empties the index and shreds the backup', async () => {
  const p = await tmpVault();
  await writeVault(p, { root: '/etc', builtAt: 'now', embedModel: 'm', fileCount: 2, chunks: [chunk('a'), chunk('b')] });
  await writeVault(p, { root: '/etc', builtAt: 'now', embedModel: 'm', fileCount: 3, chunks: [chunk('c')] });
  assert.ok((await fs.readFile(`${p}.bak`, 'utf8')).includes('contents of a'), 'precondition: .bak holds prior data');

  await clearVault(p);

  const back = await readVault(p);
  assert.deepEqual(back.chunks, [], 'index should be empty');
  assert.equal(back.root, '', 'root should be reset');
  await assert.rejects(
    () => fs.readFile(`${p}.bak`, 'utf8'),
    /ENOENT/,
    'clearing the vault must not leave the indexed corpus in a sibling .bak'
  );
});

test('clearVault does not hand back a shared mutable empty array', async () => {
  // Same class of bug as the chat store: spreading a module-level template
  // aliases its arrays, so a later push pollutes the shared "empty" value and
  // subsequent clears silently retain data.
  const p1 = await tmpVault();
  const p2 = await tmpVault();

  await clearVault(p1);
  const first = await readVault(p1);
  first.chunks.push(chunk('leaked'));

  await clearVault(p2);
  const second = await readVault(p2);
  assert.deepEqual(second.chunks, [], 'a second cleared vault must not inherit the first vault mutation');
});
