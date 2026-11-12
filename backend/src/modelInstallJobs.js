// @ts-check
// Model installs as server-side jobs: a pull through the Ollama daemon, or for an
// MCQ model a base pull plus `ollama create` from training/mcq. Jobs live in
// memory, so a page reload keeps its progress; a cancel stops the download and
// the partial blobs stay on disk, so the next pull resumes. Updating a model is
// a new job for the same name: Ollama fetches only the layers that changed.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ollamaTag } from './modelCatalog.js';
import { readBodyCapped } from './ollamaRegistry.js';

/** Ollama model ids: alphanumeric plus . _ : / -. Nothing else is forwarded. */
export const SAFE_MODEL_RE = /^[a-z0-9][a-z0-9._:/-]{0,99}$/i;

/** Built here from a Modelfile in training/mcq, on top of a public base model. */
export const MCQ_MODEL_SPECS = Object.freeze({
  'mcq-pro-12b': { base: 'gemma3:12b', modelfile: 'Modelfile.mcq-pro-12b' },
  'mcq-ultra-31b': { base: 'gemma4:31b', modelfile: 'Modelfile.mcq-ultra-31b' },
  'mcq-raw-8b': { base: 'dolphin3:latest', modelfile: 'Modelfile.mcq-raw-8b' }
});

export const INSTALL_ERRORS = {
  newerOllama: 'Needs a newer Ollama. Update Ollama, then retry.',
  notFound: 'Not in the Ollama library. Check the name.',
  diskFull: 'Disk full. Free some space, then retry.',
  ollamaDown: 'Ollama is not running. Start it, then retry.',
  interrupted: 'Download interrupted. Retry to resume.',
  offline: 'Could not reach ollama.com. Check the connection.',
  goDark: 'Blocked by Go Dark. Turn it off to install.',
  noCli: 'Ollama command not found. Install Ollama, then retry.'
};

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const PRUNE_AFTER_MS = 6 * 60 * 60 * 1000;
const MAX_JOBS = 100;
const LIST_LIMIT = 50;
/** No byte from Ollama for this long ends a pull. Verifying a large blob is quiet, but not this quiet. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SHOW_TIMEOUT_MS = 15_000;
/** One progress line is a few hundred bytes; anything this long is not one. */
const MAX_LINE_CHARS = 64 * 1024;
const RATE_SAMPLE_MS = 500;
const MAX_ERROR_BYTES = 64 * 1024;

/** Lowercased and validated, or '' when it must not reach Ollama. @param {unknown} raw */
export function normalizeModelId(raw) {
  const id = String(raw ?? '').trim().toLowerCase();
  return id && SAFE_MODEL_RE.test(id) && !id.includes('..') ? id : '';
}

/** The MCQ recipe for an installed or requested name ("mcq-raw-8b" or "mcq-raw-8b:latest"). @param {string} name */
export function mcqSpecFor(name) {
  const id = String(name || '').trim().toLowerCase().replace(/:latest$/, '');
  return Object.prototype.hasOwnProperty.call(MCQ_MODEL_SPECS, id) ? MCQ_MODEL_SPECS[/** @type {keyof typeof MCQ_MODEL_SPECS} */ (id)] : null;
}

/** Lines of CLI or API text, terminal escapes removed. @param {string} text */
function lines(text) {
  return String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n|\r/).map((s) => s.trim()).filter(Boolean);
}

/** First line, without a CLI "Error: " prefix, capped. @param {string} text */
function firstLine(text) {
  return (lines(text)[0] || '').replace(/^error:\s*/i, '').slice(0, 200);
}

/** The error a CLI run printed: its "Error:" line, else its last line. @param {string} text */
function cliError(text) {
  const all = lines(text);
  const line = [...all].reverse().find((l) => /^error:/i.test(l)) || all[all.length - 1] || '';
  return line.replace(/^error:\s*/i, '').slice(0, 200);
}

/**
 * A short plain sentence for a failed install: what failed and the fix.
 * Ollama errors that match nothing known keep Ollama's own words, one line.
 * @param {any} err
 * @returns {string}
 */
