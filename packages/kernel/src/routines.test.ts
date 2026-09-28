import { describe, expect, it } from 'vitest';
import { routineForecast, routineLabel, topRoutines, type LearnedRoutine } from './routines.js';

const at = '2026-09-01T09:00:00.000Z';
const r = (steps: string[], support: number): LearnedRoutine => ({ steps, support, firstSeenAt: at, lastSeenAt: at });
const learned = {
  'Claude/work > Warp/work > Google Chrome/work': r(['Claude/work', 'Warp/work', 'Google Chrome/work'], 83),
  'Google Chrome/work > Warp/work > Claude/work': r(['Google Chrome/work', 'Warp/work', 'Claude/work'], 80),
  'Warp/work > Claude/work > Warp/work > Google Chrome/work': r(['Warp/work', 'Claude/work', 'Warp/work', 'Google Chrome/work'], 48),
  'Slack/work > Code/work > Warp/work': r(['Slack/work', 'Code/work', 'Warp/work'], 2),
};

describe('routineForecast', () => {
  it('predicts the next step from the trail', () => {
    const f = routineForecast(['Slack/work', 'Claude/work', 'Warp/work'], learned)!;
    expect(f.expected).toBe('Google Chrome/work');
    expect(f.expectedProcess).toBe('Google Chrome');
    expect(f.matched).toBe(2);
  });

  // A four-step routine that fits the last three steps knows more about this
  // moment than a three-step one that fits the last two.
  it('prefers the longest match over the strongest support', () => {
    const f = routineForecast(['Warp/work', 'Claude/work', 'Warp/work'], learned)!;
    expect(f.routine.steps).toHaveLength(4);
    expect(f.matched).toBe(3);
  });

  it('breaks a tie on support', () => {
    const tied = { a: r(['X/work', 'Y/work', 'Z/work'], 10), b: r(['X/work', 'Y/work', 'Q/work'], 30) };
    expect(routineForecast(['X/work', 'Y/work'], tied)!.expected).toBe('Q/work');
  });

  it('ignores a routine below the support floor — one recurrence is a coincidence', () => {
    expect(routineForecast(['Slack/work', 'Code/work'], learned)).toBeNull();
  });

  it('predicts nothing when the owner is already on the predicted step', () => {
    const f = routineForecast(['Claude/work', 'Warp/work', 'Google Chrome/work'], { only: learned['Claude/work > Warp/work > Google Chrome/work'] });
    expect(f).toBeNull();
  });

  it('is null on an empty trail or an empty table', () => {
    expect(routineForecast([], learned)).toBeNull();
    expect(routineForecast(['Claude/work'], {})).toBeNull();
  });
});

describe('topRoutines and routineLabel', () => {
  it('orders by support and reads as a sentence', () => {
    const top = topRoutines(learned, 2);
    expect(top.map((x) => x.support)).toEqual([83, 80]);
    expect(routineLabel(top[0])).toBe('Claude → Warp → Google Chrome');
  });
});
