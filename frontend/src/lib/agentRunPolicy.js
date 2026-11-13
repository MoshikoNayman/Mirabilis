// @ts-check
// Agent run rules kept out of ChatApp.jsx so they are testable: where a message
// goes, what context a run carries, how approvals and progress are tracked, how a
// failure reads.

import { ACCESS_LEVELS, accessMeta, normalizeAccess } from './access.js';

/** @typedef {'agent'|'image'|'chat'} SendRoute */

/** What the Create image tool writes in the composer. Above Chat only it is how to ask for an image. */
export const IMAGE_PROMPT_PREFIX = 'Generate an image of';

/**
 * True when a message asks for an image in so many words.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isExplicitImagePrompt(text) {
  return typeof text === 'string' && /^\s*generate an image of\b/i.test(text);
}

const IMAGE_VERB = /^(please\s+)?(generate|create|draw|paint|make|render|produce|show)\s+(me\s+)?/i;
const IMAGE_NOUN = /^(an?\s+)?(image|picture|pic|photo|photograph|illustration|artwork|painting|portrait|sketch|drawing|wallpaper)\b\s*(of\b\s*)?/i;

/**
 * Composer text for the Create image tool: an explicit prompt, so the image
 * service gets it whatever Access is. "draw a cat" becomes "Generate an image of a cat".
 * @param {unknown} text
 * @returns {string}
 */
export function toImagePrompt(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (isExplicitImagePrompt(t)) return t;
  const subject = t.replace(IMAGE_VERB, '').replace(IMAGE_NOUN, '').trim();
  return `${IMAGE_PROMPT_PREFIX} ${subject}`.replace(/\s+$/, ' ');
}

/**
 * Where a composer message goes. An agentic effort always runs the agent. Above
 * Chat only the agent answers so it can use tools; image words are common in
 * troubleshooting ("make a snapshot of the processes"), so only an explicit
 * image prompt goes to the image service there. Chat only keeps the heuristic.
 * @param {{ agentic: boolean, access: string|undefined, imageRequest: boolean, explicitImage?: boolean }} p
 * @returns {SendRoute}
 */
export function chooseSendRoute({ agentic, access, imageRequest, explicitImage = false }) {
  if (agentic) return 'agent';
  if (access && access !== 'chat') return explicitImage ? 'image' : 'agent';
  return imageRequest ? 'image' : 'chat';
}

/**
 * @typedef {object} PendingApproval
 * @property {string} approvalId
 * @property {string} kind
 * @property {string} title
 * @property {string} detail
 * @property {string} reason
 * @property {string} reasonCode
 * @property {string|null} alwaysLabel
 * @property {boolean} network
 * @property {string} tool
 * @property {string} cwd   folder a command runs in; '' for other actions
 * @property {number|null} subAgent  index of the sub-agent that asks; null for the lead
 */

/** @param {unknown} v @returns {string} */
const text = (v) => (typeof v === 'string' ? v : '');

/** A sub-agent index from an event, or null for the lead. @param {unknown} v @returns {number|null} */
const agentIndex = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * The approval card's view of an approval-required event; null without an id.
 * @param {any} payload
 * @returns {PendingApproval|null}
 */
export function toApproval(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (!text(p.approvalId)) return null;
  return {
    approvalId: p.approvalId,
    kind: text(p.kind) || 'other',
    title: text(p.title),
    detail: text(p.detail),
    reason: text(p.reason),
    reasonCode: text(p.reasonCode),
    alwaysLabel: text(p.alwaysLabel) || null,
    network: p.network === true,
    tool: text(p.tool),
    cwd: text(p.cwd),
    subAgent: agentIndex(p.subAgent)
  };
}

/**
 * Pending approvals in arrival order, one entry per approvalId.
 * @param {PendingApproval[]|undefined} list
 * @param {PendingApproval} approval
 * @returns {PendingApproval[]}
 */
export function addApproval(list, approval) {
  const current = Array.isArray(list) ? list : [];
  const idx = current.findIndex((a) => a.approvalId === approval.approvalId);
  if (idx === -1) return [...current, approval];
  const next = [...current];
  next[idx] = approval;
  return next;
}

/**
 * Same array back when the id is absent, so state does not change for nothing.
 * @param {PendingApproval[]|undefined} list
 * @param {string} approvalId
 * @returns {PendingApproval[]}
 */
