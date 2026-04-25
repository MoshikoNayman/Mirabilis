// frontend/src/components/MirabilisApp.jsx
// Main app wrapper: tabs between Chat and InteLedger

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ChatApp from './ChatApp';
import IntelLedgerSession from './IntelLedgerSession';
import InfoHint from './ui/InfoHint';
import AppErrorBoundary from './ui/AppErrorBoundary';
import { APP_FOOTER_TEXT, APP_VERSION } from '../constants/app';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
const LAST_ACTIVE_TAB_STORAGE_KEY = 'mirabilis-last-active-tab-v1';

function safeStorageGet(key, fallback = null) {
  try {
    if (typeof window === 'undefined') return fallback;
    const value = window.localStorage.getItem(key);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function safeStorageSet(key, value) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage write failures so the UI can still render.
  }
}

function safeStorageRemove(key) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage removal failures so the UI can still render.
  }
}

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
    const raw = safeStorageGet(sessionsStorageKey(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalSessions(userId, sessions) {
  safeStorageSet(sessionsStorageKey(userId), JSON.stringify(sessions));
}

function sessionDetailStorageKey(userId, sessionId) {
  return `mirabilis-intelledger-session-v1-${userId}-${sessionId}`;
}

function clearLocalSessionState(userId, sessionId) {
  safeStorageRemove(sessionDetailStorageKey(userId, sessionId));
}

function seedLocalSessionState(userId, session) {
  safeStorageSet(sessionDetailStorageKey(userId, session.id), JSON.stringify({
    session,
    interactions: [],
    signals: [],
    synthesis: null
  }));
}

function defaultSessionTitle(value) {
  const trimmed = String(value || '').trim();
  return trimmed || 'Untitled';
}

function normalizeSessionPreviewText(session) {
  const raw = String(session?.topic_preview || session?.description || '').replace(/\s+/g, ' ').trim();
  // Hide legacy auto-generated placeholders that start with "Created ...".
  if (/^created\b/i.test(raw)) {
    return '';
  }
  return raw;
}

function sessionPreview(session) {
  const preview = normalizeSessionPreviewText(session);
  if (preview) return preview;
  return '';
}

function sessionInsights(session) {
  const interactions = Number(session?.interaction_count || 0);
  const signals = Number(session?.signal_count || 0);
  const syntheses = Number(session?.synthesis_count || 0);
  const activityCount = Number(session?.activity_count || (interactions + signals + syntheses));
  const sourceText = normalizeSessionPreviewText(session);
  const wordCount = sourceText ? sourceText.split(/\s+/).filter(Boolean).length : 0;

  const parts = [];
  if (interactions > 0) {
    parts.push(`${interactions} ${interactions === 1 ? 'message' : 'messages'}`);
  }
  if (signals > 0) {
    parts.push(`${signals} ${signals === 1 ? 'signal' : 'signals'}`);
  }
  if (syntheses > 0) {
    parts.push(`${syntheses} ${syntheses === 1 ? 'summary' : 'summaries'}`);
  }
  if (wordCount > 0) {
    parts.push(`~${wordCount} preview words`);
  }

  if (parts.length > 0) {
    return parts.join(' • ');
  }

  return '';
}

function textContainsQuery(value, query) {
  const source = String(value || '').toLowerCase();
  return source.includes(query);
}

export default function MirabilisApp() {
  const [activeTab, setActiveTab] = useState(() => {
    const saved = safeStorageGet(LAST_ACTIVE_TAB_STORAGE_KEY, 'chat');
    return saved === 'intel' ? 'intel' : 'chat';
  }); // 'chat' or 'intel'
  const [userId] = useState(() => {
    // Simple user ID generator (in production: auth)
    let id = safeStorageGet('mirabilis-user-id');
    if (!id) {
      id = `user-${Date.now()}`;
      safeStorageSet('mirabilis-user-id', id);
    }
    return id;
  });

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      {/* Compact floating mode switch */}
      <div className="absolute right-3 top-3 z-40 flex items-center gap-1 rounded-full border border-black/10 bg-white/85 p-1 shadow-sm backdrop-blur dark:border-white/10 dark:bg-slate-900/80">
        <button
          onClick={() => {
            setActiveTab('chat');
            safeStorageSet(LAST_ACTIVE_TAB_STORAGE_KEY, 'chat');
          }}
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
          onClick={() => {
            setActiveTab('intel');
            safeStorageSet(LAST_ACTIVE_TAB_STORAGE_KEY, 'intel');
          }}
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
        {activeTab === 'chat' && (
          <AppErrorBoundary>
            <ChatApp />
          </AppErrorBoundary>
        )}
        {activeTab === 'intel' && (
          <AppErrorBoundary>
            <IntelLedgerApp userId={userId} />
          </AppErrorBoundary>
        )}
      </div>

      {activeTab === 'intel' && (
        <footer className="pointer-events-none absolute bottom-1 left-0 right-0 text-center text-xs tracking-wide text-slate-700/90 dark:text-slate-300/90">
          {APP_FOOTER_TEXT}
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
  const [semanticSessions, setSemanticSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [createBubbleOpen, setCreateBubbleOpen] = useState(false);
  const createBubbleRef = useRef(null);
  const [searchQuery, setSearchQuery] = useState('');
  const cardDensity = 'dense';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [localMode, setLocalMode] = useState(false);
  const [searching, setSearching] = useState(false);
  const [allowClearAll, setAllowClearAll] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState(new Set());
  const [crossSynthesis, setCrossSynthesis] = useState(null); // { loading, result, error, sessionCount }
  const [todayDigest, setTodayDigest] = useState(null);
  const [digestLoading, setDigestLoading] = useState(false);
  const [auditOverview, setAuditOverview] = useState(null);
  const [auditTenantRollup, setAuditTenantRollup] = useState([]);
  const [auditOverviewLoading, setAuditOverviewLoading] = useState(false);
  const [auditLastUpdatedAt, setAuditLastUpdatedAt] = useState('');
  const [promptProfiles, setPromptProfiles] = useState([]);
  const [promptProfilesLoading, setPromptProfilesLoading] = useState(false);
  const [activePromptProfileId, setActivePromptProfileId] = useState('');
  const [promptProfileDetail, setPromptProfileDetail] = useState(null);
  const [promptDetailLoading, setPromptDetailLoading] = useState(false);
  const [promptMutationLoading, setPromptMutationLoading] = useState(false);
  const [promptRegistryError, setPromptRegistryError] = useState('');
  const [newPromptVersion, setNewPromptVersion] = useState({
    version_id: '',
    label: '',
    system_prompt: '',
    user_template: '',
    set_active: true
  });

  const toggleSelect = (id) => {
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedSessions(new Set(filteredSessions.map((s) => s.id)));
  const deselectAll = () => setSelectedSessions(new Set());

  const bulkDelete = () => {
    const ids = [...selectedSessions];
    const updated = readLocalSessions(userId).filter((s) => !ids.includes(s.id));
    for (const id of ids) clearLocalSessionState(userId, id);
    writeLocalSessions(userId, updated);
    setSessions(updated);
    if (ids.includes(activeSession)) setActiveSession(null);
    setSelectedSessions(new Set());
  };

  const bulkSynthesize = async () => {
    const ids = [...selectedSessions];
    setCrossSynthesis({ loading: true, result: null, error: null, sessionCount: ids.length });
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/sessions/cross-synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ids, query: 'Find recurring patterns, shared risks, and a unified action plan.' })
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'Cross-synthesis failed');
      setCrossSynthesis({
        loading: false,
        result: payload.synthesis,
        error: null,
        sessionCount: ids.length,
        promptProfile: payload.prompt_profile || null,
        promptVersion: payload.prompt_version || null
      });
    } catch (err) {
      setCrossSynthesis({ loading: false, result: null, error: err.message, sessionCount: ids.length });
    }
  };

  const loadTodayDigest = async (sourceSessions = sessions) => {
    const ids = (Array.isArray(sourceSessions) ? sourceSessions : []).map((item) => item.id).filter(Boolean);
    if (!ids.length) {
      setTodayDigest(null);
      return;
    }
    setDigestLoading(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/intelledger/sessions/brief?userId=${encodeURIComponent(userId)}&sessionIds=${encodeURIComponent(ids.join(','))}`
      );
      if (!res.ok) throw new Error('Failed to load digest');
      const payload = await res.json();
      setTodayDigest(payload?.brief || null);
    } catch {
      setTodayDigest(null);
    } finally {
      setDigestLoading(false);
    }
  };

  const loadAuditOverview = async () => {
    if (!userId) {
      setAuditOverview(null);
      setAuditTenantRollup([]);
      return;
    }

    setAuditOverviewLoading(true);
    try {
      const [summaryRes, trendsRes, tenantRes] = await Promise.all([
        fetch(`${API_BASE}/api/intelledger/audit/summary?userId=${encodeURIComponent(userId)}&since_hours=168&limit=2000`),
        fetch(`${API_BASE}/api/intelledger/audit/trends?userId=${encodeURIComponent(userId)}`),
        fetch(`${API_BASE}/api/intelledger/audit/trends/tenants?userId=${encodeURIComponent(userId)}&topN=10`)
      ]);

      const [summaryPayload, trendsPayload, tenantPayload] = await Promise.all([
        readJsonOrThrow(summaryRes, 'Failed to load audit summary.'),
        readJsonOrThrow(trendsRes, 'Failed to load audit trends.'),
        readJsonOrThrow(tenantRes, 'Failed to load tenant audit trends.')
      ]);

      setAuditOverview({
        summary: summaryPayload?.summary || null,
        trends: trendsPayload?.trends || null
      });
      setAuditTenantRollup(Array.isArray(tenantPayload?.rollup) ? tenantPayload.rollup : []);
      setAuditLastUpdatedAt(new Date().toISOString());
    } catch {
      setAuditOverview(null);
      setAuditTenantRollup([]);
    } finally {
      setAuditOverviewLoading(false);
    }
  };

  const loadPromptProfiles = async () => {
    setPromptProfilesLoading(true);
    setPromptRegistryError('');
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/prompts/profiles`);
      const payload = await readJsonOrThrow(res, 'Failed to load prompt profiles.');
      const rows = Array.isArray(payload?.profiles) ? payload.profiles : [];
      setPromptProfiles(rows);
      setActivePromptProfileId((prev) => {
        if (prev && rows.some((item) => item.profile_id === prev)) return prev;
        return rows[0]?.profile_id || '';
      });
      if (!rows.length) {
        setPromptProfileDetail(null);
      }
    } catch (err) {
      setPromptProfiles([]);
      setPromptProfileDetail(null);
      setPromptRegistryError(err?.message || 'Prompt registry unavailable.');
    } finally {
      setPromptProfilesLoading(false);
    }
  };

  const loadPromptProfileDetail = async (profileId) => {
    if (!profileId) {
      setPromptProfileDetail(null);
      return;
    }

    setPromptDetailLoading(true);
    setPromptRegistryError('');
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/prompts/profiles/${encodeURIComponent(profileId)}`);
      const payload = await readJsonOrThrow(res, 'Failed to load prompt profile detail.');
      setPromptProfileDetail(payload?.profile || null);
    } catch (err) {
      setPromptProfileDetail(null);
      setPromptRegistryError(err?.message || 'Failed to load prompt profile detail.');
    } finally {
      setPromptDetailLoading(false);
    }
  };

  const createPromptVersion = async () => {
    if (!activePromptProfileId) return;
    setPromptMutationLoading(true);
    setPromptRegistryError('');
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/prompts/profiles/${encodeURIComponent(activePromptProfileId)}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version_id: String(newPromptVersion.version_id || '').trim() || undefined,
          label: String(newPromptVersion.label || '').trim() || undefined,
          system_prompt: String(newPromptVersion.system_prompt || ''),
          user_template: String(newPromptVersion.user_template || ''),
          set_active: Boolean(newPromptVersion.set_active),
          created_by: 'frontend-ui'
        })
      });
      await readJsonOrThrow(res, 'Failed to create prompt version.');

      setNewPromptVersion((prev) => ({
        ...prev,
        version_id: '',
        label: ''
      }));

      await Promise.all([
        loadPromptProfiles(),
        loadPromptProfileDetail(activePromptProfileId)
      ]);
    } catch (err) {
      setPromptRegistryError(err?.message || 'Failed to create prompt version.');
    } finally {
      setPromptMutationLoading(false);
    }
  };

  const selectPromptVersion = async (profileId, versionId) => {
    if (!profileId || !versionId) return;
    setPromptMutationLoading(true);
    setPromptRegistryError('');
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/prompts/profiles/${encodeURIComponent(profileId)}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: versionId })
      });
      await readJsonOrThrow(res, 'Failed to activate prompt version.');
      await Promise.all([
        loadPromptProfiles(),
        loadPromptProfileDetail(profileId)
      ]);
    } catch (err) {
      setPromptRegistryError(err?.message || 'Failed to activate prompt version.');
    } finally {
      setPromptMutationLoading(false);
    }
  };

  const bulkExport = async () => {
    const ids = [...selectedSessions];
    const sessionNames = sessions.filter((s) => ids.includes(s.id)).map((s) => s.title);
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const [sigRes, actRes] = await Promise.all([
            fetch(`${API_BASE}/api/intelledger/sessions/${encodeURIComponent(id)}/signals`),
            fetch(`${API_BASE}/api/intelledger/sessions/${encodeURIComponent(id)}/actions`)
          ]);
          const [sig, act] = await Promise.all([sigRes.json(), actRes.json()]);
          const session = sessions.find((s) => s.id === id);
          return { id, title: session?.title, signals: sig?.signals || [], actions: act?.actions || [] };
        } catch { return { id, title: id, signals: [], actions: [] }; }
      })
    );
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), sessions: results }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `intelledger-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    loadSessions();
  }, []);

  useEffect(() => {
    if (!createBubbleOpen) return;

    const handlePointerDown = (event) => {
      if (createBubbleRef.current && !createBubbleRef.current.contains(event.target)) {
        setCreateBubbleOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setCreateBubbleOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [createBubbleOpen]);

  useEffect(() => {
    if (!activePromptProfileId || localMode) return;
    loadPromptProfileDetail(activePromptProfileId);
  }, [activePromptProfileId, localMode]);

  const activeSessionRecord = useMemo(
    () => sessions.find((session) => session.id === activeSession) || null,
    [sessions, activeSession]
  );

  const filteredSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sessions;
    if (semanticSessions.length > 0) return semanticSessions;
    return sessions.filter((session) => {
      const haystack = [
        session.title,
        session.description,
        session.topic_preview
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [sessions, searchQuery, semanticSessions]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSemanticSessions([]);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `${API_BASE}/api/intelledger/sessions/search?userId=${encodeURIComponent(userId)}&query=${encodeURIComponent(query)}`,
          { signal: controller.signal }
        );
        if (res.ok) {
          const payload = await readJsonOrThrow(res, 'Failed to run InteLedger semantic search.');
          setSemanticSessions(Array.isArray(payload?.sessions) ? payload.sessions : []);
          return;
        }

        // Fallback: deep client-side content search across interactions when semantic endpoint is unavailable.
        const loweredQuery = query.toLowerCase();
        const matches = await Promise.all(sessions.map(async (session) => {
          if (
            textContainsQuery(session.title, loweredQuery) ||
            textContainsQuery(session.description, loweredQuery) ||
            textContainsQuery(session.topic_preview, loweredQuery)
          ) {
            return session;
          }

          try {
            const interactionsRes = await fetch(
              `${API_BASE}/api/intelledger/sessions/${encodeURIComponent(session.id)}/interactions`,
              { signal: controller.signal }
            );
            if (!interactionsRes.ok) return null;
            const interactionsPayload = await interactionsRes.json();
            const interactions = Array.isArray(interactionsPayload?.interactions) ? interactionsPayload.interactions : [];
            const hit = interactions.some((item) => textContainsQuery(item?.raw_content, loweredQuery));
            return hit ? session : null;
          } catch {
            return null;
          }
        }));

        setSemanticSessions(matches.filter(Boolean));
      } catch (err) {
        if (err?.name !== 'AbortError') {
          console.warn('InteLedger semantic search unavailable, using local metadata fallback.');
          setSemanticSessions([]);
        }
      } finally {
        setSearching(false);
      }
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery, userId, sessions]);

  const loadLocalSessions = () => {
    const localSessions = readLocalSessions(userId);
    setSessions(localSessions);
    setTodayDigest(null);
    setAuditOverview(null);
    setAuditTenantRollup([]);
    setAuditLastUpdatedAt('');
    setPromptProfiles([]);
    setActivePromptProfileId('');
    setPromptProfileDetail(null);
    setPromptRegistryError('');
    setLocalMode(true);
  };

  const loadSessions = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/sessions?userId=${encodeURIComponent(userId)}`);
      const { sessions } = await readJsonOrThrow(res, 'Failed to load InteLedger sessions.');
      setSessions(sessions);
      await Promise.all([
        loadTodayDigest(sessions),
        loadAuditOverview(),
        loadPromptProfiles()
      ]);
      setSemanticSessions([]);
      setLocalMode(false);
    } catch (err) {
      loadLocalSessions();
      console.error('Failed to load sessions:', err);
    } finally {
      setLoading(false);
    }
  };

  const createSession = async () => {
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          title: defaultSessionTitle(newSessionTitle),
          description: ''
        })
      });
      const { session } = await readJsonOrThrow(res, 'Failed to create InteLedger session. Ensure backend is running on port 4000.');
      setSessions([session, ...sessions]);
      setNewSessionTitle('');
      setCreateBubbleOpen(false);
      setActiveSession(session.id);
      setLocalMode(false);
    } catch (err) {
      const fallbackSession = {
        id: `local-${Date.now()}`,
        user_id: userId,
        title: defaultSessionTitle(newSessionTitle),
        description: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      const updated = [fallbackSession, ...readLocalSessions(userId)];
      writeLocalSessions(userId, updated);
      seedLocalSessionState(userId, fallbackSession);
      setSessions(updated);
      setNewSessionTitle('');
      setCreateBubbleOpen(false);
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

  const handleSessionUpdate = (updatedSession) => {
    if (!updatedSession?.id) return;
    setSessions((previous) => previous.map((session) => (
      session.id === updatedSession.id ? { ...session, ...updatedSession } : session
    )));
  };

  if (activeSession) {
    return (
      <IntelLedgerSession
        sessionId={activeSession}
        userId={userId}
        initialSession={activeSessionRecord}
        localMode={localMode}
        onSessionUpdate={handleSessionUpdate}
        onBack={() => {
          setActiveSession(null);
          loadSessions();
        }}
      />
    );
  }

  return (
    <>
    <main className="relative h-full w-full p-3 sm:p-4">
      <div className="mx-auto flex h-full min-h-0 max-w-7xl flex-col gap-3 rounded-3xl border border-[var(--panel-border)] bg-[var(--panel)] p-3 shadow-[0_24px_90px_-36px_rgba(15,23,42,0.45)] backdrop-blur-xl sm:gap-4 sm:p-4">
        <div className="grid gap-3 rounded-2xl border border-black/10 bg-white/70 px-4 py-3 dark:border-white/10 dark:bg-slate-900/45 lg:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
          <div className="space-y-2">
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                Mirabilis Workspace Memory
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-white">InteLedger</h1>
                <span className="rounded-full border border-black/10 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:border-white/10 dark:text-slate-300">
                  embedded mode
                </span>
              </div>
              <p className="text-xs leading-5 text-slate-600 dark:text-slate-400">
                Capture context, extract signals, and move to next actions quickly.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-full border border-black/10 bg-white/75 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:border-white/10 dark:bg-slate-900/45 dark:text-slate-300">Session</span>
              <span className="rounded-full border border-black/10 bg-white/75 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:border-white/10 dark:bg-slate-900/45 dark:text-slate-300">Ingest</span>
              <span className="rounded-full border border-black/10 bg-white/75 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:border-white/10 dark:bg-slate-900/45 dark:text-slate-300">Extract</span>
              <span className="rounded-full border border-black/10 bg-white/75 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:border-white/10 dark:bg-slate-900/45 dark:text-slate-300">Synthesis</span>
              <InfoHint
                title="InteLedger Quick Guide"
                description="Short definitions. Keep each session focused on one topic."
                triggerClassName="bg-white/75 px-2 py-0.5 text-[10px] font-medium text-slate-600 hover:border-black/10 hover:text-slate-600 dark:border-white/10 dark:bg-slate-900/45 dark:text-slate-300 dark:hover:border-white/10 dark:hover:text-slate-300"
                points={[
                  'Session',
                  'Ingest',
                  'Extract',
                  'Synthesis'
                ]}
              />
            </div>
          </div>

          <div className="self-start">
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search sessions"
                className="min-w-0 flex-1 rounded-full border border-black/10 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder-slate-500 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-white/20 dark:bg-slate-800 dark:text-white dark:placeholder-slate-400"
              />
              {searching ? (
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400">
                  searching...
                </span>
              ) : null}
              <button
                onClick={loadSessions}
                className="shrink-0 rounded-full border border-black/10 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
              >
                Refresh
              </button>

              <div ref={createBubbleRef} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setCreateBubbleOpen((prev) => !prev)}
                  className="rounded-full bg-accent px-3 py-1.5 text-[11px] font-semibold text-white shadow-[0_10px_24px_-14px_rgba(26,168,111,0.9)] transition hover:brightness-95"
                >
                  New Session
                </button>

                {createBubbleOpen && (
                  <div className="absolute right-0 top-[calc(100%+0.45rem)] z-30 w-[min(19rem,86vw)] rounded-2xl border border-black/10 bg-white p-2.5 shadow-lg dark:border-white/15 dark:bg-slate-900">
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                      Optional title
                    </div>
                    <input
                      type="text"
                      value={newSessionTitle}
                      onChange={(e) => setNewSessionTitle(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && createSession()}
                      placeholder="Leave blank for Untitled"
                      className="w-full rounded-full border border-black/10 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder-slate-500 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-white/20 dark:bg-slate-800 dark:text-white dark:placeholder-slate-400"
                      autoFocus
                    />
                    <div className="mt-1.5 flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setCreateBubbleOpen(false);
                          setNewSessionTitle('');
                        }}
                        className="rounded-full border border-black/10 px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={createSession}
                        className="rounded-full bg-accent px-2.5 py-1 text-[11px] font-semibold text-white shadow-[0_10px_24px_-14px_rgba(26,168,111,0.9)] transition hover:brightness-95"
                      >
                        Create
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 grid gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
        <div className="min-h-0 overflow-auto space-y-3 lg:col-start-2">

        {!localMode && (digestLoading || todayDigest) && (
          <div className="rounded-2xl border border-black/10 bg-white/75 px-4 py-3 dark:border-white/10 dark:bg-slate-900/45">
            {digestLoading ? (
              <div className="text-xs text-slate-500 dark:text-slate-400">Loading today digest...</div>
            ) : todayDigest && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Sessions {todayDigest.session_count || 0}</span>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Open {todayDigest.open_actions || 0}</span>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Overdue {todayDigest.overdue_actions || 0}</span>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Due today {todayDigest.due_today_actions || 0}</span>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Blocked {todayDigest.blocked_actions || 0}</span>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">New notes (24h) {todayDigest.new_interactions_24h || 0}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSelectedSessions(new Set(todayDigest.overdue_session_ids || []))}
                    className="rounded-full border border-amber-300/70 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 transition hover:brightness-95 dark:border-amber-500/30 dark:bg-amber-900/20 dark:text-amber-300"
                  >
                    Select overdue sessions
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const ids = todayDigest.attention_session_ids || [];
                      if (!ids.length) return;
                      setSelectedSessions(new Set(ids));
                      setCrossSynthesis({ loading: true, result: null, error: null, sessionCount: ids.length });
                      try {
                        const res = await fetch(`${API_BASE}/api/intelledger/sessions/cross-synthesize`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ sessionIds: ids, query: 'Prioritize urgent risks, blockers, and next actions for today.' })
                        });
                        const payload = await res.json();
                        if (!res.ok) throw new Error(payload?.error || 'Cross-synthesis failed');
                        setCrossSynthesis({
                          loading: false,
                          result: payload.synthesis,
                          error: null,
                          sessionCount: ids.length,
                          promptProfile: payload.prompt_profile || null,
                          promptVersion: payload.prompt_version || null
                        });
                      } catch (err) {
                        setCrossSynthesis({ loading: false, result: null, error: err.message, sessionCount: ids.length });
                      }
                    }}
                    className="rounded-full border border-black/10 px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
                  >
                    Synthesize attention sessions
                  </button>
                  {(todayDigest.top_overdue_sessions || []).slice(0, 4).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveSession(item.id)}
                      className="rounded-full border border-black/10 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600 transition hover:border-accent/40 hover:text-accent dark:border-white/10 dark:bg-slate-800 dark:text-slate-300"
                    >
                      {item.title} ({item.count})
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {!localMode && (auditOverviewLoading || auditOverview) && (
          <div className="rounded-2xl border border-black/10 bg-white/75 px-4 py-3 dark:border-white/10 dark:bg-slate-900/45">
            {auditOverviewLoading ? (
              <div className="text-xs text-slate-500 dark:text-slate-400">Loading audit overview...</div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Audit overview</span>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Events 24h {auditOverview?.trends?.event_count_24h || 0}</span>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Events 7d {auditOverview?.trends?.event_count_7d || 0}</span>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Events 30d {auditOverview?.trends?.event_count_30d || 0}</span>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Event types (7d) {(auditOverview?.summary?.event_types || []).length}</span>
                  {auditLastUpdatedAt ? (
                    <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">
                      Updated {new Date(auditLastUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  ) : null}
                </div>

                <div className="grid gap-2 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                  <div className="rounded-xl border border-black/10 bg-white/70 px-3 py-2 dark:border-white/10 dark:bg-slate-900/35">
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">7-day trend</div>
                    {Array.isArray(auditOverview?.trends?.daily_7) && auditOverview.trends.daily_7.length > 0 ? (
                      <div>
                        <div className="flex h-14 items-end gap-1">
                          {auditOverview.trends.daily_7.map((bucket) => {
                            const maxCount = Math.max(...auditOverview.trends.daily_7.map((item) => Number(item.count || 0)), 1);
                            const height = Math.max(3, Math.round((Number(bucket.count || 0) / maxCount) * 100));
                            return (
                              <div
                                key={bucket.date}
                                title={`${bucket.date}: ${bucket.count}`}
                                className="flex-1 rounded-sm bg-accent/50"
                                style={{ height: `${height}%` }}
                              />
                            );
                          })}
                        </div>
                        <div className="mt-1 flex justify-between text-[10px] text-slate-400">
                          <span>{auditOverview.trends.daily_7[0]?.date?.slice(5) || ''}</span>
                          <span>today</span>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500 dark:text-slate-400">No trend data available yet.</div>
                    )}
                  </div>

                  <div className="rounded-xl border border-black/10 bg-white/70 px-3 py-2 dark:border-white/10 dark:bg-slate-900/35">
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Top event types (24h)</div>
                    {Array.isArray(auditOverview?.trends?.top_types_24h) && auditOverview.trends.top_types_24h.length > 0 ? (
                      <ul className="space-y-1">
                        {auditOverview.trends.top_types_24h.slice(0, 5).map((item) => (
                          <li key={item.event_type} className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="truncate text-slate-600 dark:text-slate-300">{String(item.event_type || '').replace(/\./g, ' › ')}</span>
                            <span className="font-semibold text-slate-700 dark:text-slate-200">{item.count}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-xs text-slate-500 dark:text-slate-400">No events in the last 24h.</div>
                    )}
                  </div>
                </div>

                {auditTenantRollup.length > 0 && (
                  <div className="rounded-xl border border-black/10 bg-white/70 px-3 py-2 dark:border-white/10 dark:bg-slate-900/35">
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Tenant audit rollup</div>
                    <div className="space-y-2">
                      {(() => {
                        const topTenants = auditTenantRollup.slice(0, 5);
                        const max30d = Math.max(...topTenants.map((item) => Number(item.count_30d || 0)), 1);
                        return topTenants.map((tenant) => {
                          const widthPct = Math.max(4, Math.round((Number(tenant.count_30d || 0) / max30d) * 100));
                          return (
                            <div key={tenant.tenant_id || 'tenant'} className="rounded-lg border border-black/10 bg-white/80 px-2.5 py-2 dark:border-white/10 dark:bg-slate-800/40">
                              <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                                <span className="truncate font-medium">{tenant.tenant_id || 'tenant'}</span>
                                <span>30d {tenant.count_30d || 0}</span>
                              </div>
                              <div className="mb-1.5 h-1.5 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                                <div className="h-full rounded-full bg-accent/65" style={{ width: `${widthPct}%` }} />
                              </div>
                              <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
                                <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">24h {tenant.count_24h || 0}</span>
                                <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">7d {tenant.count_7d || 0}</span>
                                {(tenant.top_types || []).slice(0, 2).map((type) => (
                                  <span key={`${tenant.tenant_id}-${type.event_type}`} className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">
                                    {String(type.event_type || '').replace(/\./g, ' › ')} ({type.count || 0})
                                  </span>
                                ))}
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {!localMode && (promptProfilesLoading || promptProfiles.length > 0 || promptRegistryError) && (
          <div className="rounded-2xl border border-black/10 bg-white/75 px-4 py-3 dark:border-white/10 dark:bg-slate-900/45">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                Prompt Registry
              </div>
              <button
                type="button"
                onClick={() => {
                  loadPromptProfiles();
                  if (activePromptProfileId) loadPromptProfileDetail(activePromptProfileId);
                }}
                disabled={promptProfilesLoading || promptDetailLoading || promptMutationLoading}
                className="rounded-full border border-black/10 px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
              >
                Refresh prompts
              </button>
            </div>

            {promptRegistryError && (
              <div className="mb-3 rounded-xl border border-red-300/70 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/40 dark:bg-red-950/30 dark:text-red-300">
                {promptRegistryError}
              </div>
            )}

            {promptProfilesLoading ? (
              <div className="text-xs text-slate-500 dark:text-slate-400">Loading prompt profiles...</div>
            ) : promptProfiles.length === 0 ? (
              <div className="text-xs text-slate-500 dark:text-slate-400">No prompt profiles available.</div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-[minmax(14rem,0.7fr)_minmax(0,1.3fr)]">
                <div className="space-y-2">
                  {promptProfiles.map((profile) => {
                    const isActive = profile.profile_id === activePromptProfileId;
                    return (
                      <button
                        key={profile.profile_id}
                        type="button"
                        onClick={() => setActivePromptProfileId(profile.profile_id)}
                        className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                          isActive
                            ? 'border-accent/50 bg-accent/10'
                            : 'border-black/10 bg-white/60 hover:border-accent/30 dark:border-white/10 dark:bg-slate-900/35'
                        }`}
                      >
                        <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">{profile.profile_id}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                          Active {profile.active_label || profile.active_version_id || 'fallback'}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-400">Versions {profile.version_count || 0}</div>
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-3 rounded-xl border border-black/10 bg-white/60 px-3 py-3 dark:border-white/10 dark:bg-slate-900/35">
                  {promptDetailLoading ? (
                    <div className="text-xs text-slate-500 dark:text-slate-400">Loading profile details...</div>
                  ) : !promptProfileDetail ? (
                    <div className="text-xs text-slate-500 dark:text-slate-400">Select a profile to view versions.</div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                        <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Profile {promptProfileDetail.profile_id}</span>
                        <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Active {promptProfileDetail.active_version_id || 'fallback'}</span>
                      </div>

                      <div className="space-y-1.5">
                        {(promptProfileDetail.versions || []).map((version) => {
                          const selected = version.id === promptProfileDetail.active_version_id;
                          return (
                            <div key={version.id} className="rounded-lg border border-black/10 bg-white/70 px-2.5 py-2 dark:border-white/10 dark:bg-slate-800/40">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-100">{version.label || version.id}</div>
                                  <div className="text-[10px] text-slate-500 dark:text-slate-400">{version.id}</div>
                                </div>
                                <button
                                  type="button"
                                  disabled={selected || promptMutationLoading}
                                  onClick={() => selectPromptVersion(promptProfileDetail.profile_id, version.id)}
                                  className={`rounded-full px-2.5 py-1 text-[10px] font-semibold transition ${
                                    selected
                                      ? 'border border-accent/40 bg-accent/15 text-accent'
                                      : 'border border-black/10 text-slate-700 hover:bg-black/5 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10'
                                  } disabled:opacity-50`}
                                >
                                  {selected ? 'Active' : 'Activate'}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                        {(promptProfileDetail.versions || []).length === 0 && (
                          <div className="text-xs text-slate-500 dark:text-slate-400">No stored versions yet (using fallback default).</div>
                        )}
                      </div>

                      <div className="rounded-xl border border-black/10 bg-white/75 px-3 py-3 dark:border-white/10 dark:bg-slate-800/40">
                        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Create version</div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <input
                            type="text"
                            value={newPromptVersion.version_id}
                            onChange={(e) => setNewPromptVersion((prev) => ({ ...prev, version_id: e.target.value }))}
                            placeholder="version_id (optional)"
                            className="rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-500 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-white/20 dark:bg-slate-900 dark:text-white"
                          />
                          <input
                            type="text"
                            value={newPromptVersion.label}
                            onChange={(e) => setNewPromptVersion((prev) => ({ ...prev, label: e.target.value }))}
                            placeholder="label"
                            className="rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-500 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-white/20 dark:bg-slate-900 dark:text-white"
                          />
                        </div>
                        <textarea
                          value={newPromptVersion.system_prompt}
                          onChange={(e) => setNewPromptVersion((prev) => ({ ...prev, system_prompt: e.target.value }))}
                          placeholder="system_prompt"
                          rows={3}
                          className="mt-2 w-full rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-500 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-white/20 dark:bg-slate-900 dark:text-white"
                        />
                        <textarea
                          value={newPromptVersion.user_template}
                          onChange={(e) => setNewPromptVersion((prev) => ({ ...prev, user_template: e.target.value }))}
                          placeholder="user_template"
                          rows={4}
                          className="mt-2 w-full rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-500 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-white/20 dark:bg-slate-900 dark:text-white"
                        />
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                          <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300">
                            <input
                              type="checkbox"
                              checked={newPromptVersion.set_active}
                              onChange={(e) => setNewPromptVersion((prev) => ({ ...prev, set_active: e.target.checked }))}
                              className="h-3.5 w-3.5 rounded border-black/20 text-accent focus:ring-accent/30 dark:border-white/20"
                            />
                            Set active after create
                          </label>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                const current = promptProfileDetail?.active;
                                if (!current) return;
                                setNewPromptVersion((prev) => ({
                                  ...prev,
                                  system_prompt: String(current.system_prompt || ''),
                                  user_template: String(current.user_template || ''),
                                  label: prev.label || `${current.label || current.id} copy`
                                }));
                              }}
                              className="rounded-full border border-black/10 px-2.5 py-1 text-[10px] font-semibold text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
                            >
                              Seed from active
                            </button>
                            <button
                              type="button"
                              onClick={createPromptVersion}
                              disabled={promptMutationLoading}
                              className="rounded-full bg-accent px-2.5 py-1 text-[10px] font-semibold text-white transition hover:brightness-95 disabled:opacity-50"
                            >
                              {promptMutationLoading ? 'Saving...' : 'Create version'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        </div>

        <div className="min-h-0 flex flex-col gap-3 lg:col-start-1 lg:row-start-1">

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
          ) : filteredSessions.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-black/10 bg-white/40 px-6 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-slate-900/25 dark:text-slate-400">
              No sessions match your search.
            </div>
          ) : (
            <>
            {selectedSessions.size > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-accent/30 bg-accent/5 px-4 py-2.5 dark:border-accent/20 dark:bg-accent/10">
                <span className="mr-1 text-xs font-semibold text-accent">{selectedSessions.size} session{selectedSessions.size !== 1 ? 's' : ''} selected</span>
                <button
                  type="button"
                  onClick={bulkSynthesize}
                  disabled={crossSynthesis?.loading}
                  className="rounded-full bg-accent px-2.5 py-1 text-[11px] font-semibold text-white shadow-[0_8px_18px_-10px_rgba(26,168,111,0.8)] transition hover:brightness-95 disabled:opacity-50"
                >
                  {crossSynthesis?.loading ? 'Analyzing…' : `Synthesize ${selectedSessions.size}`}
                </button>
                <button
                  type="button"
                  onClick={bulkExport}
                  className="rounded-full border border-black/10 px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
                >
                  Export JSON
                </button>
                <button
                  type="button"
                  onClick={selectedSessions.size === filteredSessions.length ? deselectAll : selectAll}
                  className="rounded-full border border-black/10 px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
                >
                  {selectedSessions.size === filteredSessions.length ? 'Deselect all' : 'Select all'}
                </button>
                <button
                  type="button"
                  onClick={bulkDelete}
                  className="rounded-full border border-red-300/70 px-2.5 py-1 text-[11px] font-semibold text-red-700 transition hover:bg-red-50 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-950/30"
                >
                  Delete {selectedSessions.size}
                </button>
                <button
                  type="button"
                  onClick={deselectAll}
                  className="ml-auto rounded-full border border-black/10 px-2.5 py-1 text-[11px] font-semibold text-slate-500 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-400 dark:hover:bg-white/10"
                >
                  ✕
                </button>
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredSessions.map((session) => (
                (() => {
                  const previewText = sessionPreview(session);
                  const insightText = sessionInsights(session);
                  const isSelected = selectedSessions.has(session.id);

                  return (
                <div
                  key={session.id}
                  className={`group rounded-2xl border text-left transition hover:-translate-y-0.5 hover:shadow-[0_14px_30px_-18px_rgba(15,23,42,0.35)] dark:bg-slate-900/65 ${
                    isSelected
                      ? 'border-accent/50 bg-accent/5 dark:border-accent/40 dark:bg-accent/10'
                      : 'border-black/10 bg-white/85 hover:border-accent/40 dark:border-white/10'
                  } ${
                    cardDensity === 'dense' ? 'p-3' : 'p-4'
                  }`}
                >
                  <div className={`flex items-center justify-between gap-3 ${cardDensity === 'dense' ? 'mb-1.5' : 'mb-2'}`}>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(session.id)}
                        onClick={(e) => e.stopPropagation()}
                        className={`h-3.5 w-3.5 rounded border-black/20 text-accent focus:ring-accent/30 dark:border-white/20 transition ${
                          isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'
                        }`}
                      />
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        Session
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400">
                      {new Date(session.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    onClick={() => setActiveSession(session.id)}
                    className="block w-full text-left"
                  >
                    <div className={`font-semibold tracking-tight text-slate-900 dark:text-white ${cardDensity === 'dense' ? 'line-clamp-1 text-sm' : 'line-clamp-2 text-base'}`}>
                      {session.title}
                    </div>
                    {previewText && (
                      <div className={`text-xs text-slate-600 transition group-hover:text-accent dark:text-slate-300 ${cardDensity === 'dense' ? 'mt-1 line-clamp-1' : 'mt-2 line-clamp-2'}`}>
                        {previewText}
                      </div>
                    )}
                    {insightText && (
                      <div className={`text-[10px] font-medium text-slate-500 dark:text-slate-400 ${cardDensity === 'dense' ? 'mt-1' : 'mt-1.5'}`}>
                        {insightText}
                      </div>
                    )}
                    {(session.latest_synthesis_prompt_version || session.latest_signal_prompt_version) && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {session.latest_synthesis_prompt_version && (
                          <span className="rounded-full border border-black/10 px-2 py-0.5 text-[10px] text-slate-500 dark:border-white/10 dark:text-slate-400">
                            Synth {session.latest_synthesis_prompt_version}
                          </span>
                        )}
                        {session.latest_signal_prompt_version && (
                          <span className="rounded-full border border-black/10 px-2 py-0.5 text-[10px] text-slate-500 dark:border-white/10 dark:text-slate-400">
                            Signal {session.latest_signal_prompt_version}
                          </span>
                        )}
                      </div>
                    )}
                  </button>
                  <div className={`flex items-center justify-end ${cardDensity === 'dense' ? 'mt-2' : 'mt-3'}`}>
                    <button
                      type="button"
                      onClick={() => deleteSession(session.id)}
                      className={`rounded-full border border-red-300/70 font-semibold text-red-700 transition hover:bg-red-50 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-950/30 ${
                        cardDensity === 'dense' ? 'px-2.5 py-0.5 text-[10px]' : 'px-3 py-1 text-[11px]'
                      }`}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                  );
                })()
              ))}
            </div>
            </>
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
        </div>
      </div>
    </main>

    {/* Cross-session synthesis modal */}
    {crossSynthesis && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
        onClick={(e) => { if (e.target === e.currentTarget) setCrossSynthesis(null); }}
      >
        <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col rounded-3xl border border-black/10 bg-white shadow-2xl dark:border-white/10 dark:bg-slate-900">
          <div className="flex items-center justify-between border-b border-black/10 px-6 py-4 dark:border-white/10">
            <div>
              <h2 className="text-base font-semibold tracking-tight text-slate-900 dark:text-white">Cross-Session Synthesis</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">{crossSynthesis.sessionCount} session{crossSynthesis.sessionCount !== 1 ? 's' : ''} analyzed</p>
            </div>
            <button
              type="button"
              onClick={() => setCrossSynthesis(null)}
              className="rounded-full border border-black/10 px-3 py-1.5 text-[11px] font-semibold text-slate-600 transition hover:bg-black/5 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/10"
            >
              Close
            </button>
          </div>

          <div className="flex-1 overflow-auto px-6 py-5 space-y-5">
            {crossSynthesis.loading && (
              <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                Analyzing {crossSynthesis.sessionCount} sessions...
              </div>
            )}
            {(crossSynthesis.promptProfile || crossSynthesis.promptVersion) && (
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                {crossSynthesis.promptProfile && (
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Prompt {crossSynthesis.promptProfile}</span>
                )}
                {crossSynthesis.promptVersion && (
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Version {crossSynthesis.promptVersion}</span>
                )}
              </div>
            )}
            {crossSynthesis.error && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-300">
                {crossSynthesis.error}
              </div>
            )}
            {crossSynthesis.result && (() => {
              const r = crossSynthesis.result;
              const Section = ({ label, items, color = 'slate' }) => (
                items?.length > 0 ? (
                  <div>
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">{label}</div>
                    <ul className="space-y-1">
                      {items.map((item, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null
              );
              return (
                <div className="space-y-5">
                  {r.summary && (
                    <div className="rounded-xl border border-accent/20 bg-accent/5 px-4 py-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                      {r.summary}
                    </div>
                  )}
                  <Section label="Cross-Session Patterns" items={r.cross_session_patterns} />
                  <Section label="Aggregated Risks" items={r.aggregated_risks} />
                  <Section label="Combined Next Actions" items={r.combined_next_actions} />
                  <Section label="Key Decisions" items={r.key_decisions} />
                  <Section label="Open Questions" items={r.open_questions} />
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    )}
    </>
  );
}
