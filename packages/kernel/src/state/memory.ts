// What Gnomon believes and forecasts: core memory, its own research goals, predictions, expectations, belief tests and drift.
import type { DriftState } from '../drift.js';
import type { FactTestsState } from '../fact-tests.js';

/** KernelState's Memory fields; `KernelState` extends this. */
export interface MemorySlices {
  memory: {
    accumulatedImportance: number;
    lastReflectionAt: string | null;
    /** D3 — last time `nightlyFactExtract` ran, same "since last run, or 24h back if never" pattern as `lastReflectionAt`. */
    lastFactExtractAt: string | null;
    /** Cursor for `conversationFactExtract`, the nightly pass over the owner's chat turns. Its own cursor, like the two above: the passes read different sources. */
    lastConversationExtractAt: string | null;
    /**
     * Last time the skeptic ran (`nightlyRefutation`). Rate-limits it to one
     * pass a day. Separate from `lastFactExtractAt` because the two passes do
     * opposite jobs — one grows core memory, one tries to shrink it — and
     * sharing a cursor would let a night of extraction suppress a night of
     * refutation.
     */
    lastRefutationAt: string | null;
    /** J2.3: the last belief-audit pass (`nightlyBeliefAudit`); null until the first tick after it shipped, which runs it once. */
    lastBeliefAuditAt: string | null;
    /** W2 (2026-09-23): the last world-hygiene pass (`worldHygiene`); null until the first tick after it shipped, which runs it once. */
    lastHygieneAt?: string | null;
    /** J2.4: the last alias-alignment pass (`nightlyAliasAlignment`); null until the first tick after it shipped. */
    lastAliasAlignmentAt: string | null;
    /** J2.4: pairs of names the exact leg or the judge says may be one thing, newest-highest first, bounded. The Trust page lists them; nothing acts on them. */
    aliasSuggestions: AliasSuggestion[];
    /**
     * `person-<hash>` alias → the name a confirmed `knownAs` belief gives it.
     *
     * A rule cannot query the graph, so the fold needs the mapping in state —
     * but it is maintained by `contradictionCheck`, the single writer of
     * confirmed facts, so EVERY path that establishes a name lands here: the
     * owner answering the question, `gnomon_assert`, the nightly conversation
     * pass, a replay. The first version kept its own copy inside `peopleAsk`,
     * which meant a name written by any other path was invisible to the rule
     * that asks for names, and it had to be patched to listen for candidates.
     */
    aliasNames: Record<string, string>;
    recentEntityIds: string[];
    /**
     * Meetings `entityExtract` has already minted attendee candidates for, so one
     * meeting corroborates a colleague ONCE.
     *
     * `calendar:active` polls while a meeting runs — 17 emissions covered 6 distinct
     * meetings on the live corpus — so without this an invite would re-propose the
     * same colleague on every tick.
     *
     * A bounded ring rather than one slot, because two meetings can overlap and a
     * poll alternating between them would defeat a last-one-wins field.
     *
     * Holds a hash of the calendar's own `eventId` (which carries the recurrence
     * instance, so each standup occurrence is distinct) — never the meeting title,
     * which `sanitizeAtIngest` leaves verbatim (nothing under `payload.event`
     * carries a `processName` to gate redaction on) and which therefore must not
     * spread into new surfaces. See `entityExtract`.
     */
    recentMeetingKeys: string[];
    /**
     * D3 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.5)
     * — `object`/`factId` are the currently-confirmed truth (`null` until a
     * candidate has been promoted at least once); `pendingObject`/
     * `pendingCount` track an in-flight candidate value that hasn't yet
     * recurred enough times to be promoted (no prior confirmed fact) or to
     * supersede the confirmed one (a genuine contradiction) — see
     * `contradiction-check.ts`'s doc comment for the full promotion policy.
     * A snapshot written before D3 lacks `pendingObject`/`pendingCount`;
     * `contradictionCheck` defaults them defensively rather than relying on
     * hydration to backfill every cursor entry.
     *
     * `projectId` (per-project working-memory filtering) is the entity's real,
     * resolved project scope — `state.project.current?.id` for the heuristic
     * candidates (`entityExtract`) and, for the nightly LLM pass, the
     * `relatesToProject` object resolved back against the actual project
     * registry (never the LLM's raw string) — `null` when no project could be
     * attributed, same "don't fabricate a fact from a weak guess" rule as
     * window/moment attribution. A snapshot written before this field lacks
     * it; `contradictionCheck` defaults it to `null` the same way it backfills
     * `pendingObject`/`pendingCount`.
     */
    factCursor: Record<string, { object: string | null; factId: string | null; confidence: number; pendingObject: string | null; pendingCount: number; projectId: string | null; /** lane Q: the local day the confirmed fact was last reinforced — one increment a day, however often it is re-seen. */ reinforcedOn?: string }>;
    /**
     * D5 (docs/audit/production-proposal-and-enhancements.md, addresses
     * A§5.1, A§5.5) — the last N companion insights (`kind` is the
     * triggering anomaly's `kind`, threaded through via `ScheduleLLMEffect.metadata`
     * so `applyLlmResult` can tag an entry without a DB read). `companionInsight`
     * reads this to (1) build a "don't repeat these" hint from recent titles
     * and (2) count how many same-`kind` insights landed in the trailing
     * window, so "third late night this week" is computed from in-memory
     * state, never a DB read a rule can't do.
     */
    recentInsights: { title: string; dedupeKey: string; kind: string; createdAt: string; id?: string; /** The `noticeGate` habituation key this insight came from, so a `not-now` verdict can quiet that key. */ noticeKey?: string }[];
    /**
     * D5 — "top entities/projects of the week," written by the daily
     * reflection pass (`performReflectionCall` in `apps/daemon/src/daemon/index.ts`,
     * which already reads the window's moments for its own summary — this
     * reuses that same read rather than a second query) via a synthetic
     * `memory:priorities` event, folded in by `memoryPriorities` (a plain
     * state-only rule, no effects). `momentAnalysisSchedule`'s intent prompt
     * includes this — the first genuine loop from memory back into
     * perception, per the proposal's own framing.
     */
    priorities: string[];
  };
  /**
   * Phase 1 endogenous-life (docs/design/08-endogenous-life.md §3, decisions
   * D2/D3). The surprise DRIVE itself lives in `memory.accumulatedImportance`
   * — the field the original design declared but never populated; `surpriseDrive`
   * now feeds it from `anomaly:detected`. This `mind` slice holds the derived,
   * human-legible readouts of that drive plus the endogenous-reflection cursor,
   * all maintained on `clock:tick` (no hidden timer — rides the existing tick,
   * per "the law", doc 00). Full mood readout (budget/contradiction inputs,
   * surfacing) is Phase 3.
   */
  mind: {
    /** Local-hour circadian phase, set by `mindTrack`; gates heavy autonomous work away from active daytime. */
    circadian: 'day' | 'evening' | 'night';
    /** Coarse mood, a readout of `memory.accumulatedImportance` (the surprise drive) — never an input to it. */
    mood: 'settled' | 'stirring' | 'restless';
    /** Last drive-triggered (endogenous) reflection — rate-limits `endogenousReflection`; distinct from the daily `memory.lastReflectionAt`. */
    lastEndogenousReflectionAt: string | null;
    /**
     * Where the daemon's own ignorance is concentrated — the forecaster cells it
     * is least sure of, worst first. Written by `uncertaintyMap`.
     *
     * This is a claim ABOUT A CLAIM, and that is what makes it worth ranking
     * rather than just counting. `predictions.hourlyDoneRate[h] = {n, hits}` is
     * a Beta posterior in disguise, and its variance depends on both how much
     * evidence a cell holds and how split that evidence is — so an hour observed
     * ten times and split five-five is genuinely less settled than one observed
     * ten times and never a day's last, which a bare sample count cannot say.
     *
     * Bounded, and cells with no observations at all are excluded: "I have never
     * seen you working at 04:00" is an absence of behaviour, not uncertainty
     * about it, and letting those dominate would fill the list with the small
     * hours and say nothing.
     */
    gaps: UncertaintyGap[];
    /**
     * The questions Gnomon has set itself, newest first — open ones first, then a
     * short tail of settled ones so a report can be written after the fact.
     *
     * Written by `researchGoals`. Bounded hard: this is a working set, not a
     * history. The durable record of what was learned is the `self-report` notice
     * the goal produces on closing, which goes through the same gate as everything
     * else and can therefore be habituated, deferred, or refused like any other
     * thing Gnomon might say.
     */
    goals: ResearchGoal[];
  };
  /**
   * Phase 2b forward model (docs/design/08-endogenous-life.md §4, decisions
   * D4/D6/D12). The daemon predicts, then scores itself: `dayShapeForecast`
   * forms an `open` prediction when an hour becomes active and resolves it by
   * log-loss (surprise = −ln p_actual), feeds that surprise into the drive
   * (`memory.accumulatedImportance`) — the CONTINUOUS prediction-error signal
   * complementing Phase 1's discrete anomaly surprise — and updates
   * `calibration`, the running self-model of the daemon's own predictive
   * accuracy (D12, the first inward-pointing inference). `recentResolved` is a
   * bounded window for surfacing (M6). In-state only in v1; a persisted
   * predictions table (doc Q2) and LLM/belief-derived forecasts are deferred.
   */
  predictions: {
    open: OpenPrediction[];
    /**
     * Keyed by `OpenPrediction['kind']` rather than one pooled record, and it
     * stays that way now that only one kind is live. Pooling a learnable
     * target with an unlearnable one produces a number describing neither,
     * which is what forced this shape when `project-continuity` still existed
     * — and the per-kind split is also what let that forecaster be retired
     * without touching `day-ending`'s accumulated record. D12's calibration
     * gate reads this per kind, so a future forecaster arrives with its own
     * counter and cannot dilute an existing one.
     */
    calibration: Record<string, { n: number; hits: number; brierSum: number }>;
    recentResolved: ResolvedPrediction[];
    /**
     * `day-shape-forecast.ts`'s own bookkeeping for detecting "a new hour just
     * became active" from `input:activity` emits (which fire at a constant
     * ~10s cadence regardless of activity level — see that sensor's doc
     * comment — so "active" here means "the daemon was running and observing
     * this hour," not "the user was typing"; see
     * enhancements/presence-as-absence-ground-truth for that ground-truth
     * caveat). `day` uses the same `ts.slice(0,10)` convention as
     * `budgets.day`, checked independently rather than waiting on
     * `clock:tick`'s `day:boundary` — same reasoning `clockTick` itself uses
     * for its own day check.
     */
    dayShape: { day: string; candidateHour: number | null; emitsThisHour: number };
    /**
     * The `day-ending` forecaster's OWN learned prior — hour-of-day (0-23) ->
     * observed "was this hour the day's last active one" rate. Deliberately
     * separate from `calibration['day-ending']` (the self-model/score): using
     * a kind's own aggregate hit rate AS its prediction is the degenerate fixed
     * point that got the `project-continuity` forecaster retired (see
     * `rules/forward-model.ts`). This is the conditioning feature measured to
     * carry the skill; `calibration` only ever scores the result.
     */
    hourlyDoneRate: Record<number, { n: number; hits: number }>;
    /**
     * The previous resolved day's last active hour — written on every HIT
     * resolution, read only to evaluate `prev-day-ran-late` when a conditioned
     * bet opens. A single pair rather than a history: the conditioner needs
     * yesterday, and yesterday only.
     */
    lastDayEnd: { day: string; hour: number } | null;
    /**
     * J2.2's tournament (`forecastTournament`): the tallies its features are
     * read from, a ring of recent utterance timestamps for the meeting target,
     * and which forecasters it has retired per target. Calibration for the
     * tournament's forecasters is keyed `<target>/<forecaster>` in the shared
     * `calibration` map.
     */
    tournament: {
      day: string;
      projectToday: Record<string, { minutes: number; sessions: number }>;
      touchedDays: Record<string, string[]>;
      utterances: string[];
      retired: Record<string, string[]>;
    };
    /**
     * Conditioned cells: the structure research goals have PROVEN, installed
     * only by an accepted `goal:trial-result` (MDL-guarded information gain
     * over the forecaster's own recorded samples — see `conditioners.ts`).
     *
     * Keyed by hour like `hourlyDoneRate`. The flat cell keeps updating
     * regardless, so the original `hourly-rate` series stays comparable with
     * its +46.1% measurement; conditioned bets are recorded under their own
     * forecaster string for the same reason. The arms update at resolution
     * from the condition stamped on the open prediction; a bet whose condition
     * was unevaluable (`null`) updates the flat cell only.
     */
    conditioned: Record<number, {
      variable: string;
      arms: { when: { n: number; hits: number }; otherwise: { n: number; hits: number } };
      installedAt: string;
      goalId: string;
    }>;
    /**
     * The `hour-fragmented` forecaster's own accumulator — see
     * `HourFragmentedPrediction` for the measurement that justifies it.
     *
     * `switchesThisHour` is the evidence the open bet is resolved against, and it
     * is deliberately kept HERE rather than derived at resolution time from the
     * log. That is the lesson `dayShapeForecast`'s first version paid for: it
     * decided a hit from whichever of two differently-paced event types fired
     * first, and every hour learned the inverse of the truth. An outcome must be
     * a function of the prediction's own recorded state.
     */
    fragmentation: {
      /** Local day and hour currently accumulating, or null before any hour has become active. */
      current: { day: string; hour: number; switchesThisHour: number } | null;
      /** Activity emits seen in the hour being considered, until it crosses the active threshold. Mirrors `dayShape.emitsThisHour`. */
      emitsThisHour: number;
      /** The hour those emits belong to, as `day|hour`. Empty before the first emit. */
      emitsKey: string;
      /** Whether the hour that just closed came apart — the conditioning feature for the next bet. Null before any hour has closed. */
      prevFragmented: boolean | null;
      /**
       * The local day `prevFragmented` describes.
       *
       * Load-bearing, and a test caught its absence: without it the lag survived
       * a `day:boundary`, because that event clears `current` before the next
       * day's first switch can compare days — so a fragmented final hour of
       * Monday silently conditioned the first bet of Tuesday, which is a feature
       * nothing ever measured.
       */
      prevDay: string | null;
      /** Per-cell counts, keyed by the conditioning arm. Two cells only, because the measurement supported no finer split. */
      byPrevState: Record<'prev-frag' | 'prev-calm', { n: number; hits: number }>;
    };
    /**
     * The `project-touched` forecaster's own accumulator — see
     * `project-touch-forecast.ts` for the measurement that justifies it.
     *
     * `touched` is the evidence the open bets are resolved against, recorded by
     * this rule from `window.attribution` as the day goes, never re-derived at
     * resolution from whatever event happens to close the day — the lesson both
     * earlier forecasters paid for. Keyed by local day, and pruned to the bet
     * day and today, so a day that closes late (laptop shut overnight) still
     * finds its own record.
     */
    projectTouch: {
      /** Local day the open bets belong to, or null before any day has become active. */
      day: string | null;
      /** Activity emits seen in the hour being considered, until the day's first hour crosses the active threshold. */
      emitsThisHour: number;
      /** The hour those emits belong to, as `day|hour`. */
      emitsKey: string;
      /** Local day → projects attributed to at least one window that day. */
      touched: Record<string, string[]>;
      /** Project → the last local day it was touched. The candidate set a new day bets on, pruned by recency. */
      lastTouched: Record<string, string>;
      /** Project → resolved (n, hits): the forecaster's learned prior, per project. */
      byProject: Record<string, { n: number; hits: number }>;
    };
  };
  /**
   * What recurs, so an absence can be noticed at all.
   *
   * Every producer that existed before this slice fired on something HAPPENING,
   * which is why nothing could ever report a break not taken, a routine dropped, a
   * repository gone quiet or a day never spent away from the keyboard. Those are
   * the shape most of what a person actually wants noticed takes, and a nervous
   * system generates an error signal for an expected stimulus that fails to
   * arrive, not only for an unexpected one.
   *
   * Written by `expectationLearn`, read by `expectationWatch`. Bounded by stream
   * count times bucket count, which is declared in `OCCURRENCE_STREAMS` rather
   * than open-ended, so this cannot grow without a code change.
   */
  expectations: {
    recurring: Record<string, Recurrence>;
    /**
     * Per-local-day last observed activity, in minutes from local midnight.
     *
     * A separate series because a day's end is a PHASE, not an interval, and the
     * `Recurrence` machinery above measures gaps between occurrences. The gap
     * between one day ending and the next is always about 24 hours whatever time
     * the owner stopped, so an interval model is structurally blind to the very
     * thing worth noticing here.
     *
     * This is what makes bedtime drift detectable — a stop time sliding twenty
     * minutes later each night produces no surprising night, so it is invisible to
     * every surprise-based detector in the system, and a slope over this series is
     * the only thing that can see it.
     *
     * Bounded to `MAX_DAY_END_SAMPLES`. Newest last.
     */
    dayEnd: { day: string; minutes: number; basis?: string }[];
    /**
     * Edge-trigger markers for the day-end pair, which has no occurrence to re-arm on
     * the way `Recurrence.armed` does.
     *
     * Both candidates are computed from a standing condition — "you are past your usual
     * stop", "your stop time is sliding" — so without a marker they re-emit on every
     * `clock:tick` for as long as the condition holds. Measured on the synthetic corpus:
     * 146 `day-runs-long` candidates from a handful of genuinely late nights. The gate
     * suppressed all but a few, but the log filled with a producer talking to itself.
     */
    dayEndNotice: { runsLongDay: string | null; driftKey: string | null };
  };
  /** Each testable belief's record against what the owner then did (use case 7). Single writer: `factTestTrack`. See `fact-tests.ts`. */
  factTests?: FactTestsState;
  // lane C (enhancements 7, 8) — both optional: older snapshots predate them.
  /** Weekly trends from waking days (use case 8). Single writer: `driftTrack`. See `drift.ts`. */
  drift?: DriftState;
}

