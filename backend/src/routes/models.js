// @ts-check
// /api/models: what is installed, whether it is current, what the Ollama library
// offers, install jobs and uninstall. Reads are open, like GET /api/models;
// installing, canceling and deleting need the session token.

import express, { Router } from 'express';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { catalogRowFor, getModels as getCatalogModels, UNCENSORED_NAME_RE } from '../modelCatalog.js';
import { createInstallJobs, INSTALL_ERRORS, mcqSpecFor, SAFE_MODEL_RE } from '../modelInstallJobs.js';
import { compareVersions, createModelUpdates, detectOllamaInstall, mapLimit } from '../modelUpdates.js';
import { createOllamaLibrary, LibraryError, normalizeLibraryName } from '../ollamaLibrary.js';
import { normalizeDigest, readBodyCapped } from '../ollamaRegistry.js';
import { resolveUserPath } from '../paths.js';
import { getOllamaModelInfo, listOllamaModels } from '../providers/ollama.js';

export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const OLLAMA_TIMEOUT_MS = 3000;
const DELETE_TIMEOUT_MS = 30_000;
const MAX_OLLAMA_BYTES = 4 * 1024 * 1024;
const INSTALL_INFO_TTL_MS = 10 * 60 * 1000;

const MESSAGES = {
  badName: 'Invalid model name. Check the name.',
  badLibraryName: 'Invalid model name. Use name or user/name.',
  jobNotFound: 'Install job not found. Refresh the list.',
  notInstalled: 'Not installed. Refresh the list.',
  installRunning: 'Install running. Cancel it, then delete.',
  ollamaSilent: 'Ollama did not answer. Retry.',
  failed: 'Model manager failed. Retry.'
};

/** "qwen3" and "qwen3:latest" are the same install. @param {unknown} id */
export function withTag(id) {
  const s = String(id ?? '').trim().toLowerCase();
  if (!s) return '';
  return s.lastIndexOf(':') > s.lastIndexOf('/') ? s : `${s}:latest`;
}

/** Catalog entries by the exact tag they install. @param {any[]} entries */
function catalogIndex(entries) {
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const key = withTag(e?.ollamaId || e?.id);
    if (key && !map.has(key)) map.set(key, e);
  }
  return map;
}

/** First line of an Ollama error body, JSON or plain. @param {string} text */
function ollamaMessage(text) {
  let message = String(text || '');
  try { message = JSON.parse(message)?.error || message; } catch { /* plain text */ }
  return String(message).split('\n').map((s) => s.trim()).find(Boolean)?.slice(0, 200) || '';
}

/**
 * A failed uninstall as a status and a short sentence.
 * @param {{ err?: any, status?: number, text?: string }} failure
 */
export function describeDeleteError({ err, status = 0, text = '' }) {
  if (err) {
    if (err?.name === 'TimeoutError') return { status: 504, error: MESSAGES.ollamaSilent };
    return { status: 503, error: INSTALL_ERRORS.ollamaDown };
  }
  const message = ollamaMessage(text);
  if (status === 404 || /not found/i.test(message)) return { status: 404, error: MESSAGES.notInstalled };
  return { status: status >= 400 && status < 600 ? status : 502, error: message || 'Delete failed. Retry.' };
}

/** @param {unknown} v */
const isTrue = (v) => v === '1' || v === 'true';
/** A repeated query parameter arrives as an array; keep the first. @param {unknown} v */
const first = (v) => (Array.isArray(v) ? v[0] : v);

/**
 * @param {object} deps
 * @param {import('express').RequestHandler} deps.guard  the privileged-route guard
 * @param {() => string} [deps.ollamaBaseUrl]
 * @param {() => boolean} [deps.isGoDark]
 * @param {string} [deps.dataDir]  caches: ollama-library-cache.json, model-updates.json
 * @param {string} [deps.rootDir]  holds training/mcq
 * @param {ReturnType<typeof createInstallJobs>} [deps.jobs]
 * @param {ReturnType<typeof createOllamaLibrary>} [deps.library]
 * @param {ReturnType<typeof createModelUpdates>} [deps.updates]
 * @param {(baseUrl: string) => Promise<any[]>} [deps.listInstalled]  Ollama's /api/tags, mapped by providers/ollama.js
 * @param {(baseUrl: string, name: string, opts?: { digest?: string | null }) => Promise<any>} [deps.modelInfo]  capabilities and context from /api/show
 * @param {() => any[]} [deps.catalog]
 * @param {() => Promise<import('../modelUpdates.js').OllamaInstall>} [deps.detectInstall]
 * @param {(p: string) => Promise<{ bsize: number, blocks: number, bavail: number }>} [deps.statfsImpl]
 * @param {typeof fetch} [deps.fetchImpl]  for calls to Ollama itself
 * @param {{ env?: Record<string, string|undefined>, platform?: string, home?: string }} [deps.host]
 */
