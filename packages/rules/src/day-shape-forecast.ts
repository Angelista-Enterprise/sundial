import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate as localDay, localHour } from '@sundial/helpers/local-day.js';
import { conditionerById, type DayView } from '@sundial/kernel/conditioners.js';
import type { Effect, KernelState, OpenPrediction, ResolvedPrediction, Rule } from '@sundial/kernel/types.js';
import { bumpCalibration, clampProb, hasSkill, pastRate } from './forward-model.js';
import { MAX_ACCUMULATED } from './surprise-drive.js';

const MAX_RECENT_RESOLVED = 50;
/**
 * Which forecaster produced the prior, recorded on every durable row.
 *
 * `hourly-rate` rather than `day-shape-forecast`: the column names the METHOD,
 * not the rule file, because the point of storing it is that a second method
 * can compete on the same `day-ending` target and be scored separately.
 */
const DAY_ENDING_FORECASTER = 'hourly-rate';
/**
 * `input:activity` emits at a constant ~10s cadence regardless of activity
 * level (packages/sensors/src/input-activity/index.ts's `EMIT_WINDOW_MS`),
 * so "3 emits this hour" means "the daemon has been running and observing
 * for ~30s into this hour" — a presence proxy, not a typing threshold. Kept
 * identical to `measure-forecast-skill.ts`'s `ACTIVE_HOUR_MIN_EMITS` so the
 * live forecaster and the offline measurement stay comparable. See
 * enhancements/presence-as-absence-ground-truth for why this label is a
 * genuine but imperfect proxy for "the user is done for the day."
 */
const ACTIVE_HOUR_MIN_EMITS = 3;
/** Pseudo-counts pulling a thin per-hour cell toward the forecaster's own global rate — same technique and constant `measure-forecast-skill.ts`'s `SMOOTHING` uses. */
const HOUR_RATE_SMOOTHING = 6;
/** No evidence yet for any hour: treat all 24 as equally likely to be the day's one last active hour, rather than guessing 0.5 (that's the right uninformed prior for a binary match, not for a pick-one-of-24 question). */
const UNINFORMED_DAY_ENDING_RATE = 1 / 24;

/*
 * LOCAL calendar day and LOCAL hour, deliberately both — "the last hour you
 * were active today" is a claim about the user's own day, and
 * `measure-forecast-skill.ts` bucketed the +46.1% measurement the same local
 * way, so a live forecaster using UTC would not be learning the thing that was
 * measured. Both read `state.config.timezone` (M3, 2026-09-28 — they read the
 * host zone before, so a replay on a machine in another `TZ` re-bucketed them),
 * and they never mix zones with each other, which is the mistake worth
 * avoiding — an earlier version paired a UTC day with a local hour.
 */

