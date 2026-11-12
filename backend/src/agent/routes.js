// @ts-check
// HTTP routes for agent runs. Separate from chat because a run is a long-lived job
// with a budget, approvals and a stop control.

import { Router } from 'express';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isGoDark } from '../egress.js';
import { resolveUserPath } from '../paths.js';
import { classifyProviderScope } from '../providerScope.js';
import { runAgent } from './agentLoop.js';
import { createApprovalBroker } from './approvals.js';
import { createRunAuditor, pruneRunAudits, readRunAudit } from './auditLog.js';
import { EFFORT_ORDER, EFFORT_PROFILES, isAgenticEffort, resolveRunProfile } from './effortProfiles.js';
import { createModelAdapter } from './modelAdapter.js';
import { ACCESS_LEVELS, lowerLevel, normalizeLevel } from './permissions.js';
import { createRunStore } from './runStore.js';
import { getFsRoot, safeResolvePath } from './sandbox.js';
import { createSelfTools } from './selfTools.js';
import { scrub } from './systemTools.js';
import { createRunRules, createToolRegistry, pruneRunBackups } from './tools.js';

/** Live runs, so a client that reconnects can still stop one or answer its approvals. */
const runs = new Map();

/** Keep finished runs briefly so a client can collect the result after a drop. */
const FINISHED_TTL_MS = 10 * 60_000;

/**
 * Concurrent run cap, enforced here because any token holder can start runs and
 * each may carry its own shell. Two allows a deliberate second run but stops a loop.
 */
const MAX_CONCURRENT_RUNS = Math.max(
  1,
  Number(process.env.MIRABILIS_AGENT_MAX_CONCURRENT_RUNS) || 2
);

/** backend/src/agent, three levels up: the repo root, or the packaged app's resources folder. */
const DEFAULT_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DECISIONS = ['allow', 'always', 'deny'];
const MAX_NOTE_CHARS = 500;
const OLLAMA_PROBE_MS = 2_500;
/** A run can sit for hours on an approval; a comment line keeps the stream alive. */
const HEARTBEAT_MS = 25_000;

const ACCESS_LINES = {
  chat: 'Access: Chat only. You have no tools; answer from what you know.',
  read: 'Access: Read only. You may read files anywhere, inspect the system and run read-only commands.',
  ask: 'Access: Ask first. Reading and read-only commands run freely; anything that changes something needs the user\'s approval.',
  bypass: 'Access: Bypass. Every tool runs without approval: file changes, any command, every connector tool.'
};

/** Runs that are still executing right now. */
function liveRunCount(runs) {
  let n = 0;
  for (const r of runs.values()) if (r.status === 'running' || r.status === 'stopping') n += 1;
  return n;
}

/** @param {string} file @param {string[]} args */
function execText(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: 3_000, windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : String(stdout || '').trim());
      });
    } catch {
      resolve('');
    }
  });
}

/** @type {Promise<{os: string, arch: string, user: string, home: string, shell: string}>|null} */
let hostFactsPromise = null;

/** OS name and version as the user knows them (macOS 26.1, not Darwin 25.1). Cached. */
function hostFacts() {
  if (!hostFactsPromise) {
    hostFactsPromise = (async () => {
      const platform = process.platform;
      let osName = `${os.type()} ${os.release()}`;
      if (platform === 'darwin') {
        const [name, version] = await Promise.all([execText('sw_vers', ['-productName']), execText('sw_vers', ['-productVersion'])]);
        if (version) osName = `${name || 'macOS'} ${version}`;
      } else if (platform === 'linux') {
        const text = await readFile('/etc/os-release', 'utf8').catch(() => '');
        const m = text.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
        if (m) osName = m[1];
      } else if (platform === 'win32') {
        try { osName = os.version() || osName; } catch { /* keep os.type() */ }
      }
      let user = '';
      let shell = '';
      try {
        const info = os.userInfo();
        user = info.username;
        shell = info.shell || '';
      } catch { /* no passwd entry, as in some containers */ }
      return {
        os: osName,
        arch: os.arch(),
        user: user || process.env.USER || process.env.USERNAME || 'unknown',
        home: os.homedir(),
        shell: platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || shell || '/bin/sh')
      };
    })();
  }
  return hostFactsPromise;
}

