import { deriveId } from '@sundial/helpers/derive-id.js';
import { isSystemProcess } from '@sundial/helpers/window-classification.js';
import { defaultMomentRollupExtras } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, MomentRollup, MomentRow, Rule, SanitizedEvent, WindowAttribution } from '@sundial/kernel/types.js';
import { computeMomentImportance } from '@sundial/memory/score.js';
import { resolveAttribution, type WindowLocatorInput } from './attribution.js';
import { computeFocusScore, focusQuality } from './focus-score.js';
import { computeAudioContext, computeMomentKind } from './moment-kind.js';

interface WindowChangedPayload {
  processName?: string;
  windowTitle?: string;
  documentPath?: string | null;
}

/** The window locator carried by a `window:changed` event's payload. */
function locatorFromEvent(event: SanitizedEvent): WindowLocatorInput {
  const payload = event.payload as WindowChangedPayload;
  return {
    processName: typeof payload.processName === 'string' ? payload.processName : '',
    windowTitle: typeof payload.windowTitle === 'string' ? payload.windowTitle : '',
    documentPath: typeof payload.documentPath === 'string' ? payload.documentPath : null,
  };
}

// B1 (docs/audit/production-proposal-and-enhancements.md, fixes A§3.1/A§4.7)
// — moments used to close on every window-*title* change, so a developer
// alternating a handful of files/tabs generated dozens of one-second
// fragments an hour, each triggering its own pair of LLM calls. These three
// constants are what a "real" moment boundary now means instead: a process/
// project change (or system-process/idle gap), a sanity cap on how long one
// moment can stay open, and a floor under which a fragment isn't worth its
// own row.
const MAX_MOMENT_DURATION_MS = 30 * 60_000;
/**
 * How large a jump between consecutive `clock:tick`s counts as the daemon having
 * stopped observing, rather than a late tick.
 *
 * Five minutes is five missed ticks (`CLOCK_TICK_INTERVAL_MS` is 60s). Chosen
 * from the log's own gap distribution rather than picked: of 255,027 intervals
 * between consecutive signals, 99.7% are under one minute, 242 fall between one
 * and five minutes, and everything beyond that is a long tail of 584 intervals
 * running out to 43.5 hours. Five minutes sits above the normal band and below
 * the tail.
 *
 * The cost of setting this too low is a moment closed early, which slightly
 * undercounts a quiet stretch. The cost of setting it too high is phantom
 * duration — bounded here at five minutes per gap, against the 43.5 hours a
 * single gap used to be able to contribute.
 */
const MAX_OBSERVATION_GAP_MS = 5 * 60_000;
/**
 * How short an excursion into another project has to be to count as a glance
 * rather than a switch. Two minutes, from measuring the real reversals: 39 of the
 * 47 interrupting moments fell under it, the largest group averaging 37 seconds.
 */
const BRIEF_EXCURSION_MS = 2 * 60_000;
// Exported: B2's moment-analysis-schedule rule uses the same floor to skip
// scheduling an LLM call for a moment that's about to be dropped as
// too-thin-to-count anyway.
export const MIN_MOMENT_DURATION_MS = 20_000;
const MAX_ROLLUP_TITLES = 50;

type OpenMoment = NonNullable<KernelState['moment']>;

/**
 * D2-adjacent fix, discovered while starting Phase D (docs/audit/
 * production-proposal-and-enhancements.md) — B1 taught `momentClose` itself
 * to distinguish a same-process/same-project title change (append, no
 * close) from a real boundary, but every *sibling* "runs before
 * `momentClose`" rule (`momentAnalysisSchedule`, `embeddingIndex`,
 * `entityExtract`'s `window:changed` branch, `anomalyZscore`) kept reacting
 * to *every* `window:changed` while a moment was open, exactly like before
 * B1. A long single-process session (many file/tab switches) was still
 * scheduling a fresh `ScheduleLLM`/`Embed`/fact-candidate/anomaly-sample on
 * every title change — the same "two LLM calls fire per title change"
 * symptom the original audit flagged (A§3.1), just narrower in scope than
 * before B1 landed. This is the single source of truth those four rules
 * now import instead of each re-deriving (or, worse, never deriving) the
 * same "will this event actually close the moment" decision.
 */
