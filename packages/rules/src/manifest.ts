import type { KernelState, Rule } from '@sundial/kernel/types.js';
import { anomalyZscore } from './anomaly-zscore.js';
import { applyLlmResult } from './apply-llm-result.js';
import { judgementTrack } from './judgement-track.js';
import { verifyLine } from './verify-line.js';
import { applyMomentJudgement } from './apply-moment-judgement.js';
import { applyOwnerReply, listenToReply } from './listen-to-reply.js';
import { applyGateFeatures, gateFeaturesJudge } from './gate-features-log.js';
import { coverageTrack } from './coverage-track.js';
import { expectationLearn } from './expectation-learn.js';
import { expectationWatch } from './expectation-watch.js';
import { noticeGate } from './notice-gate.js';
// lane D
import { noticeRoute } from './notice-route.js';
import { askTrack } from './ask-track.js';
import { routineLearn } from './routine-learn.js';
import { assistantTrack } from './assistant-track.js';
import { budgetTrack } from './budget-track.js';
import { clockTick } from './clock-tick.js';
import { observedTrack } from './observed-track.js';
import { contextUrlClassify } from './context-url-classify.js';
import { contradictionCheck } from './contradiction-check.js';
import { dailyJournal } from './daily-journal.js';
import { dayShapeForecast } from './day-shape-forecast.js';
import { hourFragmentedForecast } from './hour-fragmented-forecast.js';
import { projectTouchForecast } from './project-touch-forecast.js';
import { forecastTournament } from './forecast-tournament.js';
import { embeddingIndex } from './embedding-index.js';
import { commitmentTrack } from './commitment-track.js';
import { promiseTrack } from './promise-track.js';
import { entityExtract } from './entity-extract.js';
import { factConfidenceDecay } from './fact-confidence-decay.js';
import { feedbackTrack } from './feedback-track.js';
import { solicitFeedback } from './solicit-feedback.js';
import { wakeupTrack } from './wakeup-track.js';
import { askHarvest, askHarvestBackfill } from './ask-harvest.js';
import { ownerAsk } from './owner-ask.js';
import { agentSessionTrack } from './agent-session-track.js';
import { agentFleetTrack } from './agent-fleet-track.js';
import { ticketTrack } from './ticket-track.js';
import { watchRules } from './watch-rules.js';
import { focusModeTrack } from './focus-mode-track.js';
import { idleTrack } from './idle-track.js';
import { returnFromBreak } from './return-from-break.js';
import { bigCommit } from './life-event/big-commit.js';
import { contextSwitch } from './life-event/context-switch.js';
import { deploy } from './life-event/deploy.js';
import { focusFlow } from './life-event/focus-flow.js';
import { interruption } from './life-event/interruption.js';
import { testRecovery } from './life-event/test-recovery.js';
import { thrashing } from './life-event/thrashing.js';
import { endogenousReflection } from './endogenous-reflection.js';
import { memoryDecay } from './memory-decay.js';
import { mindTrack } from './mind-track.js';
// lane C
import { driftTrack } from './drift-track.js';
import { factTestTrack } from './fact-test-track.js';
import { applyWorldHygiene, worldHygiene } from './world-hygiene.js';
import { memoryPriorities } from './memory-priorities.js';
import { memoryReflection } from './memory-reflection.js';
import { momentAnalysisSchedule } from './moment-analysis-schedule.js';
import { transcriptAccept, transcriptClean } from './transcript-clean.js';
import { momentClose } from './moment-close.js';
import { hearingWindow } from './hearing-window.js';
import { boardTrack } from './board-track.js';
import { settingsTrack } from './settings-track.js';
import { momentRollup } from './moment-rollup.js';
import { fileWatcherCapacity } from './file-watcher-capacity.js';
import { networkTrack } from './network-track.js';
import { nightlyFactExtract } from './nightly-fact-extract.js';
import { conversationFactExtract } from './conversation-fact-extract.js';
import { nightlyRefutation } from './nightly-refutation.js';
import { applyFactAudit, nightlyBeliefAudit } from './nightly-belief-audit.js';
import { applyAliasAlignment, nightlyAliasAlignment } from './alias-alignment.js';
import { powerTrack } from './power-track.js';
import { fileTrack } from './file-track.js';
import { shellFailureTrack } from './shell-failure-track.js';
import { pressureTrack } from './pressure-track.js';
import { gitAheadTrack } from './git-ahead-track.js';
import { callSpanTrack } from './call-span-track.js';
import { browserTrack } from './browser-track.js';
import { screenTrack } from './screen-track.js';
import { presenceTrack } from './presence-track.js';
import { phoneTrack } from './phone-track.js';
import { projectRuleRegister } from './project-rule-register.js';
import { projectTrack } from './project-track.js';
import { retentionPrune } from './retention-prune.js';
import { scheduleTrack } from './schedule-track.js';
import { surpriseDrive } from './surprise-drive.js';
import { uncertaintyMap } from './uncertainty-map.js';
import { researchGoals } from './research-goals.js';
import { workbench } from './workbench.js';
// lane E (#12)
import { nightShift } from './night-shift.js';
import { meetingFollowup } from './meeting-followup.js';
import { peopleAsk } from './people-ask.js';
import { identityResolve } from './identity-resolve.js';
import { goalCheckin, goalProgressTrack } from './goal-checkin.js';
import { ingestAnomalyCheck } from './ingest-anomaly.js';
import { ownerPerceive } from './owner-perceive.js';
import { healthTrack } from './health-track.js';
import { vaultTrack } from './vault-track.js';
import { mailTrack } from './mail-track.js';
import { draftTrack } from './draft-track.js';
import { goalPursuit } from './goal-pursuit.js';
import { windowTrack } from './window-track.js';
import { attributionPropose } from './attribution-propose.js';
// lane B
import { briefClock } from './brief-clock.js';
import { mailMatters } from './mail-matters.js';
// lane H
import { sensorHealth } from './sensor-health.js';

