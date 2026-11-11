// ICQ-style provider list on a vibrancy sheet, grouped Local/Cloud with live presence.
'use client';

import { useEffect, useMemo } from 'react';
import { PROVIDERS } from '../../lib/presence';
import { Panel, IconButton, CloseIcon } from '../ui/primitives';
import ContactRow from '../ui/ContactRow';
import { appStore } from '../../store/useAppStore';

function warmLabelFor(providerId, warm) {
  if (providerId !== 'ollama' || !Array.isArray(warm) || warm.length === 0) return undefined;
  if (warm.length === 1) return `${warm[0]} warm`;
  return `${warm.length} models warm`;
}

function Group({ title, providers, presence, warm }) {
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
            warmLabel={warmLabelFor(p.id, warm)}
          />
        ))}
      </div>
    </div>
  );
}

export default function BuddyList({ open, presence, warm = [] }) {
  const local = useMemo(() => PROVIDERS.filter((p) => p.scope === 'local'), []);
  const remote = useMemo(() => PROVIDERS.filter((p) => p.scope === 'remote'), []);

  const counts = useMemo(() => {
    const vals = Object.values(presence || {});
    return {
      online: vals.filter((v) => v === 'online').length,
      total: PROVIDERS.length
    };
  }, [presence]);

  // Esc closes the sheet, matching CommandPalette/OmniSearch (which get it from Modal).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') appStore.setBuddyOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

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
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--hairline)' }}>
          <div className="flex flex-col">
            <span className="text-[length:var(--text-md)] font-semibold text-[color:var(--text-main)]">Buddy list</span>
            <span className="text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
              {counts.online} of {counts.total} online
            </span>
          </div>
          <IconButton label="Close" onClick={() => appStore.setBuddyOpen(false)}><CloseIcon size={14} /></IconButton>
        </div>
        <div className="au-scroll flex-1 overflow-y-auto p-1.5">
          <Group title="Local" providers={local} presence={presence} warm={warm} />
          <Group title="Cloud" providers={remote} presence={presence} />
        </div>
      </Panel>
    </div>
  );
}
