// @ts-check
// HTTP routes for agent runs. Separate from chat because a run is a long-lived
// job with a budget and a stop control that must survive a dropped socket.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';

import { runAgent } from './agentLoop.js';
import { resolveEffort, EFFORT_PROFILES, EFFORT_ORDER, isAgenticEffort } from './effortProfiles.js';
import { createToolRegistry, TOOL_POLICIES } from './tools.js';
import { createModelAdapter } from './modelAdapter.js';
import { classifyProviderScope } from '../providerScope.js';
import { isGoDark } from '../egress.js';
import { createRunAuditor, pruneRunAudits, readRunAudit } from './auditLog.js';
import { createRunStore } from './runStore.js';
import { getFsRoot, safeResolvePath } from './sandbox.js';
import { dirname, join } from 'node:path';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { resolveUserPath } from '../paths.js';

/** Live runs, so a client that reconnects can still stop one. */
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

/** Runs that are still executing right now. */
function liveRunCount(runs) {
  let n = 0;
  for (const r of runs.values()) if (r.status === 'running' || r.status === 'stopping') n += 1;
  return n;
}

/**
 * @param {object} deps
 * @param {{aiProvider?:string, [k:string]:any}} deps.config
 * @param {Function} deps.streamWithProvider
 * @param {Function} deps.getEffectiveModel  Resolves 'auto'/absent into a real model id.
 * @param {Function} [deps.resolveTuning]  Ollama context sizing, same as chat.
 * @param {{get: Function}} [deps.providerKeys]  Server-held API keys.
 * @param {{getChat: Function, saveChat: Function, getEpoch: Function, chatStorePath: string, nowIso: Function, uuid: Function}} [deps.chats]
 *        Optional chat persistence. When supplied and the caller passes a chatId,
 *        the run's goal and result are written into that chat.
 * @param {Function} [deps.guard]  Privileged-route guard, applied to every route here.
 */
