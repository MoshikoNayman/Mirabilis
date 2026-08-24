'use client';

// Live view of an autonomous run.
//
// A five-hour job that shows a spinner is indistinguishable from a hung one, so
// this reports what is actually happening: the current phase, every tool call as
// it is made, and how much of each budget axis is gone. The stop button is the
// most important control on the screen, so it stays visible the whole time
// rather than hiding behind a menu.

import { memo, useState } from 'react';

const fmtMs = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** One budget axis as a labelled bar. */
function Meter({ label, used, total, invert }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  // Time counts down, everything else counts up; both are "how much is gone".
  const tone = pct >= 90 ? 'var(--danger, #dc2626)' : pct >= 70 ? '#d97706' : 'var(--accent)';
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-[0.1em] text-[color:var(--text-muted)]">{label}</span>
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

function AgentRunPanelInner({ run, onStop }) {
  // Collapsed by default: the header line carries the state that matters at a
  // glance, and a five-hour run should not own the screen for five hours.
  const [expanded, setExpanded] = useState(false);
  if (!run) return null;
  const { status, effort, goal, budget, events = [], answer, stopReason, error } = run;
  const live = status === 'running' || status === 'stopping';
  const limits = budget?.limits;
  const timeLeft = limits ? fmtMs(limits.maxWallMs - (budget.elapsedMs || 0)) : '';
  const lastEvent = events.length ? events[events.length - 1].text : '';

  return (
    <section
      className="mb-3 rounded-[var(--r-lg)] border border-[var(--hairline)] bg-[var(--material-thin)] p-3"
      aria-label="Autonomous run"
      aria-busy={live}
    >
      <header className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="min-w-0 flex-1 rounded-lg text-left transition hover:opacity-80"
          title={expanded ? 'Collapse run details' : 'Expand run details'}
        >
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 20 20" aria-hidden="true"
              className={`h-3 w-3 shrink-0 text-[color:var(--text-muted)] transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="currentColor">
              <path d="M7 5l5 5-5 5z" />
            </svg>
            {live && <span className="au-typing" aria-hidden="true"><i /><i /><i /></span>}
            <span className="text-xs font-semibold text-[color:var(--text-main)]">
              {live ? (PHASE_LABEL[run.phase] || 'Working') : status === 'completed' ? 'Completed' : 'Stopped'}
            </span>
            <span className="rounded-full border border-[var(--hairline)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[color:var(--text-muted)]">
              {effort}
            </span>
            {run.policy && (
              <span className="text-[10px] text-[color:var(--text-muted)]">{run.policy}</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-[color:var(--text-muted)]">{goal}</p>
          {/* Collapsed summary: enough to know it is healthy without opening it. */}
          {!expanded && limits && (
            <p className="mt-0.5 truncate font-mono text-[10px] text-[color:var(--text-muted)]">
              {live ? `${timeLeft} left` : (stopReason || status)}
              {` · step ${budget.iterations}/${limits.maxIterations} · ${budget.toolCalls} tool${budget.toolCalls === 1 ? '' : 's'}`}
              {live && lastEvent ? ` · ${lastEvent}` : ''}
            </p>
          )}
        </button>
        {live ? (
          <button
            type="button"
            onClick={onStop}
            className="shrink-0 rounded-full border border-red-400/50 px-2.5 py-1 text-[11px] font-semibold text-red-600 transition hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
          >
            {status === 'stopping' ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <span className="shrink-0 font-mono text-[10px] text-[color:var(--text-muted)]">
            {stopReason || status}
          </span>
        )}
      </header>

      {expanded && limits && (
        <div className="mb-2 mt-2 space-y-1">
          <Meter label="Time" used={budget.elapsedMs} total={limits.maxWallMs} invert />
          <Meter label="Steps" used={budget.iterations} total={limits.maxIterations} />
          <Meter label="Tools" used={budget.toolCalls} total={limits.maxToolCalls} />
          {limits.maxSubAgents > 0 && (
            <Meter label="Agents" used={budget.subAgents} total={limits.maxSubAgents} />
          )}
        </div>
      )}

      {expanded && events.length > 0 && (
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
        <details className="mt-2" open={expanded || !live}>
          <summary className="cursor-pointer text-[11px] font-semibold text-[color:var(--text-main)]">Result</summary>
          <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-[color:var(--text-main)]">{answer}</p>
        </details>
      )}
    </section>
  );
}

// The event list grows on every tool call, so the panel re-renders often. Nothing
// else in the transcript should re-render with it.
export default memo(AgentRunPanelInner);
