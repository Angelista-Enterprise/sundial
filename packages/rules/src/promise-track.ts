/**
 * UC1 — "You promised this". The promise ledger: open promises, with their
 * terms, apart from the branch threads `commitmentTrack` keeps, in the same
 * `commitments` table.
 *
 * Opened by: the meeting pass (`meeting:promises`, one per meeting, U1-F2), a
 * promise heard in one moment (`commitment:heard`, J4.4), the owner's own words
 * to Gnomon or in answer to a question.
 *
 * Every term is read here, deterministically, from the words and the people
 * who were there (`promise-terms.ts`); the model only proposes the words.
 */
import { deriveId } from '@sundial/helpers/derive-id.js';
import { formatClock, localDate as localDay, localWeekday } from '@sundial/helpers/local-day.js';
import type { ClosedCommitment, Commitment, CommitmentRow, Effect, KernelState, PromiseEvidence, PromiseTerms, Rule, SanitizedEvent } from '@sundial/kernel/types.js';
import { rowFor } from './commitment-track.js';
import type { MeetingPromise } from './promise-extract.js';
import { briefsOf, meetingPrepKey } from '@sundial/kernel/briefs.js';
import { counterpartyIn, defaultDue, keyNouns, namesDeliverable, parseDue, parseStatedPromise, samePerson } from './promise-terms.js';
import { openAsk } from '@sundial/helpers/loops.js';
import { PAST, deliverableShape, promisePhrase } from '@sundial/kernel/promise-words.js';

/** Open promises kept in state. Its own cap: twenty branch threads can no longer evict one (U1-F22). */
export const MAX_PROMISES = 20;
const MAX_RECENT_CLOSED = 20;
const QUOTE_MAX = 120;

type Result = { state: KernelState; effects: Effect[] };

