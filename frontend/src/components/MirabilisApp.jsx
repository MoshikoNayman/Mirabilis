// frontend/src/components/MirabilisApp.jsx
// Main app wrapper: tabs between Chat and InteLedger

'use client';

import { useEffect, useMemo, useState } from 'react';
import ChatApp from './ChatApp';
import IntelLedgerSession from './IntelLedgerSession';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
const APP_VERSION = '26.3R1-S25';

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

function sessionsStorageKey(userId) {
  return `mirabilis-intelledger-sessions-v1-${userId}`;
}

function readLocalSessions(userId) {
  try {
    const raw = localStorage.getItem(sessionsStorageKey(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalSessions(userId, sessions) {
  localStorage.setItem(sessionsStorageKey(userId), JSON.stringify(sessions));
}

function sessionDetailStorageKey(userId, sessionId) {
  return `mirabilis-intelledger-session-v1-${userId}-${sessionId}`;
}

function clearLocalSessionState(userId, sessionId) {
  localStorage.removeItem(sessionDetailStorageKey(userId, sessionId));
}

function seedLocalSessionState(userId, session) {
  localStorage.setItem(sessionDetailStorageKey(userId, session.id), JSON.stringify({
    session,
    interactions: [],
    signals: [],
    synthesis: null
  }));
}

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
    <div className="relative h-screen w-screen overflow-hidden">
      {/* Compact floating mode switch */}
      <div className="absolute right-3 top-3 z-40 flex items-center gap-1 rounded-full border border-black/10 bg-white/85 p-1 shadow-sm backdrop-blur dark:border-white/10 dark:bg-slate-900/80">
        <button
          onClick={() => setActiveTab('chat')}
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
            activeTab === 'chat'
              ? 'bg-accent/15 text-accent dark:bg-accent/20'
              : 'text-slate-600 hover:bg-black/5 dark:text-slate-300 dark:hover:bg-white/10'
          }`}
          title="Chat"
        >
          Chat
        </button>
        <button
          onClick={() => setActiveTab('intel')}
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
            activeTab === 'intel'
              ? 'bg-accent/15 text-accent dark:bg-accent/20'
              : 'text-slate-600 hover:bg-black/5 dark:text-slate-300 dark:hover:bg-white/10'
          }`}
          title="InteLedger"
        >
          InteLedger
        </button>
      </div>

      {/* Content area */}
      <div className="h-full w-full overflow-hidden">
        {activeTab === 'chat' && <ChatApp />}
        {activeTab === 'intel' && <IntelLedgerApp userId={userId} />}
      </div>

      {activeTab === 'intel' && (
        <footer className="pointer-events-none absolute bottom-1 left-0 right-0 text-center text-xs tracking-wide text-slate-700/90 dark:text-slate-300/90">
          Mirabilis AI by Moshiko Nayman
          <span className="mx-1.5 opacity-40">·</span>
          <span className="opacity-55">v{APP_VERSION}</span>
        </footer>
      )}
    </div>
  );
}

