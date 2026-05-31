// frontend/src/lib/sounds.js
// Tiny Web Audio engine — synthesized tones, no copyrighted assets.
// The iconic two-tone "message received" nod to ICQ, plus subtle send /
// presence / error cues. Respects a global mute and prefers-reduced-motion.

import { safeStorageGet, safeStorageSet } from './storage';

const MUTE_KEY = 'mirabilis-sound-muted';

let ctx = null;
function audio() {
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

export function isMuted() {
  return safeStorageGet(MUTE_KEY, '0') === '1';
}
export function setMuted(muted) {
  safeStorageSet(MUTE_KEY, muted ? '1' : '0');
}
export function toggleMuted() {
  const next = !isMuted();
  setMuted(next);
  return next;
}

function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// Play a short tone. freq in Hz, dur in seconds.
function tone(ac, freq, start, dur, { type = 'sine', gain = 0.12 } = {}) {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function guard() {
  if (isMuted() || reducedMotion()) return null;
  return audio();
}

// The "uh-oh" two-tone receive cue: a quick down-up motif.
export function playReceive() {
  const ac = guard();
  if (!ac) return;
  const t = ac.currentTime;
  tone(ac, 660, t, 0.12, { type: 'triangle', gain: 0.14 });
  tone(ac, 990, t + 0.13, 0.16, { type: 'triangle', gain: 0.14 });
}

export function playSend() {
  const ac = guard();
  if (!ac) return;
  const t = ac.currentTime;
  tone(ac, 880, t, 0.07, { type: 'sine', gain: 0.07 });
}

export function playOnline() {
  const ac = guard();
  if (!ac) return;
  const t = ac.currentTime;
  tone(ac, 523.25, t, 0.08, { type: 'sine', gain: 0.06 });
  tone(ac, 783.99, t + 0.08, 0.1, { type: 'sine', gain: 0.06 });
}

export function playError() {
  const ac = guard();
  if (!ac) return;
  const t = ac.currentTime;
  tone(ac, 330, t, 0.18, { type: 'sawtooth', gain: 0.06 });
  tone(ac, 247, t + 0.12, 0.2, { type: 'sawtooth', gain: 0.06 });
}
