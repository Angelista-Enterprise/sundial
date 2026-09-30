// The instruments: projections over what Gnomon already wrote — the ledger, setup, autonomy, trust,
// memory, the lab, calibration, habits, reach, the asks and the effect journal.
import { view } from './http.js'
import { readMemory } from './read-memory.js'
import { readAsks } from './read-asks.js'
import { readTrace } from './read-trace.js'
import { readHabits } from './read-habits.js'
import { readReach } from './read-reach.js'
import { readLab } from './read-lab.js'
import { readCalibration } from './read-calibration.js'
import { readLedger } from './read-ledger.js'
import { foldedScorecard } from '@sundial/kernel/read/scorecard.js'
import { capabilities, earnedBy, levelOf } from '@sundial/kernel/autonomy.js'
import { readSetup } from './read-setup.js'
import { readTrust } from './read-trust.js'

export function mountInstruments(ctx) {
  const instrument = (path, unavailable, read) => view(ctx, path, unavailable, read)

  view(ctx, '/gnomon/ledger', 'The ledger could not be read.', (url) => readLedger({ state: ctx.gnomonKernel.getState(), now: Date.now(), url }))

  // ── The instruments ─────────────────────────────────────────────────────
  // Five projections over data Gnomon has always written and nothing has ever
  // read back. The counts that motivated them, from one live 18-day database:
  // 182,385 signals, 29,922 applied effects, 2,784 moments, 2,760 embeddings,
  // 335 resolved predictions and 212 entity facts, against a UI that showed a
  // dial, four insight titles and the LLM ledger.
  //
  // Every one of them is a PROJECTION, in the same sense the Unsaid page is:
  // each reads the queries the rest of the system already decided with, and
  // recomputes nothing. A second implementation of "how good is the pipeline"
  // would drift from the pipeline the first time either changed, and a
  // transparency surface that can disagree with the thing it reports on is
  // worse than no surface at all.
  //
  // Nothing outside this plugin changes: no rule, no schema, no query. That is
  // the deliberate shape of the visibility pass — it cannot alter what Gnomon
  // believes, only what the owner can see of it.


  // Trust — is the machine actually working?
  //
  // The honest denominator first: `coverage.observedHours` counts the
  // `input:activity` emits seen per local hour, so it measures how long the
  // daemon was watching rather than how busy the owner was. Every other number
  // on this page is a claim ABOUT a day, and a claim over a 1.2-hour
  // observation is a statement about the daemon, not the owner.
  // Setup — the first-run page's one reading. Permissions from the sidecars'
  // own grant flags (null = the sensor has not reported yet, never a guess),
  // whether a model is configured (host and model only, never the key), and
  // how much the record holds, which is the proof that capture works.
  view(ctx, '/gnomon/setup', 'Setup could not be read.', () => readSetup({ state: ctx.gnomonKernel.getState(), now: Date.now() }))

  // W5 step 10: what each capability may do alone, the numbers that earn it, and the folded scorecard rows (the Settings card).
  instrument('/gnomon/autonomy', 'What Gnomon may do alone could not be read.', async () => {
    const state = ctx.gnomonKernel.getState()
    const level = (cap) => state?.autonomy?.levels?.[cap] ?? { level: levelOf(state, cap), earned: false, since: null }
    return {
      capabilities: capabilities(state).map((capability) => ({ capability, ...level(capability), ...earnedBy(state, capability), granted: state?.autonomy?.granted?.[capability] ?? null, lowered: state?.autonomy?.lowered?.[capability] ?? null })),
      scorecard: foldedScorecard(state, Date.now()),
    }
  })

  view(ctx, '/gnomon/trust', 'The instruments could not be read.', () => readTrust({ state: ctx.gnomonKernel.getState(), now: Date.now(), questions: ctx.gnomonKernel.questionCatalog?.() ?? [] }))

  // Memory — every name Gnomon holds a belief about, with the beliefs ON it.
  //
  // The `?entity=` branch is GONE, and its deletion is the shape of the card.
  // It fetched one entity's facts to replace the whole panel with them, which
  // is why the owner called this the hardest page to browse: the only way to
  // read a belief was to leave the list, and the only way back was a "← All"
  // button. The beliefs ride along now, so a row folds open in place and the
  // search below can look INSIDE them. Measured before deciding: 442 current
  // facts over 221 names, about 90KB — one read where there were 222.
  //
  // The supersede history went with it. It was queried on every open, sliced to
  // 120 rows, and never rendered; a belief the card no longer holds belongs on
  // the entity drill-down in explore (D-J/M), not here.
  view(ctx, '/gnomon/memory', 'Memory could not be read.', () => readMemory({ state: ctx.gnomonKernel.getState() }))

  // Calibration — the forecaster's own record.
  //
  // `predictions` holds one row per resolution and every row is already scored;
  // this bins them by claimed probability so the question "when it says 70%,
  // does it happen 70% of the time" can be answered by looking rather than
  // trusted. The Brier score comes from `tallyPredictions` rather than being
  // recomputed here, for the no-second-implementation reason above.
  // Lab — Gnomon's self-evolving state in one live pane: the experiments it has
  // scheduled for itself (wake-ups keyed `experiment-*`), the questions it is
  // holding open (research goals, with the cell's live evidence count), and
  // how its proposals and notices fared this week. A JOIN of records that
  // already exist — no new kind, nothing written. The shape is `LabReading`.
  view(ctx, '/gnomon/lab', 'The lab could not be read.', () => readLab({ state: ctx.gnomonKernel.getState(), now: Date.now() }))

  view(ctx, '/gnomon/calibration', 'The forecast record could not be read.', () => readCalibration({ state: ctx.gnomonKernel.getState(), now: Date.now() }))

  view(ctx, '/gnomon/habits', 'Habits could not be read.', () => readHabits({ state: ctx.gnomonKernel.getState(), now: Date.now() }))

  // Reach — what Gnomon can touch outside its own record, and on what terms.
  // The tool list is dsh's own registry (the same one the model sees) and the
  // read/write verdicts come from sundial-actions through `gnomonReach`, so this
  // page can never disagree with the gate about what asks and what does not.
  view(ctx, '/gnomon/reach', 'Reach could not be read.', () => readReach({ state: ctx.gnomonKernel.getState(), tools: ctx.tools, reach: ctx.gnomonReach }))

  // Every question Gnomon has put to the owner, and whether asking was worth it.
  //
  // **`ask_threads` is deliberately gone from this payload.** The audit read
  // the card as two objects on one surface — "asks (recorded questions) and
  // chat threads are different things sharing one card" — and the split is a
  // DELETION rather than a move: `ask_threads` is not the chat feed. The chat
  // feed is the dsh sessions the threads card reads (`/gnomon/api/sessions`);
  // `ask_threads` is the retired macOS Ask surface's Q&A log, whose event
  // (`ask:answered`) last fired on 2026-08-15, and its rule was retired in W6 P4
  // (nothing emitted to it). Moving 75 dead rows onto a live card
  // would be worse than leaving them where they are — the four the owner
  // promoted are in `knowledge_entries` and reachable by search, and the
  // other 71 are history with no reader, which is what they were.
  //
  // Three joins, all of them because a card that can only report `answered`
  // against `expired` says 47 of 48 and flatters the asker:
  //
  // 1. **The verdict the owner gave the QUESTION.** New this item: `owner_ask`
  //    is now a `feedback:verdict` artifact kind, so `useful` / `wrong` /
  //    `not-now` land exactly on "worth asking" / "wrong question" / "bad
  //    moment". Read from the LOG rather than `state.feedback.recent`, which
  //    keeps only the last 50 verdicts and would silently drop older ones out
  //    of a precision figure computed over the whole record.
  // 2. **What the answer BECAME.** A fact stores the event it came from, so
  //    the `ask:owner-answered` signal ids give the other direction: which
  //    answers were routed into memory. That is the B1 rule applied — a route
  //    the card cannot read back is a button that looks like it did nothing.
  // 3. **The answer's own event id**, handed to the client so the routing door
  //    can stamp what it writes and appear in join 2 on the next read.
  view(ctx, '/gnomon/asks', 'The asks could not be read.', () => readAsks({ state: ctx.gnomonKernel.getState(), now: Date.now() }))

  // The journal, whole — see `tracePanel` for what the card is for.
  //
  // Pinned to the whole journal rather than to the board's span, and the two
  // reasons are both measurements. `applied_effects` begins on 2026-09-17,
  // when the harness executor first ran, against a log that begins on
  // 2026-07-30: a board span of a month would draw twenty-five empty days.
  // And nothing prunes this table — `deleteRowsOlderThan` touches signals,
  // moments, llm_audit and orphaned embeddings and not this — so the journal's
  // span only ever grows, and the card says its own dates on its face rather
  // than implying the record's.
  //
  // The census is five grouped scans in SQLite. The previous route pulled 120
  // rows and called their COUNT a window in minutes; over 27k rows the same
  // shape would be 3MB of JSON to produce five numbers.
  view(ctx, '/gnomon/trace', 'The trace could not be read.', (url) => readTrace({ url }))
}
