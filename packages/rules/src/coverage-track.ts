import { localDate } from '@sundial/helpers/local-day.js';
import type { KernelState, Rule } from '@sundial/kernel/types.js';

/**
 * About two weeks of hour buckets. Bounded because this slice rides in every
 * snapshot, and two weeks covers the longest interval anything in
 * `OCCURRENCE_STREAMS` currently learns — a recurrence whose gap exceeds this
 * window cannot have its coverage checked anyway, so keeping more would be storage
 * without a reader.
 */
export const MAX_COVERAGE_BUCKETS = 24 * 15;

/**
 * `input:activity` emits on a fixed ~10s cadence, so a fully-observed hour holds
 * about 360 of them. Used as the denominator when scoring how much of a window
 * Gnomon actually watched.
 */
export const EMITS_PER_FULL_HOUR = 360;

/** One per zone: this runs on every activity event the fold sees. */
const HOUR_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** `2026-08-02T14` — a LOCAL hour bucket, since every claim built on this is about the owner's own day. */
export function coverageBucket(ts: string, timezone: string): string {
  const day = localDate(ts, timezone);
  let hour: string;
  try {
    // `hourCycle: 'h23'` rather than `hour12: false`, which yields "24" for midnight
    // in some ICU versions — a bucket key that sorts after every real hour and
    // silently loses the first hour of every day to eviction.
    let format = HOUR_FORMATTERS.get(timezone);
    if (!format) HOUR_FORMATTERS.set(timezone, (format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit' })));
    hour = format.format(new Date(ts));
  } catch {
    hour = ts.slice(11, 13);
  }
  return `${day}T${hour.padStart(2, '0')}`;
}

/**
 * Fraction of `[fromMs, toMs)` that Gnomon actually observed, 0..1.
 *
 * The reason this function exists at all is a measurement: over four live days the
 * daemon observed 1.2, 8.6, 11.5 and 5.4 hours. An absence asserted over a window
 * it barely watched is a claim about the daemon's uptime wearing a claim about the
 * owner, and `enhancements/presence-as-absence-ground-truth` is the standing note
 * on that ambiguity for this exact signal.
 *
 * Hour buckets are coarse on purpose. A finer grid would imply a precision the
 * emission stream does not have (a restart leaves an 82-93 second hole), and the
 * consumer only ever multiplies a confidence by this.
 */
export function coverageOver(observedHours: Record<string, number>, fromMs: number, toMs: number, timezone: string): number {
  if (!(toMs > fromMs)) return 0;

  const HOUR_MS = 3_600_000;
  let observed = 0;
  let total = 0;

  // Walk hour by hour rather than summing the whole map: only the buckets the
  // window actually spans may contribute, or a busy yesterday would vouch for an
  // unobserved today.
  for (let cursor = Math.floor(fromMs / HOUR_MS) * HOUR_MS; cursor < toMs; cursor += HOUR_MS) {
    const overlap = Math.min(cursor + HOUR_MS, toMs) - Math.max(cursor, fromMs);
    if (overlap <= 0) continue;
    const share = overlap / HOUR_MS;
    total += share;
    const emits = observedHours[coverageBucket(new Date(cursor).toISOString(), timezone)] ?? 0;
    observed += share * Math.min(1, emits / EMITS_PER_FULL_HOUR);
  }

  return total > 0 ? observed / total : 0;
}

/**
 * Records how much of each local hour the daemon was actually watching.
 *
 * Reacts only to `input:activity`, and counts it — nothing about the payload is
 * read. That is the trick that makes this nearly free: the sensor emits on a fixed
 * cadence whenever the daemon is up *regardless of whether the owner is typing*
 * (see its own doc comment), so the emission COUNT measures observation time and
 * cannot be confused with activity level. No new sensor, no new event type, no
 * permission.
 *
 * The distinction this rule protects is the one that broke the first version of
 * absence detection. Gaps in the emission stream number 31-67 per day at five
 * minutes or longer, while `idle:start` — which requires the daemon to have watched
 * 30 consecutive windows of genuine zero input — fires 1-8 times. A break derived
 * from emission gaps would therefore have been a daemon-downtime detector wearing a
 * rest detector's name. Gaps prove nothing was recorded; only `idle:start` proves
 * nothing happened.
 *
 * No ordering constraint: it writes one field no other rule writes, and its reader
 * (`expectationWatch`) runs on a different event type.
 */
export const coverageTrack: Rule = (state, event) => {
  if (event.type !== 'input:activity') return { state, effects: [] };

  const bucket = coverageBucket(event.ts, state.config.timezone);
  const observedHours: Record<string, number> = { ...state.coverage.observedHours, [bucket]: (state.coverage.observedHours[bucket] ?? 0) + 1 };

  const keys = Object.keys(observedHours);
  if (keys.length > MAX_COVERAGE_BUCKETS) {
    // Lexical order is chronological for `YYYY-MM-DDTHH`, so sorting drops the
    // oldest hours rather than whichever key happened to be inserted first — this
    // map is written out of order whenever a replay crosses a gap.
    for (const stale of keys.sort().slice(0, keys.length - MAX_COVERAGE_BUCKETS)) delete observedHours[stale];
  }

  return { state: { ...state, coverage: { ...state.coverage, observedHours } }, effects: [] };
};

/** Coverage over the trailing `windowMs`, ending at `ts`. The form a multi-day omission check wants. */
export function recentCoverage(state: KernelState, ts: string, windowMs: number): number {
  const end = Date.parse(ts);
  return coverageOver(state.coverage.observedHours, end - windowMs, end, state.config.timezone);
}

/**
 * Today's observed window: from the first hour Gnomon actually saw activity in, to now.
 *
 * This is the right frame for any within-day claim, and getting the frame wrong broke the
 * detector twice in opposite directions on the synthetic corpus.
 *
 * Measuring from the last occurrence means a day with NO break has a window stretching
 * back through the night, where coverage is near zero — so the clearest planted case was
 * rejected for want of observation. Measuring over a fixed trailing window instead
 * accepted a day with a four-hour outage in the middle of it, because by evening the
 * recent hours looked fine — a claim of "no break all day" about a day a third of which
 * was never watched, which is the most embarrassing failure an absence detector has.
 *
 * "No break today" is a claim about today, so today is the window. Starting at the first
 * OBSERVED hour rather than midnight keeps the small hours from diluting it.
 */
export function observedToday(state: KernelState, ts: string): { fromMs: number; coverage: number; observedMs: number } {
  const HOUR_MS = 3_600_000;
  const nowMs = Date.parse(ts);
  const today = localDate(ts, state.config.timezone);

  let firstMs: number | null = null;
  for (let cursor = nowMs - 36 * HOUR_MS; cursor <= nowMs; cursor += HOUR_MS) {
    const iso = new Date(cursor).toISOString();
    if (localDate(iso, state.config.timezone) !== today) continue;
    if ((state.coverage.observedHours[coverageBucket(iso, state.config.timezone)] ?? 0) > 0) {
      firstMs = Math.floor(cursor / HOUR_MS) * HOUR_MS;
      break;
    }
  }

  if (firstMs === null || firstMs >= nowMs) return { fromMs: nowMs, coverage: 0, observedMs: 0 };
  const coverage = coverageOver(state.coverage.observedHours, firstMs, nowMs, state.config.timezone);
  return { fromMs: firstMs, coverage, observedMs: coverage * (nowMs - firstMs) };
}
