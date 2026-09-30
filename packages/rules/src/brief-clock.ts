/**
 * Lane B — the standup draft (#22) and the meeting prep (#13), on the clock.
 *
 * Folds what a standup reads back — each day's commits, pull-request changes,
 * ticket keys and working agent sessions — and who the owner last met with
 * whom. On `clock:tick` it looks at the calendar:
 *
 *   - A standup-like meeting (a short morning series with others, told by its
 *     shape: `isStandupLike`) about ten minutes out: the three-line draft,
 *     once a day, as a plain phasic notice.
 *   - Any other meeting with others about ten minutes out: the prep, as a
 *     plain tonic line, only when the record holds something on those people.
 *   - A meeting a promise is due at (UC1-X1), an hour out: the prep, led by
 *     UC1's own sentence. `promiseTrack` stays quiet for it, so the owner gets
 *     one notice per meeting, and still an hour to send the draft.
 *
 * Every notice goes to the gate as a candidate; nothing here speaks. A kind
 * the owner called wrong twice running goes quiet (`silenced`). Timed by the
 * tick and `briefs.done`, never a timer.
 */
import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { briefHeader, briefKey, briefsOf, isStandupLike, meetingPrepKey, othersIn, prepLines, silenced, standupLines, weekReviewDue, type PrepMeeting } from '@sundial/kernel/briefs.js';
import type { BriefDay, BriefState, Commitment, Effect, KernelState, Rule, SanitizedEvent, UpcomingEvent } from '@sundial/kernel/types.js';
import { fadingWeight, fadingWords, SPEAK_BEFORE_MS } from './promise-track.js';
import { samePerson } from './promise-terms.js';
import { branchKey, ticketKeys } from './ticket-track.js';

/** Days of work the fold keeps: a Monday standup reads back the Friday, a holiday or two past it. */
export const BRIEF_DAYS = 8;
/** How long before a meeting its prep or its standup draft is said. */
export const PREP_LEAD_MS = 10 * 60_000;
const MAX_LAST_MET = 80;
const MAX_PR_STATE = 60;
const MAX_DAY_TICKETS = 12;
const MAX_DAY_AGENTS = 20;
const MAX_BRANCHES = 3;

type Result = { state: KernelState; effects: Effect[] };
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const projectOf = (cwd: unknown): string => str(cwd).split('/').filter(Boolean).pop() ?? '';
const EMPTY_DAY: BriefDay = { commits: {}, prs: {}, tickets: [], agents: {} };
const at = (event: SanitizedEvent): string => {
  const t = (event.payload as { timestamp?: unknown }).timestamp;
  return typeof t === 'string' && Number.isFinite(Date.parse(t)) ? t : event.ts;
};

function withDay(state: KernelState, ts: string, change: (day: BriefDay) => BriefDay): Result {
  const briefs = briefsOf(state);
  const key = localDate(ts, state.config.timezone);
  const before = briefs.days[key] ?? EMPTY_DAY;
  const after = change(before);
  if (after === before) return { state, effects: [] };
  return { state: { ...state, briefs: { ...briefs, days: { ...briefs.days, [key]: after } } }, effects: [] };
}

const addTickets = (day: BriefDay, keys: string[]): string[] => [...new Set([...day.tickets, ...keys])].slice(0, MAX_DAY_TICKETS);

function onCommit(state: KernelState, event: SanitizedEvent): Result {
  const p = event.payload as Record<string, unknown>;
  const project = projectOf(p.cwd);
  if (project === '') return { state, effects: [] };
  const branch = str(p.branch);
  const keys = [...ticketKeys(str(p.commitLine)), ...[branchKey(branch)].filter((k): k is string => k !== null)];
  return withDay(state, at(event), (day) => {
    const c = day.commits[project] ?? { n: 0, branches: [] };
    const branches = branch !== '' && !c.branches.includes(branch) && c.branches.length < MAX_BRANCHES ? [...c.branches, branch] : c.branches;
    return { ...day, commits: { ...day.commits, [project]: { n: c.n + 1, branches } }, tickets: addTickets(day, keys) };
  });
}

