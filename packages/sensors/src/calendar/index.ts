import { type CalendarEvent, type CalendarOutput, readCalendarEvents, readReminders, type RemindersOutput } from './calendar-capture.js';

export interface CalendarSensorEvent {
  type: 'calendar:upcoming' | 'calendar:active' | 'calendar:context-event' | 'reminders:snapshot';
  payload: Record<string, unknown>;
}

export interface CalendarClassifyState {
  lastUpcomingFingerprint: string;
  activeEventIds: Set<string>;
  contextEventLastEmittedAt: Map<string, number>;
}

export function createCalendarClassifyState(): CalendarClassifyState {
  return { lastUpcomingFingerprint: '', activeEventIds: new Set(), contextEventLastEmittedAt: new Map() };
}

const CONTEXT_EVENT_DEDUPE_MS = 60 * 60_000; // 1h

function contextEventReason(ev: CalendarEvent): 'all-day' | 'not-self-attendee' | null {
  if (ev.isAllDay) return 'all-day';
  if (ev.isSelfAttendee === false) return 'not-self-attendee';
  return null;
}

/**
 * Pure classification logic, separated from the async execFile invocation
 * and the internal poll-interval gate so it's directly unit-testable — no
 * Swift helper, no timers. One poll can produce up to three event types:
 * `calendar:upcoming` (fingerprint-deduped list), `calendar:active` (an
 * event containing `now`, emitted once per event while it stays active),
 * `calendar:context-event` (all-day / non-self-attendee, 1h dedup per
 * eventId). Mutates `state` in place (same object the caller passed in)
 * and returns the events to emit.
 */
export function classifyCalendarPoll(output: CalendarOutput, state: CalendarClassifyState, now: Date = new Date()): CalendarSensorEvent[] {
  const events: CalendarSensorEvent[] = [];

  const fingerprint = [...output.events].map((e) => `${e.eventId}:${e.startDate}`).sort().join(',');
  if (fingerprint !== state.lastUpcomingFingerprint) {
    state.lastUpcomingFingerprint = fingerprint;
    events.push({ type: 'calendar:upcoming', payload: { timestamp: output.timestamp, events: output.events } });
  }

  const currentActiveIds = new Set<string>();
  for (const ev of output.events) {
    if (ev.isAllDay) continue;
    const start = new Date(ev.startDate);
    const end = new Date(ev.endDate);
    if (now >= start && now < end) {
      currentActiveIds.add(ev.eventId);
      if (!state.activeEventIds.has(ev.eventId)) {
        events.push({ type: 'calendar:active', payload: { timestamp: output.timestamp, event: ev } });
      }
    }
  }
  state.activeEventIds = currentActiveIds;

  const nowMs = now.getTime();
  for (const ev of output.events) {
    // The week ahead is read for UC1-X1 (the next meeting with a person); a
    // context event is still only the next day's, as before.
    if (Date.parse(ev.startDate) - nowMs > CONTEXT_HORIZON_MS) continue;
    const reason = contextEventReason(ev);
    if (!reason) continue;

    const lastEmitted = state.contextEventLastEmittedAt.get(ev.eventId) ?? 0;
    if (nowMs - lastEmitted < CONTEXT_EVENT_DEDUPE_MS) continue;
    state.contextEventLastEmittedAt.set(ev.eventId, nowMs);
    events.push({ type: 'calendar:context-event', payload: { timestamp: output.timestamp, event: ev, kind: 'meeting', reason } });
  }

  return events;
}

const POLL_INTERVAL_MS = 60_000;
/**
 * UC1-X1: a week ahead, not a day. A promise with no date is due at the next
 * meeting with that person, and a weekly meeting is a week away. The kernel
 * keeps the next ten (`scheduleTrack`), so every other reader sees what it saw.
 */
const LOOKAHEAD_HOURS = 7 * 24;
const CONTEXT_HORIZON_MS = 24 * 3_600_000;

/** UC1: Reminders change slowly; five minutes is soon enough for "completed" to close a promise. */
const REMINDERS_INTERVAL_MS = 5 * 60_000;
const MAX_REMINDERS = 60;

/**
 * UC1: the reminders list as one event, only when it changed — the same
 * change-only shape as `calendar:upcoming`. The title rides as `text`, so the
 * one redaction pass gives it the secret-pattern treatment at ingest.
 */
export function remindersEvent(output: RemindersOutput, last: string): { event: CalendarSensorEvent | null; fingerprint: string } {
  // An installed helper older than `--reminders` answers with the calendar shape.
  if (!Array.isArray(output?.reminders)) return { event: null, fingerprint: last };
  const items = output.reminders.slice(0, MAX_REMINDERS);
  const fingerprint = items.map((r) => `${r.id}:${r.completed ? 1 : 0}:${r.due ?? ''}:${r.title}`).sort().join('|');
  if (fingerprint === last) return { event: null, fingerprint };
  return { event: { type: 'reminders:snapshot', payload: { timestamp: output.timestamp, items: items.map((r) => ({ id: r.id, text: r.title.slice(0, 200), due: r.due, completed: r.completed, completedAt: r.completedAt, list: r.list })) } }, fingerprint };
}

/**
 * On-demand CLI invocation (not a persistent sidecar), gated to at most once per POLL_INTERVAL_MS.
 * The reminders read runs beside it, never awaited: an unanswered Reminders
 * prompt holds the helper for its whole timeout, and an older helper answers
 * `--reminders` with no list at all. Neither may cost a poll its calendar events.
 */
export class CalendarSensor {
  private lastCheckedAt = 0;
  private lastRemindersAt = 0;
  private remindersInFlight = false;
  private remindersFingerprint = '';
  private remindersReady: CalendarSensorEvent[] = [];
  private readonly classifyState = createCalendarClassifyState();

  async poll(): Promise<CalendarSensorEvent[]> {
    const now = Date.now();
    const events = this.remindersReady.splice(0);
    if (!this.remindersInFlight && now - this.lastRemindersAt >= REMINDERS_INTERVAL_MS) {
      this.lastRemindersAt = now;
      void this.readRemindersBeside();
    }
    if (now - this.lastCheckedAt < POLL_INTERVAL_MS) return events;
    this.lastCheckedAt = now;

    const output = await readCalendarEvents(LOOKAHEAD_HOURS);
    if (output && output.accessGranted) events.push(...classifyCalendarPoll(output, this.classifyState));
    return events;
  }

  private async readRemindersBeside(): Promise<void> {
    this.remindersInFlight = true;
    try {
      const reminders = await readReminders();
      if (!reminders?.accessGranted) return;
      const { event, fingerprint } = remindersEvent(reminders, this.remindersFingerprint);
      this.remindersFingerprint = fingerprint;
      if (event) this.remindersReady.push(event);
    } catch {
      // the next read, five minutes on, tries again
    } finally {
      this.remindersInFlight = false;
    }
  }
}