/**
 * The plain facts a run needs: where it is, what it may do, where its own source is.
 * @param {{level: 'chat'|'read'|'ask'|'bypass', sourceRoot: string, projectDir: string}} p
 */
async function systemContext({ level, sourceRoot, projectDir }) {
  const h = await hostFacts();
  const lines = [
    `You are Mirabilis, an assistant running on this computer: ${h.os} (${h.arch}), user ${h.user}, home ${h.home}, shell ${h.shell}.`,
    ACCESS_LINES[level]
  ];
  if (level !== 'chat') {
    lines.push(`Your own source code is at ${sourceRoot}. For questions about how Mirabilis works, call mirabilis_architecture first, then read the source.`);
  }
  if (projectDir) lines.push(`Project folder: ${projectDir}.`);
  if (level === 'ask') lines.push('When a tool needs approval the app asks the user; just call the tool.');
  if (level === 'read') lines.push('You cannot change anything; when a fix needs a change, give the exact command or edit for the user to apply.');
  if (level === 'bypass') lines.push('Actions run without confirmation. Check before you change anything.');
  return lines.join('\n');
}

/** @param {string} raw */
function safeUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return String(raw || '');
  }
}

/** @param {number} bytes */
const gb = (bytes) => (Number.isFinite(bytes) ? Math.round((bytes / 1e9) * 10) / 10 : null);

/**
 * Is Ollama answering, which models are installed, which are loaded and how much
 * of each sits on the GPU. Bounded; never throws.
 * @param {string} baseUrl
 */
