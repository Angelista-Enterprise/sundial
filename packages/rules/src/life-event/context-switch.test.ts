import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { contextSwitch } from './context-switch.js';

describe('contextSwitch', () => {
  it('emits immediately on a same-project branch flip (project:switched, kind=branch)', () => {
    const state: KernelState = { ...createInitialState('d1'), lifeEvent: { ...createInitialState('d1').lifeEvent, lastMomentProcess: 'Code' } };
    const event: SanitizedEvent = {
      id: 'e1',
      type: 'project:switched',
      ts: '2026-01-01T00:00:00.000Z',
      payload: { kind: 'branch', fromProjectName: 'gnomon', toProjectName: 'gnomon', fromBranch: 'main', toBranch: 'feature/x' },
      sanitized: true,
    };

    const { effects } = contextSwitch(state, event);

    expect(effects).toEqual([
      {
        type: 'EmitEvent',
        event: {
          id: expect.any(String),
          type: 'event:context-switch',
          ts: '2026-01-01T00:00:00.000Z',
          payload: { timestamp: '2026-01-01T00:00:00.000Z', fromProject: 'gnomon@main', toProject: 'gnomon@feature/x', fromProcess: 'Code', toProcess: 'Code' },
        },
      },
    ]);
  });

  it('ignores a non-branch project:switched', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'project:switched', ts: '2026-01-01T00:00:00.000Z', payload: { kind: 'root' }, sanitized: true };
    expect(contextSwitch(state, event).effects).toEqual([]);
  });

  it('emits on window:changed when the about-to-close moment belongs to a different project than the current one', () => {
    const base = createInitialState('d1');
    const state: KernelState = {
      ...base,
      moment: { id: 'm1', sessionId: 's1', startTime: '2026-01-01T00:00:00.000Z', processName: 'Code', projectId: '/x/project-a', rollup: { processName: 'Code', windowTitles: [], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null }, intent: { status: 'none' } },
      project: { current: { id: '/x/project-b', name: 'project-b' }, org: null, known: {}, recentDetections: [], lastClosedMoment: null },
    };
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:01:00.000Z', payload: { processName: 'Warp' }, sanitized: true };

    const { state: next, effects } = contextSwitch(state, event);

    expect(effects).toEqual([
      {
        type: 'EmitEvent',
        event: {
          id: expect.any(String),
          type: 'event:context-switch',
          ts: '2026-01-01T00:01:00.000Z',
          payload: { timestamp: '2026-01-01T00:01:00.000Z', fromProject: '/x/project-a', toProject: '/x/project-b', fromProcess: 'Code', toProcess: 'Warp' },
        },
      },
    ]);
    expect(next.lifeEvent.lastMomentProject).toBe('/x/project-a');
    expect(next.lifeEvent.lastMomentProcess).toBe('Code');
  });

  it('does not emit when the project is unchanged', () => {
    const base = createInitialState('d1');
    const state: KernelState = {
      ...base,
      moment: { id: 'm1', sessionId: 's1', startTime: '2026-01-01T00:00:00.000Z', processName: 'Code', projectId: '/x/project-a', rollup: { processName: 'Code', windowTitles: [], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null }, intent: { status: 'none' } },
      project: { current: { id: '/x/project-a', name: 'project-a' }, org: null, known: {}, recentDetections: [], lastClosedMoment: null },
    };
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:01:00.000Z', payload: { processName: 'Warp' }, sanitized: true };

    expect(contextSwitch(state, event).effects).toEqual([]);
  });
});
