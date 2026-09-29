import { formatClock, localDate } from '@sundial/helpers/local-day.js';
import { describeMoment, describeRow, eventOf, namesAny, type LogRow, type MomentRow } from './flight-recorder.js';

/*
 * UC5 — "Did I…?": "did I reply to Mira / push BOX-484 / send the invoice /
 * go to the retro?" answered from the log, deterministically. The question is
 * read into an action, a ticket key, a person and the words the thing is
 * called; each row is checked against all of them; the answer is the rows,
 * strongest first, or "no sign of it" with what was searched and what the
 * record cannot see. No model reads the log here.
 */

export type DidIAction = 'mail' | 'push' | 'commit' | 'pr' | 'meet' | 'run' | 'open' | 'say' | 'any';

/** The verbs of each action, EN + NL, as the owner asks. The first one in the question wins. */
const VERBS: [DidIAction, RegExp][] = [
  ['pr', /\b(pull request|pr|merge|merged|gemerged|mergen)\b/],
  ['push', /\b(push|pushed|pushen|gepusht|gepushed)\b/],
  ['commit', /\b(commit|committed|gecommit|committen)\b/],
  ['mail', /\b(reply|replied|answer|answered|respond|responded|mail|mailed|email|emailed|e-mail|send|sent|write|wrote|forward|forwarded|antwoord|beantwoord|geantwoord|gereageerd|reageren|mailen|gemaild|stuur|sturen|gestuurd|verstuurd|schrijven|geschreven|doorgestuurd)\b/],
  ['meet', /\b(go|went|gone|attend|attended|join|joined|make it|show up|showed up|meeting|call|standup|stand-up|retro|sync|1:1|one-on-one|gegaan|geweest|bijgewoond|aangesloten|naar de)\b/],
  ['run', /\b(run|ran|deploy|deployed|test|tested|build|built|install|installed|migrate|migrated|draaien|gedraaid|uitgevoerd|gedeployed|getest)\b/],
  ['open', /\b(open|opened|read|look|looked|review|reviewed|check|checked|see|saw|watch|watched|bekeken|gelezen|geopend|gekeken|nagekeken)\b/],
  ['say', /\b(tell|told|say|said|mention|mentioned|ask|asked|promise|promised|vertel|verteld|gezegd|gevraagd|genoemd|beloofd)\b/],
];

/** Words that never say WHICH thing. EN + NL; the verbs above are dropped separately. */
const STOP = new Set(
  (
    'did i do have has had was were am is are be been the a an of to for and or in on at by with from that this these those it its my me you your we our ' +
    'he him his she her they them their about any some all just yet already ever today yesterday last week this morning afternoon evening tonight ' +
    'back up out off over into ' +
    'heb ik is de het een van voor en of in op aan bij met uit dat dit die deze er al nog wel ooit vandaag gisteren vorige deze week mijn je jij hij zij ze hem haar hun ' +
    'naar toe te om ben bent heeft hebt hadden had waren wel niet'
  ).split(/\s+/),
);

const TICKET = /\b[a-z][a-z0-9]{1,9}-\d{1,6}\b/gi;
const words = (text: string): string[] => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(TICKET, ' ').split(/[^\p{L}\p{N}:]+/u).filter(Boolean);
const stem = (w: string): string => (w.length > 4 && w.endsWith('en') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

/** A meeting's own name (retro, standup, sync) is how it is called: it stays a key, and is never a person. */
const MEETING_WORD = /^(retro|standup|stand-up|sync|1:1|planning|demo|review|refinement|kickoff|workshop)$/;
/** Days and months are capitalised and are nobody. EN + NL. */
const CALENDAR_WORD = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|january|february|march|april|may|june|july|august|september|october|november|december|januari|februari|maart|mei|juni|juli|augustus|oktober)$/;

export interface DidIQuestion {
  action: DidIAction;
  tickets: string[];
  /** The name as asked, and every name the record holds for that person. */
  person: { asked: string; names: string[] } | null;
  /** The thing's own words, stemmed: `["invoice"]`, `["retro"]`. */
  keys: string[];
}

/**
 * Every name the record holds for a person asked by name or first name.
 *
 * `aliasNames` maps an alias (a `person-<hash>`, a short name) to the name it
 * resolves to. "Mira" finds "Mira Bakker" (first name) and every alias
 * pointing at her; a name nobody holds comes back as itself.
 */