export function removeApproval(list, approvalId) {
  const current = Array.isArray(list) ? list : [];
  if (!current.some((a) => a.approvalId === approvalId)) return current;
  return current.filter((a) => a.approvalId !== approvalId);
}

/**
 * Approval events arrive as progress frames; their own SSE event names count too.
 * @param {string} event SSE event name
 * @param {any} payload parsed frame data
 * @returns {'approval-required'|'approval-resolved'|null}
 */
export function approvalEventType(event, payload) {
  const type = event === 'progress' ? payload?.type : event;
  return type === 'approval-required' || type === 'approval-resolved' ? type : null;
}

/**
 * Run log line for an approval-resolved event.
 * @param {unknown} decision
 * @returns {string}
 */
export function approvalNarration(decision) {
  if (decision === 'allow') return 'approved';
  if (decision === 'always') return 'approved (always)';
  if (decision === 'deny') return 'denied';
  return 'approval cancelled';
}

/**
 * What a posted decision means for its card. 404 says the run or the approval
 * is gone and 409 says it was already answered, so the card is stale; anything
 * else that failed keeps the card so the user can try again.
 * @param {number} status
 * @returns {'sent'|'stale'|'failed'}
 */
export function approvalReplyOutcome(status) {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 404 || status === 409) return 'stale';
  return 'failed';
}

/**
 * Toast for an Access change made during a run. The backend applies a lower
 * level to the live run at once; a higher one waits, since the run keeps the
 * level it started with as its ceiling.
 * @param {unknown} runLevel  level the run started with
 * @param {unknown} nextLevel level just saved
 * @returns {string}
 */
export function accessChangeNotice(runLevel, nextLevel) {
  const rank = (/** @type {unknown} */ id) => ACCESS_LEVELS.findIndex((l) => l.id === normalizeAccess(id));
  const run = accessMeta(runLevel);
  const next = accessMeta(nextLevel);
  if (rank(next.id) <= rank(run.id)) return `${next.label} applies now`;
  return `${next.label} applies from next message`;
}

/**
 * A refused run start: the sentence to show, and whether the backend asked for
 * the chat route instead because Access there is Chat only.
 * @param {number} status
 * @param {string} body raw response text
 * @returns {{ message: string, useChat: boolean }}
 */
export function runRefusal(status, body) {
  let useChat = false;
  try {
    const parsed = JSON.parse(typeof body === 'string' ? body : '');
    useChat = Boolean(parsed && parsed.useChat === true);
  } catch {
    // Not JSON: nothing to read but the text.
  }
  return { message: describeRunError(status, body), useChat };
}

/**
 * Readable message for a failed run, preferring the server's plain-sentence `error`.
 *
 * @param {number} status
 * @param {string} body raw response text
 * @returns {string}
 */
export function describeRunError(status, body) {
  const raw = typeof body === 'string' ? body.trim() : '';
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
        return parsed.error.trim();
      }
    } catch {
      // Not JSON: fall through to the raw text.
    }
    // Show a raw body only when it is short enough to read as a message.
    if (!raw.startsWith('{') && !raw.startsWith('[') && raw.length <= 300) return raw;
  }
  return `Request failed (${status})`;
}

/* Run progress. The lead's events and its sub-agents' share one feed; a
   sub-agent's carry its index as subAgent and the lead's clock as at. Only the
   lead's events move the headline and the meters. */

/**
 * Stop reasons from backend/src/agent/budget.js and runStore.js.
 * @type {Readonly<Record<string, string>>}
 */
export const STOP_LABEL = Object.freeze({
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  'wall-clock-exhausted': 'Time limit',
  'iterations-exhausted': 'Step limit',
  'tool-calls-exhausted': 'Tool limit',
  'token-budget-exhausted': 'Token limit',
  'backend-restarted': 'Backend restarted'
});

/**
 * A sub-agent's name in the log and the popover: A1 for index 0, '' for the lead.
 * @param {unknown} subAgent
 * @returns {string}
 */
export function agentTag(subAgent) {
  const index = agentIndex(subAgent);
  return index === null ? '' : `A${index + 1}`;
}

/** What an agent row can say. */
export const AGENT_STATES = Object.freeze(/** @type {const} */ (['queued', 'working', 'waiting', 'passed', 'unverified', 'stopped', 'failed']));

