// frontend/src/components/IntelLedgerSession.jsx
// InteLedger session management UI

'use client';

import { useState, useEffect } from 'react';

export default function IntelLedgerSession({ sessionId, userId, onBack }) {
  const [session, setSession] = useState(null);
  const [interactions, setInteractions] = useState([]);
  const [signals, setSignals] = useState([]);
  const [synthesis, setSynthesis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('interactions');

  useEffect(() => {
    if (sessionId) loadSession();
  }, [sessionId]);

  const loadSession = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/intelledger/sessions/${sessionId}`);
      const { session } = await res.json();
      setSession(session);

      // Load interactions and signals
      const [intRes, sigRes] = await Promise.all([
        fetch(`/api/intelledger/sessions/${sessionId}/interactions`),
        fetch(`/api/intelledger/sessions/${sessionId}/signals`)
      ]);

      const { interactions } = await intRes.json();
      const { signals } = await sigRes.json();
      setInteractions(interactions);
      setSignals(signals);
    } finally {
      setLoading(false);
    }
  };

  const handleIngestText = async (e) => {
    const textarea = e.target.querySelector('textarea');
    const content = textarea.value;
    if (!content.trim()) return;

    setLoading(true);
    try {
      const res = await fetch(`/api/intelledger/sessions/${sessionId}/ingest/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, sourceName: 'manual_input' })
      });

      const { interaction, signals: extracted } = await res.json();
      setInteractions([interaction, ...interactions]);
      setSignals([...extracted, ...signals]);
      textarea.value = '';
    } finally {
      setLoading(false);
    }
  };

  const handleSynthesis = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/intelledger/sessions/${sessionId}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'comprehensive session analysis', synthesisType: 'pattern' })
      });

      const { synthesis } = await res.json();
      setSynthesis(synthesis);
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
    <div className="h-full w-full flex flex-col bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      {/* Header */}
      <div className="border-b border-black/10 dark:border-white/10 bg-white dark:bg-slate-800 px-6 py-4 shadow-sm">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              {onBack && (
                <button
                  onClick={onBack}
                  className="px-3 py-1 text-sm text-accent hover:bg-accent/10 rounded-lg transition"
                >
                  ← Back
                </button>
              )}
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{session.title}</h1>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              {interactions.length} interactions · {signals.length} signals extracted
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-black/10 dark:border-white/10 bg-white/50 dark:bg-slate-800/50 px-6 py-3">
        {['interactions', 'signals', 'synthesis'].map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium transition ${
              activeTab === tab
                ? 'text-accent border-b-2 border-accent'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-6xl mx-auto space-y-4">
          {activeTab === 'interactions' && (
            <div className="space-y-4">
              <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-black/10 dark:border-white/10 shadow-sm">
                <h3 className="font-bold text-slate-900 dark:text-white mb-4">Add Text Interaction</h3>
                <form onSubmit={handleIngestText} className="space-y-2">
                  <textarea
                    className="w-full p-3 border border-black/10 dark:border-white/20 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white placeholder-slate-500 dark:placeholder-slate-400 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                    rows="4"
                    placeholder="Paste interaction text here..."
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
                <h3 className="font-bold text-slate-900 dark:text-white">Interactions ({interactions.length})</h3>
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
                  <h3 className="font-bold text-slate-900 dark:text-white mb-4">
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
                    {JSON.stringify(JSON.parse(synthesis.content), null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
