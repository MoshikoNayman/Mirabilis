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
import { getFsRoot, safeResolvePath } from './sandbox.js';

/** Live runs, so a client that reconnects can still stop one. */
const runs = new Map();

/** Keep finished runs briefly so a client can collect the result after a drop. */
const FINISHED_TTL_MS = 10 * 60_000;

/**
 * @param {object} deps
 * @param {{aiProvider?:string, [k:string]:any}} deps.config
 * @param {Function} deps.streamWithProvider
 * @param {Function} deps.getEffectiveModel  Resolves 'auto'/absent into a real model id.
 * @param {{getChat: Function, saveChat: Function, getEpoch: Function, chatStorePath: string, nowIso: Function, uuid: Function}} [deps.chats]
 *        Optional chat persistence. When supplied and the caller passes a chatId,
 *        the run's goal and result are written into that chat.
 * @param {Function} [deps.guard]  Privileged-route guard, applied to every route here.
 */
export function createAgentRouter({ config, streamWithProvider, getEffectiveModel, chats, guard }) {
  const router = Router();
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

  router.get('/runs', (_req, res) => {
    res.json({
      runs: [...runs.values()].map((r) => ({
        id: r.id, goal: r.goal, effort: r.effort, status: r.status,
        startedAt: r.startedAt, budget: r.budget || null
      }))
    });
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
    }
    res.json({ ok: true, id: run.id, status: run.status, alreadyFinished: !live });
  });

  // Start a run and stream its progress. The response is SSE for the same reason
  // the chat route is: the interesting part is what happens over the next hour,
  // not the final byte.
  router.post('/runs', async (req, res) => {
    const {
      goal, effort = 'high', provider, model, providerBaseUrl, providerApiKey,
      toolPolicy = 'read-only', fsRoot, workDir, systemPrompt, localOnly, overrides, chatId
    } = req.body || {};

    if (!goal || typeof goal !== 'string' || !goal.trim()) {
      res.status(400).json({ error: 'goal is required' });
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

    send('run-accepted', { id, effort: profile.id, policy: toolPolicy, limits: profile });

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
          apiKey: providerApiKey
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
        }
      });

      record.status = outcome.ok ? 'completed' : String(outcome.stopReason || 'stopped');
      record.budget = outcome.budget;

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

      send('result', { ...outcome, persistedTo });
    } catch (error) {
      record.status = 'failed';
      send('error', { error: String(error?.message || error) });
    } finally {
      res.end();
      setTimeout(() => runs.delete(id), FINISHED_TTL_MS).unref?.();
    }
  });

  return router;
}
