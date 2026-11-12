'use client';

import { createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { APP_FOOTER_TEXT, APP_VERSION } from '../constants/app';
import { FlowerMark } from './ui/StatusOrb';
import {
  Badge, Button, SegmentedControl, Spinner, Switch,
  IncognitoIcon, RadarIcon, SlidersIcon, WaveIcon, CloseIcon, ArrowDownIcon, CheckIcon,
  GearIcon, ShieldIcon, PlugIcon, MicIcon, TerminalIcon, FlaskIcon, AlertIcon, CubeIcon, ChevronRightIcon
} from './ui/primitives';
import TabSwitch from './shell/TabSwitch';
import CommitmentRadar from './shell/CommitmentRadar';
import VoiceChat from './shell/VoiceChat';
import AgentRunPanel from './shell/AgentRunPanel';
import ApprovalCard from './shell/ApprovalCard';
import SettingsSheet, { SettingsGroup, SettingsList, SettingsRow, SettingsNotice } from './settings/SettingsSheet';
import AccessPane from './settings/AccessPane';
import ConnectorsPane from './settings/ConnectorsPane';
import ModelsPane from './settings/ModelsPane';
import { playSend, playReceive, playError } from '../lib/sounds';
import { postJSON } from '../lib/api';
import { getSessionToken } from '../lib/sessionToken';
import { createSseParser } from '../lib/sseParser';
import {
  chooseSendRoute, toApproval, addApproval, removeApproval, approvalEventType,
  approvalNarration, approvalReplyOutcome, runRefusal, describeRunError,
  isExplicitImagePrompt, toImagePrompt, accessChangeNotice,
  contextMessages, conversationContext, buildRunContext, isTextAttachment
} from '../lib/agentRunPolicy';
import { ACCESS_LEVELS, ACCESS_TONE_COLOR, accessMeta, lowerAccess, fetchAccess, saveAccess, describeApiError } from '../lib/access';
import { hasUsableKey, providerNeedsKey, missingKeyMessage } from '../lib/providerKeys';
import { needsServerModelSwitch } from '../lib/providerCapabilities';
import { EFFORT_LABELS } from '../lib/effort';
import {
  pickAutoModel, pickUncensoredModel, modelFit, fitDetail, itemSize, FIT_LABELS, rowIdForName, isInstalledName,
  startInstallJob, followInstallJob, cancelInstallJob, listInstallJobs, deleteInstalledModel
} from '../lib/models';
import { appStore, useAppStore } from '../store/useAppStore';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

// Male/female toggle to Piper voices. Until a model is installed, a browser
// voice speaks while the Piper model downloads in the background.
const VOICE_GENDER_PIPER = { male: 'en_US-ryan-medium', female: 'en_US-amy-medium' };
// Best-effort name hints for picking a male/female browser voice fallback.
const BROWSER_VOICE_HINTS = {
  female: ['female', 'samantha', 'victoria', 'karen', 'moira', 'tessa', 'fiona', 'amelie', 'anna', 'zira', 'susan', 'allison', 'ava', 'zoe', 'serena', 'kate'],
  male: ['male', 'daniel', 'alex', 'fred', 'thomas', 'oliver', 'george', 'david', 'mark', 'rishi', 'aaron', 'arthur', 'gordon', 'lee']
};

// The first five are prompt hints on a single request. The `agentic` ones run
// the backend loop with a hard budget via /api/agent/runs.
const EFFORT_OPTIONS = [
  { value: 'instant',  label: 'Instant',     hint: 'one line' },
  { value: 'fast',     label: 'Fast',        hint: 'concise' },
  { value: 'balanced', label: 'Balanced',    hint: 'default' },
  { value: 'thorough', label: 'Thorough',    hint: 'complete' },
  { value: 'deep',     label: 'Deep',        hint: 'reason first' },
  { value: 'high',     label: 'High',        hint: 'plan, act, validate', agentic: true },
  { value: 'hour',     label: '1 hour',      hint: 'keeps working', agentic: true },
  { value: 'session',  label: '5 hours',     hint: 'long session', agentic: true }
];

const AGENTIC_EFFORTS = new Set(EFFORT_OPTIONS.filter((o) => o.agentic).map((o) => o.value));

/** The composer Access menu's width (w-80). */
const ACCESS_MENU_WIDTH = 320;

/** First line of the message, code removed, short enough to be a search query. */
function searchQueryFrom(text) {
  const plain = String(text || '').replace(/```[\s\S]*?```/g, ' ').trim();
  const firstLine = plain.split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (firstLine.length <= 200) return firstLine;
  const cut = firstLine.slice(0, 200);
  return cut.slice(0, cut.lastIndexOf(' ') > 120 ? cut.lastIndexOf(' ') : 200);
}

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
    // Ignore storage write failures to keep the UI usable.
  }
}

function safeStorageRemove(key) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage removal failures to keep the UI usable.
  }
}

function buildDefaultSystemPrompt(providerId) {
  const runtimeLine = providerId === 'ollama' || providerId === 'koboldcpp'
    ? 'You are running entirely on the user\'s own device.'
    : 'You are inside a local app and may answer using either local or user-configured remote AI providers.';

  return `You are Mirabilis AI, a concise and helpful assistant. ${runtimeLine} Never describe yourself as a generic AI product. When someone asks who created or built you, answer naturally and briefly: Mirabilis AI was created by Moshiko Nayman. Do not volunteer that information unprompted. Image generation is available locally via a Stable Diffusion service - generate real images rather than ASCII art when asked.`;
}

const DEFAULT_SYSTEM_PROMPT = buildDefaultSystemPrompt('ollama');

function isMirabilisDefaultPrompt(value) {
  const text = String(value || '');
  return text.includes('You are Mirabilis AI, a concise and helpful assistant.') ||
    text.includes('You are Mirabilis AI, a concise and helpful local assistant.') ||
    text === 'You are a concise and helpful local assistant.';
}

const UNSAVED_PROMPT_PROFILE_ID = 'current-custom';

const BUILTIN_PROMPT_PROFILES = [
  {
    id: 'mirabilis-default',
    label: 'Default',
    getPrompt: (providerId) => buildDefaultSystemPrompt(providerId)
  },
  {
    id: 'network-engineer',
    label: 'Network',
    getPrompt: () => 'You are Mirabilis AI acting as a senior network engineer. Be precise, operationally conservative, and explicit about assumptions. When analyzing configs, logs, or CLI output, prioritize root cause, blast radius, rollback considerations, and concrete next commands.'
  },
  {
    id: 'research-analyst',
    label: 'Analyst',
    getPrompt: () => 'You are Mirabilis AI acting as a research analyst. Structure answers clearly, distinguish facts from inference, call out uncertainty, and synthesize findings into concise conclusions with practical implications.'
  },
  {
    id: 'guided-tutor',
    label: 'Tutor',
    getPrompt: () => 'You are Mirabilis AI acting as a guided tutor. Teach in clear steps, adapt to the user\'s apparent level, and explain why each step matters. Prefer examples and checkpoints over long monologues.'
  },
  {
    id: 'remote-operator',
    label: 'Operator',
    getPrompt: () => 'You are Mirabilis AI acting as a remote operations assistant. Before suggesting commands or tool use, think in terms of verification, safe sequencing, explicit targets, and reversible actions. Prefer short plans with command-by-command intent.'
  }
];

function normalizePromptProfileId(value) {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed.slice(0, 80) : '';
}

function sanitizeCustomPromptProfiles(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => ({
      id: normalizePromptProfileId(item?.id),
      label: String(item?.label || '').trim().slice(0, 60),
      description: String(item?.description || '').trim().slice(0, 120),
      prompt: String(item?.prompt || '').slice(0, 16000)
    }))
    .filter((item) => item.id && item.label && item.prompt)
    .slice(0, 24);
}

function buildPromptProfiles(providerId, customProfiles = []) {
  return [
    ...BUILTIN_PROMPT_PROFILES.map((profile) => ({
      id: profile.id,
      label: profile.label,
      description: profile.description,
      content: profile.getPrompt(providerId),
      isBuiltin: true
    })),
    ...sanitizeCustomPromptProfiles(customProfiles).map((profile) => ({
      id: profile.id,
      label: profile.label,
      description: profile.description,
      content: profile.prompt,
      isBuiltin: false
    }))
  ];
}

function findPromptProfile(profiles, profileId) {
  return profiles.find((profile) => profile.id === profileId) || null;
}

function formatUsdEstimate(value) {
  const amount = Number(value || 0);
  if (amount <= 0) return '$0.00';
  if (amount < 0.001) return '<$0.001';
  if (amount < 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

function formatUsagePercent(estUsd, budgetUsd) {
  const budget = Number(budgetUsd || 0);
  const value = Number(estUsd || 0);
  if (!(budget > 0) || !(value > 0)) return '0%';
  const pct = (value / budget) * 100;
  if (pct > 0 && pct < 1) return '<1%';
  return `${Math.min(100, Math.round(pct))}%`;
}
// Picker groups: Local (this machine), Remote (self-hosted servers), Cloud APIs (keyed).
const PROVIDER_GROUPS = ['Local', 'Remote', 'Cloud APIs'];
const PROVIDER_OPTIONS = [
  { id: 'ollama', label: 'Ollama', scope: 'Local', group: 'Local' },
  // Managed llama.cpp server; runs GGUFs directly, no Ollama daemon at inference.
  { id: 'llamacpp', label: 'llama.cpp', scope: 'Local', group: 'Local' },
  { id: 'openai-compatible', label: 'Custom endpoint', scope: 'Local/Remote', requiresBinary: 'llama-server', group: 'Local' },
  { id: 'koboldcpp', label: 'KoboldCpp', scope: 'Local', requiresBinary: 'koboldcpp', group: 'Local' },
  // vLLM runs as a managed local server on an NVIDIA/CUDA machine, or connects to
  // a remote vLLM server by URL. On Apple Silicon only the remote path is offered.
  { id: 'vllm', label: 'vLLM', scope: 'Local/Remote', group: 'Remote' },
  { id: 'gpuaas', label: 'GPUaaS endpoint', scope: 'Remote', group: 'Remote' },
  { id: 'openai', label: 'OpenAI', scope: 'Remote', group: 'Cloud APIs' },
  { id: 'claude', label: 'Claude', scope: 'Remote', group: 'Cloud APIs' },
  { id: 'gemini', label: 'Gemini', scope: 'Remote', group: 'Cloud APIs' },
  { id: 'grok', label: 'Grok', scope: 'Remote', group: 'Cloud APIs' },
  { id: 'groq', label: 'Groq', scope: 'Remote', group: 'Cloud APIs' },
  { id: 'openrouter', label: 'OpenRouter', scope: 'Remote', group: 'Cloud APIs' },
  { id: 'cerebras', label: 'Cerebras', scope: 'Remote', group: 'Cloud APIs' }
];
// First token on a big local model includes cold load and prefill and can take
// minutes. Once tokens flow, a short gap means the stream is dead.
const STREAM_FIRST_TOKEN_BUDGET_MS = 900000; // 15 min before the first token
const STREAM_STALL_TIMEOUT_MS = 60000;       // 60s gap between tokens = dead

// Per-1M-token list prices for the budget bar, from each provider's pricing page
// (2026-11-11). The longest matching prefix wins; default covers the rest.
const COST_RATES_PER_1M = {
  openai: {
    default: { in: 0.10, out: 0.50 },
    'gpt-6-luna': { in: 0.10, out: 0.50 },
    'gpt-6-sol': { in: 2.00, out: 10.00 },
    'gpt-6-astra': { in: 10.00, out: 50.00 },
    'gpt-6.1-sol': { in: 2.00, out: 10.00 },
    'gpt-6.1-terra': { in: 1.00, out: 5.00 },
    'gpt-5.6-luna': { in: 0.20, out: 1.20 },
    'gpt-5.6-terra': { in: 2.00, out: 12.00 },
    'gpt-5.6-sol': { in: 4.40, out: 22.00 },
    'gpt-5.5': { in: 5.00, out: 30.00 },
    'gpt-5.4': { in: 2.50, out: 15.00 },
    'gpt-5.4-mini': { in: 0.75, out: 4.50 },
    'gpt-5.4-nano': { in: 0.20, out: 1.25 },
    // Shut down January 14, 2027.
    'gpt-4.1': { in: 2.00, out: 8.00 },
    'gpt-4o': { in: 2.50, out: 10.00 },
    'gpt-4o-mini': { in: 0.15, out: 0.60 }
  },
  grok: {
    default: { in: 1.25, out: 2.50 },
    'grok-4.3': { in: 1.25, out: 2.50 },
    'grok-4.20': { in: 1.25, out: 2.50 },
    'grok-4.5': { in: 2.00, out: 6.00 },
    'grok-4.6': { in: 2.00, out: 6.00 },
    'grok-4.7': { in: 2.00, out: 6.00 },
    'grok-build': { in: 1.00, out: 2.00 }
  },
  groq: {
    default: { in: 0.075, out: 0.30 },
    'openai/gpt-oss-20b': { in: 0.075, out: 0.30 },
    'openai/gpt-oss-120b': { in: 0.15, out: 0.60 },
    'qwen/qwen3.8-27b': { in: 0.80, out: 4.00 }
  },
  openrouter: {
    // Ids ending in :free cost nothing; see resolveRateCard.
    default: { in: 0.50, out: 1.50 },
    'openrouter/free': { in: 0, out: 0 },
    'openai/gpt-6-luna': { in: 0.10, out: 0.50 },
    'openai/gpt-6.1-terra': { in: 1.00, out: 5.00 },
    'openai/gpt-oss-120b': { in: 0.15, out: 0.60 },
    'anthropic/claude-haiku-5.5': { in: 0.10, out: 0.50 },
    'anthropic/claude-sonnet-5': { in: 2.00, out: 10.00 },
    'anthropic/claude-opus-5.5': { in: 4.00, out: 20.00 },
    'google/gemini-3.5-flash-lite': { in: 0.30, out: 2.50 },
    'x-ai/grok-4.3': { in: 1.25, out: 2.50 }
  },
  gpuaas: {
    default: { in: 0.60, out: 1.80 }
  },
  gemini: {
    default: { in: 0.30, out: 2.50 },
    'gemini-3.5-flash-lite': { in: 0.30, out: 2.50 },
    'gemini-3.6-flash': { in: 1.50, out: 7.50 },
    // Introductory price through the end of 2026.
    'gemini-3.8-flash': { in: 0.75, out: 3.75 },
    // List price after the introductory period ends November 30, 2026.
    'gemini-4-argon': { in: 4.00, out: 20.00 },
    'gemini-4-carbon': { in: 4.00, out: 20.00 }
  },
  claude: {
    default: { in: 0.10, out: 0.50 },
    'claude-haiku-5-5': { in: 0.10, out: 0.50 },
    'claude-haiku-4-5': { in: 1.00, out: 5.00 },
    'claude-sonnet-5': { in: 2.00, out: 10.00 },
    'claude-sonnet-4': { in: 3.00, out: 15.00 },
    'claude-opus-5-5': { in: 4.00, out: 20.00 },
    'claude-opus-5': { in: 5.00, out: 25.00 },
    'claude-opus-4': { in: 5.00, out: 25.00 },
    'claude-fable-5-2': { in: 8.00, out: 40.00 },
    'claude-fable-5': { in: 10.00, out: 50.00 },
    'claude-mythos-5-2': { in: 8.00, out: 40.00 },
    'claude-mythos-5': { in: 10.00, out: 50.00 }
  },
  cerebras: {
    // Free tier is 0; these are the paid rates so the budget bar is meaningful
    // past the free allowance.
    default: { in: 0.35, out: 0.75 },
    'gpt-oss-120b': { in: 0.35, out: 0.75 },
    'qwen-3.8-27b': { in: 0.99, out: 1.49 }
  }
};

// The longest matching prefix wins, so gpt-4o-mini is not priced as gpt-4o.
function resolveRateCard(providerId, modelId) {
  const providerRates = COST_RATES_PER_1M[providerId];
  if (!providerRates) return null;
  const key = String(modelId || '').toLowerCase();
  if (providerId === 'openrouter' && key.endsWith(':free')) return { in: 0, out: 0 };
  let best = '';
  for (const prefix of Object.keys(providerRates)) {
    if (prefix !== 'default' && prefix.length > best.length && key.startsWith(prefix)) best = prefix;
  }
  return best ? providerRates[best] : providerRates.default;
}

// Auto on a cloud provider: the first model it lists. With no list, '' lets the
// backend send providerDefaults from backend/models.json.
function cloudAutoModel(list) {
  return (list || []).find((item) => item?.available !== false)?.id || '';
}

// Install and delete failures as the sentence a row shows, never raw JSON.
function modelErrorText(err, fallback) {
  const text = plainError(describeApiError(err, 'Models'), fallback);
  return /fetch failed|ECONNREFUSED/i.test(text) ? 'Ollama is not running. Start it, then retry.' : text;
}

const GO_DARK_INSTALL = 'Blocked by Go Dark. Turn it off to install.';

function normalizeGeminiBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!raw) return 'https://generativelanguage.googleapis.com/v1beta/openai';
  if (raw.includes('generativelanguage.googleapis.com') && !raw.endsWith('/openai')) {
    return `${raw}/openai`;
  }
  return raw;
}

function isImageRequest(text) {
  const hasVerb = /\b(generate|create|draw|paint|make|render|produce|show)\b/i.test(text);
  const hasNoun = /\b(image|picture|pic|photo|photograph|illustration|artwork|painting|portrait|sketch|drawing|wallpaper|snapshot|snap)\b/i.test(text);
  return hasVerb && hasNoun;
}

/**
 * Answer-mode lines for Guided Learning, an answer effort and Deep thinking.
 * Agent runs pass no effort: their effort profile carries its own style.
 */
function answerModeLines({ guided, effort, deep }) {
  const lines = [];
  if (guided) {
    lines.push(
      'Teaching mode: Explain with a short, structured learning path.',
      'Ask one clarifying question if needed, then provide step-by-step guidance.',
      'Use examples and a tiny recap at the end.'
    );
  }
  if (effort === 'instant') {
    lines.push('Effort: instant. Give the shortest possible correct answer, one line if you can, no preamble.');
  }
  if (effort === 'fast') {
    lines.push('Effort: fast. Answer concisely and directly, skip preamble.');
  }
  if (effort === 'thorough') {
    lines.push('Effort: thorough. Work through the key considerations and give a complete, well-structured answer.');
  }
  // balanced: no extra instruction. Effort "deep" and the deep-thinking toggle
  // share one set of lines so they do not double up.
  if (deep || effort === 'deep') {
    lines.push(
      'Deep thinking mode: reason carefully, compare alternatives, and include key trade-offs.',
      'Provide a concise executive answer first, then details.'
    );
  }
  return lines;
}

