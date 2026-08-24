// @ts-check
// backend/src/agent/agentLoop.js
// The autonomous execution loop: plan, act, observe, validate, repair.
//
// Shape of a run:
//
//   plan ──> [ decide ──> act ──> observe ] * ──> validate ──┬─ pass ──> done
//              ^                                              │
//              └───────────── repair (with the critique) ─────┘
//
// Two properties matter more than anything else here.
//
// 1. The budget is checked in code before every iteration and every tool call.
//    The model is told what remains so it can triage, but it cannot vote on
//    whether to continue.
//
// 2. Running out of budget must still return the best available work. An agent
//    that spends an hour and then reports only "budget exhausted" has wasted the
//    hour. When the ceiling is hit mid-run the loop asks for a wrap-up using
//    what it already has, and says plainly what was left undone.

import { createBudget, STOP_REASONS, BudgetExhaustedError } from './budget.js';
import { parseAgentAction, protocolInstructions } from './protocol.js';
import { createSpawnTool } from './subAgents.js';

/** Rough token estimate when the caller cannot report real usage. */
const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

/** Keep the observation history from crowding out the goal. */
const MAX_OBSERVATION_CHARS = 4_000;
const MAX_HISTORY_STEPS = 30;

/** The salvage generation runs after the budget is spent, so it is capped hard. */
const WRAP_UP_TIMEOUT_MS = 60_000;

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
 */
export async function runAgent({
  goal, profile, registry, callModel, onEvent = () => {}, signal, systemPrompt = '', now, makeRegistry
}) {
  const budget = createBudget(profile, { signal, now });
  const emit = (type, payload = {}) => {
    try { onEvent({ type, at: budget.elapsed(), ...payload }); } catch { /* a sink must never break the run */ }
  };

  /** @type {Array<{step: number, thought: string, tool?: string, args?: object, observation: string}>} */
  const history = [];
  let plan = '';
  let finalAnswer = '';
  // The last summary a validator REJECTED. Kept apart from finalAnswer: if the
  // budget runs out mid-repair, the rejected text used to be returned verbatim
  // as the result with nothing saying a validator had refused it.
  let rejectedAnswer = '';
  let rejectedReason = '';
  /** @type {string|null} */
  let stopReason = null;

  const ask = async (messages, purpose, maxTokens) => {
    // Bound the call by what is actually left. The budget was only consulted at
    // loop boundaries, so a provider that accepted the connection and then
    // stalled could carry a run past its ceiling: measured at 2x on the 30
    // minute tier. The wrap-up runs on an already-spent budget, so it gets a
    // small fixed allowance rather than an open-ended one.
    const deadlineMs = purpose === 'wrap-up'
      ? WRAP_UP_TIMEOUT_MS
      : Math.max(1_000, budget.remaining().wallMs);
    const res = await callModel({ messages, purpose, maxTokens, timeoutMs: deadlineMs });
    const text = String(res?.text || '');
    budget.chargeTokens(res?.tokens ?? estimateTokens(text));
    return text;
  };

  // Fan-out is offered only when the tier grants sub-agents AND the caller
  // supplied a way to build a registry for them. Sub-agents are handed a profile
  // with maxSubAgents 0, so this is self-limiting to a single level.
  if (profile.maxSubAgents > 0 && typeof makeRegistry === 'function' && typeof registry.addTool === 'function') {
    registry.addTool('spawn_agents', createSpawnTool({
      budget, profile, makeRegistry, callModel, signal, now,
      onEvent: (/** @type {any} */ event) => emit(event.type || 'sub-agent', event)
    }));
  }

  const baseSystem = [
    systemPrompt,
    protocolInstructions(registry.describeForPrompt())
  ].filter(Boolean).join('\n\n');

  /** Render the run so far for the model. */
  const transcript = () => {
    const steps = history.slice(-MAX_HISTORY_STEPS);
    if (!steps.length) return 'No steps taken yet.';
    return steps.map((s) => {
      const call = s.tool ? `${s.tool}(${JSON.stringify(s.args).slice(0, 400)})` : '(no tool)';
      return `Step ${s.step}: ${s.thought}\n  called: ${call}\n  observed: ${s.observation}`;
    }).join('\n\n');
  };

  emit('run-start', { goal, effort: profile.id, budget: budget.snapshot(), policy: registry.policy });

  try {
    // ── plan ────────────────────────────────────────────────────────────────
    if (profile.plan) {
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

    // ── act / observe, with validation and repair ───────────────────────────
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
        // Feed the parse error back as an observation. It still costs an
        // iteration, so a model that cannot follow the format degrades into
        // termination instead of spinning forever.
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
        const verdict = await ask([
          { role: 'system', content: 'You verify work strictly. You are not the author and you are not being helpful to them.' },
          {
            role: 'user',
            content: [
              `Goal:\n${goal}`,
              `\nWork performed:\n${transcript()}`,
              `\nProposed result:\n${finalAnswer}`,
              '',
              'Does the result actually achieve the goal, based on the evidence above?',
              'Claims that no tool result supports do not count as achieved.',
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
          // Out of repair attempts: keep the answer but be honest about it.
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

      // ── tool call ─────────────────────────────────────────────────────────
      let charged = true;
      try {
        budget.chargeToolCall();
      } catch (err) {
        if (err instanceof BudgetExhaustedError) { charged = false; stopReason = err.reason; }
        else throw err;
      }
      if (!charged) break;

      emit('tool-call', { iteration, tool: action.tool, args: action.args, mutating: registry.isMutating(action.tool) });
      const result = await registry.dispatch(action.tool, action.args);
      const observation = result.ok
        ? JSON.stringify(result.result).slice(0, MAX_OBSERVATION_CHARS)
        : `ERROR: ${result.error}`;
      emit('tool-result', { iteration, tool: action.tool, ok: result.ok, observation: observation.slice(0, 600) });

      history.push({ step: iteration, thought: action.thought, tool: action.tool, args: action.args, observation });
      repairNote = '';
    }

    // ── wrap up ─────────────────────────────────────────────────────────────
    // Budget ran out mid-run: salvage the work rather than reporting a bare
    // failure. This is the difference between "your hour produced nothing" and
    // "here is what I established, and here is what is left".
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
