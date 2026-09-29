import { describe, it, expect } from 'vitest';
import { enumerateCandidates, mineRules, type MineInput } from './watch-mine.js';

const now = '2026-10-31T00:00:00.000Z';
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const at = (d: number, min: number) => new Date(T0 + d * 86_400_000 + min * 60_000).toISOString();

/** Thirty made-up workdays 09:00–17:00: status every 10 min, commands, and one planted habit. */
function corpus(): MineInput {
  const events: MineInput['events'] = [];
  for (let d = 0; d < 30; d++) {
    for (let m = 540; m <= 1020; m++) events.push({ type: 'clock:tick', ts: at(d, m), payload: {} });
    for (let m = 540; m <= 1020; m += 10) {
      // The planted pattern: every third day a pile of 40 files sits from 11:00 to 13:30 in one repo.
      const pile = d % 3 === 0 && m >= 660 && m <= 810;
      events.push({ type: 'git:status', ts: at(d, m + 1), payload: { cwd: '/r/puzzlebox-studio', branch: 'main', dirtyFiles: pile ? 40 : (m / 10) % 4, ahead: 0 } });
      events.push({ type: 'git:status', ts: at(d, m + 2), payload: { cwd: '/r/other', branch: 'main', dirtyFiles: (m / 10) % 3, ahead: 0 } });
    }
    for (let m = 560; m <= 1000; m += 37) events.push({ type: 'shell:command', ts: at(d, m), payload: { cwd: '/r/other', exitCode: 0, durationMs: 800 + ((m * 7) % 900) } });
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return { events, now, days: 30, zone: 'UTC', routines: [], asks: [], useful: [], builtins: [] };
}

describe('mineRules — deterministic candidates, a holdout, then words (U4-F28)', () => {
  it('a planted pattern comes back in the top three, tested on both halves', () => {
    const top = mineRules(corpus(), 3);
    const pile = top.find((m) => m.spec.when.type === 'git:status' && m.spec.when.where?.[0]?.field === 'dirtyFiles');
    expect(pile).toBeDefined();
    expect(pile!.spec.by).toEqual(['cwd']);
    expect(pile!.older).toBeGreaterThanOrEqual(1);
    expect(pile!.recent).toBeGreaterThanOrEqual(1);
    expect(pile!.older + pile!.recent).toBeLessThanOrEqual(20);
  });
  it('what a built-in already said is dropped, and an ask the owner repeated is enumerated', () => {
    const input = corpus();
    const pile = (m: { spec: { when: { type: string } } }) => m.spec.when.type === 'git:status';
    expect(mineRules(input, 5).some(pile)).toBe(true);
    // A built-in notice at every planted pile: the rule would say what was already said.
    const builtins = Array.from({ length: 10 }, (_, i) => at(i * 3, 725));
    expect(mineRules({ ...input, builtins }, 5).some(pile)).toBe(false);
    const withAsks = { ...input, events: [...input.events, ...[0, 1, 2].map((d) => ({ type: 'window:changed', ts: at(d, 600), payload: { processName: 'Chatter' } }))], asks: [0, 1, 2].map((d) => ({ ts: at(d, 700), query: 'how long was I in chatter today?' })) };
    expect(enumerateCandidates(withAsks).filter((c) => c.source === 'ask').map((c) => (c.spec as { title: string }).title)).toEqual(['Chatter for a while']);
  });
});