/** @typedef {typeof AGENT_STATES[number]} AgentState */

/**
 * Text color of a row's state word: theme pairs that pass AA as small text on the
 * popover, as its other warnings do. States not listed stay muted.
 * @type {Readonly<Partial<Record<AgentState, string>>>}
 */
export const AGENT_STATE_TEXT = Object.freeze({
  unverified: 'text-amber-700 dark:text-amber-300',
  failed: 'text-red-700 dark:text-red-300'
});

/**
 * @typedef {object} AgentRow
 * @property {number} subAgent  0-based, unique within the run
 * @property {string} goal      its part, at most 200 characters
 * @property {AgentState} state
 */

/** Rows a run keeps; the oldest drop first. */
const MAX_AGENT_ROWS = 16;

/**
 * @param {AgentState} state
 * @param {any} p the agent's own event
 * @returns {AgentState}
 */
function nextAgentState(state, p) {
  switch (p.type) {
    case 'run-start': return 'working';
    case 'approval-required': return 'waiting';
    // Only ends a wait: a late resolve never revives a finished agent.
    case 'approval-resolved': return state === 'waiting' ? 'working' : state;
    case 'run-error': return 'failed';
    case 'run-end':
      if (p.stopReason === 'completed') return p.validated === true ? 'passed' : 'unverified';
      return p.stopReason === 'failed' ? 'failed' : 'stopped';
    default: return state;
  }
}

/**
 * Agent rows after one event: fanout-start lists its agents as queued, and each
 * agent's own events move its row. The same array comes back when nothing changes.
 * @param {AgentRow[]|undefined} rows
 * @param {any} payload progress event; an approval event carries the asking agent's index
 * @returns {AgentRow[]}
 */
export function reduceAgents(rows, payload) {
  const current = Array.isArray(rows) ? rows : [];
  const p = payload && typeof payload === 'object' ? payload : {};
  if (p.type === 'fanout-start') {
    const known = new Set(current.map((r) => r.subAgent));
    /** @type {AgentRow[]} */
    const added = [];
    for (const a of Array.isArray(p.agents) ? p.agents : []) {
      const index = agentIndex(a?.subAgent);
      if (index === null || known.has(index)) continue;
      known.add(index);
      added.push({ subAgent: index, goal: text(a.goal), state: 'queued' });
    }
    return added.length ? [...current, ...added].slice(-MAX_AGENT_ROWS) : current;
  }
  const index = agentIndex(p.subAgent);
  const at = index === null ? -1 : current.findIndex((r) => r.subAgent === index);
  if (at === -1) return current;
  const state = nextAgentState(current[at].state, p);
  if (state === current[at].state) return current;
  const next = [...current];
  next[at] = { ...current[at], state };
  return next;
}

/**
 * The run after one progress event. The lead's events set the budget and the
 * phase; a fan-out counts its agents as they finish. The same object comes back
 * when nothing changes.
 * @param {any} run the composer's run state
 * @param {any} payload
 * @returns {any}
 */
export function applyRunEvent(run, payload) {
  if (!run || !payload || typeof payload !== 'object') return run;
  /** @type {Record<string, any>} */
  const patch = {};
  if (agentIndex(payload.subAgent) === null) {
    if (payload.budget) patch.budget = payload.budget;
    if (payload.type === 'phase') patch.phase = payload.phase;
    else if (payload.type === 'iteration') patch.phase = 'act';
    else if (payload.type === 'fanout-start') {
      patch.phase = 'agents';
      patch.fanout = { total: Math.max(0, Number(payload.count) || 0), done: 0 };
    } else if (payload.type === 'fanout-end') {
      patch.phase = 'act';
      patch.fanout = null;
    }
  } else if ((payload.type === 'run-end' || payload.type === 'run-error') && run.fanout) {
    patch.fanout = { ...run.fanout, done: Math.min(run.fanout.total, run.fanout.done + 1) };
  }
  const agents = reduceAgents(run.agents, payload);
  if (agents !== run.agents) patch.agents = agents;
  return Object.keys(patch).length > 0 ? { ...run, ...patch } : run;
}

/** Rows whose agent had not ended when the feed did. */
const OPEN_STATES = new Set(['queued', 'working', 'waiting']);

