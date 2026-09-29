/**
 * Drift (use case 8): slow weekly trends the owner cannot feel from one day to
 * the next — when the day ends, weekend work, meeting load, switches per day,
 * late commits.
 *
 * Pure. `driftTrack` (packages/rules) folds the log into `state.drift.days`;
 * this module turns those days into weeks and decides whether a trend has
 * held. The read tool `gnomon_drift` and any weekly surface call the same
 * functions, so the tool and the notice cannot disagree.
 *
 * Days are WAKING days (04:00 to 04:00, `wakingDate`), so work carried past
 * midnight stays on the day it belongs to. A moment is filed by its start day
 * and clips at midnight; this is measured from the log instead.
 */

/** One waking day, as `driftTrack` folds it. Minutes are waking minutes: 0 is 04:00. */
export interface DriftDay {
  /** First and last `input:activity` window with real input. */
  first: number | null;
  last: number | null;
  /** `input:activity` windows with real input — one per ~10 s, so `active / 6` is minutes. */
  active: number;
  /** `event:context-switch` count. */
  switches: number;
  /** `git:commit` between 22:00 and 04:00. */
  late: number;
  /** Scheduled minutes of timed meetings that ran (`calendar:active`), each meeting once. */
  meetingMin: number;
}

export interface DriftState {
  days: Record<string, DriftDay>;
  /** Short hashes of calendar event ids already counted. Bounded. */
  meetings: string[];
  /** The waking week (its Monday) last checked for held trends. */
  checkedWeek: string | null;
  /** The trends that held at the last check, `metric → direction`. A trend speaks when it starts to hold, not every week it goes on. */
  holding: Record<string, 'up' | 'down'>;
}

export const DRIFT_METRICS = ['dayEnd', 'weekendMin', 'meetingMin', 'switchesPerDay', 'lateCommits'] as const;
export type DriftMetric = (typeof DRIFT_METRICS)[number];

/** Thirty active minutes: a day under this is a glance at the machine, not a working day. */
export const ACTIVE_DAY_EMITS = 180;
/** Thirteen weeks of days. The trend check reads seven. */
export const MAX_DRIFT_DAYS = 91;
export const MAX_DRIFT_MEETINGS = 256;
/** 22:00 as a waking minute. */
export const LATE_FROM_MIN = 18 * 60;
/** Weeks a change must hold, each one, before it is said. */
export const HOLD_WEEKS = 3;
/** Weeks before the held ones that make "normal"; at least `MIN_BASELINE_WEEKS` of them must have a value. */
export const BASELINE_WEEKS = 4;
export const MIN_BASELINE_WEEKS = 3;
/** A week's median or mean needs this many days behind it. */
export const MIN_DAYS_PER_WEEK = 3;
/** A week's total (weekend minutes, meetings, late commits) is only a total if the machine ran on this many of its days. */
export const MIN_PRESENT_DAYS = 5;

/**
 * The smallest change worth saying, per metric — defaults, not fitted. A week
 * must beat the baseline by `abs`, and by `rel` of it where given. Measure on
 * the record before moving them (see status-C.md).
 */
export const DRIFT_THRESHOLDS: Record<DriftMetric, { abs: number; rel?: number }> = {
  dayEnd: { abs: 30 },
  weekendMin: { abs: 60 },
  meetingMin: { abs: 60, rel: 0.25 },
  switchesPerDay: { abs: 5, rel: 0.2 },
  lateCommits: { abs: 3 },
};

export const EMPTY_DRIFT_DAY: DriftDay = { first: null, last: null, active: 0, switches: 0, late: 0, meetingMin: 0 };
export const EMPTY_DRIFT: DriftState = { days: {}, meetings: [], checkedWeek: null, holding: {} };

const DAY_MS = 86_400_000;
const dayMs = (day: string): number => Date.parse(`${day}T12:00:00.000Z`);
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** 0 = Sunday … 6 = Saturday, for a `YYYY-MM-DD` day. */
export function weekdayOf(day: string): number {
  return new Date(dayMs(day)).getUTCDay();
}

/** The Monday of a day's week, as `YYYY-MM-DD`. */
export function mondayOf(day: string): string {
  return dayOf(dayMs(day) - ((weekdayOf(day) + 6) % 7) * DAY_MS);
}

