import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { scheduleTrack } from './schedule-track.js';

function upcoming(ts: string, events: unknown[]): SanitizedEvent {
  return { id: 'u1', type: 'calendar:upcoming', ts, payload: { timestamp: ts, events }, sanitized: true };
}
const ev = (o: Record<string, unknown>) => ({
  eventId: 'x',
  title: 'Standup',
  startDate: '2026-07-18T10:00:00.000Z',
  endDate: '2026-07-18T10:30:00.000Z',
  attendees: [],
  isAllDay: false,
  ...o,
});

describe('scheduleTrack', () => {
  it('folds upcoming events into state.schedule, sorted by start', () => {
    const now = '2026-07-18T09:00:00.000Z';
    const { state: next } = scheduleTrack(
      createInitialState('d1'),
      upcoming(now, [
        ev({ title: 'Later', startDate: '2026-07-18T14:00:00.000Z', endDate: '2026-07-18T15:00:00.000Z' }),
        ev({ title: 'Sooner', startDate: '2026-07-18T10:00:00.000Z', endDate: '2026-07-18T10:30:00.000Z' }),
      ]),
    );
    expect(next.schedule.upcoming.map((e) => e.title)).toEqual(['Sooner', 'Later']);
    expect(next.schedule.updatedAt).toBe(now);
    expect(next.schedule.upcoming[0]).toMatchObject({ start: '2026-07-18T10:00:00.000Z', end: '2026-07-18T10:30:00.000Z', isAllDay: false });
  });

  it('drops events that already ended', () => {
    const now = '2026-07-18T12:00:00.000Z';
    const { state: next } = scheduleTrack(
      createInitialState('d1'),
      upcoming(now, [
        ev({ title: 'Past', startDate: '2026-07-18T09:00:00.000Z', endDate: '2026-07-18T09:30:00.000Z' }),
        ev({ title: 'Future', startDate: '2026-07-18T13:00:00.000Z', endDate: '2026-07-18T14:00:00.000Z' }),
      ]),
    );
    expect(next.schedule.upcoming.map((e) => e.title)).toEqual(['Future']);
  });

  it('replaces the list wholesale on each emit', () => {
    let s = scheduleTrack(createInitialState('d1'), upcoming('2026-07-18T09:00:00.000Z', [ev({ title: 'A' })])).state;
    s = scheduleTrack(s, upcoming('2026-07-18T09:05:00.000Z', [ev({ title: 'B', startDate: '2026-07-18T11:00:00.000Z', endDate: '2026-07-18T11:30:00.000Z' })])).state;
    expect(s.schedule.upcoming.map((e) => e.title)).toEqual(['B']);
  });

  it('caps to 10 events', () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      ev({ title: `E${i}`, startDate: `2026-07-18T10:${String(i * 3).padStart(2, '0')}:00.000Z`, endDate: '2026-07-18T23:00:00.000Z' }),
    );
    const { state: next } = scheduleTrack(createInitialState('d1'), upcoming('2026-07-18T09:00:00.000Z', many));
    expect(next.schedule.upcoming).toHaveLength(10);
  });

  it('ignores malformed / non-array payloads', () => {
    const state = createInitialState('d1');
    const bad: SanitizedEvent = { id: 'u', type: 'calendar:upcoming', ts: '2026-07-18T09:00:00.000Z', payload: { events: 'nope' }, sanitized: true };
    expect(scheduleTrack(state, bad).state).toBe(state);
  });

  it('ignores non-calendar:upcoming events', () => {
    const state = createInitialState('d1');
    const e: SanitizedEvent = { id: 'e', type: 'calendar:active', ts: '2026-07-18T10:00:00.000Z', payload: {}, sanitized: true };
    expect(scheduleTrack(state, e).state).toBe(state);
  });
});

describe('the meeting in progress', () => {
  const active = (title: string, end: string, ts: string): SanitizedEvent => ({
    id: `a-${ts}`,
    type: 'calendar:active',
    ts,
    payload: { event: { title, startDate: '2026-09-07T09:00:00.000Z', endDate: end } },
    sanitized: true,
  });
  const tick = (ts: string): SanitizedEvent => ({ id: `t-${ts}`, type: 'clock:tick', ts, payload: {}, sanitized: true });

  it('holds the running meeting on the schedule slice, which survives moment boundaries', () => {
    // It was read off `state.moment.rollup` first, and `momentClose` folds
    // before `windowTrack` — so on the very window change that enters a call the
    // title was blank and a `meetingContains` rule matched nothing all call.
    const { state } = scheduleTrack(createInitialState('d1'), active('RRA: Kruiswoorden testen', '2026-09-07T10:00:00.000Z', '2026-09-07T09:05:00.000Z'));
    expect(state.schedule.active).toEqual({ title: 'RRA: Kruiswoorden testen', start: '2026-09-07T09:00:00.000Z', end: '2026-09-07T10:00:00.000Z' });
  });

  it('clears it once the meeting has ended, on a tick — the sensor goes quiet between meetings', () => {
    const { state: running } = scheduleTrack(createInitialState('d1'), active('Standup', '2026-09-07T10:00:00.000Z', '2026-09-07T09:05:00.000Z'));
    expect(scheduleTrack(running, tick('2026-09-07T09:59:00.000Z')).state.schedule.active).not.toBeNull();
    expect(scheduleTrack(running, tick('2026-09-07T10:01:00.000Z')).state.schedule.active).toBeNull();
  });

  it('ignores an event with no title, and does not churn state for the same meeting', () => {
    const base = createInitialState('d1');
    expect(scheduleTrack(base, active('  ', '2026-09-07T10:00:00.000Z', '2026-09-07T09:05:00.000Z')).state).toBe(base);
    const { state: running } = scheduleTrack(base, active('Standup', '2026-09-07T10:00:00.000Z', '2026-09-07T09:05:00.000Z'));
    expect(scheduleTrack(running, active('Standup', '2026-09-07T10:00:00.000Z', '2026-09-07T09:20:00.000Z')).state).toBe(running);
  });
});
