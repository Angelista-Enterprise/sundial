// The forecast record: each forecaster's calibration bins and skill against its fair opponent, with n.
import { skillVsConstant, skillVsPastBaseline } from '../shell/calibration.js'
// The same predicate `researchGoals` opens a goal by, so the surface says what the fold waits for.
import { LEARNED_LOSS_DROP, gapEligibility } from '@sundial/kernel/gap-eligibility.js'
import { getCalibrationBins, listResolvedPredictions, tallyPredictions } from '@sundial/db/index.js'

export async function readCalibration({ state, now }) {
  // Bins come from their own aggregate now, not from a slice of rows. The
  // page used to decile the most recent 500 resolved predictions while the
  // tally beside it counted all 1,649 — two figures on one card describing
  // two different populations, with nothing saying so. And they are PER
  // FORECASTER: calibration is a property of a forecaster, and three of them
  // pooled is three curves laid on top of each other.
  const [tally, resolved, bins] = await Promise.all([tallyPredictions(), listResolvedPredictions({ limit: 40 }), getCalibrationBins()])
  const mind = state?.mind ?? {}
  return {
    // Skill rides ON the tally now, and it is computed against a constant at
    // the target's own base rate rather than against a `base-rate`
    // forecaster that has bet three times in the whole record. See
    // `skillVsConstant`: the old figure showed +72% against a
    // three-observation denominator and filtered the two best forecasters
    // off the board entirely.
    // Two opponents, both named. `skill` is against the oracle constant
    // (fitted with hindsight, and the card says so); `fairSkill` is K0.3's
    // past-only baseline, which only exists for rows written after the
    // column did — hence `fairN` beside it, so the card can refuse a figure
    // with nothing behind it rather than printing a confident percentage.
    tally: tally.map((row) => ({ ...row, skill: skillVsConstant(row), fairSkill: skillVsPastBaseline(row) })),
    bins,
    recent: resolved.slice(0, 40).map((row) => ({
      kind: row.kind,
      forecaster: row.forecaster,
      priorProb: row.priorProb,
      outcome: row.outcome,
      surprise: row.surprise,
      resolvedAt: row.resolvedAt,
    })),
    // The live half: what it is currently most ignorant about (the
    // uncertainty map's own cells, heaviest expected loss first), and every
    // goal it has set itself — the closed ones included, which the Unsaid
    // page drops because it only ever shows the open one.
    // Each cell carries WHY it is or is not being studied. Without it the map
    // is a list of numbers that never becomes a goal for no visible reason —
    // which is exactly what happened between 2026-08-22 and 2026-09-10, when
    // four different thresholds were failing on five different cells and no
    // surface said so.
    gaps: [...(mind.gaps ?? [])]
      .sort((a, b) => b.expectedLoss - a.expectedLoss)
      .slice(0, 12)
      .map((gap) => ({ ...gap, ...gapEligibility(gap, mind.goals ?? [], now) })),
    goals: (mind.goals ?? []).map((goal) => {
      // How far an open goal has actually got: the reducible loss it opened
      // with, against what that cell carries now. `null` when the cell has
      // left the top-five map, which is the one case where "no progress" and
      // "not measurable" are different things and must not be shown alike.
      const cell = (mind.gaps ?? []).find((gap) => `${gap.forecaster}:${gap.cell}` === goal.id) ?? null
      const opened = goal.openedWith?.excessLoss ?? 0
      const nowExcess = cell?.excessLoss ?? null
      return {
        ...goal,
        nowExcess,
        // The bar it has to clear to close as learned, in the same unit.
        targetExcess: opened > 0 ? opened * (1 - LEARNED_LOSS_DROP) : null,
        progress: opened > 0 && nowExcess !== null ? Math.max(0, Math.min(1, (opened - nowExcess) / (opened * LEARNED_LOSS_DROP))) : null,
      }
    }),
    // The bets currently in flight, and the `hour-fragmented` forecaster's own
    // two cells. A forecaster with no visible open position is one whose
    // resolution nobody can check against what it actually claimed — and this
    // one's cells ARE its model, small enough to print in full.
    // J2.2c's retirement, kept — but the LEADERBOARD it used to carry is
    // gone, folded into `tally.skill` above. It joined each forecaster to
    // the `base-rate` forecaster on the same target, which exists only for
    // `hour-fragmented` and only three times, so it printed one nonsense
    // percentage and dropped `day-ending` and `project-touched` on the
    // floor. What survives is the one thing that join really carried:
    // whether the tournament has retired a forecaster from a target.
    retired: state?.predictions?.tournament?.retired ?? {},
    open: (state?.predictions?.open ?? []).map((bet) => ({
      kind: bet.kind,
      priorProb: typeof bet.priorProb === 'number' ? bet.priorProb : (bet.forecasters?.jev ?? bet.forecasters?.['base-rate'] ?? null),
      createdAt: bet.createdAt,
      about:
        typeof bet.about === 'string'
          ? bet.about
          : bet.kind === 'hour-fragmented'
          ? `${bet.day} ${String(bet.hour).padStart(2, '0')}:00 · ${bet.prevState}`
          : bet.kind === 'project-touched'
            ? `${bet.day} · ${bet.project}`
            : `hour ${bet.hour}`,
    })),
    // Each forecaster's cells ARE its model, small enough to print in full:
    // the two lag cells of `hour-fragmented`, and one cell per project for
    // `project-touched`.
    cells: [
      ...Object.entries(state?.predictions?.fragmentation?.byPrevState ?? {}).map(([cell, counts]) => ({
        kind: 'hour-fragmented',
        cell,
        n: counts.n,
        hits: counts.hits,
        rate: counts.n === 0 ? null : counts.hits / counts.n,
      })),
      ...Object.entries(state?.predictions?.projectTouch?.byProject ?? {})
        .sort((a, b) => b[1].n - a[1].n)
        .map(([cell, counts]) => ({
          kind: 'project-touched',
          cell,
          n: counts.n,
          hits: counts.hits,
          rate: counts.n === 0 ? null : counts.hits / counts.n,
        })),
    ],
  }
}
