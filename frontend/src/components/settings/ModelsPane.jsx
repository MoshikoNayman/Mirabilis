// Models: the Ollama models on this computer, with updates and delete, and a
// search of the Ollama library to install from. Install jobs live in ChatApp so
// they survive this pane closing; the pane shows and starts them.
'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, IconButton, SegmentedControl, Spinner, Switch,
  AlertIcon, ChevronRightIcon, CloseIcon, CubeIcon, ExternalIcon, MoonIcon, RefreshIcon, SearchIcon, TrashIcon
} from '../ui/primitives';
import { describeApiError } from '../../lib/access';
import {
  fetchInstalled, fetchUpdates, fetchLibrary, fetchLibraryTags, lookupRegistry,
  formatBytes, formatContext, formatCount, formatAgo, jobProgressText, modelFit, fitDetail, fitBucket, itemSize,
  FIT_LABELS, CAPABILITY_FILTERS, CAPABILITY_LABELS, normalizeModelName, baseModelName, pullName, rowIdForName,
  exactModelName, sortInstalled, sortTags, primaryTagCount, recommendedGroups, installedNameSet, updateStatus
} from '../../lib/models';
import { SettingsGroup, SettingsList, SettingsRow, SettingsNotice, SettingsCopyButton } from './SettingsSheet';

const FEATURE = 'Models';
const SEARCH_DEBOUNCE_MS = 350;
const CLOCK_MS = 30000;

const VIEW_OPTIONS = [{ value: 'installed', label: 'Installed' }, { value: 'discover', label: 'Discover' }];
const ORDER_OPTIONS = [{ value: 'popular', label: 'Popular' }, { value: 'newest', label: 'Newest' }];
const FIT_TONES = { fits: 'success', tight: 'warn', swap: 'danger' };

const inputClass =
  'au-hairline au-focus h-8 w-full min-w-0 rounded-[var(--r-sm)] bg-transparent px-3 text-[length:var(--text-xs)] text-[color:var(--text-main)] placeholder:text-[color:var(--text-muted)] placeholder:opacity-60';
const errorText = 'text-[length:var(--text-xs)] text-rose-600 dark:text-rose-300';
const mutedXs = 'text-[length:var(--text-xs)] text-[color:var(--text-muted)]';
const muted2xs = 'text-[length:var(--text-2xs)] text-[color:var(--text-muted)]';
const linkButton =
  'au-focus inline-flex h-7 items-center gap-1.5 rounded-[var(--r-sm)] px-2.5 text-[length:var(--text-2xs)] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--hairline)] hover:text-[color:var(--text-main)]';

// A label worth a second line: "Dolphin 3.0 8B" over dolphin3:latest, not MCQ-Raw-8B over mcq-raw-8b.
const differs = (label, name) => String(label || '').toLowerCase() !== String(name || '').toLowerCase();

function Loading() {
  return (
    <div className={`au-hairline flex items-center justify-center gap-2 rounded-[var(--r-md)] px-4 py-8 ${mutedXs}`}>
      <Spinner size={14} /> Loading...
    </div>
  );
}

function FitChip({ size, ramGb }) {
  const fit = modelFit(size, ramGb);
  if (!fit) return null;
  return (
    <span className="inline-flex shrink-0" title={fitDetail(size, ramGb)}>
      <Badge tone={FIT_TONES[fit]} className="whitespace-nowrap">{FIT_LABELS[fit]}</Badge>
    </span>
  );
}

