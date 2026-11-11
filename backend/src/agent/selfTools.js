// @ts-check
// Mirabilis looking at itself: version, data folder, its own logs, and a map of how it is built.
// Read-only. Data files are reported by name and size, never by content.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, stat } from 'node:fs/promises';

import { APP_VERSION, APP_SEMVER } from '../version.js';
import { formatDuration, tailTextFile, TEXT_BUDGET } from './systemTools.js';

/** backend/src/agent, three levels up: the repo root, or the packaged app's resources folder. */
const DEFAULT_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ARCHITECTURE_DOC = path.join('docs', 'ARCHITECTURE.md');
const READ_SOURCE_NOTE = 'Read the source with read_file and search_files under sourceRoot.';
const STATUS_TIMEOUT_MS = 5_000;

const LOG_DEFAULT_LINES = 200;
const LOG_MAX_LINES = 2_000;
/** Per-log metadata costs characters too; keep the whole result under the observation limit. */
const LOG_META_CHARS = 200;

const MAX_DATA_ENTRIES = 60;
const MAX_DIR_SCAN = 5_000;

const LISTING_DIRS = ['backend/src', 'frontend/src'];
const LISTING_SKIP = new Set(['node_modules', '.next', 'testdata', 'dist', 'build', '.git', 'coverage']);
const SOURCE_FILE = /\.(js|jsx|mjs|cjs|ts|tsx)$/;
const TEST_FILE = /\.(test|spec)\.[a-z]+$/;
const MAX_LISTING_FILES = 400;

