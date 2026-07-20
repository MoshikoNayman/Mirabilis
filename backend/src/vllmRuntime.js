// @ts-check
// backend/src/vllmRuntime.js
// Managed LOCAL vLLM runtime for machines with a supported NVIDIA GPU (Linux/CUDA).
// vLLM is a high-throughput OpenAI-compatible server; here Mirabilis can launch,
// health-check, and stop a local `vllm serve` process, the same way it manages
// llama.cpp. It is a high-performance local alternative to Ollama on NVIDIA boxes.
//
// vLLM is CUDA-only, so on Apple Silicon it cannot run locally at all - the app
// keeps using llama.cpp / MLX locally there, and vLLM stays usable only as a
// REMOTE endpoint. Both paths coexist: local (managed here) when the hardware
// supports it, remote (point at a URL) everywhere. One managed server at a time.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { getRuntime } from './runtimeRegistry.js';

/** @typedef {import('./types.js').VllmCapability} VllmCapability */
/** @typedef {import('./types.js').RuntimeStatus} RuntimeStatus */

const execFileP = promisify(execFile);

// A model ref is a Hugging Face repo id or a local path. Restrict to a safe
// charset so it can never inject shell/args (it is spawned as an argv element,
// but this is defense in depth and rejects obvious garbage early).
const SAFE_VLLM_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._/@-]*$/;

/** @type {import('node:child_process').ChildProcess | null} */
let _proc = null;   // running vLLM child, or null
/** @type {{ pid?: number, port: number, baseUrl: string, model: string, startedAt: number } | null} */
let _state = null;  // { pid, port, baseUrl, model, startedAt }

function isAppleSilicon() {
  return os.platform() === 'darwin' && os.arch() === 'arm64';
}

// Is a command on PATH? Uses `command -v` (posix) / `where` (win) with no shell
// interpolation of untrusted input (cmd is always a fixed literal here).
/** @param {string} cmd @returns {Promise<boolean>} */
async function has(cmd) {
  try {
    if (os.platform() === 'win32') await execFileP('where', [cmd], { timeout: 5000 });
    else await execFileP('/bin/sh', ['-c', `command -v ${cmd}`], { timeout: 5000 });
    return true;
  } catch { return false; }
}

// Detect how vLLM can be launched: the `vllm` CLI, or `python -m vllm...`.
/** @returns {Promise<{ installed: boolean, launcher: 'cli'|'python'|null, python: string|null }>} */
async function detectLauncher() {
  if (await has('vllm')) return { installed: true, launcher: 'cli', python: null };
  for (const py of ['python3', 'python']) {
    if (await has(py)) {
      try { await execFileP(py, ['-c', 'import vllm'], { timeout: 8000 }); return { installed: true, launcher: 'python', python: py }; }
      catch { /* vllm not importable under this interpreter */ }
    }
  }
  return { installed: false, launcher: null, python: null };
}

// Can this machine run a LOCAL vLLM server? Returns a rich, UI-facing verdict.
/** @returns {Promise<VllmCapability>} */
export async function detectCapability() {
  if (isAppleSilicon()) {
    return {
      canRunLocal: false, appleSilicon: true, hasNvidia: false, installed: false,
      reason: 'vLLM is CUDA-only and cannot run locally on Apple Silicon. Use llama.cpp or MLX locally here, or connect to a remote vLLM server below.'
    };
  }
  if (os.platform() === 'win32') {
    const hasNvidia = await has('nvidia-smi');
    return {
      canRunLocal: false, appleSilicon: false, hasNvidia, installed: false,
      reason: 'Local vLLM runs on Linux with CUDA. On Windows, run it under WSL2, or connect to a remote vLLM server below.'
    };
  }
  const hasNvidia = await has('nvidia-smi');
  const { installed, launcher, python } = await detectLauncher();
  if (!hasNvidia) {
    return { canRunLocal: false, hasNvidia: false, installed, launcher, python,
      reason: 'No NVIDIA GPU detected (nvidia-smi missing). Local vLLM needs a CUDA GPU; connect to a remote vLLM server below instead.' };
  }
  if (!installed) {
    return { canRunLocal: false, hasNvidia: true, installed: false, launcher: null, python: null,
      reason: 'NVIDIA GPU found, but vLLM is not installed. Install it with:  pip install vllm' };
  }
  return { canRunLocal: true, hasNvidia: true, installed: true, launcher, python, reason: null };
}