/** A pull request counts on the day its state was first seen or changed; the sensor re-reports it every poll. */
function onPr(state: KernelState, event: SanitizedEvent): Result {
  const p = event.payload as Record<string, unknown>;
  const project = projectOf(p.cwd);
  const number = typeof p.number === 'number' ? p.number : null;
  const prState = str(p.state).toUpperCase();
  if (project === '' || number === null || prState === '') return { state, effects: [] };
  const key = `${project}#${number}`;
  const briefs = briefsOf(state);
  if (briefs.prState[key] === prState) return { state, effects: [] };
  const { [key]: _old, ...rest } = briefs.prState;
  const kept = Object.entries(rest).slice(-(MAX_PR_STATE - 1));
  const noted: KernelState = { ...state, briefs: { ...briefs, prState: { ...Object.fromEntries(kept), [key]: prState } } };
  const keys = [...ticketKeys(str(p.title)), ...[branchKey(p.branch)].filter((k): k is string => k !== null)];
  return withDay(noted, at(event), (day) => ({ ...day, prs: { ...day.prs, [key]: { number, title: str(p.title).slice(0, 120), state: prState } }, tickets: addTickets(day, keys) }));
}

function onFleet(state: KernelState, event: SanitizedEvent): Result {
  const sessions = (event.payload as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return { state, effects: [] };
  const working = sessions.map((s) => s as { id?: unknown; cwd?: unknown; state?: unknown }).filter((s) => s.state === 'working' && str(s.id) !== '' && projectOf(s.cwd) !== '');
  if (working.length === 0) return { state, effects: [] };
  return withDay(state, at(event), (day) => {
    let agents = day.agents;
    for (const s of working) {
      const project = projectOf(s.cwd);
      const ids = agents[project] ?? [];
      if (ids.includes(str(s.id)) || ids.length >= MAX_DAY_AGENTS) continue;
      agents = { ...agents, [project]: [...ids, str(s.id)] };
    }
    return agents === day.agents ? day : { ...day, agents };
  });
}

/** Who the owner was just in a meeting with: the last meeting per person, for "Last met" in the next prep. */
function onActive(state: KernelState, event: SanitizedEvent): Result {
  const e = (event.payload as { event?: { title?: unknown; startDate?: unknown; attendees?: unknown; isAllDay?: unknown } }).event;
  const title = str(e?.title);
  const start = str(e?.startDate);
  if (title === '' || !Number.isFinite(Date.parse(start)) || e?.isAllDay === true) return { state, effects: [] };
  const people = othersIn(state, Array.isArray(e?.attendees) ? e.attendees.filter((a): a is string => typeof a === 'string') : []);
  const briefs = briefsOf(state);
  const fresh = people.filter((p) => (briefs.lastMet[p]?.start ?? '') < start);
  if (fresh.length === 0) return { state, effects: [] };
  const merged = { ...briefs.lastMet, ...Object.fromEntries(fresh.map((p) => [p, { title, start }])) };
  const lastMet = Object.fromEntries(Object.entries(merged).sort((a, b) => (a[1].start < b[1].start ? 1 : -1)).slice(0, MAX_LAST_MET));
  return { state: { ...state, briefs: { ...briefs, lastMet } }, effects: [] };
}

function onBoundary(state: KernelState, event: SanitizedEvent): Result {
  const briefs = briefsOf(state);
  const cutoff = localDate(new Date(Date.parse(event.ts) - BRIEF_DAYS * 86_400_000).toISOString(), state.config.timezone);
  const since = Date.parse(event.ts) - BRIEF_DAYS * 86_400_000;
  const days = Object.fromEntries(Object.entries(briefs.days).filter(([d]) => d > cutoff));
  const done = Object.fromEntries(Object.entries(briefs.done).filter(([, t]) => Date.parse(t) >= since));
  if (Object.keys(days).length === Object.keys(briefs.days).length && Object.keys(done).length === Object.keys(briefs.done).length) return { state, effects: [] };
  return { state: { ...state, briefs: { ...briefs, days, done } }, effects: [] };
}

/** Promises due at this meeting (UC1-X1), which the prep leads with. */
function dueAt(state: KernelState, m: PrepMeeting): Commitment[] {
  const start = Date.parse(m.start);
  return state.commitments.promises.filter((c) => c.promise?.dueKind === 'next-meeting' && !!c.promise.nextMeeting && Date.parse(c.promise.nextMeeting.start) === start && m.attendees.some((a) => samePerson(a, c.promise!.counterparty)));
}

/** The meetings worth a look this tick: the calendar's, and any a promise is due at that the calendar slice no longer holds. */
function meetingsAhead(state: KernelState): (PrepMeeting & { end: string; event: UpcomingEvent | null })[] {
  const out: (PrepMeeting & { end: string; event: UpcomingEvent | null })[] = state.schedule.upcoming.filter((m) => !m.isAllDay).map((m) => ({ title: m.title, start: m.start, end: m.end, attendees: m.attendees, event: m }));
  for (const c of state.commitments.promises) {
    const next = c.promise?.dueKind === 'next-meeting' ? c.promise.nextMeeting : null;
    if (!next || out.some((m) => Date.parse(m.start) === Date.parse(next.start))) continue;
    out.push({ title: next.title, start: next.start, end: next.start, attendees: [c.promise!.counterparty ?? ''], event: null });
  }
  return out;
}

function candidate(event: SanitizedEvent, payload: Record<string, unknown>): Effect {
  return { type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'brief-clock', String(payload.key)), type: 'notice:candidate', ts: event.ts, payload: { timestamp: event.ts, shape: 'transition', plain: true, concerns: [], ...payload } } };
}

