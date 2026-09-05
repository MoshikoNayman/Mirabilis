// @ts-check
// backend/src/agent/auditLog.js
// A durable record of what an autonomous run actually did.
//
// The premise of the long tiers is that nobody is watching. That is exactly why
// there has to be a record: when a run touches something it should not have, the
// live event feed is gone (it lives in a browser tab that was closed hours ago)
// and the transcript only holds the final summary. Without this there is no way
// to answer "what did it run?" after the fact.
//
// One append-only JSONL file per run. Append-only because the interesting case
// is a run that ended badly: a crash mid-write must leave every prior line
// readable, which rules out rewriting a JSON document.

import { appendFile, mkdir, readdir, stat, unlink, readFile } from 'node:fs/promises';
import { hardenFile, ensureSecureDir, SECURE_FILE_MODE } from '../storage/securePaths.js';
import { join } from 'node:path';

/** Keep the log bounded: a 5-hour run can make thousands of calls. */
const MAX_ARG_CHARS = 2_000;
const MAX_RESULT_CHARS = 1_000;

/** Anything that looks like a credential is replaced before it reaches disk. */
const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
const SECRET_KEYVAL_RE = /\b(api[-_]?key|apikey|token|secret|password|passwd|authorization|bearer)\b(\s*[:=]\s*|\s+)("?)([^\s"']{6,})\3/gi;

/** @param {string} text */
export function redact(text) {
  return String(text ?? '')
    .replace(SECRET_RE, '[redacted]')
    .replace(SECRET_KEYVAL_RE, (_m, key, sep, q) => `${key}${sep}${q}[redacted]${q}`);
}

function clip(value, limit) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = redact(text ?? '');
  return text.length > limit ? `${text.slice(0, limit)}...[truncated ${text.length} chars]` : text;
}

/**
 * Open an audit log for one run.
 * Every method is best effort: auditing must never be the reason a run fails.
 *
 * @param {object} args
 * @param {string} args.dir      directory to write into
 * @param {string} args.runId
 * @param {() => string} [args.nowIso]
 */
export function createRunAuditor({ dir, runId, nowIso = () => new Date().toISOString() }) {
  const file = join(dir, `${runId}.jsonl`);
  /** @type {Promise<any>|null} */
  let ready = null;
  let lines = 0;
  let failed = false;

  const ensure = () => {
    if (!ready) ready = ensureSecureDir(dir).then((ok) => { if (!ok) failed = true; });
    return ready;
  };

  /** @param {object} entry */
  const write = async (entry) => {
    if (failed) return;
    try {
      await ensure();
      await appendFile(file, `${JSON.stringify({ at: nowIso(), ...entry })}\n`, { encoding: 'utf8', mode: SECURE_FILE_MODE });
      if (lines === 0) await hardenFile(file);
      lines += 1;
    } catch {
      // A full disk or a read-only volume must not take the run down with it.
      failed = true;
    }
  };

  return {
    file,
    get lineCount() { return lines; },

    /** The run's identity and, importantly, what it was permitted to do. */
    start({ goal, effort, policy, provider, model, fsRoot, limits }) {
      return write({
        kind: 'run-start',
        runId,
        goal: clip(goal, 1_000),
        effort,
        policy,
        provider,
        model,
        fsRoot: fsRoot || null,
        limits
      });
    },

    /** One tool invocation, with the arguments it was actually called with. */
    tool({ iteration, tool, args, mutating }) {
      return write({
        kind: 'tool-call',
        iteration,
        tool,
        mutating: Boolean(mutating),
        // The full command matters more than anything else in this file.
        args: clip(args, MAX_ARG_CHARS)
      });
    },

    result({ iteration, tool, ok, observation }) {
      return write({
        kind: 'tool-result', iteration, tool, ok: Boolean(ok),
        result: clip(observation, MAX_RESULT_CHARS)
      });
    },

    note(kind, payload = {}) {
      return write({ kind, ...payload });
    },

    end({ stopReason, steps, validated, budget, answer }) {
      return write({
        kind: 'run-end',
        stopReason,
        steps,
        validated: Boolean(validated),
        toolCalls: budget?.toolCalls ?? null,
        elapsedMs: budget?.elapsedMs ?? null,
        answer: clip(answer, MAX_RESULT_CHARS)
      });
    }
  };
}

/** Read one run's log back, newest entries last. */
export async function readRunAudit(dir, runId) {
  const raw = await readFile(join(dir, `${runId}.jsonl`), 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { kind: 'unreadable', line }; }
  });
}

/**
 * Drop logs older than `maxAgeDays`, keeping at most `maxFiles`.
 * A record nobody prunes eventually becomes the reason the disk fills.
 */
export async function pruneRunAudits(dir, { maxAgeDays = 30, maxFiles = 500 } = {}) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return { removed: 0 };
  }
  const logs = entries.filter((n) => n.endsWith('.jsonl'));
  const withTimes = [];
  for (const name of logs) {
    try {
      const info = await stat(join(dir, name));
      withTimes.push({ name, mtimeMs: info.mtimeMs });
    } catch { /* raced with a delete */ }
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  let removed = 0;
  for (let i = 0; i < withTimes.length; i += 1) {
    const tooOld = withTimes[i].mtimeMs < cutoff;
    const tooMany = i >= maxFiles;
    if (!tooOld && !tooMany) continue;
    try { await unlink(join(dir, withTimes[i].name)); removed += 1; } catch { /* fine */ }
  }
  return { removed };
}
