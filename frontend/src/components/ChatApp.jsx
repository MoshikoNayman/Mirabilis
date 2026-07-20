'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { APP_FOOTER_TEXT, APP_VERSION } from '../constants/app';
import { FlowerMark } from './ui/StatusOrb';
import { IncognitoIcon, RadarIcon, SlidersIcon, WaveIcon } from './ui/primitives';
import TabSwitch from './shell/TabSwitch';
import CommitmentRadar from './shell/CommitmentRadar';
import VoiceChat from './shell/VoiceChat';
import { playSend, playReceive, playError } from '../lib/sounds';
import { postJSON } from '../lib/api';
import { appStore, useAppStore } from '../store/useAppStore';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

// Voice chat: map the male/female toggle to local Piper voices. When a model is
// not installed we still speak instantly via a browser voice and fetch the
// Piper model in the background for higher-quality local TTS next time.
const VOICE_GENDER_PIPER = { male: 'en_US-ryan-medium', female: 'en_US-amy-medium' };
// Best-effort name hints for picking a male/female browser voice fallback.
const BROWSER_VOICE_HINTS = {
  female: ['female', 'samantha', 'victoria', 'karen', 'moira', 'tessa', 'fiona', 'amelie', 'anna', 'zira', 'susan', 'allison', 'ava', 'zoe', 'serena', 'kate'],
  male: ['male', 'daniel', 'alex', 'fred', 'thomas', 'oliver', 'george', 'david', 'mark', 'rishi', 'aaron', 'arthur', 'gordon', 'lee']
};

// Effort levels shown in the composer toolbar dropdown (least to most effort).
const EFFORT_LABELS = { instant: 'Instant', fast: 'Fast', balanced: 'Balanced', thorough: 'Thorough', deep: 'Deep' };

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
    description: 'Balanced general assistant',
    getPrompt: (providerId) => buildDefaultSystemPrompt(providerId)
  },
  {
    id: 'network-engineer',
    label: 'Network',
    description: 'Operational troubleshooting and change review',
    getPrompt: () => 'You are Mirabilis AI acting as a senior network engineer. Be precise, operationally conservative, and explicit about assumptions. When analyzing configs, logs, or CLI output, prioritize root cause, blast radius, rollback considerations, and concrete next commands.'
  },
  {
    id: 'research-analyst',
    label: 'Analyst',
    description: 'Structured research and synthesis',
    getPrompt: () => 'You are Mirabilis AI acting as a research analyst. Structure answers clearly, distinguish facts from inference, call out uncertainty, and synthesize findings into concise conclusions with practical implications.'
  },
  {
    id: 'guided-tutor',
    label: 'Tutor',
    description: 'Teach step by step without hand-waving',
    getPrompt: () => 'You are Mirabilis AI acting as a guided tutor. Teach in clear steps, adapt to the user\'s apparent level, and explain why each step matters. Prefer examples and checkpoints over long monologues.'
  },
  {
    id: 'remote-operator',
    label: 'Operator',
    description: 'Action plans for MCP and remote control',
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
// Providers carry a `group` so the picker can scale: Local (on this machine),
// Remote (self-hosted GPU servers you point at), and Cloud APIs (keyed SaaS).
const PROVIDER_GROUPS = ['Local', 'Remote', 'Cloud APIs'];
const PROVIDER_OPTIONS = [
  { id: 'ollama', label: 'Ollama', scope: 'Local', group: 'Local' },
  // First-class local llama.cpp engine (Metal-native on Apple Silicon), managed
  // by Mirabilis. Runs your models itself - no Ollama daemon needed at inference.
  { id: 'llamacpp', label: 'llama.cpp', scope: 'Local', group: 'Local' },
  { id: 'openai-compatible', label: 'Local/Custom Endpoint', scope: 'Local/Remote', requiresBinary: 'llama-server', group: 'Local' },
  { id: 'koboldcpp', label: 'KoboldCpp', scope: 'Local', requiresBinary: 'koboldcpp', group: 'Local' },
  // vLLM runs as a managed local server on an NVIDIA/CUDA machine, or connects to
  // a remote vLLM server by URL. On Apple Silicon only the remote path is offered.
  { id: 'vllm', label: 'vLLM', scope: 'Local/Remote', group: 'Remote' },
  { id: 'gpuaas', label: 'GPUaaS Endpoint', scope: 'Remote', group: 'Remote' },
  { id: 'openai', label: 'OpenAI', scope: 'Remote', group: 'Cloud APIs' },
  { id: 'claude', label: 'Claude', scope: 'Remote', group: 'Cloud APIs' },
  { id: 'gemini', label: 'Gemini', scope: 'Remote', group: 'Cloud APIs' },
  { id: 'grok', label: 'Grok', scope: 'Remote', group: 'Cloud APIs' },
  { id: 'groq', label: 'Groq', scope: 'Remote', group: 'Cloud APIs' },
  { id: 'openrouter', label: 'OpenRouter', scope: 'Remote', group: 'Cloud APIs' },
  { id: 'cerebras', label: 'Cerebras', scope: 'Remote', group: 'Cloud APIs' }
];
// Two separate budgets. Time-to-first-token on a big local model includes cold load
// + long-context prefill and can legitimately take minutes, so it gets a very
// generous budget (effectively "wait, trust Stop"). Once tokens are flowing, a short
// gap means a genuinely dead stream. Splitting these stops the old 120s single timer
// from aborting a healthy slow-starting local generation.
const STREAM_FIRST_TOKEN_BUDGET_MS = 900000; // 15 min before the first token
const STREAM_STALL_TIMEOUT_MS = 60000;       // 60s gap between tokens = dead

const UNCENSORED_MODEL_PRIORITY = [
  'qwen3.5-uncensored',
  'deepseek-r1-abliterated',
  'dolphin3',
  'dolphin-mixtral:8x7b',
  'dolphin-mixtral',
  'llama4.1:surge',
  'llama4.1'
];

function normalizeModelId(modelId) {
  return String(modelId || '').split(':')[0].trim().toLowerCase();
}

function isUncensoredModelRecord(item) {
  const haystack = `${item?.id || ''} ${item?.label || ''} ${item?.group || ''}`.toLowerCase();
  return (
    String(item?.group || '').toLowerCase() === 'uncensored' ||
    /uncensored|dolphin|abliterated|surge/.test(haystack)
  );
}

// Models with guaranteed 128K+ context window - preferred when conversation is large.
// (phi4=16K, mistral/mixtral=32K are excluded intentionally)
const LARGE_CONTEXT_PRIORITY = [
  'qwen2.5', 'llama3.1', 'gemma3', 'qwen3', 'deepseek-r1', 'gemma4:e2b', 'gemma4:e4b',
  'gemma3:12b', 'gemma3:27b', 'gemma4:26b', 'gemma4:31b', 'llama3.3', 'llama3'
];

// Priority list for Auto mode when context is small - prefer faster/lighter local models first.
const AUTO_MODEL_PRIORITY = [
  'qwen2.5', 'llama3.1', 'gemma3', 'mistral', 'phi4', 'qwen3',
  'deepseek-r1', 'gemma4:e2b', 'gemma4:e4b', 'gemma3:12b', 'gemma3:27b',
  'gemma4:26b', 'gemma4:31b', 'mistral-large', 'llama3.3', 'llama3'
];

const COST_RATES_PER_1M = {
  openai: {
    default: { in: 0.15, out: 0.60 },
    'gpt-4o': { in: 5.0, out: 15.0 },
    'gpt-4.1': { in: 5.0, out: 15.0 },
    'gpt-4o-mini': { in: 0.15, out: 0.60 }
  },
  grok: {
    default: { in: 0.50, out: 1.50 },
    'grok-3': { in: 5.0, out: 15.0 },
    'grok-3-mini': { in: 0.50, out: 1.50 }
  },
  groq: {
    default: { in: 0.05, out: 0.08 },
    'llama-3.1-8b': { in: 0.05, out: 0.08 },
    'llama-3.3-70b': { in: 0.59, out: 0.79 }
  },
  openrouter: {
    default: { in: 0.50, out: 1.50 },
    'openai/gpt-4o-mini': { in: 0.15, out: 0.60 },
    'anthropic/claude-3.5-sonnet': { in: 3.00, out: 15.00 }
  },
  gpuaas: {
    default: { in: 0.60, out: 1.80 }
  },
  gemini: {
    default: { in: 0.10, out: 0.40 },
    'gemini-2.5-pro': { in: 3.50, out: 10.50 },
    'gemini-2.5-flash': { in: 0.10, out: 0.40 }
  },
  claude: {
    default: { in: 3.00, out: 15.00 },
    'claude-3-5-haiku': { in: 0.80, out: 4.00 },
    'claude-3-5-sonnet': { in: 3.00, out: 15.00 },
    'claude-sonnet': { in: 3.00, out: 15.00 },
    'claude-opus': { in: 15.00, out: 75.00 }
  },
  cerebras: {
    // Free tier is 0; these approximate the paid overage rates so the budget bar
    // is meaningful past the free allowance.
    default: { in: 0.60, out: 0.80 },
    'llama-3.3-70b': { in: 0.60, out: 0.80 }
  }
};

function resolveRateCard(providerId, modelId) {
  const providerRates = COST_RATES_PER_1M[providerId];
  if (!providerRates) return null;
  const key = String(modelId || '').toLowerCase();
  for (const [prefix, rate] of Object.entries(providerRates)) {
    if (prefix === 'default') continue;
    if (key.startsWith(prefix)) return rate;
  }
  return providerRates.default;
}

function normalizeGeminiBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!raw) return 'https://generativelanguage.googleapis.com/v1beta/openai';
  if (raw.includes('generativelanguage.googleapis.com') && !raw.endsWith('/openai')) {
    return `${raw}/openai`;
  }
  return raw;
}

// Threshold above which we switch to context-first routing (in tokens ~= 6K chars).
const LARGE_CONTEXT_THRESHOLD = 6000;

function pickBestAutoModel(modelsList = [], contextTokens = 0) {
  const installed = (modelsList || []).filter(
    (item) => item?.available !== false && item?.group !== 'Uncensored'
  );
  const priority = contextTokens > LARGE_CONTEXT_THRESHOLD ? LARGE_CONTEXT_PRIORITY : AUTO_MODEL_PRIORITY;
  for (const preferred of priority) {
    const match = installed.find(
      (item) => item?.id === preferred || item?.ollamaId === preferred
    );
    if (match) return match;
  }
  return installed[0] || null;
}

function pickMostUncensoredModel(modelsList = []) {
  const installed = (modelsList || []).filter((item) => item?.available !== false);
  if (installed.length === 0) {
    return null;
  }

  for (const preferred of UNCENSORED_MODEL_PRIORITY) {
    const preferredNorm = normalizeModelId(preferred);
    const match = installed.find((item) =>
      normalizeModelId(item?.id) === preferredNorm ||
      normalizeModelId(item?.ollamaId) === preferredNorm
    );
    if (match) return match;
  }

  return installed.find((item) => isUncensoredModelRecord(item)) || null;
}

