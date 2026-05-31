// frontend/src/lib/storage.js
// Single source of truth for localStorage access. Replaces the duplicated
// safeStorage*/readJson helpers that were copy-pasted across ChatApp,
// MirabilisApp and IntelLedgerSession.

export function safeStorageGet(key, fallback = null) {
  try {
    if (typeof window === 'undefined') return fallback;
    const value = window.localStorage.getItem(key);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export function safeStorageSet(key, value) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable (private mode, quota) — fail silently */
  }
}

export function safeStorageRemove(key) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function readJson(key, fallback) {
  const raw = safeStorageGet(key, null);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  try {
    safeStorageSet(key, JSON.stringify(value));
  } catch {
    /* ignore serialization/storage failures */
  }
}
