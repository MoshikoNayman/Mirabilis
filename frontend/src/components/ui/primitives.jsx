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
    <kbd className="au-hairline inline-flex h-5 min-w-[20px] items-center justify-center rounded-[var(--r-xs)] px-1.5 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-muted)]">
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

/* ── Line icons ─────────────────────────────────────────────────────────────
   Monochrome, stroke = currentColor, so they follow the active theme accent /
   text color instead of clashing full-colour emoji. */
function Svg({ size = 16, className, children }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
export function SearchIcon(props) {
  return <Svg {...props}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.35-4.35" /></Svg>;
}
export function RecallIcon(props) {
  return <Svg {...props}><path d="M3 3v6h6" /><path d="M3.5 9a9 9 0 1 1-.85 6" /><path d="M12 7.5V12l3 1.8" /></Svg>;
}
export function MoonIcon({ filled = false, ...props }) {
  return <Svg {...props}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" fill={filled ? 'currentColor' : 'none'} /></Svg>;
}
export function ServerIcon(props) {
  return <Svg {...props}><rect x="3" y="4" width="18" height="7" rx="1.6" /><rect x="3" y="13" width="18" height="7" rx="1.6" /><path d="M7 7.5h.01M7 16.5h.01" /></Svg>;
}
export function FolderIcon(props) {
  return <Svg {...props}><path d="M3 7.5a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6l1 1a2 2 0 0 0 1.4.6H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></Svg>;
}
export function IncognitoIcon(props) {
  return <Svg {...props}><path d="M3 12h18" /><path d="M6.2 12l1.1-3.9A2 2 0 0 1 9.2 6.6h5.6a2 2 0 0 1 1.9 1.5L17.8 12" /><circle cx="7.6" cy="15.2" r="2.3" /><circle cx="16.4" cy="15.2" r="2.3" /></Svg>;
}
export function CommandIcon(props) {
  return <Svg {...props}><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z" /></Svg>;
}
export function MenuDotsIcon(props) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}
export function RadarIcon(props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 12 18.4 5.6" />
      <circle cx="16" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}
export function BellIcon(props) {
  return (
    <Svg {...props}>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
      <path d="M10.2 20a2 2 0 0 0 3.6 0" />
    </Svg>
  );
}
// Horizontal sliders - reads as "settings / options".
export function SlidersIcon(props) {
  return (
    <Svg {...props}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="9" cy="7" r="2.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="2.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="17" r="2.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}
// Soundwave bars: reads as "voice / spoken conversation". Used for the
// hands-free Voice chat entry point in the composer.
export function WaveIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4 11v2" />
      <path d="M8 8v8" />
      <path d="M12 4v16" />
      <path d="M16 8v8" />
      <path d="M20 11v2" />
    </Svg>
  );
}
// Two opposed arrows: reads as "then vs now", a reversed or superseded decision.
export function ContradictionIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4 8h13" />
      <path d="m13 4 4 4-4 4" />
      <path d="M20 16H7" />
      <path d="m11 12-4 4 4 4" />
    </Svg>
  );
}

/* ── SegmentedControl ───────────────────────────────────────────────────── */
export function SegmentedControl({ value, onChange, options, size = 'md' }) {
  const pad = size === 'sm' ? 'h-7 px-2.5 text-[length:var(--text-2xs)]' : 'h-8 px-3 text-[length:var(--text-xs)]';
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
              'au-focus inline-flex items-center gap-1 rounded-[var(--r-pill)] font-medium transition',
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
