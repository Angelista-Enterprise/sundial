import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { momentClose, noIntentReason } from './moment-close.js';

function windowEvent(ts: string, processName: string, windowTitle = 'Some Title', documentPath: string | null = null): SanitizedEvent {
  return { id: `e-${ts}`, type: 'window:changed', ts, payload: { processName, windowTitle, documentPath }, sanitized: true };
}

/** A state whose known-projects registry contains `root` (name = its basename). */
function withKnown(base: KernelState, ...roots: string[]): KernelState {
  const known = { ...base.project.known };
  for (const root of roots) known[root] = { name: root.split('/').pop() ?? root, org: null, remote: null, branch: null };
  return { ...base, project: { ...base.project, known } };
}

function idleStartEvent(ts: string): SanitizedEvent {
  return { id: `e-${ts}`, type: 'idle:start', ts, payload: { timestamp: ts }, sanitized: true };
}

function idleEndEvent(ts: string): SanitizedEvent {
  return { id: `e-${ts}`, type: 'idle:end', ts, payload: { timestamp: ts }, sanitized: true };
}

function clockTickEvent(ts: string): SanitizedEvent {
  return { id: `e-${ts}`, type: 'clock:tick', ts, payload: {}, sanitized: true };
}

function sleepWakeEvent(ts: string, kind: 'sleep' | 'wake'): SanitizedEvent {
  return { id: `e-${ts}`, type: 'system:sleep-wake', ts, payload: { timestamp: ts, kind }, sanitized: true };
}

/**
 * Folds a `clock:tick` every 60s from `fromTs` up to and including `toTs`,
 * the way a running daemon does.
 *
 * Needed because `momentClose` now reconciles against gaps in the event stream:
 * a fixture that jumps ten minutes with no events in between looks exactly like
 * ten minutes of sleep, and would be reconciled rather than exercising the
 * trigger under test. In production 99.7% of consecutive events are under a
 * minute apart, so this is what a quiet ten minutes really looks like.
 *
 * Returns the state after the ticks, and any effects they produced (a 30-minute
 * split can legitimately fire while advancing).
 */
function tickThrough(state: KernelState, fromTs: string, toTs: string): { state: KernelState; effects: unknown[] } {
  let s = state;
  const effects: unknown[] = [];
  const end = Date.parse(toTs);
  for (let t = Date.parse(fromTs) + 60_000; t <= end; t += 60_000) {
    const r = momentClose(s, clockTickEvent(new Date(t).toISOString()));
    s = r.state;
    effects.push(...r.effects);
  }
  return { state: s, effects };
}

