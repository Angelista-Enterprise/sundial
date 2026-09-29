import { describe, it, expect } from 'vitest';
import { createInitialState as initialState } from '@sundial/kernel/initial-state.js';
import { hostTimeZone } from '@sundial/helpers/local-day.js';
import type { KernelState, OpenPrediction, SanitizedEvent } from '@sundial/kernel/types.js';
import { dayShapeForecast, forecastDayEnd } from './day-shape-forecast.js';

/** These fixtures are host-local instants, so the owner's zone is the host's here (M3: the rule reads `state.config.timezone`). */
const createInitialState = (id: string): KernelState => {
  const s = initialState(id);
  return { ...s, config: { ...s.config, timezone: hostTimeZone() } };
};

/**
 * The rule buckets on LOCAL day and LOCAL hour (see its own doc comment for
 * why). So these fixtures are built from local wall-clock intent — "18:00 on
 * Jan 1, locally" — rather than from UTC literals: a hardcoded
 * `2026-01-01T18:00Z` is the evening in Amsterdam but the following morning in
 * Tokyo, which would make these assertions pass or fail depending on the
 * machine's `TZ`. `new Date(y, m-1, d, h, …)` interprets its arguments as local
 * time, and `.toISOString()` renders the same instant as the UTC string the
 * daemon would actually put on an event.
 */
function localTs(year: number, month: number, day: number, hour: number, second = 0): string {
  return new Date(year, month - 1, day, hour, 0, second).toISOString();
}

function activity(ts: string, id: string): SanitizedEvent {
  return { id, type: 'input:activity', ts, payload: {}, sanitized: true };
}

function boundary(ts: string, id: string): SanitizedEvent {
  return { id, type: 'day:boundary', ts, payload: { newDate: ts.slice(0, 10) }, sanitized: true };
}

const dayOf = (ts: string): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Drives one local hour past `ACTIVE_HOUR_MIN_EMITS` (3) so it gets promoted to "active". */
function promoteHour(state: KernelState, year: number, month: number, day: number, hour: number, idPrefix: string): KernelState {
  let next = state;
  for (const [i, second] of [5, 15, 25].entries()) {
    next = dayShapeForecast(next, activity(localTs(year, month, day, hour, second), `${idPrefix}${i}`)).state;
  }
  return next;
}

