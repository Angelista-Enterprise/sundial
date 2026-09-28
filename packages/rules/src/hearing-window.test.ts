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

const run = (state: KernelState, ...events: ReturnType<typeof event>[]) => events.reduce((s, e) => hearingWindow(s, e).state, state);

describe('hearingWindow — a meeting in progress', () => {
  it('wakes, names the window, and stays open past the scheduled end', () => {
    const state = run(createInitialState('d1'), event('calendar:active', { event: meeting() }));
    expect(state.hearing.listening).toBe(true);
    expect(state.hearing.reason).toBe('meeting');
    expect(state.hearing.title).toBe('Bijpraat');
    // Meetings overrun; a calendar end is a plan, not an observation.
    expect(state.hearing.until).toBe('2026-09-12T09:40:00.000Z');
  });

  it('ignores an all-day block with nobody in it', () => {
    const state = run(createInitialState('d1'), event('calendar:active', { event: meeting({ isAllDay: true, attendees: [] }) }));
    expect(state.hearing.listening).toBe(false);
  });
});

describe('hearingWindow — a meeting about to start', () => {
  it('wakes a few minutes early, because people join before the hour', () => {
    const soon = run(createInitialState('d1'), event('calendar:upcoming', { events: [meeting()] }, '2026-09-12T08:58:00.000Z'));
    expect(soon.hearing.listening).toBe(true);
    expect(soon.hearing.reason).toBe('meeting-soon');
    expect(soon.hearing.title).toBe('Bijpraat');
  });

  it('stays asleep for a meeting that is still hours away', () => {
    const later = run(createInitialState('d1'), event('calendar:upcoming', { events: [meeting()] }, '2026-09-12T06:00:00.000Z'));
    expect(later.hearing.listening).toBe(false);
  });

  it('ignores one that already finished', () => {
    const past = run(createInitialState('d1'), event('calendar:upcoming', { events: [meeting()] }, '2026-09-12T11:00:00.000Z'));
    expect(past.hearing.listening).toBe(false);
  });
});

describe('hearingWindow — a call', () => {
  it('wakes when something else takes the microphone', () => {
    const state = run(createInitialState('d1'), event('media:state', { audioInput: true, audioInputProcess: 'Google Chrome' }));
    expect(state.hearing).toMatchObject({ listening: true, reason: 'call', until: '2026-09-12T09:02:00.000Z' });
  });

  // The latch this whole design exists to avoid: hearing wakes, the helper
  // opens the microphone, the rule reads that as a call, and it never sleeps.
  // The first guard missed it — live, the AV sensor reports the helper under the
  // BUNDLE's display name, "Sundial", not the binary's.
  it.each(['sundial-audio-helper', 'Sundial', 'gnomon-daemon', 'coreaudiod'])('does not mistake %s for a call', (process) => {
    const state = run(createInitialState('d1'), event('media:state', { audioInput: true, audioInputProcess: process }));
    expect(state.hearing.listening).toBe(false);
  });

  it('stays asleep when the microphone is idle', () => {
    const state = run(createInitialState('d1'), event('media:state', { audioInput: false, audioInputProcess: null }));
    expect(state.hearing.listening).toBe(false);
  });
});

