// backend/src/workspace.js
// Watched Workspace: point Mirabilis at a local folder, list its text files, and
// read any file's FRESH bytes on demand. A single active watched root is held in
// memory (like remoteState in server.js). Every read is jailed to that root so a
// relative path can never escape the watched folder. This is the local-first
// superpower a cloud chat app cannot offer: live filesystem context that is
// pulled straight from disk at send time instead of a stale one-off upload.

import { watch } from 'node:fs';
import { stat, readdir, readFile as fsReadFile } from 'node:fs/promises';
import { resolve, normalize, sep, join, relative } from 'node:path';

// Skip files bigger than this in the listing (they are almost never useful as
// chat context and keep the tree cheap to scan).
const MAX_LIST_BYTES = 512 * 1024;
// Hard cap on a single readFile so one giant file cannot be pulled into a prompt.
const MAX_READ_BYTES = 256 * 1024;
// Cap the total number of entries returned so a huge tree cannot flood the UI.
const MAX_ENTRIES = 500;

// Directories that are noise for context and expensive to walk.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', 'build', 'out',
  'coverage', '.cache', '.turbo', '.venv', '__pycache__', 'vendor'
]);

// Obvious binary file extensions to skip in the listing (by extension only; the
// listing never opens these files).
const BINARY_EXT = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'tif', 'heic',
  // audio
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus',
  // video
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv',
  // archives
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  // documents / office
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // binaries / libraries
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'jar', 'wasm', 'node',
  // disk / package images
  'dmg', 'iso', 'img', 'pkg', 'deb', 'rpm',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // databases
  'db', 'sqlite', 'sqlite3',
  // design / misc
  'psd', 'ai', 'sketch', 'pyc', 'pyo'
]);

// In-memory state (single active watched root, mirrors remoteState in server.js)
let root = null;        // absolute path of the currently-watched folder, or null
let watcher = null;     // fs.FSWatcher, or null
let debounceTimer = null;
let lastChangeAt = 0;

function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isBinaryExt(name) {
  return BINARY_EXT.has(extOf(name));
}

// Jail a caller-supplied relative path to the watched root. Mirrors the
// safeResolvePath pattern in mcp/mcpServer.js: strip null bytes, normalize, then
// resolve against the root and reject anything that escapes it.
function jailResolve(relPath) {
  if (!root) throw new Error('No workspace is being watched.');
  const cleaned = normalize(String(relPath || '').replace(/\0/g, ''));
  const resolved = resolve(root, cleaned);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error('Path escapes the watched workspace root.');
  }
  return resolved;
}

// Point the watcher at a folder. Validates it exists and is a directory, stores
// the absolute path, and starts a debounced recursive watch. Returns the root.
export async function setRoot(dir) {
  const abs = resolve(String(dir || '').replace(/\0/g, ''));
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new Error(`Folder does not exist: ${abs}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Not a folder: ${abs}`);
  }
  stop();
  root = abs;
  startWatch();
  return root;
}

function startWatch() {
  if (!root) return;
  try {
    // Recursive watch is supported on macOS and Windows. On platforms where it
    // is not, this throws and we fall back to re-scanning on every listFiles()
    // call, so the feature still works, just without change notifications.
    watcher = watch(root, { recursive: true, persistent: false }, () => {
      lastChangeAt = Date.now();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { debounceTimer = null; }, 250);
    });
    watcher.on('error', () => { /* keep the root usable even if the watch drops */ });
  } catch {
    watcher = null;
  }
}

// Stop watching and clear all state.
export function stop() {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (watcher) {
    try { watcher.close(); } catch { /* ignore */ }
    watcher = null;
  }
  root = null;
}

export function getRoot() {
  return root;
}

export function getLastChangeAt() {
  return lastChangeAt;
}

// Recursively walk the watched root and return a flat list of text files,
// skipping dotfiles/dotdirs, known noise directories, obvious binaries, and
// oversize files. Capped at MAX_ENTRIES total. Each entry is
// { relPath, name, size, mtime }.
export async function listFiles() {
  if (!root) throw new Error('No workspace is being watched.');
  const out = [];

  async function walk(dir) {
    if (out.length >= MAX_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory - skip it rather than fail the whole walk
    }
    for (const ent of entries) {
      if (out.length >= MAX_ENTRIES) return;
      const name = ent.name;
      if (name.startsWith('.')) continue; // skip dotfiles and dotdirs
      const full = join(dir, name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await walk(full);
      } else if (ent.isFile()) {
        if (isBinaryExt(name)) continue;
        let info;
        try { info = await stat(full); } catch { continue; }
        if (info.size > MAX_LIST_BYTES) continue;
        out.push({
          relPath: relative(root, full),
          name,
          size: info.size,
          mtime: info.mtimeMs
        });
      }
    }
  }

  await walk(root);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

// Read a single file's FRESH contents from disk. Jailed to the watched root and
// capped at MAX_READ_BYTES. Returns { path, content, size }.
export async function readFile(relPath) {
  const resolved = jailResolve(relPath);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`File not found in workspace: ${relPath}`);
  }
  if (!info.isFile()) {
    throw new Error(`Not a file: ${relPath}`);
  }
  if (info.size > MAX_READ_BYTES) {
    throw new Error(`File too large (${info.size} bytes). Maximum is ${MAX_READ_BYTES} bytes.`);
  }
  const content = await fsReadFile(resolved, 'utf8');
  return { path: relative(root, resolved), content, size: info.size };
}