/**
 * Phase 2b forward model (docs/design/08-endogenous-life.md §4). An
 * outstanding, falsifiable prediction awaiting resolution, kept in state
 * (bounded) until it resolves.
 *
 * `day-ending` ("this active hour is the day's last one"), resolved either
 * when a later hour is promoted to active (miss) or at `day:boundary` (hit) —
 * see `day-shape-forecast.ts`. Its hour-conditioned prior is the one measured
 * to carry real information (+46.1% skill).
 *
 * Still written as a union with one member on purpose. A second kind,
 * `project-continuity`, lived here until 2026-07-29 and was retired for
 * measuring 0.2% skill over 2,362 resolutions — the argument is in
 * `rules/forward-model.ts`. A snapshot predating that retirement can still
 * hold an open prediction of the dead kind, which `hydrateSnapshot` drops;
 * see `initial-state.ts`'s `hydrateRetiredForecasters`. Keeping the union
 * shape means adding the next forecaster is a new member rather than a
 * refactor, which is what this array was always typed to allow.
 */
/**
 * The `project-touched` forecaster's bet: will this project be worked on at all
 * today? Opened per candidate project when the day becomes active, resolved
 * against the day's own record of attributed windows (`predictions.projectTouch.touched`).
 */
export interface ProjectTouchedPrediction {
  id: string;
  createdAt: string;
  kind: 'project-touched';
  /** Local day this bet is about. */
  day: string;
  /** The project id, as `window.attribution.projectId` names it. */
  project: string;
  priorProb: number;
}