export function isMomentClosingBoundary(state: KernelState, event: SanitizedEvent): boolean {
  if (event.type !== 'window:changed' || !state.moment) return false;
  const locator = locatorFromEvent(event);
  const enteringGap = isSystemProcess(locator.processName);
  // Per-window attribution, not the old global `state.project.current`: a
  // VSCode folder switch (different documentPath → different projectId) now
  // correctly splits the moment, while a browser tab (projectId null) no
  // longer splits on ambient project churn it has nothing to do with.
  const newProjectId = resolveAttribution(state, locator).projectId;
  const sameActivity = !enteringGap && state.moment.processName === locator.processName && state.moment.projectId === newProjectId;
  return !sameActivity;
}

function addTitle(existingTitles: string[], title: string): string[] {
  if (!title) return existingTitles;
  const withTitle = existingTitles.includes(title) ? existingTitles : [...existingTitles, title];
  return withTitle.slice(-MAX_ROLLUP_TITLES);
}

function openNewMoment(
  event: SanitizedEvent,
  processName: string,
  windowTitle: string,
  attribution: WindowAttribution,
  carryOverRollup: MomentRollup | null = null,
  /** W6 D1: a dropped sub-20-s predecessor's start. Its time is merged with its work, so `activeMs` never outgrows the duration. */
  carriedFrom: string | null = null,
): OpenMoment {
  return {
    id: deriveId(event.ts, event.id, 'moment-close'),
    sessionId: event.id,
    startTime: event.ts,
    ...(carriedFrom ? { carriedFrom } : {}),
    processName,
    // Per-window attribution (from the opening window's own locator), NOT the
    // old global `state.project.current` — see `isMomentClosingBoundary`.
    // `contextSwitch` (packages/rules/src/life-event/context-switch.ts) reads
    // this to detect cross-moment project changes.
    projectId: attribution.projectId,
    rollup: {
      processName,
      windowTitles: addTitle(carryOverRollup?.windowTitles ?? [], windowTitle),
      // B4 — everything below either carries over from a dropped
      // predecessor (see `closeMoment`'s doc comment) or starts at zero and
      // is accumulated by `momentRollup` while this moment stays open,
      // independent of `window:changed`/this rule's own close decision.
      ...(carryOverRollup
        ? {
            shellCommandCount: carryOverRollup.shellCommandCount,
            notableCommands: carryOverRollup.notableCommands,
            gitCommitCount: carryOverRollup.gitCommitCount,
            gitBranch: carryOverRollup.gitBranch,
            calendarActive: carryOverRollup.calendarActive,
            typingEventCount: carryOverRollup.typingEventCount,
            // Real input and attended time carry over on the same terms as every
            // other accumulator: a dropped sub-20s predecessor's work is merged into
            // its successor rather than lost.
            inputEventCount: carryOverRollup.inputEventCount ?? 0,
            activeMs: carryOverRollup.activeMs ?? 0,
            lifeEvents: carryOverRollup.lifeEvents,
            micActive: carryOverRollup.micActive,
            cameraActive: carryOverRollup.cameraActive,
            meetingTitle: carryOverRollup.meetingTitle,
            meetingAttendees: carryOverRollup.meetingAttendees,
            screenTopics: carryOverRollup.screenTopics,
            screenExcerpt: carryOverRollup.screenExcerpt,
            // The three fields added 2026-09-07. `pr` matters most: the PR
            // sensor is change-gated, so a branch's MERGED status is emitted
            // exactly ONCE — dropped with a sub-20s flick moment, the thread
            // stays "unfinished" and is later noticed as abandoned work that
            // in fact shipped.
            pr: carryOverRollup.pr,
            screenRefs: carryOverRollup.screenRefs,
            symbolsEdited: carryOverRollup.symbolsEdited,
          }
        : defaultMomentRollupExtras),
      // Attribution provenance rides on the NEWLY-opened moment's own
      // resolution, never carried over from a dropped predecessor — placed
      // after the spread so neither the carry-over nor the defaults win.
      projectSource: attribution.source,
      projectConfidence: attribution.confidence,
    },
    intent: { status: 'none' as const },
  };
}

/**
 * Closes `moment` as of `endTs`. Moments under `MIN_MOMENT_DURATION_MS` are
 * dropped rather than written — a flick between windows isn't a real
 * activity session — but the *entire* rollup (window titles, shell/git/
 * calendar/life-event context `momentRollup` (B4) accumulated during that
 * brief span) is handed back so the caller can seed whatever moment opens
 * *next* with it instead of losing that context outright ("merge into the
 * successor," not a silent drop, per B1's proposal text).
 */
