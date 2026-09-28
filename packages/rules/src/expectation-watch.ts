import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate, WAKING_DAY_START_HOUR, wakingMinute } from '@sundial/helpers/local-day.js';
import type { Effect, KernelState, NoticeCandidate, Recurrence, Rule } from '@sundial/kernel/types.js';
import { observedToday, recentCoverage } from './coverage-track.js';
import {
  MIN_DAY_END_DRIFT_MIN_PER_DAY,
  MIN_DAY_END_SAMPLES,
  MIN_DRIFT_PER_DAY_MS,
  MIN_DRIFT_SAMPLES,
  DECLARED_PRECISION,
  MIN_OCCURRENCES,
  MIN_OCCURRENCES_DECLARED,
  OCCURRENCE_STREAMS,
  OVERDUE_SD,
  absenceSurprise,
  dayEndDriftPerDay,
  intervalSd,
  medianDayEndMinutes,
  precisionOf,
} from './expectations.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Precision of the day-end phase claim, from sample count alone — the series has no per-cell variance to read. */
function dayEndPrecision(samples: number): number {
  return Math.min(1, samples / 14);
}

function streamFor(recurrence: Recurrence) {
  const base = recurrence.stream.split(':')[0];
  return OCCURRENCE_STREAMS.find((s) => s.key === base) ?? null;
}

function candidateEffect(candidate: NoticeCandidate, eventId: string, ts: string, salt: string): Effect {
  return {
    type: 'EmitEvent',
    event: {
      id: deriveId(ts, eventId, 'expectation-watch', salt),
      type: 'notice:candidate',
      ts,
      payload: { timestamp: ts, ...candidate },
    },
  };
}

/**
 * Notices that something expected did not happen, and that something is slowly
 * moving.
 *
 * These are the two detector shapes nothing in Gnomon had before, and between them
 * they are most of what a person actually wants noticed — a break not taken, a day
 * off not had, downtime that has not happened in a week, a project gone quiet, a
 * stop time creeping later. Every producer that existed previously fired on
 * something HAPPENING, which is the structural reason the surface could only ever
 * talk about activity spikes.
 *
 * ## Edge-triggered, and that is load-bearing
 *
 * This rule rides `clock:tick`, so a level-triggered overdue check would emit a
 * candidate every 60 seconds for as long as something stayed absent — 1,440 log rows
 * and 1,440 recursive `reduce()` passes a day for one missing break, which would
 * make the candidate stream mostly Gnomon talking to itself. `Recurrence.armed` is
 * cleared on emit and set again by `expectationLearn` when the occurrence next
 * happens, so each absence is announced once per absence.
 *
 * ## It gates nothing else
 *
 * Thresholds here are about whether a claim is WELL-FOUNDED (enough occurrences,
 * enough coverage, a real slope), never about whether it is worth the owner's
 * attention. Habituation, the daily budget and channel choice all belong to
 * `noticeGate`, in one place.
 */