export function namesFor(asked: string, aliasNames: Record<string, string>, known: readonly string[] = []): string[] {
  const want = asked.trim().toLowerCase();
  if (want === '') return [];
  const first = (n: string) => n.trim().toLowerCase().split(/\s+/)[0] ?? '';
  const full = new Set<string>();
  for (const n of [...Object.values(aliasNames), ...known]) if (n.trim().toLowerCase() === want || first(n) === want) full.add(n.trim());
  for (const [alias, n] of Object.entries(aliasNames)) if (alias.toLowerCase() === want) full.add(n.trim());
  const out = new Set<string>([asked.trim(), ...full]);
  for (const [alias, n] of Object.entries(aliasNames)) if (full.has(n.trim())) out.add(alias);
  return [...out].slice(0, 20);
}

/**
 * Read a "did I…?" question. `person` wins when given; otherwise a word of the
 * question that is someone's name or first name in the record is the person.
 */
export function parseDidI(what: string, opts: { person?: string; aliasNames: Record<string, string>; people?: readonly string[] }): DidIQuestion {
  const lower = what.toLowerCase();
  let action: DidIAction = 'any';
  let at = Infinity;
  for (const [a, re] of VERBS) {
    const m = re.exec(lower);
    if (m && m.index < at) {
      at = m.index;
      action = a;
    }
  }
  const tickets = [...new Set((what.match(TICKET) ?? []).map((t) => t.toUpperCase()))];
  const firstNames = new Set([...Object.values(opts.aliasNames), ...(opts.people ?? [])].map((n) => n.trim().toLowerCase().split(/\s+/)[0] ?? '').filter((n) => n.length >= 3));
  const all = words(what);
  // Else the first capitalised word that is not the question's own grammar: a name
  // the record may hold only as a mail sender ("reply to Mira"), never as a person entity.
  const verbWord = (w: string) => VERBS.some(([, re]) => re.test(w.toLowerCase()));
  const capital = what
    .replace(TICKET, ' ')
    .split(/[^\p{L}\p{N}-]+/u)
    .slice(1)
    .find((w) => /^\p{Lu}\p{Ll}{2,}$/u.test(w) && !STOP.has(w.toLowerCase()) && !verbWord(w) && !MEETING_WORD.test(w.toLowerCase()) && !CALENDAR_WORD.test(w.toLowerCase()));
  const asked = opts.person?.trim() || all.find((w) => firstNames.has(w) && !STOP.has(w)) || capital;
  const person = asked ? { asked, names: namesFor(asked, opts.aliasNames, opts.people) } : null;
  const personWords = new Set((person?.names ?? []).flatMap((n) => words(n)));
  const verb = new Set(all.filter((w) => VERBS.some(([, re]) => re.test(w))));
  const keys: string[] = [];
  for (const w of all) {
    if (STOP.has(w) || personWords.has(w) || (w.length < 3 && !/\d/.test(w))) continue;
    if (verb.has(w) && !MEETING_WORD.test(w)) continue;
    const s = stem(w);
    if (!keys.includes(s)) keys.push(s);
  }
  return { action, tickets, person, keys: keys.slice(0, 4) };
}

/** Types read for every question; the action adds its own. */
export const DID_I_TYPES = ['git:commit', 'git:push', 'git:pr-status', 'shell:command', 'mail:sent', 'mail:received', 'calendar:active', 'document:opened', 'browser:tab'];
export function didITypes(action: DidIAction): string[] {
  return [...DID_I_TYPES, ...(action === 'say' ? ['audio:transcript'] : []), ...(action === 'open' ? ['page:text'] : [])];
}

/** The strings a row is searched by: needles for the SQL read, one per constraint. */
export function needlesFor(q: DidIQuestion): string[] {
  return [...q.tickets, ...(q.person?.names ?? []), ...q.keys.filter((k) => k.length >= 4)].slice(0, 12);
}

export interface DidIEvidence {
  at: string;
  /** Owner time, `09-28 14:03`. */
  when: string;
  kind: string;
  /** The row or moment behind it, so the owner (or `gnomon_signals`) can open it. */
  id: string;
  text: string;
  /** It is the thing asked, done. False: it names the thing, and is not the doing of it. */
  strong: boolean;
  why: string;
}

export interface PromiseRow {
  id: string;
  name: string;
  openedAt: string;
  closedAt: string | null;
  closedBecause: string | null;
  promise: Record<string, unknown> | null;
}

