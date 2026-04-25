// Reusable inline help trigger with contextual popover copy.

'use client';

import { useEffect, useRef, useState } from 'react';

export default function InfoHint({ title, description, points = [], triggerClassName = '' }) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        className={`rounded-full border border-black/10 bg-white/70 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-600 transition hover:border-accent/40 hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 dark:border-white/10 dark:bg-slate-900/50 dark:text-slate-300 ${triggerClassName}`}
        aria-label="How it works"
        aria-expanded={isOpen}
        title="How it works"
        onClick={() => setIsOpen((open) => !open)}
      >
        Guide
      </button>

      <div
        className={`absolute left-0 top-[calc(100%+6px)] z-30 w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl border border-black/10 bg-white/95 p-3 text-left shadow-[0_18px_45px_-22px_rgba(15,23,42,0.65)] transition duration-200 dark:border-white/15 dark:bg-slate-900/95 ${
          isOpen ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-1 opacity-0'
        }`}
      >
        {title ? <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">{title}</div> : null}
        {description ? <p className="mt-1 text-xs leading-relaxed text-slate-700 dark:text-slate-200">{description}</p> : null}
        {points.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {points.map((point) => (
              <span
                key={point}
                className="rounded-full border border-black/10 bg-white/75 px-2 py-0.5 text-[11px] leading-relaxed text-slate-700 dark:border-white/15 dark:bg-slate-800/70 dark:text-slate-200"
              >
                {point}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