const clipQuote = (text: string): string => (text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1).trimEnd()}…` : text);

/** What a promise is called on a row: its deliverable, with the person when there is one. */
export function promiseName(terms: Pick<PromiseTerms, 'direction' | 'counterparty' | 'deliverable'>): string {
  if (terms.direction === 'awaiting' && !terms.counterparty) return `Owed to you: ${deliverableShape(terms.deliverable).thing}`;
  return promisePhrase(terms.direction, terms.deliverable, terms.counterparty);
}

export interface OpenInput {
  id: string;
  source: Commitment['source'];
  direction: PromiseTerms['direction'];
  counterparty: string | null;
  deliverable: string;
  quote: string;
  dueText: string | null;
  /** When the words were said — what "morgen" is resolved against. */
  saidAt: string;
  heardAt?: { title: string; start: string } | null;
  confirmed: boolean;
  projectId?: string | null;
  projectName?: string | null;
  heardIn?: { momentId: string; p: number };
}

/** The terms of a new promise. A due that was said wins; otherwise the default, until the calendar shows the next meeting with that person (X1). */
export function termsFor(input: OpenInput, tz: string): PromiseTerms {
  const said = parseDue(input.dueText, input.saidAt, tz);
  return {
    direction: input.direction,
    counterparty: input.counterparty,
    deliverable: input.deliverable,
    keys: keyNouns(input.deliverable),
    quote: clipQuote(input.quote),
    due: said ?? defaultDue(input.saidAt, tz),
    dueKind: said ? 'explicit' : 'default',
    ...(said ? {} : { defaultDue: defaultDue(input.saidAt, tz) }),
    heardAt: input.heardAt ?? null,
    nextMeeting: null,
    evidence: [],
    lastMailTo: null,
    confirmed: input.confirmed,
  };
}

/** A calendar event as the promise clock needs it. */
interface Upcoming {
  title: string;
  start: string;
  attendees: string[];
  isAllDay?: boolean;
}

/**
 * UC1-X1 — the next meeting is the deadline. For a promise with a person and
 * no said date, the first event after `after` that person is on. The owner's
 * own aliases never count as the person.
 */
export function nextMeetingWith(events: readonly Upcoming[], counterparty: string | null, after: string): { title: string; start: string } | null {
  if (!counterparty) return null;
  const from = Date.parse(after);
  const next = events
    .filter((e) => !e.isAllDay && Date.parse(e.start) > from && e.attendees.some((a) => samePerson(a, counterparty)))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  return next ? { title: next.title, start: next.start } : null;
}

/** Terms with the deadline the calendar gives them, when it gives one. A said date is never replaced. */
function withMeetingDeadline(terms: PromiseTerms, events: readonly Upcoming[], after: string): PromiseTerms {
  if (terms.dueKind === 'explicit') return terms;
  // A meeting deadline that has come and gone stays the deadline: the promise
  // was due then. Moving it on to the meeting after would say it again at
  // every meeting with that person.
  if (terms.dueKind === 'next-meeting' && terms.due && Date.parse(terms.due) <= Date.parse(after)) return terms;
  const next = nextMeetingWith(events, terms.counterparty, after);
  if (next) return next.start === terms.due && terms.dueKind === 'next-meeting' ? terms : { ...terms, due: next.start, dueKind: 'next-meeting', nextMeeting: next };
  // The meeting it was due at dropped off the calendar before it happened: back to the default.
  if (terms.dueKind === 'next-meeting' && terms.nextMeeting && Date.parse(terms.nextMeeting.start) > Date.parse(after)) return { ...terms, dueKind: 'default', nextMeeting: null, due: terms.defaultDue ?? terms.due };
  return terms;
}

/** Every open promise, against the calendar the sensor just read (a week ahead). */
function onCalendar(state: KernelState, event: SanitizedEvent): Result {
  const raw = (event.payload as { events?: unknown }).events;
  if (!Array.isArray(raw)) return { state, effects: [] };
  const events: Upcoming[] = raw
    .map((e) => e as { title?: unknown; startDate?: unknown; attendees?: unknown; isAllDay?: unknown })
    // A date that does not parse is no meeting: `toISOString` would throw and stop the fold.
    .filter((e) => typeof e.startDate === 'string' && Number.isFinite(Date.parse(e.startDate)))
    .map((e) => ({ title: str(e.title) || 'a meeting', start: new Date(e.startDate as string).toISOString(), attendees: Array.isArray(e.attendees) ? e.attendees.filter((a): a is string => typeof a === 'string') : [], isAllDay: e.isAllDay === true }));
  let result: Result = { state, effects: [] };
  for (const thread of state.commitments.promises) {
    if (!thread.promise) continue;
    const next = withMeetingDeadline(thread.promise, events, event.ts);
    if (next === thread.promise) continue;
    result = chain(result, (s) => updatePromise(s, { ...thread, promise: next }));
  }
  return result;
}

/** Open one promise; the same id twice is the same promise. */
export function openPromise(state: KernelState, ts: string, input: OpenInput): Result {
  const known = state.commitments.promises.some((c) => c.id === input.id) || state.commitments.recentClosed.some((c) => c.id === input.id) || state.commitments.open.some((c) => c.id === input.id);
  if (known) return { state, effects: [] };
  const promise = withMeetingDeadline(termsFor(input, state.config.timezone), state.schedule.upcoming, ts);
  // U1-F27: the same thing, to the same person, promised again is one promise.
  // A new date said for it moves it (renegotiated, the old date kept); said
  // again without one, or confirmed in the owner's words, it is confirmed.
  const same = state.commitments.promises.find(
    (c) => c.promise && c.promise.direction === promise.direction && (c.promise.counterparty ?? '') === (promise.counterparty ?? '') && promise.keys.length > 0 && namesDeliverable(c.promise.keys, promise.deliverable),
  );
  if (same?.promise) {
    if (promise.dueKind === 'explicit' && promise.due && promise.due !== same.promise.due) return movePromise(state, same.id, promise.due, ts);
    return input.confirmed && !same.promise.confirmed ? updatePromise(state, { ...same, promise: { ...same.promise, confirmed: true } }) : { state, effects: [] };
  }
  const opened: Commitment = {
    id: input.id,
    name: promiseName(promise),
    source: input.source,
    branch: '',
    projectId: input.projectId ?? null,
    projectName: input.projectName ?? null,
    openedAt: ts,
    lastTouchedAt: ts,
    touches: 1,
    activeDays: [localDay(ts, state.config.timezone)],
    lastTouchUnpushed: 0,
    merged: false,
    pr: null,
    ...(input.heardIn ? { heardIn: input.heardIn } : {}),
    promise,
  };
  const opening: Result = {
    state: { ...state, commitments: { ...state.commitments, promises: [...state.commitments.promises, opened] } },
    effects: [{ type: 'WriteDB', table: 'commitments', row: rowFor(opened, null) }],
  };
  // Past the cap, the promise whose deadline is furthest behind closes as gone
  // quiet — written, so the row does not stay open in the table after the
  // fold has stopped tracking it.
  if (opening.state.commitments.promises.length <= MAX_PROMISES) return opening;
  const stalest = [...opening.state.commitments.promises].sort((a, b) => Date.parse(a.promise?.due ?? a.openedAt) - Date.parse(b.promise?.due ?? b.openedAt))[0]!;
  return chain(opening, (s) => closePromise(s, stalest.id, 'went-quiet', ts));
}

/** Replace one open promise, and write its row. */
export function updatePromise(state: KernelState, next: Commitment): Result {
  return {
    state: { ...state, commitments: { ...state.commitments, promises: state.commitments.promises.map((c) => (c.id === next.id ? next : c)) } },
    effects: [{ type: 'WriteDB', table: 'commitments', row: rowFor(next, null) }],
  };
}

/** Close one open promise for a reason. Unknown id: nothing. */
export function closePromise(state: KernelState, id: string, closedBecause: ClosedCommitment['closedBecause'], ts: string, patch: Partial<PromiseTerms> = {}): Result {
  const thread = state.commitments.promises.find((c) => c.id === id);
  if (!thread) return { state, effects: [] };
  const closed: ClosedCommitment = { ...thread, ...(thread.promise ? { promise: { ...thread.promise, ...patch } } : {}), lastTouchedAt: ts, closedAt: ts, closedBecause };
  return {
    state: {
      ...state,
      commitments: { ...state.commitments, promises: state.commitments.promises.filter((c) => c.id !== id), recentClosed: [...state.commitments.recentClosed, closed].slice(-MAX_RECENT_CLOSED) },
    },
    effects: [{ type: 'WriteDB', table: 'commitments', row: rowFor(closed, { closedAt: ts, closedBecause }) }],
  };
}

const chain = (first: Result, next: (state: KernelState) => Result): Result => {
  const second = next(first.state);
  return { state: second.state, effects: [...first.effects, ...second.effects] };
};

/** A meeting promise's id: from the meeting and its place in the answer, so a re-delivered answer opens nothing twice. */
export const meetingPromiseId = (start: string, meetingKey: string, i: number): string => `commitment:promise:${deriveId(start, meetingKey, 'promise', i)}`;

/** The direction a meeting promise runs, from who made it and what kind it is. */
export function directionOf(p: Pick<MeetingPromise, 'who' | 'kind'>): PromiseTerms['direction'] {
  if (p.who === 'owner') return p.kind === 'promise' ? 'owner' : 'awaiting';
  return p.kind === 'promise' ? 'awaiting' : 'request';
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The meeting pass's answer: every grounded promise opens, owed to the attendee
 * the model named, else the one the words name, else — in a 1:1 — the other
 * person. Unconfirmed until the owner says so (X3). Ids come from the meeting
 * and the position, so a re-delivered answer opens nothing twice.
 */
function openFromMeeting(state: KernelState, event: SanitizedEvent): Result {
  const p = event.payload as { meetingKey?: unknown; title?: unknown; start?: unknown; end?: unknown; attendees?: unknown; promises?: unknown };
  const meetingKey = str(p.meetingKey);
  const start = str(p.start);
  if (meetingKey === '' || !Number.isFinite(Date.parse(start)) || !Array.isArray(p.promises)) return { state, effects: [] };
  const attendees = Array.isArray(p.attendees) ? p.attendees.filter((a): a is string => typeof a === 'string') : [];
  const end = Number.isFinite(Date.parse(str(p.end))) ? str(p.end) : event.ts;
  let result: Result = { state, effects: [] };
  (p.promises as MeetingPromise[]).forEach((mp, i) => {
    if (typeof mp?.quote !== 'string' || typeof mp.what !== 'string') return;
    const counterparty = (typeof mp.to === 'string' && mp.to.trim() !== '' ? mp.to.trim() : null) ?? counterpartyIn(mp.quote, attendees, state.config.ownerAliases);
    result = chain(result, (s) =>
      openPromise(s, event.ts, {
        id: meetingPromiseId(start, meetingKey, i),
        source: 'meeting',
        direction: directionOf(mp),
        counterparty,
        deliverable: mp.what.trim(),
        quote: mp.quote,
        dueText: typeof mp.due === 'string' ? mp.due : null,
        saidAt: end,
        heardAt: { title: str(p.title) || 'a meeting', start },
        confirmed: false,
      }),
    );
  });
  return result;
}

/**
 * `commitment:heard`: the J4.4 per-moment shape (`{momentId, text, p}`), kept
 * so the log it already wrote replays; and (UC1) a promise stated outright —
 * `{source: chat|owner, id, quote, counterparty, deliverable, dueText}`.
 */
function openHeard(state: KernelState, event: SanitizedEvent): Result {
  const p = event.payload as Record<string, unknown>;
  if (typeof p.momentId === 'string' && typeof p.text === 'string' && typeof p.p === 'number') {
    const text = p.text.trim();
    if (text === '') return { state, effects: [] };
    return openPromise(state, event.ts, {
      id: `commitment:speech:${p.momentId}`,
      source: 'speech',
      direction: 'owner',
      counterparty: null,
      deliverable: text,
      quote: text,
      dueText: text,
      saidAt: event.ts,
      confirmed: false,
      projectId: typeof p.projectId === 'string' ? p.projectId : null,
      projectName: typeof p.projectName === 'string' ? p.projectName : null,
      heardIn: { momentId: p.momentId, p: p.p },
    });
  }
  const deliverable = str(p.deliverable);
  const source = p.source === 'chat' || p.source === 'owner' || p.source === 'reminder' ? p.source : null;
  if (!source || deliverable === '') return { state, effects: [] };
  const direction = p.direction === 'awaiting' || p.direction === 'request' ? p.direction : 'owner';
  return openPromise(state, event.ts, {
    id: str(p.id) || `commitment:promise:${deriveId(event.ts, event.id, 'promise')}`,
    source,
    direction,
    counterparty: str(p.counterparty) || null,
    deliverable,
    quote: str(p.quote) || deliverable,
    dueText: str(p.dueText) || null,
    saidAt: event.ts,
    confirmed: true,
  });
}

const MAX_EVIDENCE = 6;

/** What one event says about one open promise: evidence, and the last mail to its counterparty. */
interface Sighting {
  evidence?: PromiseEvidence;
  lastMailTo?: { at: string; subject: string };
}

/** When the thing an event reports happened: its own timestamp where it carries one (a back-filled mail), else the event's. */
const happenedAt = (event: SanitizedEvent): string => {
  const t = (event.payload as { timestamp?: unknown }).timestamp;
  return typeof t === 'string' && Number.isFinite(Date.parse(t)) ? t : event.ts;
};

/** A caption saying the thing went across: "I've shared it", "here's the link", "ik heb het gestuurd". */
const SHARED = /\b(shared|sent|sending|sharing|here'?s the|here is the|link|gedeeld|gestuurd|stuur ik nu|deel ik nu|hierbij)\b/i;

const shorten = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * UC1-X2 — the deliverable is the proof. Deterministic: the deliverable's key
 * nouns (`keys`, read when it opened) in the name of a commit, a branch or a
 * PR, a file created or changed, a tab's title, a Meet caption saying it was
 * shared, or a mail to the counterparty. A mail to them about something else
 * is cited and closes nothing. The model judge (a moment's resolve slot) is
 * the fallback for a promise whose words named nothing matchable.
 */
function sightingFor(thread: Commitment, event: SanitizedEvent): Sighting | null {
  const terms = thread.promise;
  if (!terms) return null;
  const at = happenedAt(event);
  if (Date.parse(at) < Date.parse(thread.openedAt)) return null;
  const keys = terms.keys;
  const owed = terms.direction !== 'awaiting';
  const p = event.payload as Record<string, unknown>;
  const said = (kind: PromiseEvidence['kind'], text: string, strong = true): Sighting => ({ evidence: { kind, at, strong, text: shorten(text) } });

  if (event.type === 'mail:sent' && owed) {
    const subject = str(p.subject);
    const to = Array.isArray(p.recipients) ? p.recipients.map((r) => str((r as { to?: unknown } | null)?.to)).filter(Boolean) : [];
    const toThem = terms.counterparty !== null && to.some((t) => samePerson(t, terms.counterparty));
    const about = namesDeliverable(keys, subject);
    if (toThem) return { ...said(about ? 'mail' : 'mail-weak', `mail to ${terms.counterparty}: ${subject || '(no subject)'}`, about), lastMailTo: { at, subject } };
    return about ? said('mail-weak', `mail to ${to[0] ?? 'someone'} about it: ${subject}`, false) : null;
  }
  if (event.type === 'mail:received') {
    const bearing = mailBearing(thread, str(p.from), str(p.subject));
    if (bearing === null || bearing === 'contact') return null;
    // Their fresh mail naming the thing keeps what THEY owed. A reply in the thread, or mail about what the owner
    // owed, is a sign, not proof — "Re: the numbers" may be "Friday, sorry", and "the draft?" may be "where is it?".
    return said(bearing === 'keeps' ? 'reply' : 'mail-weak', `mail from ${str(p.from)}: ${str(p.subject)}`, bearing === 'keeps');
  }
  if (!owed || keys.length === 0) return null;
  if (event.type === 'git:commit') {
    const line = `${str(p.commitLine)} ${str(p.branch)}`;
    return namesDeliverable(keys, line) ? said('commit', `commit ${str(p.commitLine).slice(0, 60)}`) : null;
  }
  if (event.type === 'git:status') return namesDeliverable(keys, str(p.branch)) ? said('branch', `branch ${str(p.branch)}`) : null;
  if (event.type === 'git:pr-status') return namesDeliverable(keys, `${str(p.title)} ${str(p.branch)}`) ? said('pr', `PR #${String(p.number ?? '?')} ${str(p.title)}`) : null;
  if (event.type === 'file:changed') {
    const changes = Array.isArray(p.changes) ? (p.changes as { relPath?: unknown }[]) : [];
    const hit = changes.map((c) => str(c?.relPath)).find((rel) => rel !== '' && namesDeliverable(keys, rel.split('/').pop() ?? rel));
    return hit ? said('file', `file ${hit}`) : null;
  }
  if (event.type === 'browser:tab' || event.type === 'document:opened') return namesDeliverable(keys, str(p.title)) ? said('tab', `${event.type === 'browser:tab' ? 'tab' : 'document'} "${str(p.title)}"`) : null;
  if (event.type === 'browser:arc-space') {
    const tabs = Array.isArray(p.tabs) ? (p.tabs as { title?: unknown }[]) : [];
    const hit = tabs.map((t) => str(t?.title)).find((title) => namesDeliverable(keys, title));
    return hit ? said('tab', `Arc tab "${hit}"`) : null;
  }
  if (event.type === 'page:text' && p.host === 'meet.google.com') {
    const line = str(p.text)
      .split(/\n|(?<=[.!?])\s+/)
      .find((l) => SHARED.test(l) && namesDeliverable(keys, l));
    return line ? said('caption', `Meet caption: ${line}`) : null;
  }
  return null;
}