/** @param {number} port @param {number} timeoutMs @param {() => boolean} signalStop @returns {Promise<boolean>} */
function pollHealth(port, timeoutMs, signalStop) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = async () => {
      if (signalStop()) return resolve(false);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
        if (res.ok) return resolve(true);
      } catch { /* not up yet (model still loading / downloading) */ }
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 1000);
    };
    tick();
  });
}

/** @returns {RuntimeStatus} */
export function status() {
  return _proc && _state ? { running: true, ...(_state) } : { running: false };
}

// Launch a local vLLM OpenAI-compatible server for `model` (a HF repo id or a
// local path). Refuses cleanly on hardware that cannot run it.
/** @param {{ model?: string, port?: number, gpuMemoryUtilization?: number, maxModelLen?: number, dtype?: string, extraArgs?: string[], timeoutMs?: number }} [args] */
export async function startServer({ model, port, gpuMemoryUtilization, maxModelLen, dtype = 'auto', extraArgs = [], timeoutMs = 1000 * 60 * 15 } = {}) {
  const cap = await detectCapability();
  if (!cap.canRunLocal) return { ok: false, error: cap.reason || 'Local vLLM is not supported on this machine.' };

  const raw = String(model || '').trim();
  if (!raw || raw.includes('..') || !SAFE_VLLM_MODEL.test(raw)) {
    return { ok: false, error: 'Provide a valid model id (a Hugging Face repo id like "Qwen/Qwen2.5-7B-Instruct" or a local path).' };
  }

  const rtPort = Number(port) || getRuntime('vllm')?.defaultPort || 8000;
  await stopServer(); // one managed server at a time (a GPU holds one model)

  const gmu = Math.max(0.1, Math.min(1, Number(gpuMemoryUtilization) || 0.9));
  const safeDtype = ['auto', 'half', 'float16', 'bfloat16', 'float32'].includes(String(dtype)) ? String(dtype) : 'auto';
  const common = ['--host', '127.0.0.1', '--port', String(rtPort), '--gpu-memory-utilization', String(gmu), '--dtype', safeDtype];
  if (maxModelLen) common.push('--max-model-len', String(Math.max(256, Math.min(1048576, Number(maxModelLen) || 0))));
  for (const a of (Array.isArray(extraArgs) ? extraArgs : [])) {
    if (typeof a === 'string' && a.length > 0 && a.length < 200 && !a.includes('\0')) common.push(a);
  }

  // cap.canRunLocal guaranteed a launcher above; the `|| 'python3'` is a null-safe
  // fallback so the spawn target is never undefined.
  const cmd = cap.launcher === 'python' ? (cap.python || 'python3') : 'vllm';
  const args = cap.launcher === 'python'
    ? ['-m', 'vllm.entrypoints.openai.api_server', '--model', raw, ...common]
    : ['serve', raw, ...common];

  let stopping = false;
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  _proc = child;
  child.on('exit', () => { if (_proc === child) { _proc = null; _state = null; } });
  child.on('error', () => { stopping = true; });

  const healthy = await pollHealth(rtPort, timeoutMs, () => stopping || !_proc);
  if (!healthy) {
    await stopServer();
    return { ok: false, error: `vLLM did not become healthy within ${Math.round(timeoutMs / 1000)}s (a first-time weight download or load can exceed this, or the GPU is out of memory).` };
  }
  _state = { pid: child.pid, port: rtPort, baseUrl: `http://127.0.0.1:${rtPort}/v1`, model: raw, startedAt: Date.now() };
  return { ok: true, ...(_state) };
}

export function stopServer() {
  return new Promise((resolve) => {
    const child = _proc;
    if (!child) return resolve(true);
    _proc = null; _state = null;
    try {
      child.kill('SIGTERM');
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(true); }, 4000);
      child.on('exit', () => { clearTimeout(t); resolve(true); });
    } catch { resolve(true); }
  });
}