/** The local day before a `YYYY-MM-DD`, via UTC date math so no zone can shift it. */
function prevDayOf(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day - 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Base rate for smoothing a thin per-hour cell: the OBSERVED share of active
 * hours that turned out to be a day's last, aggregated over `hourlyDoneRate`.
 *
 * Deliberately NOT `calibration['day-ending'].hits / .n` — that is this
 * forecaster's own score, and feeding a score back in as its own prior is the
 * degenerate fixed point that got the `project-continuity` forecaster retired
 * (see `forward-model.ts`). This reads accumulated OBSERVATIONS instead, which
 * is a different quantity even though both count hits.
 */
function observedDayEndingRate(hourlyDoneRate: KernelState['predictions']['hourlyDoneRate']): number {
  let n = 0;
  let hits = 0;
  for (const cell of Object.values(hourlyDoneRate)) {
    n += cell.n;
    hits += cell.hits;
  }
  return n === 0 ? UNINFORMED_DAY_ENDING_RATE : hits / n;
}

/** Smoothed P(this hour turns out to be the day's last active one) — the conditioning feature measured to carry skill (+46.1%). */
function hourlyDoneRatePrior(hourlyDoneRate: KernelState['predictions']['hourlyDoneRate'], hour: number): number {
  const cell = hourlyDoneRate[hour] ?? { n: 0, hits: 0 };
  const base = observedDayEndingRate(hourlyDoneRate);
  return clampProb((cell.hits + base * HOUR_RATE_SMOOTHING) / (cell.n + HOUR_RATE_SMOOTHING));
}

/**
 * The minimum resolved active hours before this table is allowed to produce a
 * visible guess. Below it every cell is dominated by `HOUR_RATE_SMOOTHING`
 * pulling toward `UNINFORMED_DAY_ENDING_RATE`, so the "forecast" would be a
 * restatement of the uninformed prior wearing a measurement's clothes — the
 * exact dishonesty the uncertainty grammar exists to prevent.
 */
const MIN_OBSERVED_HOURS_FOR_FORECAST = 20;

/** The last hour a day can be forecast to end in. There is no hour 24; midnight is the boundary, not an hour. */
const LAST_HOUR_OF_DAY = 23;

export interface DayEndForecast {
  /** The median predicted last active hour, local. The day probably ends inside it. */
  lastActiveHour: number;
  /** P(the day has ended by the end of `lastActiveHour`), given it is still going now. ≥ 0.5 whenever the median was actually reached. */
  probability: number;
  /** Total resolved active hours behind the table — the evidence, so a reader can weigh the guess. */
  observedHours: number;
}

/**
 * Read-time projection of what `dayShapeForecast` has learned: given that the
 * day is still going at `nowHour`, which hour is it probably the last active one
 * of?
 *
 * This lives here, beside the forecaster, rather than in the macOS app, and that
 * is the whole point of its existence as a function. Today's dial marks the
 * predicted end of day, and the smoothing that turns a thin per-hour cell into a
 * probability is *not* obvious — reimplementing it in Swift would be a second
 * copy of a forecaster's arithmetic, free to drift from the one that is actually
 * being scored. The macOS app receives the answer on `GET /state` and draws it.
 *
 * NOT a rule, and deliberately so: this folds nothing and decides nothing. It is
 * the same read-time-analytic-not-a-rule call `RULE_MANIFEST`'s closing comment
 * already makes for "days at the office".
 *
 * The survival walk is the honest form of the question. Each hour's cell answers
 * "was an active hour the day's last one", so the chance the day ends at hour h
 * is that hour's rate times the chance it survived every hour before it, and the
 * median is the first hour whose cumulative total passes a half. Reading the
 * single highest-rate hour instead would answer a different question ("which
 * hour most often ends a day") and would ignore that it is already past most of
 * them.
 *
 * Returns `null` rather than a weak guess in three cases: too little evidence to
 * have learned anything (see `MIN_OBSERVED_HOURS_FOR_FORECAST`), `nowHour`
 * outside the day, and a cumulative probability that never reaches a half before
 * midnight — there is no median to name, and naming one anyway would be the
 * forecast asserting more than it knows.
 */
export function forecastDayEnd(hourlyDoneRate: KernelState['predictions']['hourlyDoneRate'], nowHour: number): DayEndForecast | null {
  if (!Number.isFinite(nowHour) || nowHour < 0 || nowHour > LAST_HOUR_OF_DAY) return null;

  const observedHours = Object.values(hourlyDoneRate).reduce((sum, cell) => sum + cell.n, 0);
  if (observedHours < MIN_OBSERVED_HOURS_FOR_FORECAST) return null;

  let survival = 1;
  let cumulativeEnded = 0;
  for (let hour = Math.floor(nowHour); hour <= LAST_HOUR_OF_DAY; hour += 1) {
    const p = hourlyDoneRatePrior(hourlyDoneRate, hour);
    cumulativeEnded += survival * p;
    survival *= 1 - p;
    if (cumulativeEnded >= 0.5) {
      return { lastActiveHour: hour, probability: Math.round(cumulativeEnded * 1000) / 1000, observedHours };
    }
  }
  return null;
}

/**
 * Resolves the open `day-ending` prediction, if any, folding the outcome into
 * calibration, its own hourly rate, the shared surprise drive, and
 * `recentResolved`. A no-op when nothing is open (e.g. a day with no recorded
 * activity).
 *
 * The outcome is DERIVED from the prediction's own day rather than passed in,
 * and that is the whole correctness argument. The prediction is "this is the
 * last active hour of ITS day", so it is a hit exactly when the resolving
 * event falls on a later day, whatever resolves it. Passing `hit` in from the
 * call site inverted the target: `input:activity` emits every ~10s while
 * `day:boundary` only rides the 60s `clock:tick`, so after midnight activity
 * resolves first and a hardcoded `hit: false` scored the day's genuine last
 * hour as a MISS, then `day:boundary` scored the newly-opened first hour of
 * the new day as a HIT. Every hour learned the opposite of the truth, and the
 * dominant real case — laptop closed overnight, so `day:boundary` never fires
 * at all — resolved the last hour as a miss every single day.
 */
function resolveOpenDayEnding(state: KernelState, ts: string): { state: KernelState; effects: Effect[] } {
  const pred = state.predictions.open.find((p): p is Extract<OpenPrediction, { kind: 'day-ending' }> => p.kind === 'day-ending');
  if (!pred) return { state, effects: [] };

  const hit = localDay(pred.createdAt, state.config.timezone) !== localDay(ts, state.config.timezone);
  const outcome = hit ? 1 : 0;
  const pActual = clampProb(hit ? pred.priorProb : 1 - pred.priorProb);
  const surprise = -Math.log(pActual);
  const rounded = Math.round(surprise * 1000) / 1000;
  const resolved: ResolvedPrediction = { kind: 'day-ending', priorProb: pred.priorProb, hit, surprise: rounded, resolvedAt: ts };
  const hourCell = state.predictions.hourlyDoneRate[pred.hour] ?? { n: 0, hits: 0 };

  // The arm update, when this bet was placed under a condition. The flat cell
  // updates regardless — the original `hourly-rate` series must stay comparable
  // with the +46.1% measurement — and the arm only moves when the installed
  // cell still tests the SAME variable the bet was stamped with, so a replaced
  // hypothesis cannot inherit another variable's counts.
  const conditionedCell = state.predictions.conditioned[pred.hour];
  const arm = pred.condition && conditionedCell?.variable === pred.condition.variable ? (pred.condition.value ? 'when' : 'otherwise') : null;
  const conditioned =
    arm === null
      ? state.predictions.conditioned
      : {
          ...state.predictions.conditioned,
          [pred.hour]: {
            ...conditionedCell,
            arms: { ...conditionedCell.arms, [arm]: { n: conditionedCell.arms[arm].n + 1, hits: conditionedCell.arms[arm].hits + outcome } },
          },
        };

  return {
    state: {
      ...state,
      // Shares the one master surprise scalar with `anomalyZscore` (D6) — a day-ending
      // prediction is scored the same log-loss way as any other, and mood/reflection read this accumulator,
      // not any one forecaster's own record.
      memory: hasSkill(state.predictions.calibration, 'day-ending') ? { ...state.memory, accumulatedImportance: Math.min(MAX_ACCUMULATED, state.memory.accumulatedImportance + surprise) } : state.memory,
      predictions: {
        ...state.predictions,
        open: state.predictions.open.filter((p) => p.kind !== 'day-ending'),
        calibration: bumpCalibration(state.predictions.calibration, 'day-ending', outcome, pred.priorProb),
        hourlyDoneRate: { ...state.predictions.hourlyDoneRate, [pred.hour]: { n: hourCell.n + 1, hits: hourCell.hits + outcome } },
        conditioned,
        // On a hit, the bet hour WAS the previous day's last active hour — the
        // one fact `prev-day-ran-late` needs at the next conditioned open.
        lastDayEnd: hit ? { day: localDay(pred.createdAt, state.config.timezone), hour: pred.hour } : state.predictions.lastDayEnd,
        recentResolved: [...state.predictions.recentResolved, resolved].slice(-MAX_RECENT_RESOLVED),
      },
    },
    /**
     * `recentResolved` above is the bounded UI window; this is the durable
     * record. Both are written from the one place a resolution happens, so they
     * cannot describe different histories — and the row survives the `.slice()`
     * that made A08's 100-resolution floor unreachable.
     */
    effects: [
      {
        type: 'RecordPrediction',
        id: pred.id,
        kind: 'day-ending',
        // A conditioned bet is a COMPETING METHOD on the same target, and the
        // convention (see DAY_ENDING_FORECASTER) is that a second method gets
        // its own forecaster string so it is scored separately — the +46.1%
        // measurement stays evidence for the flat method, and the conditioned
        // one has to earn its own number.
        forecaster: pred.condition ? `${DAY_ENDING_FORECASTER}-conditioned` : DAY_ENDING_FORECASTER,
        createdAt: pred.createdAt,
        resolvedAt: ts,
        priorProb: pred.priorProb,
        // K0.3 — the target's rate over prior resolutions only, read from the
        // entry this fold is about to bump. The fair opponent.
        baseProb: pastRate(state.predictions.calibration, 'day-ending'),
        features: pred.condition ? { hour: pred.hour, variable: pred.condition.variable, arm: pred.condition.value ? 'when' : 'otherwise' } : { hour: pred.hour },
        outcome,
        surprise: rounded,
      },
    ],
  };
}

/**
 * The conditioned bet for an hour a research goal has PROVEN structure on: the
 * matching arm's rate, smoothed toward the hour's own flat rate so a thin arm
 * degrades to exactly the bet the hour would have made anyway. Same smoothing
 * shape and constant as `hourlyDoneRatePrior`, so the two priors are readable
 * as one method with one extra split.
 */
function conditionedPrior(state: KernelState, hour: number, arm: 'when' | 'otherwise'): number {
  const cell = state.predictions.conditioned[hour];
  const counts = cell.arms[arm];
  const base = hourlyDoneRatePrior(state.predictions.hourlyDoneRate, hour);
  return clampProb((counts.hits + base * HOUR_RATE_SMOOTHING) / (counts.n + HOUR_RATE_SMOOTHING));
}

/** What the conditioner may look at about the day a bet opens on — assembled from state, never from IO. */
function dayViewFor(state: KernelState, ts: string): DayView {
  const date = localDay(ts, state.config.timezone);
  const lastEnd = state.predictions.lastDayEnd;
  return { date, prevDayEndHour: lastEnd !== null && lastEnd.day === prevDayOf(date) ? lastEnd.hour : null };
}

function openDayEndingFor(state: KernelState, ts: string, id: string, hour: number): KernelState {
  const conditionedCell = state.predictions.conditioned[hour];
  const conditioner = conditionedCell ? conditionerById(conditionedCell.variable) : null;
  // `null` from the conditioner means "unknowable today" — the bet falls back
  // to the flat prior and carries no condition, so resolution touches no arm.
  const value = conditioner !== null ? conditioner.evaluate(dayViewFor(state, ts)) : null;

  const priorProb = value === null ? hourlyDoneRatePrior(state.predictions.hourlyDoneRate, hour) : conditionedPrior(state, hour, value ? 'when' : 'otherwise');
  const pred: OpenPrediction = {
    id,
    createdAt: ts,
    kind: 'day-ending',
    hour,
    priorProb,
    ...(value === null ? {} : { condition: { variable: conditionedCell.variable, value } }),
  };
  return { ...state, predictions: { ...state.predictions, open: [...state.predictions.open.filter((p) => p.kind !== 'day-ending'), pred] } };
}

/**
 * The forward model's only forecaster since `project-continuity` was retired
 * (see `forward-model.ts`). Measured (guides/measure-forecast-skill) as the
 * highest-skill target found in this user's data: "is this hour the day's last
 * active one" scores +46.1% skill from hour of day alone, against the retired
 * forecaster's ~0%. Reacts to
 * `input:activity` (to detect a new hour becoming active — see
 * `ACTIVE_HOUR_MIN_EMITS`) and `day:boundary` (already emitted by
 * `clockTick`, so this rides the existing heartbeat rather than a new timer,
 * per D2) to resolve the day's final open prediction as a hit.
 *
 * Lifecycle: the currently-tracked candidate hour accumulates emits in
 * `predictions.dayShape` until it crosses the threshold, at which point it is
 * promoted to "active" — any previously open `day-ending` prediction resolves
 * (as a miss if a later hour of the SAME day started, as a hit if the day has
 * since rolled over — see `resolveOpenDayEnding`, which derives that itself),
 * and a new one opens for the newly-active hour.
 *
 * `input:activity` is the primary resolver precisely because it is the
 * frequent one; `day:boundary` is a backstop for the case where the machine
 * is awake across midnight but idle, so no activity event notices the new day.
 * It rides `clockTick`'s existing heartbeat rather than a new timer (D2). When
 * the laptop is simply closed overnight — the common case — neither fires
 * until morning, and the first activity of the new day resolves the previous
 * evening's prediction correctly as a hit.
 */
export const dayShapeForecast: Rule = (state, event) => {
  // An accepted trial installs its conditioned cell. This rule reacts (it is
  // the single writer of `state.predictions`) while `researchGoals` reacts to
  // the SAME event to close the goal — two rules, two slices, one fact.
  //
  // The arms are seeded from the trial's own backtested counts rather than
  // zero: those counts came from this forecaster's recorded rows, so the first
  // conditioned bet is placed on the same evidence the verdict was earned on
  // instead of re-learning it live over another month.
  if (event.type === 'goal:trial-result') {
    const payload = event.payload as { accepted?: boolean; cell?: string; variable?: string; arms?: { when: { n: number; hits: number }; otherwise: { n: number; hits: number } } };
    const hour = Number(payload.cell);
    if (payload.accepted !== true || !Number.isInteger(hour) || typeof payload.variable !== 'string' || !payload.arms) return { state, effects: [] };
    if (conditionerById(payload.variable) === null) return { state, effects: [] };
    return {
      state: {
        ...state,
        predictions: {
          ...state.predictions,
          conditioned: {
            ...state.predictions.conditioned,
            [hour]: {
              variable: payload.variable,
              arms: { when: { ...payload.arms.when }, otherwise: { ...payload.arms.otherwise } },
              installedAt: event.ts,
              goalId: typeof (event.payload as { goalId?: unknown }).goalId === 'string' ? (event.payload as { goalId: string }).goalId : '',
            },
          },
        },
      },
      effects: [],
    };
  }

  if (event.type === 'day:boundary') {
    const { state: resolved, effects } = resolveOpenDayEnding(state, event.ts);
    return {
      state: { ...resolved, predictions: { ...resolved.predictions, dayShape: { day: localDay(event.ts, state.config.timezone), candidateHour: null, emitsThisHour: 0 } } },
      effects,
    };
  }

  if (event.type !== 'input:activity') return { state, effects: [] };

  const day = localDay(event.ts, state.config.timezone);
  const hour = localHour(event.ts, state.config.timezone);
  const shape = state.predictions.dayShape;
  const isSameCandidateHour = shape.day === day && shape.candidateHour === hour;
  const emitsThisHour = isSameCandidateHour ? shape.emitsThisHour + 1 : 1;

  const withCount: KernelState = { ...state, predictions: { ...state.predictions, dayShape: { day, candidateHour: hour, emitsThisHour } } };

  // Fires exactly once, the instant this hour crosses the threshold.
  if (emitsThisHour !== ACTIVE_HOUR_MIN_EMITS) return { state: withCount, effects: [] };

  const { state: resolved, effects } = resolveOpenDayEnding(withCount, event.ts);
  const withNewPred = openDayEndingFor(resolved, event.ts, deriveId(event.ts, event.id, 'day-shape-forecast', String(hour)), hour);
  return { state: withNewPred, effects };
};
