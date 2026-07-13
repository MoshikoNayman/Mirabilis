// frontend/src/components/shell/WatchedWorkspace.jsx
// Watched Workspace - point Mirabilis at a local folder and pin specific files as
// LIVE chat context. Pinned file contents are pulled FRESH from disk at send time
// (see ChatApp.sendMessageWithContent), never a stale upload. Mirrors the Aurora
// sheet look of HomelabRoster.jsx: a chrome-vibrancy Panel anchored top-right.
// The watched root and the pinned set live in the app store and persist to
// localStorage so both survive a reload. All file reads are jailed to the root
// on the backend (workspace.js), so a pinned path can never escape the folder.
'use client';

import { useEffect, useRef, useState } from 'react';
import { Panel, IconButton, Button, Badge, FolderIcon, Spinner } from '../ui/primitives';
import { appStore, useAppStore } from '../../store/useAppStore';
import { getJSON, postJSON, apiFetch } from '../../lib/api';

const fieldClass =
  'au-hairline au-focus w-full rounded-[var(--r-sm)] bg-transparent px-2.5 py-1.5 text-[length:var(--text-xs)] text-[color:var(--text-main)] placeholder:text-[color:var(--text-muted)]';

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Small check-square used as the pin toggle - matches the monochrome line-icon
// style (stroke = currentColor) instead of a full-colour emoji checkbox.
function PinBox({ pinned }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--r-xs)] ${pinned ? 'text-white' : 'au-hairline text-transparent'}`}
      style={pinned ? { background: 'var(--accent)' } : undefined}
      aria-hidden="true"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.5 10 17.5 19 6.5" />
      </svg>
    </span>
  );
}

function FileRow({ file, pinned, onToggle }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(file.relPath)}
      className="au-focus flex w-full items-center gap-2.5 rounded-[var(--r-md)] px-2.5 py-1.5 text-left transition hover:bg-[color:var(--hairline)]"
      role="menuitemcheckbox"
      aria-checked={pinned}
    >
      <PinBox pinned={pinned} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[length:var(--text-xs)] font-medium text-[color:var(--text-main)]">
          {file.name}
        </span>
        {file.relPath !== file.name ? (
          <span className="truncate text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
            {file.relPath}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-[length:var(--text-2xs)] tabular-nums text-[color:var(--text-muted)]">
        {formatSize(file.size)}
      </span>
    </button>
  );
}

export default function WatchedWorkspace({ open }) {
  const storedRoot = useAppStore((s) => s.workspaceRoot);
  const pins = useAppStore((s) => s.workspacePins);
  const [pathInput, setPathInput] = useState('');
  const [root, setRoot] = useState('');
  const [files, setFiles] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const didInit = useRef(false);

  // On open: prefill the path and reconnect to a previously-watched root so pins
  // keep working across reloads (and backend restarts).
  useEffect(() => {
    if (!open) { didInit.current = false; return undefined; }
    if (!didInit.current) {
      didInit.current = true;
      setPathInput(storedRoot || '');
      if (storedRoot) reconnect(storedRoot);
    }
    const onKey = (e) => { if (e.key === 'Escape') appStore.closeWorkspace(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function reconnect(dir) {
    setLoading(true);
    setError('');
    try {
      let payload;
      try {
        payload = await getJSON('/api/workspace/files');
        if (payload.root !== dir) throw new Error('stale');
      } catch {
        // Backend forgot the root (e.g. it restarted) - re-establish the watch.
        payload = await postJSON('/api/workspace/watch', { path: dir });
      }
      setRoot(payload.root);
      setFiles(payload.files || []);
      appStore.setWorkspaceRoot(payload.root);
    } catch (err) {
      setError(err.message || 'Could not load workspace');
    } finally {
      setLoading(false);
    }
  }

  async function watchPath() {
    const dir = pathInput.trim();
    if (!dir || busy) return;
    setBusy(true);
    setError('');
    try {
      const payload = await postJSON('/api/workspace/watch', { path: dir });
      setRoot(payload.root);
      setFiles(payload.files || []);
      appStore.setWorkspaceRoot(payload.root);
      // Drop any pins that do not exist under the new root.
      const valid = new Set((payload.files || []).map((f) => f.relPath));
      const keep = pins.filter((p) => valid.has(p));
      if (keep.length !== pins.length) appStore.setWorkspacePins(keep);
    } catch (err) {
      setError(err.message || 'Could not watch folder');
    } finally {
      setBusy(false);
    }
  }

  function togglePin(relPath) {
    const set = new Set(pins);
    if (set.has(relPath)) set.delete(relPath);
    else set.add(relPath);
    appStore.setWorkspacePins([...set]);
  }

  async function stopWatching() {
    try { await apiFetch('/api/workspace/watch', { method: 'DELETE' }); } catch { /* ignore */ }
    setRoot('');
    setFiles([]);
    setPathInput('');
    setError('');
    appStore.setWorkspaceRoot('');
    appStore.setWorkspacePins([]);
  }

  if (!open) return null;

  const q = filter.trim().toLowerCase();
  const shown = q ? files.filter((f) => f.relPath.toLowerCase().includes(q)) : files;
  const pinnedCount = pins.length;

  return (
    <div className="fixed inset-0 z-[90]">
      <div className="au-backdrop absolute inset-0" onClick={() => appStore.closeWorkspace()} aria-hidden="true" />
      <Panel
        material="chrome"
        className="au-enter absolute right-3 top-16 flex max-h-[80vh] w-[380px] flex-col overflow-hidden"
        role="dialog"
        aria-label="Watched Workspace"
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--hairline)' }}>
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1.5 text-[length:var(--text-md)] font-semibold text-[color:var(--text-main)]">
              <FolderIcon size={15} className="text-[color:var(--text-muted)]" />
              Workspace
            </span>
            <span className="truncate text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
              {root
                ? `${pinnedCount ? `${pinnedCount} pinned as live context` : 'Pin files as live context'}`
                : 'Watch a local folder for live context'}
            </span>
          </div>
          <IconButton label="Close" onClick={() => appStore.closeWorkspace()}>✕</IconButton>
        </div>

        {/* Path input + Watch */}
        <div className="flex flex-col gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--hairline)' }}>
          <div className="flex items-center gap-1.5">
            <input
              className={fieldClass}
              placeholder="/absolute/path/to/folder"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') watchPath(); }}
              spellCheck={false}
            />
            <Button size="sm" variant="primary" onClick={watchPath} disabled={busy || !pathInput.trim()}>
              {busy ? 'Watching...' : 'Watch'}
            </Button>
          </div>
          {root ? (
            <div className="flex items-center gap-2">
              <span className="truncate text-[length:var(--text-2xs)] text-[color:var(--text-muted)]" title={root}>
                Watching {root}
              </span>
              <Badge tone="neutral" className="ml-auto shrink-0">{files.length} files</Badge>
            </div>
          ) : null}
          {error ? <div className="text-[length:var(--text-2xs)] text-rose-500">{error}</div> : null}
        </div>

        {/* Filter */}
        {root && files.length > 0 ? (
          <div className="border-b px-4 py-2" style={{ borderColor: 'var(--hairline)' }}>
            <input
              className={fieldClass}
              placeholder="Filter files..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
            />
          </div>
        ) : null}

        {/* File list */}
        <div className="au-scroll flex-1 overflow-y-auto p-1.5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-[length:var(--text-xs)] text-[color:var(--text-muted)]">
              <Spinner /> Scanning folder...
            </div>
          ) : !root ? (
            <div className="px-3 py-8 text-center text-[length:var(--text-xs)] text-[color:var(--text-muted)]">
              Point Mirabilis at a folder above. Pinned files are read fresh from
              disk each time you send - something a cloud chat app cannot do.
            </div>
          ) : shown.length === 0 ? (
            <div className="px-3 py-8 text-center text-[length:var(--text-xs)] text-[color:var(--text-muted)]">
              {files.length === 0 ? 'No text files found in this folder.' : 'No files match that filter.'}
            </div>
          ) : (
            <div className="flex flex-col">
              {shown.map((f) => (
                <FileRow key={f.relPath} file={f} pinned={pins.includes(f.relPath)} onToggle={togglePin} />
              ))}
            </div>
          )}
        </div>

        {/* Footer controls */}
        {root ? (
          <div className="flex items-center gap-2 border-t px-4 py-2.5" style={{ borderColor: 'var(--hairline)' }}>
            <span className="text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
              {pinnedCount ? `${pinnedCount} file${pinnedCount === 1 ? '' : 's'} active` : 'No files pinned'}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => appStore.setWorkspacePins([])} disabled={!pinnedCount}>
                Clear
              </Button>
              <Button size="sm" variant="danger" onClick={stopWatching}>
                Stop watching
              </Button>
            </div>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