/**
 * A run that ended without its result: Stop, a failed or broken stream. The feed stopped,
 * so no agent will report again: open rows end as stopped (failed with the run), the
 * fan-out closes, and the clock keeps the last time the panel showed.
 * @param {any} run
 * @param {{ status: string, stopReason?: string, error?: string }} end
 * @returns {any}
 */
export function settleRun(run, end) {
  if (!run) return run;
  const ended = end.status === 'failed' ? 'failed' : 'stopped';
  const rows = Array.isArray(run.agents) ? run.agents : [];
  const agents = rows.some((r) => OPEN_STATES.has(r.state))
    ? rows.map((r) => (OPEN_STATES.has(r.state) ? { ...r, state: ended } : r))
    : run.agents;
  const events = Array.isArray(run.events) ? run.events : [];
  const lastAt = events.length ? Number(events[events.length - 1].at) || 0 : 0;
  const budget = run.budget && lastAt > (Number(run.budget.elapsedMs) || 0)
    ? { ...run.budget, elapsedMs: lastAt }
    : run.budget;
  return { ...run, ...end, agents, fanout: null, budget };
}

/** @param {any} p fanout-start @returns {string} */
function fanoutLine(p) {
  const n = Math.max(0, Number(p.count) || 0);
  const head = n === 1 ? '1 agent' : `${n} agents, ${Math.min(n, Number(p.concurrency) || n)} at a time`;
  const deferred = Number(p.deferred) || 0;
  return deferred > 0 ? `${head}, ${deferred} deferred` : head;
}

/** A spawn_agents result that started no agent: a refusal, or no budget for an Ultra fan-out. */
const NO_FANOUT = /^\{"spawned":0[,}]/;

/** Why a tool call failed, from its observation. @param {any} p @returns {string} */
function failureText(p) {
  const raw = String(p.observation ?? '');
  if (NO_FANOUT.test(raw)) {
    try {
      const error = JSON.parse(raw).error;
      if (typeof error === 'string' && error) return error.slice(0, 90);
    } catch { /* a cut copy reads as it is */ }
  }
  return raw.replace(/^ERROR:\s*/, '').slice(0, 90);
}

/** @param {any} p @returns {string|null} */
function leadLine(p) {
  switch (p.type) {
    case 'phase': return `phase: ${p.phase}`;
    case 'plan': return `plan: ${String(p.plan).slice(0, 120)}`;
    case 'split': return Number(p.count) >= 2 ? `split: ${Number(p.count)} parts` : 'split: solo';
    // A fan-out reads as its own lines; one that started no agent says why.
    case 'tool-call':
      return p.tool === 'spawn_agents' ? null : `${p.tool}(${JSON.stringify(p.args ?? {}).slice(0, 60)})`;
    case 'tool-result': {
      const noFanout = p.tool === 'spawn_agents' && NO_FANOUT.test(String(p.observation ?? ''));
      if (p.ok && !noFanout) return p.tool === 'spawn_agents' ? null : `  ${p.tool} done`;
      return `  ${p.tool} failed: ${failureText(p)}`;
    }
    case 'invalid-action': return `  retrying: ${p.error}`;
    case 'finish-proposed': return 'proposed a result';
    case 'validation': return `validation ${p.passed ? 'passed' : 'failed'}${p.reason ? `: ${String(p.reason).slice(0, 70)}` : ''}`;
    case 'repair': return `repairing: ${String(p.reason).slice(0, 80)}`;
    case 'fanout-start': return fanoutLine(p);
    case 'fanout-end': return `agents done (${Number(p.spentToolCalls) || 0} tool calls)`;
    default: return null;
  }
}

/**
 * Run log line for one progress event, or null when it adds nothing. The lead's
 * lines read as they always have; a sub-agent's carry its tag after any indent.
 * @param {any} payload
 * @returns {string|null}
 */
export function runEventLine(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const tag = agentTag(p.subAgent);
  if (tag) {
    // The headline shows the lead's phase and plan; an agent's would crowd the log.
    if (p.type === 'phase' || p.type === 'plan') return null;
    if (p.type === 'run-end') {
      return p.stopReason === 'completed' ? null : `${tag} stopped: ${STOP_LABEL[text(p.stopReason)] || text(p.stopReason)}`;
    }
    if (p.type === 'run-error') return `${tag} failed: ${String(p.error ?? '').slice(0, 80)}`;
  }
  const line = leadLine(p);
  if (!line || !tag) return line;
  const indent = line.length - line.trimStart().length;
  return `${line.slice(0, indent)}${tag} ${line.slice(indent)}`;
}

