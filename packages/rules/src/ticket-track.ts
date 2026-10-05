import type { KernelState, Rule, TicketThread } from '@sundial/kernel/types.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { taskIdentity } from './entity-extract.js';

/**
 * One thread per ticket, stitched from every sense that can see a ticket key —
 * with no issue tracker connected at all.
 *
 * Measured 2026-08-28..09-27: 264 distinct keys in the log, 53 in two or more
 * sources, 16 in three or more. BOX-484 turned up in nine: window titles,
 * browser tabs, screen text, page text, commits, the branch, shell commands,
 * the PR, and the coding agent's branch. BOX-538 was on screen 360 times and
 * never got a branch. Nothing joined those sightings; this does.
 *
 * Bounded: MAX_TICKETS threads, days capped, and a thread not seen for
 * TICKET_HORIZON_DAYS is dropped on the day boundary. The rows themselves stay
 * in the log — `gnomon_signals contains=<key>` reads them.
 */
export const MAX_TICKETS = 100;
export const TICKET_HORIZON_DAYS = 30;
const MAX_DAYS = 30;
/** The rows `ticketTrack` reads, for a rebuild from the log. */
export const TICKET_SOURCE_TYPES = ['window:changed', 'browser:tab', 'screen:ocr', 'page:text', 'shell:command', 'audio:transcript', 'calendar:context-event', 'git:status', 'git:commit', 'git:pr-status', 'agent:session', 'agent:fleet', 'agent:turn'] as const;

/**
 * Strict: an uppercase project key and a number, as trackers write them in
 * prose. Not followed by another `-number`: `HQ-3-02` and `HQ-2-14` are
 * meeting rooms, and they were on the radar for five days.
 */
const TICKET = /\b([A-Z]{2,6})-(\d{1,6})\b(?!-\d)/g;
/** `AUDIT-2026`, `JUNI-2026`: a year, not an issue number. */
const YEAR = /^(19|20)\d\d$/;
/** Keys with the ticket shape that are not tickets: standards, versions, rooms, PR numbers, clocks. */
const NOT_KEYS = new Set(['UTF', 'ISO', 'SHA', 'RFC', 'GPT', 'CVE', 'RTM', 'PR', 'MP', 'HTTP', 'TLS', 'SSL', 'COVID', 'UTC', 'GMT', 'CET', 'CEST', 'AM', 'PM', 'ES', 'MD', 'NODE', 'IPV', 'WCAG', 'EN', 'NL', 'DSH']);

export function ticketKeys(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TICKET)) if (!NOT_KEYS.has(m[1]!) && m[2] !== '0' && !YEAR.test(m[2]!)) out.add(m[0]);
  return [...out];
}

/** A branch's ticket, case-insensitively, the way `entityExtract` names tasks. */
export function branchKey(branch: unknown): string | null {
  if (typeof branch !== 'string' || branch === '') return null;
  const id = taskIdentity(branch, '');
  return id && ticketKeys(id).length === 1 && ticketKeys(id)[0] === id ? id : null;
}

type Sighting = { source: string; keys: string[] };

/**
 * More keys than this in one text is a list — a board, a backlog, a search
 * result. Measured on the live log: one Jira board page carried 20+ keys, and
 * counting each as looked-at put every ticket on the board on the radar.
 */
export const LIST_VIEW_KEYS = 3;