/**
 * Lane B (#17): what a received mail says about one open promise. `keeps`: the
 * person who owed it sent a fresh mail naming the deliverable. `about`: it names
 * the deliverable but proves nothing (a reply in the thread, or mail about what
 * the owner owes). `contact`: from the person, about something else. Null: not
 * from them.
 */
export function mailBearing(thread: Commitment, from: string, subject: string): 'keeps' | 'about' | 'contact' | null {
  const terms = thread.promise;
  if (!terms?.counterparty || !samePerson(from, terms.counterparty)) return null;
  if (!namesDeliverable(terms.keys, subject)) return 'contact';
  return terms.direction === 'awaiting' && !MAIL_PREFIX.test(subject.trim()) ? 'keeps' : 'about';
}

/** Every open promise the event bears on: a strong sighting closes it as kept, a weak one is cited. */
function applyEvidence(state: KernelState, event: SanitizedEvent): Result {
  let result: Result = { state, effects: [] };
  for (const thread of state.commitments.promises) {
    const seen = sightingFor(thread, event);
    if (!seen) continue;
    const terms = thread.promise!;
    const duplicate = seen.evidence && terms.evidence.some((e) => e.kind === seen.evidence!.kind && e.text === seen.evidence!.text);
    const evidence = seen.evidence && !duplicate ? [...terms.evidence, seen.evidence].slice(-MAX_EVIDENCE) : terms.evidence;
    const patch: Partial<PromiseTerms> = { evidence, ...(seen.lastMailTo ? { lastMailTo: seen.lastMailTo } : {}) };
    if (seen.evidence?.strong) {
      result = chain(result, (s) => closePromise(s, thread.id, 'kept', event.ts, patch));
      continue;
    }
    if (duplicate && !seen.lastMailTo) continue;
    result = chain(result, (s) => {
      const current = s.commitments.promises.find((c) => c.id === thread.id);
      return current ? updatePromise(s, { ...current, lastTouchedAt: event.ts, promise: { ...current.promise!, ...patch } }) : { state: s, effects: [] };
    });
  }
  return result;
}

