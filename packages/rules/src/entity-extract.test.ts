import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { entityExtract, normaliseProcessName, slugifyEntityName } from './entity-extract.js';

describe('slugifyEntityName', () => {
  it('lowercases and dashes non-alphanumeric runs', () => {
    expect(slugifyEntityName('Priya Sharma')).toBe('priya-sharma');
    expect(slugifyEntityName('  gnomon-base ')).toBe('gnomon-base');
  });
});

function withMomentAndProject(state: KernelState): KernelState {
  return {
    ...state,
    project: { current: { id: '/repo/gnomon', name: 'gnomon' }, org: null, known: { '/repo/gnomon': { name: 'gnomon', org: null, remote: null, branch: null } }, recentDetections: [], lastClosedMoment: null },
    moment: {
      id: 'm1',
      sessionId: 's1',
      startTime: '2026-01-01T10:00:00.000Z',
      processName: 'Code',
      projectId: '/repo/gnomon',
      rollup: { processName: 'Code', windowTitles: [], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null },
      intent: { status: 'none' },
    },
  };
}

describe('entityExtract', () => {
  it('proposes a project/usesTool candidate when a moment with a known project is open', () => {
    const state = withMomentAndProject(createInitialState('d1'));
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };

    const { effects } = entityExtract(state, event);

    expect(effects).toHaveLength(1);
    const inner = (effects[0] as any).event;
    expect(inner.type).toBe('entity:fact-candidate');
    expect(inner.payload).toEqual({
      entityId: 'project:gnomon',
      entityKind: 'project',
      canonicalName: 'gnomon',
      predicate: 'usesTool',
      object: 'Code',
      confidence: 70,
      sourceEventId: 'e1',
      projectId: '/repo/gnomon',
      provenance: 'inference',
    });
  });

  // C13 — the task tier. A non-base branch mints a `task` entity alongside the
  // usesTool candidate, tied to the moment's project.
  function withBranch(state: KernelState, gitBranch: string, windowTitles: string[] = []): KernelState {
    const base = withMomentAndProject(state);
    return { ...base, moment: { ...base.moment!, rollup: { ...base.moment!.rollup, gitBranch, windowTitles } } };
  }
  const closeEvent: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };
  const taskCandidate = (effects: ReturnType<typeof entityExtract>['effects']) =>
    effects.map((e) => (e as any).event.payload).find((p) => p.entityKind === 'task');

  it('C13: mints a task/relatesToProject candidate from a non-base branch, alongside usesTool', () => {
    const { effects } = entityExtract(withBranch(createInitialState('d1'), 'feat/redesign-and-tablet'), closeEvent);
    expect(effects).toHaveLength(2);
    expect(taskCandidate(effects)).toEqual({
      entityId: 'task:redesign-and-tablet',
      entityKind: 'task',
      canonicalName: 'redesign-and-tablet', // conventional prefix stripped, slashes collapsed
      predicate: 'relatesToProject',
      object: 'gnomon',
      confidence: 75,
      sourceEventId: 'e1',
      projectId: '/repo/gnomon',
      provenance: 'inference',
    });
  });

  it('C13: prefers a ticket id as the task name, from the branch or the window titles', () => {
    expect(taskCandidate(entityExtract(withBranch(createInitialState('d1'), 'bugfix/BOX-508-thing'), closeEvent).effects)?.canonicalName).toBe('BOX-508');
    expect(taskCandidate(entityExtract(withBranch(createInitialState('d1'), 'my-branch', ['[1p] ABC-42 · Pull Request']), closeEvent).effects)?.canonicalName).toBe('ABC-42');
  });

  it('C13: mints no task from a base branch', () => {
    for (const branch of ['main', 'master', 'develop', 'release/1.2', 'stable', 'STABLE']) {
      expect(taskCandidate(entityExtract(withBranch(createInitialState('d1'), branch), closeEvent).effects)).toBeUndefined();
    }
  });

  it('C13: mints no task when the branch is just the repo’s own name (default-branch inflation)', () => {
    expect(taskCandidate(entityExtract(withBranch(createInitialState('d1'), 'gnomon'), closeEvent).effects)).toBeUndefined();
  });

  /**
   * The reference-corpus case the narrower guard missed entirely: the branch
   * `gnomon` carried 336 moments over 6 days and never once resolved to a project
   * called `gnomon` — that work happened in worktrees and sibling checkouts the
   * resolver names something else. Comparing against `state.project.current`
   * alone therefore minted a task on every one of those moments.
   */
  it('C13: mints no task from a branch naming a DIFFERENT known project than the one it resolved to', () => {
    const base = withBranch(createInitialState('d1'), 'gnomon');
    const state: KernelState = {
      ...base,
      project: {
        ...base.project,
        current: { id: '/repo/puzzlebox-studio', name: 'puzzlebox-studio' },
        known: {
          '/repo/gnomon': { name: 'gnomon', org: null, remote: null, branch: null },
          '/repo/puzzlebox-studio': { name: 'puzzlebox-studio', org: null, remote: null, branch: null },
        },
      },
    };
    expect(taskCandidate(entityExtract(state, closeEvent).effects)).toBeUndefined();
  });

  it('C13: mints no task from a branch naming a project ALIAS, which config supplies before any project is detected', () => {
    const base = withBranch(createInitialState('d1'), 'wcs');
    const state: KernelState = {
      ...base,
      project: { ...base.project, current: { id: '/repo/other', name: 'other' }, known: {} },
      config: { ...base.config, projectAliases: { wcs: 'gnomon' } },
    };
    expect(taskCandidate(entityExtract(state, closeEvent).effects)).toBeUndefined();
  });

  it('D2-adjacent fix: does NOT propose a usesTool candidate on a same-process, same-project title change (B1 append, not a real close)', () => {
    const state = withMomentAndProject(createInitialState('d1'));
    // Same process ('Code') and same project as the open moment — B1's
    // momentClose would append this title, not close.
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: { processName: 'Code', documentPath: '/repo/gnomon/src/a.ts' }, sanitized: true };
    expect(entityExtract(state, event).effects).toEqual([]);
  });

  it('does nothing on window:changed without an open moment or a known project', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };
    expect(entityExtract(state, event).effects).toEqual([]);
  });

  it("E3: does not propose a usesTool fact when the moment's processName is the [hidden] redaction placeholder", () => {
    const base = withMomentAndProject(createInitialState('d1'));
    const state: KernelState = { ...base, moment: { ...base.moment!, processName: '[hidden]' } };
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };
    expect(entityExtract(state, event).effects).toEqual([]);
  });

  it('M1: skips OS plumbing and normalises invisible marks out of the tool name', () => {
    const base = withMomentAndProject(createInitialState('d1'));
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: {}, sanitized: true };
    const finder: KernelState = { ...base, moment: { ...base.moment!, processName: 'Finder' } };
    expect(entityExtract(finder, event).effects).toEqual([]);
    const marked: KernelState = { ...base, moment: { ...base.moment!, processName: '\u200EWhatsApp ' } };
    expect((entityExtract(marked, event).effects[0] as any).event.payload.object).toBe('WhatsApp');
    expect(normaliseProcessName('\uFEFFCafe\u0301\u200F')).toBe('Caf\u00E9');
  });

  // `calendar:active` person extraction returned 2026-08-14, but ONLY in the shape
  // that survives the three failures the original was removed for (see
  // entity-extract.ts's header). This test pins those three, since they are what
  // make the trigger safe to reuse: no project link, no meeting title, and no
  // per-meeting cursor entry.
  it('mints attendees from calendar:active without reviving the removed shape', () => {
    const state = withMomentAndProject(createInitialState('d1'));
    const event: SanitizedEvent = {
      id: 'e1',
      type: 'calendar:active',
      ts: '2026-01-01T10:05:00.000Z',
      payload: { event: { eventId: 'evt-sprint', title: 'Sprint planning', attendees: ['Priya Sharma', 'sam@example.com'] } },
      sanitized: true,
    };

    const payloads = entityExtract(state, event).effects.map((e: any) => e.event.payload);
    expect(payloads).toHaveLength(2);
    for (const p of payloads) {
      // 1. No project claim — the ambient pointer is never consulted, even though
      //    this state HAS a current project.
      expect(p.projectId).toBeNull();
      expect(p.object).toBe('owner');
      // 2. One cursor key per person, not per meeting.
      expect(p.predicate).toBe('attendedMeetingWith');
    }
    // 3. The unredacted title reaches nothing.
    expect(JSON.stringify(payloads)).not.toContain('Sprint planning');
  });

  it('mints no topic from screen:ocr any more — retired 2026-09-07, 85 such facts in a month and none useful', () => {
    const state = withMomentAndProject(createInitialState('d1'));
    const event: SanitizedEvent = { id: 'e1', type: 'screen:ocr', ts: '2026-01-01T10:05:00.000Z', payload: { topics: ['reducer', 'kernel'] }, sanitized: true };
    expect(entityExtract(state, event).effects).toEqual([]);
  });

  it('ignores unrelated event types', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'input:activity', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };
    expect(entityExtract(state, event).effects).toEqual([]);
  });

  it('no longer mints topic candidates from document:opened / search:performed (removed — noisy + ambiently misattributed)', () => {
    const state = withMomentAndProject(createInitialState('d1'));
    const docEvent: SanitizedEvent = { id: 'e1', type: 'document:opened', ts: '2026-01-01T10:05:00.000Z', payload: { kind: 'jira-ticket', id: 'GNOM-123', title: 'Fix the reducer bug' }, sanitized: true };
    const searchEvent: SanitizedEvent = { id: 'e2', type: 'search:performed', ts: '2026-01-01T10:05:00.000Z', payload: { query: 'how to fix a reducer bug' }, sanitized: true };
    expect(entityExtract(state, docEvent).effects).toEqual([]);
    expect(entityExtract(state, searchEvent).effects).toEqual([]);
  });

  describe('C2: project/deployedVia from event:deploy', () => {
    it('proposes a high-confidence project/deployedVia candidate', () => {
      const state = withMomentAndProject(createInitialState('d1'));
      const event: SanitizedEvent = {
        id: 'e1',
        type: 'event:deploy',
        ts: '2026-01-01T10:05:00.000Z',
        payload: { projectName: 'gnomon', target: 'docker' },
        sanitized: true,
      };

      const { effects } = entityExtract(state, event);
      expect((effects[0] as any).event.payload).toEqual({
        entityId: 'project:gnomon',
        entityKind: 'project',
        canonicalName: 'gnomon',
        predicate: 'deployedVia',
        object: 'docker',
        confidence: 80,
        sourceEventId: 'e1',
        projectId: '/repo/gnomon',
        provenance: 'inference',
      });
    });

    it('falls back to state.project.current when the payload omits projectName', () => {
      const state = withMomentAndProject(createInitialState('d1'));
      const event: SanitizedEvent = { id: 'e1', type: 'event:deploy', ts: '2026-01-01T10:05:00.000Z', payload: { projectName: null, target: 'git-push' }, sanitized: true };
      expect((entityExtract(state, event).effects[0] as any).event.payload.canonicalName).toBe('gnomon');
    });

    it('does nothing when neither payload nor state has a project name, or target is missing', () => {
      const state = createInitialState('d1');
      const noProject: SanitizedEvent = { id: 'e1', type: 'event:deploy', ts: '2026-01-01T10:05:00.000Z', payload: { projectName: null, target: 'docker' }, sanitized: true };
      expect(entityExtract(state, noProject).effects).toEqual([]);

      const withProject = withMomentAndProject(createInitialState('d1'));
      const noTarget: SanitizedEvent = { id: 'e2', type: 'event:deploy', ts: '2026-01-01T10:05:00.000Z', payload: { projectName: 'gnomon', target: null }, sanitized: true };
      expect(entityExtract(withProject, noTarget).effects).toEqual([]);
    });
  });
});


