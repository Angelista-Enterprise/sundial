/**
 * The shape of the work, from the streams that were being thrown away.
 *
 * Three measures over five signal streams: how fragmented the day was, what
 * interrupted it, and whether the edit-run-commit loop was working. Each is a
 * plain count or a plain rate over rows the log already held — see
 * `@sundial/db/queries/work-shape.js` for the readers and why the streams sat
 * unread for so long.
 *
 * ## What is deliberately NOT here
 *
 * A "longest unbroken stretch" was built, measured, and removed. Defined as the
 * longest gap between two consecutive switches it returned its own 45-minute
 * ceiling on 13 of 19 real days, because the biggest gap on most days is the
 * overnight one. Gating it on active hours cut that to 12 of 19 — an hour counts
 * as active on a single keystroke, so a quiet fifty minutes inside a lunch hour
 * still scored as focus. A measure that reports its ceiling on two thirds of
 * days carries no information, and the system already has a real focus measure
 * per moment (`focusScore`, and `buildDailyContext().focus`). A second, worse
 * copy of an existing measure is worth less than no measure, so this one was
 * dropped rather than tuned further.
 *
 * ## Not a rule, on purpose
 *
 * This folds nothing and decides nothing, so per `RULE_MANIFEST`'s own closing
 * argument (and the precedent of `forecastDayEnd` and `buildDailyContext`) it is
 * a read-time analytic rather than a rule with a slice of `KernelState`. Two
 * concrete reasons beyond taste:
 *
 *  1. It works over history. A rule can only fold events from the moment it
 *     ships; this produces three weeks of numbers on its first call, which is
 *     what makes it usable as evidence rather than as a promise.
 *  2. It has to be recomputable. The point of these measures is to become
 *     candidate forecast TARGETS, and `measure-forecast-skill.ts` needs to
 *     recompute them per cross-validation fold. A number that only exists as
 *     accumulated state cannot be refitted on a held-out day.
 *
 * ## The denominator discipline
 *
 * Every rate here is per ACTIVE hour — an hour in which a key, click or scroll
 * was recorded — and never per wall-clock or per observed hour. The first
 * version of this file used observed hours and it was wrong in a way worth
 * keeping written down: `input:activity` emits on a fixed cadence whenever the
 * daemon is watching, so any day the lid stayed open scored 24 observed hours,
 * and dividing by that made an idle overnight machine look like a calm working
 * day. Deliberate-input hours give 8–18 on a real day.
 *
 * **That fix changed the filter and left the unit wrong, for weeks.** Both hour
 * figures went on COUNTING hours a row appeared in rather than weighing them:
 * an hour the daemon watched for eight minutes and one it watched for sixty
 * were each "1 hour". So `observedHours` stayed a flat 24 on every day of the
 * record, and the Shape card printed it. Each hour now carries its own emit
 * count and contributes `min(1, emits / EMITS_PER_FULL_HOUR)`; on 2026-09-19
 * the two figures go from 20 and 3 to 1.3 and 1.1. Weighing only the observed
 * side would have been worse than leaving it — a sparse day could then report
 * more active hours than observed ones, which is impossible — so both take the
 * same share and `activeHours <= observedHours` holds by construction.
 *
 * The denominator is published beside every rate rather than hidden inside it,
 * `lowConfidence` marks days too thin to read, and `inputBlind` marks the days
 * where the two denominators disagree — a lost Input Monitoring grant, which
 * must not render as a quiet day.
 */
import { localDate, localHour } from '@sundial/helpers/local-day.js';
import type { ActivityHourRow, CommitRow, ContextSwitchRow, InterruptionRow, ShellRunRow, ThrashingRow } from '@sundial/db/index.js';

/**
 * Below this many active hours, a day's rates are noise dressed as a finding.
 * Two hours is roughly a quarter of a working day — enough to state a count
 * honestly, not enough to state a rate about the day as a whole.
 */
const MIN_ACTIVE_HOURS = 2;

/**
 * Emits in a fully-watched hour. `input:activity` accumulates the Swift
 * helper's 1s snapshots into a 10s emit window, so a whole hour holds about
 * 360 of them whether or not anyone is at the desk.
 *
 * A second copy of `EMITS_PER_FULL_HOUR` in `packages/rules/coverage-track.ts`,
 * because `packages/kernel` cannot import from `packages/rules`. Held equal by
 * *work-shape.test.js*: two cadences for one sensor would give two answers to
 * "how long was Gnomon watching".
 */
export const EMITS_PER_FULL_HOUR = 360;

/** Hours to one decimal. A watched duration to three places implies a precision the 10s cadence does not have. */
const round1 = (hours: number): number => Math.round(hours * 10) / 10;

