/**
 * Lane B — the standup draft and the meeting prep, read from state. Pure: the
 * `briefClock` rule speaks them through the gate, `gnomon_brief` answers them on
 * demand and Today draws them, and all three read these same lines.
 *
 * Nothing here is a model: the lines are counts and names the fold already
 * holds (commits, pull requests, ticket keys, promises, the calendar, mail
 * subjects), each already sanitized at ingest.
 */
import { formatClock, localDate, localHour, localWeekday } from '@sundial/helpers/local-day.js';
import type { BriefDay, BriefState, Commitment, KernelState, UpcomingEvent, WeekBrief } from './types.js';
import { promisePhrase } from './promise-words.js';

export const EMPTY_BRIEFS: BriefState = { days: {}, prState: {}, lastMet: {}, done: {} };
export const briefsOf = (state: KernelState): BriefState => state.briefs ?? EMPTY_BRIEFS;

/** A standup is short: this long at most. */
export const STANDUP_MAX_MIN = 30;
/** And in the morning: it starts before this local hour. */
export const STANDUP_BEFORE_HOUR = 11;

const HASH = /^person-[0-9a-f]{10}$/;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A person as the owner knows them, or null for a hash they never named: a hash is never put to the owner. */
export function nameOf(state: KernelState, who: string | null | undefined): string | null {
  if (!who) return null;
  const named = state.memory.aliasNames?.[who] ?? who;
  return HASH.test(named) ? null : named;
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** A room booked as an attendee: calendars name a resource with its capacity, "Floor-2 Library (12)". */
const ROOM = /\(\d+\)\s*$/;

/** The attendees who are not the owner, and not a room. */
export function othersIn(state: KernelState, attendees: readonly string[]): string[] {
  const owner = state.config.ownerAliases ?? [];
  return [...new Set(attendees.filter((a) => a.trim() !== '' && !ROOM.test(a) && !owner.some((o) => same(o, a))))];
}

/** "Mira Bakker and 2 others", never a hash. */
export function peopleText(state: KernelState, people: readonly string[]): string {
  const named = people.map((p) => nameOf(state, p)).filter((n): n is string => n !== null);
  const rest = people.length - named.length;
  const shown = named.slice(0, 3);
  const more = rest + (named.length - shown.length);
  if (shown.length === 0) return more > 0 ? `${more} other${more === 1 ? '' : 's'}` : '';
  return more > 0 ? `${shown.join(', ')} and ${more} other${more === 1 ? '' : 's'}` : shown.join(', ');
}

/**
 * A standup, told from its shape rather than its name: part of a series (or on
 * the calendar on another day too), at most half an hour, starting before 11
 * in the owner's zone, with someone else in it. Measured on the live calendar
 * 2026-09-29: this picks 3 series, and all 3 are the standup-type meetings.
 */
export function isStandupLike(state: KernelState, m: UpcomingEvent): boolean {
  if (m.isAllDay) return false;
  const tz = state.config.timezone;
  const minutes = (Date.parse(m.end) - Date.parse(m.start)) / 60_000;
  if (!(minutes > 0 && minutes <= STANDUP_MAX_MIN)) return false;
  if (localHour(m.start, tz) >= STANDUP_BEFORE_HOUR) return false;
  if (othersIn(state, m.attendees).length === 0) return false;
  // A series by the calendar's flag, or by the record: the same title on another day, ahead or already attended.
  const day = localDate(m.start, tz);
  const seen = [...state.schedule.upcoming, ...Object.values(briefsOf(state).lastMet)].some((e) => e.title === m.title && localDate(e.start, tz) !== day);
  return m.recurring === true || seen;
}

/** "Yesterday", a weekday within the week, else the date. */
export function dayLabel(day: string, today: string): string {
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return days > 1 && days < 7 ? WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]! : day;
}

