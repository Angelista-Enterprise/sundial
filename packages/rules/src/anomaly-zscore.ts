import { deriveId } from '@sundial/helpers/derive-id.js';
import { localHour } from '@sundial/helpers/local-day.js';
import { attendedMs } from './focus-score.js';
import type { Effect, KernelState, Rule } from '@sundial/kernel/types.js';
import { coverageOver } from './coverage-track.js';
import { isMomentClosingBoundary } from './moment-close.js';

const ANOMALY_THRESHOLD = 2;
/**
 * Baseline samples required before an hour bucket may produce an anomaly at all.
 *
 * `computeZScore`'s own `MIN_SAMPLES_REQUIRED` stays at 2 because it is a maths
 * helper and the caller owns the question of adequacy — this is that judgement,
 * and it is a measurement rather than a preference. All 17 companion insights
 * deleted on 2026-08-02 came from this detector; their sample sizes ran as low as
 * TWO, their z-scores clustered at 2.04-2.95 against a threshold of 2, and the
 * observations they flagged were four-to-eight-minute stretches against a corpus
 * whose median moment is under one minute. "You concentrated on one thing for six
 * minutes" is not an anomaly, it is the segmentation restating itself.
 *
 * Ten is where the per-hour baseline stops being dominated by whichever two
 * moments happened to land there first.
 */
const MIN_BASELINE_SAMPLES = 10;
/**
 * Absolute floor on the observation itself, independent of the z-score.
 *
 * A deviation can be statistically real and still not worth anyone's attention. The
 * z-score answers "is this unusual for this hour"; this answers "is there enough of
 * it to be worth a sentence", and both have to hold.
 */
const MIN_ANOMALY_MINUTES = 12;
/** ~2 months of daily samples per hour bucket — bounds memory/snapshot size without needing a separate rolling_profiles table (WCS's version); the rolling window lives directly in KernelState. */
const MAX_SAMPLES_PER_HOUR = 60;
const MIN_SAMPLES_REQUIRED = 2;
// B5 (docs/audit/production-proposal-and-enhancements.md, fixes A§3.4) — a
// moment shorter than this isn't representative of "typical" activity for
// its hour; sampling it into the baseline (or judging it against one) would
// mostly measure noise from a brief-but-real B1 moment, not a real pattern.
const MIN_SAMPLE_DURATION_MINUTES = 1;

/**
 * Unobserved time a dwell measurement may span before it stops being about the owner.
 *
 * Elapsed wall-clock is not dwell. If the machine slept, or the daemon was down, the
 * span between a moment's start and now contains time nobody watched, and crediting it
 * as attention is a claim about the daemon's uptime wearing a claim about the owner —
 * the same sentence `coverageTrack` earned fixing the absence checks.
 *
 * Measured incident, 2026-08-12: the first `clock:tick` after an overnight sleep
 * computed 1266.8 minutes (21.1 hours) of Chrome against a baseline whose hour had
 * real samples, producing z=772.15 — three orders of magnitude past
 * `ANOMALY_THRESHOLD` — and fired 1.8 seconds BEFORE the `system:sleep-wake` signal
 * could reconcile the stale moment. The race is structural: the clock heartbeat
 * resumes immediately on wake while the sleep-wake sidecar file is polled, so the
 * first tick after any wake can always beat reconciliation. That candidate cleared
 * every gate threshold trivially and wrote a false insight to `knowledge_entries`,
 * while `surpriseDrive` absorbed 772 nats of fictitious surprise into the mood drive.
 *
 * Fifteen minutes is deliberately generous: it is longer than any restart hole (the
 * emission stream leaves 82-93 second gaps) and longer than the coarseness of the
 * hour-bucket coverage grid can manufacture, so a legitimately-watched session never
 * trips it, while any real sleep or outage does.
 */
export const MAX_UNOBSERVED_GAP_MS = 15 * 60_000;

/**
 * Unobserved milliseconds inside `[startMs, nowMs)` — elapsed time minus what
 * `coverageTrack` actually watched — or `null` when there is no observation record
 * to consult at all.
 *
 * The `null` is the important return, and it is not the same as zero. An empty
 * `observedHours` map means this rule has nothing to say about whether the span was
 * watched, which is a different claim from "the span was watched fully". Reporting a
 * full gap there would silence the detector for an hour after every cold boot;
 * reporting no gap would assert an observation nobody made. Callers evaluate on
 * `null` — in production the map is populated within ten seconds of the daemon
 * coming up (`input:activity` emits on a fixed cadence whenever the daemon is up,
 * regardless of activity level) and survives boot replay, so the only window in
 * which this returns `null` is one where no moment can yet have accumulated a gap
 * worth suppressing.
 *
 * Deliberately expressed as an absolute gap rather than a coverage ratio. A ratio
 * floor would reject a short moment sitting in an hour the daemon only joined
 * halfway through — coverage is bucketed by hour, so a 12-minute moment in a
 * half-observed hour reads 0.5 however closely it was actually watched. The absolute
 * gap has no such coupling: it grows only when real time passed unwatched.
 */
