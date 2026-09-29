import { describe, expect, it } from 'vitest';
import { CLAIM_AT, promiseReliability } from './promise-reliability.js';

const row = (closedBecause: string | null, counterparty: string | null, opts: { direction?: string; due?: string; closedAt?: string } = {}) => ({
  closedAt: closedBecause ? (opts.closedAt ?? '2026-10-01T10:00:00.000Z') : null,
  closedBecause,
  promise: { direction: opts.direction ?? 'owner', counterparty, due: opts.due ?? '2026-10-02T15:00:00.000Z' },
});

describe('promise reliability, with its n (UC1 U1-F40 F41)', () => {
  it('counts kept, on time, broken and dropped, and claims no rate before twenty', () => {
    const rows = [row('kept', 'Mira Bakker'), row('kept', 'Mira Bakker', { closedAt: '2026-10-05T10:00:00.000Z' }), row('broken', 'Bob Jansen'), row('dropped', null), row(null, 'Mira Bakker'), row(null, 'Mira Bakker', { direction: 'awaiting' })];
    const { overall, byPerson, note } = promiseReliability(rows);
    expect(overall).toEqual({ n: 4, kept: 2, onTime: 1, broken: 1, dropped: 1, wentQuiet: 0, keptRate: null });
    expect(note).toContain('No rate yet: 4 closed');
    expect(byPerson[0]).toEqual({ who: 'Mira Bakker', youOwe: 1, theyOwe: 1, toThem: { n: 2, kept: 2, onTime: 1, broken: 0, dropped: 0, wentQuiet: 0, keptRate: null } });
    const many = promiseReliability(Array.from({ length: CLAIM_AT }, (_, i) => row(i < 15 ? 'kept' : 'broken', 'Mira Bakker')));
    expect(many.overall.keptRate).toBe(0.75);
  });

  it('never names a person the owner could not: a hash with no name is left out of the ledger', () => {
    expect(promiseReliability([row('kept', 'person-0123456789')], (w) => (w.startsWith('person-') ? null : w)).byPerson).toEqual([]);
  });
});
