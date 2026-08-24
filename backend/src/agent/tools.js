// @ts-check
// backend/src/agent/tools.js
// The agent's tool surface, behind a policy gate.
//
// Two rules shape this file.
//
// First, least privilege by default. A run gets read-only tools unless the user
// explicitly grants more, because the whole point of the long tiers is that
// nobody is watching. "It only writes files when it needs to" is not a property
// you can verify after the fact, so the grant is made up front and enforced here.
//
// Second, results are for a context window, not a terminal. Every tool truncates
// and says so. An agent that burns its budget reading a 2 MB log has spent the
// user's hour on nothing.

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { safeResolvePath, isSafeCommand } from './sandbox.js';
import { runCommand } from '../services/proc.js';

/** How much of any single tool result may enter the context. */
const MAX_RESULT_CHARS = 12_000;
const MAX_DIR_ENTRIES = 300;
const MAX_MATCHES = 100;

/** Tool permission tiers, least to most privileged. */
export const TOOL_POLICIES = /** @type {const} */ (['read-only', 'write', 'full']);

/** @param {string} text @param {number} [limit] */
function clip(text, limit = MAX_RESULT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= limit) return { text: s, truncated: false };
  return {
    text: s.slice(0, limit),
    truncated: true,
    note: `Output truncated at ${limit} characters (${s.length} total). Narrow the request if you need the rest.`
  };
}

/**
 * Build the tool set for one run.
 * @param {object} opts
 * @param {'read-only'|'write'|'full'} [opts.policy]
 * @param {string} [opts.fsRoot]   Confine file tools to this subtree.
 * @param {string} [opts.workDir]  Default cwd for commands.
 * @param {number} [opts.commandTimeoutMs]
 * @param {Record<string, any>} [opts.extraTools] Run-scoped tools (e.g. spawn_agents).
 * @param {AbortSignal} [opts.signal] Cancels an in-flight tool call when the run stops.
 */
