// frontend/src/components/shell/Toaster.jsx
'use client';

import { appStore, useAppStore } from '../../store/useAppStore';

export default function Toaster() {
  const toasts = useAppStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-12 left-1/2 z-[120] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => appStore.dismissToast(t.id)}
          className="au-pop au-chrome au-hairline au-elev-3 pointer-events-auto flex items-center gap-2 rounded-[var(--r-pill)] px-4 py-2 text-[length:var(--text-xs)] font-medium text-[color:var(--text-main)]"
        >
          {t.kind === 'error' ? '⚠️' : t.kind === 'success' ? '✓' : '🌼'} {t.message}
        </button>
      ))}
    </div>
  );
}
