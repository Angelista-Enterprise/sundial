import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { contextSwitch } from './context-switch.js';

function momentOn(projectId: string | null): NonNullable<KernelState['moment']> {
  return { id: `m-${projectId}`, sessionId: 's1', startTime: '2026-01-01T00:00:00.000Z', processName: 'Code', projectId, rollup: { processName: 'Code', windowTitles: [], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null }, intent: { status: 'none' } } as never;
}

describe('contextSwitch', () => {
  it('emits immediately on a same-project branch flip (project:switched, kind=branch)', () => {
    const state: KernelState = { ...createInitialState('d1'), lifeEvent: { ...createInitialState('d1').lifeEvent, lastMomentProcess: 'Code' } };
    const event: SanitizedEvent = {
      id: 'e1',
      type: 'project:switched',
      ts: '2026-01-01T00:00:00.000Z',
      payload: { kind: 'branch', fromProjectRoot: '/x/puzzlebox', toProjectRoot: '/x/puzzlebox', fromProjectName: 'puzzlebox', toProjectName: 'puzzlebox', fromBranch: 'main', toBranch: 'feature/x' },
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
          // One key for a project on both paths: its root, the id a moment carries.
          payload: { timestamp: '2026-01-01T00:00:00.000Z', fromProject: '/x/puzzlebox', toProject: '/x/puzzlebox', fromBranch: 'main', toBranch: 'feature/x', fromProcess: 'Code', toProcess: 'Code' },
        },
      },
    ]);
  });

  it('ignores a non-branch project:switched', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'project:switched', ts: '2026-01-01T00:00:00.000Z', payload: { kind: 'root' }, sanitized: true };
    expect(contextSwitch(state, event).effects).toEqual([]);
  });

  it('emits on window:changed when the closing moment is on a different project than the last one', () => {
    const base = createInitialState('d1');
    const state: KernelState = {
      ...base,
      moment: momentOn('/x/project-b'),
      // The sticky pointer is NOT the comparison: it can hold a third project.
      project: { current: { id: '/x/project-c', name: 'project-c' }, org: null, known: {}, recentDetections: [], lastClosedMoment: null },
      lifeEvent: { ...base.lifeEvent, lastMomentProject: '/x/project-a', lastMomentProcess: 'Warp' },
    };
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:01:00.000Z', payload: { processName: 'Arc' }, sanitized: true };

    const { state: next, effects } = contextSwitch(state, event);

    expect(effects).toEqual([
      {
        type: 'EmitEvent',
        event: {
          id: expect.any(String),
          type: 'event:context-switch',
          ts: '2026-01-01T00:01:00.000Z',
          payload: { timestamp: '2026-01-01T00:01:00.000Z', fromProject: '/x/project-a', toProject: '/x/project-b', fromProcess: 'Warp', toProcess: 'Code' },
        },
      },
    ]);
    expect(next.lifeEvent.lastMomentProject).toBe('/x/project-b');
    expect(next.lifeEvent.lastMomentProcess).toBe('Code');
  });

  /** F3 — against the sticky pointer, a return to A was never a switch "to" A. */
  it('sees A → B → A as a switch back to A, across a project-less moment', () => {
    let state: KernelState = { ...createInitialState('d1'), project: { current: { id: '/x/project-b', name: 'project-b' }, org: null, known: {}, recentDetections: [], lastClosedMoment: null } };
    const switches: { fromProject: string; toProject: string }[] = [];
    ['/x/project-a', '/x/project-b', null, '/x/project-a'].forEach((projectId, i) => {
      const out = contextSwitch({ ...state, moment: momentOn(projectId) }, { id: `e${i}`, type: 'window:changed', ts: `2026-01-01T0${i}:00:00.000Z`, payload: { processName: 'Arc' }, sanitized: true });
      state = out.state;
      for (const e of out.effects) switches.push((e as unknown as { event: { payload: { fromProject: string; toProject: string } } }).event.payload);
    });
    expect(switches.map((p) => `${p.fromProject}→${p.toProject}`)).toEqual(['/x/project-a→/x/project-b', '/x/project-b→/x/project-a']);
  });

  it('does not emit when the project is unchanged', () => {
    const base = createInitialState('d1');
    const state: KernelState = {
      ...base,
      moment: { id: 'm1', sessionId: 's1', startTime: '2026-01-01T00:00:00.000Z', processName: 'Code', projectId: '/x/project-a', rollup: { processName: 'Code', windowTitles: [], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null }, intent: { status: 'none' } },
      project: { current: { id: '/x/project-b', name: 'project-b' }, org: null, known: {}, recentDetections: [], lastClosedMoment: null },
      lifeEvent: { ...base.lifeEvent, lastMomentProject: '/x/project-a' },
    };
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:01:00.000Z', payload: { processName: 'Warp' }, sanitized: true };

    expect(contextSwitch(state, event).effects).toEqual([]);
  });
});
