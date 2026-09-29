/**
 * What "a day" means, in the owner's timezone rather than in UTC.
 *
 * Every timestamp Gnomon records is UTC (`new Date().toISOString()`), which is
 * correct — an instant should not depend on where it was observed. But a *day* is
 * a human unit, and Gnomon reports in days: today's summary, the daily journal,
 * per-day budgets, the decay pass, retention. Deriving those from `ts.slice(0, 10)`
 * silently made them UTC days.
 *
 * For an owner in Amsterdam that put the boundary at 02:00 local (01:00 in
 * winter), so work done between midnight and 2am was filed under the previous
 * day — and late-night work is exactly the pattern a developer's activity log
 * should get right. The measured evidence was in the log itself: `day:boundary`
 * events at `00:00:27Z` and `00:00:44Z`, and a retention prune stamped 2:00 AM
 * local.
 *
 * ## Why the timezone is configuration and not `new Date()`
 *
 * These functions take an explicit IANA zone instead of reading the host's, and
 * that is load-bearing rather than fussy. `reduce()` must be a pure function of
 * `(state, event)` so that replaying the log reproduces the same state — the whole
 * premise of the event-sourced kernel. A rule that consulted the machine's current
 * timezone would fold differently on a laptop that has since moved, or in CI, and
 * a recompute would silently disagree with the live daemon. Passing the zone in
 * from `state.config` keeps the fold deterministic given (log, config), which is
 * the same reason `ownerAliases` and `projectRules` live there.
 */

/** `Intl` reliably yields ISO-ordered `YYYY-MM-DD` for the `en-CA` locale. */
const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = DATE_FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    DATE_FORMATTERS.set(timeZone, f);
  }
  return f;
}

const PARTS_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = PARTS_FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PARTS_FORMATTERS.set(timeZone, f);
  }
  return f;
}

/** The zone's offset from UTC, in ms, at a given instant. Positive east of Greenwich. */
function offsetMsAt(utcMs: number, timeZone: string): number {
  const parts = partsFormatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asIfUtc - utcMs;
}

/**
 * The calendar date (`YYYY-MM-DD`) an instant falls on, in `timeZone`.
 *
 * Falls back to the UTC date when the zone is unusable, rather than throwing — a
 * bad config value should degrade to the previous behaviour, not stop the daemon
 * folding events.
 */
/**
 * A wall-clock time in the owner's zone, `HH:MM`, for text the OWNER reads.
 * Four rules each hand-rolled this once and one of them sliced the ISO string,
 * which read "ended 09:30Z" for a meeting that ended at 11:30 in Amsterdam.
 * Falls back to the machine's zone on a bad zone name — still the owner's
 * clock on a single-user machine.
 */
export function formatClock(ts: string, timeZone?: string | null): string {
  const options: Intl.DateTimeFormatOptions = { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-GB', timeZone ? { ...options, timeZone } : options).format(new Date(ts));
  } catch {
    return new Intl.DateTimeFormat('en-GB', options).format(new Date(ts));
  }
}

export function localDate(ts: string, timeZone: string): string {
  try {
    return dateFormatter(timeZone).format(new Date(ts));
  } catch {
    return ts.slice(0, 10);
  }
}

/**
 * The hour of the day (0–23) an instant falls in, in `timeZone`.
 *
 * The companion to `localDate` for any analytic that buckets by hour. Rules
 * pass `state.config.timezone`; until 2026-09-28 (M3) several called
 * `new Date(ts).getHours()`, the HOST zone, so a replay on a machine in another
 * zone re-bucketed them. Pairing a local day with a host-zone hour is the
 * mismatch `day-shape-forecast.ts` warns about in its own header.
 *
 * Falls back to the UTC hour when the zone is unusable, matching `localDate`.
 */
export function localHour(ts: string, timeZone: string): number {
  try {
    const parts = partsFormatter(timeZone).formatToParts(new Date(ts));
    return Number(parts.find((p) => p.type === 'hour')?.value ?? new Date(ts).getUTCHours());
  } catch {
    return new Date(ts).getUTCHours();
  }
}

