// Connectors: MCP servers whose tools the assistant can use, and the address other
// MCP clients use to reach Mirabilis. List, detail and add views share this pane.
'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Badge, Button, SegmentedControl, Spinner, Switch,
  AlertIcon, CheckIcon, ChevronRightIcon, CopyIcon, ExternalIcon, MoonIcon, PlayIcon,
  PlugIcon, PlusIcon, RefreshIcon, ShieldIcon, TerminalIcon, TrashIcon
} from '../ui/primitives';
import { appStore, useAppStore } from '../../store/useAppStore';
import { describeApiError, fetchAccess } from '../../lib/access';
import {
  listConnectors, getCatalog, createConnector, updateConnector, removeConnector,
  restartConnector, connectorLogs, callConnectorTool, connectorStatus, connectorSubtitle,
  connectorKind, commandLine, monogram, buildCustomConnector, presetFieldValues,
  presetInitialValues, presetFieldsError, presetCommandPreview, groupPresets, requirementInfo,
  isLocalUrl, mirabilisMcpUrl, maskToken, clientSnippet, MCP_CLIENTS, fetchMcpEndpoint,
  saveMcpEndpoint
} from '../../lib/connectors';
import { getSessionToken } from '../../lib/sessionToken';
import { SettingsGroup, SettingsList, SettingsRow, SettingsNotice } from './SettingsSheet';

const FEATURE = 'Connectors';
const POLL_MS = 3000;

// Same shape as SegmentedControl, but the active fill says what the choice means.
const PERMISSION_OPTIONS = [
  { value: 'allow', label: 'Allow', fill: 'var(--accent)' },
  { value: 'ask', label: 'Ask', fill: '#b45309' },
  { value: 'off', label: 'Off', fill: '#64748b' }
];

// Fields go read-only, not disabled, while a connector is being added, so focus stays in the form.
const inputClass =
  'au-hairline au-focus h-8 w-full min-w-0 rounded-[var(--r-sm)] bg-transparent px-3 text-[length:var(--text-xs)] text-[color:var(--text-main)] placeholder:text-[color:var(--text-muted)] placeholder:opacity-60 disabled:opacity-50 read-only:opacity-50';
const textareaClass =
  'au-hairline au-focus au-scroll block w-full min-w-0 resize-y rounded-[var(--r-sm)] bg-transparent px-3 py-2 font-mono text-[length:var(--text-xs)] leading-relaxed text-[color:var(--text-main)] placeholder:font-sans placeholder:text-[color:var(--text-muted)] placeholder:opacity-60 disabled:opacity-50 read-only:opacity-50';
const monoBlockClass =
  'au-hairline au-scroll overflow-auto rounded-[var(--r-sm)] px-3 py-2 font-mono text-[length:var(--text-2xs)] leading-relaxed text-[color:var(--text-main)]';
const monoBg = { background: 'color-mix(in srgb, var(--text-main) 4%, transparent)' };
const errorText = 'text-[length:var(--text-xs)] text-rose-600 dark:text-rose-300';
const mutedXs = 'text-[length:var(--text-xs)] text-[color:var(--text-muted)]';
const muted2xs = 'text-[length:var(--text-2xs)] text-[color:var(--text-muted)]';

// The Clipboard API can be refused (desktop shell permissions); a hidden
// textarea copy still works there.
async function copyText(text) {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  } finally {
    if (active && typeof active.focus === 'function' && active !== document.activeElement) active.focus();
  }
}

function CopyButton({ text, label = 'Copy', disabled }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function onCopy() {
    if (!text) return;
    if (await copyText(text)) {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } else {
      appStore.toast('Could not copy. Copy the text manually.', { kind: 'error' });
    }
  }

  return (
    <Button size="sm" variant="ghost" onClick={onCopy} disabled={disabled || !text} aria-label={copied ? 'Copied' : label}>
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function Avatar({ name, large = false }) {
  return (
    <span
      aria-hidden="true"
      className={`au-hairline flex shrink-0 items-center justify-center rounded-[var(--r-sm)] font-semibold tracking-wide text-[color:var(--text-main)] ${
        large ? 'h-10 w-10 text-[length:var(--text-sm)]' : 'h-8 w-8 text-[length:var(--text-2xs)]'
      }`}
      style={{ background: 'color-mix(in srgb, var(--text-main) 6%, transparent)' }}
    >
      {monogram(name)}
    </span>
  );
}

function StatusPill({ connector, id }) {
  const s = connectorStatus(connector);
  return (
    <span id={id} className="inline-flex shrink-0">
      <Badge tone={s.tone} className="whitespace-nowrap">
        {s.label === 'Starting' ? <Spinner size={10} /> : null}
        {s.label}
      </Badge>
    </span>
  );
}

function BackButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-pane-back=""
      className="au-focus -ml-1 inline-flex items-center gap-1 rounded-[var(--r-xs)] px-1 py-0.5 text-[length:var(--text-xs)] font-medium text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-main)]"
    >
      <ChevronRightIcon size={13} className="rotate-180" />
      All connectors
    </button>
  );
}

function Field({ id, label, optional, hint, children }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex items-baseline gap-1.5 text-[length:var(--text-xs)] font-medium text-[color:var(--text-main)]">
        {label}
        {optional ? <span className="font-normal text-[color:var(--text-muted)]">optional</span> : null}
      </label>
      {children}
      {hint ? <p className={`mt-1 leading-snug ${muted2xs}`}>{hint}</p> : null}
    </div>
  );
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// The line under the status pill: only what the pill does not already say.
function statusLine(c) {
  const state = c.enabled ? c.status.state : 'off';
  if (state === 'ready') {
    const server = [c.status.serverName, c.status.serverVersion].filter(Boolean).join(' ');
    const since = formatTime(c.status.startedAt);
    if (!server) return since ? `Running since ${since}` : '';
    return since ? `${server}, running since ${since}` : server;
  }
  if (state === 'starting') return 'First start can take a minute';
  return '';
}

