import { describe, expect, it } from 'vitest';
import { MIN_STEPS_PER_SIDE, reviewRates, type RateRow } from './self-review-rates.js';

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const step = (s: number, data: Record<string, unknown> = {}): RateRow => ({ type: 'screen:step', at: at(s), data: { processName: 'Spotify', verb: 'press', goal: 'play the album', session: 's1', ok: true, ...data } });

describe('reviewRates', () => {
  it('splits an app\'s failed-step rate at the first proposal the owner kept, with each side\'s n', () => {
    const before = Array.from({ length: 40 }, (_, i) => step(i, { ok: i % 4 !== 0 }));
    const after = Array.from({ length: 40 }, (_, i) => step(1000 + i, { ok: i % 20 !== 0 }));
    const rows = [...before, { type: 'review:proposed', at: at(500), data: { app: 'Spotify' } }, { type: 'review:accepted', at: at(600), data: { app: 'Spotify' } }, ...after];
    const out = reviewRates(rows);
    expect(out.apps[0]).toMatchObject({ app: 'Spotify', before: { n: 40, failed: 10, rate: 0.25 }, after: { n: 40, failed: 2, rate: 0.05 }, enough: true });
    expect(out.proposals).toMatchObject({ proposed: 1, accepted: 1, share: 1, enough: false });
  });

  it('says when a side is too small to read', () => {
    const rows = [step(0), { type: 'review:accepted', at: at(1), data: { app: 'Spotify' } }, step(2)];
    expect(reviewRates(rows).apps[0]).toMatchObject({ enough: false, before: { n: 1 }, after: { n: 1 } });
    expect(MIN_STEPS_PER_SIDE).toBe(30);
  });

  it('steps per repeated goal: the first run against the later ones', () => {
    const rows = [...[0, 1, 2, 3].map((s) => step(s, { session: 'a' })), ...[10, 11].map((s) => step(s, { session: 'b' })), ...[20, 21].map((s) => step(s, { session: 'c' })), step(30, { goal: 'once', session: 'd' })];
    expect(reviewRates(rows).goals).toMatchObject({ n: 1, first: 4, later: 2, enough: false });
  });

  it('leaves the rig out: its test window and its threads', () => {
    const rows = [step(0, { windowTitle: 'Inbox - Testbox', session: 'r1' }), step(1, { session: 'r1' }), step(2, { session: 'session-rig' }), step(3, { session: 'own' })];
    expect(reviewRates(rows, ['session-rig']).steps.n).toBe(1);
  });
});
