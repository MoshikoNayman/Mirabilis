// frontend/src/components/shell/CommitmentRadar.jsx
// Commitment Radar: an ambient, read-only pass over the CURRENT conversation.
// It surfaces commitments, asks, and decisions that were made in the chat so
// they can be filed into IntelLedger with one click - nothing is persisted
// until the user chooses to file. The scan itself runs on the backend via the
// read-only /api/intelledger/scan endpoint and writes nothing.
'use client';

import { Modal, Badge, Button, Spinner, RadarIcon, ContradictionIcon } from '../ui/primitives';

const TYPE_TONE = {
  commitment: 'accent',
  decision: 'success',
  ask: 'warn',
  risk: 'danger'
};

const TYPE_LABEL = {
  commitment: 'commitment',
  decision: 'decision',
  ask: 'ask',
  risk: 'risk'
};

export default function CommitmentRadar({
  open,
  onClose,
  loading,
  error,
  scanned,
  signals = [],
  filing = false,
  onFileAll,
  conflicts = [],
  conflictsLoading = false
}) {
  const hasSignals = Array.isArray(signals) && signals.length > 0;
  const hasConflicts = Array.isArray(conflicts) && conflicts.length > 0;

  // Jump to the past chat or ledger session behind a flagged conflict, then close.
  // Both events are handled upstream (open-chat by the chat view, open-session
  // switches to the Ledger tab), so no extra tab wiring is needed here.
  function jumpToPast(past) {
    try {
      if (past?.source === 'chat' && past.chatId) {
        window.dispatchEvent(new CustomEvent('mirabilis:open-chat', { detail: { id: past.chatId } }));
      } else if (past?.source === 'ledger' && past.sessionId) {
        window.dispatchEvent(new CustomEvent('mirabilis:open-session', { detail: { id: past.sessionId } }));
      }
    } catch {
      /* ignore */
    }
    onClose?.();
  }

  return (
    <Modal open={open} onClose={onClose} align="top" className="max-w-[560px]" labelledBy="radar-title">
      <div className="au-chrome au-hairline au-elev-3 overflow-hidden rounded-[var(--r-xl)]">
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--hairline)' }}>
          <RadarIcon size={16} className="text-[color:var(--text-muted)]" />
          <span id="radar-title" className="text-[length:var(--text-sm)] font-semibold text-[color:var(--text-main)]">
            Commitment Radar
          </span>
          {loading ? <span className="ml-auto"><Spinner /></span> : (
            hasSignals ? (
              <span className="ml-auto text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
                {signals.length} detected
              </span>
            ) : null
          )}
        </div>

        <div className="au-scroll max-h-[56vh] overflow-y-auto p-1.5">
          {loading && (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
              <Spinner /> Scanning this conversation locally...
            </div>
          )}

          {!loading && error && (
            <div className="px-3 py-8 text-center text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
              {error}
            </div>
          )}

          {!loading && !error && hasSignals && signals.map((signal, i) => {
            const type = signal.signal_type || signal.type || 'commitment';
            return (
              <div
                key={`${type}-${i}`}
                className="flex items-start gap-3 rounded-[var(--r-md)] px-3 py-2"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-[length:var(--text-sm)] text-[color:var(--text-main)]">
                    {signal.value || signal.quote}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={TYPE_TONE[type] || 'neutral'}>{TYPE_LABEL[type] || type}</Badge>
                    {signal.due_date ? (
                      <span className="inline-flex items-center rounded-[var(--r-pill)] au-hairline px-2 py-0.5 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-muted)]">
                        due {signal.due_date}
                      </span>
                    ) : null}
                  </span>
                </span>
              </div>
            );
          })}

          {!loading && !error && scanned && !hasSignals && (
            <div className="px-3 py-8 text-center text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
              No open commitments detected in this conversation.
            </div>
          )}

          {!loading && !error && (conflictsLoading || hasConflicts) && (
            <div className="mt-1 border-t pt-1.5" style={{ borderColor: 'var(--hairline)' }}>
              <div className="flex items-center gap-2 px-3 py-1.5">
                <ContradictionIcon size={13} className="text-[color:var(--text-muted)]" />
                <span className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
                  Conflicts with earlier decisions
                </span>
                {conflictsLoading ? <span className="ml-auto"><Spinner size={13} /></span> : (
                  hasConflicts ? (
                    <span className="ml-auto text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
                      {conflicts.length} found
                    </span>
                  ) : null
                )}
              </div>

              {conflictsLoading && !hasConflicts && (
                <div className="flex items-center gap-2 px-3 py-3 text-[length:var(--text-xs)] text-[color:var(--text-muted)]">
                  <Spinner size={13} /> Checking against your past decisions...
                </div>
              )}

              {hasConflicts && conflicts.map((conflict, i) => {
                const past = conflict.past || {};
                const source = past.source === 'ledger' ? 'ledger' : 'chat';
                return (
                  <button
                    key={`conflict-${i}`}
                    type="button"
                    onClick={() => jumpToPast(past)}
                    className="au-focus flex w-full flex-col gap-1 rounded-[var(--r-md)] px-3 py-2 text-left transition hover:bg-[color:var(--hairline)]"
                  >
                    <span className="flex items-start gap-2">
                      <span className="mt-0.5 w-11 shrink-0 text-[length:var(--text-2xs)] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
                        Now
                      </span>
                      <span className="min-w-0 text-[length:var(--text-sm)] text-[color:var(--text-main)]">
                        {conflict.current}
                      </span>
                    </span>
                    <span className="flex items-start gap-2">
                      <span className="mt-0.5 w-11 shrink-0 text-[length:var(--text-2xs)] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">
                        Earlier
                      </span>
                      <span className="line-clamp-2 min-w-0 text-[length:var(--text-xs)] text-[color:var(--text-muted)]">
                        {past.snippet}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 pl-[3.25rem]">
                      <Badge tone={source === 'ledger' ? 'warn' : 'neutral'}>{source}</Badge>
                      {conflict.why ? (
                        <span className="text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
                          {conflict.why}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {!loading && !error && scanned && !conflictsLoading && !hasConflicts && (
            <div className="px-3 pb-3 pt-1 text-center text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
              No conflicts with your past decisions.
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-4 py-2.5" style={{ borderColor: 'var(--hairline)' }}>
          <span className="text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
            Preview only - nothing is saved until you file.
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onFileAll}
              disabled={!hasSignals || filing}
            >
              {filing ? 'Filing...' : 'File all to Ledger'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
