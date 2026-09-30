import { describe, expect, it } from 'vitest';
import { createInitialState } from '../initial-state.js';
import { noticesByKind } from './trust.js';

const day = (over: Record<string, number>) => ({ delivered: 0, labelled: 0, useful: 0, wrong: 0, notNow: 0, seen: 0, acted: 0, explored: 0, ...over });

describe('read/trust: notices by kind, folded (W4 step 8)', () => {
  it('sums the last thirty local days per kind, with n, and leaves older days out', () => {
    const s = createInitialState('d1');
    s.config.timezone = 'UTC';
    s.calibrated.noticeByKind = {
      'owner-question': { '2026-09-28': day({ delivered: 4, labelled: 3, useful: 1, wrong: 2 }), '2026-08-01': day({ delivered: 9, useful: 9 }) },
      'return-from-break': { '2026-09-29': day({ delivered: 2, labelled: 2, useful: 1, seen: 2 }) },
    };
    const out = noticesByKind(s, Date.parse('2026-09-29T12:00:00.000Z'));
    expect(out).toMatchObject({ n: 4, useful: 2, delivered: 6, labelled: 5 });
    expect(out.byKind.map((r) => [r.kind, r.n, r.useful])).toEqual([['owner-question', 3, 1], ['return-from-break', 1, 1]]);
  });
});