/**
 * J2.2: one bet in the forecast tournament, carrying every forecaster's
 * probability for the same case so they resolve on the same truth. `kind` is
 * `tournament:<target>` so the existing per-kind rules never mistake a twin
 * for their own bet; the recorded predictions carry the bare target with the
 * forecaster's name.
 */
export interface TournamentPrediction {
  id: string;
  kind: `tournament:${string}`;
  /** The target the recorded rows are filed under: `return-today` | `meeting-overrun` | `hour-fragmented`. */
  target: string;
  /** Dedupe key for the case (`<day>|<project>`, `meeting|<start>`, `hf|<day>|<hour>`). */
  key: string;
  createdAt: string;
  /** When the truth is known by the clock, or null when an event or the day boundary settles it. */
  resolveBy: string | null;
  about: string;
  features: Record<string, number | boolean | null>;
  /** forecaster → probability; `null` while Jev's answer is still out. */
  forecasters: Record<string, number | null>;
}

export type OpenPrediction = DayEndingPrediction | HourFragmentedPrediction | ProjectTouchedPrediction | TournamentPrediction;

/**
 * "This hour will come apart" — open on the hour's FIRST recorded context
 * switch, resolved at the hour's end against the switches actually counted.
 *
 * The second forecaster in the system, and the first whose conditioning feature
 * is a LAG rather than a position in the calendar. Measured with
 * `measure-forecast-skill.ts` (Q7) at +13.7% skill from the previous hour's own
 * outcome, against +6.5% from hour of day — and stable at +15.0% / +16.4% /
 * +13.7% over three corpus cutoffs, which is why this target was built and
 * "do you return to the same work after an interruption" was not: that one read
 * +9.5% / +9.7% / +15.3%, so its best number was its least typical one.
 *
 * Two cells, not forty-eight. `previous hour` alone beat `prev hour x hour` in
 * the measurement (+13.7% vs +11.0%), so the cell space is exactly
 * {prev-frag, prev-calm} — the finest split the evidence supports and no finer.
 */
