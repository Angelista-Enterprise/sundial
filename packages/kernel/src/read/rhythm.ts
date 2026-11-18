import { getActivityHours, getCommitsBetween, getContextSwitchesBetween, getDayArcs, getInterruptionsBetween, getObservedHours, getProfileFact, getShellRunsBetween, getThrashingBetween } from '@sundial/db/index.js';
import { localDayRange, WAKING_DAY_START_HOUR, wakingDate, wakingMinute } from '@sundial/helpers/local-day.js';
import { buildWorkShape, type WorkShape } from '../work-shape.js';

/**
 * Rhythm: what the owner's days look like over a span — when they start and stop, which hours
 * were watched — with the attention numbers as a ribbon. What the web client's Rhythm card and
 * the MCP `gnomon_today` tool both draw. Moved here from the theme's host on 2026-10-05 (Track B);
 * the route only resolves its span and calls this.
 */
export interface RhythmDay {
  date: string;
  firstMin: number;
  lastMin: number;
  activeMin: number;
  moments: number;
  /** Per waking-day hour from 04:00, the share of that hour Sundial was watching. A day total cannot draw a hatch. */
  hours: number[];
  observedHours: number;
  switches: number | null;
  interruptions: number | null;
}

export interface RhythmRead {
  from: string;
  to: string;
  timeZone: string;
  /** The owner's own words about their bedtime, asked rather than assumed. */
  intent: { object: string; provenance: string; validFrom: string } | null;
  /** The WAKING day, so "today" names the same row the arcs do. */
  today: string;
  nowMin: number;
  dayStartsAt: number;
  days: RhythmDay[];
  attention: { totals: WorkShape["totals"]; switchesByHour: WorkShape["switchesByHour"]; suspects: WorkShape["suspects"]; days: { date: string; thrashingBursts: number; thrashingFlips: number; thrashingBurstsMeasured: number }[] };
}

/** Calendar-day arithmetic on a `YYYY-MM-DD` — never 24h subtraction, which drifts across DST. */
export function shiftDate(date: string, deltaDays: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + deltaDays)).toISOString().slice(0, 10);
}

/** `until` is the last owner-local day; `days` how many back, inclusive. */
export async function readRhythm({ until, days, now, timeZone }: { until: string; days: number; now: number; timeZone: string }): Promise<RhythmRead> {
  const to = localDayRange(until, timeZone).end;
  const from = localDayRange(shiftDate(until, -(days - 1)), timeZone).start;
  const range = { from, to };

  const [arcs, observedHours, activityHours, switches, thrashing, interruptions, shellRuns, commits] = await Promise.all([
    getDayArcs(from, to, timeZone),
    getObservedHours(),
    getActivityHours(range),
    getContextSwitchesBetween(range),
    getThrashingBetween(range),
    getInterruptionsBetween(range),
    getShellRunsBetween(range),
    getCommitsBetween(range),
  ]);

  // Bucketed on the WAKING day and indexed from 04:00, so the hatch and the arc above it
  // describe the same twenty-four hours (K0.6).
  const watched = new Map<string, number[]>();
  for (const { hour, share } of observedHours) {
    const at = new Date(`${hour}:00:00.000Z`).toISOString();
    const day = wakingDate(at, timeZone);
    const slot = Math.floor(wakingMinute(at, timeZone) / 60);
    const byHour = watched.get(day) ?? new Array<number>(24).fill(0);
    byHour[slot] = Math.min(1, (byHour[slot] ?? 0) + share);
    watched.set(day, byHour);
  }

  const shape = buildWorkShape({ from, to, timeZone, activityHours, switches, thrashing, interruptions, shellRuns, commits });
  const byDate = new Map(shape.days.map((day) => [day.date, day]));
  const nowIso = new Date(now).toISOString();
  return {
    from,
    to,
    timeZone,
    intent: await getProfileFact('asleepBy'),
    today: wakingDate(nowIso, timeZone),
    nowMin: wakingMinute(nowIso, timeZone),
    dayStartsAt: WAKING_DAY_START_HOUR,
    days: arcs.map((arc) => ({
      ...arc,
      hours: (watched.get(arc.date) ?? new Array<number>(24).fill(0)).map((share) => Math.round(share * 100) / 100),
      observedHours: Math.round((watched.get(arc.date) ?? []).reduce((sum, share) => sum + share, 0) * 100) / 100,
      switches: byDate.get(arc.date)?.switches ?? null,
      interruptions: byDate.get(arc.date)?.interruptions ?? null,
    })),
    attention: { totals: shape.totals, switchesByHour: shape.switchesByHour, suspects: shape.suspects, days: shape.days.map((day) => ({ date: day.date, thrashingBursts: day.thrashingBursts, thrashingFlips: day.thrashingFlips, thrashingBurstsMeasured: day.thrashingBurstsMeasured })) },
  };
}