/**
 * Fixed fold order (decision #1, docs/design/00-overview.md). Phase 3 Wave
 * 3a adds `windowTrack` (fills a pre-existing gap: nothing wrote
 * `state.window` before this) and `projectTrack` (reacts to
 * `project:detected`, Wave 3a's new `project` sensor).
 *
 * Wave 3e adds `contextUrlClassify` (the document-context/search-query
 * merge) and the life-event rules. `contextSwitch` MUST run BEFORE
 * `momentClose` — it reads `state.moment` as the about-to-be-closed moment
 * to detect a cross-moment project change; once `momentClose` runs for the
 * same `window:changed` event, `state.moment` is already the newly reopened
 * one. `thrashing`/`focusFlow` run after `momentClose` so their payloads
 * can reference the freshly-reopened moment's id.
 *
 * Phase 4 adds `applyLlmResult` (reacts to a different event type,
 * `llm:result`, so it has no ordering dependency on the others) and, at the
 * time, a separate `intentSchedule`/`narrateOnClose` pair (same "runs before
 * momentClose" requirement as `contextSwitch`) — B2 later merged that pair
 * into the single `momentAnalysisSchedule` below.
 *
 * Phase 5 adds `anomalyZscore` (same "runs before momentClose" requirement —
 * it reads the about-to-close moment's duration against its rolling
 * baseline), plus `retentionPrune` (reacts to `day:boundary`), which shares no
 * event type with `momentClose` so has no ordering constraint. `companionInsight`
 * (an `anomaly:detected` → "X minutes in Chrome, well above usual for 16:00"
 * notice) was retired 2026-09-07: twenty-seven candidates in a month, one
 * marked useful. The z-score still feeds `surpriseDrive`.
 *
 * Phase 6 adds `entityExtract`/`embeddingIndex` (same "runs before
 * momentClose" requirement — both read the about-to-close `state.moment`)
 * and `contradictionCheck` (reacts to `entity:fact-candidate`, a synthetic
 * event `entityExtract` emits and which gets its own full recursive
 * `reduce()` pass via the executor's `EmitEvent` handling — so its position
 * relative to `entityExtract` in this array doesn't affect correctness,
 * only readability; kept adjacent to match the design doc's order).
 *
 * Phase 6b adds `memoryReflection` and `memoryDecay`, both reacting to
 * `day:boundary` like `retentionPrune` — no ordering constraint between the
 * three (each computes its own effect from `event.ts`/its own state slice,
 * none reads another's output within the same fold pass).
 *
 * A3 (docs/audit/production-proposal-and-enhancements.md) adds `budgetTrack`
 * (reacts to `llm:dispatched`, the executor's synthetic pre-call event) — no
 * ordering constraint with anything else, since nothing else reads or
 * writes `state.budgets.byPurpose`.
 *
 * B1/B3 add `idleTrack` (reacts to `input:activity`, emits `idle:start`/
 * `idle:end` — synthetic events `momentClose` reacts to in their own later
 * `EmitEvent` pass, same non-dependency as `entityExtract`/
 * `contradictionCheck` above) and grow `momentClose` itself to also react to
 * `idle:start`/`idle:end`/`clock:tick`, not just `window:changed` — see its
 * doc comment for the real-segmentation rules this implements.
 *
 * B2 replaces `intentSchedule`/`narrateOnClose` with `momentAnalysisSchedule`
 * (same "runs before momentClose" requirement as the pair it replaces) — one
 * rule, one merged `ScheduleLLM` effect instead of two.
 *
 * B4 adds `momentRollup` (accumulates onto the open moment's rollup from its
 * own triggers — shell/git/calendar/input activity, derived life-events) —
 * no ordering constraint with anything, since it never reads "the
 * about-to-close moment" on a shared trigger the way the `window:changed`
 * cluster above does; it just writes into whatever moment is open when its
 * own event types fire.
 *
 * C1 adds three single-purpose state-slice writers — `focusModeTrack`
 * (`focus-mode:changed` → `state.focusMode`), `powerTrack` (`system:power`
 * → `state.power`), `networkTrack` (`location:network` → `state.network`) —
 * each reacting to an event type no other rule touches, so none has an
 * ordering constraint with anything else. `momentRollup` itself grows three
 * more branches (`git:status`, `media:usage`, `symbol:edited`) plus five
 * more `lifeEvents` member types (`git:push`/`git:pr-status`/`calendar:
 * context-event`/`audio:device-changed`/`clipboard:activity`) — same file,
 * same non-dependency, no new manifest entry needed for those. `momentClose`
 * grows a fifth trigger, `system:sleep-wake` (sleep = gap, wake = reopen).
 */