/** A text's keys, split into the ones it is about and the ones it merely lists. */
function focusOrList(source: string, text: string, strong: string[] = []): Sighting[] {
  const keys = ticketKeys(text).filter((k) => !strong.includes(k));
  const list = keys.length + strong.length > LIST_VIEW_KEYS;
  return [
    { source, keys: strong },
    { source: list ? 'list' : source, keys },
  ];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function sightings(type: string, p: Record<string, unknown>): Sighting[] {
  switch (type) {
    case 'window:changed':
      return [{ source: 'window', keys: ticketKeys(str(p.windowTitle)) }];
    case 'browser:tab':
      return [{ source: 'browser', keys: ticketKeys(`${str(p.title)} ${str(p.url)}`) }];
    case 'screen:ocr':
      return focusOrList('screen', str(p.screenText));
    case 'page:text':
      return focusOrList('page', str(p.text), ticketKeys(`${str(p.title)} ${str(p.url)}`));
    case 'shell:command':
      return [{ source: 'shell', keys: ticketKeys(str(p.command)) }];
    case 'audio:transcript':
      return [{ source: 'speech', keys: ticketKeys(str(p.spokenText)) }];
    case 'agent:turn':
      return focusOrList('agent', str(p.text));
    case 'calendar:context-event':
      return [{ source: 'calendar', keys: ticketKeys(str((p.event as Record<string, unknown> | undefined)?.title)) }];
    default:
      return [];
  }
}

function touch(thread: TicketThread | undefined, id: string, source: string, ts: string, day: string): TicketThread {
  const t = thread ?? { id, firstSeen: ts, lastSeen: ts, days: [], sources: {}, stage: 'seen', commits: 0, pr: null };
  const sources = { ...t.sources, [source]: (t.sources[source] ?? 0) + 1 };
  // A key in a list was in view, not looked at: it is counted, but it is not a day.
  if (source === 'list') return { ...t, sources };
  const days = t.days.includes(day) ? t.days : [...t.days, day].slice(-MAX_DAYS);
  return { ...t, lastSeen: ts > t.lastSeen ? ts : t.lastSeen, days, sources };
}

const STAGE_RANK = { seen: 0, branch: 1, commit: 2, pr: 3 } as const;
const promote = (t: TicketThread, stage: TicketThread['stage']): TicketThread => (STAGE_RANK[stage] > STAGE_RANK[t.stage] ? { ...t, stage } : t);

function bounded(tickets: Record<string, TicketThread>): Record<string, TicketThread> {
  const ids = Object.keys(tickets);
  if (ids.length <= MAX_TICKETS) return tickets;
  const keep = ids.sort((a, b) => tickets[b]!.lastSeen.localeCompare(tickets[a]!.lastSeen)).slice(0, MAX_TICKETS);
  return Object.fromEntries(keep.map((id) => [id, tickets[id]!]));
}

function withTickets(state: KernelState, tickets: Record<string, TicketThread>) {
  return { state: { ...state, tickets: bounded(tickets) }, effects: [] };
}

export const ticketTrack: Rule = (state, event) => {
  const prior = state.tickets ?? {};
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const day = localDate(event.ts, state.config.timezone);

  if (event.type === 'day:boundary') {
    const cutoff = new Date(Date.parse(event.ts) - TICKET_HORIZON_DAYS * 86_400_000).toISOString();
    const kept = Object.fromEntries(Object.entries(prior).filter(([, t]) => t.lastSeen >= cutoff));
    return Object.keys(kept).length === Object.keys(prior).length ? { state, effects: [] } : withTickets(state, kept);
  }

  // Work on the ticket: a branch, a commit, a PR. These move the stage.
  if (event.type === 'git:status' || event.type === 'agent:session' || event.type === 'git:commit' || event.type === 'git:pr-status' || event.type === 'agent:fleet') {
    const next = { ...prior };
    const branches = event.type === 'agent:fleet' ? (Array.isArray(p.sessions) ? p.sessions.map((s) => (s as { branch?: unknown }).branch) : []) : [p.branch];
    const fromBranch = [...new Set(branches.map(branchKey).filter((k): k is string => k !== null))];
    const inText = event.type === 'git:commit' ? ticketKeys(str(p.commitLine)) : event.type === 'git:pr-status' ? ticketKeys(str(p.title)) : [];
    const ids = [...new Set([...fromBranch, ...inText])];
    if (ids.length === 0) return { state, effects: [] };
    // A branch sampled again is not a new sighting; only a commit, a PR state or a branch first seen counts.
    for (const id of ids) {
      const known = next[id];
      if (event.type === 'git:commit') next[id] = { ...promote(touch(known, id, 'git', event.ts, day), 'commit'), commits: (known?.commits ?? 0) + 1 };
      else if (event.type === 'git:pr-status') {
        const pr = { number: typeof p.number === 'number' ? p.number : null, state: str(p.state) || null, reviewState: str(p.reviewState) || null };
        next[id] = { ...promote(touch(known, id, 'pr', event.ts, day), 'pr'), pr };
      } else if (!known || known.stage === 'seen' || !known.days.includes(day)) next[id] = promote(touch(known, id, 'branch', event.ts, day), 'branch');
    }
    return withTickets(state, next);
  }

  const seen = sightings(event.type, p).filter((s) => s.keys.length > 0);
  if (seen.length === 0) return { state, effects: [] };
  const next = { ...prior };
  for (const { source, keys } of seen) for (const id of keys) next[id] = touch(next[id], id, source, event.ts, day);
  return withTickets(state, next);
};