export function createAgentRouter({ config, streamWithProvider, getEffectiveModel, resolveTuning, chats, providerKeys, guard }) {
  const router = Router();
  // One append-only log per run, beside the other stores.
  const auditDir = join(dirname(config.chatStorePath || '.'), 'agent-runs');
  // Prune at startup so audit logs cannot fill the disk.
  pruneRunAudits(auditDir).catch(() => {});

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
  if (guard) router.use(guard);

  // Effort picker data, served from the profiles so UI and server agree.
  router.get('/effort-profiles', (_req, res) => {
    res.json({
      order: EFFORT_ORDER,
      policies: TOOL_POLICIES,
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
        id: r.id, goal: r.goal, effort: r.effort, status: r.status,
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
      run.status = 'stopping';
      runStore.upsert({ id: run.id, status: 'stopping' }).catch(() => {});
    }
    res.json({ ok: true, id: run.id, status: run.status, alreadyFinished: !live });
  });

  // Start a run and stream its progress over SSE.
  router.post('/runs', async (req, res) => {
    const {
      goal, effort = 'high', provider, model, providerBaseUrl, providerApiKey,
      toolPolicy = 'read-only', fsRoot, workDir, systemPrompt, localOnly, overrides, chatId,
      acknowledgeFullPolicy
    } = req.body || {};

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

    // 'full' is an unattended shell, so it needs an explicit acknowledgement that
    // no default or remembered setting can supply. Checked here for every client.
    if (toolPolicy === 'full' && acknowledgeFullPolicy !== true) {
      res.status(400).json({
        error: 'The "full" tool policy lets this run execute shell commands unattended. '
          + 'The filesystem root limits where a command starts, not what it can reach. '
          + 'Re-send with acknowledgeFullPolicy: true to confirm.',
        requiresAcknowledgement: 'full-policy'
      });
      return;
    }
    // Write and full runs need a project folder; without one, relative paths
    // resolve against the backend directory and absolute paths reach all of home.
    const requestedRoot = typeof fsRoot === 'string' && fsRoot.trim() ? resolveUserPath(fsRoot) : '';
    if ((toolPolicy === 'write' || toolPolicy === 'full') && !requestedRoot && !getFsRoot()) {
      res.status(400).json({
        error: 'Pick a project folder first. Open Workspace and choose the folder this run may change.',
        requiresFolder: true
      });
      return;
    }
    if (requestedRoot && path.parse(requestedRoot).root === requestedRoot) {
      res.status(400).json({ error: 'The project folder cannot be the root of the disk.' });
      return;
    }
    if (requestedRoot) {
      const st = await stat(requestedRoot).catch(() => null);
      if (!st || !st.isDirectory()) {
        res.status(400).json({ error: `Project folder not found: ${requestedRoot}` });
        return;
      }
    }

    if (!isAgenticEffort(effort)) {
      res.status(400).json({
        error: `Effort "${effort}" is not an autonomous tier. Use one of: `
          + EFFORT_ORDER.filter(isAgenticEffort).join(', ') + '. '
          + 'The other tiers are single-shot and belong on the normal chat route.'
      });
      return;
    }
    // Go Dark applies to agent runs exactly as to chat turns.
    if (localOnly === true || isGoDark()) {
      const scope = classifyProviderScope(provider || config.aiProvider, providerBaseUrl);
      if (scope.offDevice) {
        res.status(403).json({ error: `Go Dark is on - ${scope.reason} Pick a local model or turn Go Dark off.` });
        return;
      }
    }

    const profile = resolveEffort(effort, overrides || {});
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

    /** @type {{id:string, goal:string, effort:string, status:string, startedAt:string, abort:AbortController, budget:any}} */
    const record = {
      id, goal, effort: profile.id, status: 'running',
      startedAt: new Date().toISOString(), abort, budget: null
    };
    runs.set(id, record);

    // Abort on disconnect so a long job does not outlive its client.
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    const auditor = createRunAuditor({ dir: auditDir, runId: id });
    await storeReady;
    await runStore.upsert({
      id, goal, effort: profile.id, policy: toolPolicy, status: 'running',
      startedAt: record.startedAt, auditLog: auditor.file, chatId: chatId || null
    });
    send('run-accepted', { id, effort: profile.id, policy: toolPolicy, limits: profile, auditLog: auditor.file });

    try {
      // A caller-supplied fsRoot may only narrow the operator's
      // MIRABILIS_MCP_FS_ROOT jail, never replace it.
      const operatorRoot = getFsRoot();
      let effectiveRoot = requestedRoot || operatorRoot || undefined;
      if (requestedRoot && operatorRoot) {
        try {
          effectiveRoot = safeResolvePath(requestedRoot, operatorRoot);
        } catch {
          send('error', { error: `fsRoot must be inside the configured filesystem root (${operatorRoot}).` });
          record.status = 'failed';
          res.end();
          return;
        }
      }

      const buildRegistry = () => createToolRegistry({
        policy: TOOL_POLICIES.includes(toolPolicy) ? toolPolicy : 'read-only',
        fsRoot: effectiveRoot,
        // Relative paths and commands start in the project folder.
        workDir: workDir ? resolveUserPath(workDir) : effectiveRoot,
        signal: abort.signal
      });
      const registry = buildRegistry();

      // Resolve the model as the chat route does; the picker's "Auto" sends none.
      const activeProvider = provider || config.aiProvider;
      const effectiveModel = typeof getEffectiveModel === 'function'
        ? await getEffectiveModel({ provider: activeProvider, model, config })
        : model;
      if (!effectiveModel) {
        send('error', { error: 'No model is available for this provider. Install or select a model first.' });
        record.status = 'failed';
        res.end();
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
        goal, effort: profile.id, policy: registry.policy,
        provider: activeProvider, model: effectiveModel,
        fsRoot: effectiveRoot,
        limits: {
          maxWallMs: profile.maxWallMs, maxIterations: profile.maxIterations,
          maxToolCalls: profile.maxToolCalls, maxSubAgents: profile.maxSubAgents
        }
      });

      const outcome = await runAgent({
        goal, profile, registry, callModel, systemPrompt,
        // Sub-agents need their own registry; without this factory the loop does
        // not register spawn_agents and maxSubAgents has no effect.
        makeRegistry: buildRegistry,
        signal: abort.signal,
        onEvent: (/** @type {any} */ event) => {
          if (event?.budget) record.budget = event.budget;
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

      send('result', { ...outcome, persistedTo, auditLog: auditor.file });
    } catch (error) {
      record.status = 'failed';
      await runStore.upsert({
        id, status: 'failed', stopReason: 'failed',
        error: String(error?.message || error), finishedAt: new Date().toISOString()
      }).catch(() => {});
      await auditor.note('run-error', { error: String(error?.message || error) });
      send('error', { error: String(error?.message || error) });
    } finally {
      res.end();
      setTimeout(() => runs.delete(id), FINISHED_TTL_MS).unref?.();
    }
  });

  return router;
}