async function probeOllama(baseUrl) {
  const url = safeUrl(baseUrl || 'http://127.0.0.1:11434');
  const getJson = async (p) => {
    const res = await fetch(`${url}${p}`, { signal: AbortSignal.timeout(OLLAMA_PROBE_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const [tags, ps] = await Promise.allSettled([getJson('/api/tags'), getJson('/api/ps')]);
  if (tags.status === 'rejected') {
    const err = /** @type {any} */ (tags.reason);
    const why = err?.name === 'TimeoutError' ? `no answer within ${OLLAMA_PROBE_MS / 1000}s` : String(err?.message || err);
    return { url, reachable: false, error: why };
  }
  const installed = (tags.value?.models || []).map((/** @type {any} */ m) => m?.name).filter(Boolean);
  /** @type {Record<string, any>} */
  const out = { url, reachable: true, installedModels: installed.slice(0, 40) };
  if (installed.length > 40) out.installedNotShown = installed.length - 40;
  if (ps.status === 'fulfilled') {
    out.loadedModels = (ps.value?.models || []).slice(0, 10).map((/** @type {any} */ m) => ({
      name: m?.name, sizeGB: gb(m?.size), onGpuGB: gb(m?.size_vram)
    }));
  }
  return out;
}

/**
 * @param {object} deps
 * @param {{aiProvider?:string, chatStorePath?: string, ollamaBaseUrl?: string, [k:string]:any}} deps.config
 * @param {Function} deps.streamWithProvider
 * @param {Function} deps.getEffectiveModel  Resolves 'auto'/absent into a real model id.
 * @param {Function} [deps.resolveTuning]  Ollama context sizing, same as chat.
 * @param {{get: Function, listMasked?: Function}} [deps.providerKeys]  Server-held API keys.
 * @param {{getChat: Function, saveChat: Function, getEpoch: Function, chatStorePath: string, nowIso: Function, uuid: Function}} [deps.chats]
 *        Optional chat persistence. When supplied and the caller passes a chatId,
 *        the run's goal and result are written into that chat.
 * @param {Function} [deps.guard]  Privileged-route guard, applied to every route here.
 * @param {ReturnType<typeof import('../accessSettings.js').createAccessStore>} [deps.accessStore]
 *        The saved Access level. Without it every run is Chat only.
 * @param {any} [deps.connectors]   Connector manager: agentTools(), list(), update().
 * @param {string} [deps.sourceRoot] Folder holding backend/, frontend/ and docs/.
 * @param {string} [deps.dataDir]
 */
export function createAgentRouter({
  config, streamWithProvider, getEffectiveModel, resolveTuning, chats, providerKeys, guard,
  accessStore, connectors, sourceRoot = DEFAULT_SOURCE_ROOT, dataDir
}) {
  const router = Router();
  const dataFolder = dataDir || path.dirname(config.chatStorePath || '.');
  // One append-only log per run, beside the other stores.
  const auditDir = path.join(dataFolder, 'agent-runs');
  // Prune at startup so audit logs and pre-write copies cannot fill the disk.
  pruneRunAudits(auditDir).catch(() => {});
  pruneRunBackups(auditDir).catch(() => {});

  // Durable run index. On boot, runs still marked live are marked interrupted,
  // since this process cannot be running them.
  const runStore = createRunStore(auditDir);
  const storeReady = runStore.init()
    .then(({ interrupted }) => {
      if (interrupted > 0) {
        console.log(`[agent] marked ${interrupted} run(s) as interrupted by a restart`);
      }
    })
    .catch(() => {});
  if (guard) router.use(/** @type {any} */ (guard));

  const savedLevel = () => normalizeLevel(accessStore ? accessStore.get().level : 'chat');

  // Effort picker data, served from the profiles so UI and server agree.
  router.get('/effort-profiles', (_req, res) => {
    res.json({
      order: EFFORT_ORDER,
      levels: ACCESS_LEVELS,
      profiles: EFFORT_ORDER.map((id) => {
        const p = EFFORT_PROFILES[id];
        return {
          id: p.id,
          label: p.label,
          description: p.description,
          agentic: p.agentic,
          maxWallMs: p.maxWallMs,
          maxIterations: p.maxIterations,
          maxToolCalls: p.maxToolCalls,
          maxSubAgents: p.maxSubAgents,
          plan: p.plan,
          validate: p.validate
        };
      })
    });
  });

  router.get('/runs', async (_req, res) => {
    await storeReady;
    // The live Map is the truth for anything running now; the store carries
    // history and anything a restart interrupted.
    const merged = new Map(runStore.list().map((r) => [r.id, r]));
    for (const r of runs.values()) {
      merged.set(r.id, {
        id: r.id, goal: r.goal, effort: r.effort, access: r.access, status: r.status,
        startedAt: r.startedAt, budget: r.budget || null
      });
    }
    res.json({
      runs: [...merged.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    });
  });

  // Audit log of a past run; the live feed is gone once the tab closes.
  router.get('/runs/:id/audit', async (req, res) => {
    try {
      res.json({ id: req.params.id, entries: await readRunAudit(auditDir, req.params.id) });
    } catch {
      res.status(404).json({ error: 'No audit log for that run.' });
    }
  });

  router.post('/runs/:id/stop', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) { res.status(404).json({ error: 'No such run.' }); return; }
    // Only a live run may move to "stopping", or a finished run is mislabelled
    // in the run list.
    const live = run.status === 'running';
    if (live) {
      run.abort.abort();
      run.broker?.cancelAll('stopped');
      run.status = 'stopping';
      runStore.upsert({ id: run.id, status: 'stopping' }).catch(() => {});
    }
    res.json({ ok: true, id: run.id, status: run.status, alreadyFinished: !live });
  });

  // Approvals a run is waiting on, for a client that joined late or reconnected.
  router.get('/runs/:id/approvals', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) { res.status(404).json({ error: 'No such run.' }); return; }
    res.json({ pending: run.broker ? run.broker.pending() : [] });
  });

  router.post('/runs/:id/approvals/:approvalId', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run || !run.broker) { res.status(404).json({ error: 'No such run.' }); return; }
    const { decision, note } = req.body || {};
    if (!DECISIONS.includes(decision)) {
      res.status(400).json({ error: 'decision must be allow, always or deny.' });
      return;
    }
    if (note != null && typeof note !== 'string') {
      res.status(400).json({ error: 'note must be text.' });
      return;
    }
    const cleanNote = typeof note === 'string' ? note.trim().slice(0, MAX_NOTE_CHARS) : undefined;
    const outcome = run.broker.resolve(String(req.params.approvalId), decision, cleanNote);
    if (outcome === 'not-found') { res.status(404).json({ error: 'This run has no such approval.' }); return; }
    if (outcome === 'already-resolved') { res.status(409).json({ error: 'This approval was already answered.' }); return; }
    res.json({ ok: true });
  });

  // Start a run and stream its progress over SSE.
  router.post('/runs', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const {
      goal, effort = 'balanced', access, provider, model, providerBaseUrl, providerApiKey,
      fsRoot, systemPrompt, localOnly, overrides, chatId
    } = body;

    if (!goal || typeof goal !== 'string' || !goal.trim()) {
      res.status(400).json({ error: 'goal is required' });
      return;
    }
    const live = liveRunCount(runs);
    if (live >= MAX_CONCURRENT_RUNS) {
      res.status(429).json({
        error: `${live} agent run(s) are already in progress and the limit is ${MAX_CONCURRENT_RUNS}. `
          + 'Stop one before starting another, or raise MIRABILIS_AGENT_MAX_CONCURRENT_RUNS.',
        liveRuns: live,
        limit: MAX_CONCURRENT_RUNS
      });
      return;
    }

    // A request can lower the saved level, never raise it.
    const stored = savedLevel();
    const level = access === undefined || access === null || access === '' ? stored : lowerLevel(access, stored);
    const effortId = String(effort || 'balanced');
    if (level === 'chat' && !isAgenticEffort(effortId)) {
      res.status(400).json({ error: 'Chat only: send this as a normal chat message, or change Access.', useChat: true });
      return;
    }

    // The project folder is where relative paths and commands start; it is not a jail.
    const projectDir = typeof fsRoot === 'string' && fsRoot.trim() ? resolveUserPath(fsRoot) : '';
    if (projectDir && path.parse(projectDir).root === projectDir) {
      res.status(400).json({ error: 'The project folder cannot be the root of the disk.' });
      return;
    }
    if (projectDir) {
      const st = await stat(projectDir).catch(() => null);
      if (!st || !st.isDirectory()) {
        res.status(400).json({ error: `Project folder not found: ${projectDir}` });
        return;
      }
    }
    // The operator jail (MIRABILIS_MCP_FS_ROOT) holds at every level, Bypass included.
    const operatorRoot = getFsRoot();
    if (projectDir && operatorRoot) {
      try {
        safeResolvePath(projectDir, operatorRoot);
      } catch {
        res.status(400).json({ error: `The project folder must be inside the configured filesystem root (${operatorRoot}).` });
        return;
      }
    }

    // Go Dark applies to agent runs exactly as to chat turns.
    if (localOnly === true || isGoDark()) {
      const scope = classifyProviderScope(provider || config.aiProvider, providerBaseUrl);
      if (scope.offDevice) {
        res.status(403).json({ error: `Go Dark is on - ${scope.reason} Pick a local model or turn Go Dark off.` });
        return;
      }
    }

    const profile = resolveRunProfile(effortId, overrides && typeof overrides === 'object' ? overrides : {});
    const abort = new AbortController();
    const id = randomUUID();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, payload) => {
      if (res.writableEnded || res.destroyed || !res.writable) return false;
      res.write(`event: ${event}\n`);
      return res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const auditor = createRunAuditor({ dir: auditDir, runId: id });
    // Approval events carry the run clock of the last loop event, so the feed reads in order.
    let lastAt = 0;
    const broker = createApprovalBroker({
      signal: abort.signal,
      emit: (type, payload) => {
        const p = /** @type {any} */ (payload);
        send('progress', { type, at: lastAt, ...p });
        if (type === 'approval-required') {
          auditor.note('approval-required', {
            approvalId: p.approvalId, tool: p.tool, kind: p.kind, title: p.title,
            detail: scrub(String(p.detail || '')).slice(0, 2_000), subAgent: p.subAgent ?? null
          });
        } else {
          auditor.note('approval-resolved', { approvalId: p.approvalId, decision: p.decision });
        }
      }
    });

    /** @type {{id:string, goal:string, effort:string, access:string, status:string, startedAt:string, abort:AbortController, budget:any, broker:any}} */
    const record = {
      id, goal, effort: profile.id, access: level, status: 'running',
      startedAt: new Date().toISOString(), abort, budget: null, broker
    };
    runs.set(id, record);

    // Abort on disconnect so a long job does not outlive its client.
    res.on('close', () => {
      if (!res.writableEnded) {
        abort.abort();
        broker.cancelAll('disconnected');
      }
    });

    await storeReady;
    await runStore.upsert({
      id, goal, effort: profile.id, access: level, status: 'running',
      startedAt: record.startedAt, auditLog: auditor.file, chatId: chatId || null
    });
    send('run-accepted', { id, effort: profile.id, access: level, limits: profile, auditLog: auditor.file });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed && res.writable) res.write(': keepalive\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const activeProvider = provider || config.aiProvider;
    // Resolved below; the status tool reads it when it runs.
    /** @type {string|undefined} */
    let effectiveModel;

    try {
      // Shared by the run and its sub-agents: an "Always allow" holds for all of them.
      const runRules = createRunRules();
      const gate = {
        allowCommands: () => (accessStore ? accessStore.get().allowCommands : []),
        goDark: () => isGoDark(),
        storedLevel: () => savedLevel(),
        runRules,
        broker,
        persistAllowCommand: async (/** @type {string} */ rule) => {
          if (!accessStore) return;
          await accessStore.addAllowCommand(rule);
          auditor.note('always-allow', { rule });
        },
        persistConnectorPermission: async (/** @type {string} */ _key, /** @type {'allow'} */ permission, /** @type {any} */ tool) => {
          if (!connectors?.update || !tool?.connectorId || !tool?.mcpTool) return;
          await connectors.update(tool.connectorId, { tools: { [tool.mcpTool]: permission } });
          auditor.note('always-allow', { connector: tool.connectorName, tool: tool.mcpTool });
        }
      };

      const getStatus = async () => ({
        goDark: isGoDark(),
        access: { thisRun: level, saved: savedLevel() },
        run: { provider: activeProvider || null, model: effectiveModel || null, effort: profile.id },
        ollama: await probeOllama(String(config.ollamaBaseUrl || '')),
        // Names only: which cloud providers have a key saved in Mirabilis.
        cloudProvidersWithKeys: (providerKeys?.listMasked?.() || [])
          .filter((/** @type {any} */ k) => k?.hasKey)
          .map((/** @type {any} */ k) => k.provider),
        connectors: (() => {
          try {
            return (connectors?.list?.() || []).map((/** @type {any} */ c) => ({
              name: c.name,
              state: c.status?.state,
              toolCount: c.status?.toolCount ?? 0,
              ...(c.status?.error ? { error: c.status.error } : {})
            }));
          } catch {
            return [];
          }
        })()
      });

      const selfTools = createSelfTools({ sourceRoot, dataDir: dataFolder, getStatus });
      // The system tools arrive here too, from the built-in This computer connector.
      const connectorTools = () => {
        if (level === 'chat') return {};
        try { return connectors?.agentTools?.() || {}; } catch { return {}; }
      };

      const buildRegistry = () => createToolRegistry({
        level,
        fsRoot: operatorRoot || undefined,
        workDir: projectDir || undefined,
        dataDir: dataFolder,
        runId: id,
        signal: abort.signal,
        gate,
        extraTools: { ...selfTools, ...connectorTools() },
        audit: (kind, payload) => auditor.note(kind, payload)
      });
      const registry = buildRegistry();

      // Resolve the model as the chat route does; the picker's "Auto" sends none.
      effectiveModel = typeof getEffectiveModel === 'function'
        ? await getEffectiveModel({ provider: activeProvider, model, config })
        : model;
      if (!effectiveModel) {
        const error = 'No model is available for this provider. Install or select a model first.';
        send('error', { error });
        record.status = 'failed';
        await runStore.upsert({ id, status: 'failed', stopReason: 'failed', error, finishedAt: new Date().toISOString() }).catch(() => {});
        return;
      }
      send('progress', { type: 'model-resolved', at: 0, provider: activeProvider, model: effectiveModel });

      // Same context sizing as chat. Without it Ollama runs use its small stock
      // window and long tool output pushes the goal out of context.
      const tuning = typeof resolveTuning === 'function'
        ? await resolveTuning({ provider: activeProvider, model: effectiveModel, baseUrl: providerBaseUrl || config.ollamaBaseUrl }).catch(() => null)
        : null;

      const callModel = createModelAdapter({
        streamWithProvider,
        config,
        signal: abort.signal,
        request: {
          provider: activeProvider,
          model: effectiveModel,
          baseUrl: providerBaseUrl,
          ollamaOptions: tuning?.options,
          // Same rule as the chat path: use the key the backend holds unless the
          // caller supplied its own.
          apiKey: (typeof providerApiKey === 'string' && providerApiKey.trim())
            ? providerApiKey
            : (providerKeys?.get?.(activeProvider) || undefined)
        }
      });

      await auditor.start({
        goal, effort: profile.id, policy: level,
        provider: activeProvider, model: effectiveModel,
        fsRoot: projectDir || operatorRoot || null,
        limits: {
          maxWallMs: profile.maxWallMs, maxIterations: profile.maxIterations,
          maxToolCalls: profile.maxToolCalls, maxSubAgents: profile.maxSubAgents
        }
      });
      await auditor.note('tools', { access: level, offered: registry.names() });

      const runSystemPrompt = [
        await systemContext({ level, sourceRoot, projectDir }),
        typeof systemPrompt === 'string' ? systemPrompt.trim() : '',
        profile.styleHint || ''
      ].filter(Boolean).join('\n\n');

      const outcome = await runAgent({
        goal, profile, registry, callModel, systemPrompt: runSystemPrompt,
        // Sub-agents need their own registry; without this factory the loop does
        // not register spawn_agents and maxSubAgents has no effect.
        makeRegistry: buildRegistry,
        signal: abort.signal,
        onEvent: (/** @type {any} */ event) => {
          if (event?.budget && event.subAgent === undefined) record.budget = event.budget;
          if (typeof event?.at === 'number' && event.subAgent === undefined) lastAt = event.at;
          send('progress', event);
          // Mirror security-relevant events to disk. Fire and forget: the
          // auditor swallows its own failures.
          if (event?.type === 'tool-call') {
            auditor.tool({ iteration: event.iteration, tool: event.tool, args: event.args, mutating: event.mutating });
          } else if (event?.type === 'tool-result') {
            auditor.result({ iteration: event.iteration, tool: event.tool, ok: event.ok, observation: event.observation });
          } else if (event?.type === 'fanout-start') {
            auditor.note('fanout', { count: event.count, concurrency: event.concurrency });
          }
        }
      });
      broker.cancelAll('finished');

      record.status = outcome.ok ? 'completed' : String(outcome.stopReason || 'stopped');
      record.budget = outcome.budget;
      await runStore.upsert({
        id, status: record.status, stopReason: outcome.stopReason,
        budget: outcome.budget, steps: outcome.steps, validated: outcome.validated,
        finishedAt: new Date().toISOString()
      });

      // Persist to the chat server side so goal and answer are saved together
      // and the clear-chats epoch guard applies.
      let persistedTo = null;
      if (chatId && chats?.getChat) {
        try {
          const chat = await chats.getChat(chats.chatStorePath, chatId);
          if (chat) {
            const epoch = chats.getEpoch();
            chat.messages.push({
              id: chats.uuid(), role: 'user', content: goal, createdAt: chats.nowIso()
            });
            chat.messages.push({
              id: chats.uuid(),
              role: 'assistant',
              content: outcome.answer || `(no result: ${outcome.stopReason})`,
              createdAt: chats.nowIso(),
              model: effectiveModel,
              provider: activeProvider,
              agentRun: {
                effort: profile.id,
                access: level,
                stopReason: outcome.stopReason,
                steps: outcome.steps,
                validated: outcome.validated,
                toolCalls: outcome.budget?.toolCalls || 0,
                elapsedMs: outcome.budget?.elapsedMs || 0
              }
            });
            chat.updatedAt = chats.nowIso();
            if (chats.getEpoch() === epoch) {
              await chats.saveChat(chats.chatStorePath, chat);
              persistedTo = chatId;
            }
          }
        } catch { /* the panel still holds the result; do not fail the run over this */ }
      }

      await auditor.end({
        stopReason: outcome.stopReason, steps: outcome.steps,
        validated: outcome.validated, budget: outcome.budget, answer: outcome.answer
      });

      send('result', { ...outcome, access: level, persistedTo, auditLog: auditor.file });
    } catch (error) {
      broker.cancelAll('failed');
      record.status = 'failed';
      await runStore.upsert({
        id, status: 'failed', stopReason: 'failed',
        error: String(error?.message || error), finishedAt: new Date().toISOString()
      }).catch(() => {});
      await auditor.note('run-error', { error: String(error?.message || error) });
      send('error', { error: String(error?.message || error) });
    } finally {
      clearInterval(heartbeat);
      res.end();
      setTimeout(() => runs.delete(id), FINISHED_TTL_MS).unref?.();
    }
  });

  return router;
}
