// frontend/src/components/shell/AuroraChrome.jsx
// The Aurora shell chrome: floating dock, command palette, omni-search, buddy
// list, toasts, and the footer - layered over the existing app so every screen
// gains the Fusion experience without fighting ChatApp's full-screen layout.
'use client';

import { useEffect, useState } from 'react';
import Dock from './Dock';
import BuddyList from './BuddyList';
import HomelabRoster from './HomelabRoster';
import WatchedWorkspace from './WatchedWorkspace';
import CommandPalette from './CommandPalette';
import OmniSearch from './OmniSearch';
import RecallOrb from './RecallOrb';
import WhileYouWereAway from './WhileYouWereAway';
import Toaster from './Toaster';
import usePresence from './usePresence';
import { appStore, useAppStore } from '../../store/useAppStore';
import { applyTheme, watchSystemTheme } from '../../lib/theme';

export default function AuroraChrome({ activeTab, onTab }) {
  const [streaming, setStreaming] = useState(false);
  const [searching, setSearching] = useState(false);
  const { map: presence, warm, orbState } = usePresence({ streaming });
  const commandOpen = useAppStore((s) => s.commandOpen);
  const searchOpen = useAppStore((s) => s.searchOpen);
  const buddyOpen = useAppStore((s) => s.buddyOpen);
  const recallOpen = useAppStore((s) => s.recallOpen);
  const homelabOpen = useAppStore((s) => s.homelabOpen);
  const workspaceOpen = useAppStore((s) => s.workspaceOpen);
  const wywaOpen = useAppStore((s) => s.wywaOpen);

  // Apply persisted theme on mount + follow OS theme changes in system mode.
  useEffect(() => {
    applyTheme();
    return watchSystemTheme();
  }, []);

  // Global keyboard: ⌘K / Ctrl-K command palette, ⌘/ search.
  useEffect(() => {
    function onKey(e) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        appStore.toggleCommand();
      } else if (meta && e.key === '/') {
        e.preventDefault();
        appStore.toggleSearch();
      }
    }
    const openCmd = () => appStore.openCommand();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mirabilis:open-command', openCmd);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mirabilis:open-command', openCmd);
    };
  }, []);

  // Let ChatApp drive the orb's "busy" state when it starts/stops streaming,
  // and the ICQ "searching" spin while a web search is running.
  useEffect(() => {
    const start = () => setStreaming(true);
    const stop = () => setStreaming(false);
    const searchStart = () => setSearching(true);
    const searchStop = () => setSearching(false);
    window.addEventListener('mirabilis:stream-start', start);
    window.addEventListener('mirabilis:stream-stop', stop);
    window.addEventListener('mirabilis:search-start', searchStart);
    window.addEventListener('mirabilis:search-stop', searchStop);
    return () => {
      window.removeEventListener('mirabilis:stream-start', start);
      window.removeEventListener('mirabilis:stream-stop', stop);
      window.removeEventListener('mirabilis:search-start', searchStart);
      window.removeEventListener('mirabilis:search-stop', searchStop);
    };
  }, []);

  function handlePickProvider(p) {
    onTab?.('chat');
    appStore.setBuddyOpen(false);
    try {
      window.dispatchEvent(new CustomEvent('mirabilis:set-provider', { detail: { provider: p.id } }));
    } catch {
      /* ignore */
    }
    appStore.toast(`Switched to ${p.label}`, { kind: 'success' });
  }

  return (
    <>
      <Dock orbState={orbState} spinning={searching} />

      <BuddyList open={buddyOpen} presence={presence} warm={warm} />
      <HomelabRoster open={homelabOpen} />
      <WatchedWorkspace open={workspaceOpen} />
      <CommandPalette open={commandOpen} onTab={onTab} />
      <OmniSearch open={searchOpen} presence={presence} onTab={onTab} onPickProvider={handlePickProvider} />
      <RecallOrb open={recallOpen} onTab={onTab} />
      <WhileYouWereAway open={wywaOpen} />
      <Toaster />
    </>
  );
}