/** The location bucket for the current network fingerprint (Phase 5 #6), or null when the fingerprint is unlabeled/unknown. */
function resolveLocation(state: KernelState): string | null {
  const fp = state.network.fingerprint;
  return fp ? (state.config.locationLabels[fp] ?? null) : null;
}

/**
 * Exit hysteresis: a brief, weakly-attributed moment inherits the project of the
 * span it interrupted instead of recording a switch away from it.
 *
 * The defect this addresses is A→B→A in the stored record — a 37-second glance at
 * a GitHub tab or a Jira ticket between two stretches of coding, which reads as
 * two context switches and fragments every per-project duration total. Measured
 * on the real corpus: 47 such reversals across 847 fully-attributed triples
 * (5.5%), and 83% of the interrupting moments were under two minutes.
 *
 * Two guards keep this from becoming the ambient attribution this codebase
 * deliberately removed (decisions/no-ambient-project-attribution):
 *
 * 1. Only a `weak` attribution can be absorbed. `editor-doc` and `shell-cwd` are
 *    `certain` — an open file is proof, and proof is never overridden by a
 *    heuristic. This is what the confidence tiers were modelled for.
 * 2. Only a `certain` neighbour can absorb. A span that was itself a guess has no
 *    standing to overwrite anything.
 *
 * The two together are narrow on purpose. Without them, 79% of moments are under
 * two minutes, so an unguarded duration rule would make nearly every moment
 * inherit its predecessor — ambient attribution by the back door, arrived at by a
 * different route.
 *
 * The result is recorded as `span-continuation` rather than silently taking the
 * neighbour's source, so the record still says how the project got there.
 */
function absorbBriefExcursion(
  projectId: string | null,
  rollup: MomentRollup,
  durationMs: number,
  lastClosed: KernelState['project']['lastClosedMoment'],
): { projectId: string | null; rollup: MomentRollup } {
  if (durationMs >= BRIEF_EXCURSION_MS) return { projectId, rollup };
  if (rollup.projectConfidence !== 'weak') return { projectId, rollup };
  if (!lastClosed || lastClosed.projectId === null || lastClosed.confidence !== 'certain') return { projectId, rollup };
  if (lastClosed.projectId === projectId) return { projectId, rollup };

  return {
    projectId: lastClosed.projectId,
    rollup: { ...rollup, projectSource: 'span-continuation', projectConfidence: 'weak' },
  };
}

/**
 * The known root that accumulated the most dev-activity events while the moment
 * was open, or null when none did. Ties break toward the lexically-first root so
 * the result is replay-deterministic (object key order is insertion order, which
 * depends on event order — fine — but a tie must not depend on it).
 */
function dominantDevActivityRoot(byProject: Record<string, number> | undefined): string | null {
  if (!byProject) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const root of Object.keys(byProject).sort()) {
    const count = byProject[root];
    if (count > bestCount) {
      best = root;
      bestCount = count;
    }
  }
  return best;
}

