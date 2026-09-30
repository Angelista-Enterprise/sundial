// The 'ask' budget guard and ledger writer: an `llm/stream` waterfall listener.
//
// Every dsh model call — agent conversation turns, and nothing else — flows
// through the `llm/stream` waterfall (`Events['llm/stream'](options, next)`).
// The kernel's own effect LLM calls (companion, reflect, extract, journal,
// refute, goal, intent) do NOT pass here: they go through
// `@sundial/llm`'s audited transport with their own per-purpose budget checks
// inside KernelRuntime's dispatchers. So this hook meters exactly what the
// daemon's /ask route metered — conversation — and cannot double-count an
// effect call.
//
// Semantics, per ROUND TRIP (W3):
//   - reserve the call BEFORE the provider is contacted, through
//     gnomonKernel.reserveLlmCall: one step of the kernel's serialized lane
//     that checks the LIVE `state.budgets.byPurpose.ask.callsToday` against the
//     cap and folds `llm:dispatched { purpose: 'ask', callId, caller }`, so
//     `budget-track` (the only writer of `state.budgets`) holds the spend and N
//     parallel streams at a finite cap overshoot it by nothing. A refused
//     reservation short-circuits with one error finish chunk and next() is
//     never called.
//   - the reservation's `callId` is the id of the call's `llm_audit` row, so
//     the spend and the ledger row join.
//
// An errored or aborted stream still counts: the provider was contacted, which
// is what a runaway-loop backstop meters. (Until W3 the spend was appended
// after the stream, in a `finally`, and concurrent turns could overshoot by
// the number in flight.)
//
// The guard is ALSO the chat half of the ledger (`recordAudit`, see audit.js).
// A counter is not a ledger: `llm:dispatched` folds into `state.budgets` and
// says a call happened, while `llm_audit` — the table the Ledger page and
// every telemetry readout project — says which model answered, what it cost,
// how long it took, and whether it worked. The kernel's effect calls write
// that row through `@sundial/llm`; dsh's calls go adapter-direct and reach the
// table only here. Both live in this one listener because they are the same
// fact recorded twice for two different readers, and because the waterfall
// gives exactly one seam that sees every dsh call whole: the request before
// dispatch, every chunk, and the end however it comes. The recorder is
// optional so the guard keeps working (and stays testable) without a database.
//
// Named exports only.

import { TURN_IDLE_MS } from '@sundial/helpers/vocab.js';
import { auditPurpose } from './audit.js';

export const ASK_PURPOSE = 'ask';

/** Stable machine code on the short-circuit finish, for surfaces that want to say why. */
export const BUDGET_EXHAUSTED_CODE = 'GNOMON_ASK_BUDGET_EXHAUSTED';

/** A chat call that sends nothing for this long (a stream that hung after a tool result) is ended as timed out; half the turn watchdog, so the turn ends with a reason before the client is closed as quiet. */
export const STREAM_IDLE_MS = TURN_IDLE_MS / 2;
export const STREAM_IDLE_CODE = 'GNOMON_STREAM_IDLE';

/** W5: the chat's model route has its breaker open (10 failures in a row): the turn ends at once instead of hanging. */
export const BREAKER_OPEN_CODE = 'GNOMON_ROUTE_BREAKER_OPEN';

/**
 * Build the waterfall listener.
 *
 * @param options.getState live kernel state (gnomonKernel.getState), null before boot / during shutdown
 * @param options.getDailyCap (purpose) => number, the cap the kernel enforces
 * @param options.reserve gnomonKernel.reserveLlmCall — (purpose, { caller }) => callId, or null when refused
 * @param options.recordAudit optional `begin(options, id)` from createLlmAuditRecorder; omitted = no ledger row
 * @returns an async-generator listener for `ctx.on('llm/stream', …)`
 */
export function createAskBudgetGuard({ getState, getDailyCap, reserve, recordAudit }) {
  return async function* askBudgetGuard(options, next) {
    const state = getState();
    const cap = getDailyCap(ASK_PURPOSE);

    // Uncapped (`Infinity`, the default since 2026-08-15) never blocks — not on
    // a spend total, and not on missing budget state during boot/shutdown. The
    // guard degrades to a pure meter: it still reserves (records the spend)
    // when state is live, and simply proceeds when it is not. A finite cap set
    // via config.budgets.ask restores the backstop, including the null-state
    // refusal, because a caller who asked for a cap wants it enforced strictly.
    const capped = Number.isFinite(cap);
    const refuse = (detail, code = BUDGET_EXHAUSTED_CODE) => ({
      type: 'finish',
      reason: { kind: 'error', failure: { message: `Gnomon: ${detail} — try again later.`, code } },
    });
    if (capped && (state === null || state === undefined)) {
      yield refuse('the Gnomon kernel has no live budget state (booting or shutting down)');
      return;
    }
    const route = options?.provider;
    // `sessionId`: dsh stamps it on every loop-built call, so a thread delete can take its ledger rows (W1).
    const sessionId = options?.sessionId ? String(options.sessionId) : null;
    const callId = state ? await reserve(ASK_PURPOSE, { caller: `chat:${auditPurpose(options)}`, ...(route ? { route } : {}), ...(sessionId ? { sessionId } : {}) }) : null;
    // W5: refused because the route's breaker is open — say so, whatever the cap.
    const openUntil = route ? getState()?.reliability?.llm?.[route]?.openUntil : null;
    if (callId === null && openUntil && Date.parse(openUntil) > Date.now()) {
      const at = new Date(openUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      yield refuse(`the model route '${route}' failed ${getState()?.reliability?.llm?.[route]?.streak ?? 10} calls in a row, so calls to it are paused; it tries again at ${at}`, BREAKER_OPEN_CODE);
      return;
    }
    if (capped && callId === null) {
      yield refuse(`daily LLM budget for '${ASK_PURPOSE}' already used (${getState()?.budgets?.byPurpose?.[ASK_PURPOSE]?.callsToday ?? '?'}/${cap})`);
      return;
    }

    // Opened AFTER the reservation and BEFORE next(): a call the cap refused
    // was never dispatched and has nothing to record, while a call that dies
    // mid-stream must already be on the record when it does.
    const audit = recordAudit ? await recordAudit(options, callId ?? undefined) : null;

    let thrown;
    const chunks = next()[Symbol.asyncIterator]();
    try {
      for (;;) {
        let timer;
        const idle = new Promise((resolve) => (timer = setTimeout(() => resolve(null), STREAM_IDLE_MS)));
        const step = await Promise.race([chunks.next(), idle]).finally(() => clearTimeout(timer));
        if (step === null) {
          // Settled as a failed (timeout) row through the finish it observes; the provider's stream is let go, not awaited.
          void chunks.return?.()?.catch?.(() => {});
          const chunk = { type: 'finish', reason: { kind: 'error', failure: { name: 'TimeoutError', message: `Gnomon: the model sent nothing for ${STREAM_IDLE_MS / 1000} s, so this call timed out — say it again, or pick another model.`, code: STREAM_IDLE_CODE } } };
          audit?.observe(chunk);
          yield chunk;
          return;
        }
        if (step.done) break;
        audit?.observe(step.value);
        yield step.value;
      }
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      // The recorder swallows its own write failures, so this cannot mask the
      // stream's outcome.
      await audit?.settle(thrown);
    }
  };
}