export interface WorkShapeDay {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /**
   * Hours the daemon was actually watching — uptime, NOT the owner's day.
   *
   * A weighed duration, not a count of hours it appeared in: see the note on
   * the denominator above. To one decimal, because the sensor's 10s cadence
   * does not support a third place.
   */
  observedHours: number;
  /** Watched hours holding deliberate input — the denominator for every rate below. Never above `observedHours`. */
  activeHours: number;
  /** True when `activeHours` is too thin for the rates to mean anything. */
  lowConfidence: boolean;
  /**
   * The daemon watched this day but recorded no human input at all.
   *
   * Almost always a lost Input Monitoring grant rather than a day off, so it is
   * reported as a distinct state instead of as a zero — a broken sensor and an
   * idle owner must never render the same.
   */
  inputBlind: boolean;
  /** Every recorded switch between two pieces of work. */
  switches: number;
  /** Of those, switches that stayed inside the SAME app — new work, same window. */
  sameAppSwitches: number;
  /** Of those, switches between two branches of one project rather than between projects. */
  branchSwitches: number;
  /** Switches per active hour, rounded to one decimal. Null when `lowConfidence`. */
  switchesPerHour: number | null;
  /** Bursts of rapid window flipping. */
  thrashingBursts: number;
  /**
   * Raw window events summed across those bursts — how hard, against how often.
   *
   * Read this with `thrashingFlips` beside it or not at all. 56% of
   * `window:changed` events are one app re-titling its own window, so this
   * number counts a terminal running a build as intensity; it is kept because
   * the rows written before 2026-09-22 carry nothing else.
   */
  thrashingSwitches: number;
  /**
   * App-to-app flips summed across those bursts — the corrected measure.
   *
   * Zero for a day whose bursts all predate the fix, which is why
   * `thrashingBurstsMeasured` says how many of the day's bursts could supply
   * one. A reader must not take a zero here as a calm day.
   */
  thrashingFlips: number;
  /** Of `thrashingBursts`, how many carry the corrected `flips` measure. */
  thrashingBurstsMeasured: number;
  /** Recorded interruptions. */
  interruptions: number;
  /** Shell commands observed. */
  shellRuns: number;
  /** Of those, the ones that exited non-zero. */
  shellFailures: number;
  /** Longest run of consecutive failing commands — a stuck loop, not just a bad day. */
  worstFailureStreak: number;
  commits: number;
  filesChanged: number;
  /**
   * MEDIAN lines changed per commit — insertions plus deletions, 0 when nothing
   * landed.
   *
   * A median rather than a sum, and that is the whole point of this field. The
   * summed version was built first and it was worthless: one commit in the real
   * corpus carries 11,673,416 insertions across 6,644 files (a generated blob),
   * which is 99.6% of its day's total, and merge commits routinely add another
   * 150,000. A day's summed churn therefore reports whether a generated file or
   * a merge happened to land, not how much work was done.
   */
  medianCommitChurn: number;
  /** Lines changed by the day's BIGGEST commit — published so the skew a median hides stays visible. */
  largestCommitChurn: number;
}

export interface WorkShapeSuspect {
  /** App that held a pending badge when an interruption was recorded. A SUSPECT, never a proven cause. */
  app: string;
  /** Interruptions this app was present for. */
  present: number;
}

export interface WorkShape {
  from: string;
  to: string;
  timeZone: string;
  /** Oldest first, one row per local day that had any observed activity. */
  days: WorkShapeDay[];
  /** Switches summed by local hour, 0–23 — where the day actually comes apart. */
  switchesByHour: { hour: number; switches: number }[];
  /** Apps most often present at an interruption, heaviest first. Correlation only — see `WorkShapeSuspect`. */
  suspects: WorkShapeSuspect[];
  /** Whole-range totals, so a reader is not left summing the table by eye. */
  totals: {
    days: number;
    observedHours: number;
    activeHours: number;
    /** Days the daemon watched but recorded no input — almost certainly a permission problem. */
    inputBlindDays: number;
    switches: number;
    sameAppSwitches: number;
    branchSwitches: number;
    thrashingBursts: number;
    interruptions: number;
    shellRuns: number;
    shellFailures: number;
    commits: number;
    /** Non-zero exits over all runs, rounded to three decimals. Null when nothing ran. */
    shellFailureRate: number | null;
    /** Switches per active hour across the range. Null when nothing was active. */
    switchesPerHour: number | null;
  };
}

export interface WorkShapeInput {
  from: string;
  to: string;
  timeZone: string;
  /** One row per hour of activity, flagged for deliberate input — the honest denominator. */
  activityHours: ActivityHourRow[];
  switches: ContextSwitchRow[];
  thrashing: ThrashingRow[];
  interruptions: InterruptionRow[];
  shellRuns: ShellRunRow[];
  commits: CommitRow[];
}

