// One pending agent action waiting for the user, shown above the composer.
// Nothing takes focus on arrival, so a keystroke meant for the composer cannot approve.
'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Badge, Button, Spinner, FolderIcon, GlobeIcon, ShieldIcon } from '../ui/primitives';

// Amber, as the run strip and a connector tool's Ask setting show "needs approval".
const WAITING = '#d97706';

// Reasons that only restate the title. The card shows the rest (the Go Dark one).
const TITLE_ONLY_REASONS = new Set(['changes-files', 'not-read-only', 'connector-ask']);

// 'Always allow `git status`' -> text with the backticked part in mono.
function withCode(text) {
  return String(text || '').split('`').map((part, i) => (
    i % 2 === 1
      ? <code key={i} className="min-w-0 truncate font-mono">{part}</code>
      : <span key={i} className="shrink-0 whitespace-pre">{part}</span>
  ));
}

// Write details carry a compact diff: '- ' and '+ ' lines get color.
function Detail({ detail, kind }) {
  const lines = String(detail).split('\n');
  const isDiff = kind === 'write' && lines.some((l) => l.startsWith('+ ') || l.startsWith('- '));
  return (
    <pre
      tabIndex={0}
      aria-label="Details"
      className="au-hairline au-scroll mt-2 max-h-[160px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-sm)] px-3 py-2 font-mono text-[length:var(--text-2xs)] leading-relaxed text-[color:var(--text-main)]"
      style={{ background: 'color-mix(in srgb, var(--text-main) 4%, transparent)' }}
    >
      {isDiff
        ? lines.map((line, i) => (
          <span
            key={i}
            className={
              line.startsWith('+ ') ? 'text-emerald-700 dark:text-emerald-300'
                : line.startsWith('- ') ? 'text-rose-700 dark:text-rose-300'
                  : undefined
            }
          >
            {line}
            {i < lines.length - 1 ? '\n' : ''}
          </span>
        ))
        : detail}
    </pre>
  );
}

/**
 * @param {object} props
 * @param {{ approvalId: string, kind?: string, title?: string, detail?: string, reason?: string,
 *   reasonCode?: string, alwaysLabel?: string|null, network?: boolean, tool?: string, cwd?: string }} props.approval
 * @param {(decision: 'allow'|'always'|'deny', note?: string) => void} props.onDecide
 *   note is set only for a deny with text in the note field
 * @param {boolean} [props.busy] true while the decision is being sent
 */
export default function ApprovalCard({ approval, onDecide, busy = false }) {
  const uid = useId();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [chosen, setChosen] = useState('');
  const noteRef = useRef(null);
  const approvalId = approval?.approvalId;

  useEffect(() => {
    setNoteOpen(false);
    setNote('');
    setChosen('');
  }, [approvalId]);

  useEffect(() => {
    if (!busy) setChosen('');
  }, [busy]);

  useEffect(() => {
    if (noteOpen) noteRef.current?.focus();
  }, [noteOpen]);

  if (!approval) return null;

  const { title, detail, reason, reasonCode, alwaysLabel, network, kind, cwd } = approval;
  const shownReason = reason && !TITLE_ONLY_REASONS.has(reasonCode) ? reason : '';

  function decide(decision) {
    if (busy) return;
    setChosen(decision);
    const text = note.trim();
    onDecide?.(decision, decision === 'deny' && text ? text : undefined);
  }

  const working = (decision) => (busy && chosen === decision ? <Spinner size={12} /> : null);
  // aria-disabled, not disabled: a disabled button drops keyboard focus to the page.
  const lock = busy ? { 'aria-disabled': true } : {};

  return (
    <section
      data-approval-card={approval.approvalId}
      tabIndex={-1}
      aria-labelledby={`${uid}-title`}
      aria-describedby={shownReason ? `${uid}-reason` : undefined}
      className="au-focus au-material-thick au-elev-2 w-full rounded-[var(--r-lg)] border px-4 py-3 outline-none"
      style={{ borderColor: `color-mix(in srgb, ${WAITING} 45%, var(--hairline))` }}
    >
      {/* The run pauses with nothing taking focus, so say so; the card remounts per approval. */}
      <p role="alert" className="sr-only">
        {`${title ? `Needs approval: ${title}.` : 'Needs approval.'}${shownReason ? ` ${shownReason}` : ''}`}
      </p>
      <div className="flex items-start gap-2">
        <ShieldIcon size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 id={`${uid}-title`} className="min-w-0 text-[length:var(--text-sm)] font-semibold text-[color:var(--text-main)]">
              {title || 'Approve this action?'}
            </h3>
            <span className="text-[length:var(--text-2xs)] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
              Needs approval
            </span>
            {network ? (
              <Badge tone="warn" className="ml-auto">
                <GlobeIcon size={11} />
                Uses network
              </Badge>
            ) : null}
          </div>
          {cwd ? (
            <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
              <FolderIcon size={11} className="shrink-0" />
              <span className="shrink-0">in</span>
              <code className="min-w-0 truncate font-mono text-[color:var(--text-main)]" title={cwd}>{cwd}</code>
            </p>
          ) : null}
          {shownReason ? (
            <p id={`${uid}-reason`} className="mt-1 text-[length:var(--text-xs)] leading-snug text-[color:var(--text-muted)]">
              {shownReason}
            </p>
          ) : null}
        </div>
      </div>

      {detail ? <Detail detail={detail} kind={kind} /> : null}

      {noteOpen ? (
        <div className="mt-2">
          <label htmlFor={`${uid}-note`} className="sr-only">Note</label>
          <input
            id={`${uid}-note`}
            ref={noteRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                decide('deny');
              } else if (e.key === 'Escape') {
                e.preventDefault();
                if (busy) return;
                setNoteOpen(false);
                setNote('');
              }
            }}
            readOnly={busy}
            maxLength={500}
            className="au-hairline au-focus h-8 w-full rounded-[var(--r-sm)] bg-transparent px-3 text-[length:var(--text-xs)] text-[color:var(--text-main)] placeholder:text-[color:var(--text-muted)] placeholder:opacity-60 disabled:opacity-50"
          />
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => decide('deny')} {...lock}>
          {working('deny')}
          {noteOpen && note.trim() ? 'Deny with note' : 'Deny'}
        </Button>
        {!noteOpen ? (
          <button
            type="button"
            onClick={() => { if (!busy) setNoteOpen(true); }}
            {...lock}
            className="au-focus rounded-[var(--r-xs)] px-1 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-muted)] underline-offset-2 transition-colors hover:text-[color:var(--text-main)] hover:underline aria-disabled:opacity-40"
          >
            Add note
          </button>
        ) : null}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {alwaysLabel ? (
            <Button
              size="sm"
              variant="soft"
              onClick={() => decide('always')}
              {...lock}
              title={alwaysLabel.includes('`') ? alwaysLabel.replace(/`/g, '') : undefined}
              className="min-w-0 max-w-[280px]"
            >
              {working('always')}
              <span className="flex min-w-0 items-center">{withCode(alwaysLabel)}</span>
            </Button>
          ) : null}
          <Button size="sm" variant="primary" onClick={() => decide('allow')} {...lock}>
            {working('allow')}
            Allow
          </Button>
        </div>
      </div>
    </section>
  );
}
