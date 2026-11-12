// The catalog: presets without hooks build and list exactly as before; Junos finds
// its folder and venv on this machine and builds from the folder alone.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildCatalog, connectorFromPreset, findPreset, PRESETS } from './catalog.js';
import { expandTilde } from './stdioClient.js';

/** @type {string[]} */
const dirs = [];

after(async () => {
  await Promise.allSettled(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix = 'mirabilis-catalog-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const POSIX_VENV = path.join('.venv', 'bin', 'python');
const WIN_VENV = path.join('.venv', 'Scripts', 'python.exe');

/**
 * A junos-mcp-server folder: jmcp.py, devices.json unless told not to, and a venv
 * interpreter when one is named.
 * @param {string} dir
 * @param {{venv?: string, devices?: boolean}} [opts]
 */
async function junosFolder(dir, { venv = '', devices = true } = {}) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'jmcp.py'), '');
  if (devices) await fs.writeFile(path.join(dir, 'devices.json'), '{}');
  if (venv) {
    await fs.mkdir(path.dirname(path.join(dir, venv)), { recursive: true });
    await fs.writeFile(path.join(dir, venv), '', { mode: 0o755 });
  }
  return dir;
}

/**
 * @param {Record<string, unknown>} fields
 * @param {{home: string, platform: string}} machine
 */
const junos = (fields, { home, platform }) => connectorFromPreset(/** @type {any} */ (findPreset('junos')), fields, { dataDir: '/data', home, platform });

/** @param {any[]} presets */
const byId = (presets) => Object.fromEntries(presets.map((p) => [p.id, p]));

test('presets without hooks build exactly as before, on every platform', async () => {
  const home = await tempDir();
  await fs.mkdir(path.join(home, 'docs'));
  await fs.mkdir(path.join(home, 'repo', '.git'), { recursive: true });
  const repo = path.join(home, 'repo');
  /** @param {string} name @param {string} preset @param {string} command @param {string[]} args @param {Record<string, string>} [env] */
  const local = (name, preset, command, args, env = {}) => ({ name, transport: 'stdio', command, args, env, cwd: '', preset });
  for (const platform of ['darwin', 'linux', 'win32']) {
    /** @param {string} id @param {any} [fields] */
    const build = (id, fields = {}) => connectorFromPreset(/** @type {any} */ (findPreset(id)), fields, { dataDir: '/data', home, platform });
    assert.deepEqual(build('filesystem', { folders: ['~/docs', repo] }), local('Filesystem', 'filesystem', 'npx', ['-y', '@modelcontextprotocol/server-filesystem', '~/docs', repo]));
    assert.deepEqual(build('memory'), local('Memory', 'memory', 'npx', ['-y', '@modelcontextprotocol/server-memory'], { MEMORY_FILE_PATH: '/data/connector-memory.jsonl' }));
    assert.deepEqual(build('sequential-thinking'), local('Sequential Thinking', 'sequential-thinking', 'npx', ['-y', '@modelcontextprotocol/server-sequential-thinking']));
    assert.deepEqual(build('git', { repo: '~/repo' }), local('Git', 'git', 'uvx', ['mcp-server-git', '--repository', '~/repo']));
    assert.deepEqual(build('fetch'), local('Fetch', 'fetch', 'uvx', ['mcp-server-fetch']));
    assert.deepEqual(build('time'), local('Time', 'time', 'uvx', ['mcp-server-time']));
    assert.deepEqual(build('everything'), local('Everything', 'everything', 'npx', ['-y', '@modelcontextprotocol/server-everything']));
    assert.throws(() => build('filesystem', {}), /^Error: Folders is required\.$/);
    assert.throws(() => build('git', { repo: '~/docs' }), /^Error: Not a git repository: ~\/docs$/);
  }
  assert.deepEqual(PRESETS.filter((p) => p.detect || p.build).map((p) => p.id), ['junos'], 'only Junos has hooks');
});

test('catalog entries of presets without hooks are unchanged', async () => {
  const withJunos = path.dirname(await junosFolder(path.join(await tempDir(), 'junos-mcp-server'), { venv: POSIX_VENV }));
  const node = 'Needs Node.js: brew install node';
  const uv = 'Needs uv: brew install uv';
  const before = [
    ['filesystem', 'npx', ['-y', '@modelcontextprotocol/server-filesystem', '{folders}'], [{ key: 'folders', label: 'Folders', kind: 'paths', placeholder: '~/Documents', required: true }], node],
    ['memory', 'npx', ['-y', '@modelcontextprotocol/server-memory'], [], node],
    ['sequential-thinking', 'npx', ['-y', '@modelcontextprotocol/server-sequential-thinking'], [], node],
    ['git', 'uvx', ['mcp-server-git', '--repository', '{repo}'], [{ key: 'repo', label: 'Repository', kind: 'path', placeholder: '~/Projects/my-repo', required: true }], uv],
    ['fetch', 'uvx', ['mcp-server-fetch'], [], uv],
    ['time', 'uvx', ['mcp-server-time'], [], uv],
    ['everything', 'npx', ['-y', '@modelcontextprotocol/server-everything'], [], node]
  ];
  // A home holding a Junos server must not change anything else.
  for (const home of [await tempDir(), withJunos]) {
    const others = buildCatalog({ pathValue: '', platform: 'darwin', home }).filter((p) => p.id !== 'junos');
    assert.deepEqual(others.map((p) => [p.id, p.command, p.args, p.fields, p.installHint]), before);
    assert.ok(others.every((p) => p.available === false && p.transport === 'stdio'));
  }
});

