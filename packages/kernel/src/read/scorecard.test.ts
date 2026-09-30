import { describe, expect, it } from 'vitest';
import { createInitialState } from '../initial-state.js';
import { actionRates, foldedScorecard, kindPrecision } from './scorecard.js';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const stats = (n: number, hits: number) => ({ n, hits, sum: hits, updatedAt: null });

describe('the folded scorecard rows (W5 step 9)', () => {
  it('says every row with its n, and "too small to trust" below 20', () => {
    const s = createInitialState('d1');
    s.config.timezone = 'UTC';
    s.reliability.llm = { openai: { streak: 0, longest: 14, openedAt: null, openUntil: null, days: [{ day: '2026-09-29', calls: 200, failed: 2 }] } };
    s.calibrated.params = { 'notice.precision': stats(12, 7), 'notice.precision:owner-question': stats(12, 3), 'notice.seen': stats(76, 61), 'presence.baseline': stats(1000, 490), 'action.verified:calendar_create': stats(82, 55) };
    s.calibrated.noticeByKind = { 'owner-question': { '2026-09-28': { delivered: 10, labelled: 4, useful: 3, wrong: 9, notNow: 0, seen: 2, acted: 3, explored: 0 } } };
    const rows = Object.fromEntries(foldedScorecard(s, NOW).map((r) => [r.id, r]));
    expect(Object.keys(rows).map(Number)).toEqual([1, 2, 3, 4, 5, 11]);
    expect(rows[1]).toMatchObject({ value: '99% (n = 200)', meets: true });
    expect(rows[2]).toMatchObject({ value: 'openai 14', meets: false });
    expect(rows[3]).toMatchObject({ value: '40% (n = 10, too small to trust)', meets: false });
    expect(rows[4]!.value).toBe('58.3% (n = 12, too small to trust)');
    expect(rows[5]!.value).toBe('+31 pts (80.3% vs 49%) (n = 76)');
    expect(rows[11]).toMatchObject({ meets: false });
  });

  it('a kind interrupts alone only at 80% on 30 verdicts; actions at 98% on 30', () => {
    const s = createInitialState('d1');
    s.calibrated.params['notice.precision:wakeup'] = stats(29, 29);
    expect(kindPrecision(s, 'wakeup').meets).toBe(false);
    s.calibrated.params['notice.precision:wakeup'] = stats(30, 24);
    expect(kindPrecision(s, 'wakeup').meets).toBe(true);
    expect(kindPrecision(s, 'never').meets).toBeNull();
    s.calibrated.params['action.verified:t'] = stats(50, 50);
    s.calibrated.params['action.performed:t'] = stats(50, 49);
    expect(actionRates(s).meets).toBe(true);
  });
});
