// Install jobs against a fake Ollama on loopback: overall progress across layers,
// the short error sentences, cancel, dedupe and the MCQ build path. The ollama CLI
// is stubbed; nothing is downloaded.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  createInstallJobs, createPullProgress, describeInstallError, INSTALL_ERRORS, MCQ_MODEL_SPECS, mcqSpecFor,
  normalizeModelId, pullStatusMessage, runProcess
} from './modelInstallJobs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {Record<string, (req: http.IncomingMessage, res: http.ServerResponse, body: any) => any>} */
let routes = {};
/** @type {{ method: string, url: string, body: any }[]} */
let seen = [];
/** @type {http.Server} */
let server;
let ollamaUrl = '';

before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ method: String(req.method), url: String(req.url), body });
    const route = routes[`${req.method} ${String(req.url).split('?')[0]}`];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"no route"}');
      return;
    }
    await route(req, res, body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  ollamaUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(() => r(undefined)));
});

/** NDJSON lines, a few milliseconds apart, like /api/pull. */
const ndjson = (lines, gap = 3) => async (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const line of lines) {
    res.write(`${JSON.stringify(line)}\n`);
    await sleep(gap);
  }
  res.end();
};

const LAYER_A = 'sha256:aaaa';
const LAYER_B = 'sha256:bbbb';
const TWO_LAYERS = [
  { status: 'pulling manifest' },
  { status: 'pulling aaaa', digest: LAYER_A, total: 1000 },
  { status: 'pulling aaaa', digest: LAYER_A, total: 1000, completed: 500 },
  { status: 'pulling aaaa', digest: LAYER_A, total: 1000, completed: 1000 },
  { status: 'pulling bbbb', digest: LAYER_B, total: 1000, completed: 0 },
  { status: 'pulling bbbb', digest: LAYER_B, total: 1000, completed: 1000 },
  { status: 'verifying sha256 digest' },
  { status: 'writing manifest' },
  { status: 'success' }
];

/** Poll a job until it finishes, recording every pct seen. */
async function settle(jobs, id, timeoutMs = 5000) {
  const pcts = [];
  const messages = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = jobs.get(id);
    if (job.pct !== null) pcts.push(job.pct);
    if (messages[messages.length - 1] !== job.message) messages.push(job.message);
    if (job.done) return { job, pcts, messages };
    if (Date.now() > deadline) throw new Error(`job ${id} did not finish: ${JSON.stringify(job)}`);
    await sleep(1);
  }
}

const freshJobs = (extra = {}) => createInstallJobs({ ollamaBaseUrl: () => ollamaUrl, ...extra });

test('progress is overall across layers; resumed bytes count toward the total, not the speed', () => {
  let clock = 0;
  const p = createPullProgress({ now: () => clock });
  p.update({ digest: 'a', total: 1000, completed: 400 }); // already on disk
  assert.deepEqual(p.snapshot(), { pct: 40, completedBytes: 400, totalBytes: 1000, bytesPerSec: null, etaSec: null });
  clock = 1000;
  p.update({ digest: 'a', total: 1000, completed: 500 });
  assert.equal(p.snapshot().bytesPerSec, 100, '100 new bytes in one second');
  assert.equal(p.snapshot().etaSec, null, 'no time left from the ramp-up window alone');
  clock = 2000;
  p.update({ digest: 'a', total: 1000, completed: 900 });
  assert.equal(p.snapshot().bytesPerSec, 400, 'the second window replaces the ramp-up one');
  assert.equal(p.snapshot().etaSec, 0, '100 bytes left at 400 a second');
  clock = 2200;
  p.update({ digest: 'b', total: 1000 }); // a new layer: the total grows
  const snap = p.snapshot();
  assert.equal(snap.totalBytes, 2000);
  assert.equal(snap.completedBytes, 900);
  assert.equal(snap.pct, 45);
  p.update({ status: 'verifying sha256 digest' });
  p.update({ digest: 'a', total: 1000, completed: 100 }); // never backwards per layer
  assert.equal(p.snapshot().completedBytes, 900);
});

