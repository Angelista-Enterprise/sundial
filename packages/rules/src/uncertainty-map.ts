import type { KernelState, Rule, UncertaintyGap } from '@sundial/kernel/types.js';
import { fragmentationPrior } from './hour-fragmented-forecast.js';
import { projectTouchPrior } from './project-touch-forecast.js';

/**
 * How many cells the map keeps. Bounded because this slice rides in every
 * snapshot, and because a ranked list of ignorance is only readable while it is
 * short — twenty-four hours of "here is how unsure I am" is a table, not a
 * finding.
 */
const MAX_GAPS = 5;

/** Matches `day-shape-forecast.ts`, so the probability scored here is the one that forecaster would actually produce. */
const HOUR_RATE_SMOOTHING = 6;
const UNINFORMED_DAY_ENDING_RATE = 1 / 24;
const PROB_EPS = 0.02;

const clampProb = (p: number): number => Math.max(PROB_EPS, Math.min(1 - PROB_EPS, p));

/**
 * Posterior mean of `Beta(hits + 1, n − hits + 1)` — the daemon's belief about
 * a cell's true rate, as opposed to the smoothed number it will actually
 * predict.
 *
 * The `+1`s are the uninformative prior, not a fudge: an hour seen once and
 * never a day's last is `Beta(1, 2)`, mean 1/3, which is honestly unsure. The
 * raw frequency would say 0.0 with total confidence.
 */
export function posteriorMean(n: number, hits: number): number {
  return (hits + 1) / (n + 2);
}

/**
 * What the forecaster expects to LOSE in this cell — the quantity that turned
 * out to describe its real weaknesses.
 *
 * Expected log-loss under the posterior: the cell's believed rate says how
 * often each outcome will come up, and the forecaster's own smoothed prior says
 * what it will bet. `−(θ̄·ln p + (1−θ̄)·ln(1−p))`. It is high both when a cell
 * is genuinely close to a coin flip and when belief and bet have come apart,
 * which is the case a variance measure cannot see at all.
 *
 * **The obvious metric was tried first and was backwards.** Ranking by the
 * variance of the same Beta posterior scored 0.35× — the flagged hours were the
 * ones the forecaster handled BEST. The reason is that `day-ending` is a rare
 * event at a ~6% base rate, so maximal variance picks out the balanced cells,
 * which are exactly the hours that genuinely do often end a day and are
 * therefore well predicted. Meanwhile the damage lives in hours the forecaster
 * is confidently sure about and occasionally wrong on, where a single miss
 * costs far more than a whole day of well-calibrated guesses. Ranking by thin
 * sample size scored 0.20×, worse still.
 *
 * Measured by `apps/daemon/src/scripts/measure-uncertainty-map.ts`: 1.46× on
 * the 19-day reference corpus, against a 1.2× bar. Re-run it before changing
 * this function.
 */
export function expectedLogLoss(n: number, hits: number, predicted: number): number {
  const believed = posteriorMean(n, hits);
  const p = clampProb(predicted);
  return -(believed * Math.log(p) + (1 - believed) * Math.log(1 - p));
}

/**
 * The cell's own entropy — the part of `expectedLogLoss` that no amount of
 * evidence can remove.
 *
 * A cell believed to fire half the time costs 0.69 nats to predict even from a
 * perfectly calibrated forecaster, because the outcome really is that
 * uncertain. This is a property of the owner's day, not a deficiency in
 * Gnomon.
 */
export function cellEntropy(n: number, hits: number): number {
  const believed = clampProb(posteriorMean(n, hits));
  return -(believed * Math.log(believed) + (1 - believed) * Math.log(1 - believed));
}

/**
 * The REDUCIBLE part: how far the forecaster's bet sits from the cell's own
 * belief, in nats. `expectedLogLoss = cellEntropy + excessLogLoss` exactly —
 * this is the KL divergence between believed and predicted.
 *
 * Split out because `expectedLogLoss` is the right thing to RANK by and the
 * wrong thing to judge PROGRESS by. Ranking wants total expected damage;
 * progress wants only the share that learning can retire. A `researchGoals`
 * criterion written against the total set its finish line under the entropy
 * floor and could never be met — see the note on `UncertaintyGap.excessLoss`.
 *
 * Zero when the forecaster already bets exactly what the cell believes, which
 * is precisely "this cell has been learned".
 */
