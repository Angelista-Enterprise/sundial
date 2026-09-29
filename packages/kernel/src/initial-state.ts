import type { KernelState, MomentRollup } from './types.js';
import { NATURAL_KEY } from './watch.js';
import { isTextKey, textKey } from '@sundial/helpers/derive-id.js';

/**
 * UTC, deliberately. This seeds `budgets.day` for a state that has no config yet
 * (`createInitialState` runs before `startDaemon` overwrites `state.config` from
 * config.json), so there is no owner timezone to consult. The first `clock:tick`
 * corrects it to the configured local day.
 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Zero-value defaults for every `MomentRollup` field that isn't
 * moment-identity (`processName`/`windowTitles` are always supplied by the
 * caller, never defaulted). Shared by `moment-close.ts`'s `openNewMoment`
 * (a brand-new moment with no carry-over) and `hydrateSnapshot` below (a
 * carried-over `rollup` restored from a snapshot written before a field
 * existed) so there's exactly one place that says what "no activity yet"
 * looks like for a rollup.
 */
export const defaultMomentRollupExtras: Omit<MomentRollup, 'processName' | 'windowTitles'> = {
  shellCommandCount: 0,
  notableCommands: [],
  gitCommitCount: 0,
  gitBranch: null,
  calendarActive: false,
  typingEventCount: 0,
  inputEventCount: 0,
  activeMs: 0,
  lifeEvents: [],
  projectSource: null,
  projectConfidence: null,
  micActive: false,
  cameraActive: false,
  meetingTitle: null,
  meetingAttendees: [],
  screenTopics: [],
  screenExcerpt: null,
  pages: [],
  unpushedCommits: null,
  playbackActive: false,
  audioApp: null,
  devActivityByProject: {},
};