export function addDays(day: string, n: number): string {
  return dayOf(dayMs(day) + n * DAY_MS);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/** One week, every metric with the n it rests on. A metric is `null` when its n is too small to say anything. */
export interface DriftWeek {
  /** Monday, `YYYY-MM-DD`. */
  week: string;
  /** Days the machine reported anything. */
  present: number;
  /** Days with at least 30 active minutes. */
  activeDays: number;
  /** Median last active minute of the working weekdays (waking minutes), over `dayEndN` days. */
  dayEnd: number | null;
  dayEndN: number;
  /** Active minutes on Saturday and Sunday. */
  weekendMin: number | null;
  meetingMin: number | null;
  /** Mean context switches per active day, over `activeDays`. */
  switchesPerDay: number | null;
  lateCommits: number | null;
}

/** Every week the days touch, oldest first. */
export function weeklyDrift(days: Record<string, DriftDay>): DriftWeek[] {
  const byWeek = new Map<string, [string, DriftDay][]>();
  for (const [day, d] of Object.entries(days)) {
    const week = mondayOf(day);
    byWeek.set(week, [...(byWeek.get(week) ?? []), [day, d]]);
  }
  return [...byWeek.keys()].sort().map((week) => {
    const list = byWeek.get(week)!;
    const active = list.filter(([, d]) => d.active >= ACTIVE_DAY_EMITS);
    const workdays = active.filter(([day, d]) => weekdayOf(day) >= 1 && weekdayOf(day) <= 5 && d.last !== null);
    const present = list.length;
    // A total only means something for a week the owner worked: the machine ran on
    // most days AND some of them were working days. A holiday week reads as a
    // week of no meetings, which is not a baseline for meeting load.
    const full = present >= MIN_PRESENT_DAYS && active.length >= MIN_DAYS_PER_WEEK;
    const weekend = list.filter(([day]) => weekdayOf(day) === 0 || weekdayOf(day) === 6);
    return {
      week,
      present,
      activeDays: active.length,
      dayEnd: workdays.length >= MIN_DAYS_PER_WEEK ? median(workdays.map(([, d]) => d.last!)) : null,
      dayEndN: workdays.length,
      weekendMin: full ? Math.round(weekend.reduce((n, [, d]) => n + d.active, 0) / 6) : null,
      meetingMin: full ? Math.round(list.reduce((n, [, d]) => n + d.meetingMin, 0)) : null,
      switchesPerDay: active.length >= MIN_DAYS_PER_WEEK ? Math.round((active.reduce((n, [, d]) => n + d.switches, 0) / active.length) * 10) / 10 : null,
      lateCommits: full ? list.reduce((n, [, d]) => n + d.late, 0) : null,
    };
  });
}

export interface DriftTrend {
  metric: DriftMetric;
  direction: 'up' | 'down';
  /** The held weeks, oldest first, with their values. */
  held: { week: string; value: number }[];
  /** Median of the baseline weeks, and how many there were. */
  baseline: number;
  baselineWeeks: number;
}

/**
 * The trends that hold in the `HOLD_WEEKS` complete weeks before `currentWeek`:
 * each of those weeks beyond the baseline by the metric's threshold, the same
 * way. The baseline is the median of the `BASELINE_WEEKS` before them.
 */
export function heldTrends(weeks: DriftWeek[], currentWeek: string): DriftTrend[] {
  const at = new Map(weeks.map((w) => [w.week, w]));
  const heldWeeks = Array.from({ length: HOLD_WEEKS }, (_, i) => addDays(currentWeek, -7 * (HOLD_WEEKS - i)));
  const baseWeeks = Array.from({ length: BASELINE_WEEKS }, (_, i) => addDays(currentWeek, -7 * (HOLD_WEEKS + BASELINE_WEEKS - i)));
  const out: DriftTrend[] = [];
  for (const metric of DRIFT_METRICS) {
    const value = (week: string): number | null => at.get(week)?.[metric] ?? null;
    const held = heldWeeks.map((week) => ({ week, value: value(week) }));
    if (held.some((h) => h.value === null)) continue;
    const base = baseWeeks.map(value).filter((v): v is number => v !== null);
    if (base.length < MIN_BASELINE_WEEKS) continue;
    const baseline = median(base)!;
    const { abs, rel } = DRIFT_THRESHOLDS[metric];
    const beyond = (v: number, sign: 1 | -1) => sign * (v - baseline) >= abs && (rel === undefined || sign * (v - baseline) >= rel * Math.abs(baseline));
    for (const [direction, sign] of [
      ['up', 1],
      ['down', -1],
    ] as const) {
      if (held.every((h) => beyond(h.value!, sign))) out.push({ metric, direction, held: held as { week: string; value: number }[], baseline, baselineWeeks: base.length });
    }
  }
  return out;
}

/** A waking minute as the wall clock the owner reads. */
export function wakingClock(minutes: number): string {
  const m = (((Math.round(minutes) + 4 * 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function formatValue(metric: DriftMetric, v: number): string {
  if (metric === 'dayEnd') return wakingClock(v);
  if (metric === 'weekendMin' || metric === 'meetingMin') return v >= 90 ? `${Math.round((v / 60) * 10) / 10} h` : `${Math.round(v)} min`;
  if (metric === 'switchesPerDay') return `${Math.round(v)} a day`;
  return `${Math.round(v)}`;
}

const SAID: Record<DriftMetric, { up: string; down: string }> = {
  dayEnd: { up: 'Your working day has ended later', down: 'Your working day has ended earlier' },
  weekendMin: { up: 'You have worked more at weekends', down: 'You have worked less at weekends' },
  meetingMin: { up: 'Your meeting load has gone up', down: 'Your meeting load has gone down' },
  switchesPerDay: { up: 'You switch context more each day', down: 'You switch context less each day' },
  lateCommits: { up: 'You commit late at night more often', down: 'You commit late at night less often' },
};

/** The countable claim, in the owner's terms, with the weeks it rests on. */
export function driftSentence(t: DriftTrend): string {
  const now = t.held.map((h) => formatValue(t.metric, h.value)).join(', ');
  return `${SAID[t.metric][t.direction]} for ${t.held.length} weeks in a row: ${now}, against ${formatValue(t.metric, t.baseline)} in the ${t.baselineWeeks} weeks before.`;
}
