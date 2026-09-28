import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, ProjectTouchedPrediction, SanitizedEvent } from '@sundial/kernel/types.js';
import { CANDIDATE_RECENCY_DAYS, projectTouchForecast } from './project-touch-forecast.js';

/** A local-time instant, so the rule's day bucketing is what the test intends. */
function at(day: string, hour: number, minute = 0): string {
  return new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).toISOString();
}

let seq = 0;
function ev(type: string, ts: string): SanitizedEvent {
  seq += 1;
  return { id: `e${seq}`, type, ts, payload: {} } as unknown as SanitizedEvent;
}

/** The three activity emits that make a day's first hour active and open its bets. */
function activate(day: string, hour = 9): SanitizedEvent[] {
  return [0, 1, 2].map((i) => ev('input:activity', at(day, hour, i)));
}

/**
 * A window change is scored through `state.window.attribution`, which
 * `windowTrack` writes before this rule runs. The fold below stamps it the way
 * the manifest would have, so the test exercises the rule's own reading of it.
 */
type Step = SanitizedEvent | { touch: string; ts: string };
const touch = (project: string, day: string, hour = 10): Step => ({ touch: project, ts: at(day, hour) });

function run(steps: Step[], from: KernelState = createInitialState('test-device')): { state: KernelState; effects: Effect[] } {
  let state = from;
  const effects: Effect[] = [];
  for (const step of steps) {
    if ('touch' in step) {
      state = { ...state, window: { ...state.window, attribution: { projectId: step.touch, source: 'rule', confidence: 'high' } } } as unknown as KernelState;
      const out = projectTouchForecast(state, ev('window:changed', step.ts));
      state = out.state;
      effects.push(...out.effects);
      continue;
    }
    const out = projectTouchForecast(state, step);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

const openBets = (state: KernelState): ProjectTouchedPrediction[] =>
  state.predictions.open.filter((p): p is ProjectTouchedPrediction => p.kind === 'project-touched');

describe('projectTouchForecast', () => {
  it('bets on nothing until it has seen a project', () => {
    const { state, effects } = run(activate('2026-08-03'));
    expect(openBets(state)).toEqual([]);
    expect(effects).toEqual([]);
    expect(state.predictions.projectTouch.day).toBe('2026-08-03');
  });

  it('opens one bet per recently touched project when the next day becomes active', () => {
    const { state } = run([...activate('2026-08-03'), touch('alpha', '2026-08-03'), touch('beta', '2026-08-03'), ...activate('2026-08-04')]);
    const bets = openBets(state);
    expect(bets.map((b) => b.project)).toEqual(['alpha', 'beta']);
    expect(bets.every((b) => b.day === '2026-08-04')).toBe(true);
    // No history yet: the measured base rate, not a coin flip.
    expect(bets[0].priorProb).toBeCloseTo(0.42, 5);
  });

  it('resolves against the bet day’s own record, and records the method', () => {
    const { state, effects } = run([
      ...activate('2026-08-03'),
      touch('alpha', '2026-08-03'),
      touch('beta', '2026-08-03'),
      ...activate('2026-08-04'),
      touch('alpha', '2026-08-04'),
      ev('day:boundary', at('2026-08-04', 23, 59)),
    ]);
    const recorded = effects.filter((e) => e.type === 'RecordPrediction');
    expect(recorded).toHaveLength(2);
    expect(recorded.find((e) => e.type === 'RecordPrediction' && e.features?.project === 'alpha')).toMatchObject({ kind: 'project-touched', forecaster: 'project-rate', outcome: 1 });
    expect(recorded.find((e) => e.type === 'RecordPrediction' && e.features?.project === 'beta')).toMatchObject({ outcome: 0 });
    expect(state.predictions.calibration['project-touched']).toMatchObject({ n: 2, hits: 1 });
    expect(state.predictions.projectTouch.byProject).toEqual({ alpha: { n: 1, hits: 1 }, beta: { n: 1, hits: 0 } });
    expect(openBets(state)).toEqual([]);
    expect(state.predictions.projectTouch.day).toBeNull();
  });

  it('closes a day that never saw midnight when the next day activates, against the OLD day’s touches', () => {
    // Laptop shut overnight: no day:boundary. The 08-04 bets must resolve on
    // what happened on 08-04, not on what has already happened on 08-05.
    const { state, effects } = run([
      ...activate('2026-08-03'),
      touch('alpha', '2026-08-03'),
      ...activate('2026-08-04'),
      // Nothing touched on 08-04. A touch early on 08-05, before the day activates:
      touch('alpha', '2026-08-05', 8),
      ...activate('2026-08-05', 9),
    ]);
    const recorded = effects.filter((e) => e.type === 'RecordPrediction');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ outcome: 0, features: { project: 'alpha', day: '2026-08-04' } });
    // And the early touch still counts toward the new day.
    expect(state.predictions.projectTouch.touched['2026-08-05']).toEqual(['alpha']);
    expect(openBets(state).map((b) => b.day)).toEqual(['2026-08-05']);
  });

  it('learns: a project touched every day bets higher than one touched once', () => {
    const steps: Step[] = [];
    for (let d = 1; d <= 9; d += 1) {
      const day = `2026-08-0${d}`;
      steps.push(...activate(day), touch('daily', day));
      if (d === 1) steps.push(touch('once', day));
      steps.push(ev('day:boundary', at(day, 23, 59)));
    }
    steps.push(...activate('2026-08-10'));
    const { state } = run(steps);
    const bets = openBets(state);
    const daily = bets.find((b) => b.project === 'daily')!;
    const once = bets.find((b) => b.project === 'once')!;
    expect(daily.priorProb).toBeGreaterThan(0.7);
    expect(once.priorProb).toBeLessThan(daily.priorProb);
  });

  it('stops betting on a project once it falls out of the recency window', () => {
    const steps: Step[] = [...activate('2026-07-01'), touch('stale', '2026-07-01'), ev('day:boundary', at('2026-07-01', 23, 59))];
    const later = new Date(`2026-07-01T12:00:00`);
    later.setDate(later.getDate() + CANDIDATE_RECENCY_DAYS + 1);
    const day = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}`;
    steps.push(...activate(day));
    const { state } = run(steps);
    expect(openBets(state)).toEqual([]);
    expect(state.predictions.projectTouch.lastTouched).toEqual({});
  });

  it('ignores an unattributed window', () => {
    const state0 = createInitialState('test-device');
    const out = projectTouchForecast(state0, ev('window:changed', at('2026-08-03', 10)));
    expect(out.state).toBe(state0);
  });

  it('follows a project merge: cells add, the candidate moves, an open bet is re-pointed', () => {
    const { state } = run([
      ...activate('2026-08-03'),
      touch('named:x', '2026-08-03'),
      ...activate('2026-08-04'),
      touch('named:x', '2026-08-04'),
      ev('day:boundary', at('2026-08-04', 23, 59)),
      ...activate('2026-08-05'),
    ]);
    expect(openBets(state).map((b) => b.project)).toEqual(['named:x']);
    const merged = { id: 'm1', type: 'project:merged', ts: at('2026-08-05', 10), payload: { from: 'named:x', into: '~/x' } } as unknown as SanitizedEvent;
    const next = projectTouchForecast(state, merged).state;
    expect(openBets(next).map((b) => b.project)).toEqual(['~/x']);
    expect(next.predictions.projectTouch.byProject).toEqual({ '~/x': { n: 1, hits: 1 } });
    expect(next.predictions.projectTouch.lastTouched).toEqual({ '~/x': '2026-08-04' });
    expect('named:x' in next.predictions.projectTouch.lastTouched).toBe(false);
  });
});