/* List view */

function ConnectorRow({ connector, busy, onOpen, onToggle }) {
  const uid = useId();
  const sub = connectorSubtitle(connector);
  const status = connectorStatus(connector);
  return (
    <div className="relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[color:var(--hairline)]">
      <Avatar name={connector.name} />
      <div className="min-w-0 flex-1">
        {/* The ::after overlay makes the whole row open the details; the switch sits above it. */}
        <button
          type="button"
          onClick={() => onOpen(connector)}
          data-connector-open={connector.id}
          aria-describedby={`${uid}-sub ${uid}-status`}
          className="block max-w-full truncate text-left text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)] outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:shadow-[inset_0_0_0_2px_var(--ring)]"
        >
          {connector.name}
        </button>
        <div id={`${uid}-sub`} className={`mt-0.5 flex min-w-0 items-center gap-1.5 ${muted2xs}`}>
          {/* Narrow rows have no room for the pill, so the status leads the subtitle. The pill stays the described text. */}
          <span aria-hidden="true" className="shrink-0 font-medium text-[color:var(--text-main)] min-[480px]:hidden">{status.label}</span>
          <span className="min-w-0 truncate min-[480px]:shrink-0">{sub.kind}</span>
          <span className="hidden min-w-0 truncate font-mono min-[480px]:inline" title={sub.detail}>{sub.detail}</span>
        </div>
      </div>
      <span className="hidden shrink-0 min-[480px]:inline-flex">
        <StatusPill connector={connector} id={`${uid}-status`} />
      </span>
      <div className="relative z-10 flex items-center">
        <Switch
          checked={connector.enabled}
          onChange={(on) => onToggle(connector, on)}
          label={`Enable ${connector.name}`}
          aria-disabled={busy ? true : undefined}
        />
      </div>
      <ChevronRightIcon size={14} className="hidden shrink-0 text-[color:var(--text-muted)] min-[480px]:block" />
    </div>
  );
}

function ListView({ connectors, loadState, loadError, busy, onRetry, onOpen, onToggle, onAdd }) {
  return (
    <SettingsGroup
      title="Your connectors"
      action={
        <span data-pane-add="">
          <Button size="sm" variant="primary" onClick={() => onAdd('catalog')}>
            <PlusIcon size={13} />
            Add connector
          </Button>
        </span>
      }
    >
      {loadState === 'loading' && connectors.length === 0 ? (
        <div className={`flex items-center justify-center gap-2 rounded-[var(--r-md)] px-4 py-8 au-hairline ${mutedXs}`}>
          <Spinner size={14} /> Loading...
        </div>
      ) : loadState === 'error' && connectors.length === 0 ? (
        <SettingsNotice
          tone="danger"
          icon={<AlertIcon size={14} />}
          action={<Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}
        >
          Could not load connectors. {loadError}
        </SettingsNotice>
      ) : connectors.length === 0 ? (
        <div className="au-hairline flex flex-col items-center gap-3 rounded-[var(--r-md)] px-6 py-10 text-center">
          <span className="au-hairline flex h-10 w-10 items-center justify-center rounded-full text-[color:var(--text-muted)]">
            <PlugIcon size={18} />
          </span>
          <p className="text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]">No connectors</p>
          <Button size="sm" variant="soft" onClick={() => onAdd('catalog')}>Browse catalog</Button>
        </div>
      ) : (
        <SettingsList className="overflow-hidden">
          {connectors.map((c) => (
            <ConnectorRow key={c.id} connector={c} busy={busy[c.id]} onOpen={onOpen} onToggle={onToggle} />
          ))}
        </SettingsList>
      )}
    </SettingsGroup>
  );
}

/* Detail view */