export function createModelsRouter({
  guard,
  ollamaBaseUrl = () => DEFAULT_BASE_URL,
  isGoDark = () => false,
  dataDir = '',
  rootDir = process.cwd(),
  catalog = getCatalogModels,
  jobs = createInstallJobs({ ollamaBaseUrl, rootDir, isGoDark }),
  library = createOllamaLibrary({ dataDir, isGoDark }),
  updates = undefined,
  listInstalled = listOllamaModels,
  modelInfo = getOllamaModelInfo,
  detectInstall = detectOllamaInstall,
  statfsImpl = statfs,
  fetchImpl = undefined,
  host = {}
}) {
  if (typeof guard !== 'function') throw new TypeError('createModelsRouter needs the privileged guard.');
  const env = host.env || process.env;
  const platform = host.platform || process.platform;
  const home = host.home || os.homedir();

  /** Built on this machine (MCQ, or a catalog entry marked local), so never checked upstream. @param {string} name */
  const isLocal = (name) => !!mcqSpecFor(name) || catalogIndex(catalog()).get(withTag(name))?.local === true;
  const checker = updates || createModelUpdates({ dataDir, isGoDark, library, isLocal });

  const base = () => String(ollamaBaseUrl() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  /** @param {string} url @param {RequestInit} [init] */
  const doFetch = (url, init) => (fetchImpl || fetch)(url, init);

  /** @param {string} route */
  async function ollamaJson(route) {
    const res = await doFetch(`${base()}${route}`, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Ollama answered ${res.status}`);
    }
    return JSON.parse((await readBodyCapped(res, MAX_OLLAMA_BYTES)).toString('utf8'));
  }

  /** @type {{ value: import('../modelUpdates.js').OllamaInstall, at: number } | null} */
  let installInfo = null;
  async function installMethod() {
    if (installInfo && Date.now() - installInfo.at < INSTALL_INFO_TTL_MS) return installInfo.value;
    const value = await detectInstall().catch(() => /** @type {const} */ ({ install: 'unknown', updateCommand: null }));
    installInfo = { value, at: Date.now() };
    return value;
  }

  /** Free space where Ollama keeps models: OLLAMA_MODELS, the default folder, else home. */
  async function diskInfo() {
    const candidates = [...new Set([
      env.OLLAMA_MODELS ? resolveUserPath(env.OLLAMA_MODELS) : '',
      path.join(home, '.ollama', 'models'),
      // The Linux install script runs Ollama as its own user.
      platform === 'linux' ? '/usr/share/ollama/.ollama/models' : '',
      home
    ].filter(Boolean))];
    for (const p of candidates) {
      try {
        const s = await statfsImpl(p);
        const bsize = Number(s.bsize);
        return { path: p, freeBytes: Number(s.bavail) * bsize, totalBytes: Number(s.blocks) * bsize };
      } catch {
        // Not there; try the next.
      }
    }
    return { path: candidates[0], freeBytes: null, totalBytes: null };
  }

  const router = Router();
  router.use(express.json({ limit: '16kb' }));

  /** @param {(req: any, res: any) => Promise<void>} fn */
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof LibraryError) {
        res.status(err.kind === 'not-found' ? 404 : 502).json({ error: err.message });
        return;
      }
      console.error('[models]', err?.stack || err?.message || err);
      res.status(500).json({ error: MESSAGES.failed });
    }
  };

  router.get('/installed', handle(async (_req, res) => {
    const [ping, install, disk, latest] = await Promise.all([
      ollamaJson('/api/version').then(
        (v) => ({ reachable: true, version: typeof v?.version === 'string' && v.version ? v.version : null }),
        () => ({ reachable: false, version: null })
      ),
      installMethod(),
      diskInfo(),
      checker.latestOllama().catch(() => null)
    ]);
    const runtime = {
      reachable: ping.reachable,
      version: ping.version,
      latest,
      updateAvailable: !!(ping.reachable && ping.version && latest && compareVersions(ping.version, latest) < 0),
      install: install.install,
      updateCommand: install.updateCommand,
      downloadUrl: OLLAMA_DOWNLOAD_URL
    };
    if (!ping.reachable) {
      res.json({ runtime, disk, models: [] });
      return;
    }

    const [listed, loaded] = await Promise.all([
      listInstalled(base()).catch(() => []),
      ollamaJson('/api/ps').then(
        (d) => new Set((Array.isArray(d?.models) ? d.models : []).map((m) => String(m?.name || m?.model || '').toLowerCase()).filter(Boolean)),
        () => new Set()
      )
    ]);
    const rows = catalog();
    const models = await mapLimit((Array.isArray(listed) ? listed : []).filter((m) => m?.name), 4, async (m) => {
      const name = String(m.name);
      const digest = normalizeDigest(m.digest) || null;
      // The digest keys the facts, so a model pulled again is read again.
      const info = await modelInfo(base(), name, { digest }).catch(() => null);
      // The row of this exact tag names it; another tag of the model still carries its flags.
      const match = catalogRowFor(name, rows);
      const entry = match?.exact ? match.row : null;
      const modified = Date.parse(m.modifiedAt ?? m.modified_at ?? '');
      return {
        name,
        sizeBytes: typeof m.sizeBytes === 'number' ? m.sizeBytes : (typeof m.size === 'number' ? m.size : null),
        digest,
        modifiedAt: Number.isFinite(modified) ? new Date(modified).toISOString() : null,
        family: m.family ?? m.details?.family ?? null,
        paramSize: m.paramSize ?? m.details?.parameter_size ?? null,
        quant: m.quant ?? m.details?.quantization_level ?? null,
        format: m.format ?? m.details?.format ?? null,
        capabilities: Array.isArray(info?.capabilities) ? info.capabilities : [],
        contextWindow: Number(info?.contextWindow) || null,
        loaded: loaded.has(name.toLowerCase()),
        catalog: entry ? { id: entry.id, label: entry.label, group: entry.group } : null,
        uncensored: match?.row?.uncensored === true || match?.row?.group === 'Uncensored' || UNCENSORED_NAME_RE.test(name),
        local: !!mcqSpecFor(name) || entry?.local === true
      };
    });
    res.json({ runtime, disk, models });
  }));

  // Compares digests only. Under Go Dark: the cached answers, no request.
  router.get('/updates', handle(async (req, res) => {
    const listed = await listInstalled(base()).catch(() => []);
    const models = (Array.isArray(listed) ? listed : [])
      .filter((m) => m?.name)
      .map((m) => ({ name: String(m.name), digest: normalizeDigest(m.digest) }));
    res.json(await checker.check({ models, refresh: isTrue(first(req.query.refresh)) }));
  }));

  router.get('/library', handle(async (req, res) => {
    res.json(await library.search({
      q: first(req.query.q),
      capabilities: req.query.c,
      size: first(req.query.s),
      order: first(req.query.o),
      page: first(req.query.page)
    }));
  }));

  /** "user/model" arrives either encoded in one segment or as two. */
  const tagsRoute = handle(async (req, res) => {
    const raw = req.params.ns ? `${req.params.ns}/${req.params.name}` : req.params.name;
    const name = normalizeLibraryName(raw);
    if (!name) {
      res.status(400).json({ error: MESSAGES.badLibraryName });
      return;
    }
    res.json(await library.tags(name));
  });
  router.get('/library/:name/tags', tagsRoute);
  router.get('/library/:ns/:name/tags', tagsRoute);

  router.get('/install-jobs', (_req, res) => {
    res.json({ jobs: jobs.list() });
  });

  router.get('/install-jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: MESSAGES.jobNotFound });
      return;
    }
    res.json({ job });
  });

  // Go Dark before the token: refusing changes nothing, and Go Dark state is public.
  // The pull itself goes through the local daemon, which the egress guard cannot see.
  /** @type {import('express').RequestHandler} */
  const refuseUnderGoDark = (_req, res, next) => {
    if (isGoDark()) {
      res.status(403).json({ error: INSTALL_ERRORS.goDark, goDark: true });
      return;
    }
    next();
  };

  router.post('/install-jobs', refuseUnderGoDark, guard, (req, res) => {
    const started = jobs.start(req.body?.modelId);
    if (!started) {
      res.status(400).json({ error: MESSAGES.badName });
      return;
    }
    res.status(202).json(started.deduped ? { job: started.job, deduped: true } : { job: started.job });
  });

  router.post('/install-jobs/:jobId/cancel', guard, (req, res) => {
    const out = jobs.cancel(req.params.jobId);
    if (!out) {
      res.status(404).json({ error: MESSAGES.jobNotFound });
      return;
    }
    res.json(out);
  });

  // Express has already decoded the segment, so "hf.co%2Fuser%2Frepo%3AQ4" arrives whole.
  router.delete('/:modelId', guard, handle(async (req, res) => {
    const name = String(req.params.modelId || '').trim();
    if (!name || !SAFE_MODEL_RE.test(name) || name.includes('..')) {
      res.status(400).json({ error: MESSAGES.badName });
      return;
    }
    if (jobs.activeFor(name)) {
      res.status(409).json({ error: MESSAGES.installRunning });
      return;
    }
    /** @type {Response} */
    let upstream;
    try {
      upstream = await doFetch(`${base()}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(DELETE_TIMEOUT_MS)
      });
    } catch (err) {
      const { status, error } = describeDeleteError({ err });
      res.status(status).json({ error });
      return;
    }
    if (upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      res.json({ ok: true });
      return;
    }
    const text = await readBodyCapped(upstream, 64 * 1024).then((b) => b.toString('utf8'), () => '');
    const { status, error } = describeDeleteError({ status: upstream.status, text });
    res.status(status).json({ error });
  }));

  // Body-parser failures arrive here instead of the handlers above.
  router.use((err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = Number(err?.status || err?.statusCode);
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: 'Send a small JSON object.' });
      return;
    }
    next(err);
  });

  return router;
}
