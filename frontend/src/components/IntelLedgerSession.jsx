// frontend/src/components/IntelLedgerSession.jsx
// InteLedger session management UI

'use client';

import { useState, useEffect } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

async function readJsonOrThrow(res, fallbackMessage) {
  const bodyText = await res.text();
  let payload = {};
  if (bodyText) {
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new Error(fallbackMessage || `InteLedger returned a non-JSON response (${res.status}).`);
    }
  }

  if (!res.ok) {
    throw new Error(payload?.error || payload?.message || fallbackMessage || `InteLedger request failed (${res.status}).`);
  }

  return payload;
}

function sessionStorageKey(userId, sessionId) {
  return `mirabilis-intelledger-session-v1-${userId}-${sessionId}`;
}

function readLocalSessionState(userId, sessionId) {
  try {
    const raw = localStorage.getItem(sessionStorageKey(userId, sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeLocalSessionState(userId, sessionId, state) {
  localStorage.setItem(sessionStorageKey(userId, sessionId), JSON.stringify(state));
}

export default function IntelLedgerSession({ sessionId, userId, initialSession = null, localMode = false, onBack }) {
  const [session, setSession] = useState(null);
  const [interactions, setInteractions] = useState([]);
  const [signals, setSignals] = useState([]);
  const [synthesis, setSynthesis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('interactions');
  const [error, setError] = useState('');
  const [usingLocalMode, setUsingLocalMode] = useState(localMode);

  const saveLocalState = (next) => {
    writeLocalSessionState(userId, sessionId, {
      session: next.session ?? session,
      interactions: next.interactions ?? interactions,
      signals: next.signals ?? signals,
      synthesis: next.synthesis ?? synthesis
    });
  };

  const loadLocalState = (seedSession = initialSession, silent = false) => {
    const localState = readLocalSessionState(userId, sessionId);
    if (localState?.session) {
      setSession(localState.session);
      setInteractions(Array.isArray(localState.interactions) ? localState.interactions : []);
      setSignals(Array.isArray(localState.signals) ? localState.signals : []);
      setSynthesis(localState.synthesis || null);
      setUsingLocalMode(true);
      if (silent) setError('');
      return true;
    }

    const localSession = {
      id: sessionId,
      title: seedSession?.title || 'InteLedger Session',
      description: seedSession?.description || '',
      created_at: new Date().toISOString()
    };
    setSession(localSession);
    setInteractions([]);
    setSignals([]);
    setSynthesis(null);
    setUsingLocalMode(true);
    writeLocalSessionState(userId, sessionId, {
      session: localSession,
      interactions: [],
      signals: [],
      synthesis: null
    });
    if (silent) setError('');
    return true;
  };

  useEffect(() => {
    if (sessionId) loadSession();
  }, [sessionId]);

  const loadSession = async () => {
    setLoading(true);
    setError('');

    if (localMode || String(sessionId).startsWith('local-')) {
      loadLocalState(initialSession, true);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/intelledger/sessions/${sessionId}`);
      const { session } = await readJsonOrThrow(res, 'Failed to load InteLedger session details.');
      setSession(session);

      // Load interactions and signals
      const [intRes, sigRes] = await Promise.all([
        fetch(`${API_BASE}/api/intelledger/sessions/${sessionId}/interactions`),
        fetch(`${API_BASE}/api/intelledger/sessions/${sessionId}/signals`)
      ]);

      const { interactions } = await readJsonOrThrow(intRes, 'Failed to load interactions.');
      const { signals } = await readJsonOrThrow(sigRes, 'Failed to load signals.');
      setInteractions(interactions);
      setSignals(signals);
      setUsingLocalMode(false);
    } catch (err) {
      loadLocalState(initialSession, false);
      setError('');
    } finally {
      setLoading(false);
    }
  };

  const handleIngestText = async (e) => {
    e.preventDefault();
    const textarea = e.target.querySelector('textarea');
    const content = textarea.value;
    if (!content.trim()) return;

    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/sessions/${sessionId}/ingest/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, sourceName: 'manual_input' })
      });

      const { interaction, signals: extracted } = await readJsonOrThrow(res, 'Failed to ingest interaction text.');
      setInteractions([interaction, ...interactions]);
      setSignals([...extracted, ...signals]);
      textarea.value = '';
      setUsingLocalMode(false);
    } catch (err) {
      const interaction = {
        id: `local-int-${Date.now()}`,
        type: 'text',
        raw_content: content,
        source_name: 'manual_input',
        ingested_at: new Date().toISOString()
      };
      const nextInteractions = [interaction, ...interactions];
      setInteractions(nextInteractions);
      textarea.value = '';
      saveLocalState({ session: session || initialSession, interactions: nextInteractions });
      setUsingLocalMode(true);
      setError('');
    } finally {
      setLoading(false);
    }
  };

  const handleSynthesis = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/sessions/${sessionId}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'comprehensive session analysis', synthesisType: 'pattern' })
      });

      const { synthesis } = await readJsonOrThrow(res, 'Failed to generate synthesis.');
      setSynthesis(synthesis);
      setUsingLocalMode(false);
    } catch (err) {
      const fallbackSynthesis = {
        id: `local-syn-${Date.now()}`,
        content: JSON.stringify({
          mode: 'local',
          interactions: interactions.length,
          signals: signals.length,
          note: 'Backend synthesis unavailable. This summary is a local fallback.'
        }, null, 2)
      };
      setSynthesis(fallbackSynthesis);
      saveLocalState({ session: session || initialSession, synthesis: fallbackSynthesis });
      setUsingLocalMode(true);
      setError('');
    } finally {
      setLoading(false);
    }
  };

  if (!session) return <div className="p-6 text-center text-slate-500">Loading...</div>;

  const signalsByType = signals.reduce((acc, sig) => {
    (acc[sig.signal_type] = acc[sig.signal_type] || []).push(sig);
    return acc;
  }, {});

  return (
    <main className="relative h-screen w-screen p-3 sm:p-6">
      <div className="mx-auto flex h-full max-w-7xl flex-col gap-3 rounded-3xl border border-[var(--panel-border)] bg-[var(--panel)] p-3 shadow-[0_24px_90px_-36px_rgba(15,23,42,0.45)] backdrop-blur-xl sm:gap-5 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-black/10 bg-white/70 px-4 py-3 dark:border-white/10 dark:bg-slate-900/45">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              {onBack && (
                <button
                  onClick={onBack}
                  className="rounded-full border border-black/10 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
                >
                  Back
                </button>
              )}
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                Mirabilis Workspace Memory
              </span>
            </div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">{session.title}</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {interactions.length} interactions · {signals.length} signals extracted
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {['interactions', 'signals', 'synthesis'].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  activeTab === tab
                    ? 'bg-accent/15 text-accent dark:bg-accent/20'
                    : 'border border-black/10 text-slate-600 hover:bg-black/5 dark:border-white/20 dark:text-slate-300 dark:hover:bg-white/10'
                }`}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-red-300/70 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-auto rounded-2xl border border-black/10 bg-white/55 p-3 dark:border-white/10 dark:bg-slate-950/35 sm:p-4">
          <div className="mx-auto max-w-6xl space-y-4">
          {activeTab === 'interactions' && (
            <div className="space-y-4">
              <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-black/10 dark:border-white/10 shadow-sm">
                <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300">Add Interaction</h3>
                <form onSubmit={handleIngestText} className="space-y-2">
                  <textarea
                    className="w-full p-3 border border-black/10 dark:border-white/20 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white placeholder-slate-500 dark:placeholder-slate-400 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                    rows="4"
                    placeholder="Paste notes, meeting recap, or decisions..."
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    className="px-4 py-2 bg-accent text-white rounded-lg hover:brightness-95 disabled:opacity-50 font-medium transition"
                  >
                    {loading ? 'Processing...' : 'Ingest & Extract'}
                  </button>
                </form>
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300">Interactions ({interactions.length})</h3>
                {interactions.map(int => (
                  <div key={int.id} className="p-4 border border-black/10 dark:border-white/10 rounded-lg bg-white dark:bg-slate-800 shadow-sm">
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-medium mb-2">{int.type}</div>
                    <div className="line-clamp-3 text-sm text-slate-700 dark:text-slate-300">{int.raw_content}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                      {new Date(int.ingested_at).toLocaleDateString()}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'signals' && (
            <div className="space-y-4">
              {Object.entries(signalsByType).map(([type, sigs]) => (
                <div key={type} className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-black/10 dark:border-white/10 shadow-sm">
                  <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300">
                    {type.replace(/_/g, ' ').toUpperCase()} ({sigs.length})
                  </h3>
                  <div className="space-y-3">
                    {sigs.map(sig => (
                      <div key={sig.id} className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                        <div className="font-semibold text-slate-900 dark:text-white text-sm">{sig.value}</div>
                        {sig.quote && (
                          <div className="text-slate-700 dark:text-slate-300 italic text-sm mt-2">
                            "{sig.quote}"
                          </div>
                        )}
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                          Confidence: {(sig.confidence * 100).toFixed(0)}%
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'synthesis' && (
            <div className="space-y-4">
              <button
                onClick={handleSynthesis}
                disabled={loading}
                className="px-4 py-2 bg-green-500 text-white rounded-lg hover:brightness-95 disabled:opacity-50 font-medium transition"
              >
                {loading ? 'Analyzing...' : 'Generate Analysis'}
              </button>

              {synthesis && (
                <div className="bg-green-50 dark:bg-green-900/20 p-6 rounded-xl border border-green-200 dark:border-green-800">
                  <h3 className="font-bold text-slate-900 dark:text-white mb-4">Analysis Results</h3>
                  <pre className="bg-white dark:bg-slate-800 p-4 rounded-lg text-sm overflow-auto max-h-96 text-slate-700 dark:text-slate-300">
                    {(() => {
                      try {
                        return JSON.stringify(JSON.parse(synthesis.content), null, 2);
                      } catch {
                        return String(synthesis.content || '');
                      }
                    })()}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      </div>
    </main>
  );
}
