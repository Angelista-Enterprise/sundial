import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState } from '@sundial/kernel/types.js';
import { hearingWindow } from './hearing-window.js';

const AT = '2026-09-12T09:00:00.000Z';

const event = (type: string, payload: Record<string, unknown>, ts = AT) => ({ id: 'e1', type, payload, ts }) as never;

const meeting = (over: Record<string, unknown> = {}) => ({
  title: 'Bijpraat',
  startDate: '2026-09-12T09:00:00.000Z',
  endDate: '2026-09-12T09:30:00.000Z',
  isAllDay: false,
  attendees: ['Pat Doe', 'Maarten Vermeer'],
  ...over,
});

/** The owner's opt-in: meetings and calls open the microphone by themselves. */
const auto = (): KernelState => {
  const base = createInitialState('d1');
  return { ...base, config: { ...base.config, autoHearMeetings: true } };
};

const run = (state: KernelState, ...events: ReturnType<typeof event>[]) => events.reduce((s, e) => hearingWindow(s, e).state, state);

describe('hearingWindow — the calendar', () => {
  // A day-long event with attendees held the microphone open all day.
  it('does not open the microphone, in progress or about to start', () => {
    const state = run(auto(), event('calendar:active', { event: meeting() }), event('calendar:upcoming', { events: [meeting()] }, '2026-09-12T08:58:00.000Z'));
    expect(state.hearing.listening).toBe(false);
  });

  it('a window the calendar opened before the change closes on the next tick', () => {
    const base = auto();
    const old = { ...base, hearing: { listening: true, reason: 'meeting' as const, until: '2026-09-12T19:40:00.000Z', title: 'Camp', mutedUntil: null } };
    const state = run(old, event('clock:tick', {}, AT));
    expect(state.hearing.listening).toBe(false);
  });
});

describe('hearingWindow — a call', () => {
  it('wakes when something else takes the microphone', () => {
    const state = run(auto(), event('media:state', { audioInput: true, audioInputProcess: 'Google Chrome' }));
    expect(state.hearing).toMatchObject({ listening: true, reason: 'call', until: '2026-09-12T09:02:00.000Z' });
  });

  // The latch this whole design exists to avoid: hearing wakes, the helper
  // opens the microphone, the rule reads that as a call, and it never sleeps.
  // The first guard missed it — live, the AV sensor reports the helper under the
  // BUNDLE's display name, "Sundial", not the binary's.
  it.each(['sundial-audio-helper', 'Sundial', 'gnomon-daemon', 'coreaudiod', 'FineTune'])('does not mistake %s for a call', (process) => {
    const state = run(auto(), event('media:state', { audioInput: true, audioInputProcess: process }));
    expect(state.hearing.listening).toBe(false);
  });

  it('stays asleep when the microphone is idle', () => {
    const state = run(auto(), event('media:state', { audioInput: false, audioInputProcess: null }));
    expect(state.hearing.listening).toBe(false);
  });
});

describe('hearingWindow — closing', () => {
  it('a call that goes on keeps pushing the window out', () => {
    const state = run(
      auto(),
      event('media:state', { audioInput: true, audioInputProcess: 'zoom.us' }),
      event('media:state', { audioInput: true, audioInputProcess: 'zoom.us' }, '2026-09-12T09:30:00.000Z'),
    );
    expect(state.hearing.until).toBe('2026-09-12T09:32:00.000Z');
  });

  // Nothing happening produces no events, so the close has to ride the clock.
  it('sleeps again once the window has passed', () => {
    let state = run(auto(), event('media:state', { audioInput: true, audioInputProcess: 'zoom.us' }));
    state = run(state, event('clock:tick', {}, '2026-09-12T09:01:00.000Z'));
    expect(state.hearing.listening).toBe(true);
    state = run(state, event('clock:tick', {}, '2026-09-12T09:03:00.000Z'));
    expect(state.hearing).toEqual({ listening: false, reason: null, mutedUntil: null, until: null, title: null });
  });

  it('a tick while asleep changes nothing', () => {
    const before = auto();
    const after = run(before, event('clock:tick', {}, AT));
    expect(after.hearing).toBe(before.hearing);
  });
});

describe('hearingWindow — the owner\'s own hand', () => {
  it('a manual start opens an hour and names itself', () => {
    const state = run(auto(), event('hearing:set', { listen: true }));
    expect(state.hearing.listening).toBe(true);
    expect(state.hearing.reason).toBe('manual');
    expect(state.hearing.until).toBe('2026-09-12T10:00:00.000Z');
  });

  it('a manual start can ask for a length, capped at four hours', () => {
    const short = run(auto(), event('hearing:set', { listen: true, minutes: 15 }));
    expect(short.hearing.until).toBe('2026-09-12T09:15:00.000Z');
    const greedy = run(auto(), event('hearing:set', { listen: true, minutes: 600 }));
    expect(greedy.hearing.until).toBe('2026-09-12T13:00:00.000Z');
  });

  // The whole point of the mute. Without it the next sample of the call a few
  // seconds later reopens the window and the button reads as broken.
  it('a manual stop is not undone by the call that is still on', () => {
    let state = run(auto(), event('media:state', { audioInput: true, audioInputProcess: 'zoom.us' }));
    expect(state.hearing.listening).toBe(true);
    state = run(state, event('hearing:set', { listen: false }, '2026-09-12T09:01:00.000Z'));
    expect(state.hearing.listening).toBe(false);
    state = run(state, event('media:state', { audioInput: true, audioInputProcess: 'zoom.us' }, '2026-09-12T09:02:00.000Z'));
    expect(state.hearing.listening).toBe(false);
  });

  it('the owner can start again inside their own mute', () => {
    let state = run(auto(), event('hearing:set', { listen: false }));
    state = run(state, event('hearing:set', { listen: true }, '2026-09-12T09:05:00.000Z'));
    expect(state.hearing.listening).toBe(true);
    expect(state.hearing.mutedUntil).toBeNull();
  });

  it('the mute runs out on the clock, and a call wakes it again', () => {
    let state = run(auto(), event('hearing:set', { listen: false }));
    state = run(state, event('clock:tick', {}, '2026-09-12T10:01:00.000Z'));
    expect(state.hearing.mutedUntil).toBeNull();
    state = run(state, event('media:state', { audioInput: true, audioInputProcess: 'zoom.us' }, '2026-09-12T10:02:00.000Z'));
    expect(state.hearing.listening).toBe(true);
  });

  // A call landing inside a window the owner opened should not rename it: the
  // strip is telling them THEY asked for this, and that stays true.
  it('a call inside a manual window does not rename it', () => {
    let state = run(auto(), event('hearing:set', { listen: true }));
    state = run(state, event('media:state', { audioInput: true, audioInputProcess: 'zoom.us' }, '2026-09-12T09:05:00.000Z'));
    expect(state.hearing.reason).toBe('manual');
  });
});

describe('hearingWindow — audio.autoMeetings off (the default)', () => {
  it('a call does not open the microphone by itself', () => {
    const state = run(createInitialState('d1'), event('media:state', { audioInput: true, audioInputProcess: 'Google Chrome' }));
    expect(state.hearing.listening).toBe(false);
  });

  it('the owner pressing Listen still opens it', () => {
    const state = run(createInitialState('d1'), event('hearing:set', { listen: true }));
    expect(state.hearing).toMatchObject({ listening: true, reason: 'manual' });
  });
});
