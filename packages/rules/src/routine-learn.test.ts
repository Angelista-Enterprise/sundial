import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { MAX_ROUTINES, confirmedRoutines, routineLearn } from './routine-learn.js';

const step = (processName: string, ts: string, id = 'e'): SanitizedEvent => ({ id: `${id}-${ts}`, type: 'window:changed', ts, payload: { processName, windowTitle: '' }, sanitized: true });

function walk(state: KernelState, processes: string[], startMs = Date.parse('2026-08-14T09:00:00.000Z')): KernelState {
  let current = state;
  processes.forEach((p, i) => {
    current = routineLearn(current, step(p, new Date(startMs + i * 60_000).toISOString(), `s${i}`)).state;
  });
  return current;
}

describe('routineLearn', () => {
  it('learns a repeated three-step sequence', () => {
    let state = createInitialState('d1');
    for (let round = 0; round < 3; round++) {
      state = walk(state, ['Code', 'Warp', 'Chrome'], Date.parse('2026-08-14T09:00:00.000Z') + round * 3_600_000);
    }

    // Asserted on the shape rather than on a hardcoded class, because the class comes
    // from the owner's own taxonomy and a built-in default (Code and Warp ship as
    // `work`) would make this test a mirror of that list rather than of this rule.
    const routines = confirmedRoutines(state);
    expect(routines.some((r) => r.steps.map((x) => x.split('/')[0]).join('>') === 'Code>Warp>Chrome')).toBe(true);
  });

  it('refuses alt-tab texture, however often it repeats', () => {
    // The failure the live measurement caught: `Chrome > Claude > Chrome` reached
    // support 375 and took every top slot, because two alternating apps satisfy the
    // distinct-target guard cleanly. Alternation is thinking, not procedure.
    let state = createInitialState('d1');
    state = walk(state, ['Chrome', 'Claude', 'Chrome', 'Claude', 'Chrome', 'Claude', 'Chrome', 'Claude']);

    expect(confirmedRoutines(state)).toEqual([]);
  });

  it('still learns a three-app sequence that merely revisits an app', () => {
    // A > B > C > A is not alternation and must survive the guard.
    let state = createInitialState('d1');
    for (let round = 0; round < 3; round++) {
      state = walk(state, ['Code', 'Warp', 'Chrome', 'Code'], Date.parse('2026-08-14T09:00:00.000Z') + round * 3_600_000);
    }
    expect(confirmedRoutines(state).length).toBeGreaterThan(0);
  });

  it('ignores a repeat of the step already current, so a title change pads nothing', () => {
    let state = createInitialState('d1');
    const before = state.routines.trail;
    state = routineLearn(state, step('Code', '2026-08-14T09:00:00.000Z')).state;
    state = routineLearn(state, step('Code', '2026-08-14T09:01:00.000Z')).state;

    expect(state.routines.trail).toHaveLength(before.length + 1);
    expect(state.routines.trail.at(-1)!.startsWith('Code/')).toBe(true);
  });

  it('emits nothing, ever — it has no opinion and cannot interrupt', () => {
    let state = createInitialState('d1');
    for (let round = 0; round < 5; round++) {
      const out = walk(state, ['Code', 'Warp', 'Chrome'], Date.parse('2026-08-14T09:00:00.000Z') + round * 3_600_000);
      state = out;
    }
    const { effects } = routineLearn(state, step('Code', '2026-08-14T20:00:00.000Z'));
    expect(effects).toEqual([]);
  });

  it('bounds the learned table', () => {
    let state = createInitialState('d1');
    // Many distinct sequences, far more than the cap.
    for (let i = 0; i < 120; i++) {
      state = walk(state, [`App${i}`, `Tool${i}`, `Site${i}`, `App${i + 1}`], Date.parse('2026-08-14T09:00:00.000Z') + i * 600_000);
    }
    expect(Object.keys(state.routines.learned).length).toBeLessThanOrEqual(MAX_ROUTINES);
  });

  it('ignores events without a process name', () => {
    const state = createInitialState('d1');
    const { state: next } = routineLearn(state, { id: 'e1', type: 'window:changed', ts: '2026-08-14T09:00:00.000Z', payload: {}, sanitized: true });
    expect(next).toBe(state);
  });
});

describe('a full table can still learn a new habit', () => {
  it('routines unseen for two weeks make room: a new sequence repeated three times is learned', () => {
    const base = createInitialState('d');
    const old = '2026-08-01T09:00:00.000Z';
    const learned = Object.fromEntries(Array.from({ length: MAX_ROUTINES }, (_, i) => [`Old${i} > B > C`, { support: 50, steps: [`Old${i}/work`, 'B/work', 'C/work'], firstSeenAt: old, lastSeenAt: old }]));
    let s: KernelState = { ...base, routines: { trail: [], learned } };
    const day = Date.parse('2026-09-20T09:00:00.000Z');
    for (let rep = 0; rep < 3; rep++) s = walk(s, ['Mail', 'Arc', 'Code', 'Notes'], day + rep * 3_600_000);
    expect(Object.keys(s.routines.learned)).toHaveLength(MAX_ROUTINES);
    expect(confirmedRoutines(s).find((r) => r.key.startsWith('Mail/') && r.steps.length === 3)?.support).toBe(3);
  });
});
