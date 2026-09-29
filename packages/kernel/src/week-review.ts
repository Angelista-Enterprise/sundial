/**
 * Lane B (#14) — the week in review: what shipped, promises kept or broken
 * (with their n), time by project, mail waiting for the owner's reply, and next
 * week's meetings. Read from the log, not the fold: a week is longer than any
 * ring `KernelState` keeps. Today draws it on Friday afternoon; `gnomon_brief`
 * answers it any day.
 *
 * `composeWeekReview` is pure over rows; `buildWeekReview` reads them.
 */
import { getPromises, getSignalsInRange, type StoredCommitment } from '@sundial/db/index.js';
import { formatClock, localDate, localDayRange, localWeekday } from '@sundial/helpers/local-day.js';
import { buildDailyContext } from './daily-context.js';
import { nameOf, othersIn } from './briefs.js';
import type { KernelState } from './types.js';

interface Row {
  eventType: string;
  capturedAt: string;
  data: Record<string, unknown>;
}

export interface WeekInput {
  /** Monday to today, one entry per local day. */
  days: { date: string; projects: { name: string; minutes: number; commits: number }[]; noProjectMin: number }[];
  /** Pull-request samples from two weeks before Monday until now. */
  prs: Row[];
  /** Mail received and sent this week. */
  mail: Row[];
  /** Calendar rows this week, for who the owner meets. */
  calendar: Row[];
  /** Every promise, open and closed. */
  promises: StoredCommitment[];
  /** The last `calendar:upcoming` sample's events. */
  upcoming: Record<string, unknown>[];
}

