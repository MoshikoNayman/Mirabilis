// Zero-dependency store on useSyncExternalStore for transient shell UI state:
// open overlays, workspace pins, Go Dark and the toast queue.

import { useSyncExternalStore } from 'react';
import { normalizeAccess } from '../lib/access';

const GO_DARK_KEY = 'mirabilis-go-dark';
const WS_PINS_KEY = 'mirabilis-workspace-pins';
const WS_ROOT_KEY = 'mirabilis-workspace-root';

function readGoDark() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(GO_DARK_KEY) === '1';
  } catch {
    return false;
  }
}

function readWorkspacePins() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(WS_PINS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function readWorkspaceRoot() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(WS_ROOT_KEY) || '';
  } catch {
    return '';
  }
}

let state = {
  commandOpen: false,
  searchOpen: false,
  buddyOpen: false,
  recallOpen: false,
  voiceChatOpen: false,
  homelabOpen: false,
  wywaOpen: false,
  workspaceOpen: false,
  // Watched folder and pinned relative paths, persisted to localStorage. ChatApp
  // folds the pinned files' current contents into each outbound message.
  workspaceRoot: readWorkspaceRoot(),
  workspacePins: readWorkspacePins(),
  // Go Dark: the UI blocks remote providers and every request is flagged
  // local-only so the backend refuses egress.
  goDark: readGoDark(),
  // Settings sheet; ChatApp renders it so the Dock and the shortcut can open it anywhere.
  settingsOpen: false,
  settingsSection: 'access',
  // Copy of the backend Access level for the composer chip; the backend decides.
  access: 'chat',
  toasts: []
};