export function describeInstallError(err) {
  const text = String(err?.message ?? err ?? '');
  const code = String(err?.code || err?.cause?.code || '');
  const status = Number(err?.status) || 0;
  if (code === 'GO_DARK') return INSTALL_ERRORS.goDark;
  if (status === 412 || /requires a newer version of ollama|newer version of ollama is required|upgrade ollama/i.test(text)) {
    return INSTALL_ERRORS.newerOllama;
  }
  if (code === 'ENOSPC' || /no space left|not enough (?:disk )?space|disk (?:is )?full|insufficient (?:disk|storage)/i.test(text)) {
    return INSTALL_ERRORS.diskFull;
  }
  if (code === 'ECONNREFUSED') return INSTALL_ERRORS.ollamaDown;
  if (code === 'ENOENT' && /spawn/i.test(String(err?.syscall || text))) return INSTALL_ERRORS.noCli;
  if (status === 404 || /manifest unknown|file does not exist|manifest_unknown|name_unknown|pull access denied|repository does not exist/i.test(text)) {
    return INSTALL_ERRORS.notFound;
  }
  // The daemon could not reach the registry. Go's net errors read like these.
  if (/dial tcp|no such host|i\/o timeout|tls handshake|network is unreachable|connect: connection refused|context deadline exceeded|server misbehaving|eai_again|enotfound/i.test(text)) {
    return INSTALL_ERRORS.offline;
  }
  if (code === 'INTERRUPTED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET'
    || /unexpected eof|connection reset|terminated|other side closed|premature close|socket hang up/i.test(text)) {
    return INSTALL_ERRORS.interrupted;
  }
  return firstLine(text) || 'Install failed. Retry.';
}