function closeMoment(
  moment: OpenMoment,
  endTs: string,
  currentProject: { id: string } | null,
  location: string | null,
  lastClosed: KernelState['project']['lastClosedMoment'],
  /** Passed in rather than read from `state`, like `location` and `currentProject` — this function deliberately never sees the whole state. */
  leisureRules: KernelState['config']['leisureRules'],
): { effects: Effect[]; carryOverRollup: MomentRollup | null; closed: KernelState['project']['lastClosedMoment'] } {
  if (Date.parse(endTs) - Date.parse(moment.startTime) < MIN_MOMENT_DURATION_MS) {
    // Dropped, not written — so it is not the "last closed moment" either. The
    // span it interrupted continues to be the thing a later excursion is judged
    // against.
    return { effects: [], carryOverRollup: moment.rollup, closed: lastClosed };
  }
  // W6 D1: the drop is judged on the moment's own span (which moments are written is unchanged);
  // the row covers the flicks merged into it too, whose work its rollup already holds.
  const startTime = moment.carriedFrom ?? moment.startTime;
  const durationMs = Math.max(0, Date.parse(endTs) - Date.parse(startTime));
  // `kind`/`focusScore`/`focusQuality` aren't part of `MomentRollup` (they're
  // closed-moment derivations, meaningless on a still-open moment) — computed
  // here, once, at write time and merged into the JSON blob. `focusScore` feeds
  // `computeMomentKind`'s `focus` decision, so it's computed first.
  const focusScore = computeFocusScore(moment.rollup, durationMs);

  // Phase 5 #4 — dev-activity attribution fallback. An editor moment often has
  // no window locator the per-window resolver can use (Code exposes no
  // AXDocument path, so `documentPath` is null and the moment closes
  // unattributed), yet its OWN git/shell activity happened in a real repo.
  // `momentRollup` tallies WHERE: each dev event's own cwd, resolved to a known
  // root, in `devActivityByProject` — so the fallback attributes to the repo the
  // activity demonstrably happened in, tagged `git-activity`/`weak`.
  //
  // The ambient `state.project.current` pointer is only consulted when the
  // moment carries owner-typed activity (commands/commits) whose cwd resolved
  // nowhere — never on `gitBranch` alone, because a background `git:status`
  // poll landing inside an unrelated foreground moment used to satisfy the old
  // `gitBranch !== null` trigger and hand the whole moment to whatever project
  // the pointer last held (a single stray `cd` mis-stamped 1.15 h one Sunday).
  const r = moment.rollup;
  const devRoot = dominantDevActivityRoot(r.devActivityByProject);
  const typedDevActivity = r.gitCommitCount > 0 || r.shellCommandCount > 0 || r.notableCommands.length > 0;
  const useFallback = moment.projectId === null && (devRoot !== null || (typedDevActivity && currentProject !== null));
  const fallbackProjectId = useFallback ? (devRoot ?? currentProject!.id) : moment.projectId;
  const fallbackRollup: MomentRollup = useFallback ? { ...r, projectSource: 'git-activity', projectConfidence: 'weak' } : r;

  const absorbed = absorbBriefExcursion(fallbackProjectId, fallbackRollup, durationMs, lastClosed);
  const projectId = absorbed.projectId;
  const rollup = absorbed.rollup;

  return {
    closed: { projectId, confidence: rollup.projectConfidence, endedAt: endTs, durationMs },
    effects: [
      {
        type: 'WriteDB',
        table: 'moments',
        row: {
          id: moment.id,
          startTime,
          endTime: endTs,
          durationMs,
          processName: moment.processName,
          data: { ...rollup, location, kind: computeMomentKind(rollup, focusScore, leisureRules), focusScore, focusQuality: focusQuality(focusScore), audioContext: computeAudioContext(rollup) },
          importanceScore: computeMomentImportance(durationMs, rollup),
          projectId,
        },
      },
    ],
    carryOverRollup: null,
  };
}

/**
 * The single writer of `state.moment` / the `moments` table. B1 grew this
 * rule from "close on every `window:changed`" to five real segmentation
 * triggers:
 *
 * 1. **`window:changed` with a process or project change** (or entering/
 *    leaving a system-process gap, unchanged from before) — a real boundary.
 *    A same-process, same-project title change (a tab switch, a file
 *    switch within the same editor) no longer closes anything; it appends
 *    the new title to the open moment's `rollup.windowTitles` (deduped,
 *    capped at `MAX_ROLLUP_TITLES`) instead.
 * 2. **`idle:start`** (`idleTrack`, B3) — closes the open moment into a gap,
 *    exactly like the existing system-process gap: `state.moment` becomes
 *    `null`, nothing new opens.
 * 3. **`idle:end`** — if a real (non-system-process) window is currently
 *    active (`state.window.active`, tracked by `windowTrack`) and nothing's
 *    open, opens a fresh moment for it. Needed because resuming activity in
 *    the *same* window that was focused before going idle fires no
 *    `window:changed` at all — without this, that gap would never end on
 *    its own.
 * 4. **`clock:tick`** with the open moment older than `MAX_MOMENT_DURATION_MS`
 *    — splits it: closes and writes the current span, opens a fresh moment
 *    for the same process/project so one very long session doesn't become
 *    one giant, never-analyzed row (`momentAnalysisSchedule` only
 *    fire on close).
 * 5. **`system:sleep-wake`** (C1, fixes A§4.1's "system:sleep-wake → idle/
 *    moment boundary") — `kind: 'sleep'` closes into a gap exactly like
 *    `idle:start` (the same `closeIntoGap` helper); `kind: 'wake'` reopens
 *    from the currently-active window exactly like `idle:end` (the same
 *    `reopenFromActiveWindow` helper). A sleep/wake cycle is definitionally
 *    a period the user wasn't at the machine — the sensor was already
 *    running and captured every real transition, it just had no consumer.
 *
 * Live-tested finding (2026-07-17, predates B1): `loginwindow`/
 * `ScreenSaverEngine` (screen lock/screensaver) were never filtered — every
 * lock period became its own real, LLM-eligible moment. Ported WCS's
 * behavior of a genuine gap (`state.moment: null`, nothing opened) rather
 * than a mislabeled moment for the system process.
 */
