// @ts-check
// backend/src/agent/protocol.js
// The wire format between the loop and the model, and a forgiving parser for it.
//
// Native tool-calling is not an option here. Mirabilis targets whatever the user
// has installed, including small local GGUF models, and support ranges from
// excellent to absent. So the contract is plain JSON in the reply text, and the
// parser is deliberately generous: models fence it in ```json, prefix it with
// "Sure!", emit smart quotes, or add a trailing comma. Every one of those is a
// recoverable formatting slip, and failing the whole iteration over it would
// burn the user's budget on punctuation.

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
    (t) => t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"), // smart quotes
    (t) => t.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"')
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

  // Accept {action:"tool", tool:"x"}, the shorthand {tool:"x"}, and the form a
  // real model actually produced: {action:"read_file", args:{...}}, where the
  // tool name is put in the action field. That last one used to be rejected as
  // an unrecognised action and cost the run an entire iteration.
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