export interface WeekReview {
  from: string;
  to: string;
  projects: { name: string; minutes: number; commits: number }[];
  noProjectMin: number;
  merged: { project: string; number: number; title: string }[];
  promises: { closed: number; kept: number; broken: number; dropped: number; quiet: number; open: number; late: number };
  mail: { sentVisible: boolean; waiting: { who: string; subject: string; at: string; owed: boolean }[]; fromPeople: number };
  /** `seen`: whether the calendar's last look ahead reached next week at all (the sensor may read only a day ahead). */
  nextWeek: { seen: boolean; meetings: number; withOthers: number; hours: number; first: { title: string; start: string }[] };
  lines: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const plusDays = (date: string, n: number): string => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const hm = (min: number): string => (min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${Math.round(min % 60)}m` : ''}` : `${Math.round(min)}m`);
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Monday of the owner's week holding `now`, and every local date from it to today. */
export function weekDates(now: string, tz: string): string[] {
  const today = localDate(now, tz);
  const monday = plusDays(today, -((localWeekday(now, tz) + 6) % 7));
  const out: string[] = [];
  for (let d = monday; d <= today; d = plusDays(d, 1)) out.push(d);
  return out;
}

export function composeWeekReview(input: WeekInput, state: KernelState, now: string): WeekReview {
  const tz = state.config.timezone;
  const dates = input.days.map((d) => d.date);
  const from = dates[0] ?? localDate(now, tz);
  const to = dates.at(-1) ?? from;
  const weekStart = localDayRange(from, tz).start;

  // Time and commits by project, the days summed.
  const byName = new Map<string, { name: string; minutes: number; commits: number }>();
  for (const day of input.days) for (const p of day.projects) {
    const acc = byName.get(p.name) ?? { name: p.name, minutes: 0, commits: 0 };
    byName.set(p.name, { name: p.name, minutes: acc.minutes + p.minutes, commits: acc.commits + p.commits });
  }
  const projects = [...byName.values()].sort((a, b) => b.minutes - a.minutes);
  const noProjectMin = input.days.reduce((n, d) => n + d.noProjectMin, 0);

  // Merged this week: a pull request seen open, then merged inside the week. An old merged branch re-reported every poll is not news.
  const seenOpen = new Set<string>();
  const merged = new Map<string, { project: string; number: number; title: string }>();
  for (const r of [...input.prs].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
    const number = typeof r.data.number === 'number' ? r.data.number : null;
    const project = str(r.data.cwd).split('/').filter(Boolean).pop() ?? '';
    if (number === null || project === '') continue;
    const key = `${project}#${number}`;
    const prState = str(r.data.state).toUpperCase();
    if (prState === 'OPEN' || prState === 'DRAFT') seenOpen.add(key);
    else if (prState === 'MERGED' && seenOpen.has(key)) {
      if (r.capturedAt >= weekStart && !merged.has(key)) merged.set(key, { project, number, title: str(r.data.title).slice(0, 80) });
      seenOpen.delete(key);
    }
  }

  // Promises closed this week, by why; the open ones, and how many are past due.
  const closedThisWeek = input.promises.filter((c) => c.closedAt !== null && c.closedAt >= weekStart && c.closedAt <= now);
  const reason = (r: string) => closedThisWeek.filter((c) => c.closedBecause === r).length;
  const open = input.promises.filter((c) => c.closedAt === null);
  const late = open.filter((c) => typeof c.promise?.due === 'string' && (c.promise.due as string) < now).length;
  const promises = { closed: closedThisWeek.length, kept: reason('kept'), broken: reason('broken'), dropped: reason('dropped'), quiet: reason('went-quiet'), open: open.length, late };

  // Mail from people the owner meets (or has a promise with), with no mail sent back to them after it.
  const counterparties = open.map((c) => str(c.promise?.counterparty)).filter((c) => c !== '');
  const met = new Set<string>();
  for (const r of input.calendar) {
    const events = r.data.event ? [r.data.event] : Array.isArray(r.data.events) ? r.data.events : [];
    for (const e of events as { attendees?: unknown }[]) for (const a of Array.isArray(e?.attendees) ? e.attendees : []) if (typeof a === 'string') met.add(a.trim().toLowerCase());
  }
  const sent = input.mail.filter((r) => r.eventType === 'sent');
  const received = input.mail
    .filter((r) => r.eventType === 'received')
    .map((r) => ({ who: str(r.data.from), subject: str(r.data.subject).slice(0, 80), at: str(r.data.timestamp) || r.capturedAt }))
    .filter((m) => m.who !== '' && !(state.config.ownerAliases ?? []).some((o) => same(o, m.who)) && (met.has(m.who.toLowerCase()) || counterparties.some((c) => same(c, m.who))));
  const answered = (m: { who: string; at: string }) => sent.some((s) => (str(s.data.timestamp) || s.capturedAt) > m.at && Array.isArray(s.data.recipients) && s.data.recipients.some((x) => same(str((x as { to?: unknown })?.to), m.who)));
  const waiting = received
    .filter((m) => !answered(m))
    .map((m) => ({ ...m, owed: counterparties.some((c) => same(c, m.who)) }))
    .sort((a, b) => Number(b.owed) - Number(a.owed) || (a.at < b.at ? 1 : -1));
  const mail = { sentVisible: sent.length > 0, waiting: sent.length > 0 ? waiting.slice(0, 8) : [], fromPeople: received.length };

  // Next week: Monday to Sunday after this week, from the calendar's last look ahead.
  const nextFrom = localDayRange(plusDays(from, 7), tz).start;
  const nextTo = localDayRange(plusDays(from, 13), tz).end;
  const nextEvents = input.upcoming
    .map((e) => ({ title: str(e.title) || 'a meeting', start: str(e.startDate), end: str(e.endDate), attendees: Array.isArray(e.attendees) ? e.attendees.filter((a): a is string => typeof a === 'string') : [], allDay: e.isAllDay === true }))
    .filter((e) => !e.allDay && Number.isFinite(Date.parse(e.start)) && e.start >= nextFrom && e.start < nextTo)
    .sort((a, b) => a.start.localeCompare(b.start));
  const unique = [...new Map(nextEvents.map((e) => [`${e.title}|${e.start}`, e])).values()];
  const withOthers = unique.filter((e) => othersIn(state, e.attendees).length > 0);
  const hours = Math.round(unique.reduce((n, e) => n + Math.max(0, (Date.parse(e.end) - Date.parse(e.start)) / 3_600_000), 0) * 10) / 10;
  const reach = input.upcoming.map((e) => str(e.startDate)).filter((t) => Number.isFinite(Date.parse(t))).sort().at(-1) ?? '';
  const nextWeek = { seen: reach >= nextFrom, meetings: unique.length, withOthers: withOthers.length, hours, first: withOthers.slice(0, 5).map((e) => ({ title: e.title, start: e.start })) };

  const lines: string[] = [];
  const shipped = projects.filter((p) => p.commits > 0).sort((a, b) => b.commits - a.commits).slice(0, 4).map((p, i) => `${i === 0 ? `${p.commits} commit${p.commits === 1 ? '' : 's'}` : p.commits} on ${p.name}`);
  const prs = [...merged.values()].slice(0, 4).map((pr) => `PR #${pr.number} merged (${pr.title})`);
  lines.push(`Shipped: ${[shipped.join(', '), prs.join(', ')].filter(Boolean).join('; ') || 'no commits on the record'}.`);
  const time = projects.slice(0, 4).map((p) => `${p.name} ${hm(p.minutes)}`);
  if (time.length > 0 || noProjectMin > 0) lines.push(`Time: ${[...time, ...(noProjectMin >= 30 ? [`unattributed ${hm(noProjectMin)}`] : [])].join(', ')}.`);
  lines.push(
    promises.closed === 0 && promises.open === 0
      ? 'Promises: none on the record.'
      : `Promises: kept ${promises.kept} of ${promises.closed} closed${promises.broken + promises.dropped + promises.quiet > 0 ? ` (not kept ${promises.broken}, dropped ${promises.dropped}, gone quiet ${promises.quiet})` : ''}; ${promises.open} open${promises.late > 0 ? `, ${promises.late} past due` : ''}.`,
  );
  if (!mail.sentVisible) {
    if (mail.fromPeople > 0) lines.push(`Mail: ${mail.fromPeople} from people you meet; sent mail is not on the record yet, so a reply cannot be matched.`);
  } else if (mail.waiting.length > 0) {
    lines.push(`Waiting on your reply: ${mail.waiting.slice(0, 4).map((m) => `${nameOf(state, m.who) ?? 'someone'} “${m.subject}” (${WEEKDAY[localWeekday(m.at, tz)]})`).join('; ')}${mail.waiting.length > 4 ? `, and ${mail.waiting.length - 4} more` : ''}.`);
  }
  lines.push(
    !nextWeek.seen
      ? 'Next week: the calendar has not been read that far ahead yet.'
      : nextWeek.meetings === 0
      ? 'Next week: nothing on the calendar yet.'
      : `Next week: ${nextWeek.meetings} meeting${nextWeek.meetings === 1 ? '' : 's'}, ${nextWeek.withOthers} with others, ${nextWeek.hours}h${nextWeek.first.length > 0 ? `; first ${nextWeek.first.slice(0, 3).map((e) => `${WEEKDAY[localWeekday(e.start, tz)]} ${formatClock(e.start, tz)} ${e.title}`).join(', ')}` : ''}.`,
  );
  return { from, to, projects, noProjectMin, merged: [...merged.values()], promises, mail, nextWeek, lines };
}

/** The week so far, read from the log. */
export async function buildWeekReview(now: string, state: KernelState): Promise<WeekReview> {
  const tz = state.config.timezone;
  const dates = weekDates(now, tz);
  const start = localDayRange(dates[0]!, tz).start;
  const days = await Promise.all(
    dates.map(async (date) => {
      const context = await buildDailyContext(date, { timeZone: tz });
      return { date, projects: context.projects.map((p) => ({ name: p.name, minutes: p.minutes, commits: p.commits })), noProjectMin: context.noProjectMin };
    }),
  );
  const prsFrom = new Date(Date.parse(start) - 14 * 86_400_000).toISOString();
  const [prs, mail, calendar, promises, looks] = await Promise.all([
    getSignalsInRange(prsFrom, now, 20_000, ['git:pr-status']),
    getSignalsInRange(start, now, 5_000, ['mail:received', 'mail:sent']),
    getSignalsInRange(new Date(Date.parse(start) - 14 * 86_400_000).toISOString(), now, 20_000, ['calendar:active', 'calendar:context-event']),
    getPromises(),
    getSignalsInRange(new Date(Date.parse(now) - 86_400_000).toISOString(), now, 1_000, ['calendar:upcoming']),
  ]);
  const last = looks.at(-1)?.data.events;
  return composeWeekReview({ days, prs, mail, calendar, promises, upcoming: Array.isArray(last) ? (last as Record<string, unknown>[]) : [] }, state, now);
}
