// Access settings: the level, the project folder, commands that skip approval in
// Ask first, and the built-in read-only list. Every change saves at once.
'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Badge, Button, IconButton, Spinner, AlertIcon, ChevronRightIcon, FolderIcon, PlusIcon, TrashIcon
} from '../ui/primitives';
import { appStore, useAppStore } from '../../store/useAppStore';
import {
  ACCESS_LEVELS, fetchAccess, saveAccess, describeApiError, normalizeAllowRule, allowRuleError
} from '../../lib/access';
import { SettingsGroup, SettingsList, SettingsRow, SettingsNotice } from './SettingsSheet';

const DANGER = '#f43f5e';
const FEATURE = 'Access';

const inputClass =
  'au-hairline au-focus h-8 w-full min-w-0 rounded-[var(--r-sm)] bg-transparent px-3 font-mono text-[length:var(--text-xs)] text-[color:var(--text-main)] placeholder:font-sans placeholder:text-[color:var(--text-muted)] placeholder:opacity-60 disabled:opacity-50';

const CHANGE_TEXT = { no: 'No', approval: 'With approval', yes: 'Yes' };

function RadioDot({ checked, color }) {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors"
      style={{ borderColor: checked ? color : 'color-mix(in srgb, var(--text-muted) 55%, transparent)' }}
    >
      {checked ? <span className="h-2 w-2 rounded-full" style={{ background: color }} /> : null}
    </span>
  );
}

function Fact({ label, value }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="text-[color:var(--text-muted)]">{label}:</span>
      <span className="font-medium text-[color:var(--text-main)]">{value}</span>
    </span>
  );
}

function LevelCard({ level, checked, pending, disabled, onSelect, buttonRef, idBase }) {
  const danger = level.tone === 'danger';
  const color = danger ? DANGER : 'var(--accent)';
  return (
    <button
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-labelledby={`${idBase}-label`}
      aria-describedby={danger ? `${idBase}-facts ${idBase}-warn` : `${idBase}-facts`}
      tabIndex={checked ? 0 : -1}
      onClick={() => { if (!disabled) onSelect(level.id); }}
      className={`au-focus flex w-full items-start gap-3 rounded-[var(--r-md)] border px-4 py-3 text-left transition-colors ${
        disabled ? 'cursor-not-allowed opacity-60' : checked ? '' : 'hover:bg-[color:var(--hairline)]'
      }`}
      style={{
        borderColor: checked ? `color-mix(in srgb, ${color} 60%, var(--hairline))` : 'var(--hairline)',
        background: checked ? `color-mix(in srgb, ${color} 8%, transparent)` : undefined
      }}
    >
      <RadioDot checked={checked} color={color} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span id={`${idBase}-label`} className="text-[length:var(--text-sm)] font-semibold text-[color:var(--text-main)]">
            {level.label}
          </span>
          {pending ? <Spinner size={12} /> : null}
        </span>
        <span id={`${idBase}-facts`} className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--text-2xs)]">
          <Fact label="Can read" value={level.canRead ? 'Yes' : 'No'} />
          <Fact label="Can change" value={CHANGE_TEXT[level.canChange] || 'No'} />
          <Fact label="Asks" value={level.asks ? 'Yes' : 'No'} />
        </span>
        {danger ? (
          <span id={`${idBase}-warn`} className="mt-2 flex items-center gap-1.5 text-[length:var(--text-2xs)] font-medium text-rose-600 dark:text-rose-300">
            <AlertIcon size={12} />
            Go Dark does not filter commands
          </span>
        ) : null}
      </span>
    </button>
  );
}

// Run logs live in <dataDir>/agent-runs (backend/src/agent/routes.js).
function runLogDir(dataDir) {
  const sep = dataDir.includes('\\') && !dataDir.includes('/') ? '\\' : '/';
  return `${dataDir.replace(/[\\/]+$/, '')}${sep}agent-runs`;
}

function PathText({ path }) {
  return (
    <span className="block truncate font-mono text-[length:var(--text-2xs)] text-[color:var(--text-muted)]" title={path}>
      {path}
    </span>
  );
}

