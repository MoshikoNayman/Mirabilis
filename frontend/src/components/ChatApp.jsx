'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
const DEFAULT_SYSTEM_PROMPT = 'You are Mirabilis AI, a concise and helpful local assistant. You run entirely on the user\'s own device — never describe yourself as cloud-based or as a generic AI product. When someone asks who created or built you, answer naturally and briefly: Mirabilis AI was created by Moshiko Nayman. Do not volunteer that information unprompted. Image generation is available locally via a Stable Diffusion service — generate real images rather than ASCII art when asked.';
const PROVIDER_OPTIONS = [
  { id: 'ollama', label: 'Ollama' },
  { id: 'openai-compatible', label: 'OpenAI-compatible' },
  { id: 'koboldcpp', label: 'KoboldCpp' }
];

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

// Models with guaranteed 128K+ context window — preferred when conversation is large.
// (phi4=16K, mistral/mixtral=32K are excluded intentionally)
const LARGE_CONTEXT_PRIORITY = [
  'llama3.3', 'llama3.1', 'qwen3', 'deepseek-r1', 'gemma4:31b', 'gemma4:26b',
  'gemma3:27b', 'gemma3:12b', 'gemma4:e4b', 'gemma4:e2b', 'gemma3', 'qwen2.5', 'llama3'
];

// Priority list for Auto mode when context is small — most capable installed model first.
const AUTO_MODEL_PRIORITY = [
  'llama3.3', 'qwen3', 'deepseek-r1', 'mistral-large', 'gemma4:31b', 'gemma4:26b',
  'gemma3:27b', 'gemma3:12b', 'llama3.1', 'gemma4:e4b', 'gemma4:e2b',
  'mistral', 'gemma3', 'qwen2.5', 'phi4', 'llama3'
];

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

  // Hard skip — pure generation / writing tasks that gain nothing from web context
  const skipPatterns = [
    /\b(write|draft|compose|summarise?|summarize|translate|generate|create|draw|code|fix|debug|refactor|improve|proofread|rewrite|convert|calculate|solve)\b/,
  ];
  const hasSkipVerb = skipPatterns.some((r) => r.test(t));

  // Live / real-time signals — always search regardless of skip verbs
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
  // Default to search when www is on — let the AI decide if the context is useful
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
      className="ml-auto rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 transition hover:bg-white/10 hover:text-white"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function CopyMessageButton({ text }) {
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
      className="rounded p-1 text-slate-400 transition hover:bg-black/5 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-slate-200"
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

// Syntax highlight theme — CSS-var-driven so it instantly reacts to scheme changes.
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

// Static markdown component overrides — defined at module level so they're never recreated.
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
    <blockquote className="my-2 border-s-2 border-accent ps-3 text-slate-500 italic dark:text-slate-400">{children}</blockquote>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:brightness-90">{children}</a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-black/10 dark:border-white/10">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-black/5 dark:bg-white/5">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-t border-black/5 dark:border-white/5">{children}</tr>,
  th: ({ children }) => <th className="px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">{children}</th>,
  td: ({ children }) => <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">{children}</td>,
};