/**
 * A rule behind one of `config.experiments`' switches: with the switch off it
 * folds nothing and returns no effects. Keeps the rule's own name, which
 * `reduce()` uses to attribute effects.
 */
function flagged(flag: 'forecasting' | 'gateFeatures' | 'presence', rule: Rule): Rule {
  const gated: Rule = (state: KernelState, event) => (state.config.experiments?.[flag] === true ? rule(state, event) : { state, effects: [] });
  Object.defineProperty(gated, 'name', { value: rule.name });
  return gated;
}

export const RULE_MANIFEST: Rule[] = [
  // First, and order-independent of everything after it: it only writes
  // `state.observed`, which nothing else reads during a fold. It is the memory the
  // daemon's ingest gate consults on the NEXT event, so it must record whatever
  // got past the gate on this one.
  observedTrack,
  clockTick,
  budgetTrack,
  // Before every consumer of coverage, and it has no other constraint: it counts
  // `input:activity` emits into `state.coverage.observedHours` and reads nothing.
  // Placed high because `expectationWatch` multiplies its confidence by this, and a
  // tick that asked about an absence before the hour it spans was counted would
  // under-report coverage by one bucket.
  coverageTrack,
  // J3.7: the anomaly check at the door. Before `momentAnalysisSchedule`, which
  // reads `state.ingestAnomaly.marked` to keep a marked title out of the
  // fan-out and the render. Also folds its own `judgement:result`.
  ingestAnomalyCheck,
  contextSwitch,
  momentAnalysisSchedule,
  // Beside the analysis, for the same reason and under the same ordering rule:
  // both read the closing moment's rollup before `momentClose` replaces it.
  transcriptClean,
  transcriptAccept,
  anomalyZscore,
  // The Phase 2b forward-model pair (`predictionResolve`/`predictionForecast`,
  // kind `project-continuity`) sat here and was retired on 2026-07-29 — it
  // forecast the base rate from its own hit rate, which is a fixed point, and
  // measured 0.2% skill over 2,362 resolutions. `forward-model.ts` keeps the
  // shared calibration helpers and records the full argument; `dayShapeForecast`
  // below is now the only forecaster, which is deliberate rather than a gap.
  entityExtract,
  // The commitment ledger. Beside `entityExtract` and under the same ordering
  // constraint — both read the about-to-close `state.moment` for its git
  // branch, so both must fold before `momentClose`. They derive the same task
  // name from it: `entityExtract` mints the ENTITY, this tracks the THREAD.
  commitmentTrack,
  // UC1: the promise ledger — its own list in `state.commitments`, its own
  // events (`meeting:promises`, `commitment:heard`) and the evidence that keeps
  // a promise. Reads nothing another rule writes on the same event.
  // lane B: `mailMatters` goes first, so it reads a promise before this mail can close it.
  mailMatters,
  promiseTrack,
  contradictionCheck,
  embeddingIndex,
  // Decides which screen-capture lines are content, so `momentRollup` (next)
  // can read `state.screen.kept` for the same event.
  screenTrack,
  momentRollup,
  // Decides whether ambient hearing is awake. Reads calendar and media state
  // and writes only its own field, so it has no ordering constraint with
  // anything else in the fold.
  hearingWindow,
  // The board is a slice nothing else reads and no other rule writes; its
  // events (`board:*`) are touched by nothing else. No ordering constraint.
  // Before anything that reads `state.settings` — the gate asks it whether it
  // may speak at all, so a settings change must be in force for the same tick.
  settingsTrack,
  boardTrack,
  momentClose,
  windowTrack,
  // Reads the attribution `windowTrack` just resolved for the NEW window, so it
  // must follow it: it times the unattributed ones by host/app.
  attributionPropose,
  projectTrack,
  // Before focusModeTrack and after projectTrack: it writes only its own slice,
  // but `resolveAttribution`'s agent tier reads it. `windowTrack` resolves a
  // window and sits above it; that holds only because the two never fire on the
  // same event (`agent:session` vs `window:changed`).
  agentSessionTrack,
  // The whole fleet of agent sessions, and the nudge when one waits on an owner who is elsewhere.
  agentFleetTrack,
  // One thread per ticket key, from every sense that can see one.
  ticketTrack,
  focusModeTrack,
  powerTrack,
  networkTrack,
  // Fold wave one (2026-09-04): five streams that were logged and never read.
  // Each writes one slice and reads no other rule's output, so they sit with
  // the other single-purpose trackers.
  fileTrack,
  // J3.5: the vault's notes edited today. Own event type; reads nothing else.
  vaultTrack,
  // J3.6: mail and message subjects/senders. Own event types.
  mailTrack,
  shellFailureTrack,
  pressureTrack,
  gitAheadTrack,
  callSpanTrack,
  browserTrack,
  // enhancements/presence-as-absence-ground-truth. Shares `location:network`
  // with `networkTrack` directly above and has no ordering dependency on it:
  // the two write different slices (`state.presence` vs `state.network`) from
  // the same payload, and neither reads the other's. Its two other triggers
  // (`presence:consent`, `presence:scan`) are touched by no other rule.
  flagged('presence', presenceTrack),
  // aspiration A01 (account for my whole day): folds the paired phone's `phone:*`
  // reports into `state.coverage`. Its event types are touched by no other rule,
  // so it has no ordering constraint.
  phoneTrack,
  // J3.1: the phone's health readings → `state.owner.energy`. Its own event types.
  healthTrack,
  fileWatcherCapacity,
  scheduleTrack,
  contextUrlClassify,
  projectRuleRegister,
  deploy,
  bigCommit,
  testRecovery,
  interruption,
  focusFlow,
  // MUST run immediately BEFORE `idleTrack`. It reads the pre-transition
  // `state.lifeEvent.idle` (isIdle + consecutiveZeroWindows) on the very
  // `input:activity` event that ends a break — `idleTrack` resets that count to zero
  // and flips isIdle off on the same event, so a rule folded after it can no longer
  // see how long the break was. A pure producer: it only emits a `notice:candidate`,
  // never touches state. See its doc comment.
  returnFromBreak,
  idleTrack,
  thrashing,
  // J2.1: the owner-state filter. After `idleTrack` (it skips the judge while
  // idle) and after `contextSwitch` (it counts `lifeEvent.recentSwitches`);
  // reads `input:activity`, `clock:tick`, its own `judgement:result` and the
  // owner's `owner:self-report`. Writes only `state.owner`.
  ownerPerceive,
  applyLlmResult,
  // Jev's answers (docs/jarvis/02): reacts to `judgement:result` and
  // `judgement:degraded`, two event types no other rule touches. Before
  // `feedbackTrack`, which reads the `judgement.recent` ring it writes — a
  // verdict and the answers it grades never share one event, so this is for
  // readability, not necessity.
  judgementTrack,
  // J1.1: the `intent` line's judge. Reacts to `llm:result` (only the intent
  // renders that carry evidence, which `applyLlmResult` now leaves alone unless
  // judging is off), `judgement:result` and `judgement:failed` for its own set.
  // Disjoint from `applyLlmResult` by condition, so order between them is free.
  verifyLine,
  // J1.2 (option A): the fan-out's answers onto the moment row. Reacts to
  // `judgement:result` for its own set only; disjoint from `verifyLine`.
  applyMomentJudgement,
  // J2.7: folds the `goal:progress` the rule above emits (its own event type,
  // folded on the executor's recursive pass) into `state.goals.progress`.
  goalProgressTrack,
  // J1.5: acts on the judged reply — AttachTranscript, a goal status
  // assertion, a knowledge entry. Own set only; disjoint from the two above.
  applyOwnerReply,
  // J2.3: the belief audit's answers — one RetractFact at `is_false ≥ θ`, on
  // the fact id the executor put in the metadata. Own set only.
  applyFactAudit,
  // J2.4: the judge's alias answers as Trust suggestions. Own set only.
  applyAliasAlignment,
  // J4.3: drafts and their judge. Own event types plus its own set's result.
  draftTrack,
  // J1.6: gate features, logged not used. `gateFeaturesJudge` reads
  // `notice:candidate` beside `noticeGate` (which decides on the same event,
  // unchanged); `applyGateFeatures` files the answers beside the decision row.
  flagged('gateFeatures', gateFeaturesJudge),
  flagged('gateFeatures', applyGateFeatures),
  retentionPrune,
  // feedbackTrack (decisions/assistant-as-an-event-source): reacts to `feedback:verdict`, an
  // event type no other rule touches, so it has no ordering constraint at all.
  feedbackTrack,
  // The asking half of the same loop: reacts only to `clock:tick`, opens/expires
  // one rating request in `state.feedback.solicitation`. Reads `feedback.recent`
  // and `memory.recentInsights`; no other rule writes those on a tick, so it has
  // no ordering constraint. After `feedbackTrack` for readability, not necessity.
  solicitFeedback,
  // Ask's own record: reacts to `ask:answered`/`ask:remembered`, two event
  // types no other rule touches — same non-dependency as `feedbackTrack`, and
  // beside it because both fold a deliberate act of the owner's rather than an
  // observation of them.
  askTrack,
  // Scheduled wake-ups. Folds `wakeup:scheduled`/`wakeup:cancelled` — two event
  // types nothing else reacts to — and fires due ones on `clock:tick` as an
  // ordinary `notice:candidate`, which the executor's recursive EmitEvent pass
  // folds like any producer's. So it has no ordering constraint either, and
  // sits beside the three above for the same reason: it records a deliberate
  // act of the owner's rather than an observation of them.
  wakeupTrack,
  // The other direction of asking: `solicitFeedback` above asks the owner to
  // RATE something, `askTrack` records what the owner asked, and this records
  // what GNOMON asked. Folds `ask:owner-opened`/`ask:owner-answered`, two more
  // event types nothing else touches, and expires an ignored question on
  // `clock:tick`. Beside its siblings for the same reason; no ordering
  // constraint.
  // J1.5: hears the owner's answer BEFORE `ownerAsk` closes the open question
  // on the same event — it needs `open` (the ask's ts matches the meeting's
  // `askedAt`, and its id says whether goals were listed). Emits a `Judge`.
  listenToReply,
  // H2: reads the question off `state.ownerAsk.open` on the same event, for the
  // same reason `listenToReply` does and under the same ordering requirement —
  // `ownerAsk` sets `open` to null a line below. Emits one `extract` call whose
  // reading is filed BESIDE the ask, never as a fact.
  askHarvest,
  // H4: the same reading for the answers that predate the rule. Rides
  // `clock:tick` and ends on its own; no ordering constraint, since it folds
  // two event types nothing else touches.
  askHarvestBackfill,
  ownerAsk,
  // decisions/assistant-as-an-event-source, write half: folds `assistant:proposal`
  // /`assistant:response`/`assistant:claim`. Same non-dependency as the two above —
  // three event types nothing else reacts to — and beside them for the same reason:
  // all three fold a deliberate act rather than an observation. Its `claim` branch
  // emits an ordinary `entity:fact-candidate`, so it needs no position relative to
  // `contradictionCheck`; the candidate is folded on the next event like any other.
  assistantTrack,
  // Procedural memory. Reacts to `window:changed` and writes only `state.routines`,
  // which nothing else touches, so it has no ordering constraint — and unlike every
  // other `window:changed` reader it does NOT care whether the moment is closing,
  // because a routine is a sequence of steps rather than a property of a moment.
  routineLearn,
  // Phase 1 endogenous-life (docs/design/08 §3): surpriseDrive accumulates
  // anomaly surprise into the drive; memoryReflection (daily) and
  // endogenousReflection (drive-triggered, clock:tick) consume it;
  // mindTrack derives the readouts LAST so it sees the post-consumption drive.
  surpriseDrive,
  memoryReflection,
  endogenousReflection,
  // The forward model's only remaining forecaster (`day-ending`,
  // hour-conditioned — the one measured to actually carry skill, +46.1%).
  // Reacts to `input:activity`/`day:boundary`.
  //
  // It MUST sit AFTER `memoryReflection`, which is the non-obvious part.
  // `memoryReflection` also fires on `day:boundary` and resets
  // `accumulatedImportance` to 0; placed before it, this rule's resolution
  // surprise was added and then discarded inside the same fold, so the one
  // signal a day-ending resolution produces never reached mood, reflection,
  // or any other consumer. The retired `predictionResolve` never hit this
  // because it only fired on `window:changed`, which `memoryReflection`
  // ignores — so this hazard arrived with this rule and stays with it.
  flagged('forecasting', dayShapeForecast),
  // The forward model's SECOND forecaster (`hour-fragmented`, conditioned on
  // whether the previous hour came apart — +13.7% measured, and stable across
  // three corpus cutoffs). Reacts to `event:context-switch`/`day:boundary`.
  //
  // Placed here for the same non-obvious reason `dayShapeForecast` is: it also
  // resolves on `day:boundary` and adds to `accumulatedImportance`, so before
  // `memoryReflection` its surprise would be added and discarded inside one
  // fold. Adjacent to the other forecaster so the ordering constraint they share
  // is visible as one block rather than rediscovered per rule.
  //
  // Independent of `dayShapeForecast` despite the adjacency: different event
  // types, different slices of `state.predictions` (`fragmentation` vs
  // `dayShape`/`hourlyDoneRate`/`conditioned`), and only `open[]`,
  // `calibration` and `recentResolved` in common — all three keyed by kind.
  flagged('forecasting', hourFragmentedForecast),
  // The third forecaster: will this project be touched at all today? Measured
  // at +12.9% / +14.5% / +14.5% across three cutoffs on the "which project"
  // feature (`measure-forecast-skill.ts` Q5). Same `day:boundary` /
  // `accumulatedImportance` placement reason as its two neighbours. Reads
  // `window.attribution`, which `windowTrack` (far above) has already
  // recomputed for this event, and its own `predictions.projectTouch` only.
  flagged('forecasting', projectTouchForecast),
  // J2.2: the forecast tournament — two forecasters per case on three targets,
  // resolved from the log, retired by Brier. AFTER `hourFragmentedForecast`, and
  // deliberately so: it twins that rule's bet when it appears in `open` and
  // resolves the twin off the resolution that rule has just pushed onto
  // `recentResolved` in the same event. Reads `meetings.seen`, `project.lastClosedMoment`
  // (its tally of a close — so also after `momentClose`), and its own
  // `predictions.tournament`; writes only `predictions`.
  flagged('forecasting', forecastTournament),
  // The inward half of the same loop: after a resolution has moved
  // `hourlyDoneRate`, rank the cells the forecaster is least settled on. Reads
  // that table, so it must follow `dayShapeForecast`; writes only `mind.gaps`,
  // and spreads `state.mind` the same way `mindTrack` does, so the two compose.
  flagged('forecasting', uncertaintyMap),
  // The one rule that CHOOSES rather than reacts. Reads the map `uncertaintyMap`
  // just wrote and commits to a single cell as a question of its own, then
  // watches that cell until the evidence moves. Immediately after its source on
  // purpose: reading a stale map would open a goal against last hour's worst
  // cell. Emits a `self-report` candidate on closing — the first producer for
  // that shape, which the taxonomy declared and nothing had ever filled.
  flagged('forecasting', researchGoals),
  // The work loop: one self-chosen job at a time while the owner is away; its
  // results are shelf entries. Reads commitments, schedule, memory — all folded
  // above it — and writes only its own slice.
  // J5.3: goal pursuit. BEFORE `workbench`: it reads `workbench.open` on
  // `work:shelved` / `work:closed` for the job's goal step, which `workbench`
  // clears on the same event. Its plan effect runs on the Monday boundary.
  goalPursuit,
  workbench,
  // lane E (#12): the night shift. After `agentFleetTrack` (it reads the fleet
  // a sample just wrote) and next to `workbench`, whose `ownerIsAway` it shares.
  nightShift,
  // The meeting loop's other half and the weekly goal check-in: both only
  // EMIT `ask:owner-opened`, which the ownerAsk rule folds on a later event.
  meetingFollowup,
  // Try the machine's own address sources before interrupting the owner. MUST
  // stay immediately BEFORE `peopleAsk`, and that order is the invariant rather
  // than a preference: both react to `clock:tick` and both act on the same
  // unnamed aliases, so whichever runs first decides whether a hash is resolved
  // in silence or put to the one party who cannot read a hash. Seven
  // unanswerable questions reached the owner on 2026-09-09 because this rule did
  // not exist. It writes only `people.resolvedAt` and emits one effect, so it
  // cannot starve `peopleAsk` — the aliases git and the vault cannot match are
  // still there on the next tick for the asking half to pick up.
  identityResolve,
  // Who the hashed attendees are: the LAST resort, one question per day, and
  // only for a meeting with exactly one unnamed attendee. Folds
  // `ask:owner-answered` for its own asks and emits a `knownAs` fact candidate.
  peopleAsk,
  goalCheckin,
  memoryPriorities,
  nightlyFactExtract,
  conversationFactExtract,
  // The adversarial counterpart: extraction grows core memory, this tries to
  // shrink it. Beside its opposite so the pair is readable as one policy, and
  // after it because a fact proposed tonight should not be put up for
  // refutation in the same fold it was proposed in.
  nightlyRefutation,
  // J2.3: the belief audit — every live inferred fact to the judge once a
  // night (and once on the first tick after it shipped). Same job as the
  // skeptic above, different instrument: Jev flags a malformed belief (subject
  // and object swapped, a room as a person) with no false alarms; it cannot
  // see a plausible misattribution, which is why `applyFactAudit` (with the
  // other `judgement:result` consumers, far above) retracts at `is_false ≥ θ`
  // and nothing else acts on its answers.
  nightlyBeliefAudit,
  // W2 — the world-hygiene pair. Anywhere after the fact producers is fine: the
  // trigger writes only its own cursor, and the apply leg reads only its event.
  worldHygiene,
  applyWorldHygiene,
  // J2.4: alias alignment. The exact leg here — a synthetic `named:` root
  // beside its real twin folds into it through `project:merged` (projectTrack
  // folds that event on a later tick, so no ordering with it); two real roots
  // with one name become a Trust suggestion. The judge leg is the executor's.
  nightlyAliasAlignment,
  dailyJournal,
  memoryDecay,
  factConfidenceDecay,
  mindTrack,
  // lane C (enhancements 8, 7). `driftTrack` before `factTestTrack`: the owner's
  // clock facts are scored against the waking day `driftTrack` folds. Both after
  // every tracker and before the noticing pipeline, which is readability only —
  // a drift candidate reaches `noticeGate` in its own later pass.
  driftTrack,
  factTestTrack,
  // The noticing pipeline, last, and in this order for real reasons.
  //
  // `expectationLearn` folds occurrences into `state.expectations`, so it must run
  // before `expectationWatch` asks what is missing — otherwise an occurrence
  // arriving on the same tick that closes a gap would be reported absent in the very
  // fold that recorded it.
  //
  // `expectationWatch` is after `dayShapeForecast` and `uncertaintyMap` because a
  // tick's forecasts and gaps should be settled before anything decides whether to
  // speak about them, and after `coverageTrack` for the reason given at the top.
  //
  // `noticeGate` reacts to `notice:candidate`, which every producer emits as an
  // `EmitEvent` and which therefore arrives in its own later recursive `reduce()`
  // pass — the same non-dependency `entityExtract`/`contradictionCheck` have. Its
  // position here is readability, not correctness. It is the single writer of
  // `state.notices` and the only rule in the manifest that decides whether Gnomon
  // says anything at all; every producer above it states what it saw and stops.
  expectationLearn,
  expectationWatch,
  // The rules Gnomon writes: adopted watch specs, one interpreter. Before the gate that prices what they say.
  watchRules,
  // lane D — #6 the right channel. Before `noticeGate` (only `briefClock` sits
  // between), which reads `state.route` on the same event (a tick that ends a meeting releases what it
  // held). After `callSpanTrack`, `scheduleTrack` and `focusModeTrack`, whose
  // slices it reads.
  noticeRoute,
  // lane B: after `promiseTrack`, which on the same tick leaves a promise due at a meeting to this rule's prep.
  briefClock,
  noticeGate,
  // lane H: Sundial's own health. Order-free: it reads only its own slice and
  // speaks through a `notice:candidate`, which reaches the gate in its own pass.
  sensorHealth,
  // count-office-days is intentionally NOT a rule: "days at the office" is a
  // read-time analytic over moments' `location` (Phase 5 #6,
  // `getLocationDayCounts` in @sundial/db), not something the reducer folds into
  // KernelState. The earlier manifest stub that broke the build is gone.
];

/**
 * The rules a BACK-FILLED event reaches (`payload.backfill === true`): an old
 * commit or meeting read once, on the owner's word, from `/setup`.
 *
 * Almost every rule reads an event as "this is happening now": `momentRollup`
 * would pin a three-week-old commit to the open moment, `hearingWindow` would
 * start listening for a meeting that ended last Tuesday, `scheduleTrack` would
 * call it the meeting in progress. So a back-filled event reaches only the
 * rules that are true about the past. The row is still in the log at its real
 * time, which is what the read tools query.
 */
export const BACKFILL_MANIFEST: Rule[] = [entityExtract];