export function unobservedGapMs(state: KernelState, startMs: number, nowMs: number): number | null {
  if (!(nowMs > startMs)) return 0;
  const observedHours = state.coverage?.observedHours ?? {};
  if (Object.keys(observedHours).length === 0) return null;
  const coverage = coverageOver(observedHours, startMs, nowMs, state.config.timezone);
  return (nowMs - startMs) * (1 - coverage);
}

interface WindowChangedPayload {
  processName?: string;
}

/**
 * Ported from WCS's `anomaly-detector.ts` z-score math (mean/stddev over a
 * rolling baseline, spread floored at 1 to avoid explosive z-scores on
 * near-zero variance, `mean <= 0` special-cased to z=3 if observed>0 else
 * 0). Returns `null` when there isn't enough history yet
 * (`MIN_SAMPLES_REQUIRED`) rather than a meaningless z-score.
 */
export function computeZScore(observed: number, samples: number[]): number | null {
  if (samples.length < MIN_SAMPLES_REQUIRED) return null;

  const mean = samples.reduce((sum, n) => sum + n, 0) / samples.length;
  if (mean <= 0) return observed > 0 ? 3 : 0;

  const variance = samples.reduce((sum, n) => sum + (n - mean) ** 2, 0) / samples.length;
  const spread = Math.max(Math.sqrt(variance), 1);
  return (observed - mean) / spread;
}

/**
 * Shared by both trigger points below (`window:changed` on close,
 * `clock:tick` mid-session) — evaluates `durationMinutes` against the
 * rolling baseline for `startTime`'s **local** hour (B5 — was
 * `getUTCHours()`; for any non-UTC user, "late night" was systematically
 * shifted by their own UTC offset), optionally records it as a new sample,
 * and emits `anomaly:detected` at most once per hour-bucket per calendar
 * day (`lastAnomalyByKind`'s existing dedup, unchanged).
 */
function evaluateAnomaly(
  state: KernelState,
  eventId: string,
  ts: string,
  startTime: string,
  durationMinutes: number,
  processName: string,
  nextProcessName: string | null,
  recordSample: boolean,
): { state: KernelState; effects: Effect[] } {
  if (durationMinutes < MIN_SAMPLE_DURATION_MINUTES) return { state, effects: [] };

  // Before anything else, and before the baseline is touched: is this duration a
  // measurement at all? A span containing unobserved time is neither a valid sample
  // (it would teach the hour's mean a number nobody watched — defect class #1 from
  // the noticing corpus, "overnight gaps mislearned as intervals") nor a valid
  // observation to judge. Returning the state unchanged is the whole fix: no sample
  // recorded, no anomaly emitted, no dedup slot spent, so the next honestly-measured
  // moment in this hour is still free to report.
  const gapMs = unobservedGapMs(state, Date.parse(startTime), Date.parse(ts));
  if (gapMs !== null && gapMs > MAX_UNOBSERVED_GAP_MS) return { state, effects: [] };

  const hour = localHour(startTime, state.config.timezone);
  const bucketKey = String(hour);
  const samples = state.baselines.hourlyDurationsByKind[bucketKey] ?? [];
  const z = computeZScore(durationMinutes, samples);

  // Only touches `hourlyDurationsByKind` when actually recording a sample —
  // a mid-session `clock:tick` evaluation (recordSample=false) must not
  // write a same-value/empty entry for an hour bucket just from looking at
  // it, or every unsampled hour would still grow a spurious map key on
  // every tick (A5's bounded-state concern).
  const baselinesAfterSample = recordSample
    ? { ...state.baselines, hourlyDurationsByKind: { ...state.baselines.hourlyDurationsByKind, [bucketKey]: [...samples, durationMinutes].slice(-MAX_SAMPLES_PER_HOUR) } }
    : state.baselines;

  // Three gates, all of which must hold. The sample and duration floors were added
  // 2026-08-02 with the noticing gate: they apply HERE rather than only at the
  // surface, because `surpriseDrive` reads this same event into
  // `memory.accumulatedImportance`, which drives mood and schedules
  // `endogenousReflection`. A four-minute dwell against a two-sample baseline is not
  // surprise for the owner and it is not surprise for the daemon either — feeding it
  // to the drive made mood a readout of window-dwell noise.
  if (z === null || Math.abs(z) < ANOMALY_THRESHOLD || samples.length < MIN_BASELINE_SAMPLES || durationMinutes < MIN_ANOMALY_MINUTES) {
    return { state: { ...state, baselines: baselinesAfterSample }, effects: [] };
  }

  const today = ts.slice(0, 10);
  const lastEmitted = state.baselines.lastAnomalyByKind[bucketKey];
  if (lastEmitted && lastEmitted.slice(0, 10) === today) {
    return { state: { ...state, baselines: baselinesAfterSample }, effects: [] };
  }

  return {
    state: {
      ...state,
      baselines: { ...baselinesAfterSample, lastAnomalyByKind: { ...baselinesAfterSample.lastAnomalyByKind, [bucketKey]: ts } },
    },
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(ts, eventId, 'anomaly-zscore'),
          type: 'anomaly:detected',
          ts,
          payload: {
            timestamp: ts,
            kind: z > 0 ? 'high-activity' : 'low-activity',
            hourOfDay: hour,
            lateNight: hour >= 22 || hour < 5,
            observedMinutes: Math.round(durationMinutes * 10) / 10,
            sampleSize: samples.length,
            zScore: Math.round(z * 100) / 100,
            processName,
            nextProcessName,
          },
        },
      },
    ],
  };
}

