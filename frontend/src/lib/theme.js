// frontend/src/lib/theme.js
// Shared theme module. Uses the EXACT localStorage keys + DOM mutations that
// ChatApp.jsx already uses, so the shell and the chat view stay in sync
// (ChatApp hydrates these keys on mount; we apply live on change).
//
//   mode   -> 'local-ai-theme-mode'   : 'light' | 'dark' | 'auto'
//   scheme -> 'mirabilis-color-scheme': 'mirabilis' | 'arctic' | 'ember' | 'summit'
//   font   -> 'mirabilis-font'        : 'jakarta' | 'system' | 'tahoma'

import { safeStorageGet, safeStorageSet } from './storage';

export const THEME_KEY = 'local-ai-theme-mode';
export const SCHEME_KEY = 'mirabilis-color-scheme';
export const FONT_KEY = 'mirabilis-font';

export const MODES = ['light', 'dark', 'auto'];
export const SCHEMES = ['mirabilis', 'arctic', 'ember', 'summit'];
export const FONTS = ['jakarta', 'system', 'tahoma'];

export const SCHEME_META = {
  mirabilis: { label: 'Mirabilis', swatch: '#1aa86f' },
  arctic: { label: 'Arctic', swatch: '#0ea5e9' },
  ember: { label: 'Ember', swatch: '#c2710c' },
  summit: { label: 'Summit', swatch: '#007aff' }
};

export const FONT_META = {
  jakarta: 'Jakarta',
  system: 'System',
  tahoma: 'Tahoma'
};

function prefersDark() {
  if (typeof window === 'undefined') return false;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function getMode() {
  const v = safeStorageGet(THEME_KEY, 'auto');
  return MODES.includes(v) ? v : 'auto';
}
export function getScheme() {
  const v = safeStorageGet(SCHEME_KEY, 'mirabilis');
  return SCHEMES.includes(v) ? v : 'mirabilis';
}
export function getFont() {
  const v = safeStorageGet(FONT_KEY, 'jakarta');
  return FONTS.includes(v) ? v : 'jakarta';
}

export function isDarkActive() {
  const mode = getMode();
  return mode === 'dark' || (mode === 'auto' && prefersDark());
}

// Apply current stored values to <html>. Idempotent — safe to call anytime.
// Mirrors ChatApp: scheme 'mirabilis' and font 'jakarta' clear the attribute.
export function applyTheme() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', isDarkActive());
  const scheme = getScheme();
  if (scheme === 'mirabilis') root.removeAttribute('data-color-scheme');
  else root.setAttribute('data-color-scheme', scheme);
  const font = getFont();
  if (font === 'jakarta') root.removeAttribute('data-font');
  else root.setAttribute('data-font', font);
}

export function setMode(mode) {
  if (!MODES.includes(mode)) return;
  safeStorageSet(THEME_KEY, mode);
  applyTheme();
  notify();
}
export function cycleMode() {
  const order = ['light', 'dark', 'auto'];
  const next = order[(order.indexOf(getMode()) + 1) % order.length];
  setMode(next);
  return next;
}
export function setScheme(scheme) {
  if (!SCHEMES.includes(scheme)) return;
  safeStorageSet(SCHEME_KEY, scheme);
  applyTheme();
  notify();
}
export function setFont(font) {
  if (!FONTS.includes(font)) return;
  safeStorageSet(FONT_KEY, font);
  applyTheme();
  notify();
}

// Lightweight subscription so shell controls re-render on theme change.
const listeners = new Set();
function notify() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}
export function subscribeTheme(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Keep dark class correct when the OS theme flips while in 'auto' mode.
export function watchSystemTheme() {
  if (typeof window === 'undefined') return () => {};
  let mq;
  try {
    mq = window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return () => {};
  }
  const handler = () => {
    if (getMode() === 'auto') {
      applyTheme();
      notify();
    }
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