function isImageRequest(text) {
  const hasVerb = /\b(generate|create|draw|paint|make|render|produce|show)\b/i.test(text);
  const hasNoun = /\b(image|picture|pic|photo|photograph|illustration|artwork|painting|portrait|sketch|drawing|wallpaper|snapshot|snap)\b/i.test(text);
  return hasVerb && hasNoun;
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
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

// ── Smart web-search classifier ───────────────────────────────────────────────
// Returns 'search' when the query clearly needs live/current data,
// or 'skip' for everything that can be answered from training knowledge.
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
  // Default to search when www is on - let the AI decide if the context is useful
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
  if (diffSec < 60) return 'Just now';
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

function formatTokenCount(value) {
  const amount = Number(value || 0);
  return `~${amount.toLocaleString()} tok`;
}

// Pre-pull model-fit estimate: compare a model's on-disk weight size against
// total device memory, leaving headroom for KV cache and the OS. Returns a small
// verdict {tier,label,title} or null when we lack the numbers. Deliberately a
// rough guide, not a promise: quantization and context length shift the real cost.
function computeModelFit(item, ramGb) {
  if (!Number.isFinite(ramGb) || ramGb <= 0) return null;
  let weightsGb = null;
  if (Number.isFinite(item?.sizeBytes) && item.sizeBytes > 0) {
    weightsGb = item.sizeBytes / 1e9;
  } else if (typeof item?.size === 'string') {
    const m = item.size.match(/([\d.]+)\s*(GB|MB)/i);
    if (m) weightsGb = /mb/i.test(m[2]) ? parseFloat(m[1]) / 1024 : parseFloat(m[1]);
  }
  if (!Number.isFinite(weightsGb) || weightsGb <= 0) return null;
  // Runtime footprint runs above raw weights (KV cache, activations, overhead).
  const required = weightsGb * 1.2;
  const detail = `~${weightsGb.toFixed(1)} GB weights vs ${ramGb} GB memory (estimate; excludes long-context KV cache)`;
  if (required <= ramGb * 0.6) return { tier: 'fits', label: 'Fits', title: `Comfortable fit: ${detail}` };
  if (required <= ramGb * 0.82) return { tier: 'tight', label: 'Tight', title: `Tight fit, close other apps: ${detail}` };
  return { tier: 'swap', label: 'Will swap', title: `Likely too large, expect swapping or slow load: ${detail}` };
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function stringifyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '{}';
  }
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
      title="Copy code"
      className="ml-auto rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)] transition hover:bg-[var(--material-thin)] hover:text-white"
    >
      {copied ? 'Copied!' : 'Copy'}
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
      title={copied ? 'Copied!' : 'Copy message'}
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

// Detects whether text contains Hebrew or Arabic characters so we can force RTL
// on the entire message block instead of relying on the browser's `dir="auto"` scan,
// which is unreliable for list containers when content is mixed or nested.
const RTL_CHARS_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

// Syntax highlight theme - CSS-var-driven so it instantly reacts to scheme changes.
// Defined at module level so it's never recreated per render.
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

// Static markdown component overrides - defined at module level so they're never recreated.
// These elements intentionally carry NO `dir` attribute; they inherit direction from the
// outer wrapper which is set explicitly in renderMessageContent via RTL_CHARS_RE.
// `p` and headings keep `dir="auto"` for correct per-paragraph alignment in mixed-lang replies.
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

function renderMessageContent(content, message = {}, remoteCtx = {}) {
  const { remoteConnectedRef, remoteTargetRef, execResultsRef, onRunCommand } = remoteCtx;
  if (message.imageGenerating) {
    return (
      <div
        className="relative overflow-hidden rounded-xl bg-[var(--material-thick)]"
        style={{ width: 288, height: 288 }}
        aria-label="Generating image…"
      >
        {/* Shimmer sweep - pure CSS, GPU-only */}
        <div
          className="img-shimmer pointer-events-none absolute inset-0 w-1/2 bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/10"
          style={{ willChange: 'transform' }}
        />
        {/* Bottom label */}
        <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-1.5 px-3 py-2.5 bg-gradient-to-t from-black/25 to-transparent rounded-b-xl">
          <svg className="h-3.5 w-3.5 text-white/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span className="text-xs font-medium text-white/80">Generating image…</span>
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
  const isShellLang = (l) => ['bash', 'sh', 'shell', 'zsh', 'fish', 'cmd', 'powershell', 'ps1'].includes(l);

  const mdComponents = {
    ...MD_STATIC_COMPONENTS,
    code({ inline, className, children, ...props }) {
      const lang = (className || '').replace('language-', '') || '';
      const displayLang = lang || 'code';
      const codeText = String(children).replace(/\n$/, '');
      // react-markdown v9+ no longer passes `inline` prop - detect it ourselves:
      // inline code has no language class and no newlines inside it.
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
      // Unique key for this code block within this message
      const blockKey = `${message?.id || 'msg'}-${displayLang}-${codeText.slice(0, 40)}`;
      const execResult = execResultsRef.current[blockKey];
      const canRun = !isInline && isShellLang(lang) && remoteConnectedRef.current;

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
                title={`Run on ${remoteTargetRef.current}`}
              >
                {execResult?.running ? '◌ Running…' : '▶ Run'}
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
                exit {execResult.exitCode} · {execResult.duration != null ? `${execResult.duration}ms` : ''}
              </div>
            </div>
          )}
        </figure>
      );
    },
  };

  // Detect RTL once from the full text so the entire block - including list
  // containers - gets a concrete direction that all descendants inherit.
  const dir = RTL_CHARS_RE.test(text) ? 'rtl' : 'ltr';

  return (
    <div className="markdown-body text-sm" dir={dir}>
      <ReactMarkdown components={mdComponents} remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

// Memoised sidebar chat row - comparator ignores callbacks so typing / streaming
// never causes the full chat list to reconcile; only the affected item re-renders.
const ChatItem = memo(function ChatItem({ chat, isActive, isMenuOpen, isPinned, onSelect, onToggleMenu, onDelete, onRename, onExport, onTogglePin, onBranch }) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');

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
              {chat.snapshotCount > 0 ? <span className="rounded-full border border-[var(--hairline)] px-1.5 py-0">{chat.snapshotCount} snap</span> : null}
            </div>
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
              <span>Branch Chat</span>
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
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-red-600 transition hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/40"
              onClick={() => onDelete(chat.id)}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M8 6V4.8c0-.7.6-1.3 1.3-1.3h5.4c.7 0 1.3.6 1.3 1.3V6" />
                <path d="M6.5 6l1 12.2c.1.8.7 1.3 1.5 1.3h6c.8 0 1.4-.5 1.5-1.3L17.5 6" />
                <path d="M10 10.2v5.6" />
                <path d="M14 10.2v5.6" />
              </svg>
              <span>Delete</span>
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

// Memoised message bubble - only re-renders when its own data or speaking state changes.
// During streaming, only the last message gets a new `message` object reference, so all prior
// messages are skipped by the custom comparator, preventing O(n) re-renders per token.
const MessageRow = memo(function MessageRow({
  message,
  isLast,
  isStreaming,
  streamingLabel,
  speakingMessageId,
  isSpeaking,
  voiceEngine,
  voiceSupported,
  remoteConnectedRef,
  remoteTargetRef,
  execResultsRef,
  runCommand,
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
      {isStreaming && !message.content && message.role === 'assistant' && isLast && !message.imageGenerating
        ? (
          <div className="flex items-center gap-2 py-1" style={{ color: 'var(--accent)' }}>
            <span className="au-typing" role="status" aria-label="Assistant is typing"><i /><i /><i /></span>
            {streamingLabel && (
              <span className="ml-0.5 text-[length:var(--text-2xs)] font-medium uppercase tracking-[0.1em] text-[color:var(--text-muted)]">{streamingLabel}</span>
            )}
          </div>
        )
        : renderMessageContent(message.content, message, { remoteConnectedRef, remoteTargetRef, execResultsRef, onRunCommand: runCommand })}
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
                    <div className="text-[10px] opacity-70">{file.mimeType || 'application/octet-stream'} · {formatFileSize(file.size)}</div>
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
            You · ~{(message.tokenEstimate || 0).toLocaleString()} tok
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
                  const onDevice = ['ollama', 'koboldcpp', 'openai-compatible'].includes(prov);
                  const provLabel = {
                    openai: 'OpenAI', grok: 'Grok', groq: 'Groq', openrouter: 'OpenRouter',
                    gemini: 'Gemini', cerebras: 'Cerebras', claude: 'Claude', gpuaas: 'GPUaaS',
                    'openai-compatible': 'Custom', koboldcpp: 'KoboldCpp', ollama: 'Ollama'
                  }[prov] || prov;
                  const rawModel = message.effectiveModel || message.model || '';
                  const shortModel = rawModel
                    ? (rawModel.length > 22 ? rawModel.slice(0, 22) + '…' : rawModel)
                    : '';
                  // Privacy Receipt: a green on-device stamp, or an amber "left the
                  // machine" stamp naming the cloud provider it was sent to.
                  return (
                    <span
                      title={onDevice
                        ? `On-device: generated locally by ${provLabel}. Nothing left your machine.`
                        : `Left your machine: this prompt was sent to ${provLabel}, a remote cloud provider.`}
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
                ~{(message.tokenEstimate || 0).toLocaleString()} tok
                {message.performance && message.performance.tokensPerSec != null ? (() => {
                  const perf = message.performance;
                  const exact = perf.source === 'ollama' && !perf.isEstimate;
                  const parts = [];
                  parts.push(`${exact ? '' : 'approx '}${perf.tokensPerSec} tokens/sec${exact ? ' (exact, from Ollama)' : ' (estimated)'}`);
                  if (perf.ttftMs != null) parts.push(`first token in ${perf.ttftMs >= 1000 ? (perf.ttftMs / 1000).toFixed(1) + 's' : perf.ttftMs + 'ms'}`);
                  if (perf.promptTokens != null) parts.push(`${perf.promptTokens.toLocaleString()} prompt tokens`);
                  if (perf.wallMs != null) parts.push(`${(perf.wallMs / 1000).toFixed(1)}s total`);
                  return (
                    <span
                      title={parts.join(' · ')}
                      className="ml-1.5 inline-flex items-center gap-1 rounded-[var(--r-pill)] bg-black/[0.05] px-1.5 py-[2px] align-middle text-[9px] font-semibold normal-case tracking-normal text-[color:var(--text-muted)] dark:bg-white/[0.06]"
                    >
                      {exact ? '' : '~'}{perf.tokensPerSec} tok/s
                      {perf.ttftMs != null ? (
                        <span className="opacity-70">{` ${perf.ttftMs >= 1000 ? (perf.ttftMs / 1000).toFixed(1) + 's' : perf.ttftMs + 'ms'} ttft`}</span>
                      ) : null}
                    </span>
                  );
                })() : null}
              </>
            ) : 'AI'}
          </span>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => {
                if (speakingMessageId === message.id && isSpeaking) stopSpeaking();
                else speakText(message.content || '', message.id);
              }}
              disabled={(voiceEngine === 'browser' && !voiceSupported) || !String(message.content || '').trim()}
              title={speakingMessageId === message.id && isSpeaking ? 'Stop speaking' : 'Speak response'}
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
                disabled={isStreaming}
                title="Regenerate response"
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
  prev.isStreaming === next.isStreaming &&
  prev.streamingLabel === next.streamingLabel &&
  prev.speakingMessageId === next.speakingMessageId &&
  prev.isSpeaking === next.isSpeaking &&
  prev.voiceEngine === next.voiceEngine &&
  prev.voiceSupported === next.voiceSupported
));

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
  // Incremented by clearAllChats so any in-flight refreshChats() calls that started
  // before the clear (and resolve after it) bail out instead of resurrecting deleted chats.
  const chatListEpochRef = useRef(0);
  // Refs for renderMessageContent (stable across renders without re-passing as props)
  const remoteConnectedRef = useRef(false);
  const remoteTargetRef = useRef('');
  const execResultsRef = useRef({});
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
  const [streamingLabel, setStreamingLabel] = useState('');
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
      // 'arctic' is a real scheme (globals.css, lib/theme.js, the Dock picker) -
      // it was missing here, so picking Arctic worked until reload, then got
      // silently coerced back to 'mirabilis'. Keep this list in sync with
      // lib/theme.js SCHEMES.
      return ['mirabilis','arctic','ember','summit'].includes(v) ? v : 'mirabilis';
    }
    return 'mirabilis';
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [models, setModels] = useState([]);
  // Total device memory (GB) for the pre-pull model-fit pill. Fetched once.
  const [deviceRamGb, setDeviceRamGb] = useState(null);
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
      // Empty by default so selecting vLLM opens the endpoint config to enter the
      // remote server URL (e.g. http://gpu-host:8000/v1).
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
  const [openChatMenuId, setOpenChatMenuId] = useState(null);
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
  const [isEngineMenuOpen, setIsEngineMenuOpen] = useState(false);
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
  const [isToolsMenuOpen, setIsToolsMenuOpen] = useState(false);
  const [isTrainingMenuOpen, setIsTrainingMenuOpen] = useState(false);
  const [isEffortMenuOpen, setIsEffortMenuOpen] = useState(false);
  const [isOptionsMenuOpen, setIsOptionsMenuOpen] = useState(false);
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
  const [isVoiceMenuOpen, setIsVoiceMenuOpen] = useState(false);
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

  // ── Voice chat (hands-free spoken conversation) ─────────────────────────────
  // The overlay is a dumb view; the whole listen -> send -> speak -> listen loop
  // is driven from here because speech recognition, the streaming send, and TTS
  // all live in this component.
  const voiceChatOpen = useAppStore((s) => s.voiceChatOpen);
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
  // MediaRecorder-based capture (webkitSpeechRecognition is dead in Electron, so
  // the loop records audio and transcribes via the local whisper.cpp backend).
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

  const [isDragOverChat, setIsDragOverChat] = useState(false);
  const [deepWebEnabled, setDeepWebEnabled] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = safeStorageGet('local-ai-deep-web-enabled');
      return saved === null ? true : saved === 'true'; // default ON
    }
    return true;
  });
  const [webSearchStatus, setWebSearchStatus] = useState('idle'); // 'idle' | 'searching' | 'error'
  // Config Vault: cited local RAG over a folder of config files. When enabled and
  // indexed, each send retrieves the most relevant config chunks (fully offline
  // via local embeddings) and folds them in as grounding context.
  const [configVaultEnabled, setConfigVaultEnabled] = useState(() => {
    if (typeof window !== 'undefined') return safeStorageGet('mirabilis-config-vault-enabled') === 'true';
    return false;
  });
  const [configVaultStatus, setConfigVaultStatus] = useState(null); // { root, builtAt, embedModel, fileCount, chunkCount }
  const [configVaultFolder, setConfigVaultFolder] = useState(() => (typeof window !== 'undefined' ? safeStorageGet('mirabilis-config-vault-folder', '') || '' : ''));
  const [configVaultBusy, setConfigVaultBusy] = useState(false);
  const [configVaultMsg, setConfigVaultMsg] = useState('');
  const [isVaultPanelOpen, setIsVaultPanelOpen] = useState(false);
  // modelId → { pct: number|null, status: string, ctrl: AbortController } while pulling
  const [pullingModels, setPullingModels] = useState({});
  // Free-text "pull any Ollama model" field in the model menu.
  const [customModelInput, setCustomModelInput] = useState('');
  // modelId → true while a delete request is in-flight
  const [deletingModels, setDeletingModels] = useState({});
  const [isTeachPanelOpen, setIsTeachPanelOpen] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const autoScrollRef = useRef(true); // ref mirror - readable synchronously in scroll handler
  const [memoryItems, setMemoryItems] = useState([]);
  const [memoryInput, setMemoryInput] = useState('');
  // Watched Workspace: pinned files (relative paths) whose FRESH contents are
  // folded into each send. Reactive so the composer chip updates as pins change.
  const workspacePins = useAppStore((s) => s.workspacePins);

  // Remote Control
  const [isControlPanelOpen, setIsControlPanelOpen] = useState(false);
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
  const [execResults, setExecResults] = useState({}); // codeBlockKey → { stdout, stderr, exitCode, running }
  const [uncensoredMode, setUncensoredMode] = useState(false);
  const [isMcpPanelOpen, setIsMcpPanelOpen] = useState(false);
  const [isParamsPanelOpen, setIsParamsPanelOpen] = useState(false);
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
  // Inference Cockpit: advanced Ollama sampling/load knobs (null = provider default).
  // Persisted as one object so power users can tune local generation the way LM
  // Studio / Jan allow. Only sent to Ollama; cloud providers ignore these.
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
  const [mcpServers, setMcpServers] = useState([]);
  const [mcpSelectedServerId, setMcpSelectedServerId] = useState('');
  const [mcpForm, setMcpForm] = useState({
    id: '',
    name: '',
    url: '',
    transport: 'streamable-http',
    authToken: ''
  });
  const [mcpTools, setMcpTools] = useState([]);
  const [mcpPolicy, setMcpPolicy] = useState({
    enforceAllowlist: false,
    requireApproval: true,
    approvalTtlSeconds: 300,
    allowedTools: []
  });
  const [mcpToolName, setMcpToolName] = useState('');
  const [mcpToolArgsText, setMcpToolArgsText] = useState('{}');
  const [mcpCallResultText, setMcpCallResultText] = useState('');
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpCalling, setMcpCalling] = useState(false);
  const promptAutosaveTimerRef = useRef(null);

  const promptProfiles = useMemo(
    () => buildPromptProfiles(provider, customPromptProfiles),
    [provider, customPromptProfiles]
  );

  const promptProfileOptions = useMemo(() => {
    const hasSelected = promptProfiles.some((profile) => profile.id === selectedPromptProfileId);
    if (hasSelected && selectedPromptProfileId !== UNSAVED_PROMPT_PROFILE_ID) return promptProfiles;
    return [...promptProfiles, { id: UNSAVED_PROMPT_PROFILE_ID, label: 'Current Custom', description: 'Unsaved instructions', content: systemPrompt, isBuiltin: false }];
  }, [promptProfiles, selectedPromptProfileId, systemPrompt]);

  const selectedPromptProfile = useMemo(
    () => findPromptProfile(promptProfiles, selectedPromptProfileId),
    [promptProfiles, selectedPromptProfileId]
  );

  const selectedMcpServer = useMemo(
    () => mcpServers.find((item) => item.id === mcpSelectedServerId) || null,
    [mcpServers, mcpSelectedServerId]
  );

  const selectedModelRecord = useMemo(() => models.find((item) => item.id === model) || null, [model, models]);
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
        if ((provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas') && !cfgKey) {
          const p = provider === 'grok' ? 'Grok' : provider === 'groq' ? 'Groq' : provider === 'openrouter' ? 'OpenRouter' : provider === 'gemini' ? 'Gemini' : provider === 'cerebras' ? 'Cerebras' : provider === 'claude' ? 'Claude' : provider === 'gpuaas' ? 'GPUaaS endpoint' : 'OpenAI';
          setStatusText(`${p} selected. Add API key in Configure endpoint.`);
          return;
        }
        const query = new URLSearchParams({ provider });
        if (cfgBase) query.set('baseUrl', cfgBase);
        // API key travels in a header, never the URL (query strings leak into logs/history).
        const keyHeader = ((provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas' || provider === 'openai-compatible' || provider === 'vllm') && cfgKey)
          ? { 'x-provider-key': cfgKey } : undefined;
        const health = await api(`/api/providers/health?${query.toString()}`, keyHeader ? { headers: keyHeader } : undefined);
        if (cancelled) return;
        if (!health?.reachable) {
          const hint = health?.hint ? ` ${health.hint}` : '';
          setStatusText(`Selected provider unavailable.${hint}`.trim());
        }
      } catch {
        // ignore startup health probe failures
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [provider, providerConfigs]);

  useEffect(() => {
    // Backfill provider config defaults for existing users with empty/legacy settings.
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

  useEffect(() => {
    safeStorageSet('mirabilis-provider-configs', JSON.stringify(providerConfigs));
  }, [providerConfigs]);

  useEffect(() => {
    safeStorageSet('mirabilis-openclaw', openClawMode ? 'true' : 'false');
  }, [openClawMode]);

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
      // silently ignore
    }
  }

  async function downloadPiperModel(modelId) {
    setDownloadingPiperModelId(modelId);
    setStatusText(`Downloading voice model ${modelId}…`);
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
    setStatusText('Setting up local voice tools...');
    try {
      const payload = await api('/api/voice/setup', { method: 'POST' });
      setVoiceTools(payload?.status || null);
      setStatusText('Voice tools installed');
    } catch (error) {
      setStatusText(`Voice setup failed: ${error.message}`);
    } finally {
      setIsSettingUpVoiceTools(false);
      await checkVoiceTools();
    }
  }

  async function setupStt() {
    setIsSettingUpStt(true);
    setStatusText('Installing local speech-to-text (this can take a few minutes)...');
    try {
      const payload = await api('/api/voice/stt-setup', { method: 'POST' });
      if (payload?.status?.ready) voiceSttReadyRef.current = true;
      setStatusText(payload?.status?.ready ? 'Speech-to-text ready' : 'Speech-to-text setup finished');
      await checkVoiceTools();
    } catch (error) {
      setStatusText(`Speech-to-text setup failed: ${error.message}`);
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
    if (!model) { setStatusText('Enter a model id for local vLLM.'); return; }
    setIsVllmBusy(true);
    setStatusText('Starting local vLLM (a first-time weight download can take a while)...');
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
      // Launchable models = the GGUFs you already have (your downloaded/Ollama
      // models). llama.cpp runs those files directly - no Ollama daemon at inference.
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
    if (!model) { setStatusText('Pick a model to run in llama.cpp.'); return; }
    setIsLlamacppBusy(true);
    setStatusText('Starting llama.cpp (loading the model)...');
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
    if (voiceEngine === 'piper') {
      speakTextViaPiper(text, messageId);
      return;
    }
    const synth = speechSynthesisRef.current;
    if (!synth || !voiceSupported) return;

    const clean = plainTextForSpeech(text);
    if (!clean) return;

    const utterance = new SpeechSynthesisUtterance(clean);
    const voice = availableVoices.find((v) => v.voiceURI === selectedVoiceUri);
    if (voice) utterance.voice = voice;
    utterance.rate = Math.min(1.5, Math.max(0.8, Number(voiceRate) || 1));
    utterance.pitch = Math.min(1.4, Math.max(0.8, Number(voicePitch) || 1));
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
        body: JSON.stringify({ text: clean.slice(0, 5000), modelId: selectedPiperModelId || undefined }),
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

  /* ── Voice chat loop ──────────────────────────────────────────────────────
     listen (SR) -> send (stream) -> speak (TTS) -> listen, hands-free, until the
     user taps End. State lives in refs so the recognition callbacks never read a
     stale phase, and send/speak are invoked through refs kept fresh every render
     (see the effect just below) so a mid-conversation provider/voice switch is
     always honoured. */

  function setVoicePhaseBoth(next) {
    voicePhaseRef.current = next;
    setVoicePhase(next);
  }

  // Keep the loop's send/speak handles pointing at the latest closures.
  useEffect(() => {
    voiceSendRef.current = sendMessageWithContent;
    voiceSpeakRef.current = speakText;
    voiceStopSpeakRef.current = stopSpeaking;
    messagesRef.current = messages;
  });

  // The live loop records audio and transcribes on the backend (whisper.cpp),
  // so it needs mic capture + MediaRecorder - NOT the Web Speech API, which is
  // dead inside the packaged Electron app.
  useEffect(() => {
    const supported = typeof window !== 'undefined'
      && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(window.MediaRecorder);
    setVoiceLoopSupported(supported);
  }, []);

  // Tear the whole capture path down: stop the recorder, release the mic (this
  // is what turns the macOS orange mic indicator OFF), close the audio context,
  // and clear every VAD timer. Idempotent - safe to call repeatedly.
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
    // Legacy Web Speech handle, in case an old recognizer is somehow still around.
    const legacy = voiceRecognitionRef.current;
    if (legacy) {
      try { legacy.onresult = null; legacy.onend = null; legacy.onerror = null; legacy.stop(); } catch { /* noop */ }
      voiceRecognitionRef.current = null;
    }
  }

  // Decode a recorded audio Blob and re-encode it as a 16 kHz mono PCM16 WAV -
  // the format whisper.cpp consumes directly, so no server-side ffmpeg is needed.
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

  // Pick the closest male/female browser voice by name (best effort - the Web
  // Speech API does not expose gender). Also flips the engine to 'browser'.
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

  // Route the chosen gender to a local Piper voice when installed; otherwise
  // speak instantly with a browser voice and fetch Piper in the background.
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
      setVoiceNote(`Preparing the ${gender} voice (first-time download)...`);
      downloadPiperModel(modelId)
        .then(() => {
          setVoiceEngine('piper');
          setSelectedPiperModelId(modelId);
          setVoiceNote('');
        })
        .catch(() => {
          // Stay on the browser voice - never crash the loop over a download.
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
      setVoiceNote('Microphone access denied. Allow the mic in System Settings, then reopen voice chat.');
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
      setVoiceNote('Audio recording is not supported here.');
      setVoicePhaseBoth('idle');
      return;
    }
    voiceRecorderRef.current = recorder;
    setVoicePhaseBoth('listening');

    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) voiceChunksRef.current.push(e.data); };
    recorder.onerror = () => { /* surfaced via onstop */ };

    // Finalize once - the VAD, the max-duration cap, and an orb tap can all race.
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
      // Release the mic immediately - this is what turns the orange indicator off.
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
        // STT unavailable or failed: stop the loop cleanly. Never blink forever.
        voiceActiveRef.current = false;
        stopVoiceRecognition();
        const msg = String(err?.message || '');
        setVoiceNote(/speech-to-text|speech to text|whisper/i.test(msg)
          ? 'Local speech-to-text is not installed yet. Open Voice Settings to set it up.'
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
      // May start suspended under the autoplay policy after our awaits; resume so
      // the analyser actually processes audio (otherwise VAD would never fire).
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
          setVoiceNote('Listening paused (no speech heard). Tap the orb to talk.');
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
      Promise.resolve(send(text)).catch(() => {
        // Send failed to even start - drop back to listening so we're not stuck.
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
      setVoiceNote('Microphone recording is not available here.');
      setVoicePhaseBoth('idle');
      return;
    }
    // Only open the mic once we know a speech-to-text engine is actually usable,
    // so we never hold the mic (blinking indicator) with nothing to transcribe.
    setVoicePhaseBoth('thinking');
    fetch(`${API_BASE}/api/voice/stt-status`).then((r) => r.json()).then((s) => {
      if (!voiceActiveRef.current) return;
      voiceSttReadyRef.current = Boolean(s?.ready);
      if (s?.ready) {
        startVoiceListening();
      } else {
        setVoiceNote('Local speech-to-text is not installed. Open Voice Settings to enable talking.');
        setVoicePhaseBoth('idle');
      }
    }).catch(() => {
      // Status unknown (backend slow/unreachable): try anyway; the transcribe
      // error path will guide the user if STT is genuinely missing.
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

  useEffect(() => {
    if (!isStreaming) { setStreamingLabel(''); return; }
    const phases = [
      [0,     'Processing…'],
      [1800,  'Thinking…'],
      [5500,  'Generating…'],
      [13000, 'Loading model…'],
      [28000, 'Still working…'],
    ];
    const timers = phases.map(([delay, label]) => setTimeout(() => setStreamingLabel(label), delay));
    return () => timers.forEach(clearTimeout);
  }, [isStreaming]);

  // Drive the Aurora StatusOrb's "busy" breathing from the real streaming state.
  // AuroraChrome listens for these; without them the orb never showed activity.
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
      setIsControlPanelOpen(false);
      setRemotePassword(''); // don't keep password in state after connecting
    } catch (err) {
      setStatusText(`Remote: ${err.message}`);
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

  async function refreshMcpServers() {
    try {
      const payload = await api('/api/mcp/servers');
      const servers = Array.isArray(payload?.servers) ? payload.servers : [];
      setMcpServers(servers);
      setMcpSelectedServerId((current) => {
        if (current && servers.find((item) => item.id === current)) return current;
        return servers[0]?.id || '';
      });
    } catch (error) {
      setStatusText(`MCP: ${error.message}`);
      setMcpServers([]);
    }
  }

  async function saveMcpServer() {
    const id = mcpForm.id.trim();
    const name = mcpForm.name.trim();
    const url = mcpForm.url.trim();
    if (!id || !name || !url) {
      setStatusText('MCP: id, name, and url are required');
      return;
    }
    setMcpLoading(true);
    try {
      await api('/api/mcp/servers', {
        method: 'POST',
        body: JSON.stringify({
          id,
          name,
          url,
          transport: 'streamable-http',
          authToken: mcpForm.authToken
        })
      });
      await refreshMcpServers();
      setMcpSelectedServerId(id);
      setStatusText(`MCP server ${id} saved`);
    } catch (error) {
      setStatusText(`MCP: ${error.message}`);
    } finally {
      setMcpLoading(false);
    }
  }

  async function deleteMcpServer() {
    if (!mcpSelectedServerId) return;
    setMcpLoading(true);
    try {
      await api(`/api/mcp/servers/${encodeURIComponent(mcpSelectedServerId)}`, { method: 'DELETE' });
      setMcpTools([]);
      setMcpToolName('');
      setMcpCallResultText('');
      await refreshMcpServers();
      setStatusText('MCP server removed');
    } catch (error) {
      setStatusText(`MCP: ${error.message}`);
    } finally {
      setMcpLoading(false);
    }
  }

  async function testMcpServer() {
    if (!mcpSelectedServerId) return;
    setMcpLoading(true);
    try {
      await api(`/api/mcp/servers/${encodeURIComponent(mcpSelectedServerId)}/test`, {
        method: 'POST',
        body: JSON.stringify({ timeoutMs: 15000 })
      });
      setStatusText(`MCP ${mcpSelectedServerId} test succeeded`);
    } catch (error) {
      setStatusText(`MCP test failed: ${error.message}`);
    } finally {
      setMcpLoading(false);
    }
  }

  async function loadMcpPolicy(serverId) {
    if (!serverId) {
      setMcpPolicy({ enforceAllowlist: false, requireApproval: true, approvalTtlSeconds: 300, allowedTools: [] });
      return;
    }
    try {
      const payload = await api(`/api/mcp/servers/${encodeURIComponent(serverId)}/policy`);
      const policy = payload?.policy || {};
      setMcpPolicy({
        enforceAllowlist: !!policy.enforceAllowlist,
        requireApproval: policy.requireApproval !== false,
        approvalTtlSeconds: Number(policy.approvalTtlSeconds) || 300,
        allowedTools: Array.isArray(policy.allowedTools) ? policy.allowedTools : []
      });
    } catch (error) {
      setStatusText(`MCP policy: ${error.message}`);
    }
  }

  async function saveMcpPolicy(nextPolicy) {
    if (!mcpSelectedServerId) return;
    setMcpPolicy(nextPolicy);
    try {
      const payload = await api(`/api/mcp/servers/${encodeURIComponent(mcpSelectedServerId)}/policy`, {
        method: 'PUT',
        body: JSON.stringify(nextPolicy)
      });
      if (payload?.policy) {
        setMcpPolicy(payload.policy);
      }
    } catch (error) {
      setStatusText(`MCP policy: ${error.message}`);
    }
  }

  async function loadMcpTools() {
    if (!mcpSelectedServerId) return;
    setMcpLoading(true);
    try {
      const payload = await api(`/api/mcp/servers/${encodeURIComponent(mcpSelectedServerId)}/tools/list`, {
        method: 'POST',
        body: JSON.stringify({ timeoutMs: 15000 })
      });
      const tools = Array.isArray(payload?.tools) ? payload.tools : [];
      setMcpTools(tools);
      if (!mcpToolName && tools.length > 0) {
        setMcpToolName(String(tools[0].name || ''));
      }
      setStatusText(`Loaded ${tools.length} MCP tools`);
    } catch (error) {
      setStatusText(`MCP tools: ${error.message}`);
      setMcpTools([]);
    } finally {
      setMcpLoading(false);
    }
  }

  async function callMcpTool() {
    if (!mcpSelectedServerId || !mcpToolName.trim()) {
      setStatusText('MCP: choose a server and tool first');
      return;
    }

    let parsedArgs = {};
    try {
      parsedArgs = JSON.parse(mcpToolArgsText || '{}');
    } catch {
      setStatusText('MCP: tool arguments must be valid JSON');
      return;
    }

    setMcpCalling(true);
    try {
      let approvalToken;
      if (mcpPolicy.requireApproval) {
        const approval = await api(`/api/mcp/servers/${encodeURIComponent(mcpSelectedServerId)}/tools/request-approval`, {
          method: 'POST',
          body: JSON.stringify({ name: mcpToolName.trim(), arguments: parsedArgs })
        });
        approvalToken = approval?.approvalToken;
      }

      const payload = await api(`/api/mcp/servers/${encodeURIComponent(mcpSelectedServerId)}/tools/call`, {
        method: 'POST',
        body: JSON.stringify({
          name: mcpToolName.trim(),
          arguments: parsedArgs,
          approvalToken,
          timeoutMs: 30000
        })
      });
      setMcpCallResultText(stringifyJson(payload?.result || {}));
      setStatusText(`MCP tool ${mcpToolName.trim()} executed`);
    } catch (error) {
      setMcpCallResultText(stringifyJson({ error: error.message }));
      setStatusText(`MCP call failed: ${error.message}`);
    } finally {
      setMcpCalling(false);
    }
  }

  function useLocalMcpPreset() {
    setMcpForm({
      id: 'mcp-local',
      name: 'Local MCP Endpoint',
      url: 'http://127.0.0.1:30030/mcp',
      transport: 'streamable-http',
      authToken: ''
    });
  }

  function handleCreateImageTool() {
    setIsToolsMenuOpen(false);
    setInput((current) => {
      const trimmed = current.trim();
      if (trimmed && !isImageRequest(trimmed)) {
        return `Generate an image of ${trimmed}`;
      }
      if (!trimmed) {
        return 'Generate an image of ';
      }
      return current;
    });
    setStatusText(imageServiceAvailable ? 'Ready to generate image prompt' : 'Image service offline');
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
      setStatusText('Dictation is not supported on this device.');
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
            setStatusText('No speech detected.');
          } else if (code === 'aborted') {
            setStatusText('Ready');
          } else if (code === 'not-allowed' || code === 'service-not-allowed') {
            setStatusText('Microphone access denied.');
            appStore.toast('Could not transcribe - microphone permission was denied.', { kind: 'error' });
          } else {
            setStatusText('Dictation error.');
            appStore.toast('Could not transcribe - speech recognition failed. Please try again.', { kind: 'error' });
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
        appStore.toast('Could not transcribe - speech recognition failed to start.', { kind: 'error' });
      }
      return;
    }

    if (dictationPhaseRef.current === 'transcribing') {
      setStatusText('Dictation is still transcribing...');
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
      setStatusText('Dictation is not supported on this device.');
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
        setStatusText('Dictation recording...');
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
        setStatusText('Transcribing dictation...');

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
            setStatusText('No speech detected.');
          }
        } catch (error) {
          setStatusText(`Dictation error: ${error.message}`);
          appStore.toast('Could not transcribe - your browser lacks speech recognition and no local Whisper is installed.', { kind: 'error', ttl: 5200 });
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
        ? 'Microphone access denied - check System Settings → Privacy → Microphone.'
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
    // Bail out if clearAllChats() ran while we were awaiting - would resurrect deleted chats
    if (chatListEpochRef.current !== epoch) return;
    setChats(payload.chats || []);
  }

  async function loadChat(chatId) {
    setIsTeachPanelOpen(false);
    // Save scroll position of the current chat before switching
    if (activeChatId && messagesScrollRef.current) {
      chatScrollPositions.current[activeChatId] = messagesScrollRef.current.scrollTop;
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
      appStore.toast('Off the Record - this chat is never saved to disk and vanishes when you quit', { kind: 'info', ttl: 4200 });
    }
  }

  async function toggleUncensoredMode() {
    const next = !uncensoredMode;
    setUncensoredMode(next);
    if (!next) {
      setOpenClawMode(false);
    }
    if (!activeChatId) {
      setStatusText(next ? 'Uncensored ON: model-only filtering (new chat will inherit)' : 'Uncensored OFF: model-native mode');
      return;
    }
    try {
      await api(`/api/chats/${activeChatId}`, {
        method: 'PATCH',
        body: JSON.stringify({ uncensoredMode: next })
      });
      if (next && provider === 'ollama') {
        const best = pickMostUncensoredModel(models);
        if (best?.id && best.id !== model) {
          setModel(best.id);
          setStatusText(`Uncensored ON: locked to ${best.label || best.id}`);
          await refreshChats();
          return;
        }
      }
      setStatusText(next ? 'Uncensored ON: model-only filtering' : 'Uncensored OFF: model-native mode');
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
        setStatusText('OpenClaw ON: uncensored + no personal memory + no app system prompt');
        return;
      }

      try {
        await api(`/api/chats/${activeChatId}`, {
          method: 'PATCH',
          body: JSON.stringify({ uncensoredMode: true })
        });
        setStatusText('OpenClaw ON: uncensored + no personal memory + no app system prompt');
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
      setStatusText('OpenClaw OFF');
      return;
    }

    try {
      await api(`/api/chats/${activeChatId}`, {
        method: 'PATCH',
        body: JSON.stringify({ uncensoredMode: false })
      });
      setUncensoredMode(false);
      setStatusText('OpenClaw OFF');
      await refreshChats();
    } catch (error) {
      setStatusText(`OpenClaw update failed: ${error.message}`);
      setOpenClawMode(true);
    }
  }

  async function removeChat(chatId) {
    // Abort any in-flight stream so the post-stream saveChat doesn't resurrect the chat
    if (activeChatId === chatId) stopStreaming();
    await api(`/api/chats/${chatId}`, { method: 'DELETE' });
    setOpenChatMenuId((current) => (current === chatId ? null : current));
    if (activeChatId === chatId) {
      setActiveChatId(null);
      setActiveChatMeta(null);
      setSelectedSnapshotId('');
      setMessages([]);
    }
    await refreshChats();
  }

  async function clearAllChats() {
    // Abort stream first - otherwise the post-stream saveChat fires after the
    // DELETE and immediately re-adds the last chat (intermittent "comes back" bug)
    stopStreaming();
    chatListEpochRef.current++; // invalidate any in-flight refreshChats() calls
    // Clear UI immediately - don't wait for the network roundtrip
    setActiveChatId(null);
    setActiveChatMeta(null);
    setSelectedSnapshotId('');
    setMessages([]);
    setChats([]);
    setChatSearch('');
    // Then flush to backend (fire and forget error - UI is already clear)
    try {
      await api('/api/chats', { method: 'DELETE' });
    } catch {
      // ignore - UI is already empty
    }
  }

  async function deleteLastChat() {
    if (!chats.length) {
      return;
    }
    // If a chat is active, delete it. Otherwise delete the most recently updated.
    const targetId = activeChatId
      ? activeChatId
      : ([...chats].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0]?.id);
    if (!targetId) {
      return;
    }
    await removeChat(targetId);
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
      setStatusText('Created chat branch');
    } catch (error) {
      setStatusText(`Branch failed: ${error.message}`);
    }
  }

  async function saveSnapshot() {
    if (!activeChatId) {
      setStatusText('Open a chat before saving a snapshot');
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
      setStatusText('Select a snapshot to restore');
      return;
    }
    const confirmed = window.confirm('Restore this snapshot? Current chat state will be replaced.');
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
    setStatusText(`Loaded instruction profile: ${profile.label}`);
  }

  function saveCurrentPromptProfile() {
    const prompt = systemPrompt.trim();
    if (!prompt) {
      setStatusText('Cannot save an empty instruction profile');
      return;
    }
    const name = window.prompt('Profile name');
    if (!name) return;
    const label = name.trim().slice(0, 60);
    if (!label) return;
    const description = window.prompt('Short description (optional)') || '';
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
    setStatusText(`Saved instruction profile: ${label}`);
  }

  function deleteSelectedPromptProfile() {
    const selected = findPromptProfile(promptProfiles, selectedPromptProfileId);
    if (!selected || selected.isBuiltin) return;
    const confirmed = window.confirm(`Delete instruction profile "${selected.label}"?`);
    if (!confirmed) return;
    setCustomPromptProfiles((prev) => prev.filter((profile) => profile.id !== selected.id));
    setSelectedPromptProfileId(UNSAVED_PROMPT_PROFILE_ID);
    setStatusText(`Deleted instruction profile: ${selected.label}`);
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
      // Fallback for older/failed profile detection: still expose processor details.
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
            label: `${cpuModel || 'Processor'} • ${cpuCores}c/${cpuThreads}t`,
            expanded: [
              archName ? `Arch: ${archName}` : null,
              platform ? `Platform: ${platform}` : null
            ].filter(Boolean).join('\n')
          },
          memory: {
            label: `${ramLabel} • System RAM`,
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

  async function refreshModels() {
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
      const available = payload.models || [];
      setModels(available);
      // Fetch total device RAM once, to size the model-fit pill against it.
      if (deviceRamGb === null) {
        try {
          const specs = await api('/api/system/specs');
          const ram = Number(specs?.ramGb);
          if (Number.isFinite(ram) && ram > 0) setDeviceRamGb(ram);
        } catch { /* fit pill just won't show */ }
      }
      // If current model is 'auto', no override needed - it resolves at send time.
      // Only fall back if the explicitly chosen model is no longer installed.
      setModel((currentModel) => {
        if (currentModel === 'auto') return 'auto';
        const stillInstalled = available.some((item) => item.id === currentModel && item.available !== false);
        if (stillInstalled) return currentModel;
        // Model was removed - fall back to auto
        return 'auto';
      });
    } catch {
      setModels([]);
    }
  }

  async function refreshVaultStatus() {
    try {
      const s = await api('/api/vault/status');
      if (s?.ok) setConfigVaultStatus(s);
    } catch { /* best effort */ }
  }

  async function indexConfigVault() {
    const folder = String(configVaultFolder || '').trim();
    if (!folder) { setConfigVaultMsg('Enter a folder path first.'); return; }
    setConfigVaultBusy(true);
    setConfigVaultMsg('Indexing (embedding locally)...');
    try {
      const r = await api('/api/vault/index', { method: 'POST', body: JSON.stringify({ path: folder }) });
      if (r?.ok) {
        setConfigVaultStatus({ ok: true, root: r.root, builtAt: new Date().toISOString(), embedModel: r.embedModel, fileCount: r.fileCount, chunkCount: r.chunkCount });
        setConfigVaultMsg(`Indexed ${r.fileCount} file(s), ${r.chunkCount} chunk(s) via ${r.embedModel}.${r.truncated ? ' Reached the chunk cap; narrow the folder for full coverage.' : ''}`);
      } else {
        setConfigVaultMsg(r?.error || 'Indexing failed.');
      }
    } catch (error) {
      setConfigVaultMsg(`Indexing failed: ${error.message}`);
    } finally {
      setConfigVaultBusy(false);
    }
  }

  async function clearConfigVault() {
    setConfigVaultBusy(true);
    try {
      await api('/api/vault/index', { method: 'DELETE' });
      setConfigVaultStatus({ ok: true, root: '', builtAt: null, embedModel: null, fileCount: 0, chunkCount: 0 });
      setConfigVaultMsg('Index cleared.');
    } catch (error) {
      setConfigVaultMsg(`Clear failed: ${error.message}`);
    } finally {
      setConfigVaultBusy(false);
    }
  }

  async function resolveProviderForSend() {
    if (provider === 'ollama') {
      const forcedUncensored = uncensoredMode ? pickMostUncensoredModel(models) : null;
      const contextTokens = contextUsage?.totalTokens || 0;
      const resolvedAuto = model === 'auto' ? (pickBestAutoModel(models, contextTokens)?.id || '') : model;
      const effectiveModel = forcedUncensored?.id || resolvedAuto;
      if (uncensoredMode && forcedUncensored?.id && model !== forcedUncensored.id) {
        setModel(forcedUncensored.id);
      }
      return { provider: 'ollama', model: effectiveModel, providerBaseUrl: undefined, providerApiKey: undefined };
    }

    const firstAvailableModel = (models || []).find((item) => item?.available !== false)?.id || '';
    const effectiveNonOllamaModel = model === 'auto'
      ? (firstAvailableModel || (provider === 'openai' ? 'gpt-4o-mini' : provider === 'grok' ? 'grok-3-mini' : provider === 'groq' ? 'llama-3.3-70b-versatile' : provider === 'openrouter' ? 'meta-llama/llama-3.3-70b-instruct:free' : provider === 'gemini' ? 'gemini-2.5-flash' : provider === 'cerebras' ? 'llama-3.3-70b' : provider === 'claude' ? 'claude-3-5-sonnet-latest' : provider === 'gpuaas' ? 'model.gguf' : ''))
      : model;

    const configuredApiKey = String(providerConfigs[provider]?.apiKey || '').trim();
    if ((provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas') && !configuredApiKey) {
      setIsProviderConfigOpen(true);
      const p = provider === 'grok' ? 'xAI' : provider === 'groq' ? 'Groq' : provider === 'openrouter' ? 'OpenRouter' : provider === 'gemini' ? 'Google AI' : provider === 'cerebras' ? 'Cerebras' : provider === 'claude' ? 'Anthropic' : provider === 'gpuaas' ? 'GPUaaS endpoint' : 'OpenAI';
      throw new Error(`${p} API key is required. Open Configure endpoint and paste your key.`);
    }

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
          providerApiKey: providerConfigs[provider]?.apiKey || undefined
        };
      }

      const hint = payload?.hint ? ` ${payload.hint}` : '';
      const target = payload?.baseUrl || configuredBaseUrl || 'configured endpoint';
      setStatusText(`Provider check warning: ${target} is unreachable.${hint}`);
      return {
        provider,
        model: effectiveNonOllamaModel,
        providerBaseUrl: providerConfigs[provider]?.baseUrl || undefined,
        providerApiKey: providerConfigs[provider]?.apiKey || undefined
      };
    } catch (error) {
      setStatusText(`Provider check failed: ${error.message}`);
      return {
        provider,
        model: effectiveNonOllamaModel,
        providerBaseUrl: providerConfigs[provider]?.baseUrl || undefined,
        providerApiKey: providerConfigs[provider]?.apiKey || undefined
      };
    }
  }

  function cancelInstall(modelId) {
    setPullingModels((prev) => {
      if (prev[modelId]?.ctrl) prev[modelId].ctrl.abort();
      const jobId = prev[modelId]?.jobId;
      if (jobId) {
        api(`/api/models/install-jobs/${encodeURIComponent(jobId)}/cancel`, {
          method: 'POST'
        }).catch(() => {});
      }
      const n = { ...prev };
      delete n[modelId];
      return n;
    });
    setStatusText(`Model install canceled: ${modelId}`);
  }

  async function deleteModel(ollamaId, modelId) {
    if (provider !== 'ollama') return;
    setDeletingModels((prev) => ({ ...prev, [modelId]: true }));
    try {
      await api(`/api/models/${encodeURIComponent(ollamaId || modelId)}`, { method: 'DELETE' });
      setStatusText(`Removed: ${modelId}`);
      await refreshModels();
      // if the deleted model was selected, clear the selection
      setModel((prev) => (prev === modelId ? '' : prev));
    } catch (err) {
      setStatusText(`Remove failed: ${err.message}`);
    } finally {
      setDeletingModels((prev) => { const n = { ...prev }; delete n[modelId]; return n; });
    }
  }

  function installModel(ollamaId, modelId) {
    if (provider !== 'ollama') {
      setStatusText('Model install is supported only in Ollama mode');
      return;
    }
    if (pullingModels[modelId]) return; // already pulling
    const ctrl = new AbortController();
    setPullingModels((prev) => ({ ...prev, [modelId]: { pct: null, status: 'Queued…', ctrl, jobId: null } }));
    (async () => {
      try {
        const started = await api('/api/models/install-jobs', {
          method: 'POST',
          body: JSON.stringify({ modelId: ollamaId })
        });

        const jobId = started?.job?.id;
        if (!jobId) {
          throw new Error('Install job was not created');
        }

        setPullingModels((prev) => {
          if (!prev[modelId]) return prev;
          return {
            ...prev,
            [modelId]: {
              ...prev[modelId],
              jobId,
              status: started?.job?.message || 'Starting…',
              pct: started?.job?.pct ?? null
            }
          };
        });

        while (true) {
          if (ctrl.signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          const polled = await api(`/api/models/install-jobs/${encodeURIComponent(jobId)}`);
          const job = polled?.job;
          if (!job) {
            throw new Error('Install job not found');
          }

          setPullingModels((prev) => {
            if (!prev[modelId]) return prev;
            return {
              ...prev,
              [modelId]: {
                ...prev[modelId],
                pct: job.pct ?? null,
                status: job.message || job.status || '',
                jobId
              }
            };
          });

          if (job.done) {
            setPullingModels((prev) => { const n = { ...prev }; delete n[modelId]; return n; });

            if (job.status === 'completed') {
              await refreshModels();
              setStatusText(`Model installed: ${modelId}`);
            } else if (job.status === 'canceled') {
              setStatusText(`Model install canceled: ${modelId}`);
            } else {
              setStatusText(`Model install failed: ${job.error || job.message || 'unknown error'}`);
            }
            return;
          }

          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      } catch (error) {
        setPullingModels((prev) => { const n = { ...prev }; delete n[modelId]; return n; });
        const msg = error?.name === 'AbortError'
          ? `Model install canceled: ${modelId}`
          : `Model install failed: ${error?.message || 'unknown error'}`;
        setStatusText(msg);
      }
    })();
  }

  // Keep refs in sync so renderMessageContent always sees latest values
  useEffect(() => { remoteConnectedRef.current = remoteConnected; }, [remoteConnected]);
  useEffect(() => { remoteTargetRef.current = remoteTarget; }, [remoteTarget]);
  useEffect(() => { execResultsRef.current = execResults; }, [execResults]);

    // Close all dropdown/panel menus
    function closeAllDropdowns() {
      setIsProviderMenuOpen(false);
      setIsProviderConfigOpen(false);
      setIsModelMenuOpen(false);
      setIsTrainingMenuOpen(false);
      setIsToolsMenuOpen(false);
      setIsVoiceMenuOpen(false);
      setIsContextPanelOpen(false);
      setIsEngineMenuOpen(false);
      setOpenHardwarePopover(null);
      setIsControlPanelOpen(false);
      setIsMcpPanelOpen(false);
      setIsParamsPanelOpen(false);
      setIsEffortMenuOpen(false);
      setIsOptionsMenuOpen(false);
      setOpenChatMenuId(null);
    }

    // Count of options/modes that are currently on - drives the Options badge.
    // OpenClaw stays here; Uncensored also has a direct toolbar toggle but is still
    // counted here since it lives in the Options Modes list too.
    const optionsActiveCount =
      (uncensoredMode ? 1 : 0) +
      (openClawMode ? 1 : 0) +
      (remoteConnected ? 1 : 0) +
      (selectedMcpServer ? 1 : 0) +
      (guidedLearningEnabled ? 1 : 0) +
      (deepThinkingEnabled ? 1 : 0) +
      (canvasEnabled ? 1 : 0) +
      (configVaultEnabled ? 1 : 0) +
      (trainingMode !== 'off' ? 1 : 0);

    const anyDropdownOpen = isProviderMenuOpen || isProviderConfigOpen || isModelMenuOpen || isTrainingMenuOpen || isToolsMenuOpen ||
      isVoiceMenuOpen || isContextPanelOpen || isEngineMenuOpen ||
      openHardwarePopover !== null || isControlPanelOpen || isMcpPanelOpen || isParamsPanelOpen ||
      isEffortMenuOpen || isOptionsMenuOpen;

    const activeMenuKey = isProviderMenuOpen
      ? 'provider'
      : isModelMenuOpen
      ? 'model'
      : isEffortMenuOpen
      ? 'effort'
      : isVoiceMenuOpen
      ? 'voice'
      : isControlPanelOpen
      ? 'control'
      : isMcpPanelOpen
      ? 'mcp'
      : isOptionsMenuOpen
      ? 'options'
      : isTrainingMenuOpen
      ? 'training'
      : isToolsMenuOpen
      ? 'tools'
      : isVoiceMenuOpen
      ? 'voice'
      : isContextPanelOpen
      ? 'context'
      : isEngineMenuOpen
      ? 'engine'
      : openHardwarePopover
      ? `hardware-${openHardwarePopover}`
      : isControlPanelOpen
      ? 'control'
      : isMcpPanelOpen
      ? 'mcp'
      : isParamsPanelOpen
      ? 'params'
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
          const focusable = getFocusableElements(panel);
          if (focusable.length > 0) {
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
    // Poll every 30 s so image device chip stays current.
    // Hardware profile is cached server-side after first call - no need to re-poll.
    const interval = setInterval(() => {
      checkImageService();
    }, 30000);
    // Poll utilization every 15 s (backend caches at 3 s, so no benefit polling faster)
    const utilInterval = setInterval(fetchUtilization, 15000);
    return () => { clearInterval(interval); clearInterval(utilInterval); };
  }, []);

  // Probe local vLLM capability/status whenever the vLLM provider is active or its
  // config panel opens, so the panel can offer a local launch or explain why not.
  useEffect(() => {
    if (provider === 'vllm') checkVllmStatus();
    if (provider === 'llamacpp') checkLlamacppStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, isProviderConfigOpen]);

  // When the endpoint config panel CLOSES, re-list models so a newly entered
  // server URL / key is reflected immediately (refreshModels only re-runs on a
  // provider change, not on a base-URL edit).
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

  // Aurora shell integration: the floating dock + ⌘K command palette now own
  // the global keyboard shortcut, and drive chat actions through these DOM
  // CustomEvents. We intentionally no longer bind ⌘K here to avoid double-firing
  // (palette opening AND a new chat) with the shell.
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
    if (!isMcpPanelOpen) return;
    refreshMcpServers();
  }, [isMcpPanelOpen]);

  useEffect(() => {
    if (!mcpSelectedServerId) return;
    loadMcpPolicy(mcpSelectedServerId);
  }, [mcpSelectedServerId]);

  useEffect(() => {
    if (!selectedMcpServer) return;
    setMcpForm((current) => ({
      ...current,
      id: selectedMcpServer.id || '',
      name: selectedMcpServer.name || '',
      url: selectedMcpServer.url || '',
      transport: selectedMcpServer.transport || 'streamable-http',
      authToken: ''
    }));
  }, [selectedMcpServer]);

  useEffect(() => {
    safeStorageSet('mirabilis-engine-option', selectedEngine);
  }, [selectedEngine]);

  // Auto-scroll to bottom while streaming new tokens - throttled to one rAF per frame.
  // IMPORTANT: we re-check autoScrollRef.current INSIDE the RAF, not just at effect entry.
  // This closes the race where the effect runs (ref=true), queues a RAF, the user scrolls
  // up (ref→false), then the RAF fires anyway and overrides the user's position.
  useEffect(() => {
    if (!isStreaming || !messagesScrollRef.current) return;
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

  // systemPrompt tokens isolated so typing in messages never re-runs estimateTokens(systemPrompt)
  const systemPromptTokens = useMemo(() => estimateTokens(systemPrompt), [systemPrompt]);

  // Pinned-first, search-filtered chat list for the sidebar
  const sortedAndFilteredChats = useMemo(() => {
    const lc = chatSearch.trim().toLowerCase();
    const filtered = lc ? chats.filter((c) => (c.title || '').toLowerCase().includes(lc)) : chats;
    const pinned = filtered.filter((c) => pinnedChatIds.has(c.id));
    const unpinned = filtered.filter((c) => !pinnedChatIds.has(c.id));
    return [...pinned, ...unpinned];
  }, [chats, chatSearch, pinnedChatIds]);

  // Single-pass over messages for all token accounting (was two separate useMemo loops)
  const { chatTokenSummary, contextUsage } = useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    let userTokens = 0;
    let uncategorizedTokens = 0;

    for (const message of messages) {
      const tokenCount = Number(message.tokenEstimate || 0);
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

    const rate = resolveRateCard(remoteProvider, model);
    if (!rate) {
      return { enabled: false, estUsd: 0, pct: 0, budgetUsd: remoteBudgetUsd, rate: null };
    }

    const input = Number(chatTokenSummary.input || 0);
    const output = Number(chatTokenSummary.output || 0);
    const estUsd = (input / 1_000_000) * rate.in + (output / 1_000_000) * rate.out;
    const budget = Number(remoteBudgetUsd || 0);
    const pct = budget > 0 ? Math.min(100, Math.round((estUsd / budget) * 100)) : 0;
    return { enabled: true, estUsd, pct, budgetUsd: budget, rate };
  }, [provider, model, chatTokenSummary.input, chatTokenSummary.output, remoteBudgetUsd]);

  async function handleImageGeneration(content) {
    setInput('');
    setIsStreaming(true);
    setStatusText('Generating image on your device...');

    let chatId = activeChatId;
    if (!chatId) {
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
      // Service offline - show a helpful local message, do NOT route to LLM
      const offlineMsg = {
        id: placeholderId,
        role: 'assistant',
        content: [
          '⚠️ Image service is not running.',
          '',
          'To enable on-device image generation:',
          '  1. Make sure you launched the app with run-local.sh from the mirabilis directory.',
          '  2. On first run it installs PyTorch + Stable Diffusion (~6 GB). Wait for “Image service ready”.',
          '  3. Alternatively start it manually:',
          '       cd mirabilis/image-service && python3 -m venv .venv',
          '       .venv/bin/pip install -r requirements.txt',
          '       .venv/bin/python server.py',
          '',
          'Once running, use Tools -> Create Image from the chat bar.'
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
    // Find the last user message
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;

    // Remove all messages after and including the last assistant message that followed
    const lastUserIdx = messages.lastIndexOf(lastUserMsg);
    const trimmed = messages.slice(0, lastUserIdx + 1);
    // Also trim the server-side chat
    const chat = await api(`/api/chats/${activeChatId}`);
    const serverMessages = chat.chat?.messages || [];
    const serverUserIdx = serverMessages.map((m) => m.id).lastIndexOf(lastUserMsg.id);
    if (serverUserIdx < 0) {
      // Temp ID not on server (e.g. message from a failed/aborted stream) - don't patch
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

  // Chat -> Ledger loop: turn the current conversation into an IntelLedger session,
  // extracting signals/actions from it, then jump straight to that session. Reuses
  // the existing create-session + ingest/text endpoints (extraction has a heuristic
  // fallback, so this works even without a live model).
  // Build the plain-text transcript of the current conversation. Shared by the
  // Chat -> Ledger commit flow and the Commitment Radar preview scan so both see
  // exactly the same text.
  function buildChatTranscript() {
    return messages
      .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
  }

  // Commitment Radar: ambient, read-only pass over the current chat. Posts the
  // transcript to the preview-only /scan endpoint (which persists nothing) and
  // opens the radar panel with the detected commitments/asks/decisions.
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
    // The contradiction pass embeds the whole history and asks a local model to
    // judge each candidate, so it runs alongside (and slower than) the fast
    // heuristic scan. It writes nothing and is best-effort: any failure is silent.
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
      setRadarError(err?.message || 'Commitment Radar is unavailable right now.');
    } finally {
      setRadarScanned(true);
      setRadarLoading(false);
    }
  }

  async function commitChatToLedger() {
    if (isCommittingToLedger) return;
    const transcript = buildChatTranscript();
    if (!transcript.trim()) {
      setStatusText('Nothing to commit - the chat has no text yet.');
      return;
    }
    const userId = safeStorageGet('mirabilis-user-id') || 'user-local';
    const chatTitle = (chats.find((c) => c.id === activeChatId)?.title || '').trim() || 'Untitled chat';
    setIsCommittingToLedger(true);
    setStatusText('Committing chat to Ledger…');
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
      setStatusText('Committed to Ledger - signals extracted.');
      appStore.toast('Committed to Ledger', { kind: 'success' });
      playReceive();
      // Close the loop: open the new session in the Ledger tab.
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

  async function sendMessageWithContent(content) {
    if (isImageRequest(content)) {
      await handleImageGeneration(content);
      return;
    }

    // Go Dark: if the session is locked to local-only, refuse to send to a cloud
    // provider before anything leaves the machine (keeps the typed text intact).
    if (appStore.getGoDark()) {
      const scope = PROVIDER_OPTIONS.find((p) => p.id === provider)?.scope;
      if (scope === 'Remote') {
        appStore.toast(`Go Dark is on - "${provider}" is a cloud provider. Switch to a local model or turn Go Dark off.`, { kind: 'warn' });
        return;
      }
    }

    setInput('');
    playSend(); // ICQ send cue (no-ops on mute / reduced-motion)

    let outboundContent = content;

    const behaviorInstructions = [];
    if (guidedLearningEnabled) {
      behaviorInstructions.push(
        'Teaching mode: Explain with a short, structured learning path.',
        'Ask one clarifying question if needed, then provide step-by-step guidance.',
        'Use examples and a tiny recap at the end.'
      );
    }
    if (effortLevel === 'instant') {
      behaviorInstructions.push(
        'Effort: instant. Give the shortest possible correct answer, one line if you can, no preamble.'
      );
    }
    if (effortLevel === 'fast') {
      behaviorInstructions.push(
        'Effort: fast. Answer concisely and directly, skip preamble.'
      );
    }
    if (effortLevel === 'thorough') {
      behaviorInstructions.push(
        'Effort: thorough. Work through the key considerations and give a complete, well-structured answer.'
      );
    }
    // balanced: no extra instruction.
    // Treat effort "deep" as equivalent to the deep-thinking toggle so the two do not
    // double up: push the deep lines once if either is set.
    if (deepThinkingEnabled || effortLevel === 'deep') {
      behaviorInstructions.push(
        'Deep thinking mode: reason carefully, compare alternatives, and include key trade-offs.',
        'Provide a concise executive answer first, then details.'
      );
    }
    if (behaviorInstructions.length > 0) {
      outboundContent = [content, '', ...behaviorInstructions].join('\n');
    }

    // Canvas: when enabled, fold the user's canvas notes into the message as
    // working context (previously the canvas text never reached the model).
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
    if (deepWebEnabled && classifyWebSearch(content) === 'search') {
      setStatusText('Searching the web...');
      setWebSearchStatus('searching');
      try {
        const payload = await api('/api/web-search', {
          method: 'POST',
          body: JSON.stringify({ query: content, maxResults: 5 })
        });

        const sources = Array.isArray(payload.sources) ? payload.sources : [];
        if (sources.length > 0) {
          const context = sources
            .map((item, index) => `${index + 1}. ${item.title || 'Untitled'}\nURL: ${item.url}\nSnippet: ${item.snippet || ''}`)
            .join('\n\n');
          const answerHint = payload.answer ? `High-level answer: ${payload.answer}\n\n` : '';
          outboundContent = [
            content,
            '',
            'Use this web research context when relevant. Prefer these sources over prior assumptions.',
            'Always cite exact source URLs from this context when making factual claims.',
            '',
            answerHint + context
          ].join('\n');
          setWebSearchStatus('idle');
        } else {
          // Search succeeded but no results - treat as soft error
          setWebSearchStatus('error');
          setTimeout(() => setWebSearchStatus('idle'), 4000);
        }
      } catch (error) {
        setStatusText(`Web search unavailable: ${error.message}`);
        setWebSearchStatus('error');
        setTimeout(() => setWebSearchStatus('idle'), 4000);
      } finally {
        setStatusText('Streaming response...');
      }
    }

    // Watched Workspace: fold pinned files' FRESH contents (pulled from disk at
    // this exact moment, not a stale upload) into the outbound message as live
    // context. Only the pinned relative paths are ever persisted - the file bytes
    // are fetched on demand here and prepended. Capped so a large pin set cannot
    // blow up the prompt; missing/oversize files are skipped, never fatal.
    const pins = appStore.getWorkspacePins ? appStore.getWorkspacePins() : [];
    if (pins.length > 0) {
      const MAX_WORKSPACE_CONTEXT = 40 * 1024; // ~40 KB combined budget
      const blocks = [];
      let used = 0;
      let skipped = 0;
      for (const relPath of pins) {
        try {
          const payload = await api(`/api/workspace/file?path=${encodeURIComponent(relPath)}`);
          const text = typeof payload?.content === 'string' ? payload.content : '';
          if (used + text.length > MAX_WORKSPACE_CONTEXT) { skipped += 1; continue; }
          used += text.length;
          blocks.push(`--- ${payload?.path || relPath} ---\n${text}`);
        } catch {
          skipped += 1; // renamed / deleted / oversize / jailed - skip, keep sending
        }
      }
      if (blocks.length > 0) {
        const header = [
          '[Watched workspace files - live context read fresh from disk. Treat these as the authoritative current contents of the named files.]',
          skipped > 0 ? `(${skipped} pinned file(s) skipped: unavailable or over the context budget.)` : ''
        ].filter(Boolean).join('\n');
        outboundContent = `${header}\n\n${blocks.join('\n\n')}\n\n${outboundContent}`;
      }
    }

    // Config Vault: cited RAG over the user's own config folder. Fully local
    // (Ollama embeddings), so it is allowed even under Go Dark. Retrieves the
    // most relevant config chunks for this message and folds them in with their
    // file:line citations so the model can ground its answer and cite sources.
    if (configVaultEnabled && configVaultStatus && configVaultStatus.chunkCount > 0) {
      try {
        setStatusText('Searching your config vault...');
        const vr = await api('/api/vault/query', { method: 'POST', body: JSON.stringify({ query: content, limit: 4 }) });
        const results = Array.isArray(vr?.results) ? vr.results : [];
        if (results.length > 0) {
          const context = results
            .map((r) => `[${r.citation}]\n${r.snippet}`)
            .join('\n\n');
          outboundContent = [
            '[Config Vault - cited excerpts retrieved locally from your own config files. Treat as authoritative; cite the exact file:line label in square brackets when you use one.]',
            '',
            context,
            '',
            outboundContent
          ].join('\n');
        }
      } catch {
        /* vault retrieval is best-effort - never block a send */
      } finally {
        setStatusText('Streaming response...');
      }
    }

    const resolvedProvider = await resolveProviderForSend();

    setStatusText('Streaming response...');

    let chatId = activeChatId;
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
      await refreshChats();
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
        const details = await response.text().catch(() => 'Failed request');
        throw new Error(details || `Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf8');
      let buffer = '';
      refreshStallWatchdog();

      // Coalesce streamed tokens: buffer incoming tokens and flush at most once per
      // animation frame. Previously every token did its own setMessages, which
      // re-parsed the whole (growing) message through Markdown + Prism on each
      // token - O(n^2) for long answers. One flush per frame keeps rendering smooth.
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
      // rAF renders smoothly in-focus; the setTimeout fallback keeps output flowing
      // when the window is backgrounded (rAF is throttled/paused there), so a long
      // local generation never looks frozen while the user is in another app.
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

      // Live during-stream progress in the status line: real generated-token count,
      // elapsed seconds, and rolling tok/s (replaces the faked "Thinking…" ladder).
      // Before the first token it shows a genuine "loading" state, not a wall-clock guess.
      let liveTokenCount = 0;
      let liveFirstTokenTs = null;
      liveProgressTimer = setInterval(() => {
        if (liveFirstTokenTs == null) { setStatusText('Loading model / prefilling…'); return; }
        const elapsed = (Date.now() - liveFirstTokenTs) / 1000;
        const tps = elapsed > 0 ? liveTokenCount / elapsed : 0;
        setStatusText(`${liveTokenCount.toLocaleString()} tok · ${tps >= 10 ? tps.toFixed(0) : tps.toFixed(1)} tok/s · ${elapsed.toFixed(0)}s`);
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
            // OOM auto-retry (or similar) reduced the runtime settings; surface it.
            setStatusText(payload.message);
          }

          if (event === 'error') {
            cancelTokenFlush();
            throw new Error(payload.error || 'Streaming error');
          }

          if (event === 'done') {
            // The full message supersedes any buffered tokens; drop the pending
            // flush so a late frame can't append stale tokens after finalization.
            cancelTokenFlush();
            playReceive(); // ICQ "message received" two-tone cue
            setMessages((prev) => {
              const next = [...prev];
              if (next.length > 0) {
                next[next.length - 1] = payload.message;
              }
              return next;
            });
            // Voice chat drives its own TTS via the loop; skip auto-speak there
            // so the reply is not spoken twice.
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

      // refreshChats() intentionally removed from the stream success path.
      // New chats are already in the sidebar (added before streaming started).
      // Titles are updated via the 'titleUpdate' SSE event during the stream.
      // Calling refreshChats() here was the second failure path for the
      // "clear all → chats come back" bug: if the stream finished just after
      // clearAllChats(), this call would return the backend-saved chat and
      // overwrite the just-emptied chats list.
      if (trainingMode === 'fine-tuning') {
        await refreshTrainingStats();
      }
      if (stallTimer) clearTimeout(stallTimer);
      setStatusText('Ready');
    } catch (error) {
      if (stallTimer) clearTimeout(stallTimer);
      if (error?.name === 'AbortError') {
        if (stalledByWatchdog) {
          setStatusText('Stream timed out. Try a smaller model or shorter prompt.');
          setMessages((prev) => {
            const next = [...prev];
            if (next.length > 0 && next[next.length - 1].role === 'assistant' && !next[next.length - 1].content) {
              next[next.length - 1] = {
                ...next[next.length - 1],
                content: 'Error: the stream went quiet with no output for a long time and was stopped. The model may not be running. Try again, or pick a smaller model.'
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
        setStatusText(`Error: ${error.message}`);
        playError(); // ICQ error cue
        setMessages((prev) => {
          const next = [...prev];
          if (next.length > 0 && next[next.length - 1].role === 'assistant' && !next[next.length - 1].content) {
            next[next.length - 1] = {
              ...next[next.length - 1],
              content: `Error: ${error.message}`
            };
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

  // Always keep shortcut ref in sync with latest handlers (avoids stale closure
  // in the Aurora shell CustomEvent listeners).
  shortcutRef.current.createChat = createChat;
  shortcutRef.current.loadChat = loadChat;

  return (
    <main className="relative h-screen w-screen p-3 sm:p-6">
      <div className="mx-auto flex h-full max-w-7xl gap-3 rounded-3xl border border-[var(--panel-border)] bg-[var(--panel)] p-3 shadow-[0_24px_90px_-36px_rgba(15,23,42,0.45)] backdrop-blur-xl sm:gap-5 sm:p-5">
        <aside className={`flex shrink-0 flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--panel-border)] bg-[var(--material-thin)] p-2 sm:p-4 transition-all duration-200 ${sidebarOpen ? 'w-28 sm:w-72' : 'hidden'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="icq-mark" title="ICQ logo">
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

          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => createChat()}
              className="rounded-full bg-accent px-2 py-1.5 text-xs font-semibold text-white shadow-[0_6px_14px_-8px_rgba(26,168,111,0.9)] transition hover:brightness-95"
            >
              New Chat
            </button>
            <button
              onClick={deleteLastChat}
              disabled={chats.length === 0}
              className="rounded-full border border-[var(--hairline)] px-2 py-1.5 text-xs font-semibold text-[color:var(--text-main)] transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-[var(--material-thin)]"
              title={activeChatId ? 'Delete current chat' : 'Delete most recent chat'}
            >
              Delete
            </button>
            <button
              onClick={clearAllChats}
              disabled={chats.length === 0}
              className="rounded-full border border-red-400/55 px-2 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-400/35 dark:text-red-300 dark:hover:bg-red-950/30"
            >
              Clear All
            </button>
          </div>

          {isSystemPromptVisible && (
          <div className="rounded-[var(--r-lg)] border border-[var(--hairline)] bg-[var(--material-thin)] p-3 shadow-[0_10px_24px_-18px_rgba(15,23,42,0.25)]">
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--text-main)]">
                  Assistant
                </div>
                <div className="text-[10px] text-[color:var(--text-muted)]">
                  {selectedPromptProfile?.description || (selectedPromptProfileId === UNSAVED_PROMPT_PROFILE_ID ? 'Custom for this chat' : 'Preset active')}
                </div>
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

              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-[color:var(--text-muted)]">
                <span className="truncate">{selectedPromptProfile?.label || 'Current custom prompt'}</span>
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

              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--text-muted)]">
                Prompt
              </div>
              <textarea
                value={systemPrompt}
                onChange={(event) => handleSystemPromptChange(event.target.value)}
                rows={4}
                className="w-full rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] px-3 py-2.5 text-[12px] leading-relaxed text-[color:var(--text-main)] outline-none transition focus:border-accent dark:text-[color:var(--text-main)]"
              />
            </div>
          </div>
          )}

          <div className="mb-2 mt-2">
            <input
              type="text"
              autoComplete="off"
              placeholder="Search chats…"
              value={chatSearch}
              onChange={(e) => setChatSearch(e.target.value)}
              className="w-full rounded-xl border border-[var(--hairline)] bg-[var(--material-thin)] px-2.5 py-1.5 text-xs outline-none placeholder:text-[color:var(--text-muted)] focus:border-accent dark:placeholder:text-[color:var(--text-muted)]"
            />
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
                  {chatSearch.trim() ? 'No chats match your search.' : 'No chats yet.'}
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
                Drop files to attach
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
                <p role="status" aria-live="polite" aria-atomic="true" className="shrink-0 font-mono text-xs text-[color:var(--text-muted)]">{statusText}</p>

                {/* hardware chips - one per logic/memory/compute/npu, live utilization + per-chip popover.
                    No overflow wrapper: it would clip each chip's absolute popover. The chips are
                    compact (CPU % / RAM % / GPU / NPU) so they fit the row without scrolling. */}
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
                          onClick={() => {
                            setIsContextPanelOpen(false);
                            setIsEngineMenuOpen(false);
                            setIsVoiceMenuOpen(false);
                            setOpenHardwarePopover((current) => (current === key ? null : key));
                          }}
                          className={`relative inline-flex items-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)] ${
                            isActive
                              ? 'border-green-400/60 bg-green-50/80 text-green-700 dark:border-green-500/40 dark:bg-green-900/20 dark:text-green-400'
                              : 'border-black/10 bg-[var(--material-thin)] text-[color:var(--text-muted)]'
                          }`}
                          title={item.label}
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
                          <div data-menu-panel={`hardware-${key}`} role="menu" tabIndex={-1} className="absolute left-0 top-full z-20 mt-2 w-72 rounded-xl border border-[var(--hairline)] au-chrome au-elev-2 p-2 text-[11px] text-[color:var(--text-muted)]">
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

              {/* RIGHT zone: contextual actions + Prompt + Context */}
              <div className="flex shrink-0 items-center gap-1.5">
                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={runCommitmentRadar}
                    disabled={radarLoading}
                    title="Commitment Radar - scan this conversation for commitments, asks, and decisions without saving anything"
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
                    title="Commit this conversation to IntelLedger - extract signals, actions, and decisions, then open the session"
                    className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent transition hover:bg-accent/20 disabled:opacity-50 dark:border-accent/30 dark:bg-accent/15 dark:hover:bg-accent/25"
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M9 12h6M12 9v6"/>
                    </svg>
                    {isCommittingToLedger ? 'Committing…' : 'To Ledger'}
                  </button>
                )}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsSystemPromptVisible((v) => !v)}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide transition ${
                      isSystemPromptVisible
                        ? 'border-accent/60 bg-accentSoft text-ink dark:border-accent/40 dark:bg-accent/20 dark:text-green-300'
                        : 'border-black/10 bg-[var(--material-thin)] text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                    }`}
                    title="Toggle instructions visibility"
                  >
                    <span>Prompt</span>
                  </button>
                </div>
                <div data-menu-container="true" className="relative">
                  <button
                    type="button"
                    data-menu-trigger="context"
                    onClick={() => {
                      setIsEngineMenuOpen(false);
                      setOpenHardwarePopover(null);
                      setIsVoiceMenuOpen(false);
                      setIsContextPanelOpen((prev) => !prev);
                    }}
                    className="inline-flex items-center justify-center rounded-full border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-0.5 text-[11px] font-medium tracking-wide text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                    title={`Context usage: ${contextUsage.totalTokens.toLocaleString()} / ${contextUsage.windowTokens.toLocaleString()} tokens`}
                  >
                    Context {contextUsage.usedPct}%
                  </button>

                  {isContextPanelOpen && (
                    <div data-menu-panel="context" role="menu" tabIndex={-1} className="absolute right-0 top-full z-20 mt-2 w-72 rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] p-2 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-[color:var(--text-main)]">Token Limit</span>
                        <span className="text-[10px] text-[color:var(--text-muted)]">{contextUsage.usedPct}% used</span>
                      </div>

                      <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-[var(--material-thin)]">
                        <div
                          className="h-full rounded-full bg-accent transition-all duration-300"
                          style={{ width: `${Math.min(contextUsage.usedPct, 100)}%` }}
                        />
                      </div>

                      <div className="space-y-1 text-[11px] text-[color:var(--text-main)]">
                        <div className="flex items-center justify-between rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1">
                          <span>System instructions</span>
                          <span>{contextUsage.systemPct}% · {contextUsage.systemTokens.toLocaleString()} tok</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1">
                          <span>User content</span>
                          <span>{contextUsage.userPct}% · {contextUsage.userTokens.toLocaleString()} tok</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1">
                          <span>Assistant</span>
                          <span>{contextUsage.uncategorizedPct}% · {contextUsage.uncategorizedTokens.toLocaleString()} tok</span>
                        </div>
                      </div>

                      <div className="mt-2 text-[10px] text-[color:var(--text-muted)]">
                        {contextUsage.totalTokens.toLocaleString()} / {contextUsage.windowTokens.toLocaleString()} tokens
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {remoteUsage.enabled && (
              <div className="mt-1.5 rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1.5">
                <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-mono text-[color:var(--text-muted)]">
                  <span>{provider} est. {formatUsdEstimate(remoteUsage.estUsd)} / ${remoteUsage.budgetUsd.toFixed(2)}</span>
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
                <span>Off the Record - this chat is never written to disk and disappears when you quit Mirabilis.</span>
              </div>
            )}
            {activeChatId && (
              <section className="rounded-2xl border border-[var(--hairline)] bg-[var(--material-thin)] p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-[color:var(--text-main)]">Branching & Snapshots</h3>
                    <p className="text-[11px] text-[color:var(--text-muted)]">
                      {activeChatMeta?.parentChatId
                        ? `Branch chat${activeChatMeta?.branchLabel ? ` · ${activeChatMeta.branchLabel}` : ''}`
                        : 'Create a branch before experimenting, or save a restore point first.'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => branchChat(activeChatId)}
                      className="rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] px-3 py-1.5 text-[11px] font-semibold text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                    >
                      Branch Chat
                    </button>
                    <button
                      type="button"
                      onClick={saveSnapshot}
                      className="rounded-xl bg-accent px-3 py-1.5 text-[11px] font-semibold text-white shadow-[0_10px_24px_-14px_rgba(26,168,111,0.9)] transition hover:brightness-95"
                    >
                      Save Snapshot
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <select
                    value={selectedSnapshotId}
                    onChange={(event) => setSelectedSnapshotId(event.target.value)}
                    disabled={!Array.isArray(activeChatMeta?.snapshots) || activeChatMeta.snapshots.length === 0}
                    className="min-w-0 flex-1 rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] px-3 py-2 text-xs outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {Array.isArray(activeChatMeta?.snapshots) && activeChatMeta.snapshots.length > 0 ? (
                      [...activeChatMeta.snapshots].reverse().map((snapshot) => (
                        <option key={snapshot.id} value={snapshot.id}>
                          {snapshot.label} · {snapshot.messageCount} msgs
                        </option>
                      ))
                    ) : (
                      <option value="">No snapshots yet</option>
                    )}
                  </select>
                  <button
                    type="button"
                    onClick={restoreSnapshot}
                    disabled={!selectedSnapshotId}
                    className="rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] px-3 py-2 text-[11px] font-semibold text-[color:var(--text-main)] transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-[var(--material-thin)]"
                  >
                    Restore Snapshot
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
                  placeholder="Draft ideas, prompts, or notes here..."
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
                  {activeChatId ? 'New Conversation' : 'Welcome to Mirabilis AI'}
                </h2>
                <p className="max-w-md text-[length:var(--text-md)] leading-relaxed text-[color:var(--text-muted)]">
                  {activeChatId ? 'Type a message below to get started.' : 'See who is online in the flower, pick a model in the bar, and start talking.'}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {!activeChatId && (
                    <button
                      type="button"
                      onClick={createChat}
                      className="au-focus rounded-[var(--r-lg)] px-5 py-2.5 text-[length:var(--text-sm)] font-semibold text-white shadow-[var(--shadow-2)] transition hover:brightness-110 active:scale-[0.98]"
                      style={{ background: 'var(--accent)' }}
                    >
                      Start a chat
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

            {messages.map((message, idx) => (
              <MessageRow
                key={message.id}
                message={message}
                isLast={idx === messages.length - 1}
                isStreaming={isStreaming}
                streamingLabel={streamingLabel}
                speakingMessageId={speakingMessageId}
                isSpeaking={isSpeaking}
                voiceEngine={voiceEngine}
                voiceSupported={voiceSupported}
                remoteConnectedRef={remoteConnectedRef}
                remoteTargetRef={remoteTargetRef}
                execResultsRef={execResultsRef}
                runCommand={runCommand}
                stopSpeaking={stopSpeaking}
                speakText={speakText}
                regenerate={regenerate}
              />
            ))}
            </div>
          </div>

          {isTeachPanelOpen && (
            <section className="mt-3 rounded-2xl border border-[var(--hairline)] bg-[var(--material-thin)] p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Personal Memory</h3>
                <button
                  type="button"
                  onClick={() => setIsTeachPanelOpen(false)}
                  className="rounded-md border border-[var(--hairline)] px-2 py-1 text-[11px] text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                >
                  Close
                </button>
              </div>
              <p className="mb-2 text-[11px] text-[color:var(--text-muted)]">
                These notes are injected as context into every conversation when memory is enabled.
              </p>
              <div className="mb-2 flex gap-2">
                <input
                  type="text"
                  value={memoryInput}
                  onChange={(e) => setMemoryInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMemoryItem(); } }}
                  placeholder="Add a memory (e.g. I prefer concise answers)"
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
                <p className="text-[11px] text-[color:var(--text-muted)]">No memories yet.</p>
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
                      >✕</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <footer className="mt-3 border-t border-black/10 pt-3">
            {/* ROW 1: slim toolbar. Left: model, effort, options. Right: status + tokens. */}
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Model unit: provider and model triggers read as one pill */}
                <div className="flex items-center gap-0.5 rounded-[var(--r-md)] au-hairline au-material px-0.5">
                <div data-menu-container="true" className="relative flex items-center gap-1">
                <div data-menu-container="true" className="relative">
                  <button
                    type="button"
                    data-menu-trigger="provider"
                    onClick={() => {
                      setIsModelMenuOpen(false);
                      setIsTrainingMenuOpen(false);
                      setIsToolsMenuOpen(false);
                      setIsControlPanelOpen(false);
                      setIsMcpPanelOpen(false);
                      setOpenHardwarePopover(null);
                      setIsEngineMenuOpen(false);
                      setIsVoiceMenuOpen(false);
                      setIsContextPanelOpen(false);
                      setProviderSearch('');
                      setIsProviderMenuOpen((prev) => !prev);
                      setIsProviderConfigOpen(false);
                      if (installingBinary?.done) setInstallingBinary(null);
                    }}
                    className="inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-main)] transition hover:bg-[color:var(--hairline)]"
                    title="Choose provider"
                  >
                    <span className="max-w-[9rem] truncate">{PROVIDER_OPTIONS.find((opt) => opt.id === provider)?.label || provider}</span>
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                      <path d="M5.25 7.5L10 12.25 14.75 7.5" />
                    </svg>
                  </button>

                  {isProviderMenuOpen && (
                    <div data-menu-panel="provider" role="menu" tabIndex={-1} className="absolute bottom-9 left-0 z-20 flex max-h-[min(70vh,460px)] w-72 flex-col overflow-hidden rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
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
                          placeholder="Search providers..."
                          className="au-focus w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1.5 text-xs text-[color:var(--text-main)] outline-none placeholder:text-[color:var(--text-muted)]"
                        />
                      </div>
                      {/* Grouped, scrollable list - capped height so the top is never off-screen */}
                      <div className="min-h-0 flex-1 overflow-y-auto p-1">
                        {(() => {
                          const q = providerSearch.trim().toLowerCase();
                          // vLLM is grouped by intent: "Local" until you point it at a
                          // remote server URL, then it moves to "Remote". (On Apple Silicon
                          // local vLLM can't actually launch - the config panel explains
                          // that and offers llama.cpp/MLX or a remote URL instead.)
                          const vllmHasRemote = !!String(providerConfigs?.vllm?.baseUrl || '').trim();
                          const effGroup = (o) => (o.id === 'vllm' ? (vllmHasRemote ? 'Remote' : 'Local') : o.group);
                          const groups = PROVIDER_GROUPS
                            .map((g) => ({ group: g, items: PROVIDER_OPTIONS.filter((o) => effGroup(o) === g && (!q || o.label.toLowerCase().includes(q) || o.id.includes(q))) }))
                            .filter((g) => g.items.length);
                          if (!groups.length) {
                            return <div className="px-2 py-3 text-center text-[11px] text-[color:var(--text-muted)]">No providers match "{providerSearch}"</div>;
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
                                        setStatusText(`Provider: ${opt.label} (${opt.scope})`);
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
                                        <span className="text-[10px] opacity-60">{binaryMissing ? 'Not installed' : opt.id === 'vllm' ? (vllmHasRemote ? 'Remote server' : 'Local (or set a remote URL)') : opt.scope}</span>
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
                                        {isInstalling ? 'Installing…' : 'Install'}
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
                                        title="Uninstall binary"
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
                          <span className="opacity-60">...</span>
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
                        <button type="button" onClick={() => setInstallingBinary(null)} className="text-[10px] text-[color:var(--text-muted)] hover:text-[color:var(--text-main)] dark:hover:text-slate-200">✕</button>
                      )}
                    </div>
                    <div className="max-h-32 overflow-y-auto space-y-0.5">
                      {installingBinary.lines.map((line, i) => (
                        <p key={i} className={`text-[11px] ${line.type === 'error' ? 'text-red-500' : line.type === 'done' ? 'text-green-500' : line.type === 'warn' ? 'text-yellow-500' : 'text-[color:var(--text-main)]'}`}>
                          {line.text}
                        </p>
                      ))}
                      {!installingBinary.done && <p className="text-[11px] text-[color:var(--text-muted)] animate-pulse">…</p>}
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
                        ⚠ KoboldCpp is a <strong>separate app</strong> you must install &amp; run on your machine. It is not included in Mirabilis. Once running, enter its URL below.
                      </p>
                    )}
                    {provider === 'llamacpp' && (
                      <div className="mb-2 rounded-lg border border-[var(--hairline)] p-2">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">llama.cpp engine (local, Metal)</span>
                          <span className={`text-[10px] font-medium ${llamacppStatus?.running ? 'text-emerald-600 dark:text-emerald-300' : llamacppStatus?.installed ? 'text-amber-600 dark:text-amber-300' : 'text-[color:var(--text-muted)]'}`}>
                            {llamacppStatus?.running ? 'Running' : llamacppStatus?.installed ? 'Ready to launch' : 'Not installed'}
                          </span>
                        </div>
                        {!llamacppStatus?.installed ? (
                          <p className="text-[10px] leading-relaxed text-[color:var(--text-muted)]">
                            llama.cpp runs your models locally with no Ollama needed. Install it with <code className="rounded bg-black/5 px-1 dark:bg-white/10">brew install llama.cpp</code>, then reopen this panel.
                          </p>
                        ) : llamacppStatus?.running ? (
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-[11px] text-[color:var(--text-main)]">{llamacppStatus.model} @ {llamacppStatus.baseUrl}</span>
                            <button type="button" onClick={stopLlamacpp} disabled={isLlamacppBusy} className="shrink-0 rounded-lg border border-[var(--hairline)] px-2 py-1 text-[11px] font-medium text-red-500 transition hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-900/20">
                              {isLlamacppBusy ? '…' : 'Stop'}
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            {llamacppLaunchable.length > 0 ? (
                              <select
                                value={llamacppModel}
                                onChange={(e) => setLlamacppModel(e.target.value)}
                                className="au-focus w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1 text-[11px] text-[color:var(--text-main)] outline-none"
                              >
                                {llamacppLaunchable.map((id) => <option key={id} value={id}>{id}</option>)}
                              </select>
                            ) : (
                              <input
                                type="text"
                                value={llamacppModel}
                                onChange={(e) => setLlamacppModel(e.target.value)}
                                placeholder="Model name or /path/to/model.gguf"
                                className="au-focus w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1 text-[11px] text-[color:var(--text-main)] outline-none placeholder:text-[color:var(--text-muted)]"
                              />
                            )}
                            <button type="button" onClick={startLlamacpp} disabled={isLlamacppBusy || !llamacppModel.trim()} className="w-full rounded-lg bg-accent px-2 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50">
                              {isLlamacppBusy ? 'Starting…' : 'Start llama.cpp with this model'}
                            </button>
                            <p className="text-[10px] leading-relaxed text-[color:var(--text-muted)]">Runs the model file directly with KV-cache quant + flash attention. Your downloaded models are reused - Ollama does not need to be running.</p>
                          </div>
                        )}
                      </div>
                    )}
                    {provider === 'openai-compatible' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        ℹ Point to any OpenAI-compatible local server (LM Studio, llama.cpp, Oobabooga, etc.) or a cloud API that requires a key.
                      </p>
                    )}
                    {provider === 'gpuaas' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        ℹ Use your GPUaaS OpenAI-compatible endpoint URL and key (for example Together, Fireworks, RunPod OpenAI proxy, vLLM gateway).
                      </p>
                    )}
                    {provider === 'vllm' && (
                      <div className="mb-2 rounded-lg border border-[var(--hairline)] p-2">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Local vLLM (NVIDIA GPU)</span>
                          <span className={`text-[10px] font-medium ${vllmStatus?.running ? 'text-emerald-600 dark:text-emerald-300' : vllmStatus?.canRunLocal ? 'text-amber-600 dark:text-amber-300' : 'text-[color:var(--text-muted)]'}`}>
                            {vllmStatus?.running ? 'Running' : vllmStatus?.canRunLocal ? 'Ready to launch' : 'Not available here'}
                          </span>
                        </div>
                        {vllmStatus?.canRunLocal ? (
                          vllmStatus?.running ? (
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate text-[11px] text-[color:var(--text-main)]">{vllmStatus.model} @ {vllmStatus.baseUrl}</span>
                              <button type="button" onClick={stopLocalVllm} disabled={isVllmBusy} className="shrink-0 rounded-lg border border-[var(--hairline)] px-2 py-1 text-[11px] font-medium text-red-500 transition hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-900/20">
                                {isVllmBusy ? '…' : 'Stop'}
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                value={vllmLocalModel}
                                onChange={(e) => setVllmLocalModel(e.target.value)}
                                placeholder="Hugging Face id, e.g. Qwen/Qwen2.5-7B-Instruct"
                                className="au-focus min-w-0 flex-1 rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1 text-[11px] text-[color:var(--text-main)] outline-none placeholder:text-[color:var(--text-muted)]"
                              />
                              <button type="button" onClick={startLocalVllm} disabled={isVllmBusy || !vllmLocalModel.trim()} className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50">
                                {isVllmBusy ? 'Starting…' : 'Start'}
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
                    {provider === 'vllm' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        ℹ Or connect to a <strong>remote vLLM server</strong>: enter its URL below (e.g. <code>http://gpu-host:8000/v1</code>). Models load from that server automatically. Key optional.
                      </p>
                    )}
                    {provider === 'openai' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        ℹ OpenAI uses https://api.openai.com/v1 and requires an API key.
                      </p>
                    )}
                    {provider === 'grok' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        ℹ Grok uses xAI API at https://api.x.ai/v1 and requires an API key.
                      </p>
                    )}
                    {provider === 'groq' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        ℹ Groq uses https://api.groq.com/openai/v1 and requires an API key.
                      </p>
                    )}
                    {provider === 'openrouter' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        ℹ OpenRouter uses https://openrouter.ai/api/v1 and requires an API key.
                      </p>
                    )}
                    {provider === 'gemini' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        ℹ Gemini uses Google AI OpenAI endpoint at https://generativelanguage.googleapis.com/v1beta/openai and requires an API key.
                      </p>
                    )}
                    {provider === 'cerebras' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        ℹ Cerebras uses https://api.cerebras.ai/v1 and requires an API key (csk-…). Free tier available.
                      </p>
                    )}
                    {provider === 'claude' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        ℹ Claude uses Anthropic API at https://api.anthropic.com and requires an API key.
                      </p>
                    )}
                    <label className="mb-1 block text-[11px] text-[color:var(--text-muted)]">Base URL</label>
                    <input
                      type="text"
                      className="mb-2 w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1 text-xs text-[color:var(--text-main)] outline-none focus:ring-1 focus:ring-accentSoft dark:text-[color:var(--text-main)]"
                      placeholder={provider === 'koboldcpp' ? 'http://127.0.0.1:5001/v1' : provider === 'openai' ? 'https://api.openai.com/v1' : provider === 'grok' ? 'https://api.x.ai/v1' : provider === 'groq' ? 'https://api.groq.com/openai/v1' : provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai' : provider === 'cerebras' ? 'https://api.cerebras.ai/v1' : provider === 'claude' ? 'https://api.anthropic.com' : provider === 'gpuaas' ? 'https://your-gpuaas-endpoint.example/v1' : provider === 'vllm' ? 'http://gpu-host:8000/v1' : 'http://127.0.0.1:1234/v1'}
                      value={providerConfigs[provider]?.baseUrl || ''}
                      onChange={(e) => setProviderConfigs((prev) => ({ ...prev, [provider]: { ...prev[provider], baseUrl: e.target.value } }))}
                    />
                    {(provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas' || provider === 'openai-compatible' || provider === 'vllm') && (
                      <>
                        <label className="mb-1 block text-[11px] text-[color:var(--text-muted)]">API Key <span className="opacity-60">{provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas' ? '(required)' : '(leave empty for local servers)'}</span></label>
                        <div className="mb-2 flex gap-1">
                          <input
                            type="password"
                            className="min-w-0 flex-1 rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1 text-xs text-[color:var(--text-main)] outline-none focus:ring-1 focus:ring-accentSoft dark:text-[color:var(--text-main)]"
                            placeholder={provider === 'openai' ? 'sk-... (required)' : provider === 'grok' ? 'xai-... (required)' : provider === 'groq' ? 'gsk_... (required)' : provider === 'openrouter' ? 'sk-or-... (required)' : provider === 'gemini' ? 'AIza... (required)' : provider === 'cerebras' ? 'csk-... (required)' : provider === 'claude' ? 'sk-ant-... (required)' : provider === 'gpuaas' ? 'provider key (required)' : 'sk-... (optional for local)'}
                            value={providerConfigs[provider]?.apiKey || ''}
                            onChange={(e) => setProviderConfigs((prev) => ({ ...prev, [provider]: { ...prev[provider], apiKey: e.target.value } }))}
                          />
                          {providerConfigs[provider]?.apiKey ? (
                            <button
                              type="button"
                              title="Clear API key"
                              onClick={() => setProviderConfigs((prev) => ({ ...prev, [provider]: { ...prev[provider], apiKey: '' } }))}
                              className="flex-shrink-0 rounded-lg border border-[var(--hairline)] px-2 py-1 text-xs text-[color:var(--text-muted)] transition hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:text-[color:var(--text-muted)] dark:hover:border-red-500/40 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                            >
                              Clear
                            </button>
                          ) : null}
                        </div>
                      </>
                    )}
                    {(provider === 'openai' || provider === 'grok' || provider === 'groq' || provider === 'openrouter' || provider === 'gemini' || provider === 'cerebras' || provider === 'claude' || provider === 'gpuaas') && (
                      <>
                        <label className="mb-1 block text-[11px] text-[color:var(--text-muted)]">Estimated Monthly Budget (USD)</label>
                        <input
                          type="number"
                          min="1"
                          step="1"
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
                        onClick={() => { setProvider('ollama'); setIsProviderConfigOpen(false); setStatusText('Switched back to Ollama'); }}
                        className="flex-1 rounded-lg border border-[var(--hairline)] px-2 py-1 text-xs text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                      >
                        ← Back to Ollama
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
                    onClick={() => { setIsProviderMenuOpen(false); setIsTrainingMenuOpen(false); setIsToolsMenuOpen(false); setIsControlPanelOpen(false); setIsMcpPanelOpen(false); setOpenHardwarePopover(null); setIsEngineMenuOpen(false); setIsVoiceMenuOpen(false); setIsModelMenuOpen((prev) => !prev); }}
                    className="inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-main)] transition hover:bg-[color:var(--hairline)]"
                    title="Choose model"
                  >
                    <span className="max-w-[9rem] truncate">
                        {model === 'auto' ? 'Auto' : (selectedModelRecord?.label || model)}
                      </span>
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                      <path d="M5.25 7.5L10 12.25 14.75 7.5" />
                    </svg>
                  </button>

                  {isModelMenuOpen && (
                  <div data-menu-panel="model" role="menu" tabIndex={-1} className="absolute bottom-9 left-0 z-20 max-h-96 w-80 overflow-y-auto rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] p-1 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
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
                              {pickBestAutoModel(models) ? `→ ${pickBestAutoModel(models).label}` : 'no model installed'}
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
                                const isDeleting = deletingModels[item.id];
                                const isSelected = item.id === model;
                                const isInstalled = item.available !== false;
                                const canDelete = isInstalled && provider === 'ollama' && !pulling && !isDeleting;
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
                                        setStatusText(`${plabel} loads a GGUF at launch and cannot pull models. Drop a .gguf into mirabilis/models, or start ${plabel} with your model, then it will appear here.`);
                                      }
                                    } else if (isInstalled) {
                                      if (provider === 'ollama') {
                                        setModel(item.id);
                                        setIsModelMenuOpen(false);
                                      } else {
                                        setStatusText(`Switching ${provider} model...`);
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
                                            setStatusText(`Active model: ${item.label}`);
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
                                        {pulling.pct !== null ? `${pulling.pct}%` : '…'}
                                      </span>
                                      <span
                                        role="button"
                                        tabIndex={0}
                                        onClick={(e) => { e.stopPropagation(); cancelInstall(item.id); }}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); cancelInstall(item.id); } }}
                                        className="ml-0.5 cursor-pointer rounded px-1 text-[10px] text-red-400 hover:text-red-600"
                                        title="Cancel install"
                                      >✕</span>
                                    </div>
                                  ) : (
                                    <span className="ml-2 flex shrink-0 items-center gap-1.5 text-[10px] text-[color:var(--text-muted)]">
                                      {provider === 'ollama' ? (() => {
                                        const fit = computeModelFit(item, deviceRamGb);
                                        if (!fit) return null;
                                        const tone = fit.tier === 'fits'
                                          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                                          : fit.tier === 'tight'
                                            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                                            : 'bg-rose-500/15 text-rose-600 dark:text-rose-300';
                                        return (
                                          <span title={fit.title} className={`inline-flex items-center rounded-[var(--r-pill)] px-1.5 py-[1px] font-semibold ${tone}`}>
                                            {fit.label}
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
                                {canDelete && (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); deleteModel(item.ollamaId || item.id, item.id); }}
                                    className="ml-0.5 shrink-0 rounded p-1 text-[10px] text-slate-300 opacity-0 transition hover:text-red-500 group-hover/row:opacity-100 dark:text-[color:var(--text-main)] dark:hover:text-red-400"
                                    title={`Remove ${item.label} to free space`}
                                  >✕</button>
                                )}
                                {isDeleting && (
                                  <span className="ml-1 shrink-0 animate-pulse text-[10px] text-red-400">…</span>
                                )}
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
                                No model running yet. Open the llama.cpp config to pick one of your models and start it locally.
                                <button type="button" onClick={openConfig} className="mt-2 block w-full rounded-lg bg-accent px-2 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110">
                                  Configure llama.cpp
                                </button>
                              </div>
                            );
                          }
                          if (endpointProviders.includes(provider) && !hasBaseUrl) {
                            return (
                              <div className="px-2 py-3 text-[11px] leading-relaxed text-[color:var(--text-muted)]">
                                {provider === 'vllm'
                                  ? 'No vLLM server connected. Start a local vLLM (NVIDIA GPU) or enter a remote server URL - then this list fills with that server\'s models.'
                                  : 'No server connected. Set the endpoint URL - then this list fills with its models.'}
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
                          return <div className="px-2 py-2 text-xs text-[color:var(--text-muted)]">No models found</div>;
                        })()
                      )}

                    {/* Pull any model not in the list (Ollama mode) - reuses the
                        existing install-job pipeline via installModel(). */}
                    {provider === 'ollama' && (
                      <div className="mt-1 border-t border-black/10 px-2 py-2">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Add any model</div>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={customModelInput}
                            onChange={(e) => setCustomModelInput(e.target.value)}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                const name = customModelInput.trim();
                                if (name) { installModel(name, name); setCustomModelInput(''); }
                              }
                            }}
                            placeholder="e.g. llama3.2, qwen2.5:7b"
                            className="au-focus min-w-0 flex-1 rounded-[var(--r-md)] border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1.5 text-[11px] text-[color:var(--text-main)] outline-none placeholder:text-[color:var(--text-muted)]"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const name = customModelInput.trim();
                              if (name) { installModel(name, name); setCustomModelInput(''); }
                            }}
                            disabled={!customModelInput.trim() || !!pullingModels[customModelInput.trim()]}
                            className="shrink-0 rounded-[var(--r-md)] px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
                            style={{ background: 'var(--accent)' }}
                          >
                            Pull
                          </button>
                        </div>
                        <a
                          href="https://ollama.com/library"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1.5 inline-block text-[10px] text-[color:var(--text-muted)] underline decoration-[var(--hairline)] underline-offset-2 hover:text-accent"
                        >
                          Browse the Ollama model library ↗
                        </a>
                      </div>
                    )}

                    {/* KoboldCpp / custom-endpoint runtimes load one GGUF at launch and
                        cannot pull models on demand. Explain how to get a model in,
                        instead of showing a dead "install" row. */}
                    {(provider === 'koboldcpp' || provider === 'openai-compatible') && (
                      <div className="mt-1 border-t border-black/10 px-2 py-2">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Loading a model</div>
                        <p className="text-[10px] leading-relaxed text-[color:var(--text-muted)]">
                          This runtime loads a single GGUF at launch. Drop a <code className="rounded bg-black/5 px-1 dark:bg-white/10">.gguf</code> file into <code className="rounded bg-black/5 px-1 dark:bg-white/10">mirabilis/models</code> and it appears above, or start the server pointed at your model. Only Ollama can download models on demand.
                        </p>
                      </div>
                    )}

                    {/* Generation params at bottom of model menu */}
                    <div className="mt-1 border-t border-black/10 px-2 py-2">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Generation</div>
                      <div className="mb-1.5">
                        <div className="flex items-center justify-between text-[10px] text-[color:var(--text-muted)]">
                          <span className="flex items-center gap-1">
                            Temperature
                            <span title="Controls randomness. 0 = precise and deterministic. 0.7 = balanced (default). 1+ = more creative but less predictable." className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-slate-300 text-[8px] leading-none text-[color:var(--text-muted)] dark:border-slate-600 dark:text-[color:var(--text-muted)]">?</span>
                          </span>
                          <span>{temperature == null ? 'default' : temperature.toFixed(2)}</span>
                        </div>
                        <input
                          type="range"
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
                            Reset to default
                          </button>
                        )}
                      </div>
                      <div>
                        <div className="mb-0.5 flex items-center gap-1 text-[10px] text-[color:var(--text-muted)]">
                          Max tokens
                          <span title="Hard cap on reply length. Leave blank to let the model stop naturally. Set a number (e.g. 512) to limit response length." className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-slate-300 text-[8px] leading-none text-[color:var(--text-muted)] dark:border-slate-600 dark:text-[color:var(--text-muted)]">?</span>
                        </div>
                        <input
                          type="number"
                          min="1"
                          max="131072"
                          placeholder="provider default"
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
                              <span className="flex items-center gap-1">Top-p<span title="Nucleus sampling. Lower keeps word choice focused; 1 considers all. Leave default unless you know you need it." className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-slate-300 text-[8px] leading-none dark:border-slate-600">?</span></span>
                              <span>{ollamaParams.top_p == null ? 'default' : Number(ollamaParams.top_p).toFixed(2)}</span>
                            </div>
                            <input type="range" min="0" max="1" step="0.05" value={ollamaParams.top_p ?? 0.9} onChange={(e) => setOllamaParams((p) => ({ ...p, top_p: Number(e.target.value) }))} className="mt-0.5 w-full accent-[var(--accent)]" />
                          </div>
                          <div className="mb-1.5">
                            <div className="flex items-center justify-between text-[10px] text-[color:var(--text-muted)]">
                              <span className="flex items-center gap-1">Repeat penalty<span title="Discourages repetition. 1.0 = off; 1.1 to 1.3 reduces loops. Too high hurts fluency." className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-slate-300 text-[8px] leading-none dark:border-slate-600">?</span></span>
                              <span>{ollamaParams.repeat_penalty == null ? 'default' : Number(ollamaParams.repeat_penalty).toFixed(2)}</span>
                            </div>
                            <input type="range" min="0.8" max="2" step="0.05" value={ollamaParams.repeat_penalty ?? 1.1} onChange={(e) => setOllamaParams((p) => ({ ...p, repeat_penalty: Number(e.target.value) }))} className="mt-0.5 w-full accent-[var(--accent)]" />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            {[
                              { key: 'top_k', label: 'Top-k', placeholder: 'default', title: 'Limits choices to the K most likely tokens. Blank = off.', min: 0, max: 500 },
                              { key: 'num_ctx', label: 'Context', placeholder: 'model default', title: 'Context window size in tokens (num_ctx). Larger uses more memory.', min: 256, max: 131072 },
                              { key: 'num_gpu', label: 'GPU layers', placeholder: 'auto', title: 'Layers offloaded to GPU (num_gpu). 0 = CPU only; higher is faster if it fits.', min: 0, max: 512 },
                              { key: 'seed', label: 'Seed', placeholder: 'random', title: 'Fixes the random seed for reproducible output. Blank = random each run.', min: 0, max: 2147483647 }
                            ].map((f) => (
                              <div key={f.key}>
                                <div className="mb-0.5 flex items-center gap-1 text-[10px] text-[color:var(--text-muted)]">{f.label}<span title={f.title} className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-slate-300 text-[8px] leading-none dark:border-slate-600">?</span></div>
                                <input
                                  type="number"
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
                            title="Keep the model resident in memory (Ollama keep_alive: never unload) so replies after a pause don't cold-reload. Uses RAM continuously."
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
                          <p className="mt-1 text-[9px] leading-tight text-[color:var(--text-muted)]">Auto-tuned for your hardware. Fields above override; blank = auto. KV-cache quant is set on the Ollama server.</p>
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
                    onClick={() => { const open = !isEffortMenuOpen; closeAllDropdowns(); setIsEffortMenuOpen(open); }}
                    className="inline-flex h-7 items-center gap-1 rounded-[var(--r-md)] au-hairline au-material px-2.5 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-main)] transition hover:brightness-105"
                    title="Answer effort level"
                  >
                    Effort: {EFFORT_LABELS[effortLevel] || EFFORT_LABELS.balanced}
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                      <path d="M5.25 7.5L10 12.25 14.75 7.5" />
                    </svg>
                  </button>
                  {isEffortMenuOpen && (
                    <div data-menu-panel="effort" role="menu" tabIndex={-1} className="absolute bottom-9 left-0 z-20 min-w-44 rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] p-1 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
                      {[
                        { value: 'instant', label: 'Instant', hint: 'one line' },
                        { value: 'fast', label: 'Fast', hint: 'concise' },
                        { value: 'balanced', label: 'Balanced', hint: 'default' },
                        { value: 'thorough', label: 'Thorough', hint: 'complete' },
                        { value: 'deep', label: 'Deep', hint: 'reason first' }
                      ].map((opt) => (
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
                {/* Direct one-click Uncensored toggle. No menu: a single click flips it.
                    Uncensored is a pure on/off, so it earns a top-level toggle; the
                    other modes stay in Options (MCP needs a server pick, not a toggle). */}
                <button
                  type="button"
                  onClick={toggleUncensoredMode}
                  aria-pressed={uncensoredMode}
                  title={uncensoredMode ? 'Uncensored is on for this chat. Click to turn off.' : 'Uncensored is off. Click to turn on for this chat.'}
                  className={`inline-flex h-7 items-center rounded-[var(--r-md)] px-2.5 text-[length:var(--text-2xs)] font-medium transition hover:brightness-105 ${
                    uncensoredMode
                      ? 'border text-[color:var(--accent)]'
                      : 'au-hairline au-material text-[color:var(--text-main)]'
                  }`}
                  style={uncensoredMode ? { borderColor: 'color-mix(in srgb, var(--accent) 55%, var(--hairline))', background: 'color-mix(in srgb, var(--accent) 12%, transparent)' } : undefined}
                >
                  Uncensored
                </button>
                {/* Direct one-click web-search toggle (the "www" chip). Same chip template
                    as its siblings; on is the default so it stays neutral, and only the
                    off state tints (our danger-rose), matching the Aurora chip look. */}
                <button
                  type="button"
                  onClick={() => setDeepWebEnabled((prev) => !prev)}
                  aria-pressed={deepWebEnabled}
                  title={webSearchStatus === 'error'
                    ? 'Web search failed last time. Click to toggle.'
                    : deepWebEnabled ? 'Web search (www) is on by default. Click to turn it off.' : 'Web search (www) is off. Click to turn it back on.'}
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
                {/* Options dropdown: relocated tools, training, modes, and voice */}
                <div data-menu-container="true" className="relative">
                  <button
                    type="button"
                    data-menu-trigger="options"
                    onClick={() => { const open = !isOptionsMenuOpen; closeAllDropdowns(); setIsOptionsMenuOpen(open); }}
                    className="inline-flex h-7 items-center gap-1.5 rounded-[var(--r-md)] au-hairline au-material px-2.5 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-main)] transition hover:brightness-105"
                    title="Tools, training, modes, and voice"
                  >
                    <SlidersIcon size={13} />
                    Options
                    {optionsActiveCount > 0 && (
                      <span className="ml-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-medium text-white" style={{ background: 'var(--accent)' }}>{optionsActiveCount}</span>
                    )}
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                      <path d="M5.25 7.5L10 12.25 14.75 7.5" />
                    </svg>
                  </button>
                  {isOptionsMenuOpen && (
                    <div data-menu-panel="options" role="menu" tabIndex={-1} className="absolute bottom-9 left-0 z-20 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-[var(--hairline)] bg-[var(--material-thick)] p-1.5 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
                      <div className="px-1 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Tools</div>
                      <button
                        type="button"
                        onClick={handleCreateImageTool}
                        className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                      >
                        <span>Create Image</span>
                        <span className="text-[10px] opacity-70">{imageServiceAvailable ? imageServiceDevice || 'ready' : 'offline'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setDeepWebEnabled((prev) => !prev)}
                        title={webSearchStatus === 'error' ? 'Web search failed - results unavailable' : deepWebEnabled ? 'Web search on' : 'Web search off'}
                        className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                          deepWebEnabled
                            ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                            : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                        }`}
                      >
                        <span>Web search</span>
                        <span className="text-[10px] opacity-70">{webSearchStatus === 'searching' ? 'searching' : webSearchStatus === 'error' ? 'error' : deepWebEnabled ? 'on' : 'off'}</span>
                      </button>

                      <div className="rounded-lg">
                        <button
                          type="button"
                          onClick={() => setConfigVaultEnabled((prev) => !prev)}
                          title="Config Vault: cited local RAG over your own config files. Fully offline, allowed under Go Dark."
                          className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                            configVaultEnabled
                              ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                              : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                          }`}
                        >
                          <span>Config Vault</span>
                          <span className="text-[10px] opacity-70">{(configVaultStatus?.chunkCount || 0) > 0 ? `${configVaultStatus.fileCount} files · ${configVaultEnabled ? 'on' : 'off'}` : (configVaultEnabled ? 'on · not indexed' : 'off')}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsVaultPanelOpen((v) => !v)}
                          className="px-2 pb-1 text-[10px] text-[color:var(--text-muted)] hover:text-[color:var(--text-main)]"
                        >
                          {isVaultPanelOpen ? 'Hide setup' : 'Setup / index a folder'}
                        </button>
                        {isVaultPanelOpen && (
                          <div className="px-2 pb-2">
                            <input
                              type="text"
                              value={configVaultFolder}
                              onChange={(e) => setConfigVaultFolder(e.target.value)}
                              placeholder="/path/to/your/configs"
                              spellCheck={false}
                              className="w-full rounded border border-[var(--hairline)] bg-[var(--material-thick)] px-1.5 py-1 text-[10px] outline-none focus:border-accent"
                            />
                            <div className="mt-1.5 flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={configVaultBusy}
                                onClick={indexConfigVault}
                                className="rounded-[var(--r-md)] px-2 py-1 text-[10px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
                                style={{ background: 'var(--accent)' }}
                              >
                                {configVaultBusy ? 'Working...' : 'Index'}
                              </button>
                              {(configVaultStatus?.chunkCount || 0) > 0 && (
                                <button
                                  type="button"
                                  disabled={configVaultBusy}
                                  onClick={clearConfigVault}
                                  className="au-hairline rounded-[var(--r-md)] px-2 py-1 text-[10px] text-[color:var(--text-muted)] transition hover:text-[color:var(--text-main)] disabled:opacity-40"
                                >
                                  Clear
                                </button>
                              )}
                            </div>
                            {(configVaultStatus?.chunkCount || 0) > 0 && (
                              <p className="mt-1 text-[9px] leading-tight text-[color:var(--text-muted)]">{configVaultStatus.fileCount} files, {configVaultStatus.chunkCount} chunks via {configVaultStatus.embedModel}</p>
                            )}
                            {configVaultMsg && <p className="mt-1 text-[9px] leading-tight text-[color:var(--text-muted)]">{configVaultMsg}</p>}
                            <p className="mt-1 text-[9px] leading-tight text-[color:var(--text-muted)]">Embeds locally. Pull nomic-embed-text for sharper retrieval.</p>
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          setCanvasEnabled((prev) => !prev);
                          setIsToolsMenuOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                          canvasEnabled
                            ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                            : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                        }`}
                      >
                        <span>Canvas</span>
                        <span className="text-[10px] opacity-70">{canvasEnabled ? 'on' : 'off'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setGuidedLearningEnabled((prev) => !prev);
                          setIsToolsMenuOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                          guidedLearningEnabled
                            ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                            : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                        }`}
                      >
                        <span>Guided Learning</span>
                        <span className="text-[10px] opacity-70">{guidedLearningEnabled ? 'on' : 'off'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDeepThinkingEnabled((prev) => !prev);
                          setIsToolsMenuOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                          deepThinkingEnabled
                            ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                            : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                        }`}
                      >
                        <span>Deep Thinking</span>
                        <span className="text-[10px] opacity-70">{deepThinkingEnabled ? 'on' : 'off'}</span>
                      </button>
                      <div className="mt-2 border-t border-[var(--hairline)] px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Training</div>
                      <button
                        type="button"
                        onClick={() => {
                          setTrainingMode('off');
                          setIsTrainingMenuOpen(false);
                        }}
                        className={`mb-1 flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                          trainingMode === 'off'
                            ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                            : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                        }`}
                      >
                        <span>Training Off</span>
                        <span className="opacity-70">default</span>
                      </button>
                      <button
                        type="button"
                          onClick={() => {
                          setTrainingMode('fine-tuning');
                          setIsTrainingMenuOpen(false);
                        }}
                        className={`mb-1 flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                          trainingMode === 'fine-tuning'
                            ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                            : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                        }`}
                      >
                        <span>Quick Learning</span>
                        <span className="opacity-70">capture examples</span>
                      </button>
                      <button
                        type="button"
                          onClick={() => {
                          setTrainingMode('full-training');
                          setIsTrainingMenuOpen(false);
                        }}
                        className={`mb-1 flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                          trainingMode === 'full-training'
                            ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
                            : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                        }`}
                      >
                        <span>Deep Training</span>
                        <span className="opacity-70">plan only</span>
                      </button>

                      <label className="mt-2 flex items-center gap-2 rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-2 text-xs text-[color:var(--text-main)]">
                        <input
                          type="checkbox"
                          checked={usePersonalMemory}
                          onChange={(event) => setUsePersonalMemory(event.target.checked)}
                          className="h-3.5 w-3.5 rounded border-black/20 text-accent focus:ring-accent"
                        />
                        <span>Use personal memory context</span>
                      </label>

                      <div className="mt-2 rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-2 text-[11px] text-[color:var(--text-main)]">
                        <div>Memory items: {trainingStats.memoryItems}</div>
                        <div>Learning examples: {trainingStats.fineTuningExamples}</div>
                        {trainingMode === 'full-training' ? (
                          <div className="mt-1 text-amber-700 dark:text-amber-300">
                            Deep Training runs offline. Export examples below for LoRA training.
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-2 flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setIsTeachPanelOpen(true); setIsOptionsMenuOpen(false);
                            setIsTrainingMenuOpen(false);
                            loadMemoryItems();
                          }}
                          className="flex-1 rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1.5 text-[11px] font-medium text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                        >
                          Teach
                        </button>
                        <button
                          type="button"
                          onClick={() => { exportTrainingExamples(); setIsTrainingMenuOpen(false); }}
                          className="flex-1 rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1.5 text-[11px] font-medium text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                        >
                          Export
                        </button>
                      </div>
                      <div className="mt-2 border-t border-[var(--hairline)] px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Modes</div>
                      <button
                        type="button"
                        onClick={toggleUncensoredMode}
                        className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                          uncensoredMode
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                            : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                        }`}
                        title="Toggle uncensored mode for this chat"
                      >
                        <span className="flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full ${uncensoredMode ? 'bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.55)]' : 'bg-transparent border border-slate-400/40'}`} />
                          Uncensored
                        </span>
                        <span className="text-[10px] opacity-60">{uncensoredMode ? 'on' : 'off'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={toggleOpenClawMode}
                        className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                          openClawMode
                            ? 'bg-rose-50 text-rose-700 dark:bg-rose-900/20 dark:text-rose-300'
                            : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                        }`}
                        title="OpenClaw preset: uncensored mode, no personal memory, empty app system prompt"
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="flex items-center gap-2">
                            <span className={`h-2 w-2 rounded-full ${openClawMode ? 'bg-rose-400 shadow-[0_0_6px_2px_rgba(244,63,94,0.5)]' : 'bg-transparent border border-slate-400/40'}`} />
                            OpenClaw
                          </span>
                          <span className="mt-0.5 pl-4 text-[10px] leading-tight text-[color:var(--text-muted)]">Uncensored, no personal memory, empty system prompt</span>
                        </span>
                        <span className="text-[10px] opacity-60">{openClawMode ? 'on' : 'off'}</span>
                      </button>
                      <div data-menu-container="true" className="relative">
                        <button
                          type="button"
                          data-menu-trigger="control"
                          onClick={() => { setIsProviderMenuOpen(false); setIsModelMenuOpen(false); setIsTrainingMenuOpen(false); setIsToolsMenuOpen(false); setIsMcpPanelOpen(false); setOpenHardwarePopover(null); setIsEngineMenuOpen(false); setIsVoiceMenuOpen(false); setIsControlPanelOpen((prev) => !prev); }}
                          className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                          title="Remote Control"
                        >
                          <span className="flex items-center gap-2">
                            <span className={`h-1.5 w-1.5 rounded-full ${remoteConnected ? 'bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.55)]' : 'bg-transparent border border-slate-400/40'}`} />
                            Remote Control
                          </span>
                          <span className="text-[10px] opacity-60">{remoteConnected ? 'connected' : 'off'}</span>
                        </button>
                  {isControlPanelOpen && (
                    <div data-menu-panel="control" role="menu" tabIndex={-1} className="mt-1 w-full rounded-xl border border-[var(--hairline)] bg-[var(--material-thin)] p-3 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-[color:var(--text-main)]">Remote Control</span>
                        {remoteConnected && (
                          <button
                            type="button"
                            onClick={() => { disconnectRemote(); setIsControlPanelOpen(false); }}
                            className="text-[10px] text-red-400 hover:text-red-600"
                          >Disconnect</button>
                        )}
                      </div>

                      {remoteConnected ? (
                        <div className="flex items-center gap-2 rounded-lg border border-emerald-300/40 bg-emerald-50/60 px-2 py-1.5 dark:border-emerald-500/30 dark:bg-emerald-900/20">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.55)]" />
                          <span className="truncate text-[11px] font-medium text-emerald-800 dark:text-emerald-300">{remoteTarget}</span>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {/* Connection type */}
                          <div className="flex gap-1">
                            {['local', 'ssh'].map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => setRemoteType(t)}
                                className={`flex-1 rounded-lg px-2 py-1 text-[11px] font-medium transition ${remoteType === t ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent' : 'border border-[var(--hairline)] text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'}`}
                              >{t === 'local' ? 'Localhost' : 'SSH'}</button>
                            ))}
                          </div>

                          {remoteType === 'ssh' && (
                            <>
                              <input
                                type="text"
                                value={remoteHost}
                                onChange={(e) => setRemoteHost(e.target.value)}
                                placeholder="hostname or IP"
                                className="w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] outline-none focus:border-accent"
                              />
                              <div className="flex gap-1.5">
                                <input
                                  type="text"
                                  value={remoteUser}
                                  onChange={(e) => setRemoteUser(e.target.value)}
                                  placeholder="username"
                                  className="flex-1 rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] outline-none focus:border-accent"
                                />
                                <input
                                  type="text"
                                  value={remotePort}
                                  onChange={(e) => setRemotePort(e.target.value)}
                                  placeholder="22"
                                  className="w-14 rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] outline-none focus:border-accent"
                                />
                              </div>
                              {/* Auth type */}
                              <div className="flex gap-1">
                                {['agent', 'key', 'password'].map((a) => (
                                  <button
                                    key={a}
                                    type="button"
                                    onClick={() => setRemoteAuthType(a)}
                                    className={`flex-1 rounded-lg px-1 py-0.5 text-[10px] font-medium transition capitalize ${remoteAuthType === a ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent' : 'border border-[var(--hairline)] text-[color:var(--text-main)] hover:bg-black/5'}`}
                                  >{a}</button>
                                ))}
                              </div>
                              {remoteAuthType === 'key' && (
                                <input
                                  type="text"
                                  value={remoteKeyPath}
                                  onChange={(e) => setRemoteKeyPath(e.target.value)}
                                  placeholder="/path/to/id_rsa"
                                  className="w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] outline-none focus:border-accent"
                                />
                              )}
                              {remoteAuthType === 'password' && (
                                <input
                                  type="password"
                                  value={remotePassword}
                                  onChange={(e) => setRemotePassword(e.target.value)}
                                  placeholder="password"
                                  autoComplete="new-password"
                                  className="w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] outline-none focus:border-accent"
                                />
                              )}
                            </>
                          )}
                          <button
                            type="button"
                            onClick={connectRemote}
                            disabled={remoteConnecting || (remoteType === 'ssh' && (!remoteHost.trim() || !remoteUser.trim()))}
                            className="w-full rounded-xl bg-accent py-1.5 text-[11px] font-semibold text-white disabled:opacity-40"
                          >
                            {remoteConnecting ? 'Connecting…' : remoteType === 'local' ? 'Connect to Localhost' : 'Connect via SSH'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                      </div>
                      <div data-menu-container="true" className="relative">
                        <button
                          type="button"
                          data-menu-trigger="mcp"
                          onClick={() => { setIsModelMenuOpen(false); setIsTrainingMenuOpen(false); setIsToolsMenuOpen(false); setIsControlPanelOpen(false); setOpenHardwarePopover(null); setIsEngineMenuOpen(false); setIsVoiceMenuOpen(false); setIsMcpPanelOpen((prev) => !prev); }}
                          className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                          title="MCP Connector"
                        >
                          <span className="flex items-center gap-2">
                            <span className={`h-2 w-2 rounded-full ${selectedMcpServer ? 'bg-cyan-400 shadow-[0_0_6px_2px_rgba(34,211,238,0.45)]' : 'bg-transparent border border-slate-400/40'}`} />
                            MCP Connector
                          </span>
                          <span className="text-[10px] opacity-60">{selectedMcpServer ? selectedMcpServer.id : 'off'}</span>
                        </button>
                  {isMcpPanelOpen && (
                    <div data-menu-panel="mcp" role="menu" tabIndex={-1} className="mt-1 w-full rounded-xl border border-[var(--hairline)] bg-[var(--material-thin)] p-3 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-[color:var(--text-main)]">MCP Connector</span>
                        <button
                          type="button"
                          onClick={refreshMcpServers}
                          className="rounded-md border border-[var(--hairline)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                        >
                          Refresh
                        </button>
                      </div>

                      <div className="mb-2 grid grid-cols-[1fr_auto_auto] gap-1.5">
                        <select
                          value={mcpSelectedServerId}
                          onChange={(event) => setMcpSelectedServerId(event.target.value)}
                          className="rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] outline-none focus:border-accent"
                        >
                          <option value="">Select server…</option>
                          {mcpServers.map((server) => (
                            <option key={server.id} value={server.id}>{server.name} ({server.id})</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={testMcpServer}
                          disabled={!mcpSelectedServerId || mcpLoading}
                          className="rounded-lg border border-[var(--hairline)] px-2 py-1.5 text-[10px] font-medium text-[color:var(--text-main)] transition hover:bg-black/5 disabled:opacity-40 dark:hover:bg-[var(--material-thin)]"
                        >
                          Test
                        </button>
                        <button
                          type="button"
                          onClick={deleteMcpServer}
                          disabled={!mcpSelectedServerId || mcpLoading}
                          className="rounded-lg border border-red-300/50 px-2 py-1.5 text-[10px] font-medium text-red-500 transition hover:bg-red-50 disabled:opacity-40 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-900/20"
                        >
                          Delete
                        </button>
                      </div>

                      <div className="mb-2 grid grid-cols-2 gap-1.5">
                        <input
                          type="text"
                          value={mcpForm.id}
                          onChange={(event) => setMcpForm((prev) => ({ ...prev, id: event.target.value }))}
                          placeholder="server id"
                          className="rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] outline-none focus:border-accent"
                        />
                        <input
                          type="text"
                          value={mcpForm.name}
                          onChange={(event) => setMcpForm((prev) => ({ ...prev, name: event.target.value }))}
                          placeholder="display name"
                          className="rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] outline-none focus:border-accent"
                        />
                      </div>
                      <input
                        type="text"
                        value={mcpForm.url}
                        onChange={(event) => setMcpForm((prev) => ({ ...prev, url: event.target.value }))}
                        placeholder="http://127.0.0.1:30030/mcp"
                        className="mb-1.5 w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] outline-none focus:border-accent"
                      />
                      <input
                        type="password"
                        value={mcpForm.authToken}
                        onChange={(event) => setMcpForm((prev) => ({ ...prev, authToken: event.target.value }))}
                        placeholder="bearer token (optional)"
                        className="mb-2 w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] outline-none focus:border-accent"
                      />

                      <div className="mb-2 flex gap-1.5">
                        <button
                          type="button"
                          onClick={saveMcpServer}
                          disabled={mcpLoading}
                          className="flex-1 rounded-lg bg-accent px-2 py-1.5 text-[11px] font-semibold text-white disabled:opacity-40"
                        >
                          Save Server
                        </button>
                        <button
                          type="button"
                          onClick={useLocalMcpPreset}
                          className="flex-1 rounded-lg border border-[var(--hairline)] px-2 py-1.5 text-[11px] font-medium text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                        >
                          Local MCP Preset
                        </button>
                      </div>

                      {mcpSelectedServerId && (
                        <>
                          <div className="mb-2 rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] p-2">
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Policy</div>
                            <div className="mb-1.5 grid grid-cols-2 gap-1.5">
                              <label className="flex items-center gap-1.5 text-[11px] text-[color:var(--text-main)]">
                                <input
                                  type="checkbox"
                                  checked={mcpPolicy.enforceAllowlist}
                                  onChange={(event) => saveMcpPolicy({ ...mcpPolicy, enforceAllowlist: event.target.checked })}
                                  className="h-3.5 w-3.5 rounded border-black/20 text-accent focus:ring-accent"
                                />
                                Enforce allowlist
                              </label>
                              <label className="flex items-center gap-1.5 text-[11px] text-[color:var(--text-main)]">
                                <input
                                  type="checkbox"
                                  checked={mcpPolicy.requireApproval}
                                  onChange={(event) => saveMcpPolicy({ ...mcpPolicy, requireApproval: event.target.checked })}
                                  className="h-3.5 w-3.5 rounded border-black/20 text-accent focus:ring-accent"
                                />
                                Require approval
                              </label>
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-[color:var(--text-main)]">
                              <span>Approval TTL</span>
                              <input
                                type="number"
                                min="30"
                                max="3600"
                                value={mcpPolicy.approvalTtlSeconds}
                                onChange={(event) => saveMcpPolicy({ ...mcpPolicy, approvalTtlSeconds: Number(event.target.value || 300) })}
                                className="w-20 rounded border border-[var(--hairline)] bg-[var(--material-thick)] px-1.5 py-0.5 text-[10px] outline-none focus:border-accent"
                              />
                              <span>seconds</span>
                            </div>
                          </div>

                          <div className="mb-2 rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] p-2">
                            <div className="mb-1.5 flex items-center justify-between">
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Tools</span>
                              <button
                                type="button"
                                onClick={loadMcpTools}
                                disabled={mcpLoading}
                                className="rounded-md border border-[var(--hairline)] px-1.5 py-0.5 text-[10px] text-[color:var(--text-main)] transition hover:bg-black/5 disabled:opacity-40 dark:hover:bg-[var(--material-thin)]"
                              >
                                Fetch
                              </button>
                            </div>
                            <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
                              {mcpTools.length === 0 && <div className="text-[10px] text-[color:var(--text-muted)]">No tools loaded yet.</div>}
                              {mcpTools.map((tool) => {
                                const name = String(tool?.name || '');
                                const checked = mcpPolicy.allowedTools.includes(name);
                                return (
                                  <label key={name} className="flex items-center justify-between gap-2 rounded-md border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-1 text-[10px]">
                                    <span className="truncate text-[color:var(--text-main)]">{name}</span>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(event) => {
                                        const next = event.target.checked
                                          ? Array.from(new Set([...mcpPolicy.allowedTools, name])).sort((a, b) => a.localeCompare(b))
                                          : mcpPolicy.allowedTools.filter((item) => item !== name);
                                        saveMcpPolicy({ ...mcpPolicy, allowedTools: next });
                                      }}
                                      className="h-3.5 w-3.5 rounded border-black/20 text-accent focus:ring-accent"
                                    />
                                  </label>
                                );
                              })}
                            </div>
                          </div>

                          <div className="rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] p-2">
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Run Tool</div>
                            <div className="mb-1.5 grid grid-cols-[1fr_auto] gap-1.5">
                              <select
                                value={mcpToolName}
                                onChange={(event) => setMcpToolName(event.target.value)}
                                className="rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] outline-none focus:border-accent"
                              >
                                <option value="">Select tool…</option>
                                {mcpTools.map((tool) => {
                                  const name = String(tool?.name || '');
                                  return <option key={name} value={name}>{name}</option>;
                                })}
                              </select>
                              <button
                                type="button"
                                onClick={callMcpTool}
                                disabled={mcpCalling || !mcpToolName}
                                className="rounded-lg bg-accent px-2 py-1.5 text-[11px] font-semibold text-white disabled:opacity-40"
                              >
                                {mcpCalling ? 'Running…' : 'Run'}
                              </button>
                            </div>
                            <textarea
                              value={mcpToolArgsText}
                              onChange={(event) => setMcpToolArgsText(event.target.value)}
                              rows={4}
                              placeholder={'{\n  "arg": "value"\n}'}
                              className="mb-1.5 w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 font-mono text-[10px] outline-none focus:border-accent"
                            />
                            <pre className="max-h-28 overflow-y-auto rounded-lg border border-[var(--hairline)] bg-slate-950/90 p-2 font-mono text-[10px] text-emerald-300">
                              {mcpCallResultText || '{ }'}
                            </pre>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                      </div>
                      <div className="mt-2 border-t border-[var(--hairline)] px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Voice</div>
                      <div data-menu-container="true" className="relative">
                        <button
                          type="button"
                          data-menu-trigger="voice"
                          onClick={() => { setIsContextPanelOpen(false); setOpenHardwarePopover(null); setIsEngineMenuOpen(false); setIsControlPanelOpen(false); setIsMcpPanelOpen(false); checkVoiceTools(); fetchPiperModels(); setIsVoiceMenuOpen((prev) => !prev); }}
                          className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs text-[color:var(--text-main)] transition hover:bg-black/5 dark:hover:bg-[var(--material-thin)]"
                          title="Voice settings"
                        >
                          <span className="flex items-center gap-2">
                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M4 12h1" /><path d="M8 9v6" /><path d="M12 7v10" /><path d="M16 9v6" /><path d="M20 11v2" />
                            </svg>
                            Voice settings
                          </span>
                          <span className="text-[10px] opacity-60">{voiceEngine === 'piper' ? 'Piper' : 'Browser'}</span>
                        </button>
                {isVoiceMenuOpen && (
                  <div data-menu-panel="voice" role="menu" tabIndex={-1} className="mt-1 w-full rounded-xl border border-[var(--hairline)] bg-[var(--material-thin)] p-2 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-[color:var(--text-main)]">Voice Settings</span>
                      <span className="text-[10px] text-[color:var(--text-muted)]">{voiceSupported ? 'TTS ready' : 'Unavailable'}</span>
                    </div>

                    {/* Speech-to-text (talking to the assistant). The live voice loop
                        records audio and transcribes locally via whisper.cpp - the
                        browser Web Speech API does not work in the desktop app. */}
                    <div className="mb-2 rounded-lg border border-[var(--hairline)] p-2">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Speech to Text (talking)</span>
                        <span className={`text-[10px] font-medium ${voiceTools?.stt?.ready ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-600 dark:text-amber-300'}`}>
                          {voiceTools?.stt?.ready ? 'Ready' : 'Not installed'}
                        </span>
                      </div>
                      <p className="mb-1.5 text-[10px] leading-relaxed text-[color:var(--text-muted)]">
                        {voiceTools?.stt?.ready
                          ? (voiceTools?.stt?.whisperCpp ? 'Local whisper.cpp - fully offline.' : voiceTools?.stt?.openai ? 'Using OpenAI transcription.' : 'Local Whisper CLI.')
                          : 'Install local speech-to-text (whisper.cpp) to talk hands-free. One-time ~150MB download, runs offline.'}
                      </p>
                      {!voiceTools?.stt?.ready && (
                        <button
                          type="button"
                          onClick={setupStt}
                          disabled={isSettingUpStt}
                          className="w-full rounded-lg bg-accent px-2 py-1.5 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
                        >
                          {isSettingUpStt ? 'Installing…' : 'Install local speech-to-text'}
                        </button>
                      )}
                    </div>

                    <div className="mb-2 grid grid-cols-2 gap-1">
                      <button
                        type="button"
                        onClick={() => setAutoSpeakEnabled((prev) => !prev)}
                        className={`rounded-lg px-2 py-1.5 text-[11px] font-medium transition ${
                          autoSpeakEnabled
                            ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                            : 'border border-[var(--hairline)] text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'
                        }`}
                      >
                        Auto-speak {autoSpeakEnabled ? 'on' : 'off'}
                      </button>
                      <button
                        type="button"
                        onClick={() => (isSpeaking ? stopSpeaking() : speakText('Voice preview from Mirabilis.'))}
                        disabled={!voiceSupported && voiceEngine === 'browser'}
                        className="rounded-lg border border-[var(--hairline)] px-2 py-1.5 text-[11px] font-medium text-[color:var(--text-main)] transition hover:bg-black/5 disabled:opacity-40 dark:hover:bg-[var(--material-thin)]"
                      >
                        {isSpeaking ? 'Stop' : 'Preview'}
                      </button>
                    </div>

                    {/* Voice engine toggle */}
                    <div className="mb-2">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Voice Engine</div>
                      <div className="flex overflow-hidden rounded-lg border border-[var(--hairline)]">
                        <button
                          type="button"
                          onClick={() => setVoiceEngine('browser')}
                          className={`flex-1 px-2 py-1.5 text-[10px] font-medium transition ${voiceEngine === 'browser' ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent' : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'}`}
                        >
                          Browser
                        </button>
                        <button
                          type="button"
                          onClick={() => setVoiceEngine('piper')}
                          className={`flex-1 border-l border-black/10 px-2 py-1.5 text-[10px] font-medium transition ${voiceEngine === 'piper' ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent' : 'text-[color:var(--text-main)] hover:bg-black/5 dark:hover:bg-[var(--material-thin)]'}`}
                        >
                          Piper neural
                        </button>
                      </div>
                    </div>

                    {/* Browser engine */}
                    {voiceEngine === 'browser' && (
                      <>
                        <div className="mb-2 space-y-1">
                          <label className="block text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Voice</label>
                          <select
                            value={selectedVoiceUri}
                            onChange={(e) => setSelectedVoiceUri(e.target.value)}
                            className="w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] text-[color:var(--text-main)] outline-none focus:border-accent"
                          >
                            {availableVoices.map((voice) => (
                              <option key={voice.voiceURI} value={voice.voiceURI}>
                                {voice.name} ({voice.lang})
                              </option>
                            ))}
                          </select>
                          {voiceTools?.platform === 'darwin' && (
                            <p className="text-[10px] text-[color:var(--text-muted)]">
                              More voices: System Settings → Accessibility → Spoken Content → Manage Voices
                            </p>
                          )}
                        </div>
                        <div className="mb-1 grid grid-cols-2 gap-2">
                          <label className="text-[10px] text-[color:var(--text-muted)]">
                            Rate {voiceRate.toFixed(2)}
                            <input type="range" min="0.8" max="1.5" step="0.05" value={voiceRate} onChange={(e) => setVoiceRate(Number(e.target.value))} className="mt-1 w-full" />
                          </label>
                          <label className="text-[10px] text-[color:var(--text-muted)]">
                            Pitch {voicePitch.toFixed(2)}
                            <input type="range" min="0.8" max="1.4" step="0.05" value={voicePitch} onChange={(e) => setVoicePitch(Number(e.target.value))} className="mt-1 w-full" />
                          </label>
                        </div>
                      </>
                    )}

                    {/* Piper neural engine */}
                    {voiceEngine === 'piper' && (
                      <div className="space-y-2">
                        {!voiceTools?.voices?.localPiper && (
                          <div className="rounded-lg border border-[var(--hairline)] bg-[var(--material-thin)] p-2 text-[10px]">
                            <div className="mb-0.5 font-semibold text-[color:var(--text-main)]">Piper Neural TTS</div>
                            <div className="mb-2 text-[color:var(--text-muted)]">
                              Free, high-quality local voices that run offline. Runs on your device - no cloud.
                            </div>
                            <button
                              type="button"
                              onClick={setupVoiceTools}
                              disabled={isSettingUpVoiceTools}
                              className="w-full rounded-md bg-accent px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
                            >
                              {isSettingUpVoiceTools ? 'Installing…' : 'Install Piper'}
                            </button>
                          </div>
                        )}

                        {voiceTools?.voices?.localPiper && (
                          <>
                            {(voiceTools.voices.piperModels || []).length > 0 && (
                              <div className="space-y-1">
                                <label className="block text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Active voice</label>
                                <select
                                  value={selectedPiperModelId}
                                  onChange={(e) => setSelectedPiperModelId(e.target.value)}
                                  className="w-full rounded-lg border border-[var(--hairline)] bg-[var(--material-thick)] px-2 py-1.5 text-[11px] text-[color:var(--text-main)] outline-none focus:border-accent"
                                >
                                  {piperModels.filter((m) => m.installed).map((m) => (
                                    <option key={m.id} value={m.id}>{m.label}</option>
                                  ))}
                                </select>
                              </div>
                            )}

                            <div>
                              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">Free voice catalog</div>
                              <div className="space-y-0.5">
                                {piperModels.map((model) => (
                                  <div key={model.id} className="flex items-center justify-between rounded-lg px-2 py-1 text-[10px]">
                                    <span className="text-[color:var(--text-main)]">{model.label}</span>
                                    {model.installed ? (
                                      <span className="font-semibold text-emerald-600 dark:text-emerald-400">Installed</span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => downloadPiperModel(model.id)}
                                        disabled={downloadingPiperModelId !== null}
                                        className="rounded-md bg-black/5 px-2 py-0.5 font-medium text-[color:var(--text-main)] transition hover:bg-accent hover:text-white disabled:opacity-40 dark:bg-[var(--material-thin)] dark:hover:bg-accent dark:hover:text-white"
                                      >
                                        {downloadingPiperModelId === model.id ? 'Downloading…' : `${model.sizeMb}MB`}
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>

                            <label className="block text-[10px] text-[color:var(--text-muted)]">
                              Speed {voiceRate.toFixed(2)}
                              <input type="range" min="0.8" max="1.5" step="0.05" value={voiceRate} onChange={(e) => setVoiceRate(Number(e.target.value))} className="mt-1 w-full" />
                            </label>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
              <div className="flex flex-wrap justify-end gap-1.5">
                {deepThinkingEnabled && (
                  <span className="rounded-full border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-main)]">
                    Deep Thinking
                  </span>
                )}
                {guidedLearningEnabled && (
                  <span className="rounded-full border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-main)]">
                    Guided
                  </span>
                )}
                {trainingMode === 'fine-tuning' && (
                  <span className="rounded-full border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-main)]">
                    Quick Learning
                  </span>
                )}
                {trainingMode === 'full-training' && (
                  <span className="rounded-full border border-amber-300/60 bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:border-amber-400/40 dark:bg-amber-900/30 dark:text-amber-200">
                    Deep Training
                  </span>
                )}
                {canvasEnabled && (
                  <span className="rounded-full border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-main)]">
                    Canvas
                  </span>
                )}
                {remoteConnected && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/50 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-900/20 dark:text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    {remoteTarget}
                  </span>
                )}
                {workspacePins.length > 0 && (
                  <button
                    type="button"
                    onClick={() => appStore.openWorkspace()}
                    title="Pinned workspace files - read fresh from disk on send"
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--hairline)] bg-[var(--material-thin)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--text-main)] transition hover:bg-[color:var(--hairline)]"
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                    {workspacePins.length} workspace file{workspacePins.length === 1 ? '' : 's'}
                  </button>
                )}
                {selectedMcpServer && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/60 bg-cyan-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-700 dark:border-cyan-400/40 dark:bg-cyan-900/20 dark:text-cyan-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                    MCP {selectedMcpServer.id}
                  </span>
                )}
              </div>
                <span
                  className="shrink-0 font-medium tabular-nums text-[length:var(--text-2xs)] text-[color:var(--text-muted)]"
                  title={`in ${chatTokenSummary.input.toLocaleString()} / out ${chatTokenSummary.output.toLocaleString()}`}
                >
                  {(chatTokenSummary.input + chatTokenSummary.output).toLocaleString()} tokens
                </span>
              </div>
            </div>

            {/* ROW 2: input bar - single-container composer. textarea on top, then one action row: [attach mic voice] ... [Send]. */}
            <div className="rounded-[var(--r-lg)] border border-[var(--hairline)] bg-[var(--material-thin)] focus-within:border-[color:var(--accent)] transition">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleAttachFiles}
              />
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onFocus={() => {
                  setIsModelMenuOpen(false);
                  setIsTrainingMenuOpen(false);
                  setIsToolsMenuOpen(false);
                  setIsControlPanelOpen(false);
                  setIsMcpPanelOpen(false);
                  setOpenHardwarePopover(null);
                  setIsEngineMenuOpen(false);
                  setIsContextPanelOpen(false);
                  setIsVoiceMenuOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Type your message..."
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
                    title={dictationSupported ? (isDictating ? 'Stop dictation' : 'Start dictation') : 'Dictation not supported in this browser'}
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
                    title="Voice chat - hands-free spoken conversation"
                  >
                    <WaveIcon size={16} className="h-4 w-4" />
                  </button>
                </div>
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

          {(showScrollDown || !autoScrollEnabled) && (
            <div className="pointer-events-none absolute bottom-28 left-0 right-0 z-20 flex justify-center">
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
                title="Jump to latest messages"
                aria-label="Scroll to bottom"
              >
                {isStreaming && !autoScrollEnabled ? 'New messages ↓' : '↓'}
              </button>
            </div>
          )}
        </section>
      </div>
      <footer className="pointer-events-none absolute bottom-1 left-0 right-0 text-center text-xs tracking-wide text-[color:var(--text-main)]/90">
        {APP_FOOTER_TEXT}
        <span className="mx-1.5 opacity-40">·</span>
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
        onClose={() => appStore.closeVoiceChat()}
        phase={voicePhase}
        interimText={voiceInterim}
        replyText={voiceReply}
        gender={voiceGender}
        onGenderChange={onVoiceGenderChange}
        onOrbTap={onVoiceOrbTap}
        srSupported={voiceLoopSupported}
        note={voiceNote}
      />
    </main>
  );
}
