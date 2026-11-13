// @ts-check
// spawn_agents tool: parallel sub-agents with fresh contexts that share the
// parent's budget. Depth is capped at one; sub-agents get no spawn tool.

import { BASE_URL_PROVIDERS, REMOTE_PROVIDERS, classifyProviderScope } from '../providerScope.js';
import { runAgent } from './agentLoop.js';

/** Never hand a sub-agent less than this; below it they cannot do anything useful. */
const MIN_SUB_ITERATIONS = 3;
const MIN_SUB_TOOL_CALLS = 5;
const MIN_SUB_TOKENS = 2_000;
const MIN_SUB_WALL_MS = 30_000;
/** Sub-agents share this much of what remains; the parent keeps the rest to merge. */
const SUB_SHARE = 0.7;
/** Answer room split across one fan-out, so the parent sees every result whole. */
const FANOUT_ANSWER_CHARS = 8_000;
const FANOUT_GOAL_CHARS = 200;
const MAX_DEFERRED_LISTED = 8;
/** The parent reads a fan-out whole, so its JSON is fitted to this, never cut. */
const MAX_FANOUT_RESULT_CHARS = 16_000;
const MAX_FANOUT_CONCURRENCY = 8;

// Sub-agents share one local engine and Ollama serialises per model, so more in
// flight only adds memory pressure. Engines that serve requests side by side get
// more; see fanoutConcurrencyFor.
const DEFAULT_FANOUT_CONCURRENCY = 2;
const PARALLEL_FANOUT_CONCURRENCY = 8;

/** MIRABILIS_AGENT_FANOUT_CONCURRENCY, or null when it is unset or not a number. */
function envConcurrency() {
  const raw = Number(process.env.MIRABILIS_AGENT_FANOUT_CONCURRENCY);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(Math.floor(raw), MAX_FANOUT_CONCURRENCY);
  return null;
}

function fanoutConcurrency() {
  return envConcurrency() ?? DEFAULT_FANOUT_CONCURRENCY;
}

/**
 * Sub-agents generating at once for a run on this provider. A single local engine
 * queues requests; cloud APIs and vLLM serve them side by side. The env var, when
 * set, applies to every provider.
 * @param {string} [provider]
 * @param {string} [baseUrl]
 */
