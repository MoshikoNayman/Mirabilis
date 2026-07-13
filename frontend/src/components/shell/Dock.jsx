// frontend/src/components/shell/Dock.jsx
// The floating control cluster (top-right). Replaces the old tab pill with a
// richer dock: StatusOrb (buddy list), tab switcher, search, and an appearance
// menu. Apple vibrancy + ICQ presence in one compact surface.
'use client';

import { useEffect, useRef, useState } from 'react';
import StatusOrb from '../ui/StatusOrb';
import { SegmentedControl, IconButton, Panel } from '../ui/primitives';
import { appStore } from '../../store/useAppStore';
import {
  SCHEMES, SCHEME_META, FONTS, FONT_META, MODES,
  setScheme, setFont, setMode, getMode, getScheme, getFont, subscribeTheme
} from '../../lib/theme';
import { isMuted, toggleMuted } from '../../lib/sounds';

function useThemeTick() {
  const [, force] = useState(0);
  useEffect(() => subscribeTheme(() => force((n) => n + 1)), []);
}

function AppearanceMenu({ onClose }) {
  useThemeTick();
  const ref = useRef(null);
  const [muted, setMutedState] = useState(isMuted());

  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  return (
    <Panel
      ref={ref}
      material="chrome"
      className="au-pop absolute right-0 top-11 w-[260px] p-3"
      role="menu"
    >
      <Label>Appearance</Label>
      <div className="mb-3 flex gap-1">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`au-focus flex-1 rounded-[var(--r-sm)] px-2 py-1.5 text-[length:var(--text-2xs)] font-medium capitalize transition ${
              getMode() === m ? 'text-white' : 'au-hairline text-[color:var(--text-muted)]'
            }`}
            style={getMode() === m ? { background: 'var(--accent)' } : undefined}
          >
            {m}
          </button>
        ))}
      </div>

      <Label>Palette</Label>
      <div className="mb-3 grid grid-cols-2 gap-1.5">
        {SCHEMES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScheme(s)}
            className={`au-focus flex items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-[length:var(--text-2xs)] font-medium transition ${
              getScheme() === s ? 'au-hairline bg-[color:var(--hairline)]' : 'hover:bg-[color:var(--hairline)]'
            }`}
          >
            <span className="h-3 w-3 rounded-full" style={{ background: SCHEME_META[s].swatch }} />
            {SCHEME_META[s].label}
          </button>
        ))}
      </div>

      <Label>Font</Label>
      <div className="mb-3 flex gap-1">
        {FONTS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFont(f)}
            className={`au-focus flex-1 rounded-[var(--r-sm)] px-2 py-1.5 text-[length:var(--text-2xs)] font-medium transition ${
              getFont() === f ? 'text-white' : 'au-hairline text-[color:var(--text-muted)]'
            }`}
            style={getFont() === f ? { background: 'var(--accent)' } : undefined}
          >
            {FONT_META[f]}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setMutedState(toggleMuted())}
        className="au-focus flex w-full items-center justify-between rounded-[var(--r-sm)] px-2 py-2 text-[length:var(--text-xs)] font-medium text-[color:var(--text-main)] hover:bg-[color:var(--hairline)]"
      >
        <span>Sounds</span>
        <span className="text-[color:var(--text-muted)]">{muted ? '🔕 Off' : '🔔 On'}</span>
      </button>
    </Panel>
  );
}

function Label({ children }) {
  return (
    <div className="mb-1.5 text-[length:var(--text-2xs)] font-medium uppercase tracking-wide text-[color:var(--text-muted)]">
      {children}
    </div>
  );
}

export default function Dock({ activeTab, onTab, orbState, spinning = false }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="fixed right-3 top-3 z-[80]">
      <Panel material="chrome" className="flex items-center gap-1.5 rounded-[var(--r-pill)] p-1.5">
        <StatusOrb state={orbState} size={32} spinning={spinning} onClick={() => appStore.toggleBuddy()} />

        <SegmentedControl
          size="sm"
          value={activeTab === 'intel' ? 'intel' : 'chat'}
          onChange={(v) => onTab?.(v)}
          options={[
            { value: 'chat', label: 'Chat' },
            { value: 'intel', label: 'Ledger' }
          ]}
        />

        <IconButton label="Search (⌘/)" onClick={() => appStore.openSearch()}>🔍</IconButton>

        <IconButton label="Commands (⌘K)" onClick={() => appStore.openCommand()}>⌘</IconButton>

        <div className="relative">
          <IconButton label="Appearance" onClick={() => setMenuOpen((v) => !v)}>◐</IconButton>
          {menuOpen ? <AppearanceMenu onClose={() => setMenuOpen(false)} /> : null}
        </div>
      </Panel>
    </div>
  );
}