export const expectationWatch: Rule = (state, event) => {
  if (event.type !== 'clock:tick') return { state, effects: [] };

  const nowMs = Date.parse(event.ts);
  const effects: Effect[] = [];
  const recurring = { ...state.expectations.recurring };
  let disarmed = false;

  const localToday = localDate(event.ts, state.config.timezone);

  for (const recurrence of Object.values(state.expectations.recurring)) {
    /**
     * Armed, OR disarmed on an earlier day.
     *
     * Re-arming only on an occurrence is what edge-triggering means, and taken literally
     * it produces the worst possible failure: announce "no break yet" once, and a day on
     * which the owner takes NO break at all can never be reported, because the re-arm
     * condition is the very thing that did not happen. On the synthetic corpus this
     * silenced the clearest planted case in the whole set — `absent:break` fired on six
     * ordinary days and not on the one day with no break in it.
     *
     * A standing absence is worth at most one mention per day. That keeps the log bounded
     * (one per day, not one per tick) while letting a worsening absence be raised again,
     * and habituation in the gate decides whether the owner actually hears it.
     */
    if (!recurrence.armed && recurrence.disarmedOn === localToday) continue;

    const stream = streamFor(recurrence);
    if (!stream) continue;

    /**
     * Learned where there is evidence; declared where there is not.
     *
     * A learned interval needs `MIN_OCCURRENCES` real gaps. Below that, a stream that
     * declares `expectedEveryMs` may still speak — with a fixed mediocre precision and
     * the evidence labelled as declared — because the alternative is permanent silence for
     * exactly the people the claim matters most for. The `officer` persona logged three
     * leisure sessions in sixty days.
     */
    const learned = recurrence.intervalMs.n >= MIN_OCCURRENCES;
    if (!learned && (stream.expectedEveryMs === undefined || recurrence.intervalMs.n < MIN_OCCURRENCES_DECLARED)) continue;

    const meanMs = learned ? recurrence.intervalMs.mean : stream.expectedEveryMs!;
    // A declared interval has no measured spread. A third of the interval is a deliberately
    // wide band, so a declared claim only fires when something is far past due.
    const sd = learned ? intervalSd(recurrence) : meanMs / 3;
    if (!Number.isFinite(sd)) continue;

    const wallGapMs = nowMs - Date.parse(recurrence.lastSeenAt);

    // The owner has to be there for a within-day claim to mean anything. `idleTrack`
    // requires 30 consecutive windows of genuine zero input, which is the only signal
    // in the system that distinguishes "away" from "the daemon happens to be running".
    if (stream.requiresPresence && state.lifeEvent.idle.isIdle) continue;

    /**
     * The frame the claim is made in, and it differs by stream shape.
     *
     * A multi-day claim spans its whole gap: "this repository has been quiet eleven days"
     * is a claim about those eleven days, so coverage over all of them is the right test.
     *
     * A within-day claim is about TODAY — see `observedToday`, which documents the two
     * opposite failures that got us here. The observed portion of today, measured from
     * the first hour Gnomon actually saw, is both the window the coverage floor applies
     * to and the elapsed time compared against the interval.
     */
    const today = stream.requiresPresence ? observedToday(state, event.ts) : null;
    const coverage = today ? today.coverage : recentCoverage(state, event.ts, wallGapMs);
    if (coverage < stream.minCoverage) continue;

    // For a within-day stream: observed time since whichever is later, the last
    // occurrence or the start of today's observed window. Unobserved hours contribute
    // nothing, so a night adds nothing and a four-hour outage adds nothing.
    const gapMs = today ? Math.min(wallGapMs, today.observedMs) : wallGapMs;

    const overdueSd = (gapMs - meanMs) / Math.max(sd, MINUTE);
    if (overdueSd < OVERDUE_SD) continue;

    const precision = learned ? precisionOf(recurrence, coverage) : DECLARED_PRECISION * coverage;
    if (precision <= 0) continue;

    effects.push(
      candidateEffect(
        {
          shape: 'omission',
          kind: `absent:${recurrence.stream}`,
          key: `absent:${recurrence.key}`,
          surprise: absenceSurprise(gapMs, meanMs),
          precision,
          valueHalfLifeMs: recurrence.valueHalfLifeMs,
          observation: stream.describeAbsence(gapMs, learned ? recurrence : { ...recurrence, intervalMs: { ...recurrence.intervalMs, mean: meanMs } }),
          evidence: [
            learned ? `usual gap ${Math.round(meanMs / MINUTE)} min` : `expected every ${Math.round(meanMs / MINUTE)} min (declared, not learned)`,
            `n=${recurrence.intervalMs.n}`,
            `${Math.round(overdueSd * 10) / 10} sd overdue`,
            `coverage ${Math.round(coverage * 100)}%`,
          ],
          concerns: concernsFor(state, recurrence),
        },
        event.id,
        event.ts,
        `absent:${recurrence.key}`,
      ),
    );

    recurring[recurrence.key] = { ...recurrence, armed: false, disarmedOn: localToday };
    disarmed = true;
  }

  // Interval drift — a recurrence whose gap is systematically stretching or
  // compressing. Keyed by day so it is restated at most daily rather than once ever:
  // a slope that is still worsening a week later is news again.
  for (const recurrence of Object.values(state.expectations.recurring)) {
    if (recurrence.driftSamples < MIN_DRIFT_SAMPLES) continue;
    if (Math.abs(recurrence.driftPerDayMs) < MIN_DRIFT_PER_DAY_MS) continue;
    const stream = streamFor(recurrence);
    if (!stream?.describeDrift) continue;

    effects.push(
      candidateEffect(
        {
          shape: 'drift',
          kind: `drift:${recurrence.stream}`,
          key: `drift:${recurrence.key}`,
          surprise: Math.abs(recurrence.driftPerDayMs) / Math.max(recurrence.intervalMs.mean, MINUTE),
          precision: Math.min(1, recurrence.driftSamples / 20),
          valueHalfLifeMs: null,
          observation: stream.describeDrift(recurrence.driftPerDayMs, recurrence),
          evidence: [`${Math.round(recurrence.driftPerDayMs / MINUTE)} min/day`, `n=${recurrence.driftSamples}`],
          concerns: [],
        },
        event.id,
        event.ts,
        `drift:${recurrence.key}`,
      ),
    );
  }

  // The day-end pair, both off the phase series rather than an interval.
  const dayEnd = dayEndCandidates(state, event.id, event.ts);
  effects.push(...dayEnd.effects);

  const changed = disarmed || dayEnd.notice !== null;
  const nextState = changed
    ? {
        ...state,
        expectations: {
          ...state.expectations,
          recurring: disarmed ? recurring : state.expectations.recurring,
          dayEndNotice: dayEnd.notice ?? state.expectations.dayEndNotice,
        },
      }
    : state;
  return { state: nextState, effects };
};

