// backend/src/llamacppRuntime.js
// Managed llama.cpp runtime: launch / health-check / stop a llama-server process with
// hardware-tuned flags, and talk to it over the OpenAI-compatible transport (which now
// forwards the full param set). This is the "first-class" part Ollama-by-URL can't do:
// Mirabilis supervises the process and exposes the knobs Ollama hides - KV-cache
// quantization (q8_0 halves KV memory), flash attention, and server slots.
//
// One managed server at a time (memory-safe on unified-memory Macs). It can run a GGUF
// path directly, or resolve one of the user's existing Ollama models to its GGUF blob.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import os from 'node:os';
import { getRuntime } from './runtimeRegistry.js';

// Ollama model refs: [namespace/]name[:tag] over a safe charset. Used to reject any
// value that could traverse the filesystem before it is ever joined into a path.
const SAFE_MODEL_REF = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*(:[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/;
// Ollama blob digests are sha256 hex; validate before using one as a path segment.
const SAFE_DIGEST = /^sha256[:-][0-9a-f]{64}$/;
// KV-cache quant types llama.cpp accepts; anything else is dropped (falls back to default).
const KV_TYPES = new Set(['f16', 'f32', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'iq4_nl', 'bf16']);

let _proc = null;      // the running llama-server child, or null
let _state = null;     // { pid, port, baseUrl, model, startedAt, flags }

function findBinary() {
  const rt = getRuntime('llamacpp');
  for (const cand of rt.binaryCandidates) {
    if (cand.includes('/')) { if (existsSync(cand)) return cand; }
    else return cand; // rely on PATH
  }
  return null;
}

export function isLlamaCppInstalled() {
  const bin = findBinary();
  return !!bin && (bin.includes('/') ? existsSync(bin) : true);
}

// Resolve an Ollama model name (e.g. "qwen2.5:0.5b") to the absolute path of its GGUF
// weights blob, so the user's existing library runs under llama.cpp with no re-download.
export function resolveOllamaGguf(model) {
  const raw = String(model || '');
  // Reject anything that is not a plain model ref before it touches a path (traversal guard).
  if (!SAFE_MODEL_REF.test(raw) || raw.includes('..')) return null;
  const home = os.homedir();
  const root = resolve(process.env.OLLAMA_MODELS || join(home, '.ollama', 'models'));
  const blobsRoot = join(root, 'blobs');
  const hadTag = raw.includes(':');
  const [name, tag = 'latest'] = raw.split(':');
  // Manifests live under manifests/registry.ollama.ai/library/<name>/<tag> (or a
  // namespaced path for non-library models); search both shapes.
  const manifestDirs = [
    join(root, 'manifests', 'registry.ollama.ai', 'library', name, tag),
    join(root, 'manifests', 'registry.ollama.ai', name, tag)
  ];
  let manifestPath = manifestDirs.find((p) => existsSync(p));
  if (!manifestPath) {
    // Fallback: scan for a manifest file under manifests. Match an exact name/tag;
    // and when the caller gave no explicit tag (e.g. "qwen2.5"), accept whatever
    // tag is actually installed for that name (prefer "latest") so a base name
    // still resolves to the one downloaded version (e.g. qwen2.5:0.5b).
    try {
      const base = join(root, 'manifests', 'registry.ollama.ai');
      const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
      const all = walk(base);
      manifestPath = all.find((p) => p.endsWith(join(name, tag)));
      if (!manifestPath && !hadTag) {
        const forName = all.filter((p) => { const parts = p.split(sep); return parts[parts.length - 2] === name; });
        manifestPath = forName.find((p) => p.endsWith(sep + 'latest')) || forName[0];
      }
    } catch { /* ignore */ }
  }
  if (!manifestPath || !existsSync(manifestPath)) return null;
  // Defense in depth: the resolved manifest must live inside the Ollama store.
  if (!resolve(manifestPath).startsWith(root + sep)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const modelLayer = (manifest.layers || []).find((l) => (l.mediaType || '').includes('.model'));
    if (!modelLayer) return null;
    const digestRaw = String(modelLayer.digest || '');
    if (!SAFE_DIGEST.test(digestRaw)) return null; // never build a path from an untrusted digest
    const blob = join(blobsRoot, digestRaw.replace(':', '-'));
    if (!resolve(blob).startsWith(blobsRoot + sep)) return null;
    return existsSync(blob) ? blob : null;
  } catch { return null; }
}

function pollHealth(port, timeoutMs, signalStop) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = async () => {
      if (signalStop()) return resolve(false);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return resolve(true);
      } catch { /* not up yet */ }
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 600);
    };
    tick();
  });
}

