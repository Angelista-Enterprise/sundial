# Deploying new code to the live install

The live install runs the checkout `~/Projects/sundial` (main) through `$SUNDIAL_HOME/app.env`. A merge to main does not change the running process. A build does: dsh imports `dist/`, so the next start of the process runs whatever `tsc` wrote last.

## The rule: deploy only through a clean restart

1. Merge to main.
2. In the main checkout: `pnpm install` if `pnpm-lock.yaml` changed, then `npx tsc -b tsconfig.json`.
3. `sundial restart`.
4. Read the boot line in `$SUNDIAL_HOME/logs/sundial.log`: `[sundial-kernel] boot replay: snapshot offset …, tail N signal(s)`. After a clean restart, N is 0, or a few `judgement:*` / `llm:*` signals: a model answer that was in flight during the shutdown is logged after the final snapshot, and the next boot folds it like any new event. A larger N, or other kinds of signal in it, means the last stop was not clean.

A shifted journal row whose own effect already completed at another index of the same event is skipped, not run again (`effectCompletedElsewhere`).

Do not deploy over a crash. If the process stopped without a clean shutdown (it was killed, the Mac lost power), first start the OLD code once, let it replay its own tail, stop it cleanly, and then deploy.

## Why

The effect journal (`applied_effects`) names each effect by the event it came from and its **position** in the list the fold returned for that event: `(event_id, effect_index)`. Boot replays every event after the last snapshot, and for each effect asks the journal if it already ran (`replayDecision` in `packages/harness-runtime/src/runtime.ts`).

New code that adds, removes or reorders a rule in `RULE_MANIFEST`, or changes the effects a rule returns, changes that list for the same event. Position 3 can now be a different effect. Then:

- the journal says "completed" for an effect that never ran, and it is skipped;
- the journal says nothing for an effect that did run, and it runs again (a second notice, a second LLM call, a second write).

A clean stop (`sundial stop` or `restart`, SIGTERM, logout) drains the event lane and writes a last snapshot at the last event (`KernelRuntime.shutdown`). The next boot replays nothing, so the journal is never asked about old events under new code.

A crash leaves a tail of up to about one minute of events (a snapshot is written on every `clock:tick`). Under new code, the effects of those events can be skipped or repeated.