/** Ids of open commitments a recurrence plausibly touches — the current-concerns gain. */
function concernsFor(state: KernelState, recurrence: Recurrence): string[] {
  if (!recurrence.stream.startsWith('repo:')) return [];
  const projectId = recurrence.stream.slice('repo:'.length);
  return state.commitments.open.filter((c) => c.projectId === projectId).map((c) => c.id);
}

/**
 * "You are hours past where your days normally end", and "your stop time has been
 * sliding".
 *
 * The first is a genuine prediction error against a median with real evidence behind
 * it, and it decays fast — it is worth knowing at 02:40 and near-worthless at
 * breakfast, which is what routes it to the interrupting channel. The second is the
 * drift a nervous system structurally cannot feel, and it does not decay at all.
 */
function dayEndCandidates(state: KernelState, eventId: string, ts: string): { effects: Effect[]; notice: KernelState['expectations']['dayEndNotice'] | null } {
  const samples = state.expectations.dayEnd;
  if (samples.length < MIN_DAY_END_SAMPLES) return { effects: [], notice: null };

  const effects: Effect[] = [];
  let notice: KernelState['expectations']['dayEndNotice'] | null = null;
  const marker = state.expectations.dayEndNotice;
  const timezone = state.config.timezone;
  // Today's own partial figure must not vote on what "normally" is, or a long night
  // quietly raises the bar it is being measured against.
  const today = samples[samples.length - 1]!.day;
  const history = samples.filter((s) => s.day !== today);
  const median = medianDayEndMinutes(history);

  if (median !== null && history.length >= MIN_DAY_END_SAMPLES - 1) {
    // K0.6b — the same zero the samples use. Read as minutes past midnight it
    // reset to 0 at 00:00 while the median sat near 1380, so `pastBy` went
    // hugely negative exactly when the owner was up late: `day-runs-long` has
    // fired zero times in fifty-four days of a record with ten nights past
    // midnight. The notice about working late was silent while working late.
    const nowMinutes = wakingMinute(ts, timezone);
    const spread = Math.max(30, madMinutes(history, median));
    const pastBy = nowMinutes - median;
    // The owner has to actually be AT the machine. `input:activity` emits on a fixed
    // cadence whenever the daemon is up, so neither coverage nor a recent event can
    // tell us anyone is there — `idleTrack`'s flag is the one signal that can, since
    // it requires 30 consecutive windows of genuine zero input to set.
    //
    // Without this the candidate fires every night at the same hour on a machine
    // left switched on, which is the difference between "you are still working at
    // 02:40" and "your laptop is still open".
    const stillActive = !state.lifeEvent.idle.isIdle;
    // Once per day, not once per tick. A late night is one fact however many minutes it
    // goes on for.
    if (stillActive && pastBy >= 2 * spread && marker.runsLongDay !== today) {
      notice = { ...marker, runsLongDay: today };
      effects.push(
        candidateEffect(
          {
            shape: 'prediction-error',
            kind: 'day-runs-long',
            key: `day-runs-long:${today}`,
            surprise: pastBy / spread,
            precision: dayEndPrecision(history.length),
            valueHalfLifeMs: 90 * MINUTE,
            observation: `${Math.round(pastBy)} minutes past where your days normally end (${fmtClock(median)})`,
            evidence: [`usual stop ${fmtClock(median)}`, `spread ±${Math.round(spread)} min`, `n=${history.length} days`],
            concerns: state.commitments.open.map((c) => c.id),
          },
          eventId,
          ts,
          `day-runs-long:${today}`,
        ),
      );
    }
  }

  const slope = dayEndDriftPerDay(history);
  const driftKey = `day-end-drift:${weekKey(ts, timezone)}`;
  // Once per week. A slope still present next week is worth restating; the same slope
  // restated every tick is a producer talking to itself.
  if (Math.abs(slope) >= MIN_DAY_END_DRIFT_MIN_PER_DAY && marker.driftKey !== driftKey) {
    notice = { ...(notice ?? marker), driftKey };
    const latest = medianDayEndMinutes(history.slice(-3));
    effects.push(
      candidateEffect(
        {
          shape: 'drift',
          kind: 'day-end-drift',
          // Weekly key: a slope that is still there next week is worth restating, but
          // not every day while it persists.
          key: driftKey,
          surprise: Math.abs(slope) / MIN_DAY_END_DRIFT_MIN_PER_DAY,
          precision: dayEndPrecision(history.length),
          valueHalfLifeMs: null,
          observation: `your day has been ending about ${Math.abs(Math.round(slope))} minutes ${slope > 0 ? 'later' : 'earlier'} each day${latest !== null ? `, now around ${fmtClock(latest)}` : ''}`,
          evidence: [`${Math.round(slope)} min/day`, `over ${history.length} days`],
          concerns: [],
        },
        eventId,
        ts,
        driftKey,
      ),
    );
  }

  return { effects, notice };
}

/** Median absolute deviation — spread that one all-nighter cannot inflate. */
function madMinutes(samples: { minutes: number }[], median: number): number {
  const deviations = samples.map((s) => Math.abs(s.minutes - median)).sort((a, b) => a - b);
  const mid = Math.floor(deviations.length / 2);
  return deviations.length % 2 === 0 ? (deviations[mid - 1]! + deviations[mid]!) / 2 : deviations[mid]!;
}

/**
 * A waking-day minute as a wall clock the owner reads — K0.6b.
 *
 * Minutes count from `WAKING_DAY_START_HOUR`, so the four hours have to go back
 * on before this is a time of day. Without it every one of these notices would
 * report a stop four hours early and read as a person who knocks off at 19:00.
 */
function fmtClock(minutes: number): string {
  const m = ((Math.round(minutes) + WAKING_DAY_START_HOUR * 60) % 1440 + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** ISO-ish week bucket, only ever used as a dedupe key. */
function weekKey(ts: string, timezone: string): string {
  const ms = Date.parse(ts);
  void timezone;
  return `w${Math.floor(ms / (7 * DAY))}`;
}