// ── The promise clock (U1-F19) ────────────────────────────────────────────
//
// Its own clock, not `notable()`: a promise opens with one touch and is never
// touched again, so the branch rule's "two days and three sessions" never let
// one fade. A promise is due when it is due — said, the next meeting with the
// person (X1), or three working days — and that is the only test.

/** How long before a said or a meeting deadline the notice speaks (X1: "about an hour before"). */
export const SPEAK_BEFORE_MS = 60 * 60_000;
/** After the deadline with nothing seen, this long before the owner is asked whether it was kept (U1-F32). */
export const ASK_AFTER_MS = 2 * 24 * 60 * 60_000;
/** Open and unanswered this long past its deadline, it closes as gone quiet. */
export const PROMISE_STALE_MS = 14 * 24 * 60 * 60_000;

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A day the owner reads: a weekday within the week, else the date. */
function dayOf(ts: string, now: string, tz: string): string {
  const days = (Date.parse(now) - Date.parse(ts)) / 86_400_000;
  if (localDay(ts, tz) === localDay(now, tz)) return 'today';
  return days < 6.5 ? WEEKDAY_NAMES[localWeekday(ts, tz)]! : localDay(ts, tz);
}

/** Who, as the owner knows them: the name they gave a hash, a name, or null for a hash they never named — never quote a hash at a person. */
export function whoOf(state: KernelState, counterparty: string | null): string | null {
  if (!counterparty) return null;
  const named = state.memory.aliasNames?.[counterparty] ?? counterparty;
  return /^person-[0-9a-f]{10}$/.test(named) ? null : named;
}

/** "The draft is not sent." — the owner's own sentence for a promise still open. */
export function notDone(deliverable: string): string {
  const shape = deliverableShape(deliverable);
  const verb = shape.verb ? PAST[shape.verb] : undefined;
  const thing = shape.thing;
  const last = thing.split(/\s+/).pop() ?? '';
  const plural = /[^s]s$/i.test(last) && last.length > 3;
  return `${thing.charAt(0).toUpperCase()}${thing.slice(1)} ${plural ? 'are' : 'is'} not ${verb ?? 'sent'}`;
}

/** U1-F21: the absence, from the sent log rather than a model — "No mail to Mira since Tuesday." With the channels that cannot be seen. */
export function absenceOf(state: KernelState, thread: Commitment, now: string): string | null {
  const terms = thread.promise!;
  const who = whoOf(state, terms.counterparty) ?? (terms.counterparty ? 'them' : null);
  if (!who) return null;
  const tz = state.config.timezone;
  if (terms.direction === 'awaiting') return `Nothing from ${who} about it since ${dayOf(thread.openedAt, now, tz)}`;
  if (terms.lastMailTo) return `Your last mail to ${who}, ${dayOf(terms.lastMailTo.at, now, tz)}, was about "${shorten(terms.lastMailTo.subject, 50)}"`;
  return `No mail to ${who} since ${dayOf(thread.openedAt, now, tz)}`;
}

/** The notice's words: the owner's sentence, the words it was made in, and what cannot be seen. Lane B's meeting prep says the same words when the promise is due at the meeting. */
export function fadingWords(state: KernelState, thread: Commitment, now: string, deadline: string, before: boolean): { observation: string; evidence: string[] } {
  const terms = thread.promise!;
  const tz = state.config.timezone;
  const who = whoOf(state, terms.counterparty);
  const clock = formatClock(deadline, tz);
  const event = { ts: now };
  const lead =
    terms.direction === 'awaiting'
      ? `${who ?? 'Someone'} owes you ${terms.deliverable}${before ? `, due ${clock}` : `, due ${dayOf(deadline, event.ts, tz)}`}`
      : before && terms.dueKind === 'next-meeting' && terms.nextMeeting
        ? `You see ${who ?? 'them'} at ${clock}. ${notDone(terms.deliverable)}`
        : before
          ? `${notDone(terms.deliverable)}${who ? ` — due to ${who}` : ''} at ${clock}`
          : `${notDone(terms.deliverable)}${who ? ` for ${who}` : ''}, promised ${dayOf(thread.openedAt, event.ts, tz)}`;
  const absence = absenceOf(state, thread, event.ts);
  return {
    observation: `${lead}.${absence ? ` ${absence}.` : ''}`,
    evidence: [
      `"${terms.quote}"`,
      terms.heardAt ? `said in ${terms.heardAt.title}, ${dayOf(terms.heardAt.start, event.ts, tz)}` : `${thread.source === 'chat' ? 'told to Gnomon' : 'opened'} ${dayOf(thread.openedAt, event.ts, tz)}`,
      `due ${terms.dueKind === 'explicit' ? 'as said' : terms.dueKind === 'next-meeting' ? `at the next meeting with ${who ?? 'them'}${terms.nextMeeting ? ` (${terms.nextMeeting.title})` : ''}` : 'by default, three working days'}`,
      ...terms.evidence.filter((e) => !e.strong).map((e) => e.text),
      'WhatsApp, Slack and calls are not read',
      ...(terms.confirmed ? [] : ['found by the meeting pass, not confirmed']),
    ],
  };
}