export function excessLogLoss(n: number, hits: number, predicted: number): number {
  // Computed as the difference rather than as a separate KL formula, so the
  // identity holds by construction and the two can never drift apart.
  return Math.max(0, expectedLogLoss(n, hits, predicted) - cellEntropy(n, hits));
}

/** The `day-ending` forecaster's own smoothed prior, reproduced so the loss estimated here is the loss it would really take. */
function hourlyPrior(hourlyDoneRate: KernelState['predictions']['hourlyDoneRate'], hour: number): number {
  let n = 0;
  let hits = 0;
  for (const cell of Object.values(hourlyDoneRate)) {
    n += cell.n;
    hits += cell.hits;
  }
  const base = n === 0 ? UNINFORMED_DAY_ENDING_RATE : hits / n;
  const cell = hourlyDoneRate[hour] ?? { n: 0, hits: 0 };
  return clampProb((cell.hits + base * HOUR_RATE_SMOOTHING) / (cell.n + HOUR_RATE_SMOOTHING));
}

/** `17` → `17:00`. The forecaster keys by local hour; a reader should not have to know that. */
function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function rankGaps(predictions: KernelState['predictions']): UncertaintyGap[] {
  const hourlyDoneRate = predictions.hourlyDoneRate;
  const gaps: UncertaintyGap[] = [];
  for (const [key, cell] of Object.entries(hourlyDoneRate)) {
    // An hour never observed is an absence of behaviour, not uncertainty about
    // it. Including them would rank the small hours at the top of every list —
    // maximally unknown and completely uninteresting.
    if (cell.n <= 0) continue;
    const hour = Number(key);
    const predicted = hourlyPrior(hourlyDoneRate, hour);

    // A cell with PROVEN structure is scored on its conditioned bets: the
    // sample-weighted loss over the arms, each arm judged against the bet the
    // forecaster actually places there. This is where an accepted trial's
    // information gain becomes a real fall in the map — the explained share of
    // the cell's apparent entropy leaves both losses, so the map stops ranking
    // a cell the daemon has already understood.
    const conditioned = predictions.conditioned[hour];
    if (conditioned) {
      const arms = [conditioned.arms.when, conditioned.arms.otherwise].filter((arm) => arm.n > 0);
      const total = arms.reduce((sum, arm) => sum + arm.n, 0);
      if (total > 0) {
        let expected = 0;
        let excess = 0;
        for (const arm of arms) {
          // Same smoothing shape as the live conditioned bet in day-shape-forecast.
          const bet = clampProb((arm.hits + predicted * HOUR_RATE_SMOOTHING) / (arm.n + HOUR_RATE_SMOOTHING));
          expected += (arm.n / total) * expectedLogLoss(arm.n, arm.hits, bet);
          excess += (arm.n / total) * excessLogLoss(arm.n, arm.hits, bet);
        }
        gaps.push({
          kind: 'day-ending',
          forecaster: 'hourly-rate-conditioned',
          cell: key,
          label: Number.isFinite(hour) ? hourLabel(hour) : key,
          n: cell.n,
          hits: cell.hits,
          expectedLoss: expected,
          excessLoss: excess,
        });
        continue;
      }
    }

    gaps.push({
      kind: 'day-ending',
      forecaster: 'hourly-rate',
      cell: key,
      label: Number.isFinite(hour) ? hourLabel(hour) : key,
      n: cell.n,
      hits: cell.hits,
      // Ranking is UNCHANGED — `expectedLoss` still orders the map, and its
      // 1.46× out-of-sample validation still stands. `excessLoss` is carried
      // alongside for `researchGoals` to judge progress by; it does not sort.
      expectedLoss: expectedLogLoss(cell.n, cell.hits, predicted),
      excessLoss: excessLogLoss(cell.n, cell.hits, predicted),
    });
  }

  // The other two forecasters' cells, scored the same way against the bet each
  // would actually place there (their own exported priors, so the smoothing
  // cannot drift from the live rule). Until 2026-09-04 the map ranked only
  // `hourly-rate`, so a research goal could never ask about a fragmented hour
  // or a project — the two forecasters were invisible to the daemon's own
  // sense of what it predicts badly.
  for (const [key, cell] of Object.entries(predictions.fragmentation.byPrevState)) {
    if (cell.n <= 0) continue;
    const predicted = fragmentationPrior(predictions.fragmentation, key as 'prev-frag' | 'prev-calm');
    gaps.push({
      kind: 'hour-fragmented',
      forecaster: 'prev-hour-lag',
      cell: key,
      label: key === 'prev-frag' ? 'an hour after a fragmented one' : 'an hour after a calm one',
      n: cell.n,
      hits: cell.hits,
      expectedLoss: expectedLogLoss(cell.n, cell.hits, predicted),
      excessLoss: excessLogLoss(cell.n, cell.hits, predicted),
    });
  }
  for (const [project, cell] of Object.entries(predictions.projectTouch.byProject)) {
    if (cell.n <= 0) continue;
    const predicted = projectTouchPrior(predictions.projectTouch, project);
    gaps.push({
      kind: 'project-touched',
      forecaster: 'project-rate',
      cell: project,
      label: `the project ${project.replace(/^named:/, '').split('/').pop() ?? project}`,
      n: cell.n,
      hits: cell.hits,
      expectedLoss: expectedLogLoss(cell.n, cell.hits, predicted),
      excessLoss: excessLogLoss(cell.n, cell.hits, predicted),
    });
  }

  // Worst first; ties broken by the thinner sample, which is the one more
  // evidence would move fastest.
  return gaps.sort((a, b) => b.expectedLoss - a.expectedLoss || a.n - b.n).slice(0, MAX_GAPS);
}

