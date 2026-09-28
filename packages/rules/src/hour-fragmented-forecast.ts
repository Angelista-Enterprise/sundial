import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Effect, HourFragmentedPrediction, KernelState, ResolvedPrediction, Rule } from '@sundial/kernel/types.js';
import { bumpCalibration, clampProb, pastRate } from './forward-model.js';
import { MAX_ACCUMULATED } from './surprise-drive.js';

/**
 * The system's second forecaster: will this hour come apart?
 *
 * `dayShapeForecast` predicts WHEN the day ends. This predicts whether the hour
 * you are in will be a fragmented one — ten or more switches between pieces of
 * work — and it is the first forecaster here whose conditioning feature is a LAG
 * rather than a position in the calendar.
 *
 * ## Why this target and not another
 *
 * Four new targets were measured with `measure-forecast-skill.ts` before any of
 * this was written, and two of the four died on the numbers: "will you commit
 * anything today" scored +0.9% and "will the next shell command fail" scored
 * −1.6% (shell failures do not come in runs in this user's data, which was the
 * whole hypothesis). Of the two survivors this one was chosen because it is
 * STABLE, not because it scored highest on the full corpus:
 *
 * | cutoff     | this target | return-after-interruption |
 * |------------|-------------|---------------------------|
 * | 2026-08-10 | +15.0%      | +9.5%                     |
 * | 2026-08-15 | +16.4%      | +9.7%                     |
 * | 2026-08-20 | +13.7%      | +15.3%                    |
 *
 * The other target's best reading was its least typical one. Picking on a single
 * high number is exactly how "has the day started yet" got recorded at +21.9%
 * and then collapsed to +3.5% three days of data later, and
 * `guides/measure-forecast-skill` warns about precisely this. It is also
 * shape-of-the-day rather than content-of-the-work, which is the line
 * `forward-model.ts` draws after the `project-continuity` retirement.
 *
 * ## The resolver, which is the part that goes wrong
 *
 * The outcome is derived from `predictions.fragmentation.current`, the count this
 * rule accumulated for that exact (day, hour) — never from properties of
 * whatever event happens to trigger resolution. `dayShapeForecast`'s first
 * version decided its outcome from which of two differently-paced event types
 * fired first, and every hour of the day learned the inverse of the truth for
 * weeks. A forecaster's outcome must be a function of its own recorded state.
 *
 * ## The population must match the measurement, and at first it did not
 *
 * A bet opens when an hour becomes ACTIVE — three `input:activity` emits, the
 * same threshold `dayShapeForecast` promotes an hour on and the same one
 * `measure-forecast-skill.ts` used to build its sample. That alignment is the
 * whole correctness argument, and the first version got it wrong: it opened on
 * the hour's first context SWITCH instead, reasoning that an hour with no
 * switches cannot reach ten so betting on it forecasts nothing.
 *
 * Replaying all 2,426 recorded switches through that version scored **−3.2%**
 * skill against a constant baseline, then −1.8% after its cold-start prior was
 * corrected — while its two cells had separated correctly to 0.608 and 0.393.
 * The feature was real and the forecaster still lost, because restricting the
 * bets to already-switching hours removed the sub-population where the lag
 * carries most of its information: a calm hour following a calm hour. Those
 * hours are not free wins a baseline also gets — they are the structure.
 *
 * The general lesson, and the reason this is written at length: an offline skill
 * number is a claim about a POPULATION, and a live rule that bets on a different
 * population has not inherited the measurement. It has to be re-earned.
 */

/** Switches in one local hour at or above which the hour counts as fragmented. Fixed, never fitted — a threshold that moved with the data would relabel history under it. */
export const FRAGMENTED_HOUR_SWITCHES = 10;

/** Pseudo-counts pulling a thin cell toward the observed base rate. Same technique and constant as `hourlyDoneRatePrior`, so the two forecasters read as one method. */
const CELL_SMOOTHING = 6;

/**
 * With no evidence at all, the chance an active hour comes apart: the measured
 * base rate of the population actually bet on, 0.14.
 *
 * The seed has to be the base rate of the SAME population the bets are drawn
 * from, and an earlier version got this wrong in both directions at once — it
 * bet on switching hours only (base rate 0.49) while seeding from the
 * all-active-hours figure (0.14), and under-bet its whole warm-up. With the
 * trigger corrected to every active hour, 0.14 is the right seed again.
 */
const UNINFORMED_FRAGMENT_RATE = 0.14;

/** `input:activity` emits before an hour counts as active. Identical to `dayShapeForecast`'s `ACTIVE_HOUR_MIN_EMITS` and to the measurement script's, so all three agree on what an hour is. */
const ACTIVE_HOUR_MIN_EMITS = 3;

