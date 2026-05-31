// frontend/src/store/useAppStore.js
// Tiny zero-dependency global store (useSyncExternalStore). Holds transient
// shell UI state: which overlays are open + a toast queue. Theme and sound
// preferences have their own modules (lib/theme, lib/sounds).

import { useSyncExternalStore } from 'react';

let state = {
  commandOpen: false,
  searchOpen: false,
  buddyOpen: false,
  toasts: []
};

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
  closeAll() {
    state.commandOpen = false;
    state.searchOpen = false;
    state.buddyOpen = false;
    emit();
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
