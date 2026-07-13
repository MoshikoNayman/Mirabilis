// frontend/src/components/shell/RecallOrb.jsx
// Recall Orb: ask a question and get cited answers pulled from your own history -
// past chats and IntelLedger signals - ranked locally by Ollama embeddings. No
// cloud. Clicking a chat result opens that conversation.
'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal, Badge, Kbd, Spinner, RecallIcon } from '../ui/primitives';
import { appStore } from '../../store/useAppStore';
import { postJSON } from '../../lib/api';

function scorePct(score) {
  const pct = Math.round(Math.max(0, Math.min(1, Number(score) || 0)) * 100);
  return `${pct}%`;
}

export default function RecallOrb({ open, onTab }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError('');
      setSearched(false);
      setLoading(false);
    }
  }, [open]);

  async function runSearch() {
    const term = query.trim();
    if (!term || loading) return;
    setLoading(true);
    setError('');
    setSearched(true);
    try {
      // First query embeds the whole corpus locally, so allow a generous timeout.
      const payload = await postJSON('/api/recall', { query: term, limit: 6 }, { timeoutMs: 120000 });
      setResults(Array.isArray(payload?.results) ? payload.results : []);
      setModel(payload?.model || '');
    } catch (err) {
      setResults([]);
      setError(err?.message || 'Recall is unavailable right now.');
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  }

  function openResult(r) {
    if (r.source === 'chat' && r.chatId) {
      appStore.closeRecall();
      onTab?.('chat');
      try {
        window.dispatchEvent(new CustomEvent('mirabilis:open-chat', { detail: { id: r.chatId } }));
      } catch {
        /* ignore */
      }
    } else if (r.source === 'ledger' && r.sessionId) {
      appStore.closeRecall();
      onTab?.('intel');
      try {
        window.dispatchEvent(new CustomEvent('mirabilis:open-session', { detail: { id: r.sessionId } }));
      } catch {
        /* ignore */
      }
    }
  }

  return (
    <Modal open={open} onClose={() => appStore.closeRecall()} align="top" className="max-w-[620px]" labelledBy="recall-title">
      <div className="au-chrome au-hairline au-elev-3 overflow-hidden rounded-[var(--r-xl)]">
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--hairline)' }}>
          <RecallIcon size={16} className="text-[color:var(--text-muted)]" />
          <input
            id="recall-title"
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Recall from your own history..."
            className="w-full bg-transparent text-[length:var(--text-md)] text-[color:var(--text-main)] outline-none placeholder:text-[color:var(--text-muted)]"
          />
          {loading ? <Spinner /> : <Kbd>Enter</Kbd>}
        </div>

        <div className="au-scroll max-h-[56vh] overflow-y-auto p-1.5">
          {loading && (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
              <Spinner /> Searching your history locally...
            </div>
          )}

          {!loading && error && (
            <div className="px-3 py-8 text-center text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
              {error}
            </div>
          )}

          {!loading && !error && results.map((r, i) => (
            <button
              key={`${r.source}-${r.chatId || r.sessionId || 'x'}-${i}`}
              type="button"
              onClick={() => openResult(r)}
              className="au-focus flex w-full items-start gap-3 rounded-[var(--r-md)] px-3 py-2 text-left transition hover:bg-[color:var(--hairline)]"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]">{r.title}</span>
                  <Badge tone={r.source === 'ledger' ? 'warn' : 'neutral'}>{r.source === 'ledger' ? 'ledger' : 'chat'}</Badge>
                  <span className="ml-auto shrink-0 text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">{scorePct(r.score)}</span>
                </span>
                <span className="line-clamp-2 text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">{r.snippet}</span>
              </span>
            </button>
          ))}

          {!loading && !error && searched && results.length === 0 && (
            <div className="px-3 py-8 text-center text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
              Nothing in your history matched that yet.
            </div>
          )}

          {!loading && !error && !searched && (
            <div className="px-3 py-8 text-center text-[length:var(--text-sm)] text-[color:var(--text-muted)]">
              Ask a question - Recall finds cited moments from your own chats and ledger.
            </div>
          )}
        </div>

        {model ? (
          <div className="border-t px-4 py-2 text-[length:var(--text-2xs)] text-[color:var(--text-muted)]" style={{ borderColor: 'var(--hairline)' }}>
            Ranked locally with {model} - nothing left this machine.
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