/** Text of the readable files attached to these messages, by storedName. Unreadable files are left out. */
async function fetchAttachmentTexts(messages) {
  const files = [];
  for (const m of messages) {
    for (const a of (Array.isArray(m.attachments) ? m.attachments : [])) {
      if (isTextAttachment(a)) files.push(a);
    }
  }
  const texts = new Map();
  await Promise.all(files.map(async (a) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${API_BASE}${a.url}`, { signal: ctrl.signal });
      if (res.ok) texts.set(a.storedName, await res.text());
    } catch {
      // Named in the context as unreadable instead.
    } finally {
      clearTimeout(timer);
    }
  }));
  return texts;
}

async function api(path, options = {}) {
  // Privileged routes need the session token; unguarded routes ignore the header.
  const token = await getSessionToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-mirabilis-mcp-token': token } : {}),
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    const payload = await response.text().catch(() => 'Request failed');
    throw new Error(payload || `Request failed (${response.status})`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

// api() throws the raw response text; show the server's sentence when it sent
// JSON, short plain text as is, and the fallback for pages or payloads.
function plainError(message, fallback = 'Request failed') {
  const raw = String(message || '').trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // Plain text already.
  }
  return raw && raw.length <= 300 && !/^[<{[]/.test(raw) ? raw : fallback;
}

// 'search' when the query needs live data, 'skip' when training knowledge suffices.
function classifyWebSearch(text) {
  const t = text.toLowerCase();

  // Hard skip - pure generation / writing tasks that gain nothing from web context
  const skipPatterns = [
    /\b(write|draft|compose|summarise?|summarize|translate|generate|create|draw|code|fix|debug|refactor|improve|proofread|rewrite|convert|calculate|solve)\b/,
  ];
  const hasSkipVerb = skipPatterns.some((r) => r.test(t));

  // Live / real-time signals - always search regardless of skip verbs
  const liveSignals = [
    /\b(today|tonight|right now|currently|at the moment|this week|this month|this year|yesterday|latest|recent|new|breaking|live|happening)\b/,
    /\b(news|headline|stock|price|weather|forecast|score|result|standings|match|game|election|vote|poll|winner|champion)\b/,
    /\b(who (is|are|won|leads?|runs?|owns?)|what('s| is) (the )?(?:current|latest|new|best|top)|when (is|does|will|did))\b/,
    /\b(2025|2026|2027)\b/,
    /\b(release|launch|announce|update|version) .{0,30}(when|date|out|available|coming)\b/,
    /https?:\/\//,
    // capability / internet-connectivity checks
    /\b(check|test|verify|is .{0,20} (working|available|online|down|up)|can you (access|reach|fetch|browse|search))\b/,
  ];
  const hasLiveSignal = liveSignals.some((r) => r.test(t));

  if (hasLiveSignal) return 'search';
  if (hasSkipVerb) return 'skip';
  // Default to search when www is on; the model decides if the context helps.
  return 'search';
}

function formatTime(value) {
  const date = new Date(value);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);
  if (diffSec < 60) return 'Now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function estimateTokens(text) {
  const normalized = (text || '').trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

// Saved agent-run messages carry no estimate, so count their text; an explicit
// estimate, zero included, stands.
function messageTokens(message) {
  const est = Number(message?.tokenEstimate);
  return message?.tokenEstimate != null && Number.isFinite(est) ? est : estimateTokens(message?.content);
}

function formatTokenCount(value) {
  const amount = Number(value || 0);
  return `${amount.toLocaleString()} tok`;
}

// Picker fit chip colors; lib/models.js modelFit decides the fit, as in Settings > Models.
const FIT_CHIP_TONE = {
  fits: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  tight: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  swap: 'bg-rose-500/15 text-rose-600 dark:text-rose-300'
};

// Install progress is polled at this rate; a lost backend gets this many tries.
const JOB_POLL_MS = 1000;
const JOB_POLL_RETRIES = 5;

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function plainTextForSpeech(text) {
  const raw = String(text || '');
  return raw
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/\s+/g, ' ')
    .trim();
}

function estimateModelContextWindow(modelId) {
  const id = String(modelId || '').toLowerCase();
  // Llama 3.1 / 3.2 / 4: 128K context
  if (id.includes('llama3.1') || id.includes('llama3.2') || id.includes('llama4')) return 131072;
  // Llama 3.3: 128K
  if (id.includes('llama3.3')) return 131072;
  // Llama 3.0: 8K default
  if (id.includes('llama3')) return 8192;
  // Qwen 2.5 / 3 all ship with 128K
  if (id.includes('qwen')) return 131072;
  // DeepSeek models: 64K
  if (id.includes('deepseek')) return 65536;
  // Dolphin 3+ uses Llama 3 / Qwen base: 128K; older Dolphin on Mistral: 32K
  if (id.includes('dolphin3') || (id.includes('dolphin') && !id.includes('mixtral'))) return 131072;
  if (id.includes('dolphin')) return 32768;
  // Mistral Large 3: 128K
  if (id.includes('mistral-large')) return 131072;
  // Mistral 7B / Mixtral: 32K
  if (id.includes('mistral') || id.includes('mixtral')) return 32768;
  // Jamba (AI21): up to 256K context
  if (id.includes('jamba')) return 262144;
  // Phi-4: 16K
  if (id.includes('phi4')) return 16384;
  // Gemma 4: 26b/31b = 256K; e2b/e4b = 128K
  if (id.includes('gemma4') && (id.includes('26b') || id.includes('31b'))) return 262144;
  if (id.includes('gemma4')) return 131072;
  // Gemma 3: 128K; older Gemma: 8K
  if (id.includes('gemma3')) return 131072;
  if (id.includes('gemma')) return 8192;
  return 8192;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }
  return (
    <button
      onClick={handleCopy}
      className="ml-auto rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)] transition hover:bg-[var(--material-thin)] hover:text-white"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CopyMessageButton({ text, className }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? 'Copied' : 'Copy message'}
      className={className || 'rounded p-1 text-[color:var(--text-muted)] transition hover:bg-black/5 hover:text-[color:var(--text-main)] dark:hover:bg-[var(--material-thin)] dark:hover:text-slate-200'}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

// Hebrew/Arabic forces RTL on the whole block; `dir="auto"` is unreliable on
// mixed or nested lists.
const RTL_CHARS_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

// CSS-var driven so it follows scheme changes without re-rendering.
const SYNTAX_THEME = {
  'code[class*="language-"]': {
    color: 'var(--code-text)',
    background: 'none',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
  },
  'pre[class*="language-"]': { background: 'none', margin: 0, padding: 0 },
  comment:             { color: 'var(--code-comment)', fontStyle: 'italic' },
  prolog:              { color: 'var(--code-comment)', fontStyle: 'italic' },
  doctype:             { color: 'var(--code-comment)', fontStyle: 'italic' },
  cdata:               { color: 'var(--code-comment)', fontStyle: 'italic' },
  punctuation:         { color: 'color-mix(in srgb, var(--code-text) 65%, transparent)' },
  tag:                 { color: 'var(--code-tag)' },
  'tag .punctuation':  { color: 'var(--code-tag)' },
  'attr-name':         { color: 'var(--code-attr)' },
  'attr-value':        { color: 'var(--code-string)' },
  string:              { color: 'var(--code-string)' },
  char:                { color: 'var(--code-string)' },
  'template-string':   { color: 'var(--code-string)' },
  'template-punctuation': { color: 'var(--code-string)' },
  number:              { color: 'var(--code-number)' },
  boolean:             { color: 'var(--code-number)' },
  keyword:             { color: 'var(--code-keyword)', fontWeight: '600' },
  atrule:              { color: 'var(--code-keyword)' },
  'control-flow':      { color: 'var(--code-keyword)', fontWeight: '600' },
  function:            { color: 'var(--code-fn)' },
  'function-variable': { color: 'var(--code-fn)' },
  'class-name':        { color: 'var(--code-fn)' },
  property:            { color: 'var(--code-attr)' },
  selector:            { color: 'var(--code-tag)' },
  builtin:             { color: 'var(--code-fn)' },
  constant:            { color: 'var(--code-number)' },
  symbol:              { color: 'var(--code-number)' },
  operator:            { color: 'color-mix(in srgb, var(--code-text) 75%, transparent)' },
  entity:              { color: 'var(--code-attr)', cursor: 'help' },
  url:                 { color: 'var(--code-attr)' },
  regex:               { color: 'var(--code-string)' },
  important:           { color: 'var(--code-keyword)', fontWeight: 'bold' },
  variable:            { color: 'var(--code-text)' },
  namespace:           { color: 'var(--code-fn)' },
  bold:                { fontWeight: 'bold' },
  italic:              { fontStyle: 'italic' },
  // line numbers
  'line-numbers.line-numbers .line-numbers-rows': { borderRightColor: 'color-mix(in srgb, var(--code-text) 12%, transparent)' },
  'line-numbers-rows > span:before': { color: 'color-mix(in srgb, var(--code-text) 30%, transparent)' },
};

// Lists and tables inherit `dir` from the wrapper set in renderMessageContent.
// `p` and headings keep `dir="auto"` for per-paragraph alignment in mixed text.
const MD_STATIC_COMPONENTS = {
  h1: ({ children }) => <h1 className="mb-2 mt-3 text-xl font-bold" dir="auto">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1.5 mt-3 text-lg font-bold" dir="auto">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-base font-semibold" dir="auto">{children}</h3>,
  p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed" dir="auto">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 ps-4 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 ps-4 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-s-2 border-accent ps-3 text-[color:var(--text-muted)] italic dark:text-[color:var(--text-muted)]">{children}</blockquote>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:brightness-90">{children}</a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-[var(--hairline)]">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-black/5 dark:bg-white/5">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-t border-black/5 dark:border-white/5">{children}</tr>,
  th: ({ children }) => <th className="px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-[color:var(--text-main)]">{children}</th>,
  td: ({ children }) => <td className="px-3 py-1.5 text-[color:var(--text-main)]">{children}</td>,
};

// Remote Control state for code blocks. Must be context, not a ref: MessageRow's
// memo comparator ignores execResults, and context updates bypass React.memo.
const RemoteExecContext = createContext({
  remoteConnected: false,
  remoteTarget: '',
  execResults: {},
  onRunCommand: () => {}
});

// The id of the message currently being rendered, used to key its code blocks.
// Provided by MessageRow so the code renderer can live at module scope.
const MessageIdContext = createContext('msg');

const SHELL_LANGS = ['bash', 'sh', 'shell', 'zsh', 'fish', 'cmd', 'powershell', 'ps1'];
const isShellLang = (l) => SHELL_LANGS.includes(l);

// Kept at module scope: a new component identity per render remounts every code
// block, losing selection and CopyButton state and re-running Prism.
function MarkdownCode({ inline, className, children, ...props }) {
  const { remoteConnected, remoteTarget, execResults, onRunCommand } = useContext(RemoteExecContext);
  const messageId = useContext(MessageIdContext);

  const lang = (className || '').replace('language-', '') || '';
  const displayLang = lang || 'code';
  const codeText = String(children).replace(/\n$/, '');
  // react-markdown v9+ omits `inline`: inline code has no language class and no newline.
  const isInline = inline || (!className?.includes('language-') && !codeText.includes('\n'));
  if (isInline) {
    return (
      <code
        className="rounded-md border px-1 py-0.5 font-mono text-[0.82em]"
        style={{
          background: 'var(--accent-soft)',
          borderColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
          color: 'var(--accent)',
        }}
        {...props}
      >
        {children}
      </code>
    );
  }

  const blockKey = `${messageId || 'msg'}-${displayLang}-${codeText.slice(0, 40)}`;
  const execResult = execResults[blockKey];
  const canRun = isShellLang(lang) && remoteConnected;

  return (
    <figure className="relative overflow-clip rounded-xl border" style={{ background: 'var(--code-bg)', borderColor: 'var(--code-border)', color: 'var(--code-text)' }}>
      <figcaption className="sticky top-0 z-10 flex items-center border-b px-3 py-1 backdrop-blur-sm" style={{ background: 'var(--code-header)', borderColor: 'var(--code-border)' }}>
        <span className="text-[10px] uppercase tracking-[0.12em]" style={{ color: 'var(--code-lang)' }}>{displayLang}</span>
        {canRun && (
          <button
            type="button"
            onClick={() => onRunCommand(codeText, blockKey)}
            disabled={execResult?.running}
            className="ml-2 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400 transition hover:bg-[var(--material-thin)] hover:text-emerald-300 disabled:opacity-50"
            title={`Run on ${remoteTarget}`}
          >
            {execResult?.running ? 'Running...' : 'Run'}
          </button>
        )}
        <CopyButton text={codeText} />
      </figcaption>
      <div className="overflow-x-auto p-3 text-[12px] leading-5 sm:text-[13px]">
        <SyntaxHighlighter
          language={lang || 'text'}
          style={SYNTAX_THEME}
          showLineNumbers
          lineNumberStyle={{ color: 'color-mix(in srgb, var(--code-text) 28%, transparent)', minWidth: '2.2em', userSelect: 'none', paddingRight: '1em' }}
          PreTag="div"
          CodeTag="code"
          customStyle={{ background: 'none', margin: 0, padding: 0, fontFamily: 'var(--font-mono), monospace' }}
          codeTagProps={{ className: 'font-mono' }}
          wrapLongLines={false}
        >
          {codeText}
        </SyntaxHighlighter>
      </div>
      {execResult && !execResult.running && (
        <div className="border-t border-white/10 bg-black/40 px-3 py-2 font-mono text-[11px]">
          {execResult.stdout && (
            <pre className="whitespace-pre-wrap text-emerald-300">{execResult.stdout}</pre>
          )}
          {execResult.stderr && (
            <pre className="whitespace-pre-wrap text-red-400">{execResult.stderr}</pre>
          )}
          <div className={`mt-1 text-[10px] ${execResult.exitCode === 0 ? 'text-[color:var(--text-muted)]' : 'text-red-400'}`}>
            exit {execResult.exitCode} | {execResult.duration != null ? `${execResult.duration}ms` : ''}
          </div>
        </div>
      )}
    </figure>
  );
}

// Frozen at module scope so component identities stay stable.
const MD_COMPONENTS = Object.freeze({ ...MD_STATIC_COMPONENTS, code: MarkdownCode });

function renderMessageContent(content, message = {}) {
  if (message.imageGenerating) {
    return (
      <div
        className="relative overflow-hidden rounded-xl bg-[var(--material-thick)]"
        style={{ width: 288, height: 288 }}
        aria-label="Generating image..."
      >
        <div
          className="img-shimmer pointer-events-none absolute inset-0 w-1/2 bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/10"
          style={{ willChange: 'transform' }}
        />
        <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-1.5 px-3 py-2.5 bg-gradient-to-t from-black/25 to-transparent rounded-b-xl">
          <svg className="h-3.5 w-3.5 text-white/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span className="text-xs font-medium text-white/80">Generating image...</span>
        </div>
      </div>
    );
  }

  if (message.imageUrl) {
    return (
      <figure className="mt-1">
        <img
          src={`${API_BASE}${message.imageUrl}`}
          alt={message.content || 'Generated image'}
          className="max-w-full rounded-xl"
        />
        {message.content && (
          <figcaption className="mt-1.5 text-xs text-[color:var(--text-muted)]">{message.content}</figcaption>
        )}
      </figure>
    );
  }

  const text = content || '';

  // A concrete direction on the block so list containers inherit it.
  const dir = RTL_CHARS_RE.test(text) ? 'rtl' : 'ltr';

  return (
    <div className="markdown-body text-sm" dir={dir}>
      <ReactMarkdown components={MD_COMPONENTS} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{text}</ReactMarkdown>
    </div>
  );
}

// Comparator ignores callbacks so typing or streaming does not reconcile the whole list.
const ChatItem = memo(function ChatItem({ chat, isActive, isMenuOpen, isPinned, onSelect, onToggleMenu, onDelete, onRename, onExport, onTogglePin, onBranch }) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false); // two-click delete on the row

  function startRename() {
    setRenameValue(chat.title || '');
    setIsRenaming(true);
    onToggleMenu(null);
  }

  function commitRename(e) {
    if (e) e.preventDefault();
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== chat.title) {
      onRename(chat.id, trimmed);
    }
    setIsRenaming(false);
  }

  return (
    <li>
      <div
        data-chat-item={chat.id}
        onMouseLeave={() => setConfirmDelete(false)}
        className={`group relative flex items-start gap-2 rounded-xl border px-2 py-2 transition ${
          isActive
            ? 'border-accent bg-accentSoft/80 dark:bg-accent/20'
            : 'border-black/10 bg-[var(--material-thin)] hover:bg-[var(--material-thick)] dark:hover:bg-slate-700/60'
        }`}
      >
        {isPinned && (
          <span className="mt-1 shrink-0 text-accent" title="Pinned" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="currentColor" aria-hidden="true">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
          </span>
        )}
        {isRenaming ? (
          <form onSubmit={commitRename} className="flex-1 min-w-0">
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              aria-label="Chat name"
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setIsRenaming(false); e.stopPropagation(); }
              }}
              className="w-full rounded border border-accent/50 bg-[var(--material-thick)] px-1.5 py-0.5 text-sm outline-none dark:text-[color:var(--text-main)]"
            />
          </form>
        ) : (
          <button onClick={() => onSelect(chat.id)} className="min-w-0 flex-1 text-left">
            <div className="line-clamp-1 text-sm font-medium">{chat.title}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-[color:var(--text-muted)]">
              <span>{formatTime(chat.updatedAt)}</span>
              {chat.parentChatId ? <span className="rounded-full border border-[var(--hairline)] px-1.5 py-0">branch</span> : null}
              {chat.snapshotCount > 0 ? <span className="rounded-full border border-[var(--hairline)] px-1.5 py-0">{chat.snapshotCount} {chat.snapshotCount === 1 ? 'snapshot' : 'snapshots'}</span> : null}
            </div>
          </button>
        )}
        {!isRenaming && (
          <button
            type="button"
            aria-label={confirmDelete ? `Confirm delete ${chat.title}` : `Delete ${chat.title}`}
            title={confirmDelete ? 'Confirm delete' : 'Delete chat'}
            className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition focus:opacity-100 ${
              confirmDelete
                ? 'bg-red-500 text-white opacity-100'
                : 'text-[color:var(--text-muted)] opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-300'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (confirmDelete) onDelete(chat.id);
              else setConfirmDelete(true);
            }}
          >
            {confirmDelete ? (
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18" /><path d="M8 6V4.8c0-.7.6-1.3 1.3-1.3h5.4c.7 0 1.3.6 1.3 1.3V6" /><path d="M6.5 6l1 12.2c.1.8.7 1.3 1.5 1.3h6c.8 0 1.4-.5 1.5-1.3L17.5 6" />
              </svg>
            )}
          </button>
        )}
        {!isRenaming && (
          <button
            type="button"
            aria-label={`More actions for ${chat.title}`}
            title="Chat actions"
            className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[color:var(--text-muted)] opacity-0 transition hover:bg-black/5 hover:text-[color:var(--text-main)] group-hover:opacity-100 focus:opacity-100 dark:text-[color:var(--text-muted)] dark:hover:bg-[var(--material-thin)] dark:hover:text-slate-200"
            onClick={() => onToggleMenu(chat.id)}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="currentColor">
              <circle cx="5" cy="12" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="19" cy="12" r="1.8" />
            </svg>
          </button>
        )}
        {isMenuOpen && (
          <div className="absolute right-2 top-10 z-10 min-w-36 rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] p-1 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
              onClick={startRename}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              <span>Rename</span>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
              onClick={() => { onBranch(chat.id); onToggleMenu(null); }}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3v12" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="18" cy="18" r="3" />
                <path d="M9 6h6" />
                <path d="M9 18h6" />
                <path d="M6 12c0 3.314 2.686 6 6 6" />
              </svg>
              <span>Branch</span>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
              onClick={() => { onTogglePin(chat.id); onToggleMenu(null); }}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
              <span>{isPinned ? 'Unpin' : 'Pin'}</span>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
              onClick={() => { onExport(chat.id); onToggleMenu(null); }}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              <span>Export .md</span>
            </button>
          </div>
        )}
      </div>
    </li>
  );
}, (prev, next) => (
  prev.chat === next.chat &&
  prev.isActive === next.isActive &&
  prev.isMenuOpen === next.isMenuOpen &&
  prev.isPinned === next.isPinned
));

// While streaming only the last message gets a new object, so the comparator
// skips every earlier row instead of re-rendering O(n) per token.
const MessageRow = memo(function MessageRow({
  message,
  isLast,
  busy,
  speakingMessageId,
  isSpeaking,
  voiceEngine,
  voiceSupported,
  stopSpeaking,
  speakText,
  regenerate,
}) {
  const isLastAssistant = message.role === 'assistant' && !message.imageGenerating && isLast;
  return (
    <article
      className={`au-enter text-[length:var(--text-md)] leading-relaxed text-[color:var(--text-main)] ${
        message.role === 'user'
          ? 'ml-auto max-w-[90%] rounded-[var(--r-lg)] rounded-br-[var(--r-xs)] px-4 py-2.5 shadow-[var(--shadow-2)] sm:max-w-[75%] border border-[color:color-mix(in_srgb,var(--accent)_40%,transparent)]'
          : speakingMessageId === message.id
          ? 'w-full rounded-[var(--r-lg)] px-4 py-2.5 au-hairline'
          : 'w-full rounded-[var(--r-lg)] px-4 py-2.5'
      }`}
      style={
        message.role === 'user'
          ? { background: 'color-mix(in srgb, var(--accent) 18%, var(--material-thin))' }
          : speakingMessageId === message.id
          ? { background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }
          : { background: 'color-mix(in srgb, var(--text-main) 4%, transparent)' }
      }
    >
      {/* Lets the module-scope code renderer key its blocks by message. */}
      <MessageIdContext.Provider value={message.id}>
        {renderMessageContent(message.content, message)}
      </MessageIdContext.Provider>
      {Array.isArray(message.attachments) && message.attachments.length > 0 && (
        <div className="mt-2 grid gap-2">
          {message.attachments.map((file) => {
            const isImage = String(file.mimeType || '').startsWith('image/');
            return (
              <div key={file.storedName || file.url} className="rounded-xl border border-[var(--hairline)] bg-[var(--material-thin)] p-2">
                {isImage && file.url ? (
                  <img
                    src={`${API_BASE}${file.url}`}
                    alt={file.name || 'Uploaded image'}
                    className="mb-2 max-h-52 rounded-lg object-contain"
                  />
                ) : null}
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{file.name || 'file'}</div>
                    <div className="text-[10px] opacity-70">{file.mimeType || 'application/octet-stream'} | {formatFileSize(file.size)}</div>
                  </div>
                  {file.url ? (
                    <a
                      href={`${API_BASE}${file.url}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md border border-[var(--hairline)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                    >
                      Open
                    </a>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {message.role === 'user' && message.content && (
        <div className="mt-1.5 flex items-center justify-between border-t border-[var(--hairline)] pt-1">
          <span className="font-mono text-[9px] leading-none uppercase tracking-wide text-[color:var(--text-main)] opacity-70">
            You | {messageTokens(message).toLocaleString()} tok
          </span>
          <CopyMessageButton
            text={message.content || ''}
            className="rounded p-1 text-[color:var(--text-main)] opacity-70 transition hover:bg-[var(--material-thin)] hover:opacity-100"
          />
        </div>
      )}
      {message.role === 'assistant' && !message.imageGenerating && (
        <div className="mt-1.5 flex items-center justify-between border-t border-black/[0.06] pt-1 dark:border-white/[0.07]">
          <span className="font-mono text-[9px] leading-none uppercase tracking-wide text-[color:var(--text-muted)]">
            {!message.imageUrl ? (
              <>
                {(message.effectiveProvider || message.provider) ? (() => {
                  const prov = message.effectiveProvider || message.provider;
                  const onDevice = ['ollama', 'llamacpp', 'koboldcpp', 'openai-compatible'].includes(prov);
                  const provLabel = {
                    openai: 'OpenAI', grok: 'Grok', groq: 'Groq', openrouter: 'OpenRouter',
                    gemini: 'Gemini', cerebras: 'Cerebras', claude: 'Claude', gpuaas: 'GPUaaS',
                    'openai-compatible': 'Custom', koboldcpp: 'KoboldCpp', ollama: 'Ollama',
                    llamacpp: 'llama.cpp', vllm: 'vLLM'
                  }[prov] || prov;
                  const rawModel = message.effectiveModel || message.model || '';
                  const shortModel = rawModel
                    ? (rawModel.length > 22 ? rawModel.slice(0, 22) + '...' : rawModel)
                    : '';
                  // Privacy Receipt: green on-device, or amber naming the cloud provider.
                  // The tooltip names what the pill hides: the local engine or a cut model id.
                  return (
                    <span
                      title={onDevice || rawModel.length > 22 ? `${provLabel} ${rawModel}`.trim() : undefined}
                      className={`mr-1.5 inline-flex items-center gap-1 rounded-[var(--r-pill)] px-1.5 py-[2px] align-middle text-[9px] font-semibold normal-case tracking-normal ${
                        onDevice
                          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                          : 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                      }`}
                    >
                      {onDevice ? 'On-device' : provLabel}
                      {shortModel ? <span className="opacity-70">{` ${shortModel}`}</span> : null}
                    </span>
                  );
                })() : null}
                {(() => {
                  // Exact count from Ollama eval metrics when present, else the char/4 estimate.
                  const p = message.performance;
                  const exactOut = p && p.source === 'ollama' && !p.isEstimate && p.tokens != null;
                  const count = exactOut ? p.tokens : messageTokens(message);
                  return `${Number(count).toLocaleString()} tok`;
                })()}
                {message.performance && message.performance.tokensPerSec != null ? (() => {
                  const perf = message.performance;
                  const exact = perf.source === 'ollama' && !perf.isEstimate;
                  const parts = [];
                  parts.push(`${exact ? '' : '~'}${perf.tokensPerSec} tok/s`);
                  if (perf.ttftMs != null) parts.push(`First token ${perf.ttftMs >= 1000 ? (perf.ttftMs / 1000).toFixed(1) + 's' : perf.ttftMs + 'ms'}`);
                  if (perf.promptTokens != null) parts.push(`${perf.promptTokens.toLocaleString()} prompt tokens`);
                  if (perf.wallMs != null) parts.push(`${(perf.wallMs / 1000).toFixed(1)}s total`);
                  return (
                    <span
                      title={parts.join(' | ')}
                      className="ml-1.5 inline-flex items-center gap-1 rounded-[var(--r-pill)] bg-black/[0.05] px-1.5 py-[2px] align-middle text-[9px] font-semibold normal-case tracking-normal text-[color:var(--text-muted)] dark:bg-white/[0.06]"
                    >
                      {perf.tokensPerSec} tok/s
                      {perf.ttftMs != null ? (
                        <span className="opacity-70">{` ${perf.ttftMs >= 1000 ? (perf.ttftMs / 1000).toFixed(1) + 's' : perf.ttftMs + 'ms'} ttft`}</span>
                      ) : null}
                    </span>
                  );
                })() : null}
              </>
            ) : null}
          </span>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => {
                if (speakingMessageId === message.id && isSpeaking) stopSpeaking();
                else speakText(message.content || '', message.id);
              }}
              disabled={(voiceEngine === 'browser' && !voiceSupported) || !String(message.content || '').trim()}
              title={speakingMessageId === message.id && isSpeaking ? 'Stop reading' : 'Read aloud'}
              className={`rounded p-1 transition disabled:opacity-40 ${
                speakingMessageId === message.id && isSpeaking
                  ? 'text-accent'
                  : 'text-[color:var(--text-muted)] hover:bg-black/5 hover:text-[color:var(--text-main)] dark:hover:bg-[var(--material-thin)] dark:hover:text-slate-200'
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 12h1" />
                <path d="M8 9v6" />
                <path d="M12 7v10" />
                <path d="M16 9v6" />
                <path d="M20 11v2" />
              </svg>
            </button>
            {isLastAssistant && (
              <button
                onClick={regenerate}
                disabled={busy}
                title="Regenerate"
                className="rounded p-1 text-[color:var(--text-muted)] transition hover:bg-black/5 hover:text-[color:var(--text-main)] disabled:opacity-40 dark:text-[color:var(--text-muted)] dark:hover:bg-[var(--material-thin)] dark:hover:text-slate-200"
              >
                <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 4a8 8 0 0 1 12 0" />
                  <path d="M16 16a8 8 0 0 1-12 0" />
                  <polyline points="13 1 16 4 13 7" />
                  <polyline points="7 19 4 16 7 13" />
                </svg>
              </button>
            )}
            <CopyMessageButton text={message.content || ''} />
          </div>
        </div>
      )}
    </article>
  );
}, (prev, next) => (
  prev.message === next.message &&
  prev.isLast === next.isLast &&
  prev.busy === next.busy &&
  prev.speakingMessageId === next.speakingMessageId &&
  prev.isSpeaking === next.isSpeaking &&
  prev.voiceEngine === next.voiceEngine &&
  prev.voiceSupported === next.voiceSupported
));

/* Settings sections. They are views over ChatApp state, so every value and
   handler comes in as a prop. Rows follow SettingsRow: label and one line on
   the left, the control on the right. */

const SETTINGS_FIELD =
  'au-hairline au-focus h-8 min-w-0 rounded-[var(--r-sm)] bg-transparent px-3 text-[length:var(--text-xs)] text-[color:var(--text-main)] placeholder:text-[color:var(--text-muted)] placeholder:opacity-60 disabled:opacity-50';
// Inputs and selects in the control column; narrower on phones.
const CONTROL_WIDTH = 'w-44 sm:w-56';
const SETTINGS_SELECT =
  'au-hairline au-focus h-8 min-w-0 rounded-[var(--r-sm)] bg-[var(--material-thick)] px-2 text-[length:var(--text-xs)] text-[color:var(--text-main)] disabled:opacity-50';
const SETTINGS_NOTE = 'text-[length:var(--text-2xs)] leading-snug text-[color:var(--text-muted)]';

// Same hint as the Dock: the Command key symbol on Apple platforms.
function settingsShortcutLabel() {
  if (typeof navigator === 'undefined') return 'Ctrl+,';
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? '\u2318,' : 'Ctrl+,';
}

function RangeControl({ label, value, min, max, step, onChange }) {
  return (
    <div className="flex w-44 items-center gap-2">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-[var(--accent)]"
      />
      <span className="w-9 shrink-0 text-right font-mono text-[length:var(--text-2xs)] tabular-nums text-[color:var(--text-muted)]">
        {Number(value).toFixed(2)}
      </span>
    </div>
  );
}

function BusyLabel({ busy, busyText, children }) {
  return busy ? <><Spinner size={12} />{busyText}</> : children;
}

function ChatToolsSettings({
  instructionsVisible, instructionsLabel, onInstructionsChange,
  webSearch, webSearchStatus, goDark, onWebSearchChange,
  imageReady, imageDevice, onCreateImage,
  vaultEnabled, vaultStatus, vaultFolder, vaultBusy, vaultMessage,
  onVaultEnabledChange, onVaultFolderChange, onIndexVault, onClearVault
}) {
  const uid = useId();
  const indexed = (vaultStatus?.chunkCount || 0) > 0;
  return (
    <>
      <SettingsGroup title="Answers">
        <SettingsList>
          <SettingsRow label="Show instructions" description={`Profile: ${instructionsLabel}`}>
            <Switch checked={instructionsVisible} onChange={onInstructionsChange} label="Show instructions" />
          </SettingsRow>
          <SettingsRow
            label="Web search"
            detail={goDark ? (
              <span className="text-[length:var(--text-2xs)] text-amber-700 dark:text-amber-300">Blocked by Go Dark</span>
            ) : webSearchStatus === 'error' ? (
              <span className="text-[length:var(--text-2xs)] text-rose-600 dark:text-rose-300">Last search failed</span>
            ) : null}
          >
            <Switch checked={webSearch} onChange={onWebSearchChange} label="Web search" />
          </SettingsRow>
          <SettingsRow
            label="Create image"
            detail={
              <Badge tone={imageReady ? 'success' : 'neutral'}>
                {imageReady ? `Ready${imageDevice ? ` on ${imageDevice}` : ''}` : 'Offline'}
              </Badge>
            }
          >
            <Button size="sm" variant="soft" onClick={onCreateImage}>New prompt</Button>
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>

      <SettingsGroup title="Config Vault">
        <SettingsList>
          <SettingsRow
            label="Use Config Vault"
            description={indexed
              ? `${vaultStatus.fileCount} files, ${vaultStatus.chunkCount} chunks${vaultStatus.embedModel ? `, ${vaultStatus.embedModel}` : ''}`
              : 'Not indexed'}
          >
            <Switch checked={vaultEnabled} onChange={onVaultEnabledChange} label="Use Config Vault" />
          </SettingsRow>
          <SettingsRow
            label="Folder"
            htmlFor={`${uid}-vault`}
            detail={
              <>
                <form
                  className="mt-2 flex items-center gap-2"
                  onSubmit={(e) => { e.preventDefault(); if (!vaultBusy) onIndexVault(); }}
                >
                  <input
                    id={`${uid}-vault`}
                    type="text"
                    value={vaultFolder}
                    onChange={(e) => onVaultFolderChange(e.target.value)}
                    placeholder="~/configs"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className={`${SETTINGS_FIELD} w-full font-mono`}
                  />
                  {/* r-sm to match the field beside them; it sorts after the size's r-md. */}
                  <Button type="submit" variant="soft" className="rounded-[var(--r-sm)]" disabled={vaultBusy || !String(vaultFolder || '').trim()}>
                    <BusyLabel busy={vaultBusy} busyText="Working">Index</BusyLabel>
                  </Button>
                  {indexed ? (
                    <Button variant="ghost" className="rounded-[var(--r-sm)]" onClick={onClearVault} disabled={vaultBusy}>Clear</Button>
                  ) : null}
                </form>
                {vaultMessage ? <p role="status" className={`mt-2 ${SETTINGS_NOTE}`}>{vaultMessage}</p> : null}
              </>
            }
          />
        </SettingsList>
      </SettingsGroup>
    </>
  );
}

function VoiceSettings({
  voiceTools, settingUpStt, onSetupStt,
  autoSpeak, onAutoSpeakChange,
  voiceSupported, speaking, onPreview,
  engine, onEngineChange,
  voices, voiceUri, onVoiceUriChange,
  rate, onRateChange, pitch, onPitchChange,
  piperModels, piperModelId, onPiperModelChange,
  settingUpPiper, onSetupPiper, downloadingPiperId, onDownloadPiper
}) {
  const uid = useId();
  const stt = voiceTools?.stt;
  const piperReady = Boolean(voiceTools?.voices?.localPiper);
  const catalog = Array.isArray(piperModels) ? piperModels : [];
  const installed = catalog.filter((m) => m.installed);
  const sttText = stt?.ready
    ? (stt.whisperCpp ? 'whisper.cpp' : stt.openai ? 'OpenAI transcription' : 'Whisper CLI')
    : 'whisper.cpp, about 150 MB';
  return (
    <>
      <SettingsGroup title="Dictation">
        <SettingsList>
          <SettingsRow label="Speech to text" description={sttText}>
            {stt?.ready ? (
              <Badge tone="success">Ready</Badge>
            ) : (
              <Button size="sm" variant="primary" onClick={onSetupStt} disabled={settingUpStt}>
                <BusyLabel busy={settingUpStt} busyText="Installing">Install</BusyLabel>
              </Button>
            )}
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>

      <SettingsGroup title="Spoken replies">
        <SettingsList>
          <SettingsRow label="Read replies aloud">
            <Switch checked={autoSpeak} onChange={onAutoSpeakChange} label="Read replies aloud" />
          </SettingsRow>
          <SettingsRow label="Voice engine">
            <SegmentedControl
              size="sm"
              value={engine}
              onChange={onEngineChange}
              options={[{ value: 'browser', label: 'Browser' }, { value: 'piper', label: 'Piper neural' }]}
            />
          </SettingsRow>
          {engine === 'browser' ? (
            <>
              <SettingsRow
                label="Voice"
                htmlFor={`${uid}-voice`}
                description={voiceTools?.platform === 'darwin'
                  ? 'More voices: System Settings > Accessibility > Spoken Content'
                  : undefined}
              >
                <select
                  id={`${uid}-voice`}
                  value={voiceUri}
                  onChange={(e) => onVoiceUriChange(e.target.value)}
                  className={`${SETTINGS_SELECT} ${CONTROL_WIDTH}`}
                >
                  {(voices || []).map((voice) => (
                    <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>
                  ))}
                </select>
              </SettingsRow>
              <SettingsRow label="Speed">
                <RangeControl label="Speaking speed" value={rate} min={0.8} max={1.5} step={0.05} onChange={onRateChange} />
              </SettingsRow>
              <SettingsRow label="Pitch">
                <RangeControl label="Voice pitch" value={pitch} min={0.8} max={1.4} step={0.05} onChange={onPitchChange} />
              </SettingsRow>
            </>
          ) : !piperReady ? (
            <SettingsRow label="Piper">
              <Button size="sm" variant="primary" onClick={onSetupPiper} disabled={settingUpPiper}>
                <BusyLabel busy={settingUpPiper} busyText="Installing">Install</BusyLabel>
              </Button>
            </SettingsRow>
          ) : (
            <>
              {installed.length > 0 ? (
                <SettingsRow label="Voice" htmlFor={`${uid}-piper`}>
                  <select
                    id={`${uid}-piper`}
                    value={piperModelId}
                    onChange={(e) => onPiperModelChange(e.target.value)}
                    className={`${SETTINGS_SELECT} ${CONTROL_WIDTH}`}
                  >
                    {installed.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </SettingsRow>
              ) : null}
              <SettingsRow label="Speed">
                <RangeControl label="Speaking speed" value={rate} min={0.8} max={1.5} step={0.05} onChange={onRateChange} />
              </SettingsRow>
            </>
          )}
          <SettingsRow
            label="Preview"
            description={voiceSupported || engine === 'piper' ? undefined : 'Unavailable in this browser'}
          >
            <Button size="sm" variant="soft" onClick={onPreview} disabled={!voiceSupported && engine === 'browser'}>
              {speaking ? 'Stop' : 'Play'}
            </Button>
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>

      {engine === 'piper' && piperReady && catalog.length > 0 ? (
        <SettingsGroup title="Piper voices">
          <SettingsList>
            {catalog.map((m) => (
              <SettingsRow key={m.id} label={m.label}>
                {m.installed ? (
                  <Badge tone="success">Installed</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => onDownloadPiper(m.id)}
                    disabled={downloadingPiperId !== null}
                  >
                    <BusyLabel busy={downloadingPiperId === m.id} busyText="Downloading">
                      {`Download${m.sizeMb ? ` ${m.sizeMb} MB` : ''}`}
                    </BusyLabel>
                  </Button>
                )}
              </SettingsRow>
            ))}
          </SettingsList>
        </SettingsGroup>
      ) : null}
    </>
  );
}

function RemoteSettings({
  connected, target, error,
  type, onTypeChange, host, onHostChange, user, onUserChange, port, onPortChange,
  authType, onAuthTypeChange, keyPath, onKeyPathChange, password, onPasswordChange,
  connecting, onConnect, onDisconnect
}) {
  const uid = useId();
  if (connected) {
    return (
      <SettingsGroup title="Connection">
        <SettingsList>
          <SettingsRow
            label="Connected"
            detail={<span className="block truncate font-mono text-[length:var(--text-2xs)] text-[color:var(--text-muted)]" title={target}>{target}</span>}
          >
            <Button size="sm" variant="danger" onClick={onDisconnect}>Disconnect</Button>
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>
    );
  }
  const ssh = type === 'ssh';
  const ready = !connecting && (!ssh || (host.trim() && user.trim()));
  return (
    <SettingsGroup title="Connection">
      {error ? (
        <SettingsNotice tone="danger" icon={<AlertIcon size={13} />} className="mb-3">
          Could not connect. {error}
        </SettingsNotice>
      ) : null}
      <SettingsList>
        <SettingsRow label="Target">
          <SegmentedControl
            size="sm"
            value={type}
            onChange={onTypeChange}
            options={[{ value: 'local', label: 'Localhost' }, { value: 'ssh', label: 'SSH' }]}
          />
        </SettingsRow>
        {ssh ? (
          <>
            <SettingsRow label="Host" htmlFor={`${uid}-host`}>
              <input id={`${uid}-host`} type="text" value={host} onChange={(e) => onHostChange(e.target.value)} placeholder="192.168.1.10" spellCheck={false} autoCapitalize="off" className={`${SETTINGS_FIELD} ${CONTROL_WIDTH}`} />
            </SettingsRow>
            <SettingsRow label="User" htmlFor={`${uid}-user`}>
              <input id={`${uid}-user`} type="text" value={user} onChange={(e) => onUserChange(e.target.value)} placeholder="admin" spellCheck={false} autoCapitalize="off" className={`${SETTINGS_FIELD} ${CONTROL_WIDTH}`} />
            </SettingsRow>
            <SettingsRow label="Port" htmlFor={`${uid}-port`}>
              <input id={`${uid}-port`} type="text" inputMode="numeric" value={port} onChange={(e) => onPortChange(e.target.value)} placeholder="22" className={`${SETTINGS_FIELD} w-20`} />
            </SettingsRow>
            <SettingsRow label="Sign in with">
              <SegmentedControl
                size="sm"
                value={authType}
                onChange={onAuthTypeChange}
                options={[{ value: 'agent', label: 'SSH agent' }, { value: 'key', label: 'Key' }, { value: 'password', label: 'Password' }]}
              />
            </SettingsRow>
            {authType === 'key' ? (
              <SettingsRow label="Key file" htmlFor={`${uid}-key`}>
                <input id={`${uid}-key`} type="text" value={keyPath} onChange={(e) => onKeyPathChange(e.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} autoCapitalize="off" className={`${SETTINGS_FIELD} ${CONTROL_WIDTH} font-mono`} />
              </SettingsRow>
            ) : null}
            {authType === 'password' ? (
              <SettingsRow label="Password" htmlFor={`${uid}-password`}>
                <input id={`${uid}-password`} type="password" value={password} onChange={(e) => onPasswordChange(e.target.value)} autoComplete="new-password" className={`${SETTINGS_FIELD} ${CONTROL_WIDTH}`} />
              </SettingsRow>
            ) : null}
          </>
        ) : null}
      </SettingsList>
      <div className="mt-3 flex justify-end">
        <Button variant="primary" onClick={onConnect} disabled={!ready}>
          <BusyLabel busy={connecting} busyText="Connecting">Connect</BusyLabel>
        </Button>
      </div>
    </SettingsGroup>
  );
}

const TRAINING_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'fine-tuning', label: 'Quick' },
  { value: 'full-training', label: 'Deep' }
];

// Off needs no line; Deep only plans, so it says so.
const TRAINING_HINT = {
  'fine-tuning': 'Saves chats as learning examples',
  'full-training': 'Plan only: export and train a LoRA offline'
};

function LabsSettings({
  canvas, onCanvasChange, guided, onGuidedChange, deepThinking, onDeepThinkingChange,
  openClaw, onOpenClawChange,
  trainingMode, onTrainingModeChange, examples, onExportExamples,
  personalMemory, onPersonalMemoryChange, memoryItems, onManageMemory
}) {
  return (
    <>
      <SettingsGroup title="Answer modes">
        <SettingsList>
          <SettingsRow label="Canvas">
            <Switch checked={canvas} onChange={onCanvasChange} label="Canvas" />
          </SettingsRow>
          <SettingsRow label="Guided Learning">
            <Switch checked={guided} onChange={onGuidedChange} label="Guided Learning" />
          </SettingsRow>
          <SettingsRow label="Deep Thinking">
            <Switch checked={deepThinking} onChange={onDeepThinkingChange} label="Deep Thinking" />
          </SettingsRow>
          <SettingsRow label="OpenClaw" description="Uncensored, no memory or instructions">
            <Switch checked={openClaw} onChange={onOpenClawChange} label="OpenClaw" />
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>

      <SettingsGroup title="Training">
        <SettingsList>
          <SettingsRow label="Learning mode" description={TRAINING_HINT[trainingMode]}>
            <SegmentedControl size="sm" value={trainingMode} onChange={onTrainingModeChange} options={TRAINING_OPTIONS} />
          </SettingsRow>
          <SettingsRow label="Learning examples" description={`${examples} captured`}>
            <Button size="sm" variant="soft" onClick={onExportExamples}>Export</Button>
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>

      <SettingsGroup title="Personal memory">
        <SettingsList>
          <SettingsRow label="Use personal memory" description={`${memoryItems} saved`}>
            <Button size="sm" variant="ghost" onClick={onManageMemory}>Manage</Button>
            <Switch checked={personalMemory} onChange={onPersonalMemoryChange} label="Use personal memory" />
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>
    </>
  );
}

export default function ChatApp() {
  const fileInputRef = useRef(null);
  const dictationRecorderRef = useRef(null);
  const dictationStreamRef = useRef(null);
  const dictationChunksRef = useRef([]);
  const dictationPhaseRef = useRef('idle');
  const dictationBaseRef = useRef('');
  const dictationRecognitionRef = useRef(null);
  const dragCounterRef = useRef(0);
  const messagesScrollRef = useRef(null);
  const lastScrollTopRef = useRef(0);
  const isProgrammaticScrollRef = useRef(false); // true while we're scrolling programmatically
  const speechSynthesisRef = useRef(null);
  const piperAudioRef = useRef(null);
  const chatScrollPositions = useRef({});
  // Bumped by clearAllChats so a refreshChats() in flight across a clear cannot restore deleted chats.
  const chatListEpochRef = useRef(0);
  // Refs for renderMessageContent (stable across renders without re-passing as props)
  const lastKeyboardMenuTriggerRef = useRef(null);
  const streamAbortRef = useRef(null);
  const shortcutRef = useRef({});
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [activeChatMeta, setActiveChatMeta] = useState(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCommittingToLedger, setIsCommittingToLedger] = useState(false);
  // Commitment Radar: read-only preview of commitments/asks/decisions in the
  // current chat. Nothing is persisted until the user files them.
  const [radarOpen, setRadarOpen] = useState(false);
  const [radarLoading, setRadarLoading] = useState(false);
  const [radarError, setRadarError] = useState('');
  const [radarScanned, setRadarScanned] = useState(false);
  const [radarSignals, setRadarSignals] = useState([]);
  // "Your Past Self Disagrees": conflicts between this chat and the user's own
  // past decisions, surfaced inside the same Commitment Radar modal.
  const [radarConflicts, setRadarConflicts] = useState([]);
  const [radarConflictsLoading, setRadarConflictsLoading] = useState(false);
  const [themeMode, setThemeMode] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('local-ai-theme-mode', 'auto');
    return 'auto';
  });
  const [uiFont, setUiFont] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('mirabilis-font', 'jakarta');
    return 'jakarta';
  });
  const [colorScheme, setColorScheme] = useState(() => {
    if (typeof window !== 'undefined') {
      const v = safeStorageGet('mirabilis-color-scheme', 'mirabilis');
      // Keep in sync with lib/theme.js SCHEMES; anything missing resets on reload.
      return ['mirabilis','arctic','ember','summit'].includes(v) ? v : 'mirabilis';
    }
    return 'mirabilis';
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [models, setModels] = useState([]);
  // Ollama's catalog and installed rows for Settings > Models, whatever provider chats use.
  const [ollamaModels, setOllamaModels] = useState([]);
  const ollamaModelsRef = useRef([]);
  // Total device memory (GB) for the pre-pull model-fit pill. Fetched once.
  const [deviceRamGb, setDeviceRamGb] = useState(null);
  // Apple silicon runs Ollama's MLX builds; Settings > Models marks them.
  const [appleSilicon, setAppleSilicon] = useState(false);
  const [provider, setProvider] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('mirabilis-provider', 'ollama');
    return 'ollama';
  });
  const [providerConfigs, setProviderConfigs] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = safeStorageGet('mirabilis-provider-configs');
      if (stored) try { return JSON.parse(stored); } catch {}
    }
    return {
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '' },
      grok: { baseUrl: 'https://api.x.ai/v1', apiKey: '' },
      groq: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: '' },
      openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' },
      gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '' },
      cerebras: { baseUrl: 'https://api.cerebras.ai/v1', apiKey: '' },
      claude: { baseUrl: 'https://api.anthropic.com', apiKey: '' },
      gpuaas: { baseUrl: '', apiKey: '' },
      'openai-compatible': { baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '' },
      'koboldcpp': { baseUrl: 'http://127.0.0.1:5001/v1', apiKey: '' },
      // Empty so selecting vLLM opens the endpoint config for a server URL.
      'vllm': { baseUrl: '', apiKey: '' },
      // Managed llama.cpp server; Mirabilis launches it on this port.
      'llamacpp': { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: '' }
    };
  });
  const [isProviderConfigOpen, setIsProviderConfigOpen] = useState(false);
  const [localBinaryStatus, setLocalBinaryStatus] = useState({ 'llama-server': null, koboldcpp: null });
  const [installingBinary, setInstallingBinary] = useState(null); // { provider, lines[], done, error }
  const [customPromptProfiles, setCustomPromptProfiles] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        return sanitizeCustomPromptProfiles(JSON.parse(safeStorageGet('mirabilis-custom-prompt-profiles', '[]') || '[]'));
      } catch {}
    }
    return [];
  });
  const [selectedPromptProfileId, setSelectedPromptProfileId] = useState(() => {
    if (typeof window !== 'undefined') {
      return safeStorageGet('mirabilis-prompt-profile-id', 'mirabilis-default');
    }
    return 'mirabilis-default';
  });
  const [model, setModel] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('local-ai-model', 'auto');
    return 'auto';
  });
  const [systemPrompt, setSystemPrompt] = useState(buildDefaultSystemPrompt(provider));
  const [statusText, setStatusText] = useState('Ready');
  // Engine reachability; null until the first check answers.
  const [engineUp, setEngineUp] = useState(null);
  const [openChatMenuId, setOpenChatMenuId] = useState(null);
  const [clearArmed, setClearArmed] = useState(false); // two-click confirm for "clear all"
  const [imageServiceAvailable, setImageServiceAvailable] = useState(false);
  const [imageServiceDevice, setImageServiceDevice] = useState(null);
  const [hardwareProfile, setHardwareProfile] = useState({
    compute: null,
    npu: null,
    logic: null,
    memory: null,
    action: { label: 'Engine', options: [] }
  });
  const [utilization, setUtilization] = useState({ cpuPct: 0, memPct: 0 });
  const [openHardwarePopover, setOpenHardwarePopover] = useState(null);
  const [isSystemPromptVisible, setIsSystemPromptVisible] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('mirabilis-sidebar-open', 'true') !== 'false';
    return true;
  });
  const [selectedEngine, setSelectedEngine] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('mirabilis-engine-option', '');
    return '';
  });
  const [isContextPanelOpen, setIsContextPanelOpen] = useState(false);
  const [isProviderMenuOpen, setIsProviderMenuOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState('');
  const [vllmStatus, setVllmStatus] = useState(null);   // { canRunLocal, running, reason, ... }
  const [vllmLocalModel, setVllmLocalModel] = useState('Qwen/Qwen2.5-7B-Instruct');
  const [isVllmBusy, setIsVllmBusy] = useState(false);
  const [llamacppStatus, setLlamacppStatus] = useState(null); // { installed, running, model, baseUrl }
  const [llamacppModel, setLlamacppModel] = useState('');     // model to launch (Ollama name or .gguf path)
  const [llamacppLaunchable, setLlamacppLaunchable] = useState([]); // models you can run
  const [isLlamacppBusy, setIsLlamacppBusy] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isEffortMenuOpen, setIsEffortMenuOpen] = useState(false);
  const [isAccessMenuOpen, setIsAccessMenuOpen] = useState(false);
  // Where the Access menu sits so it stays inside the window: a left shift and a height cap.
  const [accessMenuPlace, setAccessMenuPlace] = useState({ left: 0, maxHeight: undefined });
  // Level id while a composer change is being saved.
  const [accessSaving, setAccessSaving] = useState('');
  // Backend-owned Access level, mirrored in the store for the chip and the send route.
  const accessLevel = useAppStore((s) => s.access);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const settingsSection = useAppStore((s) => s.settingsSection);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const goDarkOn = useAppStore((s) => s.goDark);
  // Read by SSE handlers, which outlive the render that created them.
  const settingsOpenRef = useRef(false);
  settingsOpenRef.current = settingsOpen;
  // Agent run state. Null when no run is in flight or finished.
  const [agentRun, setAgentRun] = useState(null);
  const agentAbortRef = useRef(null);
  const agentRunRef = useRef(null);
  // Approval id whose decision is being posted.
  const [approvalBusyId, setApprovalBusyId] = useState('');

  // Masked hints for keys the backend holds; the page never sees a value.
  const [keyHints, setKeyHints] = useState({});
  // What the user is currently typing, before it is saved. Never persisted.
  const [keyDraft, setKeyDraft] = useState('');
  const [canvasEnabled, setCanvasEnabled] = useState(false);
  const [canvasText, setCanvasText] = useState('');
  const [guidedLearningEnabled, setGuidedLearningEnabled] = useState(false);
  const [deepThinkingEnabled, setDeepThinkingEnabled] = useState(false);
  const [effortLevel, setEffortLevel] = useState(() => safeStorageGet('mirabilis-effort-level', 'balanced'));
  const [trainingMode, setTrainingMode] = useState('off');
  const [usePersonalMemory, setUsePersonalMemory] = useState(true);
  const [openClawMode, setOpenClawMode] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('mirabilis-openclaw', 'false') === 'true';
    return false;
  });

  const [trainingStats, setTrainingStats] = useState({ memoryItems: 0, fineTuningExamples: 0 });
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [dictationSupported, setDictationSupported] = useState(false);
  const [isDictating, setIsDictating] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState(null);
  const [availableVoices, setAvailableVoices] = useState([]);
  const [selectedVoiceUri, setSelectedVoiceUri] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('mirabilis-voice-uri', '');
    return '';
  });
  const [autoSpeakEnabled, setAutoSpeakEnabled] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('mirabilis-auto-speak', 'false') === 'true';
    return false;
  });
  const [voiceRate, setVoiceRate] = useState(() => {
    if (typeof window !== 'undefined') return Number(safeStorageGet('mirabilis-voice-rate', '1') || '1');
    return 1;
  });
  const [voicePitch, setVoicePitch] = useState(() => {
    if (typeof window !== 'undefined') return Number(safeStorageGet('mirabilis-voice-pitch', '1') || '1');
    return 1;
  });
  const [voiceTools, setVoiceTools] = useState(null);
  const [isSettingUpVoiceTools, setIsSettingUpVoiceTools] = useState(false);
  const [isSettingUpStt, setIsSettingUpStt] = useState(false);
  const [voiceEngine, setVoiceEngine] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('mirabilis-voice-engine', 'browser');
    return 'browser';
  });
  const [selectedPiperModelId, setSelectedPiperModelId] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('mirabilis-piper-model', '');
    return '';
  });
  const [piperModels, setPiperModels] = useState([]);
  const [downloadingPiperModelId, setDownloadingPiperModelId] = useState(null);

  // Voice chat. The overlay is only a view; the listen, send, speak loop runs
  // here because capture, the streaming send and TTS live in this component.
  const voiceChatOpen = useAppStore((s) => s.voiceChatOpen);
  // Read after awaits, where the render's value may be stale.
  const voiceChatOpenRef = useRef(false);
  voiceChatOpenRef.current = voiceChatOpen;
  // Stable: Modal moves focus to its first button whenever onClose changes,
  // which would pull focus out of an approval card on every render.
  const closeVoiceChat = useCallback(() => appStore.closeVoiceChat(), []);
  const [voicePhase, setVoicePhase] = useState('idle'); // idle | listening | thinking | speaking
  const [voiceInterim, setVoiceInterim] = useState('');
  const [voiceReply, setVoiceReply] = useState('');
  const [voiceLoopSupported, setVoiceLoopSupported] = useState(false);
  const [voiceNote, setVoiceNote] = useState('');
  const [voiceGender, setVoiceGender] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = safeStorageGet('mirabilis-voice-gender', 'female');
      return saved === 'male' ? 'male' : 'female';
    }
    return 'female';
  });
  const voiceRecognitionRef = useRef(null);
  const voiceActiveRef = useRef(false);        // overlay open + loop should run
  const voicePhaseRef = useRef('idle');        // synchronous mirror of voicePhase
  const voiceFinalRef = useRef('');            // final transcript accumulated this turn
  const voiceAwaitingReplyRef = useRef(false); // sent, waiting for the stream to finish
  const voiceSawStreamingRef = useRef(false);  // saw isStreaming flip true after send
  const voiceSawSpeakingRef = useRef(false);   // saw isSpeaking flip true after speak
  const voiceRestartTimerRef = useRef(null);   // debounce re-listen after empty turn
  const voiceSpeakWatchdogRef = useRef(null);  // fallback if TTS never starts
  // MediaRecorder capture transcribed by backend whisper.cpp; webkitSpeechRecognition
  // does not work in Electron.
  const voiceStreamRef = useRef(null);         // active getUserMedia MediaStream
  const voiceRecorderRef = useRef(null);       // active MediaRecorder
  const voiceChunksRef = useRef([]);           // recorded audio chunks this turn
  const voiceAudioCtxRef = useRef(null);       // AudioContext for silence detection
  const voiceVadRafRef = useRef(null);         // rAF handle for the VAD meter
  const voiceVadTimersRef = useRef({});        // { maxDuration, noSpeech } timers
  const voiceSttReadyRef = useRef(true);       // backend speech-to-text is usable
  const voiceHeardSpeechRef = useRef(false);   // did the VAD detect speech this turn
  const voiceStopCaptureRef = useRef(null);    // finalize() handle for an orb tap
  // Always-fresh handles so the loop never calls a stale send/speak closure.
  const voiceSendRef = useRef(null);
  const voiceSpeakRef = useRef(null);
  const voiceStopSpeakRef = useRef(null);
  const messagesRef = useRef([]);
  // Mirrors activeChatId for handlers held by memoized ChatItem rows, whose
  // comparator ignores callbacks and so can keep a stale closure.
  const activeChatIdRef = useRef(null);
  // Always-fresh voice settings so a retained speakText closure uses current values.
  const voiceSettingsRef = useRef({});

  const [isDragOverChat, setIsDragOverChat] = useState(false);
  const [deepWebEnabled, setDeepWebEnabled] = useState(() => {
    if (typeof window !== 'undefined') {
      // Off by default; the v2 flag resets a stored default-on value once.
      if (safeStorageGet('mirabilis-web-default-v2') !== '1') {
        safeStorageSet('mirabilis-web-default-v2', '1');
        safeStorageSet('local-ai-deep-web-enabled', 'false');
        return false;
      }
      return safeStorageGet('local-ai-deep-web-enabled') === 'true';
    }
    return true;
  });
  const [webSearchStatus, setWebSearchStatus] = useState('idle'); // 'idle' | 'searching' | 'error'
  // Config Vault: offline cited RAG over a config folder, added to each send.
  const [configVaultEnabled, setConfigVaultEnabled] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('mirabilis-config-vault-enabled') === 'true';
    return false;
  });
  const [configVaultStatus, setConfigVaultStatus] = useState(null); // { root, builtAt, embedModel, fileCount, chunkCount }
  const [configVaultFolder, setConfigVaultFolder] = useState(() => (typeof window !== 'undefined' ? safeStorageGet('mirabilis-config-vault-folder', '') || '' : ''));
  const [configVaultBusy, setConfigVaultBusy] = useState(false);
  const [configVaultMsg, setConfigVaultMsg] = useState('');
  // Row id (lib/models.js rowIdForName) -> the running install or update:
  // { name, jobId, status, pct, completedBytes, totalBytes, bytesPerSec, etaSec }.
  // The picker and Settings > Models both read it.
  const [pullingModels, setPullingModels] = useState({});
  // Row id -> { name, error } for the last failed install, until it is retried.
  const [installErrors, setInstallErrors] = useState({});
  // Row id -> { ctrl, jobId, update } of the poll loop watching that job.
  const jobWatchersRef = useRef(new Map());
  // Bumped when the installed set changes, so Settings > Models reloads.
  const [modelsRevision, setModelsRevision] = useState(0);
  // Settings > Models view; kept here because the pane remounts per section.
  const [modelsView, setModelsView] = useState('installed');
  const [isTeachPanelOpen, setIsTeachPanelOpen] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const autoScrollRef = useRef(true); // ref mirror - readable synchronously in scroll handler
  const [memoryItems, setMemoryItems] = useState([]);
  const [memoryInput, setMemoryInput] = useState('');
  // The backend keeps the watched root in memory and restarts each launch;
  // re-send the persisted root so pinned paths resolve again.
  useEffect(() => {
    const root = appStore.getWorkspaceRoot ? appStore.getWorkspaceRoot() : '';
    if (!root) return;
    let cancelled = false;
    (async () => {
      try {
        await api('/api/workspace/watch', { method: 'POST', body: JSON.stringify({ path: root }) });
      } catch {
        // The folder may be gone; the send path reports skipped pins.
        if (!cancelled) { /* nothing to do */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pinned relative paths whose current contents go into each send.
  const workspacePins = useAppStore((s) => s.workspacePins);

  // Remote Control
  const [remoteConnected, setRemoteConnected] = useState(false);
  const [remoteTarget, setRemoteTarget] = useState('');
  const [remoteType, setRemoteType] = useState('local');   // 'local' | 'ssh'
  const [remoteHost, setRemoteHost] = useState('');
  const [remotePort, setRemotePort] = useState('22');
  const [remoteUser, setRemoteUser] = useState('');
  const [remoteAuthType, setRemoteAuthType] = useState('key'); // 'key' | 'password' | 'agent'
  const [remotePassword, setRemotePassword] = useState('');
  const [remoteKeyPath, setRemoteKeyPath] = useState('');
  const [remoteConnecting, setRemoteConnecting] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  const [execResults, setExecResults] = useState({}); // codeBlockKey -> { stdout, stderr, exitCode, running }
  const [uncensoredMode, setUncensoredMode] = useState(false);
  const [chatSearch, setChatSearch] = useState('');
  const [pinnedChatIds, setPinnedChatIds] = useState(() => {
    if (typeof window !== 'undefined') {
      try { return new Set(JSON.parse(safeStorageGet('mirabilis-pinned-chats', '[]') || '[]')); } catch { return new Set(); }
    }
    return new Set();
  });
  const [temperature, setTemperature] = useState(() => {
    if (typeof window !== 'undefined') {
      const v = safeStorageGet('mirabilis-temperature');
      return v === null ? null : Number(v);
    }
    return null;
  });
  const [maxTokens, setMaxTokens] = useState(() => {
    if (typeof window !== 'undefined') {
      const v = safeStorageGet('mirabilis-max-tokens');
      return v === null ? null : Number(v);
    }
    return null;
  });
  // Inference Cockpit: Ollama sampling/load knobs (null = provider default). Ollama only.
  const [ollamaParams, setOllamaParams] = useState(() => {
    if (typeof window !== 'undefined') {
      try { const v = safeStorageGet('mirabilis-ollama-params'); return v ? JSON.parse(v) : {}; } catch { return {}; }
    }
    return {};
  });
  // Pin the local model resident (Ollama keep_alive: -1) instead of the 5-min unload.
  const [pinModel, setPinModel] = useState(() => (typeof window !== 'undefined' ? safeStorageGet('mirabilis-pin-model') === 'true' : false));
  // Auto-tune result reported by the backend on each send (resolved num_ctx + a why line).
  const [resolvedTuning, setResolvedTuning] = useState(null);
  const [remoteBudgetUsd, setRemoteBudgetUsd] = useState(() => {
    if (typeof window !== 'undefined') {
      const v = Number(safeStorageGet('mirabilis-remote-budget-usd', '20') || '20');
      return Number.isFinite(v) && v > 0 ? v : 20;
    }
    return 20;
  });
  const promptAutosaveTimerRef = useRef(null);
  // Hidden on the Ledger tab; approvals raised then also get a toast.
  const mainRef = useRef(null);
  const composerInputRef = useRef(null);

  const promptProfiles = useMemo(
    () => buildPromptProfiles(provider, customPromptProfiles),
    [provider, customPromptProfiles]
  );

  const promptProfileOptions = useMemo(() => {
    const hasSelected = promptProfiles.some((profile) => profile.id === selectedPromptProfileId);
    if (hasSelected && selectedPromptProfileId !== UNSAVED_PROMPT_PROFILE_ID) return promptProfiles;
    return [...promptProfiles, { id: UNSAVED_PROMPT_PROFILE_ID, label: 'Custom', content: systemPrompt, isBuiltin: false }];
  }, [promptProfiles, selectedPromptProfileId, systemPrompt]);

  const selectedPromptProfile = useMemo(
    () => findPromptProfile(promptProfiles, selectedPromptProfileId),
    [promptProfiles, selectedPromptProfileId]
  );

  const selectedModelRecord = useMemo(() => models.find((item) => item.id === model) || null, [model, models]);
  // What the picker's Auto row names: the catalog pick for Ollama, the send-time pick elsewhere.
  const autoModelRecord = useMemo(() => {
    if (provider === 'ollama') return pickAutoModel(models);
    const id = cloudAutoModel(models);
    return models.find((item) => item.id === id) || null;
  }, [provider, models]);
  const shouldShowModelChip = useMemo(
    () => provider === 'ollama' || provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas' || provider === 'openai-compatible' || provider === 'vllm' || provider === 'koboldcpp' || provider === 'llamacpp' || models.length > 0,
    [provider, models.length]
  );

  useEffect(() => {
    const savedThemeMode = safeStorageGet('local-ai-theme-mode');
    const savedModel = safeStorageGet('local-ai-model');
    const savedPrompt = safeStorageGet('local-ai-system-prompt');
    const savedPromptProfileId = safeStorageGet('mirabilis-prompt-profile-id', 'mirabilis-default');
    const savedDeepWeb = safeStorageGet('local-ai-deep-web-enabled');
    const savedCanvasEnabled = safeStorageGet('local-ai-canvas-enabled');
    const savedCanvasText = safeStorageGet('local-ai-canvas-text');
    const savedGuided = safeStorageGet('local-ai-guided-learning-enabled');
    const savedDeepThinking = safeStorageGet('local-ai-deep-thinking-enabled');
    const savedTrainingMode = safeStorageGet('local-ai-training-mode');
    const savedPersonalMemory = safeStorageGet('local-ai-use-personal-memory');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    setSystemPrefersDark(prefersDark);
    if (savedThemeMode === 'light' || savedThemeMode === 'dark' || savedThemeMode === 'auto') {
      setThemeMode(savedThemeMode);
    }
    if (savedModel) {
      setModel(savedModel);
    }
    setSelectedPromptProfileId(savedPromptProfileId);
    // deepWebEnabled already restored via lazy useState initialiser above
    if (savedCanvasEnabled === 'true') {
      setCanvasEnabled(true);
    }
    if (savedCanvasText) {
      setCanvasText(savedCanvasText);
    }
    if (savedGuided === 'true') {
      setGuidedLearningEnabled(true);
    }
    if (savedDeepThinking === 'true') {
      setDeepThinkingEnabled(true);
    }
    if (savedTrainingMode === 'off' || savedTrainingMode === 'fine-tuning' || savedTrainingMode === 'full-training') {
      setTrainingMode(savedTrainingMode);
    }
    if (savedPersonalMemory === 'false') {
      setUsePersonalMemory(false);
    }
    if (isMirabilisDefaultPrompt(savedPrompt) || savedPromptProfileId === 'mirabilis-default') {
      setSystemPrompt(buildDefaultSystemPrompt(provider));
    } else if (savedPrompt) {
      setSystemPrompt(savedPrompt);
    }
  }, []);

  useEffect(() => {
    api('/api/providers/local-status').then((data) => {
      if (data) setLocalBinaryStatus({ 'llama-server': data.llamaServer, koboldcpp: data.koboldcpp });
    }).catch(() => {});
  }, []);

  function installLocalProvider(binaryId) {
    if (installingBinary?.provider === binaryId && !installingBinary?.done) return;
    setInstallingBinary({ provider: binaryId, lines: [], done: false, error: false });
    const es = new EventSource(`${API_BASE}/api/providers/install-stream?provider=${encodeURIComponent(binaryId)}`);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        setInstallingBinary((prev) => {
          if (!prev || prev.provider !== binaryId) return prev;
          const isDone = msg.type === 'done' || msg.type === 'error';
          return { ...prev, lines: [...prev.lines, { type: msg.type, text: msg.message }], done: isDone, error: isDone && msg.type === 'error' };
        });
        if (msg.type === 'done') {
          es.close();
          api('/api/providers/local-status').then((data) => {
            if (data) setLocalBinaryStatus({ 'llama-server': data.llamaServer, koboldcpp: data.koboldcpp });
          }).catch(() => {});
        }
        if (msg.type === 'error') es.close();
      } catch {}
    };
    es.onerror = () => {
      setInstallingBinary((prev) => prev && !prev.done ? { ...prev, lines: [...prev.lines, { type: 'error', text: 'Connection lost' }], done: true, error: true } : prev);
      es.close();
    };
  }

  useEffect(() => {
    if (selectedPromptProfileId === 'mirabilis-default' || isMirabilisDefaultPrompt(systemPrompt)) {
      setSystemPrompt(buildDefaultSystemPrompt(provider));
    }
  }, [provider, selectedPromptProfileId]);

  useEffect(() => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    speechSynthesisRef.current = synth;
    setVoiceSupported(Boolean(synth));

    if (!synth) return undefined;

    const refreshVoices = () => {
      const voices = synth.getVoices() || [];
      setAvailableVoices(voices);
      if (!selectedVoiceUri && voices.length > 0) {
        const preferred = voices.find((v) => /samantha|serena|alex|alloy|natural/i.test(v.name)) || voices[0];
        setSelectedVoiceUri(preferred.voiceURI || '');
      }
    };

    refreshVoices();
    synth.onvoiceschanged = refreshVoices;

    return () => {
      if (synth) {
        synth.onvoiceschanged = null;
        synth.cancel();
        setIsSpeaking(false);
        setSpeakingMessageId(null);
      }
    };
  }, [selectedVoiceUri]);

  useEffect(() => {
    safeStorageSet('mirabilis-voice-uri', selectedVoiceUri || '');
  }, [selectedVoiceUri]);

  useEffect(() => {
    safeStorageSet('mirabilis-auto-speak', autoSpeakEnabled ? 'true' : 'false');
  }, [autoSpeakEnabled]);

  useEffect(() => {
    safeStorageSet('mirabilis-provider', provider);
  }, [provider]);

  useEffect(() => {
    if (provider === 'ollama') return;
    let cancelled = false;

    (async () => {
      try {
        const cfgBase = String(providerConfigs?.[provider]?.baseUrl || '').trim();
        const cfgKey = String(providerConfigs?.[provider]?.apiKey || '').trim();
        // Same rule as the send path: a backend-held key counts.
        if (providerNeedsKey(provider) && !hasUsableKey(provider, { pageKey: cfgKey, hints: keyHints })) {
          setStatusText('API key needed');
          return;
        }
        const query = new URLSearchParams({ provider });
        if (cfgBase) query.set('baseUrl', cfgBase);
        // Key in a header, never the URL: query strings leak into logs and history.
        const keyHeader = ((provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas' || provider === 'openai-compatible' || provider === 'vllm') && cfgKey)
          ? { 'x-provider-key': cfgKey } : undefined;
        const health = await api(`/api/providers/health?${query.toString()}`, keyHeader ? { headers: keyHeader } : undefined);
        if (cancelled) return;
        if (!health?.reachable) {
          const hint = health?.hint ? ` ${health.hint}` : '';
          setStatusText(`Provider unreachable.${hint}`.trim());
        }
      } catch {
        // ignore startup health probe failures
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [provider, providerConfigs, keyHints]);

  useEffect(() => {
    // Fill defaults into empty or legacy stored provider configs.
    setProviderConfigs((prev) => {
      const existingOpenAiBase = prev?.['openai-compatible']?.baseUrl || '';
      const normalizedOpenAiBase = String(existingOpenAiBase).trim() === 'http://127.0.0.1:8080/v1'
        ? 'http://127.0.0.1:8000/v1'
        : (existingOpenAiBase || 'http://127.0.0.1:8000/v1');
      const next = {
        ...prev,
        openai: {
          baseUrl: prev?.openai?.baseUrl || 'https://api.openai.com/v1',
          apiKey: prev?.openai?.apiKey || ''
        },
        grok: {
          baseUrl: prev?.grok?.baseUrl || 'https://api.x.ai/v1',
          apiKey: prev?.grok?.apiKey || ''
        },
        groq: {
          baseUrl: prev?.groq?.baseUrl || 'https://api.groq.com/openai/v1',
          apiKey: prev?.groq?.apiKey || ''
        },
        openrouter: {
          baseUrl: prev?.openrouter?.baseUrl || 'https://openrouter.ai/api/v1',
          apiKey: prev?.openrouter?.apiKey || ''
        },
        gemini: {
          baseUrl: normalizeGeminiBaseUrl(prev?.gemini?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai'),
          apiKey: prev?.gemini?.apiKey || ''
        },
        cerebras: {
          baseUrl: prev?.cerebras?.baseUrl || 'https://api.cerebras.ai/v1',
          apiKey: prev?.cerebras?.apiKey || ''
        },
        claude: {
          baseUrl: prev?.claude?.baseUrl || 'https://api.anthropic.com',
          apiKey: prev?.claude?.apiKey || ''
        },
        gpuaas: {
          baseUrl: prev?.gpuaas?.baseUrl || '',
          apiKey: prev?.gpuaas?.apiKey || ''
        },
        'openai-compatible': {
          baseUrl: normalizedOpenAiBase,
          apiKey: prev?.['openai-compatible']?.apiKey || ''
        },
        koboldcpp: {
          baseUrl: prev?.koboldcpp?.baseUrl || 'http://127.0.0.1:5001/v1',
          apiKey: prev?.koboldcpp?.apiKey || ''
        }
      };
      if (JSON.stringify(next) === JSON.stringify(prev)) return prev;
      return next;
    });
  }, []);

  // Persist without API keys. Keys live in the backend (providerKeys.js) so page
  // scripts and the browser profile never hold them.
  useEffect(() => {
    const withoutKeys = Object.fromEntries(
      Object.entries(providerConfigs || {}).map(([id, cfg]) => {
        const { apiKey, ...rest } = cfg || {};
        return [id, rest];
      })
    );
    safeStorageSet('mirabilis-provider-configs', JSON.stringify(withoutKeys));
  }, [providerConfigs]);

  // One-time migration: move keys found in local storage to the backend, then erase them.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let stored;
      try {
        stored = JSON.parse(safeStorageGet('mirabilis-provider-configs', '{}') || '{}');
      } catch { return; }
      const withKeys = Object.entries(stored).filter(([, cfg]) => cfg && cfg.apiKey);
      if (!withKeys.length) return;
      for (const [providerId, cfg] of withKeys) {
        try {
          await api(`/api/provider-keys/${encodeURIComponent(providerId)}`, {
            method: 'PUT', body: JSON.stringify({ apiKey: cfg.apiKey })
          });
        } catch { return; } // leave local storage alone if the move failed
      }
      if (cancelled) return;
      const cleaned = Object.fromEntries(
        Object.entries(stored).map(([id, cfg]) => {
          const { apiKey, ...rest } = cfg || {};
          return [id, rest];
        })
      );
      safeStorageSet('mirabilis-provider-configs', JSON.stringify(cleaned));
      appStore.toast(`${withKeys.length} API key(s) moved to the app`, { kind: 'info' });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    safeStorageSet('mirabilis-openclaw', openClawMode ? 'true' : 'false');
  }, [openClawMode]);

  // openClawMode is persisted but the state that implements it is not, so
  // re-apply it on load or the indicator says "on" while the app is not.
  const openClawRestoredRef = useRef(false);
  useEffect(() => {
    if (openClawRestoredRef.current) return;
    openClawRestoredRef.current = true;
    if (!openClawMode) return;
    setUncensoredMode(true);
    setUsePersonalMemory(false);
    setSelectedPromptProfileId(UNSAVED_PROMPT_PROFILE_ID);
    setSystemPrompt('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    safeStorageSet('mirabilis-voice-rate', String(voiceRate));
  }, [voiceRate]);

  useEffect(() => {
    safeStorageSet('mirabilis-voice-pitch', String(voicePitch));
  }, [voicePitch]);

  useEffect(() => {
    safeStorageSet('mirabilis-voice-engine', voiceEngine);
  }, [voiceEngine]);

  useEffect(() => {
    safeStorageSet('mirabilis-piper-model', selectedPiperModelId || '');
  }, [selectedPiperModelId]);

  useEffect(() => {
    safeStorageSet('mirabilis-pinned-chats', JSON.stringify(Array.from(pinnedChatIds)));
  }, [pinnedChatIds]);

  useEffect(() => {
    safeStorageSet('mirabilis-config-vault-enabled', configVaultEnabled ? 'true' : 'false');
  }, [configVaultEnabled]);

  useEffect(() => {
    if (configVaultFolder) safeStorageSet('mirabilis-config-vault-folder', configVaultFolder);
    else safeStorageRemove('mirabilis-config-vault-folder');
  }, [configVaultFolder]);

  // Fetch the persisted Config Vault index status once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api('/api/vault/status');
        if (!cancelled && s?.ok) {
          setConfigVaultStatus(s);
          if (s.root && !configVaultFolder) setConfigVaultFolder(s.root);
        }
      } catch { /* vault status is best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (temperature === null) safeStorageRemove('mirabilis-temperature');
    else safeStorageSet('mirabilis-temperature', String(temperature));
  }, [temperature]);

  useEffect(() => {
    if (maxTokens === null) safeStorageRemove('mirabilis-max-tokens');
    else safeStorageSet('mirabilis-max-tokens', String(maxTokens));
  }, [maxTokens]);

  useEffect(() => {
    const keys = Object.keys(ollamaParams || {}).filter((k) => ollamaParams[k] != null);
    if (keys.length === 0) safeStorageRemove('mirabilis-ollama-params');
    else safeStorageSet('mirabilis-ollama-params', JSON.stringify(ollamaParams));
  }, [ollamaParams]);

  useEffect(() => {
    if (Number.isFinite(remoteBudgetUsd) && remoteBudgetUsd > 0) {
      safeStorageSet('mirabilis-remote-budget-usd', String(remoteBudgetUsd));
    }
  }, [remoteBudgetUsd]);

  async function fetchPiperModels() {
    try {
      const data = await api('/api/voice/piper-models');
      setPiperModels(data?.catalog || []);
      // auto-select first installed if current selection is empty
      const installed = (data?.catalog || []).filter((m) => m.installed);
      if (installed.length > 0) {
        setSelectedPiperModelId((prev) => {
          if (prev && installed.find((m) => m.id === prev)) return prev;
          return installed[0].id;
        });
      }
    } catch {
      // Best effort.
    }
  }

  async function downloadPiperModel(modelId) {
    setDownloadingPiperModelId(modelId);
    setStatusText(`Downloading ${modelId}...`);
    try {
      await api('/api/voice/download-model', { method: 'POST', body: JSON.stringify({ modelId }) });
      setStatusText('Voice model downloaded');
      await Promise.all([checkVoiceTools(), fetchPiperModels()]);
      setSelectedPiperModelId(modelId);
    } catch (err) {
      setStatusText(`Download failed: ${err.message}`);
    } finally {
      setDownloadingPiperModelId(null);
    }
  }

  async function checkVoiceTools() {
    try {
      const status = await api('/api/voice/status');
      setVoiceTools(status);
    } catch {
      setVoiceTools(null);
    }
  }

  async function setupVoiceTools() {
    setIsSettingUpVoiceTools(true);
    setStatusText('Installing Piper...');
    try {
      const payload = await api('/api/voice/setup', { method: 'POST' });
      setVoiceTools(payload?.status || null);
      setStatusText('Piper installed');
    } catch (error) {
      setStatusText(`Piper install failed: ${error.message}`);
    } finally {
      setIsSettingUpVoiceTools(false);
      await checkVoiceTools();
    }
  }

  async function setupStt() {
    setIsSettingUpStt(true);
    setStatusText('Installing speech to text...');
    try {
      const payload = await api('/api/voice/stt-setup', { method: 'POST' });
      if (payload?.status?.ready) voiceSttReadyRef.current = true;
      setStatusText(payload?.status?.ready ? 'Speech to text ready' : 'Speech to text not ready');
      await checkVoiceTools();
    } catch (error) {
      setStatusText(`Speech to text setup failed: ${error.message}`);
    } finally {
      setIsSettingUpStt(false);
    }
  }

  async function checkVllmStatus() {
    try {
      const s = await api('/api/runtimes/vllm/status');
      setVllmStatus(s);
      // If a local vLLM is already running, make sure the provider points at it.
      if (s?.running && s?.baseUrl) {
        setProviderConfigs((prev) => ({ ...prev, vllm: { ...prev.vllm, baseUrl: s.baseUrl } }));
      }
    } catch {
      setVllmStatus(null);
    }
  }

  async function startLocalVllm() {
    const model = vllmLocalModel.trim();
    if (!model) { setStatusText('Enter a model id'); return; }
    setIsVllmBusy(true);
    setStatusText('Starting vLLM...');
    try {
      const out = await api('/api/runtimes/vllm/start', { method: 'POST', body: JSON.stringify({ model }) });
      // Point the vLLM provider at the managed local server so chat routes to it.
      setProviderConfigs((prev) => ({ ...prev, vllm: { ...prev.vllm, baseUrl: out.baseUrl } }));
      setStatusText(`Local vLLM running at ${out.baseUrl}`);
      await checkVllmStatus();
      await refreshModels();
    } catch (error) {
      setStatusText(`vLLM start failed: ${error.message}`);
    } finally {
      setIsVllmBusy(false);
    }
  }

  async function stopLocalVllm() {
    setIsVllmBusy(true);
    try {
      await api('/api/runtimes/vllm/stop', { method: 'POST' });
      setStatusText('Local vLLM stopped');
      await checkVllmStatus();
    } catch (error) {
      setStatusText(`vLLM stop failed: ${error.message}`);
    } finally {
      setIsVllmBusy(false);
    }
  }

  async function checkLlamacppStatus() {
    try {
      const s = await api('/api/runtimes/llamacpp/status');
      setLlamacppStatus(s);
      if (s?.running && s?.baseUrl) {
        setProviderConfigs((prev) => ({ ...prev, llamacpp: { ...prev.llamacpp, baseUrl: s.baseUrl } }));
      }
      // Launchable models are the local GGUFs, including Ollama's, run directly by llama.cpp.
      try {
        const m = await api('/api/models?provider=ollama');
        const ids = (m.models || []).filter((x) => x.available !== false).map((x) => x.id);
        setLlamacppLaunchable(ids);
        setLlamacppModel((cur) => cur || ids[0] || '');
      } catch { /* leave list empty; user can still type a .gguf path */ }
    } catch {
      setLlamacppStatus(null);
    }
  }

  async function startLlamacpp() {
    const model = llamacppModel.trim();
    if (!model) { setStatusText('Pick a model'); return; }
    setIsLlamacppBusy(true);
    setStatusText('Starting llama.cpp...');
    try {
      const body = /\.gguf$/i.test(model) ? { modelPath: model } : { model };
      const out = await api('/api/runtimes/llamacpp/start', { method: 'POST', body: JSON.stringify(body) });
      setProviderConfigs((prev) => ({ ...prev, llamacpp: { ...prev.llamacpp, baseUrl: out.baseUrl } }));
      setStatusText(`llama.cpp running: ${model}`);
      await checkLlamacppStatus();
      await refreshModels();
    } catch (error) {
      setStatusText(`llama.cpp start failed: ${error.message}`);
    } finally {
      setIsLlamacppBusy(false);
    }
  }

  async function stopLlamacpp() {
    setIsLlamacppBusy(true);
    try {
      await api('/api/runtimes/llamacpp/stop', { method: 'POST' });
      setStatusText('llama.cpp stopped');
      await checkLlamacppStatus();
      await refreshModels();
    } catch (error) {
      setStatusText(`llama.cpp stop failed: ${error.message}`);
    } finally {
      setIsLlamacppBusy(false);
    }
  }

  function stopStreaming() {
    // An autonomous run has no chat stream, so Stop goes to the run.
    if (agentAbortRef.current) {
      stopAgentRun();
      return;
    }
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
  }

  function stopSpeaking() {
    const synth = speechSynthesisRef.current;
    if (synth) synth.cancel();
    if (piperAudioRef.current) {
      piperAudioRef.current.pause();
      piperAudioRef.current.src = '';
      piperAudioRef.current = null;
    }
    setIsSpeaking(false);
    setSpeakingMessageId(null);
  }

  function speakText(text, messageId = null) {
    // Read from the ref so a memoized row's stale closure uses current settings.
    const vs = voiceSettingsRef.current || {};
    const engine = vs.voiceEngine ?? voiceEngine;
    const voiceUri = vs.selectedVoiceUri ?? selectedVoiceUri;
    const rate = vs.voiceRate ?? voiceRate;
    const pitch = vs.voicePitch ?? voicePitch;
    const voices = vs.availableVoices ?? availableVoices;
    if (engine === 'piper') {
      speakTextViaPiper(text, messageId);
      return;
    }
    const synth = speechSynthesisRef.current;
    if (!synth || !voiceSupported) return;

    const clean = plainTextForSpeech(text);
    if (!clean) return;

    const utterance = new SpeechSynthesisUtterance(clean);
    const voice = (voices || []).find((v) => v.voiceURI === voiceUri);
    if (voice) utterance.voice = voice;
    utterance.rate = Math.min(1.5, Math.max(0.8, Number(rate) || 1));
    utterance.pitch = Math.min(1.4, Math.max(0.8, Number(pitch) || 1));
    utterance.onstart = () => {
      setIsSpeaking(true);
      setSpeakingMessageId(messageId);
    };
    utterance.onend = () => {
      setIsSpeaking(false);
      setSpeakingMessageId(null);
    };
    utterance.onerror = () => {
      setIsSpeaking(false);
      setSpeakingMessageId(null);
    };

    setSpeakingMessageId(messageId);
    synth.cancel();
    synth.speak(utterance);
  }

  async function speakTextViaPiper(text, messageId = null) {
    const clean = plainTextForSpeech(text);
    if (!clean) return;
    // Stop any currently-playing piper audio before starting a new one
    if (piperAudioRef.current) {
      piperAudioRef.current.pause();
      piperAudioRef.current.src = '';
      piperAudioRef.current = null;
    }
    setSpeakingMessageId(messageId);
    setIsSpeaking(true);
    try {
      const resp = await fetch(`${API_BASE}/api/voice/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean.slice(0, 5000), modelId: (voiceSettingsRef.current?.selectedPiperModelId ?? selectedPiperModelId) || undefined }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || 'TTS request failed');
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      piperAudioRef.current = audio;
      audio.onended = () => {
        setIsSpeaking(false);
        setSpeakingMessageId(null);
        URL.revokeObjectURL(url);
        piperAudioRef.current = null;
      };
      audio.onerror = () => {
        setIsSpeaking(false);
        setSpeakingMessageId(null);
        URL.revokeObjectURL(url);
        piperAudioRef.current = null;
      };
      await audio.play();
    } catch (err) {
      setIsSpeaking(false);
      setSpeakingMessageId(null);
      setStatusText(`Voice error: ${err.message}`);
    }
  }

  /* Voice loop: listen, send, speak, repeat until End. Phase lives in refs so
     callbacks never read it stale; send/speak go through refs refreshed each
     render so a provider or voice switch mid-conversation applies. */

  function setVoicePhaseBoth(next) {
    voicePhaseRef.current = next;
    setVoicePhase(next);
  }

  // Engine reachability, so the status chip does not claim "Ready" with nothing
  // running. Checked on mount, on provider change and every 30s.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const query = new URLSearchParams({ provider });
        const configured = providerConfigs[provider]?.baseUrl;
        if (configured) query.set('baseUrl', configured);
        const payload = await api(`/api/providers/health?${query.toString()}`);
        if (cancelled) return;
        const up = Boolean(payload?.reachable);
        setEngineUp(up);
        // Clear a stale failure label once the engine is back.
        if (up) setStatusText((prev) => (prev === 'No engine' || prev === 'Error' ? 'Ready' : prev));
      } catch {
        if (!cancelled) setEngineUp(false);
      }
    };
    check();
    const timer = setInterval(check, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const refreshKeyHints = useCallback(async () => {
    try {
      const payload = await api('/api/provider-keys');
      const next = {};
      for (const k of (payload?.keys || [])) next[k.provider] = k;
      setKeyHints(next);
      // Also returned: the send path cannot wait for state on an early first message.
      return next;
    } catch {
      return null; // settings panel shows nothing stored
    }
  }, []);

  useEffect(() => { refreshKeyHints(); }, [refreshKeyHints]);

  async function saveProviderKey(providerId, value) {
    try {
      await api(`/api/provider-keys/${encodeURIComponent(providerId)}`, {
        method: 'PUT', body: JSON.stringify({ apiKey: value })
      });
      setKeyDraft('');
      await refreshKeyHints();
      appStore.toast('API key saved', { kind: 'success' });
    } catch (err) {
      appStore.toast(`API key not saved: ${plainError(err.message)}`, { kind: 'error' });
    }
  }

  async function clearProviderKey(providerId) {
    try {
      await api(`/api/provider-keys/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
      setKeyDraft('');
      await refreshKeyHints();
    } catch (err) {
      appStore.toast(`API key not cleared: ${plainError(err.message)}`, { kind: 'error' });
    }
  }

  // Keep the loop's send/speak handles pointing at the latest closures.
  useEffect(() => {
    voiceSendRef.current = sendMessageWithContent;
    voiceSpeakRef.current = speakText;
    voiceStopSpeakRef.current = stopSpeaking;
    messagesRef.current = messages;
    activeChatIdRef.current = activeChatId;
    // Lets a memoized row's stale speakText closure use current voice settings.
    voiceSettingsRef.current = { voiceEngine, selectedVoiceUri, voiceRate, voicePitch, selectedPiperModelId, availableVoices };
  });

  // The loop needs getUserMedia and MediaRecorder; Web Speech does not work in Electron.
  useEffect(() => {
    const supported = typeof window !== 'undefined'
      && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(window.MediaRecorder);
    setVoiceLoopSupported(supported);
  }, []);

  // Idempotent. Releasing the mic tracks is what turns the OS mic indicator off.
  function stopVoiceRecognition() {
    const timers = voiceVadTimersRef.current || {};
    for (const k of Object.keys(timers)) { clearTimeout(timers[k]); }
    voiceVadTimersRef.current = {};
    if (voiceVadRafRef.current) { cancelAnimationFrame(voiceVadRafRef.current); voiceVadRafRef.current = null; }
    const rec = voiceRecorderRef.current;
    if (rec) {
      try {
        rec.ondataavailable = null;
        rec.onstop = null;
        rec.onerror = null;
        if (rec.state !== 'inactive') rec.stop();
      } catch { /* already stopped */ }
      voiceRecorderRef.current = null;
    }
    if (voiceStreamRef.current) {
      try { voiceStreamRef.current.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
      voiceStreamRef.current = null;
    }
    if (voiceAudioCtxRef.current) {
      try { voiceAudioCtxRef.current.close(); } catch { /* already closed */ }
      voiceAudioCtxRef.current = null;
    }
    // Web Speech recognizer, if one is still attached.
    const legacy = voiceRecognitionRef.current;
    if (legacy) {
      try { legacy.onresult = null; legacy.onend = null; legacy.onerror = null; legacy.stop(); } catch { /* noop */ }
      voiceRecognitionRef.current = null;
    }
  }

  // 16 kHz mono PCM16 WAV is what whisper.cpp reads directly, so no server ffmpeg.
  async function encodeWavFromBlob(blob) {
    const arrayBuf = await blob.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const decodeCtx = new Ctx();
    let decoded;
    try {
      decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
    } finally {
      try { decodeCtx.close(); } catch { /* noop */ }
    }
    const targetRate = 16000;
    const frames = Math.ceil(decoded.duration * targetRate);
    if (!frames) return null;
    const offline = new OfflineAudioContext(1, frames, targetRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    // PCM16 WAV
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);          // PCM
    view.setUint16(22, 1, true);          // mono
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  // Matches by name since Web Speech does not expose gender. Switches the engine to 'browser'.
  function pickBrowserVoiceForGender(gender) {
    setVoiceEngine('browser');
    const voices = availableVoices || [];
    if (voices.length === 0) return; // synth default is fine
    const want = BROWSER_VOICE_HINTS[gender] || [];
    const avoid = BROWSER_VOICE_HINTS[gender === 'male' ? 'female' : 'male'] || [];
    const lc = (s) => String(s || '').toLowerCase();
    const enFirst = voices.filter((v) => lc(v.lang).startsWith('en'));
    const pool = enFirst.length ? enFirst : voices;
    let pick = pool.find((v) => want.some((h) => lc(v.name).includes(h)));
    if (!pick) pick = pool.find((v) => !avoid.some((h) => lc(v.name).includes(h)));
    if (!pick) pick = pool[0];
    if (pick) setSelectedVoiceUri(pick.voiceURI);
  }

  // Piper when installed; otherwise a browser voice while Piper downloads.
  function ensureVoiceForGender(gender) {
    const modelId = VOICE_GENDER_PIPER[gender];
    const model = (piperModels || []).find((m) => m.id === modelId);
    if (model?.installed) {
      setVoiceEngine('piper');
      setSelectedPiperModelId(modelId);
      setVoiceNote('');
      return;
    }
    // Not installed yet: use a browser voice now so the loop never blocks.
    pickBrowserVoiceForGender(gender);
    if (model && downloadingPiperModelId !== modelId) {
      setVoiceNote(`Downloading ${gender} voice...`);
      downloadPiperModel(modelId)
        .then(() => {
          setVoiceEngine('piper');
          setSelectedPiperModelId(modelId);
          setVoiceNote('');
        })
        .catch(() => {
          // A failed download keeps the browser voice.
          setVoiceNote('');
        });
    }
  }

  async function startVoiceListening() {
    if (!voiceActiveRef.current || !voiceLoopSupported) return;
    if (voiceRestartTimerRef.current) {
      clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = null;
    }
    stopVoiceRecognition(); // tear down any prior capture and release the mic

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      voiceActiveRef.current = false;
      setVoiceNote('Microphone access denied. Allow it in System Settings.');
      setVoicePhaseBoth('idle');
      return;
    }
    // The loop may have been ended while we awaited the permission prompt.
    if (!voiceActiveRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }

    voiceStreamRef.current = stream;
    voiceChunksRef.current = [];
    voiceHeardSpeechRef.current = false;
    voiceFinalRef.current = '';
    setVoiceInterim('');

    const mimeType = getDictationMimeType();
    let recorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      stopVoiceRecognition();
      voiceActiveRef.current = false;
      setVoiceNote('Audio recording not supported');
      setVoicePhaseBoth('idle');
      return;
    }
    voiceRecorderRef.current = recorder;
    setVoicePhaseBoth('listening');

    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) voiceChunksRef.current.push(e.data); };
    recorder.onerror = () => { /* surfaced via onstop */ };

    // Finalize once: the VAD, the max-duration cap and an orb tap can race.
    let finalized = false;
    const finalize = () => {
      if (finalized) return; finalized = true;
      const timers = voiceVadTimersRef.current || {};
      for (const k of Object.keys(timers)) clearTimeout(timers[k]);
      voiceVadTimersRef.current = {};
      if (voiceVadRafRef.current) { cancelAnimationFrame(voiceVadRafRef.current); voiceVadRafRef.current = null; }
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* noop */ }
    };
    voiceStopCaptureRef.current = finalize;

    recorder.onstop = async () => {
      // Release the mic now so the OS mic indicator turns off.
      if (voiceStreamRef.current) { try { voiceStreamRef.current.getTracks().forEach((t) => t.stop()); } catch { /* noop */ } voiceStreamRef.current = null; }
      if (voiceAudioCtxRef.current) { try { voiceAudioCtxRef.current.close(); } catch { /* noop */ } voiceAudioCtxRef.current = null; }
      voiceRecorderRef.current = null;
      if (!voiceActiveRef.current) return;
      const chunks = voiceChunksRef.current; voiceChunksRef.current = [];
      if (!voiceHeardSpeechRef.current || !chunks.length) {
        // Nothing said - keep listening hands-free.
        if (voiceActiveRef.current && voicePhaseRef.current === 'listening') {
          voiceRestartTimerRef.current = setTimeout(() => { if (voiceActiveRef.current) startVoiceListening(); }, 250);
        }
        return;
      }
      setVoicePhaseBoth('thinking');
      try {
        const raw = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const wav = await encodeWavFromBlob(raw);
        if (!wav) throw new Error('empty audio');
        const fd = new FormData();
        fd.append('audio', wav, 'voice.wav');
        const resp = await fetch(`${API_BASE}/api/voice/transcribe`, { method: 'POST', body: fd });
        if (!resp.ok) {
          const payload = await resp.json().catch(() => ({}));
          throw new Error(payload.error || `Transcription failed (${resp.status})`);
        }
        const payload = await resp.json();
        const text = String(payload?.text || '').trim();
        if (!voiceActiveRef.current) return;
        if (text) {
          submitVoiceTurn(text);
        } else {
          // Heard sound but no words - listen again.
          setVoicePhaseBoth('listening');
          if (voiceActiveRef.current) startVoiceListening();
        }
      } catch (err) {
        if (!voiceActiveRef.current) return;
        // STT unavailable or failed: end the loop instead of retrying forever.
        voiceActiveRef.current = false;
        stopVoiceRecognition();
        const msg = String(err?.message || '');
        setVoiceNote(/speech-to-text|speech to text|whisper/i.test(msg)
          ? 'Install speech to text in Settings > Voice'
          : `Voice error: ${msg || 'transcription failed'}`);
        setVoicePhaseBoth('idle');
      }
    };

    // Voice activity detection: auto-stop shortly after the user stops talking,
    // cap the turn length, and release the mic if no speech is heard at all.
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new Ctx();
      voiceAudioCtxRef.current = audioCtx;
      // Autoplay policy can leave it suspended after the awaits; without resume the VAD never fires.
      if (audioCtx.state === 'suspended') { audioCtx.resume().catch(() => {}); }
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const SPEECH_RMS = 0.015;      // above this counts as speech
      const SILENCE_HANG_MS = 1200;  // stop this long after speech ends
      let silenceStart = 0;
      const tick = () => {
        if (finalized || !voiceActiveRef.current) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        if (rms > SPEECH_RMS) {
          if (!voiceHeardSpeechRef.current) {
            voiceHeardSpeechRef.current = true;
            if (voiceVadTimersRef.current.noSpeech) { clearTimeout(voiceVadTimersRef.current.noSpeech); voiceVadTimersRef.current.noSpeech = null; }
          }
          silenceStart = 0;
        } else if (voiceHeardSpeechRef.current) {
          if (!silenceStart) silenceStart = now;
          else if (now - silenceStart > SILENCE_HANG_MS) { finalize(); return; }
        }
        voiceVadRafRef.current = requestAnimationFrame(tick);
      };
      voiceVadRafRef.current = requestAnimationFrame(tick);
    } catch { /* no VAD - the hard timers below still bound the turn */ }

    // Hard caps: longest single turn, and a ceiling on holding an idle mic.
    voiceVadTimersRef.current.maxDuration = setTimeout(() => finalize(), 30000);
    voiceVadTimersRef.current.noSpeech = setTimeout(() => {
      if (!voiceHeardSpeechRef.current) {
        finalized = true;
        stopVoiceRecognition();
        if (voiceActiveRef.current) {
          setVoiceNote('No speech heard');
          setVoicePhaseBoth('idle');
        }
      }
    }, 10000);

    try {
      recorder.start();
    } catch {
      stopVoiceRecognition();
      voiceActiveRef.current = false;
      setVoicePhaseBoth('idle');
    }
  }

  function submitVoiceTurn(text) {
    stopVoiceRecognition();
    setVoiceInterim(text);
    setVoiceReply('');
    setVoicePhaseBoth('thinking');
    voiceAwaitingReplyRef.current = true;
    voiceSawStreamingRef.current = false;
    const send = voiceSendRef.current;
    if (send) {
      Promise.resolve(send(text)).then(() => {
        // The send path can refuse without throwing (Go Dark, no key, no chat).
        // Settled with nothing streamed means refused: go back to listening.
        // A normal reply cannot reach this: the completion effect clears
        // voiceAwaitingReplyRef first, and a live stream sets voiceSawStreamingRef.
        if (voiceAwaitingReplyRef.current && !voiceSawStreamingRef.current) {
          voiceAwaitingReplyRef.current = false;
          setVoiceNote('Not sent. Check the provider, API key or Go Dark.');
          if (voiceActiveRef.current) startVoiceListening();
        }
      }).catch(() => {
        // Send failed to start; go back to listening.
        voiceAwaitingReplyRef.current = false;
        if (voiceActiveRef.current) startVoiceListening();
      });
    }
  }

  function startVoiceLoop() {
    voiceActiveRef.current = true;
    voiceFinalRef.current = '';
    voiceAwaitingReplyRef.current = false;
    voiceSawStreamingRef.current = false;
    voiceSawSpeakingRef.current = false;
    setVoiceInterim('');
    setVoiceReply('');
    setVoiceNote('');
    // Refresh the Piper catalog so an installed ryan/amy is picked up even if the
    // voice menu was never opened; the piperModels effect re-applies on arrival.
    fetchPiperModels();
    ensureVoiceForGender(voiceGender);
    if (!voiceLoopSupported) {
      setVoiceNote('Microphone not available');
      setVoicePhaseBoth('idle');
      return;
    }
    // Open the mic only once STT is usable, so it is never held with nothing to transcribe.
    setVoicePhaseBoth('thinking');
    fetch(`${API_BASE}/api/voice/stt-status`).then((r) => r.json()).then((s) => {
      if (!voiceActiveRef.current) return;
      voiceSttReadyRef.current = Boolean(s?.ready);
      if (s?.ready) {
        startVoiceListening();
      } else {
        setVoiceNote('Install speech to text in Settings > Voice');
        setVoicePhaseBoth('idle');
      }
    }).catch(() => {
      // Status unknown: try anyway; the transcribe error path reports missing STT.
      if (voiceActiveRef.current) startVoiceListening();
    });
  }

  function stopVoiceLoop() {
    voiceActiveRef.current = false;
    voiceAwaitingReplyRef.current = false;
    voiceSawStreamingRef.current = false;
    voiceSawSpeakingRef.current = false;
    if (voiceRestartTimerRef.current) {
      clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = null;
    }
    if (voiceSpeakWatchdogRef.current) {
      clearTimeout(voiceSpeakWatchdogRef.current);
      voiceSpeakWatchdogRef.current = null;
    }
    stopVoiceRecognition();
    voiceStopSpeakRef.current?.();
    setVoicePhaseBoth('idle');
    setVoiceInterim('');
  }

  function onVoiceOrbTap() {
    if (!voiceLoopSupported || !voiceActiveRef.current) return;
    const phase = voicePhaseRef.current;
    if (phase === 'speaking') {
      // Barge-in: cut the reply short and start listening immediately.
      voiceStopSpeakRef.current?.();
      startVoiceListening();
    } else if (phase === 'listening') {
      // End the current turn now and transcribe what was captured.
      if (voiceStopCaptureRef.current) voiceStopCaptureRef.current();
    } else if (phase === 'idle') {
      // Resume after a no-speech pause (or a retry).
      setVoiceNote('');
      startVoiceListening();
    }
    // 'thinking' - ignore taps while a reply is generating.
  }

  function onVoiceGenderChange(gender) {
    const next = gender === 'male' ? 'male' : 'female';
    setVoiceGender(next);
    safeStorageSet('mirabilis-voice-gender', next);
    ensureVoiceForGender(next);
  }

  // Open/close: start or tear down the loop. Also cleans up on unmount.
  useEffect(() => {
    if (voiceChatOpen) startVoiceLoop();
    else stopVoiceLoop();
    return () => {
      if (voiceChatOpen) stopVoiceLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceChatOpen]);

  // When the Piper catalog arrives/updates while the overlay is open, re-apply
  // the chosen voice (upgrades a browser fallback to local Piper once installed).
  useEffect(() => {
    if (voiceChatOpen) ensureVoiceForGender(voiceGender);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piperModels]);

  // Reply completion: when the stream we kicked off finishes, speak the last
  // assistant message and enter the speaking phase.
  useEffect(() => {
    if (!voiceActiveRef.current || !voiceAwaitingReplyRef.current) return;
    if (isStreaming) { voiceSawStreamingRef.current = true; return; }
    if (!voiceSawStreamingRef.current) return; // stream not started yet
    voiceSawStreamingRef.current = false;
    voiceAwaitingReplyRef.current = false;
    const last = [...(messagesRef.current || [])]
      .reverse()
      .find((m) => m.role === 'assistant' && m.content && !m.imageGenerating);
    const content = String(last?.content || '').trim();
    if (!content) {
      if (voiceActiveRef.current) startVoiceListening();
      return;
    }
    setVoiceReply(content);
    setVoicePhaseBoth('speaking');
    voiceSawSpeakingRef.current = false;
    voiceSpeakRef.current?.(content, last.id || null);
    // Watchdog: if TTS never signals start, fall back to listening.
    if (voiceSpeakWatchdogRef.current) clearTimeout(voiceSpeakWatchdogRef.current);
    voiceSpeakWatchdogRef.current = setTimeout(() => {
      if (voiceActiveRef.current && voicePhaseRef.current === 'speaking' && !voiceSawSpeakingRef.current) {
        startVoiceListening();
      }
    }, 2500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  // Speech completion: when TTS we started finishes, listen for the next turn.
  useEffect(() => {
    if (!voiceActiveRef.current || voicePhaseRef.current !== 'speaking') return;
    if (isSpeaking) {
      voiceSawSpeakingRef.current = true;
      if (voiceSpeakWatchdogRef.current) {
        clearTimeout(voiceSpeakWatchdogRef.current);
        voiceSpeakWatchdogRef.current = null;
      }
      return;
    }
    if (!voiceSawSpeakingRef.current) return; // TTS not started yet
    voiceSawSpeakingRef.current = false;
    if (voiceActiveRef.current) startVoiceListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpeaking]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event) => setSystemPrefersDark(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const speechRecognitionSupported = typeof window !== 'undefined'
      && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    const mediaRecorderSupported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    setDictationSupported(speechRecognitionSupported || mediaRecorderSupported);

    return () => {
      if (dictationRecognitionRef.current) {
        try {
          dictationRecognitionRef.current.onresult = null;
          dictationRecognitionRef.current.onend = null;
          dictationRecognitionRef.current.onerror = null;
          dictationRecognitionRef.current.stop();
        } catch {}
        dictationRecognitionRef.current = null;
      }

      if (dictationRecorderRef.current) {
        try {
          dictationRecorderRef.current.ondataavailable = null;
          dictationRecorderRef.current.onstop = null;
          dictationRecorderRef.current.onerror = null;
          if (dictationPhaseRef.current === 'recording') {
            dictationRecorderRef.current.stop();
          }
        } catch {}
      }

      if (dictationStreamRef.current) {
        dictationStreamRef.current.getTracks().forEach((track) => track.stop());
      }

      dictationRecorderRef.current = null;
      dictationStreamRef.current = null;
      dictationChunksRef.current = [];
      dictationPhaseRef.current = 'idle';
    };
  }, []);

  useEffect(() => {
    const applyDark = themeMode === 'dark' || (themeMode === 'auto' && systemPrefersDark);
    document.documentElement.classList.toggle('dark', applyDark);
    safeStorageSet('local-ai-theme-mode', themeMode);
  }, [themeMode, systemPrefersDark]);

  useEffect(() => {
    if (uiFont === 'jakarta') {
      document.documentElement.removeAttribute('data-font');
    } else {
      document.documentElement.setAttribute('data-font', uiFont);
    }
    safeStorageSet('mirabilis-font', uiFont);
  }, [uiFont]);

  useEffect(() => {
    if (colorScheme === 'mirabilis') {
      document.documentElement.removeAttribute('data-color-scheme');
    } else {
      document.documentElement.setAttribute('data-color-scheme', colorScheme);
    }
    safeStorageSet('mirabilis-color-scheme', colorScheme);
  }, [colorScheme]);

  // AuroraChrome listens for these to drive the StatusOrb busy state.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(isStreaming ? 'mirabilis:stream-start' : 'mirabilis:stream-stop'));
  }, [isStreaming]);

  // Spin the classic ICQ flower in the dock while a web search runs.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(webSearchStatus === 'searching' ? 'mirabilis:search-start' : 'mirabilis:search-stop'));
  }, [webSearchStatus]);

  useEffect(() => {
    safeStorageSet('local-ai-model', model);
  }, [model]);

  useEffect(() => {
    safeStorageSet('local-ai-system-prompt', systemPrompt);
  }, [systemPrompt]);

  useEffect(() => {
    safeStorageSet('mirabilis-prompt-profile-id', selectedPromptProfileId || UNSAVED_PROMPT_PROFILE_ID);
  }, [selectedPromptProfileId]);

  useEffect(() => {
    safeStorageSet('mirabilis-custom-prompt-profiles', JSON.stringify(customPromptProfiles));
  }, [customPromptProfiles]);

  useEffect(() => {
    if (!activeChatId) return undefined;
    if (promptAutosaveTimerRef.current) {
      clearTimeout(promptAutosaveTimerRef.current);
    }
    promptAutosaveTimerRef.current = setTimeout(() => {
      api(`/api/chats/${activeChatId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          systemPrompt,
          promptProfileId: selectedPromptProfileId === UNSAVED_PROMPT_PROFILE_ID ? '' : selectedPromptProfileId
        })
      }).catch(() => {});
    }, 350);

    return () => {
      if (promptAutosaveTimerRef.current) {
        clearTimeout(promptAutosaveTimerRef.current);
      }
    };
  }, [activeChatId, systemPrompt, selectedPromptProfileId]);

  useEffect(() => {
    safeStorageSet('local-ai-deep-web-enabled', String(deepWebEnabled));
    if (!deepWebEnabled) setWebSearchStatus('idle');
  }, [deepWebEnabled]);

  useEffect(() => {
    safeStorageSet('local-ai-canvas-enabled', String(canvasEnabled));
  }, [canvasEnabled]);

  useEffect(() => {
    safeStorageSet('local-ai-canvas-text', canvasText);
  }, [canvasText]);

  useEffect(() => {
    safeStorageSet('local-ai-guided-learning-enabled', String(guidedLearningEnabled));
  }, [guidedLearningEnabled]);

  useEffect(() => {
    safeStorageSet('local-ai-deep-thinking-enabled', String(deepThinkingEnabled));
  }, [deepThinkingEnabled]);

  useEffect(() => {
    safeStorageSet('mirabilis-effort-level', effortLevel);
  }, [effortLevel]);

  // Access replaced the per-run tool policy; drop its stored value. The backend
  // owns Access, so the chip loads the level from there.
  useEffect(() => {
    safeStorageRemove('mirabilis-tool-policy');
    let cancelled = false;
    fetchAccess()
      .then((a) => { if (!cancelled) appStore.setAccess(a.level); })
      .catch(() => { /* older backend: stay on Chat only */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    safeStorageSet('local-ai-training-mode', trainingMode);
  }, [trainingMode]);

  useEffect(() => {
    safeStorageSet('local-ai-use-personal-memory', String(usePersonalMemory));
  }, [usePersonalMemory]);

  async function refreshTrainingStats() {
    try {
      const payload = await api('/api/training/status');
      setTrainingStats({
        memoryItems: Number(payload.memoryItems || 0),
        fineTuningExamples: Number(payload.fineTuningExamples || 0)
      });
    } catch {
      setTrainingStats({ memoryItems: 0, fineTuningExamples: 0 });
    }
  }

  async function loadMemoryItems() {
    try {
      const payload = await api('/api/training/memory');
      setMemoryItems(payload.items || []);
    } catch {
      setMemoryItems([]);
    }
  }

  async function addMemoryItem() {
    const text = memoryInput.trim();
    if (!text) return;
    setMemoryInput('');
    await api('/api/training/memory', { method: 'POST', body: JSON.stringify({ text }) });
    await loadMemoryItems();
    await refreshTrainingStats();
  }

  async function deleteMemoryItem(id) {
    await api(`/api/training/memory/${id}`, { method: 'DELETE' });
    await loadMemoryItems();
    await refreshTrainingStats();
  }

  function exportTrainingExamples() {
    const url = `${API_BASE}/api/training/examples/export`;
    const a = document.createElement('a');
    a.href = url;
    a.download = 'training-examples.jsonl';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function checkRemoteStatus() {
    try {
      const payload = await api('/api/remote/status');
      setRemoteConnected(payload.connected || false);
      setRemoteTarget(payload.target || '');
    } catch {
      setRemoteConnected(false);
    }
  }

  async function connectRemote() {
    setRemoteConnecting(true);
    setRemoteError('');
    try {
      const body = remoteType === 'local'
        ? { type: 'local' }
        : { type: 'ssh', host: remoteHost, port: remotePort, user: remoteUser,
            authType: remoteAuthType,
            ...(remoteAuthType === 'password' ? { password: remotePassword } : {}),
            ...(remoteAuthType === 'key' ? { privateKeyPath: remoteKeyPath } : {}) };
      const payload = await api('/api/remote/connect', {
        method: 'POST', body: JSON.stringify(body)
      });
      setRemoteConnected(payload.connected || false);
      setRemoteTarget(payload.target || '');
      setRemotePassword(''); // don't keep password in state after connecting
    } catch (err) {
      setRemoteError(plainError(err.message));
      setStatusText(`Remote: ${plainError(err.message)}`);
    } finally {
      setRemoteConnecting(false);
    }
  }

  async function disconnectRemote() {
    try { await api('/api/remote/disconnect', { method: 'DELETE' }); } catch { /* ignore */ }
    setRemoteConnected(false);
    setRemoteTarget('');
  }

  async function runCommand(command, key) {
    if (!remoteConnected) return;
    setExecResults((prev) => ({ ...prev, [key]: { running: true, stdout: '', stderr: '', exitCode: null } }));
    try {
      const result = await api('/api/remote/exec', {
        method: 'POST', body: JSON.stringify({ command, timeout: 30000 })
      });
      setExecResults((prev) => ({ ...prev, [key]: { running: false, ...result } }));
    } catch (err) {
      setExecResults((prev) => ({ ...prev, [key]: { running: false, stdout: '', stderr: err.message, exitCode: 1 } }));
    }
  }

  // Stable identity so the context value below stays memoized.
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;
  const stableRunCommand = useCallback((command, key) => runCommandRef.current(command, key), []);

  // Recomputed only when something a code block actually displays changes.
  const remoteExecValue = useMemo(
    () => ({ remoteConnected, remoteTarget, execResults, onRunCommand: stableRunCommand }),
    [remoteConnected, remoteTarget, execResults, stableRunCommand]
  );

  // True while the assistant has been asked but has no text yet.
  const lastMessage = messages[messages.length - 1];
  const showTypingIndicator = isStreaming
    && !!lastMessage
    && lastMessage.role === 'assistant'
    && !lastMessage.content
    && !lastMessage.imageGenerating;

  // Settings opens on either tab, and these actions act on the chat view.
  function showChatTab() {
    try { window.dispatchEvent(new CustomEvent('mirabilis:set-tab', { detail: { tab: 'chat' } })); } catch { /* ignore */ }
  }

  function handleCreateImageTool() {
    // An explicit prompt reaches the image service at any Access level.
    setInput((current) => toImagePrompt(current));
    setStatusText(imageServiceAvailable ? 'Image prompt ready' : 'Image service offline');
    // Started from Settings: hand the prompt to the message box.
    showChatTab();
    appStore.closeSettings();
    requestAnimationFrame(() => {
      const el = composerInputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  async function uploadFiles(selectedFiles) {
    if (!selectedFiles.length || isUploadingFiles || isStreaming) {
      return;
    }

    setIsUploadingFiles(true);
    setStatusText('Uploading file(s)...');

    let chatId = activeChatId;
    try {
      if (!chatId) {
        const payload = await api('/api/chats', {
          method: 'POST',
          body: JSON.stringify({
            title: 'New Chat',
            uncensoredMode,
            systemPrompt,
            promptProfileId: selectedPromptProfileId === UNSAVED_PROMPT_PROFILE_ID ? '' : selectedPromptProfileId
          })
        });
        chatId = payload.chat.id;
        setActiveChatId(chatId);
      }

      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append('files', file));

      const response = await fetch(`${API_BASE}/api/chats/${chatId}/attachments`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const err = await response.text().catch(() => 'Attachment upload failed');
        throw new Error(err || 'Attachment upload failed');
      }

      const payload = await response.json();
      setMessages((prev) => [...prev, payload.message]);
      await refreshChats();
      await loadChat(chatId);
      setStatusText('Ready');
    } catch (error) {
      setStatusText(`Upload error: ${error.message}`);
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setIsUploadingFiles(false);
    }
  }

  function getDictationMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus'
    ];
    return candidates.find((mimeType) => window.MediaRecorder.isTypeSupported?.(mimeType)) || '';
  }

  async function transcribeDictationBlob(blob) {
    const formData = new FormData();
    const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    formData.append('audio', blob, `dictation.${extension}`);

    const response = await fetch(`${API_BASE}/api/voice/transcribe`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const payload = await response.text().catch(() => 'Transcription failed');
      throw new Error(payload || `Transcription failed (${response.status})`);
    }

    return response.json();
  }

  function clearDictationResources() {
    if (dictationRecorderRef.current) {
      try {
        dictationRecorderRef.current.ondataavailable = null;
        dictationRecorderRef.current.onstop = null;
        dictationRecorderRef.current.onerror = null;
      } catch {}
    }

    if (dictationStreamRef.current) {
      dictationStreamRef.current.getTracks().forEach((track) => track.stop());
    }

    dictationRecorderRef.current = null;
    dictationStreamRef.current = null;
    dictationChunksRef.current = [];
  }

  async function toggleDictation() {
    if (!dictationSupported) {
      setStatusText('Dictation unavailable');
      return;
    }

    const SR = typeof window !== 'undefined'
      ? (window.SpeechRecognition || window.webkitSpeechRecognition)
      : null;

    // Preferred path: browser Web Speech API - no server or Whisper needed.
    if (SR) {
      // Already listening: stop and let onend clean up.
      if (dictationRecognitionRef.current) {
        try {
          dictationRecognitionRef.current.stop();
        } catch {
          dictationRecognitionRef.current = null;
          dictationPhaseRef.current = 'idle';
          setIsDictating(false);
        }
        return;
      }

      try {
        const recognition = new SR();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

        dictationBaseRef.current = input && !input.endsWith(' ') ? `${input} ` : input;
        dictationRecognitionRef.current = recognition;
        dictationPhaseRef.current = 'listening';

        recognition.onstart = () => {
          setIsDictating(true);
          setStatusText('Listening...');
        };

        recognition.onresult = (event) => {
          let transcript = '';
          for (let i = 0; i < event.results.length; i += 1) {
            transcript += event.results[i][0].transcript;
          }
          setInput(`${dictationBaseRef.current}${transcript.trim()}`);
        };

        recognition.onerror = (event) => {
          const code = event?.error || 'unknown';
          dictationRecognitionRef.current = null;
          dictationPhaseRef.current = 'idle';
          setIsDictating(false);
          if (code === 'no-speech') {
            setStatusText('No speech detected');
          } else if (code === 'aborted') {
            setStatusText('Ready');
          } else if (code === 'not-allowed' || code === 'service-not-allowed') {
            setStatusText('Microphone access denied');
            appStore.toast('Microphone access denied', { kind: 'error' });
          } else {
            setStatusText('Dictation failed');
            appStore.toast('Dictation failed. Try again.', { kind: 'error' });
          }
        };

        recognition.onend = () => {
          dictationRecognitionRef.current = null;
          dictationPhaseRef.current = 'idle';
          setIsDictating(false);
          setStatusText((prev) => (prev === 'Listening...' ? 'Ready' : prev));
        };

        recognition.start();
      } catch (error) {
        dictationRecognitionRef.current = null;
        dictationPhaseRef.current = 'idle';
        setIsDictating(false);
        setStatusText(`Dictation error: ${error?.message || 'unknown'}`);
        appStore.toast('Dictation could not start', { kind: 'error' });
      }
      return;
    }

    if (dictationPhaseRef.current === 'transcribing') {
      setStatusText('Transcribing...');
      return;
    }

    if (dictationPhaseRef.current === 'recording' && dictationRecorderRef.current) {
      try {
        dictationRecorderRef.current.stop();
      } catch (error) {
        setStatusText(`Dictation error: ${error.message}`);
      }
      return;
    }

    const mediaDevices = navigator.mediaDevices;
    const MediaRecorderCtor = window.MediaRecorder;
    if (!mediaDevices?.getUserMedia || !MediaRecorderCtor) {
      setStatusText('Dictation unavailable');
      return;
    }

    try {
      const stream = await mediaDevices.getUserMedia({ audio: true });
      const mimeType = getDictationMimeType();
      const recorder = mimeType ? new MediaRecorderCtor(stream, { mimeType }) : new MediaRecorderCtor(stream);

      dictationBaseRef.current = input && !input.endsWith(' ') ? `${input} ` : input;
      dictationChunksRef.current = [];
      dictationStreamRef.current = stream;
      dictationRecorderRef.current = recorder;
      dictationPhaseRef.current = 'recording';

      recorder.onstart = () => {
        setIsDictating(true);
        setStatusText('Recording...');
      };

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          dictationChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        const msg = event.error?.message || event.error || 'unknown';
        setStatusText(`Dictation error: ${msg}`);
      };

      recorder.onstop = async () => {
        dictationPhaseRef.current = 'transcribing';
        setStatusText('Transcribing...');

        try {
          const blob = new Blob(dictationChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
          if (!blob.size) {
            throw new Error('No audio captured');
          }

          const payload = await transcribeDictationBlob(blob);
          const transcript = String(payload?.text || '').trim();
          if (transcript) {
            setInput(`${dictationBaseRef.current}${transcript}`);
            setStatusText('Ready');
          } else {
            setStatusText('No speech detected');
          }
        } catch (error) {
          setStatusText(`Dictation error: ${error.message}`);
          appStore.toast('Could not transcribe. Install speech to text in Settings > Voice.', { kind: 'error', ttl: 5200 });
        } finally {
          clearDictationResources();
          dictationPhaseRef.current = 'idle';
          setIsDictating(false);
        }
      };

      recorder.start();
    } catch (error) {
      clearDictationResources();
      dictationPhaseRef.current = 'idle';
      setIsDictating(false);
      const message = error?.name === 'NotAllowedError'
        ? 'microphone access denied (System Settings > Privacy & Security > Microphone)'
        : error.message || 'unknown';
      setStatusText(`Dictation error: ${message}`);
    }
  }

  async function handleAttachFiles(event) {
    const selectedFiles = Array.from(event.target.files || []);
    await uploadFiles(selectedFiles);
  }

  function handleChatDragEnter(event) {
    if (!event.dataTransfer?.types?.includes('Files')) {
      return;
    }
    event.preventDefault();
    dragCounterRef.current += 1;
    setIsDragOverChat(true);
  }

  function handleChatDragOver(event) {
    if (!event.dataTransfer?.types?.includes('Files')) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDragOverChat(true);
  }

  function handleChatDragLeave(event) {
    if (!event.dataTransfer?.types?.includes('Files')) {
      return;
    }
    event.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDragOverChat(false);
    }
  }

  async function handleChatDrop(event) {
    if (!event.dataTransfer?.files?.length) {
      return;
    }
    event.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOverChat(false);
    const droppedFiles = Array.from(event.dataTransfer.files || []);
    await uploadFiles(droppedFiles);
  }

  async function refreshChats() {
    const epoch = chatListEpochRef.current;
    const payload = await api('/api/chats');
    // clearAllChats() ran during the await; applying this would restore deleted chats.
    if (chatListEpochRef.current !== epoch) return;
    setChats(payload.chats || []);
  }

  async function loadChat(chatId) {
    // Stop the stream first or its tokens land in the newly opened chat.
    if (streamAbortRef.current) stopStreaming();
    // Drop a finished run's panel; a live run keeps it so Stop stays reachable.
    if (!agentAbortRef.current) setAgentRun(null);
    setIsTeachPanelOpen(false);
    // Save scroll position of the current chat before switching
    const leavingChatId = activeChatIdRef.current;
    if (leavingChatId && messagesScrollRef.current) {
      chatScrollPositions.current[leavingChatId] = messagesScrollRef.current.scrollTop;
    }
    const payload = await api(`/api/chats/${chatId}`);
    setActiveChatId(chatId);
    setActiveChatMeta(payload.chat || null);
    const snapshots = Array.isArray(payload.chat?.snapshots) ? payload.chat.snapshots : [];
    setSelectedSnapshotId(snapshots[snapshots.length - 1]?.id || '');
    setMessages(payload.chat?.messages || []);
    setUncensoredMode(payload.chat?.uncensoredMode === true);
    const nextPromptProfileId = normalizePromptProfileId(payload.chat?.promptProfileId) || 'mirabilis-default';
    setSelectedPromptProfileId(nextPromptProfileId);
    if (payload.chat && Object.prototype.hasOwnProperty.call(payload.chat, 'systemPrompt')) {
      setSystemPrompt(typeof payload.chat.systemPrompt === 'string' ? payload.chat.systemPrompt : '');
    } else {
      const matchingProfile = findPromptProfile(promptProfiles, nextPromptProfileId);
      setSystemPrompt(matchingProfile?.content || buildDefaultSystemPrompt(provider));
    }
    // Restore saved scroll, or jump to bottom for new chats
    requestAnimationFrame(() => {
      if (!messagesScrollRef.current) return;
      const saved = chatScrollPositions.current[chatId];
      if (saved !== undefined) {
        messagesScrollRef.current.scrollTop = saved;
      } else {
        messagesScrollRef.current.scrollTop = messagesScrollRef.current.scrollHeight;
      }
    });
  }

  async function createChat({ ephemeral = false } = {}) {
    // Stop any in-progress stream so its tokens do not bleed into the new chat.
    if (streamAbortRef.current) stopStreaming();
    const payload = await api('/api/chats', {
      method: 'POST',
      body: JSON.stringify({
        title: ephemeral ? 'Off the Record' : 'New Chat',
        uncensoredMode,
        systemPrompt,
        promptProfileId: selectedPromptProfileId === UNSAVED_PROMPT_PROFILE_ID ? '' : selectedPromptProfileId,
        // Off-the-Record: this chat is kept in memory only and never written to disk.
        ...(ephemeral === true ? { ephemeral: true } : {})
      })
    });
    setChatSearch('');
    await refreshChats();
    await loadChat(payload.chat.id);
    if (ephemeral) {
      appStore.toast('Off the Record: never saved to disk', { kind: 'info', ttl: 4200 });
    }
  }

  async function toggleUncensoredMode() {
    const next = !uncensoredMode;
    setUncensoredMode(next);
    if (!next) {
      setOpenClawMode(false);
    }
    if (!activeChatId) {
      setStatusText(next ? 'Uncensored on' : 'Uncensored off');
      return;
    }
    try {
      await api(`/api/chats/${activeChatId}`, {
        method: 'PATCH',
        body: JSON.stringify({ uncensoredMode: next })
      });
      if (next && provider === 'ollama') {
        const best = pickUncensoredModel(models);
        if (best?.id && best.id !== model) {
          setModel(best.id);
          setStatusText(`Uncensored on: ${best.label || best.id}`);
          await refreshChats();
          return;
        }
      }
      setStatusText(next ? 'Uncensored on' : 'Uncensored off');
      await refreshChats();
    } catch (error) {
      setStatusText(`Mode update failed: ${error.message}`);
      setUncensoredMode(!next);
    }
  }

  async function toggleOpenClawMode() {
    const next = !openClawMode;
    setOpenClawMode(next);

    if (next) {
      setUncensoredMode(true);
      setUsePersonalMemory(false);
      setSelectedPromptProfileId(UNSAVED_PROMPT_PROFILE_ID);
      setSystemPrompt('');

      if (!activeChatId) {
        setStatusText('OpenClaw on');
        return;
      }

      try {
        await api(`/api/chats/${activeChatId}`, {
          method: 'PATCH',
          body: JSON.stringify({ uncensoredMode: true })
        });
        setStatusText('OpenClaw on');
        await refreshChats();
      } catch (error) {
        setStatusText(`OpenClaw update failed: ${error.message}`);
        setOpenClawMode(false);
      }
      return;
    }

    setUsePersonalMemory(true);
    if (!systemPrompt.trim()) {
      setSelectedPromptProfileId('mirabilis-default');
      setSystemPrompt(buildDefaultSystemPrompt(provider));
    }

    if (!activeChatId) {
      setStatusText('OpenClaw off');
      return;
    }

    try {
      await api(`/api/chats/${activeChatId}`, {
        method: 'PATCH',
        body: JSON.stringify({ uncensoredMode: false })
      });
      setUncensoredMode(false);
      setStatusText('OpenClaw off');
      await refreshChats();
    } catch (error) {
      setStatusText(`OpenClaw update failed: ${error.message}`);
      setOpenClawMode(true);
    }
  }

  async function removeChat(chatId) {
    // From the ref: a memoized ChatItem may hold a removeChat with a stale activeChatId.
    const currentChatId = activeChatIdRef.current;
    // Abort first so the post-stream saveChat cannot re-create the chat.
    if (currentChatId === chatId) stopStreaming();
    await api(`/api/chats/${chatId}`, { method: 'DELETE' });
    setOpenChatMenuId((current) => (current === chatId ? null : current));
    if (currentChatId === chatId) {
      setActiveChatId(null);
      setActiveChatMeta(null);
      setSelectedSnapshotId('');
      setMessages([]);
    }
    await refreshChats();
  }

  async function clearAllChats() {
    // Abort first, or the post-stream saveChat re-adds the last chat after the DELETE.
    stopStreaming();
    chatListEpochRef.current++; // invalidate any in-flight refreshChats() calls
    setActiveChatId(null);
    setActiveChatMeta(null);
    setSelectedSnapshotId('');
    setMessages([]);
    setChats([]);
    setChatSearch('');
    try {
      await api('/api/chats', { method: 'DELETE' });
    } catch {
      // UI is already empty.
    }
  }

  async function renameChat(chatId, newTitle) {
    try {
      await api(`/api/chats/${chatId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: newTitle }),
      });
      setChats((prev) => prev.map((c) => c.id === chatId ? { ...c, title: newTitle } : c));
    } catch (err) {
      setStatusText(`Rename failed: ${err.message}`);
    }
  }

  function togglePin(chatId) {
    setPinnedChatIds((prev) => {
      const next = new Set(prev);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      return next;
    });
  }

  async function branchChat(chatId = activeChatId) {
    const targetChatId = chatId || activeChatId;
    if (!targetChatId) return;
    try {
      const payload = await api(`/api/chats/${targetChatId}/branch`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      await refreshChats();
      await loadChat(payload.chat.id);
      setStatusText('Branch created');
    } catch (error) {
      setStatusText(`Branch failed: ${error.message}`);
    }
  }

  async function saveSnapshot() {
    if (!activeChatId) {
      setStatusText('Open a chat first');
      return;
    }
    try {
      const payload = await api(`/api/chats/${activeChatId}/snapshots`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      setActiveChatMeta(payload.chat || null);
      setSelectedSnapshotId(payload.snapshot?.id || '');
      await refreshChats();
      setStatusText('Snapshot saved');
    } catch (error) {
      setStatusText(`Snapshot failed: ${error.message}`);
    }
  }

  async function restoreSnapshot() {
    if (!activeChatId || !selectedSnapshotId) {
      setStatusText('Select a snapshot first');
      return;
    }
    const confirmed = window.confirm('Restore this snapshot? It replaces the current chat.');
    if (!confirmed) return;
    try {
      await api(`/api/chats/${activeChatId}/snapshots/${selectedSnapshotId}/restore`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      await refreshChats();
      await loadChat(activeChatId);
      setStatusText('Snapshot restored');
    } catch (error) {
      setStatusText(`Restore failed: ${error.message}`);
    }
  }

  function handleSystemPromptChange(value) {
    setSystemPrompt(value);
    if (selectedPromptProfile && value === selectedPromptProfile.content) {
      return;
    }
    setSelectedPromptProfileId(UNSAVED_PROMPT_PROFILE_ID);
  }

  function applyPromptProfile(profileId) {
    if (profileId === UNSAVED_PROMPT_PROFILE_ID) {
      setSelectedPromptProfileId(UNSAVED_PROMPT_PROFILE_ID);
      return;
    }
    const profile = findPromptProfile(promptProfiles, profileId);
    if (!profile) return;
    setSelectedPromptProfileId(profile.id);
    setSystemPrompt(profile.content);
    setStatusText(`Profile loaded: ${profile.label}`);
  }

  function saveCurrentPromptProfile() {
    const prompt = systemPrompt.trim();
    if (!prompt) {
      setStatusText('Instructions are empty');
      return;
    }
    const name = window.prompt('Profile name');
    if (!name) return;
    const label = name.trim().slice(0, 60);
    if (!label) return;
    const description = window.prompt('Description (optional)') || '';
    const slugBase = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile';
    const id = `custom-${slugBase}-${Date.now().toString(36)}`;
    const nextProfile = {
      id,
      label,
      description: description.trim().slice(0, 120),
      prompt
    };
    setCustomPromptProfiles((prev) => [...prev, nextProfile]);
    setSelectedPromptProfileId(id);
    setStatusText(`Profile saved: ${label}`);
  }

  function deleteSelectedPromptProfile() {
    const selected = findPromptProfile(promptProfiles, selectedPromptProfileId);
    if (!selected || selected.isBuiltin) return;
    const confirmed = window.confirm(`Delete profile "${selected.label}"?`);
    if (!confirmed) return;
    setCustomPromptProfiles((prev) => prev.filter((profile) => profile.id !== selected.id));
    setSelectedPromptProfileId(UNSAVED_PROMPT_PROFILE_ID);
    setStatusText(`Profile deleted: ${selected.label}`);
  }

  async function exportChat(chatId) {
    try {
      const payload = await api(`/api/chats/${chatId}`);
      const chat = payload.chat;
      const lines = [`# ${chat.title}\n`];
      for (const msg of chat.messages || []) {
        const role = msg.role === 'user' ? 'You' : 'Assistant';
        const time = msg.createdAt ? new Date(msg.createdAt).toLocaleString() : '';
        lines.push(`## ${role}${time ? ` - ${time}` : ''}\n`);
        lines.push(`${msg.content || ''}\n`);
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(chat.title || 'chat').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '')}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setStatusText(`Export failed: ${err.message}`);
    }
  }

  async function checkImageService() {
    try {
      const payload = await api('/api/image-service/status');
      const available = payload.available === true;
      setImageServiceAvailable((prev) => prev === available ? prev : available);
      if (available) {
        const dev = payload.device || '';
        const label = dev === 'mps' ? 'MPS' : dev.startsWith('cuda') ? 'NVIDIA' : dev === 'cpu' ? 'CPU' : (dev || 'GPU');
        setImageServiceDevice((prev) => prev === label ? prev : label);
      } else {
        setImageServiceDevice((prev) => prev === null ? prev : null);
      }
    } catch {
      setImageServiceAvailable((prev) => prev === false ? prev : false);
      setImageServiceDevice((prev) => prev === null ? prev : null);
    }
  }

  async function checkHardwareProfile() {
    try {
      const payload = await api('/api/system/hardware-profile');
      setHardwareProfile({
        compute: payload.compute || null,
        npu: payload.npu || null,
        logic: payload.logic || null,
        memory: payload.memory || null,
        action: payload.action || { label: 'Engine', options: [] }
      });
      setSelectedEngine((current) => {
        const options = Array.isArray(payload.action?.options) ? payload.action.options : [];
        if (current && options.includes(current)) {
          return current;
        }
        return options[0] || '';
      });
    } catch {
      // Profile detection failed: still expose processor details.
      try {
        const specs = await api('/api/system/specs');
        const cpuModel = String(specs?.cpuModel || specs?.arch || '').trim();
        const cpuCores = Number(specs?.cpuCores) || 1;
        const cpuThreads = Number(specs?.cpuThreads) || cpuCores;
        const archName = String(specs?.arch || '').trim();
        const platform = String(specs?.platform || '').trim();
        const ramGb = Number(specs?.ramGb);
        const ramLabel = Number.isFinite(ramGb) && ramGb > 0 ? `${ramGb} GB` : 'Unknown';

        setHardwareProfile({
          compute: null,
          npu: null,
          logic: {
            label: `${cpuModel || 'Processor'} | ${cpuCores}C/${cpuThreads}T`,
            expanded: [
              archName ? `Arch: ${archName}` : null,
              platform ? `Platform: ${platform}` : null
            ].filter(Boolean).join('\n')
          },
          memory: {
            label: `${ramLabel} | System RAM`,
            expanded: `Size: ${ramLabel}`
          },
          action: { label: 'Engine', options: ['CPU'] }
        });
        setSelectedEngine((current) => current || 'CPU');
      } catch {
        setHardwareProfile({
          compute: null,
          npu: null,
          logic: null,
          memory: null,
          action: { label: 'Engine', options: [] }
        });
      }
    }
  }

  function setOllamaList(list) {
    ollamaModelsRef.current = list;
    setOllamaModels(list);
  }

  // Memory and platform for fit chips and MLX builds; tried again until the backend answers.
  const specsLoadedRef = useRef(false);
  async function loadDeviceSpecs() {
    if (specsLoadedRef.current) return;
    specsLoadedRef.current = true;
    try {
      const specs = await api('/api/system/specs');
      const ram = Number(specs?.ramGb);
      if (Number.isFinite(ram) && ram > 0) setDeviceRamGb(ram);
      setAppleSilicon(specs?.platform === 'darwin' && specs?.arch === 'arm64');
    } catch {
      specsLoadedRef.current = false; // fit chips just won't show yet
    }
  }

  // Lists the chat provider's models; for Ollama the same list feeds Settings > Models.
  async function refreshModels() {
    const forProvider = provider;
    try {
      const query = new URLSearchParams({ provider: String(provider || '').trim() });
      let keyHeader;
      if (provider !== 'ollama') {
        const baseUrl = provider === 'gemini'
          ? normalizeGeminiBaseUrl(providerConfigs?.[provider]?.baseUrl || '')
          : String(providerConfigs?.[provider]?.baseUrl || '').trim();
        const apiKey = String(providerConfigs?.[provider]?.apiKey || '').trim();
        if (baseUrl) query.set('baseUrl', baseUrl);
        // Key in a header, never the URL.
        if ((provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas' || provider === 'openai-compatible' || provider === 'vllm') && apiKey) keyHeader = { 'x-provider-key': apiKey };
      }
      const payload = await api(`/api/models?${query.toString()}`, keyHeader ? { headers: keyHeader } : undefined);
      const available = Array.isArray(payload?.models) ? payload.models : [];
      setModels(available);
      if (forProvider === 'ollama') setOllamaList(available);
      // 'auto' resolves at send time; fall back only if the chosen model is gone.
      setModel((currentModel) => {
        if (currentModel === 'auto') return 'auto';
        const stillInstalled = available.some((item) => item.id === currentModel && item.available !== false);
        if (stillInstalled) return currentModel;
        return 'auto';
      });
      return available;
    } catch {
      setModels([]);
      return [];
    } finally {
      loadDeviceSpecs();
    }
  }

  // The Ollama list for Settings > Models while chats use another provider.
  async function refreshOllamaModels() {
    if (provider === 'ollama') return refreshModels();
    try {
      const payload = await api('/api/models?provider=ollama');
      const list = Array.isArray(payload?.models) ? payload.models : [];
      setOllamaList(list);
      return list;
    } catch {
      return ollamaModelsRef.current;
    }
  }

  // An install, update or delete finished: the picker, Auto and Settings > Models catch up.
  function modelsChanged() {
    refreshOllamaModels();
    setModelsRevision((n) => n + 1);
  }

  async function refreshVaultStatus() {
    try {
      const s = await api('/api/vault/status');
      if (s?.ok) setConfigVaultStatus(s);
    } catch { /* best effort */ }
  }

  async function indexConfigVault() {
    const folder = String(configVaultFolder || '').trim();
    if (!folder) { setConfigVaultMsg('Enter a folder path'); return; }
    setConfigVaultBusy(true);
    setConfigVaultMsg('Indexing...');
    try {
      const r = await api('/api/vault/index', { method: 'POST', body: JSON.stringify({ path: folder }) });
      if (r?.ok) {
        setConfigVaultStatus({ ok: true, root: r.root, builtAt: new Date().toISOString(), embedModel: r.embedModel, fileCount: r.fileCount, chunkCount: r.chunkCount });
        // The counts show on the row above; only the chunk cap needs a word here.
        setConfigVaultMsg(r.truncated ? 'Chunk limit reached. Index a smaller folder.' : 'Indexed');
      } else {
        setConfigVaultMsg(r?.error || 'Indexing failed');
      }
    } catch (error) {
      setConfigVaultMsg(`Indexing failed: ${plainError(error.message)}`);
    } finally {
      setConfigVaultBusy(false);
    }
  }

  async function clearConfigVault() {
    setConfigVaultBusy(true);
    try {
      await api('/api/vault/index', { method: 'DELETE' });
      setConfigVaultStatus({ ok: true, root: '', builtAt: null, embedModel: null, fileCount: 0, chunkCount: 0 });
      setConfigVaultMsg('Index cleared');
    } catch (error) {
      setConfigVaultMsg(`Clear failed: ${plainError(error.message)}`);
    } finally {
      setConfigVaultBusy(false);
    }
  }

  // Throws a plain sentence and opens the endpoint config when a cloud key is
  // missing. A key counts whether the backend or the page holds it.
  async function ensureProviderKey() {
    const pageKey = String(providerConfigs[provider]?.apiKey || '').trim();
    if (!providerNeedsKey(provider) || hasUsableKey(provider, { pageKey, hints: keyHints })) return;
    // Confirm with the server before refusing; hints may not have loaded yet.
    const fresh = await refreshKeyHints();
    if (!hasUsableKey(provider, { pageKey, hints: fresh || {} })) {
      setIsProviderConfigOpen(true);
      throw new Error(missingKeyMessage(provider));
    }
  }

  async function resolveProviderForSend() {
    if (provider === 'ollama') {
      const forcedUncensored = uncensoredMode ? pickUncensoredModel(models) : null;
      const contextTokens = contextUsage?.totalTokens || 0;
      const resolvedAuto = model === 'auto' ? (pickAutoModel(models, contextTokens)?.id || '') : model;
      const effectiveModel = forcedUncensored?.id || resolvedAuto;
      if (uncensoredMode && forcedUncensored?.id && model !== forcedUncensored.id) {
        setModel(forcedUncensored.id);
      }
      return { provider: 'ollama', model: effectiveModel, providerBaseUrl: undefined, providerApiKey: undefined };
    }

    const effectiveNonOllamaModel = model === 'auto' ? cloudAutoModel(models) : model;

    await ensureProviderKey();
    const configuredApiKey = String(providerConfigs[provider]?.apiKey || '').trim();

    const configuredBaseUrl = provider === 'gemini'
      ? normalizeGeminiBaseUrl(providerConfigs[provider]?.baseUrl || '')
      : String(providerConfigs[provider]?.baseUrl || '').trim();
    const query = new URLSearchParams({ provider });
    if (configuredBaseUrl) {
      query.set('baseUrl', configuredBaseUrl);
    }
    // Key in a header, never the URL.
    const keyHeader = ((provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas' || provider === 'openai-compatible' || provider === 'vllm') && configuredApiKey)
      ? { 'x-provider-key': configuredApiKey } : undefined;

    try {
      const payload = await api(`/api/providers/health?${query.toString()}`, keyHeader ? { headers: keyHeader } : undefined);
      if (payload?.reachable) {
        return {
          provider,
          model: effectiveNonOllamaModel,
          providerBaseUrl: providerConfigs[provider]?.baseUrl || undefined,
          providerApiKey: undefined, // held by the backend; never sent from the page
        };
      }

      const hint = payload?.hint ? ` ${payload.hint}` : '';
      const target = payload?.baseUrl || configuredBaseUrl || 'Endpoint';
      setStatusText(`${target} is unreachable.${hint}`);
      return {
        provider,
        model: effectiveNonOllamaModel,
        providerBaseUrl: providerConfigs[provider]?.baseUrl || undefined,
        providerApiKey: undefined, // held by the backend; never sent from the page
      };
    } catch (error) {
      setStatusText(`Provider check failed: ${error.message}`);
      return {
        provider,
        model: effectiveNonOllamaModel,
        providerBaseUrl: providerConfigs[provider]?.baseUrl || undefined,
        providerApiKey: undefined // held by the backend; never sent from the page
      };
    }
  }

  // Fresh each render, for poll loops that outlive the render that started them.
  const modelsChangedRef = useRef(null);
  modelsChangedRef.current = modelsChanged;

  function dropPulling(rowId) {
    setPullingModels((prev) => {
      if (!(rowId in prev)) return prev;
      const next = { ...prev };
      delete next[rowId];
      return next;
    });
  }

  function dismissInstallError(rowId) {
    setInstallErrors((prev) => {
      if (!(rowId in prev)) return prev;
      const next = { ...prev };
      delete next[rowId];
      return next;
    });
  }

  // The job ended on the backend; a cancel from here never reaches this.
  function finishJob(rowId, watcher, name, status, error) {
    if (jobWatchersRef.current.get(rowId) === watcher) jobWatchersRef.current.delete(rowId);
    dropPulling(rowId);
    const update = watcher?.update === true;
    if (status === 'completed') {
      setStatusText(`Model ${update ? 'updated' : 'installed'}: ${name}`);
      appStore.toast(`${update ? 'Updated' : 'Installed'} ${name}`, { kind: 'success' });
      modelsChangedRef.current?.();
    } else if (status === 'canceled') {
      setStatusText(`Model ${update ? 'update' : 'install'} cancelled: ${name}`);
    } else {
      const sentence = plainError(error, `${update ? 'Update' : 'Install'} failed. Try again.`);
      setInstallErrors((prev) => ({ ...prev, [rowId]: { name, error: sentence } }));
      setStatusText(`Model ${update ? 'update' : 'install'} failed: ${sentence}`);
      appStore.toast(`Could not ${update ? 'update' : 'install'} ${name}`, { kind: 'error' });
    }
  }

  // One poll loop per row, shared by the picker and Settings > Models. The job
  // runs on the backend, so closing either view does not stop it.
  async function watchJob(firstJob, rowId, name, watcher) {
    const live = () => jobWatchersRef.current.get(rowId) === watcher;
    const end = await followInstallJob(firstJob, {
      signal: watcher.ctrl.signal,
      intervalMs: JOB_POLL_MS,
      retries: JOB_POLL_RETRIES,
      describe: (err) => modelErrorText(err, ''),
      onProgress: (job) => setPullingModels((prev) => (!live() ? prev : {
        ...prev,
        [rowId]: {
          name,
          jobId: job.id,
          status: job.status,
          pct: job.pct,
          completedBytes: job.completedBytes,
          totalBytes: job.totalBytes,
          bytesPerSec: job.bytesPerSec,
          etaSec: job.etaSec
        }
      }))
    });
    if (end.status !== 'aborted' && live()) finishJob(rowId, watcher, name, end.status, end.error);
  }

  // Installs or updates one Ollama model, from the picker or Settings > Models,
  // whatever provider chats use. Updating is a new pull of the same name.
  async function installModel(name, rowId = rowIdForName(name, ollamaModelsRef.current)) {
    const pull = String(name || '').trim();
    if (!pull || !rowId || jobWatchersRef.current.has(rowId)) return;
    if (appStore.getGoDark()) {
      setStatusText(GO_DARK_INSTALL);
      return;
    }
    const watcher = { ctrl: new AbortController(), jobId: null, update: isInstalledName(pull, ollamaModelsRef.current) };
    jobWatchersRef.current.set(rowId, watcher);
    dismissInstallError(rowId);
    setPullingModels((prev) => ({
      ...prev,
      [rowId]: { name: pull, jobId: null, status: 'queued', pct: null, completedBytes: null, totalBytes: null, bytesPerSec: null, etaSec: null }
    }));
    let job;
    try {
      job = await startInstallJob(pull);
      if (!job.id) throw new Error('Install did not start. Try again.');
    } catch (err) {
      if (jobWatchersRef.current.get(rowId) === watcher) finishJob(rowId, watcher, pull, 'failed', modelErrorText(err, ''));
      return;
    }
    // Canceled while the request was in flight: the job exists now, so stop it too.
    if (watcher.ctrl.signal.aborted) {
      cancelInstallJob(job.id).catch(() => {});
      return;
    }
    watcher.jobId = job.id;
    watchJob(job, rowId, pull, watcher);
  }

  function cancelInstall(rowId) {
    const watcher = jobWatchersRef.current.get(rowId);
    jobWatchersRef.current.delete(rowId);
    watcher?.ctrl.abort();
    if (watcher?.jobId) cancelInstallJob(watcher.jobId).catch(() => {});
    dropPulling(rowId);
    setStatusText(`Model ${watcher?.update ? 'update' : 'install'} cancelled: ${pullingModels[rowId]?.name || rowId}`);
  }

  // Settings > Models confirms first. Resolves to '' or the sentence the row shows.
  async function deleteOllamaModel(name) {
    try {
      await deleteInstalledModel(name);
    } catch (err) {
      return modelErrorText(err, 'Delete failed. Try again.');
    }
    setStatusText(`Removed: ${name}`);
    appStore.toast(`Deleted ${name}`, { kind: 'success' });
    modelsChanged();
    return '';
  }

  function openModelManager() {
    setIsModelMenuOpen(false);
    setModelsView('discover');
    appStore.openSettings('models');
  }

    function closeAllDropdowns() {
      setIsProviderMenuOpen(false);
      setIsProviderConfigOpen(false);
      setIsModelMenuOpen(false);
      setIsContextPanelOpen(false);
      setOpenHardwarePopover(null);
      setIsEffortMenuOpen(false);
      setIsAccessMenuOpen(false);
      setOpenChatMenuId(null);
    }

    const anyDropdownOpen = isProviderMenuOpen || isProviderConfigOpen || isModelMenuOpen ||
      isContextPanelOpen || openHardwarePopover !== null || isEffortMenuOpen || isAccessMenuOpen;

    const activeMenuKey = isProviderMenuOpen
      ? 'provider'
      : isModelMenuOpen
      ? 'model'
      : isEffortMenuOpen
      ? 'effort'
      : isAccessMenuOpen
      ? 'access'
      : isContextPanelOpen
      ? 'context'
      : openHardwarePopover
      ? `hardware-${openHardwarePopover}`
      : null;

    function getFocusableElements(container) {
      if (!container) return [];
      return Array.from(
        container.querySelectorAll(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
    }

    useEffect(() => {
      if (!activeMenuKey) return undefined;
      const panel = document.querySelector(`[data-menu-panel="${activeMenuKey}"]`);
      const trigger = document.querySelector(`[data-menu-trigger="${activeMenuKey}"]`);
      if (trigger instanceof HTMLElement) {
        lastKeyboardMenuTriggerRef.current = trigger;
      }

      if (panel instanceof HTMLElement) {
        requestAnimationFrame(() => {
          // A menu with a current choice opens on it.
          const current = panel.querySelector('[aria-checked="true"]');
          const focusable = getFocusableElements(panel);
          if (current instanceof HTMLElement) {
            current.focus();
          } else if (focusable.length > 0) {
            focusable[0].focus();
          } else {
            panel.focus();
          }
        });
      }

      function handleTabTrap(e) {
        if (e.key !== 'Tab') return;
        const activePanel = document.querySelector(`[data-menu-panel="${activeMenuKey}"]`);
        if (!(activePanel instanceof HTMLElement)) return;
        const focusable = getFocusableElements(activePanel);
        if (focusable.length === 0) {
          e.preventDefault();
          activePanel.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }

      document.addEventListener('keydown', handleTabTrap);
      return () => {
        document.removeEventListener('keydown', handleTabTrap);
      };
    }, [activeMenuKey]);

    // Global Escape + click-outside closes any open menu
    useEffect(() => {
      if (!anyDropdownOpen) return undefined;
      function handlePointerDown(e) {
        if (!e.target.closest('[data-menu-container]')) {
          closeAllDropdowns();
        }
      }
      function handleKeyDown(e) {
        if (e.key === 'Escape') {
          const trigger = activeMenuKey
            ? document.querySelector(`[data-menu-trigger="${activeMenuKey}"]`)
            : null;
          closeAllDropdowns();
          if (trigger instanceof HTMLElement) {
            requestAnimationFrame(() => trigger.focus());
          } else if (lastKeyboardMenuTriggerRef.current instanceof HTMLElement) {
            requestAnimationFrame(() => lastKeyboardMenuTriggerRef.current.focus());
          }
        }
      }
      document.addEventListener('pointerdown', handlePointerDown);
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('pointerdown', handlePointerDown);
        document.removeEventListener('keydown', handleKeyDown);
      };
    }, [activeMenuKey, anyDropdownOpen]);

  // Close chat item three-dot menu when clicking outside that specific item
  useEffect(() => {
    if (!openChatMenuId) return undefined;
    function handlePointerDown(e) {
      if (!e.target.closest(`[data-chat-item="${openChatMenuId}"]`)) {
        setOpenChatMenuId(null);
      }
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') setOpenChatMenuId(null);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openChatMenuId]);

  useEffect(() => {
    refreshChats().catch(() => setStatusText('Failed to load chats'));
  }, []);

  useEffect(() => {
    checkImageService();
    checkHardwareProfile();
    checkVoiceTools();
    refreshTrainingStats();
    checkRemoteStatus();

    async function fetchUtilization() {
      try {
        const data = await api('/api/system/utilization');
        setUtilization({ cpuPct: data.cpuPct ?? 0, memPct: data.memPct ?? 0 });
      } catch { /* non-critical */ }
    }

    fetchUtilization();
    // Hardware profile is cached server-side; only the image service is re-polled.
    const interval = setInterval(() => {
      checkImageService();
    }, 30000);
    const utilInterval = setInterval(fetchUtilization, 15000);
    return () => { clearInterval(interval); clearInterval(utilInterval); };
  }, []);

  // Re-probe on panel open so it can offer a local launch or explain why not.
  useEffect(() => {
    if (provider === 'vllm') checkVllmStatus();
    if (provider === 'llamacpp') checkLlamacppStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, isProviderConfigOpen]);

  // Re-list models when the config panel closes; a base-URL edit is not a provider change.
  const prevProviderConfigOpenRef = useRef(false);
  useEffect(() => {
    if (prevProviderConfigOpenRef.current && !isProviderConfigOpen && provider !== 'ollama') {
      refreshModels();
    }
    prevProviderConfigOpenRef.current = isProviderConfigOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProviderConfigOpen]);

  useEffect(() => {
    refreshModels();
  }, [provider]);

  // Install jobs run on the backend and outlive a reload; their progress is
  // picked back up here, on the rows that started them.
  useEffect(() => {
    let alive = true;
    const watchers = jobWatchersRef.current;
    (async () => {
      const running = (await listInstallJobs().catch(() => [])).filter((job) => !job.done);
      if (!alive || running.length === 0) return;
      const rows = await refreshOllamaModels();
      if (!alive) return;
      for (const job of running) {
        const rowId = rowIdForName(job.modelId, rows);
        if (!rowId || watchers.has(rowId)) continue;
        const watcher = { ctrl: new AbortController(), jobId: job.id, update: isInstalledName(job.modelId, rows) };
        watchers.set(rowId, watcher);
        watchJob(job, rowId, job.modelId, watcher);
      }
    })();
    return () => {
      alive = false;
      for (const watcher of watchers.values()) watcher.ctrl.abort();
      watchers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The Aurora shell owns Cmd+K and drives chat actions through these events.
  // Do not bind Cmd+K here or it fires twice.
  useEffect(() => {
    const onNewChat = () => shortcutRef.current.createChat?.();
    const onNewEphemeralChat = () => shortcutRef.current.createChat?.({ ephemeral: true });
    const onSetProvider = (e) => {
      const next = e?.detail?.provider;
      if (!next) return;
      setProvider(next);
      // GGUF model names are local-only; reset to auto when switching providers.
      setModel((m) => (typeof m === 'string' && m.toLowerCase().endsWith('.gguf') ? 'auto' : m));
    };
    const onToggleWebSearch = () => setDeepWebEnabled((v) => !v);
    const onOpenChat = (e) => {
      const id = e?.detail?.id;
      if (id) shortcutRef.current.loadChat?.(id);
    };
    window.addEventListener('mirabilis:new-chat', onNewChat);
    window.addEventListener('mirabilis:new-ephemeral-chat', onNewEphemeralChat);
    window.addEventListener('mirabilis:set-provider', onSetProvider);
    window.addEventListener('mirabilis:toggle-web-search', onToggleWebSearch);
    window.addEventListener('mirabilis:open-chat', onOpenChat);
    return () => {
      window.removeEventListener('mirabilis:new-chat', onNewChat);
      window.removeEventListener('mirabilis:new-ephemeral-chat', onNewEphemeralChat);
      window.removeEventListener('mirabilis:set-provider', onSetProvider);
      window.removeEventListener('mirabilis:toggle-web-search', onToggleWebSearch);
      window.removeEventListener('mirabilis:open-chat', onOpenChat);
    };
  }, []);

  useEffect(() => {
    safeStorageSet('mirabilis-engine-option', selectedEngine);
  }, [selectedEngine]);

  // Settings is a dialog: composer menus close so their focus traps do not fight it.
  useEffect(() => {
    if (settingsOpen) shortcutRef.current.closeAllDropdowns?.();
  }, [settingsOpen]);

  // Each section refreshes what it shows when it opens.
  useEffect(() => {
    if (!settingsOpen) return;
    if (settingsSection === 'voice') {
      checkVoiceTools();
      fetchPiperModels();
    } else if (settingsSection === 'remote') {
      checkRemoteStatus();
    } else if (settingsSection === 'labs') {
      refreshTrainingStats();
    } else if (settingsSection === 'chat-tools') {
      checkImageService();
      refreshVaultStatus();
    } else if (settingsSection === 'models') {
      // Models pulled from the command line show up as installed.
      refreshOllamaModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, settingsSection]);

  // Cmd+, (Ctrl+, elsewhere) opens Settings from either tab.
  useEffect(() => {
    function onKey(e) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key !== ',') return;
      e.preventDefault();
      shortcutRef.current.openSettings?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Follow new content while the user is at the bottom. Agent runs land their whole
  // answer at once, after streaming ends, so this cannot be limited to streaming.
  // autoScrollRef is re-checked inside the rAF because the user can scroll up between
  // queueing and firing.
  useEffect(() => {
    if (!messagesScrollRef.current) return;
    const el = messagesScrollRef.current;
    const raf = requestAnimationFrame(() => {
      if (!autoScrollRef.current) return; // re-check right before touching the DOM
      isProgrammaticScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollHeight; // keep direction-detection baseline in sync
      requestAnimationFrame(() => { isProgrammaticScrollRef.current = false; });
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, isStreaming]); // ref-based guard - autoScrollEnabled state not needed in deps

  // When switching chats, jump to bottom and re-enable auto-scroll.
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    autoScrollRef.current = true;
    setAutoScrollEnabled(true);
    setShowScrollDown(false);
    isProgrammaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollHeight; // sync baseline
    requestAnimationFrame(() => { isProgrammaticScrollRef.current = false; });
  }, [activeChatId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Separate memo so typing does not re-estimate the system prompt.
  const systemPromptTokens = useMemo(() => estimateTokens(systemPrompt), [systemPrompt]);

  // Pinned-first, search-filtered chat list for the sidebar
  const sortedAndFilteredChats = useMemo(() => {
    const lc = chatSearch.trim().toLowerCase();
    const filtered = lc ? chats.filter((c) => (c.title || '').toLowerCase().includes(lc)) : chats;
    const pinned = filtered.filter((c) => pinnedChatIds.has(c.id));
    const unpinned = filtered.filter((c) => !pinnedChatIds.has(c.id));
    return [...pinned, ...unpinned];
  }, [chats, chatSearch, pinnedChatIds]);

  // Single pass over messages for all token accounting.
  const { chatTokenSummary, contextUsage } = useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    let userTokens = 0;
    let uncategorizedTokens = 0;

    for (const message of messages) {
      const tokenCount = messageTokens(message);
      if (message.role === 'user') {
        inputTokens += tokenCount;
        userTokens += tokenCount;
      } else {
        outputTokens += tokenCount;
        uncategorizedTokens += tokenCount;
      }
    }

    const totalTokens = systemPromptTokens + userTokens + uncategorizedTokens;
    const windowTokens = estimateModelContextWindow(model);
    const usedPct = Math.min(999, Math.round((totalTokens / Math.max(windowTokens, 1)) * 100));
    const systemPct = totalTokens > 0 ? Math.round((systemPromptTokens / totalTokens) * 100) : 0;
    const userPct = totalTokens > 0 ? Math.round((userTokens / totalTokens) * 100) : 0;
    const uncategorizedPct = Math.max(0, 100 - systemPct - userPct);

    return {
      chatTokenSummary: { input: inputTokens, output: outputTokens },
      contextUsage: {
        systemTokens: systemPromptTokens,
        userTokens,
        uncategorizedTokens,
        totalTokens,
        windowTokens,
        usedPct,
        systemPct,
        userPct,
        uncategorizedPct
      }
    };
  }, [messages, model, systemPromptTokens]);

  const remoteUsage = useMemo(() => {
    const remoteProvider = provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas' ? provider : null;
    if (!remoteProvider) {
      return { enabled: false, estUsd: 0, pct: 0, budgetUsd: remoteBudgetUsd, rate: null };
    }

    // Auto is priced as the model it sends to.
    const rate = resolveRateCard(remoteProvider, model === 'auto' ? cloudAutoModel(models) : model);
    if (!rate) {
      return { enabled: false, estUsd: 0, pct: 0, budgetUsd: remoteBudgetUsd, rate: null };
    }

    const input = Number(chatTokenSummary.input || 0);
    const output = Number(chatTokenSummary.output || 0);
    const estUsd = (input / 1_000_000) * rate.in + (output / 1_000_000) * rate.out;
    const budget = Number(remoteBudgetUsd || 0);
    const pct = budget > 0 ? Math.min(100, Math.round((estUsd / budget) * 100)) : 0;
    return { enabled: true, estUsd, pct, budgetUsd: budget, rate };
  }, [provider, model, models, chatTokenSummary.input, chatTokenSummary.output, remoteBudgetUsd]);

  async function handleImageGeneration(content) {
    setInput('');
    setIsStreaming(true);
    setStatusText('Generating image...');

    let chatId = activeChatId;
    if (!chatId) {
      // Runs before the try below; a throw here would leave isStreaming stuck true.
      try {
        const payload = await api('/api/chats', {
          method: 'POST',
          body: JSON.stringify({
            title: content.slice(0, 40),
            uncensoredMode,
            systemPrompt,
            promptProfileId: selectedPromptProfileId === UNSAVED_PROMPT_PROFILE_ID ? '' : selectedPromptProfileId
          })
        });
        chatId = payload.chat.id;
        setActiveChatId(chatId);
        await refreshChats();
      } catch (error) {
        setStatusText(`Image error: ${error.message}`);
        setInput(content); // restore the prompt the user typed
        setIsStreaming(false);
        return;
      }
    }

    const userMessage = {
      id: `local-user-${Date.now()}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      tokenEstimate: estimateTokens(content)
    };

    const placeholderId = `local-img-${Date.now()}`;

    if (!imageServiceAvailable) {
      // Service offline: show setup steps instead of routing to the LLM.
      const offlineMsg = {
        id: placeholderId,
        role: 'assistant',
        content: [
          'Image service is not running.',
          '',
          'Start the app with `node run.js` (without `--no-image`). The first run downloads about 6 GB.',
          '',
          'Or start it manually:',
          '',
          '```',
          'cd mirabilis/image-service && python3 -m venv .venv',
          '.venv/bin/pip install -r requirements.txt',
          '.venv/bin/python server.py',
          '```'
        ].join('\n'),
        createdAt: new Date().toISOString(),
        tokenEstimate: 0
      };
      setMessages((prev) => [...prev, userMessage, offlineMsg]);
      setIsStreaming(false);
      setStatusText('Ready');
      // Recheck the service so the badge updates when it comes online
      checkImageService();
      return;
    }

    const placeholder = {
      id: placeholderId,
      role: 'assistant',
      content: '',
      imageGenerating: true,
      createdAt: new Date().toISOString(),
      tokenEstimate: 0
    };

    setMessages((prev) => [...prev, userMessage, placeholder]);

    try {
      const genResponse = await fetch(`${API_BASE}/api/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: content })
      });

      if (!genResponse.ok) {
        const errData = await genResponse.json().catch(() => ({}));
        throw new Error(errData.error || `Generation failed (${genResponse.status})`);
      }

      const genData = await genResponse.json();

      const saveResponse = await fetch(`${API_BASE}/api/chats/${chatId}/image-messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: content, imageBase64: genData.image, format: genData.format })
      });

      if (!saveResponse.ok) throw new Error('Failed to save image to chat');

      const saveData = await saveResponse.json();

      setMessages((prev) => {
        const next = [...prev];
        const idx = next.findIndex((m) => m.id === placeholderId);
        if (idx !== -1) next[idx] = saveData.message;
        return next;
      });

      await refreshChats();
      setStatusText('Ready');
    } catch (error) {
      setStatusText(`Image error: ${error.message}`);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === placeholderId
            ? { ...m, content: `Could not generate image: ${error.message}`, imageGenerating: false }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
    }
  }

  async function regenerate() {
    if (isStreaming || !activeChatId) return;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;

    // Drop everything after the last user message.
    const lastUserIdx = messages.lastIndexOf(lastUserMsg);
    const trimmed = messages.slice(0, lastUserIdx + 1);
    // Also trim the server-side chat
    const chat = await api(`/api/chats/${activeChatId}`);
    const serverMessages = chat.chat?.messages || [];
    const serverUserIdx = serverMessages.map((m) => m.id).lastIndexOf(lastUserMsg.id);
    if (serverUserIdx < 0) {
      // Temp ID from a failed or aborted stream is not on the server: do not patch.
      setMessages(messages.slice(0, messages.lastIndexOf(lastUserMsg) + 1));
      setInput(lastUserMsg.content);
      setTimeout(() => sendMessageWithContent(lastUserMsg.content), 0);
      return;
    }
    await api(`/api/chats/${activeChatId}`, {
      method: 'PATCH',
      body: JSON.stringify({ messages: serverMessages.slice(0, serverUserIdx + 1) })
    }).catch(() => {}); // best-effort; stream endpoint will re-append

    setMessages(trimmed);
    setInput(lastUserMsg.content);
    setTimeout(() => sendMessageWithContent(lastUserMsg.content), 0);
  }

  // Shared by Chat -> Ledger and Commitment Radar so both see the same text.
  function buildChatTranscript() {
    return messages
      .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
  }

  // Read-only: /scan is preview-only and persists nothing.
  async function runCommitmentRadar() {
    if (radarLoading) return;
    const transcript = buildChatTranscript();
    setRadarOpen(true);
    setRadarError('');
    setRadarSignals([]);
    setRadarConflicts([]);
    setRadarConflictsLoading(false);
    setRadarScanned(false);
    if (!transcript.trim()) {
      setRadarScanned(true);
      return;
    }
    setRadarLoading(true);
    // The contradiction pass uses embeddings and a local model, so it runs beside
    // the faster heuristic scan. Best effort; writes nothing.
    setRadarConflictsLoading(true);
    postJSON('/api/recall/contradictions', { text: transcript }, { timeoutMs: 120000 })
      .then((payload) => {
        setRadarConflicts(Array.isArray(payload?.conflicts) ? payload.conflicts : []);
      })
      .catch(() => {
        setRadarConflicts([]);
      })
      .finally(() => {
        setRadarConflictsLoading(false);
      });
    try {
      const payload = await api('/api/intelledger/scan', {
        method: 'POST',
        body: JSON.stringify({ text: transcript })
      });
      setRadarSignals(Array.isArray(payload?.signals) ? payload.signals : []);
    } catch (err) {
      setRadarError(plainError(err?.message, 'Scan failed'));
    } finally {
      setRadarScanned(true);
      setRadarLoading(false);
    }
  }

  async function commitChatToLedger() {
    if (isCommittingToLedger) return;
    const transcript = buildChatTranscript();
    if (!transcript.trim()) {
      setStatusText('Nothing to commit');
      return;
    }
    const userId = safeStorageGet('mirabilis-user-id') || 'user-local';
    const chatTitle = (chats.find((c) => c.id === activeChatId)?.title || '').trim() || 'Untitled chat';
    setIsCommittingToLedger(true);
    setStatusText('Committing to Ledger...');
    try {
      const created = await api('/api/intelledger/sessions', {
        method: 'POST',
        body: JSON.stringify({ userId, title: `Chat: ${chatTitle}` })
      });
      const sessionId = created?.session?.id;
      if (!sessionId) throw new Error('could not create ledger session');
      await api(`/api/intelledger/sessions/${sessionId}/ingest/text`, {
        method: 'POST',
        body: JSON.stringify({ content: transcript, sourceName: 'chat' })
      });
      setStatusText('Committed to Ledger');
      appStore.toast('Committed to Ledger', { kind: 'success' });
      playReceive();
      window.dispatchEvent(new CustomEvent('mirabilis:open-session', { detail: { id: sessionId } }));
    } catch (err) {
      setStatusText(`Commit to Ledger failed: ${err.message}`);
    } finally {
      setIsCommittingToLedger(false);
    }
  }

  async function sendMessage() {
    const content = input.trim();
    if (!content || isStreaming) {
      return;
    }
    await sendMessageWithContent(content);
  }


  // Agent runs. An agentic effort is a budgeted job; with Access above Chat only,
  // every message runs this way so it can use tools. Progress goes to the run
  // panel and approvals to the card above the composer; the transcript shows the
  // goal at once and the saved result when the run ends.
  function stopAgentRun() {
    const run = agentRunRef.current;
    if (run?.id) {
      api(`/api/agent/runs/${run.id}/stop`, { method: 'POST' }).catch(() => {});
    }
    // Abort locally too, so the panel stops even if the stop call cannot land.
    try { agentAbortRef.current?.abort(); } catch { /* already gone */ }
    setAgentRun((prev) => (prev ? { ...prev, status: 'stopping' } : prev));
  }

  // Web results for a message as one block, or '' when search is off, blocked,
  // empty or failed. doneStatus is the status line to leave behind.
  async function webSearchContext(content, doneStatus) {
    // Go Dark blocks web search for any model: the raw query would go to a
    // third-party API, and the provider check covers only the model call.
    if (deepWebEnabled && appStore.getGoDark()) {
      appStore.toast('Go Dark: web search skipped', { kind: 'warn' });
    }
    if (!deepWebEnabled || appStore.getGoDark() || classifyWebSearch(content) !== 'search') return '';
    setStatusText('Searching the web...');
    setWebSearchStatus('searching');
    try {
      const query = searchQueryFrom(content);
      const payload = await api('/api/web-search', {
        method: 'POST',
        body: JSON.stringify({ query, maxResults: 5, localOnly: appStore.getGoDark() })
      });
      const sources = Array.isArray(payload.sources) ? payload.sources : [];
      if (payload.needsKey) {
        appStore.toast(payload.error, { kind: 'info' });
        setWebSearchStatus('idle');
        return '';
      }
      if (sources.length === 0) {
        // Search succeeded but no results - treat as soft error
        setWebSearchStatus('error');
        setTimeout(() => setWebSearchStatus('idle'), 4000);
        return '';
      }
      const context = sources
        .map((item, index) => `${index + 1}. ${item.title || 'Untitled'}\nURL: ${item.url}\nSnippet: ${item.snippet || ''}`)
        .join('\n\n');
      const answerHint = payload.answer ? `High-level answer: ${payload.answer}\n\n` : '';
      setStatusText(`Searched: ${query}`);
      setWebSearchStatus('idle');
      return [`Web results for "${query}". Use them when relevant and cite their URLs.`, '', answerHint + context].join('\n');
    } catch (error) {
      setStatusText(`Web search unavailable: ${error.message}`);
      setWebSearchStatus('error');
      setTimeout(() => setWebSearchStatus('idle'), 4000);
      return '';
    } finally {
      setStatusText(doneStatus);
    }
  }

  // Pinned workspace files read fresh from disk, as one block within budgetChars.
  // Files that cannot be read or do not fit are skipped and listed in skipped.
  async function readPinnedFiles(budgetChars) {
    const pins = appStore.getWorkspacePins ? appStore.getWorkspacePins() : [];
    const blocks = [];
    const skipped = [];
    let used = 0;
    for (const relPath of pins) {
      try {
        const payload = await api(`/api/workspace/file?path=${encodeURIComponent(relPath)}`);
        const text = typeof payload?.content === 'string' ? payload.content : '';
        if (used + text.length > budgetChars) { skipped.push(relPath); continue; }
        used += text.length;
        blocks.push(`--- ${payload?.path || relPath} ---\n${text}`);
      } catch {
        skipped.push(relPath); // renamed / deleted / oversize / jailed - skip, keep sending
      }
    }
    if (blocks.length === 0) {
      if (skipped.length > 0) {
        appStore.toast(
          `${skipped.length} pinned file(s) unreadable. Pick the Workspace folder again.`,
          { kind: 'warn' }
        );
      }
      return { text: '', skipped };
    }
    const header = [
      '[Watched workspace files - live context read fresh from disk. Treat these as the authoritative current contents of the named files.]',
      skipped.length > 0 ? `(${skipped.length} pinned file(s) skipped: unavailable or over the context budget.)` : ''
    ].filter(Boolean).join('\n');
    return { text: `${header}\n\n${blocks.join('\n\n')}`, skipped };
  }

  // Config Vault excerpts for a message, or ''. Retrieval uses local Ollama
  // embeddings, so Go Dark allows it, and a failure never blocks a send.
  async function vaultContext(content, doneStatus) {
    if (!(configVaultEnabled && configVaultStatus && configVaultStatus.chunkCount > 0)) return '';
    try {
      setStatusText('Searching Config Vault...');
      const vr = await api('/api/vault/query', { method: 'POST', body: JSON.stringify({ query: content, limit: 4 }) });
      const results = Array.isArray(vr?.results) ? vr.results : [];
      if (results.length === 0) return '';
      const context = results.map((r) => `[${r.citation}]\n${r.snippet}`).join('\n\n');
      return [
        '[Config Vault - cited excerpts retrieved locally from your own config files. Treat as authoritative; cite the exact file:line label in square brackets when you use one.]',
        '',
        context
      ].join('\n');
    } catch {
      return '';
    } finally {
      setStatusText(doneStatus);
    }
  }

  // What a run needs from the chat side: the earlier turns with their files, and
  // the modes the chat path would apply. The backend reads none of it from the chat.
  async function gatherRunContext(goal) {
    const earlier = contextMessages(messages);
    const loadMemory = async () => {
      // Same rule as the chat route: personal memory stays out of Uncensored chats.
      if (!usePersonalMemory || uncensoredMode) return [];
      try {
        const payload = await api('/api/training/memory');
        return (Array.isArray(payload?.items) ? payload.items : []).map((item) => String(item?.text || ''));
      } catch {
        return [];
      }
    };
    const [attachmentTexts, pinned, memory] = await Promise.all([
      fetchAttachmentTexts(earlier), readPinnedFiles(12 * 1024), loadMemory()
    ]);
    // One after the other, so the status line reads in order.
    const web = await webSearchContext(goal, 'Ready');
    const vault = await vaultContext(goal, 'Ready');
    // The project folder is the run's working folder, so a pin that did not fit is one read_file away.
    const unshown = pinned.skipped.length
      ? `Pinned files not shown here: ${pinned.skipped.slice(0, 20).join(', ')}. Read them with read_file; the paths are relative to the project folder.`
      : '';
    return buildRunContext({
      conversation: conversationContext(earlier, { attachmentTexts }),
      remoteTarget: remoteConnected ? remoteTarget : '',
      canvas: canvasEnabled ? canvasText : '',
      pinned: [pinned.text, unshown].filter(Boolean).join('\n'),
      vault,
      web,
      memory,
      instructions: answerModeLines({ guided: guidedLearningEnabled, effort: '', deep: deepThinkingEnabled })
    });
  }

  // Resolves 'use-chat' when the backend's Access is Chat only, so the caller can
  // send the message as plain chat instead.
  async function runAgentGoal(goal) {
    // One run at a time: runs share agentRunRef, so an older one could not be stopped.
    if (agentAbortRef.current) {
      appStore.toast('Run in progress. Stop it first.', { kind: 'warn' });
      return 'busy';
    }
    // Claim the slot before any await, so a second Send cannot start a second run.
    const controller = new AbortController();
    agentAbortRef.current = controller;
    try {
      await ensureProviderKey();
    } catch (err) {
      agentAbortRef.current = null;
      appStore.toast(err.message, { kind: 'error', ttl: 5200 });
      return 'refused';
    }
    // A request can lower the stored level but never raise it, so a stale copy is safe.
    const access = appStore.getAccess();

    const started = {
      id: null, goal, effort: effortLevel, access,
      status: 'running', phase: AGENTIC_EFFORTS.has(effortLevel) ? 'plan' : 'act',
      events: [], budget: null, answer: '', stopReason: null, error: '', approvals: []
    };
    setAgentRun(started);
    agentRunRef.current = started;
    setIsStreaming(true);

    // An event without a time keeps the previous one, so the log stays in order.
    const pushEvent = (text, at) => setAgentRun((prev) => {
      if (!prev) return prev;
      const last = prev.events[prev.events.length - 1];
      const when = Number.isFinite(at) ? at : (last ? last.at : 0);
      return { ...prev, events: [...prev.events, { text, at: when }].slice(-200) };
    });

    // Fills the reply bubble in place. After a switch to another chat the bubble
    // is gone and this does nothing.
    const replyId = `local-assistant-${Date.now()}`;
    const settleReply = (patch) => setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === replyId);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
    let accepted = false;
    let settled = false;
    let outcome = 'done';

    try {
      // Uncensored runs on the model the chat path would force.
      const forced = uncensoredMode && provider === 'ollama' ? pickUncensoredModel(models) : null;

      // Create the chat up front so the backend can write the result into it. It
      // carries the same modes as a chat-path chat, or reloading it would reset them.
      let targetChatId = activeChatIdRef.current;
      if (!targetChatId) {
        const created = await api('/api/chats', {
          method: 'POST',
          body: JSON.stringify({
            title: goal.slice(0, 60),
            uncensoredMode,
            systemPrompt,
            promptProfileId: selectedPromptProfileId === UNSAVED_PROMPT_PROFILE_ID ? '' : selectedPromptProfileId
          })
        }).catch(() => null);
        targetChatId = created?.chat?.id || null;
        if (targetChatId) {
          setActiveChatId(targetChatId);
          await refreshChats().catch(() => {});
        }
      }

      // The goal is only the new message, so earlier turns, files and chat modes ride along here.
      const runContext = await gatherRunContext(goal);
      const token = await getSessionToken();
      const res = await fetch(`${API_BASE}/api/agent/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-mirabilis-mcp-token': token } : {})
        },
        signal: controller.signal,
        body: JSON.stringify({
          goal,
          chatId: targetChatId || undefined,
          effort: effortLevel,
          access,
          provider,
          model: forced?.id || model || undefined,
          providerBaseUrl: providerConfigs[provider]?.baseUrl || undefined,
          // The watched workspace folder is the run's project folder.
          fsRoot: appStore.getWorkspaceRoot() || undefined,
          localOnly: appStore.getGoDark(),
          // Uncensored sends no app instructions, as in chat; the chat context still goes.
          systemPrompt: [uncensoredMode ? '' : systemPrompt, runContext]
            .filter((part) => typeof part === 'string' && part.trim())
            .join('\n\n')
        })
      });

      if (!res.ok || !res.body) {
        // Show the server's `error` sentence, not the raw JSON body.
        const refusal = runRefusal(res.status, await res.text().catch(() => ''));
        if (refusal.useChat) {
          appStore.setAccess('chat');
          outcome = 'use-chat';
          return outcome;
        }
        throw new Error(refusal.message);
      }

      // Clear only after the server accepts the run, so a refusal keeps the text.
      setInput('');
      accepted = true;
      const createdAt = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        { id: `local-user-${Date.now()}`, role: 'user', content: goal, createdAt, tokenEstimate: estimateTokens(goal) },
        { id: replyId, role: 'assistant', content: '', createdAt, tokenEstimate: 0 }
      ]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // Shared parser; accepts "data:" with or without the space.
      const sse = createSseParser();

      while (true) {
        const { done, value } = await reader.read();
        const frames = done
          ? sse.flush()
          : sse.push(decoder.decode(value, { stream: true }));

        for (const frame of frames) {
          const currentEvent = frame.event;
          let payload;
          try { payload = JSON.parse(frame.data); } catch { continue; }

          if (currentEvent === 'run-accepted') {
            setAgentRun((prev) => (prev ? { ...prev, id: payload.id, access: payload.access || prev.access } : prev));
            // The level the backend gave this run; an Access change mid-run is judged against it.
            agentRunRef.current = { ...agentRunRef.current, id: payload.id, access: payload.access || agentRunRef.current?.access };
            continue;
          }
          if (currentEvent === 'error') {
            settled = true;
            setAgentRun((prev) => (prev ? { ...prev, status: 'failed', error: payload.error } : prev));
            settleReply({ content: `Error: ${payload.error || 'Run failed'}`, failed: true });
            continue;
          }
          if (currentEvent === 'result') {
            settled = true;
            setAgentRun((prev) => (prev ? {
              ...prev,
              status: payload.ok ? 'completed' : 'stopped',
              stopReason: payload.stopReason,
              answer: payload.answer,
              // Keep the backend's actionable failure sentence for the panel.
              error: payload.ok ? '' : (payload.error || prev.error || ''),
              budget: payload.budget
            } : prev));
            if (!payload.ok && payload.error) {
              appStore.toast(payload.error, { kind: 'error' });
            }
            // The backend writes the run into the chat. Reload only if the user is
            // still in it, so a draft elsewhere survives; otherwise fill the bubble.
            if (payload.persistedTo && activeChatIdRef.current === payload.persistedTo) {
              await loadChat(payload.persistedTo).catch(() => {});
            } else {
              const answer = String(payload.answer || '');
              settleReply(answer
                ? { content: answer, tokenEstimate: estimateTokens(answer) }
                : payload.error
                  ? { content: `Error: ${payload.error}`, failed: true }
                  : { content: `(no result: ${payload.stopReason || 'stopped'})` });
            }
            if (payload.persistedTo) await refreshChats().catch(() => {});
            continue;
          }

          const approvalType = approvalEventType(currentEvent, payload);
          if (approvalType === 'approval-required') {
            const approval = toApproval(payload);
            if (approval) {
              setAgentRun((prev) => (prev ? { ...prev, approvals: addApproval(prev.approvals, approval) } : prev));
              const what = approval.title || approval.tool || 'an action';
              pushEvent(`waiting for approval: ${what}`, payload.at);
              // The card is out of sight behind Settings or on the Ledger tab.
              if (settingsOpenRef.current || mainRef.current?.offsetParent === null) {
                appStore.toast(`Needs approval: ${what}`, { kind: 'warn', ttl: 8000 });
              }
            }
            continue;
          }
          if (approvalType === 'approval-resolved') {
            if (typeof payload.approvalId === 'string') {
              setAgentRun((prev) => (prev ? { ...prev, approvals: removeApproval(prev.approvals, payload.approvalId) } : prev));
            }
            pushEvent(approvalNarration(payload.decision), payload.at);
            continue;
          }
          if (currentEvent !== 'progress') continue;

          // Meters show only the parent's budget; sub-agent events carry their own smaller one.
          if (payload.budget && payload.subAgent === undefined) {
            setAgentRun((prev) => (prev ? { ...prev, budget: payload.budget } : prev));
          }
          const at = payload.at;
          switch (payload.type) {
            case 'phase':
              setAgentRun((prev) => (prev ? { ...prev, phase: payload.phase } : prev));
              pushEvent(`phase: ${payload.phase}`, at);
              break;
            case 'plan': pushEvent(`plan: ${String(payload.plan).slice(0, 120)}`, at); break;
            case 'iteration': setAgentRun((prev) => (prev ? { ...prev, phase: 'act' } : prev)); break;
            case 'tool-call': pushEvent(`${payload.tool}(${JSON.stringify(payload.args).slice(0, 60)})`, at); break;
            case 'tool-result':
              pushEvent(payload.ok
                ? `  ${payload.tool} done`
                : `  ${payload.tool} failed: ${String(payload.observation).replace(/^ERROR:\s*/, '').slice(0, 90)}`, at);
              break;
            case 'invalid-action': pushEvent(`  retrying: ${payload.error}`, at); break;
            case 'finish-proposed': pushEvent('proposed a result', at); break;
            case 'validation': pushEvent(`validation ${payload.passed ? 'passed' : 'failed'}${payload.reason ? `: ${String(payload.reason).slice(0, 70)}` : ''}`, at); break;
            case 'repair': pushEvent(`repairing: ${String(payload.reason).slice(0, 80)}`, at); break;
            case 'fanout-start': pushEvent(`spawned ${payload.count} sub-agent(s)`, at); break;
            case 'fanout-end': pushEvent(`sub-agents done (${payload.spentToolCalls} tool calls)`, at); break;
            default: break;
          }
        }
        if (done) break;
      }
      if (!settled) {
        // The stream closed with neither a result nor an error.
        const lost = 'Run ended without a result';
        setAgentRun((prev) => (prev ? { ...prev, status: 'failed', error: prev.error || lost } : prev));
        settleReply({ content: `Error: ${lost}`, failed: true });
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        setAgentRun((prev) => (prev ? { ...prev, status: 'failed', error: err.message } : prev));
        if (accepted) settleReply({ content: `Error: ${err.message}`, failed: true });
        else appStore.toast(err.message, { kind: 'error', ttl: 5200 });
      } else {
        setAgentRun((prev) => (prev ? { ...prev, status: 'stopped', stopReason: 'cancelled' } : prev));
        // Stopped before an answer: keep the goal, drop the empty bubble.
        setMessages((prev) => prev.filter((m) => m.id !== replyId || m.content));
      }
    } finally {
      setIsStreaming(false);
      agentAbortRef.current = null;
      setApprovalBusyId('');
      // The backend cancels open approvals when a run ends.
      if (outcome === 'use-chat') setAgentRun(null);
      else setAgentRun((prev) => (prev && prev.approvals?.length ? { ...prev, approvals: [] } : prev));
    }
    return outcome;
  }

  // Posts the answer to one approval. 404 and 409 mean the card is stale; any
  // other failure keeps it so the user can answer again.
  async function decideApproval(approval, decision, note) {
    const runId = agentRunRef.current?.id;
    if (!approval || !runId || approvalBusyId) return;
    setApprovalBusyId(approval.approvalId);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const token = await getSessionToken();
      const res = await fetch(
        `${API_BASE}/api/agent/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approval.approvalId)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'x-mirabilis-mcp-token': token } : {})
          },
          body: JSON.stringify(note ? { decision, note } : { decision }),
          signal: ctrl.signal
        }
      );
      if (approvalReplyOutcome(res.status) === 'failed') {
        const body = await res.text().catch(() => '');
        throw new Error(plainError(body, `Server error ${res.status}`));
      }
      setAgentRun((prev) => (prev ? { ...prev, approvals: removeApproval(prev.approvals, approval.approvalId) } : prev));
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timed out' : String(err?.message || 'request failed').trim().replace(/\.+$/, '');
      appStore.toast(`Answer not sent: ${reason}. Try again.`, { kind: 'error', ttl: 5200 });
    } finally {
      clearTimeout(timer);
      setApprovalBusyId('');
    }
  }

  // Keeps focus on the chip when its menu closes, so Settings returns it there.
  function focusAccessChip() {
    const trigger = document.querySelector('[data-menu-trigger="access"]');
    if (trigger instanceof HTMLElement) trigger.focus();
  }

  // The composer's Access menu. The chip changes at once and goes back if the save fails.
  async function chooseAccess(level) {
    focusAccessChip();
    setIsAccessMenuOpen(false);
    const previous = appStore.getAccess();
    if (accessSaving || level === previous) return;
    setAccessSaving(level);
    appStore.setAccess(level);
    try {
      const saved = await saveAccess({ level });
      appStore.setAccess(saved.level);
      if (saved.level === 'bypass') {
        appStore.toast('Bypass on: runs anything, never asks', { kind: 'warn', ttl: 5200 });
      }
      if (agentAbortRef.current) {
        // The backend lowers a live run at once and never raises it past its start level.
        const runLevel = agentRunRef.current?.access || previous;
        appStore.toast(accessChangeNotice(runLevel, saved.level), { kind: 'info' });
        setAgentRun((prev) => (prev ? { ...prev, accessNow: lowerAccess(runLevel, saved.level) } : prev));
      }
    } catch (err) {
      appStore.setAccess(previous);
      appStore.toast(`Access not changed. ${describeApiError(err, 'Access')}`, { kind: 'error', ttl: 5200 });
    } finally {
      setAccessSaving('');
    }
  }

  function openAccessMenu() {
    const open = !isAccessMenuOpen;
    closeAllDropdowns();
    if (open) {
      // The menu is wider than the chip and opens upward: shift it left as far as it
      // needs, and cap its height at the room above the chip (it scrolls past that).
      const trigger = document.querySelector('[data-menu-trigger="access"]');
      if (trigger instanceof HTMLElement) {
        const rect = trigger.getBoundingClientRect();
        const width = Math.min(ACCESS_MENU_WIDTH, window.innerWidth - 32);
        const overflow = rect.left + width - (window.innerWidth - 16);
        setAccessMenuPlace({
          left: overflow > 0 ? -Math.min(overflow, Math.max(0, rect.left - 16)) : 0,
          // 8px gap above the chip (bottom-9 on a 28px chip); the top 56px hold the floating Dock.
          maxHeight: Math.max(160, Math.floor(rect.top - 64))
        });
      }
    }
    setIsAccessMenuOpen(open);
    // Another window may have changed it; skip while a save is in flight.
    if (open && !accessSaving) {
      fetchAccess().then((a) => appStore.setAccess(a.level)).catch(() => {});
    }
  }

  // Up and Down move between the levels; Home and End jump to the ends.
  function onAccessMenuKeyDown(e) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(e.currentTarget.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'));
    if (items.length === 0) return;
    e.preventDefault();
    const idx = items.indexOf(document.activeElement);
    let next = 0;
    if (e.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(idx + 1, items.length - 1);
    else if (e.key === 'ArrowUp') next = idx < 0 ? items.length - 1 : Math.max(idx - 1, 0);
    else if (e.key === 'End') next = items.length - 1;
    items[next].focus();
  }

  async function sendMessageWithContent(content) {
    // A recently attached image means vision, so skip the image-generation heuristic.
    const recentImage = (messages || []).slice(-4).some(
      (m) => Array.isArray(m.attachments) && m.attachments.some((a) => /^image\//i.test(a?.mimeType || ''))
    );
    // An explicit agentic tier wins over image wording, since goals often contain image words.
    const route = chooseSendRoute({
      agentic: AGENTIC_EFFORTS.has(effortLevel),
      access: appStore.getAccess(),
      imageRequest: isImageRequest(content) && !recentImage,
      explicitImage: isExplicitImagePrompt(content)
    });
    if (route === 'image') {
      await handleImageGeneration(content);
      return;
    }

    // Go Dark: if the session is locked to local-only, refuse to send to a cloud
    // provider before anything leaves the machine (keeps the typed text intact).
    if (appStore.getGoDark()) {
      const option = PROVIDER_OPTIONS.find((p) => p.id === provider);
      if (option?.scope === 'Remote') {
        appStore.toast(`Go Dark blocks ${option.label}. Switch to a local model.`, { kind: 'warn' });
        return;
      }
    }

    playSend(); // ICQ send cue (no-ops on mute / reduced-motion)
    if (route === 'agent') {
      // Awaited so the voice loop settles when the reply is in, not at once.
      // runAgentGoal clears the composer once the run is accepted.
      if ((await runAgentGoal(content)) !== 'use-chat') return;
      appStore.toast('Chat only: sent without tools', { kind: 'info' });
    }

    setInput('');

    let outboundContent = content;

    const behaviorInstructions = answerModeLines({
      guided: guidedLearningEnabled, effort: effortLevel, deep: deepThinkingEnabled
    });
    if (behaviorInstructions.length > 0) {
      outboundContent = [content, '', ...behaviorInstructions].join('\n');
    }

    // Canvas notes go into the message as working context.
    if (canvasEnabled && canvasText.trim()) {
      outboundContent = `${outboundContent}\n\n[Canvas notes - treat as the user's working context]\n${canvasText.trim()}`;
    }

    // Inject remote control awareness when connected
    if (remoteConnected) {
      const disclaimer = [
        `Remote Control is active. Target: ${remoteTarget}.`,
        'When suggesting shell/terminal commands, wrap them in a fenced code block with language "bash" or "sh".',
        'The user can execute them on the target with a single click.',
        'Do not auto-execute anything - always present and explain the command first.'
      ].join(' ');
      outboundContent = `${outboundContent}\n\n[System: ${disclaimer}]`;
    }
    // Appended, so effort, canvas and remote notes added above are kept.
    const webContext = await webSearchContext(content, 'Streaming response...');
    if (webContext) outboundContent = [outboundContent, '', webContext].join('\n');

    // Pinned files are read from disk at send time; only their paths persist.
    const pinned = await readPinnedFiles(40 * 1024);
    if (pinned.text) outboundContent = `${pinned.text}\n\n${outboundContent}`;

    const vault = await vaultContext(content, 'Streaming response...');
    if (vault) outboundContent = [vault, '', outboundContent].join('\n');

    // Throws on a missing key or failed health check; the composer is already
    // cleared, so restore the draft.
    let resolvedProvider;
    try {
      resolvedProvider = await resolveProviderForSend();
    } catch (error) {
      setStatusText(error?.message || 'Cannot send with this provider');
      setInput(content);
      return;
    }

    setStatusText('Streaming response...');

    let chatId = activeChatId;
    if (!chatId) {
      // First request on a cold start, when the backend may not be up yet.
      // Restore the draft and report instead of rejecting unhandled.
      try {
        const payload = await api('/api/chats', {
          method: 'POST',
          body: JSON.stringify({
            title: 'New Chat',
            uncensoredMode,
            systemPrompt,
            promptProfileId: selectedPromptProfileId === UNSAVED_PROMPT_PROFILE_ID ? '' : selectedPromptProfileId
          })
        });
        chatId = payload.chat.id;
        setActiveChatId(chatId);
        await refreshChats();
      } catch (error) {
        setStatusText('Could not start a chat');
        appStore.toast(
          `Could not start a chat: ${describeRunError(0, error?.message || '')}`,
          { kind: 'error' }
        );
        setInput(content);
        return;
      }
    }

    const userMessage = {
      id: `local-user-${Date.now()}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      tokenEstimate: estimateTokens(content)
    };

    const assistantPlaceholder = {
      id: `local-assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      tokenEstimate: 0
    };

    setMessages((prev) => [...prev, userMessage, assistantPlaceholder]);
    setIsStreaming(true);
    let stalledByWatchdog = false;
    let stallTimer = null;
    let firstTokenSeen = false; // switches the watchdog from the first-token budget to the inter-token stall timer
    let liveProgressTimer = null; // hoisted so `finally` can always clear it

    try {
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      const refreshStallWatchdog = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          stalledByWatchdog = true;
          try { ctrl.abort(); } catch { /* no-op */ }
        }, firstTokenSeen ? STREAM_STALL_TIMEOUT_MS : STREAM_FIRST_TOKEN_BUDGET_MS);
      };
      const outboundSystemPrompt = uncensoredMode ? '' : systemPrompt;
      const outboundUsePersonalMemory = uncensoredMode ? false : usePersonalMemory;
      refreshStallWatchdog();
      const response = await fetch(`${API_BASE}/api/chats/${chatId}/messages/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: outboundContent,
          provider: resolvedProvider.provider,
          model: resolvedProvider.model,
          systemPrompt: outboundSystemPrompt,
          uncensoredMode,
          trainingMode,
          usePersonalMemory: outboundUsePersonalMemory,
          providerBaseUrl: resolvedProvider.providerBaseUrl,
          providerApiKey: resolvedProvider.providerApiKey,
          localOnly: appStore.getGoDark(),
          ...(pinModel ? { pinModel: true } : {}),
          ...(temperature !== null && isFinite(temperature) ? { temperature } : {}),
          ...(maxTokens !== null && isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
          ...(resolvedProvider.provider === 'ollama' && ollamaParams && Object.values(ollamaParams).some((v) => v != null)
            ? { ollamaOptions: ollamaParams }
            : {}),
        }),
        signal: ctrl.signal
      });

      if (!response.ok || !response.body) {
        // Show the server's `error` sentence, not the raw JSON body.
        const details = await response.text().catch(() => '');
        throw new Error(describeRunError(response.status, details));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf8');
      let buffer = '';
      refreshStallWatchdog();

      // Flush at most once per frame; a setMessages per token re-parses the whole
      // message through Markdown and Prism, O(n^2) on long answers.
      let pendingTokens = '';
      let tokenRafId = null;
      let tokenTimerId = null;
      const canRaf = typeof requestAnimationFrame === 'function';
      const flushTokens = () => {
        if (tokenRafId != null && canRaf) cancelAnimationFrame(tokenRafId);
        if (tokenTimerId != null) clearTimeout(tokenTimerId);
        tokenRafId = null;
        tokenTimerId = null;
        if (!pendingTokens) return;
        const add = pendingTokens;
        pendingTokens = '';
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          if (last.role === 'assistant') {
            const nextContent = `${last.content}${add}`;
            next[next.length - 1] = { ...last, content: nextContent, tokenEstimate: estimateTokens(nextContent) };
          }
          return next;
        });
      };
      // The setTimeout fallback keeps output flowing when a background window pauses rAF.
      const scheduleFlush = () => {
        if (canRaf && tokenRafId == null) tokenRafId = requestAnimationFrame(flushTokens);
        if (tokenTimerId == null) tokenTimerId = setTimeout(flushTokens, 250);
      };
      const cancelTokenFlush = () => {
        if (tokenRafId != null && canRaf) cancelAnimationFrame(tokenRafId);
        if (tokenTimerId != null) clearTimeout(tokenTimerId);
        tokenRafId = null;
        tokenTimerId = null;
        pendingTokens = '';
      };

      // Status line: token count, tok/s and elapsed time; a loading state before the first token.
      let liveTokenCount = 0;
      let liveFirstTokenTs = null;
      liveProgressTimer = setInterval(() => {
        if (liveFirstTokenTs == null) { setStatusText('Loading model...'); return; }
        const elapsed = (Date.now() - liveFirstTokenTs) / 1000;
        const tps = elapsed > 0 ? liveTokenCount / elapsed : 0;
        setStatusText(`${liveTokenCount.toLocaleString()} tok | ${tps >= 10 ? tps.toFixed(0) : tps.toFixed(1)} tok/s | ${elapsed.toFixed(0)}s`);
      }, 400);

      while (true) {
        const { done, value } = await reader.read();
        refreshStallWatchdog();
        if (done) {
          flushTokens();
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const chunkEnd = buffer.indexOf('\n\n');
          if (chunkEnd === -1) {
            break;
          }

          const chunk = buffer.slice(0, chunkEnd);
          buffer = buffer.slice(chunkEnd + 2);

          const lines = chunk
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);

          let event = 'message';
          let dataText = '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              event = line.slice(6).trim();
            }
            if (line.startsWith('data:')) {
              dataText += line.slice(5).trim();
            }
          }

          if (!dataText) {
            continue;
          }

          // A single malformed SSE chunk shouldn't abort the whole stream.
          let payload;
          try {
            payload = JSON.parse(dataText);
          } catch {
            continue;
          }

          if (event === 'meta' && payload.provider) {
            if (payload.numCtx || payload.tuning) {
              setResolvedTuning({ numCtx: payload.numCtx || null, note: payload.tuning && payload.tuning.note ? payload.tuning.note : null });
            }
            setMessages((prev) => {
              const next = [...prev];
              if (next.length > 0) {
                const last = next[next.length - 1];
                if (last.role === 'assistant') {
                  next[next.length - 1] = { ...last, effectiveProvider: payload.provider, effectiveModel: payload.model || '' };
                }
              }
              return next;
            });
          }

          if (event === 'token') {
            if (!firstTokenSeen) firstTokenSeen = true; // switch to the short inter-token stall timer
            refreshStallWatchdog();
            pendingTokens += payload.token || '';
            liveTokenCount += 1;
            if (liveFirstTokenTs == null) liveFirstTokenTs = Date.now();
            scheduleFlush();
          }

          if (event === 'notice' && payload.message) {
            // For example, an OOM retry reduced the runtime settings.
            setStatusText(payload.message);
          }

          if (event === 'error') {
            cancelTokenFlush();
            throw new Error(payload.error || 'Streaming error');
          }

          if (event === 'done') {
            // The full message supersedes buffered tokens; a late flush would append stale ones.
            cancelTokenFlush();
            playReceive(); // ICQ "message received" two-tone cue
            setMessages((prev) => {
              const next = [...prev];
              if (next.length > 0) {
                next[next.length - 1] = payload.message;
              }
              return next;
            });
            // The voice loop speaks the reply itself; skip auto-speak to avoid doubling.
            if (autoSpeakEnabled && !voiceActiveRef.current && payload?.message?.role === 'assistant') {
              speakText(payload.message.content || '', payload.message.id || null);
            }
          }

          if (event === 'titleUpdate' && payload.chatId && payload.title) {
            setChats((prev) => {
              const match = prev.find((c) => c.id === payload.chatId);
              if (!match || match.title === payload.title) return prev; // no-op if unchanged
              return prev.map((c) => c.id === payload.chatId ? { ...c, title: payload.title } : c);
            });
          }
        }
      }

      // No refreshChats() here: finishing just after clearAllChats() would restore
      // the cleared list. New chats and titles already arrive via the stream.
      if (trainingMode === 'fine-tuning') {
        await refreshTrainingStats();
      }
      if (stallTimer) clearTimeout(stallTimer);
      setStatusText('Ready');
    } catch (error) {
      if (stallTimer) clearTimeout(stallTimer);
      if (error?.name === 'AbortError') {
        if (stalledByWatchdog) {
          // Short label only: the status chip is fixed-width; the bubble has the detail.
          setStatusText('Timed out');
          setMessages((prev) => {
            const next = [...prev];
            if (next.length > 0 && next[next.length - 1].role === 'assistant' && !next[next.length - 1].content) {
              next[next.length - 1] = {
                ...next[next.length - 1],
                content: 'Error: no output, stream stopped. Try again or pick a smaller model.'
              };
            }
            return next;
          });
          return;
        }
        setStatusText('Stopped');
        setMessages((prev) => {
          const next = [...prev];
          if (next.length > 0 && next[next.length - 1].role === 'assistant' && !next[next.length - 1].content) {
            next.splice(next.length - 1, 1); // remove empty placeholder
          }
          return next;
        });
      } else {
        // Short label only: the status chip is fixed-width; the bubble has the detail.
        setStatusText(/Could not reach/i.test(String(error.message)) ? 'No engine' : 'Error');
        playError(); // ICQ error cue
        setMessages((prev) => {
          const next = [...prev];
          if (next.length > 0 && next[next.length - 1].role === 'assistant' && !next[next.length - 1].content) {
            // No provider/model stamp on a failed turn: nothing ran.
            const { effectiveProvider, effectiveModel, provider: _p, model: _m, performance, ...rest } = next[next.length - 1];
            next[next.length - 1] = { ...rest, failed: true, content: `Error: ${error.message}` };
          }
          return next;
        });
      }
    } finally {
      if (liveProgressTimer) clearInterval(liveProgressTimer);
      streamAbortRef.current = null;
      setIsStreaming(false);
    }
  }

  // Refreshed every render so the shell event listeners never call a stale closure.
  shortcutRef.current.createChat = createChat;
  shortcutRef.current.loadChat = loadChat;
  shortcutRef.current.closeAllDropdowns = closeAllDropdowns;
  // Reopens the section the user last viewed.
  shortcutRef.current.openSettings = () => {
    closeAllDropdowns();
    appStore.openSettings(settingsSection);
  };

  const currentAccess = accessMeta(accessLevel);
  const bypassOn = currentAccess.id === 'bypass';
  const shortcutLabel = settingsShortcutLabel();
  // Only a live run can take an answer; a stopping run's approvals are being cancelled.
  const pendingApprovals = agentRun?.status === 'running' && Array.isArray(agentRun.approvals) ? agentRun.approvals : [];
  const pendingApproval = pendingApprovals[0] || null;

  // The card is keyed by approval, so an answered one unmounts with focus on it.
  // Focus goes to the next card itself, never one of its buttons, so a second
  // Enter cannot approve an action the user has not read; with none left, to the composer.
  const shownApprovalId = pendingApproval?.approvalId || '';
  const lastApprovalIdRef = useRef('');
  useEffect(() => {
    const before = lastApprovalIdRef.current;
    lastApprovalIdRef.current = shownApprovalId;
    if (!before || before === shownApprovalId) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (shownApprovalId) {
      const card = document.querySelector(`[data-approval-card="${CSS.escape(shownApprovalId)}"]`);
      if (card instanceof HTMLElement) card.focus();
    } else if (voiceChatOpenRef.current) {
      // The orb is disabled without speech recognition; the panel's first button then.
      const target = document.querySelector('[data-voice-orb]:not([disabled])')
        || document.querySelector('[aria-labelledby="voice-chat-title"] button:not([disabled])');
      if (target instanceof HTMLElement) target.focus();
    } else if (!settingsOpenRef.current && mainRef.current?.offsetParent !== null) {
      composerInputRef.current?.focus();
    }
  }, [shownApprovalId]);

  const approvalCard = pendingApproval ? (
    <>
      <ApprovalCard
        key={pendingApproval.approvalId}
        approval={pendingApproval}
        busy={approvalBusyId === pendingApproval.approvalId}
        onDecide={(decision, note) => decideApproval(pendingApproval, decision, note)}
      />
      {pendingApprovals.length > 1 && (
        <p className="mt-1.5 px-1 text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
          {pendingApprovals.length - 1} more waiting
        </p>
      )}
    </>
  ) : null;

  // Settings sections, in the order the sheet lists them.
  const settingsSections = [
    {
      id: 'access',
      label: 'Access',
      icon: ShieldIcon,
      render: () => <AccessPane workspaceRoot={workspaceRoot} onOpenWorkspace={() => appStore.openWorkspace()} />
    },
    {
      id: 'connectors',
      label: 'Connectors',
      icon: PlugIcon,
      render: () => <ConnectorsPane />
    },
    {
      id: 'models',
      label: 'Models',
      icon: CubeIcon,
      render: () => (
        <ModelsPane
          view={modelsView}
          onViewChange={setModelsView}
          catalog={ollamaModels}
          ramGb={deviceRamGb}
          appleSilicon={appleSilicon}
          jobs={pullingModels}
          installErrors={installErrors}
          revision={modelsRevision}
          goDark={goDarkOn}
          onInstall={(name) => installModel(name)}
          onCancel={cancelInstall}
          onDelete={deleteOllamaModel}
          onDismissError={dismissInstallError}
          onRefresh={refreshOllamaModels}
        />
      )
    },
    {
      id: 'chat-tools',
      label: 'Chat tools',
      icon: SlidersIcon,
      render: () => (
        <ChatToolsSettings
          instructionsVisible={isSystemPromptVisible}
          instructionsLabel={selectedPromptProfileId === UNSAVED_PROMPT_PROFILE_ID ? 'Custom' : (selectedPromptProfile?.label || 'Default')}
          onInstructionsChange={(on) => {
            setIsSystemPromptVisible(on);
            // The editor lives in the sidebar, so make sure it can be seen.
            if (on && !sidebarOpen) {
              setSidebarOpen(true);
              safeStorageSet('mirabilis-sidebar-open', 'true');
            }
          }}
          webSearch={deepWebEnabled}
          webSearchStatus={webSearchStatus}
          goDark={goDarkOn}
          onWebSearchChange={setDeepWebEnabled}
          imageReady={imageServiceAvailable}
          imageDevice={imageServiceDevice}
          onCreateImage={handleCreateImageTool}
          vaultEnabled={configVaultEnabled}
          vaultStatus={configVaultStatus}
          vaultFolder={configVaultFolder}
          vaultBusy={configVaultBusy}
          vaultMessage={configVaultMsg}
          onVaultEnabledChange={setConfigVaultEnabled}
          onVaultFolderChange={setConfigVaultFolder}
          onIndexVault={indexConfigVault}
          onClearVault={clearConfigVault}
        />
      )
    },
    {
      id: 'voice',
      label: 'Voice',
      icon: MicIcon,
      render: () => (
        <VoiceSettings
          voiceTools={voiceTools}
          settingUpStt={isSettingUpStt}
          onSetupStt={setupStt}
          autoSpeak={autoSpeakEnabled}
          onAutoSpeakChange={setAutoSpeakEnabled}
          voiceSupported={voiceSupported}
          speaking={isSpeaking}
          onPreview={() => (isSpeaking ? stopSpeaking() : speakText('Voice preview from Mirabilis.'))}
          engine={voiceEngine}
          onEngineChange={setVoiceEngine}
          voices={availableVoices}
          voiceUri={selectedVoiceUri}
          onVoiceUriChange={setSelectedVoiceUri}
          rate={voiceRate}
          onRateChange={setVoiceRate}
          pitch={voicePitch}
          onPitchChange={setVoicePitch}
          piperModels={piperModels}
          piperModelId={selectedPiperModelId}
          onPiperModelChange={setSelectedPiperModelId}
          settingUpPiper={isSettingUpVoiceTools}
          onSetupPiper={setupVoiceTools}
          downloadingPiperId={downloadingPiperModelId}
          onDownloadPiper={downloadPiperModel}
        />
      )
    },
    {
      id: 'remote',
      label: 'Remote Control',
      icon: TerminalIcon,
      render: () => (
        <RemoteSettings
          connected={remoteConnected}
          target={remoteTarget}
          error={remoteError}
          type={remoteType}
          onTypeChange={(t) => { setRemoteType(t); setRemoteError(''); }}
          host={remoteHost}
          onHostChange={setRemoteHost}
          user={remoteUser}
          onUserChange={setRemoteUser}
          port={remotePort}
          onPortChange={setRemotePort}
          authType={remoteAuthType}
          onAuthTypeChange={setRemoteAuthType}
          keyPath={remoteKeyPath}
          onKeyPathChange={setRemoteKeyPath}
          password={remotePassword}
          onPasswordChange={setRemotePassword}
          connecting={remoteConnecting}
          onConnect={connectRemote}
          onDisconnect={disconnectRemote}
        />
      )
    },
    {
      id: 'labs',
      label: 'Labs',
      icon: FlaskIcon,
      render: () => (
        <LabsSettings
          canvas={canvasEnabled}
          onCanvasChange={setCanvasEnabled}
          guided={guidedLearningEnabled}
          onGuidedChange={setGuidedLearningEnabled}
          deepThinking={deepThinkingEnabled}
          onDeepThinkingChange={setDeepThinkingEnabled}
          openClaw={openClawMode}
          onOpenClawChange={() => { toggleOpenClawMode(); }}
          trainingMode={trainingMode}
          onTrainingModeChange={setTrainingMode}
          examples={trainingStats.fineTuningExamples}
          onExportExamples={exportTrainingExamples}
          personalMemory={usePersonalMemory}
          onPersonalMemoryChange={setUsePersonalMemory}
          memoryItems={trainingStats.memoryItems}
          onManageMemory={() => {
            showChatTab();
            setIsTeachPanelOpen(true);
            loadMemoryItems();
            appStore.closeSettings();
          }}
        />
      )
    }
  ];

  return (
    <main ref={mainRef} className="relative h-screen w-screen p-3 sm:p-6">
      <div className="mx-auto flex h-full max-w-7xl gap-3 rounded-3xl border border-[var(--panel-border)] bg-[var(--panel)] p-3 shadow-[0_24px_90px_-36px_rgba(15,23,42,0.45)] backdrop-blur-xl sm:gap-5 sm:p-5">
        <aside className={`flex shrink-0 flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--panel-border)] bg-[var(--material-thin)] p-2 sm:p-4 transition-all duration-200 ${sidebarOpen ? 'w-28 sm:w-72' : 'hidden'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="icq-mark">
                <svg viewBox="0 0 210 210" className="icq-mark-svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ICQ logo">
                  <g stroke="#000" strokeLinecap="round" strokeLinejoin="round" strokeWidth="13.229">
                    <g fill="#00ff03">
                      <path d="m106.61 110.23s-42.218-47.933-48.752-62.93c-6.534-14.998-4.4796-30.925 7.3807-35.35 11.86-4.4252 29.058 10.284 32.436 29.134 3.3782 18.85 8.9346 69.146 8.9346 69.146z"/>
                      <path d="m104.24 108.08s-3.4772-58.275 0-77.208c3.4772-18.933 21.955-27.771 36.631-23.482 14.676 4.2897 26.361 23.591 15.968 42.267-10.394 18.676-52.599 58.422-52.599 58.422z"/>
                      <path d="m104.14 106.37s40.123-44.003 58.085-48.769c17.962-4.7668 29.582-2.6383 34.339 9.6808 4.7576 12.319-7.0663 24.257-24.476 31.234-17.41 6.977-67.948 7.8542-67.948 7.8542z"/>
                      <path d="m103.95 105.45s64.011-10.41 80.734-0.91329c16.724 9.4971 17.563 19.84 16.256 31.234s-7.5384 23.693-28.129 23.197-68.862-53.518-68.862-53.518z"/>
                      <path d="m103.38 103.59s33.695 33.474 41.812 47.95c8.1173 14.476 5.3388 30.4-1.7262 35.866s-18.627 2.975-30.496-11.508c-11.869-14.483-9.59-72.308-9.59-72.308z"/>
                      <path d="m104.47 106.23s9.8769 64.267 0.54797 79.273c-9.329 15.006-22.579 21.054-35.001 17.249s-20.905-12.366-19.065-32.592c1.8397-20.226 53.518-63.93 53.518-63.93z"/>
                    </g>
                    <path d="m103.44 107.4s-35.939 37.331-51.327 40.732c-15.388 3.4011-23.473 2.9458-28.129-4.9317s-5.067-16.321 7.6716-27.216 71.784-8.5849 71.784-8.5849z" fill="#f5091f"/>
                    <path d="m102.01 107.02s-49.266 2.8098-69.592 0-24.215-11.647-23.745-23.745c0.46999-12.098 15.745-27.854 33.426-27.033s59.911 50.779 59.911 50.779z" fill="#00ff03"/>
                    <circle cx="103.56" cy="104.51" r="22.852" fill="#f8ee3e"/>
                  </g>
                </svg>
              </span>
              <h1 className="text-sm font-semibold tracking-tight sm:text-lg">Mirabilis AI</h1>
            </div>
            <TabSwitch active="chat" />
          </div>

          {isSystemPromptVisible && (
          <div className="rounded-[var(--r-lg)] border border-[var(--hairline)] bg-[var(--material-thin)] p-3 shadow-[0_10px_24px_-18px_rgba(15,23,42,0.25)]">
            <div className="space-y-2.5">
              {/* A saved profile's own description, if it has one; built-ins have none. */}
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--text-main)]">
                  Instructions
                </div>
                {selectedPromptProfile?.description ? (
                  <div className="min-w-0 truncate text-[10px] text-[color:var(--text-muted)]" title={selectedPromptProfile.description}>
                    {selectedPromptProfile.description}
                  </div>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                <label className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 rounded-xl border border-accent/30 bg-accentSoft/80 px-3 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.55)] dark:border-accent/30 dark:bg-accent/15 dark:text-accent">
                    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 shrink-0 opacity-80" fill="currentColor" aria-hidden="true">
                      <path d="M10 2l1.8 4.7L16.5 8l-4.7 1.3L10 14l-1.8-4.7L3.5 8l4.7-1.3L10 2z" />
                    </svg>
                    <select
                      value={selectedPromptProfileId}
                      onChange={(event) => applyPromptProfile(event.target.value)}
                      aria-label="Profile"
                      className="min-w-0 flex-1 bg-transparent py-2 text-[12px] font-semibold outline-none"
                    >
                      {promptProfileOptions.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
                <button
                  type="button"
                  onClick={saveCurrentPromptProfile}
                  className="shrink-0 rounded-xl bg-accent px-3 py-2 text-[11px] font-semibold text-white shadow-[0_10px_24px_-14px_rgba(26,168,111,0.9)] transition hover:brightness-95"
                >
                  Save
                </button>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 text-[10px] text-[color:var(--text-muted)]">
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={() => setSystemPrompt((selectedPromptProfile?.content || buildDefaultSystemPrompt(provider)))}
                    className="rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1 text-[10px] font-semibold text-[color:var(--text-main)] transition hover:bg-black/5 hover:text-[color:var(--text-main)] dark:hover:bg-[var(--material-thin)] dark:hover:text-[color:var(--text-main)]"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={deleteSelectedPromptProfile}
                    disabled={!selectedPromptProfile || selectedPromptProfile.isBuiltin}
                    className="rounded-lg border border-red-400/35 bg-[var(--material-thin)] px-2 py-1 text-[10px] font-semibold text-red-600 transition hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-400/25 dark:text-red-300 dark:hover:bg-red-950/30 dark:hover:text-red-200"
                  >
                    Delete
                  </button>
                  <span>{systemPrompt.trim().length.toLocaleString()} chars</span>
                </div>
              </div>

              <textarea
                value={systemPrompt}
                onChange={(event) => handleSystemPromptChange(event.target.value)}
                aria-label="Instructions"
                rows={4}
                className="w-full rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] px-3 py-2.5 text-[12px] leading-relaxed text-[color:var(--text-main)] outline-none transition focus:border-accent dark:text-[color:var(--text-main)]"
              />
            </div>
          </div>
          )}

          <div className="mb-2 mt-2 flex items-center gap-2">
            <input
              type="text"
              autoComplete="off"
              placeholder="Search"
              aria-label="Search chats"
              value={chatSearch}
              onChange={(e) => setChatSearch(e.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-[var(--hairline)] bg-[var(--material-thin)] px-2.5 py-1.5 text-xs outline-none placeholder:text-[color:var(--text-muted)] focus:border-accent dark:placeholder:text-[color:var(--text-muted)]"
            />
            <button
              onClick={() => createChat()}
              title="New chat"
              aria-label="New chat"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-[0_6px_14px_-8px_rgba(26,168,111,0.9)] transition hover:brightness-95"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            {/* Clear all: arms on the first click, clears on the second. */}
            {chats.length > 0 && (
              <button
                onClick={() => { if (clearArmed) { clearAllChats(); setClearArmed(false); } else { setClearArmed(true); } }}
                onMouseLeave={() => setClearArmed(false)}
                onBlur={() => setClearArmed(false)}
                title={clearArmed ? undefined : 'Clear all chats'}
                aria-label={clearArmed ? 'Confirm clear all chats' : 'Clear all chats'}
                className={`inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-full text-xs font-semibold transition ${
                  clearArmed
                    ? 'border border-red-500 bg-red-500 px-2 text-white'
                    : 'w-8 border border-[var(--hairline)] text-[color:var(--text-muted)] hover:border-red-400/55 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30'
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18" /><path d="M8 6V4.8c0-.7.6-1.3 1.3-1.3h5.4c.7 0 1.3.6 1.3 1.3V6" /><path d="M6.5 6l1 12.2c.1.8.7 1.3 1.5 1.3h6c.8 0 1.4-.5 1.5-1.3L17.5 6" />
                </svg>
                {clearArmed && <span>Clear all?</span>}
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto scroll-thin pr-1">
            <ul className="space-y-2">
              {sortedAndFilteredChats.map((chat) => (
                <ChatItem
                  key={chat.id}
                  chat={chat}
                  isActive={chat.id === activeChatId}
                  isMenuOpen={openChatMenuId === chat.id}
                  isPinned={pinnedChatIds.has(chat.id)}
                  onSelect={loadChat}
                  onToggleMenu={(id) => setOpenChatMenuId((current) => (current === id ? null : id))}
                  onBranch={branchChat}
                  onDelete={removeChat}
                  onRename={renameChat}
                  onExport={exportChat}
                  onTogglePin={togglePin}
                />
              ))}
              {sortedAndFilteredChats.length === 0 && (
                <li className="rounded-lg border border-dashed border-black/20 p-3 text-xs text-[color:var(--text-muted)]">
                  {chatSearch.trim() ? 'No matches' : 'No chats yet'}
                </li>
              )}
            </ul>
          </div>
        </aside>

        <section
          className={`relative flex min-w-0 flex-1 flex-col rounded-2xl border p-3 sm:p-5 ${
            isDragOverChat
              ? 'border-accent bg-accentSoft/35 dark:bg-accent/10'
              : 'border-[var(--panel-border)] bg-[var(--material-thin)]'
          }`}
          onDragEnter={handleChatDragEnter}
          onDragOver={handleChatDragOver}
          onDragLeave={handleChatDragLeave}
          onDrop={handleChatDrop}
        >
          {isDragOverChat && (
            <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-[var(--material-thin)]">
              <div className="rounded-full border border-accent/40 bg-accentSoft px-4 py-2 text-sm font-semibold text-ink dark:bg-accent/20 dark:text-white">
                Drop to attach
              </div>
            </div>
          )}
          <header className="mb-3 border-b border-black/10 pb-3">
            <div className="flex items-center justify-between gap-2">
              {/* LEFT zone: sidebar toggle + status + hardware chips + web-search */}
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setSidebarOpen((v) => { const next = !v; safeStorageSet('mirabilis-sidebar-open', String(next)); return next; })}
                  title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                  className="shrink-0 rounded p-1 text-[color:var(--text-muted)] transition hover:bg-black/5 hover:text-[color:var(--text-main)] dark:hover:bg-[var(--material-thin)] dark:hover:text-slate-200"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {sidebarOpen
                      ? <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></>
                      : <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></>
                    }
                  </svg>
                </button>
                <p
                  role="status" aria-live="polite" aria-atomic="true"
                  title={statusText}
                  className={`min-w-0 max-w-[16ch] truncate font-mono text-xs ${
                    (engineUp === false || statusText === 'No engine' || statusText === 'Error')
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-[color:var(--text-muted)]'
                  }`}
                >
                  {engineUp === false && statusText === 'Ready' ? 'No engine' : statusText}
                </p>

                {/* No overflow wrapper: it would clip each chip's absolute popover. */}
                <div className="flex min-w-0 items-center gap-1.5">
                  {['logic', 'memory', 'compute', 'npu'].map((key) => {
                    const item = hardwareProfile[key];
                    if (!item?.label) return null;
                    const isActive = isStreaming && (key === 'compute' || key === 'npu');
                    const fillPct = key === 'logic' ? utilization.cpuPct : key === 'memory' ? utilization.memPct : 0;
                    const fillColor = fillPct >= 80
                      ? 'bg-red-400/25 dark:bg-red-500/20'
                      : fillPct >= 60
                      ? 'bg-amber-400/25 dark:bg-amber-500/20'
                      : 'bg-green-400/20 dark:bg-green-500/15';
                    const shortLabel = key === 'logic'
                      ? `CPU ${utilization.cpuPct}%`
                      : key === 'memory'
                      ? `RAM ${utilization.memPct}%`
                      : key === 'compute'
                      ? 'GPU'
                      : 'NPU';
                    return (
                      <div key={key} data-menu-container="true" className="relative shrink-0">
                        <button
                          type="button"
                          data-menu-trigger={`hardware-${key}`}
                          aria-haspopup="true"
                          aria-expanded={openHardwarePopover === key}
                          onClick={() => {
                            setIsContextPanelOpen(false);
                            setOpenHardwarePopover((current) => (current === key ? null : key));
                          }}
                          className={`relative inline-flex items-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)] ${
                            isActive
                              ? 'border-green-400/60 bg-green-50/80 text-green-700 dark:border-green-500/40 dark:bg-green-900/20 dark:text-green-400'
                              : 'border-black/10 bg-[var(--material-thin)] text-[color:var(--text-muted)]'
                          }`}
                        >
                          {fillPct > 0 && !isActive && (
                            <span
                              aria-hidden="true"
                              className={`pointer-events-none absolute inset-y-0 left-0 rounded-full transition-all duration-700 ${fillColor}`}
                              style={{ width: `${fillPct}%` }}
                            />
                          )}
                          <span className="relative whitespace-nowrap">{shortLabel}</span>
                        </button>
                        {openHardwarePopover === key ? (
                          <div data-menu-panel={`hardware-${key}`} role="group" aria-label={`${shortLabel} details`} tabIndex={-1} className="absolute left-0 top-full z-20 mt-2 w-72 rounded-xl border border-[var(--hairline)] au-chrome au-elev-2 p-2 text-[11px] text-[color:var(--text-muted)]">
                            <div className="font-semibold text-[color:var(--text-main)] mb-1">{item.label}</div>
                            {item.expanded ? item.expanded.split('\n').map((line, i) => (
                              <div key={i} className="text-[color:var(--text-muted)]">{line}</div>
                            )) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

              </div>

              {/* RIGHT zone: contextual actions */}
              <div className="flex shrink-0 items-center gap-1.5">
                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={runCommitmentRadar}
                    disabled={radarLoading}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--hairline)] bg-black/5 px-2 py-0.5 text-[11px] font-medium text-[color:var(--text-muted)] transition hover:bg-black/10 hover:text-[color:var(--text-main)] disabled:opacity-50 dark:bg-[var(--material-thin)] dark:hover:bg-[var(--material-thin)]"
                  >
                    <RadarIcon size={12} />
                    {radarLoading ? 'Scanning...' : 'Radar'}
                  </button>
                )}
                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={commitChatToLedger}
                    disabled={isCommittingToLedger}
                    className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent transition hover:bg-accent/20 disabled:opacity-50 dark:border-accent/30 dark:bg-accent/15 dark:hover:bg-accent/25"
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M9 12h6M12 9v6"/>
                    </svg>
                    {isCommittingToLedger ? 'Committing...' : 'To Ledger'}
                  </button>
                )}
              </div>
            </div>

            {remoteUsage.enabled && (
              <div className="mt-1.5 rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1.5">
                <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-mono text-[color:var(--text-muted)]">
                  <span>{PROVIDER_OPTIONS.find((o) => o.id === provider)?.label || provider} est. {formatUsdEstimate(remoteUsage.estUsd)} / ${remoteUsage.budgetUsd.toFixed(2)}</span>
                  <span>{formatUsagePercent(remoteUsage.estUsd, remoteUsage.budgetUsd)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-[var(--material-thin)]">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${remoteUsage.pct >= 90 ? 'bg-red-500' : remoteUsage.pct >= 70 ? 'bg-amber-500' : 'bg-accent'}`}
                    style={{ width: `${Math.max(2, remoteUsage.pct)}%` }}
                  />
                </div>
              </div>
            )}
          </header>

          <div
            ref={messagesScrollRef}
            onScroll={(e) => {
              // Ignore scrolls we caused ourselves
              if (isProgrammaticScrollRef.current) return;

              const el = e.currentTarget;
              const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
              const atBottom = distFromBottom < 40;
              const scrollingUp = el.scrollTop < lastScrollTopRef.current - 2;
              lastScrollTopRef.current = el.scrollTop;

              setShowScrollDown(!atBottom);

              if (scrollingUp) {
                // User scrolled up - pause auto-scroll
                autoScrollRef.current = false;
                setAutoScrollEnabled(false);
              } else if (atBottom) {
                // User reached bottom - resume auto-scroll
                autoScrollRef.current = true;
                setAutoScrollEnabled(true);
              }
            }}
            className="flex-1 overflow-y-auto scroll-thin"
          >
            <div className={`mx-auto w-full space-y-3 pr-1 ${sidebarOpen ? 'max-w-3xl' : 'max-w-5xl'}`}>
            {activeChatMeta?.ephemeral && (
              <div className="flex items-center justify-center gap-1.5 rounded-2xl border border-dashed border-amber-400/50 bg-amber-500/10 px-3 py-2 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                <IncognitoIcon size={13} />
                <span>Off the Record: never saved to disk</span>
              </div>
            )}
            {activeChatId && (
              <section className="rounded-2xl border border-[var(--hairline)] bg-[var(--material-thin)] p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-[color:var(--text-main)]">Branches and snapshots</h3>
                    {/* A branch shows where it came from; the backend names it "Branch <date>" by default. */}
                    {activeChatMeta?.parentChatId ? (
                      <p className="text-[11px] text-[color:var(--text-muted)]">
                        {activeChatMeta?.branchLabel || 'Branch'}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => branchChat(activeChatId)}
                      className="rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                    >
                      Branch
                    </button>
                    <button
                      type="button"
                      onClick={saveSnapshot}
                      className="rounded-xl bg-accent px-3 py-1.5 text-[11px] font-semibold text-white shadow-[0_10px_24px_-14px_rgba(26,168,111,0.9)] transition hover:brightness-95"
                    >
                      Save snapshot
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <select
                    value={selectedSnapshotId}
                    onChange={(event) => setSelectedSnapshotId(event.target.value)}
                    aria-label="Snapshot"
                    disabled={!Array.isArray(activeChatMeta?.snapshots) || activeChatMeta.snapshots.length === 0}
                    className="min-w-0 flex-1 rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] px-3 py-2 text-xs outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {Array.isArray(activeChatMeta?.snapshots) && activeChatMeta.snapshots.length > 0 ? (
                      [...activeChatMeta.snapshots].reverse().map((snapshot) => (
                        <option key={snapshot.id} value={snapshot.id}>
                          {snapshot.label} | {snapshot.messageCount} messages
                        </option>
                      ))
                    ) : (
                      <option value="">No snapshots</option>
                    )}
                  </select>
                  <button
                    type="button"
                    onClick={restoreSnapshot}
                    disabled={!selectedSnapshotId}
                    className="rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] px-3 py-2 text-[11px] font-semibold text-[color:var(--text-main)] transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-[var(--material-thin)]"
                  >
                    Restore
                  </button>
                </div>
              </section>
            )}
            {canvasEnabled && (
              <section className="rounded-2xl border border-[var(--hairline)] bg-[var(--material-thin)] p-3">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Canvas</h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCanvasText('')}
                      className="rounded-md border border-[var(--hairline)] px-2 py-1 text-[11px] text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={() => setCanvasEnabled(false)}
                      className="rounded-md border border-[var(--hairline)] px-2 py-1 text-[11px] text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                    >
                      Hide
                    </button>
                  </div>
                </div>
                <textarea
                  value={canvasText}
                  onChange={(event) => setCanvasText(event.target.value)}
                  rows={6}
                  aria-label="Canvas"
                  className="w-full resize-y rounded-xl border border-[var(--hairline)] bg-[var(--material-thin)] px-3 py-2 text-sm outline-none focus:border-accent"
                />
              </section>
            )}

            {messages.length === 0 && (
              <div className="au-enter flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center">
                <span
                  aria-hidden="true"
                  className="au-orb-ring icq-mark flex h-32 w-32 items-center justify-center sm:h-36 sm:w-36"
                  style={{ boxShadow: 'inset 0 0 0 1px var(--hairline), 0 0 0 6px color-mix(in srgb, var(--accent) 14%, transparent), var(--shadow-3)' }}
                >
                  <FlowerMark size={120} />
                </span>
                <h2 className="text-[length:var(--text-xl)] font-[650] tracking-tight text-[color:var(--text-main)]">
                  {activeChatId ? 'New chat' : 'Welcome to Mirabilis AI'}
                </h2>

                {/* No engine reachable: what to install and run. */}
                {engineUp === false && (
                  <div className="w-full max-w-md rounded-[var(--r-lg)] border border-amber-400/40 bg-amber-50/70 p-4 text-left dark:border-amber-400/25 dark:bg-amber-950/20">
                    <p className="mb-2 text-[length:var(--text-sm)] font-semibold text-amber-900 dark:text-amber-200">
                      Set up a local model
                    </p>
                    <ol className="space-y-2 text-[length:var(--text-sm)] leading-relaxed text-amber-900/90 dark:text-amber-200/90">
                      <li>
                        1. Install Ollama from{' '}
                        <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">ollama.com</a>
                      </li>
                      <li>
                        2. Start it and pull a model:
                        <code className="mt-1 block whitespace-pre rounded-md bg-black/10 px-2 py-1 font-mono text-[length:var(--text-xs)] dark:bg-black/30">
                          {'ollama serve\nollama pull gemma3:12b'}
                        </code>
                      </li>
                    </ol>
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {!activeChatId && (
                    <button
                      type="button"
                      onClick={createChat}
                      className="au-focus rounded-[var(--r-lg)] px-5 py-2.5 text-[length:var(--text-sm)] font-semibold text-white shadow-[var(--shadow-2)] transition hover:brightness-110 active:scale-[0.98]"
                      style={{ background: 'var(--accent)' }}
                    >
                      New chat
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => { try { window.dispatchEvent(new CustomEvent('mirabilis:open-command')); } catch {} }}
                    className="au-focus au-hairline au-material rounded-[var(--r-lg)] px-4 py-2.5 text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)] transition hover:brightness-105"
                  >
                    ⌘K Commands
                  </button>
                </div>
              </div>
            )}

            <RemoteExecContext.Provider value={remoteExecValue}>
            {messages.map((message, idx) => {
              // An empty trailing reply is drawn by the typing indicator below.
              if (showTypingIndicator && idx === messages.length - 1) return null;
              return (
              <MessageRow
                key={message.id}
                message={message}
                isLast={idx === messages.length - 1}
                busy={isStreaming && idx === messages.length - 1}
                speakingMessageId={speakingMessageId}
                isSpeaking={isSpeaking}
                voiceEngine={voiceEngine}
                voiceSupported={voiceSupported}
                stopSpeaking={stopSpeaking}
                speakText={speakText}
                regenerate={regenerate}
              />
              );
            })}
            {/* Outside MessageRow so streaming flags do not invalidate every row's memo. */}
            {showTypingIndicator && (
              <div
                className="w-full rounded-[var(--r-lg)] px-4 py-2.5"
                style={{ background: 'color-mix(in srgb, var(--text-main) 4%, transparent)' }}
              >
                <div className="flex items-center gap-2 py-1" style={{ color: 'var(--accent)' }}>
                  <span className="au-typing" role="status" aria-label="Assistant is typing"><i /><i /><i /></span>
                </div>
              </div>
            )}
            </RemoteExecContext.Provider>
            </div>
          </div>

          {isTeachPanelOpen && (
            <section className="mt-3 rounded-2xl border border-[var(--hairline)] bg-[var(--material-thin)] p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Personal memory</h3>
                <button
                  type="button"
                  onClick={() => setIsTeachPanelOpen(false)}
                  className="rounded-md border border-[var(--hairline)] px-2 py-1 text-[11px] text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                >
                  Close
                </button>
              </div>
              <div className="mb-2 flex gap-2">
                <input
                  type="text"
                  value={memoryInput}
                  onChange={(e) => setMemoryInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMemoryItem(); } }}
                  placeholder="I prefer concise answers"
                  aria-label="New memory"
                  className="flex-1 rounded-xl border border-[var(--hairline)] bg-[var(--material-thin)] px-3 py-1.5 text-xs outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={addMemoryItem}
                  disabled={!memoryInput.trim()}
                  className="rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                >
                  Add
                </button>
              </div>
              {memoryItems.length === 0 ? (
                <p className="text-[11px] text-[color:var(--text-muted)]">No memories</p>
              ) : (
                <ul className="max-h-48 space-y-1 overflow-y-auto scroll-thin">
                  {memoryItems.map((item) => (
                    <li key={item.id} className="flex items-start justify-between gap-2 rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1.5">
                      <span className="flex-1 text-[11px] text-[color:var(--text-main)]">{item.text}</span>
                      <button
                        type="button"
                        onClick={() => deleteMemoryItem(item.id)}
                        className="shrink-0 rounded px-1 text-[10px] text-[color:var(--text-muted)] transition hover:text-red-500"
                        title="Remove"
                      ><CloseIcon size={11} /></button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <footer className="relative mt-3 border-t border-black/10 pt-3">
            {/* Sits just above the composer, whatever its height. */}
            {(showScrollDown || !autoScrollEnabled) && (
              <div className="pointer-events-none absolute bottom-full left-0 right-0 z-20 mb-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => {
                    const el = messagesScrollRef.current;
                    if (!el) return;
                    autoScrollRef.current = true;
                    setAutoScrollEnabled(true);
                    setShowScrollDown(false);
                    isProgrammaticScrollRef.current = true;
                    lastScrollTopRef.current = el.scrollHeight; // set baseline to destination now
                    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                    setTimeout(() => { isProgrammaticScrollRef.current = false; }, 600);
                  }}
                  className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-accent/30 bg-accentSoft px-3 text-[11px] font-semibold text-ink shadow-[0_4px_16px_-4px_rgba(15,23,42,0.18)] backdrop-blur-sm transition hover:bg-accent/20 dark:border-accent/30 dark:bg-accent/15 dark:text-accent dark:hover:bg-accent/25"
                  title="Scroll to bottom"
                  aria-label="Scroll to bottom"
                >
                  {isStreaming && !autoScrollEnabled ? <span className="inline-flex items-center gap-1">New messages <ArrowDownIcon size={12} /></span> : <ArrowDownIcon size={14} />}
                </button>
              </div>
            )}
            {/* An action waiting for the user sits on top, nearest the transcript.
                During voice chat it shows in the voice panel instead, which covers this. */}
            {pendingApproval && !voiceChatOpen && (
              <div className="mb-3">
                {approvalCard}
              </div>
            )}
            {/* Toolbar. Left: model, effort, access and settings. Right: active modes + tokens,
                which drop to their own line before the controls would wrap. */}
            <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Model unit: provider and model triggers read as one pill */}
                <div className="flex items-center gap-0.5 rounded-[var(--r-md)] au-hairline au-material px-0.5">
                <div data-menu-container="true" className="relative flex items-center gap-1">
                <div data-menu-container="true" className="relative">
                  <button
                    type="button"
                    data-menu-trigger="provider"
                    aria-haspopup="true"
                    aria-expanded={isProviderMenuOpen}
                    onClick={() => {
                      setIsModelMenuOpen(false);
                      setIsEffortMenuOpen(false);
                      setIsAccessMenuOpen(false);
                      setOpenHardwarePopover(null);
                      setIsContextPanelOpen(false);
                      setProviderSearch('');
                      setIsProviderMenuOpen((prev) => !prev);
                      setIsProviderConfigOpen(false);
                      if (installingBinary?.done) setInstallingBinary(null);
                    }}
                    className="inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-main)] transition hover:bg-[color:var(--hairline)]"
                  >
                    <span className="max-w-[9rem] truncate">{PROVIDER_OPTIONS.find((opt) => opt.id === provider)?.label || provider}</span>
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                      <path d="M5.25 7.5L10 12.25 14.75 7.5" />
                    </svg>
                  </button>

                  {isProviderMenuOpen && (
                    <div data-menu-panel="provider" role="group" aria-label="Provider" tabIndex={-1} className="absolute bottom-9 left-0 z-20 flex max-h-[min(70vh,460px)] w-72 flex-col overflow-hidden rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
                      {/* Search box - keeps the picker usable as providers grow */}
                      <div className="shrink-0 border-b border-black/10 p-2">
                        <input
                          type="text"
                          autoFocus
                          value={providerSearch}
                          onChange={(e) => setProviderSearch(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Escape') { setProviderSearch(''); setIsProviderMenuOpen(false); }
                          }}
                          placeholder="Search"
                          aria-label="Search providers"
                          className="au-focus w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1.5 text-xs text-[color:var(--text-main)] outline-none placeholder:text-[color:var(--text-muted)]"
                        />
                      </div>
                      {/* Grouped, scrollable list - capped height so the top is never off-screen */}
                      <div className="min-h-0 flex-1 overflow-y-auto p-1">
                        {(() => {
                          const q = providerSearch.trim().toLowerCase();
                          // vLLM shows under "Local" until given a remote URL, then "Remote".
                          const vllmHasRemote = !!String(providerConfigs?.vllm?.baseUrl || '').trim();
                          const effGroup = (o) => (o.id === 'vllm' ? (vllmHasRemote ? 'Remote' : 'Local') : o.group);
                          const groups = PROVIDER_GROUPS
                            .map((g) => ({ group: g, items: PROVIDER_OPTIONS.filter((o) => effGroup(o) === g && (!q || o.label.toLowerCase().includes(q) || o.id.includes(q))) }))
                            .filter((g) => g.items.length);
                          if (!groups.length) {
                            return <div className="px-2 py-3 text-center text-[11px] text-[color:var(--text-muted)]">No matches</div>;
                          }
                          return groups.map(({ group, items }) => (
                            <div key={group} className="mb-1 last:mb-0">
                              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">{group}</div>
                              {items.map((opt) => {
                                const binaryMissing = opt.requiresBinary && localBinaryStatus[opt.requiresBinary] !== true;
                                const isInstalling = installingBinary?.provider === opt.requiresBinary && !installingBinary?.done;
                                const disabled = binaryMissing;
                                return (
                                  <div key={opt.id} className="relative">
                                    <button
                                      type="button"
                                      disabled={disabled}
                                      onClick={() => {
                                        if (disabled) return;
                                        setProvider(opt.id);
                                        setIsProviderMenuOpen(false);
                                        setProviderSearch('');
                                        setStatusText(`Provider: ${opt.label}`);
                                        const cloudOnlyProviders = ['openai', 'grok', 'groq', 'openrouter', 'gemini', 'cerebras', 'claude', 'gpuaas', 'vllm'];
                                        if (cloudOnlyProviders.includes(opt.id)) {
                                          setModel((m) => (typeof m === 'string' && m.toLowerCase().endsWith('.gguf') ? 'auto' : m));
                                        }
                                        if (opt.id !== 'ollama' && !String(providerConfigs[opt.id]?.baseUrl || '').trim()) {
                                          setIsProviderConfigOpen(true);
                                        }
                                      }}
                                      className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition ${
                                        disabled
                                          ? 'cursor-not-allowed opacity-40'
                                          : provider === opt.id
                                            ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                                            : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                                      }`}
                                    >
                                      <span className="flex min-w-0 flex-col">
                                        <span className="truncate">{opt.label}</span>
                                        {/* The group header already says where it runs. */}
                                        {binaryMissing ? <span className="text-[10px] opacity-60">Not installed</span> : null}
                                      </span>
                                      {!disabled && provider === opt.id ? <span className="ml-2 shrink-0 text-[10px] opacity-70">active</span> : null}
                                    </button>
                                    {binaryMissing && (
                                      <button
                                        type="button"
                                        disabled={isInstalling}
                                        onClick={(e) => { e.stopPropagation(); installLocalProvider(opt.requiresBinary); setIsProviderMenuOpen(false); }}
                                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
                                      >
                                        {isInstalling ? 'Installing...' : 'Install'}
                                      </button>
                                    )}
                                    {!binaryMissing && opt.requiresBinary && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          api(`/api/providers/local/${encodeURIComponent(opt.requiresBinary)}`, { method: 'DELETE' })
                                            .then(() => setLocalBinaryStatus((prev) => ({ ...prev, [opt.requiresBinary]: false })))
                                            .catch(() => {});
                                          if (provider === opt.id) setProvider('ollama');
                                          setIsProviderMenuOpen(false);
                                        }}
                                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--text-muted)] hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                                      >
                                        Uninstall
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ));
                        })()}
                      </div>
                      {/* Footer: configure the current non-Ollama endpoint */}
                      {provider !== 'ollama' && (
                        <button
                          type="button"
                          onClick={() => {
                            setIsProviderMenuOpen(false);
                            setProviderSearch('');
                            setIsProviderConfigOpen(true);
                          }}
                          className="flex shrink-0 w-full items-center justify-between border-t border-black/10 px-3 py-2 text-left text-xs text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                        >
                          <span>Configure endpoint</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Provider binary install progress panel */}
                {installingBinary && (
                  <div className="absolute bottom-12 left-0 z-30 w-72 rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] p-3 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium text-[color:var(--text-main)]">
                        Installing {installingBinary.provider}
                      </span>
                      {installingBinary.done && (
                        <button type="button" onClick={() => setInstallingBinary(null)} aria-label="Close" title="Close" className="text-[10px] text-[color:var(--text-muted)] hover:text-[color:var(--text-main)] dark:hover:text-slate-200"><CloseIcon size={11} /></button>
                      )}
                    </div>
                    <div className="max-h-32 overflow-y-auto space-y-0.5">
                      {installingBinary.lines.map((line, i) => (
                        <p key={i} className={`text-[11px] ${line.type === 'error' ? 'text-red-500' : line.type === 'done' ? 'text-green-500' : line.type === 'warn' ? 'text-yellow-500' : 'text-[color:var(--text-main)]'}`}>
                          {line.text}
                        </p>
                      ))}
                      {!installingBinary.done && <p className="text-[11px] text-[color:var(--text-muted)] animate-pulse">...</p>}
                    </div>
                  </div>
                )}

                {/* Provider config panel */}
                {provider !== 'ollama' && isProviderConfigOpen && (
                  <div data-menu-container="true" className="absolute bottom-12 left-0 z-30 w-96 rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] p-3 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
                    <p className="mb-1 text-xs font-semibold text-[color:var(--text-main)]">
                      {PROVIDER_OPTIONS.find((o) => o.id === provider)?.label}
                    </p>
                    {provider === 'koboldcpp' && (
                      <p className="mb-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                        Requires KoboldCpp running on this computer
                      </p>
                    )}
                    {provider === 'llamacpp' && (
                      <div className="mb-2 rounded-lg border border-[var(--hairline)] p-2">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Local engine</span>
                          <span className={`text-[10px] font-medium ${llamacppStatus?.running ? 'text-emerald-600 dark:text-emerald-300' : llamacppStatus?.installed ? 'text-amber-600 dark:text-amber-300' : 'text-[color:var(--text-muted)]'}`}>
                            {llamacppStatus?.running ? 'Running' : llamacppStatus?.installed ? 'Not running' : 'Not installed'}
                          </span>
                        </div>
                        {!llamacppStatus?.installed ? (
                          <p className="text-[10px] leading-relaxed text-[color:var(--text-muted)]">
                            Install with <code className="rounded bg-black/5 px-1 dark:bg-white/10">brew install llama.cpp</code>
                          </p>
                        ) : llamacppStatus?.running ? (
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-[11px] text-[color:var(--text-main)]">{llamacppStatus.model} @ {llamacppStatus.baseUrl}</span>
                            <button type="button" onClick={stopLlamacpp} disabled={isLlamacppBusy} className="shrink-0 rounded-lg border border-[var(--hairline)] px-2 py-1 text-[11px] font-medium text-red-500 transition hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-900/20">
                              {isLlamacppBusy ? '...' : 'Stop'}
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            {llamacppLaunchable.length > 0 ? (
                              <select
                                value={llamacppModel}
                                onChange={(e) => setLlamacppModel(e.target.value)}
                                aria-label="Model"
                                className="au-focus w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1 text-[11px] text-[color:var(--text-main)] outline-none"
                              >
                                {llamacppLaunchable.map((id) => <option key={id} value={id}>{id}</option>)}
                              </select>
                            ) : (
                              <input
                                type="text"
                                value={llamacppModel}
                                onChange={(e) => setLlamacppModel(e.target.value)}
                                placeholder="qwen3:8b"
                                aria-label="Model name or .gguf path"
                                className="au-focus w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1 text-[11px] text-[color:var(--text-main)] outline-none placeholder:text-[color:var(--text-muted)]"
                              />
                            )}
                            <button type="button" onClick={startLlamacpp} disabled={isLlamacppBusy || !llamacppModel.trim()} className="w-full rounded-lg bg-accent px-2 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50">
                              {isLlamacppBusy ? 'Starting...' : 'Start'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {provider === 'openai-compatible' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        Any OpenAI-compatible endpoint
                      </p>
                    )}
                    {provider === 'gpuaas' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        Any OpenAI-compatible endpoint
                      </p>
                    )}
                    {provider === 'vllm' && (
                      <div className="mb-2 rounded-lg border border-[var(--hairline)] p-2">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Local vLLM (NVIDIA GPU)</span>
                          <span className={`text-[10px] font-medium ${vllmStatus?.running ? 'text-emerald-600 dark:text-emerald-300' : vllmStatus?.canRunLocal ? 'text-amber-600 dark:text-amber-300' : 'text-[color:var(--text-muted)]'}`}>
                            {vllmStatus?.running ? 'Running' : vllmStatus?.canRunLocal ? 'Not running' : 'Unavailable'}
                          </span>
                        </div>
                        {vllmStatus?.canRunLocal ? (
                          vllmStatus?.running ? (
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate text-[11px] text-[color:var(--text-main)]">{vllmStatus.model} @ {vllmStatus.baseUrl}</span>
                              <button type="button" onClick={stopLocalVllm} disabled={isVllmBusy} className="shrink-0 rounded-lg border border-[var(--hairline)] px-2 py-1 text-[11px] font-medium text-red-500 transition hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-900/20">
                                {isVllmBusy ? '...' : 'Stop'}
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                value={vllmLocalModel}
                                onChange={(e) => setVllmLocalModel(e.target.value)}
                                placeholder="Qwen/Qwen2.5-7B-Instruct"
                                aria-label="Hugging Face model id"
                                className="au-focus min-w-0 flex-1 rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1 text-[11px] text-[color:var(--text-main)] outline-none placeholder:text-[color:var(--text-muted)]"
                              />
                              <button type="button" onClick={startLocalVllm} disabled={isVllmBusy || !vllmLocalModel.trim()} className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50">
                                {isVllmBusy ? 'Starting...' : 'Start'}
                              </button>
                            </div>
                          )
                        ) : (
                          <p className="text-[10px] leading-relaxed text-[color:var(--text-muted)]">
                            {vllmStatus?.reason || 'Checking hardware...'}
                          </p>
                        )}
                      </div>
                    )}
                    {/* Cloud providers need no note: the URL placeholder and "(required)" on the key say it. */}
                    <label className="mb-1 block text-[11px] text-[color:var(--text-muted)]">Base URL</label>
                    <input
                      type="text"
                      className="mb-2 w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1 text-xs text-[color:var(--text-main)] outline-none focus:ring-1 focus:ring-accentSoft dark:text-[color:var(--text-main)]"
                      placeholder={provider === 'koboldcpp' ? 'http://127.0.0.1:5001/v1' : provider === 'openai' ? 'https://api.openai.com/v1' : provider === 'grok' ? 'https://api.x.ai/v1' : provider === 'groq' ? 'https://api.groq.com/openai/v1' : provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai' : provider === 'cerebras' ? 'https://api.cerebras.ai/v1' : provider === 'claude' ? 'https://api.anthropic.com' : provider === 'gpuaas' ? 'https://gpu.example.com/v1' : provider === 'vllm' ? 'http://gpu-host:8000/v1' : 'http://127.0.0.1:1234/v1'}
                      aria-label="Base URL"
                      value={providerConfigs[provider]?.baseUrl || ''}
                      onChange={(e) => setProviderConfigs((prev) => ({ ...prev, [provider]: { ...prev[provider], baseUrl: e.target.value } }))}
                    />
                    {(provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas' || provider === 'openai-compatible' || provider === 'vllm') && (
                      <>
                        <label className="mb-1 block text-[11px] text-[color:var(--text-muted)]">API key <span className="opacity-60">{provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas' ? '(required)' : '(optional)'}</span></label>
                        <div className="mb-2 flex gap-1">
                          <input
                            type="password"
                            className="min-w-0 flex-1 rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1 text-xs text-[color:var(--text-main)] outline-none focus:ring-1 focus:ring-accentSoft dark:text-[color:var(--text-main)]"
                            placeholder={provider === 'openai' ? 'sk-...' : provider === 'grok' ? 'xai-...' : provider === 'groq' ? 'gsk_...' : provider === 'openrouter' ? 'sk-or-...' : provider === 'gemini' ? 'AIza...' : provider === 'cerebras' ? 'csk-...' : provider === 'claude' ? 'sk-ant-...' : provider === 'gpuaas' ? undefined : 'sk-...'}
                            aria-label="API key"
                            value={keyDraft}
                            onChange={(e) => setKeyDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && keyDraft.trim()) saveProviderKey(provider, keyDraft.trim()); }}
                          />
                          {keyDraft.trim() ? (
                            <button
                              type="button"
                              onClick={() => saveProviderKey(provider, keyDraft.trim())}
                              className="flex-shrink-0 rounded-lg bg-accent px-2 py-1 text-xs font-semibold text-white transition hover:brightness-95"
                            >
                              Save
                            </button>
                          ) : keyHints[provider]?.hasKey ? (
                            <button
                              type="button"
                              onClick={() => clearProviderKey(provider)}
                              className="flex-shrink-0 rounded-lg border border-[var(--hairline)] px-2 py-1 text-xs text-[color:var(--text-muted)] transition hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:text-[color:var(--text-muted)] dark:hover:border-red-500/40 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                            >
                              Clear
                            </button>
                          ) : null}
                        </div>
                        {/* The key never returns to the page; show only the masked hint. */}
                        <p className="mb-2 text-[10px] text-[color:var(--text-muted)]">
                          {keyHints[provider]?.hasKey ? `Stored: ${keyHints[provider].hint}` : 'No key stored'}
                        </p>
                      </>
                    )}
                    {(provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas') && (
                      <>
                        <label className="mb-1 block text-[11px] text-[color:var(--text-muted)]">Monthly budget (USD)</label>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          aria-label="Monthly budget (USD)"
                          className="mb-2 w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1 text-xs text-[color:var(--text-main)] outline-none focus:ring-1 focus:ring-accentSoft dark:text-[color:var(--text-main)]"
                          value={remoteBudgetUsd}
                          onChange={(e) => {
                            const next = Number(e.target.value);
                            if (Number.isFinite(next) && next > 0) setRemoteBudgetUsd(next);
                          }}
                        />
                      </>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => { setProvider('ollama'); setIsProviderConfigOpen(false); setStatusText('Provider: Ollama'); }}
                        className="flex-1 rounded-lg border border-[var(--hairline)] px-2 py-1 text-xs text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                      >
                        Back to Ollama
                      </button>
                      <button
                        type="button"
                        onClick={() => { setIsProviderConfigOpen(false); setStatusText('Provider configured'); }}
                        className="flex-1 rounded-lg bg-accentSoft px-2 py-1 text-xs font-medium text-ink transition hover:opacity-80 dark:bg-accent/20 dark:text-accent"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
                </div>{/* end relative provider wrapper */}
                  {shouldShowModelChip && (
                    <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-[var(--hairline)]" />
                  )}
                {shouldShowModelChip && (
                <div data-menu-container="true" className="relative">
                  <button
                    type="button"
                    data-menu-trigger="model"
                    aria-haspopup="true"
                    aria-expanded={isModelMenuOpen}
                    onClick={() => { setIsProviderMenuOpen(false); setIsEffortMenuOpen(false); setIsAccessMenuOpen(false); setOpenHardwarePopover(null); setIsModelMenuOpen((prev) => !prev); }}
                    className="inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-main)] transition hover:bg-[color:var(--hairline)]"
                  >
                    <span className="max-w-[9rem] truncate">
                        {model === 'auto' ? 'Auto' : (selectedModelRecord?.label || model)}
                      </span>
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                      <path d="M5.25 7.5L10 12.25 14.75 7.5" />
                    </svg>
                  </button>

                  {isModelMenuOpen && (
                  <div data-menu-panel="model" role="group" aria-label="Model" tabIndex={-1} className="absolute bottom-9 left-0 z-20 max-h-96 w-80 overflow-y-auto rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] p-1 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
                      {models.length > 0 ? (
                        <>
                        {/* Auto mode entry - no group header, divider separates it from model groups */}
                        <div className="group/row relative flex items-center">
                          <button
                            type="button"
                            onClick={() => { setModel('auto'); setIsModelMenuOpen(false); }}
                            className={`flex min-w-0 flex-1 items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition ${
                              model === 'auto'
                                ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                                : 'font-medium text-[color:var(--text-main)] hover:bg-black/5 dark:text-[color:var(--text-main)] dark:hover:bg-[var(--material-thin)]'
                            }`}
                          >
                            <span className="flex min-w-0 items-center gap-1.5 truncate">
                              {model === 'auto'
                                ? <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                                : <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />}
                              <span className="truncate font-semibold">Auto</span>
                            </span>
                            <span className="ml-2 shrink-0 text-[10px] text-[color:var(--text-muted)]">
                              {autoModelRecord ? `uses ${autoModelRecord.label || autoModelRecord.id}` : 'none installed'}
                            </span>
                          </button>
                        </div>
                        <div className="my-1 border-t border-black/10" />
                        {Array.from(new Set(models.map((item) => item.group || 'Models'))).map((group) => (
                          <div key={group} className="mb-1 last:mb-0">
                            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">{group}</div>
                            {models
                              .filter((item) => (item.group || 'Models') === group)
                              .map((item) => {
                                const pulling = pullingModels[item.id];
                                const isSelected = item.id === model;
                                const isInstalled = item.available !== false;
                                return (
                                <div key={item.id} className="group/row relative flex items-center">
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (!isInstalled && !pulling) {
                                      if (provider === 'ollama') {
                                        installModel(item.ollamaId || item.id, item.id);
                                      } else {
                                        const plabel = PROVIDER_OPTIONS.find((o) => o.id === provider)?.label || provider;
                                        setStatusText(`${plabel} cannot pull models. Add a .gguf to mirabilis/models.`);
                                      }
                                    } else if (isInstalled) {
                                      // Only local GGUF servers need switch-model; elsewhere the
                                      // id travels with each request and the route returns 400.
                                      if (!needsServerModelSwitch(provider)) {
                                        setModel(item.id);
                                        setStatusText(`Model: ${item.label}`);
                                        setIsModelMenuOpen(false);
                                      } else {
                                        setStatusText('Switching model...');
                                        api('/api/providers/switch-model', {
                                          method: 'POST',
                                          body: JSON.stringify({
                                            provider,
                                            modelId: item.id,
                                            modelPath: item.modelFilePath || ''
                                          })
                                        })
                                          .then(async () => {
                                            await refreshModels();
                                            setModel(item.id);
                                            setStatusText(`Model: ${item.label}`);
                                            setIsModelMenuOpen(false);
                                          })
                                          .catch((error) => {
                                            setStatusText(`Model switch failed: ${error.message}`);
                                          });
                                      }
                                    }
                                  }}
                                  className={`flex min-w-0 flex-1 items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition ${
                                    isSelected
                                      ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                                      : isInstalled
                                      ? 'font-medium text-[color:var(--text-main)] hover:bg-black/5 dark:text-[color:var(--text-main)] dark:hover:bg-[var(--material-thin)]'
                                      : 'text-[color:var(--text-muted)] hover:bg-black/5 dark:text-[color:var(--text-muted)] dark:hover:bg-white/5'
                                  }`}
                                >
                                  <span className="flex min-w-0 items-center gap-1.5 truncate">
                                    {isInstalled && !isSelected && (
                                      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                                    )}
                                    {isSelected && (
                                      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                                    )}
                                    {!isInstalled && (
                                      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--presence-offline)]" />
                                    )}
                                    <span className="truncate">
                                      {item.label}
                                    </span>
                                  </span>
                                  {pulling ? (
                                    <div className="flex shrink-0 items-center gap-1.5">
                                      {pulling.pct !== null && (
                                        <div className="h-1 w-16 overflow-hidden rounded-full bg-black/10 dark:bg-[var(--material-thin)]">
                                          <div
                                            className="h-full rounded-full bg-accent transition-all duration-300"
                                            style={{ width: `${pulling.pct}%` }}
                                          />
                                        </div>
                                      )}
                                      <span className="animate-pulse text-[10px] text-accent">
                                        {pulling.pct !== null ? `${pulling.pct}%` : '...'}
                                      </span>
                                      <span
                                        role="button"
                                        tabIndex={0}
                                        aria-label="Cancel install"
                                        onClick={(e) => { e.stopPropagation(); cancelInstall(item.id); }}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); cancelInstall(item.id); } }}
                                        className="ml-0.5 cursor-pointer rounded px-1 text-[10px] text-red-400 hover:text-red-600"
                                        title="Cancel install"
                                      ><CloseIcon size={11} /></span>
                                    </div>
                                  ) : (
                                    <span className="ml-2 flex shrink-0 items-center gap-1.5 text-[10px] text-[color:var(--text-muted)]">
                                      {provider === 'ollama' ? (() => {
                                        const size = itemSize(item);
                                        const fit = modelFit(size, deviceRamGb);
                                        if (!fit) return null;
                                        return (
                                          <span title={fitDetail(size, deviceRamGb)} className={`inline-flex items-center rounded-[var(--r-pill)] px-1.5 py-[1px] font-semibold ${FIT_CHIP_TONE[fit]}`}>
                                            {FIT_LABELS[fit]}
                                          </span>
                                        );
                                      })() : null}
                                      <span>
                                        {isInstalled
                                          ? (item.paramSize || '')
                                          : provider === 'ollama'
                                            ? (item.size || '+ install')
                                            : 'load externally'}
                                      </span>
                                    </span>
                                  )}
                                </button>
                                </div>
                                );
                              })}
                                </div>
                        ))}
                        </>
                      ) : (
                        (() => {
                          const endpointProviders = ['vllm', 'openai-compatible', 'koboldcpp', 'gpuaas'];
                          const hasBaseUrl = !!String(providerConfigs[provider]?.baseUrl || '').trim();
                          const openConfig = () => { setIsModelMenuOpen(false); setIsProviderMenuOpen(false); setIsProviderConfigOpen(true); };
                          if (provider === 'llamacpp') {
                            return (
                              <div className="px-2 py-3 text-[11px] leading-relaxed text-[color:var(--text-muted)]">
                                No model running
                                <button type="button" onClick={openConfig} className="mt-2 block w-full rounded-lg bg-accent px-2 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110">
                                  Configure llama.cpp
                                </button>
                              </div>
                            );
                          }
                          if (endpointProviders.includes(provider) && !hasBaseUrl) {
                            return (
                              <div className="px-2 py-3 text-[11px] leading-relaxed text-[color:var(--text-muted)]">
                                No server connected
                                <button
                                  type="button"
                                  onClick={openConfig}
                                  className="mt-2 block w-full rounded-lg bg-accent px-2 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110"
                                >
                                  Configure endpoint
                                </button>
                              </div>
                            );
                          }
                          return <div className="px-2 py-2 text-xs text-[color:var(--text-muted)]">No models</div>;
                        })()
                      )}

                    {/* Installing, updating and deleting live in Settings > Models. */}
                    {provider === 'ollama' && (
                      <div className="mt-1 border-t border-black/10 pt-1">
                        <button
                          type="button"
                          onClick={openModelManager}
                          className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs font-medium text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                        >
                          <span className="flex items-center gap-1.5">
                            <CubeIcon size={12} />
                            Manage models
                          </span>
                          <ChevronRightIcon size={12} className="text-[color:var(--text-muted)]" />
                        </button>
                      </div>
                    )}

                    {/* These runtimes load one GGUF at launch and cannot pull on demand. */}
                    {(provider === 'koboldcpp' || provider === 'openai-compatible') && (
                      <div className="mt-1 border-t border-black/10 px-2 py-2">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Loading a model</div>
                        <p className="text-[10px] leading-relaxed text-[color:var(--text-muted)]">
                          Add a <code className="rounded bg-black/5 px-1 dark:bg-white/10">.gguf</code> to <code className="rounded bg-black/5 px-1 dark:bg-white/10">mirabilis/models</code>
                        </p>
                      </div>
                    )}

                    {/* Generation params at bottom of model menu */}
                    <div className="mt-1 border-t border-black/10 px-2 py-2">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Generation</div>
                      <div className="mb-1.5">
                        <div className="flex items-center justify-between text-[10px] text-[color:var(--text-muted)]">
                          <span>Temperature</span>
                          <span>{temperature == null ? 'default' : temperature.toFixed(2)}</span>
                        </div>
                        <input
                          type="range"
                          aria-label="Temperature"
                          min="0"
                          max="2"
                          step="0.05"
                          value={temperature ?? 0.7}
                          onChange={(e) => setTemperature(Number(e.target.value))}
                          className="mt-0.5 w-full accent-[var(--accent)]"
                        />
                        {temperature !== null && (
                          <button
                            type="button"
                            onClick={() => setTemperature(null)}
                            className="text-[9px] text-[color:var(--text-muted)] hover:text-[color:var(--text-main)] dark:hover:text-slate-300"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                      <div>
                        <div className="mb-0.5 text-[10px] text-[color:var(--text-muted)]">Max tokens</div>
                        <input
                          type="number"
                          aria-label="Max tokens"
                          min="1"
                          max="131072"
                          placeholder="default"
                          value={maxTokens ?? ''}
                          onChange={(e) => setMaxTokens(e.target.value === '' ? null : Math.max(1, Number(e.target.value)))}
                          className="w-full rounded border border-[var(--hairline)] bg-[var(--material-thick)] px-1.5 py-0.5 text-[10px] outline-none focus:border-accent"
                        />
                      </div>
                      {/* Inference Cockpit: advanced Ollama load/sampling knobs. Local only. */}
                      {provider === 'ollama' && (
                        <div className="mt-2 border-t border-black/10 pt-2 dark:border-white/10">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Advanced</span>
                            {Object.values(ollamaParams).some((v) => v != null) && (
                              <button
                                type="button"
                                onClick={() => setOllamaParams({})}
                                className="text-[9px] text-[color:var(--text-muted)] hover:text-[color:var(--text-main)] dark:hover:text-slate-300"
                              >
                                Reset all
                              </button>
                            )}
                          </div>
                          <div className="mb-1.5">
                            <div className="flex items-center justify-between text-[10px] text-[color:var(--text-muted)]">
                              <span>Top-p</span>
                              <span>{ollamaParams.top_p == null ? 'default' : Number(ollamaParams.top_p).toFixed(2)}</span>
                            </div>
                            <input type="range" aria-label="Top-p" min="0" max="1" step="0.05" value={ollamaParams.top_p ?? 0.9} onChange={(e) => setOllamaParams((p) => ({ ...p, top_p: Number(e.target.value) }))} className="mt-0.5 w-full accent-[var(--accent)]" />
                          </div>
                          <div className="mb-1.5">
                            <div className="flex items-center justify-between text-[10px] text-[color:var(--text-muted)]">
                              <span>Repeat penalty</span>
                              <span>{ollamaParams.repeat_penalty == null ? 'default' : Number(ollamaParams.repeat_penalty).toFixed(2)}</span>
                            </div>
                            <input type="range" aria-label="Repeat penalty" min="0.8" max="2" step="0.05" value={ollamaParams.repeat_penalty ?? 1.1} onChange={(e) => setOllamaParams((p) => ({ ...p, repeat_penalty: Number(e.target.value) }))} className="mt-0.5 w-full accent-[var(--accent)]" />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            {[
                              { key: 'top_k', label: 'Top-k', placeholder: 'default', min: 0, max: 500 },
                              { key: 'num_ctx', label: 'Context', placeholder: 'default', min: 256, max: 131072 },
                              { key: 'num_gpu', label: 'GPU layers', placeholder: 'auto', min: 0, max: 512 },
                              { key: 'seed', label: 'Seed', placeholder: 'random', min: 0, max: 2147483647 }
                            ].map((f) => (
                              <div key={f.key}>
                                <div className="mb-0.5 text-[10px] text-[color:var(--text-muted)]">{f.label}</div>
                                <input
                                  type="number"
                                  aria-label={f.label}
                                  min={f.min}
                                  max={f.max}
                                  placeholder={f.placeholder}
                                  value={ollamaParams[f.key] ?? ''}
                                  onChange={(e) => setOllamaParams((p) => ({ ...p, [f.key]: e.target.value === '' ? null : Math.round(Number(e.target.value)) }))}
                                  className="w-full rounded border border-[var(--hairline)] bg-[var(--material-thick)] px-1.5 py-0.5 text-[10px] outline-none focus:border-accent"
                                />
                              </div>
                            ))}
                          </div>
                          <button
                            type="button"
                            onClick={() => setPinModel((v) => { const n = !v; safeStorageSet('mirabilis-pin-model', n ? 'true' : 'false'); return n; })}
                            className={`mt-2 flex w-full items-center justify-between rounded-[var(--r-md)] px-2 py-1.5 text-[10px] font-medium transition ${
                              pinModel ? 'border text-[color:var(--accent)]' : 'au-hairline au-material text-[color:var(--text-main)]'
                            }`}
                            style={pinModel ? { borderColor: 'color-mix(in srgb, var(--accent) 55%, var(--hairline))', background: 'color-mix(in srgb, var(--accent) 12%, transparent)' } : undefined}
                          >
                            <span>Pin model in memory</span>
                            <span className="opacity-70">{pinModel ? 'on' : 'off'}</span>
                          </button>
                          {resolvedTuning && resolvedTuning.note ? (
                            <p className="mt-1.5 text-[9px] leading-tight text-[color:var(--accent)]">Auto-tuned: {resolvedTuning.note}</p>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                  )}
                </div>
                )}
                </div>
                {/* Effort dropdown: 5 levels, compact */}
                <div data-menu-container="true" className="relative">
                  <button
                    type="button"
                    data-menu-trigger="effort"
                    aria-haspopup="true"
                    aria-expanded={isEffortMenuOpen}
                    onClick={() => { const open = !isEffortMenuOpen; closeAllDropdowns(); setIsEffortMenuOpen(open); }}
                    className="inline-flex h-7 items-center gap-1 rounded-[var(--r-md)] au-hairline au-material px-2.5 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-main)] transition hover:brightness-105"
                  >
                    Effort: {EFFORT_LABELS[effortLevel] || EFFORT_LABELS.balanced}
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                      <path d="M5.25 7.5L10 12.25 14.75 7.5" />
                    </svg>
                  </button>
                  {isEffortMenuOpen && (
                    <div data-menu-panel="effort" role="group" aria-label="Effort" tabIndex={-1} className="absolute bottom-9 left-0 z-20 min-w-44 rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] p-1 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
                      <div className="px-2 pb-1 pt-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">
                        Answer style
                      </div>
                      {EFFORT_OPTIONS.filter((o) => !o.agentic).map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => { setEffortLevel(opt.value); setIsEffortMenuOpen(false); }}
                          className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition ${
                            effortLevel === opt.value
                              ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                              : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                          }`}
                        >
                          <span>{opt.label}</span>
                          <span className="text-[10px] opacity-60">{opt.hint}</span>
                        </button>
                      ))}

                      {/* Separate group: these make Send start a budgeted job, not a turn. */}
                      <div className="mt-1 border-t border-[var(--hairline)] px-2 pb-1 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">
                        Autonomous work
                      </div>
                      {/* These run for up to hours; under Chat only they would do so with no tools. */}
                      {currentAccess.id === 'chat' && (
                        <p className="max-w-[13rem] px-2 pb-1.5 text-[10px] leading-snug text-[color:var(--text-muted)]">
                          Chat only: no tools.{' '}
                          <button
                            type="button"
                            onClick={() => {
                              // The menu unmounts; Settings returns focus to the chip.
                              const chip = document.querySelector('[data-menu-trigger="effort"]');
                              if (chip instanceof HTMLElement) chip.focus();
                              setIsEffortMenuOpen(false);
                              appStore.openSettings('access');
                            }}
                            className="au-focus rounded-[var(--r-xs)] font-medium text-[color:var(--accent)] underline underline-offset-2"
                          >
                            Change Access
                          </button>
                        </p>
                      )}
                      {EFFORT_OPTIONS.filter((o) => o.agentic).map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => { setEffortLevel(opt.value); setIsEffortMenuOpen(false); }}
                          className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition ${
                            effortLevel === opt.value
                              ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                              : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                          }`}
                        >
                          <span>{opt.label}</span>
                          <span className="text-[10px] opacity-60">{opt.hint}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* Access: what the assistant may do on this computer. The backend owns the level. */}
                <div data-menu-container="true" className="relative">
                  <button
                    type="button"
                    data-menu-trigger="access"
                    aria-haspopup="menu"
                    aria-expanded={isAccessMenuOpen}
                    onClick={openAccessMenu}
                    aria-label={`Access: ${currentAccess.label}`}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-[var(--r-md)] px-2.5 text-[length:var(--text-2xs)] font-medium transition hover:brightness-105 ${
                      bypassOn ? 'border text-rose-600 dark:text-rose-300' : 'au-hairline au-material text-[color:var(--text-main)]'
                    }`}
                    style={bypassOn ? { borderColor: 'rgba(244,63,94,0.45)', background: 'rgba(244,63,94,0.12)' } : undefined}
                  >
                    {accessSaving ? (
                      <Spinner size={10} />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: ACCESS_TONE_COLOR[currentAccess.tone] }}
                      />
                    )}
                    <span><span className="hidden sm:inline">Access: </span>{currentAccess.short}</span>
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                      <path d="M5.25 7.5L10 12.25 14.75 7.5" />
                    </svg>
                  </button>
                  {isAccessMenuOpen && (
                    <div
                      data-menu-panel="access"
                      role="menu"
                      aria-label="Access"
                      tabIndex={-1}
                      onKeyDown={onAccessMenuKeyDown}
                      style={accessMenuPlace}
                      className="au-scroll absolute bottom-9 z-20 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] p-1 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur"
                    >
                      {ACCESS_LEVELS.map((level) => {
                        const checked = level.id === currentAccess.id;
                        const danger = level.tone === 'danger';
                        return (
                          <button
                            key={level.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={checked}
                            onClick={() => chooseAccess(level.id)}
                            className={`au-focus flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition ${
                              checked ? 'bg-black/[0.05] dark:bg-white/[0.07]' : 'hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                            }`}
                          >
                            <span
                              aria-hidden="true"
                              className="mt-[5px] h-2 w-2 shrink-0 rounded-full"
                              style={{ background: ACCESS_TONE_COLOR[level.tone] }}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center justify-between gap-2">
                                <span className={`text-xs font-semibold ${danger ? 'text-rose-600 dark:text-rose-300' : 'text-[color:var(--text-main)]'}`}>
                                  {level.label}
                                </span>
                                {checked ? <CheckIcon size={13} className="shrink-0 text-[color:var(--text-main)]" /> : null}
                              </span>
                              <span className="mt-0.5 block text-[11px] leading-snug text-[color:var(--text-muted)]">
                                {level.hint}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                      <div className="my-1 border-t border-[var(--hairline)]" />
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          focusAccessChip();
                          setIsAccessMenuOpen(false);
                          appStore.openSettings('access');
                        }}
                        className="au-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                      >
                        <ShieldIcon size={13} className="shrink-0 text-[color:var(--text-muted)]" />
                        <span>Access settings</span>
                      </button>
                    </div>
                  )}
                </div>
                {/* Uncensored is a plain on/off, so it gets a toolbar toggle; other modes live in Settings. */}
                <button
                  type="button"
                  onClick={toggleUncensoredMode}
                  aria-pressed={uncensoredMode}
                  className={`inline-flex h-7 items-center rounded-[var(--r-md)] px-2.5 text-[length:var(--text-2xs)] font-medium transition hover:brightness-105 ${
                    uncensoredMode
                      ? 'border text-[color:var(--accent)]'
                      : 'au-hairline au-material text-[color:var(--text-main)]'
                  }`}
                  style={uncensoredMode ? { borderColor: 'color-mix(in srgb, var(--accent) 55%, var(--hairline))', background: 'color-mix(in srgb, var(--accent) 12%, transparent)' } : undefined}
                >
                  Uncensored
                </button>
                {/* The "www" web-search chip; only the off state tints. */}
                <button
                  type="button"
                  onClick={() => setDeepWebEnabled((prev) => !prev)}
                  aria-pressed={deepWebEnabled}
                  title={webSearchStatus === 'error' ? 'Last search failed' : 'Web search'}
                  className={`inline-flex h-7 items-center rounded-[var(--r-md)] px-2.5 text-[length:var(--text-2xs)] font-medium transition hover:brightness-105 ${
                    webSearchStatus === 'searching'
                      ? 'border text-[color:var(--presence-away)] animate-pulse'
                      : (!deepWebEnabled || webSearchStatus === 'error')
                      ? 'border text-rose-600 dark:text-rose-300'
                      : 'au-hairline au-material text-[color:var(--text-main)]'
                  }`}
                  style={
                    webSearchStatus === 'searching'
                      ? { borderColor: 'color-mix(in srgb, var(--presence-away) 55%, var(--hairline))', background: 'color-mix(in srgb, var(--presence-away) 12%, transparent)' }
                      : (!deepWebEnabled || webSearchStatus === 'error')
                      ? { borderColor: 'rgba(244,63,94,0.45)', background: 'rgba(244,63,94,0.12)' }
                      : undefined
                  }
                >
                  www
                </button>
                {/* Everything that is not a per-message choice lives in Settings. */}
                <button
                  type="button"
                  onClick={() => shortcutRef.current.openSettings?.()}
                  aria-haspopup="dialog"
                  aria-label="Settings"
                  title={`Settings (${shortcutLabel})`}
                  className="inline-flex h-7 items-center gap-1.5 rounded-[var(--r-md)] au-hairline au-material px-2.5 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-main)] transition hover:brightness-105"
                >
                  <GearIcon size={13} />
                  <span className="hidden sm:inline">Settings</span>
                </button>
              </div>
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {/* Modes that change every answer. Each chip opens the setting that turns it off. */}
              <div className="flex flex-wrap justify-end gap-1.5">
                {[
                  deepThinkingEnabled && { key: 'deep-thinking', label: 'Deep Thinking', section: 'labs' },
                  guidedLearningEnabled && { key: 'guided', label: 'Guided Learning', section: 'labs' },
                  trainingMode === 'fine-tuning' && { key: 'quick-learning', label: 'Quick Learning', section: 'labs' },
                  trainingMode === 'full-training' && { key: 'deep-training', label: 'Deep Training', section: 'labs', tone: 'warn' },
                  canvasEnabled && { key: 'canvas', label: 'Canvas', section: 'labs' },
                  openClawMode && { key: 'openclaw', label: 'OpenClaw', section: 'labs', tone: 'danger' },
                  configVaultEnabled && { key: 'vault', label: 'Config Vault', section: 'chat-tools' }
                ].filter(Boolean).map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={() => appStore.openSettings(chip.section)}
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition ${
                      chip.tone === 'warn'
                        ? 'border-amber-300/60 bg-amber-100 text-amber-800 hover:brightness-95 dark:border-amber-400/40 dark:bg-amber-900/30 dark:text-amber-200'
                        : chip.tone === 'danger'
                        ? 'border-rose-300/60 bg-rose-50 text-rose-700 hover:brightness-95 dark:border-rose-400/40 dark:bg-rose-900/20 dark:text-rose-300'
                        : 'border-[var(--hairline)] bg-[var(--material-thin)] text-[color:var(--text-main)] hover:bg-[color:var(--hairline)]'
                    }`}
                  >
                    {chip.label}
                  </button>
                ))}
                {remoteConnected && (
                  <button
                    type="button"
                    onClick={() => appStore.openSettings('remote')}
                    title="Remote Control"
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-300/50 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 transition hover:brightness-95 dark:border-emerald-400/30 dark:bg-emerald-900/20 dark:text-emerald-300"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    {remoteTarget}
                  </button>
                )}
                {workspacePins.length > 0 && (
                  <button
                    type="button"
                    onClick={() => appStore.openWorkspace()}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-main)] transition hover:bg-[color:var(--hairline)]"
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                    {workspacePins.length} workspace file{workspacePins.length === 1 ? '' : 's'}
                  </button>
                )}
              </div>
                <div data-menu-container="true" className="relative shrink-0">
                  <button
                    type="button"
                    data-menu-trigger="context"
                    aria-haspopup="true"
                    aria-expanded={isContextPanelOpen}
                    onClick={() => {
                      setOpenHardwarePopover(null);
                      setIsContextPanelOpen((prev) => !prev);
                    }}
                    className={`au-focus rounded-md px-1 font-medium tabular-nums text-[length:var(--text-2xs)] underline-offset-2 transition hover:underline ${
                      contextUsage.usedPct >= 90
                        ? 'text-red-600 dark:text-red-400'
                        : contextUsage.usedPct >= 70
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-main)]'
                    }`}
                  >
                    {(chatTokenSummary.input + chatTokenSummary.output).toLocaleString()} tokens
                  </button>

                  {isContextPanelOpen && (
                    <div data-menu-panel="context" role="group" aria-label="Tokens" tabIndex={-1} className="absolute bottom-full right-0 z-30 mb-2 w-60 rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] p-3 text-[11px] text-[color:var(--text-main)] shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="font-semibold">Context</span>
                        <span className="tabular-nums text-[color:var(--text-muted)]">{contextUsage.usedPct}%</span>
                      </div>
                      <div className="mb-2.5 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-[var(--material-thin)]">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            contextUsage.usedPct >= 90 ? 'bg-red-500' : contextUsage.usedPct >= 70 ? 'bg-amber-500' : 'bg-accent'
                          }`}
                          style={{ width: `${Math.min(contextUsage.usedPct, 100)}%` }}
                        />
                      </div>
                      <dl className="space-y-1 tabular-nums">
                        {[
                          ['System', contextUsage.systemTokens],
                          ['You', contextUsage.userTokens],
                          ['Assistant', contextUsage.uncategorizedTokens]
                        ].map(([label, value]) => (
                          <div key={label} className="flex justify-between">
                            <dt className="text-[color:var(--text-muted)]">{label}</dt>
                            <dd>{value.toLocaleString()}</dd>
                          </div>
                        ))}
                        <div className="flex justify-between border-t border-[var(--hairline)] pt-1">
                          <dt className="text-[color:var(--text-muted)]">Window</dt>
                          <dd>{contextUsage.totalTokens.toLocaleString()} / {contextUsage.windowTokens.toLocaleString()}</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-[color:var(--text-muted)]">Chat in / out</dt>
                          <dd>{chatTokenSummary.input.toLocaleString()} / {chatTokenSummary.output.toLocaleString()}</dd>
                        </div>
                      </dl>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Composer: textarea, then one action row. */}
            <div className="rounded-[var(--r-lg)] border border-[var(--hairline)] bg-[var(--material-thin)] focus-within:border-[color:var(--accent)] transition">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleAttachFiles}
              />
              <textarea
                ref={composerInputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onFocus={() => {
                  setIsModelMenuOpen(false);
                  setOpenHardwarePopover(null);
                  setIsContextPanelOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Message"
                aria-label="Message"
                rows={3}
                className="w-full resize-none bg-transparent border-0 px-3.5 pt-2.5 pb-1 text-[length:var(--text-md)] text-[color:var(--text-main)] outline-none placeholder:text-[color:var(--text-muted)]"
              />
              <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isStreaming || isUploadingFiles}
                    className="rounded p-1 text-[color:var(--text-muted)] transition hover:bg-black/5 hover:text-[color:var(--text-main)] disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-[var(--material-thin)] dark:hover:text-slate-200"
                    title="Attach files"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21.44 11.05l-8.49 8.49a5 5 0 11-7.07-7.07l9.19-9.19a3.5 3.5 0 114.95 4.95l-9.2 9.2a2 2 0 01-2.82-2.83l8.48-8.48" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={toggleDictation}
                    disabled={!dictationSupported || isStreaming}
                    className={`rounded p-1 transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      isDictating
                        ? 'text-[color:var(--accent)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                        : 'text-[color:var(--text-muted)] hover:bg-black/5 hover:text-[color:var(--text-main)] dark:hover:bg-[var(--material-thin)] dark:hover:text-slate-200'
                    }`}
                    title={dictationSupported ? (isDictating ? 'Stop dictation' : 'Start dictation') : 'Dictation unavailable'}
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="9" y="3" width="6" height="11" rx="3" />
                      <path d="M5 10.5a7 7 0 0014 0" />
                      <path d="M12 17.5v3.5" />
                      <path d="M8.5 21h7" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => appStore.openVoiceChat()}
                    disabled={isStreaming}
                    className="rounded p-1 text-[color:var(--text-muted)] transition hover:bg-black/5 hover:text-[color:var(--text-main)] disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-[var(--material-thin)] dark:hover:text-slate-200"
                    title="Voice chat"
                  >
                    <WaveIcon size={16} className="h-4 w-4" />
                  </button>
                </div>
                {/* min-w-0 so a long last-event line truncates instead of pushing Send off. */}
                {agentRun && (
                  <AgentRunPanel
                    run={agentRun}
                    onStop={stopAgentRun}
                    onDismiss={() => setAgentRun(null)}
                  />
                )}

                <button
                  onClick={isStreaming ? stopStreaming : sendMessage}
                  disabled={!isStreaming && !input.trim()}
                  className={`au-focus shrink-0 rounded-[var(--r-md)] px-4 h-8 text-[length:var(--text-sm)] font-semibold text-white shadow-[var(--shadow-2)] transition active:scale-[0.98] enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 ${isStreaming ? 'bg-red-500' : ''}`}
                  style={isStreaming ? undefined : { background: 'var(--accent)' }}
                >
                  {isStreaming ? 'Stop' : 'Send'}
                </button>
              </div>
            </div>
          </footer>
        </section>
      </div>
      <footer className="pointer-events-none absolute bottom-1 left-0 right-0 text-center text-xs tracking-wide text-[color:var(--text-main)]/90">
        {APP_FOOTER_TEXT}
        <span className="mx-1.5 opacity-40">|</span>
        <span className="opacity-55">{APP_VERSION}</span>
      </footer>
      <CommitmentRadar
        open={radarOpen}
        onClose={() => setRadarOpen(false)}
        loading={radarLoading}
        error={radarError}
        scanned={radarScanned}
        signals={radarSignals}
        conflicts={radarConflicts}
        conflictsLoading={radarConflictsLoading}
        filing={isCommittingToLedger}
        onFileAll={async () => {
          await commitChatToLedger();
          setRadarOpen(false);
        }}
      />
      <VoiceChat
        open={voiceChatOpen}
        onClose={closeVoiceChat}
        phase={voicePhase}
        interimText={voiceInterim}
        replyText={voiceReply}
        gender={voiceGender}
        onGenderChange={onVoiceGenderChange}
        onOrbTap={onVoiceOrbTap}
        srSupported={voiceLoopSupported}
        note={voiceNote}
      >
        {/* A spoken request in Ask first can wait on the user; the card above the composer is behind this panel. */}
        {voiceChatOpen ? approvalCard : null}
      </VoiceChat>
      {/* Portaled to body, so the Dock and the shortcut can open it on either tab. */}
      <SettingsSheet
        open={settingsOpen}
        section={settingsSection}
        onSection={(id) => appStore.openSettings(id)}
        onClose={() => appStore.closeSettings()}
        sections={settingsSections}
      />
    </main>
  );
}
