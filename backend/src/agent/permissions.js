// @ts-check
// Turn an access level plus a tool call into allow / ask / deny. The one place
// that reads the level; the loop and routes act on the verdict it returns.

import { classifyCommand, matchesAllowRules, ruleForCommand } from './commandPolicy.js';

/** @type {Array<'chat'|'read'|'ask'|'bypass'>} */
export const ACCESS_LEVELS = ['chat', 'read', 'ask', 'bypass'];

// Labels match frontend/src/lib/access.js.
export const ACCESS_META = {
  chat: { label: 'Chat only' },
  read: { label: 'Read only' },
  ask: { label: 'Ask first' },
  bypass: { label: 'Bypass permissions' }
};

/** @param {any} x @returns {'chat'|'read'|'ask'|'bypass'} */
export function normalizeLevel(x) {
  return ACCESS_LEVELS.includes(x) ? x : 'chat';
}

/** The more restrictive of two levels (chat < read < ask < bypass). */
export function lowerLevel(a, b) {
  const ia = ACCESS_LEVELS.indexOf(normalizeLevel(a));
  const ib = ACCESS_LEVELS.indexOf(normalizeLevel(b));
  return ACCESS_LEVELS[Math.min(ia, ib)];
}

// Returned to the model on a denial.
const GO_DARK_REASON = 'Go Dark is on, so network commands are paused. Turn off Go Dark or use Bypass permissions.';
// Shown on the approval card, beside its "Uses network" badge.
const GO_DARK_ASK_REASON = 'Go Dark is on.';

/**
 * @typedef {object} ApprovalRequest
 * @property {'command'|'write'|'connector'|'other'} kind
 * @property {string} title
 * @property {string} detail
 * @property {'changes-files'|'not-read-only'|'network-go-dark'|'connector-ask'} reasonCode
 * @property {string} reason
 * @property {string|null} alwaysLabel
 * @property {{type:'command', rule:string}|{type:'writes'}|{type:'connector', tool:string}|null} alwaysRule
 * @property {boolean} network
 */

/** @param {any} v @param {number} limit */
function clip(v, limit) {
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return s.length > limit ? `${s.slice(0, limit)}...` : s;
}

/** Old block removed then new block added; the whole edit, capped. */
function miniDiff(oldStr, newStr) {
  const minus = String(oldStr ?? '').split('\n').map((l) => `- ${l}`);
  const plus = String(newStr ?? '').split('\n').map((l) => `+ ${l}`);
  const lines = [...minus, ...plus];
  const max = 40;
  if (lines.length > max) return `${lines.slice(0, max).join('\n')}\n... (${lines.length - max} more lines)`;
  return lines.join('\n');
}

/** Path, size and the first lines of what will be written. @param {any} args */
function writePreview(args) {
  const path = String(args?.path ?? '');
  const content = String(args?.content ?? '');
  const bytes = Buffer.byteLength(content, 'utf8');
  const head = content.split('\n').slice(0, 20).join('\n');
  return `${path}\n${bytes} byte(s)\n\n${head}`;
}

/** @param {string} tool @param {any} args */
function writeDetail(tool, args) {
  if (tool === 'edit_file') return `${String(args?.path ?? '')}\n\n${miniDiff(args?.old, args?.new)}`;
  return writePreview(args);
}

/**
 * @param {object} p
 * @param {'chat'|'read'|'ask'|'bypass'} p.level
 * @param {string} p.tool
 * @param {object} p.args
 * @param {{kind:'read'|'write'|'command'|'connector'|'internal', readOnly?:boolean, permission?:'allow'|'ask'|'off', connectorName?:string, mcpTool?:string}} p.info
 * @param {{allowWrites:boolean, commandRules:string[], connectorTools:string[]}} p.runRules
 * @param {string[]} p.allowCommands
 * @param {boolean} p.goDark
 * @param {string} [p.platform]
 * @returns {{action:'allow'|'ask'|'deny', reason:string, request?:ApprovalRequest}}
 */