/** @param {string} message @param {Record<string, any>} [extra] */
function failure(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

/**
 * The job's message for an Ollama pull status line, or null to keep the last one.
 * @param {unknown} status
 */
export function pullStatusMessage(status) {
  const s = String(status || '').toLowerCase();
  if (!s) return null;
  if (s.startsWith('pulling manifest')) return 'Starting';
  if (s.startsWith('pulling') || s.startsWith('downloading')) return 'Downloading';
  if (s.startsWith('verifying')) return 'Verifying';
  if (s.startsWith('writing') || s.startsWith('removing')) return 'Writing';
  return null;
}

/**
 * Overall progress of one pull across all its layers. Bytes already on disk when
 * a layer first appears (a resumed download, a shared layer) count toward the
 * total but not toward the speed.
 * @param {{ now?: () => number }} [opts]
 */
export function createPullProgress({ now = Date.now } = {}) {
  /** @type {Map<string, { total: number, completed: number, base: number }>} */
  const layers = new Map();
  /** @type {number | null} */
  let rate = null;
  /** @type {number | null} */
  let sampleAt = null;
  let sampleBytes = 0;
  /** Rate windows so far; the first one mostly measures the connection ramp-up. */
  let windows = 0;

  const totals = () => {
    let total = 0;
    let completed = 0;
    let fresh = 0;
    for (const l of layers.values()) {
      total += l.total;
      completed += l.completed;
      fresh += l.completed - l.base;
    }
    return { total, completed, fresh };
  };

  return {
    /** @param {any} line one parsed line of /api/pull */
    update(line) {
      const digest = typeof line?.digest === 'string' ? line.digest : '';
      const total = Number(line?.total);
      if (!digest || !Number.isFinite(total) || total <= 0) return;
      const reported = Number(line?.completed);
      const completed = Number.isFinite(reported) ? Math.min(Math.max(reported, 0), total) : 0;
      const layer = layers.get(digest);
      if (!layer) layers.set(digest, { total, completed, base: completed });
      else {
        layer.total = total;
        layer.completed = Math.max(layer.completed, completed);
      }
      const at = now();
      const { fresh } = totals();
      if (sampleAt === null) {
        sampleAt = at;
        sampleBytes = fresh;
        return;
      }
      if (at - sampleAt < RATE_SAMPLE_MS) return;
      const instant = Math.max(0, fresh - sampleBytes) / ((at - sampleAt) / 1000);
      windows += 1;
      rate = windows <= 2 || rate === null ? instant : rate * 0.7 + instant * 0.3;
      sampleAt = at;
      sampleBytes = fresh;
    },

    snapshot() {
      const { total, completed } = totals();
      const known = total > 0;
      return {
        pct: known ? Math.floor((completed / total) * 100) : null,
        completedBytes: known ? completed : null,
        totalBytes: known ? total : null,
        bytesPerSec: rate === null ? null : Math.round(rate),
        etaSec: known && windows >= 2 && rate && rate > 0 ? Math.max(0, Math.round((total - completed) / rate)) : null
      };
    }
  };
}

/** AbortSignal.any where it exists (Node 18.17+), a manual join elsewhere. @param {AbortSignal[]} signals */
function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) { controller.abort(s.reason); break; }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/**
 * spawn() to completion, killed when the signal aborts.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string>, signal?: AbortSignal, onSpawn?: (proc: import('node:child_process').ChildProcess) => void }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    options.onSpawn?.(proc);
    let stdout = '';
    let stderr = '';
    const kill = () => { try { proc.kill('SIGTERM'); } catch { /* already gone */ } };
    if (options.signal?.aborted) kill();
    options.signal?.addEventListener('abort', kill, { once: true });
    // Bounded: only the end of the output is ever shown.
    proc.stdout?.on('data', (d) => { stdout = (stdout + d.toString()).slice(-16_384); });
    proc.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-16_384); });
    proc.on('error', (err) => {
      options.signal?.removeEventListener('abort', kill);
      reject(err);
    });
    proc.on('close', (code, signal) => {
      options.signal?.removeEventListener('abort', kill);
      // Killed by a signal is a failure, not exit code 0.
      resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

/**
 * @typedef {{ id: string, modelId: string, status: 'queued'|'running'|'canceling'|'completed'|'failed'|'canceled',
 *   pct: number|null, message: string, error: string|null, done: boolean, createdAt: string, updatedAt: string,
 *   completedBytes: number|null, totalBytes: number|null, bytesPerSec: number|null, etaSec: number|null }} InstallJob
 */

/**
 * @param {object} [opts]
 * @param {() => string} [opts.ollamaBaseUrl]
 * @param {string} [opts.rootDir]  holds training/mcq
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {typeof runProcess} [opts.run]  the ollama CLI, for MCQ builds
 * @param {() => number} [opts.now]
 * @param {number} [opts.idleTimeoutMs]
 * @param {() => boolean} [opts.isGoDark]  the daemon downloads where the egress guard cannot see, so a pull checks this
 */
export function createInstallJobs({
  ollamaBaseUrl = () => DEFAULT_BASE_URL,
  rootDir = process.cwd(),
  fetchImpl,
  run: runCli = runProcess,
  now = Date.now,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  isGoDark = () => false
} = {}) {
  /** @type {Map<string, InstallJob & { abort: AbortController, currentProcess: import('node:child_process').ChildProcess | null }>} */
  const jobs = new Map();
  /** @param {string} url @param {RequestInit} init */
  const doFetch = (url, init) => (fetchImpl || fetch)(url, init);
  const iso = () => new Date(now()).toISOString();
  const base = () => String(ollamaBaseUrl() || DEFAULT_BASE_URL).replace(/\/+$/, '');

  /** @param {InstallJob} job @returns {InstallJob} */
  const snapshot = (job) => ({
    id: job.id,
    modelId: job.modelId,
    status: job.status,
    pct: job.pct,
    message: job.message,
    error: job.error,
    done: job.done,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedBytes: job.completedBytes,
    totalBytes: job.totalBytes,
    bytesPerSec: job.bytesPerSec,
    etaSec: job.etaSec
  });

  /** @param {InstallJob} job @param {Partial<InstallJob>} patch */
  const update = (job, patch) => Object.assign(job, patch, { updatedAt: iso() });

  function prune() {
    const at = now();
    for (const [id, job] of jobs) {
      const updatedAt = Date.parse(job.updatedAt);
      if (job.done && Number.isFinite(updatedAt) && at - updatedAt > PRUNE_AFTER_MS) jobs.delete(id);
    }
    // Oldest finished jobs go first when too many pile up.
    for (const [id, job] of jobs) {
      if (jobs.size <= MAX_JOBS) break;
      if (job.done) jobs.delete(id);
    }
  }

  /**
   * Read /api/pull's NDJSON stream into the job until success.
   * @param {Response} res
   * @param {InstallJob & { abort: AbortController }} job
   */
  async function follow(res, job) {
    if (!res.body) throw failure('Ollama sent no progress.', { code: 'INTERRUPTED' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const progress = createPullProgress({ now });
    let buffer = '';
    /** @type {NodeJS.Timeout | undefined} */
    let idle;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { reader.cancel().catch(() => {}); }, idleTimeoutMs);
      idle.unref?.();
    };

    /** @param {string} line @returns {boolean} true on success */
    const handle = (line) => {
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        return false; // a partial or foreign line; the next one will do
      }
      if (payload?.error) throw failure(String(payload.error), { fromOllama: true });
      if (payload?.status === 'success') return true;
      // Go Dark switched on mid-download: closing the stream stops the daemon.
      if (isGoDark()) throw failure('Go Dark is on.', { code: 'GO_DARK' });
      progress.update(payload);
      const snap = progress.snapshot();
      update(job, {
        // A line that lands after Cancel must not undo "Canceling".
        message: job.status === 'canceling' ? job.message : (pullStatusMessage(payload?.status) || job.message),
        // Overall across layers, held below 100 until Ollama says success, never backwards.
        pct: snap.pct === null ? job.pct : Math.max(job.pct ?? 0, Math.min(99, snap.pct)),
        completedBytes: snap.completedBytes,
        totalBytes: snap.totalBytes,
        bytesPerSec: snap.bytesPerSec,
        etaSec: snap.etaSec
      });
      return false;
    };

    arm();
    try {
      for (;;) {
        /** @type {ReadableStreamReadResult<Uint8Array>} */
        let chunk;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (job.abort.signal.aborted) throw err;
          throw failure(String(err?.message || 'stream error'), { code: 'INTERRUPTED' });
        }
        if (chunk.done) break;
        arm();
        buffer += decoder.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line && handle(line)) return;
        }
        if (buffer.length > MAX_LINE_CHARS) buffer = '';
      }
      buffer += decoder.decode();
      if (buffer.trim() && handle(buffer.trim())) return;
      if (job.abort.signal.aborted) throw failure('canceled', { name: 'AbortError' });
      // The stream ended without success and without an error: cut off mid-download.
      throw failure('The download stopped before it finished.', { code: 'INTERRUPTED' });
    } finally {
      clearTimeout(idle);
      reader.cancel().catch(() => {});
    }
  }

  /** @param {string} model @param {InstallJob & { abort: AbortController }} job */
  async function pull(model, job) {
    if (isGoDark()) throw failure('Go Dark is on.', { code: 'GO_DARK' });
    const res = await doFetch(`${base()}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: job.abort.signal
    });
    if (!res.ok) {
      const body = await readBodyCapped(res, MAX_ERROR_BYTES).then((b) => b.toString('utf8'), () => '');
      let message = body;
      try { message = JSON.parse(body)?.error || body; } catch { /* plain text */ }
      throw failure(message || `Ollama answered ${res.status}.`, { status: res.status });
    }
    await follow(res, job);
  }

  /** Whether Ollama already has this model, through the API rather than the CLI. @param {string} model @param {AbortSignal} signal */
  async function installed(model, signal) {
    const res = await doFetch(`${base()}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: anySignal([signal, AbortSignal.timeout(SHOW_TIMEOUT_MS)])
    });
    await res.body?.cancel().catch(() => {});
    return res.ok;
  }

  /** @param {InstallJob & { abort: AbortController, currentProcess: any }} job */
  async function execute(job) {
    update(job, { status: 'running', message: 'Starting', error: null });
    try {
      const spec = mcqSpecFor(job.modelId);
      if (spec) {
        const modelfile = join(rootDir, 'training', 'mcq', spec.modelfile);
        if (!existsSync(modelfile)) throw failure(`Missing training/mcq/${spec.modelfile}. Reinstall Mirabilis.`);
        if (!(await installed(spec.base, job.abort.signal))) await pull(spec.base, job);
        update(job, { message: 'Creating', bytesPerSec: null, etaSec: null });
        const created = await runCli('ollama', ['create', job.modelId, '-f', modelfile], {
          cwd: rootDir,
          // The CLI talks to the same daemon as the API calls above.
          env: { OLLAMA_HOST: base() },
          signal: job.abort.signal,
          onSpawn: (proc) => { job.currentProcess = proc; }
        });
        job.currentProcess = null;
        if (job.abort.signal.aborted) throw failure('canceled', { name: 'AbortError' });
        if (created.code !== 0) throw failure(cliError(`${created.stdout}\n${created.stderr}`) || `Could not build ${job.modelId}. Retry.`);
      } else {
        await pull(job.modelId, job);
      }
      update(job, {
        status: 'completed', message: 'Installed', pct: 100, done: true,
        completedBytes: job.totalBytes, bytesPerSec: null, etaSec: null
      });
    } catch (err) {
      if (job.abort.signal.aborted) {
        update(job, { status: 'canceled', message: 'Canceled', done: true, error: null, bytesPerSec: null, etaSec: null });
      } else {
        update(job, { status: 'failed', message: 'Failed', done: true, error: describeInstallError(err), bytesPerSec: null, etaSec: null });
      }
    } finally {
      job.currentProcess = null;
      prune();
    }
  }

  return {
    /**
     * Start installing a model, or return the job already installing it.
     * @param {unknown} modelId
     * @returns {{ job: InstallJob, deduped: boolean } | null} null for an invalid id
     */
    start(modelId) {
      const id = normalizeModelId(modelId);
      if (!id) return null;
      prune();
      // "dolphin3" and "dolphin3:latest" are one pull.
      for (const job of jobs.values()) {
        if (!job.done && ollamaTag(job.modelId) === ollamaTag(id)) return { job: snapshot(job), deduped: true };
      }
      const createdAt = iso();
      const job = {
        id: randomUUID(), modelId: id, status: /** @type {const} */ ('queued'), pct: null, message: 'Queued', error: null,
        done: false, createdAt, updatedAt: createdAt, completedBytes: null, totalBytes: null, bytesPerSec: null, etaSec: null,
        abort: new AbortController(), currentProcess: null
      };
      jobs.set(job.id, job);
      void execute(job);
      return { job: snapshot(job), deduped: false };
    },

    /** @param {unknown} jobId */
    get(jobId) {
      prune();
      const job = jobs.get(String(jobId || ''));
      return job ? snapshot(job) : null;
    },

    /** Newest first. */
    list() {
      prune();
      return [...jobs.values()]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, LIST_LIMIT)
        .map(snapshot);
    },

    /** The unfinished job for this model, if any. @param {unknown} modelId */
    activeFor(modelId) {
      const id = normalizeModelId(modelId);
      if (!id) return null;
      for (const job of jobs.values()) if (!job.done && ollamaTag(job.modelId) === ollamaTag(id)) return snapshot(job);
      return null;
    },

    /**
     * Stop a download or build. Partial blobs stay on disk for the next pull.
     * @param {unknown} jobId
     */
    cancel(jobId) {
      const job = jobs.get(String(jobId || ''));
      if (!job) return null;
      if (job.done) return { job: snapshot(job), alreadyDone: true };
      update(job, { status: 'canceling', message: 'Canceling' });
      try { job.abort.abort(); } catch { /* already aborted */ }
      try { job.currentProcess?.kill('SIGTERM'); } catch { /* already gone */ }
      return { job: snapshot(job), cancelRequested: true };
    }
  };
}