/** An empty day row, so every measure has a defined value before any stream is folded in. */
function emptyDay(date: string): WorkShapeDay {
  return {
    date,
    observedHours: 0,
    activeHours: 0,
    lowConfidence: true,
    inputBlind: false,
    switches: 0,
    sameAppSwitches: 0,
    branchSwitches: 0,
    switchesPerHour: null,
    thrashingBursts: 0,
    thrashingSwitches: 0,
    thrashingFlips: 0,
    thrashingBurstsMeasured: 0,
    interruptions: 0,
    shellRuns: 0,
    shellFailures: 0,
    worstFailureStreak: 0,
    commits: 0,
    filesChanged: 0,
    medianCommitChurn: 0,
    largestCommitChurn: 0,
  };
}

/** Middle value of a sorted-in-place copy; the lower of the two middles on an even count. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * A project key is either a path (`~/Projects/sundial`) or a `project@branch`
 * pair; this is the project half of either form.
 *
 * Measured over the real corpus: 45 of 2,426 switches carry the `@branch` form,
 * and every one of those 45 is a move between two branches of ONE project. That
 * is a genuinely different event from moving between two projects — the same
 * subject from a different angle — and it is the only sub-category of switch in
 * this stream that is not a restatement of the total.
 *
 * The first version of this file counted "switches where both sides are known
 * and differ" as its headline sub-measure, on the reasonable assumption that
 * unattributed activity would make many of them null. It does not: the sensor
 * only emits when the project actually changes, and both sides are non-null on
 * all 2,426 rows. So that column came out exactly equal to the total on every
 * single day, which is how a duplicate column announces itself. Worth
 * remembering as a checking habit — the missingness guard was correct in
 * principle and simply had no missingness to guard against in THIS stream.
 */
function projectOf(key: string | null): string | null {
  if (key === null) return null;
  const at = key.indexOf('@');
  return at === -1 ? key : key.slice(0, at);
}

/**
 * A move between two branches of one project rather than between two projects.
 * Rows before 2026-09-28 carry `name@branch` on both sides; later rows carry the
 * project's id on both sides (the branches ride as `fromBranch`/`toBranch`), and
 * a switch between projects never has the same project on both sides.
 */
function isBranchSwitch(row: ContextSwitchRow): boolean {
  const from = projectOf(row.fromProject);
  return from !== null && from === projectOf(row.toProject);
}

/** Round to `places`, returning a number rather than a string so the wire type stays numeric. */
function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Builds every measure in one pass per stream.
 *
 * Pure: takes rows and a zone, returns numbers, touches no IO and no clock. That
 * is what lets `measure-forecast-skill.ts` call it on an arbitrary subset of days
 * when these measures graduate into forecast targets.
 */
