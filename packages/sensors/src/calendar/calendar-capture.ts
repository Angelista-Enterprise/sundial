import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { getCalendarHelperPath, getCalendarInfoJsonPath } from '@sundial/helpers/sundial-paths.js';

export interface CalendarEvent {
  eventId: string;
  title: string;
  startDate: string;
  endDate: string;
  attendees: string[];
  isRecurring: boolean;
  calendar: string;
  isAllDay: boolean;
  organizer?: string;
  isSelfAttendee?: boolean;
}

export interface CalendarOutput {
  events: CalendarEvent[];
  timestamp: string;
  accessGranted: boolean;
}

const HELPER_TIMEOUT_MS = 10_000;

/** Invokes the on-demand calendar-helper CLI (EventKit), parses its stdout JSON. Not a persistent sidecar. */
export function readCalendarEvents(hoursAhead = 24, pastDays?: number): Promise<CalendarOutput | null> {
  // SUNDIAL_NATIVE_HELPERS=0: no TCC-gated helper is started (CI, test installs).
  if (process.env.SUNDIAL_NATIVE_HELPERS === '0') return Promise.resolve(null);
  return new Promise((resolve) => {
    const args = ['--hours', String(hoursAhead), ...(pastDays ? ['--past-days', String(pastDays)] : [])];
    execFile(getCalendarHelperPath(), args, { timeout: HELPER_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      try {
        const output: CalendarOutput = JSON.parse(stdout);
        persistCalendarGrantMarker(output.accessGranted);
        resolve(output);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * The calendar helper is on-demand (EventKit, `execFile`), so its grant state
 * would otherwise be invisible to `/status`'s permission surface. Persist the
 * last-known `accessGranted` to a marker sidecar `getPermissionStatus` can read
 * without spawning the helper. Best-effort — a failed write just leaves the
 * previous marker in place. Only written when we actually got a response, so a
 * transient helper error never overwrites a real grant with a false denial.
 */
function persistCalendarGrantMarker(accessGranted: boolean): void {
  try {
    fs.writeFileSync(getCalendarInfoJsonPath(), JSON.stringify({ timestamp: new Date().toISOString(), accessGranted }));
  } catch {
    // ignore — marker is a convenience for permission reporting, not load-bearing.
  }
}

/** UC1: one reminder as the helper reports it. Never notes, never a location. */
export interface ReminderItem {
  id: string;
  title: string;
  due: string | null;
  completed: boolean;
  completedAt: string | null;
  list: string;
}

export interface RemindersOutput {
  reminders: ReminderItem[];
  created: ReminderItem | null;
  error: string | null;
  timestamp: string;
  accessGranted: boolean;
}

/** Reminders access waits up to 20 s for a first answer; leave the helper room to report. */
const REMINDERS_TIMEOUT_MS = 25_000;

/** UC1: the owner's open reminders and the ones completed in the last fortnight, via the same helper (a Reminders grant of its own). */
export function readReminders(): Promise<RemindersOutput | null> {
  if (process.env.SUNDIAL_NATIVE_HELPERS === '0') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(getCalendarHelperPath(), ['--reminders'], { timeout: REMINDERS_TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(JSON.parse(stdout) as RemindersOutput);
      } catch {
        resolve(null);
      }
    });
  });
}