/** Cheap structural compare, so an unchanged map does not churn a fresh state object every tick. */
function sameGaps(a: UncertaintyGap[], b: UncertaintyGap[]): boolean {
  // `excessLoss` must be part of the identity, for two reasons the (cell, n,
  // hits) triple cannot see. A SHAPE change: gaps persisted before the field
  // existed match a fresh ranking on all three keys, so the early-exit kept the
  // old objects and the new field could not enter live state until a count
  // happened to move — `researchGoals` then read `undefined` off every gap for
  // up to a day. And PRIOR drift: the bet is smoothed against the whole table,
  // so other cells' counts move this cell's losses while its own n/hits sit
  // still. Not compared on `expectedLoss` too because that is entropy(n, hits)
  // plus this — anything that moves it moves a field already compared.
  return a.length === b.length && a.every((gap, i) => gap.cell === b[i]?.cell && gap.n === b[i]?.n && gap.hits === b[i]?.hits && gap.excessLoss === b[i]?.excessLoss);
}

/**
 * The map of what the daemon does not know about its owner.
 *
 * Every other endogenous-life rule points outward — surprise at an observation,
 * a forecast about the next hour. This one points at the forecaster itself and
 * asks where its own estimates are weakest, which is the honest, inward half of
 * an epistemic drive: knowing where you are ignorant, without yet acting to fix
 * it. Acting on it — proposing that the owner change something so the daemon can
 * learn — is deliberately NOT here; `decisions/assistant-as-an-event-source`
 * walls off outward action, and a nudge issued for the daemon's own benefit sits
 * on the far side of that wall.
 *
 * A pure readout, like `mindTrack`: no effects, and it never writes the counts
 * it reads. It rides `clock:tick` rather than recomputing on every resolution,
 * because a ranking that changes mid-fold is a ranking nothing can render
 * stably.
 *
 * **The claim it makes is falsifiable, and the first version of it was false.**
 * An uncertainty estimate is a prediction about the forecaster's own future
 * errors, so the cells it flags must actually score worse on days it has not
 * seen. Ranked by Beta variance — the obvious choice — they scored 0.35×, i.e.
 * BETTER than the cells it stayed quiet about, and the surface would have spent
 * the reader's attention on the hours the forecaster already had right. See
 * `expectedLogLoss` for why, and
 * `apps/daemon/src/scripts/measure-uncertainty-map.ts` for the gate, which the
 * shipped ranking passes at 1.46×. Run it again before changing the ranking.
 *
 * Placed after `dayShapeForecast` (whose resolutions move the table it reads)
 * and before `mindTrack`, so `state.mind` is fully derived by the end of a tick.
 * Both spread `state.mind` rather than replacing it, so neither clobbers the
 * other's fields.
 */
export const uncertaintyMap: Rule = (state, event) => {
  if (event.type !== 'clock:tick') return { state, effects: [] };

  const gaps = rankGaps(state.predictions);
  if (sameGaps(gaps, state.mind.gaps)) return { state, effects: [] };

  return { state: { ...state, mind: { ...state.mind, gaps } }, effects: [] };
};

export const MAX_UNCERTAINTY_GAPS = MAX_GAPS;