/* Run context. A run's goal is only the new message and the backend does not
   read the chat, so the earlier turns, attached files and the chat's modes travel
   in the run's system prompt. The budgets keep it small: it rides on every step. */

/** Earlier messages a run sees. */
export const CONTEXT_MAX_MESSAGES = 12;
/** One message's text; longer text keeps its head and tail. */
export const CONTEXT_MAX_MESSAGE_CHARS = 2000;
/** All earlier turns together; the oldest drop first. */
export const CONTEXT_MAX_CHARS = 10000;
/** Attached file text, shared by every file in the window; the newest files go first. */
export const CONTEXT_MAX_FILE_CHARS = 12000;
/** Canvas notes. */
export const CONTEXT_MAX_CANVAS_CHARS = 4000;
/** Personal memory items, newest last, as the chat route sends them. */
export const CONTEXT_MAX_MEMORY_ITEMS = 20;

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|toml|javascript|x-sh|x-shellscript|sql|x-ndjson))/i;

/**
 * An attachment whose text a run can read: flagged as text by the upload route,
 * or of a text type. Only files served from the uploads route qualify.
 * @param {any} a
 * @returns {boolean}
 */
export function isTextAttachment(a) {
  if (!a || typeof a !== 'object') return false;
  if (typeof a.storedName !== 'string' || !a.storedName) return false;
  if (typeof a.url !== 'string' || !a.url.startsWith('/api/uploads/')) return false;
  const mime = typeof a.mimeType === 'string' ? a.mimeType : '';
  if (/^image\//i.test(mime)) return false;
  return a.text === true || TEXT_MIME.test(mime);
}

/**
 * Head and tail of a long text with a marker between them.
 * @param {string} value
 * @param {number} max
 * @returns {string}
 */
export function clipMiddle(value, max) {
  const s = String(value || '');
  if (s.length <= max) return s;
  const marker = '\n[...]\n';
  const room = Math.max(0, max - marker.length);
  const head = Math.ceil(room * 0.7);
  return `${s.slice(0, head)}${marker}${s.slice(s.length - (room - head))}`;
}

// Blocks the chat path appends to a sent message; the chat saves them with it.
const APPENDED_BLOCKS = [
  '\n\nWeb results for "',
  '\n\n[Canvas notes - ',
  '\n\n[System: Remote Control is active.',
  '\n\nTeaching mode: ',
  '\n\nEffort: ',
  '\n\nDeep thinking mode: '
];

/**
 * A saved user message without the context the chat path appended to it, so
 * old search results do not fill the run's budget.
 * @param {unknown} content
 * @returns {string}
 */
export function userTextOf(content) {
  const s = typeof content === 'string' ? content : '';
  let end = s.length;
  for (const marker of APPENDED_BLOCKS) {
    const at = s.indexOf(marker);
    if (at !== -1 && at < end) end = at;
  }
  return s.slice(0, end);
}

/**
 * The messages a run sees: real turns with something in them, newest last.
 * @param {any[]|undefined} messages
 * @param {number} [max]
 * @returns {any[]}
 */
export function contextMessages(messages, max = CONTEXT_MAX_MESSAGES) {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant')
      && !m.failed && !m.imageGenerating
      && ((typeof m.content === 'string' && m.content.trim() !== '')
        || (Array.isArray(m.attachments) && m.attachments.length > 0)))
    .slice(-Math.max(0, max));
}

/**
 * Attached files of one message as prompt text, within budget.
 * @param {any} m
 * @param {Map<string, string>} texts storedName -> file text
 * @param {number} budget chars left for file text
 * @returns {{ text: string, used: number }}
 */
