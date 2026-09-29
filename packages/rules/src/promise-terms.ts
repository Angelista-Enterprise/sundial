/**
 * UC1 — the terms of a promise, read deterministically: who it is owed to,
 * when it is due, what the deliverable is and which of its words later
 * evidence has to carry. Pure functions, no model: the model (the meeting
 * pass) only proposes the words; everything a rule acts on is derived here,
 * so a replay reads the same promise the same way.
 */
import { localDate, localInstant, localWeekday } from '@sundial/helpers/local-day.js';

/** Words that say nothing about WHICH thing: articles, pronouns, the verbs of promising, filler. EN + NL. */
const STOP = new Set(
  (
    'the a an of to for and or in on at by with from that this these those it its is are was be been will would shall should can could ' +
    'i me my mine you your yours we us our he him his she her they them their some any all just also then than there here about ' +
    'send sent sending give get got make made do done doing share shared finish finished deliver write look review check fix ' +
    'thing things stuff something anything bit quick new final first latest version copy ' +
    'de het een van voor en of in op aan bij met uit dat dit die deze er hier daar ook dan wel nog even maar om naar toe te ' +
    'ik mij me mijn jij je jouw u uw wij we ons onze hij hem zijn zij ze haar hun het iets alles ' +
    'stuur sturen stuurt gestuurd geef geven maak maken doe doen deel delen gedeeld kijk kijken check fix ' +
    'ding dingen spul morgen vandaag straks later tomorrow today tonight vanavond week next volgende'
  ).split(/\s+/),
);

/** A ticket key: BOX-484. Kept whole, lower-cased, because it is the strongest match a deliverable can carry. */
const TICKET = /\b[a-z][a-z0-9]{1,9}-\d{1,6}\b/gi;

