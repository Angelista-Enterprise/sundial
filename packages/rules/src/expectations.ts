import { localDate, wakingDate, wakingMinute } from '@sundial/helpers/local-day.js';
import { classifyActivity } from '@sundial/helpers/window-classification.js';
import type { KernelState, Recurrence, RecurrenceBucket, SanitizedEvent } from '@sundial/kernel/types.js';

/**
 * What counts as a recurrence.
 *
 * Adding one is a line in this table — never a new rule. That is the difference
 * between this and the shape the noticing surface started with, where every pattern
 * needed its own detector and so only one ever got built.
 *
 * `valueHalfLifeMs` is declared here rather than computed, because whoever knows
 * what a stream IS knows whether saying it late is useless. It is the only input to
 * channel choice: a missed break is worth mentioning within the hour and worthless
 * tomorrow; a repository gone quiet reads the same next week.
 */
export interface OccurrenceStream {
  key: string;
  /** Coarsest bucket that still separates genuinely different rhythms. See `Recurrence.key`. */
  bucket: RecurrenceBucket;
  valueHalfLifeMs: number | null;
  /**
   * Gaps longer than this are session boundaries, not intervals, and are not learned.
   *
   * Without it a break stream folds every overnight gap into its mean and learns "a
   * break every 5.5 hours" from a rhythm that is really every 75 minutes — measured at
   * 329 minutes against a true 75 on the synthetic corpus, which then made a genuine
   * six-hour stretch with no break look perfectly normal. The absence detector was
   * silent for the whole planted case because of this one omission.
   *
   * `fit-corpus-distributions.ts` applies the same 12-hour filter when measuring break
   * gaps from real data, for exactly the same reason.
   */
  maxGapMs: number;
  /**
   * Occurrences closer together than this are the SAME occurrence.
   *
   * The "derive, don't count" rule, enforced. A leisure block produces one
   * `window:changed` every few minutes, so counting them raw measures the gap between
   * consecutive leisure WINDOWS rather than between leisure SESSIONS — measured at a
   * 273-minute "usual gap" for something that really happens about once a day, which
   * made a nine-day drought unremarkable.
   *
   * The same hazard applies to any stream fed by a sampled or repeated signal, which is
   * most of the interesting ones: meetings re-emit per moment, video calls are sampled
   * booleans, a repository is touched on every window change.
   */
  minSessionGapMs: number;
  /**
   * Whether an absence claim requires the owner to be at the machine.
   *
   * True for within-day rhythms, false for multi-day ones. "No break in six hours" is
   * meaningless while they are asleep — and it fired every single night before this
   * existed, because the last break of the day is always hours old by midnight. "No day
   * off in twelve days" is true whether or not anyone is at the keyboard right now.
   */
  requiresPresence: boolean;
  /**
   * Minimum coverage over the overdue window before an absence may be claimed.
   *
   * Per-stream because the streams differ in how much they need to have been
   * watched. "No break in six hours" is a claim about six observed hours and
   * collapses without them; "this repository has been quiet eleven days" survives a
   * patchy fortnight, because a touch would have left a durable trace whenever the
   * daemon did happen to be up.
   */
  minCoverage: number;
  /** Does this event, in this state, count as one occurrence of the stream? */
  matches(state: KernelState, event: SanitizedEvent): boolean;
  /** Per-subject suffix, for streams that track many things (a repo, a person). `null` = one global stream. */
  subject?(state: KernelState, event: SanitizedEvent): string | null;
  /**
   * A DECLARED interval, used only when there is not enough evidence to learn one.
   *
   * Some occurrences are rare by nature, and a learned interval needs a long history of
   * them. Measured on the synthetic corpus: the `officer` persona logged 3 leisure
   * sessions in sixty days, under the six-occurrence floor, so the stream correctly
   * refused to claim anything — which is honest, and also means the detector can never
   * fire for anyone whose downtime rarely happens at the machine. That is exactly the
   * population the claim matters most for.
   *
   * A declared floor is a different KIND of claim and is labelled as such in the evidence:
   * not "I learned you rest every two days" but "rest has not happened in a fortnight,
   * against an expectation of once a week". It still requires at least one observed
   * occurrence, so Gnomon never asserts a rhythm for something it has never seen at all.
   */
  expectedEveryMs?: number;
  /** Human phrasing for an absence. Countable facts only — never a state no sensor observes. */
  describeAbsence(gapMs: number, r: Recurrence): string;
  /** Human phrasing for a drift. */
  describeDrift?(perDayMs: number, r: Recurrence): string;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function fmtDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs >= DAY) {
    const days = Math.round(abs / DAY);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (abs >= HOUR) {
    const hours = Math.round((abs / HOUR) * 10) / 10;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${Math.max(1, Math.round(abs / MINUTE))} min`;
}

const isWeekend = (ts: string, timezone: string): boolean => {
  const day = new Date(`${localDate(ts, timezone)}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

/** The bucket an event falls in, for a stream that asked to be conditioned. */
export function bucketFor(stream: OccurrenceStream, ts: string, timezone: string): RecurrenceBucket {
  if (stream.bucket === 'any') return 'any';
  return isWeekend(ts, timezone) ? 'weekend' : 'weekday';
}

/**
 * The streams, all backed by signals the log actually carries — verified against a
 * 23-day corpus rather than assumed. Three deliberate omissions are as informative
 * as the inclusions:
 *
 * - **No sleep stream.** `system:sleep-wake` looks like the obvious source and is
 *   not: its 70 rows are two-to-five-minute DISPLAY sleeps (`gapSeconds` 157-648),
 *   not nights. The day boundary below is derived from activity instead.
 * - **No "left home" stream.** `location:network` produced 3 events in four days.
 *   It would be admitted by this table and then correctly silenced by
 *   `MIN_OCCURRENCES`, so adding it buys nothing until the sensor produces data.
 * - **No raw thrashing stream.** `event:thrashing` fires thousands of times;
 *   `measure-proactivity-triggers.ts` already disqualified it as a direct trigger.
 *   Fragmentation belongs in a day-level comparison, not an occurrence stream.
 */
export const OCCURRENCE_STREAMS: OccurrenceStream[] = [
  {
    key: 'break',
    bucket: 'any',
    // Worth saying within the hour, worthless tomorrow.
    valueHalfLifeMs: 45 * MINUTE,
    // A break rhythm is a within-day rhythm; anything longer is the end of a day.
    maxGapMs: 12 * HOUR,
    // `idle:start` already fires once per idle period, so nothing to dedupe.
    minSessionGapMs: 0,
    requiresPresence: true,
    // The strictest floor in the table: this is precisely the claim that collapses
    // without observation, since not-watching and not-resting look identical.
    minCoverage: 0.6,
    // `idle:start` and not an activity gap. `idleTrack` requires 30 consecutive
    // zero-input windows (~5 min) WHILE the daemon watches, so it proves nothing
    // happened. An emission gap only proves nothing was recorded.
    matches: (_state, event) => event.type === 'idle:start',
    describeAbsence: (gapMs, r) => `${fmtDuration(gapMs)} without a break, against a usual gap of ${fmtDuration(r.intervalMs.mean)}`,
  },
  {
    key: 'day-off',
    bucket: 'any',
    valueHalfLifeMs: null,
    // Weeks, since the thing being measured is how often a whole day is taken off.
    maxGapMs: 30 * DAY,
    // `day:boundary` fires once a day by construction.
    minSessionGapMs: 0,
    requiresPresence: false,
    // A day off is visible in its own right; a patchy fortnight still shows which days
    // had work in them.
    //
    // Calibrated against the fitted profile rather than guessed: the reference corpus
    // observes a MEDIAN of 6 hours a day, which is a coverage of 0.25. Any multi-day
    // stream with a floor above that can never fire on real data, however obvious the
    // absence — the first version of this table set three of them at 0.35 and above and
    // silenced every multi-day claim in the corpus.
    minCoverage: 0.1,
    expectedEveryMs: 8 * DAY,
    matches: (_state, event) => event.type === 'day:boundary',
    describeAbsence: (gapMs, r) => `${fmtDuration(gapMs)} without a day away from the keyboard, against a usual ${fmtDuration(r.intervalMs.mean)}`,
  },
  {
    key: 'leisure',
    bucket: 'any',
    valueHalfLifeMs: null,
    // Downtime recurs on a scale of days, so a fortnight without it is the signal
    // rather than an interval to learn.
    maxGapMs: 14 * DAY,
    // One evening of television is ONE occurrence, not the dozen window changes it
    // produces. Without this the stream learns a 273-minute rhythm for something that
    // happens about once a day.
    minSessionGapMs: 3 * HOUR,
    requiresPresence: false,
    // See `day-off` above for why this is 0.15 and not 0.35.
    minCoverage: 0.15,
    // Four days. Not a measurement — a default the owner can overrule, used only until
    // six real sessions have been seen.
    expectedEveryMs: 4 * DAY,
    // Reads the same classifier the moment kind does, so "downtime" means one thing
    // across the system. `ambient` deliberately does not match: an album playing
    // during a coding session is not rest.
    matches: (state, event) => {
      if (event.type !== 'window:changed') return false;
      const payload = event.payload as { processName?: string; windowTitle?: string };
      return classifyActivity(payload.processName ?? '', payload.windowTitle ?? '', state.config.leisureRules) === 'personal';
    },
    describeAbsence: (gapMs, r) => `${fmtDuration(gapMs)} with nothing but work, against a usual gap of ${fmtDuration(r.intervalMs.mean)}`,
  },
  {
    key: 'flow',
    bucket: 'weekday',
    valueHalfLifeMs: null,
    maxGapMs: 5 * DAY,
    // `focusFlow` already deduped the span.
    minSessionGapMs: 0,
    requiresPresence: true,
    minCoverage: 0.4,
    // Already deduped into a span by `focusFlow`'s running mean, so this is one
    // occurrence per sustained stretch rather than one per sample.
    matches: (_state, event) => event.type === 'event:focus-flow',
    describeAbsence: (gapMs, r) => `${fmtDuration(gapMs)} without a sustained stretch of focus, against a usual ${fmtDuration(r.intervalMs.mean)}`,
  },
  {
    key: 'repo',
    bucket: 'any',
    valueHalfLifeMs: null,
    maxGapMs: 21 * DAY,
    // A repository is touched on every window change inside it; a day is the unit that
    // means anything for "when did I last work on this".
    minSessionGapMs: 8 * HOUR,
    requiresPresence: false,
    // The most forgiving in the table: a touch leaves a durable trace whenever the
    // daemon is up at all, so a patchy fortnight still supports the claim.
    minCoverage: 0.06,
    matches: (state, event) => event.type === 'window:changed' && Boolean(state.project.current?.id),
    subject: (state) => state.project.current?.id ?? null,
    describeAbsence: (gapMs, r) => `${r.stream.split(':').slice(1).join(':') || 'this project'} untouched for ${fmtDuration(gapMs)}, against a usual ${fmtDuration(r.intervalMs.mean)}`,
  },
];

/** About three weeks of stop times — enough for a slope to mean something, bounded for the snapshot. */
export const MAX_DAY_END_SAMPLES = 21;
/** Days of stop times before a slope is trusted. */
export const MIN_DAY_END_SAMPLES = 8;
/** A stop time sliding less than this per day is noise. ~12 min/day is ~90 min over a week. */
export const MIN_DAY_END_DRIFT_MIN_PER_DAY = 12;

/**
 * Days of stop times the slope is measured over.
 *
 * A trailing window, not the whole series, and the difference is decisive. A genuine
 * 22-minutes-per-day drift over ten days diluted to 9.7 across a 21-day history — under
 * the 12-minute floor, so the detector stayed silent on a drift it was built to catch.
 * Drift is by definition a RECENT trend; averaging it against a flat fortnight measures
 * the fortnight.
 */
export const DRIFT_WINDOW_DAYS = 12;

/** Least-squares slope of `minutes` against index, in minutes per day, over the trailing window. */
export function dayEndDriftPerDay(all: { day: string; minutes: number }[]): number {
  const samples = all.slice(-DRIFT_WINDOW_DAYS);
  const n = samples.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = samples.reduce((sum, s) => sum + s.minutes, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (samples[i]!.minutes - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** Median stop time, in local minutes. Median rather than mean: one all-nighter should not move "normally". */
export function medianDayEndMinutes(samples: { day: string; minutes: number }[]): number | null {
  if (samples.length === 0) return null;
  const sorted = samples.map((s) => s.minutes).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Local minutes from midnight for an instant. */
export function localMinutes(ts: string, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ts));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
    return get('hour') * 60 + get('minute');
  } catch {
    return new Date(ts).getUTCHours() * 60 + new Date(ts).getUTCMinutes();
  }
}

/**
 * Records the latest activity seen on each WAKING day — K0.6b.
 *
 * Max-per-day needs minutes to be monotone within the bucket, and it needs no
 * end-of-day event, which matters because the common case is a closed laptop
 * where no `day:boundary` ever fires. Both hold on either boundary. What did
 * not hold was the boundary itself.
 *
 * **Measured, and it is the reason this changed.** On the calendar day,
 * activity after midnight belongs to the NEW day, so a night that ran to 02:00
 * is recorded as that evening's last pre-midnight minute. The old comment
 * called that "the honest reading rather than a bug". The record disagrees:
 * every one of the six `day-end-drift` notices Gnomon has ever sent reports a
 * stop time between **23:23 and 23:59** — six marks in a half-hour band, over a
 * record holding ten nights that ran past midnight, the latest to 03:08. And
 * the other half of the pair, `day-runs-long`, has fired **zero times in
 * fifty-four days**: `nowMinutes` resets to 0 at midnight while the median sits
 * near 1380, so `pastBy` goes hugely negative exactly when the owner is up
 * late. The notice about working late was structurally silent while working
 * late.
 *
 * Minutes now count from `WAKING_DAY_START_HOUR`, so 02:00 is minute 1320 of
 * the evening it belongs to and the series is monotone across the night.
 *
 * **`basis` is a version stamp and it is load-bearing.** The two zeros differ
 * by 240 minutes, so a series mixing them shows a four-hour step at the
 * changeover — which `dayEndDriftPerDay` would read as an enormous drift and
 * announce. Samples without the stamp are dropped as they are met rather than
 * converted: the offset is only constant for a stop time before midnight, and
 * guessing which side of it an old sample fell on is exactly the invention this
 * item exists to remove. The window is twenty-one days; it refills.
 */
export function recordDayEnd(samples: { day: string; minutes: number; basis?: string }[], ts: string, timezone: string): { day: string; minutes: number; basis?: string }[] {
  const day = wakingDate(ts, timezone);
  const minutes = wakingMinute(ts, timezone);
  const kept = samples.filter((s) => s.basis === 'waking');
  const last = kept[kept.length - 1];

  if (last?.day === day) {
    if (minutes <= last.minutes && kept.length === samples.length) return samples;
    return [...kept.slice(0, -1), { day, minutes: Math.max(minutes, last.minutes), basis: 'waking' }];
  }
  return [...kept, { day, minutes, basis: 'waking' }].slice(-MAX_DAY_END_SAMPLES);
}

/** Welford update — running mean and sum of squared deviations, no sample array. */
function observe(acc: { mean: number; m2: number; n: number }, value: number): { mean: number; m2: number; n: number } {
  const n = acc.n + 1;
  const delta = value - acc.mean;
  const mean = acc.mean + delta / n;
  return { mean, m2: acc.m2 + delta * (value - mean), n };
}

export function intervalSd(r: Recurrence): number {
  return r.intervalMs.n < 2 ? Number.POSITIVE_INFINITY : Math.sqrt(r.intervalMs.m2 / (r.intervalMs.n - 1));
}

/** Occurrences before a LEARNED interval is allowed to make any claim at all. */
export const MIN_OCCURRENCES = 6;
/**
 * Occurrences before a DECLARED interval may be used. One, not zero.
 *
 * Zero would let Gnomon assert a rhythm for something it has never observed in this
 * person's life at all — announcing an absence of downtime for someone who simply does
 * not take downtime at this machine, which is a statement about the sensor rather than
 * the owner.
 */
export const MIN_OCCURRENCES_DECLARED = 1;
/**
 * Precision of a declared expectation.
 *
 * Deliberately mediocre and fixed. A declared floor carries no evidence about THIS
 * owner's rhythm, so it must not compete on equal terms with a well-sampled learned
 * interval; the gate should prefer a measured claim every time one is available.
 */
export const DECLARED_PRECISION = 0.45;
/** Occurrences at which evidence stops discounting precision. */
export const FULL_EVIDENCE_OCCURRENCES = 20;
/** How overdue, in standard deviations of its own interval, before an absence is worth reporting. */
export const OVERDUE_SD = 2.5;
/** Occurrences before a slope is trusted. Higher than `MIN_OCCURRENCES`: a slope needs more evidence than a mean. */
export const MIN_DRIFT_SAMPLES = 10;
/** Slope below this is noise, not drift. */
export const MIN_DRIFT_PER_DAY_MS = 4 * MINUTE;
/** Exponential weight on the newest gap when updating the slope. */
const DRIFT_ALPHA = 0.3;

/**
 * Precision of the expectation a candidate violates, 0..1 — the inverse-variance
 * weight of precision-weighted prediction error.
 *
 * Three multiplied terms, each measured rather than picked:
 *
 * - **Sharpness**, from the coefficient of variation, so it is unit-free and a
 *   90-minute break is comparable with a 9-day weekend.
 * - **Evidence**, so a six-sample interval speaks quietly. This is the term that
 *   structurally retires the defect it replaces: every one of the 17 deleted
 *   companion insights came from a baseline of as few as two samples.
 * - **Coverage**, the largest of the three in practice. Observed hours per day
 *   ranged 1.2 to 11.5 over four live days, so an absence over a window Gnomon
 *   barely watched is mostly a claim about uptime.
 */
export function precisionOf(r: Recurrence, coverage: number): number {
  const sd = intervalSd(r);
  if (!Number.isFinite(sd)) return 0;
  const sharpness = 1 / (1 + sd / Math.max(r.intervalMs.mean, 1));
  const evidence = Math.min(1, r.intervalMs.n / FULL_EVIDENCE_OCCURRENCES);
  return sharpness * evidence * Math.max(0, Math.min(1, coverage));
}

/**
 * P(still absent this long) under an exponential model of the gap, clamped away
 * from zero.
 *
 * Exponential rather than the Gaussian the z-score implies, because a gap is a
 * waiting time and cannot be negative — and because the surprise it yields is then
 * `gap / mean`, which stays finite and interpretable when something is absent for
 * ten times its usual interval. A Gaussian tail would report surprise in the
 * hundreds of nats there and let one stale recurrence dominate every ranking.
 */
export function absenceSurprise(gapMs: number, meanMs: number): number {
  const lambdaGap = gapMs / Math.max(meanMs, 1);
  return Math.max(0, lambdaGap - 1);
}

/** Record one occurrence of `key`, updating interval, slope and re-arming the omission check. */
export function recordOccurrence(
  recurring: Record<string, Recurrence>,
  key: string,
  stream: string,
  bucket: RecurrenceBucket,
  ts: string,
  valueHalfLifeMs: number | null,
  maxGapMs = Number.POSITIVE_INFINITY,
  minSessionGapMs = 0,
): Record<string, Recurrence> {
  const existing = recurring[key];
  if (!existing) {
    return {
      ...recurring,
      [key]: { key, stream, bucket, intervalMs: { mean: 0, m2: 0, n: 0 }, lastSeenAt: ts, driftPerDayMs: 0, driftSamples: 0, armed: true, disarmedOn: null, valueHalfLifeMs },
    };
  }

  const gap = Date.parse(ts) - Date.parse(existing.lastSeenAt);
  // A non-positive gap means replay handed us two events at the same instant (or out
  // of order after a repair). Re-arm and move the cursor, but do not teach the
  // interval a zero — that would collapse the mean toward nothing and make every
  // later absence look enormous.
  // A gap beyond the stream's plausible interval is a session boundary — an overnight
  // gap in a break rhythm, a fortnight away in a leisure rhythm. The cursor moves and
  // the check re-arms, but the interval learns nothing, because folding a boundary in
  // as if it were an interval is what made the break stream believe in a 5.5-hour
  // rhythm and stay silent through an entire planted absence.
  // Three ways a gap is not an interval, all of which move the cursor and re-arm
  // without teaching the mean anything:
  //  - non-positive: replay handed us two events at one instant, and a zero would
  //    collapse the mean toward nothing and make every later absence look enormous;
  //  - beyond `maxGapMs`: a session boundary, not a rhythm;
  //  - under `minSessionGapMs`: still the SAME occurrence, just still going on.
  if (gap <= 0 || gap > maxGapMs || gap < minSessionGapMs) {
    return { ...recurring, [key]: { ...existing, lastSeenAt: ts, armed: true, disarmedOn: null } };
  }

  const intervalMs = observe(existing.intervalMs, gap);
  // Exponentially-weighted slope of the gap itself, per day of elapsed time. Only
  // meaningful once there is a previous mean to compare against.
  const driftPerDayMs = existing.intervalMs.n >= 2 ? existing.driftPerDayMs * (1 - DRIFT_ALPHA) + ((gap - existing.intervalMs.mean) / Math.max(gap / DAY, 1)) * DRIFT_ALPHA : 0;

  return {
    ...recurring,
    [key]: { ...existing, intervalMs, lastSeenAt: ts, driftPerDayMs, driftSamples: existing.driftSamples + 1, armed: true, disarmedOn: null, valueHalfLifeMs },
  };
}
