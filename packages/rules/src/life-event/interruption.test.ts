import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { interruption } from './interruption.js';

function withMoment(state: KernelState, id = 'm1'): KernelState {
  return { ...state, moment: { id, sessionId: 's1', startTime: '2026-01-01T00:00:00.000Z', processName: 'Code', projectId: null, rollup: { processName: 'Code', windowTitles: [], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null }, intent: { status: 'none' } } };
}

describe('interruption', () => {
  it('emits event:interruption for a rising notification while a moment is open', () => {
    const state = withMoment(createInitialState('d1'));
    const event: SanitizedEvent = {
      id: 'e1',
      type: 'event:notification',
      ts: '2026-01-01T00:05:00.000Z',
      payload: { rising: true, counts: [{ app: 'Slack', count: 3 }, { app: 'Mail', count: 1 }] },
      sanitized: true,
    };

    const { effects } = interruption(state, event);

    expect(effects).toEqual([
      {
        type: 'EmitEvent',
        event: { id: expect.any(String), type: 'event:interruption', ts: '2026-01-01T00:05:00.000Z', payload: { timestamp: '2026-01-01T00:05:00.000Z', momentId: 'm1', cause: 'notification', detail: 'Slack, Mail' } },
      },
    ]);
  });

  it('does not emit when notifications are falling, not rising', () => {
    const state = withMoment(createInitialState('d1'));
    const event: SanitizedEvent = { id: 'e1', type: 'event:notification', ts: '2026-01-01T00:00:00.000Z', payload: { rising: false, counts: [] }, sanitized: true };
    expect(interruption(state, event).effects).toEqual([]);
  });

  it('does not emit when no moment is open', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'event:notification', ts: '2026-01-01T00:00:00.000Z', payload: { rising: true, counts: [{ app: 'Slack' }] }, sanitized: true };
    expect(interruption(state, event).effects).toEqual([]);
  });
});