/** @param {any} value @param {number} min @param {number} max @param {number} fallback */
function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** @param {string} text @param {number} limit */
function clip(text, limit) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit - 3)}...` : s;
}

/** @param {any} err */
const reason = (err) => String(err?.message || err);

/**
 * Where Mirabilis writes logs: the launcher (node run.js) uses the temp folder, the
 * desktop app uses Electron's logs folder, which is <dataDir>/logs off macOS.
 * @param {{platform?: string, dataDir?: string, home?: string, tmp?: string}} [opts]
 */
export function defaultLogFiles({ platform = process.platform, dataDir, home = os.homedir(), tmp = os.tmpdir() } = {}) {
  const files = ['backend.log', 'frontend.log', 'image-service.log'].map((n) => path.join(tmp, n));
  if (platform === 'darwin') {
    for (const n of ['backend.log', 'frontend.log']) files.push(path.join(home, 'Library', 'Logs', 'Mirabilis AI', n));
  } else if (dataDir) {
    for (const n of ['backend.log', 'frontend.log']) files.push(path.join(dataDir, 'logs', n));
  }
  return [...new Set(files)];
}

/**
 * The first comment of a file, when the file opens with one. Comments further down
 * describe a line of code, not the file, so they are not used.
 * @param {string} text
 */
export function headerComment(text) {
  const lines = String(text || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    const skip = !t || t.startsWith('#!') || /^\/\/\s*@ts-(no)?check/.test(t)
      || /^['"]use (strict|client|server)['"];?$/.test(t);
    if (!skip) break;
    i += 1;
  }
  const head = (lines[i] || '').trim();
  if (head.startsWith('//')) {
    // House headers run to two lines; the second usually finishes the sentence.
    const next = (lines[i + 1] || '').trim();
    const second = next.startsWith('//') ? next.replace(/^\/\/+/, '') : '';
    return clip(`${head.replace(/^\/\/+/, '')} ${second}`, 160);
  }
  if (!head.startsWith('/*')) return '';
  let found = head.replace(/^\/\*+/, '').replace(/\*\/.*$/, '').trim();
  let j = i;
  while (!found && !lines[j].includes('*/') && j + 1 < lines.length) {
    j += 1;
    const t = lines[j].trim().replace(/^\*+\s?/, '').replace(/\*\/.*$/, '').trim();
    if (t && !t.startsWith('@')) found = t;
  }
  return clip(found, 120);
}

/**
 * Markdown headings outside code fences, with their line index.
 * @param {string[]} lines
 */
function headings(lines) {
  /** @type {Array<{level: number, title: string, line: number}>} */
  const found = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const m = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (m) found.push({ level: m[1].length, title: m[2], line: index });
  });
  return found;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.sourceRoot]  Folder holding backend/, frontend/ and docs/.
 * @param {string} [opts.dataDir]     The data folder (chats, settings, run logs).
 * @param {string[]} [opts.logFiles]  Log paths to look for; defaults to defaultLogFiles().
 * @param {() => any} [opts.getStatus] Live app state merged into mirabilis_status.
 * @param {number} [opts.statusTimeoutMs]
 */
export function createSelfTools({ sourceRoot, dataDir, logFiles, getStatus, statusTimeoutMs = STATUS_TIMEOUT_MS } = {}) {
  const root = path.resolve(sourceRoot || DEFAULT_SOURCE_ROOT);
  const logs = Array.isArray(logFiles) ? logFiles.map(String) : defaultLogFiles({ dataDir });

  /**
   * File count and bytes under a folder, bounded so a huge uploads folder stays cheap.
   * @param {string} dir
   */
  async function folderSize(dir) {
    let files = 0;
    let bytes = 0;
    let seen = 0;
    let partial = false;
    const stack = [dir];
    while (stack.length && !partial) {
      const cur = /** @type {string} */ (stack.pop());
      let entries;
      try { entries = await readdir(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (seen >= MAX_DIR_SCAN) { partial = true; break; }
        seen += 1;
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) {
          files += 1;
          const s = await stat(full).catch(() => null);
          if (s) bytes += s.size;
        }
      }
    }
    return partial ? { files, bytes, partial } : { files, bytes };
  }

  async function dataFiles() {
    if (!dataDir) return { error: 'The data folder is not configured.' };
    let entries;
    try {
      entries = await readdir(dataDir, { withFileTypes: true });
    } catch (err) {
      return { error: `Cannot read ${dataDir}: ${reason(err)}` };
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    /** @type {Array<Record<string, any>>} */
    const rows = [];
    for (const e of entries) {
      if (e.name === '.DS_Store') continue;
      if (rows.length >= MAX_DATA_ENTRIES) break;
      const full = path.join(dataDir, e.name);
      if (e.isDirectory()) rows.push({ name: `${e.name}/`, ...(await folderSize(full)) });
      else if (e.isFile()) {
        const s = await stat(full).catch(() => null);
        rows.push({ name: e.name, bytes: s ? s.size : null });
      }
    }
    return rows;
  }

  async function foundLogs() {
    /** @type {Array<{path: string, bytes: number, modified: string, mtimeMs: number}>} */
    const found = [];
    for (const file of logs) {
      const s = await stat(file).catch(() => null);
      if (s?.isFile()) found.push({ path: file, bytes: s.size, modified: s.mtime.toISOString(), mtimeMs: s.mtimeMs });
    }
    return found;
  }

  /** getStatus probes the network (Ollama), so it is bounded and never fatal. */
  async function liveStatus() {
    if (typeof getStatus !== 'function') return {};
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => getStatus()),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`status check took longer than ${statusTimeoutMs / 1000}s`)), statusTimeoutMs);
        })
      ]);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      return value == null ? {} : { status: value };
    } catch (err) {
      return { statusError: reason(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** @param {string} dir @param {string[]} out */
  async function walkSources(dir, out) {
    if (out.length >= MAX_LISTING_FILES) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_LISTING_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!LISTING_SKIP.has(e.name)) await walkSources(full, out);
      } else if (e.isFile() && SOURCE_FILE.test(e.name) && !TEST_FILE.test(e.name)) {
        out.push(full);
      }
    }
  }

  async function generatedListing() {
    const lines = [];
    for (const rel of LISTING_DIRS) {
      /** @type {string[]} */
      const files = [];
      await walkSources(path.join(root, rel), files);
      for (const file of files) {
        let desc = '';
        try { desc = headerComment((await readFile(file, 'utf8')).slice(0, 4_000)); } catch { /* unreadable: list it bare */ }
        const name = path.relative(root, file).split(path.sep).join('/');
        lines.push(desc ? `${name}: ${desc}` : name);
      }
    }
    return lines.join('\n');
  }

  /** @type {Record<string, any>} */
  const tools = {
    mirabilis_status: {
      kind: 'read',
      mutating: false,
      description: 'Mirabilis itself: version, uptime, where its code and data live, data file sizes, '
        + 'its log files, and the live state of Go Dark, access, models, providers and connectors.',
      parameters: {},
      async execute() {
        const [data, logFound, live] = await Promise.all([dataFiles(), foundLogs(), liveStatus()]);
        /** @type {Record<string, any>} */
        const out = {
          version: APP_VERSION,
          semver: APP_SEMVER,
          node: process.version,
          pid: process.pid,
          uptime: formatDuration(process.uptime()),
          platform: `${process.platform} ${process.arch}`,
          sourceRoot: root,
          dataDir: dataDir || null,
          dataFiles: data,
          logFiles: logFound.map(({ mtimeMs: _m, ...rest }) => rest)
        };
        // Live state adds to the report; it never replaces the facts above.
        for (const [key, value] of Object.entries(live)) if (!(key in out)) out[key] = value;
        return out;
      }
    },

    mirabilis_logs: {
      kind: 'read',
      mutating: false,
      description: "The newest lines of Mirabilis's own logs, with secrets removed. "
        + 'Use it when Mirabilis itself misbehaves: failed replies, slow starts, connector errors.',
      parameters: {
        which: 'string (optional: backend, frontend or all; default backend)',
        lines: `number (optional: lines from the end of each log, default ${LOG_DEFAULT_LINES}, max ${LOG_MAX_LINES})`,
        filter: 'string (optional: keep only lines containing this text)'
      },
      async execute(args = {}) {
        const a = args || {};
        const requested = String(a.which || 'backend').toLowerCase();
        const which = ['backend', 'frontend', 'all'].includes(requested) ? requested : 'backend';
        const lines = clampInt(a.lines, 1, LOG_MAX_LINES, LOG_DEFAULT_LINES);
        const filter = String(a.filter ?? '').trim();
        const wanted = logs.filter((f) => which === 'all' || path.basename(f).toLowerCase().startsWith(which));
        // Newest first: when the launcher and the desktop app both left logs, the
        // live one is the one written last.
        const present = (await foundLogs())
          .filter((l) => wanted.includes(l.path))
          .sort((x, y) => y.mtimeMs - x.mtimeMs);
        const scope = `last ${lines} lines of each log${filter ? `, filtered by "${clip(filter, 60)}"` : ''}`;
        if (!present.length) {
          return { which, scope, logs: [], note: `No ${which === 'all' ? '' : `${which} `}log file exists yet. Looked for: ${wanted.join(', ') || '(none configured)'}` };
        }
        let remaining = Math.max(1_200, TEXT_BUDGET - LOG_META_CHARS * (present.length - 1));
        const results = [];
        for (let i = 0; i < present.length; i += 1) {
          const share = Math.floor(remaining / (present.length - i));
          try {
            const tail = await tailTextFile(present[i].path, { lines, filter, budget: share });
            remaining -= tail.text.length;
            results.push({ path: present[i].path, ...tail });
          } catch (err) {
            results.push({ path: present[i].path, error: reason(err) });
          }
        }
        return { which, scope, logs: results };
      }
    },

    mirabilis_architecture: {
      kind: 'read',
      mutating: false,
      description: 'How Mirabilis is built: processes and ports, the path of a chat message, the agent loop, '
        + 'access levels, Go Dark, connectors, storage and the desktop app. Call it first for any question '
        + 'about how Mirabilis works, then read the source.',
      parameters: {
        section: 'string (optional: return only the section whose heading contains this text)'
      },
      async execute(args = {}) {
        const a = args || {};
        const docPath = path.join(root, ARCHITECTURE_DOC);
        let text;
        try {
          text = await readFile(docPath, 'utf8');
        } catch {
          return {
            sourceRoot: root,
            generated: true,
            note: `${ARCHITECTURE_DOC} is missing, so this is a file list with each file's header comment. ${READ_SOURCE_NOTE}`,
            text: (await generatedListing()) || 'No backend/src or frontend/src folder under sourceRoot.'
          };
        }
        const lines = text.split('\n');
        const heads = headings(lines);
        const titles = heads.filter((x) => x.level >= 2).map((x) => x.title);
        const note = `${READ_SOURCE_NOTE} Pass section to get one part of this map.`;
        const query = String(a.section ?? '').trim().toLowerCase();
        if (!query) return { sourceRoot: root, doc: docPath, note, sections: titles, text };

        const hit = heads.find((x) => x.title.toLowerCase() === query)
          || heads.find((x) => x.title.toLowerCase().startsWith(query))
          || heads.find((x) => x.title.toLowerCase().includes(query));
        if (!hit) return { sourceRoot: root, doc: docPath, error: `No section heading contains "${clip(query, 60)}".`, sections: titles };
        const next = heads.find((x) => x.line > hit.line && x.level <= hit.level);
        const body = lines.slice(hit.line, next ? next.line : lines.length).join('\n').trim();
        return { sourceRoot: root, doc: docPath, section: hit.title, note: READ_SOURCE_NOTE, text: body };
      }
    }
  };

  return tools;
}