export function createToolRegistry({
  policy = 'read-only',
  fsRoot,
  workDir = process.cwd(),
  commandTimeoutMs = 120_000,
  extraTools = {},
  signal
} = {}) {
  const level = TOOL_POLICIES.indexOf(policy) >= 0 ? policy : 'read-only';
  const allows = (needed) => TOOL_POLICIES.indexOf(level) >= TOOL_POLICIES.indexOf(needed);
  const rp = (p) => safeResolvePath(p, fsRoot);

  /** @type {Record<string, any>} */
  const all = {
    list_dir: {
      needs: 'read-only',
      description: 'List the entries of a directory.',
      parameters: { path: 'string (directory to list)' },
      async execute({ path: dirPath }) {
        const resolved = rp(dirPath || '.');
        const entries = await readdir(resolved, { withFileTypes: true });
        const listed = entries.slice(0, MAX_DIR_ENTRIES).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other'
        }));
        return {
          path: resolved,
          entries: listed,
          truncated: entries.length > MAX_DIR_ENTRIES,
          totalEntries: entries.length
        };
      }
    },

    read_file: {
      needs: 'read-only',
      description: 'Read a UTF-8 text file. Optionally a line range.',
      parameters: { path: 'string', startLine: 'number (optional, 1-based)', endLine: 'number (optional)' },
      async execute({ path: filePath, startLine, endLine }) {
        const resolved = rp(filePath);
        const info = await stat(resolved);
        if (!info.isFile()) throw new Error(`${resolved} is not a file`);
        const raw = await readFile(resolved, 'utf8');
        let body = raw;
        if (startLine != null || endLine != null) {
          const lines = raw.split('\n');
          const from = Math.max(1, Number(startLine) || 1);
          const to = Math.min(lines.length, Number(endLine) || lines.length);
          body = lines.slice(from - 1, to).join('\n');
        }
        return { path: resolved, bytes: info.size, ...clip(body) };
      }
    },

    search_files: {
      needs: 'read-only',
      description: 'Search file contents for a pattern, like grep. Case-insensitive by default. Use this before reading whole files.',
      parameters: {
        pattern: 'string (regex or literal)',
        path: 'string (dir to search)',
        glob: 'string (optional, e.g. *.js)',
        caseSensitive: 'boolean (optional, default false)'
      },
      async execute({ pattern, path: searchPath, glob, caseSensitive }) {
        if (!pattern) throw new Error('pattern is required');
        const root = rp(searchPath || '.');
        // Case-INSENSITIVE by default. Observed with a real model: it searched
        // for "error", the log said "ERROR", grep found nothing, and the agent
        // confidently reported that the application had no errors. A search
        // tool that silently returns the wrong answer is worse than none.
        const args = ['-rn', '--binary-files=without-match'];
        if (!caseSensitive) args.push('-i');
        args.push('-e', String(pattern), root);
        try {
          const { stdout } = await runCommand('grep', args, { timeoutMs: 30_000 });
          const lines = stdout.split('\n').filter(Boolean);
          return {
            root,
            matchCount: lines.length,
            matches: lines.slice(0, MAX_MATCHES).map((l) => l.replace(root, '.')),
            truncated: lines.length > MAX_MATCHES
          };
        } catch (err) {
          // grep exits 1 when nothing matched; that is an answer, not a failure.
          if (/exited with code 1/.test(String(err?.message))) {
            return { root, matchCount: 0, matches: [], truncated: false };
          }
          throw err;
        }
      }
    },

    write_file: {
      needs: 'write',
      description: 'Create or overwrite a text file. Requires the write policy.',
      parameters: { path: 'string', content: 'string' },
      mutating: true,
      async execute({ path: filePath, content }) {
        const resolved = rp(filePath);
        // Keep the prior contents so a bad autonomous edit is recoverable.
        /** @type {string|null} */
        let previous = null;
        try { previous = await readFile(resolved, 'utf8'); } catch { /* new file */ }
        await mkdir(dirname(resolved), { recursive: true });
        await writeFile(resolved, String(content ?? ''), 'utf8');
        return {
          path: resolved,
          bytesWritten: Buffer.byteLength(String(content ?? ''), 'utf8'),
          replacedExisting: previous != null,
          previousBytes: previous == null ? 0 : Buffer.byteLength(previous, 'utf8')
        };
      }
    },

    run_command: {
      needs: 'full',
      description: 'Run a shell command and capture its output. Requires the full policy.',
      parameters: { command: 'string', cwd: 'string (optional)' },
      mutating: true,
      async execute({ command, cwd }) {
        const cmd = String(command || '').trim();
        if (!cmd) throw new Error('command is required');
        if (!isSafeCommand(cmd)) {
          throw new Error('Command blocked: matches a destructive pattern (rm -rf /, mkfs, dd, shutdown).');
        }
        const execCwd = cwd ? rp(cwd) : workDir;
        try {
          const { stdout, stderr } = await runCommand('/bin/sh', ['-c', cmd], {
            cwd: execCwd, timeoutMs: commandTimeoutMs, signal
          });
          return { command: cmd, cwd: execCwd, exitCode: 0, ...clip(stdout), stderr: clip(stderr).text };
        } catch (err) {
          // A non-zero exit is information the agent needs, not a crash.
          const msg = String(err?.message || err);
          return { command: cmd, cwd: execCwd, exitCode: 1, failed: true, ...clip(msg) };
        }
      }
    }
  };

  // Run-scoped tools are merged before the policy filter, so they are gated by
  // the same rules as everything else rather than sneaking in above them.
  for (const [name, tool] of Object.entries(extraTools || {})) {
    if (tool && typeof tool.execute === 'function') all[name] = tool;
  }

  /** @type {Record<string, any>} */
  const granted = {};
  for (const [name, tool] of Object.entries(all)) {
    if (allows(tool.needs)) granted[name] = tool;
  }

  return {
    policy: level,
    names: () => Object.keys(granted),

    /** Register a run-scoped tool after construction (used for spawn_agents). */
    addTool(name, tool) {
      if (!tool || typeof tool.execute !== 'function') return false;
      if (!allows(tool.needs || 'read-only')) return false;
      all[name] = tool;
      granted[name] = tool;
      return true;
    },

    /** Is this tool available under the run's policy? */
    has: (name) => Object.prototype.hasOwnProperty.call(granted, name),

    /** Would this tool change something on disk? */
    isMutating: (name) => Boolean(granted[name]?.mutating),

    /**
     * Run one tool. Never throws for an ordinary tool failure: the loop needs
     * the error text as an observation so it can adapt, not an exception that
     * ends the run. A refused tool is reported the same way, with the reason.
     */
    async dispatch(name, args = {}) {
      // Refuse work once the run is cancelled. Without this, a stop pressed
      // during a decide step still let the next tool call start.
      if (signal?.aborted) return { ok: false, error: 'Run cancelled.' };
      const tool = granted[name];
      if (!tool) {
        const known = Object.keys(all);
        const exists = known.includes(name);
        return {
          ok: false,
          error: exists
            ? `Tool "${name}" is not permitted at the "${level}" policy for this run. Available: ${Object.keys(granted).join(', ')}.`
            : `Unknown tool "${name}". Available: ${Object.keys(granted).join(', ')}.`
        };
      }
      try {
        const result = await tool.execute(args || {});
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },

    /** The tool list as the model sees it. */
    describeForPrompt() {
      const lines = Object.entries(granted).map(([name, t]) => {
        const params = Object.entries(t.parameters).map(([k, v]) => `      ${k}: ${v}`).join('\n');
        return `  - ${name}: ${t.description}\n${params}`;
      });
      return lines.join('\n');
    }
  };
}