export function createInitialState(deviceId: string): KernelState {
  return {
    device: { id: deviceId },
    window: { active: null, previous: null, attribution: { projectId: null, source: null, confidence: null } },
    moment: null,
    // Null, not `now`: a daemon that has folded nothing has observed nothing, so
    // its first event cannot be measured as a gap from a boot that may have
    // happened days ago.
    observation: { lastObservedAt: null },
    observed: {},
    project: { current: null, org: null, known: {}, recentDetections: [], lastClosedMoment: null },
    agent: { session: null },
    focusMode: { state: 'unknown', name: null, since: new Date().toISOString() },
    power: { source: 'ac' },
    // charging/timeRemainingMinutes deliberately omitted (optional) rather
    // than defaulted to a guessed value — `powerTrack` fills them in from
    // the first real `system:power` event; until then "unknown" is honestly
    // represented by the key being absent, not a fabricated `false`/`null`.
    network: { fingerprint: '' },
    // Fold wave one — see the matching `KernelState` doc comments.
    files: { day: null, hot: {} },
    shell: { streak: null, lastCommandAt: null },
    pressure: { byApp: {}, total: 0, updatedAt: null },
    git: { unpushed: {} },
    av: { call: null, lastCall: null },
    browser: { current: null, authorized: true, lastError: null },
    hearing: { listening: false, reason: null, until: null, title: null, mutedUntil: null },
    settings: { autonomy: 'act', noticeBias: 0, autoAdvanceMs: null, paper: 'system', motion: 'full', blur: 'full', quiet: [], updatedAt: null },
    board: { cards: {}, scenes: {}, lenses: {}, focus: null, notice: null, walk: null, plan: null, span: null, recent: [], sections: {}, updatedAt: null },
    screen: { app: null, prevLines: [], eventId: null, kept: [], refs: [], audit: { captures: 0, lines: 0, kept: 0, furniture: 0, noise: 0 } },
    workbench: { open: null, queue: [], recent: [], done: {}, briefPoints: {}, day: null, countToday: 0 },
    meetings: { seen: {} },
    people: { asked: {} },
    // No networks known and nothing swept. A fresh daemon has consented to
    // nothing, which is the only safe starting point for a sensor that observes
    // other people's devices.
    presence: { networks: {}, lastScan: null },
    // Phase 1 phone coverage: what the paired phone knows about the desk-blind
    // hours. Empty until the iOS app posts its first `phone:*` event.
    coverage: { place: null, placeSince: null, lastSleepEnd: null, activity: null, activitySince: null, updatedAt: null, observedHours: {} },
    // Nothing recurs yet. Every entry here is learned from the log by
    // `expectationLearn`; a fresh daemon knows of no routine, so it can honestly
    // report no absence — which is the correct behaviour, not a gap.
    expectations: { recurring: {}, dayEnd: [], dayEndNotice: { runsLongDay: null, driftKey: null } },
    // The noticing gate's memory. `day: ''` never equals a real local day, so the
    // first notice of any day resets the budget without needing a boundary event —
    // the same trick `budgets.day` and `predictions.dayShape` already use.
    notices: { habituation: {}, day: '', spentToday: 0, recentPhasic: [], deferred: [] },
    // Overwritten every boot with the freshly-loaded config.json values
    // (see `KernelState.config`'s doc comment) — these are just the
    // zero-config defaults for a daemon that's never had `startDaemon` run
    // (e.g. a bare `createInitialState()` in a test).
    config: { retentionDays: 180, screenTextRetentionDays: 14, transcriptRetentionDays: 14, autoHearMeetings: false, decayFactor: 0.95, projectRules: [], sharedPlaces: [], projectAliases: {}, orgByPath: {}, locationLabels: {}, ownerAliases: [], timezone: 'UTC', refutationEnabled: true, leisureRules: { browserProfiles: {}, domainOverrides: {}, processes: {}, excluded: [] }, experiments: { ownerStateInGateCost: false, learnedGate: false, forecasting: false, gateFeatures: false, presence: false }, vault: null },
    pending: { llmCalls: {}, timers: {}, debounces: {} },
    budgets: {
      byPurpose: {
        intent: { callsToday: 0 },
        companion: { callsToday: 0 },
        reflect: { callsToday: 0 },
        extract: { callsToday: 0 },
        journal: { callsToday: 0 },
        ask: { callsToday: 0 },
        refute: { callsToday: 0 },
        goal: { callsToday: 0 },
        transcript: { callsToday: 0 },
        perceive: { callsToday: 0 },
        classify: { callsToday: 0 },
        rank: { callsToday: 0 },
        judge: { callsToday: 0 },
        audit: { callsToday: 0 },
        forecast: { callsToday: 0 },
        listen: { callsToday: 0 },
      },
      day: today(),
    },
    baselines: { hourlyDurationsByKind: {}, lastAnomalyByKind: {} },
    retention: { lastPrunedAt: null },
    recentHistory: [],
    memory: {
      accumulatedImportance: 0,
      lastReflectionAt: null,
      lastFactExtractAt: null,
      lastConversationExtractAt: null,
      lastRefutationAt: null,
      lastBeliefAuditAt: null,
      lastHygieneAt: null,
      lastAliasAlignmentAt: null,
      aliasSuggestions: [],
      aliasNames: {},
      recentEntityIds: [],
      recentMeetingKeys: [],
      factCursor: {},
      recentInsights: [],
      priorities: [],
    },
    // Phase 1 endogenous-life: derived readouts of the surprise drive
    // (`memory.accumulatedImportance`) + circadian phase, maintained by
    // `mindTrack` on `clock:tick`. Zero-value = a calm daemon at start of day.
    mind: { circadian: 'day', mood: 'settled', lastEndogenousReflectionAt: null, gaps: [], goals: [] },
    // P0-3: near-future calendar, filled by `scheduleTrack` from calendar:upcoming.
    schedule: { upcoming: [], updatedAt: null, active: null },
    // Phase 2b forward model: open prediction(s) + per-kind calibration self-model.
    predictions: {
      open: [],
      calibration: {},
      recentResolved: [],
      dayShape: { day: '', candidateHour: null, emitsThisHour: 0 },
      hourlyDoneRate: {},
      lastDayEnd: null,
      tournament: { day: '', projectToday: {}, touchedDays: {}, utterances: [], retired: {} },
      conditioned: {},
      fragmentation: { current: null, emitsThisHour: 0, emitsKey: '', prevFragmented: null, prevDay: null, byPrevState: { 'prev-frag': { n: 0, hits: 0 }, 'prev-calm': { n: 0, hits: 0 } } },
      projectTouch: { day: null, emitsThisHour: 0, emitsKey: '', touched: {}, lastTouched: {}, byProject: {} },
    },
    // The feedback loop (decisions/assistant-as-an-event-source): the owner's verdicts on what Gnomon
    // produced, plus the currently-open rating request (`solicitFeedback`).
    feedback: { recent: [], countsByVerdict: {}, lastVerdictAt: null, solicitation: null, solicitedRecently: [] },
    // What Jev's probabilities mean for this owner, learned per question id from verdicts. See `KernelState.judgement`.
    judgement: { questions: {}, recent: [], recentByArtifact: [], degraded: 'none', degradedSince: null, degradedMs: 0 },
    // The commitment ledger — open threads of work spanning hours to weeks.
    commitments: { open: [], recentClosed: [], promises: [], promiseAsk: null },
    // Wake-ups the owner or the model asked for. Folded from the log on
    // `clock:tick`, never a timer — see `KernelState.wakeups`.
    wakeups: { open: [] },
    // The question Gnomon is waiting on an answer to. One at a time; see
    // `KernelState.ownerAsk`.
    ownerAsk: { open: null, askedCount: 0, answeredCount: 0, recent: [], lastBackfillAt: null, backfillDone: false, classGain: {} },
    goals: { progress: {} },
    ingestAnomaly: { seen: [], marked: {} },
    vault: { day: null, notesToday: {} },
    drafts: { recent: [] },
    mail: { recent: [], messages: [], accessible: null },
    owner: {
      perception: { input: [], lastJudgedAt: null },
      focus: { alpha: 1, beta: 1 },
      stuck: { alpha: 1, beta: 1 },
      interruptible: { alpha: 1, beta: 1 },
      selfReports: [],
      brier: { n: 0, sum: 0, firstAt: null },
      energy: { sleepHours: null, sleptFrom: null, sleptTo: null, restingHr: null, steps: null, updatedAt: null },
    },
    // Untracked time by host/app, waiting to be asked about. See `attributionPropose`.
    attributionProposals: { watching: null, candidates: {}, decided: {} },
    // Procedural memory. Nothing repeats yet; every entry is learned from the log.
    routines: { trail: [], learned: {} },
    // decisions/assistant-as-an-event-source: what the assistant proposed and
    // claimed, folded like any sensor's output so it can be scored.
    assistant: { recent: [], proposedCount: 0, acceptedCount: 0, rejectedCount: 0, claimedCount: 0, lastAt: null },
    // The questions the owner asked, and which answers they kept.
    ask: { recent: [], askedCount: 0, rememberedCount: 0, lastAskedAt: null },
    lifeEvent: {
      lastMomentProject: null,
      lastMomentProcess: null,
      failedTests: {},
      flow: null,
      recentSwitches: [],
      lastThrashEmitAt: null,
      idle: { consecutiveZeroWindows: 0, isIdle: false },
    },
    // lane D — #6: nothing seen yet, so the owner is taken to be at the Mac.
    route: { channel: 'mac', reason: 'active', since: null, awaySince: null },
    // lane F (F1): the slices typed optional because older snapshots predate
    // them. A default here is what lets `deepMergeDefaults` back-fill a key
    // added inside one of them later; without it the persisted slice is taken
    // whole and a new nested key stays `undefined`. Same shapes as each
    // writer's own EMPTY.
    resume: { last: null, intents: {} },
    tickets: {},
    watch: { rules: [], runtime: {} },
    nightShift: { queue: [], open: null, recent: [], night: null, countTonight: 0, spentUsdTonight: 0 },
    drift: { days: {}, meetings: [], checkedWeek: null, holding: {} },
    factTests: { day: null, seen: {}, records: {} },
    briefs: { days: {}, prState: {}, lastMet: {}, done: {} },
    // lane H
    sensorHealth: { troubles: {}, lastTickAt: null, keys: null, llmAuth: {}, budgetExhausted: {}, push: { lastOkAt: null, lastFailedAt: null, lastError: null } },
  };
}