describe('momentClose', () => {
  it('opens the first moment on boot', () => {
    const state = createInitialState('d1');
    const { state: next } = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code'));
    expect(next.moment).toMatchObject({ processName: 'Code' });
  });

  it('closes and reopens on a normal window change, writing the closed moment', () => {
    let state = createInitialState('d1');
    state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code')).state;

    const { state: next, effects } = momentClose(state, windowEvent('2026-01-01T00:05:00.000Z', 'Warp'));

    expect(next.moment).toMatchObject({ processName: 'Warp' });
    expect(effects).toEqual([
      {
        type: 'WriteDB',
        table: 'moments',
        row: {
          id: expect.any(String),
          startTime: '2026-01-01T00:00:00.000Z',
          endTime: '2026-01-01T00:05:00.000Z',
          durationMs: 300_000,
          processName: 'Code',
          data: {
            processName: 'Code',
            windowTitles: ['Some Title'],
            shellCommandCount: 0,
            notableCommands: [],
            gitCommitCount: 0,
            gitBranch: null,
            calendarActive: false,
            typingEventCount: 0, inputEventCount: 0, activeMs: 0,
            lifeEvents: [],
            projectSource: null,
            projectConfidence: null,
            micActive: false,
            cameraActive: false,
            meetingTitle: null,
            meetingAttendees: [],
            screenTopics: [],
            pages: [],
            screenExcerpt: null,
            unpushedCommits: null,
            playbackActive: false,
            audioApp: null,
            devActivityByProject: {},
            location: null,
            kind: 'setup',
            focusScore: expect.closeTo(1 / 3, 5), // 5 min / 15, no engagement
            focusQuality: 'shallow',
            audioContext: 'none',
          },
          // 5 minutes on the saturating duration curve, no bonus. Was exactly 1
          // under the old `round(1 + minutes/30)`, which flattened every moment
          // shorter than 15 minutes — 97% of them — onto the floor.
          importanceScore: expect.closeTo(1.946, 3),
          projectId: null,
        },
      },
    ]);
  });

  it('closes into a system process (loginwindow) without opening a new moment — a real gap', () => {
    let state = createInitialState('d1');
    state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code')).state;

    const { state: next, effects } = momentClose(state, windowEvent('2026-01-01T00:05:00.000Z', 'loginwindow'));

    expect(next.moment).toBeNull();
    expect(effects).toHaveLength(1);
    expect((effects[0] as any).row.processName).toBe('Code');
  });

  it('stays in the gap when the system process changes to another system process', () => {
    let state = createInitialState('d1');
    state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code')).state;
    state = momentClose(state, windowEvent('2026-01-01T00:05:00.000Z', 'loginwindow')).state;

    const { state: next, effects } = momentClose(state, windowEvent('2026-01-01T00:06:00.000Z', 'ScreenSaverEngine'));

    expect(next.moment).toBeNull();
    expect(effects).toEqual([]);
  });

  it('opens a fresh moment when a real window reappears after a gap', () => {
    let state = createInitialState('d1');
    state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code')).state;
    state = momentClose(state, windowEvent('2026-01-01T00:05:00.000Z', 'loginwindow')).state;

    const { state: next, effects } = momentClose(state, windowEvent('2026-01-01T00:45:00.000Z', 'Warp'));

    expect(next.moment).toMatchObject({ processName: 'Warp', startTime: '2026-01-01T00:45:00.000Z' });
    // No moment was open during the gap, so there's nothing to write for it.
    expect(effects).toEqual([]);
  });

  it('ignores non-window:changed events, apart from recording that it observed one', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'input:activity', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = momentClose(state, event);
    expect(next.moment).toBe(state.moment);
    expect(next.observation.lastObservedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(effects).toEqual([]);
  });

  it('fills projectId from the active window\'s documentPath (editor-doc)', () => {
    const base = withKnown(createInitialState('d1'), '/x/gnomon');
    const { state: next } = momentClose(base, windowEvent('2026-01-01T00:00:00.000Z', 'Code', 'a.ts', '/x/gnomon/src/a.ts'));
    expect(next.moment?.projectId).toBe('/x/gnomon');
    expect(next.moment?.rollup.projectSource).toBe('editor-doc');
    expect(next.moment?.rollup.projectConfidence).toBe('certain');
  });

  it('Phase 5 #4: an unattributed moment WITH dev activity falls back to the current project (git-activity/weak)', () => {
    const base = withKnown(createInitialState('d1'), '/x/gnomon');
    const rollup = {
      processName: 'Code',
      windowTitles: [],
      shellCommandCount: 0,
      notableCommands: [],
      gitCommitCount: 2,
      gitBranch: 'main',
      calendarActive: false,
      typingEventCount: 0, inputEventCount: 0, activeMs: 0,
      lifeEvents: [],
      projectSource: null,
      projectConfidence: null,
      micActive: false,
      cameraActive: false,
      meetingTitle: null,
      meetingAttendees: [],
      screenTopics: [],
            pages: [],
      screenExcerpt: null,
    };
    const state: KernelState = {
      ...base,
      project: { ...base.project, current: { id: '/x/gnomon', name: 'gnomon' } },
      moment: { id: 'm1', sessionId: 's1', startTime: '2026-01-01T00:00:00.000Z', processName: 'Code', projectId: null, rollup, intent: { status: 'none' } },
    };
    const { effects } = momentClose(state, windowEvent('2026-01-01T00:30:00.000Z', 'Slack'));
    const write = effects.find((e) => (e as { type: string }).type === 'WriteDB') as any;
    expect(write.row.projectId).toBe('/x/gnomon');
    expect(write.row.data.projectSource).toBe('git-activity');
    expect(write.row.data.projectConfidence).toBe('weak');
  });

  it('Phase 5 #4: an unattributed moment with NO dev activity does not fall back (no ambient stamping)', () => {
    const base = withKnown(createInitialState('d1'), '/x/gnomon');
    const rollup = {
      processName: 'Google Chrome',
      windowTitles: [],
      shellCommandCount: 0,
      notableCommands: [],
      gitCommitCount: 0,
      gitBranch: null,
      calendarActive: false,
      typingEventCount: 0, inputEventCount: 0, activeMs: 0,
      lifeEvents: [],
      projectSource: null,
      projectConfidence: null,
      micActive: false,
      cameraActive: false,
      meetingTitle: null,
      meetingAttendees: [],
      screenTopics: [],
            pages: [],
      screenExcerpt: null,
    };
    const state: KernelState = {
      ...base,
      project: { ...base.project, current: { id: '/x/gnomon', name: 'gnomon' } },
      moment: { id: 'm1', sessionId: 's1', startTime: '2026-01-01T00:00:00.000Z', processName: 'Google Chrome', projectId: null, rollup, intent: { status: 'none' } },
    };
    const { effects } = momentClose(state, windowEvent('2026-01-01T00:30:00.000Z', 'Slack'));
    const write = effects.find((e) => (e as { type: string }).type === 'WriteDB') as any;
    expect(write.row.projectId).toBeNull();
    expect(write.row.data.projectSource).toBeNull();
  });

  it('git-activity fallback prefers the moment\'s own dev-activity evidence over the ambient pointer', () => {
    // The Aug-2 regression: the owner's real work was gnomon (every dev event's
    // cwd said so), but `state.project.current` was parked on doe by a
    // stray `cd`. The evidence must win.
    const base = withKnown(createInitialState('d1'), '/x/gnomon', '/y/doe');
    const rollup = {
      processName: 'Google Chrome',
      windowTitles: [],
      shellCommandCount: 0,
      notableCommands: [],
      gitCommitCount: 0,
      gitBranch: 'lab/noticing-gate',
      calendarActive: false,
      typingEventCount: 0, inputEventCount: 0, activeMs: 0,
      lifeEvents: [],
      projectSource: null,
      projectConfidence: null,
      micActive: false,
      cameraActive: false,
      meetingTitle: null,
      meetingAttendees: [],
      screenTopics: [],
            pages: [],
      screenExcerpt: null,
      devActivityByProject: { '/x/gnomon': 5 },
    };
    const state: KernelState = {
      ...base,
      project: { ...base.project, current: { id: '/y/doe', name: 'doe' } },
      moment: { id: 'm1', sessionId: 's1', startTime: '2026-01-01T00:00:00.000Z', processName: 'Google Chrome', projectId: null, rollup, intent: { status: 'none' } },
    };
    const { effects } = momentClose(state, windowEvent('2026-01-01T00:30:00.000Z', 'Slack'));
    const write = effects.find((e) => (e as { type: string }).type === 'WriteDB') as any;
    expect(write.row.projectId).toBe('/x/gnomon');
    expect(write.row.data.projectSource).toBe('git-activity');
    expect(write.row.data.projectConfidence).toBe('weak');
  });

  it('gitBranch alone (a background git:status with no resolvable cwd) no longer triggers the ambient fallback', () => {
    const base = withKnown(createInitialState('d1'), '/y/doe');
    const rollup = {
      processName: 'Google Chrome',
      windowTitles: [],
      shellCommandCount: 0,
      notableCommands: [],
      gitCommitCount: 0,
      gitBranch: 'main',
      calendarActive: false,
      typingEventCount: 0, inputEventCount: 0, activeMs: 0,
      lifeEvents: [],
      projectSource: null,
      projectConfidence: null,
      micActive: false,
      cameraActive: false,
      meetingTitle: null,
      meetingAttendees: [],
      screenTopics: [],
            pages: [],
      screenExcerpt: null,
    };
    const state: KernelState = {
      ...base,
      project: { ...base.project, current: { id: '/y/doe', name: 'doe' } },
      moment: { id: 'm1', sessionId: 's1', startTime: '2026-01-01T00:00:00.000Z', processName: 'Google Chrome', projectId: null, rollup, intent: { status: 'none' } },
    };
    const { effects } = momentClose(state, windowEvent('2026-01-01T00:30:00.000Z', 'Slack'));
    const write = effects.find((e) => (e as { type: string }).type === 'WriteDB') as any;
    expect(write.row.projectId).toBeNull();
    expect(write.row.data.projectSource).toBeNull();
  });

  it('dev-activity fallback tie-break is deterministic (lexically-first root wins a tied count)', () => {
    const base = withKnown(createInitialState('d1'), '/x/gnomon', '/y/doe');
    const rollup = {
      processName: 'Code',
      windowTitles: [],
      shellCommandCount: 2,
      notableCommands: [],
      gitCommitCount: 0,
      gitBranch: null,
      calendarActive: false,
      typingEventCount: 0, inputEventCount: 0, activeMs: 0,
      lifeEvents: [],
      projectSource: null,
      projectConfidence: null,
      micActive: false,
      cameraActive: false,
      meetingTitle: null,
      meetingAttendees: [],
      screenTopics: [],
            pages: [],
      screenExcerpt: null,
      devActivityByProject: { '/y/doe': 1, '/x/gnomon': 1 },
    };
    const state: KernelState = {
      ...base,
      project: { ...base.project, current: null },
      moment: { id: 'm1', sessionId: 's1', startTime: '2026-01-01T00:00:00.000Z', processName: 'Code', projectId: null, rollup, intent: { status: 'none' } },
    };
    const { effects } = momentClose(state, windowEvent('2026-01-01T00:30:00.000Z', 'Slack'));
    const write = effects.find((e) => (e as { type: string }).type === 'WriteDB') as any;
    expect(write.row.projectId).toBe('/x/gnomon');
  });

  it('leaves projectId null for a window with no locator (no ambient stamping)', () => {
    const base = withKnown(createInitialState('d1'), '/x/gnomon');
    // Chrome, no documentPath — must NOT inherit the known project.
    const { state: next } = momentClose(base, windowEvent('2026-01-01T00:00:00.000Z', 'Google Chrome', 'Some Page'));
    expect(next.moment?.projectId).toBeNull();
    expect(next.moment?.rollup.projectSource).toBeNull();
  });

  it('persists the closed moment\'s projectId into the WriteDB row', () => {
    const base = withKnown(createInitialState('d1'), '/x/gnomon');
    const state = momentClose(base, windowEvent('2026-01-01T00:00:00.000Z', 'Code', 'a.ts', '/x/gnomon/src/a.ts')).state;

    const { effects } = momentClose(state, windowEvent('2026-01-01T00:05:00.000Z', 'Google Chrome'));
    expect((effects[0] as any).row.projectId).toBe('/x/gnomon');
  });

  it('is deterministic (A§1.2): replaying the same opening event from the same starting state always mints the same moment id', () => {
    const state = createInitialState('d1');
    const event = windowEvent('2026-01-01T00:00:00.000Z', 'Code');

    const first = momentClose(state, event).state;
    const second = momentClose(state, event).state;

    expect(first.moment?.id).toBe(second.moment?.id);
  });

  describe('B1: real moment segmentation', () => {
    it('appends the title instead of closing on a same-process, same-project title change', () => {
      let state = createInitialState('d1');
      state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code', 'a.ts')).state;
      const openId = state.moment?.id;

      const { state: next, effects } = momentClose(state, windowEvent('2026-01-01T00:00:05.000Z', 'Code', 'b.ts'));

      expect(effects).toEqual([]);
      expect(next.moment?.id).toBe(openId);
      expect(next.moment?.rollup.windowTitles).toEqual(['a.ts', 'b.ts']);
    });

    it('dedupes a repeated title and caps windowTitles at 50', () => {
      let state = createInitialState('d1');
      state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code', 'a.ts')).state;
      state = momentClose(state, windowEvent('2026-01-01T00:00:05.000Z', 'Code', 'a.ts')).state;
      expect(state.moment?.rollup.windowTitles).toEqual(['a.ts']);

      for (let i = 0; i < 60; i++) {
        state = momentClose(state, windowEvent(`2026-01-01T00:01:${String(i).padStart(2, '0')}.000Z`, 'Code', `f${i}.ts`)).state;
      }
      expect(state.moment?.rollup.windowTitles).toHaveLength(50);
      expect(state.moment?.rollup.windowTitles).toContain('f59.ts');
      expect(state.moment?.rollup.windowTitles).not.toContain('a.ts');
    });

    it('still closes on a project change even when the process name stays the same', () => {
      // Same editor (Code), different open file → different documentPath →
      // different resolved project → a real boundary.
      let state = withKnown(createInitialState('d1'), '/x/proj-a', '/x/proj-b');
      state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code', 'a.ts', '/x/proj-a/a.ts')).state;
      const openId = state.moment?.id;

      const { state: next, effects } = momentClose(state, windowEvent('2026-01-01T00:05:00.000Z', 'Code', 'b.ts', '/x/proj-b/b.ts'));

      expect(effects).toHaveLength(1);
      expect(next.moment?.id).not.toBe(openId);
      expect(next.moment?.projectId).toBe('/x/proj-b');
    });

    it('idle:start closes the open moment into a gap without opening a new one', () => {
      let state = createInitialState('d1');
      state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code')).state;
      state = tickThrough(state, '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z').state;

      const { state: next, effects } = momentClose(state, idleStartEvent('2026-01-01T00:10:00.000Z'));

      expect(next.moment).toBeNull();
      expect(effects).toEqual([
        expect.objectContaining({ type: 'WriteDB', table: 'moments', row: expect.objectContaining({ processName: 'Code', durationMs: 600_000 }) }),
      ]);
    });

    it('idle:start writes nothing when nothing is open', () => {
      const state = createInitialState('d1');
      const { state: next, effects } = momentClose(state, idleStartEvent('2026-01-01T00:00:00.000Z'));
      expect(next.moment).toBeNull();
      expect(effects).toEqual([]);
    });

    it('idle:end reopens a moment for the currently active window', () => {
      let state: KernelState = {
        ...createInitialState('d1'),
        window: { active: { processName: 'Code', windowTitle: 'a.ts', windowId: 'w1', documentPath: null }, previous: null, attribution: { projectId: null, source: null, confidence: null } },
      };
      // Simulate having gone idle (moment already null from a prior idle:start).
      const { state: next, effects } = momentClose(state, idleEndEvent('2026-01-01T00:15:00.000Z'));

      expect(effects).toEqual([]);
      expect(next.moment).toMatchObject({ processName: 'Code', startTime: '2026-01-01T00:15:00.000Z' });
      expect(next.moment?.rollup.windowTitles).toEqual(['a.ts']);
    });

    it('idle:end does nothing if the active window is a system process', () => {
      const state: KernelState = {
        ...createInitialState('d1'),
        window: { active: { processName: 'loginwindow', windowTitle: '', windowId: 'w1', documentPath: null }, previous: null, attribution: { projectId: null, source: null, confidence: null } },
      };
      const { state: next, effects } = momentClose(state, idleEndEvent('2026-01-01T00:15:00.000Z'));
      expect(next.moment).toBeNull();
      expect(effects).toEqual([]);
    });

    it('clock:tick splits a moment that has been open longer than the 30min cap', () => {
      let state = createInitialState('d1');
      state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code')).state;
      const openId = state.moment?.id;

      // Ticked through minute by minute: the split fires on the first tick at
      // which the moment has been open for the full 30 minutes.
      const { state: next, effects } = tickThrough(state, '2026-01-01T00:00:00.000Z', '2026-01-01T00:31:00.000Z');

      expect(effects).toEqual([
        expect.objectContaining({ type: 'WriteDB', table: 'moments', row: expect.objectContaining({ id: openId, durationMs: 30 * 60_000 }) }),
      ]);
      expect(next.moment?.id).not.toBe(openId);
      expect(next.moment).toMatchObject({ processName: 'Code', startTime: '2026-01-01T00:30:00.000Z' });
    });

    it('clock:tick writes nothing while a moment is under the 30min cap', () => {
      let state = createInitialState('d1');
      state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code')).state;
      const before = state;

      const { state: next, effects } = tickThrough(state, '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z');

      expect(effects).toEqual([]);
      void before;
      // The moment is untouched, but every event is recorded — observation
      // continuity is what the reconciliation below depends on.
      expect(next.moment?.id).toBe(state.moment?.id);
      expect(next.observation.lastObservedAt).toBe('2026-01-01T00:10:00.000Z');
    });

    /**
     * The 54%-of-all-duration defect. Ticks stop while the machine sleeps, so the
     * first tick after a suspend used to close the pre-sleep moment at "now" and
     * credit the entire sleep to it — 14 such moments held 54% of all recorded
     * duration, the longest 43.5 hours.
     */
    describe('observation-gap reconciliation', () => {
      /** Establishes a tick baseline so a following tick has a gap to measure. */
      function openWithTickBaseline(): ReturnType<typeof createInitialState> {
        let state = createInitialState('d1');
        state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code')).state;
        return momentClose(state, clockTickEvent('2026-01-01T00:01:00.000Z')).state;
      }

      it('closes an open moment at the LAST OBSERVED tick, not at now', () => {
        const state = openWithTickBaseline();
        const openId = state.moment?.id;

        // 17 hours of no ticks: the machine slept. Only the observed minute counts.
        const { effects } = momentClose(state, clockTickEvent('2026-01-01T17:01:00.000Z'));

        expect(effects).toEqual([
          expect.objectContaining({
            type: 'WriteDB',
            table: 'moments',
            row: expect.objectContaining({ id: openId, endTime: '2026-01-01T00:01:00.000Z', durationMs: 60_000 }),
          }),
        ]);
      });

      it('opens no successor, because nothing was observed to be focused', () => {
        const state = openWithTickBaseline();
        const { state: next } = momentClose(state, clockTickEvent('2026-01-01T17:01:00.000Z'));
        expect(next.moment).toBeNull();
        expect(next.observation.lastObservedAt).toBe('2026-01-01T17:01:00.000Z');
      });

      it('records the gap even when no moment was open', () => {
        let state = createInitialState('d1');
        state = momentClose(state, clockTickEvent('2026-01-01T00:00:00.000Z')).state;
        const { state: next, effects } = momentClose(state, clockTickEvent('2026-01-02T00:00:00.000Z'));
        expect(effects).toEqual([]);
        expect(next.observation.lastObservedAt).toBe('2026-01-02T00:00:00.000Z');
      });

      it('treats a merely late tick as continuous rather than a discontinuity', () => {
        const state = openWithTickBaseline();
        // 4 minutes — inside the 5-minute threshold, and under the 30min cap.
        const { state: next, effects } = momentClose(state, clockTickEvent('2026-01-01T00:05:00.000Z'));
        expect(effects).toEqual([]);
        expect(next.moment?.id).toBe(state.moment?.id);
      });

      it('does not reconcile on the very first event of a fresh daemon', () => {
        const state = createInitialState('d1');
        expect(state.observation.lastObservedAt).toBeNull();
        const { state: next, effects } = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code'));
        expect(effects).toEqual([]);
        expect(next.moment).not.toBeNull();
      });

      /**
       * The case that defeated a tick-only version of this: after a sleep, the
       * first event is usually a window change, and its own handler would close
       * the open moment at its timestamp — crediting the whole sleep to it.
       */
      it('reconciles when the first event after the gap is a window change, not a tick', () => {
        const state = openWithTickBaseline();
        const openId = state.moment?.id;

        const { state: next, effects } = momentClose(state, windowEvent('2026-01-02T09:00:00.000Z', 'Slack'));

        expect(effects).toEqual([
          expect.objectContaining({
            type: 'WriteDB',
            row: expect.objectContaining({ id: openId, endTime: '2026-01-01T00:01:00.000Z', durationMs: 60_000 }),
          }),
        ]);
        // The window change still opens its own moment against the reconciled state.
        expect(next.moment).toMatchObject({ processName: 'Slack', startTime: '2026-01-02T09:00:00.000Z' });
      });
    });

    it('drops a sub-20s moment instead of writing it, and merges its title into the successor', () => {
      let state = createInitialState('d1');
      state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code', 'flicker.ts')).state;

      const { state: next, effects } = momentClose(state, windowEvent('2026-01-01T00:00:05.000Z', 'Warp', 'shell'));

      expect(effects).toEqual([]);
      expect(next.moment).toMatchObject({ processName: 'Warp' });
      expect(next.moment?.rollup.windowTitles).toEqual(['flicker.ts', 'shell']);
    });

    it('C1: system:sleep-wake (kind=sleep) closes the open moment into a gap, same as idle:start', () => {
      let state = createInitialState('d1');
      state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Code')).state;
      state = tickThrough(state, '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z').state;

      const { state: next, effects } = momentClose(state, sleepWakeEvent('2026-01-01T00:10:00.000Z', 'sleep'));

      expect(next.moment).toBeNull();
      expect(effects).toEqual([
        expect.objectContaining({ type: 'WriteDB', table: 'moments', row: expect.objectContaining({ processName: 'Code', durationMs: 600_000 }) }),
      ]);
    });

    it('C1: system:sleep-wake (kind=wake) reopens a moment for the currently active window, same as idle:end', () => {
      const state: KernelState = {
        ...createInitialState('d1'),
        window: { active: { processName: 'Code', windowTitle: 'a.ts', windowId: 'w1', documentPath: null }, previous: null, attribution: { projectId: null, source: null, confidence: null } },
      };
      const { state: next, effects } = momentClose(state, sleepWakeEvent('2026-01-01T08:00:00.000Z', 'wake'));

      expect(effects).toEqual([]);
      expect(next.moment).toMatchObject({ processName: 'Code', startTime: '2026-01-01T08:00:00.000Z' });
    });

    it('C1: system:sleep-wake with an unrecognized kind is a no-op', () => {
      const state = createInitialState('d1');
      const event: SanitizedEvent = { id: 'e1', type: 'system:sleep-wake', ts: '2026-01-01T00:00:00.000Z', payload: { kind: 'unknown' }, sanitized: true };
      const { state: next, effects } = momentClose(state, event);
      expect(next.moment).toBe(state.moment);
      expect(effects).toEqual([]);
    });
  });


  /**
   * C09's remainder: a brief glance at another project between two stretches of
   * coding read as two context switches (47 reversals in 847 fully-attributed
   * triples). The guards matter as much as the behaviour — without them this
   * would be the ambient attribution the codebase deliberately removed.
   */
  describe('brief-excursion absorption', () => {
    /** A rollup with a given attribution, as `openNewMoment` would produce. */
    function momentWith(projectId: string | null, source: string | null, confidence: string | null, startTime: string) {
      return {
        id: `m-${startTime}`,
        sessionId: 's1',
        startTime,
        processName: 'Code',
        projectId,
        rollup: { processName: 'Code', windowTitles: [], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: source, projectConfidence: confidence, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [],
            pages: [], screenExcerpt: null, unpushedCommits: null },
        intent: { status: 'none' as const },
      } as unknown as NonNullable<KernelState['moment']>;
    }

    function closeAfter(state: KernelState, moment: NonNullable<KernelState['moment']>, endTs: string) {
      const s: KernelState = { ...state, moment, observation: { lastObservedAt: moment.startTime } };
      return momentClose(s, windowEvent(endTs, 'Slack'));
    }

    const certainSpan = { projectId: '~/p/alpha', confidence: 'certain' as const };

    it('absorbs a brief weak excursion into the surrounding certain span', () => {
      const base: KernelState = { ...createInitialState('d1'), project: { ...createInitialState('d1').project, lastClosedMoment: certainSpan } };
      const brief = momentWith('~/p/beta', 'rule-match', 'weak', '2026-01-01T00:00:00.000Z');
      const { effects } = closeAfter(base, brief, '2026-01-01T00:00:40.000Z');
      const row = (effects[0] as any).row;
      expect(row.projectId).toBe('~/p/alpha');
      expect(row.data.projectSource).toBe('span-continuation');
    });

    it('leaves a CERTAIN excursion alone — an open file is proof, not a guess', () => {
      const base: KernelState = { ...createInitialState('d1'), project: { ...createInitialState('d1').project, lastClosedMoment: certainSpan } };
      const brief = momentWith('~/p/beta', 'editor-doc', 'certain', '2026-01-01T00:00:00.000Z');
      const { effects } = closeAfter(base, brief, '2026-01-01T00:00:40.000Z');
      expect((effects[0] as any).row.projectId).toBe('~/p/beta');
    });

    it('leaves a LONG weak excursion alone — past two minutes it is a real switch', () => {
      const base: KernelState = { ...createInitialState('d1'), project: { ...createInitialState('d1').project, lastClosedMoment: certainSpan } };
      const brief = momentWith('~/p/beta', 'rule-match', 'weak', '2026-01-01T00:00:00.000Z');
      const { effects } = closeAfter(base, brief, '2026-01-01T00:03:00.000Z');
      expect((effects[0] as any).row.projectId).toBe('~/p/beta');
    });

    it('will not absorb into a span that was itself only a guess', () => {
      const weakSpan = { projectId: '~/p/alpha', confidence: 'weak' as const };
      const base: KernelState = { ...createInitialState('d1'), project: { ...createInitialState('d1').project, lastClosedMoment: weakSpan } };
      const brief = momentWith('~/p/beta', 'rule-match', 'weak', '2026-01-01T00:00:00.000Z');
      const { effects } = closeAfter(base, brief, '2026-01-01T00:00:40.000Z');
      expect((effects[0] as any).row.projectId).toBe('~/p/beta');
    });

    it('will not absorb with no preceding span at all', () => {
      const base = createInitialState('d1');
      const brief = momentWith('~/p/beta', 'rule-match', 'weak', '2026-01-01T00:00:00.000Z');
      const { effects } = closeAfter(base, brief, '2026-01-01T00:00:40.000Z');
      expect((effects[0] as any).row.projectId).toBe('~/p/beta');
    });

    it('records the written attribution for the next excursion to be judged against', () => {
      const base = createInitialState('d1');
      const m = momentWith('~/p/alpha', 'editor-doc', 'certain', '2026-01-01T00:00:00.000Z');
      const { state: next } = closeAfter(base, m, '2026-01-01T00:05:00.000Z');
      expect(next.project.lastClosedMoment).toMatchObject({ projectId: '~/p/alpha', confidence: 'certain', endedAt: '2026-01-01T00:05:00.000Z', durationMs: 300_000 });
    });

    it('forgets the preceding span across an unobserved gap', () => {
      const base: KernelState = { ...createInitialState('d1'), project: { ...createInitialState('d1').project, lastClosedMoment: certainSpan } };
      const m = momentWith('~/p/alpha', 'editor-doc', 'certain', '2026-01-01T00:00:00.000Z');
      const s: KernelState = { ...base, moment: m, observation: { lastObservedAt: '2026-01-01T00:01:00.000Z' } };
      // A 17-hour hole: what preceded it cannot vouch for what follows.
      const { state: next } = momentClose(s, clockTickEvent('2026-01-01T17:01:00.000Z'));
      expect(next.project.lastClosedMoment).toBeNull();
    });
  });
});