test('catalog: the Junos entry and its fields as the app shows them', async () => {
  const home = await tempDir();
  const entry = byId(buildCatalog({ pathValue: '', platform: 'darwin', home })).junos;
  assert.deepEqual(Object.keys(entry), [
    'id', 'name', 'description', 'category', 'transport', 'command', 'args', 'fields',
    'requires', 'available', 'network', 'docsUrl', 'note', 'installHint'
  ], 'the hooks stay on the server');
  assert.equal(entry.command, 'python3');
  assert.deepEqual(entry.args, ['{folder}/jmcp.py', '-f', '{devices}', '-t', 'stdio']);
  assert.equal(entry.requires, 'python3');
  assert.equal(entry.network, true);
  assert.deepEqual(entry.fields, [
    { key: 'folder', label: 'Server folder', kind: 'path', placeholder: '~/junos-mcp-server', required: true },
    { key: 'devices', label: 'Devices file', kind: 'path', placeholder: '~/junos-mcp-server/devices.json', required: false }
  ]);
});

test('catalog: ~/junos-mcp-server is the default only when jmcp.py is there', async () => {
  const home = await tempDir();
  const fields = () => byId(buildCatalog({ pathValue: '', platform: 'darwin', home })).junos.fields;
  assert.equal(fields()[0].default, undefined);
  await fs.mkdir(path.join(home, 'junos-mcp-server'));
  assert.equal(fields()[0].default, undefined, 'an empty folder is not the server');
  await fs.writeFile(path.join(home, 'junos-mcp-server', 'jmcp.py'), '');
  assert.deepEqual(fields(), [
    { key: 'folder', label: 'Server folder', kind: 'path', placeholder: '~/junos-mcp-server', required: true, default: '~/junos-mcp-server' },
    { key: 'devices', label: 'Devices file', kind: 'path', placeholder: '~/junos-mcp-server/devices.json', required: false }
  ]);
  await fs.writeFile(path.join(home, 'junos-mcp-server', 'devices.json'), '{}');
  assert.equal(fields()[1].default, '~/junos-mcp-server/devices.json', 'devices.json in the folder is the default too');
  for (const p of buildCatalog({ pathValue: '', platform: 'darwin', home })) {
    if (p.id !== 'junos') assert.ok(p.fields.every((f) => !('default' in f)), p.id);
  }
});

test('catalog: Junos is available through the folder venv with no Python on PATH', async () => {
  const home = await tempDir();
  const dir = path.join(home, 'junos-mcp-server');
  /** @param {string} platform */
  const entry = (platform) => byId(buildCatalog({ pathValue: '', platform, home })).junos;
  assert.equal(entry('darwin').available, false);
  assert.equal(entry('darwin').installHint, 'Needs Python 3: brew install python');
  await fs.mkdir(path.dirname(path.join(dir, POSIX_VENV)), { recursive: true });
  await fs.writeFile(path.join(dir, POSIX_VENV), '', { mode: 0o755 });
  assert.equal(entry('darwin').available, false, 'a venv without jmcp.py is not the server');
  await fs.writeFile(path.join(dir, 'jmcp.py'), '');
  assert.equal(entry('darwin').available, true);
  assert.equal(entry('darwin').installHint, '');
  assert.equal(entry('darwin').command, path.join('{folder}', POSIX_VENV), 'the shown command is the venv python buildJunos picks');
  assert.equal(entry('linux').available, true);
  assert.equal(entry('win32').available, false, 'Windows looks for Scripts/python.exe');
  await fs.mkdir(path.dirname(path.join(dir, WIN_VENV)), { recursive: true });
  await fs.writeFile(path.join(dir, WIN_VENV), '');
  assert.equal(entry('win32').available, true);
});

test('catalog: Junos is available with python3 on PATH and no folder', { skip: process.platform === 'win32' }, async () => {
  const home = await tempDir();
  const bin = await tempDir('mirabilis-bin-');
  await fs.writeFile(path.join(bin, 'python3'), '#!/bin/sh\n', { mode: 0o755 });
  const entry = byId(buildCatalog({ pathValue: bin, platform: 'darwin', home })).junos;
  assert.equal(entry.available, true);
  assert.equal(entry.fields[0].default, undefined);
});