/**
 * Top-level keys of a loaded snapshot that `createInitialState` does not know:
 * a field that was removed or renamed. `deepMergeDefaults` keeps them, so they
 * ride along in every snapshot until someone notices. Boot prints them.
 */
export function unknownSnapshotKeys(persisted: object): string[] {
  const known = createInitialState('');
  return Object.keys(persisted).filter((k) => !(k in known));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively fills in defaults at every depth, not just the top level.
 * Arrays and primitives are leaves — the persisted value wins wholesale if
 * present (merging array *elements* against a default array would be
 * nonsensical), but two plain objects at the same position are merged key
 * by key, recursively. This is what lets a snapshot written before a phase
 * added a new field to an *existing* nested slice (e.g. a new key under
 * `budgets.byPurpose` or `memory`) still hydrate that field from
 * `createInitialState` instead of leaving it `undefined` (A§1.7) — the
 * previous shallow, top-level-only merge only caught brand-new top-level
 * slices.
 */
function deepMergeDefaults<T>(defaults: T, persisted: unknown): T {
  if (persisted === undefined) return defaults;
  if (!isPlainObject(defaults) || !isPlainObject(persisted)) return persisted as T;

  const merged: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(persisted)) {
    merged[key] = deepMergeDefaults(defaults[key], persisted[key]);
  }
  return merged as T;
}