export function decide(p) {
  const level = normalizeLevel(p.level);
  const info = p.info || /** @type {any} */ ({});
  const kind = info.kind;
  const runRules = p.runRules || { allowWrites: false, commandRules: [], connectorTools: [] };
  const platform = p.platform || process.platform;

  if (level === 'chat') {
    return { action: 'deny', reason: 'Chat only: tools are off. Change Access to use them.' };
  }

  // Connector 'off' is never offered, at any level.
  if (kind === 'connector' && info.permission === 'off') {
    return { action: 'deny', reason: 'This connector tool is off. Turn it on in Connectors.' };
  }

  if (level === 'bypass') {
    return { action: 'allow', reason: 'Bypass permissions: runs without approval.' };
  }

  if (kind === 'read' || kind === 'internal') {
    return { action: 'allow', reason: 'Read-only action.' };
  }

  if (kind === 'write') {
    if (level === 'read') {
      return { action: 'deny', reason: 'Read only: changing files is off. Switch Access to Ask first.' };
    }
    // ask
    if (runRules.allowWrites) return { action: 'allow', reason: 'File changes allowed for this run.' };
    const title = p.tool === 'edit_file' ? 'Edit a file' : 'Write a file';
    return {
      action: 'ask',
      reason: 'This changes a file on disk.',
      request: {
        kind: 'write',
        title,
        detail: writeDetail(p.tool, p.args || {}),
        reasonCode: 'changes-files',
        reason: 'This changes a file on disk.',
        alwaysLabel: 'Allow for this run',
        alwaysRule: { type: 'writes' },
        network: false
      }
    };
  }

  if (kind === 'command') {
    const command = String(/** @type {any} */ (p.args)?.command ?? '');
    const c = classifyCommand(command, { platform });
    const networkBlocked = Boolean(p.goDark && c.network);
    const ruled = matchesAllowRules(command, [...(p.allowCommands || []), ...runRules.commandRules], { platform });
    const wouldAllow = c.readOnly || ruled;

    if (level === 'read') {
      if (c.readOnly && !networkBlocked) return { action: 'allow', reason: 'Read-only command.' };
      const reason = !c.readOnly
        ? 'Read only: this command may change things. Switch Access to Ask first.'
        : GO_DARK_REASON;
      return { action: 'deny', reason };
    }

    // ask
    if (wouldAllow && !networkBlocked) {
      return { action: 'allow', reason: c.readOnly ? 'Read-only command.' : 'Matches an allowed command.' };
    }
    const reasonCode = networkBlocked ? 'network-go-dark' : 'not-read-only';
    const reason = networkBlocked ? GO_DARK_ASK_REASON : 'This command is not known to be read-only.';
    const offerAlways = !networkBlocked;
    const rule = offerAlways ? ruleForCommand(command, { platform }) : '';
    return {
      action: 'ask',
      reason,
      request: {
        kind: 'command',
        title: 'Run a command',
        detail: command,
        reasonCode,
        reason,
        alwaysLabel: offerAlways && rule ? `Always allow \`${rule}\`` : null,
        alwaysRule: offerAlways && rule ? { type: 'command', rule } : null,
        network: c.network
      }
    };
  }

  if (kind === 'connector') {
    const tool = p.tool;
    if (level === 'read') {
      if (info.readOnly === true) return { action: 'allow', reason: 'Read-only connector tool.' };
      return { action: 'deny', reason: 'Read only: this connector tool can change things. Switch Access to Ask first.' };
    }
    // ask
    if (info.permission === 'allow' || (runRules.connectorTools || []).includes(tool)) {
      return { action: 'allow', reason: 'Connector tool allowed.' };
    }
    const mcpTool = info.mcpTool || tool;
    return {
      action: 'ask',
      reason: `Use ${info.connectorName || 'connector'}: ${mcpTool}`,
      request: {
        kind: 'connector',
        title: `Use ${info.connectorName || 'connector'}: ${mcpTool}`,
        detail: `Arguments: ${clip(p.args || {}, 400)}`,
        reasonCode: 'connector-ask',
        reason: `This runs ${mcpTool} on ${info.connectorName || 'a connector'}.`,
        alwaysLabel: `Always allow \`${mcpTool}\``,
        alwaysRule: { type: 'connector', tool },
        network: false
      }
    };
  }

  // Unknown kind: safest is to ask in ask, deny in read.
  if (level === 'read') return { action: 'deny', reason: 'Read only: this action may change things. Switch Access to Ask first.' };
  return {
    action: 'ask',
    reason: 'This action needs your approval.',
    request: {
      kind: 'other',
      title: `Run ${p.tool}`,
      detail: clip(p.args || {}, 400),
      reasonCode: 'not-read-only',
      reason: 'This action is not known to be read-only.',
      alwaysLabel: null,
      alwaysRule: null,
      network: false
    }
  };
}
