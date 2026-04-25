// backend/src/storage/intelLedger.js
// InteLedger persistence layer — JSON file-based (no database required)

import fs from 'fs/promises';
import path from 'path';
import { randomUUID, createHash } from 'node:crypto';

const empty = () => ({
  sessions: [],
  interactions: [],
  signals: [],
  syntheses: [],
  actions: [],
  jobs: [],
  entities: [],
  entity_links: [],
  signal_feedback: [],
  prompt_profiles: [],
  eval_runs: [],
  audit_events: []
});
const DEFAULT_SIGNAL_EXTRACTOR_VERSION = 'intelledger-signals-v2.4';

let _cache = null;
let _cachePath = null;
let _lock = Promise.resolve();

function summarizeText(content) {
  const cleaned = String(content || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const sentence = cleaned.split(/[.!?]/)[0].trim() || cleaned;
  return sentence.length > 130 ? `${sentence.slice(0, 127)}...` : sentence;
}

function stripLegacyCreatedLabel(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return /^created\b/i.test(cleaned) ? '' : cleaned;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'as', 'it', 'this', 'that', 'these', 'those',
  'from', 'about', 'into', 'over', 'after', 'before', 'between', 'we', 'you', 'they', 'he', 'she', 'i'
]);

function semanticTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function mergeSemanticTerms(existing, incoming, limit = 36) {
  const merged = [...new Set([...(Array.isArray(existing) ? existing : []), ...incoming])];
  return merged.slice(0, limit);
}