/** How much a promise's notice weighs: before the deadline it is worth an interruption (F30, X1); after it, a line for the next conversation. */
export function fadingWeight(thread: Commitment, now: string, deadline: string, before: boolean): { surprise: number; precision: number } {
  const lateDays = Math.max(0, (Date.parse(now) - Date.parse(deadline)) / 86_400_000);
  // A promise the owner stated or confirmed is surer than one a model found and nobody confirmed.
  return { surprise: before ? 1.5 : 0.8 + 0.4 * Math.min(1, lateDays / 7), precision: thread.promise!.confirmed ? 1 : thread.source === 'speech' ? 0.5 : 0.8 };
}

/** The notice: the owner's sentence, the words it was made in, and what cannot be seen. */
function fadingNotice(state: KernelState, thread: Commitment, event: SanitizedEvent, deadline: string, before: boolean): Effect {
  const terms = thread.promise!;
  const words = fadingWords(state, thread, event.ts, deadline, before);
  return {
    type: 'EmitEvent',
    event: {
      id: deriveId(event.ts, event.id, 'promise-track', `fading:${thread.id}:${deadline}`),
      type: 'notice:candidate',
      ts: event.ts,
      payload: {
        timestamp: event.ts,
        shape: 'transition',
        kind: 'promise-fading',
        // U1-F31: habituation per person, so the gate learns how the owner takes being reminded about THEM.
        key: `promise-fading:${terms.counterparty ?? thread.id}`,
        ...fadingWeight(thread, event.ts, deadline, before),
        valueHalfLifeMs: before ? SPEAK_BEFORE_MS : null,
        observation: words.observation,
        evidence: words.evidence,
        concerns: [thread.id],
      },
    },
  };
}

/** One promise in a line the owner reads: "the draft for Mira, by Tuesday". Never a hash. */
export function promiseLine(state: KernelState, thread: Commitment): string {
  const terms = thread.promise;
  if (!terms) return thread.name;
  const who = whoOf(state, terms.counterparty);
  const due = terms.dueKind === 'explicit' && terms.due ? `, by ${dayOf(terms.due, thread.openedAt, state.config.timezone)}` : '';
  return `${promisePhrase(terms.direction, terms.deliverable, who)}${due}`;
}

/** A question put to the owner when a promise is past due and nothing was seen (U1-F32): ask, never guess "broken". */
function keptQuestion(state: KernelState, thread: Commitment, event: SanitizedEvent): Effect {
  const terms = thread.promise!;
  const who = whoOf(state, terms.counterparty);
  const askId = `owner-ask:promise-${deriveId(thread.openedAt, thread.id, 'kept').slice(0, 12)}`;
  const { verb, thing } = deliverableShape(terms.deliverable);
  const question =
    terms.direction === 'awaiting' ? `Did ${who ?? 'they'} ${verb ?? 'deliver'} ${thing}?` : verb ? `Did you ${promisePhrase('owner', terms.deliverable, who)}?` : who ? `Did ${thing} reach ${who}?` : `Did you get to ${thing}?`;
  return {
    type: 'EmitEvent',
    event: {
      id: deriveId(event.ts, event.id, 'promise-track', `ask:${thread.id}`),
      type: 'ask:owner-opened',
      ts: event.ts,
      payload: {
        askId,
        question,
        reason: [absenceOf(state, thread, event.ts), `due ${dayOf(terms.due ?? thread.openedAt, event.ts, state.config.timezone)}`].filter(Boolean).join('; '),
        choices: terms.direction === 'awaiting' ? ['Yes, it came', 'Moved — tell me when', 'Not kept', 'Dropped'] : ['Sent it', 'Moved — tell me when', 'Not kept', 'Dropped'],
        promiseAsk: { kind: 'kept', ids: [thread.id] },
      },
    },
  };
}

/** Every open promise, once a tick: speak before or after its deadline, ask when it is well past, close it when it has gone quiet. */
function tickClock(state: KernelState, event: SanitizedEvent): Result {
  const now = Date.parse(event.ts);
  let result: Result = { state, effects: [] };
  let asked = openAsk(state) !== null || state.commitments.promiseAsk !== null;
  for (const thread of state.commitments.promises) {
    const terms = thread.promise;
    if (!terms?.due) continue;
    const deadline = Date.parse(terms.due);
    if (now - deadline >= PROMISE_STALE_MS) {
      result = chain(result, (s) => closePromise(s, thread.id, 'went-quiet', event.ts));
      continue;
    }
    const firm = terms.dueKind !== 'default';
    const before = firm && now < deadline && deadline - now <= SPEAK_BEFORE_MS;
    if (terms.spokeFor !== terms.due && (before || now >= deadline)) {
      // Lane B: before the meeting it is due at, the meeting's prep says it — one notice per meeting.
      // Only while that prep has not been said yet: a promise made after it still speaks for itself.
      const at = before && terms.dueKind === 'next-meeting' ? terms.nextMeeting : null;
      const prepSays = !!at && !briefsOf(result.state).done[meetingPrepKey(at.title, at.start)];
      const notice = prepSays ? [] : [fadingNotice(result.state, thread, event, terms.due, before)];
      result = chain(result, (s) => {
        const u = updatePromise(s, { ...thread, promise: { ...terms, spokeFor: terms.due! } });
        return { state: u.state, effects: [...notice, ...u.effects] };
      });
      continue;
    }
    if (!asked && !terms.askedAt && now - deadline >= ASK_AFTER_MS) {
      asked = true;
      const question = keptQuestion(result.state, thread, event);
      result = chain(result, (s) => {
        const u = updatePromise(s, { ...thread, promise: { ...terms, askedAt: event.ts } });
        return { state: u.state, effects: [question, ...u.effects] };
      });
    }
  }
  return result;
}

// ── The owner's word (U1-F27 F28 F29 F32) ─────────────────────────────────

