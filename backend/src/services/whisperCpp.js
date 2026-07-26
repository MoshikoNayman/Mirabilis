// @ts-check
// backend/src/services/whisperCpp.js
// Local, on-device speech-to-text via whisper.cpp.
//
// This lives in its own module because BOTH products need it and only one had
// it. The chat dictation path tried whisper.cpp before falling back to the
// Python `whisper` CLI or the OpenAI API, while IntelLedger media ingest went
// straight from "no OpenAI key" to the Python CLI, with no whisper.cpp tier at
// all. On a machine where whisper.cpp is the only installed engine, IntelLedger
// therefore failed (or reached for a cloud API) while the app reported local STT
// as ready. That contradicts the local-first promise, so the tier belongs in one
// place that every caller uses.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

import { commandExists, runCommand } from './proc.js';

// whisper.cpp ships its CLI under a few names across versions and distros.
export const WHISPER_CPP_BINARIES = ['whisper-cli', 'whisper-cpp', 'main'];

export const WHISPER_MODEL_CATALOG = [
  { id: 'base.en', label: 'Base English (fast, ~142MB)', sizeMb: 142, url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' },
  { id: 'small.en', label: 'Small English (more accurate, ~466MB)', sizeMb: 466, url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin' }
];

export function getWhisperModelsDir() {
  if (process.platform === 'darwin') {
    return join(os.homedir(), 'Library', 'Application Support', 'whisper', 'models');
  }
  return join(os.homedir(), '.local', 'share', 'whisper', 'models');
}

export function getInstalledWhisperModelIds() {
  const dir = getWhisperModelsDir();
  return WHISPER_MODEL_CATALOG
    .filter((m) => existsSync(join(dir, `ggml-${m.id}.bin`)))
    .map((m) => m.id);
}

/** Path to a usable whisper.cpp binary, or null. */
export async function resolveWhisperCppBinary() {
  const override = process.env.WHISPER_CPP_BINARY;
  if (override) {
    const ok = override.includes('/') ? existsSync(override) : await commandExists(override);
    return ok ? override : null;
  }
  for (const cand of WHISPER_CPP_BINARIES) {
    if (await commandExists(cand)) return cand;
  }
  return null;
}

/** Path to a downloaded ggml model, or null. */
export function resolveWhisperCppModel() {
  const override = process.env.WHISPER_CPP_MODEL;
  if (override && existsSync(override)) return override;
  const dir = getWhisperModelsDir();
  for (const m of WHISPER_MODEL_CATALOG) {
    const p = join(dir, `ggml-${m.id}.bin`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Strip whisper.cpp non-speech markers like [BLANK_AUDIO], (music), [ Silence ]. */
export function cleanTranscript(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:blank audio|music|silence|inaudible|noise)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Transcribe a 16kHz mono WAV with whisper.cpp. Returns cleaned text.
 * @param {{wavPath: string, binary: string, model: string, outStem: string, timeoutMs?: number}} args
 */
export async function transcribeWithWhisperCpp({ wavPath, binary, model, outStem, timeoutMs = 1000 * 60 * 5 }) {
  // whisper-cli writes <outStem>.txt with -otxt/-of; -nt strips timestamps.
  await runCommand(binary, [
    '-m', model,
    '-f', wavPath,
    '-otxt',
    '-of', outStem,
    '-nt'
  ], { timeoutMs });
  const txt = await readFile(`${outStem}.txt`, 'utf8').catch(() => '');
  return cleanTranscript(txt);
}

/** Is a complete whisper.cpp setup (binary AND model) available right now? */
export async function whisperCppAvailable() {
  const binary = await resolveWhisperCppBinary();
  if (!binary) return null;
  const model = resolveWhisperCppModel();
  if (!model) return null;
  return { binary, model };
}