export default function AccessPane({ workspaceRoot, onOpenWorkspace }) {
  const uid = useId();
  const storeLevel = useAppStore((s) => s.access);
  const workspaceOpen = useAppStore((s) => s.workspaceOpen);
  const openedPicker = useRef(false);

  const [settings, setSettings] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [pendingLevel, setPendingLevel] = useState('');
  const [levelError, setLevelError] = useState('');
  const [rulesBusy, setRulesBusy] = useState(false);
  const [ruleInput, setRuleInput] = useState('');
  const [ruleError, setRuleError] = useState('');
  const [showBuiltIn, setShowBuiltIn] = useState(false);

  const mounted = useRef(false);
  const cardRefs = useRef([]);

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError('');
    try {
      const next = await fetchAccess();
      if (!mounted.current) return;
      setSettings(next);
      setLoadState('ready');
      appStore.setAccess(next.level);
    } catch (err) {
      if (!mounted.current) return;
      setLoadError(describeApiError(err, FEATURE));
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; };
  }, [load]);

  const ready = loadState === 'ready' && settings != null;
  // Lists show this until settings arrive.
  const pendingText = loadState === 'loading' ? 'Loading...' : 'Not loaded';
  const savedLevel = settings ? settings.level : storeLevel;
  const shownLevel = pendingLevel || savedLevel;
  const rules = settings ? settings.allowCommands : [];
  const builtIn = settings ? settings.readOnlyPrograms : [];

  async function chooseLevel(id) {
    if (!ready || pendingLevel || id === savedLevel) return;
    setPendingLevel(id);
    setLevelError('');
    try {
      const next = await saveAccess({ level: id });
      if (!mounted.current) return;
      setSettings(next);
      appStore.setAccess(next.level);
    } catch (err) {
      if (mounted.current) setLevelError(describeApiError(err, FEATURE));
    } finally {
      if (mounted.current) setPendingLevel('');
    }
  }

  // Arrows move focus only. Choosing saves at once, so passing over Bypass on
  // the way to another card must not switch to it.
  function onRadioKeyDown(e) {
    const cards = cardRefs.current.filter(Boolean);
    const idx = cards.indexOf(document.activeElement);
    if (idx === -1) return;
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = Math.min(idx + 1, cards.length - 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = Math.max(idx - 1, 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = cards.length - 1;
    else return;
    e.preventDefault();
    cards[next]?.focus();
  }

  async function saveRules(next) {
    setRulesBusy(true);
    setRuleError('');
    try {
      const saved = await saveAccess({ allowCommands: next });
      if (!mounted.current) return false;
      setSettings(saved);
      return true;
    } catch (err) {
      if (mounted.current) setRuleError(describeApiError(err, FEATURE));
      return false;
    } finally {
      if (mounted.current) setRulesBusy(false);
    }
  }

  // The field is where work goes on after an add or a remove; the button pressed
  // is disabled (empty field) or gone (removed row).
  const focusRuleInput = () => document.getElementById(`${uid}-rule`)?.focus();

  async function addRule() {
    if (!ready || rulesBusy) return;
    const rule = normalizeAllowRule(ruleInput);
    const problem = allowRuleError(rule, rules);
    if (problem) {
      setRuleError(problem);
      return;
    }
    if (await saveRules([...rules, rule])) {
      setRuleInput('');
      focusRuleInput();
    }
  }

  async function removeRule(rule) {
    if (!ready || rulesBusy) return;
    if (await saveRules(rules.filter((r) => r !== rule))) focusRuleInput();
  }

  function chooseFolder() {
    openedPicker.current = true;
    onOpenWorkspace?.();
  }

  // The picker opens over Settings; focus comes back to Choose when it closes.
  useEffect(() => {
    if (workspaceOpen || !openedPicker.current) return;
    openedPicker.current = false;
    document.getElementById(`${uid}-choose`)?.focus();
  }, [workspaceOpen, uid]);

  return (
    <div>
      {loadState === 'error' ? (
        <SettingsNotice
          tone="danger"
          icon={<AlertIcon size={14} />}
          className="mb-6"
          action={<Button size="sm" variant="outline" onClick={load}>Try again</Button>}
        >
          Could not load Access settings. {loadError}
        </SettingsNotice>
      ) : null}

      <SettingsGroup
        title="Access level"
        action={
          loadState === 'loading' ? (
            <span className="flex items-center gap-2 text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
              <Spinner size={12} /> Loading...
            </span>
          ) : pendingLevel ? (
            <span className="text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">Saving...</span>
          ) : null
        }
      >
        <div
          role="radiogroup"
          aria-label="Access level"
          aria-busy={loadState === 'loading' || !!pendingLevel}
          onKeyDown={onRadioKeyDown}
          className="flex flex-col gap-2"
        >
          {ACCESS_LEVELS.map((level, i) => (
            <LevelCard
              key={level.id}
              level={level}
              idBase={`${uid}-${level.id}`}
              checked={shownLevel === level.id}
              pending={pendingLevel === level.id}
              disabled={!ready}
              onSelect={chooseLevel}
              buttonRef={(el) => { cardRefs.current[i] = el; }}
            />
          ))}
        </div>
        {levelError ? (
          <p role="alert" className="mt-2 text-[length:var(--text-xs)] text-rose-600 dark:text-rose-300">
            Not saved. {levelError}
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Workspace">
        <SettingsList>
          <SettingsRow
            label="Project folder"
            detail={workspaceRoot ? <PathText path={workspaceRoot} /> : (
              <span className="text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">Home folder</span>
            )}
          >
            <Button id={`${uid}-choose`} size="sm" variant="soft" onClick={chooseFolder}>
              <FolderIcon size={13} />
              Choose
            </Button>
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>

      <SettingsGroup
        title="Always allowed commands"
        action={<Badge>Ask first only</Badge>}
      >
        {rules.length > 0 ? (
          <SettingsList className="mb-3">
            {rules.map((rule) => (
              <div key={rule} className="flex items-center gap-3 py-1 pl-4 pr-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-xs)] text-[color:var(--text-main)]" title={rule}>
                  {rule}
                </code>
                <IconButton
                  size="sm"
                  label={`Remove ${rule}`}
                  onClick={() => removeRule(rule)}
                  aria-disabled={!ready || rulesBusy || undefined}
                >
                  <TrashIcon size={13} />
                </IconButton>
              </div>
            ))}
          </SettingsList>
        ) : (
          <p className="mb-3 text-[length:var(--text-xs)] text-[color:var(--text-muted)]">
            {ready ? 'None' : pendingText}
          </p>
        )}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); addRule(); }}
        >
          <label htmlFor={`${uid}-rule`} className="sr-only">Command to always allow</label>
          <input
            id={`${uid}-rule`}
            className={inputClass}
            placeholder="npm run build"
            value={ruleInput}
            onChange={(e) => { setRuleInput(e.target.value); if (ruleError) setRuleError(''); }}
            disabled={!ready}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={ruleError ? true : undefined}
            aria-describedby={ruleError ? `${uid}-rule-hint ${uid}-rule-error` : `${uid}-rule-hint`}
          />
          {/* r-sm to match the field; it sorts after the size's r-md. */}
          <Button
            type="submit"
            size="md"
            variant="soft"
            className="rounded-[var(--r-sm)]"
            disabled={!ready || !ruleInput.trim()}
            aria-disabled={rulesBusy || undefined}
          >
            {rulesBusy ? <Spinner size={12} /> : <PlusIcon size={13} />}
            Add
          </Button>
        </form>
        {/* Rules match on leading words (commandPolicy segmentMatchesRule): "git" also allows "git push". */}
        <p id={`${uid}-rule-hint`} className="mt-1 text-[length:var(--text-2xs)] text-[color:var(--text-muted)]">
          Matches commands that start with an entry
        </p>
        {ruleError ? (
          <p id={`${uid}-rule-error`} role="alert" className="mt-2 text-[length:var(--text-xs)] text-rose-600 dark:text-rose-300">
            {ruleError}
          </p>
        ) : null}

        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowBuiltIn((v) => !v)}
            aria-expanded={showBuiltIn}
            aria-controls={`${uid}-builtin`}
            className="au-focus -ml-1 inline-flex items-center gap-1.5 rounded-[var(--r-xs)] px-1 py-0.5 text-[length:var(--text-xs)] font-medium text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-main)]"
          >
            <ChevronRightIcon size={12} className={`transition-transform ${showBuiltIn ? 'rotate-90' : ''}`} />
            Built-in read-only commands{builtIn.length ? ` (${builtIn.length})` : ''}
          </button>
          {showBuiltIn ? (
            <div id={`${uid}-builtin`} className="mt-2">
              {builtIn.length ? (
                <div className="flex flex-wrap gap-1">
                  {builtIn.map((name) => (
                    <span
                      key={name}
                      className="au-hairline rounded-[var(--r-xs)] px-1.5 py-0.5 font-mono text-[length:var(--text-2xs)] text-[color:var(--text-main)]"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[length:var(--text-xs)] text-[color:var(--text-muted)]">
                  {ready ? 'None' : pendingText}
                </p>
              )}
            </div>
          ) : null}
        </div>
      </SettingsGroup>

      {settings?.dataDir || settings?.sourceRoot ? (
        <SettingsGroup title="Locations">
          <SettingsList>
            {settings.dataDir ? (
              <SettingsRow
                label="Run logs"
                detail={<PathText path={runLogDir(settings.dataDir)} />}
              />
            ) : null}
            {settings.sourceRoot ? (
              <SettingsRow
                label="Source code"
                detail={<PathText path={settings.sourceRoot} />}
              />
            ) : null}
          </SettingsList>
        </SettingsGroup>
      ) : null}
    </div>
  );
}