interface SleepWakePayload {
  kind?: string;
}

function closeIntoGap(state: KernelState, event: SanitizedEvent): { state: KernelState; effects: Effect[] } {
  if (!state.moment) return { state, effects: [] };
  const { effects, closed } = closeMoment(state.moment, event.ts, state.project.current, resolveLocation(state), state.project.lastClosedMoment, state.config.leisureRules);
  return { state: { ...state, moment: null, project: { ...state.project, lastClosedMoment: closed } }, effects };
}

function reopenFromActiveWindow(state: KernelState, event: SanitizedEvent): { state: KernelState; effects: Effect[] } {
  if (state.moment) return { state, effects: [] };
  const active = state.window.active;
  if (!active || isSystemProcess(active.processName)) return { state, effects: [] };
  // Reopening the same window that was focused before the gap — no fresh
  // `window:changed`, so reuse the attribution `windowTrack` last resolved.
  return { state: { ...state, moment: openNewMoment(event, active.processName, active.windowTitle, state.window.attribution) }, effects: [] };
}

/**
 * RECONCILIATION — closes a moment that was left open across an interval the
 * daemon did not observe, at the last instant it DID observe rather than at
 * "now".
 *
 * This runs for every event, before any of the segmentation triggers below, and
 * that breadth is the point. An earlier version of this ran only on `clock:tick`
 * and did not work: the first event after a sleep is very often a
 * `window:changed`, whose own handler closes the open moment at its timestamp and
 * therefore credits the entire sleep to it before any tick arrives. Measured
 * against a full replay, gating on ticks alone still left 6 moments over three
 * hours and a longest of 56.8 hours.
 *
 * The detector is the event stream's own continuity. Every event proves the
 * daemon was alive at its timestamp, so a gap between consecutive events is a
 * gap in observation — no separate heartbeat to trust, and specifically NOT
 * `system:sleep-wake`, which was measured unbalanced at 587 sleeps against 726
 * wakes. `clock:tick` keeps the stream dense during quiet periods, so a gap here
 * means the daemon really was not running.
 *
 * Nothing reopens. After an unobserved interval the daemon does not know what is
 * focused, and inventing a successor is precisely the ambient-attribution
 * guess this codebase removed on purpose. The event being processed opens a
 * fresh moment if it is the kind of event that does that.
 */
function reconcileObservationGap(state: KernelState, event: SanitizedEvent): { state: KernelState; effects: Effect[] } {
  const lastObservedAt = state.observation.lastObservedAt;
  const observed = { ...state, observation: { lastObservedAt: event.ts } };
  if (lastObservedAt === null) return { state: observed, effects: [] };

  const gapMs = Date.parse(event.ts) - Date.parse(lastObservedAt);
  if (gapMs <= MAX_OBSERVATION_GAP_MS || !state.moment) return { state: observed, effects: [] };

  const { effects } = closeMoment(state.moment, lastObservedAt, state.project.current, resolveLocation(state), state.project.lastClosedMoment, state.config.leisureRules);
  // `lastClosedMoment` is cleared, not carried: whatever was open before an
  // interval the daemon did not watch cannot vouch for what appears after it, so
  // the next brief excursion is judged on its own merits.
  return { state: { ...observed, moment: null, project: { ...observed.project, lastClosedMoment: null } }, effects };
}

