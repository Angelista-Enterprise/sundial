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

describe('the week ahead (UC1-X1)', () => {
  it('lists a week of events, but a context event is still only the next day\'s', async () => {
    const { classifyCalendarPoll, createCalendarClassifyState } = await import('./index.js');
    const now = new Date('2026-09-29T08:00:00.000Z');
    const ev = (id: string, startDate: string) => ({ eventId: id, title: id, startDate, endDate: startDate, attendees: [], isRecurring: false, calendar: 'c', isAllDay: true });
    const out = classifyCalendarPoll({ events: [ev('soon', '2026-09-29T12:00:00.000Z'), ev('later', '2026-10-03T12:00:00.000Z')], timestamp: now.toISOString(), accessGranted: true }, createCalendarClassifyState(), now);
    expect(out.find((e) => e.type === 'calendar:upcoming')?.payload.events).toHaveLength(2);
    expect(out.filter((e) => e.type === 'calendar:context-event').map((e) => (e.payload.event as { eventId: string }).eventId)).toEqual(['soon']);
  });
});

describe('reminders, as one event when the list changed (UC1)', () => {
  it('emits the list with the title as text, and nothing when it did not change', async () => {
    const { remindersEvent } = await import('./index.js');
    const output = { reminders: [{ id: 'R1', title: 'Send Mira the draft', due: '2026-10-01T08:00:00.000Z', completed: false, completedAt: null, list: 'Reminders' }], created: null, error: null, timestamp: '2026-09-29T08:00:00.000Z', accessGranted: true };
    const first = remindersEvent(output, '');
    expect(first.event).toEqual({ type: 'reminders:snapshot', payload: { timestamp: output.timestamp, items: [{ id: 'R1', text: 'Send Mira the draft', due: '2026-10-01T08:00:00.000Z', completed: false, completedAt: null, list: 'Reminders' }] } });
    expect(remindersEvent(output, first.fingerprint).event).toBeNull();
    expect(remindersEvent({ ...output, reminders: [{ ...output.reminders[0]!, completed: true }] }, first.fingerprint).event).not.toBeNull();
  });
});
