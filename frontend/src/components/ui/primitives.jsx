// frontend/src/components/ui/primitives.jsx
// Aurora primitive components - the shared design-system layer that replaces
// ad-hoc inline Tailwind. Styled via the tokens in src/design/tokens.css.
'use client';

import { forwardRef, useEffect, useRef } from 'react';

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

/* ── Button ─────────────────────────────────────────────────────────────── */
const BTN_BASE =
  'au-focus inline-flex items-center justify-center gap-1.5 font-medium select-none transition active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none';

const BTN_VARIANTS = {
  primary:
    'text-white shadow-[var(--shadow-2)] hover:brightness-110',
  soft:
    'au-hairline au-material hover:brightness-105 text-[color:var(--text-main)]',
  ghost:
    'hover:bg-[color:var(--hairline)] text-[color:var(--text-muted)] hover:text-[color:var(--text-main)]',
  outline:
    'au-hairline bg-transparent hover:bg-[color:var(--hairline)] text-[color:var(--text-main)]',
  danger:
    'au-hairline bg-transparent text-rose-500 hover:bg-rose-500/10'
};

const BTN_SIZES = {
  sm: 'h-7 px-2.5 text-[length:var(--text-2xs)] rounded-[var(--r-sm)]',
  md: 'h-8 px-3 text-[length:var(--text-xs)] rounded-[var(--r-md)]',
  lg: 'h-10 px-4 text-[length:var(--text-sm)] rounded-[var(--r-lg)]'
};

export function Button({ variant = 'soft', size = 'md', className, style, children, ...rest }) {
  const isPrimary = variant === 'primary';
  return (
    <button
      type="button"
      className={cx(BTN_BASE, BTN_VARIANTS[variant], BTN_SIZES[size], className)}
      style={isPrimary ? { background: 'var(--accent)', ...style } : style}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ── IconButton ─────────────────────────────────────────────────────────── */
export function IconButton({ size = 'md', variant = 'ghost', className, label, children, ...rest }) {
  const dim = size === 'sm' ? 'h-7 w-7' : size === 'lg' ? 'h-10 w-10' : 'h-8 w-8';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'au-focus inline-flex items-center justify-center rounded-[var(--r-md)] transition active:scale-95',
        BTN_VARIANTS[variant],
        dim,
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ── Panel / Card ───────────────────────────────────────────────────────── */
export const Panel = forwardRef(function Panel(
  { as: Tag = 'div', material = 'thick', className, children, ...rest },
  ref
) {
  const mat = material === 'chrome' ? 'au-chrome' : material === 'thin' ? 'au-material' : 'au-material-thick';
  return (
    <Tag ref={ref} className={cx(mat, 'au-hairline au-elev-2 rounded-[var(--r-lg)]', className)} {...rest}>
      {children}
    </Tag>
  );
});

/* ── Badge / Pill ───────────────────────────────────────────────────────── */
export function Badge({ tone = 'neutral', className, children }) {
  const tones = {
    neutral: 'au-hairline text-[color:var(--text-muted)]',
    accent: 'border border-transparent text-white',
    success: 'border border-emerald-400/30 bg-emerald-500/12 text-emerald-600 dark:text-emerald-300',
    warn: 'border border-amber-400/30 bg-amber-500/12 text-amber-600 dark:text-amber-300',
    danger: 'border border-rose-400/30 bg-rose-500/12 text-rose-600 dark:text-rose-300'
  };
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-[var(--r-pill)] px-2 py-0.5 text-[length:var(--text-2xs)] font-medium',
        tones[tone],
        className
      )}
      style={tone === 'accent' ? { background: 'var(--accent)' } : undefined}
    >
      {children}
    </span>
  );
}

/* ── Presence dot ───────────────────────────────────────────────────────── */
export function PresenceDot({ presence = 'offline', className }) {
  return <span className={cx('au-dot', className)} data-presence={presence} aria-hidden="true" />;
}

/* ── Keyboard hint ──────────────────────────────────────────────────────── */
export function Kbd({ children }) {
  return (
    <kbd className="au-hairline inline-flex h-5 min-w-[20px] items-center justify-center rounded-[var(--r-xs)] px-1.5 text-[10px] font-medium text-[color:var(--text-muted)]">
      {children}
    </kbd>
  );
}

/* ── Spinner ────────────────────────────────────────────────────────────── */
export function Spinner({ size = 16 }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-60"
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/* ── SegmentedControl ───────────────────────────────────────────────────── */
export function SegmentedControl({ value, onChange, options, size = 'md' }) {
  const pad = size === 'sm' ? 'h-7 text-[length:var(--text-2xs)]' : 'h-8 text-[length:var(--text-xs)]';
  return (
    <div className="au-hairline au-material inline-flex items-center gap-0.5 rounded-[var(--r-pill)] p-0.5">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cx(
              'au-focus inline-flex items-center gap-1 rounded-[var(--r-pill)] px-3 font-medium transition',
              pad,
              active ? 'text-white shadow-[var(--shadow-1)]' : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-main)]'
            )}
            style={active ? { background: 'var(--accent)' } : undefined}
            aria-pressed={active}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Modal / overlay ────────────────────────────────────────────────────── */
export function Modal({ open, onClose, children, align = 'center', className, labelledBy }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    }
    document.addEventListener('keydown', onKey, true);
    // focus first focusable for accessibility
    const t = setTimeout(() => {
      const el = ref.current?.querySelector(
        'input, button, [tabindex]:not([tabindex="-1"]), textarea, a[href]'
      );
      el?.focus();
    }, 30);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;
  const justify = align === 'top' ? 'items-start pt-[12vh]' : 'items-center';
  return (
    <div
      className={cx('fixed inset-0 z-[100] flex justify-center px-4', justify)}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
    >
      <div
        className="au-backdrop absolute inset-0 bg-[rgba(8,12,22,0.42)]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div ref={ref} className={cx('au-pop relative z-10 w-full', className)}>
        {children}
      </div>
    </div>
  );
}
