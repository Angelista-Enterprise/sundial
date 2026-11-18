import { createInitialState } from '@sundial/kernel/initial-state.js';
import { summonEvidence, summonLine } from '@sundial/kernel/read/summon-evidence.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { GLANCE_MS, overlayTrack } from './overlay-track.js';

const T0 = Date.parse('2026-03-10T09:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const ev = (type: string, sec: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${sec}`, type, ts: at(sec), payload, sanitized: true });

/** A test that failed 2 minutes before second 0. Made-up values. */
function red(): KernelState {
  const base = createInitialState('d1');
  return { ...base, lifeEvent: { ...base.lifeEvent, failedTests: { k: { command: 'pnpm test --filter puzzlebox', failedAt: at(-120) } } } } as KernelState;
}

function fold(state: KernelState, events: SanitizedEvent[]) {
  const effects: Effect[] = [];
  for (const e of events) {
    const out = overlayTrack(state, e);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}
const settled = (effects: Effect[]) => effects.flatMap((e) => (e.type === 'EmitEvent' && e.event.type === 'overlay:settled' ? [e.event.payload] : []));

describe('summonEvidence (plan 15 step 2)', () => {
  it('nothing to see: no line and no guess', () => {
    expect(summonEvidence(createInitialState('d1'), at(0))).toEqual({ line: null, evidence: [], guess: null });
  });

  it('a red test is the guess, with its line', () => {
    expect(summonEvidence(red(), at(0))).toEqual({ line: '`pnpm test --filter puzzlebox` failed 2 min ago.', evidence: ['red'], guess: 'red' });
  });

  it('a red test older than 10 minutes is no sign', () => {
    expect(summonEvidence(red(), at(9 * 60)).guess).toBeNull();
  });

  it('in a typing burst the signs are kept but there is no guess', () => {
    const s = { ...red(), voice: { ...red().voice, typedAt: at(-5) } } as KernelState;
    expect(summonEvidence(s, at(0))).toEqual({ line: null, evidence: ['red'], guess: null });
  });
});

describe('overlayTrack (plan 15 step 2)', () => {
  it('a summon holds the guess; typing settles it once as a hit', () => {
    const { state, effects } = fold(red(), [ev('overlay:summoned', 0, { summonId: 's1' }), ev('overlay:first-move', 2, { summonId: 's1', kind: 'type' }), ev('overlay:first-move', 3, { summonId: 's1', kind: 'look' })]);
    expect(state.overlay?.open).toMatchObject({ summonId: 's1', guess: 'red', evidence: ['red'], firstMove: 'type' });
    expect(state.overlay?.tally).toEqual({ red: { n: 1, hits: 1 } });
    expect(settled(effects)).toEqual([{ summonId: 's1', firstMove: 'type', guess: 'red', evidence: ['red'], ms: 2000 }]);
  });

  it('no move within the glance window is a glance, a miss', () => {
    const { state, effects } = fold(red(), [ev('overlay:summoned', 0, { summonId: 's1' }), ev('clock:tick', GLANCE_MS / 1000 + 1)]);
    expect(state.overlay?.tally).toEqual({ red: { n: 1, hits: 0 } });
    expect(settled(effects)).toMatchObject([{ firstMove: 'glance' }]);
  });

  it('a step back is a miss; a dismiss closes the summon without a second row', () => {
    const { state, effects } = fold(red(), [ev('overlay:summoned', 0, { summonId: 's1' }), ev('overlay:first-move', 1, { summonId: 's1', kind: 'step-back' }), ev('overlay:dismissed', 4)]);
    expect(state.overlay).toEqual({ open: null, tally: { red: { n: 1, hits: 0 } } });
    expect(settled(effects)).toHaveLength(1);
  });

  it('a move for another summon, or an unknown kind, does not count as that move', () => {
    const { effects } = fold(red(), [ev('overlay:summoned', 0, { summonId: 's1' }), ev('overlay:first-move', 1, { summonId: 's0', kind: 'type' }), ev('overlay:first-move', 2, { summonId: 's1', kind: 'shout' })]);
    expect(settled(effects)).toMatchObject([{ firstMove: 'glance' }]);
  });

  it('with no guess the move is logged but the tally does not move', () => {
    const { state, effects } = fold(createInitialState('d1'), [ev('overlay:summoned', 0, { summonId: 's1' }), ev('overlay:first-move', 1, { summonId: 's1', kind: 'type' })]);
    expect(state.overlay?.tally).toEqual({});
    expect(settled(effects)).toMatchObject([{ firstMove: 'type', guess: null }]);
  });

  it('other events leave the state as it was', () => {
    const s = red();
    expect(overlayTrack(s, ev('clock:tick', 0))).toEqual({ state: s, effects: [] });
  });

  it('the page reads the line of the guess the fold made', () => {
    const { state } = fold(red(), [ev('overlay:summoned', 0, { summonId: 's1' })]);
    expect(summonLine(state, at(1), 's1')).toEqual({ line: '`pnpm test --filter puzzlebox` failed 2 min ago.', guess: 'red' });
    expect(summonLine(createInitialState('d1'), at(1), 's9')).toEqual({ line: null, guess: null });
  });
});
