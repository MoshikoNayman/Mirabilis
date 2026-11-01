'use client';

// One-line live view of an agent run in the composer's action row, with details
// in a popover. No Stop button here: Send becomes Stop during a run.

import { memo, useEffect, useRef, useState } from 'react';

const fmtMs = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** Compact strip format, e.g. "12m" or "1h05". */
const fmtShort = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
};

/** One budget axis as a labelled bar. Popover only. */
function Meter({ label, used, total, invert }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  // Time counts down, everything else counts up; both are "how much is gone".
  const tone = pct >= 90 ? 'var(--danger, #dc2626)' : pct >= 70 ? '#d97706' : 'var(--accent)';
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[10px] uppercase tracking-[0.1em] text-[color:var(--text-muted)]">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: tone }} />
      </div>
      <span className="w-20 shrink-0 text-right font-mono text-[10px] text-[color:var(--text-muted)]">
        {invert ? `${fmtMs(total - used)} left` : `${used}/${total}`}
      </span>
    </div>
  );
}

const PHASE_LABEL = {
  plan: 'Planning', validate: 'Validating', 'wrap-up': 'Wrapping up'
};

function AgentRunPanelInner({ run, onStop, onDismiss }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Close on outside click and on Escape, like every other popover in the app.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!run) return null;

  const { status, effort, goal, budget, events = [], answer, stopReason, error } = run;
  const live = status === 'running' || status === 'stopping';
  const limits = budget?.limits;
  const lastEvent = events.length ? events[events.length - 1].text : '';

  // Numbers only, e.g. "8m | 3/12 | 7/60"; the popover carries the labels.
  const summary = limits
    ? [
      live ? fmtShort(limits.maxWallMs - (budget.elapsedMs || 0)) : (stopReason || status),
      `${budget.iterations}/${limits.maxIterations}`,
      `${budget.toolCalls}/${limits.maxToolCalls}`
    ].join(' | ')
    : (stopReason || status);

  const headline = live
    ? (PHASE_LABEL[run.phase] || 'Working')
    : status === 'completed' ? 'Done' : 'Stopped';

  return (
    <div ref={wrapRef} className="relative mx-1 flex min-w-0 flex-1 items-center justify-center sm:mx-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Autonomous run: ${headline}. ${summary}. Click for details.`}
        title={goal}
        className="au-focus flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-full border border-[var(--hairline)] bg-black/[0.03] px-2 py-0.5 text-[10px] transition hover:bg-black/[0.06] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
      >
        {live
          ? <span className="au-typing shrink-0" aria-hidden="true"><i /><i /><i /></span>
          : (
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${error || status === 'failed' ? 'bg-red-500' : 'bg-[color:var(--text-muted)]'}`}
            />
          )}
        {/* Parts appear by width so the strip never pushes Send off screen. */}
        <span className="hidden shrink-0 font-medium text-[color:var(--text-main)] sm:inline">{headline}</span>
        <span className="hidden shrink-0 font-mono text-[color:var(--text-muted)] md:inline">{summary}</span>
        {live && lastEvent && (
          <span className="hidden min-w-0 truncate text-[color:var(--text-muted)] opacity-70 lg:inline">
            | {lastEvent}
          </span>
        )}
        <svg viewBox="0 0 20 20" aria-hidden="true" fill="currentColor"
          className={`h-2.5 w-2.5 shrink-0 text-[color:var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M5 8l5 5 5-5z" />
        </svg>
      </button>

      {/* Finished runs can be dismissed; live runs stop via the composer's Stop. */}
      {!live && onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss run"
          title="Dismiss"
          className="au-focus ml-1 shrink-0 rounded-full p-0.5 text-[color:var(--text-muted)] transition hover:bg-black/5 hover:text-[color:var(--text-main)] dark:hover:bg-white/10"
        >
          <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      )}

      {open && (
        // Floats over the transcript so opening it does not move the conversation.
        // The material tokens are translucent and need backdrop-blur to stay legible.
        <div
          className="absolute bottom-full left-1/2 z-30 mb-2 w-[min(30rem,85vw)] -translate-x-1/2 rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] p-3 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur"
          role="dialog"
          aria-label="Autonomous run details"
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-[11px] font-semibold text-[color:var(--text-main)]">{goal}</p>
              <p className="mt-0.5 text-[10px] text-[color:var(--text-muted)]">
                {effort}{run.policy ? ` | ${run.policy}` : ''}{stopReason ? ` | ${stopReason}` : ''}
              </p>
            </div>
            {live && onStop && (
              <button
                type="button"
                onClick={onStop}
                className="shrink-0 rounded-full border border-red-400/50 px-2 py-0.5 text-[10px] font-semibold text-red-600 transition hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
              >
                {status === 'stopping' ? 'Stopping...' : 'Stop'}
              </button>
            )}
          </div>

          {limits && (
            <div className="mb-2 space-y-1">
              <Meter label="Time" used={budget.elapsedMs} total={limits.maxWallMs} invert />
              <Meter label="Steps" used={budget.iterations} total={limits.maxIterations} />
              <Meter label="Tools" used={budget.toolCalls} total={limits.maxToolCalls} />
              {limits.maxSubAgents > 0 && (
                <Meter label="Agents" used={budget.subAgents} total={limits.maxSubAgents} />
              )}
            </div>
          )}

          {events.length > 0 && (
            <ol className="max-h-40 space-y-0.5 overflow-y-auto scroll-thin font-mono text-[10px] text-[color:var(--text-muted)]">
              {events.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="w-10 shrink-0 text-right opacity-60">{fmtMs(e.at)}</span>
                  <span className="min-w-0 flex-1 truncate">{e.text}</span>
                </li>
              ))}
            </ol>
          )}

          {error && (
            <p className="mt-2 rounded-lg border border-red-400/40 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </p>
          )}

          {!live && answer && (
            <div className="mt-2 border-t border-[var(--hairline)] pt-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[color:var(--text-muted)]">Result</p>
              <p className="mt-1 max-h-32 overflow-y-auto scroll-thin whitespace-pre-wrap text-[12px] leading-relaxed text-[color:var(--text-main)]">
                {answer}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The event list grows on every tool call, so this re-renders often. Nothing
// else in the composer should re-render with it.
export default memo(AgentRunPanelInner);
