import { localDate, localInstant } from './local-day.js';

/**
 * A repeating job's schedule, in the plain words the owner said it in:
 * "every monday at 9am", "weekdays at 17:30", "daily at 8", "every tuesday and
 * thursday at 14:00". Days and one time of day — nothing finer, because a job
 * is a brief for the shelf, not a cron job.
 */
export interface RepeatSchedule {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  hour: number;
  minute: number;
}

/** The key a repeating job is stored and stopped under — by the rule and by the tools, from this one definition. */
export function repeatKey(subject: string): string {
  return subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** The schedule in `text`, or null when it is not one this understands. With no time given, 09:00. */
export function parseRepeat(text: string): RepeatSchedule | null {
  const t = text.trim().toLowerCase();
  const time = t.match(/\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*$/);
  let hour = 9;
  let minute = 0;
  let rest = t;
  if (time && (time[2] !== undefined || time[3] !== undefined || /\bat\s+\d/.test(t))) {
    hour = Number(time[1]);
    minute = time[2] ? Number(time[2]) : 0;
    if (time[3] === 'pm' && hour < 12) hour += 12;
    if (time[3] === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    rest = t.slice(0, time.index).trim();
  }
  rest = rest.replace(/^(every|each|on)\s+/, '');
  let days: number[];
  if (/^(day|daily)$/.test(rest)) days = [0, 1, 2, 3, 4, 5, 6];
  else if (/^weekdays?$/.test(rest)) days = [1, 2, 3, 4, 5];
  else if (/^weekends?$/.test(rest)) days = [0, 6];
  else {
    const names = rest.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean);
    days = names.map((name) => DAY_NAMES.indexOf(name.slice(0, 3)));
    if (days.length === 0 || days.includes(-1) || names.some((n) => !/^(sun(day)?|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs?(day)?)?|fri(day)?|sat(urday)?)s?$/.test(n))) return null;
  }
  return { days: [...new Set(days)].sort(), hour, minute };
}

function occurrences(schedule: RepeatSchedule, nowIso: string, timeZone: string, from: number, to: number): string[] {
  const [y, m, d] = localDate(nowIso, timeZone).split('-').map(Number);
  const out: string[] = [];
  for (let k = from; k <= to; k++) {
    const day = new Date(Date.UTC(y!, m! - 1, d! + k));
    if (!schedule.days.includes(day.getUTCDay())) continue;
    out.push(localInstant(day.toISOString().slice(0, 10), schedule.hour, schedule.minute, timeZone));
  }
  return out;
}

/** The latest scheduled instant at or before now, looking back a week; null if none. */
export function lastOccurrence(schedule: RepeatSchedule, nowIso: string, timeZone: string): string | null {
  const past = occurrences(schedule, nowIso, timeZone, -7, 0).filter((at) => at <= nowIso);
  return past.length > 0 ? past[past.length - 1]! : null;
}

/** The next scheduled instant after now. */
export function nextOccurrence(schedule: RepeatSchedule, nowIso: string, timeZone: string): string | null {
  return occurrences(schedule, nowIso, timeZone, 0, 8).find((at) => at > nowIso) ?? null;
}