export interface DidIAnswer {
  answer: 'yes' | 'related only' | 'no sign of it';
  question: DidIQuestion;
  evidence: DidIEvidence[];
  /** How many matching rows were left out of `evidence`. */
  more: number;
  /** For a reply: their last mail, and whether one of yours to them came after it. */
  reply?: { lastFromThem: { at: string; subject: string; id: string } | null; sentAfter: boolean };
}

const STRONG_TYPES: Record<DidIAction, string[]> = {
  mail: ['mail:sent'],
  push: ['git:push', 'git:pr-status'],
  commit: ['git:commit'],
  pr: ['git:pr-status'],
  meet: [],
  run: ['shell:command'],
  open: ['document:opened', 'browser:tab', 'page:text'],
  say: ['audio:transcript'],
  any: [],
};

function keysHit(keys: readonly string[], hay: string): boolean {
  if (keys.length === 0) return true;
  const have = new Set(words(hay).map(stem));
  const hits = keys.filter((k) => have.has(k) || [...have].some((h) => h.length >= 5 && k.length >= 5 && (h.startsWith(k) || k.startsWith(h)))).length;
  return keys.length <= 2 ? hits === keys.length : hits >= keys.length - 1;
}

/** What of the question one haystack meets. */
function hits(q: DidIQuestion, hay: string): { ticket: boolean; person: boolean; keys: boolean; any: boolean } {
  const lower = hay.toLowerCase();
  const ticket = q.tickets.length === 0 || q.tickets.some((t) => lower.includes(t.toLowerCase()));
  const person = q.person === null || namesAny(lower, q.person.names);
  const keys = keysHit(q.keys, hay);
  const any = (q.tickets.length > 0 && ticket) || (q.person !== null && person) || (q.keys.length > 0 && q.keys.some((k) => keysHit([k], hay)));
  return { ticket, person, keys, any };
}

const why = (q: DidIQuestion, h: ReturnType<typeof hits>): string =>
  [q.tickets.length > 0 && h.ticket ? `names ${q.tickets.join(', ')}` : '', q.person && h.person ? `names ${q.person.asked}` : '', q.keys.length > 0 && h.keys ? `says ${q.keys.join(' ')}` : ''].filter(Boolean).join(', ') || 'in the window';

/** A searchable text for a row: its fields, without the telemetry numbers. */
const hayOf = (row: LogRow): string => {
  if (row.type === 'calendar:active') {
    const e = eventOf(row);
    return e ? `${e.title} ${e.attendees.join(' ')}` : '';
  }
  return Object.values(row.data)
    .map((v) => (typeof v === 'string' ? v : typeof v === 'object' && v !== null ? JSON.stringify(v) : ''))
    .join(' ');
};

/**
 * Judge the rows against the question.
 *
 * A row is **strong** when it is the asked action (a sent mail for "reply", a
 * push or its PR for "push", being in the meeting for "go to") and meets every
 * constraint the question carries. A row that meets one constraint and is not
 * the doing — a mail FROM Mira, a commit naming BOX-484 when a push was asked,
 * the retro on the calendar with no sign of being in it — is **related**.
 */