export interface HourFragmentedPrediction {
  id: string;
  createdAt: string;
  kind: 'hour-fragmented';
  /** Local day this bet belongs to. Carried so resolution never has to re-derive it from the resolving event's clock. */
  day: string;
  /** Local hour being forecast. */
  hour: number;
  priorProb: number;
  /** The conditioning cell this prior came from — whether the PREVIOUS hour came apart. */
  prevState: 'prev-frag' | 'prev-calm';
}

export type DayEndingPrediction = {
  id: string;
  createdAt: string;
  kind: 'day-ending';
  hour: number;
  priorProb: number;
  /**
   * The conditioning arm this bet was placed under, when the hour has an
   * accepted conditioned cell (see `predictions.conditioned`). Stamped at OPEN
   * time because that is the only moment the condition is evaluable — by
   * resolution the next morning, "today" is a different day. Absent when the
   * hour is unconditioned or the conditioner returned `null` (unknowable).
   */
  condition?: { variable: string; value: boolean };
};

/**
 * One cell of a forecaster's conditioning table where it expects to do badly.
 *
 * Note what this is NOT: a measure of how little evidence the cell holds. That
 * was the first version and it was measurably backwards — see
 * `packages/rules/src/uncertainty-map.ts`.
 */
export interface UncertaintyGap {
  kind: string;
  forecaster: string;
  /** The conditioning value, as the forecaster keys it — an hour, for `day-ending`. */
  cell: string;
  /** The same value in the owner's terms, e.g. `17:00`. Built here so a surface never has to know how a forecaster spells its own key. */
  label: string;
  n: number;
  hits: number;
  /**
   * Expected log-loss in nats under the cell's Beta posterior, given what the
   * forecaster will actually predict there. Higher means more error expected —
   * validated out-of-sample at 1.46× against the hours it stays quiet about.
   *
   * This is the RANKING metric and it is the sum of two different things:
   * `H(believed) + excessLoss`. Use it to choose what to look at, never to
   * judge whether looking helped — see `excessLoss`.
   */
  expectedLoss: number;
  /**
   * The part of `expectedLoss` that more evidence can actually remove: the KL
   * divergence between what the cell's posterior believes and what the
   * forecaster will bet there.
   *
   * Split out because conflating the two produced a rule that could never tell
   * the truth. `expectedLoss` also contains `H(believed)`, the cell's own
   * entropy, which is a FLOOR — an hour that genuinely is a coin flip costs
   * 0.69 nats no matter how long it is watched, and watching harder makes the
   * daemon more certain it is a coin flip rather than more accurate. Because a
   * goal only opens on a high-loss (therefore high-entropy) cell, any criterion
   * demanding a fraction of `expectedLoss` burn off sets its target BELOW that
   * floor and can never be met: measured across true rates 0.2–0.6, the 30%
   * target was 0.50–0.59 nats against floors of 0.50–0.69.
   *
   * `excessLoss` has no such floor. It goes to zero exactly when the forecaster
   * has learned the cell, which is the thing a research goal is about.
   */
  excessLoss: number;
}

