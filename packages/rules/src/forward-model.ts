import type { KernelState } from '@sundial/kernel/types.js';

/** Clamp probabilities away from 0/1 so log-loss stays finite (a miss at p=1 would be infinite surprise). */
export const PROB_EPS = 0.02;
export const clampProb = (p: number): number => Math.max(PROB_EPS, Math.min(1 - PROB_EPS, p));

type CalibrationEntry = { n: number; hits: number; brierSum: number };

/**
 * Shared by every forecaster (`day-shape-forecast.ts` included) so each kind
 * bumps only its own record — see `KernelState.predictions.calibration`'s
 * doc comment for why this is keyed by kind rather than pooled.
 */
/**
 * The target's base rate as it stood BEFORE this resolution — K0.3.
 *
 * The honest opponent for a forecaster. `skillVsConstant` on the Calibration
 * card scores against a constant at the target's own base rate computed with
 * HINDSIGHT over the same bets it scores, which is an oracle and the card says
 * so; the offline harness measures both and the gap is real (+12.3% against
 * the oracle, +14.1% against a past-only running mean for `project-touched`).
 * The live table could not, because nothing stored a past-only figure.
 *
 * It needs no new state. The calibration entry a resolving rule is about to
 * bump already holds `n` and `hits` over every PRIOR resolution of that key,
 * so reading it one line earlier is the running mean — and every forecaster on
 * a shared target accumulates the same outcomes, so a tournament key
 * (`<target>/<forecaster>`) gives the target's rate just as a bare target key
 * does.
 *
 * `null` on the first resolution of a target, which has no past to average.
 * That is the reason the column is nullable and the reason a card must not
 * read a missing baseline as zero.
 */
export function pastRate(cal: KernelState['predictions']['calibration'], key: string): number | null {
  const entry = cal[key];
  return entry !== undefined && entry.n > 0 ? entry.hits / entry.n : null;
}

export function bumpCalibration(cal: KernelState['predictions']['calibration'], kind: string, outcome: 0 | 1, priorProb: number): KernelState['predictions']['calibration'] {
  const entry: CalibrationEntry = cal[kind] ?? { n: 0, hits: 0, brierSum: 0 };
  return { ...cal, [kind]: { n: entry.n + 1, hits: entry.hits + outcome, brierSum: entry.brierSum + (priorProb - outcome) ** 2 } };
}

/**
 * This file used to hold the forward model's first two rules,
 * `predictionForecast` and `predictionResolve`, which forecast
 * `project-continuity` — "the next moment that closes stays in the closing
 * moment's project." Both were retired on 2026-07-29 and what remains is the
 * calibration machinery every other forecaster shares.
 *
 * The reason is measurement, not taste. `continuityPrior` returned the
 * forecaster's own running hit rate (`cal.hits / cal.n`) as the probability
 * for its next forecast, which is a fixed point rather than a model: it
 * predicts the base rate, so it matches the base rate, so it goes on
 * predicting the base rate. It conditioned on nothing — not the project, not
 * the hour, not the calendar, not whether the user was idle — so no quantity
 * of accumulated data could move it. The live record bore that out exactly:
 * a Brier of 0.2495 against a coin flip's 0.25, which is 0.2% skill, over
 * 2,362 resolutions (issues/degenerate-continuity-prior, and the method in
 * guides/measure-forecast-skill).
 *
 * Retiring it rather than conditioning it on real features was an owner
 * decision, and the argument was about D12 rather than about this forecaster.
 * D12 makes calibration the gate on whether the daemon has earned the right
 * to say anything confidently. A gate wired to a number that cannot improve
 * either never opens or teaches its maintainers to route around it, and a
 * calibration gate that gets routed around is worse than no gate — so the
 * dead forecaster goes, and `dayShapeForecast` (kind `day-ending`, +46.1%
 * measured skill from hour of day alone) is left as the sole thing the gate
 * reads.
 *
 * What that concedes, deliberately and on the evidence: Gnomon forecasts the
 * SHAPE of the owner's day and not the CONTENT of it. Every content-shaped
 * target tested scored at or below a constant baseline at every horizon. If a
 * future forecaster wants to predict what the owner will work on, it needs a
 * conditioning feature nobody has found yet — and it must arrive with a
 * measurement, not with a prior derived from its own score.
 *
 * `predictions.recentResolved` and the shared surprise drive are unaffected:
 * both were always per-kind and cross-forecaster, and `day-ending`
 * resolutions keep feeding them.
 */
