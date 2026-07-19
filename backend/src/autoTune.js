// backend/src/autoTune.js
// Capability-first inference tuning: map detected hardware + the selected model to
// safe, ambitious Ollama runtime options. The headline is num_ctx - Ollama otherwise
// defaults to ~2048/4096 regardless of a model's real window, so a 128K model runs
// blind. We size num_ctx to the model's true window capped by a memory budget, so a
// capable box uses its whole context instead of a toy slice. Every value here is a
// DEFAULT that the user's Inference Cockpit overrides.

const MIN_CTX = 2048;
const DEFAULT_CTX = 8192;
const CTX_STEP = 2048;

// Coarse fp16 KV-cache cost per token, derived from param count. A 7B model is
// ~0.5 MB/token; approximate as params(B) * 0.075 MB with a floor. Deliberately
// generous so we under-fill memory rather than OOM. Refine later via /api/show arch.
function kvBytesPerToken(paramsB) {
  return Math.max(0.05, (paramsB || 7) * 0.075) * 1e6;
}

// Billions of params from a paramSize string ("12.2B", "494.03M") or on-disk bytes
// (quantized models run ~0.6 bytes/param).
export function estimateParamsB(paramSize, modelSizeBytes) {
  if (paramSize) {
    const m = String(paramSize).match(/([\d.]+)\s*([BM])/i);
    if (m) return m[2].toUpperCase() === 'B' ? parseFloat(m[1]) : parseFloat(m[1]) / 1000;
  }
  if (modelSizeBytes > 0) return modelSizeBytes / 0.6e9;
  return 7;
}

function snapCtx(n) {
  return Math.max(MIN_CTX, Math.floor((n || DEFAULT_CTX) / CTX_STEP) * CTX_STEP);
}

// profileRaw: { backend, ramGb, unifiedMemory, gpuOffloadCapable, cpuCores, ... } from hardwareProfile.raw
// availableGb: fresh free-memory read (not from the cached profile)
// modelContextWindow: the model's true max window (from /api/show, or a heuristic)
export function deriveInferenceDefaults({ profileRaw = {}, availableGb = null, modelSizeBytes = 0, paramSize = null, modelContextWindow = DEFAULT_CTX } = {}) {
  const ramGb = profileRaw.ramGb || availableGb || 8;
  const paramsB = estimateParamsB(paramSize, modelSizeBytes);
  const weightsGb = modelSizeBytes > 0 ? modelSizeBytes / 1e9 : paramsB * 0.6;

  // Memory budget = the tighter of the reserve policy (keep ~35% for OS/apps/KV
  // slack) and the current free memory (leave 10% of what is actually free).
  const policyBudget = ramGb * 0.65;
  const freeBudget = (Number.isFinite(availableGb) && availableGb > 0) ? availableGb * 0.9 : policyBudget;
  const budgetGb = Math.max(1, Math.min(policyBudget, freeBudget));

  const options = {};

  // num_ctx: spend the leftover budget (after weights) on KV cache, capped at the
  // model's real window. If weights already eat the budget, fall back to a small ctx.
  const kvBudgetBytes = Math.max(0, budgetGb - weightsGb) * 1e9;
  let ctx = kvBudgetBytes > 0 ? Math.floor(kvBudgetBytes / kvBytesPerToken(paramsB)) : MIN_CTX;
  ctx = Math.min(ctx || DEFAULT_CTX, modelContextWindow || DEFAULT_CTX);
  ctx = snapCtx(ctx);
  options.num_ctx = ctx;

  // Tight memory: help the model fit rather than fail to load.
  const tight = weightsGb > budgetGb * 0.85;
  if (tight) { options.low_vram = true; options.num_batch = 256; }

  // CPU-only: pin threads to physical cores (Ollama otherwise guesses).
  if (!profileRaw.gpuOffloadCapable && profileRaw.cpuCores) {
    options.num_thread = profileRaw.cpuCores;
  }

  return {
    options,
    meta: {
      budgetGb: Math.round(budgetGb * 10) / 10,
      weightsGb: Math.round(weightsGb * 10) / 10,
      paramsB: Math.round(paramsB * 10) / 10,
      modelContextWindow: modelContextWindow || null,
      resolvedCtx: ctx,
      tight,
      backend: profileRaw.backend || null,
      note: `num_ctx ${ctx}${profileRaw.backend && profileRaw.backend !== 'CPU' ? `, offload on ${profileRaw.backend}` : ', CPU'} - sized to ${budgetGb.toFixed(0)} GB budget`
    }
  };
}
