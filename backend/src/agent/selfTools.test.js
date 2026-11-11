import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSelfTools, defaultLogFiles, headerComment } from './selfTools.js';
import { APP_VERSION, APP_SEMVER } from '../version.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const made = [];
after(() => Promise.all(made.map((d) => fs.rm(d, { recursive: true, force: true }))));

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-selftools-'));
  made.push(dir);
  return dir;
}

async function put(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

const DOC = [
  '# Mirabilis architecture',
  '',
  'A map of the code.',
  '',
  '## Processes and ports',
  '',
  'Backend on 4000.',
  '',
  '### Backend',
  '',
  'Express.',
  '',
  '## Agent loop',
  '',
  'Plan, act.',
  '',
  '```text',
  '## not a heading inside a fence',
  '```',
  '',
  '## Storage files',
  '',
  'Many files.',
  '',
  '## Storage',
  '',
  'The data folder.',
  ''
].join('\n');

// mirabilis_architecture

test('mirabilis_architecture returns the doc, its sections, and where the source is', async () => {
  const root = await tempDir();
  await put(path.join(root, 'docs', 'ARCHITECTURE.md'), DOC);
  const tools = createSelfTools({ sourceRoot: root, logFiles: [] });
  const out = await tools.mirabilis_architecture.execute({});
  assert.equal(out.sourceRoot, root);
  assert.equal(out.doc, path.join(root, 'docs', 'ARCHITECTURE.md'));
  assert.equal(out.text, DOC);
  assert.deepEqual(out.sections, ['Processes and ports', 'Backend', 'Agent loop', 'Storage files', 'Storage']);
  assert.match(out.note, /Read the source with read_file and search_files under sourceRoot\./);
  assert.deepEqual(Object.keys(out).slice(0, 3), ['sourceRoot', 'doc', 'note'],
    'the pointers come before the long text, so a clipped observation keeps them');
});

test('mirabilis_architecture returns one section, preferring an exact heading match', async () => {
  const root = await tempDir();
  await put(path.join(root, 'docs', 'ARCHITECTURE.md'), DOC);
  const tools = createSelfTools({ sourceRoot: root, logFiles: [] });

  const loop = await tools.mirabilis_architecture.execute({ section: 'AGENT' });
  assert.equal(loop.section, 'Agent loop');
  assert.equal(loop.text, '## Agent loop\n\nPlan, act.\n\n```text\n## not a heading inside a fence\n```');

  const procs = await tools.mirabilis_architecture.execute({ section: 'processes' });
  assert.match(procs.text, /### Backend\n\nExpress\./, 'a section keeps its subsections');

  const sub = await tools.mirabilis_architecture.execute({ section: 'backend' });
  assert.equal(sub.text, '### Backend\n\nExpress.');

  const storage = await tools.mirabilis_architecture.execute({ section: 'storage' });
  assert.equal(storage.section, 'Storage');
  assert.equal(storage.text, '## Storage\n\nThe data folder.');

  const missing = await tools.mirabilis_architecture.execute({ section: 'quantum flux' });
  assert.match(missing.error, /No section heading contains "quantum flux"/);
  assert.ok(missing.sections.includes('Agent loop'));
});

test('mirabilis_architecture falls back to a listing built from file header comments', async () => {
  const root = await tempDir();
  await put(path.join(root, 'backend/src/a.js'), '// @ts-check\n// Alpha does a thing,\n// and then more.\nexport const a = 1;\n');
  await put(path.join(root, 'backend/src/a.test.js'), '// Tests are not part of the map.\n');
  await put(path.join(root, 'backend/src/node_modules/x.js'), '// Dependencies are not either.\n');
  await put(path.join(root, 'backend/src/sub/b.js'), '/**\n * Beta module.\n */\nexport const b = 2;\n');
  await put(path.join(root, 'frontend/src/c.jsx'), "'use client';\n// Gamma component.\n\nexport default function C() {}\n");
  await put(path.join(root, 'frontend/src/d.js'), 'import x from "y";\n// A comment on a line of code.\n');
  const tools = createSelfTools({ sourceRoot: root, logFiles: [] });
  const out = await tools.mirabilis_architecture.execute({});
  assert.equal(out.generated, true);
  assert.match(out.note, /ARCHITECTURE\.md is missing/);
  assert.equal(out.text, [
    'backend/src/a.js: Alpha does a thing, and then more.',
    'backend/src/sub/b.js: Beta module.',
    'frontend/src/c.jsx: Gamma component.',
    'frontend/src/d.js'
  ].join('\n'));
});

test('headerComment reads only a comment that opens the file', () => {
  assert.equal(headerComment('#!/usr/bin/env node\n// Launcher.\n'), 'Launcher.');
  assert.equal(headerComment('/* One line. */\ncode();'), 'One line.');
  assert.equal(headerComment('/**\n * @file\n * Real text\n */'), 'Real text');
  assert.equal(headerComment('"use strict";\n\n// After a directive.'), 'After a directive.');
  assert.equal(headerComment('const x = 1; // trailing'), '');
  assert.equal(headerComment(''), '');
});

// mirabilis_status

test('mirabilis_status reports versions, data file names and sizes only, logs found, and live state', async () => {
  const dataDir = await tempDir();
  const chats = '{"note":"SECRET-CONTENT-123"}';
  const keys = '{"openai":"sk-abcdefghijklmnopqrstuvwx"}';
  await put(path.join(dataDir, 'chats.json'), chats);
  await put(path.join(dataDir, 'provider-keys.json'), keys);
  await put(path.join(dataDir, 'agent-runs', 'r1.jsonl'), '12345');
  await put(path.join(dataDir, 'agent-runs', 'nested', 'r2.jsonl'), '1234567890');
  await put(path.join(dataDir, '.DS_Store'), 'x');
  const log = path.join(dataDir, 'logs', 'backend.log');
  await put(log, 'started\n');
  const tools = createSelfTools({
    sourceRoot: REPO_ROOT,
    dataDir,
    logFiles: [log, path.join(dataDir, 'logs', 'frontend.log')],
    getStatus: async () => ({ goDark: true, access: 'read', version: 'not-mine' })
  });
  const out = await tools.mirabilis_status.execute({});
  assert.equal(out.version, APP_VERSION, 'live state cannot replace core facts');
  assert.equal(out.semver, APP_SEMVER);
  assert.equal(out.node, process.version);
  assert.equal(out.pid, process.pid);
  assert.equal(out.platform, `${process.platform} ${process.arch}`);
  assert.equal(out.sourceRoot, REPO_ROOT);
  assert.equal(out.dataDir, dataDir);
  assert.deepEqual(out.dataFiles, [
    { name: 'agent-runs/', files: 2, bytes: 15 },
    { name: 'chats.json', bytes: Buffer.byteLength(chats) },
    { name: 'logs/', files: 1, bytes: 8 },
    { name: 'provider-keys.json', bytes: Buffer.byteLength(keys) }
  ]);
  assert.equal(out.logFiles.length, 1);
  assert.deepEqual(Object.keys(out.logFiles[0]), ['path', 'bytes', 'modified']);
  assert.equal(out.logFiles[0].path, log);
  assert.equal(out.goDark, true);
  assert.equal(out.access, 'read');
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /SECRET-CONTENT-123/);
  assert.doesNotMatch(json, /sk-abcdef/);
});

test('mirabilis_status survives a failing, hanging or odd getStatus and a missing data folder', async () => {
  const failing = createSelfTools({ logFiles: [], getStatus: () => { throw new Error('ollama unreachable'); } });
  const a = await failing.mirabilis_status.execute({});
  assert.equal(a.statusError, 'ollama unreachable');
  assert.deepEqual(a.dataFiles, { error: 'The data folder is not configured.' });

  const hanging = createSelfTools({ logFiles: [], getStatus: () => new Promise(() => {}), statusTimeoutMs: 50 });
  const started = Date.now();
  const b = await hanging.mirabilis_status.execute({});
  assert.match(b.statusError, /took longer than/);
  assert.ok(Date.now() - started < 2000);

  const odd = createSelfTools({ logFiles: [], getStatus: () => 'fine' });
  assert.equal((await odd.mirabilis_status.execute({})).status, 'fine');

  const gone = createSelfTools({ logFiles: [], dataDir: path.join(await tempDir(), 'nope') });
  assert.match((await gone.mirabilis_status.execute({})).dataFiles.error, /^Cannot read /);
});

// mirabilis_logs

async function logFixture() {
  const a = await tempDir();
  const b = await tempDir();
  const files = {
    oldBackend: path.join(a, 'backend.log'),
    frontend: path.join(a, 'frontend.log'),
    image: path.join(a, 'image-service.log'),
    newBackend: path.join(b, 'backend.log'),
    missing: path.join(b, 'frontend.log')
  };
  await put(files.oldBackend, 'old start\nold WARN slow disk\n');
  await put(files.frontend, 'ready on 3000\n');
  await put(files.image, 'loading model\n');
  await put(files.newBackend, 'new start\nprovider key sk-abcdefghijklmnopqrstuvwx\nnew warn: slow reply\n');
  const t0 = Date.now() / 1000;
  await fs.utimes(files.oldBackend, t0 - 3600, t0 - 3600);
  await fs.utimes(files.image, t0 - 60, t0 - 60);
  await fs.utimes(files.frontend, t0 - 30, t0 - 30);
  await fs.utimes(files.newBackend, t0, t0);
  return files;
}

test('mirabilis_logs reads backend logs by default, newest file first, with secrets removed', async () => {
  const f = await logFixture();
  const tools = createSelfTools({ logFiles: Object.values(f) });
  const out = await tools.mirabilis_logs.execute({});
  assert.equal(out.which, 'backend');
  assert.deepEqual(out.logs.map((l) => l.path), [f.newBackend, f.oldBackend]);
  assert.equal(out.logs[0].text, 'new start\nprovider key [redacted]\nnew warn: slow reply');
  assert.doesNotMatch(JSON.stringify(out), /sk-abcdef/);
  assert.equal((await tools.mirabilis_logs.execute({ which: 'nonsense' })).which, 'backend');
});

test('mirabilis_logs selects frontend or all logs and filters any case', async () => {
  const f = await logFixture();
  const tools = createSelfTools({ logFiles: Object.values(f) });
  const front = await tools.mirabilis_logs.execute({ which: 'frontend' });
  assert.deepEqual(front.logs.map((l) => l.path), [f.frontend]);
  const all = await tools.mirabilis_logs.execute({ which: 'all' });
  assert.deepEqual(all.logs.map((l) => l.path), [f.newBackend, f.frontend, f.image, f.oldBackend]);
  const warn = await tools.mirabilis_logs.execute({ which: 'backend', filter: 'WARN' });
  assert.deepEqual(warn.logs.map((l) => l.text), ['new warn: slow reply', 'old WARN slow disk']);
  assert.match(warn.scope, /filtered by "WARN"/);
});

test('mirabilis_logs says where it looked when no log exists yet', async () => {
  const dir = await tempDir();
  const tools = createSelfTools({ logFiles: [path.join(dir, 'backend.log')] });
  const out = await tools.mirabilis_logs.execute({});
  assert.deepEqual(out.logs, []);
  assert.match(out.note, /No backend log file exists yet\. Looked for: .*backend\.log/);
});

test('mirabilis_logs shares one output budget across every log', async () => {
  const dir = await tempDir();
  const names = ['backend.log', 'frontend.log', 'image-service.log'];
  const big = Array.from({ length: 400 }, (_, i) => `${i} ${'y'.repeat(180)}`).join('\n');
  for (const n of names) await put(path.join(dir, n), big);
  const tools = createSelfTools({ logFiles: names.map((n) => path.join(dir, n)) });
  const out = await tools.mirabilis_logs.execute({ which: 'all', lines: 2000 });
  assert.equal(out.logs.length, 3);
  assert.ok(out.logs.every((l) => l.shown > 0 && l.truncated), 'every log gets a share');
  const json = JSON.stringify(out).length;
  assert.ok(json < 4000, `three logs are ${json} chars`);
});

test('defaultLogFiles covers the launcher and the desktop app on each platform', () => {
  const darwin = defaultLogFiles({ platform: 'darwin', home: '/Users/me', tmp: '/tmp/x' });
  assert.deepEqual(darwin, [
    path.join('/tmp/x', 'backend.log'),
    path.join('/tmp/x', 'frontend.log'),
    path.join('/tmp/x', 'image-service.log'),
    path.join('/Users/me', 'Library', 'Logs', 'Mirabilis AI', 'backend.log'),
    path.join('/Users/me', 'Library', 'Logs', 'Mirabilis AI', 'frontend.log')
  ]);
  const linux = defaultLogFiles({ platform: 'linux', dataDir: '/home/me/.config/Mirabilis AI', tmp: '/tmp/x' });
  assert.ok(linux.includes(path.join('/home/me/.config/Mirabilis AI', 'logs', 'backend.log')));
  assert.equal(defaultLogFiles({ platform: 'linux', tmp: '/tmp/x' }).length, 3);
});

test('self tools are read-only and default to the source tree they live in', async () => {
  const tools = createSelfTools({ logFiles: [] });
  assert.deepEqual(Object.keys(tools).sort(), ['mirabilis_architecture', 'mirabilis_logs', 'mirabilis_status']);
  for (const [name, tool] of Object.entries(tools)) {
    assert.equal(tool.kind, 'read', name);
    assert.equal(tool.mutating, false, name);
    assert.equal(typeof tool.description, 'string', name);
    for (const doc of Object.values(tool.parameters)) assert.equal(typeof doc, 'string', name);
  }
  assert.equal((await tools.mirabilis_status.execute({})).sourceRoot, REPO_ROOT);
});

// The shipped map must stay true: short enough to read, and every file it names exists.
test('docs/ARCHITECTURE.md is short and names only files that exist', async () => {
  const docPath = path.join(REPO_ROOT, 'docs', 'ARCHITECTURE.md');
  const text = await fs.readFile(docPath, 'utf8');
  assert.ok(text.split('\n').length < 250, 'keep the map under 250 lines');
  // Paths under a top-level repo folder; data folder paths such as agent-runs/ are not repo files.
  const topLevel = new Set(await fs.readdir(REPO_ROOT));
  const named = [...text.matchAll(/`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.\[\]-]+)+\.(?:js|jsx|mjs|json|md|sh|bat|css))`/g)]
    .map((m) => m[1])
    .filter((p) => topLevel.has(p.split('/')[0]));
  assert.ok(named.length > 20, 'the map points at real files');
  const missing = named.filter((p) => !existsSync(path.join(REPO_ROOT, p)));
  assert.deepEqual(missing, [], 'every path in the map exists');
  const tools = createSelfTools({ logFiles: [] });
  const out = await tools.mirabilis_architecture.execute({});
  assert.equal(out.generated, undefined);
  assert.ok(out.sections.length >= 8);
});