/**
 * One question the daemon set ITSELF, and what became of it.
 *
 * The first thing in the system that is chosen rather than triggered. Every other
 * producer reacts: something happened, and a rule had an opinion about it. This
 * starts from what Gnomon does not know — `mind.gaps`, already ranked by expected
 * loss — picks the cell it expects to learn most from, and then watches that one
 * cell until the evidence moves.
 *
 * Ranked by expected learning progress rather than by importance on purpose. A
 * gap can be enormous and unlearnable (an hour the owner is simply never awake
 * for), and a system that chased size alone would keep re-opening the same dead
 * cell forever. `expectedLoss` is what the forecaster expects to get WRONG there,
 * so improvement in it is the thing actually being pursued.
 */
export interface ResearchGoal {
  /** Stable across the goal's life; derived from the gap's forecaster + cell. */
  id: string;
  forecaster: string;
  cell: string;
  /** The gap in the owner's terms, e.g. `17:00` — carried so a surface need not re-derive it. */
  label: string;
  /** The question in one sentence, written at open time so the report can quote it. */
  question: string;
  openedAt: string;
  /**
   * Evidence count and loss AT OPEN — the baseline the finding is measured
   * against. `excessLoss` is the one progress is judged on; `expectedLoss` is
   * kept because it is what ranked the cell in the first place.
   */
  openedWith: { n: number; expectedLoss: number; excessLoss: number };
  /** Set when the goal is settled; `null` while it is still open. */
  closedAt: string | null;
  /**
   * Why it closed, and no two of these mean the same thing — K0.4.
   *
   * `learned` = a hypothesis was PROPOSED, TESTED and ACCEPTED: the goal has a
   * variable, two arms and a measured gain, and `finding` holds all three. It
   * is the only ending that claims anything was understood, and it is reached
   * from the trial path alone.
   *
   * `faded` = the cell's correctable error fell past the bar without anything
   * being tested. This used to say `learned` too, and that was the Lab card's
   * central complaint: `MIN_EXCESS_TO_OPEN` is 0.02 and `LEARNED_LOSS_DROP` is
   * 0.3, so a goal may open on two hundredths of a nat and declare victory on
   * six thousandths of one, which two coin flips produce — and not one of the
   * record's five goals ever formed a hypothesis at all. The gap closing on
   * its own is a real and useful thing to report; it is not understanding, and
   * one word cannot mean both.
   *
   * `stale` = it sat open for three weeks, or exhausted the variable menu,
   * without the evidence moving. A real finding about the question.
   *
   * `superseded` = a hotter gap displaced it. The ending that most looks like
   * a result and least is one: it says nothing whatever about the question.
   */
  outcome: 'learned' | 'faded' | 'stale' | 'superseded' | null;
  /**
   * Evidence count and loss at close, for the delta the report states.
   *
   * `excessLoss` is here for the same reason it is on `openedWith` and it was
   * missing until K0.4: the close is DECIDED on the excess loss and stored the
   * expected one, so the arithmetic of a closed goal could not be checked
   * afterwards from the record. Optional, because the two goals closed before
   * this have none.
   */
  closedWith: { n: number; expectedLoss: number; excessLoss?: number } | null;
  /**
   * The propose-and-verify state machine, all optional so goals persisted
   * before it existed hydrate cleanly (the same lesson `openedWith.excessLoss`
   * taught — see `researchGoals`' re-baseline branch).
   *
   * Flow: open → `proposalRequestedAt` set when the ScheduleLLM proposal goes
   * out → `hypothesis` set when a valid llm:result lands (and a RunGoalTrial
   * is emitted) → the trial's verdict either closes the goal `learned` with
   * `finding` populated, or appends the variable to `tried`, clears the
   * hypothesis, and allows ONE more proposal. The model picks the variable;
   * the arithmetic renders every verdict.
   */
  proposalRequestedAt?: string | null;
  hypothesis?: { variable: string; because: string; proposedAt: string } | null;
  /** Variables already tested and rejected for this goal — excluded from later proposal menus. */
  tried?: string[];
  /**
   * What the goal concluded — one shape for both endings, K0.4.
   *
   * It existed and only the TRIAL path ever wrote it, and that path has never
   * fired: all five of the record's closed goals carry `null`, so the Lab card
   * had to print "no conclusion was written" on every row. The threshold path
   * was already building the honest sentence for its own notice — what came
   * down, from what to what, over how many new observations — and throwing it
   * away. Now both paths write here.
   *
   * `variable` and `arms` are non-null only where something was actually
   * tested. A `faded` goal has neither and says so, rather than leaving a
   * reader to guess whether the split is missing or was never made — which is
   * the same distinction `outcome` now draws, kept consistent on purpose.
   *
   * Numbers, not prose: a surface phrases them. `stalled` marks the shape a
   * `stale` close leaves behind, where the excess loss is recorded and no
   * progress is claimed.
   */
  finding?: {
    variable: string | null;
    /** Information gain of the split in nats per sample (see `conditioners.ts`), or the excess loss burnt off on a `faded` close. */
    gain: number;
    arms: { when: { n: number; hits: number }; otherwise: { n: number; hits: number } } | null;
    /** K0.4 — the correctable error at open and at close, which is what the threshold judged. */
    excessFrom?: number;
    excessTo?: number;
    /** How much new evidence arrived while the goal was open. The number that makes a verdict word believable or not. */
    newObservations?: number;
    stalled?: boolean;
  } | null;
}

