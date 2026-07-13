// frontend/src/components/ui/ContactRow.jsx
// A single "buddy" row in the Buddy List - provider name, presence, meta.
'use client';

import { PresenceDot, Badge } from './primitives';
import { PRESENCE_LABELS } from '../../lib/presence';

export default function ContactRow({ provider, presence = 'unknown', modelCount, warmLabel, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="au-focus group flex w-full items-center gap-2.5 rounded-[var(--r-md)] px-2.5 py-2 text-left transition hover:bg-[color:var(--hairline)]"
    >
      <PresenceDot presence={presence === 'unknown' ? 'offline' : presence} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]">
            {provider.label}
          </span>
          <Badge tone="neutral" className="opacity-70">
            {provider.scope}
          </Badge>
        </span>
        <span className="truncate text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
          {PRESENCE_LABELS[presence] || 'Checking…'}
          {typeof modelCount === 'number' && modelCount > 0 ? ` · ${modelCount} models` : ''}
          {warmLabel ? (
            <span className="text-emerald-600 dark:text-emerald-300">{` · ${warmLabel}`}</span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