/** Move a promise to a new due date, keeping the old one (U1-F27: renegotiated, not broken). */
export function movePromise(state: KernelState, id: string, due: string, ts: string): Result {
  const thread = state.commitments.promises.find((c) => c.id === id);
  if (!thread?.promise || thread.promise.due === due) return { state, effects: [] };
  const terms = thread.promise;
  const { spokeFor: _spoke, askedAt: _asked, ...rest } = terms;
  return updatePromise(state, { ...thread, lastTouchedAt: ts, promise: { ...rest, due, dueKind: 'explicit', moved: [...(terms.moved ?? []), ...(terms.due ? [terms.due] : [])].slice(-5), confirmed: true } });
}

const said = (answer: string, re: RegExp): boolean => re.test(answer.trim());
const KEPT = /^(sent it|yes|ja|done|kept|it came|gedaan|verstuurd)/i;
const NOT_KEPT = /^(not kept|no\b|nee\b|missed|broken|niet)/i;
const DROPPED = /^(dropped|not needed|no longer|vervallen|niet meer nodig)/i;

/** The owner's answer to "did the draft reach Mira?": kept, moved to a date they give, not kept, or dropped. A date without a verb is a move. */
function answerKept(state: KernelState, ids: string[], answer: string, ts: string): Result {
  let result: Result = { state, effects: [] };
  const due = parseDue(answer, ts, state.config.timezone);
  for (const id of ids) {
    const thread = result.state.commitments.promises.find((c) => c.id === id);
    if (!thread?.promise) continue;
    const reply: PromiseEvidence = { kind: 'reply', at: ts, strong: true, text: `you said: ${shorten(answer, 60)}` };
    const evidence = [...thread.promise.evidence, reply].slice(-MAX_EVIDENCE);
    if (said(answer, DROPPED)) result = chain(result, (st) => closePromise(st, id, 'dropped', ts, { evidence }));
    else if (said(answer, NOT_KEPT)) result = chain(result, (st) => closePromise(st, id, 'broken', ts, { evidence }));
    else if (due) result = chain(result, (st) => movePromise(st, id, due, ts));
    else if (said(answer, KEPT)) result = chain(result, (st) => closePromise(st, id, 'kept', ts, { evidence }));
  }
  return result;
}

/** A question about promises is remembered when it opens, so its answer can be read after `ownerAsk` has closed it. */
function rememberAsk(state: KernelState, event: SanitizedEvent): Result {
  const p = event.payload as { askId?: unknown; promiseAsk?: { kind?: unknown; ids?: unknown; attendees?: unknown; meeting?: unknown } };
  const pa = p.promiseAsk;
  const askId = str(p.askId);
  // `ownerAsk` folds later on this same event and keeps the ask only when none is open, so an ask it will drop is not remembered.
  if (!pa || askId === '' || openAsk(state) !== null) return { state, effects: [] };
  const ids = Array.isArray(pa.ids) ? pa.ids.filter((i): i is string => typeof i === 'string') : [];
  const attendees = Array.isArray(pa.attendees) ? pa.attendees.filter((a): a is string => typeof a === 'string') : [];
  const m = pa.meeting as { title?: unknown; start?: unknown } | null | undefined;
  const meeting = m && typeof m.title === 'string' && typeof m.start === 'string' ? { title: m.title, start: m.start } : null;
  return { state: { ...state, commitments: { ...state.commitments, promiseAsk: { askId, kind: pa.kind === 'meeting' ? 'meeting' : 'kept', ids, attendees, meeting } } }, effects: [] };
}

/**
 * UC1-X3: the answer to "did you promise anything?". With promises the meeting
 * pass found: Track confirms them, Only the first keeps one, Not a promise
 * drops them (labels for how good the pass is). Without: a "yes" in the
 * owner's own words opens the promise they describe, owed to whoever of the
 * meeting's people it names, due when they say.
 */
function answerMeeting(state: KernelState, pending: NonNullable<KernelState['commitments']['promiseAsk']>, answer: string, event: SanitizedEvent): Result {
  let result: Result = { state, effects: [] };
  const ids = pending.ids;
  if (ids.length > 0 && /^(track|yes|ja|klopt)/i.test(answer)) {
    for (const id of ids) {
      result = chain(result, (s) => {
        const c = s.commitments.promises.find((x) => x.id === id);
        return c?.promise ? updatePromise(s, { ...c, promise: { ...c.promise, confirmed: true } }) : { state: s, effects: [] };
      });
    }
    return result;
  }
  if (ids.length > 0 && /^only the first/i.test(answer)) {
    const [first, ...rest] = ids;
    result = chain(result, (s) => {
      const c = s.commitments.promises.find((x) => x.id === first);
      return c?.promise ? updatePromise(s, { ...c, promise: { ...c.promise, confirmed: true } }) : { state: s, effects: [] };
    });
    for (const id of rest) result = chain(result, (s) => closePromise(s, id, 'dropped', event.ts));
    return result;
  }
  if (ids.length > 0 && /^(not (a )?promises?|no\b|nee\b)/i.test(answer)) {
    for (const id of ids) result = chain(result, (s) => closePromise(s, id, 'dropped', event.ts));
    return result;
  }
  const stated = parseStatedPromise(answer, { ts: event.ts, tz: state.config.timezone, attendees: pending.attendees, ownerAliases: state.config.ownerAliases });
  if (!stated) return result;
  return openPromise(state, event.ts, {
    id: `commitment:promise:${deriveId(event.ts, event.id, 'promise', 'told')}`,
    source: 'owner',
    direction: 'owner',
    counterparty: stated.counterparty,
    deliverable: stated.deliverable,
    quote: answer,
    dueText: stated.dueText,
    saidAt: event.ts,
    heardAt: pending.meeting,
    confirmed: true,
  });
}

function answerAsk(state: KernelState, event: SanitizedEvent): Result {
  const pending = state.commitments.promiseAsk;
  const p = event.payload as { askId?: unknown; answer?: unknown };
  if (!pending || (str(p.askId) !== '' && str(p.askId) !== pending.askId)) return { state, effects: [] };
  const answer = str(p.answer);
  if (answer === '') return { state, effects: [] };
  const cleared = { ...state, commitments: { ...state.commitments, promiseAsk: null } };
  return pending.kind === 'meeting' ? answerMeeting(cleared, pending, answer, event) : answerKept(cleared, pending.ids, answer, event.ts);
}

