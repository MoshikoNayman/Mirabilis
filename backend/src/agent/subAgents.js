// @ts-check
// backend/src/agent/subAgents.js
// Parallel sub-agents, as a tool the parent can call.
//
// Fan-out is worth it when a goal splits into parts that do not need to see each
// other's work: audit four subsystems, research five options, check a change
// against three lenses. Each sub-agent gets its own clean context, which is the
// real win. A single agent doing all four sequentially drags the first
// subsystem's noise through the other three.
//
// Two rules keep this from becoming a budget bomb:
//
// 1. Sub-agents SHARE the parent's budget. They receive a slice of what actually
//    remains, and everything they spend is charged back to the parent. A run
//    cannot buy itself more time by delegating.
// 2. Depth is capped at one. Sub-agents get no spawn tool of their own, so there
//    is no tree, only a single fan-out. Recursive delegation is where these
//    systems quietly turn one hour into sixteen.

import { runAgent } from './agentLoop.js';

/** Never hand a sub-agent less than this; below it they cannot do anything useful. */
const MIN_SUB_ITERATIONS = 3;
const MIN_SUB_TOOL_CALLS = 5;

// How many sub-agents may be mid-generation at once.
//
// Deliberately small. Sub-agents share ONE local engine, so firing six at it
// does not make them six times faster: Ollama serialises requests per model, so
// they queue anyway, while the machine holds six live contexts and six open
// sockets. On a 16 GB laptop running a 12B model that is how you turn a working
// session into swap. Raise MIRABILIS_AGENT_FANOUT_CONCURRENCY only when the
// engine is genuinely able to serve requests in parallel (a real vLLM box).
const DEFAULT_FANOUT_CONCURRENCY = 2;

function fanoutConcurrency() {
  const raw = Number(process.env.MIRABILIS_AGENT_FANOUT_CONCURRENCY);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(Math.floor(raw), 8);
  return DEFAULT_FANOUT_CONCURRENCY;
}

/**
 * Run `jobs` with at most `limit` in flight. Order of results matches input.
 * Every job settles: one failure never cancels the rest.
 * @param {Array<() => Promise<any>>} jobs
 * @param {number} limit
 */
async function mapWithLimit(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      results[index] = await jobs[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Build the spawn_agents tool for a parent run.
 * @param {object} args
 * @param {any} args.budget          Parent budget; sub-agent spend is charged here.
 * @param {import('./effortProfiles.js').EffortProfile} args.profile
 * @param {() => any} args.makeRegistry   Fresh tool registry per sub-agent.
 * @param {(req: {messages: Array<{role:string,content:string}>, maxTokens?: number, purpose: string, timeoutMs?: number}) => Promise<{text: string, tokens?: number}>} args.callModel
 * @param {(event: object) => void} [args.onEvent]
 * @param {AbortSignal} [args.signal]
 * @param {() => number} [args.now]
 */
export function createSpawnTool({ budget, profile, makeRegistry, callModel, onEvent = () => {}, signal, now }) {
  return {
    needs: 'read-only',
    description:
      'Run several independent sub-tasks in parallel, each with its own fresh context, and get their '
      + 'summaries back. Use this only for parts that do NOT depend on each other. They share your budget.',
    parameters: {
      tasks: 'array of { goal: string } - the independent sub-tasks (2 or more)'
    },
    async execute({ tasks }) {
      const list = (Array.isArray(tasks) ? tasks : [])
        .map((t) => (typeof t === 'string' ? { goal: t } : t))
        .filter((t) => t && typeof t.goal === 'string' && t.goal.trim())
        .map((t) => ({ goal: String(t.goal).trim() }));

      if (list.length < 2) {
        return {
          spawned: 0,
          error: 'spawn_agents needs at least 2 independent tasks. For a single task, just do it yourself.'
        };
      }

      const granted = budget.chargeSubAgents(list.length);
      if (granted === 0) {
        return { spawned: 0, error: 'No sub-agent capacity remains at this effort level. Continue the work yourself.' };
      }
      const running = list.slice(0, granted);
      const deferred = list.slice(granted);

      // Slice what is ACTUALLY left, not what the tier started with. Reserve a
      // share for the parent, which still has to synthesise the results.
      const remaining = budget.remaining();
      const share = (total) => Math.max(1, Math.floor((total * 0.7) / running.length));
      /** @type {import('./effortProfiles.js').EffortProfile} */
      const childProfile = {
        ...profile,
        maxWallMs: Math.max(30_000, share(remaining.wallMs)),
        maxIterations: Math.max(MIN_SUB_ITERATIONS, share(remaining.iterations)),
        maxToolCalls: Math.max(MIN_SUB_TOOL_CALLS, share(remaining.toolCalls)),
        maxOutputTokens: Math.max(2_000, share(remaining.outputTokens)),
        // Depth cap: no grandchildren.
        maxSubAgents: 0,
        // A sub-task is scoped and short; planning it again is overhead.
        plan: false,
        maxRepairAttempts: Math.min(1, profile.maxRepairAttempts)
      };

      onEvent({ type: 'fanout-start', count: running.length, deferred: deferred.length, concurrency: fanoutConcurrency(), childProfile: {
        maxIterations: childProfile.maxIterations,
        maxToolCalls: childProfile.maxToolCalls,
        maxWallMs: childProfile.maxWallMs
      } });

      const settled = await mapWithLimit(running.map((task, index) => async () => {
        try {
          const outcome = await runAgent({
            goal: task.goal,
            profile: childProfile,
            registry: makeRegistry(),
            callModel,
            signal,
            now,
            onEvent: (event) => onEvent({ ...event, subAgent: index, subGoal: task.goal })
          });
          return { index, goal: task.goal, outcome };
        } catch (error) {
          return { index, goal: task.goal, outcome: null, error: String(error?.message || error) };
        }
      }), fanoutConcurrency());

      // Charge the parent for everything the children spent, so delegation is
      // never a way to escape the ceiling.
      let spentTokens = 0;
      let spentToolCalls = 0;
      for (const s of settled) {
        const b = s.outcome?.budget;
        if (!b) continue;
        spentTokens += b.outputTokens || 0;
        spentToolCalls += b.toolCalls || 0;
      }
      budget.chargeTokens(spentTokens);
      for (let i = 0; i < spentToolCalls; i += 1) {
        try { budget.chargeToolCall(); } catch { break; } // parent ceiling reached
      }

      onEvent({ type: 'fanout-end', count: settled.length, spentTokens, spentToolCalls });

      return {
        spawned: settled.length,
        deferred: deferred.map((t) => t.goal),
        spent: { tokens: spentTokens, toolCalls: spentToolCalls },
        results: settled.map((s) => ({
          goal: s.goal,
          ok: Boolean(s.outcome?.ok),
          stopReason: s.outcome?.stopReason || 'failed',
          steps: s.outcome?.steps || 0,
          answer: (s.outcome?.answer || s.error || '(no result)').slice(0, 4_000)
        }))
      };
    }
  };
}
