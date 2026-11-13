// @ts-check
// Agent actions as plain JSON in the reply text, since small local models lack
// native tool calls. The parser repairs fences, prose, smart quotes and trailing commas.

/** @typedef {{kind:'tool', tool:string, args:object, thought:string}} ToolAction */
/** @typedef {{kind:'finish', summary:string, thought:string}} FinishAction */
/** @typedef {{kind:'invalid', error:string, raw:string}} InvalidAction */

/** Pull the first balanced {...} block out of arbitrary prose. */
function extractJsonObject(text) {
  const s = String(text || '');
  // Prefer a fenced block when present: it is the least ambiguous.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced ? [fenced[1], s] : [s];

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return candidate.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Repair the formatting slips that are not worth an iteration. */
function tolerantParse(jsonText) {
  const attempts = [
    (t) => t,
    (t) => t.replace(/,\s*([}\]])/g, '$1'),              // trailing commas
    (t) => t.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'"), // smart quotes
    (t) => t.replace(/,\s*([}\]])/g, '$1').replace(/[\u201C\u201D]/g, '"')
  ];
  for (const fix of attempts) {
    try { return JSON.parse(fix(jsonText)); } catch { /* try the next repair */ }
  }
  return null;
}

/**
 * Parse one model reply into an action.
 * @param {string} text
 * @returns {ToolAction|FinishAction|InvalidAction}
 */
export function parseAgentAction(text) {
  const raw = String(text || '');
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return { kind: 'invalid', error: 'No JSON object found in the reply. Respond with a single JSON object.', raw };
  }
  const parsed = tolerantParse(jsonText);
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'invalid', error: 'The JSON object could not be parsed.', raw };
  }

  const thought = String(parsed.thought || parsed.reasoning || '').slice(0, 2000);
  const action = String(parsed.action || parsed.type || '').toLowerCase();

  if (action === 'finish' || action === 'done' || action === 'complete') {
    return {
      kind: 'finish',
      summary: String(parsed.summary || parsed.answer || parsed.result || '').slice(0, 20_000),
      thought
    };
  }

  // Accept {action:"tool", tool:"x"}, {tool:"x"}, and {action:"read_file", args:{...}},
  // which local models emit.
  let toolName = String(parsed.tool || parsed.tool_name || parsed.name || '').trim();
  const looksLikeToolName = action && action !== 'tool' && action !== 'finish'
    && action !== 'done' && action !== 'complete'
    && /^[a-z][a-z0-9_]*$/.test(action);
  if (!toolName && looksLikeToolName) toolName = action;

  if (action === 'tool' || toolName) {
    if (!toolName) {
      return { kind: 'invalid', error: 'action was "tool" but no tool name was given.', raw };
    }
    const args = parsed.args ?? parsed.arguments ?? parsed.parameters ?? {};
    return {
      kind: 'tool',
      tool: toolName,
      args: (args && typeof args === 'object') ? args : {},
      thought
    };
  }

  return {
    kind: 'invalid',
    error: `Unrecognised action "${action || '(missing)'}". Use "tool" or "finish".`,
    raw
  };
}

/** Most parts one split may hold, and how long each part may be. */
const MAX_SPLIT_PARTS = 16;
const MAX_PART_CHARS = 2_000;
const MAX_FOLDED_PART_CHARS = 4_000;

/**
 * Read the parts out of a split reply: {"parts": [...]}, {"tasks": [...]} or a bare
 * array, each part a string or {goal}. Parts beyond `max` are folded round-robin into
 * the kept ones as an "Also:" line, so no part is dropped. Unreadable gives [].
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
export function parseSplit(text, max = MAX_SPLIT_PARTS) {
  const raw = String(text || '');
  /** @type {any[]|null} */
  let items = null;
  const jsonText = extractJsonObject(raw);
  const parsed = jsonText ? tolerantParse(jsonText) : null;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.parts)) items = parsed.parts;
    else if (Array.isArray(parsed.tasks)) items = parsed.tasks;
  }
  if (!items) {
    // Small models often reply with the array alone.
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    const bare = start !== -1 && end > start ? tolerantParse(raw.slice(start, end + 1)) : null;
    if (Array.isArray(bare)) items = bare;
  }
  if (!items) return [];

  /** @type {string[]} */
  const parts = [];
  for (const item of items) {
    const value = typeof item === 'string' ? item : item?.goal;
    if (typeof value !== 'string') continue;
    const part = value.trim().slice(0, MAX_PART_CHARS);
    if (!part || parts.includes(part)) continue;
    parts.push(part);
    if (parts.length >= MAX_SPLIT_PARTS) break;
  }

  const limit = Math.floor(Number(max) || 0);
  if (limit < 1) return [];
  if (parts.length <= limit) return parts;
  const kept = parts.slice(0, limit);
  parts.slice(limit).forEach((extra, i) => {
    const at = i % limit;
    kept[at] = `${kept[at]}\nAlso: ${extra}`.slice(0, MAX_FOLDED_PART_CHARS);
  });
  return kept;
}

/** The contract, stated for the model. */
export function protocolInstructions(toolDescription) {
  return [
    'You are working autonomously toward a goal. Reply with EXACTLY ONE JSON object and nothing else.',
    '',
    'To use a tool:',
    '  {"thought": "why this step", "action": "tool", "tool": "<name>", "args": { ... }}',
    '',
    'When the goal is genuinely achieved:',
    '  {"thought": "why it is done", "action": "finish", "summary": "<the complete answer or a report of what you did>"}',
    '',
    'Available tools:',
    toolDescription || '  (none: you must reason to a conclusion and finish)',
    '',
    'Rules:',
    '- One JSON object per reply. No prose outside it.',
    '- Take one step at a time and use what you observe before deciding the next.',
    '- Do not claim something is verified unless a tool result actually shows it.',
    '- Finish as soon as the goal is met. Do not pad the work to fill the budget.'
  ].join('\n');
}
