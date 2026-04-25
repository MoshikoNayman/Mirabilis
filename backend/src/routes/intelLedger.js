// backend/src/routes/intelLedger.js
// InteLedger API routes — ESM

import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveIntelLedgerIdentity } from '../intelLedgerIdentity.js';

const INTELLEDGER_SIGNAL_EXTRACTOR_VERSION = 'intelledger-signals-v2.4';
const DEFAULT_PROMPT_PROFILES = {
  signal_extraction: {
    id: 'signal-extraction-v1',
    label: 'Signal Extraction v1',
    system_prompt: 'You are a precise signal extractor. Return only valid JSON.',
    user_template: [
      'Extract structured signals from this note. Return ONLY valid JSON and no extra text.',
      '',
      'For each signal include:',
      '- type: one of commitment | risk | decision | ask | opportunity',
      '- value: the full sentence or clause (string)',
      '- owner: person responsible (string or null)',
      '- due_date: deadline if mentioned (string or null)',
      '- confidence: 0.0–1.0 (number)',
      '',
      'Return shape:',
      '{ "signals": [ { "type": "...", "value": "...", "owner": null, "due_date": null, "confidence": 0.85 } ] }',
      '',
      'Note:',
      '{{content}}'
    ].join('\n')
  },
  session_synthesis: {
    id: 'session-synthesis-v1',
    label: 'Session Synthesis v1',
    system_prompt: 'You are an analyst. Return only valid JSON. Be concise and practical.',
    user_template: [
      'Goal: {{query}}',
      '',
      'Interactions:',
      '{{interactions}}',
      '',
      'Extracted signals:',
      '{{signals}}',
      '',
      'Return valid JSON with this exact shape:',
      '{',
      '  "summary": "short paragraph",',
      '  "key_decisions": ["..."],',
      '  "risks": ["..."],',
      '  "commitments": ["..."],',
      '  "opportunities": ["..."],',
      '  "next_actions": ["..."],',
      '  "open_questions": ["..."]',
      '}'
    ].join('\n')
  },
  cross_session_synthesis: {
    id: 'cross-session-synthesis-v1',
    label: 'Cross Session Synthesis v1',
    system_prompt: 'You are a strategic analyst. Return only valid JSON.',
    user_template: [
      'Analyse these {{sessionCount}} sessions and return a cross-session synthesis.',
      'Focus: {{query}}',
      '',
      '{{sessionBlocks}}',
      '',
      'Return valid JSON with this exact shape:',
      '{',
      '  "summary": "overall paragraph covering what these sessions share",',
      '  "cross_session_patterns": ["pattern 1", "pattern 2"],',
      '  "aggregated_risks": ["risk 1", "risk 2"],',
      '  "combined_next_actions": ["action 1", "action 2"],',
      '  "key_decisions": ["decision 1"],',
      '  "open_questions": ["question 1"]',
      '}'
    ].join('\n')
  }
};

function renderPromptTemplate(template, variables = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => String(variables[key] ?? ''));
}

function isGenericSessionTitle(title) {
  const normalized = String(title || '').trim().toLowerCase();
  return !normalized || ['untitled', 'inteledger session', 'new session', 'session'].includes(normalized);
}