/** An expired question is forgotten with the ask, so the next one can be put. */
const forgetExpired = (state: KernelState): Result =>
  state.commitments.promiseAsk && openAsk(state)?.askId !== state.commitments.promiseAsk.askId ? { state: { ...state, commitments: { ...state.commitments, promiseAsk: null } }, effects: [] } : { state, effects: [] };

/** U1-F29: the owner closing a promise by hand, with a reason — kept, not kept, dropped — or moving it to a new date. */
function closeByOwner(state: KernelState, event: SanitizedEvent): Result {
  const p = event.payload as { id?: unknown; reason?: unknown; due?: unknown };
  const id = str(p.id);
  const due = str(p.due);
  if (due !== '' && Number.isFinite(Date.parse(due))) return movePromise(state, id, new Date(due).toISOString(), event.ts);
  const reason = p.reason === 'kept' || p.reason === 'broken' || p.reason === 'dropped' ? p.reason : 'owner';
  return closePromise(state, id, reason, event.ts);
}

// ── Apple Reminders (U1-F38) ──────────────────────────────────────────────

/** A reminder Gnomon made for a promise (through the gated tool): the promise takes its id and its native due date. */
function onReminderMade(state: KernelState, event: SanitizedEvent): Result {
  const p = event.payload as { tool?: unknown; reminderId?: unknown; promiseId?: unknown; due?: unknown };
  if (p.tool !== 'reminder_create' || str(p.reminderId) === '') return { state, effects: [] };
  const thread = state.commitments.promises.find((c) => c.id === str(p.promiseId));
  if (!thread?.promise) return { state, effects: [] };
  const due = str(p.due);
  const dated = due !== '' && Number.isFinite(Date.parse(due)) ? { due: new Date(due).toISOString(), dueKind: 'explicit' as const } : {};
  return updatePromise(state, { ...thread, promise: { ...thread.promise, ...dated, reminderId: str(p.reminderId), confirmed: true } });
}

/**
 * The reminders list, when it changed. A mirrored reminder completed keeps the
 * promise; its due date, moved in Reminders, moves the promise. A reminder the
 * owner made by hand that names an open promise's thing (and its person, when
 * it has one) becomes that promise's mirror.
 */
function onReminders(state: KernelState, event: SanitizedEvent): Result {
  const raw = (event.payload as { items?: unknown }).items;
  if (!Array.isArray(raw)) return { state, effects: [] };
  const items = raw.map((r) => r as { id?: unknown; text?: unknown; due?: unknown; completed?: unknown; completedAt?: unknown }).filter((r) => typeof r.id === 'string');
  let result: Result = { state, effects: [] };
  for (const thread of state.commitments.promises) {
    const terms = thread.promise;
    if (!terms) continue;
    const first = terms.counterparty?.split(' ')[0]?.toLowerCase();
    const item = terms.reminderId
      ? items.find((r) => r.id === terms.reminderId)
      : items.find((r) => r.completed !== true && namesDeliverable(terms.keys, str(r.text)) && (!first || str(r.text).toLowerCase().includes(first)));
    if (!item) continue;
    if (item.completed === true) {
      const evidence = [...terms.evidence, { kind: 'reminder' as const, at: str(item.completedAt) || event.ts, strong: true, text: `reminder completed: ${shorten(str(item.text), 60)}` }].slice(-MAX_EVIDENCE);
      result = chain(result, (s) => closePromise(s, thread.id, 'kept', event.ts, { evidence, reminderId: str(item.id) }));
      continue;
    }
    const due = typeof item.due === 'string' && Number.isFinite(Date.parse(item.due)) ? new Date(item.due).toISOString() : null;
    if (terms.reminderId === item.id && (!due || due === terms.due)) continue;
    result = chain(result, (s) => {
      const current = s.commitments.promises.find((c) => c.id === thread.id);
      if (!current?.promise) return { state: s, effects: [] };
      const moved = due && due !== current.promise.due ? movePromise(s, thread.id, due, event.ts) : { state: s, effects: [] as Effect[] };
      const after = moved.state.commitments.promises.find((c) => c.id === thread.id)!;
      const u = updatePromise(moved.state, { ...after, promise: { ...after.promise!, reminderId: str(item.id) } });
      return { state: u.state, effects: [...moved.effects, ...u.effects] };
    });
  }
  return result;
}

// ── Promises and requests in mail subjects (U1-F5 F6 F7) ──────────────────

