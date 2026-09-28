import { type CalendarEvent, type CalendarOutput, readCalendarEvents } from './calendar-capture.js';

export interface CalendarSensorEvent {
  type: 'calendar:upcoming' | 'calendar:active' | 'calendar:context-event';
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

/** On-demand CLI invocation (not a persistent sidecar), gated to at most once per POLL_INTERVAL_MS. */
export class CalendarSensor {
  private lastCheckedAt = 0;
  private readonly classifyState = createCalendarClassifyState();

  async poll(): Promise<CalendarSensorEvent[]> {
    const now = Date.now();
    if (now - this.lastCheckedAt < POLL_INTERVAL_MS) return [];
    this.lastCheckedAt = now;

    const output = await readCalendarEvents();
    if (!output || !output.accessGranted) return [];

    return classifyCalendarPoll(output, this.classifyState);
  }
}
