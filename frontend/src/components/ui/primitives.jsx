// Aurora design-system primitives, styled via the tokens in src/design/tokens.css.
'use client';

import { forwardRef, useEffect, useRef } from 'react';

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

/* Button */
// aria-disabled looks like disabled but keeps focus, for a control that is busy
// right after being pressed; its handler must ignore clicks meanwhile.
const BTN_BASE =
  'au-focus inline-flex items-center justify-center gap-1.5 font-medium select-none transition active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-40';

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

/* IconButton */
export function IconButton({ size = 'md', variant = 'ghost', className, label, children, ...rest }) {
  const dim = size === 'sm' ? 'h-7 w-7' : size === 'lg' ? 'h-10 w-10' : 'h-8 w-8';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'au-focus inline-flex items-center justify-center rounded-[var(--r-md)] transition active:scale-95 aria-disabled:cursor-not-allowed aria-disabled:opacity-40',
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

/* Panel / Card */
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

/* Badge / Pill */
export function Badge({ tone = 'neutral', className, children }) {
  const tones = {
    neutral: 'au-hairline text-[color:var(--text-muted)]',
    accent: 'border border-transparent text-white',
    success: 'border border-emerald-400/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    warn: 'border border-amber-400/30 bg-amber-500/10 text-amber-600 dark:text-amber-300',
    danger: 'border border-rose-400/30 bg-rose-500/10 text-rose-600 dark:text-rose-300'
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

/* Presence dot */
export function PresenceDot({ presence = 'offline', className }) {
  return <span className={cx('au-dot', className)} data-presence={presence} aria-hidden="true" />;
}

/* Keyboard hint */
export function Kbd({ children }) {
  return (
    <kbd className="au-hairline inline-flex h-5 min-w-[20px] items-center justify-center rounded-[var(--r-xs)] px-1.5 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-muted)]">
      {children}
    </kbd>
  );
}

/* Spinner */
export function Spinner({ size = 16 }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-60"
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/* Line icons: stroke is currentColor so they follow the theme text color. */
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
export function CloseIcon(props) {
  return <Svg {...props}><path d="M6 6l12 12M18 6 6 18" /></Svg>;
}
export function PencilIcon(props) {
  return <Svg {...props}><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></Svg>;
}
export function ChatIcon(props) {
  return <Svg {...props}><path d="M4 5h16v11H9l-5 4V5Z" /></Svg>;
}
export function GlobeIcon(props) {
  return <Svg {...props}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Svg>;
}
export function PaletteIcon(props) {
  return <Svg {...props}><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.6 0-1.4 1-2.4 2.4-2.4H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z" /><path d="M7.5 11h.01M10 7.5h.01M14 7.5h.01" /></Svg>;
}
export function TypeIcon(props) {
  return <Svg {...props}><path d="M5 6V4h14v2M12 4v16M9 20h6" /></Svg>;
}
export function PlayIcon(props) {
  return <Svg {...props}><path d="M7 5v14l11-7L7 5Z" /></Svg>;
}
export function ChevronRightIcon(props) {
  return <Svg {...props}><path d="m9 6 6 6-6 6" /></Svg>;
}
export function ArrowDownIcon(props) {
  return <Svg {...props}><path d="M12 5v14M6 13l6 6 6-6" /></Svg>;
}
export function AlertIcon(props) {
  return <Svg {...props}><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17h.01" /></Svg>;
}
export function CheckIcon(props) {
  return <Svg {...props}><path d="m5 12 5 5 9-10" /></Svg>;
}
export function UsersIcon(props) {
  return <Svg {...props}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></Svg>;
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
// Soundwave bars for the Voice chat entry point.
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
// Opposed arrows for a reversed or superseded decision.
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
// Six-tooth gear: fewer teeth stay legible at 15px.
export function GearIcon(props) {
  return (
    <Svg {...props}>
      <path d="M9.89 5.11 10.13 2.38A9.8 9.8 0 0 1 13.87 2.38L14.11 5.11A7.2 7.2 0 0 1 16.91 6.73L19.4 5.57A9.8 9.8 0 0 1 21.27 8.81L19.02 10.38A7.2 7.2 0 0 1 19.02 13.62L21.27 15.19A9.8 9.8 0 0 1 19.4 18.43L16.91 17.27A7.2 7.2 0 0 1 14.11 18.89L13.87 21.62A9.8 9.8 0 0 1 10.13 21.62L9.89 18.89A7.2 7.2 0 0 1 7.09 17.27L4.6 18.43A9.8 9.8 0 0 1 2.73 15.19L4.98 13.62A7.2 7.2 0 0 1 4.98 10.38L2.73 8.81A9.8 9.8 0 0 1 4.6 5.57L7.09 6.73A7.2 7.2 0 0 1 9.89 5.11Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}
export function ShieldIcon(props) {
  return <Svg {...props}><path d="M12 3 5 5.8v5.4c0 4.3 2.9 8 7 9.8 4.1-1.8 7-5.5 7-9.8V5.8L12 3Z" /></Svg>;
}
export function PlugIcon(props) {
  return <Svg {...props}><path d="M9 3v4.5M15 3v4.5" /><path d="M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0V7.5Z" /><path d="M12 16.5V21" /></Svg>;
}
export function TerminalIcon(props) {
  return <Svg {...props}><rect x="3" y="4.5" width="18" height="15" rx="2.2" /><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" /></Svg>;
}
export function BookIcon(props) {
  return (
    <Svg {...props}>
      <path d="M12 6.8C10.4 5.5 8.2 4.8 5.5 4.8H3.5v13.4h2c2.7 0 4.9.7 6.5 2 1.6-1.3 3.8-2 6.5-2h2V4.8h-2c-2.7 0-4.9.7-6.5 2Z" />
      <path d="M12 6.8v13.4" />
    </Svg>
  );
}
export function MicIcon(props) {
  return <Svg {...props}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 10.5a6.5 6.5 0 0 0 13 0" /><path d="M12 17v4M8.5 21h7" /></Svg>;
}
export function FlaskIcon(props) {
  return (
    <Svg {...props}>
      <path d="M9 3h6" />
      <path d="M10 3v6.2L4.8 18.3A1.8 1.8 0 0 0 6.4 21h11.2a1.8 1.8 0 0 0 1.6-2.7L14 9.2V3" />
      <path d="M7.4 15.5h9.2" />
    </Svg>
  );
}
export function LinkIcon(props) {
  return <Svg {...props}><path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Svg>;
}
export function CopyIcon(props) {
  return (
    <Svg {...props}>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2.2" />
      <path d="M15.5 8.5V5.7a2.2 2.2 0 0 0-2.2-2.2H5.7a2.2 2.2 0 0 0-2.2 2.2v7.6a2.2 2.2 0 0 0 2.2 2.2h2.8" />
    </Svg>
  );
}
export function RefreshIcon(props) {
  return <Svg {...props}><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 4v4.5h-4.5" /></Svg>;
}
export function TrashIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4 7h16" />
      <path d="M9.5 7V4.5h5V7" />
      <path d="m6.5 7 .8 11.4a2.2 2.2 0 0 0 2.2 2.1h5a2.2 2.2 0 0 0 2.2-2.1L17.5 7" />
      <path d="M10 11v5.5M14 11v5.5" />
    </Svg>
  );
}
export function PlusIcon(props) {
  return <Svg {...props}><path d="M12 5v14M5 12h14" /></Svg>;
}
export function ExternalIcon(props) {
  return <Svg {...props}><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></Svg>;
}
// Isometric cube for models.
export function CubeIcon(props) {
  return <Svg {...props}><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></Svg>;
}

/* SegmentedControl */
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

/* Switch: on/off that applies at once. onChange receives the next value. */
export function Switch({ checked = false, onChange, label, disabled = false, size = 'md', className, style, ...rest }) {
  const sm = size === 'sm';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cx(
        'au-focus relative inline-flex shrink-0 items-center rounded-[var(--r-pill)] p-0.5 transition-colors duration-[var(--dur-fast)] disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40',
        sm ? 'h-4 w-7' : 'h-5 w-9',
        className
      )}
      style={{ background: checked ? 'var(--accent)' : 'color-mix(in srgb, var(--text-muted) 38%, transparent)', ...style }}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cx(
          'block rounded-full bg-white shadow-[var(--shadow-1)] transition-transform duration-[var(--dur-fast)]',
          sm ? 'h-3 w-3' : 'h-4 w-4',
          checked ? (sm ? 'translate-x-3' : 'translate-x-4') : 'translate-x-0'
        )}
      />
    </button>
  );
}

/* Modal / overlay */
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