const MAIL_PREFIX = /^((re|fw|fwd|aw|antw|wg)\s*:\s*)+/i;
/** A sent subject that promises: "Draft coming Tuesday", "Numbers to follow", "Offerte volgt morgen". */
const SUBJECT_PROMISE = /\b(coming|to follow|follows|will follow|will send|i'll send|on its way|volgt|komt eraan|komt nog|stuur ik)\b/i;
/** A subject that asks: "Can you review the PR?", "Kun je de offerte checken?". */
const SUBJECT_REQUEST = /^(can|could|would|will) you\b|^(kun|kan|wil|zou) (je|jij|u)\b|^(please|graag|verzoek)\b/i;
const REQUEST_LEAD = /^((can|could|would|will) you( please)?|(kun|kan|wil|zou) (je|jij|u)( even)?|please|graag|verzoek:?)\s+/i;

/** The thing a subject names, without the promise or the ask around it. */
function subjectThing(subject: string, marker: RegExp): string {
  const bare = subject.replace(MAIL_PREFIX, '').trim();
  const at = bare.search(marker);
  const before = at > 0 ? bare.slice(0, at) : '';
  const thing = (before.trim() || bare.replace(marker, '').replace(REQUEST_LEAD, '')).replace(/[?!.]+$/, '').trim();
  return thing.length > 60 ? `${thing.slice(0, 59).trimEnd()}…` : thing;
}

/** People the owner meets: on a meeting of the last two days, or the next ten. A request from anyone else is a stranger's (or a tool's), not a colleague's. */
const metRecently = (state: KernelState, who: string): boolean =>
  Object.values(state.meetings.seen).some((m) => m.attendees.some((a) => samePerson(a, who))) || state.schedule.upcoming.some((m) => m.attendees.some((a) => samePerson(a, who)));

/**
 * A promise or a request in a subject line. Sent: "Draft coming Tuesday" is
 * a promise to the first recipient; "Can you check the numbers?" is the owner
 * waiting on them. Received: "Can you review the PR?" from someone the owner
 * meets is a request to the owner. Never a body — there is none.
 */
function openFromMail(state: KernelState, event: SanitizedEvent): Result {
  const p = event.payload as { subject?: unknown; recipients?: unknown; from?: unknown };
  const subject = str(p.subject);
  if (subject === '') return { state, effects: [] };
  const at = happenedAt(event);
  const bare = subject.replace(MAIL_PREFIX, '').trim();
  const open = (direction: PromiseTerms['direction'], counterparty: string | null, marker: RegExp) => {
    const deliverable = subjectThing(subject, marker);
    if (deliverable === '' || keyNouns(deliverable).length === 0) return { state, effects: [] };
    return openPromise(state, at, { id: `commitment:promise:${deriveId(at, event.id, 'mail-promise')}`, source: 'mail', direction, counterparty, deliverable, quote: subject, dueText: bare, saidAt: at, confirmed: false });
  };
  if (event.type === 'mail:sent') {
    const to = Array.isArray(p.recipients) ? p.recipients.map((r) => str((r as { to?: unknown } | null)?.to)).filter(Boolean) : [];
    if (to.length === 0 || subject !== bare) return { state, effects: [] }; // a reply's subject is the thread's, not a new promise
    if (SUBJECT_PROMISE.test(bare)) return open('owner', to[0]!, SUBJECT_PROMISE);
    if (SUBJECT_REQUEST.test(bare)) return open('awaiting', to[0]!, REQUEST_LEAD);
    return { state, effects: [] };
  }
  const from = str(p.from);
  if (event.type === 'mail:received' && subject === bare && SUBJECT_REQUEST.test(bare) && from !== '' && metRecently(state, from)) return open('request', from, REQUEST_LEAD);
  return { state, effects: [] };
}

/**
 * A one-time repair, run at boot: a promise heard aloud before `promiseTrack`
 * (J4.4) was opened by `commitmentTrack` as a branch-less thread in
 * `commitments.open`, with no terms. `openPromise` counts `open` as known, so
 * that id could never become a promise: it sat there until the 14-day sweep.
 * Each one moves to `promises`, with the terms the heard path gives today, as
 * of when it was said. Pure; a second run finds nothing to move.
 */
export function adoptHeardThreads(state: KernelState): Result & { moved: number } {
  const heard = state.commitments.open.filter((c) => c.source === 'speech' && !c.branch && !c.promise && c.name.trim() !== '');
  if (heard.length === 0) return { state, effects: [], moved: 0 };
  const ids = new Set(heard.map((c) => c.id));
  let result: Result = { state: { ...state, commitments: { ...state.commitments, open: state.commitments.open.filter((c) => !ids.has(c.id)) } }, effects: [] };
  for (const c of heard) {
    const text = c.name.trim();
    result = chain(result, (s) =>
      openPromise(s, c.openedAt, {
        id: c.id,
        source: 'speech',
        direction: 'owner',
        counterparty: null,
        deliverable: text,
        quote: text,
        dueText: text,
        saidAt: c.openedAt,
        confirmed: false,
        projectId: c.projectId,
        projectName: c.projectName,
        ...(c.heardIn ? { heardIn: c.heardIn } : {}),
      }),
    );
  }
  // Adopted, not newly heard: they fade in passing, but the "did you get to it?"
  // question is marked as asked, or four old sentences become four daily pushes.
  const openedAt = new Map(heard.map((c) => [c.id, c.openedAt]));
  const promises = result.state.commitments.promises.map((c) => (openedAt.has(c.id) && c.promise && !c.promise.askedAt ? { ...c, promise: { ...c.promise, askedAt: openedAt.get(c.id)! } } : c));
  const byId = new Map(promises.map((c) => [c.id, c]));
  // The table row carries the same terms, so a boot that reads the table back does not ask either.
  const effects = result.effects.map((e) => (e.type === 'WriteDB' && e.table === 'commitments' && openedAt.has((e.row as CommitmentRow).id) && byId.has((e.row as CommitmentRow).id) ? { ...e, row: rowFor(byId.get((e.row as CommitmentRow).id)!, null) } : e));
  result = { state: { ...result.state, commitments: { ...result.state.commitments, promises } }, effects };
  // One said twice is one promise (U1-F27): the copy's row closes, so the table holds no open row the fold has forgotten.
  const kept = new Set(result.state.commitments.promises.map((c) => c.id));
  const merged = heard.filter((c) => !kept.has(c.id)).map((c): Effect => ({ type: 'WriteDB', table: 'commitments', row: rowFor(c, { closedAt: c.lastTouchedAt, closedBecause: 'dropped' }) }));
  return { state: result.state, effects: [...result.effects, ...merged], moved: heard.length };
}

const EVIDENCE_EVENTS = new Set(['mail:sent', 'mail:received', 'git:commit', 'git:status', 'git:pr-status', 'file:changed', 'browser:tab', 'browser:arc-space', 'document:opened', 'page:text']);

export const promiseTrack: Rule = (state, event) => {
  if (event.type === 'clock:tick') return chain(forgetExpired(state), (s) => (s.commitments.promises.length === 0 ? { state: s, effects: [] } : tickClock(s, event)));
  if (event.type === 'mail:sent' || event.type === 'mail:received') return chain(state.commitments.promises.length === 0 ? { state, effects: [] } : applyEvidence(state, event), (s) => openFromMail(s, event));
  if (EVIDENCE_EVENTS.has(event.type)) return state.commitments.promises.length === 0 ? { state, effects: [] } : applyEvidence(state, event);
  if (event.type === 'meeting:promises') return openFromMeeting(state, event);
  if (event.type === 'action:performed') return onReminderMade(state, event);
  if (event.type === 'reminders:snapshot') return state.commitments.promises.length === 0 ? { state, effects: [] } : onReminders(state, event);
  if (event.type === 'calendar:upcoming') return state.commitments.promises.length === 0 ? { state, effects: [] } : onCalendar(state, event);
  if (event.type === 'commitment:heard') return openHeard(state, event);
  if (event.type === 'commitment:closed') return closeByOwner(state, event);
  if (event.type === 'ask:owner-opened') return rememberAsk(state, event);
  if (event.type === 'ask:owner-answered') return answerAsk(state, event);
  // The fan-out's resolve slot, with its second key (`applyMomentJudgement`): the model judge, kept as the fallback to the evidence below.
  if (event.type === 'commitment:resolved') {
    const p = event.payload as { id?: unknown; p?: unknown };
    const thread = state.commitments.promises.find((c) => c.id === str(p.id));
    if (!thread?.promise) return { state, effects: [] };
    const evidence = [...thread.promise.evidence, { kind: 'judge' as const, at: event.ts, strong: true, text: `a moment judged it kept (p ${typeof p.p === 'number' ? p.p.toFixed(2) : '?'})` }].slice(-6);
    return closePromise(state, thread.id, 'kept', event.ts, { evidence });
  }
  return { state, effects: [] };
};
