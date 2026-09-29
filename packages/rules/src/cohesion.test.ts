// The seams between features added 2026-09-05: each test pins ONE way a slice
// written by one rule changes what another rule or read path does.
import { describe, it, expect } from 'vitest';
import { createInitialState, defaultMomentRollupExtras } from '@sundial/kernel/initial-state.js';
import type { MomentRollup, SanitizedEvent } from '@sundial/kernel/types.js';
import { attendedMs, computeFocusScore } from './focus-score.js';
import { interruptionCostOf } from './notice-gate.js';
import { meetingFollowup, CALL_FOLLOWUP_MIN_MS } from './meeting-followup.js';
import { hotFilesFor } from './workbench.js';
import { momentRollup } from './moment-rollup.js';

const rollup = (over: Partial<MomentRollup> = {}): MomentRollup => ({ processName: 'Code', windowTitles: [], ...defaultMomentRollupExtras, ...over });

describe('attention over presence', () => {
  it('attendedMs is the input-covered span when the moment recorded input, wall time when it never did', () => {
    const hour = 3_600_000;
    expect(attendedMs(rollup({ inputEventCount: 40, activeMs: 12 * 60_000 }), hour)).toBe(12 * 60_000);
    expect(attendedMs(rollup({ inputEventCount: 0, activeMs: 0 }), hour)).toBe(hour);
    // Never more than the wall (a carried-over rollup can outrun a short close).
    expect(attendedMs(rollup({ inputEventCount: 5, activeMs: 2 * hour }), hour)).toBe(hour);
  });

  it('a window left open for an hour with three minutes of typing is not an hour of focus', () => {
    const hour = 3_600_000;
    const idle = computeFocusScore(rollup({ inputEventCount: 6, activeMs: 3 * 60_000, typingEventCount: 1 }), hour);
    const busy = computeFocusScore(rollup({ inputEventCount: 900, activeMs: 55 * 60_000, typingEventCount: 1 }), hour);
    expect(busy).toBeGreaterThan(idle);
  });
});

describe('a call is the worst time to interrupt, whatever the moment thinks', () => {
  it('interruptionCostOf saturates while callSpanTrack holds a call open', () => {
    const state = createInitialState('d');
    expect(interruptionCostOf(state)).toBe(0);
    const onCall = { ...state, av: { ...state.av, call: { app: 'WhatsApp', kind: 'personal-call' as const, since: '2026-09-05T09:00:00.000Z', cameraEver: false } } };
    expect(interruptionCostOf(onCall)).toBe(1);
  });
});

describe('an ad-hoc work call gets a follow-up question', () => {
  const tick = (ts: string): SanitizedEvent => ({ id: `t-${ts}`, type: 'clock:tick', ts, payload: {}, sanitized: true });

  it('asks after a ten-minute browser call the calendar never had, but not after a personal call', () => {
    let state = createInitialState('d');
    state = { ...state, av: { call: null, lastCall: { app: 'Google Chrome', kind: 'work-call', since: '2026-09-05T09:00:00.000Z', until: '2026-09-05T09:15:00.000Z', cameraEver: true } } };
    const { state: seen } = meetingFollowup(state, tick('2026-09-05T09:15:30.000Z'));
    expect(Object.keys(seen.meetings.seen)).toEqual(['call|2026-09-05T09:00:00.000Z']);
    // UC1-X3: the call's promise pass was asked for on the first tick; the question waits for it, eight minutes at most.
    expect(meetingFollowup(seen, tick('2026-09-05T09:18:00.000Z')).effects).toEqual([]);
    const { effects } = meetingFollowup(seen, tick('2026-09-05T09:24:00.000Z'));
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: 'EmitEvent', event: { type: 'ask:owner-opened', payload: { question: 'How did the call in Google Chrome go? Who was it with — and did you promise anything?' } } });

    const personal = { ...createInitialState('d'), av: { call: null, lastCall: { app: 'WhatsApp', kind: 'personal-call' as const, since: '2026-09-05T09:00:00.000Z', until: '2026-09-05T09:30:00.000Z', cameraEver: false } } };
    expect(Object.keys(meetingFollowup(personal, tick('2026-09-05T09:31:00.000Z')).state.meetings.seen)).toEqual([]);
  });

  it('a short call is a quick sync, not a debrief', () => {
    const until = new Date(Date.parse('2026-09-05T09:00:00.000Z') + CALL_FOLLOWUP_MIN_MS - 1000).toISOString();
    const state = { ...createInitialState('d'), av: { call: null, lastCall: { app: 'zoom.us', kind: 'work-call' as const, since: '2026-09-05T09:00:00.000Z', until, cameraEver: false } } };
    expect(Object.keys(meetingFollowup(state, tick('2026-09-05T09:12:00.000Z')).state.meetings.seen)).toEqual([]);
  });
});

describe('a handoff note knows where the work was', () => {
  it('hotFilesFor names the most-touched files of the thread\'s project, by root basename', () => {
    const state = createInitialState('d');
    state.files.hot = {
      '~/Projects/sundial|src/a.ts': { projectRoot: '~/Projects/sundial', relPath: 'src/a.ts', changes: 9, focusedChanges: 5, firstAt: 'x', lastAt: 'y' },
      '~/Projects/sundial|src/b.ts': { projectRoot: '~/Projects/sundial', relPath: 'src/b.ts', changes: 2, focusedChanges: 1, firstAt: 'x', lastAt: 'y' },
      '~/Projects/other|c.ts': { projectRoot: '~/Projects/other', relPath: 'c.ts', changes: 20, focusedChanges: 20, firstAt: 'x', lastAt: 'y' },
    };
    expect(hotFilesFor(state, 'Sundial')).toEqual(['src/a.ts (9×)', 'src/b.ts (2×)']);
    expect(hotFilesFor(state, null)).toEqual([]);
  });
});

describe('what the owner read rides with the moment', () => {
  it('browser:tab pages land on the rollup, deduped and bounded', () => {
    let state = createInitialState('d');
    state = { ...state, moment: { id: 'm', startTime: '2026-09-05T09:00:00.000Z', processName: 'Google Chrome', rollup: rollup({ processName: 'Google Chrome' }) } as never };
    const tab = (host: string, path: string): SanitizedEvent => ({ id: `b-${host}${path}`, type: 'browser:tab', ts: '2026-09-05T09:01:00.000Z', payload: { host, path, app: 'Google Chrome', url: `https://${host}${path}`, title: null }, sanitized: true });
    state = momentRollup(state, tab('github.com', '/acme/puzzles/pull/689')).state;
    state = momentRollup(state, tab('github.com', '/acme/puzzles/pull/689')).state;
    state = momentRollup(state, tab('developer.apple.com', '/')).state;
    expect(state.moment?.rollup.pages).toEqual(['github.com/acme/puzzles/pull/689', 'developer.apple.com']);
  });
});
