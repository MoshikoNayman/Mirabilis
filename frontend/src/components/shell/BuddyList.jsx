// frontend/src/components/shell/BuddyList.jsx
// The ICQ-style contact list, reimagined as an Apple vibrancy sheet. Providers
// are "buddies" grouped by Local / Remote with live presence.
'use client';

import { useMemo } from 'react';
import { PROVIDERS } from '../../lib/presence';
import { Panel, PresenceDot, IconButton } from '../ui/primitives';
import ContactRow from '../ui/ContactRow';
import { appStore } from '../../store/useAppStore';

function Group({ title, providers, presence, onPick }) {
  if (!providers.length) return null;
  return (
    <div className="mb-2">
      <div className="px-2.5 pb-1 pt-2 text-[length:var(--text-2xs)] font-medium uppercase tracking-wide text-[color:var(--text-muted)]">
        {title}
      </div>
      <div className="flex flex-col">
        {providers.map((p) => (
          <ContactRow
            key={p.id}
            provider={p}
            presence={presence[p.id] || 'unknown'}
            onClick={() => onPick?.(p)}
          />
        ))}
      </div>
    </div>
  );
}

export default function BuddyList({ open, presence, onPick }) {
  const local = useMemo(() => PROVIDERS.filter((p) => p.scope === 'local'), []);
  const remote = useMemo(() => PROVIDERS.filter((p) => p.scope === 'remote'), []);

  const counts = useMemo(() => {
    const vals = Object.values(presence || {});
    return {
      online: vals.filter((v) => v === 'online').length,
      total: PROVIDERS.length
    };
  }, [presence]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90]">
      <div className="au-backdrop absolute inset-0" onClick={() => appStore.setBuddyOpen(false)} aria-hidden="true" />
      <Panel
        material="chrome"
        className="au-enter absolute right-3 top-16 flex max-h-[78vh] w-[320px] flex-col overflow-hidden"
        role="dialog"
        aria-label="Buddy list"
      >
        <div className="flex items-center justify-between border-b px-3.5 py-3" style={{ borderColor: 'var(--hairline)' }}>
          <div className="flex flex-col">
            <span className="text-[length:var(--text-md)] font-semibold text-[color:var(--text-main)]">Buddies</span>
            <span className="text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
              {counts.online} of {counts.total} online
            </span>
          </div>
          <IconButton label="Close" onClick={() => appStore.setBuddyOpen(false)}>✕</IconButton>
        </div>
        <div className="au-scroll flex-1 overflow-y-auto p-1.5">
          <Group title="On this Mac" providers={local} presence={presence} onPick={onPick} />
          <Group title="Cloud providers" providers={remote} presence={presence} onPick={onPick} />
        </div>
        <div className="flex items-center gap-2 border-t px-3.5 py-2.5 text-[length:var(--text-2xs)] text-[color:var(--text-muted)]" style={{ borderColor: 'var(--hairline)' }}>
          <span className="flex items-center gap-1"><PresenceDot presence="online" /> online</span>
          <span className="flex items-center gap-1"><PresenceDot presence="needkey" /> needs key</span>
          <span className="flex items-center gap-1"><PresenceDot presence="offline" /> offline</span>
        </div>
      </Panel>
    </div>
  );
}