test('Junos: the folder venv runs jmcp.py over stdio, devices.json from the folder', async () => {
  const home = await tempDir();
  const dir = await junosFolder(path.join(home, 'servers', 'junos'), { venv: POSIX_VENV });
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(junos({ folder: dir }, { home, platform }), {
      name: 'Junos',
      transport: 'stdio',
      command: path.join(dir, POSIX_VENV),
      args: [path.join(dir, 'jmcp.py'), '-f', path.join(dir, 'devices.json'), '-t', 'stdio'],
      env: {},
      cwd: dir,
      preset: 'junos'
    });
  }
});

test('Junos: without a venv it runs python3, or python on Windows', async () => {
  const home = await tempDir();
  const dir = await junosFolder(path.join(home, 'jmcp'));
  assert.equal(junos({ folder: dir }, { home, platform: 'darwin' }).command, 'python3');
  assert.equal(junos({ folder: dir }, { home, platform: 'linux' }).command, 'python3');
  assert.equal(junos({ folder: dir }, { home, platform: 'win32' }).command, 'python');
});

test('Junos: Windows runs the Scripts venv', async () => {
  const home = await tempDir();
  const dir = await junosFolder(path.join(home, 'jmcp'), { venv: WIN_VENV });
  const c = junos({ folder: dir }, { home, platform: 'win32' });
  assert.equal(c.command, path.join(dir, WIN_VENV));
  assert.deepEqual(c.args, [path.join(dir, 'jmcp.py'), '-f', path.join(dir, 'devices.json'), '-t', 'stdio']);
  assert.equal(c.cwd, dir);
  assert.equal(junos({ folder: dir }, { home, platform: 'darwin' }).command, 'python3', 'not a POSIX venv');
});

test('Junos: ~ is kept in stored form and expands to the files that exist', { skip: process.platform === 'win32' }, async () => {
  const home = await tempDir();
  await junosFolder(path.join(home, 'junos-mcp-server'), { venv: POSIX_VENV });
  const c = junos({ folder: '~/junos-mcp-server' }, { home, platform: 'darwin' });
  assert.equal(c.command, '~/junos-mcp-server/.venv/bin/python');
  assert.deepEqual(c.args, ['~/junos-mcp-server/jmcp.py', '-f', '~/junos-mcp-server/devices.json', '-t', 'stdio']);
  assert.equal(c.cwd, '~/junos-mcp-server');
  // What the program gets once ~ is expanded at start.
  for (const p of [c.command, c.args[0], c.args[2]]) await fs.access(expandTilde(p, home));
  assert.equal(expandTilde(c.cwd, home), path.join(home, 'junos-mcp-server'));
  // A relative folder is made absolute against home.
  assert.equal(junos({ folder: 'junos-mcp-server' }, { home, platform: 'darwin' }).cwd, path.join(home, 'junos-mcp-server'));
});

test('Junos: a devices file can live anywhere; a relative one is in the folder', async () => {
  const home = await tempDir();
  const dir = await junosFolder(path.join(home, 'jun'));
  const lab = path.join(home, 'lab.json');
  await fs.writeFile(lab, '{}');
  await fs.writeFile(path.join(dir, 'core.json'), '{}');
  const machine = { home, platform: 'darwin' };
  /** @param {any} devices */
  const flag = (devices) => junos({ folder: dir, devices }, machine).args.slice(1, 3);
  assert.deepEqual(flag(lab), ['-f', lab]);
  assert.deepEqual(flag('~/lab.json'), ['-f', '~/lab.json']);
  assert.deepEqual(flag('core.json'), ['-f', path.join(dir, 'core.json')]);
  assert.deepEqual(flag(''), ['-f', path.join(dir, 'devices.json')]);
  assert.deepEqual(flag(undefined), ['-f', path.join(dir, 'devices.json')]);
});

test('Junos: a missing folder, jmcp.py or devices file is a plain error', async () => {
  const home = await tempDir();
  const empty = path.join(home, 'empty');
  await fs.mkdir(empty);
  const dir = await junosFolder(path.join(home, 'jun'), { devices: false });
  const script = path.join(dir, 'jmcp.py');
  const nowhere = path.join(home, 'nope');
  const cases = [
    [{}, 'Server folder is required.'],
    [{ folder: '  ' }, 'Server folder is required.'],
    [{ folder: nowhere }, `Server folder not found: ${nowhere}`],
    [{ folder: '~/nope' }, 'Server folder not found: ~/nope'],
    [{ folder: script }, `Server folder not found: ${script}`],
    [{ folder: empty }, `jmcp.py not found in ${empty}`],
    [{ folder: dir }, `Devices file not found: ${path.join(dir, 'devices.json')}`],
    [{ folder: dir, devices: '~/lab.json' }, 'Devices file not found: ~/lab.json'],
    [{ folder: dir, devices: dir }, `Devices file not found: ${dir}`]
  ];
  for (const [fields, message] of cases) {
    assert.throws(() => junos(/** @type {any} */ (fields), { home, platform: 'darwin' }), (err) => err.message === message, JSON.stringify(fields));
  }
});