export function judgeDidI(q: DidIQuestion, rows: readonly LogRow[], moments: readonly MomentRow[], promises: readonly PromiseRow[], zone: string, maxEvidence = 8): DidIAnswer {
  const when = (ts: string) => `${localDate(ts, zone).slice(5)} ${formatClock(ts, zone)}`;
  const found: DidIEvidence[] = [];
  const strongTypes = STRONG_TYPES[q.action];
  const seenEvents = new Set<string>();

  for (const row of rows) {
    if (row.type === 'calendar:active') {
      const e = eventOf(row);
      if (!e || e.allDay || seenEvents.has(e.id)) continue;
      seenEvents.add(e.id);
    }
    const h = hits(q, hayOf(row));
    if (!h.any && (q.tickets.length > 0 || q.person || q.keys.length > 0)) continue;
    const all = h.ticket && h.person && h.keys;
    let strong = all && (q.action === 'any' ? row.type !== 'mail:received' && row.type !== 'calendar:active' : strongTypes.includes(row.type));
    // "Did I push": a shell `git push` that succeeded is the push, whatever the sensor saw.
    if (!strong && all && q.action === 'push' && row.type === 'shell:command' && /\bgit\s+push\b/.test(String(row.data.command)) && row.data.exitCode === 0) strong = true;
    const line = describeRow(row, zone);
    if (!line) continue;
    found.push({ at: row.ts, when: when(row.ts), kind: row.type, id: row.id, text: line.text, strong, why: why(q, h) });
  }

  for (const m of moments) {
    const hay = [m.data.meetingTitle, m.data.meetingAttendees, (m.data.intent as { text?: unknown } | undefined)?.text, m.data.gitBranch, m.projectId].map((v) => (typeof v === 'string' ? v : v ? JSON.stringify(v) : '')).join(' ');
    const h = hits(q, hay);
    if (!h.any) continue;
    const inMeeting = typeof m.data.meetingTitle === 'string' && m.data.meetingTitle !== '';
    const present = m.data.micActive === true || typeof m.data.spokenExcerpt === 'string' || (typeof m.data.activeMs === 'number' && m.data.activeMs > 0);
    // Being in the meeting is the "went": a moment inside it with the microphone on or speech
    // heard. Only at the keyboard is related: the owner may have been working through it.
    const heard = m.data.micActive === true || typeof m.data.spokenExcerpt === 'string';
    const strong = h.ticket && h.person && h.keys && q.action === 'meet' && inMeeting && heard;
    const presence = !inMeeting ? '' : heard ? ', mic on during it' : present ? ', at the machine during it, no microphone' : '';
    found.push({ at: m.start, when: when(m.start), kind: 'moment', id: m.id, text: describeMoment(m).text, strong, why: why(q, h) + presence });
  }

  for (const p of promises) {
    const terms = p.promise ?? {};
    const hay = [terms.deliverable, terms.counterparty, terms.quote, ...(Array.isArray(terms.keys) ? terms.keys : []), p.name].map((v) => (typeof v === 'string' ? v : '')).join(' ');
    const h = hits(q, hay);
    if (!h.any) continue;
    const state = p.closedAt ? (p.closedBecause ?? 'closed') : 'open';
    const kept = state === 'kept' && h.ticket && h.person && h.keys;
    const last = Array.isArray(terms.evidence) ? (terms.evidence as { text?: unknown; at?: unknown }[]).at(-1) : undefined;
    found.push({
      at: p.closedAt ?? p.openedAt,
      when: when(p.closedAt ?? p.openedAt),
      kind: 'promise',
      id: p.id,
      text: `promise "${String(terms.deliverable ?? p.name).slice(0, 60)}"${terms.counterparty ? ` to ${String(terms.counterparty)}` : ''}: ${state}${last && typeof last.text === 'string' ? ` (${last.text.slice(0, 60)})` : ''}`,
      strong: kept,
      why: why(q, h),
    });
  }

  // Strongest first, newest first within each.
  found.sort((a, b) => Number(b.strong) - Number(a.strong) || b.at.localeCompare(a.at));
  const evidence = found.slice(0, maxEvidence);
  const answer: DidIAnswer = {
    answer: found.some((e) => e.strong) ? 'yes' : found.length > 0 ? 'related only' : 'no sign of it',
    question: q,
    evidence,
    more: found.length - evidence.length,
  };
  if (q.action === 'mail' && q.person) {
    const theirs = rows.filter((r) => r.type === 'mail:received' && namesAny(String(r.data.from ?? '').toLowerCase(), q.person!.names)).at(-1);
    const sentAfter = theirs ? rows.some((r) => r.type === 'mail:sent' && r.ts > theirs.ts && namesAny(JSON.stringify(r.data.recipients ?? []).toLowerCase(), q.person!.names)) : false;
    answer.reply = { lastFromThem: theirs ? { at: theirs.ts, subject: String(theirs.data.subject ?? '').slice(0, 100), id: theirs.id } : null, sentAfter };
  }
  return answer;
}

/** What the record cannot answer, said beside a "no". Counts decide the mail line: a reader that recorded nothing may be off. */
export function blindSpots(q: DidIQuestion, typeCounts: Record<string, number>): string[] {
  const out = ['Slack, WhatsApp, Messages, phone calls and other machines are not in the record.'];
  if (q.action === 'mail' && (typeCounts['mail:sent'] ?? 0) === 0) out.unshift('No sent mail is recorded in this window at all (0 rows): the sent-mail reader may be off, so a "no" here says nothing about mail.');
  if (q.action === 'meet') out.push('Being in a meeting is read from the microphone, speech heard and the keyboard during it; a meeting joined from a phone leaves none of those.');
  if (q.action === 'push' || q.action === 'pr') out.push('Pushes from another machine or from a web UI are not seen; a PR is seen only for a branch this machine checked out.');
  return out;
}
