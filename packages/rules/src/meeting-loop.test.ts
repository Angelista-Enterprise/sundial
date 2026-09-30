import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { askLoop } from '@sundial/helpers/loops.js';
import type { KernelState, OpenLoop, SanitizedEvent } from '@sundial/kernel/types.js';
import { meetingFollowup, FOLLOWUP_MIN_AFTER_MS, FOLLOWUP_MAX_AFTER_MS } from './meeting-followup.js';
import { goalCheckin, openGoals } from './goal-checkin.js';

const T0 = Date.parse('2026-09-04T13:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
let seq = 0;
const tick = (ms: number): SanitizedEvent => ({ id: `t${++seq}`, type: 'clock:tick', ts: at(ms), payload: {}, sanitized: true });

function withMeeting(state: KernelState, attendees: string[], startMs = -60 * 60_000, endMs = -5 * 60_000): KernelState {
  state.config.ownerAliases = ['pat'];
  state.schedule.upcoming.push({ title: 'Sanity certification', start: at(startMs), end: at(endMs), attendees, isAllDay: false });
  return state;
}

describe('meetingFollowup', () => {
  it('asks once, a few minutes after a meeting with other people ended, and never again for the same meeting', () => {
    let state = withMeeting(createInitialState('d'), ['pat', 'Bob', 'Noah']);
    // Seen while still upcoming.
    let out = meetingFollowup(state, tick(-30 * 60_000));
    state = out.state;
    expect(Object.values(state.meetings.seen)).toHaveLength(1);
    expect(out.effects).toEqual([]);

    // Calendar poll dropped it; the rule still remembers.
    state.schedule.upcoming = [];
    out = meetingFollowup(state, tick(0));
    state = out.state;
    expect(out.effects).toHaveLength(1);
    expect(out.effects[0]).toMatchObject({
      type: 'EmitEvent',
      event: { type: 'ask:owner-opened', payload: { question: 'How did "Sanity certification" go — did you promise anything?', reason: expect.stringContaining('Bob, Noah'), choices: ['No', 'Yes — tell me'] } },
    });
    expect(Object.values(state.meetings.seen)[0].askedAt).toBe(at(0));

    expect(meetingFollowup(state, tick(60_000)).effects).toEqual([]);
  });

  it('a meeting alone, an all-day one, or one that ended long ago is not asked about; an open question waits', () => {
    const solo = withMeeting(createInitialState('d'), ['pat']);
    expect(Object.keys(meetingFollowup(solo, tick(0)).state.meetings.seen)).toHaveLength(0);

    const old = withMeeting(createInitialState('d'), ['Bob'], -3 * 60 * 60_000, -(FOLLOWUP_MAX_AFTER_MS + 60_000));
    expect(meetingFollowup(old, tick(0)).effects).toEqual([]);

    const tooSoon = withMeeting(createInitialState('d'), ['Bob'], -60 * 60_000, -(FOLLOWUP_MIN_AFTER_MS - 1000));
    expect(meetingFollowup(tooSoon, tick(0)).effects).toEqual([]);

    const busy = withMeeting(createInitialState('d'), ['Bob']);
    busy.loops.open.push(askLoop({ askId: 'x', question: 'q', reason: '', choices: [], ts: at(-1000) }) as OpenLoop);
    expect(meetingFollowup(busy, tick(0)).effects).toEqual([]);
  });

  it('does not ask about a meeting hearing was awake for and heard almost nothing of — the owner was elsewhere', () => {
    const heard = (ms: number): SanitizedEvent => ({ id: `a${++seq}`, type: 'audio:transcript', ts: at(ms), payload: { spokenText: 'ja' }, sanitized: true });
    const run = (utterances: number, listening: boolean) => {
      let state = withMeeting(createInitialState('d'), ['Bob']); // 55 minutes
      state = meetingFollowup(state, tick(-70 * 60_000)).state;
      state = { ...state, hearing: { ...state.hearing, listening } };
      state = meetingFollowup(state, tick(-50 * 60_000)).state;
      for (let i = 0; i < utterances; i += 1) state = meetingFollowup(state, heard(-40 * 60_000 + i)).state;
      state = { ...state, hearing: { ...state.hearing, listening: false } };
      // UC1-X3: the question waits up to eight minutes for the meeting's promise pass.
      const first = meetingFollowup(state, tick(0));
      return [...first.effects, ...meetingFollowup(first.state, tick(9 * 60_000)).effects].filter((e) => e.type === 'EmitEvent').length;
    };
    expect(run(16, true), 'the skipped standup: 16 utterances').toBe(0);
    expect(run(96, true), 'an attended one').toBe(1);
    expect(run(1, true), 'the skipped Crrntlive: one stray utterance').toBe(0);
    expect(run(0, false), 'hearing asleep: silence says nothing, so ask').toBe(1);
    expect(run(0, true), 'awake but nothing at all: the transcriber may be down, so ask').toBe(1);
  });

  it('counts only the microphone as the owner being there — the far side of a call is heard in an empty room too', () => {
    let state = withMeeting(createInitialState('d'), ['Bob']);
    state = meetingFollowup(state, tick(-70 * 60_000)).state;
    state = { ...state, hearing: { ...state.hearing, listening: true } };
    state = meetingFollowup(state, tick(-50 * 60_000)).state;
    for (let i = 0; i < 200; i += 1) state = meetingFollowup(state, { id: `s${++seq}`, type: 'audio:transcript', ts: at(-40 * 60_000 + i), payload: { spokenText: 'the far side', channel: 'system' }, sanitized: true }).state;
    state = meetingFollowup(state, { id: `m${++seq}`, type: 'audio:transcript', ts: at(-30 * 60_000), payload: { spokenText: 'ja', channel: 'mic' }, sanitized: true }).state;
    expect(Object.values(state.meetings.seen)[0]!.heard).toBe(1);
    // No question for a room the owner was not in; the promise pass still reads what the far side said (W6 P2).
    expect(meetingFollowup(state, tick(0)).effects.map((e) => e.type)).toEqual(['RunMeetingPromises']);
  });

  it('forgets meetings older than two days', () => {
    const state = withMeeting(createInitialState('d'), ['Bob'], -3 * 24 * 60 * 60_000, -3 * 24 * 60 * 60_000 + 60_000);
    const seen = meetingFollowup(state, tick(-3 * 24 * 60 * 60_000 + 30_000)).state;
    expect(Object.keys(seen.meetings.seen)).toHaveLength(1);
    expect(Object.keys(meetingFollowup(seen, tick(0)).state.meetings.seen)).toHaveLength(0);
  });
});

describe('goalCheckin', () => {
  const boundary = (iso: string): SanitizedEvent => ({ id: `b${++seq}`, type: 'day:boundary', ts: iso, payload: {}, sanitized: true });

  function withGoals(state: KernelState): KernelState {
    state.config.timezone = 'Europe/Amsterdam';
    state.memory.factCursor['goal:ship-gnomon-v1:status'] = { object: 'open', factId: 'f1', confidence: 90, pendingObject: null, pendingCount: 0, projectId: null } as never;
    state.memory.factCursor['goal:run-a-marathon:status'] = { object: 'paused', factId: 'f2', confidence: 90, pendingObject: null, pendingCount: 0, projectId: null } as never;
    state.memory.factCursor['goal:learn-rust:status'] = { object: 'done', factId: 'f3', confidence: 90, pendingObject: null, pendingCount: 0, projectId: null } as never;
    state.memory.factCursor['goal:ship-gnomon-v1:targetDate'] = { object: '2026-10-01', factId: 'f4', confidence: 90, pendingObject: null, pendingCount: 0, projectId: null } as never;
    return state;
  }

  it('reads open goals off the fold\'s own belief, skipping closed ones', () => {
    expect(openGoals(withGoals(createInitialState('d')).memory.factCursor)).toEqual([
      { entityId: 'goal:run-a-marathon', name: 'run a marathon', status: 'paused' },
      { entityId: 'goal:ship-gnomon-v1', name: 'ship gnomon v1', status: 'open' },
    ]);
  });

  it('asks on the boundary into Monday (owner local time) and on no other day', () => {
    const state = withGoals(createInitialState('d'));
    // 2026-09-06T22:00Z is Monday 2026-09-07 00:00 in Amsterdam.
    const monday = goalCheckin(state, boundary('2026-09-06T22:00:00.000Z'));
    expect(monday.effects).toHaveLength(1);
    expect(monday.effects[0]).toMatchObject({ event: { type: 'ask:owner-opened', payload: { question: expect.stringContaining('run a marathon (no time seen); ship gnomon v1 (no time seen)'), choices: ['run a marathon', 'ship gnomon v1'] } } });
    expect(goalCheckin(state, boundary('2026-09-07T22:00:00.000Z')).effects).toEqual([]);
  });

  it('stays quiet with no goals or with a question already open', () => {
    expect(goalCheckin(createInitialState('d'), boundary('2026-09-06T22:00:00.000Z')).effects).toEqual([]);
    const busy = withGoals(createInitialState('d'));
    busy.loops.open.push(askLoop({ askId: 'x', question: 'q', reason: '', choices: [], ts: '2026-09-06T21:00:00.000Z' }) as OpenLoop);
    expect(goalCheckin(busy, boundary('2026-09-06T22:00:00.000Z')).effects).toEqual([]);
  });
});