function renderMessageContent(content, message = {}, remoteCtx = {}) {
  const { remoteConnectedRef, remoteTargetRef, execResultsRef, onRunCommand } = remoteCtx;
  if (message.imageGenerating) {
    return (
      <div
        className="relative overflow-hidden rounded-xl bg-slate-200 dark:bg-slate-700"
        style={{ width: 288, height: 288 }}
        aria-label="Generating image…"
      >
        {/* Shimmer sweep — pure CSS, GPU-only */}
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
          <figcaption className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{message.content}</figcaption>
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
      // react-markdown v9+ no longer passes `inline` prop — detect it ourselves:
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
                className="ml-2 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400 transition hover:bg-white/10 hover:text-emerald-300 disabled:opacity-50"
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
              <div className={`mt-1 text-[10px] ${execResult.exitCode === 0 ? 'text-slate-400' : 'text-red-400'}`}>
                exit {execResult.exitCode} · {execResult.duration != null ? `${execResult.duration}ms` : ''}
              </div>
            </div>
          )}
        </figure>
      );
    },
  };

  // Detect RTL once from the full text so the entire block — including list
  // containers — gets a concrete direction that all descendants inherit.
  const dir = RTL_CHARS_RE.test(text) ? 'rtl' : 'ltr';

  return (
    <div className="markdown-body text-sm" dir={dir}>
      <ReactMarkdown components={mdComponents} remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

// Memoised sidebar chat row — comparator ignores callbacks so typing / streaming
// never causes the full chat list to reconcile; only the affected item re-renders.
const ChatItem = memo(function ChatItem({ chat, isActive, isMenuOpen, isPinned, onSelect, onToggleMenu, onDelete, onRename, onExport, onTogglePin }) {
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
            : 'border-black/10 bg-white/75 hover:bg-white dark:border-white/10 dark:bg-slate-800/60 dark:hover:bg-slate-700/60'
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
              className="w-full rounded border border-accent/50 bg-white px-1.5 py-0.5 text-sm outline-none dark:bg-slate-800 dark:text-slate-100"
            />
          </form>
        ) : (
          <button onClick={() => onSelect(chat.id)} className="min-w-0 flex-1 text-left">
            <div className="line-clamp-1 text-sm font-medium">{chat.title}</div>
            <div className="text-[10px] text-slate-500 dark:text-slate-300">{formatTime(chat.updatedAt)}</div>
          </button>
        )}
        {!isRenaming && (
          <button
            type="button"
            aria-label={`More actions for ${chat.title}`}
            title="Chat actions"
            className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 opacity-0 transition hover:bg-black/5 hover:text-slate-700 group-hover:opacity-100 focus:opacity-100 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-200"
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
          <div className="absolute right-2 top-10 z-10 min-w-36 rounded-xl border border-black/10 bg-white/95 p-1 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-slate-700 transition hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10"
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
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-slate-700 transition hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10"
              onClick={() => { onTogglePin(chat.id); onToggleMenu(null); }}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
              <span>{isPinned ? 'Unpin' : 'Pin'}</span>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-slate-700 transition hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10"
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

// Memoised message bubble — only re-renders when its own data or speaking state changes.
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
      className={`fade-in text-sm ${
        message.role === 'user'
          ? 'ml-auto max-w-[90%] rounded-2xl px-3 py-2 shadow-sm sm:max-w-[75%] bg-accent text-white shadow-[0_10px_22px_-14px_rgba(26,168,111,0.9)]'
          : speakingMessageId === message.id
          ? 'w-full rounded-r-xl border-l-2 border-accent px-3 py-2 bg-accentSoft/50 text-slate-800 dark:bg-accent/15 dark:text-slate-100'
          : 'w-full rounded-r-xl border-l-2 border-accent/30 px-3 py-2 bg-black/[0.025] text-slate-800 dark:border-accent/25 dark:bg-white/[0.04] dark:text-slate-100'
      }`}
    >
      {isStreaming && !message.content && message.role === 'assistant' && isLast && !message.imageGenerating
        ? (
          <div className="flex items-center gap-1.5 py-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]" />
            {streamingLabel && (
              <span className="ml-1 text-[10px] font-medium uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">{streamingLabel}</span>
            )}
          </div>
        )
        : renderMessageContent(message.content, message, { remoteConnectedRef, remoteTargetRef, execResultsRef, onRunCommand: runCommand })}
      {Array.isArray(message.attachments) && message.attachments.length > 0 && (
        <div className="mt-2 grid gap-2">
          {message.attachments.map((file) => {
            const isImage = String(file.mimeType || '').startsWith('image/');
            return (
              <div key={file.storedName || file.url} className="rounded-xl border border-black/10 bg-white/80 p-2 dark:border-white/10 dark:bg-slate-900/50">
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
                      className="rounded-md border border-black/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
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
        <div className="mt-1.5 flex items-center justify-between border-t border-white/20 pt-1">
          <span className="font-mono text-[9px] leading-none uppercase tracking-wide text-white/50">
            You · ~{(message.tokenEstimate || 0).toLocaleString()} tok
          </span>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(message.content || '').catch(() => {})}
            title="Copy message"
            className="rounded p-1 text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>
      )}
      {message.role === 'assistant' && !message.imageGenerating && (
        <div className="mt-1.5 flex items-center justify-between border-t border-black/[0.06] pt-1 dark:border-white/[0.07]">
          <span className="font-mono text-[9px] leading-none uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {!message.imageUrl ? `AI · ~${(message.tokenEstimate || 0).toLocaleString()} tok` : 'AI'}
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
                  : 'text-slate-400 hover:bg-black/5 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-slate-200'
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
                className="rounded p-1 text-slate-400 transition hover:bg-black/5 hover:text-slate-700 disabled:opacity-40 dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-slate-200"
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
  const speechRecognitionRef = useRef(null);
  const dictationBaseRef = useRef('');
  const dictationFinalRef = useRef('');
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
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingLabel, setStreamingLabel] = useState('');
  const [themeMode, setThemeMode] = useState(() => {
    if (typeof window !== 'undefined') return window.localStorage.getItem('local-ai-theme-mode') || 'auto';
    return 'auto';
  });
  const [uiFont, setUiFont] = useState(() => {
    if (typeof window !== 'undefined') return window.localStorage.getItem('mirabilis-font') || 'jakarta';
    return 'jakarta';
  });
  const [colorScheme, setColorScheme] = useState(() => {
    if (typeof window !== 'undefined') {
      const v = window.localStorage.getItem('mirabilis-color-scheme') || 'mirabilis';
      return ['mirabilis','arctic','ember','summit'].includes(v) ? v : 'mirabilis';
    }
    return 'mirabilis';
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  const [models, setModels] = useState([]);
  const [provider, setProvider] = useState(() => {
    if (typeof window !== 'undefined') return window.localStorage.getItem('mirabilis-provider') || 'ollama';
    return 'ollama';
  });
  const [providerConfigs, setProviderConfigs] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem('mirabilis-provider-configs');
      if (stored) try { return JSON.parse(stored); } catch {}
    }
    return {
      'openai-compatible': { baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '' },
      'koboldcpp': { baseUrl: 'http://127.0.0.1:5001/v1', apiKey: '' }
    };
  });
  const [isProviderConfigOpen, setIsProviderConfigOpen] = useState(false);
  const [model, setModel] = useState(() => {
    if (typeof window !== 'undefined') return window.localStorage.getItem('local-ai-model') || 'auto';
    return 'auto';
  });
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
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
  const [selectedEngine, setSelectedEngine] = useState(() => {
    if (typeof window !== 'undefined') return window.localStorage.getItem('mirabilis-engine-option') || '';
    return '';
  });
  const [isContextPanelOpen, setIsContextPanelOpen] = useState(false);
  const [isProviderMenuOpen, setIsProviderMenuOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isToolsMenuOpen, setIsToolsMenuOpen] = useState(false);
  const [isTrainingMenuOpen, setIsTrainingMenuOpen] = useState(false);
  const [canvasEnabled, setCanvasEnabled] = useState(false);
  const [canvasText, setCanvasText] = useState('');
  const [guidedLearningEnabled, setGuidedLearningEnabled] = useState(false);
  const [deepThinkingEnabled, setDeepThinkingEnabled] = useState(false);
  const [trainingMode, setTrainingMode] = useState('off');
  const [usePersonalMemory, setUsePersonalMemory] = useState(true);
  const [openClawMode, setOpenClawMode] = useState(() => {
    if (typeof window !== 'undefined') return window.localStorage.getItem('mirabilis-openclaw') === 'true';
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
    if (typeof window !== 'undefined') return window.localStorage.getItem('mirabilis-voice-uri') || '';
    return '';
  });
  const [autoSpeakEnabled, setAutoSpeakEnabled] = useState(() => {
    if (typeof window !== 'undefined') return window.localStorage.getItem('mirabilis-auto-speak') === 'true';
    return false;
  });
  const [voiceRate, setVoiceRate] = useState(() => {
    if (typeof window !== 'undefined') return Number(window.localStorage.getItem('mirabilis-voice-rate') || '1');
    return 1;
  });
  const [voicePitch, setVoicePitch] = useState(() => {
    if (typeof window !== 'undefined') return Number(window.localStorage.getItem('mirabilis-voice-pitch') || '1');
    return 1;
  });
  const [voiceTools, setVoiceTools] = useState(null);
  const [isSettingUpVoiceTools, setIsSettingUpVoiceTools] = useState(false);
  const [voiceEngine, setVoiceEngine] = useState(() => {
    if (typeof window !== 'undefined') return window.localStorage.getItem('mirabilis-voice-engine') || 'browser';
    return 'browser';
  });
  const [selectedPiperModelId, setSelectedPiperModelId] = useState(() => {
    if (typeof window !== 'undefined') return window.localStorage.getItem('mirabilis-piper-model') || '';
    return '';
  });
  const [piperModels, setPiperModels] = useState([]);
  const [downloadingPiperModelId, setDownloadingPiperModelId] = useState(null);
  const [isDragOverChat, setIsDragOverChat] = useState(false);
  const [deepWebEnabled, setDeepWebEnabled] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('local-ai-deep-web-enabled');
      return saved === null ? true : saved === 'true'; // default ON
    }
    return true;
  });
  const [webSearchStatus, setWebSearchStatus] = useState('idle'); // 'idle' | 'searching' | 'error'
  // modelId → { pct: number|null, status: string, ctrl: AbortController } while pulling
  const [pullingModels, setPullingModels] = useState({});
  // modelId → true while a delete request is in-flight
  const [deletingModels, setDeletingModels] = useState({});
  const [isTeachPanelOpen, setIsTeachPanelOpen] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const autoScrollRef = useRef(true); // ref mirror — readable synchronously in scroll handler
  const [memoryItems, setMemoryItems] = useState([]);
  const [memoryInput, setMemoryInput] = useState('');
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
      try { return new Set(JSON.parse(window.localStorage.getItem('mirabilis-pinned-chats') || '[]')); } catch { return new Set(); }
    }
    return new Set();
  });
  const [temperature, setTemperature] = useState(() => {
    if (typeof window !== 'undefined') {
      const v = window.localStorage.getItem('mirabilis-temperature');
      return v === null ? null : Number(v);
    }
    return null;
  });
  const [maxTokens, setMaxTokens] = useState(() => {
    if (typeof window !== 'undefined') {
      const v = window.localStorage.getItem('mirabilis-max-tokens');
      return v === null ? null : Number(v);
    }
    return null;
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

  const selectedMcpServer = useMemo(
    () => mcpServers.find((item) => item.id === mcpSelectedServerId) || null,
    [mcpServers, mcpSelectedServerId]
  );

  const selectedModelRecord = useMemo(() => models.find((item) => item.id === model) || null, [model, models]);
  const shouldShowModelChip = useMemo(
    () => provider === 'ollama' || provider === 'openai-compatible' || provider === 'koboldcpp' || models.length > 0,
    [provider, models.length]
  );

  useEffect(() => {
    const savedThemeMode = window.localStorage.getItem('local-ai-theme-mode');
    const savedModel = window.localStorage.getItem('local-ai-model');
    const savedPrompt = window.localStorage.getItem('local-ai-system-prompt');
    const savedDeepWeb = window.localStorage.getItem('local-ai-deep-web-enabled');
    const savedCanvasEnabled = window.localStorage.getItem('local-ai-canvas-enabled');
    const savedCanvasText = window.localStorage.getItem('local-ai-canvas-text');
    const savedGuided = window.localStorage.getItem('local-ai-guided-learning-enabled');
    const savedDeepThinking = window.localStorage.getItem('local-ai-deep-thinking-enabled');
    const savedTrainingMode = window.localStorage.getItem('local-ai-training-mode');
    const savedPersonalMemory = window.localStorage.getItem('local-ai-use-personal-memory');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    setSystemPrefersDark(prefersDark);
    if (savedThemeMode === 'light' || savedThemeMode === 'dark' || savedThemeMode === 'auto') {
      setThemeMode(savedThemeMode);
    }
    if (savedModel) {
      setModel(savedModel);
    }
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
    if (
      savedPrompt === 'You are a concise and helpful local assistant.' ||
      (savedPrompt != null && savedPrompt.startsWith('You are Mirabilis AI, a concise and helpful assistant running locally in this app'))
    ) {
      setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
    } else if (savedPrompt) {
      setSystemPrompt(savedPrompt);
    }
  }, []);

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
    window.localStorage.setItem('mirabilis-voice-uri', selectedVoiceUri || '');
  }, [selectedVoiceUri]);

  useEffect(() => {
    window.localStorage.setItem('mirabilis-auto-speak', autoSpeakEnabled ? 'true' : 'false');
  }, [autoSpeakEnabled]);

  useEffect(() => {
    window.localStorage.setItem('mirabilis-provider', provider);
  }, [provider]);

  useEffect(() => {
    if (provider === 'ollama') return;
    let cancelled = false;

    (async () => {
      try {
        const cfgBase = String(providerConfigs?.[provider]?.baseUrl || '').trim();
        const query = new URLSearchParams({ provider });
        if (cfgBase) query.set('baseUrl', cfgBase);
        const health = await api(`/api/providers/health?${query.toString()}`);
        if (cancelled) return;
        if (!health?.reachable) {
          const ollama = await api('/api/providers/health?provider=ollama');
          if (!cancelled && ollama?.reachable) {
            setProvider('ollama');
            setStatusText('Selected provider is down. Automatically switched to Ollama.');
          }
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
    window.localStorage.setItem('mirabilis-provider-configs', JSON.stringify(providerConfigs));
  }, [providerConfigs]);

  useEffect(() => {
    window.localStorage.setItem('mirabilis-openclaw', openClawMode ? 'true' : 'false');
  }, [openClawMode]);

  useEffect(() => {
    window.localStorage.setItem('mirabilis-voice-rate', String(voiceRate));
  }, [voiceRate]);

  useEffect(() => {
    window.localStorage.setItem('mirabilis-voice-pitch', String(voicePitch));
  }, [voicePitch]);

  useEffect(() => {
    window.localStorage.setItem('mirabilis-voice-engine', voiceEngine);
  }, [voiceEngine]);

  useEffect(() => {
    window.localStorage.setItem('mirabilis-piper-model', selectedPiperModelId || '');
  }, [selectedPiperModelId]);

  useEffect(() => {
    window.localStorage.setItem('mirabilis-pinned-chats', JSON.stringify(Array.from(pinnedChatIds)));
  }, [pinnedChatIds]);

  useEffect(() => {
    if (temperature === null) window.localStorage.removeItem('mirabilis-temperature');
    else window.localStorage.setItem('mirabilis-temperature', String(temperature));
  }, [temperature]);

  useEffect(() => {
    if (maxTokens === null) window.localStorage.removeItem('mirabilis-max-tokens');
    else window.localStorage.setItem('mirabilis-max-tokens', String(maxTokens));
  }, [maxTokens]);

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

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event) => setSystemPrefersDark(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    setDictationSupported(Boolean(SpeechRecognitionCtor));

    return () => {
      if (speechRecognitionRef.current) {
        speechRecognitionRef.current.onend = null;
        speechRecognitionRef.current.onerror = null;
        speechRecognitionRef.current.onresult = null;
        speechRecognitionRef.current.stop();
      }
    };
  }, []);

  useEffect(() => {
    const applyDark = themeMode === 'dark' || (themeMode === 'auto' && systemPrefersDark);
    document.documentElement.classList.toggle('dark', applyDark);
    window.localStorage.setItem('local-ai-theme-mode', themeMode);
  }, [themeMode, systemPrefersDark]);

  useEffect(() => {
    if (uiFont === 'jakarta') {
      document.documentElement.removeAttribute('data-font');
    } else {
      document.documentElement.setAttribute('data-font', uiFont);
    }
    window.localStorage.setItem('mirabilis-font', uiFont);
  }, [uiFont]);

  useEffect(() => {
    if (colorScheme === 'mirabilis') {
      document.documentElement.removeAttribute('data-color-scheme');
    } else {
      document.documentElement.setAttribute('data-color-scheme', colorScheme);
    }
    window.localStorage.setItem('mirabilis-color-scheme', colorScheme);
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

  useEffect(() => {
    window.localStorage.setItem('local-ai-model', model);
  }, [model]);

  useEffect(() => {
    window.localStorage.setItem('local-ai-system-prompt', systemPrompt);
  }, [systemPrompt]);

  useEffect(() => {
    window.localStorage.setItem('local-ai-deep-web-enabled', String(deepWebEnabled));
    if (!deepWebEnabled) setWebSearchStatus('idle');
  }, [deepWebEnabled]);

  useEffect(() => {
    window.localStorage.setItem('local-ai-canvas-enabled', String(canvasEnabled));
  }, [canvasEnabled]);

  useEffect(() => {
    window.localStorage.setItem('local-ai-canvas-text', canvasText);
  }, [canvasText]);

  useEffect(() => {
    window.localStorage.setItem('local-ai-guided-learning-enabled', String(guidedLearningEnabled));
  }, [guidedLearningEnabled]);

  useEffect(() => {
    window.localStorage.setItem('local-ai-deep-thinking-enabled', String(deepThinkingEnabled));
  }, [deepThinkingEnabled]);

  useEffect(() => {
    window.localStorage.setItem('local-ai-training-mode', trainingMode);
  }, [trainingMode]);

  useEffect(() => {
    window.localStorage.setItem('local-ai-use-personal-memory', String(usePersonalMemory));
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
          body: JSON.stringify({ title: 'New Chat', uncensoredMode })
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

  function toggleDictation() {
    if (!dictationSupported) {
      setStatusText('Dictation is not supported in this browser.');
      return;
    }

    if (isDictating && speechRecognitionRef.current) {
      speechRecognitionRef.current.stop();
      return;
    }

    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setStatusText('Dictation is not supported in this browser.');
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    dictationBaseRef.current = input && !input.endsWith(' ') ? `${input} ` : input;
    dictationFinalRef.current = '';

    recognition.onstart = () => {
      setIsDictating(true);
      setStatusText('Dictation on...');
    };

    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const segment = event.results[i][0]?.transcript || '';
        if (event.results[i].isFinal) {
          finalText += segment.endsWith(' ') ? segment : `${segment} `;
        } else {
          interimText += segment;
        }
      }

      if (finalText) {
        dictationFinalRef.current += finalText;
      }

      setInput(`${dictationBaseRef.current}${dictationFinalRef.current}${interimText}`);
    };

    recognition.onerror = (event) => {
      setStatusText(`Dictation error: ${event.error || 'unknown'}`);
    };

    recognition.onend = () => {
      setIsDictating(false);
      speechRecognitionRef.current = null;
      setStatusText('Ready');
    };

    speechRecognitionRef.current = recognition;
    recognition.start();
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
    // Bail out if clearAllChats() ran while we were awaiting — would resurrect deleted chats
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
    setMessages(payload.chat?.messages || []);
    setUncensoredMode(payload.chat?.uncensoredMode === true);
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

  async function createChat() {
    const payload = await api('/api/chats', {
      method: 'POST',
      body: JSON.stringify({ title: 'New Chat', uncensoredMode })
    });
    setChatSearch('');
    await refreshChats();
    await loadChat(payload.chat.id);
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
      setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
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
      setMessages([]);
    }
    await refreshChats();
  }

  async function clearAllChats() {
    // Abort stream first — otherwise the post-stream saveChat fires after the
    // DELETE and immediately re-adds the last chat (intermittent "comes back" bug)
    stopStreaming();
    chatListEpochRef.current++; // invalidate any in-flight refreshChats() calls
    // Clear UI immediately — don't wait for the network roundtrip
    setActiveChatId(null);
    setMessages([]);
    setChats([]);
    setChatSearch('');
    // Then flush to backend (fire and forget error — UI is already clear)
    try {
      await api('/api/chats', { method: 'DELETE' });
    } catch {
      // ignore — UI is already empty
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

  async function exportChat(chatId) {
    try {
      const payload = await api(`/api/chats/${chatId}`);
      const chat = payload.chat;
      const lines = [`# ${chat.title}\n`];
      for (const msg of chat.messages || []) {
        const role = msg.role === 'user' ? 'You' : 'Assistant';
        const time = msg.createdAt ? new Date(msg.createdAt).toLocaleString() : '';
        lines.push(`## ${role}${time ? ` — ${time}` : ''}\n`);
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
      if (provider !== 'ollama') {
        const baseUrl = String(providerConfigs?.[provider]?.baseUrl || '').trim();
        const apiKey = String(providerConfigs?.[provider]?.apiKey || '').trim();
        if (baseUrl) query.set('baseUrl', baseUrl);
        if (provider === 'openai-compatible' && apiKey) query.set('apiKey', apiKey);
      }
      const payload = await api(`/api/models?${query.toString()}`);
      const available = payload.models || [];
      setModels(available);
      // If current model is 'auto', no override needed — it resolves at send time.
      // Only fall back if the explicitly chosen model is no longer installed.
      setModel((currentModel) => {
        if (currentModel === 'auto') return 'auto';
        const stillInstalled = available.some((item) => item.id === currentModel && item.available !== false);
        if (stillInstalled) return currentModel;
        // Model was removed — fall back to auto
        return 'auto';
      });
    } catch {
      setModels([]);
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

    async function fallbackToOllama(reason) {
      try {
        const ollamaHealth = await api('/api/providers/health?provider=ollama');
        if (ollamaHealth?.reachable) {
          setProvider('ollama');
          setStatusText(`Selected provider unavailable. Switched to Ollama. ${reason || ''}`.trim());
          const forcedUncensored = uncensoredMode ? pickMostUncensoredModel(models) : null;
          const effectiveModel = forcedUncensored?.id || model;
          if (uncensoredMode && forcedUncensored?.id && model !== forcedUncensored.id) {
            setModel(forcedUncensored.id);
          }
          return { provider: 'ollama', model: effectiveModel, providerBaseUrl: undefined, providerApiKey: undefined };
        }
      } catch {
        // ignore fallback probe errors
      }
      return null;
    }

    const configuredBaseUrl = String(providerConfigs[provider]?.baseUrl || '').trim();
    const query = new URLSearchParams({ provider });
    if (configuredBaseUrl) {
      query.set('baseUrl', configuredBaseUrl);
    }

    try {
      const payload = await api(`/api/providers/health?${query.toString()}`);
      if (payload?.reachable) {
        return {
          provider,
          model,
          providerBaseUrl: providerConfigs[provider]?.baseUrl || undefined,
          providerApiKey: providerConfigs[provider]?.apiKey || undefined
        };
      }

      const hint = payload?.hint ? ` ${payload.hint}` : '';
      const target = payload?.baseUrl || configuredBaseUrl || 'configured endpoint';
      const fallback = await fallbackToOllama(`Provider check failed for ${target}.${hint}`);
      if (fallback) return fallback;
      setStatusText(`Provider check warning: ${target} is unreachable.${hint}`);
      return {
        provider,
        model,
        providerBaseUrl: providerConfigs[provider]?.baseUrl || undefined,
        providerApiKey: providerConfigs[provider]?.apiKey || undefined
      };
    } catch (error) {
      const fallback = await fallbackToOllama(`Provider check error: ${error.message}`);
      if (fallback) return fallback;
      setStatusText(`Provider check failed: ${error.message}`);
      return {
        provider,
        model,
        providerBaseUrl: providerConfigs[provider]?.baseUrl || undefined,
        providerApiKey: providerConfigs[provider]?.apiKey || undefined
      };
    }
  }

  function cancelInstall(modelId) {
    setPullingModels((prev) => {
      if (prev[modelId]?.ctrl) prev[modelId].ctrl.abort();
      const n = { ...prev };
      delete n[modelId];
      return n;
    });
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
    setPullingModels((prev) => ({ ...prev, [modelId]: { pct: null, status: 'Connecting…', ctrl } }));
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/models/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: ollamaId }),
          signal: ctrl.signal
        });
        if (!res.ok || !res.body) throw new Error('Pull request failed');
        const reader = res.body.getReader();
        const dec = new TextDecoder('utf8');
        let buf = '';
        let currentEvent = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue; }
            if (!line.startsWith('data: ')) continue;
            try {
              const payload = JSON.parse(line.slice(6));
              if (currentEvent === 'done' || payload.modelId) {
                setPullingModels((prev) => { const n = { ...prev }; delete n[modelId]; return n; });
                await refreshModels();
              } else if (currentEvent === 'error') {
                setPullingModels((prev) => { const n = { ...prev }; delete n[modelId]; return n; });
                setStatusText(`Model install failed: ${payload.message || 'unknown error'}`);
              } else {
                setPullingModels((prev) => ({
                  ...prev,
                  [modelId]: { pct: payload.pct ?? null, status: payload.status || '', ctrl }
                }));
              }
            } catch { /* skip malformed lines */ }
            currentEvent = '';
          }
        }
      } catch {
        setPullingModels((prev) => { const n = { ...prev }; delete n[modelId]; return n; });
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
      setOpenChatMenuId(null);
    }

    const anyDropdownOpen = isProviderMenuOpen || isProviderConfigOpen || isModelMenuOpen || isTrainingMenuOpen || isToolsMenuOpen ||
      isVoiceMenuOpen || isContextPanelOpen || isEngineMenuOpen ||
      openHardwarePopover !== null || isControlPanelOpen || isMcpPanelOpen || isParamsPanelOpen;

    const activeMenuKey = isProviderMenuOpen
      ? 'provider'
      : isModelMenuOpen
      ? 'model'
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
    // Hardware profile is cached server-side after first call — no need to re-poll.
    const interval = setInterval(() => {
      checkImageService();
    }, 30000);
    // Poll utilization every 15 s (backend caches at 3 s, so no benefit polling faster)
    const utilInterval = setInterval(fetchUtilization, 15000);
    return () => { clearInterval(interval); clearInterval(utilInterval); };
  }, []);

  useEffect(() => {
    refreshModels();
  }, [provider]);

  // Global keyboard shortcuts: Ctrl+K / Cmd+K → new chat
  useEffect(() => {
    function handleShortcuts(e) {
      const ctrlOrCmd = e.metaKey || e.ctrlKey;
      if (ctrlOrCmd && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        shortcutRef.current.createChat?.();
      }
    }
    document.addEventListener('keydown', handleShortcuts);
    return () => document.removeEventListener('keydown', handleShortcuts);
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
    window.localStorage.setItem('mirabilis-engine-option', selectedEngine);
  }, [selectedEngine]);

  // Auto-scroll to bottom while streaming new tokens — throttled to one rAF per frame.
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
  }, [messages, isStreaming]); // ref-based guard — autoScrollEnabled state not needed in deps

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

  async function handleImageGeneration(content) {
    setInput('');
    setIsStreaming(true);
    setStatusText('Generating image on your device...');

    let chatId = activeChatId;
    if (!chatId) {
      const payload = await api('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ title: content.slice(0, 40), uncensoredMode })
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
      // Service offline — show a helpful local message, do NOT route to LLM
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
      // Temp ID not on server (e.g. message from a failed/aborted stream) — don't patch
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

    setInput('');

    let outboundContent = content;

    const behaviorInstructions = [];
    if (guidedLearningEnabled) {
      behaviorInstructions.push(
        'Teaching mode: Explain with a short, structured learning path.',
        'Ask one clarifying question if needed, then provide step-by-step guidance.',
        'Use examples and a tiny recap at the end.'
      );
    }
    if (deepThinkingEnabled) {
      behaviorInstructions.push(
        'Deep thinking mode: reason carefully, compare alternatives, and include key trade-offs.',
        'Provide a concise executive answer first, then details.'
      );
    }
    if (behaviorInstructions.length > 0) {
      outboundContent = [content, '', ...behaviorInstructions].join('\n');
    }

    // Inject remote control awareness when connected
    if (remoteConnected) {
      const disclaimer = [
        `Remote Control is active. Target: ${remoteTarget}.`,
        'When suggesting shell/terminal commands, wrap them in a fenced code block with language "bash" or "sh".',
        'The user can execute them on the target with a single click.',
        'Do not auto-execute anything — always present and explain the command first.'
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
          // Search succeeded but no results — treat as soft error
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

    const resolvedProvider = await resolveProviderForSend();

    setStatusText('Streaming response...');

    let chatId = activeChatId;
    if (!chatId) {
      const payload = await api('/api/chats', {
        method: 'POST',
        body: JSON.stringify({ title: 'New Chat', uncensoredMode })
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

    try {
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      const outboundSystemPrompt = uncensoredMode ? '' : systemPrompt;
      const outboundUsePersonalMemory = uncensoredMode ? false : usePersonalMemory;
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
          ...(temperature !== null && isFinite(temperature) ? { temperature } : {}),
          ...(maxTokens !== null && isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
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

          const payload = JSON.parse(dataText);

          if (event === 'token') {
            setMessages((prev) => {
              const next = [...prev];
              if (next.length === 0) {
                return next;
              }
              const last = next[next.length - 1];
              if (last.role === 'assistant') {
                const nextContent = `${last.content}${payload.token || ''}`;
                next[next.length - 1] = {
                  ...last,
                  content: nextContent,
                  tokenEstimate: estimateTokens(nextContent)
                };
              }
              return next;
            });
          }

          if (event === 'error') {
            throw new Error(payload.error || 'Streaming error');
          }

          if (event === 'done') {
            setMessages((prev) => {
              const next = [...prev];
              if (next.length > 0) {
                next[next.length - 1] = payload.message;
              }
              return next;
            });
            if (autoSpeakEnabled && payload?.message?.role === 'assistant') {
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
      setStatusText('Ready');
    } catch (error) {
      if (error?.name === 'AbortError') {
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
      streamAbortRef.current = null;
      setIsStreaming(false);
    }
  }

  // Always keep shortcut ref in sync with latest createChat (avoids stale closure in keydown handler)
  shortcutRef.current.createChat = createChat;

  return (
    <main className="relative h-screen w-screen p-3 sm:p-6">
      <div className="mx-auto flex h-full max-w-7xl gap-3 rounded-3xl border border-[var(--panel-border)] bg-[var(--panel)] p-3 shadow-[0_24px_90px_-36px_rgba(15,23,42,0.45)] backdrop-blur-xl sm:gap-5 sm:p-5">
        <aside className="flex w-28 shrink-0 flex-col gap-3 rounded-2xl border border-[var(--panel-border)] bg-white/65 p-2 dark:bg-slate-950/45 sm:w-72 sm:p-4">
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
          </div>

          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={createChat}
              className="rounded-full bg-accent px-2 py-1.5 text-xs font-semibold text-white shadow-[0_10px_24px_-14px_rgba(26,168,111,0.9)] transition hover:brightness-95"
            >
              New Chat
            </button>
            <button
              onClick={deleteLastChat}
              disabled={chats.length === 0}
              className="rounded-full border border-black/10 px-2 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
              title={activeChatId ? 'Delete current chat' : 'Delete most recent chat'}
            >
              {activeChatId ? 'Delete' : 'Delete Last'}
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
          <div className="space-y-2">
            <label className="block text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-300">
              Instructions
            </label>
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              rows={3}
              className="w-full rounded-lg border border-black/10 bg-white/80 px-2 py-2 text-xs dark:border-white/20 dark:bg-slate-800"
            />
          </div>
          )}

          <div className="mb-2 mt-2">
            <input
              type="text"
              autoComplete="off"
              placeholder="Search chats…"
              value={chatSearch}
              onChange={(e) => setChatSearch(e.target.value)}
              className="w-full rounded-xl border border-black/10 bg-white/80 px-2.5 py-1.5 text-xs outline-none placeholder:text-slate-400 focus:border-accent dark:border-white/20 dark:bg-slate-900/60 dark:placeholder:text-slate-500"
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
                  onDelete={removeChat}
                  onRename={renameChat}
                  onExport={exportChat}
                  onTogglePin={togglePin}
                />
              ))}
              {sortedAndFilteredChats.length === 0 && (
                <li className="rounded-lg border border-dashed border-black/20 p-3 text-xs text-slate-500">
                  {chatSearch.trim() ? 'No chats match your search.' : 'No chats yet.'}
                </li>
              )}
            </ul>
          </div>

          <div className="space-y-1.5">
            <label className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-300 sm:text-xs">
              Appearance
            </label>

            <div className="space-y-1">
              <div className="text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-slate-300">Theme</div>
              <div className="grid grid-cols-3 gap-0.5 rounded-full border border-black/10 bg-white/80 p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-white/15 dark:bg-slate-900/85">
                {[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                  { value: 'auto', label: 'System' },
                ].map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => setThemeMode(value)}
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.01em] transition ${
                      themeMode === value
                        ? 'bg-ink text-white shadow-[0_1px_2px_rgba(15,23,42,0.18)] dark:bg-accent'
                        : 'text-slate-600 hover:bg-black/5 dark:text-slate-300 dark:hover:bg-white/10'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-slate-300">Font</div>
              <div className="grid grid-cols-3 gap-0.5 rounded-full border border-black/10 bg-white/80 p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-white/15 dark:bg-slate-900/85">
                {[
                  { id: 'jakarta', label: 'Jakarta', style: { fontFamily: 'var(--font-ui), sans-serif' } },
                  { id: 'system', label: 'System', style: { fontFamily: "-apple-system, 'Helvetica Neue', sans-serif" } },
                  { id: 'tahoma', label: 'Tahoma', style: { fontFamily: 'Tahoma, Geneva, sans-serif' } },
                ].map(({ id, label, style }) => (
                  <button
                    key={id}
                    onClick={() => setUiFont(id)}
                    style={style}
                    className={`rounded-full px-1.5 py-0.5 text-[10px] transition ${
                      uiFont === id
                        ? 'border border-accent bg-accentSoft font-semibold text-ink dark:border-accent/60 dark:bg-accent/20 dark:text-accent'
                        : 'border border-transparent text-slate-600 hover:bg-black/5 dark:text-slate-300 dark:hover:bg-white/10'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-slate-300">Palette</div>
              <div className="grid grid-cols-4 gap-0.5 rounded-full border border-black/10 bg-white/80 p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-white/15 dark:bg-slate-900/85">
                {[
                  { id: 'mirabilis', label: 'Mirabilis' },
                  { id: 'arctic',    label: 'Arctic' },
                  { id: 'ember',     label: 'Ember' },
                  { id: 'summit',    label: 'Summit' },
                ].map(({ id, label }) => (
                  <button
                    key={id}
                    onClick={() => setColorScheme(id)}
                    className={`rounded-full px-1.5 py-0.5 text-[10px] transition ${
                      colorScheme === id
                        ? 'border border-accent bg-accentSoft font-semibold text-ink dark:border-accent/60 dark:bg-accent/20 dark:text-accent'
                        : 'border border-transparent text-slate-600 hover:bg-black/5 dark:text-slate-300 dark:hover:bg-white/10'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>

        <section
          className={`relative flex min-w-0 flex-1 flex-col rounded-2xl border p-3 sm:p-5 ${
            isDragOverChat
              ? 'border-accent bg-accentSoft/35 dark:bg-accent/10'
              : 'border-[var(--panel-border)] bg-white/72 dark:bg-slate-950/40'
          }`}
          onDragEnter={handleChatDragEnter}
          onDragOver={handleChatDragOver}
          onDragLeave={handleChatDragLeave}
          onDrop={handleChatDrop}
        >
          {isDragOverChat && (
            <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-white/75 dark:bg-slate-900/75">
              <div className="rounded-full border border-accent/40 bg-accentSoft px-4 py-2 text-sm font-semibold text-ink dark:bg-accent/20 dark:text-white">
                Drop files to attach
              </div>
            </div>
          )}
          <header className="mb-3 border-b border-black/10 pb-3 dark:border-white/10">
            <div className="flex items-baseline justify-between gap-2">
              <p className="shrink-0 font-mono text-xs text-slate-500 dark:text-slate-300">{statusText}</p>
              <p className="truncate font-mono text-[11px] text-slate-400 dark:text-slate-400">
                input {formatTokenCount(chatTokenSummary.input)} · output {formatTokenCount(chatTokenSummary.output)}
              </p>
            </div>

            <div className="mt-1.5 flex flex-nowrap items-center gap-1.5">

                {/* hardware chips — left */}
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
                  return (
                    <div key={key} data-menu-container="true" className="relative">
                      <button
                        type="button"
                        data-menu-trigger={`hardware-${key}`}
                        onClick={() => {
                          setIsContextPanelOpen(false);
                          setIsEngineMenuOpen(false);
                          setIsVoiceMenuOpen(false);
                          setOpenHardwarePopover((current) => (current === key ? null : key));
                        }}
                        className={`relative inline-flex items-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide transition hover:bg-black/5 dark:hover:bg-white/10 ${
                          isActive
                            ? 'border-green-400/60 bg-green-50/80 text-green-700 dark:border-green-500/40 dark:bg-green-900/20 dark:text-green-400'
                            : 'border-black/10 bg-white/80 text-slate-600 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-300'
                        }`}
                        title={item.expanded || item.label}
                      >
                        {fillPct > 0 && !isActive && (
                          <span
                            aria-hidden="true"
                            className={`pointer-events-none absolute inset-y-0 left-0 rounded-full transition-all duration-700 ${fillColor}`}
                            style={{ width: `${fillPct}%` }}
                          />
                        )}
                        <span className="relative">{item.label}</span>
                      </button>
                      {openHardwarePopover === key && item.expanded ? (
                        <div data-menu-panel={`hardware-${key}`} role="menu" tabIndex={-1} className="absolute left-0 top-full z-20 mt-2 w-72 rounded-xl border border-black/10 bg-white/95 p-2 text-[11px] text-slate-600 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-900/95 dark:text-slate-300">
                          {item.expanded.split('\n').map((line, i) => (
                            <div key={i} className={i === 0 ? 'font-semibold text-slate-800 dark:text-slate-100 mb-1' : 'text-slate-500 dark:text-slate-400'}>{line}</div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}

                {/* web search chip — fixed width so it never grows when searching */}
                <div className="relative">
                <button
                  type="button"
                  onClick={() => setDeepWebEnabled((v) => !v)}
                  title={
                    webSearchStatus === 'error'
                      ? 'Web search failed — results unavailable'
                      : deepWebEnabled
                      ? 'Web search on — click to disable'
                      : 'Web search off — click to enable'
                  }
                  className={`relative inline-flex items-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide transition hover:bg-black/5 dark:hover:bg-white/10 ${
                    webSearchStatus === 'searching'
                      ? 'border-green-400/60 bg-green-50/80 text-green-700 dark:border-green-500/40 dark:bg-green-900/20 dark:text-green-400'
                      : webSearchStatus === 'error'
                      ? 'border-red-400/60 bg-red-50/80 text-red-600 dark:border-red-500/40 dark:bg-red-900/20 dark:text-red-400'
                      : deepWebEnabled
                      ? 'border-black/10 bg-white/80 text-slate-600 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-300'
                      : 'border-black/10 bg-white/80 text-slate-400 opacity-50 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-500'
                  }`}
                >
                  <span className="relative">www</span>
                </button>
                </div>

                {/* context + engine — right */}
                <div className="ml-auto flex flex-nowrap items-center gap-1.5">
                  <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsSystemPromptVisible((v) => !v)}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide transition ${
                      isSystemPromptVisible
                        ? 'border-accent/60 bg-accentSoft text-ink dark:border-accent/40 dark:bg-accent/20 dark:text-green-300'
                        : 'border-black/10 bg-white/80 text-slate-600 hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:bg-white/10'
                    }`}
                    title="Toggle instructions visibility"
                  >
                    <span>Instructions</span>
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
                      className="inline-flex items-center justify-center rounded-full border border-black/10 bg-white/80 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600 transition hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:bg-white/10"
                      title={`Context usage: ${contextUsage.totalTokens.toLocaleString()} / ${contextUsage.windowTokens.toLocaleString()} tokens`}
                    >
                      Context {contextUsage.usedPct}%
                    </button>

                    {isContextPanelOpen && (
                      <div data-menu-panel="context" role="menu" tabIndex={-1} className="absolute right-0 top-full z-20 mt-2 w-72 rounded-xl border border-black/10 bg-white/95 p-2 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Token Limit</span>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400">{contextUsage.usedPct}% used</span>
                        </div>

                        <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                          <div
                            className="h-full rounded-full bg-accent transition-all duration-300"
                            style={{ width: `${Math.min(contextUsage.usedPct, 100)}%` }}
                          />
                        </div>

                        <div className="space-y-1 text-[11px] text-slate-600 dark:text-slate-300">
                          <div className="flex items-center justify-between rounded-lg border border-black/5 bg-white/70 px-2 py-1 dark:border-white/10 dark:bg-slate-800/60">
                            <span>System instructions</span>
                            <span>{contextUsage.systemPct}% · {contextUsage.systemTokens.toLocaleString()} tok</span>
                          </div>
                          <div className="flex items-center justify-between rounded-lg border border-black/5 bg-white/70 px-2 py-1 dark:border-white/10 dark:bg-slate-800/60">
                            <span>User content</span>
                            <span>{contextUsage.userPct}% · {contextUsage.userTokens.toLocaleString()} tok</span>
                          </div>
                          <div className="flex items-center justify-between rounded-lg border border-black/5 bg-white/70 px-2 py-1 dark:border-white/10 dark:bg-slate-800/60">
                            <span>Assistant</span>
                            <span>{contextUsage.uncategorizedPct}% · {contextUsage.uncategorizedTokens.toLocaleString()} tok</span>
                          </div>
                        </div>

                        <div className="mt-2 text-[10px] text-slate-500 dark:text-slate-400">
                          {contextUsage.totalTokens.toLocaleString()} / {contextUsage.windowTokens.toLocaleString()} tokens
                        </div>
                      </div>
                    )}
                  </div>

                  {hardwareProfile.action?.label ? (
                    <div data-menu-container="true" className="relative">
                      <button
                        type="button"
                        data-menu-trigger="engine"
                        onClick={() => {
                          setIsContextPanelOpen(false);
                          setIsVoiceMenuOpen(false);
                          setOpenHardwarePopover(null);
                          setIsEngineMenuOpen((current) => !current);
                        }}
                        className="inline-flex items-center gap-1 rounded-full border border-black/10 bg-white/80 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600 transition hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:bg-white/10"
                        title={selectedEngine ? `Engine: ${selectedEngine}` : 'Engine'}
                      >
                        <span>Engine</span>
                        <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                          <path d="M5.25 7.5L10 12.25 14.75 7.5" />
                        </svg>
                      </button>
                      {isEngineMenuOpen && Array.isArray(hardwareProfile.action.options) && hardwareProfile.action.options.length > 0 ? (
                        <div data-menu-panel="engine" role="menu" tabIndex={-1} className="absolute right-0 top-full z-20 mt-2 min-w-36 rounded-xl border border-black/10 bg-white/95 p-1 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
                          {hardwareProfile.action.options.map((option) => (
                            <button
                              key={option}
                              type="button"
                              onClick={() => {
                                setSelectedEngine(option);
                                setStatusText(`Engine: ${option}`);
                                setIsEngineMenuOpen(false);
                                checkHardwareProfile();
                              }}
                              className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                                selectedEngine === option
                                  ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                                  : 'text-slate-700 hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10'
                              }`}
                            >
                              <span>{option}</span>
                              {selectedEngine === option ? <span className="text-[10px] opacity-70">active</span> : null}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
            </div>
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
                // User scrolled up — pause auto-scroll
                autoScrollRef.current = false;
                setAutoScrollEnabled(false);
              } else if (atBottom) {
                // User reached bottom — resume auto-scroll
                autoScrollRef.current = true;
                setAutoScrollEnabled(true);
              }
            }}
            className="flex-1 overflow-y-auto scroll-thin"
          >
            <div className="mx-auto w-full max-w-3xl space-y-3 pr-1">
            {canvasEnabled && (
              <section className="rounded-2xl border border-black/10 bg-white/80 p-3 dark:border-white/10 dark:bg-slate-900/50">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Canvas</h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCanvasText('')}
                      className="rounded-md border border-black/10 px-2 py-1 text-[11px] text-slate-600 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-300 dark:hover:bg-white/10"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={() => setCanvasEnabled(false)}
                      className="rounded-md border border-black/10 px-2 py-1 text-[11px] text-slate-600 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-300 dark:hover:bg-white/10"
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
                  className="w-full resize-y rounded-xl border border-black/10 bg-white/90 px-3 py-2 text-sm outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
                />
              </section>
            )}

            {messages.length === 0 && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
                <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">
                  {activeChatId ? 'New Conversation' : 'Welcome to Mirabilis AI'}
                </h2>
                <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
                  {activeChatId ? 'Type a message below to get started.' : 'Select a model, then start a new conversation.'}
                </p>
                {!activeChatId && (
                  <button
                    type="button"
                    onClick={createChat}
                    className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white shadow-[0_10px_24px_-14px_rgba(26,168,111,0.9)] transition hover:brightness-95"
                  >
                    Start a chat
                  </button>
                )}
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
            <section className="mt-3 rounded-2xl border border-black/10 bg-white/80 p-3 dark:border-white/10 dark:bg-slate-900/50">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Personal Memory</h3>
                <button
                  type="button"
                  onClick={() => setIsTeachPanelOpen(false)}
                  className="rounded-md border border-black/10 px-2 py-1 text-[11px] text-slate-600 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-300 dark:hover:bg-white/10"
                >
                  Close
                </button>
              </div>
              <p className="mb-2 text-[11px] text-slate-500 dark:text-slate-400">
                These notes are injected as context into every conversation when memory is enabled.
              </p>
              <div className="mb-2 flex gap-2">
                <input
                  type="text"
                  value={memoryInput}
                  onChange={(e) => setMemoryInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMemoryItem(); } }}
                  placeholder="Add a memory (e.g. I prefer concise answers)"
                  className="flex-1 rounded-xl border border-black/10 bg-white/90 px-3 py-1.5 text-xs outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
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
                <p className="text-[11px] text-slate-400 dark:text-slate-500">No memories yet.</p>
              ) : (
                <ul className="max-h-48 space-y-1 overflow-y-auto scroll-thin">
                  {memoryItems.map((item) => (
                    <li key={item.id} className="flex items-start justify-between gap-2 rounded-lg border border-black/5 bg-white/70 px-2 py-1.5 dark:border-white/10 dark:bg-slate-800/60">
                      <span className="flex-1 text-[11px] text-slate-700 dark:text-slate-200">{item.text}</span>
                      <button
                        type="button"
                        onClick={() => deleteMemoryItem(item.id)}
                        className="shrink-0 rounded px-1 text-[10px] text-slate-400 transition hover:text-red-500"
                        title="Remove"
                      >✕</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <footer className="mt-3 border-t border-black/10 pt-3 dark:border-white/10">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
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
                      setIsProviderMenuOpen((prev) => !prev);
                      setIsProviderConfigOpen(false);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-white/10"
                    title="Choose provider"
                  >
                    <span className="max-w-[9rem] truncate">{PROVIDER_OPTIONS.find((opt) => opt.id === provider)?.label || provider}</span>
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                      <path d="M5.25 7.5L10 12.25 14.75 7.5" />
                    </svg>
                  </button>

                  {isProviderMenuOpen && (
                    <div data-menu-panel="provider" role="menu" tabIndex={-1} className="absolute bottom-9 left-0 z-20 min-w-48 rounded-xl border border-black/10 bg-white/95 p-1 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
                      {PROVIDER_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => {
                            setProvider(opt.id);
                            setIsProviderMenuOpen(false);
                            setStatusText(`Provider: ${opt.label}`);
                            if (opt.id !== 'ollama' && !String(providerConfigs[opt.id]?.baseUrl || '').trim()) {
                              setIsProviderConfigOpen(true);
                            }
                          }}
                          className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition ${
                            provider === opt.id
                              ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                              : 'text-slate-700 hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10'
                          }`}
                        >
                          <span>{opt.label}</span>
                          {provider === opt.id ? <span className="text-[10px] opacity-70">active</span> : null}
                        </button>
                      ))}
                      {provider !== 'ollama' && (
                        <button
                          type="button"
                          onClick={() => {
                            setIsProviderMenuOpen(false);
                            setIsProviderConfigOpen(true);
                          }}
                          className="mt-1 flex w-full items-center justify-between rounded-lg border-t border-black/10 px-2 py-1.5 text-left text-xs text-slate-600 transition hover:bg-black/5 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/10"
                        >
                          <span>Configure endpoint</span>
                          <span className="opacity-60">...</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Provider config panel */}
                {provider !== 'ollama' && isProviderConfigOpen && (
                  <div data-menu-container="true" className="absolute bottom-12 left-0 z-30 w-96 rounded-xl border border-black/10 bg-white/95 p-3 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
                    <p className="mb-1 text-xs font-semibold text-slate-700 dark:text-slate-200">
                      {PROVIDER_OPTIONS.find((o) => o.id === provider)?.label}
                    </p>
                    {provider === 'koboldcpp' && (
                      <p className="mb-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                        ⚠ KoboldCpp is a <strong>separate app</strong> you must install &amp; run on your machine. It is not included in Mirabilis. Once running, enter its URL below.
                      </p>
                    )}
                    {provider === 'openai-compatible' && (
                      <p className="mb-2 rounded-lg bg-blue-50 px-2 py-1.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        ℹ Point to any OpenAI-compatible local server (LM Studio, llama.cpp, Oobabooga, etc.) or a cloud API that requires a key.
                      </p>
                    )}
                    <label className="mb-1 block text-[11px] text-slate-500 dark:text-slate-400">Base URL</label>
                    <input
                      type="text"
                      className="mb-2 w-full rounded-lg border border-black/10 bg-white px-2 py-1 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-accentSoft dark:border-white/10 dark:bg-slate-800 dark:text-slate-100"
                      placeholder={provider === 'koboldcpp' ? 'http://127.0.0.1:5001/v1' : 'http://127.0.0.1:1234/v1'}
                      value={providerConfigs[provider]?.baseUrl || ''}
                      onChange={(e) => setProviderConfigs((prev) => ({ ...prev, [provider]: { ...prev[provider], baseUrl: e.target.value } }))}
                    />
                    {provider === 'openai-compatible' && (
                      <>
                        <label className="mb-1 block text-[11px] text-slate-500 dark:text-slate-400">API Key <span className="opacity-60">(leave empty for local servers)</span></label>
                        <input
                          type="password"
                          className="mb-2 w-full rounded-lg border border-black/10 bg-white px-2 py-1 text-xs text-slate-800 outline-none focus:ring-1 focus:ring-accentSoft dark:border-white/10 dark:bg-slate-800 dark:text-slate-100"
                          placeholder="sk-... (optional for local)"
                          value={providerConfigs[provider]?.apiKey || ''}
                          onChange={(e) => setProviderConfigs((prev) => ({ ...prev, [provider]: { ...prev[provider], apiKey: e.target.value } }))}
                        />
                      </>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => { setProvider('ollama'); setIsProviderConfigOpen(false); setStatusText('Switched back to Ollama'); }}
                        className="flex-1 rounded-lg border border-black/10 px-2 py-1 text-xs text-slate-600 transition hover:bg-black/5 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/10"
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
                <div data-menu-container="true" className="relative">
                  <button
                    type="button"
                    data-menu-trigger="model"
                    onClick={() => { setIsProviderMenuOpen(false); setIsTrainingMenuOpen(false); setIsToolsMenuOpen(false); setIsControlPanelOpen(false); setIsMcpPanelOpen(false); setOpenHardwarePopover(null); setIsEngineMenuOpen(false); setIsVoiceMenuOpen(false); setIsModelMenuOpen((prev) => !prev); }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-white/10"
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
                  <div data-menu-panel="model" role="menu" tabIndex={-1} className="absolute bottom-9 left-0 z-20 max-h-96 w-80 overflow-y-auto rounded-xl border border-black/10 bg-white/95 p-1 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
                      {models.length > 0 ? (
                        <>
                        {/* Auto mode entry — no group header, divider separates it from model groups */}
                        <div className="group/row relative flex items-center">
                          <button
                            type="button"
                            onClick={() => { setModel('auto'); setIsModelMenuOpen(false); }}
                            className={`flex min-w-0 flex-1 items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition ${
                              model === 'auto'
                                ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                                : 'font-medium text-slate-800 hover:bg-black/5 dark:text-slate-100 dark:hover:bg-white/10'
                            }`}
                          >
                            <span className="flex min-w-0 items-center gap-1.5 truncate">
                              {model === 'auto'
                                ? <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                                : <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />}
                              <span className="truncate font-semibold">Auto</span>
                            </span>
                            <span className="ml-2 shrink-0 text-[10px] text-slate-400 dark:text-slate-500">
                              {pickBestAutoModel(models) ? `→ ${pickBestAutoModel(models).label}` : 'no model installed'}
                            </span>
                          </button>
                        </div>
                        <div className="my-1 border-t border-black/10 dark:border-white/10" />
                        {Array.from(new Set(models.map((item) => item.group || 'Models'))).map((group) => (
                          <div key={group} className="mb-1 last:mb-0">
                            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{group}</div>
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
                                        setStatusText('Model not available in this endpoint yet. Add GGUF to mirabilis/models or load it in the provider runtime.');
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
                                      ? 'font-medium text-slate-800 hover:bg-black/5 dark:text-slate-100 dark:hover:bg-white/10'
                                      : 'text-slate-400 hover:bg-black/5 dark:text-slate-500 dark:hover:bg-white/5'
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
                                      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600" />
                                    )}
                                    <span className="truncate">
                                      {item.label}
                                    </span>
                                  </span>
                                  {pulling ? (
                                    <div className="flex shrink-0 items-center gap-1.5">
                                      {pulling.pct !== null && (
                                        <div className="h-1 w-16 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                                          <div
                                            className="h-full rounded-full bg-accent transition-all duration-300"
                                            style={{ width: `${pulling.pct}%` }}
                                          />
                                        </div>
                                      )}
                                      <span className="animate-pulse text-[10px] text-accent">
                                        {pulling.pct !== null ? `${pulling.pct}%` : '…'}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); cancelInstall(item.id); }}
                                        className="ml-0.5 rounded px-1 text-[10px] text-red-400 hover:text-red-600"
                                        title="Cancel install"
                                      >✕</button>
                                    </div>
                                  ) : (
                                    <span className="ml-2 shrink-0 text-[10px] text-slate-400 dark:text-slate-500">
                                      {isInstalled
                                        ? (item.paramSize || '')
                                        : provider === 'ollama'
                                          ? (item.size || '+ install')
                                          : 'load externally'}
                                    </span>
                                  )}
                                </button>
                                {canDelete && (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); deleteModel(item.ollamaId || item.id, item.id); }}
                                    className="ml-0.5 shrink-0 rounded p-1 text-[10px] text-slate-300 opacity-0 transition hover:text-red-500 group-hover/row:opacity-100 dark:text-slate-600 dark:hover:text-red-400"
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
                        <div className="px-2 py-2 text-xs text-slate-500">No models found</div>
                      )}

                    {/* Generation params at bottom of model menu */}
                    <div className="mt-1 border-t border-black/10 px-2 py-2 dark:border-white/10">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Generation</div>
                      <div className="mb-1.5">
                        <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
                          <span className="flex items-center gap-1">
                            Temperature
                            <span title="Controls randomness. 0 = precise and deterministic. 0.7 = balanced (default). 1+ = more creative but less predictable." className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-slate-300 text-[8px] leading-none text-slate-400 dark:border-slate-600 dark:text-slate-500">?</span>
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
                          className="mt-0.5 w-full accent-[var(--color-accent)]"
                        />
                        {temperature !== null && (
                          <button
                            type="button"
                            onClick={() => setTemperature(null)}
                            className="text-[9px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                          >
                            Reset to default
                          </button>
                        )}
                      </div>
                      <div>
                        <div className="mb-0.5 flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
                          Max tokens
                          <span title="Hard cap on reply length. Leave blank to let the model stop naturally. Set a number (e.g. 512) to limit response length." className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-slate-300 text-[8px] leading-none text-slate-400 dark:border-slate-600 dark:text-slate-500">?</span>
                        </div>
                        <input
                          type="number"
                          min="1"
                          max="131072"
                          placeholder="provider default"
                          value={maxTokens ?? ''}
                          onChange={(e) => setMaxTokens(e.target.value === '' ? null : Math.max(1, Number(e.target.value)))}
                          className="w-full rounded border border-black/10 bg-white/90 px-1.5 py-0.5 text-[10px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800 dark:text-slate-200"
                        />
                      </div>
                    </div>
                  </div>
                  )}
                </div>
                )}

                  <div data-menu-container="true" className="relative order-3">
                  <button
                    type="button"
                      data-menu-trigger="training"
                    onClick={() => { setIsProviderMenuOpen(false); setIsModelMenuOpen(false); setIsToolsMenuOpen(false); setIsControlPanelOpen(false); setIsMcpPanelOpen(false); setOpenHardwarePopover(null); setIsEngineMenuOpen(false); setIsVoiceMenuOpen(false); setIsTrainingMenuOpen((prev) => !prev); }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-white/10"
                    title="Training options"
                  >
                    Training
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                      <path d="M5.25 7.5L10 12.25 14.75 7.5" />
                    </svg>
                  </button>

                  {isTrainingMenuOpen && (
                  <div data-menu-panel="training" role="menu" tabIndex={-1} className="absolute bottom-9 left-0 z-20 min-w-72 rounded-xl border border-black/10 bg-white/95 p-2 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
                      <button
                        type="button"
                        onClick={() => {
                          setTrainingMode('off');
                          setIsTrainingMenuOpen(false);
                        }}
                        className={`mb-1 flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                          trainingMode === 'off'
                            ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                            : 'text-slate-700 hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10'
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
                            : 'text-slate-700 hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10'
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
                            : 'text-slate-700 hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10'
                        }`}
                      >
                        <span>Deep Training</span>
                        <span className="opacity-70">plan only</span>
                      </button>

                      <label className="mt-2 flex items-center gap-2 rounded-lg border border-black/10 bg-white/70 px-2 py-2 text-xs text-slate-600 dark:border-white/20 dark:bg-slate-900/60 dark:text-slate-300">
                        <input
                          type="checkbox"
                          checked={usePersonalMemory}
                          onChange={(event) => setUsePersonalMemory(event.target.checked)}
                          className="h-3.5 w-3.5 rounded border-black/20 text-accent focus:ring-accent"
                        />
                        <span>Use personal memory context</span>
                      </label>

                      <div className="mt-2 rounded-lg border border-black/10 bg-white/70 px-2 py-2 text-[11px] text-slate-600 dark:border-white/20 dark:bg-slate-900/60 dark:text-slate-300">
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
                            setIsTeachPanelOpen(true);
                            setIsTrainingMenuOpen(false);
                            loadMemoryItems();
                          }}
                          className="flex-1 rounded-lg border border-black/10 bg-white/80 px-2 py-1.5 text-[11px] font-medium text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/60 dark:text-slate-200 dark:hover:bg-white/10"
                        >
                          Teach
                        </button>
                        <button
                          type="button"
                          onClick={() => { exportTrainingExamples(); setIsTrainingMenuOpen(false); }}
                          className="flex-1 rounded-lg border border-black/10 bg-white/80 px-2 py-1.5 text-[11px] font-medium text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/60 dark:text-slate-200 dark:hover:bg-white/10"
                        >
                          Export
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                  <div data-menu-container="true" className="relative">
                  <button
                    type="button"
                      data-menu-trigger="tools"
                    onClick={() => { setIsProviderMenuOpen(false); setIsModelMenuOpen(false); setIsTrainingMenuOpen(false); setIsControlPanelOpen(false); setIsMcpPanelOpen(false); setOpenHardwarePopover(null); setIsEngineMenuOpen(false); setIsVoiceMenuOpen(false); setIsToolsMenuOpen((prev) => !prev); }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-white/10"
                    title="Open tools"
                  >
                    Tools
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                      <path d="M5.25 7.5L10 12.25 14.75 7.5" />
                    </svg>
                  </button>

                  {isToolsMenuOpen && (
                    <div data-menu-panel="tools" role="menu" tabIndex={-1} className="absolute bottom-9 left-0 z-20 min-w-56 rounded-xl border border-black/10 bg-white/95 p-1 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
                      <button
                        type="button"
                        onClick={handleCreateImageTool}
                        className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs text-slate-700 transition hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10"
                      >
                        <span>Create Image</span>
                        <span className="text-[10px] opacity-70">{imageServiceAvailable ? imageServiceDevice || 'ready' : 'offline'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setCanvasEnabled((prev) => !prev);
                          setIsToolsMenuOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition ${
                          canvasEnabled
                            ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                            : 'text-slate-700 hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10'
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
                            : 'text-slate-700 hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10'
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
                            : 'text-slate-700 hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10'
                        }`}
                      >
                        <span>Deep Thinking</span>
                        <span className="text-[10px] opacity-70">{deepThinkingEnabled ? 'on' : 'off'}</span>
                      </button>
                    </div>
                  )}
                </div>

                {/* ── Remote Control button ───────────────────────── */}
                <div data-menu-container="true" className="relative order-3">
                  <button
                    type="button"
                    data-menu-trigger="control"
                    onClick={() => { setIsProviderMenuOpen(false); setIsModelMenuOpen(false); setIsTrainingMenuOpen(false); setIsToolsMenuOpen(false); setIsMcpPanelOpen(false); setOpenHardwarePopover(null); setIsEngineMenuOpen(false); setIsVoiceMenuOpen(false); setIsControlPanelOpen((prev) => !prev); }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-white/10"
                    title="Remote Control"
                  >
                    {/* Green dot indicator */}
                    <span className={`h-2 w-2 rounded-full ${remoteConnected ? 'bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.55)]' : 'bg-transparent border border-slate-400/40'}`} />
                    Control
                  </button>

                  {isControlPanelOpen && (
                    <div data-menu-panel="control" role="menu" tabIndex={-1} className="absolute bottom-9 left-0 z-20 w-80 rounded-xl border border-black/10 bg-white/95 p-3 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Remote Control</span>
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
                                className={`flex-1 rounded-lg px-2 py-1 text-[11px] font-medium transition ${remoteType === t ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent' : 'border border-black/10 text-slate-600 hover:bg-black/5 dark:border-white/20 dark:text-slate-300 dark:hover:bg-white/10'}`}
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
                                className="w-full rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
                              />
                              <div className="flex gap-1.5">
                                <input
                                  type="text"
                                  value={remoteUser}
                                  onChange={(e) => setRemoteUser(e.target.value)}
                                  placeholder="username"
                                  className="flex-1 rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
                                />
                                <input
                                  type="text"
                                  value={remotePort}
                                  onChange={(e) => setRemotePort(e.target.value)}
                                  placeholder="22"
                                  className="w-14 rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
                                />
                              </div>
                              {/* Auth type */}
                              <div className="flex gap-1">
                                {['agent', 'key', 'password'].map((a) => (
                                  <button
                                    key={a}
                                    type="button"
                                    onClick={() => setRemoteAuthType(a)}
                                    className={`flex-1 rounded-lg px-1 py-0.5 text-[10px] font-medium transition capitalize ${remoteAuthType === a ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent' : 'border border-black/10 text-slate-600 hover:bg-black/5 dark:border-white/20 dark:text-slate-300'}`}
                                  >{a}</button>
                                ))}
                              </div>
                              {remoteAuthType === 'key' && (
                                <input
                                  type="text"
                                  value={remoteKeyPath}
                                  onChange={(e) => setRemoteKeyPath(e.target.value)}
                                  placeholder="/path/to/id_rsa"
                                  className="w-full rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
                                />
                              )}
                              {remoteAuthType === 'password' && (
                                <input
                                  type="password"
                                  value={remotePassword}
                                  onChange={(e) => setRemotePassword(e.target.value)}
                                  placeholder="password"
                                  autoComplete="new-password"
                                  className="w-full rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
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

                <div className="relative">
                  <button
                    type="button"
                    onClick={toggleUncensoredMode}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                      uncensoredMode
                        ? 'border-emerald-300/60 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-400/40 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30'
                        : 'border-black/10 bg-white/80 text-slate-700 hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-white/10'
                    }`}
                    title="Toggle uncensored mode for this chat"
                  >
                    <span className={`h-2 w-2 rounded-full ${uncensoredMode ? 'bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.55)]' : 'bg-transparent border border-slate-400/40'}`} />
                    Uncensored
                  </button>
                </div>

                <div className="group relative order-5">
                  <button
                    type="button"
                    onClick={toggleOpenClawMode}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                      openClawMode
                        ? 'border-rose-300/60 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-400/40 dark:bg-rose-900/20 dark:text-rose-300 dark:hover:bg-rose-900/30'
                        : 'border-black/10 bg-white/80 text-slate-700 hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-white/10'
                    }`}
                    title="OpenClaw preset: uncensored mode, no personal memory, empty app system prompt"
                  >
                    <span className={`h-2 w-2 rounded-full ${openClawMode ? 'bg-rose-400 shadow-[0_0_6px_2px_rgba(244,63,94,0.5)]' : 'bg-transparent border border-slate-400/40'}`} />
                    OpenClaw
                  </button>
                  {/* Hover tooltip — no button/state needed */}
                  <div className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 w-72 rounded-xl border border-black/10 bg-white/95 p-3 text-[11px] text-slate-600 opacity-0 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur transition-all duration-150 group-hover:opacity-100 dark:border-white/10 dark:bg-slate-900/95 dark:text-slate-300">
                    <div className="mb-1.5 text-[11px] font-semibold text-slate-800 dark:text-slate-100">OpenClaw Profile</div>
                    <ul className="space-y-1 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
                      <li>Turns on Uncensored mode.</li>
                      <li>Disables Personal Memory injection.</li>
                      <li>Clears the app System Prompt field.</li>
                      <li>Leaves model-level behavior untouched.</li>
                    </ul>
                  </div>
                </div>

                <div data-menu-container="true" className="relative order-4">
                  <button
                    type="button"
                    data-menu-trigger="mcp"
                    onClick={() => {
                      setIsModelMenuOpen(false);
                      setIsTrainingMenuOpen(false);
                      setIsToolsMenuOpen(false);
                      setIsControlPanelOpen(false);
                      setOpenHardwarePopover(null);
                      setIsEngineMenuOpen(false);
                      setIsVoiceMenuOpen(false);
                      setIsMcpPanelOpen((prev) => !prev);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-white/10"
                    title="MCP Connector"
                  >
                    <span className={`h-2 w-2 rounded-full ${selectedMcpServer ? 'bg-cyan-400 shadow-[0_0_6px_2px_rgba(34,211,238,0.45)]' : 'bg-transparent border border-slate-400/40'}`} />
                    MCP
                  </button>

                  {isMcpPanelOpen && (
                    <div data-menu-panel="mcp" role="menu" tabIndex={-1} className="absolute bottom-9 left-0 z-20 w-[27rem] rounded-xl border border-black/10 bg-white/95 p-3 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">MCP Connector</span>
                        <button
                          type="button"
                          onClick={refreshMcpServers}
                          className="rounded-md border border-black/10 px-2 py-0.5 text-[10px] font-medium text-slate-600 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-300 dark:hover:bg-white/10"
                        >
                          Refresh
                        </button>
                      </div>

                      <div className="mb-2 grid grid-cols-[1fr_auto_auto] gap-1.5">
                        <select
                          value={mcpSelectedServerId}
                          onChange={(event) => setMcpSelectedServerId(event.target.value)}
                          className="rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
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
                          className="rounded-lg border border-black/10 px-2 py-1.5 text-[10px] font-medium text-slate-700 transition hover:bg-black/5 disabled:opacity-40 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
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
                          className="rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
                        />
                        <input
                          type="text"
                          value={mcpForm.name}
                          onChange={(event) => setMcpForm((prev) => ({ ...prev, name: event.target.value }))}
                          placeholder="display name"
                          className="rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
                        />
                      </div>
                      <input
                        type="text"
                        value={mcpForm.url}
                        onChange={(event) => setMcpForm((prev) => ({ ...prev, url: event.target.value }))}
                        placeholder="http://127.0.0.1:30030/mcp"
                        className="mb-1.5 w-full rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
                      />
                      <input
                        type="password"
                        value={mcpForm.authToken}
                        onChange={(event) => setMcpForm((prev) => ({ ...prev, authToken: event.target.value }))}
                        placeholder="bearer token (optional)"
                        className="mb-2 w-full rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
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
                          className="flex-1 rounded-lg border border-black/10 px-2 py-1.5 text-[11px] font-medium text-slate-700 transition hover:bg-black/5 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
                        >
                          Local MCP Preset
                        </button>
                      </div>

                      {mcpSelectedServerId && (
                        <>
                          <div className="mb-2 rounded-lg border border-black/10 bg-white/70 p-2 dark:border-white/20 dark:bg-slate-900/60">
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Policy</div>
                            <div className="mb-1.5 grid grid-cols-2 gap-1.5">
                              <label className="flex items-center gap-1.5 text-[11px] text-slate-700 dark:text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={mcpPolicy.enforceAllowlist}
                                  onChange={(event) => saveMcpPolicy({ ...mcpPolicy, enforceAllowlist: event.target.checked })}
                                  className="h-3.5 w-3.5 rounded border-black/20 text-accent focus:ring-accent"
                                />
                                Enforce allowlist
                              </label>
                              <label className="flex items-center gap-1.5 text-[11px] text-slate-700 dark:text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={mcpPolicy.requireApproval}
                                  onChange={(event) => saveMcpPolicy({ ...mcpPolicy, requireApproval: event.target.checked })}
                                  className="h-3.5 w-3.5 rounded border-black/20 text-accent focus:ring-accent"
                                />
                                Require approval
                              </label>
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-slate-600 dark:text-slate-300">
                              <span>Approval TTL</span>
                              <input
                                type="number"
                                min="30"
                                max="3600"
                                value={mcpPolicy.approvalTtlSeconds}
                                onChange={(event) => saveMcpPolicy({ ...mcpPolicy, approvalTtlSeconds: Number(event.target.value || 300) })}
                                className="w-20 rounded border border-black/10 bg-white/90 px-1.5 py-0.5 text-[10px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
                              />
                              <span>seconds</span>
                            </div>
                          </div>

                          <div className="mb-2 rounded-lg border border-black/10 bg-white/70 p-2 dark:border-white/20 dark:bg-slate-900/60">
                            <div className="mb-1.5 flex items-center justify-between">
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Tools</span>
                              <button
                                type="button"
                                onClick={loadMcpTools}
                                disabled={mcpLoading}
                                className="rounded-md border border-black/10 px-1.5 py-0.5 text-[10px] text-slate-600 transition hover:bg-black/5 disabled:opacity-40 dark:border-white/20 dark:text-slate-300 dark:hover:bg-white/10"
                              >
                                Fetch
                              </button>
                            </div>
                            <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
                              {mcpTools.length === 0 && <div className="text-[10px] text-slate-500 dark:text-slate-400">No tools loaded yet.</div>}
                              {mcpTools.map((tool) => {
                                const name = String(tool?.name || '');
                                const checked = mcpPolicy.allowedTools.includes(name);
                                return (
                                  <label key={name} className="flex items-center justify-between gap-2 rounded-md border border-black/5 bg-white/70 px-2 py-1 text-[10px] dark:border-white/10 dark:bg-slate-800/60">
                                    <span className="truncate text-slate-700 dark:text-slate-200">{name}</span>
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

                          <div className="rounded-lg border border-black/10 bg-white/70 p-2 dark:border-white/20 dark:bg-slate-900/60">
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Run Tool</div>
                            <div className="mb-1.5 grid grid-cols-[1fr_auto] gap-1.5">
                              <select
                                value={mcpToolName}
                                onChange={(event) => setMcpToolName(event.target.value)}
                                className="rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
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
                              className="mb-1.5 w-full rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 font-mono text-[10px] outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
                            />
                            <pre className="max-h-28 overflow-y-auto rounded-lg border border-black/10 bg-slate-950/90 p-2 font-mono text-[10px] text-emerald-300 dark:border-white/20">
                              {mcpCallResultText || '{ }'}
                            </pre>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap justify-end gap-1.5">
                {deepThinkingEnabled && (
                  <span className="rounded-full border border-black/10 bg-white/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-300">
                    Deep Thinking
                  </span>
                )}
                {guidedLearningEnabled && (
                  <span className="rounded-full border border-black/10 bg-white/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-300">
                    Guided
                  </span>
                )}
                {trainingMode === 'fine-tuning' && (
                  <span className="rounded-full border border-black/10 bg-white/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-300">
                    Quick Learning
                  </span>
                )}
                {trainingMode === 'full-training' && (
                  <span className="rounded-full border border-amber-300/60 bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:border-amber-400/40 dark:bg-amber-900/30 dark:text-amber-200">
                    Deep Training
                  </span>
                )}
                {canvasEnabled && (
                  <span className="rounded-full border border-black/10 bg-white/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-300">
                    Canvas
                  </span>
                )}
                {remoteConnected && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/50 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-900/20 dark:text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    {remoteTarget}
                  </span>
                )}
                {selectedMcpServer && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/60 bg-cyan-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-700 dark:border-cyan-400/40 dark:bg-cyan-900/20 dark:text-cyan-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                    MCP {selectedMcpServer.id}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-stretch gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleAttachFiles}
              />
              <div className="relative flex shrink-0 flex-col items-center justify-between">
                <button
                  type="button"
                  onClick={toggleDictation}
                  disabled={!dictationSupported || isStreaming}
                  className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    isDictating
                      ? 'border-accent/50 bg-accentSoft text-ink dark:border-accent/60 dark:bg-accent/20 dark:text-accent'
                      : 'border-black/10 bg-white/85 text-slate-500 hover:bg-black/5 hover:text-slate-700 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-slate-100'
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
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStreaming || isUploadingFiles}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-black/10 bg-white/85 text-slate-500 transition hover:bg-black/5 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-slate-100"
                  title="Attach files"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21.44 11.05l-8.49 8.49a5 5 0 11-7.07-7.07l9.19-9.19a3.5 3.5 0 114.95 4.95l-9.2 9.2a2 2 0 01-2.82-2.83l8.48-8.48" />
                  </svg>
                </button>
              </div>
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
                className="w-full resize-none rounded-xl border border-black/10 bg-white/90 px-3 py-2 text-sm outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800"
              />
              <div className="flex w-[4.25rem] shrink-0 flex-col items-stretch justify-between">
                <div data-menu-container="true" className="relative">
                <button
                  type="button"
                  data-menu-trigger="voice"
                  onClick={() => {
                    setIsContextPanelOpen(false);
                    setOpenHardwarePopover(null);
                    setIsEngineMenuOpen(false);
                    setIsControlPanelOpen(false);
                    setIsMcpPanelOpen(false);
                    checkVoiceTools();
                    fetchPiperModels();
                    setIsVoiceMenuOpen((prev) => !prev);
                  }}
                  className={`inline-flex h-8 w-full items-center justify-center rounded-full border text-[10px] font-semibold tracking-wide transition ${
                    isSpeaking
                      ? 'border-accent/50 bg-accentSoft text-ink dark:border-accent/60 dark:bg-accent/20 dark:text-accent'
                      : 'border-black/10 bg-white/80 text-slate-600 hover:bg-black/5 dark:border-white/20 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:bg-white/10'
                  }`}
                  title="Voice settings"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 12h1" />
                    <path d="M8 9v6" />
                    <path d="M12 7v10" />
                    <path d="M16 9v6" />
                    <path d="M20 11v2" />
                  </svg>
                  <span className="text-[8px] font-bold leading-none opacity-70">{voiceEngine === 'piper' ? 'P' : 'B'}</span>
                </button>

                {isVoiceMenuOpen && (
                  <div data-menu-panel="voice" role="menu" tabIndex={-1} className="absolute bottom-full right-0 mb-2 z-20 w-80 rounded-xl border border-black/10 bg-white/95 p-2 shadow-[0_18px_40px_-20px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-900/95">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Voice Settings</span>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400">{voiceSupported ? 'TTS ready' : 'Unavailable'}</span>
                    </div>

                    <div className="mb-2 grid grid-cols-2 gap-1">
                      <button
                        type="button"
                        onClick={() => setAutoSpeakEnabled((prev) => !prev)}
                        className={`rounded-lg px-2 py-1.5 text-[11px] font-medium transition ${
                          autoSpeakEnabled
                            ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent'
                            : 'border border-black/10 text-slate-700 hover:bg-black/5 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10'
                        }`}
                      >
                        Auto-speak {autoSpeakEnabled ? 'on' : 'off'}
                      </button>
                      <button
                        type="button"
                        onClick={() => (isSpeaking ? stopSpeaking() : speakText('Voice preview from Mirabilis.'))}
                        disabled={!voiceSupported && voiceEngine === 'browser'}
                        className="rounded-lg border border-black/10 px-2 py-1.5 text-[11px] font-medium text-slate-700 transition hover:bg-black/5 disabled:opacity-40 dark:border-white/20 dark:text-slate-200 dark:hover:bg-white/10"
                      >
                        {isSpeaking ? 'Stop' : 'Preview'}
                      </button>
                    </div>

                    {/* Voice engine toggle */}
                    <div className="mb-2">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Voice Engine</div>
                      <div className="flex overflow-hidden rounded-lg border border-black/10 dark:border-white/20">
                        <button
                          type="button"
                          onClick={() => setVoiceEngine('browser')}
                          className={`flex-1 px-2 py-1.5 text-[10px] font-medium transition ${voiceEngine === 'browser' ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent' : 'text-slate-700 hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10'}`}
                        >
                          Browser
                        </button>
                        <button
                          type="button"
                          onClick={() => setVoiceEngine('piper')}
                          className={`flex-1 border-l border-black/10 px-2 py-1.5 text-[10px] font-medium transition dark:border-white/20 ${voiceEngine === 'piper' ? 'bg-accentSoft text-ink dark:bg-accent/20 dark:text-accent' : 'text-slate-700 hover:bg-black/5 dark:text-slate-200 dark:hover:bg-white/10'}`}
                        >
                          Piper neural
                        </button>
                      </div>
                    </div>

                    {/* Browser engine */}
                    {voiceEngine === 'browser' && (
                      <>
                        <div className="mb-2 space-y-1">
                          <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Voice</label>
                          <select
                            value={selectedVoiceUri}
                            onChange={(e) => setSelectedVoiceUri(e.target.value)}
                            className="w-full rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] text-slate-700 outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800 dark:text-slate-200"
                          >
                            {availableVoices.map((voice) => (
                              <option key={voice.voiceURI} value={voice.voiceURI}>
                                {voice.name} ({voice.lang})
                              </option>
                            ))}
                          </select>
                          {voiceTools?.platform === 'darwin' && (
                            <p className="text-[10px] text-slate-400 dark:text-slate-500">
                              More voices: System Settings → Accessibility → Spoken Content → Manage Voices
                            </p>
                          )}
                        </div>
                        <div className="mb-1 grid grid-cols-2 gap-2">
                          <label className="text-[10px] text-slate-500 dark:text-slate-400">
                            Rate {voiceRate.toFixed(2)}
                            <input type="range" min="0.8" max="1.5" step="0.05" value={voiceRate} onChange={(e) => setVoiceRate(Number(e.target.value))} className="mt-1 w-full" />
                          </label>
                          <label className="text-[10px] text-slate-500 dark:text-slate-400">
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
                          <div className="rounded-lg border border-black/10 bg-slate-50/80 p-2 text-[10px] dark:border-white/10 dark:bg-slate-800/60">
                            <div className="mb-0.5 font-semibold text-slate-700 dark:text-slate-100">Piper Neural TTS</div>
                            <div className="mb-2 text-slate-500 dark:text-slate-400">
                              Free, high-quality local voices that run offline. Runs on your device — no cloud.
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
                                <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Active voice</label>
                                <select
                                  value={selectedPiperModelId}
                                  onChange={(e) => setSelectedPiperModelId(e.target.value)}
                                  className="w-full rounded-lg border border-black/10 bg-white/90 px-2 py-1.5 text-[11px] text-slate-700 outline-none focus:border-accent dark:border-white/20 dark:bg-slate-800 dark:text-slate-200"
                                >
                                  {piperModels.filter((m) => m.installed).map((m) => (
                                    <option key={m.id} value={m.id}>{m.label}</option>
                                  ))}
                                </select>
                              </div>
                            )}

                            <div>
                              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Free voice catalog</div>
                              <div className="space-y-0.5">
                                {piperModels.map((model) => (
                                  <div key={model.id} className="flex items-center justify-between rounded-lg px-2 py-1 text-[10px]">
                                    <span className="text-slate-700 dark:text-slate-200">{model.label}</span>
                                    {model.installed ? (
                                      <span className="font-semibold text-emerald-600 dark:text-emerald-400">Installed</span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => downloadPiperModel(model.id)}
                                        disabled={downloadingPiperModelId !== null}
                                        className="rounded-md bg-black/5 px-2 py-0.5 font-medium text-slate-700 transition hover:bg-accent hover:text-white disabled:opacity-40 dark:bg-white/10 dark:text-slate-200 dark:hover:bg-accent dark:hover:text-white"
                                      >
                                        {downloadingPiperModelId === model.id ? 'Downloading…' : `${model.sizeMb}MB`}
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>

                            <label className="block text-[10px] text-slate-500 dark:text-slate-400">
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

                <button
                  onClick={isStreaming ? stopStreaming : sendMessage}
                  className={`w-full rounded-xl px-2 py-2 text-sm font-semibold text-white shadow-[0_10px_24px_-14px_rgba(26,168,111,0.9)] transition ${isStreaming ? 'bg-red-500 hover:brightness-95' : 'bg-accent hover:brightness-95'}`}
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
      <footer className="pointer-events-none absolute bottom-1 left-0 right-0 text-center text-xs tracking-wide text-slate-700/90 dark:text-slate-300/90">
        Mirabilis AI by Moshiko Nayman
        <span className="mx-1.5 opacity-40">·</span>
        <span className="opacity-55">v26.3R1-S3</span>
      </footer>
    </main>
  );
}