export const momentClose: Rule = (state, event) => {
  const pre = reconcileObservationGap(state, event);
  const s = pre.state;
  /** Prepends any reconciliation write, so a gap-close is never lost to the branch that follows it. */
  const withPre = (r: { state: KernelState; effects: Effect[] }) => ({ state: r.state, effects: [...pre.effects, ...r.effects] });

  if (event.type === 'idle:start') return withPre(closeIntoGap(s, event));
  if (event.type === 'idle:end') return withPre(reopenFromActiveWindow(s, event));

  if (event.type === 'system:sleep-wake') {
    const kind = (event.payload as SleepWakePayload).kind;
    if (kind === 'sleep') return withPre(closeIntoGap(s, event));
    if (kind === 'wake') return withPre(reopenFromActiveWindow(s, event));
    return { state: s, effects: pre.effects };
  }

  if (event.type === 'clock:tick') {
    if (!s.moment) return { state: s, effects: pre.effects };
    const openMs = Date.parse(event.ts) - Date.parse(s.moment.startTime);
    if (openMs < MAX_MOMENT_DURATION_MS) return { state: s, effects: pre.effects };
    const { effects, closed } = closeMoment(s.moment, event.ts, s.project.current, resolveLocation(s), s.project.lastClosedMoment, s.config.leisureRules);
    const currentTitle = s.window.active?.windowTitle ?? '';
    // A max-duration split continues the same activity — keep the active
    // window's current attribution rather than re-resolving from a tick.
    return {
      state: { ...s, moment: openNewMoment(event, s.moment.processName, currentTitle, s.window.attribution), project: { ...s.project, lastClosedMoment: closed } },
      effects: [...pre.effects, ...effects],
    };
  }

  if (event.type !== 'window:changed') return { state: s, effects: pre.effects };

  const locator = locatorFromEvent(event);
  const { processName, windowTitle } = locator;
  const enteringGap = isSystemProcess(processName);
  const attribution = resolveAttribution(s, locator);

  if (!s.moment) {
    // Already in a gap (or first boot) and the new window is ALSO a system
    // process — stay in the gap, nothing to open or close.
    if (enteringGap) return { state: s, effects: pre.effects };
    return { state: { ...s, moment: openNewMoment(event, processName, windowTitle, attribution) }, effects: pre.effects };
  }

  const open = s.moment;
  if (!isMomentClosingBoundary(s, event)) {
    return {
      state: { ...s, moment: { ...open, rollup: { ...open.rollup, windowTitles: addTitle(open.rollup.windowTitles, windowTitle) } } },
      effects: pre.effects,
    };
  }

  const { effects, carryOverRollup, closed } = closeMoment(open, event.ts, s.project.current, resolveLocation(s), s.project.lastClosedMoment, s.config.leisureRules);
  const nextMoment = enteringGap ? null : openNewMoment(event, processName, windowTitle, attribution, carryOverRollup, carryOverRollup ? (open.carriedFrom ?? open.startTime) : null);
  return { state: { ...s, moment: nextMoment, project: { ...s.project, lastClosedMoment: closed } }, effects: [...pre.effects, ...effects] };
};

/**
 * The `moments` row this event is about to write, or null when it closes nothing.
 *
 * This is what the "runs before `momentClose`" sibling rules
 * (`momentAnalysisSchedule`, `embeddingIndex`) ask instead of re-deriving the
 * close decision themselves. It asks `momentClose` rather than restating its
 * branches, because restating them is exactly what went wrong before:
 * `isMomentClosingBoundary` extracted only the `window:changed` branch, and the
 * siblings that adopted it therefore learned about one of the five triggers this
 * rule actually closes on. Measured against a 41-day live record, moments closed
 * by the other four — `idle:start`, sleep, the `MAX_MOMENT_DURATION_MS` tick
 * split, and `reconcileObservationGap` — were never analyzed and never embedded:
 * 0 of 10 moments over thirty minutes had a narrative or a vector, against 95%
 * of the sub-minute ones. The long undisturbed sessions are the ones most worth
 * retrieving, and they were the ones missing. The tick-split branch's own doc
 * comment above claims it exists so a long session does not become "one giant,
 * never-analyzed row" — that intent was never actually delivered.
 *
 * Returning the row rather than a boolean also hands back the authoritative id
 * and `durationMs`, and folds in the `MIN_MOMENT_DURATION_MS` drop for free: a
 * moment too thin to be written produces no row, so a caller cannot schedule
 * work against a moment that will never exist. Callers no longer re-check the
 * floor, and no longer compute duration from `event.ts`, which was wrong for a
 * reconciled gap-close (that one ends at `lastObservedAt`, not at now).
 *
 * `momentClose` is a pure function of `(state, event)`, so calling it a second
 * time costs one fold's worth of arithmetic and no side effects. The returned
 * state is deliberately discarded — `momentClose` itself remains the single
 * writer of `state.moment` and of the `moments` table.
 */
export function closingMomentRow(state: KernelState, event: SanitizedEvent): MomentRow | null {
  for (const effect of momentClose(state, event).effects) {
    if (effect.type === 'WriteDB' && effect.table === 'moments') return effect.row;
  }
  return null;
}