/** One promise in the owner's words: "the draft for Mira" or "Mira owes you the numbers". */
export function promiseText(state: KernelState, c: Commitment): string {
  const p = c.promise;
  if (!p) return c.name;
  const who = nameOf(state, p.counterparty);
  return promisePhrase(p.direction, p.deliverable, who);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const hasWork = (d: BriefDay | undefined): boolean => !!d && (Object.keys(d.commits).length > 0 || Object.keys(d.prs).length > 0 || Object.keys(d.agents).length > 0);

/** The last day before today with work on it, if the fold still holds it. */
export function lastWorkDay(state: KernelState, now: string): string | null {
  const today = localDate(now, state.config.timezone);
  const days = briefsOf(state).days;
  return Object.keys(days).filter((d) => d < today && hasWork(days[d])).sort().pop() ?? null;
}

/**
 * The standup draft, three lines at most:
 *   "Yesterday: 12 commits on puzzlebox-studio (feat/box-484), 3 on sundial; PR #12 merged; BOX-484."
 *   "Kept: the draft for Mira Bakker. Agent sessions: 2 on puzzlebox-studio."
 *   "Today: Planning 11:00; due: the deck for Bob."
 */
export function standupLines(state: KernelState, now: string, except: { title: string; start: string } | null = null): string[] {
  const tz = state.config.timezone;
  const today = localDate(now, tz);
  const prev = lastWorkDay(state, now);
  const day = prev ? briefsOf(state).days[prev] : undefined;

  const commits = Object.entries(day?.commits ?? {})
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 3)
    .map(([project, c], i) => `${i === 0 ? plural(c.n, 'commit') : c.n} on ${project}${c.branches.length > 0 ? ` (${c.branches.slice(0, 2).join(', ')})` : ''}`);
  const prs = Object.values(day?.prs ?? {})
    .slice(-3)
    .map((pr) => `PR #${pr.number} ${pr.state.toLowerCase()}`);
  const tickets = (day?.tickets ?? []).slice(0, 4);
  const did = [commits.join(', '), prs.join(', '), tickets.join(', ')].filter((s) => s !== '').join('; ');
  const lines = [prev ? `${dayLabel(prev, today)}: ${did}.` : 'No work on the record for the last few days.'];

  const kept = state.commitments.recentClosed.filter((c) => c.promise && c.closedBecause === 'kept' && prev !== null && localDate(c.closedAt, tz) === prev).map((c) => promiseText(state, c));
  const agents = Object.entries(day?.agents ?? {})
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([project, ids]) => `${ids.length} on ${project}`);
  const also = [kept.length > 0 ? `Kept: ${kept.slice(0, 2).join('; ')}.` : '', agents.length > 0 ? `Agent sessions: ${agents.join(', ')}.` : ''].filter((s) => s !== '').join(' ');
  if (also !== '') lines.push(also);

  const meetings = [
    ...new Set(
      state.schedule.upcoming
        .filter((m) => !m.isAllDay && localDate(m.start, tz) === today && Date.parse(m.end) > Date.parse(now) && !(except && Date.parse(m.start) === Date.parse(except.start)))
        .map((m) => `${m.title} ${formatClock(m.start, tz)}`),
    ),
  ].slice(0, 4);
  const due = state.commitments.promises.filter((c) => c.promise?.due && localDate(c.promise.due, tz) <= today).map((c) => promiseText(state, c));
  const plan = [meetings.join(', '), due.length > 0 ? `due: ${due.slice(0, 3).join('; ')}` : ''].filter((s) => s !== '').join('; ');
  lines.push(`Today: ${plan || 'nothing on the calendar'}.`);
  return lines;
}

/** A meeting as the prep needs it. */
export interface PrepMeeting {
  title: string;
  start: string;
  attendees: string[];
}

/** Mail with these people, newest first: what they sent and what the owner sent them. Subjects only. */
export function mailWith(state: KernelState, people: readonly string[], max = 3): { who: string; subject: string; at: string; sent: boolean }[] {
  const got = (state.mail?.recent ?? []).filter((m) => people.some((p) => same(p, m.from))).map((m) => ({ who: m.from, subject: m.subject, at: m.at, sent: false }));
  const sent = (state.mail?.sent ?? []).flatMap((m) => {
    const to = m.to.find((t) => people.some((p) => same(p, t)));
    return to ? [{ who: to, subject: m.subject, at: m.at, sent: true }] : [];
  });
  return [...got, ...sent].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, max);
}

/**
 * The meeting prep: what is owed between the owner and the people in the room,
 * the last meeting with them, tickets in play, and recent mail with them.
 * `lead` is a sentence the caller already has (the promise due at this meeting,
 * UC1's own words); `leadIds` are the promises it covers. Empty when the record
 * holds nothing on these people, so an empty prep is never said.
 */
