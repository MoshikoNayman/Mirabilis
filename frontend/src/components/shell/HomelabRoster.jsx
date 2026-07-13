// frontend/src/components/shell/HomelabRoster.jsx
// Homelab Roster - the user's own machines (routers, NAS, servers, a Raspberry
// Pi) shown as ICQ-style buddy contacts with LIVE reachability dots. Mirrors the
// look of BuddyList.jsx: an Apple-vibrancy sheet with presence dots. Hosts are
// saved on the backend; a TCP probe polls every ~15s to light each dot green
// (reachable) or grey (offline). "Connect" reuses the existing SSH backend.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel, PresenceDot, IconButton, Button, Badge } from '../ui/primitives';
import { appStore } from '../../store/useAppStore';
import { getJSON, postJSON, apiFetch } from '../../lib/api';

const HOST_TYPES = [
  { value: 'router', label: 'Router' },
  { value: 'nas', label: 'NAS' },
  { value: 'server', label: 'Server' },
  { value: 'pi', label: 'Pi' },
  { value: 'other', label: 'Other' }
];

const AUTH_TYPES = [
  { value: 'agent', label: 'SSH agent' },
  { value: 'key', label: 'Key file' },
  { value: 'password', label: 'Password' }
];

const POLL_MS = 15000;

const EMPTY_FORM = {
  label: '',
  host: '',
  port: '22',
  type: 'server',
  user: '',
  authType: 'agent',
  keyPath: ''
};

function typeMeta(type) {
  return HOST_TYPES.find((t) => t.value === type) || HOST_TYPES[HOST_TYPES.length - 1];
}

const fieldClass =
  'au-hairline au-focus w-full rounded-[var(--r-sm)] bg-transparent px-2.5 py-1.5 text-[length:var(--text-xs)] text-[color:var(--text-main)] placeholder:text-[color:var(--text-muted)]';

function HostRow({ host, status, connecting, onConnect, onDelete }) {
  const [showPw, setShowPw] = useState(false);
  const [pw, setPw] = useState('');
  const meta = typeMeta(host.type);
  const reachable = status?.reachable === true;
  const presence = reachable ? 'online' : 'offline';

  function handleConnect() {
    if (host.authType === 'password') {
      if (!showPw) { setShowPw(true); return; }
      onConnect(host, pw);
      setPw('');
      setShowPw(false);
    } else {
      onConnect(host);
    }
  }

  return (
    <div className="rounded-[var(--r-md)] px-2.5 py-2 transition hover:bg-[color:var(--hairline)]">
      <div className="flex items-center gap-2.5">
        <PresenceDot presence={presence} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]">
              {host.label}
            </span>
            <Badge tone="neutral" className="opacity-70">{meta.label}</Badge>
          </span>
          <span className="truncate text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
            {host.user ? `${host.user}@` : ''}{host.host}:{host.port}
            {status ? (reachable ? ` · reachable${typeof status.ms === 'number' ? ` (${status.ms}ms)` : ''}` : ' · offline') : ' · checking…'}
          </span>
        </span>
        <Button size="sm" variant="soft" onClick={handleConnect} disabled={connecting}>
          {connecting ? 'Connecting…' : 'Connect'}
        </Button>
        <IconButton size="sm" label={`Remove ${host.label}`} onClick={() => onDelete(host)}>✕</IconButton>
      </div>
      {showPw ? (
        <div className="mt-2 flex items-center gap-1.5 pl-[26px]">
          <input
            type="password"
            className={fieldClass}
            placeholder={`Password for ${host.user || 'user'}@${host.host}`}
            value={pw}
            autoFocus
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleConnect(); }}
          />
          <Button size="sm" variant="primary" onClick={handleConnect} disabled={connecting}>Go</Button>
        </div>
      ) : null}
    </div>
  );
}

