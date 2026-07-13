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
        className={`rounded-full border border-[var(--hairline)] bg-[var(--material-thin)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--text-muted)] transition hover:border-accent/40 hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${triggerClassName}`}
        aria-label="How it works"
        aria-expanded={isOpen}
        title="How it works"
        onClick={() => setIsOpen((open) => !open)}
      >
        Guide
      </button>

      <div
        className={`au-material-thick absolute left-0 top-[calc(100%+6px)] z-30 w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl border border-[var(--hairline)] p-3 text-left shadow-[var(--shadow-3)] transition duration-200 ${
          isOpen ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-1 opacity-0'
        }`}
      >
        {title ? <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--text-muted)]">{title}</div> : null}
        {description ? <p className="mt-1 text-xs leading-relaxed text-[color:var(--text-main)]">{description}</p> : null}
        {points.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {points.map((point) => (
              <span
                key={point}
                className="rounded-full border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-0.5 text-[11px] leading-relaxed text-[color:var(--text-main)]"
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