/**
 * Merges a persisted snapshot with fresh defaults, recursively (see
 * `deepMergeDefaults`) — NOT a raw `JSON.parse(...) as KernelState` cast.
 * `KernelState` grows fields — new top-level slices, or new keys inside an
 * existing one — as later phases add domains; an old snapshot predating a
 * field simply won't have it, and a raw cast would produce an object the
 * type claims is complete but isn't.
 */
/**
 * `deepMergeDefaults` can't reach `moment.rollup` on its own: `createInitialState().moment`
 * is `null` (a fresh daemon has no open moment), so there's no default *object* to recurse
 * into — the general merge just takes `persisted.moment` wholesale. That's fine for the
 * moment-identity fields (`processName`/`startTime`/etc., always fully populated by whichever
 * rule opened it) but leaves a rollup extra silently `undefined` forever if this exact moment
 * (or an unbroken carry-over chain from it — `moment-close.ts`'s `openNewMoment`) has been open
 * since before that field existed, which is exactly what `appendCapped` in `moment-rollup.ts`
 * crashed on: `[...undefined, item]` is not iterable.
 */
function hydrateMoment(state: KernelState): KernelState {
  if (!state.moment) return state;
  return { ...state, moment: { ...state.moment, rollup: { ...defaultMomentRollupExtras, ...state.moment.rollup } } };
}

/**
 * Forecaster kinds that once ran and no longer do. A snapshot written before a
 * retirement still carries the dead kind's open prediction, its calibration
 * counter and its last resolutions, and none of those have a live producer any
 * more — so `hydrateSnapshot` drops them once, on the first boot after the
 * upgrade, rather than leaving the UI to render a forecaster that cannot
 * produce another data point.
 *
 * `project-continuity` was retired on 2026-07-29 for measuring 0.2% skill over
 * 2,362 resolutions; `rules/forward-model.ts` records why, and
 * `types.ts`'s `OpenPrediction` records that the union shrank to hold only
 * `day-ending`. Dropping its `recentResolved` entries is deliberate rather
 * than tidy-mindedness: that list is what the macOS app shows as "recently
 * resolved", and 50 trailing resolutions from a forecaster that will never
 * resolve a 51st reads as a live signal when it is a fossil. The measurement
 * itself is preserved in the almanac, which is the right home for a result.
 */