function remember(state: KernelState, keys: string[], ts: string, latest: BriefState['latest']): KernelState {
  const briefs = briefsOf(state);
  return { ...state, briefs: { ...briefs, done: { ...briefs.done, ...Object.fromEntries(keys.map((k) => [k, ts])) }, ...(latest ? { latest } : {}) } };
}

function onTick(state: KernelState, event: SanitizedEvent): Result {
  const now = Date.parse(event.ts);
  const tz = state.config.timezone;
  const done = briefsOf(state).done;
  let result: Result = { state, effects: [] };
  for (const m of meetingsAhead(state)) {
    const lead = Date.parse(m.start) - now;
    const prepKey = meetingPrepKey(m.title, m.start);
    if (lead <= 0 || lead > SPEAK_BEFORE_MS || done[prepKey] || result.state.briefs?.done[prepKey]) continue;
    if (othersIn(result.state, m.attendees).length === 0) continue;
    const s = result.state;

    // A promise due at this meeting: its prep speaks now, an hour out, led by UC1's own words.
    const owed = dueAt(s, m);
    if (owed.length > 0) {
      const words = owed.map((c) => fadingWords(s, c, event.ts, c.promise!.due!, true));
      const lines = prepLines(s, m, event.ts, { lead: words.map((w) => w.observation).join(' '), leadIds: owed.map((c) => c.id) });
      const weight = owed.map((c) => fadingWeight(c, event.ts, c.promise!.due!, true)).sort((a, b) => b.surprise * b.precision - a.surprise * a.precision)[0]!;
      const notice = candidate(event, { kind: 'meeting-prep', key: prepKey, ...weight, valueHalfLifeMs: SPEAK_BEFORE_MS, observation: lines.join(' '), evidence: [briefHeader(s, m), ...words.flatMap((w) => w.evidence)].slice(0, 8), concerns: owed.map((c) => c.id) });
      result = { state: remember(s, [prepKey], event.ts, { kind: 'meeting-prep', title: m.title, start: m.start, end: m.end, lines, at: event.ts }), effects: [...result.effects, notice] };
      continue;
    }
    if (lead > PREP_LEAD_MS) continue;

    // A standup: the day's draft, once a day, even when two standups share the morning.
    if (m.event && isStandupLike(s, m.event)) {
      const dayKey = briefKey({ kind: 'standup-draft', title: m.title, start: m.start }, tz);
      // A fold that holds no earlier day (just deployed) cannot say what yesterday was: stay quiet rather than say "no work".
      const heldBefore = Object.keys(s.briefs?.days ?? {}).some((d) => d < localDate(m.start, tz));
      if (s.briefs?.done[dayKey] || silenced(s, 'standup-draft') || !heldBefore) {
        result = { state: remember(s, [prepKey], event.ts, null), effects: result.effects };
        continue;
      }
      const lines = standupLines(s, event.ts, m);
      const notice = candidate(event, { kind: 'standup-draft', key: dayKey, surprise: 1.7, precision: 1, valueHalfLifeMs: PREP_LEAD_MS, observation: `${briefHeader(s, m)} ${lines.join(' ')}`, evidence: [briefHeader(s, m), 'commits, pull requests and agent sessions as the sensors saw them; Slack and tickets you did not open are not read'] });
      result = { state: remember(s, [prepKey, dayKey], event.ts, { kind: 'standup-draft', title: m.title, start: m.start, end: m.end, lines, at: event.ts }), effects: [...result.effects, notice] };
      continue;
    }

    // Any other meeting with others: the prep, as a line in passing, only when there is something to prep.
    const lines = silenced(s, 'meeting-prep') ? [] : prepLines(s, m, event.ts);
    if (lines.length === 0) {
      result = { state: remember(s, [prepKey], event.ts, null), effects: result.effects };
      continue;
    }
    const notice = candidate(event, { kind: 'meeting-prep', key: prepKey, surprise: 1, precision: 1, valueHalfLifeMs: null, observation: `${briefHeader(s, m)} ${lines.join(' ')}`, evidence: ['promises, the calendar, tickets and mail subjects already on the record; mail bodies, Slack and chat are not read'] });
    result = { state: remember(s, [prepKey], event.ts, { kind: 'meeting-prep', title: m.title, start: m.start, end: m.end, lines, at: event.ts }), effects: [...result.effects, notice] };
  }
  return result;
}

