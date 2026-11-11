// Settings dialog: section nav on the left (a scroll strip on narrow windows) and
// the active section on the right. Portaled to body so it shows from any tab.
'use client';

import { createElement, isValidElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconButton, CloseIcon } from '../ui/primitives';
import { useAppStore } from '../../store/useAppStore';
import { APP_VERSION } from '../../constants/app';

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

// Fades the strip's right edge while more tabs sit past it.
const STRIP_FADE = {
  WebkitMaskImage: 'linear-gradient(to right, #000 80%, transparent)',
  maskImage: 'linear-gradient(to right, #000 80%, transparent)'
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

// Sections may pass an icon component or a ready element.
function sectionIcon(icon, size) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  if (typeof icon === 'function' || typeof icon === 'object') return createElement(icon, { size });
  return null;
}

/** Titled block of settings, with an optional control on the right of the title. Title only, no subtitle. */
export function SettingsGroup({ title, action, children, className }) {
  return (
    <section className={cx('mb-8 last:mb-0', className)}>
      {title || action ? (
        <div className="mb-3 flex items-end justify-between gap-4">
          <div className="min-w-0">
            {title ? (
              <h4 className="text-[length:var(--text-sm)] font-semibold text-[color:var(--text-main)]">{title}</h4>
            ) : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Bordered list of rows with hairline separators. */
export function SettingsList({ children, className }) {
  return (
    <div className={cx('au-hairline divide-y divide-[color:var(--hairline)] rounded-[var(--r-md)]', className)}>
      {children}
    </div>
  );
}

/**
 * One setting: label and a one-line description on the left, its control on the
 * right. `detail` renders under the description (a path, a status line).
 */
export function SettingsRow({ label, description, detail, htmlFor, labelId, children, className }) {
  const Label = htmlFor ? 'label' : 'div';
  // Wraps on narrow windows, so a wide control drops below the text instead of squeezing it.
  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3', className)}>
      <div className="min-w-[12rem] flex-1">
        <Label
          htmlFor={htmlFor}
          id={labelId}
          className="block text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]"
        >
          {label}
        </Label>
        {description ? (
          <p className="mt-0.5 text-[length:var(--text-xs)] leading-snug text-[color:var(--text-muted)]">{description}</p>
        ) : null}
        {detail ? <div className="mt-1 min-w-0">{detail}</div> : null}
      </div>
      {children != null && children !== false ? (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

const NOTICE_TONES = {
  info: 'au-hairline text-[color:var(--text-muted)]',
  warn: 'border border-amber-400/40 bg-amber-500/10 text-amber-800 dark:text-amber-200',
  danger: 'border border-rose-400/40 bg-rose-500/10 text-rose-700 dark:text-rose-200'
};

/** Inline message inside a pane: info, warn or danger. */
export function SettingsNotice({ tone = 'info', icon, action, children, className }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cx(
        'flex items-start gap-2 rounded-[var(--r-md)] px-3 py-2 text-[length:var(--text-xs)] leading-relaxed',
        NOTICE_TONES[tone] || NOTICE_TONES.info,
        className
      )}
    >
      {icon ? <span className="mt-0.5 flex shrink-0">{icon}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export default function SettingsSheet({ open, section, onSection, onClose, sections = [] }) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const panelId = `${uid}-panel`;
  const tabId = (id) => `${uid}-tab-${id}`;

  const panelRef = useRef(null);
  const bodyRef = useRef(null);
  const returnFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Panels opened from here (the Workspace picker, for one) sit above the sheet
  // and get Esc first.
  const overlayOpen = useAppStore((s) =>
    s.workspaceOpen || s.homelabOpen || s.buddyOpen || s.wywaOpen || s.recallOpen
    || s.voiceChatOpen || s.commandOpen || s.searchOpen);
  const overlayRef = useRef(overlayOpen);
  useEffect(() => { overlayRef.current = overlayOpen; }, [overlayOpen]);

  // Local copy so arrow keys work even if the parent does not echo onSection.
  const [currentId, setCurrentId] = useState(section);
  useEffect(() => { setCurrentId(section); }, [section]);

  const list = Array.isArray(sections) ? sections.filter((s) => s && s.id) : [];
  const active = list.find((s) => s.id === currentId) || list[0] || null;
  const activeId = active ? active.id : '';

  function select(id) {
    setCurrentId(id);
    if (id !== section) onSection?.(id);
  }

  // Focus moves in on open and back to the opener on close.
  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement;
    const tab = panelRef.current?.querySelector('[role="tab"][aria-selected="true"]');
    (tab || panelRef.current)?.focus();
    return () => {
      const el = returnFocusRef.current;
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
    };
  }, [open]);

  // Esc closes. A control that needs Esc for itself calls preventDefault.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key !== 'Escape' || e.defaultPrevented || overlayRef.current) return;
      e.preventDefault();
      onCloseRef.current?.();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [activeId]);

  // A pane can switch sections itself (Change Access), and the control it used
  // unmounts with focus on it; the new section's tab takes focus instead.
  useEffect(() => {
    if (!open || overlayRef.current) return;
    const panel = panelRef.current;
    const focused = document.activeElement;
    if (!panel || (focused && focused !== document.body && panel.contains(focused))) return;
    document.getElementById(`${uid}-tab-${activeId}`)?.focus();
  }, [open, activeId, uid]);

  // The nav is a column from 720px and a horizontal strip below, which may hide tabs off the edge.
  const stripRef = useRef(null);
  const [wide, setWide] = useState(true);
  const [moreRight, setMoreRight] = useState(false);
  const measureStrip = useCallback(() => {
    const el = stripRef.current;
    setMoreRight(Boolean(el) && el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
  }, []);
  useEffect(() => {
    if (!open || typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(min-width: 720px)');
    const update = () => { setWide(mq.matches); measureStrip(); };
    update();
    mq.addEventListener?.('change', update);
    window.addEventListener('resize', measureStrip);
    return () => {
      mq.removeEventListener?.('change', update);
      window.removeEventListener('resize', measureStrip);
    };
  }, [open, measureStrip]);

  if (!open || typeof document === 'undefined') return null;

  // Up/Down (Left/Right on the narrow strip), Home and End move between sections.
  function onNavKeyDown(e) {
    const idx = list.findIndex((s) => s.id === activeId);
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = Math.min(idx + 1, list.length - 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = Math.max(idx - 1, 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else return;
    e.preventDefault();
    const target = list[next];
    if (!target) return;
    if (target.id !== activeId) select(target.id);
    document.getElementById(tabId(target.id))?.focus();
  }

  // Keeps Tab inside the dialog while it is open; a panel opened from here (the
  // Workspace picker) sits outside it and must stay reachable.
  function onPanelKeyDown(e) {
    if (e.key !== 'Tab' || !panelRef.current || overlayRef.current) return;
    const items = focusableIn(panelRef.current);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (e.shiftKey && (current === first || current === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && current === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-4 min-[720px]:p-6">
      <div
        className="au-backdrop absolute inset-0 bg-[rgba(8,12,22,0.42)]"
        onClick={() => onCloseRef.current?.()}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={overlayOpen ? undefined : 'true'}
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
        className="au-pop au-material-thick au-hairline au-elev-3 relative flex h-[min(640px,88vh)] w-full max-w-[920px] flex-col overflow-hidden rounded-[var(--r-xl)] text-[color:var(--text-main)] outline-none min-[720px]:flex-row"
      >
        <IconButton
          label="Close settings"
          onClick={() => onCloseRef.current?.()}
          className="absolute right-3 top-3 z-10"
        >
          <CloseIcon size={14} />
        </IconButton>

        <nav
          aria-label="Settings sections"
          className="flex shrink-0 flex-col border-b min-[720px]:w-[200px] min-[720px]:border-b-0 min-[720px]:border-r"
          style={{
            borderColor: 'var(--hairline)',
            background: 'color-mix(in srgb, var(--text-main) 3%, transparent)'
          }}
        >
          <h2
            id={titleId}
            className="px-4 pb-2 pt-4 text-[length:var(--text-md)] font-semibold min-[720px]:px-5 min-[720px]:pb-3 min-[720px]:pt-5"
          >
            Settings
          </h2>
          <div
            ref={stripRef}
            role="tablist"
            aria-orientation={wide ? 'vertical' : 'horizontal'}
            aria-labelledby={titleId}
            onKeyDown={onNavKeyDown}
            onScroll={measureStrip}
            className="au-scroll flex gap-1 overflow-x-auto px-3 pb-3 min-[720px]:flex-col min-[720px]:overflow-x-visible"
            style={!wide && moreRight ? STRIP_FADE : undefined}
          >
            {list.map((s) => {
              const selected = s.id === activeId;
              return (
                <button
                  key={s.id}
                  id={tabId(s.id)}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={panelId}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => select(s.id)}
                  className={cx(
                    'au-focus flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[var(--r-sm)] px-3 text-left text-[length:var(--text-xs)] font-medium transition-colors',
                    selected
                      ? 'text-[color:var(--text-main)]'
                      : 'text-[color:var(--text-muted)] hover:bg-[color:var(--hairline)] hover:text-[color:var(--text-main)]'
                  )}
                  style={selected ? { background: 'color-mix(in srgb, var(--accent) 14%, transparent)' } : undefined}
                >
                  <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center"
                    style={selected ? { color: 'var(--accent)' } : undefined}
                    aria-hidden="true"
                  >
                    {sectionIcon(s.icon, 15)}
                  </span>
                  <span className="min-w-0 truncate">{s.label}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-auto hidden px-5 py-4 text-[length:var(--text-2xs)] text-[color:var(--text-muted)] min-[720px]:block">
            Mirabilis {APP_VERSION}
          </div>
        </nav>

        <section
          id={panelId}
          role="tabpanel"
          aria-labelledby={active ? tabId(active.id) : titleId}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {active ? (
            <>
              <header
                className="shrink-0 border-b px-4 py-3 min-[720px]:px-6 min-[720px]:pb-4 min-[720px]:pr-16 min-[720px]:pt-5"
                style={{ borderColor: 'var(--hairline)' }}
              >
                <h3 className="text-[length:var(--text-lg)] font-semibold leading-tight">{active.label}</h3>
              </header>
              {/* relative: absolutely positioned content (sr-only labels) scrolls and clips here, not in the dialog. */}
              <div
                ref={bodyRef}
                key={active.id}
                className="au-scroll relative min-h-0 flex-1 overflow-y-auto px-4 py-4 min-[720px]:px-6 min-[720px]:py-6"
              >
                {typeof active.render === 'function' ? active.render() : null}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
              No settings
            </div>
          )}
        </section>
      </div>
    </div>,
    document.body
  );
}