export function fanoutConcurrencyFor(provider, baseUrl) {
  const env = envConcurrency();
  if (env != null) return env;
  const id = String(provider || '');
  if (REMOTE_PROVIDERS.has(id) || id === 'vllm') return PARALLEL_FANOUT_CONCURRENCY;
  // llama.cpp serves one request per model like Ollama, wherever it runs.
  if (BASE_URL_PROVIDERS.has(id) && id !== 'llamacpp' && classifyProviderScope(id, baseUrl).offDevice) {
    return PARALLEL_FANOUT_CONCURRENCY;
  }
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
 * @param {(p: Promise<any>) => Promise<any>} [args.pause]  The parent's pause: a sub-agent waiting
 *        on an approval stops the parent's clock as well as its own.
 * @param {number} [args.concurrency]   Sub-agents in flight; the route picks it per provider.
 * @param {string} [args.systemPrompt]  Host context for every sub-agent: where it runs, what it may do.
 * @param {string} [args.parentGoal]    The whole goal, so each agent knows what its part belongs to.
 * @param {Map<string, number>} [args.claims]  Files a sub-agent is changing in the current fan-out,
 *        by path; shared with the registries, which refuse a second writer.
 */
export function createSpawnTool({
  budget, profile, makeRegistry, callModel, onEvent = () => {}, signal, now, pause,
  concurrency, systemPrompt = '', parentGoal = '', claims
}) {
  // Numbers run on across fan-outs, so each agent keeps one name for the whole run.
  let nextAgent = 0;

  return {
    kind: 'internal',
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

      const limit = Math.min(MAX_FANOUT_CONCURRENCY, Math.max(1, Math.floor(Number(concurrency) || fanoutConcurrency())));
      // Start only the agents the remaining budget can fund at the floors below, so
      // the floors can never add up to more than the parent has left.
      const room = budget.remaining();
      const fundable = Math.min(
        Math.floor((room.iterations * SUB_SHARE) / MIN_SUB_ITERATIONS),
        Math.floor((room.toolCalls * SUB_SHARE) / MIN_SUB_TOOL_CALLS),
        Math.floor((room.outputTokens * SUB_SHARE) / MIN_SUB_TOKENS),
        Math.floor((room.wallMs * SUB_SHARE) / MIN_SUB_WALL_MS) * limit
      );
      if (fundable < 2) {
        return { spawned: 0, error: 'Not enough budget left for sub-agents. Continue the work yourself.' };
      }
      const granted = budget.chargeSubAgents(Math.min(list.length, fundable));
      if (granted === 0) {
        return { spawned: 0, error: 'No sub-agent capacity remains at this effort level. Continue the work yourself.' };
      }
      const running = list.slice(0, granted);
      const deferred = list.slice(granted);
      const base = nextAgent;
      nextAgent += running.length;

      // Split 70% of what remains, keeping the rest for the parent to merge the results.
      // Agents in one wave run side by side, so each wave, not each agent, gets a time share.
      const waves = Math.ceil(running.length / limit);
      const share = (/** @type {number} */ total, /** @type {number} */ floor) => (
        Math.max(floor, Math.floor((total * SUB_SHARE) / running.length))
      );
      /** @type {import('./effortProfiles.js').EffortProfile} */
      const childProfile = {
        ...profile,
        maxWallMs: Math.max(MIN_SUB_WALL_MS, Math.floor((room.wallMs * SUB_SHARE) / waves)),
        maxIterations: share(room.iterations, MIN_SUB_ITERATIONS),
        maxToolCalls: share(room.toolCalls, MIN_SUB_TOOL_CALLS),
        maxOutputTokens: share(room.outputTokens, MIN_SUB_TOKENS),
        // Depth cap: no grandchildren, and no split inside a part.
        maxSubAgents: 0,
        // A sub-task is scoped and short; planning it again is overhead.
        plan: false,
        maxRepairAttempts: Math.min(1, profile.maxRepairAttempts)
      };

      const answerChars = Math.max(300, Math.floor(FANOUT_ANSWER_CHARS / running.length));
      /** Where it runs, its part of the whole, and how long its report may be. No chat context. */
      const promptFor = (/** @type {number} */ i) => {
        const others = running.filter((_, j) => j !== i).map((t) => t.goal.slice(0, 120)).join('; ');
        return [
          systemPrompt,
          `You are agent ${i + 1} of ${running.length}, each on one part of a larger goal. Do only your part.`,
          parentGoal ? `The larger goal: ${String(parentGoal).slice(0, 500)}` : '',
          running.length > 1 ? `Other agents are doing: ${others}` : '',
          `Finish with a report under ${answerChars} characters: the result, the evidence and anything still open.`
        ].filter(Boolean).join('\n\n');
      };

      onEvent({
        type: 'fanout-start', count: running.length, deferred: deferred.length, concurrency: limit,
        childProfile: {
          maxIterations: childProfile.maxIterations,
          maxToolCalls: childProfile.maxToolCalls,
          maxWallMs: childProfile.maxWallMs
        },
        agents: running.map((t, i) => ({ subAgent: base + i, goal: t.goal.slice(0, FANOUT_GOAL_CHARS) })),
        budget: budget.snapshot()
      });

      const jobs = running.map((task, i) => async () => {
        const subAgent = base + i;
        try {
          const outcome = await runAgent({
            goal: task.goal,
            profile: childProfile,
            registry: makeRegistry(),
            callModel,
            signal,
            now,
            outerPause: pause,
            subAgent,
            systemPrompt: promptFor(i),
            onEvent: (event) => onEvent({ ...event, subAgent, subGoal: task.goal.slice(0, FANOUT_GOAL_CHARS) })
          });
          return { goal: task.goal, outcome };
        } catch (error) {
          return { goal: task.goal, outcome: null, error: String(error?.message || error) };
        }
      });
      // Claims hold for one fan-out: agents of the next one may change any file.
      claims?.clear();
      const settled = await mapWithLimit(jobs, limit).finally(() => claims?.clear());

      // Charge child spend to the parent on every axis so delegation cannot escape the ceiling.
      let spentTokens = 0;
      let spentToolCalls = 0;
      let spentIterations = 0;
      for (const s of settled) {
        const b = s.outcome?.budget;
        if (!b) continue;
        spentTokens += b.outputTokens || 0;
        spentToolCalls += b.toolCalls || 0;
        spentIterations += b.iterations || 0;
      }
      budget.chargeChildSpend({ outputTokens: spentTokens, toolCalls: spentToolCalls, iterations: spentIterations });

      onEvent({
        type: 'fanout-end', count: settled.length, spentTokens, spentToolCalls, spentIterations,
        budget: budget.snapshot()
      });

      // JSON escapes outgrow the text: a quote or a newline takes two characters, a control
      // character six. So the result is fitted by its JSON length, never cut: goals and the
      // deferred list get at most half the room, and the answers share the rest.
      const answerOf = (/** @type {any} */ s) => String(s.outcome?.answer || s.error || '(no result)');
      const build = (/** @type {number} */ chars, /** @type {number} */ listed, /** @type {number} */ goalChars) => ({
        spawned: settled.length,
        deferred: deferred.slice(0, listed).map((t) => t.goal.slice(0, goalChars)),
        spent: { tokens: spentTokens, toolCalls: spentToolCalls, iterations: spentIterations },
        results: settled.map((s) => ({
          goal: s.goal.slice(0, goalChars),
          ok: Boolean(s.outcome?.ok),
          validated: Boolean(s.outcome?.validated),
          stopReason: s.outcome?.stopReason || 'failed',
          steps: s.outcome?.steps || 0,
          answer: answerOf(s).slice(0, chars)
        }))
      });
      const size = (/** @type {object} */ r) => JSON.stringify(r).length;
      let listed = Math.min(deferred.length, MAX_DEFERRED_LISTED);
      let goalChars = FANOUT_GOAL_CHARS;
      while (size(build(0, listed, goalChars)) > MAX_FANOUT_RESULT_CHARS / 2 && (listed > 0 || goalChars > 0)) {
        if (listed > 0) listed -= 1;
        else goalChars = Math.floor(goalChars / 2);
      }
      let chars = Math.min(answerChars, Math.max(0, ...settled.map((s) => answerOf(s).length)));
      let result = build(chars, listed, goalChars);
      for (let n = size(result); n > MAX_FANOUT_RESULT_CHARS && chars > 0; n = size(result)) {
        chars = Math.floor(chars * Math.min(0.9, MAX_FANOUT_RESULT_CHARS / n));
        result = build(chars, listed, goalChars);
      }
      return result;
    }
  };
}