// Build the tuned flag list from the resolved context + hardware. On Apple unified
// memory we offload all layers (-ngl 999) and quantize the KV cache to q8_0 to stretch
// the memory budget; flash attention on; jinja chat template for /v1/chat/completions.
function buildFlags({ modelPath, port, numCtx, ngl, kvQuant, flashAttn, parallel }) {
  const ctx = Math.max(256, Math.min(1048576, Number(numCtx) || 8192));
  const gpuLayers = ngl == null ? 999 : Math.max(0, Math.min(1000, Number(ngl) || 0));
  const flags = [
    '-m', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-c', String(ctx),
    '-ngl', String(gpuLayers),
    '-fa', flashAttn === false ? 'off' : 'on',
    '--jinja',
    '--no-webui',
    '-np', String(Math.max(1, Math.min(64, Number(parallel) || 1)))
  ];
  // Only pass a KV-cache type llama.cpp actually accepts; ignore anything else.
  if (kvQuant && KV_TYPES.has(String(kvQuant))) { flags.push('-ctk', String(kvQuant), '-ctv', String(kvQuant)); }
  return flags;
}

export function status() {
  if (!_proc || !_state) return { running: false, installed: isLlamaCppInstalled() };
  return { running: true, installed: true, ...(_state) };
}

export async function startServer({ modelPath, model, numCtx = 8192, port, ngl, kvQuant = 'q8_0', flashAttn = true, parallel = 1, timeoutMs = 180000 } = {}) {
  const bin = findBinary();
  if (!bin) return { ok: false, error: 'llama.cpp (llama-server) is not installed. Install with: brew install llama.cpp' };

  // Resolve the model path. An explicit modelPath must be an existing REGULAR .gguf
  // file (never a directory, device, or arbitrary file); an Ollama model name goes
  // through the validated resolver above.
  let resolvedPath = null;
  if (modelPath) {
    const rp = resolve(String(modelPath).replace(/\0/g, ''));
    if (!/\.gguf$/i.test(rp) || !existsSync(rp) || !statSync(rp).isFile()) {
      return { ok: false, error: 'modelPath must be an existing .gguf file.' };
    }
    resolvedPath = rp;
  } else if (model) {
    resolvedPath = resolveOllamaGguf(model);
  }
  if (!resolvedPath || !existsSync(resolvedPath)) {
    return { ok: false, error: `Could not find a GGUF for ${model || modelPath}. Pass an absolute .gguf path or an installed Ollama model name.` };
  }

  await stopServer(); // one managed server at a time

  const rtPort = port || getRuntime('llamacpp').defaultPort || 8080;
  const flags = buildFlags({ modelPath: resolvedPath, port: rtPort, numCtx, ngl, kvQuant, flashAttn, parallel });
  let stopping = false;
  const child = spawn(bin, flags, { stdio: ['ignore', 'pipe', 'pipe'] });
  _proc = child;
  child.on('exit', () => { if (_proc === child) { _proc = null; _state = null; } });
  child.on('error', () => { stopping = true; });

  const healthy = await pollHealth(rtPort, timeoutMs, () => stopping || !_proc);
  if (!healthy) {
    await stopServer();
    return { ok: false, error: `llama-server did not become healthy within ${Math.round(timeoutMs / 1000)}s (model may be too large for memory, or the port is busy).` };
  }
  _state = { pid: child.pid, port: rtPort, baseUrl: `http://127.0.0.1:${rtPort}/v1`, model: model || resolvedPath, startedAt: Date.now(), flags };
  return { ok: true, ...(_state) };
}

export function stopServer() {
  return new Promise((resolve) => {
    const child = _proc;
    if (!child) return resolve(true);
    _proc = null; _state = null;
    try {
      child.kill('SIGTERM');
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(true); }, 3000);
      child.on('exit', () => { clearTimeout(t); resolve(true); });
    } catch { resolve(true); }
  });
}