export function prepLines(state: KernelState, m: PrepMeeting, now: string, opts: { lead?: string | null; leadIds?: readonly string[] } = {}): string[] {
  const tz = state.config.timezone;
  const today = localDate(now, tz);
  const others = othersIn(state, m.attendees);
  const lines: string[] = opts.lead ? [opts.lead] : [];

  const owed = state.commitments.promises.filter((c) => !opts.leadIds?.includes(c.id) && others.some((p) => same(p, c.promise?.counterparty))).map((c) => promiseText(state, c));
  if (owed.length > 0) lines.push(`Open: ${owed.slice(0, 3).join('; ')}.`);

  const start = Date.parse(m.start);
  const met = others
    .map((p) => briefsOf(state).lastMet[p])
    .filter((x): x is { title: string; start: string } => !!x && Date.parse(x.start) < start - 60_000)
    .sort((a, b) => (a.start < b.start ? 1 : -1))[0];
  if (met) lines.push(`Last met: ${met.title}, ${dayLabel(localDate(met.start, tz), today)}.`);

  const mail = mailWith(state, others);
  const text = [m.title, ...mail.map((x) => x.subject)].join(' ');
  const tickets = Object.values(state.tickets ?? {})
    .filter((t) => /^[A-Z0-9]+-\d+$/i.test(t.id) && new RegExp(`\\b${t.id}\\b`, 'i').test(text))
    .slice(0, 3)
    .map((t) => (t.pr?.number ? `${t.id} (PR #${t.pr.number}${t.pr.state ? ` ${t.pr.state.toLowerCase()}` : ''})` : t.id));
  if (tickets.length > 0) lines.push(`In play: ${tickets.join(', ')}.`);
  if (mail.length > 0) lines.push(`Mail: ${mail.map((x) => `${x.sent ? `you to ${nameOf(state, x.who) ?? 'them'}` : (nameOf(state, x.who) ?? 'them')} “${x.subject}” (${dayLabel(localDate(x.at, tz), today)})`).join('; ')}.`);

  const brief = state.workbench.recent.find((r) => r.kind === 'meeting-brief' && r.key === `meeting:${m.title}:${m.start}` && r.outcome === 'shelved');
  if (brief) lines.push('Gnomon’s brief is on your shelf.');
  // The last meeting alone is context, not a prep: nothing is owed, in play or in the mail.
  return lines.length === 1 && met && lines[0]!.startsWith('Last met:') ? [] : lines;
}

/** The header a prep or a draft is said under: "Standup at 09:00 with Mira Bakker and 3 others." */
export function briefHeader(state: KernelState, m: PrepMeeting): string {
  const people = peopleText(state, othersIn(state, m.attendees));
  return `${m.title || 'A meeting'} at ${formatClock(m.start, state.config.timezone)}${people ? ` with ${people}` : ''}.`;
}

/** Whether the week's review belongs on Today: Friday from 13:00, and the weekend after it. */
export function weekReviewDue(now: string, tz: string): boolean {
  const wd = localWeekday(now, tz);
  return wd === 6 || wd === 0 || (wd === 5 && localHour(now, tz) >= 13);
}

/** Today's brief card at `now`: the brief with the notice key it was raised under, and this week's review while it is due. */
export function todayBrief(state: KernelState | null | undefined, now: number): { before: ReturnType<typeof visibleBrief>; week: Pick<WeekBrief, 'from' | 'to' | 'lines'> | null } {
  if (!state) return { before: null, week: null };
  const week = visibleWeek(state, now);
  return { before: visibleBrief(state, now), week: week ? { from: week.from, to: week.to, lines: week.lines } : null };
}

/** The week in review Today shows at `now`: this week's, while it is due (Friday from 13:00 and the weekend). */
export function visibleWeek(state: KernelState, now: number): WeekBrief | null {
  const iso = new Date(now).toISOString();
  const tz = state.config.timezone;
  const week = briefsOf(state).week ?? null;
  return week && weekReviewDue(iso, tz) && week.from === mondayOf(iso, tz) ? week : null;
}

/** The owner-local Monday of the week holding `iso`. */
export function mondayOf(iso: string, tz: string): string {
  const back = (localWeekday(iso, tz) + 6) % 7;
  return new Date(Date.parse(`${localDate(iso, tz)}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
}

/** The key a meeting's prep is raised under, one per occurrence. `promiseTrack` reads it: a promise due at the meeting is said by the prep. */
export const meetingPrepKey = (title: string, start: string): string => `meeting-prep:${title}|${Number.isFinite(Date.parse(start)) ? new Date(start).toISOString() : start}`;

/** The notice key a brief is raised under: the standup draft once a day, the prep once per meeting. */
export const briefKey = (brief: { kind: string; title: string; start: string }, timeZone: string): string =>
  brief.kind === 'standup-draft' ? `standup-draft:${localDate(brief.start, timeZone)}` : meetingPrepKey(brief.title, brief.start);

/** The brief Today shows at `now`, with its notice key: the latest one until its meeting ends, none when the owner turned briefs off in Settings. */
export function visibleBrief(state: KernelState, now: number): (NonNullable<BriefState['latest']> & { key: string }) | null {
  const latest = briefsOf(state).latest ?? null;
  if (!latest || Date.parse(latest.end) <= now || (state.settings?.quiet ?? []).includes('briefs')) return null;
  return { ...latest, key: briefKey(latest, state.config.timezone) };
}

/** The owner's word on a kind of brief: the last two verdicts on it both "wrong" turn it off until a "useful" one. */
export function silenced(state: KernelState, kind: string): boolean {
  const verdicts = (state.feedback?.recent ?? []).filter((f) => f.artifactKind === 'notice' && f.artifactId.startsWith(`${kind}:`)).slice(-2);
  return verdicts.length === 2 && verdicts.every((f) => f.verdict === 'wrong');
}
