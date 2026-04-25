// frontend/src/components/MirabilisApp.jsx
// Main app wrapper: tabs between Chat and InteLedger

'use client';

import { useState } from 'react';
import ChatApp from './ChatApp';
import IntelLedgerSession from './IntelLedgerSession';

export default function MirabilisApp() {
  const [activeTab, setActiveTab] = useState('chat'); // 'chat' or 'intel'
  const [userId] = useState(() => {
    // Simple user ID generator (in production: auth)
    let id = localStorage.getItem('mirabilis-user-id');
    if (!id) {
      id = `user-${Date.now()}`;
      localStorage.setItem('mirabilis-user-id', id);
    }
    return id;
  });

  return (
    <div className="h-screen w-screen flex flex-col">
      {/* Tab bar */}
      <div className="flex items-center gap-2 border-b border-black/10 bg-white/80 px-6 py-3 dark:border-white/10 dark:bg-slate-900/50">
        <button
          onClick={() => setActiveTab('chat')}
          className={`px-4 py-2 font-medium text-sm transition ${
            activeTab === 'chat'
              ? 'text-accent border-b-2 border-accent'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          💬 Chat
        </button>
        <button
          onClick={() => setActiveTab('intel')}
          className={`px-4 py-2 font-medium text-sm transition ${
            activeTab === 'intel'
              ? 'text-accent border-b-2 border-accent'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          📊 InteLedger
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'chat' && <ChatApp />}
        {activeTab === 'intel' && <IntelLedgerApp userId={userId} />}
      </div>
    </div>
  );
}

// InteLedger session management UI
function IntelLedgerApp({ userId }) {
  const [sessions, setSessions] = useState([]);
  const [activeSes, setActiveSession] = useState(null);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [loading, setLoading] = useState(false);

  const loadSessions = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/intelledger/sessions?userId=${userId}`);
      const { sessions } = await res.json();
      setSessions(sessions);
    } catch (err) {
      console.error('Failed to load sessions:', err);
    } finally {
      setLoading(false);
    }
  };

  const createSession = async () => {
    if (!newSessionTitle.trim()) return;
    try {
      const res = await fetch('/api/intelledger/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          title: newSessionTitle,
          description: `Created ${new Date().toLocaleDateString()}`
        })
      });
      const { session } = await res.json();
      setSessions([session, ...sessions]);
      setNewSessionTitle('');
      setActiveSession(session.id);
    } catch (err) {
      console.error('Failed to create session:', err);
    }
  };

  if (activeSession) {
    return <IntelLedgerSession sessionId={activeSession} userId={userId} onBack={() => setActiveSession(null)} />;
  }

  return (
    <div className="h-full w-full p-6 bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 overflow-auto">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">InteLedger</h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">Interaction archive + AI-powered retrospective intelligence</p>
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-xl border border-black/10 dark:border-white/10 p-6 shadow-sm">
          <h2 className="font-semibold text-slate-900 dark:text-white mb-4">New Session</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={newSessionTitle}
              onChange={(e) => setNewSessionTitle(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && createSession()}
              placeholder="e.g., Account ABC Q2 Interactions"
              className="flex-1 px-4 py-2 rounded-lg border border-black/10 dark:border-white/20 bg-white dark:bg-slate-700 text-slate-900 dark:text-white placeholder-slate-500 dark:placeholder-slate-400 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <button
              onClick={createSession}
              disabled={!newSessionTitle.trim()}
              className="px-4 py-2 bg-accent text-white font-medium rounded-lg hover:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              Create
            </button>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-xl border border-black/10 dark:border-white/10 p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-900 dark:text-white">Sessions</h2>
            <button
              onClick={loadSessions}
              className="text-xs px-3 py-1 text-accent hover:bg-accent/10 rounded-lg transition"
            >
              Refresh
            </button>
          </div>

          {loading ? (
            <div className="text-center py-8 text-slate-500">Loading...</div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-8 text-slate-500">No sessions yet. Create one to get started.</div>
          ) : (
            <div className="space-y-2">
              {sessions.map(session => (
                <button
                  key={session.id}
                  onClick={() => setActiveSession(session.id)}
                  className="w-full text-left p-3 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 border border-black/10 dark:border-white/10 transition"
                >
                  <div className="font-medium text-slate-900 dark:text-white">{session.title}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Created {new Date(session.created_at).toLocaleDateString()}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
