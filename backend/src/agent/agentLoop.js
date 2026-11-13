// @ts-check
// Agent loop: plan, act, observe, validate, repair. Ultra also splits the goal and fans out
// in code. Code enforces the budget before every step; on exhaustion it still wraps up.

import { createBudget, STOP_REASONS, BudgetExhaustedError } from './budget.js';
import { parseAgentAction, parseSplit, protocolInstructions } from './protocol.js';
import { createSpawnTool } from './subAgents.js';

/** Rough token estimate when the caller cannot report real usage. */
const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

/** Keep the observation history from crowding out the goal. A fan-out fits its own result. */
const MAX_OBSERVATION_CHARS = 4_000;
const MAX_HISTORY_STEPS = 30;

/** The salvage generation runs after the budget is spent, so it is capped hard. */
const WRAP_UP_TIMEOUT_MS = 60_000;

/** Every check on an Ultra run, lead and agents alike, looks for a reason to fail first. */
const REFUTE_LINE = 'Try to refute it first: look for a counterexample, a missed requirement or a step that does not hold. '
  + 'Pass only if you find none.';

/** @typedef {{goal: string, answer: string}} AgentResult */

/**
 * The agents' results of a fan-out that ran, kept on its step; a refused one has none.
 * @param {any} result  what spawn_agents returned
 * @returns {AgentResult[]|undefined}
 */
const fanoutResults = (result) => (Array.isArray(result?.results) && result.results.length ? result.results : undefined);

/**
 * What the agents found, for a run that ends before the lead could merge it. No model call.
 * @param {Array<{results?: AgentResult[]}>} history
 */
function agentResultsSoFar(history) {
  const lines = history.flatMap((step) => (step.results || []).map((r) => `- ${r.goal}: ${r.answer}`));
  return lines.length ? ['[Stopped. Agent results so far:]', ...lines].join('\n') : '';
}

/**
 * @param {object} args
 * @param {string} args.goal                       What the user asked for.
 * @param {import('./effortProfiles.js').EffortProfile} args.profile
 * @param {any} args.registry  Tool registry from createToolRegistry().
 * @param {(req: {messages: Array<{role:string,content:string}>, maxTokens?: number, purpose: string, timeoutMs?: number}) => Promise<{text: string, tokens?: number}>} args.callModel
 * @param {(event: object) => void} [args.onEvent] Progress sink (SSE, logs).
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.systemPrompt]
 * @param {() => number} [args.now]                Injectable clock, for tests.
 * @param {() => any} [args.makeRegistry]          Fresh registry per sub-agent; enables fan-out.
 * @param {(p: Promise<any>) => Promise<any>} [args.outerPause]  A parent's pause, so a sub-agent
 *        waiting on the user stops the parent's clock too.
 * @param {number} [args.subAgent]                 This run's index when it is a sub-agent.
 * @param {number} [args.fanoutConcurrency]        Sub-agents in flight, chosen by the route per provider.
 * @param {string} [args.subAgentPrompt]           System prompt for sub-agents: host context, not the chat.
 */