/** How often the week in review is composed again while it is due, so Friday afternoon's work reaches it. */
export const WEEK_EVERY_MS = 60 * 60_000;

/** W4 step 7: while the week is due, ask the executor to compose it, at most once an hour. */
function askWeek(result: Result, event: SanitizedEvent): Result {
  const briefs = briefsOf(result.state);
  if (!weekReviewDue(event.ts, result.state.config.timezone)) return result;
  if (briefs.weekAskedAt && Date.parse(event.ts) - Date.parse(briefs.weekAskedAt) < WEEK_EVERY_MS) return result;
  return { state: { ...result.state, briefs: { ...briefs, weekAskedAt: event.ts } }, effects: [...result.effects, { type: 'ComposeWeekReview', at: event.ts }] };
}

function onWeekComposed(state: KernelState, event: SanitizedEvent): Result {
  const p = event.payload as Record<string, unknown>;
  const lines = Array.isArray(p.lines) ? p.lines.filter((l): l is string => typeof l === 'string').slice(0, 20) : [];
  if (!str(p.from) || !str(p.to) || lines.length === 0) return { state, effects: [] };
  return { state: { ...state, briefs: { ...briefsOf(state), week: { from: str(p.from), to: str(p.to), lines, at: str(p.at) || event.ts } } }, effects: [] };
}

export const briefClock: Rule = (state, event) => {
  switch (event.type) {
    case 'clock:tick':
      return askWeek(onTick(state, event), event);
    case 'brief:week-composed':
      return onWeekComposed(state, event);
    case 'git:commit':
      return onCommit(state, event);
    case 'git:pr-status':
      return onPr(state, event);
    case 'agent:fleet':
      return onFleet(state, event);
    case 'calendar:active':
      return onActive(state, event);
    case 'day:boundary':
      return onBoundary(state, event);
    default:
      return { state, effects: [] };
  }
};