/** Local day and local hour, paired — never one of each, the mismatch `day-shape-forecast.ts` warns about in its own header. */
function localDay(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localHour(ts: string): number {
  return new Date(ts).getHours();
}

type Cell = 'prev-frag' | 'prev-calm';

/** Which cell a bet belongs in, given how the previous hour turned out. No previous hour reads as calm — the commoner state. */
function cellFor(prevFragmented: boolean | null): Cell {
  return prevFragmented === true ? 'prev-frag' : 'prev-calm';
}

/**
 * The observed share of bet-on hours that came apart, pooled across both cells.
 *
 * Pooled OBSERVATIONS, deliberately not `calibration['hour-fragmented']` — that
 * is this forecaster's own score, and a prior derived from its own score is the
 * degenerate fixed point that retired `project-continuity`. Both quantities
 * count hits; they are not the same quantity.
 */
function observedRate(byPrevState: KernelState['predictions']['fragmentation']['byPrevState']): number {
  const n = byPrevState['prev-frag'].n + byPrevState['prev-calm'].n;
  const hits = byPrevState['prev-frag'].hits + byPrevState['prev-calm'].hits;
  // Smoothed toward the uninformed rate, not a bare `hits / n`, and the live
  // daemon showed why within four minutes of shipping the bare version: the very
  // first bet resolved as a miss, `hits / n` became 0/1 = 0, that 0 was then fed
  // in as the base rate the CELL smooths toward, and the next bet went out at the
  // 2% clamp floor for a target whose real rate is 14%. One observation had
  // driven the forecaster to near-certainty.
  //
  // Two layers of smoothing looks redundant and is not: the cell rate is
  // smoothed toward the pooled rate, and the pooled rate is smoothed toward the
  // measured prior. Without the second layer the "prior" a thin cell falls back
  // to is itself a one-sample estimate.
  return (hits + UNINFORMED_FRAGMENT_RATE * CELL_SMOOTHING) / (n + CELL_SMOOTHING);
}

/** P(this hour reaches the threshold), from its cell, smoothed toward the pooled rate so a thin cell degrades to the uninformed bet. */
export function fragmentationPrior(fragmentation: KernelState['predictions']['fragmentation'], cell: Cell): number {
  const counts = fragmentation.byPrevState[cell];
  const base = observedRate(fragmentation.byPrevState);
  return clampProb((counts.hits + base * CELL_SMOOTHING) / (counts.n + CELL_SMOOTHING));
}

/**
 * Closes the accumulating hour: resolves any open bet on it against the count
 * this rule itself kept, folds the outcome into the cell, calibration and the
 * shared surprise drive, and records `prevFragmented` for the next bet.
 *
 * A no-op when no hour is accumulating. Safe when an hour accumulated switches
 * but never opened a bet (possible only on a replay boundary) — the hour's
 * outcome still trains `prevFragmented`, because the conditioning feature is a
 * fact about the day and not about whether a bet happened to exist.
 */
function closeHour(state: KernelState, ts: string): { state: KernelState; effects: Effect[] } {
  const current = state.predictions.fragmentation.current;
  if (current === null) return { state, effects: [] };

  const fragmented = current.switchesThisHour >= FRAGMENTED_HOUR_SWITCHES;
  const open = state.predictions.open.find(
    (p): p is HourFragmentedPrediction => p.kind === 'hour-fragmented' && p.day === current.day && p.hour === current.hour,
  );

  const cleared: KernelState = {
    ...state,
    predictions: {
      ...state.predictions,
      open: state.predictions.open.filter((p) => !(p.kind === 'hour-fragmented' && p.day === current.day && p.hour === current.hour)),
      // `prevDay` is stamped with the closed hour's OWN day, which is what lets
      // the next bet tell "the hour before this one" from "the last hour of some
      // earlier day".
      fragmentation: { ...state.predictions.fragmentation, current: null, prevFragmented: fragmented, prevDay: current.day },
    },
  };

  if (open === undefined) return { state: cleared, effects: [] };

  const outcome: 0 | 1 = fragmented ? 1 : 0;
  const pActual = clampProb(fragmented ? open.priorProb : 1 - open.priorProb);
  const surprise = Math.round(-Math.log(pActual) * 1000) / 1000;
  const resolved: ResolvedPrediction = { kind: 'hour-fragmented', priorProb: open.priorProb, hit: fragmented, surprise, resolvedAt: ts };
  const counts = cleared.predictions.fragmentation.byPrevState[open.prevState];

  return {
    state: {
      ...cleared,
      // The one master surprise scalar, shared with `anomalyZscore` and
      // `dayShapeForecast` — mood and reflection read the accumulator, never a
      // single forecaster's own record.
      memory: { ...cleared.memory, accumulatedImportance: Math.min(MAX_ACCUMULATED, cleared.memory.accumulatedImportance + -Math.log(pActual)) },
      predictions: {
        ...cleared.predictions,
        calibration: bumpCalibration(cleared.predictions.calibration, 'hour-fragmented', outcome, open.priorProb),
        recentResolved: [...cleared.predictions.recentResolved, resolved].slice(-50),
        fragmentation: {
          ...cleared.predictions.fragmentation,
          byPrevState: { ...cleared.predictions.fragmentation.byPrevState, [open.prevState]: { n: counts.n + 1, hits: counts.hits + outcome } },
        },
      },
    },
    effects: [
      {
        type: 'RecordPrediction',
        id: open.id,
        kind: 'hour-fragmented',
        // Names the METHOD, not the rule file, so a second method can compete on
        // this same target and be scored separately — the convention
        // `DAY_ENDING_FORECASTER` set.
        forecaster: 'prev-hour-lag',
        createdAt: open.createdAt,
        resolvedAt: ts,
        priorProb: open.priorProb,
        // K0.3 — read from `cleared`, which is the state BEFORE this
        // resolution is folded in: the rate this forecaster could have bet.
        baseProb: pastRate(cleared.predictions.calibration, 'hour-fragmented'),
        features: { hour: open.hour, prevState: open.prevState, switches: current.switchesThisHour },
        outcome,
        surprise,
      },
    ],
  };
}

/**
 * Reacts to three event types, each doing one job:
 *
 *  - `input:activity` — promotes an hour to active once it holds
 *    `ACTIVE_HOUR_MIN_EMITS` emits, which is when a bet OPENS. This is the
 *    trigger that makes the live population match the measured one.
 *  - `event:context-switch` — the counter the bet is resolved against.
 *  - `day:boundary` — the backstop that closes a day's final hour when the
 *    machine goes quiet before the next hour is ever promoted.
 *
 * Rides `clockTick`'s existing `day:boundary` rather than adding a timer, per D2,
 * and reuses `dayShapeForecast`'s own promotion threshold rather than inventing a
 * second definition of an active hour.
 *
 * An hour closes lazily — when a LATER hour is promoted — so a bet can stay open
 * past its own hour. That is correct rather than merely convenient: the count it
 * resolves against is already final, since no further switch can land in an hour
 * that has passed, so a late resolution and a punctual one reach the same verdict.
 */
export const hourFragmentedForecast: Rule = (state, event) => {
  if (event.type === 'day:boundary') return closeHour(state, event.ts);

  const frag = state.predictions.fragmentation;

  // The counter. Counts into whatever hour is currently open, and ONLY that
  // hour: a switch arriving in an hour that never became active belongs to no
  // bet, and crediting it to the open one would inflate a different hour's count.
  if (event.type === 'event:context-switch') {
    const current = frag.current;
    if (current === null || current.day !== localDay(event.ts) || current.hour !== localHour(event.ts)) return { state, effects: [] };
    return {
      state: { ...state, predictions: { ...state.predictions, fragmentation: { ...frag, current: { ...current, switchesThisHour: current.switchesThisHour + 1 } } } },
      effects: [],
    };
  }

  if (event.type !== 'input:activity') return { state, effects: [] };

  const day = localDay(event.ts);
  const hour = localHour(event.ts);
  const key = `${day}|${hour}`;

  // Already the open hour: nothing to promote, nothing to count.
  if (frag.current !== null && frag.current.day === day && frag.current.hour === hour) return { state, effects: [] };

  const emitsThisHour = frag.emitsKey === key ? frag.emitsThisHour + 1 : 1;
  const counted: KernelState = { ...state, predictions: { ...state.predictions, fragmentation: { ...frag, emitsThisHour, emitsKey: key } } };

  // Fires exactly once, the instant this hour crosses the threshold.
  if (emitsThisHour !== ACTIVE_HOUR_MIN_EMITS) return { state: counted, effects: [] };

  // A new hour is active. Close the old one first, so the outcome it records is
  // what conditions the bet about to be placed.
  const { state: closed, effects } = closeHour(counted, event.ts);
  // A new day resets the lag: whether yesterday's last hour came apart says
  // nothing about the first hour of today, and carrying it over would let one
  // day's shape condition the next through a feature never measured that way.
  //
  // Keyed on `prevDay` rather than on `current`, because `current` is already
  // null on the two paths that matter — after a `day:boundary`, and after the
  // machine slept through midnight. An earlier version compared `current.day`
  // and silently inherited the lag on exactly those paths.
  const carried = closed.predictions.fragmentation;
  const prevFragmented = carried.prevDay === day ? carried.prevFragmented : null;
  const cell = cellFor(prevFragmented);
  const priorProb = fragmentationPrior(carried, cell);
  const pred: HourFragmentedPrediction = {
    id: deriveId(event.ts, event.id, 'hour-fragmented', key),
    createdAt: event.ts,
    kind: 'hour-fragmented',
    day,
    hour,
    priorProb,
    prevState: cell,
  };

  return {
    state: {
      ...closed,
      predictions: {
        ...closed.predictions,
        open: [...closed.predictions.open, pred],
        // Opens at zero, not one: the promoting event is an activity emit, not a
        // switch, so no switch has been observed in this hour yet.
        fragmentation: { ...carried, current: { day, hour, switchesThisHour: 0 }, prevFragmented, prevDay: prevFragmented === null ? null : carried.prevDay },
      },
    },
    effects,
  };
};