// The desktop updater runs outside the backend and checks for updates only
// after this reports that Go Dark is off.
function reportLocalOnly(on) {
  if (typeof window === 'undefined') return;
  try { window.electron?.setLocalOnly?.(on === true); } catch { /* not the desktop app */ }
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

/** Tell the backend, which enforces Go Dark for every outbound call. */
async function pushGoDark(on) {
  try {
    await fetch(`${API_BASE}/api/go-dark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: on === true })
    });
  } catch { /* backend not up yet: publishGoDark reconciles on next load */ }
}

/**
 * Reconcile with the backend on load, then tell the desktop shell.
 * If either side says on, it is on: an unreachable backend must not turn it off.
 */
export async function publishGoDark() {
  let backendOn = null;
  try {
    const res = await fetch(`${API_BASE}/api/go-dark`);
    if (res.ok) backendOn = (await res.json())?.on === true;
  } catch { /* backend not reachable */ }
  const on = state.goDark || backendOn === true;
  if (on !== state.goDark) appStore.setGoDark(on, { sync: false });
  if (backendOn !== null && backendOn !== on) await pushGoDark(on);
  reportLocalOnly(state.goDark);
}

const listeners = new Set();

function emit() {
  state = { ...state };
  listeners.forEach((l) => l());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return state;
}

let toastId = 0;

export const appStore = {
  openCommand() {
    state.commandOpen = true;
    state.searchOpen = false;
    emit();
  },
  closeCommand() {
    state.commandOpen = false;
    emit();
  },
  toggleCommand() {
    state.commandOpen = !state.commandOpen;
    if (state.commandOpen) state.searchOpen = false;
    emit();
  },
  openSearch() {
    state.searchOpen = true;
    state.commandOpen = false;
    emit();
  },
  closeSearch() {
    state.searchOpen = false;
    emit();
  },
  toggleSearch() {
    state.searchOpen = !state.searchOpen;
    if (state.searchOpen) state.commandOpen = false;
    emit();
  },
  setBuddyOpen(open) {
    state.buddyOpen = open;
    emit();
  },
  toggleBuddy() {
    state.buddyOpen = !state.buddyOpen;
    emit();
  },
  openRecall() {
    state.recallOpen = true;
    state.commandOpen = false;
    state.searchOpen = false;
    emit();
  },
  closeRecall() {
    state.recallOpen = false;
    emit();
  },
  toggleRecall() {
    state.recallOpen = !state.recallOpen;
    if (state.recallOpen) {
      state.commandOpen = false;
      state.searchOpen = false;
    }
    emit();
  },
  openVoiceChat() {
    state.voiceChatOpen = true;
    state.commandOpen = false;
    state.searchOpen = false;
    emit();
  },
  closeVoiceChat() {
    state.voiceChatOpen = false;
    emit();
  },
  toggleVoiceChat() {
    state.voiceChatOpen = !state.voiceChatOpen;
    if (state.voiceChatOpen) {
      state.commandOpen = false;
      state.searchOpen = false;
    }
    emit();
  },
  openHomelab() {
    state.homelabOpen = true;
    state.commandOpen = false;
    state.searchOpen = false;
    emit();
  },
  closeHomelab() {
    state.homelabOpen = false;
    emit();
  },
  toggleHomelab() {
    state.homelabOpen = !state.homelabOpen;
    if (state.homelabOpen) {
      state.commandOpen = false;
      state.searchOpen = false;
    }
    emit();
  },
  openWywa() {
    state.wywaOpen = true;
    state.commandOpen = false;
    state.searchOpen = false;
    emit();
  },
  closeWywa() {
    state.wywaOpen = false;
    emit();
  },
  toggleWywa() {
    state.wywaOpen = !state.wywaOpen;
    if (state.wywaOpen) {
      state.commandOpen = false;
      state.searchOpen = false;
    }
    emit();
  },
  openWorkspace() {
    state.workspaceOpen = true;
    state.commandOpen = false;
    state.searchOpen = false;
    emit();
  },
  closeWorkspace() {
    state.workspaceOpen = false;
    emit();
  },
  toggleWorkspace() {
    state.workspaceOpen = !state.workspaceOpen;
    if (state.workspaceOpen) {
      state.commandOpen = false;
      state.searchOpen = false;
    }
    emit();
  },
  setWorkspaceRoot(root) {
    state.workspaceRoot = root || '';
    if (typeof window !== 'undefined') {
      try {
        if (root) window.localStorage.setItem(WS_ROOT_KEY, root);
        else window.localStorage.removeItem(WS_ROOT_KEY);
      } catch { /* ignore */ }
    }
    emit();
  },
  setWorkspacePins(pins) {
    const next = Array.isArray(pins) ? pins.filter((p) => typeof p === 'string') : [];
    state.workspacePins = next;
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(WS_PINS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    }
    emit();
  },
  getWorkspacePins() {
    return state.workspacePins;
  },
  getWorkspaceRoot() {
    return state.workspaceRoot;
  },
  openSettings(section = 'access') {
    state.settingsOpen = true;
    state.settingsSection = typeof section === 'string' && section ? section : 'access';
    state.commandOpen = false;
    state.searchOpen = false;
    emit();
  },
  closeSettings() {
    state.settingsOpen = false;
    emit();
  },
  setAccess(level) {
    state.access = normalizeAccess(level);
    emit();
  },
  getAccess() {
    return state.access;
  },
  closeAll() {
    state.commandOpen = false;
    state.searchOpen = false;
    state.buddyOpen = false;
    state.recallOpen = false;
    state.voiceChatOpen = false;
    state.homelabOpen = false;
    state.wywaOpen = false;
    state.workspaceOpen = false;
    emit();
  },
  setGoDark(on, { sync = true } = {}) {
    state.goDark = !!on;
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(GO_DARK_KEY, on ? '1' : '0'); } catch { /* ignore */ }
    }
    if (sync) void pushGoDark(state.goDark);
    reportLocalOnly(state.goDark);
    emit();
  },
  toggleGoDark() {
    appStore.setGoDark(!state.goDark);
    return state.goDark;
  },
  getGoDark() {
    return state.goDark;
  },
  toast(message, { kind = 'info', ttl = 3200 } = {}) {
    const id = ++toastId;
    state.toasts = [...state.toasts, { id, message, kind }];
    emit();
    if (ttl) {
      setTimeout(() => appStore.dismissToast(id), ttl);
    }
    return id;
  },
  dismissToast(id) {
    state.toasts = state.toasts.filter((t) => t.id !== id);
    emit();
  }
};

export function useAppStore(selector = (s) => s) {
  return useSyncExternalStore(
    subscribe,
    () => selector(getSnapshot()),
    () => selector(getSnapshot())
  );
}