const RETIRED_FORECASTER_KINDS: ReadonlySet<string> = new Set(['project-continuity']);

/**
 * `predictions.calibration` used to be one pooled `{n,hits,brierSum}` — the
 * single `project-continuity` forecaster's own record, from before calibration
 * was keyed by prediction kind. `deepMergeDefaults` can't detect that shape
 * change on its own: an old pooled record and the new empty-record default are
 * both plain objects, so the merge keeps the old one's `n`/`hits`/`brierSum`
 * as stray top-level keys. That pooled record IS the retired forecaster's
 * history (nothing else existed yet), so it is now discarded outright — it
 * used to be migrated onto the `project-continuity` key, which would resurrect
 * a dead counter.
 */
function isLegacyCalibration(value: unknown): value is { n: number; hits: number; brierSum: number } {
  return isPlainObject(value) && typeof value.n === 'number' && typeof value.hits === 'number' && typeof value.brierSum === 'number';
}

function hydrateRetiredForecasters(state: KernelState): KernelState {
  const rawCal: unknown = state.predictions.calibration;
  const calibration = isLegacyCalibration(rawCal) ? {} : Object.fromEntries(Object.entries(state.predictions.calibration).filter(([kind]) => !RETIRED_FORECASTER_KINDS.has(kind)));

  return {
    ...state,
    predictions: {
      ...state.predictions,
      calibration,
      open: state.predictions.open.filter((p) => !RETIRED_FORECASTER_KINDS.has(p.kind)),
      recentResolved: state.predictions.recentResolved.filter((p) => !RETIRED_FORECASTER_KINDS.has(p.kind)),
    },
  };
}

/**
 * A watch rule adopted before `NATURAL_KEY` existed was validated without it,
 * and the snapshot holds it as validated then: one stream, so another repo's
 * clean status ends every dirty stretch. Only `validateWatchRule` gave the
 * default, and boot does not re-validate. The same default, here: no `by`, no
 * count, a state stream. `by: []` is the owner's one stream and stays.
 */
function hydrateWatch(state: KernelState): KernelState {
  if (!state.watch?.rules?.length) return state;
  const rules = state.watch.rules.map((r) => (r.by !== undefined || r.count || !NATURAL_KEY[r.when.type] ? r : { ...r, by: [...NATURAL_KEY[r.when.type]!] }));
  return { ...state, watch: { ...state.watch, rules } };
}

/**
 * lane Q (Q9): a snapshot from before `ingestAnomaly` kept keys holds whole
 * texts in both rings. Each becomes its key, so nothing already asked is asked
 * again and nothing marked stops being marked.
 */
function hydrateIngestAnomaly(state: KernelState): KernelState {
  const slice = state.ingestAnomaly;
  if (!slice || (slice.seen.every(isTextKey) && Object.keys(slice.marked).every(isTextKey))) return state;
  const seen = [...new Set(slice.seen.map((s) => (isTextKey(s) ? s : textKey(s))))];
  const marked = Object.fromEntries(Object.entries(slice.marked).map(([k, v]) => [isTextKey(k) ? k : textKey(k), v]));
  return { ...state, ingestAnomaly: { seen, marked } };
}

export function hydrateSnapshot(deviceId: string, persisted: Partial<KernelState>): KernelState {
  return hydrateIngestAnomaly(hydrateWatch(hydrateRetiredForecasters(hydrateMoment(deepMergeDefaults(createInitialState(deviceId), persisted)))));
}
