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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { getRuntime } from './runtimeRegistry.js';

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
  const home = os.homedir();
  const root = process.env.OLLAMA_MODELS || join(home, '.ollama', 'models');
  const [name, tag = 'latest'] = String(model || '').split(':');
  // Manifests live under manifests/registry.ollama.ai/library/<name>/<tag> (or a
  // namespaced path for non-library models); search both shapes.
  const manifestDirs = [
    join(root, 'manifests', 'registry.ollama.ai', 'library', name, tag),
    join(root, 'manifests', 'registry.ollama.ai', name, tag)
  ];
  let manifestPath = manifestDirs.find((p) => existsSync(p));
  if (!manifestPath) {
    // Fallback: scan for a manifest file matching name/tag anywhere under manifests.
    try {
      const base = join(root, 'manifests', 'registry.ollama.ai');
      const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
      manifestPath = walk(base).find((p) => p.endsWith(join(name, tag)));
    } catch { /* ignore */ }
  }
  if (!manifestPath || !existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const modelLayer = (manifest.layers || []).find((l) => (l.mediaType || '').includes('.model'));
    if (!modelLayer) return null;
    const digest = String(modelLayer.digest || '').replace(':', '-');
    const blob = join(root, 'blobs', digest);
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
  const flags = [
    '-m', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-c', String(numCtx || 8192),
    '-ngl', String(ngl == null ? 999 : ngl),
    '-fa', flashAttn === false ? 'off' : 'on',
    '--jinja',
    '--no-webui',
    '-np', String(parallel || 1)
  ];
  if (kvQuant) { flags.push('-ctk', kvQuant, '-ctv', kvQuant); }
  return flags;
}

export function status() {
  if (!_proc || !_state) return { running: false, installed: isLlamaCppInstalled() };
  return { running: true, installed: true, ...(_state) };
}

export async function startServer({ modelPath, model, numCtx = 8192, port, ngl, kvQuant = 'q8_0', flashAttn = true, parallel = 1, timeoutMs = 180000 } = {}) {
  const bin = findBinary();
  if (!bin) return { ok: false, error: 'llama.cpp (llama-server) is not installed. Install with: brew install llama.cpp' };

  // Resolve the model path: explicit .gguf, or an Ollama model name -> its blob.
  let resolvedPath = modelPath;
  if (!resolvedPath && model) resolvedPath = resolveOllamaGguf(model);
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