/** Lower-case, accents off, split into words; a ticket key stays one token. */
export function wordsOf(text: string): string[] {
  const lower = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const tickets = lower.match(TICKET) ?? [];
  const rest = lower.replace(TICKET, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return [...tickets, ...rest];
}

/** One form per word: a plural `s` or Dutch `en` off, so "drafts" meets "draft" and "slides" meets "slide". */
const stem = (w: string): string => (/^[a-z][a-z0-9]*-\d+$/.test(w) ? w : w.length > 4 && w.endsWith('en') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

/** The words later evidence must carry: the deliverable's nouns, stop-words out, at most four. */
export function keyNouns(deliverable: string): string[] {
  const out: string[] = [];
  for (const w of wordsOf(deliverable)) {
    if (STOP.has(w) || (w.length < 3 && !/\d/.test(w))) continue;
    const s = stem(w);
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 4);
}

/**
 * Does `text` name the deliverable? Every key when there are one or two, and
 * all but one when there are more — "the Q3 board deck" is kept by a file
 * called `board-deck.key`, and never by one called `notes.md`.
 */
export function namesDeliverable(keys: readonly string[], text: string): boolean {
  if (keys.length === 0 || text.trim() === '') return false;
  const have = new Set(wordsOf(text).map(stem));
  const hits = keys.filter((k) => have.has(k) || [...have].some((h) => h.length >= 5 && k.length >= 5 && (h.startsWith(k) || k.startsWith(h)))).length;
  return keys.length <= 2 ? hits === keys.length : hits >= keys.length - 1;
}

/** Same person, as the log writes people: a name or `person-<hash>`, compared without case. First names count for a spoken name. */
export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Who a promise is to, among the people who were there.
 *
 * A name in the words that matches an attendee (whole name or first name)
 * wins; otherwise, in a 1:1, the one other person; otherwise nobody — "the
 * room" — rather than a guess.
 */
export function counterpartyIn(text: string, attendees: readonly string[], ownerAliases: readonly string[] = []): string | null {
  const owner = new Set(ownerAliases.map((a) => a.trim().toLowerCase()));
  const others = [...new Set(attendees.map((a) => a.trim()).filter((a) => a !== '' && !owner.has(a.toLowerCase())))];
  const words = new Set(wordsOf(text));
  const named = others.filter((a) => {
    if (/^person-[0-9a-f]{10}$/.test(a)) return false;
    const first = wordsOf(a)[0];
    return first !== undefined && first.length >= 3 && words.has(first);
  });
  if (named.length === 1) return named[0]!;
  return others.length === 1 ? others[0]! : null;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  zondag: 0, maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6,
};

/** The local date `days` after the local date of `ts`. */
function plusDays(ts: string, days: number, tz: string): string {
  const d = new Date(`${localDate(ts, tz)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** End of a working day, where a promise "by Tuesday" is judged. */
const END_OF_DAY = 17;

/**
 * A due date from the words, resolved against when they were said, in the
 * owner's timezone. EN + NL: today / vandaag / EOD, tonight / vanavond,
 * tomorrow / morgen, overmorgen, a weekday ("dinsdag" said on a Thursday is
 * next Tuesday), end of the week / EOW, next week / volgende week (its
 * Friday), in N days / over N dagen. Anything vaguer — "later", "soon",
 * "straks" — is no date, and the promise takes a default instead.
 */
export function parseDue(text: string | null | undefined, ts: string, tz: string): string | null {
  if (!text) return null;
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ')} `;
  const at = (days: number, hour = END_OF_DAY): string => localInstant(plusDays(ts, days, tz), hour, 0, tz);
  const today = localWeekday(ts, tz);
  if (/ (overmorgen|day after tomorrow) /.test(t)) return at(2);
  if (/ (tomorrow|morgen|morgenochtend|morgenmiddag) /.test(t)) return at(1);
  if (/ (tonight|vanavond) /.test(t)) return at(0, 21);
  if (/ (today|vandaag|eod|end of (the )?day|vanmiddag|this afternoon|einde van de dag) /.test(t)) {
    const eod = at(0);
    return Date.parse(eod) > Date.parse(ts) ? eod : at(0, 23);
  }
  const inDays = t.match(/ (?:in|over|binnen) (\d{1,2}|two|three|twee|drie) (?:days?|dagen|werkdagen) /);
  if (inDays) {
    const n = { two: 2, three: 3, twee: 2, drie: 3 }[inDays[1]! as 'two'] ?? Number(inDays[1]);
    return at(n);
  }
  if (/ (next week|volgende week|komende week) /.test(t)) return at(7 + ((5 - today + 7) % 7));
  if (/ (eow|end of (the )?week|eind van de week|einde van de week|this week|deze week) /.test(t)) return at((5 - today + 7) % 7);
  for (const [name, day] of Object.entries(WEEKDAYS)) {
    if (!t.includes(` ${name} `)) continue;
    const ahead = (day - today + 7) % 7;
    return at(ahead === 0 ? 7 : ahead);
  }
  return null;
}

/** Three working days after `ts`, at the end of the day: when a promise with no date and nobody to meet is due. */
export function defaultDue(ts: string, tz: string): string {
  let days = 0;
  let working = 0;
  while (working < 3) {
    days += 1;
    const wd = new Date(`${plusDays(ts, days, tz)}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) working += 1;
  }
  return localInstant(plusDays(ts, days, tz), END_OF_DAY, 0, tz);
}

/** First person, future: the shape a promise is said in (EN + NL). */
export const PROMISING = /\b(ik ga|ga ik|ik zal|zal ik|ik stuur|stuur ik|we gaan|gaan we|ik kijk|kijk ik|ik maak|maak ik|ik regel|regel ik|i'll|i will|i'm going to|we'll|we will|let me|i owe|i promised|i told \w+ i'?d|beloofd)\b/i;

/**
 * A promise the owner states in their own words — typed to Gnomon, or said in
 * answer to "did you promise anything?". First person by construction, so the
 * only questions are to whom, what, and by when:
 *
 *   "I owe Mira the draft by Tuesday" · "I promised Bob I'd review the PR"
 *   "told Mira I'd send the deck tomorrow" · "ik stuur Mira morgen de notulen"
 *
 * Returns null when the words make no promise at all.
 */
export function parseStatedPromise(text: string, opts: { ts: string; tz: string; attendees?: readonly string[]; ownerAliases?: readonly string[] }): { counterparty: string | null; deliverable: string; due: string | null; dueText: string | null } | null {
  const said = text.trim().replace(/\s+/g, ' ');
  if (said === '' || !(PROMISING.test(said) || /\b(owe|promised|told|beloofd|i'?d|i would)\b/i.test(said) || /^(to |send |stuur |review |deliver |share )/i.test(said))) return null;
  if (/^(no|nee|nope|nothing|niks|niets)\b/i.test(said)) return null;
  // To whom: an attendee named in the words, else the name after the verb of owing.
  const NAME = "([A-Z][\\p{L}'-]+(?:\\s[A-Z][\\p{L}'-]+)?)";
  const named = said.match(new RegExp(`\\b(?:owe|promised|told|beloofd aan|stuur|send|give|geef|aan|to)\\s+${NAME}`, 'u')) ?? said.match(new RegExp(`\\bheb\\s+${NAME}\\s+beloofd`, 'u'));
  const fromAttendees = opts.attendees && opts.attendees.length > 0 ? counterpartyIn(said, opts.attendees, opts.ownerAliases) : null;
  const counterparty = fromAttendees ?? (named ? named[1]!.replace(/\s+(I|I'd|Ik)$/, '') : null);
  // By when: the first due-shaped phrase.
  const dueMatch = said.match(/\b(by|before|on|voor|uiterlijk|op)?\s*(overmorgen|tomorrow|morgen|tonight|vanavond|today|vandaag|eod|end of (?:the )?(?:day|week)|eind van de week|next week|volgende week|this week|deze week|in \d+ days|over \d+ dagen|monday|tuesday|wednesday|thursday|friday|saturday|sunday|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\b/i);
  const dueText = dueMatch ? dueMatch[0].trim() : null;
  // What: the words after the promise verb, with the person and the date taken out.
  const first = counterparty?.split(' ')[0]?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let what = said
    .replace(/^.*?\b(owe|promised( to)?|told|i'll|i will|i'm going to|we'll|we will|let me|ik stuur|stuur ik|ik ga|ga ik|ik zal|zal ik|ik maak|maak ik|ik regel|regel ik|beloofd( om)?)(?=\s|$)/i, '')
    .replace(dueText ?? '\u0000', '')
    .replace(first ? new RegExp(`\\b${first}\\b('s)?(\\s+${counterparty!.split(' ').slice(1).join('\\s+')})?`, 'i') : /\u0000/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(that |dat )?(i'?d|i would|ik|to|om|te)\s+/i, '')
    .replace(/^(send|give|stuur|geef|sturen)\s+(you|je|jou|u)\s+/i, '$1 ')
    .replace(/\s+(to|aan|for|voor|by|before|on|op|stuur|sturen|doe|maak|deel|geef|lever)$/i, '')
    .replace(/^[,.;:]+|[,.;:]+$/g, '')
    .trim();
  if (what === '') what = said;
  const deliverable = what.length > 60 ? `${what.slice(0, 59).trimEnd()}…` : what;
  return { counterparty, deliverable, due: parseDue(dueText, opts.ts, opts.tz), dueText };
}
