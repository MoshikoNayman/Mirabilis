// @ts-check
// Agent tools behind a policy gate: read-only unless the user grants more up front.
// Every tool truncates its result to fit the context window, and says so.

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
/** Keep the end of command output, where test runners print failures and summaries. */
function tail(text, limit = MAX_RESULT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return `[... ${s.length - limit} earlier characters omitted ...]\n${s.slice(-limit)}`;
}

/** Directories that are never worth searching. */
const SEARCH_EXCLUDE_DIRS = ['.git', 'node_modules', 'target', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache'];

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
        // Case-insensitive by default: models search "error" in logs that say "ERROR"
        // and treat no match as no errors.
        const args = ['-rn', '--binary-files=without-match'];
        for (const dir of SEARCH_EXCLUDE_DIRS) args.push(`--exclude-dir=${dir}`);
        if (glob) args.push(`--include=${String(glob)}`);
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
          if (err?.exitCode === 1 || /exited with code 1/.test(String(err?.message))) {
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
          return { command: cmd, cwd: execCwd, exitCode: 0, stdout: tail(stdout), stderr: tail(stderr, 4000) };
        } catch (err) {
          // A non-zero exit is information the agent needs, not a crash.
          const exitCode = typeof err?.exitCode === 'number' ? err.exitCode : null;
          return {
            command: cmd,
            cwd: execCwd,
            exitCode,
            failed: true,
            error: exitCode === null ? String(err?.message || err) : undefined,
            stdout: tail(err?.stdout),
            stderr: tail(err?.stderr, 4000)
          };
        }
      }
    }
  };

  // Merge run-scoped tools before the policy filter so the same gate applies.
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
     * Run one tool. Failures and refusals come back as results with the reason,
     * so the loop can adapt instead of ending the run.
     */
    async dispatch(name, args = {}) {
      // A stop pressed during a decide step must not let the next tool call start.
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