/** A resolved prediction — the fitness record. `surprise` = −ln(p assigned to the actual outcome), in nats. */
export interface ResolvedPrediction {
  kind: string;
  priorProb: number;
  hit: boolean;
  surprise: number;
  resolvedAt: string;
}

/**
 * One thing that recurs, learned from the log — the only way to notice an absence.
 *
 * A survival model rather than a schedule, and that is what lets ONE mechanism
 * cover a break every ~90 minutes, a day off every ~9 days, a standup every ~24
 * hours and a repository touched every couple of days. None of those needs its own
 * rule, which is the difference between this and the bespoke-detector-per-topic
 * shape the noticing surface started with.
 *
 * Welford accumulators rather than a sample array, the same choice
 * `lifeEvent.flow` already makes: an occurrence stream has no upper bound on
 * length and the spread is all anything reads.
 */
export interface Recurrence {
  /**
   * `${stream}|${bucket}`.
   *
   * Bucketed for exactly the reason `predictions.hourlyDoneRate` buckets by hour.
   * `git:commit` runs several times a day on weekdays and zero at weekends, so an
   * unconditioned interval learns a bimodal gap and then reports every Saturday as
   * an absence — a detector that fires 52 times a year and is wrong every time.
   */
  key: string;
  stream: string;
  bucket: RecurrenceBucket;
  /** Welford over the gap between consecutive occurrences, in ms. */
  intervalMs: { mean: number; m2: number; n: number };
  lastSeenAt: string;
  /**
   * Slope of the interval over recent occurrences, ms per day.
   *
   * Separate from the interval itself because habituation HIDES drift: a bedtime
   * moving twenty minutes later each night never produces a single surprising
   * night, so no surprise-based detector can ever see it. Measuring the slope
   * explicitly is the one place this design deliberately refuses to copy the
   * biology, since slow change is precisely what a nervous system is worst at.
   */
  driftPerDayMs: number;
  /** Occurrences behind `driftPerDayMs`, so the drift term has its own evidence count. */
  driftSamples: number;
  /**
   * Whether an omission for this recurrence is currently allowed to fire.
   *
   * Edge-triggering, and it is load-bearing rather than an optimisation.
   * `expectationWatch` runs on `clock:tick`, so a level-triggered overdue check
   * would emit a candidate every 60 seconds for as long as the thing stayed
   * absent — 1,440 log rows and 1,440 recursive `reduce()` passes a day, for one
   * missing break. Disarmed on emit, re-armed when the occurrence next happens.
   */
  armed: boolean;
  /**
   * Local day the omission was last announced on, or null.
   *
   * Re-arming strictly on an occurrence is correct edge-triggering and catastrophic in
   * one case: an absence that never ends never re-arms, so the worst instance of it can
   * never be reported. This lets a standing absence be raised once per day and no more.
   */
  disarmedOn: string | null;
  /** Declared by the stream: whoever knows what this is knows whether saying it late is useless. */
  valueHalfLifeMs: number | null;
}

