import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { PICK_WAIT_MS, screenPickTrack } from './screen-pick-track.js';

const T0 = Date.parse('2026-03-10T09:00:00.000Z');
const ev = (type: string, sec: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${sec}`, type, ts: new Date(T0 + sec * 1000).toISOString(), payload, sanitized: true });
const picked = (sec: number, more: Record<string, unknown> = {}) => ev('screen:picked', sec, { look: 'look-1a2b3c4d', ref: 'e1', tier: 1, p: 0.97, k: 9, qid: 'screen-pick:target', acted: true, processName: 'Notes', role: 'button', screenText: ['New Note'], ...more });
const step = (sec: number, more: Record<string, unknown> = {}) => ev('screen:step', sec, { id: `act-${sec}`, processName: 'Notes', verb: 'press', role: 'button', screenText: ['New Note'], ok: true, changed: true, ...more });

function fold(events: SanitizedEvent[], state: KernelState = createInitialState('d1')) {
  for (const e of events) state = screenPickTrack(state, e).state;
  return state;
}
const grade = (s: KernelState, id = 'screen-pick:target') => s.screenPick?.grades[id];

describe('screenPickTrack (doc 16, the fast path)', () => {
  it('a pick acted on is right when its step worked, wrong when the screen did not change', () => {
    const s = fold([picked(0), step(1), picked(2), step(3, { changed: false })]);
    expect(grade(s)).toMatchObject({ n: 2, hits: 1, threshold: 0.7 });
    expect(grade(s)?.bins.n[9]).toBe(2);
    expect(s.screenPick?.last).toBeNull();
  });

  it('a pick not acted on is right when the chat model then acted on the same thing, and it worked', () => {
    const s = fold([picked(0, { acted: false, p: 0.62 }), step(1), picked(2, { acted: false, p: 0.55 }), step(3, { screenText: ['Search'], role: 'search field', verb: 'set-value' })]);
    expect(grade(s)).toMatchObject({ n: 2, hits: 1 });
  });

  it('a step that names nothing, a stale pick and a step in another app grade nothing', () => {
    expect(grade(fold([picked(0, { acted: false }), step(1, { verb: 'key', screenText: [''] })]))).toBeUndefined();
    expect(grade(fold([picked(0), step(PICK_WAIT_MS / 1000 + 1)]))).toBeUndefined();
    const waiting = fold([picked(0), step(1, { processName: 'Xcode' })]);
    expect(grade(waiting)).toBeUndefined();
    expect(grade(fold([step(2)], waiting))).toMatchObject({ n: 1, hits: 1 });
  });

  it('tier 0 is graded under its own id; a pick with no id or no p is ignored', () => {
    expect(grade(fold([picked(0, { tier: 0, p: 1, qid: 'screen-pick:exact' }), step(1)]), 'screen-pick:exact')).toMatchObject({ n: 1, hits: 1 });
    expect(fold([picked(0, { qid: undefined })]).screenPick).toBeUndefined();
  });

  it('the threshold moves at 20 graded, and the grades stay bounded', () => {
    let s = createInitialState('d1');
    for (let i = 0; i < 20; i++) s = fold([picked(i * 2, { p: 0.75 }), step(i * 2 + 1, { changed: i % 2 === 0 })], s);
    expect(grade(s)?.n).toBe(20);
    expect(grade(s)?.threshold).not.toBe(0.7);
    for (let i = 0; i < 12; i++) s = fold([picked(100 + i * 2, { qid: `screen-pick:x${i}` }), step(101 + i * 2)], s);
    expect(Object.keys(s.screenPick?.grades ?? {})).toHaveLength(8);
  });
});
