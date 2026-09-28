import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { focusFlow } from './focus-flow.js';

function withMoment(state: KernelState, processName = 'Code'): KernelState {
  return { ...state, moment: { id: 'm1', sessionId: 's1', startTime: '2026-01-01T00:00:00.000Z', processName, projectId: null, rollup: { processName, windowTitles: [], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null }, intent: { status: 'none' } } };
}

function inputEvent(ts: string, activity: Partial<{ keyDownCount: number; mouseClickCount: number; mouseMoveCount: number; scrollCount: number }>, windowMs = 10_000): SanitizedEvent {
  return { id: 'e1', type: 'input:activity', ts, payload: { windowMs, keyDownCount: 0, mouseClickCount: 0, mouseMoveCount: 0, scrollCount: 0, ...activity }, sanitized: true };
}

function idleStart(ts: string): SanitizedEvent {
  return { id: 'idle', type: 'idle:start', ts, payload: { timestamp: ts }, sanitized: true };
}

describe('focusFlow', () => {
  it('starts a span on typing', () => {
    const state = withMoment(createInitialState('d1'));
    const { state: next } = focusFlow(state, inputEvent('2026-01-01T00:00:00.000Z', { keyDownCount: 10 }));
    expect(next.lifeEvent.flow).toEqual({ processName: 'Code', startedAt: '2026-01-01T00:00:00.000Z', sampleCount: 1, sampleSum: 60 });
  });

  it('C15: starts a span on reading too — a scroll with no typing, which the old typing-rate gate ignored', () => {
    const state = withMoment(createInitialState('d1'));
    // 5 scrolls / 10s = 30 events/min, zero keystrokes.
    const { state: next } = focusFlow(state, inputEvent('2026-01-01T00:00:00.000Z', { scrollCount: 5 }));
    expect(next.lifeEvent.flow).toEqual({ processName: 'Code', startedAt: '2026-01-01T00:00:00.000Z', sampleCount: 1, sampleSum: 30 });
  });

  it('accumulates sampleCount/sampleSum across active ticks (running mean, not a stored array)', () => {
    const state = withMoment(createInitialState('d1'));
    let next = focusFlow(state, inputEvent('2026-01-01T00:00:00.000Z', { keyDownCount: 10 })).state; // 60/min
    next = focusFlow(next, inputEvent('2026-01-01T00:00:10.000Z', { mouseMoveCount: 20 })).state; // 120/min
    expect(next.lifeEvent.flow).toEqual({ processName: 'Code', startedAt: '2026-01-01T00:00:00.000Z', sampleCount: 2, sampleSum: 180 });
  });

  it('does not start a span on a fully idle (zero-activity) window', () => {
    const state = withMoment(createInitialState('d1'));
    const { state: next, effects } = focusFlow(state, inputEvent('2026-01-01T00:00:00.000Z', {}));
    expect(next.lifeEvent.flow).toBeNull();
    expect(effects).toEqual([]);
  });

  it('tolerates a quiet window mid-span — a reading pause does not close the span', () => {
    let state = withMoment(createInitialState('d1'));
    state = focusFlow(state, inputEvent('2026-01-01T00:00:00.000Z', { scrollCount: 3 })).state;
    const { state: next } = focusFlow(state, inputEvent('2026-01-01T00:00:10.000Z', {})); // no activity
    expect(next.lifeEvent.flow).not.toBeNull();
    expect(next.lifeEvent.flow?.sampleCount).toBe(1); // unchanged: the quiet window neither extends nor closes
  });

  it('emits event:focus-flow when a sustained span (>=5min) closes via window:changed', () => {
    let state = withMoment(createInitialState('d1'));
    state = focusFlow(state, inputEvent('2026-01-01T00:00:00.000Z', { keyDownCount: 10 })).state;
    state = focusFlow(state, inputEvent('2026-01-01T00:03:00.000Z', { keyDownCount: 10 })).state;

    const closeEvent: SanitizedEvent = { id: 'e2', type: 'window:changed', ts: '2026-01-01T00:06:00.000Z', payload: { processName: 'Warp' }, sanitized: true };
    const { state: next, effects } = focusFlow(state, closeEvent);

    expect(next.lifeEvent.flow).toBeNull();
    expect(effects).toEqual([
      {
        type: 'EmitEvent',
        event: { id: expect.any(String), type: 'event:focus-flow', ts: '2026-01-01T00:06:00.000Z', payload: { timestamp: '2026-01-01T00:06:00.000Z', momentId: 'm1', processName: 'Code', durationMs: 360_000, activityRatePerMin: 60 } },
      },
    ]);
  });

  it('closes the span on idle:start — sustained inactivity ends deep work', () => {
    let state = withMoment(createInitialState('d1'));
    state = focusFlow(state, inputEvent('2026-01-01T00:00:00.000Z', { scrollCount: 5 })).state;
    state = focusFlow(state, inputEvent('2026-01-01T00:03:00.000Z', { scrollCount: 5 })).state;
    const { state: next, effects } = focusFlow(state, idleStart('2026-01-01T00:06:00.000Z'));
    expect(next.lifeEvent.flow).toBeNull();
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'EmitEvent', event: { type: 'event:focus-flow' } });
  });

  it('does NOT emit a one-off span: a single stray event that then idles out after 5min is not deep work', () => {
    let state = withMoment(createInitialState('d1'));
    state = focusFlow(state, inputEvent('2026-01-01T00:00:00.000Z', { mouseMoveCount: 1 })).state;
    const { effects } = focusFlow(state, idleStart('2026-01-01T00:06:00.000Z'));
    expect(effects).toEqual([]); // sampleCount 1 < FLOW_MIN_ACTIVE_WINDOWS
  });

  it('does not emit for a short span that closes before the minimum duration', () => {
    let state = withMoment(createInitialState('d1'));
    state = focusFlow(state, inputEvent('2026-01-01T00:00:00.000Z', { keyDownCount: 10 })).state;
    state = focusFlow(state, inputEvent('2026-01-01T00:00:10.000Z', { keyDownCount: 10 })).state;

    const closeEvent: SanitizedEvent = { id: 'e2', type: 'window:changed', ts: '2026-01-01T00:01:00.000Z', payload: { processName: 'Warp' }, sanitized: true };
    const { effects } = focusFlow(state, closeEvent);
    expect(effects).toEqual([]);
  });
});
