import { describe, it, expect, vi, beforeEach } from 'vitest';

const capture = vi.hoisted(() => ({ readCalendarEvents: vi.fn(), readReminders: vi.fn() }));
vi.mock('./calendar-capture.js', () => capture);

const { CalendarSensor, remindersEvent } = await import('./index.js');

const calendar = {
  timestamp: '2026-01-01T10:00:00.000Z',
  accessGranted: true,
  events: [{ eventId: 'e1', title: 'Standup', startDate: '2099-01-01T10:00:00.000Z', endDate: '2099-01-01T10:30:00.000Z', attendees: [], isRecurring: false, calendar: 'Work', isAllDay: false }],
};

beforeEach(() => {
  capture.readCalendarEvents.mockReset().mockResolvedValue(calendar);
  capture.readReminders.mockReset();
});

describe('CalendarSensor.poll and the reminders read', () => {
  it('keeps the calendar events when an older helper answers --reminders without a list', async () => {
    capture.readReminders.mockResolvedValue({ timestamp: calendar.timestamp, accessGranted: true });
    const events = await new CalendarSensor().poll();
    expect(events.map((e) => e.type)).toContain('calendar:upcoming');
  });

  it('keeps the calendar events when the reminders read rejects', async () => {
    capture.readReminders.mockRejectedValue(new Error('boom'));
    const events = await new CalendarSensor().poll();
    expect(events.map((e) => e.type)).toContain('calendar:upcoming');
  });

  it('never waits on a reminders read that hangs (an unanswered TCC prompt)', async () => {
    capture.readReminders.mockReturnValue(new Promise(() => {}));
    const events = await new CalendarSensor().poll();
    expect(events.map((e) => e.type)).toContain('calendar:upcoming');
  });

  it('hands the reminders list over on a later poll', async () => {
    capture.readReminders.mockResolvedValue({ timestamp: calendar.timestamp, accessGranted: true, created: null, error: null, reminders: [{ id: 'r1', title: 'Send the deck', due: null, completed: false, completedAt: null, list: 'Work' }] });
    const sensor = new CalendarSensor();
    await sensor.poll();
    await new Promise((r) => setTimeout(r, 0));
    expect((await sensor.poll()).map((e) => e.type)).toEqual(['reminders:snapshot']);
  });

  it('remindersEvent ignores a result with no reminders array', () => {
    expect(remindersEvent({ timestamp: 'x', accessGranted: true } as never, 'fp')).toEqual({ event: null, fingerprint: 'fp' });
  });
});
