// @ts-check
// backend/src/agent/routes.js
// HTTP surface for autonomous runs.
//
// Deliberately separate from the chat stream route. A chat turn is a request and
// a reply; an agent run is a job with a lifetime, a budget, a live event feed and
// a stop button, and pretending it is a chat message would mean either blocking
// the chat route for five hours or losing the run when the socket blinks.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';

import { runAgent } from './agentLoop.js';
import { resolveEffort, EFFORT_PROFILES, EFFORT_ORDER, isAgenticEffort } from './effortProfiles.js';
import { createToolRegistry, TOOL_POLICIES } from './tools.js';
import { createModelAdapter } from './modelAdapter.js';
import { classifyProviderScope } from '../providerScope.js';
import { createRunAuditor, pruneRunAudits, readRunAudit } from './auditLog.js';
import { createRunStore } from './runStore.js';
import { getFsRoot, safeResolvePath } from './sandbox.js';
import { dirname, join } from 'node:path';

/** Live runs, so a client that reconnects can still stop one. */
const runs = new Map();

/** Keep finished runs briefly so a client can collect the result after a drop. */
const FINISHED_TTL_MS = 10 * 60_000;

/**
 * How many runs may be executing at once.
 *
 * The UI allows one, but that is a convenience, not a control: this endpoint
 * takes a token, and anything holding it could start runs in a loop. Each one
 * carries its own budget and, at the full policy, its own shell, so an
 * unbounded count is a resource-exhaustion hole with a local-code-execution
 * flavour. Two, so a second run is possible deliberately but a loop is not.
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
 * @param {{get: Function}} [deps.providerKeys]  Server-held API keys.
 * @param {{getChat: Function, saveChat: Function, getEpoch: Function, chatStorePath: string, nowIso: Function, uuid: Function}} [deps.chats]
 *        Optional chat persistence. When supplied and the caller passes a chatId,
 *        the run's goal and result are written into that chat.
 * @param {Function} [deps.guard]  Privileged-route guard, applied to every route here.
 */
export function createAgentRouter({ config, streamWithProvider, getEffectiveModel, chats, providerKeys, guard }) {
  const router = Router();
  // One append-only log per run, beside the other stores.
  const auditDir = join(dirname(config.chatStorePath || '.'), 'agent-runs');
  // Housekeeping at startup so the record never becomes the thing that fills the disk.
  pruneRunAudits(auditDir).catch(() => {});

  // Durable run index. Reconciles on boot: anything the index still calls live
  // cannot be, since this process just started, so it is marked interrupted
  // rather than left as a run that appears to be going but never finishes.
  const runStore = createRunStore(auditDir);
  const storeReady = runStore.init()
    .then(({ interrupted }) => {
      if (interrupted > 0) {
        console.log(`[agent] marked ${interrupted} run(s) as interrupted by a restart`);
      }
    })
    .catch(() => {});
  if (guard) router.use(guard);

  // What the UI needs to render the effort picker, straight from the source of
  // truth so the two can never disagree about what "1 hour" means.
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

  // The record of what a run did, after the fact. This is the whole point of
  // the audit log: the live feed is gone once the tab closes.
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
    // Only a live run can be stopped. Flipping a finished run to "stopping"
    // left it permanently mislabelled in the run list.
    const live = run.status === 'running';
    if (live) {
      run.abort.abort();
      run.status = 'stopping';
      runStore.upsert({ id: run.id, status: 'stopping' }).catch(() => {});
    }
    res.json({ ok: true, id: run.id, status: run.status, alreadyFinished: !live });
  });

  // Start a run and stream its progress. The response is SSE for the same reason
  // the chat route is: the interesting part is what happens over the next hour,
  // not the final byte.
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

    // The 'full' policy is a real shell running unattended. Requiring an
    // explicit acknowledgement means it can never be reached by a default, a
    // remembered setting, or a caller that did not think about it. Checked on
    // the server so it holds for any client, not just this app's UI.
    if (toolPolicy === 'full' && acknowledgeFullPolicy !== true) {
      res.status(400).json({
        error: 'The "full" tool policy lets this run execute shell commands unattended. '
          + 'The filesystem root limits where a command starts, not what it can reach. '
          + 'Re-send with acknowledgeFullPolicy: true to confirm.',
        requiresAcknowledgement: 'full-policy'
      });
      return;
    }
    if (!isAgenticEffort(effort)) {
      res.status(400).json({
        error: `Effort "${effort}" is not an autonomous tier. Use one of: `
          + EFFORT_ORDER.filter(isAgenticEffort).join(', ') + '. '
          + 'The other tiers are single-shot and belong on the normal chat route.'
      });
      return;
    }
    // Go Dark applies to an agent exactly as it applies to a chat turn, and
    // matters more: a long run makes many calls.
    if (localOnly === true) {
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

    // A disconnect must not silently keep an hour-long job running.
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    const auditor = createRunAuditor({ dir: auditDir, runId: id });
    await storeReady;
    await runStore.upsert({
      id, goal, effort: profile.id, policy: toolPolicy, status: 'running',
      startedAt: record.startedAt, auditLog: auditor.file, chatId: chatId || null
    });
    send('run-accepted', { id, effort: profile.id, policy: toolPolicy, limits: profile, auditLog: auditor.file });

    try {
      // A caller-supplied fsRoot may only NARROW the operator's jail, never
      // replace it. Previously a request body could set fsRoot: "/" and quietly
      // discard MIRABILIS_MCP_FS_ROOT, which is the one setting an operator uses
      // to contain these runs.
      const operatorRoot = getFsRoot();
      let effectiveRoot = fsRoot || operatorRoot || undefined;
      if (fsRoot && operatorRoot) {
        try {
          effectiveRoot = safeResolvePath(fsRoot, operatorRoot);
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
        workDir: workDir || undefined,
        signal: abort.signal
      });
      const registry = buildRegistry();

      // Resolve the model the same way the chat route does. The picker's "Auto"
      // sends no model at all, and passing that straight through made every
      // agent run die on the first call with "model is required".
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

      const callModel = createModelAdapter({
        streamWithProvider,
        config,
        signal: abort.signal,
        request: {
          provider: activeProvider,
          model: effectiveModel,
          baseUrl: providerBaseUrl,
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
        // Sub-agents need their own registry. Without this factory the loop
        // never registers spawn_agents, so maxSubAgents was a no-op on every
        // real run even though the tier advertised it.
        makeRegistry: buildRegistry,
        signal: abort.signal,
        onEvent: (/** @type {any} */ event) => {
          if (event?.budget) record.budget = event.budget;
          send('progress', event);
          // Mirror the security-relevant events to disk. Fire and forget: the
          // auditor swallows its own failures so it can never sink a run.
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

      // Persist the run into the chat HERE rather than from the client. The
      // frontend used to POST the goal and the answer to a route that does not
      // exist, so every run's result lived only in the panel and vanished with
      // it. Doing it server-side also keeps the two messages atomic and honours
      // the clear-chats epoch guard.
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
