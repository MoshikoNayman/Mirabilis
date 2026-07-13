// frontend/src/components/shell/WhileYouWereAway.jsx
// The ICQ "offline messages" greeting, reimagined for IntelLedger. On app open
// it surfaces what needs attention - overdue commitments and items due today -
// each with quick actions (Resolve / Snooze / Jump). Styled to match BuddyList:
// an Apple-vibrancy sheet anchored top-right under the dock.
'use client';

import { useEffect, useState } from 'react';
import { Panel, Badge, Button, IconButton, Spinner, BellIcon } from '../ui/primitives';
import { appStore } from '../../store/useAppStore';
import { getJSON, patchJSON } from '../../lib/api';

// The sheet auto-opens at most once per browser session. This guard also keeps
// React StrictMode's double-mount from firing the greeting twice.
const SHOWN_KEY = 'mirabilis-wywa-shown';
const SNOOZE_DAYS = 3;

function readUserId() {
  // Same source MirabilisApp uses for the ledger userId.
  try {
    return window.localStorage.getItem('mirabilis-user-id') || '';
  } catch {
    return '';
  }
}

function alreadyShown() {
  try {
    return window.sessionStorage.getItem(SHOWN_KEY) === '1';
  } catch {
    return false;
  }
}

function markShown() {
  try {
    window.sessionStorage.setItem(SHOWN_KEY, '1');
  } catch {
    /* ignore */
  }
}

