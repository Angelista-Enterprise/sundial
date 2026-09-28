/**
 * When a cell in the uncertainty map may become a research goal, and — when it
 * may not — why not, in one sentence the owner can read.
 *
 * This lives in the kernel rather than beside `researchGoals` because two
 * places need the same answer and must never disagree about it: the RULE, which
 * decides what to study, and the Calibration surface, which shows the owner
 * what Gnomon is trying to learn and what it is waiting for. A surface that
 * re-derived these four thresholds would drift from the fold the first time one
 * moved, and the owner would be reading a promise the rule does not keep.
 *
 * The reasons matter as much as the verdict. Goals stopped opening on
 * 2026-08-22 and stayed stopped for nineteen days; nothing anywhere said why,
 * and the answer turned out to be four different thresholds failing on five
 * different cells. That is exactly the thing a surface should be able to say.
 *
 * Pure: gaps, goals and a clock in, a verdict out.
 */
import type { ResearchGoal, UncertaintyGap } from './types.js';

/**
 * A cell needs this many observations before its uncertainty is worth pursuing.
 *
 * Below it, `expectedLoss` is dominated by the prior rather than by anything
 * observed, so the "gap" is a statement about the shape of the Beta and not
 * about the owner. Matches the floor `anomalyZscore` applies for the same reason.
 */
export const MIN_EVIDENCE_TO_OPEN = 5;

/**
 * Minimum expected loss, in nats, for a gap to be worth a goal at all.
 *
 * ~0.35 nats is roughly a 70/30 cell. Below that the forecaster is already close
 * enough to right that "learning" it would be noise-fitting, and a goal opened
 * there would close on drift alone and report a discovery that never happened.
 */
export const MIN_LOSS_TO_OPEN = 0.35;

/**
 * A cell must carry at least this much REDUCIBLE loss (nats) before a goal
 * opens on it. `expectedLoss` alone ranks a genuine coin flip at the very top —
 * an hour after a fragmented one comes apart half the time, 0.69 nats, and the
 * forecaster already bets 0.5 there — so once the map covered more than the
 * hourly cells, the first goal it opened was on a question with nothing left to
 * learn. The entropy floor is a fact about the owner's day; a goal is a bet
 * that watching will move the forecaster's bet, and here it cannot.
 */
export const MIN_EXCESS_TO_OPEN = 0.02;

/**
 * How much of the REDUCIBLE loss must burn off before the goal counts as learned.
 *
 * A fraction rather than an absolute: a cell starting at 0.9 nats and one starting
 * at 0.4 are not the same distance from settled, and demanding the same absolute
 * drop from both would make the easy one trivial and the hard one unreachable.
 *
 * Measured against `excessLoss`, NOT `expectedLoss`. Against the total it was
 * unsatisfiable: the total carries the cell's entropy as a floor, a goal only
 * opens on high-loss (hence high-entropy) cells, and so the 30% target landed
 * beneath the floor for every true rate between 0.2 and 0.6. No run of
 * observations, however long or clean, could close such a goal as learned.
 */
export const LEARNED_LOSS_DROP = 0.3;

/** How long a settled cell is left alone before it may be studied again. See `regoalAfter`. */
export const REGOAL_AFTER_MS = 30 * 86_400_000;

/** The longer wait for a cell that closed having learned nothing, so an unlearnable question is not re-asked monthly. */
export const REGOAL_AFTER_UNLEARNABLE_MS = 90 * 86_400_000;

/** The id a gap would carry as a goal. Must match `goalId` in the rule. */
export function gapId(gap: Pick<UncertaintyGap, 'forecaster' | 'cell'>): string {
  return `${gap.forecaster}:${gap.cell}`;
}

/** When a settled goal's cell becomes choosable again. `superseded` never got a fair run, so it waits the short one. */
export function regoalAfter(outcome: ResearchGoal['outcome']): number {
  return outcome === 'stale' ? REGOAL_AFTER_UNLEARNABLE_MS : REGOAL_AFTER_MS;
}

/** Days, rounded up, for a human-facing "not yet" — 0.4 days left is still "1 day". */
function daysLeft(ms: number): number {
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

export interface GapVerdict {
  /** Whether a goal could open on this cell right now. */
  eligible: boolean;
  /**
   * Why not, in the owner's terms, or `null` when it is eligible. Deliberately
   * ONE reason — the first that fails, in the order the rule checks them — so a
   * row reads as a next step rather than as a list of complaints.
   */
  reason: string | null;
}

/**
 * Whether `gap` could become a goal now, and what is holding it back.
 *
 * `goals` is the full history the state keeps, open and closed. A cell is held
 * while its own goal runs, and for a cooling-off period after it settles.
 */
export function gapEligibility(gap: UncertaintyGap, goals: readonly ResearchGoal[], now: number): GapVerdict {
  const id = gapId(gap);
  for (const goal of goals) {
    if (goal.id !== id) continue;
    if (goal.closedAt === null) return { eligible: false, reason: 'being studied now' };
    const until = Date.parse(goal.closedAt) + regoalAfter(goal.outcome);
    if (now < until) {
      const outcome = goal.outcome === 'stale' ? 'learned nothing' : goal.outcome === 'learned' ? 'learned' : 'was set aside';
      return { eligible: false, reason: `studied ${goal.closedAt.slice(0, 10)} and ${outcome} — free again in ${daysLeft(until - now)} days` };
    }
  }
  if (gap.n < MIN_EVIDENCE_TO_OPEN) return { eligible: false, reason: `only ${gap.n} observation${gap.n === 1 ? '' : 's'} — needs ${MIN_EVIDENCE_TO_OPEN}` };
  if (gap.expectedLoss < MIN_LOSS_TO_OPEN) return { eligible: false, reason: 'already predicted well enough to leave alone' };
  if (gap.excessLoss < MIN_EXCESS_TO_OPEN) return { eligible: false, reason: `nothing left to learn — ${gap.excessLoss.toFixed(3)} of ${gap.expectedLoss.toFixed(2)} nats is correctable, and that is mostly the day's own randomness` };
  return { eligible: true, reason: null };
}
