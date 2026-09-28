import type { Rule, UpcomingEvent } from '@sundial/kernel/types.js';

/** Bounded state — the forward model needs the next few events, not the whole calendar. */
const MAX_UPCOMING = 10;

interface RawEvent {
  title?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  attendees?: unknown;
  isAllDay?: unknown;
}

function toUpcoming(raw: unknown): UpcomingEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as RawEvent;
  const start = typeof e.startDate === 'string' ? e.startDate : '';
  if (!start) return null;
  return {
    title: typeof e.title === 'string' ? e.title : '',
    start,
    end: typeof e.endDate === 'string' ? e.endDate : start,
    attendees: Array.isArray(e.attendees) ? e.attendees.filter((a): a is string => typeof a === 'string') : [],
    isAllDay: e.isAllDay === true,
  };
}

/**
 * P0-3 (docs/design/08-endogenous-life.md §11.2). Folds the `calendar:upcoming`
 * signal — imported from WCS but, until now, consumed by NO rule (171 signals
 * sitting inert) — into `state.schedule`. The near-future calendar is the most
 * directly predictive raw signal the forward model (Phase 2b) can condition on,
 * and it's useful in read paths immediately.
 *
 * Keeps only events not yet ended (`end >= event.ts`), sorted by start, capped
 * to `MAX_UPCOMING`. The sensor re-emits its full lookahead every poll, so this
 * REPLACES the list wholesale rather than merging. Payload events are already
 * sanitized at ingest (attendee emails aliased). Pure state write, no effects.
 */
export const scheduleTrack: Rule = (state, event) => {
  // A meeting the owner is IN, from the same sensor that reports the next few.
  // `calendar:active` fires while an event is running and carries the event
  // itself; holding it on the schedule slice is what lets a `meetingContains`
  // rule fire for the whole call rather than only until the next moment opens.
  if (event.type === 'calendar:active') {
    const ev = (event.payload as { event?: { title?: unknown; startDate?: unknown; endDate?: unknown } }).event;
    const title = typeof ev?.title === 'string' ? ev.title.trim() : '';
    if (title === '') return { state, effects: [] };
    const start = typeof ev?.startDate === 'string' ? ev.startDate : event.ts;
    const end = typeof ev?.endDate === 'string' ? ev.endDate : event.ts;
    const active = state.schedule.active;
    if (active && active.title === title && active.end === end) return { state, effects: [] };
    return { state: { ...state, schedule: { ...state.schedule, active: { title, start, end } } }, effects: [] };
  }

  // A meeting that has ended stops being the active one, on the next tick
  // rather than on the next poll: the sensor goes quiet between meetings, so
  // nothing else would ever clear it.
  if (event.type === 'clock:tick') {
    const active = state.schedule.active;
    if (!active || Date.parse(event.ts) <= Date.parse(active.end)) return { state, effects: [] };
    return { state: { ...state, schedule: { ...state.schedule, active: null } }, effects: [] };
  }

  if (event.type !== 'calendar:upcoming') return { state, effects: [] };

  const raw = (event.payload as { events?: unknown }).events;
  if (!Array.isArray(raw)) return { state, effects: [] };

  const now = Date.parse(event.ts);
  const upcoming = raw
    .map(toUpcoming)
    .filter((e): e is UpcomingEvent => {
      if (e === null) return false;
      const end = Date.parse(e.end);
      return Number.isNaN(end) || end >= now;
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, MAX_UPCOMING);

  return { state: { ...state, schedule: { ...state.schedule, upcoming, updatedAt: event.ts } }, effects: [] };
};