export function buildWorkShape(input: WorkShapeInput): WorkShape {
  const { timeZone } = input;
  const byDate = new Map<string, WorkShapeDay>();
  const dayFor = (ts: string): WorkShapeDay => {
    const date = localDate(ts, timeZone);
    let day = byDate.get(date);
    if (!day) {
      day = emptyDay(date);
      byDate.set(date, day);
    }
    return day;
  };

  // The denominator first, so a rate can never be computed before the hours it
  // divides by are known — and WEIGHED, not counted.
  //
  // **Both hour figures were presence dressed as duration.** An hour appeared
  // in this map if a single `input:activity` emit landed in it, so an hour the
  // daemon watched for eight minutes and one it watched for sixty both counted
  // as "1 hour". `input:activity` fires on a fixed ~10s cadence whenever the
  // daemon is up, so `observedHours` came out a flat **24 on every day of the
  // record** — a claim that the daemon watched every hour of every one of them
  // — and `activeHours` overstated by the same mechanism one filter down. On
  // 2026-09-19 the two read 20 and 3 where the log says 1.3 and 1.1.
  //
  // Weighing `observedHours` alone would have been worse than leaving it: a
  // sparse day could then report more ACTIVE hours than observed ones, which is
  // impossible — input cannot be recorded in a minute nobody was watching. So
  // both take the same share, which makes `activeHours <= observedHours` true
  // by construction rather than by luck.
  const observed = new Map<string, number>();
  const active = new Map<string, number>();
  const bump = (into: Map<string, number>, date: string, share: number): void => {
    into.set(date, (into.get(date) ?? 0) + share);
  };
  for (const row of input.activityHours) {
    const date = localDate(row.ts, timeZone);
    // Clamped at one: a burst of emits cannot buy back an hour nobody was
    // there for, and a restart can double-count a minute.
    const share = Math.min(1, (row.emits ?? 0) / EMITS_PER_FULL_HOUR);
    bump(observed, date, share);
    if (row.active) bump(active, date, share);
  }
  for (const [date, watched] of observed) {
    const day = byDate.get(date) ?? emptyDay(date);
    const activeHours = round1(active.get(date) ?? 0);
    day.observedHours = round1(watched);
    day.activeHours = activeHours;
    day.lowConfidence = activeHours < MIN_ACTIVE_HOURS;
    day.inputBlind = activeHours === 0 && watched > 0;
    byDate.set(date, day);
  }
  const switchesByHour = new Array<number>(24).fill(0);
  for (const row of input.switches) {
    const day = dayFor(row.ts);
    day.switches += 1;
    if (row.fromProcess !== null && row.fromProcess === row.toProcess) day.sameAppSwitches += 1;
    if (isBranchSwitch(row)) day.branchSwitches += 1;
    switchesByHour[localHour(row.ts, timeZone)] += 1;
  }

  for (const row of input.thrashing) {
    const day = dayFor(row.ts);
    day.thrashingBursts += 1;
    day.thrashingSwitches += row.switchCount;
    if (row.flips !== null) {
      day.thrashingFlips += row.flips;
      day.thrashingBurstsMeasured += 1;
    }
  }

  const suspectCounts = new Map<string, number>();
  for (const row of input.interruptions) {
    dayFor(row.ts).interruptions += 1;
    // `detail` for a notification cause is a comma-joined app list. Present at
    // the scene, nothing more.
    for (const app of (row.detail ?? '').split(',').map((part) => part.trim())) {
      if (app === '') continue;
      suspectCounts.set(app, (suspectCounts.get(app) ?? 0) + 1);
    }
  }

  // Failure streaks are per day and in time order, which is why the readers
  // return rows sorted ascending — a streak computed over shuffled rows would be
  // a count of failures wearing a streak's name.
  const streakState = new Map<string, number>();
  for (const row of input.shellRuns) {
    const day = dayFor(row.ts);
    day.shellRuns += 1;
    // A null exit code means the witness never saw the command finish — neither
    // a success nor a failure, so it breaks a streak without extending it.
    if (row.exitCode === null) {
      streakState.set(day.date, 0);
      continue;
    }
    if (row.exitCode === 0) {
      streakState.set(day.date, 0);
      continue;
    }
    day.shellFailures += 1;
    const streak = (streakState.get(day.date) ?? 0) + 1;
    streakState.set(day.date, streak);
    day.worstFailureStreak = Math.max(day.worstFailureStreak, streak);
  }

  const churnByDate = new Map<string, number[]>();
  for (const row of input.commits) {
    const day = dayFor(row.ts);
    day.commits += 1;
    day.filesChanged += row.filesChanged;
    const churn = row.insertions + row.deletions;
    const all = churnByDate.get(day.date) ?? [];
    all.push(churn);
    churnByDate.set(day.date, all);
    day.largestCommitChurn = Math.max(day.largestCommitChurn, churn);
  }
  for (const [date, churns] of churnByDate) {
    const day = byDate.get(date);
    if (day) day.medianCommitChurn = median(churns);
  }

  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of days) {
    day.switchesPerHour = day.lowConfidence ? null : round(day.switches / day.activeHours, 1);
  }

  const sum = (pick: (day: WorkShapeDay) => number): number => days.reduce((total, day) => total + pick(day), 0);
  // Rounded again after summing. A column of one-decimal hours adds up to
  // 194.09999999999997 in binary floating point, and a total is a thing the
  // page prints.
  const observedHours = round1(sum((d) => d.observedHours));
  const activeHours = round1(sum((d) => d.activeHours));
  const shellRuns = sum((d) => d.shellRuns);
  const switches = sum((d) => d.switches);

  return {
    from: input.from,
    to: input.to,
    timeZone,
    days,
    switchesByHour: switchesByHour.map((count, hour) => ({ hour, switches: count })),
    suspects: [...suspectCounts.entries()]
      .map(([app, present]) => ({ app, present }))
      .sort((a, b) => b.present - a.present)
      .slice(0, 8),
    totals: {
      days: days.length,
      observedHours,
      activeHours,
      inputBlindDays: days.filter((day) => day.inputBlind).length,
      switches,
      sameAppSwitches: sum((d) => d.sameAppSwitches),
      branchSwitches: sum((d) => d.branchSwitches),
      thrashingBursts: sum((d) => d.thrashingBursts),
      interruptions: sum((d) => d.interruptions),
      shellRuns,
      shellFailures: sum((d) => d.shellFailures),
      commits: sum((d) => d.commits),
      shellFailureRate: shellRuns === 0 ? null : round(sum((d) => d.shellFailures) / shellRuns, 3),
      switchesPerHour: activeHours === 0 ? null : round(switches / activeHours, 1),
    },
  };
}