describe('dayShapeForecast', () => {
  it('ignores unrelated event types', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: localTs(2026, 1, 1, 10), payload: {}, sanitized: true };
    const { state: next, effects } = dayShapeForecast(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('accumulates emits for a candidate hour without opening a prediction below the threshold', () => {
    let state = createInitialState('d1');
    state = dayShapeForecast(state, activity(localTs(2026, 1, 1, 10, 5), 'e1')).state;
    expect(state.predictions.dayShape).toEqual({ day: '2026-01-01', candidateHour: 10, emitsThisHour: 1 });
    expect(state.predictions.open).toEqual([]);

    state = dayShapeForecast(state, activity(localTs(2026, 1, 1, 10, 15), 'e2')).state;
    expect(state.predictions.dayShape.emitsThisHour).toBe(2);
    expect(state.predictions.open).toEqual([]);
  });

  it('opens a day-ending prediction the instant the candidate hour crosses the emit threshold', () => {
    const state = promoteHour(createInitialState('d1'), 2026, 1, 1, 10, 'e');
    expect(state.predictions.open).toHaveLength(1);
    expect(state.predictions.open[0]).toMatchObject({ kind: 'day-ending', hour: 10 });
    // No evidence yet anywhere — uninformed 1/24 prior.
    expect((state.predictions.open[0] as { priorProb: number }).priorProb).toBeCloseTo(1 / 24, 5);
  });

  it('a later hour of the SAME day resolves the earlier open prediction as a MISS and opens a new one', () => {
    let state = promoteHour(createInitialState('d1'), 2026, 1, 1, 10, 'a');
    expect(state.predictions.open).toMatchObject([{ kind: 'day-ending', hour: 10 }]);

    state = promoteHour(state, 2026, 1, 1, 11, 'b');

    expect(state.predictions.open).toHaveLength(1);
    expect(state.predictions.open[0]).toMatchObject({ kind: 'day-ending', hour: 11 });
    expect(state.predictions.calibration['day-ending']).toMatchObject({ n: 1, hits: 0 });
    expect(state.predictions.hourlyDoneRate[10]).toEqual({ n: 1, hits: 0 });
    expect(state.predictions.recentResolved).toHaveLength(1);
    expect(state.predictions.recentResolved[0]).toMatchObject({ kind: 'day-ending', hit: false });
    // A forecaster with no record yet has no say in the shared drive (Q8).
    expect(state.memory.accumulatedImportance).toBe(0);
  });

  it('with skill on 50 or more resolutions, a miss feeds the shared drive, same as anomalyZscore (Q8)', () => {
    const base = createInitialState('d1');
    // 60 resolutions, 3 hits, Brier 0.02: well under the constant's 0.0475.
    const skilled = { ...base, predictions: { ...base.predictions, calibration: { 'day-ending': { n: 60, hits: 3, brierSum: 1.2 } } } };
    let state = promoteHour(skilled, 2026, 1, 1, 10, 'a');
    state = promoteHour(state, 2026, 1, 1, 11, 'b');
    expect(state.memory.accumulatedImportance).toBeGreaterThan(0);
    // The same record at the constant's Brier: no skill, no say.
    const flat = { ...base, predictions: { ...base.predictions, calibration: { 'day-ending': { n: 60, hits: 3, brierSum: 2.85 } } } };
    expect(promoteHour(promoteHour(flat, 2026, 1, 1, 10, 'a'), 2026, 1, 1, 11, 'b').memory.accumulatedImportance).toBe(0);
  });

  // The regression that matters. `input:activity` emits every ~10s while
  // `day:boundary` only rides the 60s `clock:tick`, so past midnight ACTIVITY
  // resolves the previous day's prediction first. Hardcoding that as a miss
  // taught the forecaster the exact inverse of its target, every single day —
  // and with the laptop closed overnight (the common case) `day:boundary` never
  // fires at all, so this was the ONLY path that ever resolved the last hour.
  it("resolves the previous day's prediction as a HIT when the first activity of a NEW day promotes an hour — no day:boundary needed", () => {
    let state = promoteHour(createInitialState('d1'), 2026, 1, 1, 18, 'a');
    expect(state.predictions.open).toMatchObject([{ kind: 'day-ending', hour: 18 }]);

    // Next morning. No day:boundary in between — the laptop was closed.
    state = promoteHour(state, 2026, 1, 2, 9, 'b');

    expect(state.predictions.calibration['day-ending']).toMatchObject({ n: 1, hits: 1 });
    expect(state.predictions.hourlyDoneRate[18]).toEqual({ n: 1, hits: 1 });
    expect(state.predictions.recentResolved[0]).toMatchObject({ kind: 'day-ending', hit: true });
    // And a fresh prediction is open for the new day's first active hour.
    expect(state.predictions.open).toMatchObject([{ kind: 'day-ending', hour: 9 }]);
  });

  it("does NOT credit a hit to the new day's own first hour when day:boundary lands after activity already rolled the day over", () => {
    let state = promoteHour(createInitialState('d1'), 2026, 1, 1, 18, 'a');
    // Activity wins the race past midnight (the common ordering).
    state = promoteHour(state, 2026, 1, 2, 0, 'b');
    expect(state.predictions.calibration['day-ending']).toMatchObject({ n: 1, hits: 1 });

    // day:boundary then lands ~60s later. The prediction now open belongs to the
    // SAME local day it fires on, so it must NOT be scored a hit.
    const { state: next } = dayShapeForecast(state, boundary(localTs(2026, 1, 2, 0, 60), 'db1'));

    expect(next.predictions.calibration['day-ending']).toMatchObject({ n: 2, hits: 1 });
    expect(next.predictions.hourlyDoneRate[0]).toEqual({ n: 1, hits: 0 });
  });

  it("day:boundary is a backstop: it resolves a PREVIOUS day's still-open prediction as a HIT and resets dayShape", () => {
    const state = promoteHour(createInitialState('d1'), 2026, 1, 1, 18, 'a');
    expect(state.predictions.open).toHaveLength(1);

    const boundaryTs = localTs(2026, 1, 2, 0);
    const { state: next } = dayShapeForecast(state, boundary(boundaryTs, 'db1'));

    expect(next.predictions.open).toEqual([]);
    expect(next.predictions.calibration['day-ending']).toMatchObject({ n: 1, hits: 1 });
    expect(next.predictions.hourlyDoneRate[18]).toEqual({ n: 1, hits: 1 });
    expect(next.predictions.recentResolved[0]).toMatchObject({ kind: 'day-ending', hit: true });
    expect(next.predictions.dayShape).toEqual({ day: dayOf(boundaryTs), candidateHour: null, emitsThisHour: 0 });
  });

  it('day:boundary with nothing open is a no-op besides resetting dayShape', () => {
    const state = createInitialState('d1');
    const boundaryTs = localTs(2026, 1, 2, 0);
    const { state: next, effects } = dayShapeForecast(state, boundary(boundaryTs, 'db1'));
    expect(effects).toEqual([]);
    expect(next.predictions.open).toEqual([]);
    expect(next.predictions.calibration).toEqual({});
    expect(next.predictions.dayShape.day).toBe(dayOf(boundaryTs));
  });

  /**
   * `day-ending` is the only live forecaster since `project-continuity` was
   * retired, so the foreign prediction here is a stand-in for whatever
   * forecaster is added next. The guarantee under test is that this rule
   * filters `open[]` by its OWN kind rather than replacing the array wholesale
   * — the property that let one forecaster be retired without disturbing the
   * other, and the one that will matter again the moment a second kind exists.
   */
  it("never touches a concurrently open prediction of another kind", () => {
    const foreign = { id: 'fk1', createdAt: localTs(2026, 1, 1, 9), kind: 'some-future-forecaster', priorProb: 0.5 } as unknown as OpenPrediction;
    const base = createInitialState('d1');
    let state: KernelState = { ...base, predictions: { ...base.predictions, open: [foreign] } };

    state = promoteHour(state, 2026, 1, 1, 10, 'a');

    expect(state.predictions.open).toHaveLength(2);
    expect(state.predictions.open).toContainEqual(foreign);
    expect(state.predictions.open.some((p) => p.kind === 'day-ending')).toBe(true);
  });

  it('learns a per-hour rate that shifts the prior away from the uninformed 1/24 baseline', () => {
    const base = createInitialState('d1');
    let state: KernelState = {
      ...base,
      predictions: { ...base.predictions, hourlyDoneRate: { 23: { n: 20, hits: 18 } } },
    };

    state = promoteHour(state, 2026, 1, 1, 23, 'a');

    const opened = state.predictions.open.find((p) => p.kind === 'day-ending') as { hour: number; priorProb: number };
    expect(opened.hour).toBe(23);
    expect(opened.priorProb).toBeGreaterThan(0.5);
  });

  it("seeds a thin hour's prior from OBSERVED hourly rates, not from its own calibration score (no self-referential prior)", () => {
    const base = createInitialState('d1');
    // A deliberately misleading calibration record: were the prior read from
    // here, an unseen hour would inherit a 90% chance of ending the day.
    let state: KernelState = {
      ...base,
      predictions: {
        ...base.predictions,
        calibration: { 'day-ending': { n: 100, hits: 90, brierSum: 5 } },
        hourlyDoneRate: { 22: { n: 40, hits: 2 } },
      },
    };

    state = promoteHour(state, 2026, 1, 1, 14, 'a');

    const opened = state.predictions.open.find((p) => p.kind === 'day-ending') as { priorProb: number };
    // Observed rate is 2/40 = 0.05, so an unseen hour stays low.
    expect(opened.priorProb).toBeLessThan(0.2);
  });
});

describe('forecastDayEnd', () => {
  /** Every hour equally likely to be a day's last, with enough resolutions to clear the evidence bar. */
  function flatTable(ratePerHour: number, nPerHour = 4): KernelState['predictions']['hourlyDoneRate'] {
    const table: KernelState['predictions']['hourlyDoneRate'] = {};
    for (let hour = 0; hour < 24; hour += 1) table[hour] = { n: nPerHour, hits: ratePerHour * nPerHour };
    return table;
  }

  it('withholds a forecast until the table has learned something', () => {
    expect(forecastDayEnd({}, 14)).toBeNull();
    // 4 resolved hours is well under the bar — every cell would just be the
    // uninformed prior in a measurement's clothing.
    expect(forecastDayEnd({ 17: { n: 4, hits: 4 } }, 14)).toBeNull();
  });

  it('names the hour the day probably ends in, conditioned on still being active now', () => {
    // 18:00 ends the day on nearly every observed evening.
    const table: KernelState['predictions']['hourlyDoneRate'] = {};
    for (let hour = 0; hour < 24; hour += 1) table[hour] = { n: 10, hits: hour === 18 ? 10 : 0 };

    const forecast = forecastDayEnd(table, 14);
    expect(forecast?.lastActiveHour).toBe(18);
    expect(forecast?.probability).toBeGreaterThanOrEqual(0.5);
    expect(forecast?.observedHours).toBe(240);
  });

  it('never forecasts an hour already past — the walk starts at now', () => {
    const table: KernelState['predictions']['hourlyDoneRate'] = {};
    for (let hour = 0; hour < 24; hour += 1) table[hour] = { n: 10, hits: hour === 9 ? 10 : 0 };

    // 09:00 was the historically day-ending hour, but it is 20:00 and the day
    // is plainly still going.
    const forecast = forecastDayEnd(table, 20);
    expect(forecast === null || forecast.lastActiveHour >= 20).toBe(true);
  });

  it('returns null rather than a median it never reached', () => {
    // A day that essentially never ends within the observed hours.
    expect(forecastDayEnd(flatTable(0), 14)).toBeNull();
  });

  it('rejects an hour outside the day instead of walking off the end', () => {
    expect(forecastDayEnd(flatTable(0.5), -1)).toBeNull();
    expect(forecastDayEnd(flatTable(0.5), 24)).toBeNull();
    expect(forecastDayEnd(flatTable(0.5), Number.NaN)).toBeNull();
  });

  it('accumulates across hours: a moderate per-hour rate reaches the median later than a decisive one', () => {
    const moderate = forecastDayEnd(flatTable(0.25), 12);
    const decisive = forecastDayEnd(flatTable(0.9), 12);
    expect(moderate).not.toBeNull();
    expect(decisive?.lastActiveHour).toBe(12);
    expect(moderate!.lastActiveHour).toBeGreaterThan(decisive!.lastActiveHour);
  });
});

/**
 * `recentResolved` is a 50-entry window and was the only record of a
 * resolution, while A08 gates its calibration figure on 100 of them — so the
 * ambition could never be met however long the daemon ran. These cover the
 * durable half: every resolution also leaves a row behind.
 */
describe('dayShapeForecast — durable resolution record', () => {
  it('emits a RecordPrediction alongside the state fold, carrying the hour it conditioned on', () => {
    const state = promoteHour(createInitialState('d1'), 2026, 1, 1, 10, 'a');
    const open = state.predictions.open[0] as Extract<OpenPrediction, { kind: 'day-ending' }>;

    // The third emit of hour 11 promotes it, which resolves hour 10's prediction.
    let result = { state, effects: [] as ReturnType<typeof dayShapeForecast>['effects'] };
    for (const [i, second] of [5, 15, 25].entries()) {
      result = dayShapeForecast(result.state, activity(localTs(2026, 1, 1, 11, second), `b${i}`));
    }

    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({
      type: 'RecordPrediction',
      id: open.id,
      kind: 'day-ending',
      forecaster: 'hourly-rate',
      createdAt: open.createdAt,
      priorProb: open.priorProb,
      features: { hour: 10 },
      outcome: 0,
    });
  });

  it('records a hit when the day rolled over', () => {
    let state = promoteHour(createInitialState('d1'), 2026, 1, 1, 18, 'a');

    let result = { state, effects: [] as ReturnType<typeof dayShapeForecast>['effects'] };
    for (const [i, second] of [5, 15, 25].entries()) {
      result = dayShapeForecast(result.state, activity(localTs(2026, 1, 2, 9, second), `b${i}`));
    }
    state = result.state;

    expect(result.effects[0]).toMatchObject({ type: 'RecordPrediction', outcome: 1, features: { hour: 18 } });
  });

  it('resolves through day:boundary too, not only through activity', () => {
    const state = promoteHour(createInitialState('d1'), 2026, 1, 1, 22, 'a');
    const { effects } = dayShapeForecast(state, boundary(localTs(2026, 1, 2, 0), 'bnd'));

    expect(effects).toMatchObject([{ type: 'RecordPrediction', kind: 'day-ending', outcome: 1 }]);
  });

  /** No open prediction means nothing was forecast, so there is nothing to score — an empty row here would be a phantom resolution in A08's sample. */
  it('emits nothing when there was no open prediction to resolve', () => {
    const { effects } = dayShapeForecast(createInitialState('d1'), boundary(localTs(2026, 1, 2, 0), 'bnd'));
    expect(effects).toEqual([]);
  });

  /** The durable row and the bounded window are written from one place, so they cannot disagree about what happened. */
  it('agrees with the recentResolved entry it was written beside', () => {
    const state = promoteHour(createInitialState('d1'), 2026, 1, 1, 10, 'a');
    let result = { state, effects: [] as ReturnType<typeof dayShapeForecast>['effects'] };
    for (const [i, second] of [5, 15, 25].entries()) {
      result = dayShapeForecast(result.state, activity(localTs(2026, 1, 1, 11, second), `b${i}`));
    }

    const window = result.state.predictions.recentResolved[0]!;
    const effect = result.effects[0] as Extract<ReturnType<typeof dayShapeForecast>['effects'][number], { type: 'RecordPrediction' }>;
    expect(effect.priorProb).toBe(window.priorProb);
    expect(effect.surprise).toBe(window.surprise);
    expect(effect.outcome === 1).toBe(window.hit);
    expect(effect.resolvedAt).toBe(window.resolvedAt);
  });
});

describe('conditioned cells (propose-and-verify, the accepted half)', () => {
  const trialResult = (ts: string, over: Record<string, unknown> = {}): SanitizedEvent => ({
    id: 'tr1',
    type: 'goal:trial-result',
    ts,
    payload: {
      goalId: 'hourly-rate:6',
      cell: '6',
      variable: 'prev-day-ran-late',
      accepted: true,
      gain: 0.31,
      arms: { when: { n: 5, hits: 4 }, otherwise: { n: 8, hits: 0 } },
      unknown: 0,
      ...over,
    },
    sanitized: true,
  });

  it('installs an accepted trial as a conditioned cell, arms seeded from the backtest', () => {
    const { state } = dayShapeForecast(createInitialState('d1'), trialResult(localTs(2026, 1, 10, 12)));
    const cell = state.predictions.conditioned[6];

    expect(cell.variable).toBe('prev-day-ran-late');
    // Seeded, not zeroed: the counts came from this forecaster's own recorded
    // rows, so the first conditioned bet stands on the evidence the verdict
    // was earned on instead of re-learning it live over another month.
    expect(cell.arms).toEqual({ when: { n: 5, hits: 4 }, otherwise: { n: 8, hits: 0 } });
  });

  it('ignores a rejected trial and an unknown variable — installation is for PROVEN structure only', () => {
    const base = createInitialState('d1');
    expect(dayShapeForecast(base, trialResult(localTs(2026, 1, 10, 12), { accepted: false })).state).toBe(base);
    expect(dayShapeForecast(base, trialResult(localTs(2026, 1, 10, 12), { variable: 'vibes' })).state).toBe(base);
  });

  it('bets the WHEN arm after a late night, stamps the condition, and resolves into that arm', () => {
    // Install the conditioned cell, then record that yesterday ended at 23:00.
    let state = dayShapeForecast(createInitialState('d1'), trialResult(localTs(2026, 1, 10, 12))).state;
    state = { ...state, predictions: { ...state.predictions, lastDayEnd: { day: '2026-01-11', hour: 23 } } };

    // 06:00 on the 12th becomes active: prev day (the 11th) ran late → 'when'.
    state = promoteHour(state, 2026, 1, 12, 6, 'w');
    const pred = state.predictions.open.find((p): p is Extract<OpenPrediction, { kind: 'day-ending' }> => p.kind === 'day-ending')!;
    expect(pred.condition).toEqual({ variable: 'prev-day-ran-late', value: true });
    // The when-arm rate (4/5) smoothed toward the flat prior: far ABOVE the
    // flat cell's own bet, which is the whole point of conditioning.
    expect(pred.priorProb).toBeGreaterThan(0.3);

    // Nothing else happens on the 12th; the next morning's first ACTIVE hour
    // (three emits) resolves it as a hit into the WHEN arm, and the flat cell
    // moves too (the original series must stay comparable with its measurement).
    const resolved = promoteHour(state, 2026, 1, 13, 9, 'r');
    expect(resolved.predictions.conditioned[6].arms.when).toEqual({ n: 6, hits: 5 });
    expect(resolved.predictions.conditioned[6].arms.otherwise).toEqual({ n: 8, hits: 0 });
    expect(resolved.predictions.hourlyDoneRate[6]).toEqual({ n: 1, hits: 1 });
    // The hit records the day's last active hour for tomorrow's conditioner.
    expect(resolved.predictions.lastDayEnd).toEqual({ day: '2026-01-12', hour: 6 });
  });

  it('falls back to the flat bet with NO condition when the conditioner cannot evaluate', () => {
    // Conditioned cell installed, but no lastDayEnd: prev-day-ran-late is
    // unknowable, and an unknowable day must not update any arm.
    let state = dayShapeForecast(createInitialState('d1'), trialResult(localTs(2026, 1, 10, 12))).state;
    state = promoteHour(state, 2026, 1, 12, 6, 'n');

    const pred = state.predictions.open.find((p): p is Extract<OpenPrediction, { kind: 'day-ending' }> => p.kind === 'day-ending')!;
    expect(pred.condition).toBeUndefined();

    const resolved = promoteHour(state, 2026, 1, 13, 9, 'r2');
    expect(resolved.predictions.conditioned[6].arms).toEqual({ when: { n: 5, hits: 4 }, otherwise: { n: 8, hits: 0 } });
  });

  it('records conditioned bets under their own forecaster string, so the flat series keeps its measurement', () => {
    let state = dayShapeForecast(createInitialState('d1'), trialResult(localTs(2026, 1, 10, 12))).state;
    state = { ...state, predictions: { ...state.predictions, lastDayEnd: { day: '2026-01-11', hour: 23 } } };
    state = promoteHour(state, 2026, 1, 12, 6, 'f');

    // Drive the next morning's hour to activation by hand so the THIRD emit's
    // effects (where the resolution lives) are inspectable.
    let result = dayShapeForecast(state, activity(localTs(2026, 1, 13, 9, 5), 'f0'));
    for (const [i, second] of [15, 25].entries()) {
      result = dayShapeForecast(result.state, activity(localTs(2026, 1, 13, 9, second), `f${i + 1}`));
    }
    const effect = result.effects[0] as Extract<ReturnType<typeof dayShapeForecast>['effects'][number], { type: 'RecordPrediction' }>;
    expect(effect.forecaster).toBe('hourly-rate-conditioned');
    expect(effect.features).toEqual({ hour: 6, variable: 'prev-day-ran-late', arm: 'when' });
  });
});
