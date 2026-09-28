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
// Semantics mirror ask.ts + runToolLoop's `beforeCall` seam, per ROUND TRIP:
//   - check the LIVE `state.budgets.byPurpose.ask.callsToday` against the
//     resolved daily cap BEFORE the provider is contacted; when exhausted (or
//     state is null — kernel shutting down), short-circuit by yielding an
//     error finish chunk and never calling next(). The chunk order contract
//     (usage before finish, nothing after finish) is trivially satisfied: the
//     stream is one finish chunk.
//   - after next() completes, append ONE `llm:dispatched { purpose: 'ask' }`
//     signal via gnomonKernel.appendSignal — the exact event the daemon's
//     `recordLlmDispatch` ingested — so `budget-track` (the only writer of
//     `state.budgets`) folds the spend and kernel budget state stays the
//     single source of truth. The usage chunk's TokenUsage rides along in the
//     payload for the record; budget-track reads only `purpose`.
//
// Spend is recorded in a `finally`, so an errored or aborted stream still
// counts: the provider call happened, which is what a runaway-loop backstop
// meters. Recording after (not before, as ask.ts did) keeps the guard from
// spending a slot on a request the short-circuit path never sent; the
// check-then-record gap between two concurrent turns can overshoot the cap
// by at most the number of in-flight calls, which a backstop tolerates.
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

export const ASK_PURPOSE = 'ask';

/** Stable machine code on the short-circuit finish, for surfaces that want to say why. */
export const BUDGET_EXHAUSTED_CODE = 'GNOMON_ASK_BUDGET_EXHAUSTED';

/**
 * Build the waterfall listener.
 *
 * @param options.getState live kernel state (gnomonKernel.getState), null before boot / during shutdown
 * @param options.getDailyCap (purpose) => number, from resolveDailyCaps(config.budgets)
 * @param options.appendSignal gnomonKernel.appendSignal — serialized ingest → reduce → effects
 * @param options.recordAudit optional `begin(options)` from createLlmAuditRecorder; omitted = no ledger row
 * @returns an async-generator listener for `ctx.on('llm/stream', …)`
 */
export function createAskBudgetGuard({ getState, getDailyCap, appendSignal, recordAudit }) {
  return async function* askBudgetGuard(options, next) {
    const state = getState();
    const cap = getDailyCap(ASK_PURPOSE);
    const spent = state?.budgets?.byPurpose?.[ASK_PURPOSE]?.callsToday;

    // Uncapped (`Infinity`, the default since 2026-08-15) never blocks — not on
    // a spend total, and not on missing budget state during boot/shutdown. The
    // guard degrades to a pure meter: it still records the spend below when
    // state is live, and simply proceeds when it is not. A finite cap set via
    // config.budgets.ask restores the old backstop, including the null-state
    // refusal, because a caller who asked for a cap wants it enforced strictly.
    const capped = Number.isFinite(cap);
    if (capped && (state === null || state === undefined || typeof spent !== 'number' || spent >= cap)) {
      const detail =
        state === null || state === undefined || typeof spent !== 'number'
          ? 'the Gnomon kernel has no live budget state (booting or shutting down)'
          : `daily LLM budget for '${ASK_PURPOSE}' already used (${spent}/${cap})`;
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: `Gnomon: ${detail} — try again later.`, code: BUDGET_EXHAUSTED_CODE } },
      };
      return;
    }

    // Opened AFTER the short-circuit and BEFORE next(): a call the cap
    // refused was never dispatched and has nothing to record, while a call
    // that dies mid-stream must already be on the record when it does.
    const audit = recordAudit ? await recordAudit(options) : null;

    let usage;
    let thrown;
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage;
        audit?.observe(chunk);
        yield chunk;
      }
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      // The recorder swallows its own write failures, so this cannot mask the
      // stream's outcome any more than the spend append below can.
      await audit?.settle(thrown);
      // The one durable spend record. Failure to append must not mask the
      // stream's own outcome (or lack of one), so it is contained here.
      try {
        await appendSignal('llm:dispatched', { purpose: ASK_PURPOSE, ...(usage !== undefined ? { usage } : {}) });
      } catch (error) {
        console.error('[sundial-tools] failed to record ask budget spend:', error);
      }
    }
  };
}