/**
 * Reacts to `window:changed` (same ordering requirement as `contextSwitch`/
 * `momentAnalysisSchedule` — MUST run before `momentClose` to read
 * `state.moment` as the about-to-close moment) **and**, since B5, to
 * `clock:tick` — fixes A§3.4's "an all-night session in one window is
 * invisible until the user finally switches away": every clock tick now
 * also evaluates the *currently open* moment's elapsed duration so far
 * against its hour's baseline, without recording it as a sample (its final
 * duration isn't known yet — that would corrupt the baseline with a partial
 * value). The existing per-hour-per-day dedup means a mid-session emission
 * from `clock:tick` naturally suppresses a duplicate when the same moment
 * later closes still-anomalously via `window:changed`.
 *
 * Deliberate simplification vs WCS: no separate `rolling_profiles` DB table
 * or `setInterval`-driven periodic recompute — the rolling baseline lives
 * directly in `state.baselines.hourlyDurationsByKind`, updated inline as
 * each moment closes, which is what a reducer-driven architecture is for.
 * Dedup also improves on WCS's flaky reset proxy (clearing an in-memory Set
 * when a query "happens to" return zero moments, guessing at midnight): here
 * `lastAnomalyByKind` stores the last-emitted ISO timestamp, and a fresh
 * anomaly for the same hour bucket is only suppressed if it falls on the
 * *same calendar date* as the stored one — the date comparison itself is
 * the reset, no separate boundary event needed.
 */
export const anomalyZscore: Rule = (state, event) => {
  if (event.type === 'clock:tick') {
    if (!state.moment) return { state, effects: [] };
    const durationMinutes = attendedMs(state.moment.rollup, Math.max(0, Date.parse(event.ts) - Date.parse(state.moment.startTime))) / 60_000;
    return evaluateAnomaly(state, event.id, event.ts, state.moment.startTime, durationMinutes, state.moment.processName, null, false);
  }

  if (event.type !== 'window:changed') return { state, effects: [] };

  const closing = state.moment;
  if (!closing) return { state, effects: [] };

  // D2-adjacent fix (see moment-close.ts's `isMomentClosingBoundary` doc
  // comment) — a same-process/same-project title change appends to the
  // open moment (B1), not a real close; without this check, every title
  // change recorded a new (growing, overlapping) duration sample into the
  // hour's baseline for what is really one ongoing session, and could fire
  // a spurious anomaly on each one. The `clock:tick` branch above already
  // covers "is this still-open moment running anomalously long" on its own
  // periodic cadence without recording a sample — nothing is lost by
  // skipping the mid-session check here too.
  if (!isMomentClosingBoundary(state, event)) return { state, effects: [] };

  // Dwell is ATTENDED time, not wall time (see `attendedMs`): the 21.1-hour
  // Chrome "dwell" across an overnight sleep that once produced a false insight
  // had zero input for 20 of those hours.
  const durationMinutes = attendedMs(closing.rollup, Math.max(0, Date.parse(event.ts) - Date.parse(closing.startTime))) / 60_000;
  const newProcessName = typeof (event.payload as WindowChangedPayload).processName === 'string' ? (event.payload as WindowChangedPayload).processName! : 'unknown';
  return evaluateAnomaly(state, event.id, event.ts, closing.startTime, durationMinutes, closing.processName, newProcessName, true);
};