describe('hearingWindow — overlap and closing', () => {
  it('lets a call inside a meeting extend the window without renaming it', () => {
    const state = run(
      createInitialState('d1'),
      event('calendar:active', { event: meeting() }),
      event('media:state', { audioInput: true, audioInputProcess: 'zoom.us' }, '2026-09-12T09:35:00.000Z'),
    );
    // The meeting keeps the name the transcript files under…
    expect(state.hearing.reason).toBe('meeting');
    expect(state.hearing.title).toBe('Bijpraat');
    // …and the furthest reach wins, so neither cuts the other short.
    expect(state.hearing.until).toBe('2026-09-12T09:40:00.000Z');
  });

  it('a call running past the meeting pushes the window out', () => {
    const state = run(
      createInitialState('d1'),
      event('calendar:active', { event: meeting() }),
      event('media:state', { audioInput: true, audioInputProcess: 'zoom.us' }, '2026-09-12T09:39:00.000Z'),
    );
    expect(state.hearing.until).toBe('2026-09-12T09:41:00.000Z');
  });

  // Nothing happening produces no events, so the close has to ride the clock.
  it('sleeps again once the window has passed', () => {
    let state = run(createInitialState('d1'), event('calendar:active', { event: meeting() }));
    state = run(state, event('clock:tick', {}, '2026-09-12T09:39:00.000Z'));
    expect(state.hearing.listening).toBe(true);
    state = run(state, event('clock:tick', {}, '2026-09-12T09:41:00.000Z'));
    expect(state.hearing).toEqual({ listening: false, reason: null, mutedUntil: null, until: null, title: null });
  });

  it('a tick while asleep changes nothing', () => {
    const before = createInitialState('d1');
    const after = run(before, event('clock:tick', {}, AT));
    expect(after.hearing).toBe(before.hearing);
  });
});

describe('hearingWindow — the owner\'s own hand', () => {
  it('a manual start opens an hour and names itself', () => {
    const state = run(createInitialState('d1'), event('hearing:set', { listen: true }));
    expect(state.hearing.listening).toBe(true);
    expect(state.hearing.reason).toBe('manual');
    expect(state.hearing.until).toBe('2026-09-12T10:00:00.000Z');
  });

  it('a manual start can ask for a length, capped at four hours', () => {
    const short = run(createInitialState('d1'), event('hearing:set', { listen: true, minutes: 15 }));
    expect(short.hearing.until).toBe('2026-09-12T09:15:00.000Z');
    const greedy = run(createInitialState('d1'), event('hearing:set', { listen: true, minutes: 600 }));
    expect(greedy.hearing.until).toBe('2026-09-12T13:00:00.000Z');
  });

  // The whole point of the mute. Without it the calendar poll a few seconds
  // later reopens the window and the button reads as broken.
  it('a manual stop is not undone by the meeting that is still on', () => {
    let state = run(createInitialState('d1'), event('calendar:active', { event: meeting() }));
    expect(state.hearing.listening).toBe(true);
    state = run(state, event('hearing:set', { listen: false }, '2026-09-12T09:10:00.000Z'));
    expect(state.hearing.listening).toBe(false);
    state = run(
      state,
      event('calendar:active', { event: meeting() }, '2026-09-12T09:11:00.000Z'),
      event('media:state', { audioInput: true, audioInputProcess: 'zoom.us' }, '2026-09-12T09:12:00.000Z'),
    );
    expect(state.hearing.listening).toBe(false);
  });

  it('the owner can start again inside their own mute', () => {
    let state = run(createInitialState('d1'), event('hearing:set', { listen: false }));
    state = run(state, event('hearing:set', { listen: true }, '2026-09-12T09:05:00.000Z'));
    expect(state.hearing.listening).toBe(true);
    expect(state.hearing.mutedUntil).toBeNull();
  });

  it('the mute runs out on the clock, and a meeting wakes it again', () => {
    let state = run(createInitialState('d1'), event('hearing:set', { listen: false }));
    state = run(state, event('clock:tick', {}, '2026-09-12T10:01:00.000Z'));
    expect(state.hearing.mutedUntil).toBeNull();
    state = run(state, event('calendar:active', { event: meeting({ endDate: '2026-09-12T10:30:00.000Z' }) }, '2026-09-12T10:02:00.000Z'));
    expect(state.hearing.listening).toBe(true);
  });

  // A call landing inside a window the owner opened should not rename it: the
  // strip is telling them THEY asked for this, and that stays true.
  it('a call inside a manual window does not rename it', () => {
    let state = run(createInitialState('d1'), event('hearing:set', { listen: true }));
    state = run(state, event('media:state', { audioInput: true, audioInputProcess: 'zoom.us' }, '2026-09-12T09:05:00.000Z'));
    expect(state.hearing.reason).toBe('manual');
  });
});
