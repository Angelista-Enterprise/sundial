import { describe, it, expect } from 'vitest';
import { classifyCalendarPoll, createCalendarClassifyState } from './index.js';
import type { CalendarEvent, CalendarOutput } from './calendar-capture.js';

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    eventId: 'e1',
    title: 'Standup',
    startDate: '2026-01-01T10:00:00.000Z',
    endDate: '2026-01-01T10:30:00.000Z',
    attendees: [],
    isRecurring: false,
    calendar: 'Work',
    isAllDay: false,
    ...overrides,
  };
}

function output(events: CalendarEvent[]): CalendarOutput {
  return { events, timestamp: '2026-01-01T10:15:00.000Z', accessGranted: true };
}

describe('classifyCalendarPoll', () => {
  it('emits calendar:upcoming on the first poll', () => {
    const state = createCalendarClassifyState();
    const events = classifyCalendarPoll(output([event()]), state, new Date('2026-01-01T09:00:00.000Z'));

    expect(events.map((e) => e.type)).toContain('calendar:upcoming');
  });

  it('does not re-emit calendar:upcoming when the event list is unchanged', () => {
    const state = createCalendarClassifyState();
    classifyCalendarPoll(output([event()]), state, new Date('2026-01-01T09:00:00.000Z'));

    const events = classifyCalendarPoll(output([event()]), state, new Date('2026-01-01T09:00:01.000Z'));

    expect(events.map((e) => e.type)).not.toContain('calendar:upcoming');
  });

  it('emits calendar:active for an event containing now, once, not every poll while it stays active', () => {
    const state = createCalendarClassifyState();
    const now = new Date('2026-01-01T10:15:00.000Z'); // inside [10:00, 10:30]

    const first = classifyCalendarPoll(output([event()]), state, now);
    expect(first.map((e) => e.type)).toContain('calendar:active');

    const second = classifyCalendarPoll(output([event()]), state, now);
    expect(second.map((e) => e.type)).not.toContain('calendar:active');
  });

  it('does not emit calendar:active for an all-day event', () => {
    const state = createCalendarClassifyState();
    const now = new Date('2026-01-01T10:15:00.000Z');

    const events = classifyCalendarPoll(output([event({ isAllDay: true })]), state, now);

    expect(events.map((e) => e.type)).not.toContain('calendar:active');
  });

  it('emits calendar:context-event for an all-day event, and does not re-emit within the 1h dedup window', () => {
    const state = createCalendarClassifyState();
    const now = new Date('2026-01-01T09:00:00.000Z');

    const first = classifyCalendarPoll(output([event({ isAllDay: true })]), state, now);
    expect(first.map((e) => e.type)).toContain('calendar:context-event');

    const second = classifyCalendarPoll(output([event({ isAllDay: true })]), state, new Date(now.getTime() + 60_000));
    expect(second.map((e) => e.type)).not.toContain('calendar:context-event');
  });

  it('emits calendar:context-event for a non-self-attendee meeting', () => {
    const state = createCalendarClassifyState();
    const events = classifyCalendarPoll(output([event({ isSelfAttendee: false })]), state, new Date('2026-01-01T09:00:00.000Z'));

    const contextEvent = events.find((e) => e.type === 'calendar:context-event');
    expect(contextEvent?.payload.reason).toBe('not-self-attendee');
  });
});
