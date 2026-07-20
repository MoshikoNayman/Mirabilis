// backend/src/runtimeRegistry.js
// Declarative registry of inference RUNTIMES (as opposed to model providers). Every
// runtime is treated as an OpenAI-compatible-or-Ollama endpoint with a known shape,
// so adding a backend (llama.cpp, vLLM, an external server) is a data row here rather
// than another branch in modelService's if/else. The registry answers three things:
//   - what runtimes exist and how to reach them (baseUrl)
//   - whether Mirabilis can LAUNCH one locally or only consume an EXTERNAL one
//   - what each runtime is good at (capabilities), for the model router
//
// This is additive: the existing provider adapters keep working. The registry gives
// the launch layer, the router, and the UI a single source of truth.

import os from 'node:os';

// kind -> the transport used to talk to it. 'ollama' uses the Ollama native API;
// everything else speaks the OpenAI-compatible /v1/chat/completions shape.
export const RUNTIMES = [
  {
    id: 'ollama',
    kind: 'ollama',
    label: 'Ollama',
    scope: 'local',
    transport: 'ollama',
    managed: 'external',           // Ollama runs as its own daemon; we consume it
    baseUrlEnv: 'OLLAMA_BASE_URL',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    capabilities: {
      autoNumCtx: true, keepAlive: true, oomRetry: true, pull: true,
      kvQuant: false, flashAttn: 'auto', grammar: false, speculative: false, jsonMode: true
    },
    note: 'Zero-config default local runtime. Best for casual single-user use.'
  },
  {
    id: 'llamacpp',
    kind: 'llamacpp',
    label: 'llama.cpp',
    scope: 'local',
    transport: 'openai',           // llama-server exposes an OpenAI-compatible API
    managed: 'spawn',              // Mirabilis can launch/stop llama-server
    binaryCandidates: ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server', 'llama-server'],
    defaultPort: 8080,
    // Power-user local runtime: exposes the knobs Ollama hides.
    capabilities: {
      autoNumCtx: true, keepAlive: false, oomRetry: true,
      kvQuant: true, flashAttn: true, grammar: true, speculative: true, jsonMode: true
    },
    note: 'Metal-native power-user runtime. Unlocks KV-cache quant, flash attention, speculative decoding, and GBNF grammar-constrained JSON.'
  },
  {
    id: 'openai-compatible',
    kind: 'openai-compatible',
    label: 'Local / Custom Endpoint',
    scope: 'local',
    transport: 'openai',
    managed: 'external',           // any already-running OpenAI-compatible server
    baseUrlEnv: 'OPENAI_BASE_URL',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    capabilities: { jsonMode: true, grammar: 'server-dependent' },
    note: 'Point at any OpenAI-compatible server: LM Studio, Oobabooga, TGI, or a remote vLLM box.'
  },
  {
    id: 'vllm',
    kind: 'vllm',
    label: 'vLLM',
    scope: 'local-or-remote',      // managed locally on NVIDIA/CUDA; remote elsewhere
    transport: 'openai',
    managed: 'spawn-or-external',  // spawn a local server on CUDA, or consume a remote one
    defaultPort: 8000,
    capabilities: { jsonMode: true, continuousBatching: true, highConcurrency: true },
    note: 'Throughput king on NVIDIA. Runs as a managed local server on a CUDA GPU, or connect to a remote vLLM server by URL. CUDA-only, so not launched locally on Apple Silicon.'
  },
  {
    id: 'koboldcpp',
    kind: 'koboldcpp',
    label: 'KoboldCpp',
    scope: 'local',
    transport: 'openai',
    managed: 'external',
    baseUrlEnv: 'KOBOLD_BASE_URL',
    defaultBaseUrl: 'http://127.0.0.1:5001/v1',
    capabilities: { jsonMode: true },
    note: 'KoboldCpp local server.'
  }
];

const BY_ID = new Map(RUNTIMES.map((r) => [r.id, r]));

export function getRuntime(id) {
  return BY_ID.get(id) || null;
}

// Is this host Apple Silicon (Metal)? Used to gate CUDA-only runtimes (vLLM/SGLang).
export function isAppleSilicon() {
  return os.platform() === 'darwin' && os.arch() === 'arm64';
}

// A serializable view for the UI / router: which runtimes are usable here.
export function listRuntimes() {
  const appleSilicon = isAppleSilicon();
  return RUNTIMES.map((r) => {
    // vLLM (and SGLang later) are CUDA-only, so they cannot be LAUNCHED on this
    // Mac - but they are fully usable as a REMOTE endpoint over the OpenAI
    // transport. So they stay available (consumable), just not localLaunchable.
    const cudaLocalBlocked = r.kind === 'vllm' && appleSilicon;
    return {
      id: r.id,
      label: r.label,
      kind: r.kind,
      scope: r.scope,
      transport: r.transport,
      managed: r.managed,
      capabilities: r.capabilities,
      canPull: r.capabilities?.pull === true,
      note: r.note,
      // Coarse capability for the UI; the vLLM status route does the real probe
      // (NVIDIA GPU present + vLLM installed) before offering a local launch.
      localLaunchable: (r.managed === 'spawn' || r.managed === 'spawn-or-external') && !cudaLocalBlocked,
      available: true,
      remoteOnlyReason: cudaLocalBlocked
        ? 'vLLM is CUDA-only, so it runs on a remote NVIDIA host, not locally on Apple Silicon. Point it at your vLLM server URL.'
        : null
    };
  });
}