function fileBlocks(m, texts, budget) {
  const files = Array.isArray(m.attachments) ? m.attachments : [];
  const readable = files.filter((a) => isTextAttachment(a) && typeof texts.get(a.storedName) === 'string');
  const share = readable.length ? Math.floor(Math.max(0, budget) / readable.length) : 0;
  let used = 0;
  const parts = files.map((a) => {
    const name = text(a?.name) || 'file';
    if (/^image\//i.test(text(a?.mimeType))) return `[image: ${name}. Images are not shown to you in this mode.]`;
    const body = readable.includes(a) ? /** @type {string} */ (texts.get(a.storedName)) : null;
    if (body === null) return `[file: ${name}, not readable as text]`;
    if (share < 200) return `[file: ${name}, left out: the context limit is reached]`;
    const clipped = clipMiddle(body, share);
    used += clipped.length;
    const note = clipped.length < body.length ? ` (${clipped.length} of ${body.length} characters, start and end)` : '';
    return `--- ${name}${note} ---\n${clipped}\n--- end of ${name} ---`;
  });
  return { text: parts.join('\n'), used };
}

/**
 * Earlier turns of the chat as one block, oldest first. The newest turns and
 * files win the budget, so a follow-up always has what it refers to.
 * @param {any[]|undefined} messages messages before the new one
 * @param {{ attachmentTexts?: Map<string, string>, maxMessages?: number, maxChars?: number,
 *   maxMessageChars?: number, maxFileChars?: number }} [opts]
 * @returns {string} '' when there is nothing earlier
 */
export function conversationContext(messages, opts = {}) {
  const texts = opts.attachmentTexts instanceof Map ? opts.attachmentTexts : new Map();
  const maxChars = opts.maxChars ?? CONTEXT_MAX_CHARS;
  const perMessage = opts.maxMessageChars ?? CONTEXT_MAX_MESSAGE_CHARS;
  const list = contextMessages(messages, opts.maxMessages ?? CONTEXT_MAX_MESSAGES);
  /** @type {string[]} */
  const entries = [];
  let used = 0;
  let fileBudget = opts.maxFileChars ?? CONTEXT_MAX_FILE_CHARS;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    const who = m.role === 'assistant' ? 'Assistant' : 'User';
    const raw = (m.role === 'user' ? userTextOf(m.content) : text(m.content)).trim();
    const said = m.imageUrl ? `[generated an image${raw ? `: ${raw}` : ''}]` : clipMiddle(raw, perMessage);
    const line = `${who}: ${said}`;
    if (entries.length > 0 && used + line.length > maxChars) break;
    const files = fileBlocks(m, texts, fileBudget);
    fileBudget -= files.used;
    used += line.length;
    entries.unshift(files.text ? `${line}\n${files.text}` : line);
  }
  if (entries.length === 0) return '';
  return ["[Earlier in this chat, oldest first. The user's new message is your goal.]", ...entries].join('\n\n');
}

/**
 * Everything a run needs from the chat side, as one block for its system prompt.
 * @param {{ conversation?: string, remoteTarget?: string, canvas?: string, pinned?: string,
 *   vault?: string, web?: string, memory?: string[], instructions?: string[] }} parts
 * @returns {string} '' when there is nothing to add
 */
export function buildRunContext(parts) {
  const p = parts && typeof parts === 'object' ? parts : {};
  /** @type {string[]} */
  const blocks = [];
  if (p.conversation) blocks.push(p.conversation);
  if (p.remoteTarget) {
    blocks.push(
      `[Remote Control is connected to ${p.remoteTarget}. Your tools act on this computer, not on ${p.remoteTarget}. `
      + `For ${p.remoteTarget}, write each command in a fenced bash block; the user can run it there with one click.]`
    );
  }
  const canvas = text(p.canvas).trim();
  if (canvas) blocks.push(`[Canvas notes - treat as the user's working context]\n${clipMiddle(canvas, CONTEXT_MAX_CANVAS_CHARS)}`);
  if (p.pinned) blocks.push(p.pinned);
  if (p.vault) blocks.push(p.vault);
  if (p.web) blocks.push(p.web);
  const memory = (Array.isArray(p.memory) ? p.memory : [])
    .filter((m) => typeof m === 'string' && m.trim())
    .slice(-CONTEXT_MAX_MEMORY_ITEMS);
  if (memory.length) {
    blocks.push(`[Personal memory (private, local). Use as user preferences or context when relevant]\n${memory.map((m, i) => `${i + 1}. ${m.trim()}`).join('\n')}`);
  }
  const instructions = (Array.isArray(p.instructions) ? p.instructions : []).filter((l) => typeof l === 'string' && l.trim());
  if (instructions.length) blocks.push(`[How to answer]\n${instructions.join('\n')}`);
  return blocks.join('\n\n');
}