test('Ollama status lines become short messages', () => {
  assert.equal(pullStatusMessage('pulling manifest'), 'Starting');
  assert.equal(pullStatusMessage('pulling a3de86cd1c13'), 'Downloading');
  assert.equal(pullStatusMessage('verifying sha256 digest'), 'Verifying');
  assert.equal(pullStatusMessage('writing manifest'), 'Writing');
  assert.equal(pullStatusMessage('something new'), null);
});

test('failures map to the short sentences; unknown ones keep Ollama\'s first line', () => {
  const newer = 'pull model manifest: 412:\n\nThe model you are attempting to pull requires a newer version of Ollama.\n\nPlease download the latest version at:\n\n\thttps://ollama.com/download';
  assert.equal(describeInstallError(new Error(newer)), INSTALL_ERRORS.newerOllama);
  assert.equal(describeInstallError(Object.assign(new Error('x'), { status: 412 })), INSTALL_ERRORS.newerOllama);
  assert.equal(describeInstallError(new Error('pull model manifest: file does not exist')), INSTALL_ERRORS.notFound);
  assert.equal(describeInstallError(new Error('pull model manifest: manifest unknown')), INSTALL_ERRORS.notFound);
  assert.equal(describeInstallError(new Error('write /models/blobs/x: no space left on device')), INSTALL_ERRORS.diskFull);
  assert.equal(describeInstallError(Object.assign(new Error('x'), { code: 'ENOSPC' })), INSTALL_ERRORS.diskFull);
  assert.equal(describeInstallError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), INSTALL_ERRORS.ollamaDown);
  assert.equal(describeInstallError(new Error('pull model manifest: Get "https://registry.ollama.ai/v2/library/x/manifests/latest": dial tcp: lookup registry.ollama.ai: no such host')), INSTALL_ERRORS.offline);
  assert.equal(describeInstallError(Object.assign(new Error('cut'), { code: 'INTERRUPTED' })), INSTALL_ERRORS.interrupted);
  assert.equal(describeInstallError(new Error('unexpected EOF')), INSTALL_ERRORS.interrupted);
  assert.equal(describeInstallError(Object.assign(new Error('Go Dark is on'), { code: 'GO_DARK' })), INSTALL_ERRORS.goDark);
  assert.equal(describeInstallError(Object.assign(new Error('spawn ollama ENOENT'), { code: 'ENOENT', syscall: 'spawn ollama' })), INSTALL_ERRORS.noCli);
  assert.equal(describeInstallError(new Error('Error: the model is odd\nsecond line')), 'the model is odd');
  assert.equal(describeInstallError(new Error('')), 'Install failed. Retry.');
  for (const sentence of Object.values(INSTALL_ERRORS)) {
    assert.ok(sentence.split(/\s+/).length <= 12, sentence);
    assert.match(sentence, /^[\x20-\x7e]+$/, 'ASCII only');
  }
});

test('ids are validated and MCQ names resolve with or without :latest', () => {
  assert.equal(normalizeModelId('  Qwen3:8B '), 'qwen3:8b');
  assert.equal(normalizeModelId('hf.co/user/repo:Q4_K_M'), 'hf.co/user/repo:q4_k_m');
  for (const bad of ['', 'bad; rm -rf /', '../x', 'a/../b', null]) assert.equal(normalizeModelId(bad), '', String(bad));
  assert.equal(mcqSpecFor('mcq-raw-8b:latest'), MCQ_MODEL_SPECS['mcq-raw-8b']);
  assert.equal(mcqSpecFor('qwen3:8b'), null);
});

test('a pull completes with overall progress that never goes backwards', async () => {
  routes = { 'POST /api/pull': ndjson(TWO_LAYERS) };
  seen = [];
  const jobs = freshJobs();
  const started = jobs.start('Qwen3:8b');
  assert.ok(started);
  assert.equal(started.deduped, false);
  assert.equal(started.job.modelId, 'qwen3:8b');
  const { job, pcts, messages } = await settle(jobs, started.job.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.message, 'Installed');
  assert.equal(job.pct, 100);
  assert.equal(job.error, null);
  assert.equal(job.totalBytes, 2000);
  assert.equal(job.completedBytes, 2000);
  assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b), 'pct is monotonic');
  assert.ok(pcts.filter((p) => p < 100).every((p) => p <= 99), 'below 100 until success');
  assert.ok(messages.includes('Downloading'));
  assert.deepEqual(seen.map((s) => [s.url, s.body]), [['/api/pull', { model: 'qwen3:8b', stream: true }]]);
  for (const key of ['completedBytes', 'totalBytes', 'bytesPerSec', 'etaSec']) assert.ok(key in job, key);
});