/** Bar and "2.1 of 6.6 GB, 12 MB/s, 3 min left" for a running install or update. */
function JobProgress({ job, name }) {
  const pct = typeof job.pct === 'number' && Number.isFinite(job.pct) ? Math.max(0, Math.min(100, job.pct)) : null;
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <div
        role="progressbar"
        aria-label={`${name} download`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        className={`h-1 w-28 shrink-0 overflow-hidden rounded-full bg-[color:var(--hairline)] ${pct == null ? 'animate-pulse' : ''}`}
      >
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${pct ?? 0}%`, background: 'var(--accent)' }} />
      </div>
      <span className={`min-w-0 tabular-nums ${muted2xs}`}>{jobProgressText(job)}</span>
    </div>
  );
}

function CancelJob({ name, rowId, onCancel }) {
  return (
    <IconButton size="sm" label={`Cancel ${name}`} onClick={() => onCancel(rowId)}>
      <CloseIcon size={13} />
    </IconButton>
  );
}

function RowError({ error, onDismiss }) {
  return (
    <div className="mt-1.5 flex items-start gap-1.5">
      <p role="alert" className={`flex min-w-0 flex-1 items-start gap-1.5 leading-snug ${errorText}`}>
        <AlertIcon size={12} className="mt-px shrink-0" />
        <span>{error}</span>
      </p>
      {onDismiss ? (
        <IconButton size="sm" label="Dismiss" onClick={onDismiss} className="-my-1.5">
          <CloseIcon size={11} />
        </IconButton>
      ) : null}
    </div>
  );
}

/** Install, Retry after a failure, the running job's cancel, or Installed. */
function InstallAction({ name, rowId, installed, job, failed, goDark, disabled, onInstall, onCancel }) {
  if (installed && !job) return <Badge tone="success">Installed</Badge>;
  if (job) return <CancelJob name={name} rowId={rowId} onCancel={onCancel} />;
  if (goDark) return null;
  return (
    <Button size="sm" variant="soft" onClick={() => onInstall(name)} disabled={disabled} aria-label={`${failed ? 'Retry' : 'Install'} ${name}`}>
      {failed ? 'Retry' : 'Install'}
    </Button>
  );
}

/* Installed */

function RuntimeList({ runtime, disk }) {
  const version = runtime.version ? `Ollama ${runtime.version}` : 'Ollama';
  const outdated = runtime.updateAvailable;
  return (
    <SettingsList className="mb-8">
      <SettingsRow
        label={
          <span className="inline-flex flex-wrap items-center gap-2">
            {version}
            {outdated ? (
              <span className="inline-flex" title={runtime.latest ? `Latest ${runtime.latest}` : undefined}>
                <Badge tone="warn">Update available</Badge>
              </span>
            ) : null}
          </span>
        }
        detail={outdated && runtime.updateCommand ? (
          <code className="block break-all font-mono text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">{runtime.updateCommand}</code>
        ) : null}
      >
        {!outdated ? null : runtime.updateCommand ? (
          <SettingsCopyButton text={runtime.updateCommand} label="Copy command" />
        ) : (
          <a href={runtime.downloadUrl} target="_blank" rel="noopener noreferrer" className={linkButton}>
            Download
            <ExternalIcon size={11} />
          </a>
        )}
      </SettingsRow>
      {disk.freeBytes != null ? (
        <SettingsRow
          label="Free space"
          detail={disk.path ? (
            <code className="block truncate font-mono text-[length:var(--text-2xs)] text-[color:var(--text-muted)]" title={disk.path}>{disk.path}</code>
          ) : null}
        >
          <span className={`tabular-nums ${mutedXs}`}>
            {formatBytes(disk.freeBytes)}{disk.totalBytes ? ` of ${formatBytes(disk.totalBytes)}` : ''}
          </span>
        </SettingsRow>
      ) : null}
    </SettingsList>
  );
}

function InstalledRow({ model, label, rowId, status, job, error, goDark, onInstall, onCancel, onDelete, onDismissError }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const confirmRef = useRef(null);
  const trashRef = useRef(null);
  const wasConfirming = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // Cancel takes focus so a stray Enter does not delete; closing gives it back to the trash button.
  useEffect(() => {
    if (confirming) confirmRef.current?.querySelector('button')?.focus();
    else if (wasConfirming.current) trashRef.current?.querySelector('button')?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  function cancel() {
    if (deleting) return;
    setConfirming(false);
    setDeleteError('');
  }

  async function confirmDelete() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError('');
    const failure = await onDelete(model.name);
    if (!alive.current) return;
    setDeleting(false);
    if (failure) setDeleteError(failure);
  }

  if (confirming) {
    return (
      <div
        ref={confirmRef}
        role="group"
        aria-label={`Delete ${model.name}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        className="flex flex-wrap items-center gap-2 bg-rose-500/10 px-4 py-3"
      >
        <div className="min-w-0 flex-1">
          <p className="text-[length:var(--text-xs)] text-rose-700 dark:text-rose-200">
            Delete <span className="break-all font-mono">{model.name}</span>?
          </p>
          {deleteError ? <p role="alert" className={`mt-0.5 leading-snug ${errorText}`}>{deleteError}</p> : null}
        </div>
        <Button size="sm" variant="ghost" onClick={cancel} aria-disabled={deleting || undefined}>Cancel</Button>
        <Button size="sm" variant="danger" onClick={confirmDelete} aria-disabled={deleting || undefined}>
          {deleting ? 'Deleting...' : 'Delete'}
        </Button>
      </div>
    );
  }

  const size = formatBytes(model.sizeBytes);
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 break-words text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]">{label}</span>
            {model.loaded ? <Badge tone="success">Loaded</Badge> : null}
            {model.uncensored ? <Badge tone="warn">Uncensored</Badge> : null}
          </div>
          <div className={`mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 ${muted2xs}`}>
            {differs(label, model.name) ? <span className="break-all font-mono">{model.name}</span> : null}
            {size ? <span className="tabular-nums">{size}</span> : null}
            {model.paramSize ? <span>{model.paramSize}</span> : null}
            {model.quant ? <span>{model.quant}</span> : null}
          </div>
          {job ? <JobProgress job={job} name={model.name} /> : null}
          {error && !job ? <RowError error={error} onDismiss={() => onDismissError(rowId)} /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {job ? (
            <CancelJob name={model.name} rowId={rowId} onCancel={onCancel} />
          ) : (
            <>
              {status === 'update' && !goDark ? (
                <Button size="sm" variant="soft" onClick={() => onInstall(model.name)} aria-label={`${error ? 'Retry' : 'Update'} ${model.name}`}>
                  {error ? 'Retry' : 'Update'}
                </Button>
              ) : null}
              <span ref={trashRef} className="inline-flex">
                <IconButton size="sm" label={`Delete ${model.name}`} onClick={() => setConfirming(true)} data-model-delete="">
                  <TrashIcon size={14} />
                </IconButton>
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A model being installed, or whose install failed, that is not on disk yet. */
function PendingRow({ name, label, rowId, job, error, goDark, onInstall, onCancel, onDismissError }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <span className="block break-words text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]">{label}</span>
          {differs(label, name) ? <span className={`mt-0.5 block break-all font-mono ${muted2xs}`}>{name}</span> : null}
          {job ? <JobProgress job={job} name={name} /> : null}
          {error && !job ? <RowError error={error} onDismiss={() => onDismissError(rowId)} /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <InstallAction name={name} rowId={rowId} installed={false} job={job} failed={Boolean(error)} goDark={goDark} onInstall={onInstall} onCancel={onCancel} />
        </div>
      </div>
    </div>
  );
}

export function InstalledView({
  state, error, data, updates, checking, checkError, now, catalog, jobs, installErrors, goDark,
  onRetry, onCheck, onInstall, onCancel, onDelete, onDismissError, onDiscover
}) {
  const rootRef = useRef(null);
  const [focusIndex, setFocusIndex] = useState(null);

  const models = useMemo(() => sortInstalled(data?.models || []), [data]);
  const installedKeys = useMemo(() => new Set(models.map((m) => normalizeModelName(m.name))), [models]);
  const keyOf = useCallback((name) => rowIdForName(name, catalog), [catalog]);
  const labelOf = (m) => m.catalog?.label || m.name;

  // Jobs and failures for names not on disk yet get their own rows above the list.
  const pending = useMemo(() => {
    const out = new Map();
    for (const [rowId, entry] of [...Object.entries(jobs || {}), ...Object.entries(installErrors || {})]) {
      const name = entry?.name || rowId;
      if (installedKeys.has(normalizeModelName(name)) || out.has(rowId)) continue;
      const row = (catalog || []).find((r) => r.id === rowId);
      out.set(rowId, { rowId, name, label: row?.label || name });
    }
    return [...out.values()];
  }, [jobs, installErrors, installedKeys, catalog]);

  // The deleted row takes its focus with it: the next row's delete button gets it,
  // else Check for updates, else Discover in the empty state.
  useEffect(() => {
    if (focusIndex == null) return;
    const root = rootRef.current;
    const buttons = root ? [...root.querySelectorAll('[data-model-delete]')] : [];
    const target = buttons[Math.min(focusIndex, buttons.length - 1)]
      || root?.querySelector('[data-models-check]') || root?.querySelector('[data-models-discover] button');
    target?.focus();
    setFocusIndex(null);
  }, [focusIndex, models]);

  if (state === 'loading' && !data) return <Loading />;
  if (!data) {
    return (
      <SettingsNotice
        tone="danger"
        icon={<AlertIcon size={14} />}
        action={<Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
      >
        Could not load models. {error}
      </SettingsNotice>
    );
  }
  if (!data.runtime.reachable) {
    return (
      <SettingsNotice
        tone="warn"
        icon={<AlertIcon size={14} />}
        action={<Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
      >
        Ollama is not running.
      </SettingsNotice>
    );
  }

  const blocked = goDark || updates?.goDark === true;
  const statusOf = (m) => updateStatus(m, updates);
  const updatable = models.filter((m) => statusOf(m) === 'update' && !jobs?.[keyOf(m.name)]);
  const checked = updates?.checkedAt ? formatAgo(updates.checkedAt, now) : '';
  // A check that could verify nothing says why, rather than looking like all is current.
  const verdicts = Object.values(updates?.results || {});
  const unverified = !blocked && verdicts.some((r) => r.status === 'unknown')
    && verdicts.every((r) => r.status === 'unknown' || r.status === 'local');
  const checkNote = checkError || (unverified ? verdicts.find((r) => r.status === 'unknown' && r.reason)?.reason || '' : '');

  async function remove(model) {
    const index = models.findIndex((m) => m.name === model.name);
    const failure = await onDelete(model.name);
    if (!failure) setFocusIndex(Math.max(0, index));
    return failure;
  }

  return (
    <div ref={rootRef}>
      <RuntimeList runtime={data.runtime} disk={data.disk} />
      <SettingsGroup>
        {/* Its own row rather than the group's action slot, so it wraps in a narrow window. */}
        {models.length ? (
          <div className="mb-3 flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
            {checkNote ? (
              <span role="alert" className={errorText}>{checkNote}</span>
            ) : checked ? (
              <span className={muted2xs}>Checked {checked}</span>
            ) : null}
            {updatable.length >= 2 && !blocked ? (
              <Button size="sm" variant="soft" onClick={() => updatable.forEach((m) => onInstall(m.name))}>Update all</Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { if (!checking) onCheck(); }}
              disabled={blocked}
              aria-disabled={checking || undefined}
              data-models-check=""
            >
              {checking ? <Spinner size={12} /> : <RefreshIcon size={13} />}
              {checking ? 'Checking...' : 'Check for updates'}
            </Button>
          </div>
        ) : null}
        {models.length === 0 && pending.length === 0 ? (
          <div className="au-hairline flex flex-col items-center gap-3 rounded-[var(--r-md)] px-6 py-10 text-center">
            <span className="au-hairline flex h-10 w-10 items-center justify-center rounded-full text-[color:var(--text-muted)]">
              <CubeIcon size={18} />
            </span>
            <p className="text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]">No models</p>
            <span data-models-discover="">
              <Button size="sm" variant="soft" onClick={onDiscover}>Discover</Button>
            </span>
          </div>
        ) : (
          <SettingsList>
            {pending.map((p) => (
              <PendingRow
                key={`pending-${p.rowId}`}
                name={p.name}
                label={p.label}
                rowId={p.rowId}
                job={jobs?.[p.rowId]}
                error={installErrors?.[p.rowId]?.error || ''}
                goDark={blocked}
                onInstall={onInstall}
                onCancel={onCancel}
                onDismissError={onDismissError}
              />
            ))}
            {models.map((m) => {
              const rowId = keyOf(m.name);
              return (
                <InstalledRow
                  key={m.name}
                  model={m}
                  label={labelOf(m)}
                  rowId={rowId}
                  status={statusOf(m)}
                  job={jobs?.[rowId]}
                  error={installErrors?.[rowId]?.error || ''}
                  goDark={blocked}
                  onInstall={onInstall}
                  onCancel={onCancel}
                  onDelete={() => remove(m)}
                  onDismissError={onDismissError}
                />
              );
            })}
          </SettingsList>
        )}
      </SettingsGroup>
    </div>
  );
}

/* Discover */

function FilterChip({ on, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`au-focus inline-flex h-7 items-center rounded-[var(--r-pill)] px-2.5 text-[length:var(--text-2xs)] font-medium transition-colors ${
        on ? 'text-[color:var(--text-main)]' : 'au-hairline text-[color:var(--text-muted)] hover:text-[color:var(--text-main)]'
      }`}
      style={on ? { background: 'color-mix(in srgb, var(--accent) 16%, transparent)', boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent)' } : undefined}
    >
      {children}
    </button>
  );
}

function TagRow({ tag, rowId, installed, job, error, ramGb, appleSilicon, goDark, onInstall, onCancel }) {
  const size = tag.sizeBytes != null ? formatBytes(tag.sizeBytes) : tag.size;
  const context = formatContext(tag.context);
  // Aligned columns where there is room; below 600px the values flow and the action keeps right.
  return (
    <div className="py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex min-w-[7rem] flex-1 flex-wrap items-center gap-1.5">
          <span className="break-all font-mono text-[length:var(--text-xs)] text-[color:var(--text-main)]">{tag.tag}</span>
          {tag.latest && tag.tag !== 'latest' ? <Badge>latest</Badge> : null}
          {tag.mlx && appleSilicon ? <Badge>MLX</Badge> : null}
        </span>
        <span className={`tabular-nums min-[600px]:w-14 min-[600px]:text-right ${muted2xs}`}>{size}</span>
        <span className={`tabular-nums min-[600px]:w-20 min-[600px]:text-right ${muted2xs}`}>{context ? `${context} context` : ''}</span>
        <span className="flex min-[600px]:w-[4.5rem] min-[600px]:justify-end">
          <FitChip size={tag.sizeBytes ?? tag.size} ramGb={ramGb} />
        </span>
        <span className="ml-auto flex justify-end min-[600px]:ml-0 min-[600px]:w-20">
          <InstallAction
            name={tag.name}
            rowId={rowId}
            installed={installed}
            job={job}
            failed={Boolean(error)}
            goDark={goDark}
            onInstall={onInstall}
            onCancel={onCancel}
          />
        </span>
      </div>
      {job ? <JobProgress job={job} name={tag.name} /> : null}
      {error && !job ? <RowError error={error} /> : null}
    </div>
  );
}

export function TagList({ entry, catalog, installedSet, jobs, installErrors, ramGb, appleSilicon, goDark, onInstall, onCancel, onRetry }) {
  const [all, setAll] = useState(false);
  if (!entry || entry.state === 'loading') {
    return (
      <p className={`flex items-center gap-2 py-2 ${muted2xs}`}>
        <Spinner size={12} /> Loading...
      </p>
    );
  }
  if (entry.state === 'error') {
    return (
      <SettingsNotice
        tone="danger"
        icon={<AlertIcon size={13} />}
        action={<Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
      >
        {entry.error}
      </SettingsNotice>
    );
  }
  const sorted = sortTags(entry.tags, { appleSilicon });
  if (sorted.length === 0) return <p className={`py-2 ${muted2xs}`}>No tags</p>;
  const shown = all ? sorted : sorted.slice(0, primaryTagCount(sorted, { appleSilicon }));
  return (
    <div>
      <div className="divide-y divide-[color:var(--hairline)]">
        {shown.map((t) => {
          const rowId = rowIdForName(t.name, catalog);
          return (
            <TagRow
              key={t.name}
              tag={t}
              rowId={rowId}
              installed={installedSet.has(normalizeModelName(t.name))}
              job={jobs?.[rowId]}
              error={installErrors?.[rowId]?.error || ''}
              ramGb={ramGb}
              appleSilicon={appleSilicon}
              goDark={goDark}
              onInstall={onInstall}
              onCancel={onCancel}
            />
          );
        })}
      </div>
      {sorted.length > shown.length ? (
        <Button size="sm" variant="ghost" className="-ml-2.5 mt-1" onClick={() => setAll(true)}>
          All {sorted.length} tags
        </Button>
      ) : null}
    </div>
  );
}

function LibraryRow({ model, open, installed, onToggle, children }) {
  const uid = useId();
  return (
    <div className="px-4 py-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={open ? `${uid}-tags` : undefined}
        data-library-row={model.name}
        className="au-focus -m-1 flex w-[calc(100%+0.5rem)] min-w-0 items-start gap-2 rounded-[var(--r-xs)] p-1 text-left"
      >
        <ChevronRightIcon
          size={12}
          className={`mt-[3px] shrink-0 text-[color:var(--text-muted)] transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="break-all font-mono text-[length:var(--text-xs)] font-medium text-[color:var(--text-main)]">{model.name}</span>
            {model.capabilities.map((c) => <Badge key={c}>{CAPABILITY_LABELS[c] || c}</Badge>)}
            {installed ? <Badge tone="success">Installed</Badge> : null}
          </span>
          {model.description ? (
            <span className={`mt-0.5 block truncate leading-snug ${muted2xs}`} title={model.description}>{model.description}</span>
          ) : null}
        </span>
        {model.pulls != null ? (
          <span className={`shrink-0 pt-px tabular-nums ${muted2xs}`}>{formatCount(model.pulls)} pulls</span>
        ) : null}
      </button>
      {open ? <div id={`${uid}-tags`} className="mt-2 pl-5">{children}</div> : null}
    </div>
  );
}

function RecommendedRow({ row, installed, job, error, ramGb, goDark, onInstall, onCancel }) {
  const name = pullName(row);
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-[10rem] flex-1">
          <span className="block text-[length:var(--text-sm)] font-medium text-[color:var(--text-main)]">{row.label || name}</span>
          {row.label && differs(row.label, name) ? <span className={`block break-all font-mono ${muted2xs}`}>{name}</span> : null}
        </div>
        {row.size ? <span className={`tabular-nums ${muted2xs}`}>{row.size}</span> : null}
        <FitChip size={itemSize(row)} ramGb={ramGb} />
        <InstallAction
          name={name}
          rowId={row.id}
          installed={installed}
          job={job}
          failed={Boolean(error)}
          goDark={goDark}
          onInstall={onInstall}
          onCancel={onCancel}
        />
      </div>
      {job ? <JobProgress job={job} name={name} /> : null}
      {error && !job ? <RowError error={error} /> : null}
    </div>
  );
}

function ExactNameRow({ name, lookup, installed, job, error, ramGb, goDark, rowId, onInstall, onCancel }) {
  const size = lookup?.sizeBytes ?? null;
  const missing = lookup?.status === 'missing' || lookup?.status === 'invalid';
  const note = lookup?.status === 'checking' ? 'Checking...'
    : lookup?.status === 'missing' ? 'Not found'
      : lookup?.status === 'invalid' ? 'Invalid name'
        : '';
  return (
    <SettingsList className="mb-6">
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="min-w-[10rem] flex-1">
            <span className="block break-all font-mono text-[length:var(--text-xs)] font-medium text-[color:var(--text-main)]">{name}</span>
            {note ? (
              <span className={`block ${missing ? 'text-[length:var(--text-2xs)] text-rose-600 dark:text-rose-300' : muted2xs}`}>{note}</span>
            ) : null}
          </div>
          {size ? <span className={`tabular-nums ${muted2xs}`}>{formatBytes(size)}</span> : null}
          <FitChip size={size} ramGb={ramGb} />
          <InstallAction
            name={name}
            rowId={rowId}
            installed={installed}
            job={job}
            failed={Boolean(error)}
            goDark={goDark}
            disabled={missing}
            onInstall={onInstall}
            onCancel={onCancel}
          />
        </div>
        {job ? <JobProgress job={job} name={name} /> : null}
        {error && !job ? <RowError error={error} /> : null}
      </div>
    </SettingsList>
  );
}

/**
 * Discover without its requests: the pane container below loads what this shows.
 * Everything arrives as props so each state renders on its own.
 */
export function DiscoverView({
  query, onQuery, onSearchNow, caps, onToggleCap, fits, onFits, order, onOrder,
  ramGb, appleSilicon, goDark, catalog, installedSet, jobs, installErrors,
  library, expanded, onExpand, tagsByName, onRetryTags, onRetryLibrary, onMore,
  exactName, lookup, onInstall, onCancel
}) {
  const uid = useId();
  const bucket = fitBucket(ramGb);
  const browsing = !query.trim() && caps.length === 0;
  const recommended = browsing ? recommendedGroups(catalog, ramGb) : [];
  const installedBases = useMemo(() => new Set([...installedSet].map(baseModelName)), [installedSet]);
  const isInstalled = (name) => installedSet.has(normalizeModelName(name));
  const exactKey = exactName ? rowIdForName(exactName, catalog) : '';
  const busy = library.state === 'loading';

  return (
    <div>
      {goDark ? null : (
        <div className="mb-6 flex flex-col gap-3">
          <div className="relative">
            <SearchIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)]" />
            <input
              type="search"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onSearchNow();
                } else if (e.key === 'Escape' && query) {
                  e.preventDefault();
                  onQuery('');
                }
              }}
              placeholder="Search models"
              aria-label="Search models"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className={`${inputClass} pl-8`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div role="group" aria-label="Capabilities" className="flex flex-wrap items-center gap-1.5">
              {CAPABILITY_FILTERS.map((f) => (
                <FilterChip key={f.value} on={caps.includes(f.value)} onClick={() => onToggleCap(f.value)}>{f.label}</FilterChip>
              ))}
            </div>
            {bucket ? (
              <div className="flex items-center gap-2">
                <Switch id={`${uid}-fits`} size="sm" checked={fits} onChange={onFits} aria-labelledby={`${uid}-fits-label`} />
                <label id={`${uid}-fits-label`} htmlFor={`${uid}-fits`} className={`cursor-pointer whitespace-nowrap ${mutedXs}`}>
                  Fits this computer
                </label>
              </div>
            ) : null}
            <div className="ml-auto">
              <SegmentedControl size="sm" value={order} onChange={onOrder} options={ORDER_OPTIONS} />
            </div>
          </div>
        </div>
      )}

      {exactName && !goDark ? (
        <ExactNameRow
          name={exactName}
          lookup={lookup}
          installed={isInstalled(exactName)}
          rowId={exactKey}
          job={jobs?.[exactKey]}
          error={installErrors?.[exactKey]?.error || ''}
          ramGb={ramGb}
          goDark={goDark}
          onInstall={onInstall}
          onCancel={onCancel}
        />
      ) : null}

      {recommended.length ? (
        <SettingsGroup title="Recommended">
          {recommended.map((g) => (
            <div key={g.group} className="mb-4 last:mb-0">
              <p className={`mb-1.5 font-semibold uppercase tracking-wide ${muted2xs}`}>{g.group}</p>
              <SettingsList>
                {g.rows.map((row) => (
                  <RecommendedRow
                    key={row.id}
                    row={row}
                    installed={isInstalled(pullName(row))}
                    job={jobs?.[row.id]}
                    error={installErrors?.[row.id]?.error || ''}
                    ramGb={ramGb}
                    goDark={goDark}
                    onInstall={onInstall}
                    onCancel={onCancel}
                  />
                ))}
              </SettingsList>
            </div>
          ))}
        </SettingsGroup>
      ) : null}

      {goDark ? null : (
        <SettingsGroup title="Library" action={busy && library.results.length ? <Spinner size={12} /> : null}>
          {busy && library.results.length === 0 ? (
            <Loading />
          ) : library.state === 'error' && library.results.length === 0 ? (
            <SettingsNotice
              tone="danger"
              icon={<AlertIcon size={14} />}
              action={<Button size="sm" variant="outline" onClick={onRetryLibrary}>Retry</Button>}
            >
              {library.error}
            </SettingsNotice>
          ) : library.results.length === 0 ? (
            <p className={mutedXs}>No matches</p>
          ) : (
            <>
              <SettingsList className={busy ? 'opacity-60 transition-opacity' : undefined}>
                {library.results.map((m) => (
                  <LibraryRow
                    key={m.name}
                    model={m}
                    open={expanded === m.name}
                    installed={installedBases.has(baseModelName(m.name))}
                    onToggle={() => onExpand(expanded === m.name ? '' : m.name)}
                  >
                    <TagList
                      entry={tagsByName[m.name]}
                      catalog={catalog}
                      installedSet={installedSet}
                      jobs={jobs}
                      installErrors={installErrors}
                      ramGb={ramGb}
                      appleSilicon={appleSilicon}
                      goDark={goDark}
                      onInstall={onInstall}
                      onCancel={onCancel}
                      onRetry={() => onRetryTags(m.name)}
                    />
                  </LibraryRow>
                ))}
              </SettingsList>
              {library.state === 'error' ? (
                <SettingsNotice
                  tone="danger"
                  icon={<AlertIcon size={14} />}
                  className="mt-3"
                  action={<Button size="sm" variant="outline" onClick={onRetryLibrary}>Retry</Button>}
                >
                  {library.error}
                </SettingsNotice>
              ) : null}
              {library.hasMore && !busy && library.state !== 'error' ? (
                <div className="mt-3 flex justify-center">
                  <Button size="sm" variant="soft" onClick={() => { if (library.state !== 'more') onMore(); }} aria-disabled={library.state === 'more' || undefined}>
                    {library.state === 'more' ? <Spinner size={12} /> : null}
                    More
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </SettingsGroup>
      )}
    </div>
  );
}

// failedPage is the page a Retry asks for again.
const EMPTY_LIBRARY = { state: 'loading', results: [], page: 0, hasMore: false, error: '', failedPage: 1 };

/** Discover's requests: the library search, tag lists and the exact-name lookup. */
function DiscoverTab({ ramGb, goDark, ...rest }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [caps, setCaps] = useState([]);
  const [fits, setFits] = useState(true);
  const [order, setOrder] = useState('popular');
  const [library, setLibrary] = useState(EMPTY_LIBRARY);
  const [expanded, setExpanded] = useState('');
  const [tagsByName, setTagsByName] = useState({});
  const [lookup, setLookup] = useState(null);
  const libraryReq = useRef(null);
  const tagReqs = useRef(new Map());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const tags = tagReqs.current;
    return () => {
      mounted.current = false;
      libraryReq.current?.abort();
      for (const ctrl of tags.values()) ctrl.abort();
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const params = useMemo(
    () => ({ query: debounced, caps, fits: fits && Boolean(fitBucket(ramGb)), ramGb, order }),
    [debounced, caps, fits, ramGb, order]
  );

  const load = useCallback(async (page) => {
    libraryReq.current?.abort();
    if (goDark) {
      setLibrary({ ...EMPTY_LIBRARY, state: 'ready' });
      return;
    }
    const ctrl = new AbortController();
    libraryReq.current = ctrl;
    setLibrary((s) => ({ ...s, state: page > 1 ? 'more' : 'loading', error: '' }));
    try {
      const res = await fetchLibrary({ ...params, page }, { signal: ctrl.signal });
      if (ctrl.signal.aborted || !mounted.current) return;
      setLibrary((s) => {
        const seen = new Set(page > 1 ? s.results.map((m) => m.name) : []);
        const added = res.results.filter((m) => !seen.has(m.name));
        return {
          state: 'ready',
          results: page > 1 ? [...s.results, ...added] : res.results,
          page: res.page || page,
          hasMore: res.hasMore && (page === 1 || added.length > 0),
          error: '',
          failedPage: 1
        };
      });
    } catch (err) {
      if (ctrl.signal.aborted || !mounted.current) return;
      // A failed new search drops the old query's results; a failed More keeps them.
      setLibrary((s) => ({
        ...s,
        state: 'error',
        results: page > 1 ? s.results : [],
        hasMore: page > 1 ? s.hasMore : false,
        error: describeApiError(err, FEATURE),
        failedPage: page
      }));
    }
  }, [params, goDark]);

  useEffect(() => { load(1); }, [load]);

  const exactName = exactModelName(debounced);
  useEffect(() => {
    if (!exactName || goDark) {
      setLookup(null);
      return undefined;
    }
    const ctrl = new AbortController();
    setLookup({ status: 'checking', sizeBytes: null, size: '' });
    lookupRegistry(exactName, { signal: ctrl.signal })
      .then((r) => { if (!ctrl.signal.aborted) setLookup(r); })
      .catch(() => { if (!ctrl.signal.aborted) setLookup({ status: 'unknown', sizeBytes: null, size: '' }); });
    return () => ctrl.abort();
  }, [exactName, goDark]);

  const loadTags = useCallback(async (name) => {
    tagReqs.current.get(name)?.abort();
    const ctrl = new AbortController();
    tagReqs.current.set(name, ctrl);
    setTagsByName((m) => ({ ...m, [name]: { state: 'loading', tags: [], error: '' } }));
    try {
      const res = await fetchLibraryTags(name, { signal: ctrl.signal });
      if (ctrl.signal.aborted || !mounted.current) return;
      setTagsByName((m) => ({ ...m, [name]: { state: 'ready', tags: res.tags, error: '' } }));
    } catch (err) {
      if (ctrl.signal.aborted || !mounted.current) return;
      setTagsByName((m) => ({ ...m, [name]: { state: 'error', tags: [], error: describeApiError(err, FEATURE) } }));
    } finally {
      if (tagReqs.current.get(name) === ctrl) tagReqs.current.delete(name);
    }
  }, []);

  function expand(name) {
    setExpanded(name);
    if (name && (!tagsByName[name] || tagsByName[name].state === 'error')) loadTags(name);
  }

  return (
    <DiscoverView
      {...rest}
      ramGb={ramGb}
      goDark={goDark}
      query={query}
      onQuery={setQuery}
      onSearchNow={() => setDebounced(query.trim())}
      caps={caps}
      onToggleCap={(c) => setCaps((list) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]))}
      fits={fits}
      onFits={setFits}
      order={order}
      onOrder={setOrder}
      library={library}
      expanded={expanded}
      onExpand={expand}
      tagsByName={tagsByName}
      onRetryTags={loadTags}
      onRetryLibrary={() => load(library.failedPage || 1)}
      onMore={() => load(library.page + 1)}
      exactName={exactName}
      lookup={lookup}
    />
  );
}

/* Pane */

/**
 * @param {object} props
 * @param {'installed'|'discover'} props.view
 * @param {(view: string) => void} props.onViewChange
 * @param {object[]} props.catalog          GET /api/models?provider=ollama
 * @param {number|null} props.ramGb
 * @param {boolean} props.appleSilicon
 * @param {Record<string, object>} props.jobs           row id -> running install
 * @param {Record<string, {name: string, error: string}>} props.installErrors
 * @param {number} props.revision         bumps when the installed set changed
 * @param {boolean} props.goDark
 * @param {(name: string) => void} props.onInstall
 * @param {(rowId: string) => void} props.onCancel
 * @param {(name: string) => Promise<string>} props.onDelete  '' or the error
 * @param {(rowId: string) => void} props.onDismissError
 * @param {() => void} props.onRefresh   reloads the picker's Ollama list
 */
export default function ModelsPane({
  view = 'installed', onViewChange, catalog = [], ramGb = null, appleSilicon = false, jobs = {}, installErrors = {},
  revision = 0, goDark = false, onInstall, onCancel, onDelete, onDismissError, onRefresh
}) {
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [updates, setUpdates] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  // Each view mounts on first visit and then stays, so a search survives switching.
  const [seen, setSeen] = useState(() => ({ installed: view === 'installed', discover: view === 'discover' }));
  const mounted = useRef(false);
  const loadSeq = useRef(0);
  const updatesAsked = useRef(false);
  const firstRevision = useRef(revision);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    setSeen((s) => (s[view] ? s : { ...s, [view]: true }));
  }, [view]);

  const loadInstalled = useCallback(async ({ quiet = false } = {}) => {
    const seq = ++loadSeq.current;
    if (!quiet) setState((s) => (s === 'ready' ? s : 'loading'));
    try {
      const next = await fetchInstalled();
      if (!mounted.current || seq !== loadSeq.current) return;
      setData(next);
      setState('ready');
      setError('');
    } catch (err) {
      if (!mounted.current || seq !== loadSeq.current) return;
      setError(describeApiError(err, FEATURE));
      setState('error');
    }
  }, []);

  const loadUpdates = useCallback(async (refresh = false) => {
    if (refresh) {
      setChecking(true);
      setCheckError('');
    }
    try {
      const next = await fetchUpdates({ refresh });
      if (mounted.current) setUpdates(next);
    } catch (err) {
      if (mounted.current && refresh) setCheckError(describeApiError(err, FEATURE));
    } finally {
      if (mounted.current && refresh) setChecking(false);
    }
  }, []);

  useEffect(() => { loadInstalled(); }, [loadInstalled]);

  // The cached check loads the first time Installed shows; it never downloads.
  useEffect(() => {
    if (view !== 'installed' || updatesAsked.current) return;
    updatesAsked.current = true;
    loadUpdates(false);
  }, [view, loadUpdates]);

  // An install, update or delete finished somewhere: reload quietly.
  useEffect(() => {
    if (revision === firstRevision.current) return;
    firstRevision.current = revision;
    loadInstalled({ quiet: true });
    if (updatesAsked.current) loadUpdates(false);
  }, [revision, loadInstalled, loadUpdates]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);

  const installedSet = useMemo(() => {
    const set = installedNameSet(data?.models || []);
    // The picker list also knows what is installed, in case this list failed to load.
    for (const r of catalog || []) if (r?.available) set.add(normalizeModelName(pullName(r)));
    return set;
  }, [data, catalog]);

  async function remove(name) {
    const failure = await onDelete(name);
    if (!failure && mounted.current) {
      setData((d) => (d ? { ...d, models: d.models.filter((m) => m.name !== name) } : d));
    }
    return failure;
  }

  function retry() {
    loadInstalled();
    onRefresh?.();
  }

  const shared = { catalog, jobs, installErrors, goDark, onInstall, onCancel };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl size="sm" value={view} onChange={onViewChange} options={VIEW_OPTIONS} />
      </div>
      {goDark ? (
        <SettingsNotice tone="info" icon={<MoonIcon size={13} />} className="mb-6">
          Go Dark is on
        </SettingsNotice>
      ) : null}
      {seen.installed ? (
        <div hidden={view !== 'installed'}>
          <InstalledView
            {...shared}
            state={state}
            error={error}
            data={data}
            updates={updates}
            checking={checking}
            checkError={checkError}
            now={now}
            onRetry={retry}
            onCheck={() => loadUpdates(true)}
            onDelete={remove}
            onDismissError={onDismissError}
            onDiscover={() => onViewChange('discover')}
          />
        </div>
      ) : null}
      {seen.discover ? (
        <div hidden={view !== 'discover'}>
          <DiscoverTab {...shared} ramGb={ramGb} appleSilicon={appleSilicon} installedSet={installedSet} />
        </div>
      ) : null}
    </div>
  );
}
