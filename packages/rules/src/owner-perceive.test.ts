import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { brierOf, mean, ownerPerceive, PERCEIVE_WEIGHT, perceiveInput } from './owner-perceive.js';

const TS = '2026-09-22T10:00:00.000Z';
const ev = (type: string, payload: Record<string, unknown> = {}, ts = TS): SanitizedEvent => ({ id: `e-${type}-${ts}`, type, ts, payload, sanitized: true });

function withMoment(state: KernelState): KernelState {
  return {
    ...state,
    lifeEvent: { ...state.lifeEvent, idle: { consecutiveZeroWindows: 0, isIdle: false }, recentSwitches: [{ at: '2026-09-22T09:55:00.000Z', process: 'Code' }, { at: '2026-09-22T09:40:00.000Z', process: 'Arc' }] },
    moment: { id: 'm1', sessionId: 's1', startTime: '2026-09-22T09:30:00.000Z', processName: 'Code', projectId: null, rollup: { ...(state.moment?.rollup as object), processName: 'Code', windowTitles: ['a', 'b', 'a'], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null, playbackActive: true } as never, intent: { status: 'none' } } as never,
  };
}

describe('ownerPerceive (J2.1)', () => {
  it('keeps the last minute of raw input windows', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < 8; i += 1) state = ownerPerceive(state, ev('input:activity', { windowMs: 10_000, keyDownCount: 10 + i, mouseClickCount: 1, scrollCount: 0 }, `2026-09-22T10:00:${String(i * 10).padStart(2, '0')}.000Z`)).state;
    expect(state.owner.perception.input).toHaveLength(6);
    expect(state.owner.perception.input[0]).toMatchObject({ keys: 12, events: 13, windowMs: 10_000 });
  });

  it('on a tick: decays toward the prior, and puts RAW RATES ONLY to the judge — no label, no derived event, no title', () => {
    let state = withMoment(createInitialState('d1'));
    state = { ...state, owner: { ...state.owner, focus: { alpha: 3, beta: 1 } } };
    state = ownerPerceive(state, ev('input:activity', { windowMs: 10_000, keyDownCount: 20, mouseClickCount: 2, scrollCount: 0 })).state;
    const { state: next, effects } = ownerPerceive(state, ev('clock:tick'));
    expect(next.owner.focus.alpha).toBeCloseTo(1 + 2 * 0.9, 6);
    const judge = effects.find((e) => e.type === 'Judge') as Extract<Effect, { type: 'Judge' }>;
    expect(judge).toMatchObject({ purpose: 'perceive', questionSetId: 'perceive', delayMs: 0, momentId: 'm1' });
    expect(judge.state).toEqual({ switches_last_10_min: 1, minutes_since_last_switch: 5, minutes_in_current_session: 30, distinct_windows_in_session: 2, keys_per_minute: 120, input_events_per_minute: 132, mic_on: false, playback_on: true, calendar_event_active: false, hour_local: 10 });
    for (const key of Object.keys(judge.state as object)) expect(['kind', 'intent', 'label', 'verdict', 'life_events', 'window_titles', 'app']).not.toContain(key);
  });

  it('asks nothing while idle or with no moment open', () => {
    const idle = { ...withMoment(createInitialState('d1')) };
    idle.lifeEvent = { ...idle.lifeEvent, idle: { consecutiveZeroWindows: 9, isIdle: true } };
    expect(ownerPerceive(idle, ev('clock:tick')).effects).toEqual([]);
    expect(perceiveInput(createInitialState('d1'), TS)).toBeNull();
  });

  it('a perceive answer moves each belief by w · likelihood; another set moves nothing', () => {
    const base = createInitialState('d1');
    const { state } = ownerPerceive(base, ev('judgement:result', { purpose: 'perceive', questionSetId: 'perceive', momentId: 'm1', answers: { in_flow: { type: 'noul', noul: 0.9 }, stuck: { type: 'noul', noul: 0.1 }, interruptible: { type: 'noul', noul: 0.5 } }, model: 'm', latencyMs: 1 }));
    expect(state.owner.focus).toEqual({ alpha: 1 + 0.9 * PERCEIVE_WEIGHT, beta: 1 + 0.1 * PERCEIVE_WEIGHT });
    expect(state.owner.stuck.alpha).toBeCloseTo(1 + 0.1 * PERCEIVE_WEIGHT, 9);
    expect(ownerPerceive(base, ev('judgement:result', { purpose: 'classify', questionSetId: 'moment-fanout', momentId: 'm1', answers: { in_flow: { type: 'noul', noul: 0.9 } }, model: 'm', latencyMs: 1 })).state).toBe(base);
  });

  it("the owner's tap is scored against the belief it met (Brier), and counted toward the gate", () => {
    let state = createInitialState('d1');
    state = { ...state, owner: { ...state.owner, focus: { alpha: 9, beta: 1 }, stuck: { alpha: 1, beta: 9 } } };
    const flow = ownerPerceive(state, ev('owner:self-report', { tap: 'flow' })).state;
    expect(flow.owner.selfReports[0]).toMatchObject({ tap: 'flow', pFlow: 0.9, pStuck: 0.1 });
    expect(flow.owner.selfReports[0].brier).toBeCloseTo(brierOf(0.9, 0.1, 'flow'), 9);
    expect(flow.owner.brier).toEqual({ n: 1, sum: flow.owner.selfReports[0].brier, firstAt: TS });
    const stuck = ownerPerceive(flow, ev('owner:self-report', { tap: 'stuck' }, '2026-09-22T13:00:00.000Z')).state;
    expect(stuck.owner.brier.n).toBe(2);
    expect(stuck.owner.selfReports[1].brier).toBeCloseTo(((0.9 - 0) ** 2 + (0.1 - 1) ** 2) / 2, 9);
    expect(ownerPerceive(state, ev('owner:self-report', { tap: 'great' })).state).toBe(state);
    expect(mean({ alpha: 9, beta: 1 })).toBe(0.9);
  });
});
