import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isTextAttachment, clipText, readAttachmentText, buildAttachmentPrompt, attachmentTokenHint } from './attachmentText.js';

const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

test('configs, source and logs count as text; images and binaries do not', () => {
  for (const name of ['srx300.conf', 'main.rs', 'app.log', 'Makefile', 'policy.set', 'x.yaml']) {
    assert.equal(isTextAttachment({ name, mimeType: 'application/octet-stream' }), true, name);
  }
  assert.equal(isTextAttachment({ name: 'a.png', mimeType: 'image/png' }), false);
  assert.equal(isTextAttachment({ name: 'a.zip', mimeType: 'application/zip' }), false);
});

test('a long file keeps its head and tail and says which lines were sent', () => {
  const text = Array.from({ length: 1000 }, (_, i) => `set line ${i + 1}`).join('\n');
  const out = clipText(text, 2000);
  assert.equal(out.truncated, true);
  assert.match(out.note, /^lines 1-\d+ and \d+-1000 of 1000 sent$/);
  assert.ok(out.text.startsWith('set line 1\n'));
  assert.ok(out.text.endsWith('set line 1000'));
  assert.ok(out.text.length < 2200);
});

test('a short file is passed through untouched', () => {
  assert.deepEqual(clipText('a\nb', 100), { text: 'a\nb', truncated: false, note: '' });
});

test('binary content is refused even with a text extension', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-att-'));
  await fs.writeFile(path.join(dir, 'u1-fake.conf'), Buffer.from([0x73, 0x00, 0x01]));
  await fs.writeFile(path.join(dir, 'u2-real.conf'), 'set system host-name FW1\n');
  assert.equal(await readAttachmentText(dir, { name: 'fake.conf', storedName: 'u1-fake.conf' }, SAFE), null);
  assert.equal(await readAttachmentText(dir, { name: 'real.conf', storedName: 'u2-real.conf' }, SAFE), 'set system host-name FW1\n');
  assert.equal(await readAttachmentText(dir, { name: 'x.conf', storedName: '../etc/passwd' }, SAFE), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('the prompt carries the file text, not just its name', () => {
  const msg = {
    content: 'Uploaded 1 file: srx300.conf',
    attachments: [{ name: 'srx300.conf', storedName: 's1' }]
  };
  const prompt = buildAttachmentPrompt(msg, new Map([['s1', 'set system host-name FW1']]), 10000);
  assert.match(prompt, /--- srx300.conf ---\nset system host-name FW1\n--- end of srx300.conf ---/);
});

test('the history window is charged for attachment text', () => {
  const msg = { type: 'attachments', attachments: [{ text: true, size: 40000 }, { size: 9999 }] };
  assert.equal(attachmentTokenHint(msg, 20000), 5000);
  assert.equal(attachmentTokenHint({ content: 'hi' }, 20000), 0);
});