function TryTool({ id, connector, tool }) {
  const [argsText, setArgsText] = useState('{}');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const ready = connector.enabled && connector.status.state === 'ready';
  const canRun = ready && tool.permission !== 'off';
  // Why the button is disabled is already on the pill and the Allow / Ask / Off control.
  const note = canRun && tool.permission === 'ask' ? 'Your click counts as approval' : '';

  async function run() {
    if (running || !canRun) return;
    let args;
    try {
      args = argsText.trim() ? JSON.parse(argsText) : {};
    } catch {
      setError('Arguments must be valid JSON.');
      return;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      setError('Arguments must be a JSON object.');
      return;
    }
    setRunning(true);
    setError('');
    setResult(null);
    try {
      setResult(await callConnectorTool(connector.id, tool.name, args));
    } catch (err) {
      setError(describeApiError(err, FEATURE));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div id={id} className="mt-3 pl-5">
      <Field id={`${id}-args`} label="Arguments (JSON)">
        <textarea
          id={`${id}-args`}
          rows={3}
          className={textareaClass}
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          disabled={!canRun || running}
          spellCheck={false}
        />
      </Field>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="soft" onClick={run} disabled={!canRun} aria-disabled={running || undefined}>
          {running ? <Spinner size={12} /> : <PlayIcon size={12} />}
          {running ? 'Running...' : 'Run tool'}
        </Button>
        {note ? <span className={muted2xs}>{note}</span> : null}
      </div>
      {error ? <p role="alert" className={`mt-2 ${errorText}`}>{error}</p> : null}
      {result ? (
        <div className="mt-3">
          <p className={`mb-1 text-[length:var(--text-2xs)] font-medium ${result.isError ? 'text-rose-600 dark:text-rose-300' : 'text-[color:var(--text-muted)]'}`}>
            {result.isError ? 'Tool error' : 'Result'}
          </p>
          <pre tabIndex={0} className={`${monoBlockClass} max-h-60 whitespace-pre-wrap break-words`} style={monoBg}>
            {result.text || 'No output'}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function PermissionControl({ value, onChange, label }) {
  return (
    <div role="group" aria-label={label} className="au-hairline au-material inline-flex items-center gap-0.5 rounded-[var(--r-pill)] p-0.5">
      {PERMISSION_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => { if (!active) onChange(opt.value); }}
            aria-pressed={active}
            className={`au-focus inline-flex h-7 items-center rounded-[var(--r-pill)] px-2.5 text-[length:var(--text-2xs)] font-medium transition ${
              active ? 'text-white shadow-[var(--shadow-1)]' : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-main)]'
            }`}
            style={active ? { background: opt.fill } : undefined}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ToolRow({ connector, tool, open, onToggleOpen, onPermission }) {
  const uid = useId();
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-controls={open ? `${uid}-try` : undefined}
          aria-label={`${tool.name} details`}
          className="au-focus -m-1 flex min-w-0 flex-1 items-start gap-2 rounded-[var(--r-xs)] p-1 text-left"
        >
          <ChevronRightIcon
            size={12}
            className={`mt-[3px] shrink-0 text-[color:var(--text-muted)] transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="break-all font-mono text-[length:var(--text-xs)] font-medium text-[color:var(--text-main)]">
                {tool.name}
              </span>
              {tool.title && tool.title !== tool.name ? <span className={muted2xs}>{tool.title}</span> : null}
              {tool.readOnly ? <Badge>Read-only</Badge> : null}
            </span>
            {/* Server-written and often long: two lines until opened, the rest on hover. */}
            {tool.description ? (
              <span
                className={`mt-0.5 block leading-snug ${muted2xs} ${open ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}
                title={open ? undefined : tool.description}
              >
                {tool.description}
              </span>
            ) : null}
          </span>
        </button>
        <div className="shrink-0">
          <PermissionControl
            label={`Permission for ${tool.name}`}
            value={tool.permission}
            onChange={(value) => onPermission(connector, tool.name, value)}
          />
        </div>
      </div>
      {open ? <TryTool id={`${uid}-try`} connector={connector} tool={tool} /> : null}
    </div>
  );
}

function ConnectorDetail({ connector: c, busy, onBack, onToggle, onRestart, onRemove, onPermission }) {
  const uid = useId();
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState([]);
  const [logsState, setLogsState] = useState('idle');
  const [logsError, setLogsError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [openTool, setOpenTool] = useState('');
  const logRef = useRef(null);
  const confirmRef = useRef(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const state = c.enabled ? c.status.state : 'off';
  const isHttp = c.transport === 'http';
  const target = isHttp ? c.url : commandLine(c.command, c.args);
  const secretKeys = [...c.envKeys, ...c.headerKeys];
  const statusText = state === 'error' ? '' : statusLine(c);

  async function loadLogs() {
    setLogsState('loading');
    setLogsError('');
    try {
      const lines = await connectorLogs(c.id);
      if (!alive.current) return;
      setLogs(lines);
      setLogsState('ready');
    } catch (err) {
      if (!alive.current) return;
      setLogsError(describeApiError(err, FEATURE));
      setLogsState('error');
    }
  }

  function toggleLogs() {
    const next = !logsOpen;
    setLogsOpen(next);
    if (next) loadLogs();
  }

  useEffect(() => {
    if (logsOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, logsOpen]);

  // Cancel takes focus so a stray Enter does not delete.
  useEffect(() => {
    if (confirming) confirmRef.current?.querySelector('button')?.focus();
  }, [confirming]);

  return (
    <div>
      <BackButton onClick={onBack} />

      <div className="mb-8">
        <div className="mt-4 flex items-start gap-3">
          <Avatar name={c.name} large />
          <div className="min-w-0 flex-1">
            <h4 className="truncate text-[length:var(--text-md)] font-semibold text-[color:var(--text-main)]">{c.name}</h4>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusPill connector={c} />
              <Badge>{connectorKind(c)}</Badge>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            {/* A local connector that is on starts whenever Mirabilis does. */}
            {isHttp ? null : (
              <label id={`${uid}-start`} htmlFor={`${uid}-switch`} className={`cursor-pointer whitespace-nowrap ${mutedXs}`}>
                Start with Mirabilis
              </label>
            )}
            <Switch
              id={`${uid}-switch`}
              checked={c.enabled}
              onChange={(on) => onToggle(c, on)}
              label={isHttp ? `Enable ${c.name}` : undefined}
              aria-labelledby={isHttp ? undefined : `${uid}-start`}
              aria-disabled={busy ? true : undefined}
            />
          </div>
        </div>

        {state === 'error' || statusText ? (
          <div className="mt-4">
            {state === 'error' ? (
              <SettingsNotice tone="danger" icon={<AlertIcon size={14} />}>
                <p className="font-medium">Could not connect.</p>
                {c.status.error ? (
                  <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[length:var(--text-2xs)]">{c.status.error}</p>
                ) : null}
                <p className="mt-1">
                  {isHttp ? 'Check the URL and token, then restart.' : 'Check the command and logs, then restart.'}
                </p>
              </SettingsNotice>
            ) : (
              <p className={mutedXs}>{statusText}</p>
            )}
          </div>
        ) : null}

        <SettingsList className="mt-4">
          <SettingsRow
            label={isHttp ? 'URL' : 'Command'}
            detail={<code className="block break-all font-mono text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">{target}</code>}
          >
            <CopyButton text={target} label={isHttp ? 'Copy URL' : 'Copy command'} />
          </SettingsRow>
          {c.cwd ? (
            <SettingsRow
              label="Working folder"
              detail={<code className="block break-all font-mono text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">{c.cwd}</code>}
            />
          ) : null}
          {c.hasSecrets || secretKeys.length ? (
            <SettingsRow
              label="Secrets"
              description="Values hidden"
              detail={secretKeys.length ? (
                <code className="block break-all font-mono text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
                  {secretKeys.join(', ')}
                </code>
              ) : null}
            />
          ) : null}
        </SettingsList>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="soft" onClick={() => onRestart(c)} disabled={!c.enabled} aria-disabled={busy ? true : undefined}>
            {busy === 'restart' ? <Spinner size={12} /> : <RefreshIcon size={13} />}
            {busy === 'restart' ? 'Restarting...' : 'Restart'}
          </Button>
          <Button size="sm" variant="soft" onClick={toggleLogs} aria-expanded={logsOpen} aria-controls={`${uid}-logs`}>
            <TerminalIcon size={13} />
            {logsOpen ? 'Hide logs' : 'View logs'}
          </Button>
          <Button size="sm" variant="danger" className="ml-auto" onClick={() => setConfirming(true)} disabled={!!busy || confirming}>
            <TrashIcon size={13} />
            Remove
          </Button>
        </div>

        {confirming ? (
          <div
            ref={confirmRef}
            role="group"
            aria-label={`Remove ${c.name}`}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setConfirming(false);
              }
            }}
            className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-rose-400/40 bg-rose-500/10 px-3 py-2"
          >
            <p className="min-w-0 flex-1 text-[length:var(--text-xs)] text-rose-700 dark:text-rose-200">
              Remove {c.name} and delete its settings?
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { if (busy !== 'remove') setConfirming(false); }}
              aria-disabled={busy === 'remove' || undefined}
            >
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={() => onRemove(c)} aria-disabled={busy === 'remove' || undefined}>
              {busy === 'remove' ? 'Removing...' : 'Remove'}
            </Button>
          </div>
        ) : null}

        {logsOpen ? (
          <div id={`${uid}-logs`} className="mt-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className={`font-medium ${muted2xs}`}>
                {logs.length ? `Last ${logs.length} line${logs.length === 1 ? '' : 's'}` : ''}
              </span>
              <Button size="sm" variant="ghost" onClick={loadLogs} disabled={logsState === 'loading'}>
                <RefreshIcon size={12} />
                Refresh
              </Button>
            </div>
            {logsState === 'error' ? (
              <p role="alert" className={errorText}>{logsError}</p>
            ) : (
              <pre
                ref={logRef}
                tabIndex={0}
                aria-label={`${c.name} logs`}
                className={`${monoBlockClass} max-h-60 whitespace-pre-wrap break-all`}
                style={monoBg}
              >
                {logsState === 'loading' && logs.length === 0 ? 'Loading...' : logs.length ? logs.join('\n') : 'No output'}
              </pre>
            )}
          </div>
        ) : null}
      </div>

      <SettingsGroup title={`Tools${c.tools.length ? ` (${c.tools.length})` : ''}`}>
        {c.tools.length ? (
          <SettingsList>
            {c.tools.map((t) => (
              <ToolRow
                key={t.name}
                connector={c}
                tool={t}
                open={openTool === t.name}
                onToggleOpen={() => setOpenTool((cur) => (cur === t.name ? '' : t.name))}
                onPermission={onPermission}
              />
            ))}
          </SettingsList>
        ) : (
          <p className={mutedXs}>
            {state === 'ready' ? 'No tools' : 'Not connected'}
          </p>
        )}
      </SettingsGroup>
    </div>
  );
}

/* Add view */

function PresetField({ id, field, value, onChange, disabled }) {
  const many = field.kind === 'paths';
  return (
    <Field
      id={id}
      label={field.label}
      optional={!field.required}
      hint={many ? 'One per line' : ''}
    >
      {many ? (
        <textarea
          id={id}
          rows={3}
          className={textareaClass}
          placeholder={field.placeholder || '~/Documents'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={disabled}
          spellCheck={false}
        />
      ) : (
        <input
          id={id}
          className={`${inputClass} ${field.kind === 'path' ? 'font-mono placeholder:font-sans' : ''}`}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      )}
    </Field>
  );
}

function PresetRow({ preset, added, expanded, onExpand, onCollapse, onCreate }) {
  const uid = useId();
  const [values, setValues] = useState(() => presetInitialValues(preset));
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const rowRef = useRef(null);
  const wasExpanded = useRef(expanded);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // Set up and Cancel disappear when pressed, so focus moves to the first field,
  // or back to Set up unless another row's form took it.
  useEffect(() => {
    if (wasExpanded.current === expanded) return;
    wasExpanded.current = expanded;
    const row = rowRef.current;
    if (!row) return;
    const active = document.activeElement;
    if (expanded) row.querySelector('input, textarea')?.focus();
    else if (!active || active === document.body || row.contains(active)) row.querySelector('[data-preset-action]')?.focus();
  }, [expanded]);

  const needsForm = preset.fields.length > 0;
  const need = requirementInfo(preset.requires);
  const actionText = creating ? 'Adding...' : needsForm ? 'Set up' : added ? 'Add another' : 'Add';

  async function add() {
    if (creating) return;
    const problem = presetFieldsError(preset, values);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    setCreating(true);
    const failure = await onCreate({ presetId: preset.id, fields: presetFieldValues(preset, values) });
    if (!alive.current) return;
    setCreating(false);
    if (failure) setError(failure);
  }

  return (
    <div ref={rowRef} className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Avatar name={preset.name} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]">{preset.name}</span>
            {added ? <Badge tone="success">Added</Badge> : null}
            {preset.network ? <Badge>Uses network</Badge> : null}
          </div>
          {preset.description ? <p className={`mt-0.5 leading-snug ${mutedXs}`}>{preset.description}</p> : null}
          <div className={`mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 ${muted2xs}`}>
            {preset.requires ? <span>Runs with <code className="font-mono">{preset.requires}</code></span> : null}
            {preset.docsUrl ? (
              <a
                href={preset.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="au-focus inline-flex items-center gap-0.5 rounded-[var(--r-xs)] transition-colors hover:text-[color:var(--text-main)]"
              >
                Docs
                <ExternalIcon size={10} />
              </a>
            ) : null}
          </div>
          {preset.note ? <p className={`mt-1 leading-snug ${muted2xs}`}>{preset.note}</p> : null}
          {!preset.available ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[length:var(--text-2xs)] font-medium leading-snug text-amber-700 dark:text-amber-300">
              <AlertIcon size={11} className="shrink-0" />
              <span>{preset.installHint || `Needs ${need.label}`}</span>
              {need.url ? (
                <a
                  href={need.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="au-focus inline-flex items-center gap-0.5 rounded-[var(--r-xs)] underline underline-offset-2"
                >
                  How to install
                  <ExternalIcon size={10} />
                </a>
              ) : null}
            </p>
          ) : null}
        </div>
        {!expanded ? (
          <Button
            size="sm"
            variant="soft"
            onClick={needsForm ? onExpand : add}
            aria-disabled={creating || undefined}
            aria-label={`${actionText} ${preset.name}`}
            data-preset-action=""
          >
            {creating ? <Spinner size={12} /> : null}
            {actionText}
          </Button>
        ) : null}
      </div>

      {expanded ? (
        // A form, so Enter in a field adds the connector, as in Custom.
        <form
          noValidate
          onSubmit={(e) => { e.preventDefault(); add(); }}
          className="mt-3 flex flex-col gap-3 pl-11"
        >
          {preset.fields.map((f) => (
            <PresetField
              key={f.key}
              id={`${uid}-${f.key}`}
              field={f}
              value={values[f.key] || ''}
              onChange={(v) => {
                setValues((cur) => ({ ...cur, [f.key]: v }));
                if (error) setError('');
              }}
              disabled={creating}
            />
          ))}
          <div className={muted2xs}>
            Runs <code className="break-all font-mono text-[color:var(--text-main)]">{presetCommandPreview(preset, values)}</code>
          </div>
          {error ? <p role="alert" className={errorText}>{error}</p> : null}
          {creating ? <p className={mutedXs}>First start can take a minute</p> : null}
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" variant="primary" aria-disabled={creating || undefined}>
              {creating ? <Spinner size={12} /> : null}
              {creating ? 'Adding...' : 'Add connector'}
            </Button>
            <Button size="sm" variant="ghost" onClick={onCollapse} disabled={creating}>Cancel</Button>
          </div>
        </form>
      ) : (
        <>
          {error ? <p role="alert" className={`mt-2 pl-11 ${errorText}`}>{error}</p> : null}
          {creating ? <p className={`mt-2 pl-11 ${mutedXs}`}>First start can take a minute</p> : null}
        </>
      )}
    </div>
  );
}

function CatalogView({ catalog, catalogState, catalogError, connectors, onRetry, onCreate }) {
  const [expanded, setExpanded] = useState('');

  if (catalogState === 'error') {
    return (
      <SettingsNotice
        tone="danger"
        icon={<AlertIcon size={14} />}
        action={<Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}
      >
        Could not load the catalog. {catalogError}
      </SettingsNotice>
    );
  }
  if (!catalog) {
    return (
      <div className={`flex items-center justify-center gap-2 py-8 ${mutedXs}`}>
        <Spinner size={14} /> Loading...
      </div>
    );
  }
  if (catalog.length === 0) {
    return <p className={mutedXs}>Catalog is empty</p>;
  }

  return (
    <div>
      {groupPresets(catalog).map((group) => (
        <SettingsGroup key={group.category} title={group.category}>
          <SettingsList>
            {group.presets.map((p) => (
              <PresetRow
                key={p.id}
                preset={p}
                added={connectors.some((c) => c.preset === p.id)}
                expanded={expanded === p.id}
                onExpand={() => setExpanded(p.id)}
                onCollapse={() => setExpanded('')}
                onCreate={onCreate}
              />
            ))}
          </SettingsList>
        </SettingsGroup>
      ))}
    </div>
  );
}

const EMPTY_CUSTOM = { transport: 'stdio', name: '', command: '', args: '', env: '', cwd: '', url: '', token: '' };

function CustomForm({ goDark, onCreate }) {
  const uid = useId();
  const [form, setForm] = useState(EMPTY_CUSTOM);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const isHttp = form.transport === 'http';
  const id = (k) => `${uid}-${k}`;

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    if (error) setError('');
  }

  async function submit(e) {
    e.preventDefault();
    if (creating) return;
    const { input, error: problem } = buildCustomConnector(form);
    if (!input) {
      setError(problem);
      return;
    }
    setCreating(true);
    const failure = await onCreate(input);
    if (!alive.current) return;
    setCreating(false);
    if (failure) setError(failure);
  }

  const remoteBlocked = isHttp && goDark && form.url.trim() !== '' && !isLocalUrl(form.url);

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div>
        <SegmentedControl
          size="sm"
          value={form.transport}
          onChange={(v) => set('transport', v)}
          options={[{ value: 'stdio', label: 'Command' }, { value: 'http', label: 'URL' }]}
        />
      </div>

      <Field id={id('name')} label="Name">
        <input
          id={id('name')}
          className={inputClass}
          placeholder={isHttp ? 'Team knowledge base' : 'My server'}
          value={form.name}
          maxLength={60}
          onChange={(e) => set('name', e.target.value)}
          readOnly={creating}
        />
      </Field>

      {isHttp ? (
        <>
          <Field id={id('url')} label="URL">
            <input
              id={id('url')}
              type="url"
              className={`${inputClass} font-mono placeholder:font-sans`}
              placeholder="https://example.com/mcp"
              value={form.url}
              onChange={(e) => set('url', e.target.value)}
              readOnly={creating}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          {remoteBlocked ? (
            <SettingsNotice tone="warn" icon={<MoonIcon size={13} />}>
              Go Dark blocks servers outside your network.
            </SettingsNotice>
          ) : null}
          <Field id={id('token')} label="Bearer token" optional hint="Hidden after saving">
            <input
              id={id('token')}
              type="password"
              className={`${inputClass} font-mono`}
              value={form.token}
              onChange={(e) => set('token', e.target.value)}
              readOnly={creating}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </>
      ) : (
        <>
          <Field id={id('command')} label="Command">
            <input
              id={id('command')}
              className={`${inputClass} font-mono placeholder:font-sans`}
              placeholder="npx"
              value={form.command}
              onChange={(e) => set('command', e.target.value)}
              readOnly={creating}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          <Field id={id('args')} label="Arguments" optional hint="One per line">
            <textarea
              id={id('args')}
              rows={3}
              className={textareaClass}
              placeholder={'-y\n@modelcontextprotocol/server-memory'}
              value={form.args}
              onChange={(e) => set('args', e.target.value)}
              readOnly={creating}
              spellCheck={false}
            />
          </Field>
          <Field id={id('env')} label="Environment" optional hint="One KEY=value per line, hidden after saving">
            <textarea
              id={id('env')}
              rows={2}
              className={textareaClass}
              placeholder="API_KEY=abc123"
              value={form.env}
              onChange={(e) => set('env', e.target.value)}
              readOnly={creating}
              spellCheck={false}
            />
          </Field>
          <Field id={id('cwd')} label="Working folder" optional>
            <input
              id={id('cwd')}
              className={`${inputClass} font-mono placeholder:font-sans`}
              placeholder="~/projects/app"
              value={form.cwd}
              onChange={(e) => set('cwd', e.target.value)}
              readOnly={creating}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
        </>
      )}

      {error ? <p role="alert" className={errorText}>{error}</p> : null}
      {creating ? <p className={mutedXs}>First start can take a minute</p> : null}
      <div>
        <Button type="submit" size="sm" variant="primary" aria-disabled={creating || undefined}>
          {creating ? <Spinner size={12} /> : <PlusIcon size={13} />}
          {creating ? 'Adding...' : 'Add connector'}
        </Button>
      </div>
    </form>
  );
}

function AddView({ tab, onTab, onBack, catalog, catalogState, catalogError, onRetryCatalog, connectors, goDark, onCreate }) {
  return (
    <div>
      <BackButton onClick={onBack} />
      <div className="mb-6 mt-4 flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-[length:var(--text-md)] font-semibold text-[color:var(--text-main)]">Add connector</h4>
        <SegmentedControl
          size="sm"
          value={tab}
          onChange={onTab}
          options={[{ value: 'catalog', label: 'Catalog' }, { value: 'custom', label: 'Custom' }]}
        />
      </div>
      {tab === 'custom' ? (
        <CustomForm goDark={goDark} onCreate={onCreate} />
      ) : (
        <CatalogView
          catalog={catalog}
          catalogState={catalogState}
          catalogError={catalogError}
          connectors={connectors}
          onRetry={onRetryCatalog}
          onCreate={onCreate}
        />
      )}
    </div>
  );
}

/* Mirabilis as a server for other apps */

function UseFromOtherApps() {
  const [token, setToken] = useState('');
  const [tokenState, setTokenState] = useState('loading');
  const [reveal, setReveal] = useState(false);
  const [client, setClient] = useState(MCP_CLIENTS[0].id);
  // known stays false on a backend without the switch: no switch, server on.
  const [server, setServer] = useState({ known: false, enabled: true });
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    let alive = true;
    getSessionToken().then((t) => {
      if (!alive) return;
      setToken(t || '');
      setTokenState(t ? 'ready' : 'missing');
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    mounted.current = true;
    fetchMcpEndpoint()
      .then((e) => { if (mounted.current) setServer({ known: true, enabled: e.enabled }); })
      .catch(() => { /* older backend: no switch, server stays on */ });
    return () => { mounted.current = false; };
  }, []);

  // Flips at once and flips back if the save fails, like the connector switches.
  async function toggleServer(on) {
    if (saving) return;
    setSaving(true);
    setServer({ known: true, enabled: on });
    try {
      const next = await saveMcpEndpoint({ enabled: on });
      if (mounted.current) setServer({ known: true, enabled: next.enabled });
    } catch (err) {
      if (!mounted.current) return;
      setServer({ known: true, enabled: !on });
      appStore.toast(`Could not turn MCP server ${on ? 'on' : 'off'}. ${describeApiError(err, 'MCP server')}`, { kind: 'error' });
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const url = mirabilisMcpUrl();
  const shownToken = token ? (reveal ? token : maskToken(token)) : '<token>';
  const hint = (MCP_CLIENTS.find((c) => c.id === client) || MCP_CLIENTS[0]).hint;
  const tokenText = tokenState === 'loading'
    ? 'Loading...'
    : token ? shownToken : 'Not available. Start the backend, then reopen Settings.';

  return (
    <SettingsGroup
      title="Use Mirabilis from other apps"
      action={server.known ? (
        <Switch
          checked={server.enabled}
          onChange={toggleServer}
          label="Mirabilis MCP server"
          aria-disabled={saving || undefined}
        />
      ) : null}
    >
      {/* Only the content below hides; the switch keeps focus. */}
      {server.enabled ? (
        <>
          <SettingsList>
            <SettingsRow
              label="Endpoint"
              detail={<code className="block break-all font-mono text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">{url}</code>}
            >
              <CopyButton text={url} label="Copy endpoint" />
            </SettingsRow>
            <SettingsRow
              label="Token"
              detail={<code className="block break-all font-mono text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">{tokenText}</code>}
            >
              <Button size="sm" variant="ghost" onClick={() => setReveal((v) => !v)} disabled={!token}>
                {reveal ? 'Hide' : 'Show'}
              </Button>
              <CopyButton text={token} label="Copy token" />
            </SettingsRow>
          </SettingsList>
          <p className={`mt-2 flex items-start gap-1.5 leading-snug ${muted2xs}`}>
            <ShieldIcon size={12} className="mt-px shrink-0" />
            Keep this token private.
          </p>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl
              size="sm"
              value={client}
              onChange={setClient}
              options={MCP_CLIENTS.map((c) => ({ value: c.id, label: c.label }))}
            />
            <CopyButton text={clientSnippet(client, url, token || '<token>')} label="Copy setup" />
          </div>
          <pre tabIndex={0} className={`${monoBlockClass} mt-2 whitespace-pre-wrap break-words`} style={monoBg} aria-label="Setup snippet">
            {clientSnippet(client, url, shownToken)}
          </pre>
          <p className={`mt-1 ${muted2xs}`}>{hint}</p>
        </>
      ) : (
        <p className={mutedXs}>Off</p>
      )}
    </SettingsGroup>
  );
}

/* Pane */

export default function ConnectorsPane() {
  const goDark = useAppStore((s) => s.goDark);

  // Read here rather than from the store, which holds a default until loaded.
  const [access, setAccess] = useState('');
  const [view, setView] = useState({ name: 'list' });
  const [connectors, setConnectors] = useState([]);
  const [loadState, setLoadState] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState({});
  const [catalog, setCatalog] = useState(null);
  const [catalogState, setCatalogState] = useState('idle');
  const [catalogError, setCatalogError] = useState('');

  const rootRef = useRef(null);
  const mounted = useRef(false);
  // Writes per connector run one at a time; while any are pending, polls and
  // stale responses must not overwrite the optimistic state.
  const writes = useRef(new Map());
  const lastOpened = useRef('');
  const firstView = useRef(true);

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoadState((s) => (s === 'ready' ? s : 'loading'));
    try {
      const list = await listConnectors();
      if (!mounted.current || writes.current.size > 0) return;
      setConnectors(list);
      setLoadState('ready');
      setLoadError('');
    } catch (err) {
      if (!mounted.current || quiet) return;
      setLoadError(describeApiError(err, FEATURE));
      setLoadState('error');
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    setCatalogState('loading');
    setCatalogError('');
    try {
      const presets = await getCatalog();
      if (!mounted.current) return;
      setCatalog(presets);
      setCatalogState('ready');
    } catch (err) {
      if (!mounted.current) return;
      setCatalogError(describeApiError(err, FEATURE));
      setCatalogState('error');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    fetchAccess()
      .then((a) => {
        if (!mounted.current) return;
        setAccess(a.level);
        appStore.setAccess(a.level);
      })
      .catch(() => { /* the notice just stays hidden */ });
    return () => { mounted.current = false; };
  }, [refresh]);

  const anyStarting = connectors.some((c) => c.enabled && c.status.state === 'starting');
  useEffect(() => {
    if (!anyStarting) return undefined;
    const timer = setInterval(() => { refresh({ quiet: true }); }, POLL_MS);
    return () => clearInterval(timer);
  }, [anyStarting, refresh]);

  useEffect(() => {
    if (view.name === 'add' && catalogState === 'idle') loadCatalog();
  }, [view.name, catalogState, loadCatalog]);

  const current = view.name === 'detail' ? connectors.find((c) => c.id === view.id) || null : null;
  useEffect(() => {
    if (view.name === 'detail' && !current && loadState !== 'loading') setView({ name: 'list' });
  }, [view.name, current, loadState]);

  // Keyboard focus follows the view: Back in detail and add, the row it came from in the list.
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    let el = null;
    if (view.name === 'list') {
      const id = lastOpened.current;
      el = id
        ? [...root.querySelectorAll('[data-connector-open]')].find((n) => n.getAttribute('data-connector-open') === id)
        : null;
      el = el || root.querySelector('[data-pane-add] button');
    } else {
      el = root.querySelector('[data-pane-back]');
    }
    el?.focus();
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [view.name, view.id]);

  const upsert = useCallback((c) => {
    if (!c?.id) return;
    setConnectors((list) => {
      const i = list.findIndex((x) => x.id === c.id);
      if (i === -1) return [...list, c];
      const next = list.slice();
      next[i] = c;
      return next;
    });
  }, []);

  function queueWrite(id, task) {
    const entry = writes.current.get(id) || { chain: Promise.resolve(), count: 0 };
    entry.count += 1;
    const run = entry.chain.catch(() => {}).then(task);
    entry.chain = run;
    writes.current.set(id, entry);
    return run.finally(() => {
      entry.count -= 1;
      if (entry.count === 0 && writes.current.get(id) === entry) writes.current.delete(id);
    });
  }

  const settled = (id) => !writes.current.has(id);

  function setBusyFor(id, value) {
    setBusy((b) => {
      const next = { ...b };
      if (value) next[id] = value;
      else delete next[id];
      return next;
    });
  }

  // Busy controls stay focusable (aria-disabled), so each action ignores a press while one is pending.
  async function toggle(c, on) {
    if (busy[c.id]) return;
    upsert({ ...c, enabled: on, status: { ...c.status, state: on ? 'starting' : 'off', error: '' } });
    setBusyFor(c.id, 'toggle');
    try {
      const next = await queueWrite(c.id, () => updateConnector(c.id, { enabled: on }));
      if (mounted.current && settled(c.id)) upsert(next);
    } catch (err) {
      if (!mounted.current) return;
      if (settled(c.id)) upsert(c);
      appStore.toast(`Could not turn ${c.name} ${on ? 'on' : 'off'}. ${describeApiError(err, FEATURE)}`, { kind: 'error' });
    } finally {
      if (mounted.current) setBusyFor(c.id, '');
    }
  }

  async function setPermission(c, toolName, permission) {
    const before = c.tools.find((t) => t.name === toolName);
    if (!before || before.permission === permission) return;
    const withPermission = (list, value) => list.map((t) => (t.name === toolName ? { ...t, permission: value } : t));
    setConnectors((list) => list.map((x) => (x.id === c.id ? { ...x, tools: withPermission(x.tools, permission) } : x)));
    try {
      const next = await queueWrite(c.id, () => updateConnector(c.id, { tools: { [toolName]: permission } }));
      if (mounted.current && settled(c.id)) upsert(next);
    } catch (err) {
      if (!mounted.current) return;
      if (settled(c.id)) {
        setConnectors((list) => list.map((x) => (x.id === c.id ? { ...x, tools: withPermission(x.tools, before.permission) } : x)));
      }
      const choice = PERMISSION_OPTIONS.find((o) => o.value === permission)?.label || permission;
      appStore.toast(`Could not set ${toolName} to ${choice}. ${describeApiError(err, FEATURE)}`, { kind: 'error' });
    }
  }

  async function restart(c) {
    if (busy[c.id] || !c.enabled) return;
    setBusyFor(c.id, 'restart');
    upsert({ ...c, status: { ...c.status, state: 'starting', error: '' } });
    try {
      const next = await queueWrite(c.id, () => restartConnector(c.id));
      if (mounted.current && settled(c.id)) upsert(next);
    } catch (err) {
      if (!mounted.current) return;
      appStore.toast(`Could not restart ${c.name}. ${describeApiError(err, FEATURE)}`, { kind: 'error' });
      refresh({ quiet: true });
    } finally {
      if (mounted.current) setBusyFor(c.id, '');
    }
  }

  async function remove(c) {
    if (busy[c.id] === 'remove') return;
    setBusyFor(c.id, 'remove');
    try {
      await queueWrite(c.id, () => removeConnector(c.id));
      if (!mounted.current) return;
      lastOpened.current = '';
      setConnectors((list) => list.filter((x) => x.id !== c.id));
      setView({ name: 'list' });
      appStore.toast(`Removed ${c.name}`, { kind: 'success' });
    } catch (err) {
      if (mounted.current) appStore.toast(`Could not remove ${c.name}. ${describeApiError(err, FEATURE)}`, { kind: 'error' });
    } finally {
      if (mounted.current) setBusyFor(c.id, '');
    }
  }

  // Resolves to '' on success or a sentence for the form to show.
  async function create(input) {
    try {
      const c = await createConnector(input);
      if (!mounted.current) return '';
      if (!c.id) {
        refresh({ quiet: true });
        setView({ name: 'list' });
        return '';
      }
      upsert(c);
      lastOpened.current = c.id;
      setView({ name: 'detail', id: c.id });
      const failed = c.status.state === 'error';
      appStore.toast(failed ? `Added ${c.name}, failed to start` : `Added ${c.name}`, { kind: failed ? 'warn' : 'success' });
      return '';
    } catch (err) {
      return describeApiError(err, FEATURE);
    }
  }

  function openDetail(c) {
    lastOpened.current = c.id;
    setView({ name: 'detail', id: c.id });
  }

  let body;
  if (view.name === 'detail' && current) {
    body = (
      <ConnectorDetail
        connector={current}
        busy={busy[current.id]}
        onBack={() => setView({ name: 'list' })}
        onToggle={toggle}
        onRestart={restart}
        onRemove={remove}
        onPermission={setPermission}
      />
    );
  } else if (view.name === 'add') {
    body = (
      <AddView
        tab={view.tab || 'catalog'}
        onTab={(tab) => setView({ name: 'add', tab })}
        onBack={() => setView({ name: 'list' })}
        catalog={catalog}
        catalogState={catalogState}
        catalogError={catalogError}
        onRetryCatalog={loadCatalog}
        connectors={connectors}
        goDark={goDark}
        onCreate={create}
      />
    );
  } else {
    body = (
      <>
        {access === 'chat' ? (
          <SettingsNotice
            tone="info"
            icon={<ShieldIcon size={13} />}
            className="mb-6"
            action={<Button size="sm" variant="outline" onClick={() => appStore.openSettings('access')}>Change Access</Button>}
          >
            Connector tools are off in Chat only.
          </SettingsNotice>
        ) : null}
        {goDark ? (
          <SettingsNotice tone="info" icon={<MoonIcon size={13} />} className="mb-6">
            Go Dark does not filter local connectors.
          </SettingsNotice>
        ) : null}
        <ListView
          connectors={connectors}
          loadState={loadState}
          loadError={loadError}
          busy={busy}
          onRetry={() => refresh()}
          onOpen={openDetail}
          onToggle={toggle}
          onAdd={(tab) => setView({ name: 'add', tab })}
        />
        <UseFromOtherApps />
      </>
    );
  }

  return <div ref={rootRef}>{body}</div>;
}