// UTC calendar day, matching how the backend brief computes "today".
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(baseIso, days) {
  const dt = new Date(`${baseIso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Port of the backend parseDueDateValue so row classification matches the brief.
function normalizeDue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const today = todayIso();
  if (lower === 'today' || lower === 'eod') return today;
  if (lower === 'tomorrow') return addDaysIso(today, 1);
  if (lower === 'next week') return addDaysIso(today, 7);
  if (lower === 'next month') return addDaysIso(today, 30);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

async function fetchPendingRows(userId) {
  const briefResp = await getJSON(`/api/intelledger/sessions/brief?userId=${encodeURIComponent(userId)}`);
  const brief = briefResp?.brief || {};
  const attentionIds = Array.isArray(brief.attention_session_ids) ? brief.attention_session_ids : [];
  if (attentionIds.length === 0) return [];

  const sessResp = await getJSON(`/api/intelledger/sessions?userId=${encodeURIComponent(userId)}`);
  const titleMap = {};
  (sessResp?.sessions || []).forEach((s) => { titleMap[s.id] = s.title || 'Untitled session'; });

  const today = todayIso();
  const perSession = await Promise.all(attentionIds.map((sid) =>
    getJSON(`/api/intelledger/sessions/${encodeURIComponent(sid)}/actions`)
      .then((r) => ({ sid, actions: Array.isArray(r?.actions) ? r.actions : [] }))
      .catch(() => ({ sid, actions: [] }))
  ));

  const rows = [];
  for (const { sid, actions } of perSession) {
    for (const action of actions) {
      if (String(action.status || '').toLowerCase() === 'done') continue;
      const due = normalizeDue(action.due_date);
      if (!due) continue;
      let kind = null;
      if (due < today) kind = 'overdue';
      else if (due === today) kind = 'due';
      if (!kind) continue;
      rows.push({
        id: action.id,
        sessionId: sid,
        sessionTitle: titleMap[sid] || 'Untitled session',
        title: action.title || 'Untitled action',
        due,
        kind
      });
    }
  }

  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'overdue' ? -1 : 1;
    if (a.due !== b.due) return a.due < b.due ? -1 : 1;
    return 0;
  });
  return rows;
}

function Row({ row, onResolve, onSnooze, onJump }) {
  const overdue = row.kind === 'overdue';
  return (
    <div className="flex flex-col gap-2 rounded-[var(--r-md)] px-3 py-2.5 transition hover:bg-[color:var(--hairline)]">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]">
            {row.title}
          </span>
          <span className="mt-0.5 block truncate text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
            {row.sessionTitle}
          </span>
        </span>
        <Badge tone={overdue ? 'danger' : 'warn'}>{overdue ? 'overdue' : 'due today'}</Badge>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="soft" onClick={() => onResolve(row)}>Resolve</Button>
        <Button size="sm" variant="ghost" onClick={() => onSnooze(row)}>Snooze</Button>
        <Button size="sm" variant="ghost" onClick={() => onJump(row)}>Jump</Button>
      </div>
    </div>
  );
}

export default function WhileYouWereAway({ open }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Auto-open gate: fetch the brief once on mount. If anything is overdue or due
  // today, open the sheet - but at most once per browser session.
  useEffect(() => {
    if (alreadyShown()) return;
    const userId = readUserId();
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await getJSON(`/api/intelledger/sessions/brief?userId=${encodeURIComponent(userId)}`);
        const brief = resp?.brief || {};
        const pending = (Number(brief.overdue_actions) || 0) + (Number(brief.due_today_actions) || 0);
        if (cancelled) return;
        markShown();
        if (pending > 0) appStore.openWywa();
      } catch {
        // If the ledger is unreachable we simply do not greet - no popup on launch.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // (Re)load the full item list whenever the sheet opens.
  useEffect(() => {
    if (!open) return undefined;
    const userId = readUserId();
    if (!userId) { setRows([]); return undefined; }
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchPendingRows(userId)
      .then((next) => { if (!cancelled) setRows(next); })
      .catch((err) => {
        if (cancelled) return;
        setRows([]);
        setError(err?.message || 'Could not load your pending items.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  // Esc closes the sheet, matching BuddyList.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') appStore.closeWywa(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function reload() {
    const userId = readUserId();
    if (!userId) return;
    try {
      const next = await fetchPendingRows(userId);
      setRows(next);
    } catch {
      /* keep the current view on a refresh failure */
    }
  }

  async function handleResolve(row) {
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    try {
      await patchJSON(
        `/api/intelledger/sessions/${encodeURIComponent(row.sessionId)}/actions/${encodeURIComponent(row.id)}`,
        { status: 'done' }
      );
      appStore.toast('Marked done', { kind: 'success' });
    } catch {
      appStore.toast('Could not resolve that item', { kind: 'error' });
      reload();
    }
  }

  async function handleSnooze(row) {
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    const nextDue = addDaysIso(todayIso(), SNOOZE_DAYS);
    try {
      await patchJSON(
        `/api/intelledger/sessions/${encodeURIComponent(row.sessionId)}/actions/${encodeURIComponent(row.id)}`,
        { due_date: nextDue }
      );
      appStore.toast(`Snoozed for ${SNOOZE_DAYS} days`, { kind: 'info' });
    } catch {
      appStore.toast('Could not snooze that item', { kind: 'error' });
      reload();
    }
  }

  function handleJump(row) {
    try {
      window.dispatchEvent(new CustomEvent('mirabilis:open-session', { detail: { id: row.sessionId } }));
    } catch {
      /* ignore */
    }
    appStore.closeWywa();
  }

  if (!open) return null;

  const overdueCount = rows.filter((r) => r.kind === 'overdue').length;
  const dueCount = rows.length - overdueCount;
  let subtitle = 'Nothing needs your attention';
  if (loading) subtitle = 'Checking your ledger...';
  else if (rows.length) {
    const parts = [];
    if (overdueCount) parts.push(`${overdueCount} overdue`);
    if (dueCount) parts.push(`${dueCount} due today`);
    subtitle = parts.join(' - ');
  }

  return (
    <div className="fixed inset-0 z-[90]">
      <div className="au-backdrop absolute inset-0" onClick={() => appStore.closeWywa()} aria-hidden="true" />
      <Panel
        material="chrome"
        className="au-enter absolute right-3 top-16 flex max-h-[78vh] w-[360px] flex-col overflow-hidden"
        role="dialog"
        aria-label="While you were away"
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--hairline)' }}>
          <div className="flex items-center gap-2.5">
            <BellIcon size={17} className="text-[color:var(--text-muted)]" />
            <div className="flex flex-col">
              <span className="text-[length:var(--text-md)] font-semibold text-[color:var(--text-main)]">While you were away</span>
              <span className="text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">{subtitle}</span>
            </div>
          </div>
          <IconButton label="Close" onClick={() => appStore.closeWywa()}>&#10005;</IconButton>
        </div>

        <div className="au-scroll flex-1 overflow-y-auto p-1.5">
          {loading && (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
              <Spinner /> Checking your ledger...
            </div>
          )}

          {!loading && error && (
            <div className="px-3 py-8 text-center text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
              {error}
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div className="px-3 py-8 text-center text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
              Nothing needs your attention right now.
            </div>
          )}

          {!loading && !error && rows.map((row) => (
            <Row
              key={`${row.sessionId}-${row.id}`}
              row={row}
              onResolve={handleResolve}
              onSnooze={handleSnooze}
              onJump={handleJump}
            />
          ))}
        </div>

        <div className="flex items-center gap-3 border-t px-4 py-2 text-[length:var(--text-2xs)] text-[color:var(--text-muted)]" style={{ borderColor: 'var(--hairline)' }}>
          <span className="flex items-center gap-1.5"><Badge tone="danger">overdue</Badge></span>
          <span className="flex items-center gap-1.5"><Badge tone="warn">due today</Badge></span>
        </div>
      </Panel>
    </div>
  );
}