/** Minutes since local midnight, 0–1439, in `timeZone`. UTC on an unusable zone, matching `localHour`. */
export function localMinuteOfDay(ts: string, timeZone: string): number {
  try {
    const parts = partsFormatter(timeZone).formatToParts(new Date(ts));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
    return get('hour') * 60 + get('minute');
  } catch {
    const d = new Date(ts);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

/** Day of the week (0 = Sunday) of the local date an instant falls on in `timeZone`. */
export function localWeekday(ts: string, timeZone: string): number {
  return new Date(`${localDate(ts, timeZone)}T12:00:00Z`).getUTCDay();
}

/**
 * The half-open UTC interval `[start, end)` covering a local calendar day —
 * what a "moments for this date" query has to range over, since the stored
 * timestamps are UTC.
 *
 * Resolved in two passes because a zone's offset is itself a function of the
 * instant. The first pass guesses the offset at the naive midnight, and the
 * second re-reads it at the corrected instant. That matters exactly twice a year:
 * on a DST transition the offset at 00:00 local differs from the offset at
 * 00:00 UTC, and a single-pass conversion lands an hour out — which would drop or
 * double-count an hour of the record on those two days.
 */
export function localDayRange(date: string, timeZone: string): { start: string; end: string } {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return { start: `${date}T00:00:00.000Z`, end: `${date}T23:59:59.999Z` };

  const naive = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const startMs = naive - offsetMsAt(naive - offsetMsAt(naive, timeZone), timeZone);

  const naiveNext = naive + 24 * 60 * 60 * 1000;
  const endMs = naiveNext - offsetMsAt(naiveNext - offsetMsAt(naiveNext, timeZone), timeZone);

  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

/** The UTC instant of a local wall-clock time on a local date — two passes, for the same DST reason as `localDayRange`. */
export function localInstant(date: string, hour: number, minute: number, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const naive = Date.UTC(y!, m! - 1, d!, hour, minute, 0, 0);
  try {
    return new Date(naive - offsetMsAt(naive - offsetMsAt(naive, timeZone), timeZone)).toISOString();
  } catch {
    return new Date(naive).toISOString();
  }
}

/**
 * When a WAKING day begins — K0.6, and it is not a second calendar.
 *
 * `localDate` answers "what date did this happen on", which is the right
 * question for a budget, a retention sweep, a journal entry and the gate's
 * daily allowance: those all mean the calendar day and are correct as they are.
 * This answers a different one — "which of the owner's days was this part of" —
 * and midnight is the wrong boundary for it, because people do not stop at
 * midnight.
 *
 * The record settles it. Seven of the record's forty-two days have their FIRST
 * moment between 00:00 and 00:05, which is not somebody who got up at four
 * minutes past twelve: it is the previous evening continuing. Filed by calendar
 * date, those seven days claim to start at 00:03 and the evenings they belong
 * to claim to stop at 23:57 — so both ends of both days are wrong, and the
 * Rhythm card had to draw them as unknowable. Read against a 04:00 boundary the
 * same seven nights end at 00:04, 00:16, 00:24, 00:33, 01:04, 01:23 and 02:00,
 * which is a real spread and a readable one.
 *
 * 04:00 rather than 03:00 or 05:00 because it is comfortably after the latest
 * of those (02:00) and comfortably before the earliest start the record holds,
 * so no day in it is split and none is merged. It is a boundary for READING
 * only: nothing that accounts for a day uses it, and a surface that mixes the
 * two is describing two things under one heading.
 */
export const WAKING_DAY_START_HOUR = 4;

/**
 * The waking day an instant belongs to, as `YYYY-MM-DD` — the date that day
 * STARTED on, so work at 00:30 on Tuesday belongs to Monday's day.
 *
 * Built by shifting the instant back by `WAKING_DAY_START_HOUR` and taking the
 * local date of that, which is correct across a DST change for the same reason
 * `localDate` is: the shift happens in absolute time and the zone is applied
 * once, afterwards.
 */
export function wakingDate(ts: string, timeZone: string): string {
  const shifted = new Date(Date.parse(ts) - WAKING_DAY_START_HOUR * 3_600_000).toISOString();
  return localDate(shifted, timeZone);
}

/**
 * Minutes from the start of the waking day an instant falls in, 0–1439.
 *
 * The companion to `wakingDate`: 04:00 is minute 0, midnight is 1200, and
 * 02:00 the following morning is 1320. A day-arc measured this way needs no
 * clipping, no wrap and no special case — the late night simply sits near the
 * right-hand end where it belongs.
 */
export function wakingMinute(ts: string, timeZone: string): number {
  const shifted = new Date(Date.parse(ts) - WAKING_DAY_START_HOUR * 3_600_000).toISOString();
  const parts = partsFormatter(timeZone).formatToParts(new Date(shifted));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return get('hour') * 60 + get('minute');
}

/** The host's IANA zone, for seeding config on a machine that has never set one. */
export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
