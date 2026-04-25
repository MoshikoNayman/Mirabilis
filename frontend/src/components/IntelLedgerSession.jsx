// frontend/src/components/IntelLedgerSession.jsx
// InteLedger session management UI

'use client';

import { useState, useEffect } from 'react';
import InfoHint from './ui/InfoHint';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
const SIGNAL_TYPE_ORDER = ['decision', 'risk', 'ask', 'commitment', 'opportunity'];

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

function isGenericSessionTitle(title) {
  const normalized = String(title || '').trim().toLowerCase();
  return !normalized || ['untitled', 'inteledger session', 'new session', 'session'].includes(normalized);
}

function titleFromContent(content) {
  const cleaned = String(content || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Untitled';
  const first = cleaned.split(/[.!?]/)[0].trim() || cleaned;
  return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}

function titleCaseSignalType(value) {
  return String(value || 'signal')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function confidenceBadgeTone(confidence) {
  if (confidence >= 0.8) return 'border-emerald-300/70 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-900/20 dark:text-emerald-300';
  if (confidence >= 0.6) return 'border-amber-300/70 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-900/20 dark:text-amber-300';
  return 'border-rose-300/70 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-900/20 dark:text-rose-300';
}

export default function IntelLedgerSession({ sessionId, userId, initialSession = null, localMode = false, onSessionUpdate = () => {}, onBack }) {
  const [session, setSession] = useState(null);
  const [interactions, setInteractions] = useState([]);
  const [signals, setSignals] = useState([]);
  const [actions, setActions] = useState([]);
  const [mediaJobs, setMediaJobs] = useState([]);
  const [mediaFile, setMediaFile] = useState(null);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [isMediaDragActive, setIsMediaDragActive] = useState(false);
  const [highlightedInteractionId, setHighlightedInteractionId] = useState(null);
  const [expandedActionSource, setExpandedActionSource] = useState(null); // actionId
  const [highlightedActionId, setHighlightedActionId] = useState(null);
  const [sessionBrief, setSessionBrief] = useState(null);
  const [synthesis, setSynthesis] = useState(null);
  const [reminderStatus, setReminderStatus] = useState(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [activeTab, setActiveTab] = useState('interactions');
  const [signalTypeFilter, setSignalTypeFilter] = useState('all');
  const [signalConfidenceFilter, setSignalConfidenceFilter] = useState('all');
  const [signalOwnerFilter, setSignalOwnerFilter] = useState('all');
  const [error, setError] = useState('');
  const [auditSummary, setAuditSummary] = useState(null);
  const [auditTrends, setAuditTrends] = useState(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [usingLocalMode, setUsingLocalMode] = useState(localMode);

  const actionStatusCounts = actions.reduce((acc, action) => {
    const status = action?.status || 'open';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, { open: 0, in_progress: 0, done: 0, blocked: 0 });

  const todayIso = new Date().toISOString().slice(0, 10);
  const actionInsights = actions.reduce((acc, action) => {
    const status = String(action?.status || 'open');
    const isOpen = status !== 'done';
    const urgency = Number(action?.urgency_score || 0);
    const dueDate = String(action?.due_date || '');
    const isOverdue = Boolean(action?.is_overdue) || (isOpen && dueDate && dueDate < todayIso);
    const reminderAt = action?.next_reminder_at ? new Date(action.next_reminder_at) : null;

    if (isOpen && urgency >= 72) acc.urgent += 1;
    if (isOverdue) acc.overdue += 1;
    if (isOpen && status === 'blocked' && urgency >= 72) acc.blockedUrgent += 1;
    if (isOpen && reminderAt && !Number.isNaN(reminderAt.getTime())) {
      const diffHours = (reminderAt.getTime() - Date.now()) / 3600000;
      if (diffHours <= 24) acc.remindersSoon += 1;
    }

    return acc;
  }, { urgent: 0, overdue: 0, blockedUrgent: 0, remindersSoon: 0 });

  const normalizeActionTitle = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

  const focusActionByTitle = (title) => {
    const normalized = normalizeActionTitle(title);
    if (!normalized) return;

    const exact = actions.find((item) => normalizeActionTitle(item.title) === normalized);
    const partial = exact || actions.find((item) => normalizeActionTitle(item.title).includes(normalized));
    if (!partial) return;

    setActiveTab('actions');
    setHighlightedActionId(partial.id);
    setTimeout(() => {
      const card = document.getElementById(`action-card-${partial.id}`);
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  };

  const saveLocalState = (next) => {
    writeLocalSessionState(userId, sessionId, {
      session: next.session ?? session,
      interactions: next.interactions ?? interactions,
      signals: next.signals ?? signals,
      actions: next.actions ?? actions,
      sessionBrief: next.sessionBrief ?? sessionBrief,
      synthesis: next.synthesis ?? synthesis
    });
  };

  const loadLocalState = (seedSession = initialSession, silent = false) => {
    const localState = readLocalSessionState(userId, sessionId);
    if (localState?.session) {
      setSession(localState.session);
      setInteractions(Array.isArray(localState.interactions) ? localState.interactions : []);
      setSignals(Array.isArray(localState.signals) ? localState.signals : []);
      setActions(Array.isArray(localState.actions) ? localState.actions : []);
      setSessionBrief(localState.sessionBrief || null);
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
    setActions([]);
    setSessionBrief(null);
    setSynthesis(null);
    setUsingLocalMode(true);
    writeLocalSessionState(userId, sessionId, {
      session: localSession,
      interactions: [],
      signals: [],
      actions: [],
      sessionBrief: null,
      synthesis: null
    });
    if (silent) setError('');
    return true;
  };

  useEffect(() => {
    if (sessionId) loadSession();
  }, [sessionId]);

  useEffect(() => {
    const hasActiveJobs = mediaJobs.some((job) => ['queued', 'running'].includes(String(job.status || '')));
    if (!hasActiveJobs || !sessionId || localMode) return undefined;
    const timer = setInterval(() => {
      loadMediaJobs();
    }, 2500);
    return () => clearInterval(timer);
  }, [sessionId, localMode, mediaJobs]);

  useEffect(() => {
    if (!sessionId || localMode || usingLocalMode || activeTab !== 'actions') return undefined;

    let mounted = true;
    const loadReminderStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/intelledger/reminders/status`);
        if (!res.ok) {
          if (mounted) setReminderStatus(null);
          return;
        }
        const payload = await readJsonOrThrow(res, 'Failed to load reminder worker status.');
        if (mounted) {
          setReminderStatus(payload || null);
        }
      } catch {
        if (mounted) setReminderStatus(null);
      }
    };

    loadReminderStatus();
    const timer = setInterval(loadReminderStatus, 10000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [sessionId, localMode, usingLocalMode, activeTab]);

  useEffect(() => {
    if (activeTab !== 'audit' || localMode || usingLocalMode || !userId) return undefined;
    let mounted = true;
    const load = async () => {
      setAuditLoading(true);
      try {
        const [sumRes, trendRes] = await Promise.all([
          fetch(`${API_BASE}/api/intelledger/audit/summary?userId=${encodeURIComponent(userId)}&since_hours=168&limit=2000`),
          fetch(`${API_BASE}/api/intelledger/audit/trends?userId=${encodeURIComponent(userId)}`)
        ]);
        const [sumPayload, trendPayload] = await Promise.all([sumRes.json(), trendRes.json()]);
        if (mounted) {
          setAuditSummary(sumPayload?.summary || null);
          setAuditTrends(trendPayload?.trends || null);
        }
      } catch {
        if (mounted) { setAuditSummary(null); setAuditTrends(null); }
      } finally {
        if (mounted) setAuditLoading(false);
      }
    };
    load();
    return () => { mounted = false; };
  }, [activeTab, userId, localMode, usingLocalMode]);

  const formatMs = (value) => {
    const ms = Math.max(0, Number(value || 0));
    const total = Math.floor(ms / 1000);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const focusInteractionAt = (interactionId, startMs = null) => {
    if (!interactionId) return;
    setActiveTab('interactions');
    setHighlightedInteractionId(interactionId);
    setTimeout(() => {
      const card = document.getElementById(`interaction-card-${interactionId}`);
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
    if (typeof startMs === 'number') {
      setError(`Evidence @ ${formatMs(startMs)} in source interaction.`);
      setTimeout(() => setError(''), 2200);
    }
  };

  const loadMediaJobs = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/sessions/${sessionId}/jobs`);
      if (!res.ok) return;
      const payload = await readJsonOrThrow(res, 'Failed to load media jobs.');
      setMediaJobs(Array.isArray(payload.jobs) ? payload.jobs : []);
    } catch {
      // Keep UI usable even if jobs endpoint is unavailable.
    }
  };

  const loadSessionBrief = async () => {
    try {
      const briefRes = await fetch(`${API_BASE}/api/intelledger/sessions/${sessionId}/brief`);
      if (!briefRes.ok) return null;
      const { brief } = await readJsonOrThrow(briefRes, 'Failed to load session brief.');
      setSessionBrief(brief || null);
      return brief || null;
    } catch {
      return null;
    }
  };

  const loadSession = async () => {
    setLoadingSession(true);
    setError('');

    if (localMode || String(sessionId).startsWith('local-')) {
      loadLocalState(initialSession, true);
      setLoadingSession(false);
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
      await loadMediaJobs();
      await loadSessionBrief();

      // Actions are optional: if endpoint is unavailable, keep session data visible.
      try {
        const actionRes = await fetch(`${API_BASE}/api/intelledger/sessions/${sessionId}/actions`);
        if (actionRes.ok) {
          const { actions } = await readJsonOrThrow(actionRes, 'Failed to load actions.');
          setActions(Array.isArray(actions) ? actions : []);
        } else {
          setActions([]);
        }
      } catch {
        setActions([]);
      }

      setUsingLocalMode(false);
    } catch (err) {
      loadLocalState(initialSession, false);
      setError('');
    } finally {
      setLoadingSession(false);
    }
  };

  const handleIngestText = async (e) => {
    e.preventDefault();
    const textarea = e.target.querySelector('textarea');
    const content = textarea.value;
    if (!content.trim()) return;

    setIngesting(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/intelledger/sessions/${sessionId}/ingest/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, sourceName: 'manual_input' })
      });

      const { interaction, signals: extracted, actions: extractedActions, session: updatedSession } = await readJsonOrThrow(res, 'Failed to ingest interaction text.');
      setInteractions([interaction, ...interactions]);
      setSignals([...extracted, ...signals]);
      if (Array.isArray(extractedActions)) {
        setActions(extractedActions);
      }
      await loadSessionBrief();
      if (updatedSession?.title) {
        setSession(updatedSession);
        onSessionUpdate(updatedSession);
      }
      textarea.value = '';
      setUsingLocalMode(false);
    } catch (err) {
      const shouldRename = interactions.length === 0 && isGenericSessionTitle(session?.title);
      const localSession = shouldRename
        ? {
            ...(session || initialSession || {}),
            title: titleFromContent(content),
            topic_preview: titleFromContent(content)
          }
        : (session || initialSession);
      const interaction = {
        id: `local-int-${Date.now()}`,
        type: 'text',
        raw_content: content,
        source_name: 'manual_input',
        ingested_at: new Date().toISOString()
      };
      const nextInteractions = [interaction, ...interactions];
      setInteractions(nextInteractions);
      if (localSession?.title && localSession?.id) {
        setSession(localSession);
        onSessionUpdate(localSession);
      }
      textarea.value = '';
      saveLocalState({ session: localSession, interactions: nextInteractions, actions, sessionBrief });
      setUsingLocalMode(true);
      setError('');
    } finally {
      setIngesting(false);
    }
  };

  const handleSynthesis = async () => {
    setSynthesizing(true);
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
      setSynthesizing(false);
    }
  };

  const handleIngestMedia = async (e) => {
    e.preventDefault();
    if (!mediaFile) return;

    setMediaUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', mediaFile);

      const res = await fetch(`${API_BASE}/api/intelledger/sessions/${sessionId}/ingest/media`, {
        method: 'POST',
        body: form
      });
      const payload = await readJsonOrThrow(res, 'Failed to queue media transcription.');

      if (payload?.interaction) {
        setInteractions((current) => [payload.interaction, ...current]);
      }
      if (payload?.job) {
        setMediaJobs((current) => [payload.job, ...current.filter((item) => item.id !== payload.job.id)]);
      }
      setMediaFile(null);
      await loadSessionBrief();
      setUsingLocalMode(false);
    } catch (err) {
      setError(err.message || 'Failed to queue media upload.');
    } finally {
      setMediaUploading(false);
    }
  };

  const handlePickedMediaFile = (candidate) => {
    if (!candidate) {
      setMediaFile(null);
      return;
    }

    if (!(candidate.type || '').startsWith('video/') && !(candidate.type || '').startsWith('audio/')) {
      setError('Only video/audio files are supported.');
      return;
    }

    setError('');
    setMediaFile(candidate);
  };

  const handleMediaDrop = (event) => {
    event.preventDefault();
    setIsMediaDragActive(false);
    handlePickedMediaFile(event.dataTransfer?.files?.[0] || null);
  };

  const updateAction = async (actionId, patch) => {
    const previous = actions;
    const optimistic = actions.map((item) => (
      item.id === actionId ? { ...item, ...patch, updated_at: new Date().toISOString() } : item
    ));
    setActions(optimistic);

    try {
      const res = await fetch(`${API_BASE}/api/intelledger/sessions/${sessionId}/actions/${actionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      const { action } = await readJsonOrThrow(res, 'Failed to update action.');
      setActions((current) => current.map((item) => (item.id === actionId ? { ...item, ...action } : item)));
      await loadSessionBrief();
      setUsingLocalMode(false);
    } catch {
      setActions(previous);
      setUsingLocalMode(true);
      saveLocalState({ actions: optimistic });
    }
  };

  if (!session && loadingSession) return <div className="p-6 text-center text-slate-500">Loading...</div>;
  if (!session) return <div className="p-6 text-center text-slate-500">Loading...</div>;

  const ownerOptions = [...new Set(signals.map((sig) => String(sig.owner || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const filteredSignals = signals.filter((sig) => {
    if (signalTypeFilter !== 'all' && sig.signal_type !== signalTypeFilter) return false;
    if (signalOwnerFilter !== 'all' && String(sig.owner || '').trim() !== signalOwnerFilter) return false;

    if (signalConfidenceFilter !== 'all') {
      const confidence = Number(sig.confidence || 0);
      const threshold = Number(signalConfidenceFilter);
      if (Number.isFinite(threshold) && confidence < threshold) return false;
    }

    return true;
  });

  const allSignalTypes = [...new Set(signals.map((sig) => sig.signal_type).filter(Boolean))];

  const signalsByTypeRaw = filteredSignals.reduce((acc, sig) => {
    (acc[sig.signal_type] = acc[sig.signal_type] || []).push(sig);
    return acc;
  }, {});
  const orderedSignalTypes = [...Object.keys(signalsByTypeRaw)].sort((a, b) => {
    const aIdx = SIGNAL_TYPE_ORDER.indexOf(a);
    const bIdx = SIGNAL_TYPE_ORDER.indexOf(b);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

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
              {interactions.length} interactions · {signals.length} signals extracted · {actions.length} actions
            </p>
            <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
              <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Open {actionStatusCounts.open || 0}</span>
              <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">In Progress {actionStatusCounts.in_progress || 0}</span>
              <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Done {actionStatusCounts.done || 0}</span>
              <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Blocked {actionStatusCounts.blocked || 0}</span>
              {sessionBrief && (
                <>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Due today {sessionBrief.due_today_actions || 0}</span>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">Overdue {sessionBrief.overdue_actions || 0}</span>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">New notes (24h) {sessionBrief.new_interactions_24h || 0}</span>
                  <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">New signals (24h) {sessionBrief.new_signals_24h || 0}</span>
                </>
              )}
            </div>
            {sessionBrief && (
              <div className="space-y-1 text-[10px] text-slate-500 dark:text-slate-400">
                {Array.isArray(sessionBrief.overdue_titles) && sessionBrief.overdue_titles.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400">Overdue items</span>
                    {sessionBrief.overdue_titles.map((title) => (
                      <button
                        key={title}
                        type="button"
                        onClick={() => focusActionByTitle(title)}
                        className="rounded-full border border-amber-300/60 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 transition hover:brightness-95 dark:border-amber-500/30 dark:bg-amber-900/20 dark:text-amber-300"
                      >
                        {title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex items-center gap-1 overflow-x-auto pt-1 text-[10px] text-slate-500 dark:text-slate-400">
              <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10" title="One piece of source text you added.">Interaction</span>
              <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10" title="Extracted insight such as risk/decision/commitment.">Signal</span>
              <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10" title="AI summary over all interactions and signals.">Synthesis</span>
              <InfoHint
                title="How it works"
                description="Ingest raw context, review extracted signals, then synthesize for a concise action snapshot."
                points={[
                  'Ingest: add text or file notes',
                  'Extract: tag structured signals automatically',
                  'Synthesis: ask AI what matters now'
                ]}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {['interactions', 'signals', 'actions', 'synthesis', 'audit'].map((tab) => (
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
                <div className="grid items-stretch gap-3 lg:grid-cols-2">
                  <form onSubmit={handleIngestText} className="flex h-full flex-col gap-2 rounded-lg border border-black/10 bg-white/60 p-3 dark:border-white/10 dark:bg-slate-900/40">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Text Note</div>
                      <button
                        type="submit"
                        disabled={ingesting}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-95 disabled:opacity-50"
                      >
                        {ingesting && <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/35 border-t-white" />}
                        {ingesting ? 'Extracting...' : 'Ingest & Extract'}
                      </button>
                    </div>
                    <textarea
                      className="min-h-[168px] flex-1 resize-none rounded-lg border border-black/10 bg-white p-3 text-slate-900 placeholder-slate-500 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-white/20 dark:bg-slate-700 dark:text-white dark:placeholder-slate-400"
                      rows="7"
                      placeholder="Paste notes, meeting recap, or decisions..."
                    />
                    {ingesting && (
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Running AI extraction and action generation. This can take a few seconds.
                      </div>
                    )}
                  </form>

                  <form onSubmit={handleIngestMedia} className="flex h-full flex-col gap-2 rounded-lg border border-black/10 bg-white/60 p-3 dark:border-white/10 dark:bg-slate-900/40">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Upload Video / Audio</div>
                      <button
                        type="submit"
                        disabled={!mediaFile || mediaUploading}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-95 disabled:opacity-50"
                      >
                        {mediaUploading && <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/35 border-t-white" />}
                        {mediaUploading ? 'Queuing...' : 'Upload & Transcribe'}
                      </button>
                    </div>
                    <input
                      id="intelledger-media-input"
                      type="file"
                      accept="video/*,audio/*"
                      onChange={(event) => handlePickedMediaFile(event.target.files?.[0] || null)}
                      className="sr-only"
                    />
                    <label
                      htmlFor="intelledger-media-input"
                      onDragOver={(event) => {
                        event.preventDefault();
                        setIsMediaDragActive(true);
                      }}
                      onDragLeave={() => setIsMediaDragActive(false)}
                      onDrop={handleMediaDrop}
                      className={`flex min-h-[168px] flex-1 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-4 text-center transition ${
                        isMediaDragActive
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-black/20 bg-white/80 text-slate-600 hover:border-accent/60 hover:bg-accent/5 dark:border-white/20 dark:bg-slate-800/60 dark:text-slate-300'
                      }`}
                    >
                      <div className="text-xs font-semibold">Drag and drop video/audio here</div>
                      <div className="mt-1 text-[11px]">or click to browse</div>
                      {mediaFile ? (
                        <div className="mt-2 rounded-full border border-black/10 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:border-white/20 dark:bg-slate-900 dark:text-slate-200">
                          {mediaFile.name}
                        </div>
                      ) : null}
                    </label>
                  </form>
                </div>
              </div>

              {mediaJobs.length > 0 && (
                <div className="rounded-xl border border-black/10 bg-white/80 p-3 dark:border-white/10 dark:bg-slate-900/45">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Media Jobs</div>
                  <div className="space-y-2">
                    {mediaJobs.slice(0, 8).map((job) => (
                      <div key={job.id} className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/10">
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          <span className="rounded-full border border-black/10 px-2 py-0.5 font-semibold uppercase tracking-[0.08em] dark:border-white/10">{job.status || 'queued'}</span>
                          <span className="text-slate-500 dark:text-slate-400">{job.phase || 'queued'} · {Number(job.progress || 0)}%</span>
                        </div>
                        {job.error && (
                          <div className="mt-1 text-xs text-rose-600 dark:text-rose-300">{job.error}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300">Interactions ({interactions.length})</h3>
                {interactions.map(int => (
                  <div
                    id={`interaction-card-${int.id}`}
                    key={int.id}
                    className={`p-4 border rounded-lg bg-white dark:bg-slate-800 shadow-sm transition ${
                      highlightedInteractionId === int.id
                        ? 'border-amber-300/80 ring-2 ring-amber-200/70 dark:border-amber-500/40 dark:ring-amber-500/20'
                        : 'border-black/10 dark:border-white/10'
                    }`}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-medium">
                      <span>{int.type}</span>
                      {int.source_name && <span>· {int.source_name}</span>}
                      {int.transcript_status && <span>· transcript {int.transcript_status}</span>}
                      {int.media?.duration_sec ? <span>· {Math.round(int.media.duration_sec)}s</span> : null}
                    </div>
                    <div className="line-clamp-4 text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{int.raw_content}</div>

                    {Array.isArray(int.transcript_segments) && int.transcript_segments.length > 0 && (
                      <div className="mt-3 space-y-1 rounded-lg border border-black/10 bg-slate-50 p-2 dark:border-white/10 dark:bg-slate-900/45">
                        {int.transcript_segments.slice(0, 8).map((seg, idx) => (
                          <button
                            key={`${int.id}-${idx}`}
                            type="button"
                            onClick={() => focusInteractionAt(int.id, Number(seg.start_ms || 0))}
                            className="block w-full text-left text-[11px] text-slate-600 transition hover:text-accent dark:text-slate-300 dark:hover:text-accent"
                          >
                            <span className="font-semibold">[{formatMs(seg.start_ms)}]</span> {seg.speaker || 'Speaker'}: {seg.text}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                      {new Date(int.ingested_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'signals' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-black/10 bg-white/75 p-3 dark:border-white/10 dark:bg-slate-900/45">
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="text-[11px] text-slate-500 dark:text-slate-400">
                    <div className="mb-1">Type</div>
                    <select
                      value={signalTypeFilter}
                      onChange={(e) => setSignalTypeFilter(e.target.value)}
                      className="w-full rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs text-slate-700 focus:outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800 dark:text-slate-200"
                    >
                      <option value="all">All types</option>
                      {SIGNAL_TYPE_ORDER.map((type) => (
                        <option key={type} value={type}>{titleCaseSignalType(type)}</option>
                      ))}
                      {allSignalTypes
                        .filter((type) => !SIGNAL_TYPE_ORDER.includes(type))
                        .map((type) => (
                          <option key={type} value={type}>{titleCaseSignalType(type)}</option>
                        ))}
                    </select>
                  </label>
                  <label className="text-[11px] text-slate-500 dark:text-slate-400">
                    <div className="mb-1">Confidence</div>
                    <select
                      value={signalConfidenceFilter}
                      onChange={(e) => setSignalConfidenceFilter(e.target.value)}
                      className="w-full rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs text-slate-700 focus:outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800 dark:text-slate-200"
                    >
                      <option value="all">Any confidence</option>
                      <option value="0.8">80% and up</option>
                      <option value="0.6">60% and up</option>
                      <option value="0.4">40% and up</option>
                    </select>
                  </label>
                  <label className="text-[11px] text-slate-500 dark:text-slate-400">
                    <div className="mb-1">Owner</div>
                    <select
                      value={signalOwnerFilter}
                      onChange={(e) => setSignalOwnerFilter(e.target.value)}
                      className="w-full rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs text-slate-700 focus:outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800 dark:text-slate-200"
                    >
                      <option value="all">Any owner</option>
                      {ownerOptions.map((owner) => (
                        <option key={owner} value={owner}>{owner}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
              {signals.length === 0 && (
                <div className="rounded-lg border border-dashed border-black/10 bg-white/60 px-4 py-3 text-sm text-slate-500 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-400">
                  No signals extracted yet. Ingest text in the Interactions tab to populate structured signals.
                </div>
              )}
              {signals.length > 0 && filteredSignals.length === 0 && (
                <div className="rounded-lg border border-dashed border-black/10 bg-white/60 px-4 py-3 text-sm text-slate-500 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-400">
                  No signals match the current filters.
                </div>
              )}
              {orderedSignalTypes.map((type) => {
                const sigs = signalsByTypeRaw[type] || [];
                return (
                <div key={type} className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-black/10 dark:border-white/10 shadow-sm">
                  <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300">
                    {titleCaseSignalType(type)} ({sigs.length})
                  </h3>
                  <div className="space-y-3">
                    {sigs.map(sig => (
                      <div key={sig.id} className="p-3 rounded-lg border border-black/10 bg-white dark:border-white/10 dark:bg-slate-900/50">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${confidenceBadgeTone(Number(sig.confidence || 0))}`}>
                            {(Number(sig.confidence || 0) * 100).toFixed(0)}% confidence
                          </span>
                          {sig.owner && (
                            <span className="text-[11px] text-slate-500 dark:text-slate-400">Owner: {sig.owner}</span>
                          )}
                          {sig.due_date && (
                            <span className="text-[11px] text-slate-500 dark:text-slate-400">Due: {sig.due_date}</span>
                          )}
                        </div>
                        <div className="mt-2 font-semibold text-slate-900 dark:text-white text-sm">{sig.value}</div>
                        {Number.isFinite(Number(sig.start_ms)) && (
                          <button
                            type="button"
                            onClick={() => focusInteractionAt(sig.interaction_id, Number(sig.start_ms || 0))}
                            className="mt-1 rounded-full border border-black/10 px-2 py-0.5 text-[10px] font-medium text-slate-500 transition hover:text-accent dark:border-white/10 dark:text-slate-400 dark:hover:text-accent"
                          >
                            Source timestamp {formatMs(sig.start_ms)}
                          </button>
                        )}
                        {sig.quote && (
                          <div className="text-slate-700 dark:text-slate-300 italic text-sm mt-2">
                            "{sig.quote}"
                          </div>
                        )}
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                          Confidence: {(sig.confidence * 100).toFixed(0)}%
                          {sig.extracted_at && (
                            <span className="ml-2">· {new Date(sig.extracted_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                );
              })}
            </div>
          )}

          {activeTab === 'actions' && (
            <div className="space-y-4">
              {reminderStatus?.worker && (
                <div className="rounded-xl border border-black/10 bg-white/75 p-3 dark:border-white/10 dark:bg-slate-900/45">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Reminder Worker</div>
                  <div className="grid gap-2 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-md border border-black/10 bg-white/80 px-2 py-1 text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300">
                      Enabled <span className="font-semibold">{reminderStatus.worker.enabled ? 'Yes' : 'No'}</span>
                    </div>
                    <div className="rounded-md border border-black/10 bg-white/80 px-2 py-1 text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300">
                      Interval <span className="font-semibold">{Math.round(Number(reminderStatus.worker.interval_ms || 0) / 1000)}s</span>
                    </div>
                    <div className="rounded-md border border-black/10 bg-white/80 px-2 py-1 text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300">
                      Min gap <span className="font-semibold">{Math.round(Number(reminderStatus.worker.min_interval_ms || 0) / 1000)}s</span>
                    </div>
                    <div className="rounded-md border border-black/10 bg-white/80 px-2 py-1 text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300">
                      Signing <span className="font-semibold">{reminderStatus.worker.webhook_signing_enabled ? 'On' : 'Off'}</span>
                    </div>
                    <div className="rounded-md border border-black/10 bg-white/80 px-2 py-1 text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300">
                      Due preview <span className="font-semibold">{Number(reminderStatus.due_preview_count || 0)}</span>
                    </div>
                    <div className="rounded-md border border-black/10 bg-white/80 px-2 py-1 text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300">
                      Processed cycle <span className="font-semibold">{Number(reminderStatus.worker.last_cycle_processed_count || 0)}</span>
                    </div>
                    <div className="rounded-md border border-black/10 bg-white/80 px-2 py-1 text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300">
                      Suppressed cycle <span className="font-semibold">{Number(reminderStatus.worker.last_cycle_suppressed_count || 0)}</span>
                    </div>
                    <div className="rounded-md border border-black/10 bg-white/80 px-2 py-1 text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300">
                      Dispatch history <span className="font-semibold">{Array.isArray(reminderStatus.worker.dispatches) ? reminderStatus.worker.dispatches.length : 0}</span>
                    </div>
                  </div>
                  {reminderStatus.worker.last_error && (
                    <div className="mt-2 rounded-md border border-rose-300/60 bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:border-rose-500/30 dark:bg-rose-900/20 dark:text-rose-300">
                      Last error: {reminderStatus.worker.last_error}
                    </div>
                  )}
                </div>
              )}
              <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-black/10 dark:border-white/10 shadow-sm">
                <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300">
                  Action Queue ({actions.length})
                </h3>
                {actions.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-black/10 bg-white/60 px-4 py-3 text-sm text-slate-500 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-400">
                    No actions yet. Ingest more context to generate a queue.
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid gap-2 rounded-lg border border-black/10 bg-slate-50/70 p-2 text-[11px] dark:border-white/10 dark:bg-slate-900/50 sm:grid-cols-4">
                      <div className="rounded-md border border-black/10 bg-white/80 px-2 py-1 text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300">
                        Urgent open <span className="font-semibold">{actionInsights.urgent}</span>
                      </div>
                      <div className="rounded-md border border-black/10 bg-white/80 px-2 py-1 text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300">
                        Overdue <span className="font-semibold">{actionInsights.overdue}</span>
                      </div>
                      <div className="rounded-md border border-black/10 bg-white/80 px-2 py-1 text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300">
                        Blocked urgent <span className="font-semibold">{actionInsights.blockedUrgent}</span>
                      </div>
                      <div className="rounded-md border border-black/10 bg-white/80 px-2 py-1 text-slate-600 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-300">
                        Reminders ≤24h <span className="font-semibold">{actionInsights.remindersSoon}</span>
                      </div>
                    </div>
                    {actions.map((action) => (
                      <div
                        id={`action-card-${action.id}`}
                        key={action.id}
                        className={`rounded-lg border bg-white p-3 transition dark:bg-slate-900/50 ${
                          highlightedActionId === action.id
                            ? 'border-amber-300/80 ring-2 ring-amber-200/70 dark:border-amber-500/50 dark:ring-amber-500/20'
                            : 'border-black/10 dark:border-white/10'
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-black/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600 dark:border-white/10 dark:text-slate-300">
                            {action.priority || 'medium'}
                          </span>
                          {Number.isFinite(Number(action.urgency_score)) && (
                            <span className="rounded-full border border-black/10 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-white/10 dark:text-slate-300">
                              Urgency {Math.round(Number(action.urgency_score || 0))}
                            </span>
                          )}
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {action.source_signal_type || 'signal'}
                          </span>
                          <select
                            value={action.status || 'open'}
                            onChange={(e) => updateAction(action.id, { status: e.target.value })}
                            className="rounded-full border border-black/10 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-600 focus:outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800 dark:text-slate-200"
                          >
                            <option value="open">Open</option>
                            <option value="in_progress">In Progress</option>
                            <option value="done">Done</option>
                            <option value="blocked">Blocked</option>
                          </select>
                        </div>
                        <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{action.title}</div>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <input
                            type="text"
                            value={action.owner || ''}
                            onChange={(e) => updateAction(action.id, { owner: e.target.value })}
                            placeholder="Owner"
                            className="rounded-full border border-black/10 bg-white px-3 py-1 text-xs text-slate-700 focus:outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800 dark:text-slate-200"
                          />
                          <input
                            type="date"
                            value={action.due_date || ''}
                            onChange={(e) => updateAction(action.id, { due_date: e.target.value })}
                            className="rounded-full border border-black/10 bg-white px-3 py-1 text-xs text-slate-700 focus:outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800 dark:text-slate-200"
                          />
                        </div>
                        {action.rationale && (
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{action.rationale}</div>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                          {action.escalation_level && (
                            <span className="rounded-full border border-black/10 px-2 py-0.5 dark:border-white/10">
                              Escalation {action.escalation_level}
                            </span>
                          )}
                          {action.next_reminder_at && (
                            <span>
                              Next reminder {new Date(action.next_reminder_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                            </span>
                          )}
                        </div>
                        {action.source_signal_id && (() => {
                          const src = signals.find((s) => s.id === action.source_signal_id);
                          const quote = src?.value || src?.quote;
                          if (!quote) return null;
                          const isOpen = expandedActionSource === action.id;
                          return (
                            <div className="mt-2">
                              <button
                                type="button"
                                onClick={() => setExpandedActionSource(isOpen ? null : action.id)}
                                className="flex items-center gap-1 text-[10px] font-medium text-slate-400 transition hover:text-accent dark:text-slate-500 dark:hover:text-accent"
                              >
                                <span className={`transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                                Source ({src.signal_type || action.source_signal_type})
                              </button>
                              {isOpen && (
                                <div className="mt-1 rounded-lg border border-black/10 bg-slate-50 px-3 py-2 text-xs italic text-slate-600 dark:border-white/10 dark:bg-slate-800 dark:text-slate-400">
                                  "{quote}"
                                  {Number.isFinite(Number(src?.start_ms)) && (
                                    <button
                                      type="button"
                                      onClick={() => focusInteractionAt(src.interaction_id, Number(src.start_ms || 0))}
                                      className="ml-2 not-italic rounded-full border border-black/10 px-2 py-0.5 text-[10px] font-medium text-slate-500 transition hover:text-accent dark:border-white/10 dark:text-slate-400 dark:hover:text-accent"
                                    >
                                      {formatMs(src.start_ms)}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'audit' && (
            <div className="space-y-6">
              {auditLoading && (
                <div className="text-sm text-slate-500 dark:text-slate-400">Loading audit data…</div>
              )}
              {!auditLoading && !auditSummary && !auditTrends && (
                <div className="rounded-xl border border-black/10 bg-white/60 px-5 py-8 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-400">
                  No audit data available. Activity is recorded as you use IntelLedger.
                </div>
              )}

              {auditSummary && (
                <div className="rounded-xl border border-black/10 bg-white/60 p-4 dark:border-white/10 dark:bg-slate-900/40">
                  <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">7-Day Activity Summary</div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      { label: 'Events', value: auditSummary.event_count },
                      { label: 'Sessions', value: auditSummary.unique_sessions },
                      { label: 'Sampled', value: auditSummary.sampled_events },
                      { label: 'Window (h)', value: auditSummary.since_hours }
                    ].map(({ label, value }) => (
                      <div key={label} className="rounded-lg border border-black/8 bg-white/70 px-3 py-2 dark:border-white/10 dark:bg-slate-800/50">
                        <div className="text-[18px] font-bold text-slate-800 dark:text-slate-100">{value ?? '—'}</div>
                        <div className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">{label}</div>
                      </div>
                    ))}
                  </div>

                  {Array.isArray(auditSummary.event_types) && auditSummary.event_types.length > 0 && (
                    <div className="mt-4">
                      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">Top Event Types</div>
                      <div className="space-y-1.5">
                        {auditSummary.event_types.slice(0, 8).map((item) => {
                          const maxCount = auditSummary.event_types[0]?.count || 1;
                          const pct = Math.round((item.count / maxCount) * 100);
                          return (
                            <div key={item.event_type} className="flex items-center gap-2">
                              <div className="w-44 shrink-0 truncate text-[11px] text-slate-600 dark:text-slate-300">{item.event_type}</div>
                              <div className="relative flex-1 overflow-hidden rounded-full bg-black/5 dark:bg-white/8" style={{ height: 6 }}>
                                <div className="absolute inset-y-0 left-0 rounded-full bg-accent/60" style={{ width: `${pct}%` }} />
                              </div>
                              <div className="w-8 shrink-0 text-right text-[11px] font-medium text-slate-600 dark:text-slate-400">{item.count}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {auditTrends && (
                <div className="space-y-4">
                  {/* 30-day daily bar chart */}
                  {Array.isArray(auditTrends.daily_30) && auditTrends.daily_30.length > 0 && (() => {
                    const maxCount = Math.max(...auditTrends.daily_30.map((b) => b.count), 1);
                    return (
                      <div className="rounded-xl border border-black/10 bg-white/60 p-4 dark:border-white/10 dark:bg-slate-900/40">
                        <div className="mb-3 flex items-center justify-between">
                          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">30-Day Daily Events</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">{auditTrends.event_count_30d} total</div>
                        </div>
                        <div className="flex h-16 items-end gap-px">
                          {auditTrends.daily_30.map((bucket) => {
                            const h = maxCount > 0 ? Math.max(2, Math.round((bucket.count / maxCount) * 100)) : 2;
                            const isToday = bucket.date === new Date().toISOString().slice(0, 10);
                            return (
                              <div key={bucket.date} title={`${bucket.date}: ${bucket.count}`} className="flex-1 rounded-sm transition-opacity hover:opacity-80" style={{ height: `${h}%`, background: isToday ? 'var(--color-accent, #1aa86f)' : 'rgb(148 163 184 / 0.5)' }} />
                            );
                          })}
                        </div>
                        <div className="mt-1 flex justify-between text-[10px] text-slate-400">
                          <span>{auditTrends.daily_30[0]?.date?.slice(5)}</span>
                          <span>today</span>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Top types per window */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {[['24h', auditTrends.top_types_24h, auditTrends.event_count_24h], ['7d', auditTrends.top_types_7d, auditTrends.event_count_7d], ['30d', auditTrends.top_types_30d, auditTrends.event_count_30d]].map(([label, types, total]) => (
                      <div key={label} className="rounded-xl border border-black/10 bg-white/60 p-3 dark:border-white/10 dark:bg-slate-900/40">
                        <div className="mb-2 flex items-center justify-between">
                          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">Top types — {label}</div>
                          <div className="text-[11px] font-medium text-slate-600 dark:text-slate-400">{total}</div>
                        </div>
                        {Array.isArray(types) && types.length > 0 ? (
                          <ul className="space-y-1">
                            {types.slice(0, 5).map((item) => (
                              <li key={item.event_type} className="flex items-center justify-between gap-2">
                                <span className="truncate text-[11px] text-slate-600 dark:text-slate-300">{item.event_type.replace(/\./g, ' › ')}</span>
                                <span className="shrink-0 text-[11px] font-semibold text-slate-700 dark:text-slate-200">{item.count}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="text-[11px] text-slate-400">No events</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'synthesis' && (
            <div className="space-y-4">
              <button
                onClick={handleSynthesis}
                disabled={synthesizing}
                className="rounded-full bg-accent px-4 py-1.5 text-[11px] font-semibold text-white shadow-[0_8px_18px_-10px_rgba(26,168,111,0.8)] transition hover:brightness-95 disabled:opacity-50"
              >
                {synthesizing ? 'Analyzing…' : synthesis ? 'Re-analyze' : 'Generate Analysis'}
              </button>

              {synthesis && (() => {
                let r = {};
                try { r = typeof synthesis.content === 'string' ? JSON.parse(synthesis.content) : (synthesis.content || {}); } catch { r = { summary: synthesis.content }; }
                const SynthSection = ({ label, items }) =>
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
                  ) : null;
                return (
                  <div className="space-y-5">
                    {r.summary && (
                      <div className="rounded-xl border border-accent/20 bg-accent/5 px-4 py-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                        {r.summary}
                      </div>
                    )}
                    <SynthSection label="Key Decisions" items={r.key_decisions} />
                    <SynthSection label="Risks" items={r.risks} />
                    <SynthSection label="Commitments" items={r.commitments} />
                    <SynthSection label="Opportunities" items={r.opportunities} />
                    <SynthSection label="Next Actions" items={r.next_actions} />
                    <SynthSection label="Open Questions" items={r.open_questions} />
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>
      </div>
    </main>
  );
}