export async function runAgent({
  goal, profile, registry, callModel, onEvent = () => {}, signal, systemPrompt = '', now, makeRegistry,
  outerPause, subAgent, fanoutConcurrency, subAgentPrompt = ''
}) {
  const budget = createBudget(profile, { signal, now });
  // The payload goes first, so type and this run's clock always win: a sub-agent's
  // events reach the parent's sink stamped with the parent's clock.
  const emit = (type, payload = {}) => {
    try { onEvent({ ...payload, type, at: budget.elapsed() }); } catch { /* a sink must never break the run */ }
  };
  /** Time spent waiting on an approval is not charged to this budget or any parent's. */
  const pause = (/** @type {Promise<any>} */ p) => budget.pauseWhile(outerPause ? outerPause(p) : p);

  /** @type {Array<{step: number, thought: string, tool?: string, args?: object, observation: string, results?: AgentResult[]}>} */
  const history = [];
  let plan = '';
  let finalAnswer = '';
  // Last summary the validator rejected. Kept apart from finalAnswer so a run that
  // ends mid-repair never returns it as if it had passed.
  let rejectedAnswer = '';
  let rejectedReason = '';
  /** @type {string|null} */
  let stopReason = null;

  const ask = async (messages, purpose, maxTokens) => {
    // Bound each call by the time left, so a stalled provider cannot carry the run
    // past its ceiling. The wrap-up runs on a spent budget and gets a fixed allowance.
    const deadlineMs = purpose === 'wrap-up'
      ? WRAP_UP_TIMEOUT_MS
      : Math.max(1_000, budget.remaining().wallMs);
    const res = await callModel({ messages, purpose, maxTokens, timeoutMs: deadlineMs });
    const text = String(res?.text || '');
    budget.chargeTokens(res?.tokens ?? estimateTokens(text));
    return text;
  };

  // Fan-out needs a tier with sub-agents and a registry factory. Sub-agents get
  // maxSubAgents 0, so nesting stops at one level. Ultra calls the tool itself, so it
  // is built even where the registry will not offer it to the model (Chat only).
  const spawnTool = profile.maxSubAgents > 0 && typeof makeRegistry === 'function'
    ? createSpawnTool({
      budget, profile, makeRegistry, callModel, signal, now, pause,
      parentGoal: goal,
      concurrency: fanoutConcurrency,
      systemPrompt: subAgentPrompt,
      claims: registry.runRules?.writeClaims,
      onEvent: (/** @type {any} */ event) => emit(event.type || 'sub-agent', event)
    })
    : null;
  if (spawnTool && typeof registry.addTool === 'function') registry.addTool('spawn_agents', spawnTool);

  // With no tools there is no tool evidence to ask for, so the check judges the reasoning.
  const toolless = typeof registry.names === 'function' && registry.names().length === 0;

  const baseSystem = [
    systemPrompt,
    protocolInstructions(registry.describeForPrompt())
  ].filter(Boolean).join('\n\n');

  /**
   * Render the run so far for the model. Agent results stay past the window: the lead merges
   * them. A refused fan-out has nothing to merge and goes with the window.
   */
  const transcript = () => {
    const pinned = history.slice(0, -MAX_HISTORY_STEPS).filter((s) => s.results?.length);
    const steps = [...pinned, ...history.slice(-MAX_HISTORY_STEPS)];
    if (!steps.length) return 'No steps taken yet.';
    return steps.map((s) => {
      const call = s.tool ? `${s.tool}(${JSON.stringify(s.args).slice(0, 400)})` : '(no tool)';
      return `Step ${s.step}: ${s.thought}\n  called: ${call}\n  observed: ${s.observation}`;
    }).join('\n\n');
  };

  emit('run-start', { goal, effort: profile.id, budget: budget.snapshot(), access: registry.level });

  try {
    // Ultra: split the goal and run one agent per part. The model only names the
    // parts; whether to fan out is decided here, not by the model.
    let planned = false;
    if (profile.ultra === true && spawnTool && budget.remaining().subAgents >= 2) {
      const room = budget.remaining().subAgents;
      emit('phase', { phase: 'split' });
      const agentTools = (typeof registry.names === 'function' ? registry.names() : [])
        .filter((/** @type {string} */ name) => name !== 'spawn_agents');
      /** @type {string[]} */
      let parts = [];
      try {
        const reply = await ask([
          { role: 'system', content: systemPrompt || 'You split work into independent parts.' },
          {
            role: 'user',
            content: [
              `Goal:\n${goal}`,
              '',
              `Tools each agent will have: ${agentTools.length ? agentTools.join(', ') : 'none'}`,
              '',
              `Split the goal into at most ${room} parts that separate agents can do at the same time.`,
              'Each agent sees only its part, so each part must name the files, facts and result it needs.',
              'Parts must not depend on each other or change the same files.',
              'If the goal is small or its steps depend on each other, return no parts.',
              'Reply with one JSON object: {"parts": ["...", "..."]}'
            ].join('\n')
          }
        ], 'split', Math.min(1_500, 300 + 150 * room));
        parts = parseSplit(reply, room);
      } catch (err) {
        // A failed split is not a failed run: the lead works alone instead.
        if (signal?.aborted) throw err;
      }
      emit('split', { count: parts.length });

      if (parts.length >= 2) {
        planned = true;
        plan = parts.map((part, i) => `${i + 1}. ${part}`).join('\n');
        emit('plan', { plan });

        // The same cost as a fan-out the model asks for. On a spent budget it is
        // skipped, and the loop's stop check ends the run with the usual wrap-up.
        /** @type {number|null} */
        let iteration = null;
        try {
          const next = budget.beginIteration();
          budget.chargeToolCall();
          iteration = next;
        } catch (err) {
          if (!(err instanceof BudgetExhaustedError)) throw err;
        }
        if (iteration !== null) {
          emit('iteration', { iteration, budget: budget.snapshot() });
          const args = { tasks: parts.map((part) => ({ goal: part })) };
          emit('tool-call', { iteration, tool: 'spawn_agents', args, mutating: false });
          /** @type {any} */
          let result;
          try {
            result = await spawnTool.execute(args);
          } catch (err) {
            result = { spawned: 0, error: String(err?.message || err) };
          }
          // Never cut: spawn_agents fits its own JSON, and a cut one would not parse.
          const observation = JSON.stringify(result);
          emit('tool-result', { iteration, tool: 'spawn_agents', ok: !result.error, observation: observation.slice(0, 600) });
          history.push({
            step: iteration,
            thought: result.spawned > 0
              ? `Split the goal into ${parts.length} parts and ran one agent per part. Next: check the results against `
                + 'each other and the goal, fix any part that failed or was not verified, then finish with one merged answer.'
              : 'No agents could start. Do the parts yourself, then finish with one answer.',
            tool: 'spawn_agents',
            args,
            observation,
            results: fanoutResults(result)
          });
        }
      }
    }

    // plan
    if (profile.plan && !planned) {
      emit('phase', { phase: 'plan' });
      plan = await ask([
        { role: 'system', content: systemPrompt || 'You plan work carefully and concretely.' },
        {
          role: 'user',
          content: [
            `Goal:\n${goal}`,
            '',
            `Tools you will have:\n${registry.describeForPrompt() || '(none)'}`,
            '',
            budget.describeRemaining(),
            '',
            'Write a short, concrete plan: the steps you will take and how you will know the goal is met.',
            'Plain prose, no JSON. Be specific about what "done" looks like.'
          ].join('\n')
        }
      ], 'plan', 1_000);
      emit('plan', { plan });
    }

    // act / observe, with validation and repair
    let repairNote = '';
    let validated = false;

    while (true) {
      const stop = budget.checkStop();
      if (stop) { stopReason = stop; break; }

      let iteration;
      try {
        iteration = budget.beginIteration();
      } catch (err) {
        if (err instanceof BudgetExhaustedError) { stopReason = err.reason; break; }
        throw err;
      }
      emit('iteration', { iteration, budget: budget.snapshot() });

      const decision = await ask([
        { role: 'system', content: baseSystem },
        {
          role: 'user',
          content: [
            `Goal:\n${goal}`,
            plan ? `\nYour plan:\n${plan}` : '',
            `\nWork so far:\n${transcript()}`,
            repairNote ? `\nA validation pass rejected your last attempt:\n${repairNote}\nAddress this specifically.` : '',
            `\n${budget.describeRemaining()}`,
            '\nReply with one JSON object: your next tool call, or finish.'
          ].filter(Boolean).join('\n')
        }
      ], 'decide', 1_500);

      const action = parseAgentAction(decision);

      if (action.kind === 'invalid') {
        // Feed the parse error back. It still costs an iteration, so a model that
        // cannot follow the format terminates instead of spinning.
        emit('invalid-action', { iteration, error: action.error });
        history.push({
          step: iteration,
          thought: '(unparseable reply)',
          observation: `Your reply was not valid: ${action.error} Reply with exactly one JSON object.`
        });
        continue;
      }

      if (action.kind === 'finish') {
        finalAnswer = action.summary;
        emit('finish-proposed', { iteration, summary: finalAnswer });

        if (!profile.validate) { stopReason = STOP_REASONS.COMPLETED; break; }

        emit('phase', { phase: 'validate' });
        // Without tools there is no evidence to show, and small models fail a
        // correct answer for an empty work log; they get the answer to judge instead.
        const noWork = toolless && !history.length;
        const verdict = await ask([
          { role: 'system', content: 'You verify work strictly. You are not the author and you are not being helpful to them.' },
          {
            role: 'user',
            content: [
              `Goal:\n${goal}`,
              ...(noWork ? [] : [`\nWork performed:\n${transcript()}`]),
              `\nProposed result:\n${finalAnswer}`,
              '',
              toolless
                ? 'Is the proposed result correct and complete for the goal?'
                : 'Does the result actually achieve the goal, based on the evidence above?',
              toolless
                ? 'This run has no tools, so judge the reasoning itself: check each step and the final claim. Missing evidence alone is no reason to fail it.'
                : 'Claims that no tool result supports do not count as achieved.',
              ...(profile.ultra ? [REFUTE_LINE] : []),
              'Reply with one JSON object: {"pass": true|false, "reason": "...", "missing": "what remains"}'
            ].join('\n')
          }
        ], 'validate', 800);

        let passed = true;
        let reason = '';
        const parsedVerdict = parseAgentAction(verdict);
        // The verdict rides the same tolerant JSON extraction.
        try {
          const m = verdict.match(/\{[\s\S]*\}/);
          const v = m ? JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')) : null;
          if (v && typeof v.pass === 'boolean') {
            passed = v.pass;
            reason = String(v.reason || v.missing || '');
          }
        } catch { /* unreadable verdict: do not block completion on it */ }
        void parsedVerdict;

        emit('validation', { iteration, passed, reason });

        if (passed) { validated = true; stopReason = STOP_REASONS.COMPLETED; break; }

        if (!budget.chargeRepair()) {
          // Out of repair attempts: keep the answer, flagged as unvalidated.
          stopReason = STOP_REASONS.COMPLETED;
          finalAnswer += `\n\n[Validation did not pass and no repair attempts remain. Outstanding: ${reason || 'unspecified'}]`;
          break;
        }
        repairNote = reason || 'The result did not clearly achieve the goal.';
        rejectedAnswer = finalAnswer;
        rejectedReason = repairNote;
        finalAnswer = '';
        emit('repair', { iteration, reason: repairNote, remaining: budget.remaining().repairs });
        continue;
      }

      // tool call
      let charged = true;
      try {
        budget.chargeToolCall();
      } catch (err) {
        if (err instanceof BudgetExhaustedError) { charged = false; stopReason = err.reason; }
        else throw err;
      }
      if (!charged) break;

      emit('tool-call', { iteration, tool: action.tool, args: action.args, mutating: registry.isMutating(action.tool) });
      const result = await registry.dispatch(action.tool, action.args, { pause, iteration, subAgent });
      // A fan-out fits its own JSON; every other result is cut to the usual cap.
      const fanout = action.tool === 'spawn_agents' && result.ok;
      const observation = result.ok
        ? (fanout ? JSON.stringify(result.result) : JSON.stringify(result.result).slice(0, MAX_OBSERVATION_CHARS))
        : `ERROR: ${result.error}`;
      emit('tool-result', { iteration, tool: action.tool, ok: result.ok, observation: observation.slice(0, 600) });

      history.push({
        step: iteration, thought: action.thought, tool: action.tool, args: action.args, observation,
        results: fanout ? fanoutResults(result.result) : undefined
      });
      repairNote = '';
    }

    // wrap up
    // Budget ran out mid-run: salvage the work instead of reporting a bare failure.
    const ranOut = stopReason && stopReason !== STOP_REASONS.COMPLETED && stopReason !== STOP_REASONS.CANCELLED;

    // Stopped while repairing a rejected answer: hand it back only with the
    // rejection attached, never as though it had passed.
    if (!finalAnswer && rejectedAnswer) {
      finalAnswer = `${rejectedAnswer}\n\n[This result did NOT pass validation and the run ended before it could be fixed. `
        + `Reason: ${rejectedReason}]`;
      validated = false;
    }

    if (ranOut && !finalAnswer) {
      emit('phase', { phase: 'wrap-up', reason: stopReason });
      finalAnswer = await ask([
        { role: 'system', content: systemPrompt || 'You report results honestly and concisely.' },
        {
          role: 'user',
          content: [
            `Goal:\n${goal}`,
            `\nWork completed before the budget ran out:\n${transcript()}`,
            `\nThe run stopped because: ${stopReason}.`,
            '',
            'Report the most useful result you can from the work actually done.',
            'State plainly what was established, what was not, and the single best next step.',
            'Do not claim anything the observations do not support. Plain prose, no JSON.'
          ].join('\n')
        }
      ], 'wrap-up', 2_000).catch(() => '');
    }
    // Stopped, or the wrap-up failed, with no answer: hand back what the agents found.
    if (!finalAnswer && stopReason !== STOP_REASONS.COMPLETED) finalAnswer = agentResultsSoFar(history);
    if (ranOut && finalAnswer && !/budget/i.test(finalAnswer)) {
      finalAnswer += `\n\n[Stopped early: ${stopReason}. ${history.length} step(s) completed.]`;
    }

    if (!stopReason) stopReason = STOP_REASONS.COMPLETED;
    budget.finish(stopReason);

    const outcome = {
      ok: stopReason === STOP_REASONS.COMPLETED,
      stopReason,
      goal,
      plan,
      answer: finalAnswer,
      validated,
      steps: history.length,
      history,
      budget: budget.snapshot()
    };
    emit('run-end', { stopReason, validated, steps: history.length, budget: outcome.budget });
    return outcome;
  } catch (error) {
    budget.finish(STOP_REASONS.FAILED);
    // A stop, an engine error or Go Dark after a fan-out still keeps what the agents found.
    if (!finalAnswer) finalAnswer = agentResultsSoFar(history);
    emit('run-error', { error: String(error?.message || error), budget: budget.snapshot() });
    return {
      ok: false,
      stopReason: STOP_REASONS.FAILED,
      goal,
      plan,
      answer: finalAnswer,
      validated: false,
      steps: history.length,
      history,
      error: String(error?.message || error),
      budget: budget.snapshot()
    };
  }
}