test('an error line from Ollama fails the job with a short sentence', async () => {
  routes = { 'POST /api/pull': ndjson([{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }]) };
  const jobs = freshJobs();
  const { job } = await settle(jobs, jobs.start('nope:1b')?.job.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.message, 'Failed');
  assert.equal(job.error, INSTALL_ERRORS.notFound);
});

test('a non-OK answer keeps Ollama\'s own words', async () => {
  routes = {
    'POST /api/pull': (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid model name' }));
    }
  };
  const jobs = freshJobs();
  const { job } = await settle(jobs, jobs.start('x:1b')?.job.id);
  assert.equal(job.error, 'invalid model name');
});

test('a stream cut mid-download says it can resume', async () => {
  routes = {
    'POST /api/pull': async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ status: 'pulling aaaa', digest: LAYER_A, total: 1000, completed: 10 })}\n`);
      await sleep(10);
      req.socket.destroy();
    }
  };
  const jobs = freshJobs();
  const { job } = await settle(jobs, jobs.start('x:1b')?.job.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.error, INSTALL_ERRORS.interrupted);
});

test('a stream that ends without success is interrupted too, and so is a silent one', async () => {
  routes = { 'POST /api/pull': ndjson([{ status: 'pulling aaaa', digest: LAYER_A, total: 1000, completed: 10 }]) };
  let jobs = freshJobs();
  assert.equal((await settle(jobs, jobs.start('x:1b')?.job.id)).job.error, INSTALL_ERRORS.interrupted);

  routes = {
    'POST /api/pull': async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
      // Then nothing at all.
    }
  };
  jobs = freshJobs({ idleTimeoutMs: 80 });
  const { job } = await settle(jobs, jobs.start('y:1b')?.job.id);
  assert.equal(job.error, INSTALL_ERRORS.interrupted);
});

test('Ollama not running is said plainly', async () => {
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {any} */ (closed.address()).port;
  await new Promise((r) => closed.close(() => r(undefined)));
  const jobs = createInstallJobs({ ollamaBaseUrl: () => `http://127.0.0.1:${port}` });
  const { job } = await settle(jobs, jobs.start('qwen3:8b')?.job.id);
  assert.equal(job.error, INSTALL_ERRORS.ollamaDown);
});

test('the same model twice is one job; cancel stops the download', async () => {
  let closedByClient = false;
  routes = {
    'POST /api/pull': async (req, res) => {
      res.on('close', () => { closedByClient = true; });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (let i = 1; i < 500 && !res.destroyed; i += 1) {
        res.write(`${JSON.stringify({ status: 'pulling aaaa', digest: LAYER_A, total: 100000, completed: i * 10 })}\n`);
        await sleep(5);
      }
      res.end();
    }
  };
  const jobs = freshJobs();
  const first = jobs.start('qwen3:8b');
  const second = jobs.start('QWEN3:8b');
  assert.equal(second?.deduped, true);
  assert.equal(second?.job.id, first?.job.id);
  assert.equal(jobs.activeFor('qwen3:8b')?.id, first?.job.id);
  // A bare name is its :latest tag.
  const bare = jobs.start('dolphin3');
  assert.equal(jobs.start('dolphin3:latest')?.job.id, bare?.job.id);
  assert.equal(jobs.activeFor('Dolphin3:latest')?.id, bare?.job.id);
  jobs.cancel(bare?.job.id);
  await sleep(40);
  const canceled = jobs.cancel(first?.job.id);
  assert.equal(canceled?.cancelRequested, true);
  const { job } = await settle(jobs, first?.job.id);
  assert.equal(job.status, 'canceled');
  assert.equal(job.message, 'Canceled');
  assert.equal(job.error, null);
  await sleep(20);
  assert.equal(closedByClient, true, 'the request to Ollama was closed');
  assert.equal(jobs.cancel(first?.job.id)?.alreadyDone, true);
  assert.equal(jobs.cancel('no-such-job'), null);
  assert.equal(jobs.activeFor('qwen3:8b'), null);
  assert.equal(jobs.start('bad; rm -rf /'), null);
  assert.equal(jobs.list()[0].id, first?.job.id);
});

