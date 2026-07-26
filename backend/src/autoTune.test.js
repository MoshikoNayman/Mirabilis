// autoTune tests.
//
// deriveInferenceDefaults is a pure function that decides how much context to
// hand the engine. Getting it wrong costs either quality (a needlessly tiny
// window) or a failed load (a window too large for the memory available), and
// it had no coverage at all despite being the headline of the tuning feature.
//
// The load-bearing test here is monotonicity: as a model gets bigger on fixed
// hardware, the context it is granted must never go UP.

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveInferenceDefaults, estimateParamsB } from './autoTune.js';

const MIN_CTX = 2048;
const CTX_STEP = 2048;

const ctxFor = (modelSizeBytes, over = {}) => deriveInferenceDefaults({
  profileRaw: { ramGb: 8, gpuOffloadCapable: true },
  modelSizeBytes,
  paramSize: '7B',
  modelContextWindow: 131072,
  ...over
}).options.num_ctx;

// ── invariants that must hold for every input ────────────────────────────────

test('num_ctx is always a positive multiple of the step and never below the floor', () => {
  for (let gb = 0.5; gb <= 40; gb += 0.5) {
    for (const ramGb of [4, 8, 16, 32, 64]) {
      const ctx = ctxFor(gb * 1e9, { profileRaw: { ramGb, gpuOffloadCapable: true } });
      assert.ok(Number.isInteger(ctx), `ctx must be an integer, got ${ctx}`);
      assert.ok(ctx >= MIN_CTX, `ctx ${ctx} below floor for ${gb}GB model on ${ramGb}GB RAM`);
      assert.equal(ctx % CTX_STEP, 0, `ctx ${ctx} is not a multiple of ${CTX_STEP}`);
    }
  }
});

test('num_ctx never exceeds the model\'s real context window', () => {
  for (const window of [2048, 4096, 8192, 32768, 131072]) {
    for (const gb of [0.5, 2, 4, 8]) {
      const ctx = ctxFor(gb * 1e9, { modelContextWindow: window });
      assert.ok(ctx <= window, `ctx ${ctx} exceeds the model window ${window}`);
    }
  }
});

test('num_ctx is monotonically non-increasing as the model grows', () => {
  // The real bug this catches: when the KV budget lands just above zero, the
  // computed context truncates to 0 and an `|| DEFAULT_CTX` fallback promoted it
  // to 8192, so a model that barely fits was granted FOUR TIMES the context of a
  // smaller one. That is exactly backwards, and it happens at the point where
  // memory is tightest, which is where a too-large window fails the load.
  for (const ramGb of [4, 8, 16, 32]) {
    let previous = Infinity;
    for (let bytes = 0.2e9; bytes <= ramGb * 1e9; bytes += 0.01e9) {
      const ctx = ctxFor(bytes, { profileRaw: { ramGb, gpuOffloadCapable: true } });
      assert.ok(
        ctx <= previous,
        `on ${ramGb}GB RAM, a ${(bytes / 1e9).toFixed(2)}GB model got ctx ${ctx}, ` +
        `MORE than the ${previous} granted to the smaller model before it`
      );
      previous = ctx;
    }
  }
});

test('num_ctx is monotonic across the budget boundary specifically', () => {
  // A coarse sweep steps straight over the failure. The window where the KV
  // allowance is positive but rounds down to zero tokens is only about 525KB
  // wide (one token's worth of KV cache for a 7B model), so 1MB steps can miss
  // it entirely. Walk it in 50KB steps. On 8GB RAM the budget is 5.2GB.
  for (const ramGb of [4, 8, 16, 32]) {
    const budgetBytes = ramGb * 0.65 * 1e9;
    let previous = Infinity;
    for (let bytes = budgetBytes - 2e6; bytes <= budgetBytes + 2e6; bytes += 50e3) {
      const ctx = ctxFor(bytes, { profileRaw: { ramGb, gpuOffloadCapable: true } });
      assert.ok(
        ctx <= previous,
        `on ${ramGb}GB RAM near the ${(budgetBytes / 1e9).toFixed(2)}GB budget, a ` +
        `${(bytes / 1e9).toFixed(4)}GB model got ctx ${ctx}, MORE than the ${previous} before it`
      );
      previous = ctx;
    }
  }
});

test('a model at or over the memory budget falls back to the floor, not a large default', () => {
  // 8GB RAM gives a 5.2GB budget (65 percent reserve policy).
  assert.equal(ctxFor(5.20e9), MIN_CTX, 'exactly at budget should use the floor');
  assert.equal(ctxFor(5.1999e9), MIN_CTX, 'a hair under budget must not jump to a large default');
  assert.equal(ctxFor(6.0e9), MIN_CTX, 'over budget should use the floor');
  assert.equal(ctxFor(20e9), MIN_CTX, 'far over budget should use the floor');
});

test('a small model on a big box gets a generous context', () => {
  const ctx = ctxFor(1e9, { profileRaw: { ramGb: 64, gpuOffloadCapable: true } });
  assert.ok(ctx > 8192, `expected a generous window on 64GB RAM, got ${ctx}`);
});

// ── the surrounding option flags ─────────────────────────────────────────────

test('tight memory turns on the low-VRAM path', () => {
  const { options, meta } = deriveInferenceDefaults({
    profileRaw: { ramGb: 8, gpuOffloadCapable: true },
    modelSizeBytes: 5.0e9, paramSize: '7B', modelContextWindow: 8192
  });
  assert.equal(meta.tight, true);
  assert.equal(options.low_vram, true);
  assert.equal(options.num_batch, 256);
});

test('num_thread is set only when there is no GPU to offload to', () => {
  const cpu = deriveInferenceDefaults({
    profileRaw: { ramGb: 16, gpuOffloadCapable: false, cpuCores: 10 },
    modelSizeBytes: 2e9, paramSize: '3B', modelContextWindow: 8192
  });
  assert.equal(cpu.options.num_thread, 10, 'CPU-only should pin threads');

  const gpu = deriveInferenceDefaults({
    profileRaw: { ramGb: 16, gpuOffloadCapable: true, cpuCores: 10 },
    modelSizeBytes: 2e9, paramSize: '3B', modelContextWindow: 8192
  });
  assert.equal(gpu.options.num_thread, undefined, 'GPU path should let the engine choose');
});

test('free memory tightens the budget below the reserve policy', () => {
  const plenty = deriveInferenceDefaults({
    profileRaw: { ramGb: 64, gpuOffloadCapable: true },
    availableGb: 60, modelSizeBytes: 2e9, paramSize: '7B', modelContextWindow: 131072
  }).options.num_ctx;
  const squeezed = deriveInferenceDefaults({
    profileRaw: { ramGb: 64, gpuOffloadCapable: true },
    availableGb: 4, modelSizeBytes: 2e9, paramSize: '7B', modelContextWindow: 131072
  }).options.num_ctx;
  assert.ok(squeezed < plenty, `low free memory should shrink ctx (${squeezed} vs ${plenty})`);
});

// ── estimateParamsB ─────────────────────────────────────────────────────────

test('estimateParamsB reads both B and M suffixes and falls back to size', () => {
  assert.equal(estimateParamsB('7B', 0), 7);
  assert.equal(estimateParamsB('12.2B', 0), 12.2);
  assert.ok(Math.abs(estimateParamsB('494.03M', 0) - 0.49403) < 1e-9, 'M suffix converts to billions');
  assert.ok(Math.abs(estimateParamsB(null, 6e9) - 10) < 0.001, 'derives from on-disk bytes');
  assert.equal(estimateParamsB(null, 0), 7, 'defaults to 7B when nothing is known');
});