// InteLedger session management UI
function IntelLedgerApp({ userId }) {
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [localMode, setLocalMode] = useState(false);
  const [allowClearAll, setAllowClearAll] = useState(false);

  useEffect(() => {
    loadSessions();
  }, []);

  const activeSessionRecord = useMemo(
    () => sessions.find((session) => session.id === activeSession) || null,
    [sessions, activeSession]
  );

  const loadLocalSessions = () => {
    const localSessions = readLocalSessions(userId);
    setSessions(localSessions);
    setLocalMode(true);
  };

  const loadSessions = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/sessions?userId=${encodeURIComponent(userId)}`);
      const { sessions } = await readJsonOrThrow(res, 'Failed to load InteLedger sessions.');
      setSessions(sessions);
      setLocalMode(false);
    } catch (err) {
      loadLocalSessions();
      console.error('Failed to load sessions:', err);
    } finally {
      setLoading(false);
    }
  };

  const createSession = async () => {
    if (!newSessionTitle.trim()) return;
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          title: newSessionTitle,
          description: `Created ${new Date().toLocaleDateString()}`
        })
      });
      const { session } = await readJsonOrThrow(res, 'Failed to create InteLedger session. Ensure backend is running on port 4000.');
      setSessions([session, ...sessions]);
      setNewSessionTitle('');
      setActiveSession(session.id);
      setLocalMode(false);
    } catch (err) {
      const fallbackSession = {
        id: `local-${Date.now()}`,
        user_id: userId,
        title: newSessionTitle,
        description: `Created ${new Date().toLocaleDateString()}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      const updated = [fallbackSession, ...readLocalSessions(userId)];
      writeLocalSessions(userId, updated);
      seedLocalSessionState(userId, fallbackSession);
      setSessions(updated);
      setNewSessionTitle('');
      setActiveSession(fallbackSession.id);
      setLocalMode(true);
      console.error('Failed to create session:', err);
    }
  };

  const deleteSession = (sessionId) => {
    const updated = readLocalSessions(userId).filter((session) => session.id !== sessionId);
    writeLocalSessions(userId, updated);
    clearLocalSessionState(userId, sessionId);
    setSessions(updated);
    if (activeSession === sessionId) {
      setActiveSession(null);
    }
  };

  const clearAllSessions = () => {
    const currentSessions = readLocalSessions(userId);
    for (const session of currentSessions) {
      clearLocalSessionState(userId, session.id);
    }
    writeLocalSessions(userId, []);
    setSessions([]);
    setAllowClearAll(false);
    setActiveSession(null);
  };

  if (activeSession) {
    return <IntelLedgerSession sessionId={activeSession} userId={userId} initialSession={activeSessionRecord} localMode={localMode} onBack={() => setActiveSession(null)} />;
  }

  return (
    <main className="relative h-screen w-screen p-3 sm:p-6">
      <div className="mx-auto flex h-full max-w-7xl flex-col gap-3 rounded-3xl border border-[var(--panel-border)] bg-[var(--panel)] p-3 shadow-[0_24px_90px_-36px_rgba(15,23,42,0.45)] backdrop-blur-xl sm:gap-5 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-black/10 bg-white/70 px-4 py-3 dark:border-white/10 dark:bg-slate-900/45">
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
              Mirabilis Workspace Memory
            </div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">InteLedger</h1>
              <span className="rounded-full border border-black/10 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:border-white/10 dark:text-slate-300">
                embedded mode
              </span>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-400">A Mirabilis layer for capturing interactions, extracting signals, and revisiting them later.</p>
          </div>

          <div className="flex min-w-[18rem] flex-1 flex-wrap items-center justify-end gap-2">
            <input
              type="text"
              value={newSessionTitle}
              onChange={(e) => setNewSessionTitle(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && createSession()}
              placeholder="Name a session"
              className="min-w-[14rem] flex-1 rounded-full border border-black/10 bg-white px-4 py-2 text-sm text-slate-900 placeholder-slate-500 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-white/20 dark:bg-slate-800 dark:text-white dark:placeholder-slate-400"
            />
            <button
              onClick={createSession}
              disabled={!newSessionTitle.trim()}
              className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white shadow-[0_10px_24px_-14px_rgba(26,168,111,0.9)] transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Create
            </button>
            <button
              onClick={loadSessions}
              className="rounded-full border border-black/10 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
            >
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-red-300/70 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-auto rounded-2xl border border-black/10 bg-white/55 p-3 dark:border-white/10 dark:bg-slate-950/35 sm:p-4">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">Loading sessions...</div>
          ) : sessions.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-black/10 bg-white/40 px-6 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-slate-900/25 dark:text-slate-400">
              Create a session to start tracking recurring patterns, decisions, risks, and follow-ups.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className="group rounded-2xl border border-black/10 bg-white/85 p-4 text-left transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-[0_14px_30px_-18px_rgba(15,23,42,0.35)] dark:border-white/10 dark:bg-slate-900/65"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      Session
                    </span>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400">
                      {new Date(session.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    onClick={() => setActiveSession(session.id)}
                    className="block w-full text-left"
                  >
                    <div className="line-clamp-2 text-base font-semibold tracking-tight text-slate-900 dark:text-white">
                      {session.title}
                    </div>
                    <div className="mt-3 text-xs font-medium text-slate-500 transition group-hover:text-accent dark:text-slate-400">
                      Open workspace
                    </div>
                  </button>
                  <div className="mt-4 flex items-center justify-end">
                    <button
                      type="button"
                      onClick={() => deleteSession(session.id)}
                      className="rounded-full border border-red-300/70 px-3 py-1 text-[11px] font-semibold text-red-700 transition hover:bg-red-50 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-950/30"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {sessions.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-end gap-3 border-t border-black/10 pt-4 dark:border-white/10">
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={allowClearAll}
                  onChange={(e) => setAllowClearAll(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-black/20 text-accent focus:ring-accent/30 dark:border-white/20"
                />
                I understand this deletes all saved InteLedger sessions.
              </label>
              <button
                type="button"
                onClick={clearAllSessions}
                disabled={!allowClearAll}
                className="rounded-full border border-red-300/70 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-950/30"
              >
                Clear All
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