function normalizeForSearch(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function makeWeightedTermMap(fields) {
  const map = new Map();
  for (const field of fields) {
    const tokens = semanticTokens(field.text);
    for (const token of tokens) {
      const current = map.get(token) || 0;
      map.set(token, current + field.weight);
    }
  }
  return map;
}

function semanticScore(queryMap, documentMap, exactQuery) {
  if (!queryMap.size || !documentMap.size) return 0;
  let score = 0;
  for (const [token, queryWeight] of queryMap.entries()) {
    const docWeight = documentMap.get(token) || 0;
    if (docWeight > 0) {
      score += queryWeight * Math.sqrt(docWeight);
    }
  }
  if (exactQuery && Array.from(documentMap.keys()).join(' ').includes(exactQuery)) {
    score += 1.25;
  }
  return score;
}

function parseDueDateIso(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

function daysUntilIso(dateIso) {
  if (!dateIso || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso))) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(`${dateIso}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  return Math.floor((due.getTime() - today.getTime()) / 86400000);
}

function computeNextReminder({ priority, dueDate, isOverdue, status }) {
  if (String(status || 'open') === 'done') return null;

  const now = new Date();
  const reminder = new Date(now);
  const daysUntilDue = dueDate ? daysUntilIso(dueDate) : null;

  if (isOverdue) {
    reminder.setHours(reminder.getHours() + 1);
    return reminder.toISOString();
  }

  if (daysUntilDue !== null && daysUntilDue <= 1) {
    reminder.setHours(reminder.getHours() + 6);
    return reminder.toISOString();
  }

  if (priority === 'high') {
    reminder.setHours(reminder.getHours() + 12);
  } else if (priority === 'medium') {
    reminder.setHours(reminder.getHours() + 24);
  } else {
    reminder.setHours(reminder.getHours() + 48);
  }

  return reminder.toISOString();
}

function recalculateActionMeta(action) {
  const status = String(action.status || 'open').toLowerCase();
  const priority = String(action.priority || 'medium').toLowerCase();
  const dueDate = parseDueDateIso(action.due_date);
  const daysUntilDue = dueDate ? daysUntilIso(dueDate) : null;
  const isOverdue = status !== 'done' && daysUntilDue !== null && daysUntilDue < 0;

  const priorityWeight = priority === 'high' ? 24 : (priority === 'medium' ? 14 : 8);
  const dueWeight = dueDate ? 12 : 0;
  const overdueWeight = isOverdue ? Math.min(30, 12 + Math.abs(daysUntilDue || 0) * 3) : 0;
  const dueSoonWeight = !isOverdue && daysUntilDue !== null && daysUntilDue <= 2 ? 10 : 0;
  const blockedWeight = status === 'blocked' ? 8 : 0;
  const donePenalty = status === 'done' ? -60 : 0;
  const baseConfidenceWeight = Math.round(Math.max(0, Math.min(1, Number(action.confidence || 0.7))) * 18);
  const urgencyScore = Math.max(0, Math.min(100, priorityWeight + dueWeight + overdueWeight + dueSoonWeight + blockedWeight + baseConfidenceWeight + donePenalty));

  const escalationLevel = status === 'done'
    ? 'low'
    : (isOverdue ? 'high' : (!isOverdue && daysUntilDue !== null && daysUntilDue <= 1 ? 'medium' : 'low'));

  action.due_date = dueDate;
  action.is_overdue = isOverdue;
  action.urgency_score = urgencyScore;
  action.escalation_level = escalationLevel;
  action.next_reminder_at = computeNextReminder({ priority, dueDate, isOverdue, status });
}

function invalidateCache() { _cache = null; _cachePath = null; }

function normalizeStoreShape(store) {
  const candidate = store && typeof store === 'object' ? store : {};
  return {
    sessions: Array.isArray(candidate.sessions) ? candidate.sessions : [],
    interactions: Array.isArray(candidate.interactions) ? candidate.interactions : [],
    signals: Array.isArray(candidate.signals) ? candidate.signals : [],
    syntheses: Array.isArray(candidate.syntheses) ? candidate.syntheses : [],
    actions: Array.isArray(candidate.actions) ? candidate.actions : [],
    jobs: Array.isArray(candidate.jobs) ? candidate.jobs : [],
    entities: Array.isArray(candidate.entities) ? candidate.entities : [],
    entity_links: Array.isArray(candidate.entity_links) ? candidate.entity_links : [],
    signal_feedback: Array.isArray(candidate.signal_feedback) ? candidate.signal_feedback : [],
    prompt_profiles: Array.isArray(candidate.prompt_profiles) ? candidate.prompt_profiles : [],
    eval_runs: Array.isArray(candidate.eval_runs) ? candidate.eval_runs : [],
    audit_events: Array.isArray(candidate.audit_events) ? candidate.audit_events : []
  };
}

function normalizeEntityName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTenantId(value, fallback = '') {
  const trimmed = String(value || '').trim();
  if (trimmed) return trimmed.slice(0, 120);
  const fallbackTrimmed = String(fallback || '').trim();
  return fallbackTrimmed ? fallbackTrimmed.slice(0, 120) : 'default';
}

function normalizePromptProfileId(value) {
  const cleaned = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_');
  return cleaned.slice(0, 80) || null;
}

function normalizePromptVersionId(value) {
  const cleaned = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
  return cleaned.slice(0, 80) || null;
}

function hashPiiValue(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

function normalizeEntityKey(value) {
  return normalizeEntityName(value).toLowerCase();
}

function extractLikelyPeople(text) {
  const source = String(text || '');
  if (!source) return [];
  const matches = source.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g) || [];
  const blocked = new Set(['Next Week', 'Next Month', 'Inte Ledger', 'Speaker']);
  return [...new Set(matches.map((item) => normalizeEntityName(item)).filter((item) => item && !blocked.has(item)))].slice(0, 8);
}

function inferIdentityCandidates({ session, interaction, signals = [] }) {
  const candidates = [];
  const sessionTitle = normalizeEntityName(session?.title);
  if (sessionTitle) {
    candidates.push({
      entity_type: 'account',
      canonical_name: sessionTitle,
      confidence: 0.66,
      role: null,
      source_hint: 'session'
    });
  }

  const interactionType = String(interaction?.type || '').toLowerCase();
  const interactionSource = normalizeEntityName(interaction?.source_name || '');
  const hasAttachmentName = interactionSource && interactionSource !== 'manual';
  if (interactionSource) {
    candidates.push({
      entity_type: 'thread',
      canonical_name: interactionSource,
      confidence: 0.62,
      role: interactionType || null,
      source_hint: 'interaction'
    });
  }

  if (hasAttachmentName && /\.[a-z0-9]{2,6}$/i.test(interactionSource)) {
    candidates.push({
      entity_type: 'attachment',
      canonical_name: interactionSource,
      confidence: 0.6,
      role: null,
      source_hint: 'interaction'
    });
  }

  if (['media', 'meeting', 'transcript', 'audio', 'video'].includes(interactionType)) {
    candidates.push({
      entity_type: 'meeting',
      canonical_name: interactionSource || `meeting-${interaction?.id || 'unknown'}`,
      confidence: 0.68,
      role: null,
      source_hint: 'interaction'
    });
  }

  const titleLower = sessionTitle.toLowerCase();
  if (titleLower.includes('deal') || titleLower.includes('opportunit') || titleLower.includes('renewal')) {
    candidates.push({
      entity_type: 'deal',
      canonical_name: sessionTitle,
      confidence: 0.58,
      role: null,
      source_hint: 'session'
    });
  }

  for (const signal of (Array.isArray(signals) ? signals : [])) {
    const owner = normalizeEntityName(signal?.owner);
    if (owner) {
      candidates.push({
        entity_type: 'person',
        canonical_name: owner,
        confidence: 0.78,
        role: 'owner',
        source_hint: 'signal',
        source_signal_id: signal.id || null
      });
    }

    const speaker = normalizeEntityName(signal?.speaker);
    if (speaker) {
      candidates.push({
        entity_type: 'person',
        canonical_name: speaker,
        confidence: 0.72,
        role: 'speaker',
        source_hint: 'signal',
        source_signal_id: signal.id || null
      });
    }

    const textPeople = extractLikelyPeople(`${signal?.value || ''} ${signal?.quote || ''}`);
    for (const personName of textPeople) {
      candidates.push({
        entity_type: 'person',
        canonical_name: personName,
        confidence: 0.52,
        role: null,
        source_hint: 'signal',
        source_signal_id: signal.id || null
      });
    }
  }

  const deduped = new Map();
  for (const candidate of candidates) {
    const name = normalizeEntityName(candidate.canonical_name);
    if (!name) continue;
    const key = `${candidate.entity_type}:${normalizeEntityKey(name)}`;
    const previous = deduped.get(key);
    if (!previous || Number(candidate.confidence || 0) > Number(previous.confidence || 0)) {
      deduped.set(key, { ...candidate, canonical_name: name });
    }
  }
  return Array.from(deduped.values());
}

function clampSignalConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.6;
  return Math.max(0.2, Math.min(0.99, num));
}

function normalizeExtractorVersion(value) {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed.slice(0, 80) : DEFAULT_SIGNAL_EXTRACTOR_VERSION;
}

function withLock(fn) {
  let release;
  const ticket = new Promise(resolve => { release = resolve; });
  const prev = _lock;
  _lock = ticket;
  return prev.then(() => fn()).finally(() => release());
}

async function ensureStore(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try { await fs.access(filePath); }
  catch { await fs.writeFile(filePath, JSON.stringify(empty(), null, 2), 'utf8'); }
}

async function readStore(filePath) {
  await ensureStore(filePath);
  if (_cache && _cachePath === filePath) return _cache;
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    _cache = normalizeStoreShape(JSON.parse(raw));
    _cachePath = filePath;
    return _cache;
  }
  catch { return empty(); }
}

async function writeStore(filePath, data) {
  invalidateCache();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  _cache = data;
  _cachePath = filePath;
}

export function createIntelLedgerStorage(filePath) {
  const get = () => readStore(filePath);
  const set = (data) => writeStore(filePath, data);

  return {
    async ensureStore() { return ensureStore(filePath); },

    async listPromptProfiles() {
      const store = await get();
      return store.prompt_profiles
        .map((profile) => ({
          profile_id: profile.profile_id,
          active_version_id: profile.active_version_id || null,
          version_count: Array.isArray(profile.versions) ? profile.versions.length : 0,
          created_at: profile.created_at || null,
          updated_at: profile.updated_at || null
        }))
        .sort((a, b) => String(a.profile_id).localeCompare(String(b.profile_id)));
    },

    async getPromptProfile(profileId) {
      const normalizedProfile = normalizePromptProfileId(profileId);
      if (!normalizedProfile) return null;

      const store = await get();
      const profile = store.prompt_profiles.find((item) => item.profile_id === normalizedProfile);
      if (!profile) return null;

      const versions = Array.isArray(profile.versions)
        ? [...profile.versions].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        : [];

      return {
        profile_id: profile.profile_id,
        active_version_id: profile.active_version_id || null,
        created_at: profile.created_at || null,
        updated_at: profile.updated_at || null,
        versions
      };
    },

    async createPromptVersion(profileId, payload = {}) {
      return withLock(async () => {
        const normalizedProfile = normalizePromptProfileId(profileId);
        if (!normalizedProfile) {
          throw new Error('profileId is required');
        }

        const systemPrompt = String(payload.system_prompt || payload.systemPrompt || '').trim();
        const userTemplate = String(payload.user_template || payload.userTemplate || '').trim();
        if (!systemPrompt || !userTemplate) {
          throw new Error('system_prompt and user_template are required');
        }

        const store = await get();
        const now = new Date().toISOString();

        let profile = store.prompt_profiles.find((item) => item.profile_id === normalizedProfile);
        if (!profile) {
          profile = {
            profile_id: normalizedProfile,
            active_version_id: null,
            versions: [],
            created_at: now,
            updated_at: now
          };
          store.prompt_profiles.push(profile);
        }

        const requestedVersionId = normalizePromptVersionId(payload.version_id || payload.versionId || payload.version_key || payload.versionKey);
        const versionId = requestedVersionId || `${normalizedProfile}-${Date.now()}`;
        if ((profile.versions || []).some((item) => item.id === versionId)) {
          throw new Error(`prompt version already exists: ${versionId}`);
        }

        const version = {
          id: versionId,
          label: String(payload.label || payload.name || versionId).trim().slice(0, 140) || versionId,
          system_prompt: systemPrompt.slice(0, 12000),
          user_template: userTemplate.slice(0, 20000),
          created_at: now,
          created_by: String(payload.created_by || payload.createdBy || 'system').trim().slice(0, 80) || 'system'
        };

        profile.versions = Array.isArray(profile.versions) ? profile.versions : [];
        profile.versions.push(version);

        const setActive = payload.set_active !== false;
        if (setActive || !profile.active_version_id) {
          profile.active_version_id = version.id;
        }
        profile.updated_at = now;

        await set(store);
        return {
          profile_id: profile.profile_id,
          active_version_id: profile.active_version_id,
          version
        };
      });
    },

    async selectPromptVersion(profileId, versionId) {
      return withLock(async () => {
        const normalizedProfile = normalizePromptProfileId(profileId);
        const normalizedVersionId = normalizePromptVersionId(versionId);
        if (!normalizedProfile || !normalizedVersionId) return null;

        const store = await get();
        const profile = store.prompt_profiles.find((item) => item.profile_id === normalizedProfile);
        if (!profile) return null;
        const hasVersion = (profile.versions || []).some((item) => item.id === normalizedVersionId);
        if (!hasVersion) return null;

        profile.active_version_id = normalizedVersionId;
        profile.updated_at = new Date().toISOString();
        await set(store);

        const selected = (profile.versions || []).find((item) => item.id === normalizedVersionId) || null;
        return {
          profile_id: profile.profile_id,
          active_version_id: normalizedVersionId,
          version: selected
        };
      });
    },

    async resolvePromptVersion(profileId, fallback = null) {
      const normalizedProfile = normalizePromptProfileId(profileId);
      if (!normalizedProfile) return null;

      const profile = await this.getPromptProfile(normalizedProfile);
      if (!profile) {
        if (!fallback) return null;
        return {
          profile_id: normalizedProfile,
          id: normalizePromptVersionId(fallback.id || fallback.version_id) || 'default-v1',
          label: String(fallback.label || 'Default').trim(),
          system_prompt: String(fallback.system_prompt || '').trim(),
          user_template: String(fallback.user_template || '').trim(),
          created_at: null,
          created_by: 'builtin',
          is_fallback: true
        };
      }

      const activeId = normalizePromptVersionId(profile.active_version_id);
      const selected = (profile.versions || []).find((item) => item.id === activeId) || profile.versions?.[0] || null;
      if (!selected) {
        if (!fallback) return null;
        return {
          profile_id: normalizedProfile,
          id: normalizePromptVersionId(fallback.id || fallback.version_id) || 'default-v1',
          label: String(fallback.label || 'Default').trim(),
          system_prompt: String(fallback.system_prompt || '').trim(),
          user_template: String(fallback.user_template || '').trim(),
          created_at: null,
          created_by: 'builtin',
          is_fallback: true
        };
      }

      return {
        profile_id: normalizedProfile,
        id: selected.id,
        label: selected.label,
        system_prompt: selected.system_prompt,
        user_template: selected.user_template,
        created_at: selected.created_at || null,
        created_by: selected.created_by || 'system',
        is_fallback: false
      };
    },

    async createSession(userId, title, description, options = {}) {
      return withLock(async () => {
        const store = await get();
        const tenantId = normalizeTenantId(options.tenantId, userId || 'default');
        const session = {
          id: randomUUID(),
          user_id: userId,
          tenant_id: tenantId,
          title: title || 'Untitled',
          description: stripLegacyCreatedLabel(description),
          topic_preview: '',
          semantic_terms: semanticTokens(`${title || ''} ${description || ''}`).slice(0, 24),
          retention_days: null,
          pii_mode: 'standard',
          pii_retention_action: 'purge',
          archived: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        store.sessions.push(session);
        await set(store);
        return session;
      });
    },

    async getSession(sessionId) {
      const store = await get();
      return store.sessions.find(s => s.id === sessionId) || null;
    },

    async getSessionForTenant(sessionId, tenantId) {
      const session = await this.getSession(sessionId);
      if (!session) return null;
      const normalizedTenant = normalizeTenantId(tenantId);
      const sessionTenant = normalizeTenantId(session.tenant_id, session.user_id || 'default');
      return sessionTenant === normalizedTenant ? session : null;
    },

    async updateSessionTitle(sessionId, title) {
      return withLock(async () => {
        const store = await get();
        const session = store.sessions.find(s => s.id === sessionId);
        if (!session) return null;
        session.title = String(title || '').trim() || session.title;
        session.updated_at = new Date().toISOString();
        await set(store);
        return session;
      });
    },

    async updateSessionRetentionPolicy(sessionId, policy = {}) {
      return withLock(async () => {
        const store = await get();
        const session = store.sessions.find((item) => item.id === sessionId);
        if (!session) return null;

        if (Object.prototype.hasOwnProperty.call(policy, 'retention_days')) {
          const nextRetention = Number(policy.retention_days);
          session.retention_days = Number.isFinite(nextRetention) && nextRetention > 0
            ? Math.max(1, Math.min(Math.round(nextRetention), 3650))
            : null;
        }

        if (Object.prototype.hasOwnProperty.call(policy, 'pii_mode')) {
          const nextPiiMode = String(policy.pii_mode || '').trim().toLowerCase();
          const allowed = new Set(['standard', 'strict']);
          if (allowed.has(nextPiiMode)) {
            session.pii_mode = nextPiiMode;
          }
        }

        if (Object.prototype.hasOwnProperty.call(policy, 'pii_retention_action')) {
          const nextAction = String(policy.pii_retention_action || '').trim().toLowerCase();
          const allowedActions = new Set(['purge', 'hash']);
          if (allowedActions.has(nextAction)) {
            session.pii_retention_action = nextAction;
          }
        }

        session.updated_at = new Date().toISOString();
        await set(store);
        return session;
      });
    },

    async runRetentionSweep(sessionId, options = {}) {
      return withLock(async () => {
        const store = await get();
        const session = store.sessions.find((item) => item.id === sessionId);
        if (!session) return null;

        const configuredRetentionDays = Number(session.retention_days);
        const overrideDays = Number(options.retention_days);
        const days = Number.isFinite(overrideDays) && overrideDays > 0
          ? Math.max(1, Math.min(Math.round(overrideDays), 3650))
          : (Number.isFinite(configuredRetentionDays) && configuredRetentionDays > 0 ? configuredRetentionDays : null);

        if (!days) {
          return {
            session_id: sessionId,
            retention_days: null,
            cutoff_at: null,
            purged: {
              interactions: 0,
              signals: 0,
              syntheses: 0,
              actions: 0,
              jobs: 0,
              entities: 0,
              entity_links: 0,
              signal_feedback: 0
            }
          };
        }

        const requestedNow = options.now ? new Date(options.now).getTime() : Date.now();
        const now = Number.isFinite(requestedNow) ? requestedNow : Date.now();
        const cutoffMs = now - (days * 24 * 60 * 60 * 1000);
        const cutoffIso = new Date(cutoffMs).toISOString();

        const staleInteractionIds = new Set(
          store.interactions
            .filter((item) => item.session_id === sessionId && new Date(item.ingested_at || 0).getTime() < cutoffMs)
            .map((item) => item.id)
        );

        const staleSignalIds = new Set(
          store.signals
            .filter((item) => item.session_id === sessionId && new Date(item.extracted_at || 0).getTime() < cutoffMs)
            .map((item) => item.id)
        );

        const staleActionIds = new Set(
          store.actions
            .filter((item) => item.session_id === sessionId && new Date(item.updated_at || item.created_at || 0).getTime() < cutoffMs)
            .map((item) => item.id)
        );

        const staleEntityIds = new Set(
          store.entities
            .filter((item) => item.session_id === sessionId && new Date(item.last_seen_at || item.updated_at || 0).getTime() < cutoffMs)
            .map((item) => item.id)
        );

        const before = {
          interactions: store.interactions.length,
          signals: store.signals.length,
          syntheses: store.syntheses.length,
          actions: store.actions.length,
          jobs: store.jobs.length,
          entities: store.entities.length,
          entity_links: store.entity_links.length,
          signal_feedback: store.signal_feedback.length
        };

        const hashed = {
          interactions: 0,
          signals: 0,
          syntheses: 0
        };

        const shouldHashStalePii = String(session.pii_mode || 'standard') === 'strict'
          && String(session.pii_retention_action || 'purge') === 'hash';

        if (shouldHashStalePii) {
          for (const interaction of store.interactions) {
            if (interaction.session_id !== sessionId || !staleInteractionIds.has(interaction.id)) continue;
            interaction.raw_content = hashPiiValue(interaction.raw_content);
            interaction.transcript_summary = hashPiiValue(interaction.transcript_summary);
            interaction.transcript_segments = [];
            interaction.redacted_at = new Date(now).toISOString();
            interaction.redaction_mode = 'hash';
            hashed.interactions += 1;
          }

          for (const signal of store.signals) {
            if (signal.session_id !== sessionId || !staleSignalIds.has(signal.id)) continue;
            signal.value = hashPiiValue(signal.value);
            signal.quote = hashPiiValue(signal.quote);
            signal.owner = signal.owner ? hashPiiValue(signal.owner) : null;
            signal.ask = signal.ask ? hashPiiValue(signal.ask) : null;
            signal.commitment = signal.commitment ? hashPiiValue(signal.commitment) : null;
            signal.risk = signal.risk ? hashPiiValue(signal.risk) : null;
            signal.decision = signal.decision ? hashPiiValue(signal.decision) : null;
            signal.redacted_at = new Date(now).toISOString();
            signal.redaction_mode = 'hash';
            hashed.signals += 1;
          }

          for (const synthesis of store.syntheses) {
            if (synthesis.session_id !== sessionId || new Date(synthesis.created_at || 0).getTime() >= cutoffMs) continue;
            synthesis.content = hashPiiValue(synthesis.content);
            synthesis.redacted_at = new Date(now).toISOString();
            synthesis.redaction_mode = 'hash';
            hashed.syntheses += 1;
          }
        }

        if (!shouldHashStalePii) {
          store.interactions = store.interactions.filter((item) => !(item.session_id === sessionId && staleInteractionIds.has(item.id)));
          store.signals = store.signals.filter((item) => !(item.session_id === sessionId && staleSignalIds.has(item.id)));
          store.syntheses = store.syntheses.filter((item) => !(item.session_id === sessionId && new Date(item.created_at || 0).getTime() < cutoffMs));
        }
        store.actions = store.actions.filter((item) => !(item.session_id === sessionId && staleActionIds.has(item.id)));
        store.jobs = store.jobs.filter((item) => !(item.session_id === sessionId && new Date(item.created_at || 0).getTime() < cutoffMs));
        store.entities = store.entities.filter((item) => !(item.session_id === sessionId && staleEntityIds.has(item.id)));

        store.entity_links = store.entity_links.filter((link) => {
          if (link.session_id !== sessionId) return true;
          if (staleEntityIds.has(link.entity_id)) return false;
          if (link.interaction_id && staleInteractionIds.has(link.interaction_id)) return false;
          if (link.signal_id && staleSignalIds.has(link.signal_id)) return false;
          return true;
        });

        store.signal_feedback = store.signal_feedback.filter((item) => {
          if (item.session_id !== sessionId) return true;
          if (item.signal_id && staleSignalIds.has(item.signal_id)) return false;
          return new Date(item.created_at || 0).getTime() >= cutoffMs;
        });

        session.updated_at = new Date().toISOString();
        await set(store);

        const after = {
          interactions: store.interactions.length,
          signals: store.signals.length,
          syntheses: store.syntheses.length,
          actions: store.actions.length,
          jobs: store.jobs.length,
          entities: store.entities.length,
          entity_links: store.entity_links.length,
          signal_feedback: store.signal_feedback.length
        };

        return {
          session_id: sessionId,
          retention_days: days,
          pii_retention_action: shouldHashStalePii ? 'hash' : 'purge',
          cutoff_at: cutoffIso,
          hashed,
          purged: {
            interactions: before.interactions - after.interactions,
            signals: before.signals - after.signals,
            syntheses: before.syntheses - after.syntheses,
            actions: before.actions - after.actions,
            jobs: before.jobs - after.jobs,
            entities: before.entities - after.entities,
            entity_links: before.entity_links - after.entity_links,
            signal_feedback: before.signal_feedback - after.signal_feedback
          }
        };
      });
    },

    async listSessions(userId, options = {}) {
      const store = await get();
      const normalizedTenant = options.tenantId ? normalizeTenantId(options.tenantId) : null;
      const interactionCountBySession = new Map();
      const signalCountBySession = new Map();
      const synthesisCountBySession = new Map();
      const actionCountBySession = new Map();
      const latestPreviewBySession = new Map();
      const latestPreviewTimeBySession = new Map();

      for (const interaction of store.interactions) {
        if (!interaction?.session_id) continue;
        const currentCount = interactionCountBySession.get(interaction.session_id) || 0;
        interactionCountBySession.set(interaction.session_id, currentCount + 1);

        const currentTime = latestPreviewTimeBySession.get(interaction.session_id) || '';
        const nextTime = String(interaction.ingested_at || '');
        if (nextTime >= currentTime) {
          latestPreviewTimeBySession.set(interaction.session_id, nextTime);
          latestPreviewBySession.set(interaction.session_id, summarizeText(interaction.raw_content));
        }
      }

      for (const signal of store.signals) {
        if (!signal?.session_id) continue;
        const currentCount = signalCountBySession.get(signal.session_id) || 0;
        signalCountBySession.set(signal.session_id, currentCount + 1);
      }

      for (const synthesis of store.syntheses) {
        if (!synthesis?.session_id) continue;
        const currentCount = synthesisCountBySession.get(synthesis.session_id) || 0;
        synthesisCountBySession.set(synthesis.session_id, currentCount + 1);
      }

      for (const action of store.actions) {
        if (!action?.session_id) continue;
        const currentCount = actionCountBySession.get(action.session_id) || 0;
        actionCountBySession.set(action.session_id, currentCount + 1);
      }

      return store.sessions
        .filter((s) => {
          if (s.user_id !== userId || s.archived) return false;
          if (!normalizedTenant) return true;
          const sessionTenant = normalizeTenantId(s.tenant_id, s.user_id || 'default');
          return sessionTenant === normalizedTenant;
        })
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .map((session) => {
          const interactionCount = interactionCountBySession.get(session.id) || 0;
          const signalCount = signalCountBySession.get(session.id) || 0;
          const synthesisCount = synthesisCountBySession.get(session.id) || 0;
          const actionCount = actionCountBySession.get(session.id) || 0;
          return {
            ...session,
            description: stripLegacyCreatedLabel(session.description),
            topic_preview: stripLegacyCreatedLabel(session.topic_preview || latestPreviewBySession.get(session.id) || ''),
            interaction_count: interactionCount,
            signal_count: signalCount,
            synthesis_count: synthesisCount,
            action_count: actionCount,
            activity_count: interactionCount + signalCount + synthesisCount + actionCount
          };
        });
    },

    async deleteSession(sessionId) {
      return withLock(async () => {
        const store = await get();
        store.sessions    = store.sessions.filter(s => s.id !== sessionId);
        store.interactions = store.interactions.filter(i => i.session_id !== sessionId);
        store.signals      = store.signals.filter(s => s.session_id !== sessionId);
        store.syntheses    = store.syntheses.filter(s => s.session_id !== sessionId);
        store.actions      = store.actions.filter(a => a.session_id !== sessionId);
        store.jobs         = store.jobs.filter(j => j.session_id !== sessionId);
        store.entities     = store.entities.filter((e) => e.session_id !== sessionId);
        store.entity_links = store.entity_links.filter((l) => l.session_id !== sessionId);
        store.signal_feedback = store.signal_feedback.filter((f) => f.session_id !== sessionId);
        await set(store);
      });
    },

    async ingestInteraction(sessionId, type, rawContent, sourceName) {
      return withLock(async () => {
        const store = await get();
        const interaction = {
          id: randomUUID(),
          session_id: sessionId,
          type,
          raw_content: rawContent,
          source_name: sourceName || 'manual',
          extracted: false,
          ingested_at: new Date().toISOString()
        };
        store.interactions.push(interaction);
        const sess = store.sessions.find(s => s.id === sessionId);
        if (sess) {
          sess.updated_at = new Date().toISOString();
          const preview = summarizeText(rawContent);
          if (preview) sess.topic_preview = preview;
          sess.semantic_terms = mergeSemanticTerms(sess.semantic_terms, semanticTokens(rawContent));
        }
        await set(store);
        return interaction;
      });
    },

    async updateInteraction(sessionId, interactionId, patch = {}) {
      return withLock(async () => {
        const store = await get();
        const interaction = store.interactions.find((item) => item.session_id === sessionId && item.id === interactionId);
        if (!interaction) return null;

        if (typeof patch.raw_content === 'string') {
          interaction.raw_content = patch.raw_content;
        }
        if (typeof patch.extracted === 'boolean') {
          interaction.extracted = patch.extracted;
        }

        const passthroughKeys = [
          'type',
          'source_name',
          'media',
          'transcript_status',
          'transcript_segments',
          'transcript_summary',
          'job_id'
        ];
        for (const key of passthroughKeys) {
          if (Object.prototype.hasOwnProperty.call(patch, key)) {
            interaction[key] = patch[key];
          }
        }

        const sess = store.sessions.find((s) => s.id === sessionId);
        if (sess) {
          sess.updated_at = new Date().toISOString();
          const preview = summarizeText(interaction.raw_content);
          if (preview) sess.topic_preview = preview;
        }

        await set(store);
        return interaction;
      });
    },

    async searchSessions(userId, query, limit = 30, options = {}) {
      const cleanedQuery = String(query || '').trim().toLowerCase();
      const max = Math.max(1, Math.min(Number(limit) || 30, 100));
      const sessions = await this.listSessions(userId, options);
      if (!cleanedQuery) return sessions.slice(0, max);

      const queryMap = makeWeightedTermMap([{ text: cleanedQuery, weight: 2 }]);
      const store = await get();
      const interactionsBySession = new Map();
      const signalsBySession = new Map();
      const synthesesBySession = new Map();

      for (const interaction of store.interactions) {
        if (!interaction?.session_id) continue;
        const list = interactionsBySession.get(interaction.session_id) || [];
        list.push(interaction);
        interactionsBySession.set(interaction.session_id, list);
      }

      for (const signal of store.signals) {
        if (!signal?.session_id) continue;
        const list = signalsBySession.get(signal.session_id) || [];
        list.push(signal);
        signalsBySession.set(signal.session_id, list);
      }

      for (const synthesis of store.syntheses) {
        if (!synthesis?.session_id) continue;
        const list = synthesesBySession.get(synthesis.session_id) || [];
        list.push(synthesis);
        synthesesBySession.set(synthesis.session_id, list);
      }

      const ranked = sessions
        .map((session) => {
          const interactions = interactionsBySession.get(session.id) || [];
          const signals = signalsBySession.get(session.id) || [];
          const syntheses = synthesesBySession.get(session.id) || [];

          const interactionText = interactions.map((item) => `${item.type || ''} ${item.source_name || ''} ${item.raw_content || ''}`).join(' ');
          const signalText = signals.map((item) => `${item.signal_type || ''} ${item.value || ''}`).join(' ');
          const synthesisText = syntheses.map((item) => item.content || '').join(' ');
          const fullText = normalizeForSearch([
            session.title,
            session.description,
            session.topic_preview,
            (session.semantic_terms || []).join(' '),
            interactionText,
            signalText,
            synthesisText
          ].join(' '));

          const lexicalMatch = cleanedQuery.length >= 2 && fullText.includes(cleanedQuery);
          const documentMap = makeWeightedTermMap([
            { text: session.title, weight: 4 },
            { text: session.description, weight: 2 },
            { text: session.topic_preview, weight: 3 },
            { text: (session.semantic_terms || []).join(' '), weight: 2 },
            { text: interactionText, weight: 1 },
            { text: signalText, weight: 1.5 },
            { text: synthesisText, weight: 1 }
          ]);

          let score = semanticScore(queryMap, documentMap, cleanedQuery);
          if (lexicalMatch) {
            score += 2.5;
          }
          return { ...session, semantic_score: Number(score.toFixed(3)), lexical_match: lexicalMatch };
        })
        .filter((session) => session.semantic_score > 0 || session.lexical_match)
        .sort((a, b) => b.semantic_score - a.semantic_score || new Date(b.updated_at) - new Date(a.updated_at));

      return ranked.slice(0, max);
    },

    async getInteractions(sessionId) {
      const store = await get();
      return store.interactions
        .filter(i => i.session_id === sessionId)
        .sort((a, b) => new Date(b.ingested_at) - new Date(a.ingested_at));
    },

    async getInteraction(sessionId, interactionId) {
      const store = await get();
      return store.interactions.find((item) => item.session_id === sessionId && item.id === interactionId) || null;
    },

    async storeSignals(sessionId, interactionId, signals, options = {}) {
      return withLock(async () => {
        const store = await get();
        const extractorVersion = normalizeExtractorVersion(options.extractorVersion);
        const stored = (Array.isArray(signals) ? signals : []).map((sig) => {
          const signalType = String(sig.type || sig.signal_type || '').trim().toLowerCase();
          const value = String(sig.value || sig.quote || '').trim().slice(0, 320);
          if (!signalType || !value) return null;

          const quote = String(sig.quote || value).trim().slice(0, 600) || value;
          const extractedAt = new Date().toISOString();
          const sourceId = String(sig.source_id || sig.sourceId || interactionId || '').trim() || interactionId;
          const confidence = clampSignalConfidence(sig.confidence);
          const resolvedExtractorVersion = normalizeExtractorVersion(sig.extractor_version || sig.extractorVersion || extractorVersion);

          return {
            id: randomUUID(),
            session_id: sessionId,
            interaction_id: interactionId,
            signal_type: signalType,
            value,
            quote,
            source_id: sourceId,
            extractor_version: resolvedExtractorVersion,
            prompt_profile: options.promptProfile ? String(options.promptProfile).trim().slice(0, 80) : null,
            prompt_version: options.promptVersion ? String(options.promptVersion).trim().slice(0, 80) : null,
            owner: sig.owner || null,
            due_date: sig.due_date || null,
            ask: sig.ask || null,
            commitment: sig.commitment || null,
            risk: sig.risk || null,
            decision: sig.decision || null,
            speaker: sig.speaker || null,
            start_ms: Number.isFinite(Number(sig.start_ms)) ? Number(sig.start_ms) : null,
            end_ms: Number.isFinite(Number(sig.end_ms)) ? Number(sig.end_ms) : null,
            confidence,
            extracted_at: extractedAt,
            evidence: {
              quote,
              source_id: sourceId,
              timestamp: extractedAt,
              confidence,
              extractor_version: resolvedExtractorVersion
            }
          };
        }).filter(Boolean);
        store.signals.push(...stored);
        await set(store);
        return stored;
      });
    },

    async getSignalsBySession(sessionId, signalType = null) {
      const store = await get();
      return store.signals
        .filter(s => s.session_id === sessionId && (!signalType || s.signal_type === signalType))
        .map((signal) => {
          const quote = String(signal.quote || signal.value || '').trim() || null;
          const sourceId = String(signal.source_id || signal.interaction_id || '').trim() || null;
          const extractorVersion = normalizeExtractorVersion(signal.extractor_version || 'legacy-unknown');
          const confidence = clampSignalConfidence(signal.confidence);
          const extractedAt = signal.extracted_at || null;

          return {
            ...signal,
            quote,
            source_id: sourceId,
            extractor_version: extractorVersion,
            confidence,
            evidence: signal.evidence || {
              quote,
              source_id: sourceId,
              timestamp: extractedAt,
              confidence,
              extractor_version: extractorVersion
            }
          };
        })
        .sort((a, b) => new Date(b.extracted_at) - new Date(a.extracted_at));
    },

    async addSignalFeedback(sessionId, signalId, verdict, note = '', source = 'human') {
      return withLock(async () => {
        const store = await get();
        const signal = store.signals.find((item) => item.session_id === sessionId && item.id === signalId);
        if (!signal) return null;

        const normalizedVerdict = String(verdict || '').trim().toLowerCase();
        if (!['accept', 'reject'].includes(normalizedVerdict)) {
          throw new Error('verdict must be accept or reject');
        }

        const now = new Date().toISOString();
        const feedback = {
          id: randomUUID(),
          session_id: sessionId,
          signal_id: signalId,
          verdict: normalizedVerdict,
          note: String(note || '').trim().slice(0, 400) || null,
          source: String(source || 'human').trim().slice(0, 60) || 'human',
          created_at: now
        };

        store.signal_feedback.push(feedback);
        signal.feedback_count = Number(signal.feedback_count || 0) + 1;
        signal.last_feedback_verdict = normalizedVerdict;
        signal.last_feedback_at = now;

        await set(store);
        return feedback;
      });
    },

    async getSignalFeedbackBySession(sessionId) {
      const store = await get();
      return store.signal_feedback
        .filter((item) => item.session_id === sessionId)
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    },

    async getSignalQualityMetrics(sessionId, { windowDays = 30 } = {}) {
      const store = await get();
      const days = Math.max(1, Math.min(Number(windowDays) || 30, 365));
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

      const signals = store.signals.filter((item) => item.session_id === sessionId);
      const feedbackRows = store.signal_feedback.filter((item) => {
        if (item.session_id !== sessionId) return false;
        const createdAt = new Date(item.created_at || 0).getTime();
        return Number.isFinite(createdAt) && createdAt >= cutoff;
      });

      const accepted = feedbackRows.filter((item) => item.verdict === 'accept').length;
      const rejected = feedbackRows.filter((item) => item.verdict === 'reject').length;
      const totalFeedback = feedbackRows.length;

      const evidenceCompleteCount = signals.filter((item) => {
        const quote = String(item.quote || '').trim();
        const sourceId = String(item.source_id || '').trim();
        const timestamp = String(item.extracted_at || '').trim();
        const confidence = Number(item.confidence);
        const extractorVersion = String(item.extractor_version || '').trim();
        return Boolean(quote && sourceId && timestamp && extractorVersion && Number.isFinite(confidence));
      }).length;

      const feedbackBySignal = new Map();
      for (const row of feedbackRows) {
        const current = feedbackBySignal.get(row.signal_id) || { accept: 0, reject: 0 };
        if (row.verdict === 'accept') current.accept += 1;
        if (row.verdict === 'reject') current.reject += 1;
        feedbackBySignal.set(row.signal_id, current);
      }

      const citedSignalsWithFeedback = Array.from(feedbackBySignal.entries())
        .filter(([signalId]) => {
          const signal = signals.find((item) => item.id === signalId);
          return signal && String(signal.quote || '').trim();
        });

      const citationCorrect = citedSignalsWithFeedback.filter(([, votes]) => votes.accept > votes.reject).length;
      const citationWrong = citedSignalsWithFeedback.filter(([, votes]) => votes.reject > votes.accept).length;
      const citationDenominator = citedSignalsWithFeedback.length;

      const ratio = (num, den) => (den > 0 ? Number((num / den).toFixed(4)) : null);
      return {
        generated_at: new Date().toISOString(),
        window_days: days,
        signal_count: signals.length,
        feedback_count: totalFeedback,
        accepted_count: accepted,
        rejected_count: rejected,
        useful_insight_rate: ratio(accepted, totalFeedback),
        extraction_precision_proxy: ratio(accepted, accepted + rejected),
        citation_correctness_rate: ratio(citationCorrect, citationDenominator),
        citation_wrong_count: citationWrong,
        evidence_coverage_rate: ratio(evidenceCompleteCount, signals.length)
      };
    },

    async runSessionEvaluation(sessionId, options = {}) {
      return withLock(async () => {
        const store = await get();
        const session = store.sessions.find((item) => item.id === sessionId);
        if (!session) return null;

        const windowDays = Math.max(1, Math.min(Number(options.windowDays || options.window_days || 30) || 30, 365));
        const metrics = await this.getSignalQualityMetrics(sessionId, { windowDays });

        const interactions = store.interactions.filter((item) => item.session_id === sessionId);
        const signals = store.signals.filter((item) => item.session_id === sessionId);
        const actions = store.actions.filter((item) => item.session_id === sessionId);
        const syntheses = store.syntheses.filter((item) => item.session_id === sessionId);

        const openActionCount = actions.filter((item) => String(item.status || '').toLowerCase() !== 'done').length;
        const signalCount = signals.length;
        const actionCoverage = signalCount > 0 ? Math.min(1, openActionCount / signalCount) : (openActionCount > 0 ? 1 : 0);

        const toRatio = (value) => {
          const num = Number(value);
          return Number.isFinite(num) && num >= 0 ? Math.min(1, num) : 0;
        };

        const dimensions = {
          evidence_coverage: toRatio(metrics.evidence_coverage_rate),
          extraction_precision: toRatio(metrics.extraction_precision_proxy),
          useful_insight_rate: toRatio(metrics.useful_insight_rate),
          citation_correctness: toRatio(metrics.citation_correctness_rate),
          action_coverage: toRatio(actionCoverage)
        };

        const weighted = (
          dimensions.evidence_coverage * 0.26 +
          dimensions.extraction_precision * 0.28 +
          dimensions.useful_insight_rate * 0.2 +
          dimensions.citation_correctness * 0.16 +
          dimensions.action_coverage * 0.1
        );
        const overallScore = Number((weighted * 100).toFixed(2));
        const status = overallScore >= 80 ? 'pass' : (overallScore >= 60 ? 'watch' : 'fail');

        const now = new Date().toISOString();
        const run = {
          id: randomUUID(),
          session_id: sessionId,
          session_title: session.title || 'Untitled',
          user_id: session.user_id,
          tenant_id: session.tenant_id || null,
          trigger: String(options.trigger || 'manual').slice(0, 40),
          note: options.note ? String(options.note).slice(0, 300) : null,
          tags: Array.isArray(options.tags) ? options.tags.map((item) => String(item).trim()).filter(Boolean).slice(0, 12) : [],
          window_days: windowDays,
          counts: {
            interactions: interactions.length,
            signals: signalCount,
            syntheses: syntheses.length,
            actions: actions.length,
            open_actions: openActionCount
          },
          metrics,
          dimensions,
          overall_score: overallScore,
          status,
          created_at: now
        };

        store.eval_runs.push(run);
        await set(store);
        return run;
      });
    },

    async getEvalRunsBySession(sessionId, options = {}) {
      const store = await get();
      const limit = Math.max(1, Math.min(Number(options.limit || 50) || 50, 200));
      return store.eval_runs
        .filter((item) => item.session_id === sessionId)
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, limit);
    },

    async getEvalRunById(runId) {
      const store = await get();
      return store.eval_runs.find((item) => item.id === runId) || null;
    },

    async appendAuditEvent(event = {}) {
      return withLock(async () => {
        const store = await get();
        const now = new Date().toISOString();
        const entry = {
          id: randomUUID(),
          event_type: String(event.event_type || event.eventType || 'unknown').slice(0, 80),
          session_id: event.session_id ? String(event.session_id).slice(0, 120) : null,
          actor_user_id: event.actor_user_id ? String(event.actor_user_id).slice(0, 120) : null,
          actor_tenant_id: event.actor_tenant_id ? String(event.actor_tenant_id).slice(0, 120) : null,
          source_ip: event.source_ip ? String(event.source_ip).slice(0, 120) : null,
          metadata: event.metadata && typeof event.metadata === 'object' ? event.metadata : null,
          created_at: now
        };

        store.audit_events.push(entry);
        store.audit_events = store.audit_events.slice(-5000);
        await set(store);
        return entry;
      });
    },

    async getAuditEvents(options = {}) {
      const store = await get();
      const limit = Math.max(1, Math.min(Number(options.limit || 100) || 100, 500));
      const sessionId = options.sessionId ? String(options.sessionId) : null;
      const eventType = options.eventType ? String(options.eventType) : null;

      return store.audit_events
        .filter((item) => {
          if (sessionId && item.session_id !== sessionId) return false;
          if (eventType && item.event_type !== eventType) return false;
          return true;
        })
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, limit);
    },

    async runBatchEvaluation(sessionIds = [], options = {}) {
      const uniqueIds = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map((item) => String(item || '').trim()).filter(Boolean))];
      const runs = [];
      for (const sessionId of uniqueIds) {
        const run = await this.runSessionEvaluation(sessionId, options);
        if (run) runs.push(run);
      }

      const summary = {
        total: runs.length,
        pass: runs.filter((item) => item.status === 'pass').length,
        watch: runs.filter((item) => item.status === 'watch').length,
        fail: runs.filter((item) => item.status === 'fail').length,
        avg_score: runs.length > 0
          ? Number((runs.reduce((acc, item) => acc + Number(item.overall_score || 0), 0) / runs.length).toFixed(2))
          : null
      };

      return { runs, summary };
    },

    async upsertEntitiesForInteraction(sessionId, interactionId, signals = []) {
      return withLock(async () => {
        const store = await get();
        const session = store.sessions.find((item) => item.id === sessionId);
        const interaction = store.interactions.find((item) => item.id === interactionId && item.session_id === sessionId);
        if (!session || !interaction) {
          return { entities: [], links: [] };
        }

        const now = new Date().toISOString();
        const candidates = inferIdentityCandidates({ session, interaction, signals });
        const upserted = [];
        const links = [];

        for (const candidate of candidates) {
          const key = normalizeEntityKey(candidate.canonical_name);
          if (!key) continue;

          let entity = store.entities.find((item) => (
            item.session_id === sessionId &&
            item.entity_type === candidate.entity_type &&
            normalizeEntityKey(item.canonical_name) === key
          ));

          if (!entity) {
            entity = {
              id: randomUUID(),
              session_id: sessionId,
              entity_type: candidate.entity_type,
              canonical_name: candidate.canonical_name,
              role: candidate.role || null,
              confidence: Number(candidate.confidence || 0.6),
              aliases: [],
              source_ids: [interactionId],
              mention_count: 1,
              first_seen_at: now,
              last_seen_at: now,
              created_at: now,
              updated_at: now
            };
            store.entities.push(entity);
          } else {
            entity.last_seen_at = now;
            entity.updated_at = now;
            entity.mention_count = Number(entity.mention_count || 0) + 1;
            entity.confidence = Math.max(Number(entity.confidence || 0), Number(candidate.confidence || 0));
            if (candidate.role && !entity.role) {
              entity.role = candidate.role;
            }
            const sourceIds = new Set(Array.isArray(entity.source_ids) ? entity.source_ids : []);
            sourceIds.add(interactionId);
            entity.source_ids = Array.from(sourceIds).slice(-50);
          }

          upserted.push(entity);

          const signalId = candidate.source_signal_id || null;
          const relationType = candidate.source_hint || 'interaction';
          const existingLink = store.entity_links.find((item) => (
            item.session_id === sessionId &&
            item.entity_id === entity.id &&
            item.interaction_id === interactionId &&
            item.signal_id === signalId &&
            item.relation_type === relationType
          ));
          if (!existingLink) {
            const link = {
              id: randomUUID(),
              session_id: sessionId,
              entity_id: entity.id,
              interaction_id: interactionId,
              signal_id: signalId,
              relation_type: relationType,
              created_at: now
            };
            store.entity_links.push(link);
            links.push(link);
          }
        }

        await set(store);
        return { entities: upserted, links };
      });
    },

    async getEntitiesBySession(sessionId, entityType = null) {
      const store = await get();
      const filtered = store.entities
        .filter((item) => item.session_id === sessionId && (!entityType || item.entity_type === entityType));

      return filtered
        .map((entity) => {
          const links = store.entity_links.filter((link) => link.entity_id === entity.id && link.session_id === sessionId);
          return {
            ...entity,
            link_count: links.length
          };
        })
        .sort((a, b) => Number(b.mention_count || 0) - Number(a.mention_count || 0));
    },

    async getEntityLinksBySession(sessionId) {
      const store = await get();
      return store.entity_links
        .filter((item) => item.session_id === sessionId)
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    },

    async storeSynthesis(sessionId, synthesisType, content, modelUsed, tokensUsed, options = {}) {
      return withLock(async () => {
        const store = await get();
        const entry = {
          id: randomUUID(),
          session_id: sessionId,
          synthesis_type: synthesisType,
          content,
          model_used: modelUsed || '',
          tokens_used: tokensUsed || 0,
          prompt_profile: options.promptProfile ? String(options.promptProfile).trim().slice(0, 80) : null,
          prompt_version: options.promptVersion ? String(options.promptVersion).trim().slice(0, 80) : null,
          created_at: new Date().toISOString()
        };
        store.syntheses.push(entry);
        await set(store);
        return entry;
      });
    },

    async getSynthesisBySession(sessionId, type = null) {
      const store = await get();
      return store.syntheses
        .filter(s => s.session_id === sessionId && (!type || s.synthesis_type === type))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },

    async replaceActionsForSession(sessionId, actions, source = 'auto') {
      return withLock(async () => {
        const store = await get();
        const existing = store.actions.filter((item) => item.session_id === sessionId);

        const normalizeTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        const tokenSet = (t) => new Set(normalizeTitle(t).split(' ').filter(Boolean));
        const jaccard = (a, b) => {
          const aSet = tokenSet(a);
          const bSet = tokenSet(b);
          if (!aSet.size || !bSet.size) return 0;
          let intersection = 0;
          for (const token of aSet) {
            if (bSet.has(token)) intersection += 1;
          }
          const union = aSet.size + bSet.size - intersection;
          return union ? (intersection / union) : 0;
        };

        const isManualTouched = (action) => (
          action.status !== 'open' || Boolean(action.owner) || Boolean(action.due_date)
        );

        const findMatch = (incomingAction) => {
          if (incomingAction.source_signal_id) {
            const bySignal = existing.find((item) => item.source_signal_id && item.source_signal_id === incomingAction.source_signal_id);
            if (bySignal) return bySignal;
          }

          const sameType = existing.filter((item) => (item.source_signal_type || '') === (incomingAction.source_signal_type || ''));
          const incomingNorm = normalizeTitle(incomingAction.title);

          const exact = sameType.find((item) => normalizeTitle(item.title) === incomingNorm);
          if (exact) return exact;

          let best = null;
          let bestScore = 0;
          for (const candidate of sameType) {
            const score = jaccard(candidate.title, incomingAction.title);
            if (score > bestScore) {
              bestScore = score;
              best = candidate;
            }
          }

          return bestScore >= 0.72 ? best : null;
        };

        const now = new Date().toISOString();
        const incoming = (Array.isArray(actions) ? actions : []).map((action) => ({
          id: randomUUID(),
          session_id: sessionId,
          title: String(action.title || '').trim() || 'Follow up',
          owner: action.owner ? String(action.owner).trim() : null,
          due_date: action.due_date ? String(action.due_date).trim() : null,
          priority: String(action.priority || 'medium').toLowerCase(),
          status: String(action.status || 'open').toLowerCase(),
          rationale: action.rationale ? String(action.rationale).trim() : null,
          source_signal_id: action.source_signal_id || null,
          source_signal_type: action.source_signal_type || null,
          confidence: Number(action.confidence || 0.7),
          urgency_score: Number(action.urgency_score || 0),
          escalation_level: action.escalation_level ? String(action.escalation_level).toLowerCase() : null,
          next_reminder_at: action.next_reminder_at ? String(action.next_reminder_at) : null,
          is_overdue: Boolean(action.is_overdue),
          source,
          created_at: now,
          updated_at: now
        }));

        const matchedExistingIds = new Set();
        const toAdd = [];
        for (const item of incoming) {
          const matched = findMatch(item);
          if (matched) {
            matchedExistingIds.add(matched.id);
            if (!isManualTouched(matched)) {
              matched.rationale = item.rationale;
              matched.confidence = item.confidence;
              matched.urgency_score = item.urgency_score;
              matched.escalation_level = item.escalation_level;
              matched.next_reminder_at = item.next_reminder_at;
              matched.is_overdue = item.is_overdue;
              matched.source_signal_id = item.source_signal_id || matched.source_signal_id;
              matched.source_signal_type = item.source_signal_type || matched.source_signal_type;
              matched.updated_at = now;
            }
            continue;
          }
          toAdd.push(item);
        }

        store.actions = [
          ...store.actions.filter((item) => item.session_id !== sessionId),
          ...existing,
          ...toAdd
        ];

        await set(store);
        return store.actions.filter((item) => item.session_id === sessionId);
      });
    },

    async getActionsBySession(sessionId, status = null) {
      const store = await get();
      return store.actions
        .filter((item) => item.session_id === sessionId && (!status || item.status === status))
        .sort((a, b) => {
          const urgencyDelta = Number(b.urgency_score || 0) - Number(a.urgency_score || 0);
          if (urgencyDelta !== 0) return urgencyDelta;
          const priorityRank = { high: 0, medium: 1, low: 2 };
          const aRank = priorityRank[a.priority] ?? 3;
          const bRank = priorityRank[b.priority] ?? 3;
          if (aRank !== bRank) return aRank - bRank;
          return new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0);
        });
    },

    async getDueReminderActions({ limit = 50 } = {}) {
      const store = await get();
      const now = Date.now();
      const max = Math.max(1, Math.min(Number(limit) || 50, 500));

      return store.actions
        .filter((item) => {
          const status = String(item.status || 'open').toLowerCase();
          if (status === 'done') return false;

          const reminderAtMs = item.next_reminder_at ? new Date(item.next_reminder_at).getTime() : NaN;
          const dueByReminder = Number.isFinite(reminderAtMs) && reminderAtMs <= now;
          const dueByOverdue = Boolean(item.is_overdue);
          return dueByReminder || dueByOverdue;
        })
        .sort((a, b) => {
          const urgencyDelta = Number(b.urgency_score || 0) - Number(a.urgency_score || 0);
          if (urgencyDelta !== 0) return urgencyDelta;

          const aReminder = new Date(a.next_reminder_at || 0).getTime();
          const bReminder = new Date(b.next_reminder_at || 0).getTime();
          if (Number.isFinite(aReminder) && Number.isFinite(bReminder) && aReminder !== bReminder) {
            return aReminder - bReminder;
          }

          return new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0);
        })
        .slice(0, max);
    },

    async markActionReminderDispatched(sessionId, actionId, nextReminderAt, dispatchMeta = {}) {
      return withLock(async () => {
        const store = await get();
        const action = store.actions.find((item) => item.session_id === sessionId && item.id === actionId);
        if (!action) return null;

        const now = new Date().toISOString();
        const channel = String(dispatchMeta.channel || 'log').trim().toLowerCase();
        const status = String(dispatchMeta.status || 'sent').trim().toLowerCase();
        const hasResponseCode = dispatchMeta.response_code !== null && dispatchMeta.response_code !== undefined;
        const parsedResponseCode = hasResponseCode ? Number(dispatchMeta.response_code) : NaN;
        const responseCode = Number.isFinite(parsedResponseCode)
          ? parsedResponseCode
          : null;
        const errorMessage = dispatchMeta.error ? String(dispatchMeta.error).slice(0, 400) : null;

        const historyEntry = {
          at: now,
          channel,
          status,
          response_code: responseCode,
          error: errorMessage
        };

        const history = Array.isArray(action.reminder_history) ? action.reminder_history : [];
        action.reminder_history = [...history, historyEntry].slice(-80);
        action.last_reminded_at = now;
        action.last_reminder_channel = channel;
        action.last_reminder_status = status;
        action.last_reminder_response_code = responseCode;
        action.last_reminder_error = errorMessage;
        action.next_reminder_at = nextReminderAt || action.next_reminder_at;
        action.updated_at = now;
        await set(store);
        return action;
      });
    },

    async updateAction(sessionId, actionId, patch = {}) {
      return withLock(async () => {
        const store = await get();
        const action = store.actions.find((item) => item.session_id === sessionId && item.id === actionId);
        if (!action) return null;

        const allowedStatuses = new Set(['open', 'in_progress', 'done', 'blocked']);
        const allowedPriorities = new Set(['high', 'medium', 'low']);

        if (typeof patch.status === 'string') {
          const nextStatus = patch.status.trim().toLowerCase();
          if (allowedStatuses.has(nextStatus)) action.status = nextStatus;
        }
        if (typeof patch.owner === 'string') {
          const owner = patch.owner.trim();
          action.owner = owner || null;
        }
        if (typeof patch.due_date === 'string') {
          const due = patch.due_date.trim();
          action.due_date = due || null;
        }
        if (typeof patch.priority === 'string') {
          const priority = patch.priority.trim().toLowerCase();
          if (allowedPriorities.has(priority)) action.priority = priority;
        }
        if (typeof patch.title === 'string') {
          const title = patch.title.trim();
          if (title) action.title = title;
        }

        const shouldRecalculate = ['status', 'due_date', 'priority'].some((key) => Object.prototype.hasOwnProperty.call(patch, key));
        if (shouldRecalculate) {
          recalculateActionMeta(action);
        }

        action.updated_at = new Date().toISOString();
        await set(store);
        return action;
      });
    },

    async createJob(sessionId, jobType, payload = {}) {
      return withLock(async () => {
        const store = await get();
        const now = new Date().toISOString();
        const job = {
          id: randomUUID(),
          session_id: sessionId,
          job_type: String(jobType || 'generic'),
          status: 'queued',
          progress: 0,
          phase: 'queued',
          created_at: now,
          updated_at: now,
          started_at: null,
          completed_at: null,
          error: null,
          payload,
          result: null,
          events: []
        };
        store.jobs.push(job);
        await set(store);
        return job;
      });
    },

    async updateJob(jobId, patch = {}) {
      return withLock(async () => {
        const store = await get();
        const job = store.jobs.find((item) => item.id === jobId);
        if (!job) return null;

        const now = new Date().toISOString();
        const trackedKeys = ['status', 'progress', 'phase', 'error', 'result', 'payload'];
        for (const key of trackedKeys) {
          if (Object.prototype.hasOwnProperty.call(patch, key)) {
            job[key] = patch[key];
          }
        }

        if (patch.status === 'running' && !job.started_at) {
          job.started_at = now;
        }
        if ((patch.status === 'done' || patch.status === 'failed') && !job.completed_at) {
          job.completed_at = now;
        }

        if (typeof patch.event === 'string' && patch.event.trim()) {
          job.events = Array.isArray(job.events) ? job.events : [];
          job.events.push({
            at: now,
            message: patch.event.trim().slice(0, 400)
          });
          job.events = job.events.slice(-80);
        }

        job.updated_at = now;
        await set(store);
        return job;
      });
    },

    async getJob(jobId) {
      const store = await get();
      return store.jobs.find((item) => item.id === jobId) || null;
    },

    async getJobsBySession(sessionId) {
      const store = await get();
      return store.jobs
        .filter((item) => item.session_id === sessionId)
        .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
    }
  };
}