test('Go Dark stops a running download and refuses one that has not started', async () => {
  let closedByClient = false;
  routes = {
    'POST /api/pull': async (_req, res) => {
      res.on('close', () => { closedByClient = true; });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (let i = 1; i < 500 && !res.destroyed; i += 1) {
        res.write(`${JSON.stringify({ status: 'pulling aaaa', digest: LAYER_A, total: 100000, completed: i * 10 })}\n`);
        await sleep(5);
      }
      res.end();
    }
  };
  let dark = false;
  const jobs = freshJobs({ isGoDark: () => dark });
  const started = jobs.start('qwen3:8b');
  await sleep(40);
  assert.equal(jobs.get(started?.job.id)?.status, 'running');
  dark = true;
  const { job } = await settle(jobs, started?.job.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.error, INSTALL_ERRORS.goDark);
  await sleep(20);
  assert.equal(closedByClient, true, 'the request to Ollama was closed');

  seen = [];
  const refused = await settle(jobs, jobs.start('qwen3:4b')?.job.id);
  assert.equal(refused.job.error, INSTALL_ERRORS.goDark);
  assert.deepEqual(seen, [], 'nothing reached Ollama');
});

test('MCQ: the base is pulled when missing, then built with the CLI on the same daemon', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirabilis-mcq-'));
  await fs.mkdir(path.join(rootDir, 'training', 'mcq'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'training', 'mcq', 'Modelfile.mcq-raw-8b'), 'FROM dolphin3:latest\n');
  seen = [];
  routes = {
    'POST /api/show': (_req, res) => { res.writeHead(404); res.end('{"error":"not found"}'); },
    'POST /api/pull': ndjson(TWO_LAYERS)
  };
  /** @type {any[]} */
  const cli = [];
  const jobs = freshJobs({
    rootDir,
    run: async (command, args, options) => {
      cli.push({ command, args, env: options?.env, cwd: options?.cwd });
      await sleep(30);
      return { code: 0, stdout: '', stderr: 'success' };
    }
  });
  const { job, messages } = await settle(jobs, jobs.start('mcq-raw-8b')?.job.id);
  assert.equal(job.status, 'completed', job.error || '');
  assert.ok(messages.includes('Creating'));
  assert.deepEqual(seen.map((s) => [s.url, s.body.model]), [['/api/show', 'dolphin3:latest'], ['/api/pull', 'dolphin3:latest']]);
  assert.deepEqual(cli, [{
    command: 'ollama',
    args: ['create', 'mcq-raw-8b', '-f', path.join(rootDir, 'training', 'mcq', 'Modelfile.mcq-raw-8b')],
    env: { OLLAMA_HOST: ollamaUrl },
    cwd: rootDir
  }]);

  // Base already there: no pull. A failed build reports its Error: line.
  seen = [];
  routes = { 'POST /api/show': (_req, res) => { res.writeHead(200); res.end('{}'); } };
  const failing = freshJobs({
    rootDir,
    run: async () => ({ code: 1, stdout: '', stderr: 'gathering model components\nError: invalid model reference\n' })
  });
  const built = await settle(failing, failing.start('mcq-raw-8b')?.job.id);
  assert.equal(built.job.status, 'failed');
  assert.equal(built.job.error, 'invalid model reference');
  assert.deepEqual(seen.map((s) => s.url), ['/api/show']);

  const missing = freshJobs({ rootDir, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const noFile = await settle(missing, missing.start('mcq-pro-12b')?.job.id);
  assert.equal(noFile.job.error, 'Missing training/mcq/Modelfile.mcq-pro-12b. Reinstall Mirabilis.');
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('a CLI killed by a signal is a failure, not exit code 0', { skip: process.platform === 'win32' ? 'POSIX signals' : false }, async () => {
  const out = await runProcess(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']);
  assert.notEqual(out.code, 0);
  const ok = await runProcess(process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.deepEqual([ok.code, ok.stdout], [0, 'hi']);
});