export type RecurrenceBucket = 'weekday' | 'weekend' | 'any';

/**
 * A notice that cleared the interrupting bar. Kept in state (bounded) because the
 * owner chose "log plus a surface in the app" over real delivery for now:
 * `NotifyEffect` has no delivery channel, so this slice IS the channel until the
 * measured false-positive rate justifies building one.
 */
/**
 * The Lab instrument's reading (`GET /gnomon/lab`): Gnomon's self-evolving
 * state, joined at read time from records that already exist — the wake-up loops
 * keyed `experiment-*`, `mind.goals` with the cell's live `n`, and the week's
 * `assistant`/`feedback` verdicts. Nothing here is a new record kind.
 */
export interface LabReading {
  experiments: { key: string; name: string; at: string; scheduledAt: string; reason: string; status: 'scheduled' | 'due' }[];
  questions: { id: string; question: string; label: string; evidence: number; status: 'open' | 'learned' | 'stale' | 'superseded' | 'closed'; openedAt: string; closedAt: string | null }[];
  weekVerdicts: {
    /** All-time tally, the way the strip and the model quote it: accepted of resolved. */
    accepted: number;
    rejected: number;
    resolved: number;
    /** This week's decided proposals, newest first. */
    proposals: { id: string; summary: string; kind: string; outcome: 'accepted' | 'rejected'; at: string }[];
    /** This week's verdicts on notices. */
    notices: { useful: number; wrong: number; notNow: number };
  };
}

/** One "these two names may be one thing" the Trust surface shows (J2.4). `basis` says who said so. */
export interface AliasSuggestion {
  kind: 'project' | 'person';
  aId: string;
  a: string;
  bId: string;
  b: string;
  /** P(same): 1 for an exact same-name match, the judge's noul otherwise. */
  p: number;
  basis: 'same-name' | 'judge';
  at: string;
}