function fallbackTitleFromContent(content) {
  const cleaned = String(content || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Untitled';
  const first = cleaned.split(/[.!?]/)[0].trim();
  const candidate = first || cleaned;
  return candidate.length > 60 ? `${candidate.slice(0, 57)}...` : candidate;
}

function redactSensitiveContent(content) {
  const source = String(content || '');
  return source
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\b(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[REDACTED_PHONE]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_CARD]');
}

function applyPiiPolicy(content, piiMode) {
  if (String(piiMode || '').trim().toLowerCase() !== 'strict') {
    return String(content || '');
  }
  return redactSensitiveContent(content);
}

async function generateSessionTitle({ content, provider, model, config, streamWithProvider }) {
  const snippet = String(content || '').trim().slice(0, 500);
  if (!snippet) return null;

  let title = '';
  await streamWithProvider({
    provider,
    model,
    messages: [
      {
        role: 'system',
        content: 'Generate a concise 3-6 word title for this note. Return ONLY the title, no quotes, no punctuation at end.'
      },
      { role: 'user', content: snippet }
    ],
    config,
    onToken: (token) => { title += token; }
  });

  const cleaned = title.trim().replace(/^["'`]|["'`]$/g, '').replace(/\.$/, '').slice(0, 60).trim();
  return cleaned || null;
}

function extractOwner(sentence) {
  const ownerMatch = sentence.match(/\b(?:owner|owned by|assigned to|by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  return ownerMatch ? ownerMatch[1].trim() : null;
}

function extractDueDate(sentence) {
  const dueMatch = sentence.match(/\b(?:by|before|due|on)?\s*(today|tomorrow|next\s+week|next\s+month|eod|\d{4}-\d{2}-\d{2}|[A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)\b/i);
  return dueMatch ? dueMatch[1].trim() : null;
}

function extractSignalsWithFallback(rawText, aiSignals) {
  const parsed = Array.isArray(aiSignals) ? aiSignals.filter(Boolean) : [];
  if (parsed.length > 0) return parsed; 
  return extractStructuredSignals(rawText);
}

function extractStructuredSignals(text) {
  const source = String(text || '');
  const sentences = source
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 80);

  const signals = [];
  const keywordSets = {
    commitment: /\b(will|going to|plan to|commit|promise|ensure|guarantee|deliver|ship|follow up)\b/i,
    risk: /\b(risk|concern|issue|problem|challenge|blocker|obstacle|delay|outage|failure)\b/i,
    decision: /\b(decided|agreed|chose|selected|approved|rejected|confirmed)\b/i,
    ask: /\b(need|please|request|can you|could you|ask|require)\b/i,
    opportunity: /\b(opportunity|potential|could|might benefit|leverage|upside)\b/i
  };

  for (const sentence of sentences) {
    const owner = extractOwner(sentence);
    const dueDate = extractDueDate(sentence);

    for (const [type, regex] of Object.entries(keywordSets)) {
      if (!regex.test(sentence)) continue;

      signals.push({
        type,
        value: sentence,
        quote: sentence,
        owner,
        due_date: dueDate,
        ask: type === 'ask' ? sentence : null,
        commitment: type === 'commitment' ? sentence : null,
        risk: type === 'risk' ? sentence : null,
        decision: type === 'decision' ? sentence : null,
        confidence: type === 'decision' || type === 'commitment' ? 0.78 : 0.7
      });
    }
  }

  return signals.slice(0, 36);
}

function buildActionQueue(signals) {
  const ranked = (Array.isArray(signals) ? signals : [])
    .filter((signal) => ['ask', 'commitment', 'risk', 'decision'].includes(signal.signal_type || signal.type))
    .map((signal) => {
      const type = signal.signal_type || signal.type;
      const normalizedDueDate = parseDueDateValue(signal.due_date);
      const confidence = Number(signal.confidence || 0.7);
      const typeWeight = type === 'risk' ? 40 : (type === 'ask' ? 28 : (type === 'commitment' ? 24 : 18));
      const confidenceWeight = Math.round(Math.max(0, Math.min(1, confidence)) * 35);
      const dueWeight = normalizedDueDate ? 18 : 0;
      const daysUntilDue = normalizedDueDate ? daysUntilDate(normalizedDueDate) : null;
      const overdueWeight = daysUntilDue !== null && daysUntilDue < 0
        ? Math.min(28, 10 + (Math.abs(daysUntilDue) * 3))
        : 0;
      const dueSoonWeight = daysUntilDue !== null && daysUntilDue >= 0 && daysUntilDue <= 2
        ? 10
        : 0;
      const urgencyScore = Math.min(100, typeWeight + confidenceWeight + dueWeight + overdueWeight + dueSoonWeight);
      const priority = urgencyScore >= 72 ? 'high' : (urgencyScore >= 45 ? 'medium' : 'low');
      const isOverdue = daysUntilDue !== null && daysUntilDue < 0;
      const escalationLevel = isOverdue
        ? 'high'
        : (daysUntilDue !== null && daysUntilDue <= 1 ? 'medium' : 'low');
      const nextReminderAt = computeNextReminderAt({ priority, dueDate: normalizedDueDate, isOverdue });

      return {
        title: String(signal.value || '').slice(0, 120),
        owner: signal.owner || null,
        due_date: normalizedDueDate,
        priority,
        status: 'open',
        rationale: `${type} extracted from recent interaction`,
        source_signal_id: signal.id || null,
        source_signal_type: type,
        confidence,
        urgency_score: urgencyScore,
        escalation_level: escalationLevel,
        next_reminder_at: nextReminderAt,
        is_overdue: isOverdue
      };
    });

  const deduped = [];
  const seen = new Set();
  for (const action of ranked) {
    const key = `${action.source_signal_type}:${action.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(action);
  }

  return deduped
    .sort((a, b) => Number(b.urgency_score || 0) - Number(a.urgency_score || 0))
    .slice(0, 12);
}

function buildSynthesisPrompt({ query, interactions, signals, template = null }) {
  const interactionLines = interactions
    .slice(0, 25)
    .map((item, index) => `${index + 1}. [${item.type}] ${String(item.raw_content || '').slice(0, 240)}`)
    .join('\n');

  const signalLines = signals
    .slice(0, 80)
    .map((item, index) => `${index + 1}. [${item.signal_type}] ${item.value}`)
    .join('\n');

  const selectedTemplate = template || DEFAULT_PROMPT_PROFILES.session_synthesis.user_template;
  return renderPromptTemplate(selectedTemplate, {
    query: query || 'Summarize this session and suggest next actions.',
    interactions: interactionLines || 'None',
    signals: signalLines || 'None'
  });
}

function parseDueDateValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (lower === 'today' || lower === 'eod') {
    return todayStart.toISOString().slice(0, 10);
  }

  if (lower === 'tomorrow') {
    const dt = new Date(todayStart);
    dt.setDate(dt.getDate() + 1);
    return dt.toISOString().slice(0, 10);
  }

  if (lower === 'next week') {
    const dt = new Date(todayStart);
    dt.setDate(dt.getDate() + 7);
    return dt.toISOString().slice(0, 10);
  }

  if (lower === 'next month') {
    const dt = new Date(todayStart);
    dt.setMonth(dt.getMonth() + 1);
    return dt.toISOString().slice(0, 10);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

function daysUntilDate(dateIso) {
  if (!dateIso || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso))) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(`${dateIso}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  return Math.floor((due.getTime() - today.getTime()) / 86400000);
}

function computeNextReminderAt({ priority, dueDate, isOverdue }) {
  const now = new Date();
  const reminder = new Date(now);
  const daysUntilDue = dueDate ? daysUntilDate(dueDate) : null;

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

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

function formatTimestampMs(ms) {
  const safe = Math.max(0, Number(ms || 0));
  const totalSeconds = Math.floor(safe / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function normalizeTranscriptSegments(rawSegments = []) {
  return rawSegments
    .map((seg) => {
      const startCandidate = seg.start_ms ?? (Number(seg.start || 0) * 1000);
      const endCandidate = seg.end_ms ?? (Number(seg.end || 0) * 1000);
      return {
        start_ms: Math.max(0, Math.round(Number(startCandidate || 0))),
        end_ms: Math.max(0, Math.round(Number(endCandidate || 0))),
        text: String(seg.text || '').trim(),
        speaker: seg.speaker ? String(seg.speaker) : null
      };
    })
    .filter((seg) => seg.text)
    .sort((a, b) => a.start_ms - b.start_ms)
    .slice(0, 4000);
}

function applyHeuristicSpeakers(segments = []) {
  if (!segments.length) return segments;
  let speakerIndex = 1;
  let previousEnd = segments[0].start_ms || 0;
  return segments.map((segment, index) => {
    if (index > 0 && ((segment.start_ms - previousEnd) > 1800)) {
      speakerIndex = speakerIndex === 1 ? 2 : 1;
    }
    previousEnd = segment.end_ms || segment.start_ms;
    return {
      ...segment,
      speaker: segment.speaker || `Speaker ${speakerIndex}`
    };
  });
}

function transcriptFromSegments(segments = []) {
  return segments
    .map((segment) => (`[${formatTimestampMs(segment.start_ms)}-${formatTimestampMs(segment.end_ms)}] ${segment.speaker || 'Speaker'}: ${segment.text}`))
    .join('\n')
    .slice(0, 160000);
}

function attachSignalEvidence(rawSignals = [], segments = []) {
  if (!segments.length) return rawSignals;
  const loweredSegments = segments.map((seg) => ({ ...seg, lowered: seg.text.toLowerCase() }));
  return rawSignals.map((signal) => {
    const snippet = String(signal.value || '').toLowerCase().slice(0, 80).trim();
    if (!snippet) return signal;
    const hit = loweredSegments.find((seg) => seg.lowered.includes(snippet.slice(0, 24)));
    if (!hit) return signal;
    return {
      ...signal,
      speaker: hit.speaker || null,
      start_ms: hit.start_ms,
      end_ms: hit.end_ms,
      quote: signal.quote || hit.text
    };
  });
}

function normalizeSignalType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (['commitment', 'commitments', 'promise', 'promises'].includes(normalized)) return 'commitment';
  if (['risk', 'risks', 'issue', 'issues', 'blocker', 'blockers'].includes(normalized)) return 'risk';
  if (['decision', 'decisions', 'decide', 'decided'].includes(normalized)) return 'decision';
  if (['ask', 'asks', 'request', 'requests'].includes(normalized)) return 'ask';
  if (['opportunity', 'opportunities', 'upside'].includes(normalized)) return 'opportunity';
  return normalized;
}

function tokenizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function overlapScore(aTokens = [], bTokens = []) {
  if (!aTokens.length || !bTokens.length) return 0;
  const bSet = new Set(bTokens);
  let overlap = 0;
  for (const token of aTokens) {
    if (bSet.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.length, bTokens.length);
}

function splitSourceSentences(sourceText) {
  return String(sourceText || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 220);
}

function attachTextSignalEvidence(rawSignals = [], sourceText = '') {
  const sentences = splitSourceSentences(sourceText);
  if (!sentences.length) return rawSignals;
  const sentenceTokens = sentences.map((sentence) => tokenizeForMatch(sentence));

  return rawSignals.map((signal) => {
    const candidate = String(signal.quote || signal.value || '').trim();
    if (!candidate) return signal;

    const loweredCandidate = candidate.toLowerCase();
    const directSentence = sentences.find((sentence) => sentence.toLowerCase().includes(loweredCandidate.slice(0, 24)));
    if (directSentence) {
      return {
        ...signal,
        quote: signal.quote || directSentence
      };
    }

    const candidateTokens = tokenizeForMatch(candidate);
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < sentenceTokens.length; i += 1) {
      const score = overlapScore(candidateTokens, sentenceTokens[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestScore >= 0.28) {
      return {
        ...signal,
        quote: signal.quote || sentences[bestIndex]
      };
    }

    return signal;
  });
}

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.6;
  return Math.max(0.2, Math.min(0.99, num));
}

function normalizeSignalValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function calibrateAndDeduplicateSignals(rawSignals = [], { sourceText = '', segments = [] } = {}) {
  const withEvidence = segments.length
    ? attachSignalEvidence(rawSignals, segments)
    : attachTextSignalEvidence(rawSignals, sourceText);

  const sourceLower = String(sourceText || '').toLowerCase();
  const deduped = new Map();

  for (const signal of withEvidence) {
    const signalType = normalizeSignalType(signal.signal_type || signal.type);
    const value = String(signal.value || signal.quote || '').trim().slice(0, 320);
    if (!signalType || !value || value.length < 8) continue;

    let confidence = clampConfidence(signal.confidence);
    const quote = String(signal.quote || '').trim();
    const hasOwner = Boolean(String(signal.owner || '').trim());
    const hasDueDate = Boolean(String(signal.due_date || '').trim());

    const hasEvidence = quote
      ? sourceLower.includes(quote.toLowerCase().slice(0, 36))
      : sourceLower.includes(value.toLowerCase().slice(0, 36));

    if (hasEvidence) confidence += 0.07;
    else confidence -= 0.08;
    if (hasOwner) confidence += 0.03;
    if (hasDueDate) confidence += 0.03;
    if (signalType === 'decision' || signalType === 'commitment') confidence += 0.02;
    confidence = clampConfidence(confidence);

    const normalizedValue = normalizeSignalValue(value);
    const dedupeKey = `${signalType}:${normalizedValue}`;

    const candidate = {
      ...signal,
      type: signalType,
      signal_type: signalType,
      value,
      quote: quote || value,
      confidence,
      owner: hasOwner ? String(signal.owner).trim() : null,
      due_date: hasDueDate ? String(signal.due_date).trim() : null,
      ask: signalType === 'ask' ? value : null,
      commitment: signalType === 'commitment' ? value : null,
      risk: signalType === 'risk' ? value : null,
      decision: signalType === 'decision' ? value : null
    };

    const previous = deduped.get(dedupeKey);
    if (!previous || candidate.confidence > previous.confidence) {
      deduped.set(dedupeKey, previous
        ? {
            ...previous,
            ...candidate,
            owner: candidate.owner || previous.owner,
            due_date: candidate.due_date || previous.due_date,
            quote: candidate.quote || previous.quote
          }
        : candidate);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, 36);
}

async function probeMediaDurationSeconds(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);
  const value = Number(String(stdout || '').trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

async function extractAudioTrack(inputPath, outputPath) {
  await runCommand('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    outputPath
  ]);
}

async function transcribeWithOpenAI({ audioPath, apiKey, baseUrl, model }) {
  const fileBuffer = await fs.readFile(audioPath);
  const form = new FormData();
  form.append('model', model || 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('file', new Blob([fileBuffer], { type: 'audio/wav' }), path.basename(audioPath));

  const response = await fetch(`${String(baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI transcription failed (${response.status}): ${text.slice(0, 300)}`);
  }

  let payload = {};
  try { payload = JSON.parse(text); } catch {
    payload = { text };
  }

  return {
    text: String(payload.text || '').trim(),
    segments: normalizeTranscriptSegments(payload.segments || [])
  };
}

async function transcribeWithWhisperCli({ audioPath, outputPrefix, model = 'base' }) {
  const outputDir = path.dirname(outputPrefix);
  await runCommand('whisper', [
    audioPath,
    '--model', model,
    '--output_format', 'json',
    '--output_dir', outputDir,
    '--word_timestamps', 'False'
  ]);

  const jsonPath = `${outputPrefix}.json`;
  const raw = await fs.readFile(jsonPath, 'utf8');
  const parsed = JSON.parse(raw || '{}');
  return {
    text: String(parsed.text || '').trim(),
    segments: normalizeTranscriptSegments(parsed.segments || [])
  };
}

export function createIntelLedgerRoutes(storage, aiDeps) {
  const { streamWithProvider, getEffectiveModel, config } = aiDeps;
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage() });
  const mediaMaxBytes = Math.max(5 * 1024 * 1024, Number(process.env.INTELLEDGER_MEDIA_MAX_BYTES || (150 * 1024 * 1024)));
  const mediaMaxDurationSec = Math.max(60, Number(process.env.INTELLEDGER_MEDIA_MAX_DURATION_SEC || (90 * 60)));
  const mediaMaxConcurrent = Math.max(1, Number(process.env.INTELLEDGER_MEDIA_MAX_CONCURRENT || 1));
  const mediaQueueCapacity = Math.max(1, Number(process.env.INTELLEDGER_MEDIA_MAX_QUEUE || 12));
  const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: mediaMaxBytes, files: 1 }
  });
  const mediaRootDir = path.join(path.dirname(config.intelLedgerStorePath), 'intelledger-media');
  const queuedMediaJobs = [];
  const runningMediaJobs = new Set();
  const requireAuthContext = String(process.env.INTELLEDGER_REQUIRE_AUTH_CONTEXT || '0') === '1';

  const resolveIdentity = (req) => resolveIntelLedgerIdentity(req, { requireAuthContext });

  const rejectInvalidIdentity = (res, identity) => {
    if (identity.authRequiredButMissing) {
      res.status(401).json({ error: 'Authenticated identity required.' });
      return true;
    }
    if (identity.mismatch.user || identity.mismatch.tenant) {
      res.status(403).json({ error: 'Request identity does not match authenticated context.' });
      return true;
    }
    return false;
  };

  const resolvePromptProfile = async (profileId) => {
    const fallback = DEFAULT_PROMPT_PROFILES[profileId];
    if (typeof storage.resolvePromptVersion === 'function') {
      return storage.resolvePromptVersion(profileId, fallback ? {
        id: fallback.id,
        label: fallback.label,
        system_prompt: fallback.system_prompt,
        user_template: fallback.user_template
      } : null);
    }

    if (!fallback) return null;
    return {
      profile_id: profileId,
      id: fallback.id,
      label: fallback.label,
      system_prompt: fallback.system_prompt,
      user_template: fallback.user_template,
      is_fallback: true
    };
  };

  const getSessionTenantId = (session) => String(session?.tenant_id || session?.user_id || 'default').trim();

  router.use('/sessions/:sessionId', async (req, res, next) => {
    try {
      const identity = resolveIdentity(req);
      if (rejectInvalidIdentity(res, identity)) return;
      if (!identity.tenantId && !identity.trustedUserId) return next();

      const session = await storage.getSession(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Not found' });
      }

      if (identity.tenantId && getSessionTenantId(session) !== identity.tenantId) {
        return res.status(404).json({ error: 'Not found' });
      }
      if (identity.trustedUserId && String(session.user_id || '').trim() !== identity.trustedUserId) {
        return res.status(404).json({ error: 'Not found' });
      }

      req.intelLedgerSession = session;
      return next();
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/prompts/profiles', async (req, res) => {
    try {
      const registryRows = typeof storage.listPromptProfiles === 'function'
        ? await storage.listPromptProfiles()
        : [];

      const knownProfileIds = new Set([
        ...Object.keys(DEFAULT_PROMPT_PROFILES),
        ...registryRows.map((item) => item.profile_id)
      ]);

      const profiles = await Promise.all(
        Array.from(knownProfileIds).sort().map(async (profileId) => {
          const resolved = await resolvePromptProfile(profileId);
          const registry = registryRows.find((item) => item.profile_id === profileId) || null;
          return {
            profile_id: profileId,
            active_version_id: resolved?.id || registry?.active_version_id || null,
            active_label: resolved?.label || null,
            is_fallback: Boolean(resolved?.is_fallback),
            version_count: Number(registry?.version_count || 0),
            updated_at: registry?.updated_at || null
          };
        })
      );

      res.json({ profiles });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/prompts/profiles/:profileId', async (req, res) => {
    try {
      const profileId = String(req.params.profileId || '').trim().toLowerCase();
      const profile = typeof storage.getPromptProfile === 'function'
        ? await storage.getPromptProfile(profileId)
        : null;
      const resolved = await resolvePromptProfile(profileId);
      if (!resolved && !profile) {
        return res.status(404).json({ error: 'Prompt profile not found.' });
      }

      return res.json({
        profile: {
          profile_id: profileId,
          active_version_id: resolved?.id || profile?.active_version_id || null,
          active: resolved || null,
          versions: profile?.versions || []
        }
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/prompts/profiles/:profileId/versions', async (req, res) => {
    try {
      if (typeof storage.createPromptVersion !== 'function') {
        return res.status(501).json({ error: 'Prompt registry is not supported by this storage backend.' });
      }

      const profileId = String(req.params.profileId || '').trim().toLowerCase();
      const created = await storage.createPromptVersion(profileId, req.body || {});
      return res.status(201).json({ profile: created });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  router.post('/prompts/profiles/:profileId/select', async (req, res) => {
    try {
      if (typeof storage.selectPromptVersion !== 'function') {
        return res.status(501).json({ error: 'Prompt registry is not supported by this storage backend.' });
      }

      const profileId = String(req.params.profileId || '').trim().toLowerCase();
      const versionId = req.body?.version_id || req.body?.versionId;
      const selected = await storage.selectPromptVersion(profileId, versionId);
      if (!selected) {
        return res.status(404).json({ error: 'Prompt version not found.' });
      }
      return res.json({ profile: selected });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  const processNextMediaJob = async () => {
    if (runningMediaJobs.size >= mediaMaxConcurrent) return;
    const next = queuedMediaJobs.shift();
    if (!next) return;
    runningMediaJobs.add(next.id);
    try {
      await runMediaJob(next);
    } finally {
      runningMediaJobs.delete(next.id);
      if (queuedMediaJobs.length > 0) {
        processNextMediaJob().catch(() => {});
      }
    }
  };

  const enqueueMediaJob = (jobPayload) => {
    if ((queuedMediaJobs.length + runningMediaJobs.size) >= mediaQueueCapacity) {
      throw new Error('Media queue is full. Please retry in a few minutes.');
    }
    queuedMediaJobs.push(jobPayload);
    processNextMediaJob().catch(() => {});
  };

  const updateJob = async (jobId, patch = {}) => {
    if (typeof storage.updateJob === 'function') {
      await storage.updateJob(jobId, patch);
    }
  };

  const runMediaJob = async (jobPayload) => {
    const { jobId, sessionId, interactionId, sourcePath, originalName, fileSizeBytes } = jobPayload;
    const audioPath = `${sourcePath}.wav`;
    const session = await storage.getSession(sessionId);
    const piiMode = String(session?.pii_mode || 'standard').toLowerCase();

    try {
      await updateJob(jobId, { status: 'running', phase: 'preflight', progress: 8, event: 'Media job started.' });
      await storage.updateInteraction(sessionId, interactionId, { transcript_status: 'running' });

      let durationSec = null;
      try {
        durationSec = await probeMediaDurationSeconds(sourcePath);
      } catch {
        durationSec = null;
      }

      if (durationSec && durationSec > mediaMaxDurationSec) {
        throw new Error(`Media duration exceeds limit (${Math.round(durationSec)}s > ${mediaMaxDurationSec}s).`);
      }

      const estimatedCostUsd = durationSec
        ? Number(((durationSec / 60) * 0.006).toFixed(4))
        : Number((((fileSizeBytes || 0) / (1024 * 1024)) * 0.00025).toFixed(4));

      await storage.updateInteraction(sessionId, interactionId, {
        media: {
          path: sourcePath,
          source_name: originalName,
          size_bytes: fileSizeBytes,
          duration_sec: durationSec,
          estimated_cost_usd: estimatedCostUsd
        },
        transcript_status: 'running'
      });

      await updateJob(jobId, {
        phase: 'extract_audio',
        progress: 28,
        event: 'Extracting audio track.'
      });
      await extractAudioTrack(sourcePath, audioPath);

      await updateJob(jobId, {
        phase: 'transcribe',
        progress: 52,
        event: 'Transcribing audio.'
      });

      let transcription = null;
      const providerPref = String(process.env.INTELLEDGER_TRANSCRIBE_PROVIDER || 'auto').toLowerCase();
      const transcribeModel = process.env.INTELLEDGER_TRANSCRIBE_MODEL || 'whisper-1';
      const whisperCliModel = process.env.INTELLEDGER_WHISPER_CLI_MODEL || 'base';

      const canUseOpenAI = Boolean(config.openAIApiKey);
      if (providerPref === 'openai' || (providerPref === 'auto' && canUseOpenAI)) {
        transcription = await transcribeWithOpenAI({
          audioPath,
          apiKey: config.openAIApiKey,
          baseUrl: config.openAIBaseUrl,
          model: transcribeModel
        });
      } else {
        transcription = await transcribeWithWhisperCli({
          audioPath,
          outputPrefix: sourcePath,
          model: whisperCliModel
        });
      }

      let segments = normalizeTranscriptSegments(transcription.segments || []);
      segments = applyHeuristicSpeakers(segments);
      const transcriptTextRaw = (String(transcription.text || '').trim() || transcriptFromSegments(segments)).slice(0, 160000);
      const transcriptText = applyPiiPolicy(transcriptTextRaw, piiMode);

      await updateJob(jobId, {
        phase: 'extract_signals',
        progress: 74,
        event: 'Extracting signals from transcript.'
      });

      await storage.updateInteraction(sessionId, interactionId, {
        type: 'media',
        raw_content: transcriptText,
        transcript_status: 'complete',
        transcript_segments: segments,
        transcript_summary: transcriptText.slice(0, 600),
        media: {
          path: sourcePath,
          source_name: originalName,
          size_bytes: fileSizeBytes,
          duration_sec: durationSec,
          estimated_cost_usd: estimatedCostUsd
        },
        extracted: true
      });

      const provider = config.aiProvider || 'ollama';
      const model = await getEffectiveModel({ provider, model: null, config });
      const extractionPrompt = await resolvePromptProfile('signal_extraction');
      let rawSignals;
      try {
        rawSignals = extractSignalsWithFallback(
          transcriptText,
          await extractSignalsWithAI(transcriptText, provider, model, extractionPrompt)
        );
      } catch {
        rawSignals = extractStructuredSignals(transcriptText);
      }

      const qualitySignals = calibrateAndDeduplicateSignals(rawSignals, {
        sourceText: transcriptText,
        segments
      });
      const storedSignals = await storage.storeSignals(sessionId, interactionId, qualitySignals, {
        extractorVersion: INTELLEDGER_SIGNAL_EXTRACTOR_VERSION,
        promptProfile: extractionPrompt?.profile_id || 'signal_extraction',
        promptVersion: extractionPrompt?.id || DEFAULT_PROMPT_PROFILES.signal_extraction.id
      });
      const entityGraph = await storage.upsertEntitiesForInteraction(sessionId, interactionId, storedSignals);
      const allSignals = await storage.getSignalsBySession(sessionId);
      const actions = await storage.replaceActionsForSession(sessionId, buildActionQueue(allSignals), 'media_extract');

      await updateJob(jobId, {
        status: 'done',
        phase: 'completed',
        progress: 100,
        result: {
          interaction_id: interactionId,
          transcript_chars: transcriptText.length,
          segment_count: segments.length,
          signal_count: storedSignals.length,
          entity_count: Array.isArray(entityGraph?.entities) ? entityGraph.entities.length : 0,
          action_count: actions.length,
          estimated_cost_usd: estimatedCostUsd
        },
        event: 'Media transcription and extraction completed.'
      });
    } catch (err) {
      await storage.updateInteraction(sessionId, interactionId, { transcript_status: 'failed' });
      await updateJob(jobId, {
        status: 'failed',
        phase: 'failed',
        progress: 100,
        error: err.message || 'Media processing failed.',
        event: err.message || 'Media job failed.'
      });
    } finally {
      try { await fs.unlink(audioPath); } catch {}
    }
  };

  async function extractSignalsWithAI(content, provider, model, promptRuntime = null) {
    const snippet = String(content || '').trim().slice(0, 3000);
    const resolvedPrompt = promptRuntime || await resolvePromptProfile('signal_extraction');
    const systemPrompt = resolvedPrompt?.system_prompt || DEFAULT_PROMPT_PROFILES.signal_extraction.system_prompt;
    const promptTemplate = resolvedPrompt?.user_template || DEFAULT_PROMPT_PROFILES.signal_extraction.user_template;
    const prompt = renderPromptTemplate(promptTemplate, { content: snippet });

    let aiText = '';
    await streamWithProvider({
      provider,
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      config,
      onToken: (token) => { aiText += token; }
    });

    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] || aiText);
    const signals = Array.isArray(parsed?.signals) ? parsed.signals : [];

    // Normalize to the same shape extractStructuredSignals produces
    return signals.map((s) => ({
      type: s.type,
      value: String(s.value || '').slice(0, 300),
      quote: String(s.value || '').slice(0, 300),
      owner: s.owner || null,
      due_date: s.due_date || null,
      ask: s.type === 'ask' ? s.value : null,
      commitment: s.type === 'commitment' ? s.value : null,
      risk: s.type === 'risk' ? s.value : null,
      decision: s.type === 'decision' ? s.value : null,
      confidence: Number(s.confidence) || 0.8
    })).slice(0, 36);
  }

  // Sessions
  router.post('/sessions', async (req, res) => {
    try {
      const { title, description } = req.body;
      const identity = resolveIdentity(req);
      if (rejectInvalidIdentity(res, identity)) return;

      const session = await storage.createSession(identity.userId, title, description, { tenantId: identity.tenantId });
      res.json({ session });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/sessions', async (req, res) => {
    try {
      const identity = resolveIdentity(req);
      if (rejectInvalidIdentity(res, identity)) return;
      const sessions = await storage.listSessions(identity.userId, { tenantId: identity.tenantId });
      res.json({ sessions });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/sessions/brief', async (req, res) => {
    try {
      const identity = resolveIdentity(req);
      if (rejectInvalidIdentity(res, identity)) return;

      const { sessionIds } = req.query;
      const allSessions = await storage.listSessions(identity.userId, { tenantId: identity.tenantId });
      const requestedIds = String(sessionIds || '').split(',').map((v) => v.trim()).filter(Boolean);
      const targetSessions = requestedIds.length > 0
        ? allSessions.filter((item) => requestedIds.includes(item.id))
        : allSessions;

      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const dayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));

      const rollup = {
        generated_at: now.toISOString(),
        session_count: targetSessions.length,
        open_actions: 0,
        overdue_actions: 0,
        due_today_actions: 0,
        blocked_actions: 0,
        new_interactions_24h: 0,
        new_signals_24h: 0,
        overdue_session_ids: [],
        attention_session_ids: [],
        top_overdue_sessions: []
      };

      const overdueBySession = [];
      const attentionBySession = [];

      for (const session of targetSessions) {
        const [interactions, signals, actions] = await Promise.all([
          storage.getInteractions(session.id),
          storage.getSignalsBySession(session.id),
          typeof storage.getActionsBySession === 'function' ? storage.getActionsBySession(session.id) : []
        ]);

        const openActions = (actions || []).filter((item) => item.status !== 'done');
        const overdue = openActions.filter((item) => {
          const due = parseDueDateValue(item.due_date);
          return due && due < today;
        });
        const dueToday = openActions.filter((item) => parseDueDateValue(item.due_date) === today);
        const blocked = openActions.filter((item) => item.status === 'blocked');

        const interactions24h = (interactions || []).filter((item) => {
          const ts = new Date(item.ingested_at || item.created_at || 0);
          return !Number.isNaN(ts.getTime()) && ts >= dayAgo;
        }).length;

        const signals24h = (signals || []).filter((item) => {
          const ts = new Date(item.extracted_at || item.created_at || 0);
          return !Number.isNaN(ts.getTime()) && ts >= dayAgo;
        }).length;

        rollup.open_actions += openActions.length;
        rollup.overdue_actions += overdue.length;
        rollup.due_today_actions += dueToday.length;
        rollup.blocked_actions += blocked.length;
        rollup.new_interactions_24h += interactions24h;
        rollup.new_signals_24h += signals24h;

        if (overdue.length > 0) {
          overdueBySession.push({ id: session.id, title: session.title, count: overdue.length });
        }

        const attentionScore = (overdue.length * 3) + (blocked.length * 2) + dueToday.length;
        if (attentionScore > 0) {
          attentionBySession.push({ id: session.id, title: session.title, score: attentionScore });
        }
      }

      overdueBySession.sort((a, b) => b.count - a.count);
      attentionBySession.sort((a, b) => b.score - a.score);

      rollup.overdue_session_ids = overdueBySession.map((item) => item.id);
      rollup.attention_session_ids = attentionBySession.map((item) => item.id);
      rollup.top_overdue_sessions = overdueBySession.slice(0, 5);

      res.json({ brief: rollup });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/sessions/search', async (req, res) => {
    try {
      const { query, limit } = req.query;
      const identity = resolveIdentity(req);
      if (rejectInvalidIdentity(res, identity)) return;

      const cleanedQuery = String(query || '').trim();
      if (!cleanedQuery) {
        const sessions = await storage.listSessions(identity.userId, { tenantId: identity.tenantId });
        return res.json({ sessions, query: '', mode: 'default' });
      }

      const sessions = typeof storage.searchSessions === 'function'
        ? await storage.searchSessions(identity.userId, cleanedQuery, limit, { tenantId: identity.tenantId })
        : (await storage.listSessions(identity.userId, { tenantId: identity.tenantId })).filter((session) => {
            const haystack = [session.title, session.description, session.topic_preview].join(' ').toLowerCase();
            return haystack.includes(cleanedQuery.toLowerCase());
          });

      res.json({ sessions, query: cleanedQuery, mode: 'semantic' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cross-session synthesis (multi-select)
  router.post('/sessions/cross-synthesize', async (req, res) => {
    try {
      const { sessionIds, query, provider: requestedProvider, model: requestedModel } = req.body;
      const identity = resolveIdentity(req);
      if (rejectInvalidIdentity(res, identity)) return;

      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return res.status(400).json({ error: 'sessionIds array required' });
      }

      // Gather interactions + signals for every selected session
      const sessionData = await Promise.all(
        sessionIds.map(async (id) => {
          const [session, interactions, signals, actions] = await Promise.all([
            storage.getSession(id),
            storage.getInteractions(id),
            storage.getSignalsBySession(id),
            typeof storage.getActionsBySession === 'function' ? storage.getActionsBySession(id) : []
          ]);
          if (identity.tenantId && session && getSessionTenantId(session) !== identity.tenantId) {
            throw new Error('One or more sessions are not accessible for this tenant.');
          }
          if (identity.trustedUserId && session && String(session.user_id || '').trim() !== identity.trustedUserId) {
            throw new Error('One or more sessions are not accessible for this tenant.');
          }
          return { session, interactions: interactions || [], signals: signals || [], actions: actions || [] };
        })
      );

      const sessionBlocks = sessionData.map(({ session, interactions, signals, actions }, idx) => {
        const iLines = interactions.slice(0, 15).map((item) => `  - [${item.type}] ${String(item.raw_content || '').slice(0, 200)}`).join('\n');
        const sLines = signals.slice(0, 30).map((item) => `  - [${item.signal_type}] ${item.value}`).join('\n');
        const aLines = actions.filter((a) => a.status !== 'done').slice(0, 15).map((a) => `  - [${a.priority || 'medium'}] ${a.title}`).join('\n');
        return [
          `=== Session ${idx + 1}: ${session?.title || id} ===`,
          'Interactions:',
          iLines || '  (none)',
          'Signals:',
          sLines || '  (none)',
          'Open Actions:',
          aLines || '  (none)'
        ].join('\n');
      });

      const crossSessionPrompt = await resolvePromptProfile('cross_session_synthesis');
      const prompt = renderPromptTemplate(
        crossSessionPrompt?.user_template || DEFAULT_PROMPT_PROFILES.cross_session_synthesis.user_template,
        {
          sessionCount: sessionIds.length,
          query: query || 'Find recurring patterns, shared risks, and a unified action plan.',
          sessionBlocks: sessionBlocks.join('\n\n')
        }
      );

      const provider = requestedProvider || config.aiProvider || 'ollama';
      const model = await getEffectiveModel({ provider, model: requestedModel, config });

      let aiText = '';
      await streamWithProvider({
        provider,
        model,
        messages: [
          {
            role: 'system',
            content: crossSessionPrompt?.system_prompt || DEFAULT_PROMPT_PROFILES.cross_session_synthesis.system_prompt
          },
          { role: 'user', content: prompt }
        ],
        config,
        onToken: (token) => { aiText += token; }
      });

      let parsed = {};
      try { parsed = JSON.parse(aiText.match(/\{[\s\S]*\}/)?.[0] || aiText); } catch { parsed = { summary: aiText }; }

      res.json({
        synthesis: parsed,
        session_count: sessionIds.length,
        prompt_profile: crossSessionPrompt?.profile_id || 'cross_session_synthesis',
        prompt_version: crossSessionPrompt?.id || DEFAULT_PROMPT_PROFILES.cross_session_synthesis.id
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/sessions/:sessionId', async (req, res) => {
    try {
      const session = await storage.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'Not found' });
      res.json({ session });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/sessions/:sessionId/brief', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const [interactions, signals, actions] = await Promise.all([
        storage.getInteractions(sessionId),
        storage.getSignalsBySession(sessionId),
        typeof storage.getActionsBySession === 'function' ? storage.getActionsBySession(sessionId) : []
      ]);

      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const dayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));

      const openActions = (actions || []).filter((item) => item.status !== 'done');
      const overdue = openActions.filter((item) => {
        const due = parseDueDateValue(item.due_date);
        return due && due < today;
      });
      const dueToday = openActions.filter((item) => parseDueDateValue(item.due_date) === today);

      const newInteractions24h = (interactions || []).filter((item) => {
        const ts = new Date(item.ingested_at || item.created_at || 0);
        return !Number.isNaN(ts.getTime()) && ts >= dayAgo;
      }).length;

      const newSignals24h = (signals || []).filter((item) => {
        const ts = new Date(item.extracted_at || item.created_at || 0);
        return !Number.isNaN(ts.getTime()) && ts >= dayAgo;
      }).length;

      const blocked = openActions.filter((item) => item.status === 'blocked').length;

      res.json({
        brief: {
          generated_at: now.toISOString(),
          open_actions: openActions.length,
          overdue_actions: overdue.length,
          due_today_actions: dueToday.length,
          blocked_actions: blocked,
          new_interactions_24h: newInteractions24h,
          new_signals_24h: newSignals24h,
          overdue_titles: overdue.slice(0, 3).map((item) => item.title)
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/sessions/:sessionId', async (req, res) => {
    try {
      await storage.deleteSession(req.params.sessionId);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.patch('/sessions/:sessionId/retention', async (req, res) => {
    try {
      if (typeof storage.updateSessionRetentionPolicy !== 'function') {
        return res.status(501).json({ error: 'Retention policy updates are not supported by this storage backend.' });
      }
      const { retention_days, pii_mode } = req.body || {};
      const session = await storage.updateSessionRetentionPolicy(req.params.sessionId, {
        retention_days,
        pii_mode
      });
      if (!session) return res.status(404).json({ error: 'Not found' });
      return res.json({ session });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/sessions/:sessionId/retention/run', async (req, res) => {
    try {
      if (typeof storage.runRetentionSweep !== 'function') {
        return res.status(501).json({ error: 'Retention sweep is not supported by this storage backend.' });
      }
      const { retention_days } = req.body || {};
      const result = await storage.runRetentionSweep(req.params.sessionId, { retention_days });
      if (!result) return res.status(404).json({ error: 'Not found' });
      return res.json({ retention: result });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Ingest text
  router.post('/sessions/:sessionId/ingest/text', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const rawContent = req.body?.content ?? req.body?.raw_content ?? '';
      const content = String(rawContent || '').trim();
      const sourceName = req.body?.sourceName ?? req.body?.source_name ?? 'manual';
      if (!content) {
        return res.status(400).json({ error: 'content is required' });
      }
      const existingSession = await storage.getSession(sessionId);
      const piiMode = String(existingSession?.pii_mode || 'standard').toLowerCase();
      const normalizedContent = applyPiiPolicy(content, piiMode).trim();
      const interaction = await storage.ingestInteraction(sessionId, 'text', normalizedContent, sourceName || 'manual');
      const provider = config.aiProvider || 'ollama';
      const model = await getEffectiveModel({ provider, model: null, config });
      const extractionPrompt = await resolvePromptProfile('signal_extraction');
      let rawSignals;
      try {
        rawSignals = extractSignalsWithFallback(
          normalizedContent,
          await extractSignalsWithAI(normalizedContent, provider, model, extractionPrompt)
        );
      } catch {
        rawSignals = extractStructuredSignals(normalizedContent);
      }
      const qualitySignals = calibrateAndDeduplicateSignals(rawSignals, { sourceText: normalizedContent });
      const signals = await storage.storeSignals(sessionId, interaction.id, qualitySignals, {
        extractorVersion: INTELLEDGER_SIGNAL_EXTRACTOR_VERSION,
        promptProfile: extractionPrompt?.profile_id || 'signal_extraction',
        promptVersion: extractionPrompt?.id || DEFAULT_PROMPT_PROFILES.signal_extraction.id
      });
      const entityGraph = await storage.upsertEntitiesForInteraction(sessionId, interaction.id, signals);
      const allSignals = await storage.getSignalsBySession(sessionId);
      const actions = await storage.replaceActionsForSession(sessionId, buildActionQueue(allSignals), 'auto_extract');

      let session = await storage.getSession(sessionId);
      if (
        session &&
        existingSession &&
        isGenericSessionTitle(existingSession.title) &&
        (await storage.getInteractions(sessionId)).length === 1
      ) {
        const provider = config.aiProvider || 'ollama';
        const model = await getEffectiveModel({ provider, model: null, config });
        let title = null;
        try {
          title = await generateSessionTitle({ content: normalizedContent, provider, model, config, streamWithProvider });
        } catch {
          title = null;
        }
        session = await storage.updateSessionTitle(sessionId, title || fallbackTitleFromContent(normalizedContent));
      }

      res.json({
        interaction,
        signals,
        actions,
        entities: entityGraph?.entities || [],
        entity_links: entityGraph?.links || [],
        session
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Ingest file
  router.post('/sessions/:sessionId/ingest/file', upload.single('file'), async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!req.file) return res.status(400).json({ error: 'No file' });
      const content = req.file.buffer.toString('utf-8');
      const existingSession = await storage.getSession(sessionId);
      const piiMode = String(existingSession?.pii_mode || 'standard').toLowerCase();
      const normalizedContent = applyPiiPolicy(content, piiMode);
      const interaction = await storage.ingestInteraction(sessionId, 'file', normalizedContent, req.file.originalname);
      const provider = config.aiProvider || 'ollama';
      const model = await getEffectiveModel({ provider, model: null, config });
      const extractionPrompt = await resolvePromptProfile('signal_extraction');
      let rawSignals;
      try {
        rawSignals = extractSignalsWithFallback(
          normalizedContent,
          await extractSignalsWithAI(normalizedContent, provider, model, extractionPrompt)
        );
      } catch {
        rawSignals = extractStructuredSignals(normalizedContent);
      }
      const qualitySignals = calibrateAndDeduplicateSignals(rawSignals, { sourceText: normalizedContent });
      const signals = await storage.storeSignals(sessionId, interaction.id, qualitySignals, {
        extractorVersion: INTELLEDGER_SIGNAL_EXTRACTOR_VERSION,
        promptProfile: extractionPrompt?.profile_id || 'signal_extraction',
        promptVersion: extractionPrompt?.id || DEFAULT_PROMPT_PROFILES.signal_extraction.id
      });
      const entityGraph = await storage.upsertEntitiesForInteraction(sessionId, interaction.id, signals);
      const allSignals = await storage.getSignalsBySession(sessionId);
      const actions = await storage.replaceActionsForSession(sessionId, buildActionQueue(allSignals), 'auto_extract');

      let session = await storage.getSession(sessionId);
      if (
        session &&
        existingSession &&
        isGenericSessionTitle(existingSession.title) &&
        (await storage.getInteractions(sessionId)).length === 1
      ) {
        const provider = config.aiProvider || 'ollama';
        const model = await getEffectiveModel({ provider, model: null, config });
        let title = null;
        try {
          title = await generateSessionTitle({ content: normalizedContent, provider, model, config, streamWithProvider });
        } catch {
          title = null;
        }
        session = await storage.updateSessionTitle(sessionId, title || fallbackTitleFromContent(normalizedContent));
      }

      res.json({
        interaction,
        signals,
        actions,
        entities: entityGraph?.entities || [],
        entity_links: entityGraph?.links || [],
        session
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Ingest media (video/audio) asynchronously
  router.post('/sessions/:sessionId/ingest/media', mediaUpload.single('file'), async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!req.file) return res.status(400).json({ error: 'No media file uploaded.' });

      const mime = String(req.file.mimetype || '').toLowerCase();
      if (!mime.startsWith('audio/') && !mime.startsWith('video/')) {
        return res.status(400).json({ error: 'Only audio/video uploads are supported.' });
      }

      const originalName = String(req.file.originalname || 'media-upload').slice(0, 200);
      const safeExt = path.extname(originalName || '').replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12) || '.bin';
      const mediaId = randomUUID();
      const mediaPath = path.join(mediaRootDir, `${mediaId}${safeExt}`);
      const sha256 = createHash('sha256').update(req.file.buffer).digest('hex');

      await fs.mkdir(mediaRootDir, { recursive: true });
      await fs.writeFile(mediaPath, req.file.buffer);

      const interaction = await storage.ingestInteraction(
        sessionId,
        'media',
        `[queued transcription] ${originalName}`,
        originalName
      );

      const job = await storage.createJob(sessionId, 'media_transcription', {
        interaction_id: interaction.id,
        media_path: mediaPath,
        mime_type: mime,
        file_size_bytes: req.file.size,
        sha256,
        source_name: originalName,
        max_duration_sec: mediaMaxDurationSec,
        max_bytes: mediaMaxBytes
      });

      await storage.updateInteraction(sessionId, interaction.id, {
        job_id: job.id,
        transcript_status: 'queued',
        media: {
          path: mediaPath,
          source_name: originalName,
          mime_type: mime,
          size_bytes: req.file.size,
          sha256
        }
      });

      enqueueMediaJob({
        id: job.id,
        jobId: job.id,
        sessionId,
        interactionId: interaction.id,
        sourcePath: mediaPath,
        originalName,
        fileSizeBytes: req.file.size
      });

      const refreshed = await storage.getInteraction(sessionId, interaction.id);
      res.status(202).json({
        interaction: refreshed || interaction,
        job,
        queue: {
          running: runningMediaJobs.size,
          queued: queuedMediaJobs.length
        }
      });
    } catch (err) {
      const message = String(err?.message || 'Failed to queue media transcription.');
      if (/queue is full/i.test(message)) {
        return res.status(429).json({ error: message });
      }
      res.status(500).json({ error: message });
    }
  });

  // Retrieval
  router.get('/sessions/:sessionId/interactions', async (req, res) => {
    try {
      const interactions = await storage.getInteractions(req.params.sessionId);
      res.json({ interactions });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/sessions/:sessionId/jobs', async (req, res) => {
    try {
      const jobs = await storage.getJobsBySession(req.params.sessionId);
      res.json({
        jobs,
        queue: {
          running: runningMediaJobs.size,
          queued: queuedMediaJobs.length
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/sessions/:sessionId/jobs/:jobId', async (req, res) => {
    try {
      const job = await storage.getJob(req.params.jobId);
      if (!job || job.session_id !== req.params.sessionId) {
        return res.status(404).json({ error: 'Job not found.' });
      }
      res.json({ job });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/sessions/:sessionId/signals', async (req, res) => {
    try {
      const { type } = req.query;
      const signals = await storage.getSignalsBySession(req.params.sessionId, type);
      res.json({ signals });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/sessions/:sessionId/entities', async (req, res) => {
    try {
      const { type } = req.query;
      const entities = await storage.getEntitiesBySession(req.params.sessionId, type);
      const links = await storage.getEntityLinksBySession(req.params.sessionId);
      res.json({ entities, links });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/sessions/:sessionId/signals/:signalId/feedback', async (req, res) => {
    try {
      const { sessionId, signalId } = req.params;
      const verdict = req.body?.verdict;
      const note = req.body?.note;
      const source = req.body?.source || 'human';

      const feedback = await storage.addSignalFeedback(sessionId, signalId, verdict, note, source);
      if (!feedback) {
        return res.status(404).json({ error: 'Signal not found' });
      }

      const metrics = await storage.getSignalQualityMetrics(sessionId, { windowDays: 30 });
      return res.json({ feedback, metrics });
    } catch (err) {
      const message = String(err?.message || 'Failed to store signal feedback');
      if (/verdict must/i.test(message)) {
        return res.status(400).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });

  router.get('/sessions/:sessionId/quality', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const windowDays = Number(req.query?.window_days || req.query?.windowDays || 30);
      const metrics = await storage.getSignalQualityMetrics(sessionId, { windowDays });
      const feedback = await storage.getSignalFeedbackBySession(sessionId);
      return res.json({ metrics, feedback: feedback.slice(0, 100) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/sessions/:sessionId/evals/run', async (req, res) => {
    try {
      if (typeof storage.runSessionEvaluation !== 'function') {
        return res.status(501).json({ error: 'Eval orchestration is not supported by this storage backend.' });
      }

      const { sessionId } = req.params;
      const windowDays = Number(req.body?.window_days || req.body?.windowDays || req.query?.window_days || req.query?.windowDays || 30);
      const run = await storage.runSessionEvaluation(sessionId, {
        windowDays,
        trigger: req.body?.trigger || 'manual',
        note: req.body?.note,
        tags: req.body?.tags
      });

      if (!run) {
        return res.status(404).json({ error: 'Not found' });
      }

      return res.status(201).json({ eval_run: run });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/sessions/:sessionId/evals', async (req, res) => {
    try {
      if (typeof storage.getEvalRunsBySession !== 'function') {
        return res.status(501).json({ error: 'Eval orchestration is not supported by this storage backend.' });
      }

      const { sessionId } = req.params;
      const limit = Number(req.query?.limit || 20);
      const runs = await storage.getEvalRunsBySession(sessionId, { limit });
      return res.json({ eval_runs: runs });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/sessions/:sessionId/scorecard', async (req, res) => {
    try {
      if (typeof storage.getEvalRunsBySession !== 'function') {
        return res.status(501).json({ error: 'Eval orchestration is not supported by this storage backend.' });
      }

      const { sessionId } = req.params;
      const runs = await storage.getEvalRunsBySession(sessionId, { limit: 1 });
      const latest = runs[0] || null;
      return res.json({ scorecard: latest });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/evals/run-batch', async (req, res) => {
    try {
      if (typeof storage.runBatchEvaluation !== 'function') {
        return res.status(501).json({ error: 'Eval orchestration is not supported by this storage backend.' });
      }

      const identity = resolveIdentity(req);
      if (rejectInvalidIdentity(res, identity)) return;
      if (!identity.userId) {
        return res.status(400).json({ error: 'userId is required to run batch evaluations.' });
      }

      const requestedSessionIds = Array.isArray(req.body?.session_ids || req.body?.sessionIds)
        ? (req.body?.session_ids || req.body?.sessionIds)
        : null;
      const sessions = await storage.listSessions(identity.userId, { tenantId: identity.tenantId });
      const allowedSessionIds = new Set(sessions.map((item) => item.id));
      const sessionIds = requestedSessionIds
        ? requestedSessionIds.map((item) => String(item || '').trim()).filter((item) => allowedSessionIds.has(item))
        : sessions.map((item) => item.id);

      const result = await storage.runBatchEvaluation(sessionIds, {
        windowDays: Number(req.body?.window_days || req.body?.windowDays || 30),
        trigger: req.body?.trigger || 'batch',
        note: req.body?.note,
        tags: req.body?.tags
      });

      return res.json({
        requested_count: requestedSessionIds ? requestedSessionIds.length : sessions.length,
        executed_count: sessionIds.length,
        ...result
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/evals/:runId', async (req, res) => {
    try {
      if (typeof storage.getEvalRunById !== 'function') {
        return res.status(501).json({ error: 'Eval orchestration is not supported by this storage backend.' });
      }

      const identity = resolveIdentity(req);
      if (rejectInvalidIdentity(res, identity)) return;

      const run = await storage.getEvalRunById(req.params.runId);
      if (!run) return res.status(404).json({ error: 'Not found' });

      if (identity.tenantId && String(run.tenant_id || '') !== identity.tenantId) {
        return res.status(404).json({ error: 'Not found' });
      }
      if (identity.trustedUserId && String(run.user_id || '') !== identity.trustedUserId) {
        return res.status(404).json({ error: 'Not found' });
      }

      return res.json({ eval_run: run });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/sessions/:sessionId/actions', async (req, res) => {
    try {
      const { status } = req.query;
      const actions = await storage.getActionsBySession(req.params.sessionId, status);
      res.json({ actions });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/sessions/:sessionId/actions/reminders/due', async (req, res) => {
    try {
      const actions = await storage.getActionsBySession(req.params.sessionId, 'open');
      const now = Date.now();

      const due = (actions || []).filter((action) => {
        const reminderTime = action?.next_reminder_at ? new Date(action.next_reminder_at).getTime() : NaN;
        const hasDueReminder = Number.isFinite(reminderTime) && reminderTime <= now;
        const overdueDate = parseDueDateValue(action?.due_date);
        const overdueByDate = overdueDate ? (daysUntilDate(overdueDate) < 0) : false;
        return hasDueReminder || overdueByDate || Boolean(action?.is_overdue);
      });

      res.json({
        generated_at: new Date(now).toISOString(),
        count: due.length,
        actions: due
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/sessions/:sessionId/actions/:actionId', async (req, res) => {
    try {
      const { sessionId, actionId } = req.params;
      const updated = await storage.updateAction(sessionId, actionId, req.body || {});
      if (!updated) return res.status(404).json({ error: 'Action not found' });
      res.json({ action: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Synthesis
  router.post('/sessions/:sessionId/synthesize', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { query, synthesisType = 'pattern', provider: requestedProvider, model: requestedModel } = req.body;
      const [signals, interactions] = await Promise.all([
        storage.getSignalsBySession(sessionId),
        storage.getInteractions(sessionId)
      ]);

      const provider = requestedProvider || config.aiProvider || 'ollama';
      const model = await getEffectiveModel({ provider, model: requestedModel, config });
      const synthesisPrompt = await resolvePromptProfile('session_synthesis');
      const userPrompt = buildSynthesisPrompt({
        query,
        interactions,
        signals,
        template: synthesisPrompt?.user_template
      });

      let aiText = '';
      await streamWithProvider({
        provider,
        model,
        messages: [
          {
            role: 'system',
            content: synthesisPrompt?.system_prompt || DEFAULT_PROMPT_PROFILES.session_synthesis.system_prompt
          },
          { role: 'user', content: userPrompt }
        ],
        config,
        onToken: (token) => { aiText += token; }
      });

      const stored = await storage.storeSynthesis(
        sessionId,
        synthesisType,
        aiText,
        model,
        Math.ceil(aiText.length / 4),
        {
          promptProfile: synthesisPrompt?.profile_id || 'session_synthesis',
          promptVersion: synthesisPrompt?.id || DEFAULT_PROMPT_PROFILES.session_synthesis.id
        }
      );
      res.json({ synthesis: stored });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/sessions/:sessionId/synthesis', async (req, res) => {
    try {
      const { type } = req.query;
      const syntheses = await storage.getSynthesisBySession(req.params.sessionId, type);
      res.json({ syntheses });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
