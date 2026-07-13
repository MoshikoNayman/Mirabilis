// frontend/src/components/shell/Dock.jsx
// The floating control cluster (top-right), kept deliberately minimal in the ICQ
// spirit: just the presence orb and one "..." menu that holds every secondary
// control (search, recall, homelab, commands, off-the-record, go dark, and
// appearance). The Chat / Ledger switch lives next to the wordmark instead.
'use client';

import { useEffect, useRef, useState } from 'react';
import StatusOrb from '../ui/StatusOrb';
import {
  IconButton, Panel, MenuDotsIcon, SearchIcon, RecallIcon, ServerIcon,
  CommandIcon, MoonIcon, IncognitoIcon, BellIcon, FolderIcon
} from '../ui/primitives';
import { appStore, useAppStore } from '../../store/useAppStore';
import {
  SCHEMES, SCHEME_META, FONTS, FONT_META, MODES,
  setScheme, setFont, setMode, getMode, getScheme, getFont, subscribeTheme
} from '../../lib/theme';
import { isMuted, toggleMuted } from '../../lib/sounds';

function useThemeTick() {
  const [, force] = useState(0);
  useEffect(() => subscribeTheme(() => force((n) => n + 1)), []);
}

function Label({ children }) {
  return (
    <div className="mb-1.5 mt-1 px-1 text-[length:var(--text-2xs)] font-medium uppercase tracking-wide text-[color:var(--text-muted)]">
      {children}
    </div>
  );
}

function MenuRow({ icon, label, onClick, right }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="au-focus flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-2.5 py-2 text-[length:var(--text-xs)] font-medium text-[color:var(--text-main)] transition hover:bg-[color:var(--hairline)]"
      role="menuitem"
    >
      <span className="flex h-4 w-4 items-center justify-center text-[color:var(--text-muted)]">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {right}
    </button>
  );
}

function Divider() {
  return <div className="my-1 border-t" style={{ borderColor: 'var(--hairline)' }} />;
}

function ControlMenu({ onClose }) {
  useThemeTick();
  const ref = useRef(null);
  const goDark = useAppStore((s) => s.goDark);
  const [muted, setMutedState] = useState(isMuted());

  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  const act = (fn) => () => { onClose(); fn(); };

  return (
    <Panel ref={ref} material="chrome" className="au-pop absolute right-0 top-11 w-[252px] p-1.5" role="menu">
      <MenuRow icon={<SearchIcon size={15} />} label="Search" onClick={act(() => appStore.openSearch())} />
      <MenuRow icon={<BellIcon size={15} />} label="While you were away" onClick={act(() => appStore.openWywa())} />
      <MenuRow icon={<RecallIcon size={15} />} label="Recall" onClick={act(() => appStore.openRecall())} />
      <MenuRow icon={<ServerIcon size={15} />} label="Homelab" onClick={act(() => appStore.openHomelab())} />
      <MenuRow icon={<FolderIcon size={15} />} label="Workspace" onClick={act(() => appStore.openWorkspace())} />
      <MenuRow icon={<CommandIcon size={15} />} label="Commands" onClick={act(() => appStore.openCommand())} />
      <MenuRow
        icon={<IncognitoIcon size={15} />}
        label="Off the Record"
        onClick={act(() => {
          try { window.dispatchEvent(new CustomEvent('mirabilis:set-tab', { detail: { tab: 'chat' } })); } catch { /* ignore */ }
          setTimeout(() => {
            try { window.dispatchEvent(new CustomEvent('mirabilis:new-ephemeral-chat')); } catch { /* ignore */ }
          }, 60);
        })}
      />

      <Divider />

      <MenuRow
        icon={<MoonIcon size={15} filled={goDark} />}
        label="Go Dark"
        onClick={() => {
          const on = appStore.toggleGoDark();
          appStore.toast(on ? 'Go Dark on - local models only, nothing leaves this machine' : 'Go Dark off - cloud providers allowed again', { kind: on ? 'success' : 'info' });
        }}
        right={(
          <span
            className={`rounded-full px-1.5 py-0.5 text-[length:var(--text-2xs)] font-medium ${goDark ? 'text-white' : 'au-hairline text-[color:var(--text-muted)]'}`}
            style={goDark ? { background: 'var(--accent)' } : undefined}
          >
            {goDark ? 'On' : 'Off'}
          </span>
        )}
      />

      <Divider />

      <Label>Appearance</Label>
      <div className="mb-2 flex gap-1 px-1">
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
      <div className="mb-2 grid grid-cols-2 gap-1 px-1">
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
      <div className="mb-1 flex gap-1 px-1">
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
        className="au-focus flex w-full items-center justify-between rounded-[var(--r-sm)] px-2.5 py-2 text-[length:var(--text-xs)] font-medium text-[color:var(--text-main)] hover:bg-[color:var(--hairline)]"
      >
        <span>Sounds</span>
        <span className="text-[color:var(--text-muted)]">{muted ? 'Off' : 'On'}</span>
      </button>
    </Panel>
  );
}

export default function Dock({ orbState, spinning = false }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="fixed right-3 top-3 z-[80]">
      <Panel material="chrome" className="flex items-center gap-1.5 rounded-[var(--r-pill)] p-1.5">
        <StatusOrb state={orbState} size={32} spinning={spinning} onClick={() => appStore.toggleBuddy()} />

        <div className="relative">
          <IconButton label="Menu" onClick={() => setMenuOpen((v) => !v)}><MenuDotsIcon /></IconButton>
          {menuOpen ? <ControlMenu onClose={() => setMenuOpen(false)} /> : null}
        </div>
      </Panel>
    </div>
  );
}
