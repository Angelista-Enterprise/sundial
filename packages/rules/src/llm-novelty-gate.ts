import type { KernelState } from '@sundial/kernel/types.js';
import { coverageOver } from './coverage-track.js';

/**
 * Whether a scheduled LLM pass has enough new material to be worth making.
 *
 * [FOCAL](https://arxiv.org/abs/2604.19541) measured the shape of this: a
 * planning step reading only METADATA — app names, window titles, never
 * screenshots — decided per action whether the expensive model call was needed at
 * all, and cut vision-model calls by 72.3% while *improving* every quality metric
 * (key-information recall 0.38 → 0.61, judged quality 2.96 → 4.16). Fewer calls won
 * on quality rather than despite it, because the calls it skipped were the ones that
 * would have summarized noise — and noise summarized is noise remembered, which is
 * the same failure Activity Frames measured when LLM summaries scored *below* raw
 * rows and inflated durations 2.9x.
 *
 * Gnomon's version needs no planner and no model. The daemon already knows how much
 * of a window it actually watched, because `coverageTrack` counts `input:activity`
 * emissions — a signal that fires on a fixed cadence whenever the daemon is up
 * regardless of activity level, so its count measures observation time and cannot be
 * confused with activity. A period the daemon barely watched has nothing in it to
 * summarize, whatever the calendar says happened.
 *
 * This is deliberately a floor on OBSERVATION, not on activity. "The owner did
 * little" is a legitimate thing for a journal to say and must still be sayable;
 * "Gnomon saw almost nothing" is not the same claim, and asking a model to write a
 * day up from an hour of coverage is how a confident account of an unobserved day
 * gets written. The distinction is the one `coverageTrack` earned fixing the absence
 * checks, applied to spend.
 */
export interface NoveltyVerdict {
  worthCalling: boolean;
  observedHours: number;
  reason: 'enough-observed' | 'too-little-observed' | 'no-coverage-record';
}

/**
 * Observation floor, in hours, before a summarizing pass is worth its tokens.
 *
 * One hour, against a reference corpus whose MEDIAN observed day is about six —
 * so this excludes roughly the bottom sixth of days rather than a typical one. Set
 * from that measured median rather than guessed, the same discipline
 * `OCCURRENCE_STREAMS`' own `minCoverage` floors were calibrated with after a first
 * version set them above the corpus median and silenced every multi-day claim.
 *
 * Deliberately generous. A pass skipped on a day that deserved one is a silent gap
 * in the record; a pass made on a thin day costs tokens and produces a thin entry.
 * The first failure is worse, so the floor sits well below the typical day.
 */
export const MIN_OBSERVED_HOURS = 1;

/**
 * Longest window a deferred pass may accumulate before it runs regardless.
 *
 * Without this, a machine that is off or unobserved for a fortnight would defer for
 * ever and the window handed to the eventual pass would keep growing — turning a
 * saving into an unbounded prompt. Seven days is past any plausible quiet stretch
 * while still bounding the worst-case prompt.
 */
export const MAX_DEFERRED_WINDOW_MS = 7 * 86_400_000;

export function assessNovelty(state: KernelState, sinceIso: string, nowIso: string): NoveltyVerdict {
  const fromMs = Date.parse(sinceIso);
  const toMs = Date.parse(nowIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return { worthCalling: true, observedHours: 0, reason: 'no-coverage-record' };
  }

  const observedHours = state.coverage?.observedHours ?? {};
  // No record at all is not evidence of an empty period — it is absence of
  // evidence, and the same distinction `unobservedGapMs` draws for the same reason.
  // Fail OPEN: a missing coverage map must never silently stop the daemon writing
  // anything down.
  if (Object.keys(observedHours).length === 0) return { worthCalling: true, observedHours: 0, reason: 'no-coverage-record' };

  // Past the ceiling the pass runs whatever coverage says, so a long quiet stretch
  // cannot defer indefinitely.
  if (toMs - fromMs >= MAX_DEFERRED_WINDOW_MS) {
    return { worthCalling: true, observedHours: (coverageOver(observedHours, fromMs, toMs, state.config.timezone) * (toMs - fromMs)) / 3_600_000, reason: 'enough-observed' };
  }

  const observed = (coverageOver(observedHours, fromMs, toMs, state.config.timezone) * (toMs - fromMs)) / 3_600_000;
  if (observed < MIN_OBSERVED_HOURS) return { worthCalling: false, observedHours: observed, reason: 'too-little-observed' };
  return { worthCalling: true, observedHours: observed, reason: 'enough-observed' };
}
