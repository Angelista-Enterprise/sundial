import { createHash } from 'node:crypto';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { wakingDate, wakingMinute } from '@sundial/helpers/local-day.js';
import {
  DRIFT_THRESHOLDS,
  EMPTY_DRIFT,
  EMPTY_DRIFT_DAY,
  LATE_FROM_MIN,
  MAX_DRIFT_DAYS,
  MAX_DRIFT_MEETINGS,
  driftSentence,
  heldTrends,
  mondayOf,
  weeklyDrift,
  type DriftDay,
  type DriftState,
  type DriftTrend,
} from '@sundial/kernel/drift.js';
import type { Effect, KernelState, NoticeCandidate, Rule, SanitizedEvent } from '@sundial/kernel/types.js';
import { isZeroActivity } from './idle-track.js';

/** A meeting longer than this is a calendar block, not four hours of talking. */
const MAX_MEETING_MIN = 240;

export const DRIFT_TYPES = ['input:activity', 'event:context-switch', 'git:commit', 'calendar:active', 'clock:tick'] as const;

function withDay(drift: DriftState, day: string, change: (d: DriftDay) => DriftDay): DriftState {
  const prior = drift.days[day];
  const days = { ...drift.days, [day]: change(prior ?? EMPTY_DRIFT_DAY) };
  if (!prior) {
    const keys = Object.keys(days).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_DRIFT_DAYS))) delete days[old];
  }
  return { ...drift, days };
}

/** How much a held trend is worth saying: its mean distance past the threshold, capped. */
function candidateFor(t: DriftTrend, weeks: ReturnType<typeof weeklyDrift>): NoticeCandidate {
  const { abs } = DRIFT_THRESHOLDS[t.metric];
  const mean = t.held.reduce((n, h) => n + Math.abs(h.value - t.baseline), 0) / t.held.length;
  const byWeek = new Map(weeks.map((w) => [w.week, w]));
  const nOf = (week: string) => {
    const w = byWeek.get(week);
    if (!w) return 0;
    return t.metric === 'dayEnd' ? w.dayEndN : t.metric === 'switchesPerDay' ? w.activeDays : w.present;
  };
  return {
    shape: 'drift',
    kind: 'weekly-drift',
    // Per metric and direction, so a trend that stops and comes back is the SAME
    // stimulus to the gate's habituation, not a new one every week.
    key: `weekly-drift:${t.metric}:${t.direction}`,
    surprise: Math.min(3, mean / abs),
    precision: Math.min(1, t.baselineWeeks / 4),
    valueHalfLifeMs: null,
    observation: driftSentence(t),
    evidence: [`weeks of ${t.held.map((h) => h.week).join(', ')}`, `n = ${t.held.map((h) => nOf(h.week)).join(' + ')} days`, `baseline n = ${t.baselineWeeks} weeks`],
    concerns: [],
  };
}

/**
 * Drift (use case 8): folds the log into waking days, and once a week asks
 * whether any of five measures has held beyond its usual level for three
 * weeks in a row (`HOLD_WEEKS`). A trend speaks through the gate when it STARTS
 * to hold; the weeks it goes on holding are not new.
 *
 * Measured from the log, not from moments: a moment is filed by its start day,
 * and midnight clips it.
 */
export const driftTrack: Rule = (state, event) => {
  if (!(DRIFT_TYPES as readonly string[]).includes(event.type)) return { state, effects: [] };
  const tz = state.config.timezone;
  const drift = state.drift ?? EMPTY_DRIFT;
  const p = event.payload as Record<string, unknown>;

  if (event.type === 'input:activity') {
    const day = wakingDate(event.ts, tz);
    if (isZeroActivity(p as Parameters<typeof isZeroActivity>[0])) {
      // A day the machine ran counts as present even without input: "the daemon
      // watched nothing" and "the daemon was not running" are different claims.
      if (drift.days[day]) return { state, effects: [] };
      return { state: { ...state, drift: withDay(drift, day, (d) => d) }, effects: [] };
    }
    const minute = wakingMinute(event.ts, tz);
    return { state: { ...state, drift: withDay(drift, day, (d) => ({ ...d, active: d.active + 1, first: d.first ?? minute, last: Math.max(d.last ?? minute, minute) })) }, effects: [] };
  }

  if (event.type === 'event:context-switch') {
    return { state: { ...state, drift: withDay(drift, wakingDate(event.ts, tz), (d) => ({ ...d, switches: d.switches + 1 })) }, effects: [] };
  }

  if (event.type === 'git:commit') {
    if (p.backfill === true || wakingMinute(event.ts, tz) < LATE_FROM_MIN) return { state, effects: [] };
    return { state: { ...state, drift: withDay(drift, wakingDate(event.ts, tz), (d) => ({ ...d, late: d.late + 1 })) }, effects: [] };
  }

  if (event.type === 'calendar:active') {
    const e = (p.event ?? {}) as Record<string, unknown>;
    if (e.isAllDay === true || typeof e.eventId !== 'string' || typeof e.startDate !== 'string' || typeof e.endDate !== 'string') return { state, effects: [] };
    const minutes = (Date.parse(e.endDate) - Date.parse(e.startDate)) / 60_000;
    if (!Number.isFinite(minutes) || minutes <= 0) return { state, effects: [] };
    // Every occurrence of a series shares its eventId: the start tells them apart.
    const key = createHash('sha256').update(`${e.eventId}|${e.startDate}`).digest('hex').slice(0, 12);
    if (drift.meetings.includes(key)) return { state, effects: [] };
    const next = withDay({ ...drift, meetings: [...drift.meetings, key].slice(-MAX_DRIFT_MEETINGS) }, wakingDate(e.startDate, tz), (d) => ({ ...d, meetingMin: d.meetingMin + Math.min(MAX_MEETING_MIN, minutes) }));
    return { state: { ...state, drift: next }, effects: [] };
  }

  // clock:tick — once per waking week.
  const week = mondayOf(wakingDate(event.ts, tz));
  if (drift.checkedWeek === week) return { state, effects: [] };
  const weeks = weeklyDrift(drift.days);
  const trends = heldTrends(weeks, week);
  const holding = Object.fromEntries(trends.map((t) => [t.metric, t.direction]));
  const fresh = drift.checkedWeek === null ? [] : trends.filter((t) => drift.holding[t.metric] !== t.direction);
  const effects: Effect[] = fresh.map((t) => ({
    type: 'EmitEvent' as const,
    event: { id: deriveId(event.ts, event.id, 'drift-track', t.metric, t.direction), type: 'notice:candidate', ts: event.ts, payload: { timestamp: event.ts, ...candidateFor(t, weeks) } },
  }));
  return { state: { ...state, drift: { ...drift, checkedWeek: week, holding } }, effects };
};

/**
 * `rows` folded into `state.drift`, clock ticks skipped — the rebuild from the
 * log for a snapshot that predates the slice, one page at a time. The rule is
 * pure, so this is the answer a full replay would give. Without the ticks the
 * weekly check stays unrun (`checkedWeek: null`), so the first live check
 * records what already holds without saying it: a trend that held before the
 * deploy is not news on the day of the deploy.
 */
export function foldDriftRows(state: KernelState, rows: Iterable<SanitizedEvent>): KernelState {
  let folded = state;
  for (const row of rows) if (row.type !== 'clock:tick') folded = driftTrack(folded, row).state;
  return folded;
}