describe('W6 D1: activeMs never exceeds the duration', () => {
  it('on a fixture day of flicks and straddling input windows, through the whole manifest', async () => {
    const { reduce } = await import('@sundial/kernel/reduce.js');
    const { RULE_MANIFEST } = await import('./manifest.js');
    let state: KernelState = createInitialState('d1');
    const rows: { durationMs: number; data: { activeMs: number } }[] = [];
    const T0 = Date.parse('2026-09-29T08:00:03.000Z');
    const at = (s: number) => new Date(T0 + s * 1000).toISOString();
    const events: SanitizedEvent[] = [];
    // A day in miniature: Code for 95 s, a 12-s flick to Arc, Code again, a 7-s flick, Terminal.
    const switches: [number, string][] = [[0, 'Code'], [95, 'Arc'], [107, 'Code'], [300, 'Slack'], [307, 'Terminal'], [600, 'Code']];
    for (const [s, app] of switches) events.push(windowEvent(at(s), app, `${app} window`));
    // A 10-s input window every 10 s on the minute grid, each with keys: most straddle a switch.
    for (let s = 7; s <= 900; s += 10) events.push({ id: `in-${s}`, type: 'input:activity', ts: at(s), payload: { keyDownCount: 5, mouseClickCount: 1, windowMs: 10_000 }, sanitized: true });
    for (let s = 60; s <= 900; s += 60) events.push(clockTickEvent(at(s)));
    events.push(windowEvent(at(900), 'loginwindow', ''));
    events.sort((a, b) => a.ts.localeCompare(b.ts));
    for (const event of events) {
      const out = reduce(state, event, RULE_MANIFEST);
      state = out.state;
      for (const { effect } of out.effects) if (effect.type === 'WriteDB' && effect.table === 'moments') rows.push(effect.row as never);
    }
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) expect(row.data.activeMs).toBeLessThanOrEqual(row.durationMs);
    // The flicks' time went to their successors: the written moments cover the day without a gap.
    expect(rows.reduce((sum, r) => sum + r.durationMs, 0)).toBe(900_000);
    expect(rows).toHaveLength(4);
  });

  it('a merged sub-20-s predecessor carries its start (and so its duration) into the successor', () => {
    let s = createInitialState('d1');
    s = momentClose(s, windowEvent('2026-09-29T08:00:00.000Z', 'Code')).state;
    s = momentClose(s, windowEvent('2026-09-29T08:02:00.000Z', 'Arc')).state;
    s = momentClose(s, windowEvent('2026-09-29T08:02:12.000Z', 'Code')).state;
    expect(s.moment).toMatchObject({ startTime: '2026-09-29T08:02:12.000Z', carriedFrom: '2026-09-29T08:02:00.000Z' });
    // A second flick keeps the chain's first start; the drop is still judged on its own 15 s.
    s = momentClose(s, windowEvent('2026-09-29T08:02:27.000Z', 'Arc')).state;
    expect(s.moment?.carriedFrom).toBe('2026-09-29T08:02:00.000Z');
    const closed = momentClose(s, windowEvent('2026-09-29T08:03:00.000Z', 'Code'));
    const row = closed.effects.find((e) => e.type === 'WriteDB')?.row as { startTime: string; durationMs: number };
    expect(row).toMatchObject({ startTime: '2026-09-29T08:02:00.000Z', durationMs: 60_000 });
  });
});

describe('R10: the close stamps a moment that gets no intent by design', () => {
  const close = (title: string) => {
    let state = createInitialState('d1');
    state = momentClose(state, windowEvent('2026-01-01T00:00:00.000Z', 'Finder', title)).state;
    const fx = momentClose(state, windowEvent('2026-01-01T00:05:00.000Z', 'Warp')).effects[0] as unknown as { row: { data: Record<string, unknown> } };
    return fx.row.data.intentSkipped;
  };
  it('a flick (no title but the process name) and an all-blanked one are stamped; a real title is not', () => {
    expect(close('Finder')).toBe('thin');
    expect(close('[private]')).toBe('private');
    expect(close('BOX-484 review')).toBeUndefined();
    expect(noIntentReason('Code', ['', 'Code'])).toBe('thin');
    expect(noIntentReason('Code', ['[private]', 'notes.md'])).toBeNull();
  });
});