function AddHostForm({ onAdd, busy }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setError('');
    const ok = await onAdd(form);
    if (ok === true) {
      setForm(EMPTY_FORM);
    } else if (typeof ok === 'string') {
      setError(ok);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t px-4 py-3" style={{ borderColor: 'var(--hairline)' }}>
      <div className="text-[length:var(--text-2xs)] font-medium uppercase tracking-wide text-[color:var(--text-muted)]">
        Add a machine
      </div>
      <input className={fieldClass} placeholder="Label (e.g. Living-room Pi)" value={form.label} onChange={(e) => set('label', e.target.value)} />
      <div className="flex gap-2">
        <input className={fieldClass} placeholder="host or IP" value={form.host} onChange={(e) => set('host', e.target.value)} />
        <input className={`${fieldClass} w-20`} placeholder="port" inputMode="numeric" value={form.port} onChange={(e) => set('port', e.target.value)} />
      </div>
      <div className="flex gap-2">
        <select className={fieldClass} value={form.type} onChange={(e) => set('type', e.target.value)}>
          {HOST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <input className={fieldClass} placeholder="user" value={form.user} onChange={(e) => set('user', e.target.value)} />
      </div>
      <select className={fieldClass} value={form.authType} onChange={(e) => set('authType', e.target.value)}>
        {AUTH_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
      </select>
      {form.authType === 'key' ? (
        <input className={fieldClass} placeholder="key file path (e.g. ~/.ssh/id_ed25519)" value={form.keyPath} onChange={(e) => set('keyPath', e.target.value)} />
      ) : null}
      {error ? <div className="text-[length:var(--text-2xs)] text-rose-500">{error}</div> : null}
      <Button variant="primary" size="sm" onClick={submit} disabled={busy}>Save host</Button>
    </div>
  );
}

export default function HomelabRoster({ open }) {
  const [hosts, setHosts] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [connectingId, setConnectingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const pollRef = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      const payload = await getJSON('/api/homelab/hosts/status');
      const map = {};
      (payload.statuses || []).forEach((s) => { map[s.id] = s; });
      setStatuses(map);
    } catch {
      /* leave dots as-is on a transient failure */
    }
  }, []);

  const loadHosts = useCallback(async () => {
    try {
      const payload = await getJSON('/api/homelab/hosts');
      setHosts(payload.hosts || []);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message || 'Could not load hosts');
    }
  }, []);

  // Load hosts + start the reachability poll while the sheet is open.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      await loadHosts();
      if (!cancelled) await loadStatus();
    })();
    pollRef.current = setInterval(loadStatus, POLL_MS);
    const onKey = (e) => { if (e.key === 'Escape') appStore.closeHomelab(); };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, loadHosts, loadStatus]);

  async function addHost(form) {
    setBusy(true);
    try {
      const body = {
        label: form.label,
        host: form.host,
        port: Number(form.port) || 22,
        type: form.type,
        user: form.user,
        authType: form.authType,
        ...(form.authType === 'key' ? { keyPath: form.keyPath } : {})
      };
      await postJSON('/api/homelab/hosts', body);
      await loadHosts();
      await loadStatus();
      return true;
    } catch (err) {
      return err.message || 'Could not save host';
    } finally {
      setBusy(false);
    }
  }

  async function removeHost(host) {
    try {
      await apiFetch(`/api/homelab/hosts/${host.id}`, { method: 'DELETE' });
      await loadHosts();
    } catch (err) {
      appStore.toast(`Could not remove ${host.label}: ${err.message}`, { kind: 'error' });
    }
  }

  async function connectHost(host, password) {
    setConnectingId(host.id);
    try {
      const body = {
        type: 'ssh',
        host: host.host,
        port: host.port,
        user: host.user,
        authType: host.authType,
        ...(host.authType === 'password' ? { password: password || '' } : {}),
        ...(host.authType === 'key' && host.keyPath ? { privateKeyPath: host.keyPath } : {})
      };
      await postJSON('/api/remote/connect', body);
      appStore.closeHomelab();
      appStore.toast(`Connected to ${host.label}`, { kind: 'success' });
    } catch (err) {
      appStore.toast(`Connect failed: ${err.message}`, { kind: 'error' });
    } finally {
      setConnectingId('');
    }
  }

  if (!open) return null;

  const onlineCount = hosts.filter((h) => statuses[h.id]?.reachable).length;

  return (
    <div className="fixed inset-0 z-[90]">
      <div className="au-backdrop absolute inset-0" onClick={() => appStore.closeHomelab()} aria-hidden="true" />
      <Panel
        material="chrome"
        className="au-enter absolute right-3 top-16 flex max-h-[80vh] w-[360px] flex-col overflow-hidden"
        role="dialog"
        aria-label="Homelab Roster"
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--hairline)' }}>
          <div className="flex flex-col">
            <span className="text-[length:var(--text-md)] font-semibold text-[color:var(--text-main)]">Homelab</span>
            <span className="text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
              {hosts.length ? `${onlineCount} of ${hosts.length} reachable` : 'Your machines as buddies'}
            </span>
          </div>
          <IconButton label="Close" onClick={() => appStore.closeHomelab()}>✕</IconButton>
        </div>

        <div className="au-scroll flex-1 overflow-y-auto p-1.5">
          {loadError ? (
            <div className="px-3 py-4 text-[length:var(--text-xs)] text-rose-500">{loadError}</div>
          ) : hosts.length === 0 ? (
            <div className="px-3 py-6 text-center text-[length:var(--text-xs)] text-[color:var(--text-muted)]">
              No machines yet. Add your router, NAS, server, or Pi below.
            </div>
          ) : (
            <div className="flex flex-col">
              {hosts.map((h) => (
                <HostRow
                  key={h.id}
                  host={h}
                  status={statuses[h.id]}
                  connecting={connectingId === h.id}
                  onConnect={connectHost}
                  onDelete={removeHost}
                />
              ))}
            </div>
          )}
        </div>

        <AddHostForm onAdd={addHost} busy={busy} />

        <div className="flex items-center gap-2 border-t px-4 py-2 text-[length:var(--text-2xs)] text-[color:var(--text-muted)]" style={{ borderColor: 'var(--hairline)' }}>
          <span className="flex items-center gap-1"><PresenceDot presence="online" /> reachable</span>
          <span className="flex items-center gap-1"><PresenceDot presence="offline" /> offline</span>
        </div>
      </Panel>
    </div>
  );
}