describe('entityExtract — colleagues from calendar attendees', () => {
  const active = (attendees: string[], eventId: string, ts = '2026-01-01T10:00:00.000Z', id = 'e1'): SanitizedEvent => ({
    id,
    type: 'calendar:active',
    ts,
    payload: { event: { attendees, eventId, title: 'Standup' } },
    sanitized: true,
  });
  const people = (effects: unknown[]) => effects.map((e) => (e as any).event.payload).filter((p) => p.entityKind === 'person');

  it('mints one candidate per attendee, with a constant object and no project claim', () => {
    const { effects } = entityExtract(createInitialState('d1'), active(['Ben de Groot', 'Mia Vos'], 'evt-1'));

    expect(people(effects)).toHaveLength(2);
    expect(people(effects)[0]).toMatchObject({
      entityId: 'person:ben-de-groot',
      entityKind: 'person',
      canonicalName: 'Ben de Groot',
      predicate: 'attendedMeetingWith',
      object: 'owner',
      confidence: 60,
      // The removed producer's defining defect: a project asserted from the ambient pointer.
      projectId: null,
      provenance: 'inference',
    });
  });

  it('never reads the meeting title, which sanitizeAtIngest leaves verbatim', () => {
    const { effects } = entityExtract(createInitialState('d1'), active(['Ben de Groot'], 'evt-1'));
    expect(JSON.stringify(effects)).not.toContain('Standup');
  });

  it('mints once per meeting however often calendar:active polls it', () => {
    let state = createInitialState('d1');
    const first = entityExtract(state, active(['Ben de Groot'], 'evt-1', '2026-01-01T10:00:00.000Z', 'e1'));
    expect(people(first.effects)).toHaveLength(1);

    const second = entityExtract(first.state, active(['Ben de Groot'], 'evt-1', '2026-01-01T10:05:00.000Z', 'e2'));
    expect(people(second.effects)).toHaveLength(0);
  });

  it('mints again for a different meeting, including the next occurrence of a recurring one', () => {
    let state = createInitialState('d1');
    state = entityExtract(state, active(['Ben de Groot'], 'evt-1/RID=1', '2026-01-01T10:00:00.000Z', 'e1')).state;
    const next = entityExtract(state, active(['Ben de Groot'], 'evt-1/RID=2', '2026-01-02T10:00:00.000Z', 'e2'));
    expect(people(next.effects)).toHaveLength(1);
  });

  it('survives two overlapping meetings polling alternately', () => {
    let state = createInitialState('d1');
    state = entityExtract(state, active(['Bob'], 'evt-A', '2026-01-01T10:00:00.000Z', 'e1')).state;
    state = entityExtract(state, active(['Isa'], 'evt-B', '2026-01-01T10:01:00.000Z', 'e2')).state;
    const backToA = entityExtract(state, active(['Bob'], 'evt-A', '2026-01-01T10:02:00.000Z', 'e3'));
    expect(people(backToA.effects)).toHaveLength(0);
  });

  it('caps a distribution list so it cannot flush the fact cursor', () => {
    const many = Array.from({ length: 30 }, (_, i) => `Attendee Number${i}`);
    const { effects } = entityExtract(createInitialState('d1'), active(many, 'evt-big'));
    expect(people(effects)).toHaveLength(8);
  });

  it('emits nothing for a meeting with no attendees, and records no key', () => {
    const { state: next, effects } = entityExtract(createInitialState('d1'), active([], 'evt-empty'));
    expect(effects).toEqual([]);
    expect(next.memory.recentMeetingKeys).toEqual([]);
  });
});

describe('entityExtract — edited code symbols are not topics any more', () => {
  it('mints nothing from symbol:edited — the identifiers stay on the moment, not in the belief graph', () => {
    const base = createInitialState('d1');
    const state: KernelState = { ...base, project: { ...base.project, known: { '/repo/gnomon': { id: '/repo/gnomon', name: 'gnomon', rootPath: '/repo/gnomon' } as never } } };
    const event: SanitizedEvent = { id: 'e1', type: 'symbol:edited', ts: '2026-01-01T10:05:00.000Z', payload: { projectRoot: '/repo/gnomon', edits: [{ symbols: ['SidecarCheck', 'classifySidecar'] }] }, sanitized: true };
    expect(entityExtract(state, event).effects).toEqual([]);
  });
});
