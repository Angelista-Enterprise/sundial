/**
 * UC1 (U1-F2) — one promise pass per meeting, over the whole meeting.
 *
 * The pure half. The executor gathers what was heard inside the meeting's
 * window (the utterances, labelled by speaker when the far side of a call was
 * heard, then any Meet captions), builds the call with `meetingPromiseMessages`,
 * and keeps only what `parseMeetingPromises` grounds in those words. The fold
 * never sees the transcript; it sees `meeting:promises`, the grounded list.
 *
 * It replaces the 160-character tail the per-moment judge read: a long meeting
 * kept only its last ~600 characters per moment, and "by Tuesday" was almost
 * never in them.
 */
import { withPersona } from '@sundial/kernel/persona.js';
import type { ChatMessage } from '@sundial/kernel/types.js';
import { inTheOwnersLanguage } from './apply-moment-judgement.js';
import { wordsOf } from './promise-terms.js';

/** One promise as the model proposes it, before the fold reads its terms. */
export interface MeetingPromise {
  /** Who made it: the owner (the microphone) or someone else in the meeting. */
  who: 'owner' | 'other';
  /** `promise`: an undertaking to deliver. `request`: asking the other side to deliver. */
  kind: 'promise' | 'request';
  /** The attendee it is to (or from), exactly as the attendee list names them; null when nobody in particular. */
  to: string | null;
  what: string;
  /** The due words as said ("by Tuesday", "morgen"), or null. */
  due: string | null;
  quote: string;
}

export const MAX_MEETING_PROMISES = 5;

/**
 * A meeting room ("Room-2-04 (8)") or a mailing list ("design-team") sits on
 * an invite like a person, and can be owed nothing. The bench on the live
 * record found `to` naming one in 9 of 12 answers that named anybody.
 */
const NOT_A_PERSON = /\(\d+\)\s*$|^(?!person-[0-9a-f]{10}$)[a-z0-9]+(?:[-_.][a-z0-9]+)+$/;
export const peopleOn = (attendees: readonly string[]): string[] => attendees.filter((a) => !NOT_A_PERSON.test(a.trim()));

export function meetingPromiseMessages(input: { title: string; attendees: string[]; ownerName: string; transcript: string }): ChatMessage[] {
  const named = peopleOn(input.attendees);
  const people = named.length > 0 ? named.join(', ') : 'nobody on the invite';
  return [
    {
      role: 'system',
      content: withPersona(
        `Below is what was heard during a meeting, "${input.title}", between ${input.ownerName} (the owner) and ${people}.`,
        `Lines starting "${input.ownerName}:" are the owner's own microphone; lines starting with another name, or "Them:", are the other side of the call. Text with no labels is a room: anyone may have said it. A section headed "Captions" is what the meeting app captioned. Speech recognition garbles words; never repair a garbled sentence into a promise.`,
        'Find the PROMISES: one person undertaking to deliver a concrete thing to another person or the team — "I\'ll send you the draft by Tuesday", "you\'ll have the slides from me tonight", "Mira will share the numbers tomorrow". Also the REQUESTS: one side asking the other for a concrete thing, where the other agreed ("could you check the invoice?" — "sure, today").',
        'NOT promises, leave them out: a status update about one\'s own ongoing work ("I\'m still on the login page", "I\'ll try to pick that up"); an intention to look into, research or think about something; an announcement to an audience at a talk or event; a plan for the group to do something together; a thing done during the meeting itself; an ask nobody agreed to; anything from a video, a podcast or a television. Most meetings hold none, one or two. When unsure, leave it out.',
        `Respond with STRICT JSON only, no markdown fencing: an array of at most ${MAX_MEETING_PROMISES} objects, each exactly {"who": "owner"|"other", "kind": "promise"|"request", "to": "<a name copied from: ${people}>" or null, "what": "<the thing, 2 to 6 words, as said>", "due": "<the due words exactly as said>" or null, "quote": "<the words it was said in>"}.`,
        '"quote": ONE continuous stretch copied verbatim from the transcript, at most 25 words — never two passages joined with "...". "due": a time word (morgen, vandaag, vanavond, vrijdag, tomorrow, next week) from the same sentence as the promise, copied in its own language, never translated; null when that sentence names no time. "to": null unless the person the promise is to is in that list.',
        'who "owner" with kind "promise": the owner promised. who "other" with kind "request": someone asked the owner and the owner agreed. who "other" with kind "promise": someone promised the owner. who "owner" with kind "request": the owner asked someone else to deliver. Respond with [] when there are none.',
      ),
    },
    { role: 'user', content: input.transcript },
  ];
}

/** The share of a quote's words that must appear in what was heard. A model paraphrasing is allowed a word or two; a model inventing is not. */
const GROUNDED_SHARE = 0.8;

/**
 * The model's answer, kept only where it is grounded: a quote of at least
 * three words, nearly all of them in the transcript, in a language the owner
 * speaks (the room-noise key J4.4 learned from), with a thing to deliver.
 * `to` must name an attendee whose name was heard, or it becomes null — never
 * a name the model made up or guessed from the invite.
 */
export function parseMeetingPromises(text: string, transcript: string, attendees: readonly string[]): MeetingPromise[] {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A reply the token cap cut off mid-quote keeps the objects it finished.
    try {
      parsed = JSON.parse(`${body.slice(0, body.lastIndexOf('}') + 1)}]`);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const heard = new Set(wordsOf(transcript));
  const people = new Map(peopleOn(attendees).map((a) => [a.trim().toLowerCase(), a]));
  const out: MeetingPromise[] = [];
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const quote = typeof r.quote === 'string' ? r.quote.trim().replace(/\s+/g, ' ') : '';
    const what = typeof r.what === 'string' ? r.what.trim().slice(0, 80) : '';
    if (quote === '' || what === '' || !inTheOwnersLanguage(quote)) continue;
    const words = wordsOf(quote);
    if (words.length < 3 || words.filter((w) => heard.has(w)).length / words.length < GROUNDED_SHARE) continue;
    // A name nobody said is the model guessing from the invite (3 of 3 named
    // answers in one bench meeting): kept only when its first name was heard.
    const named = typeof r.to === 'string' ? (people.get(r.to.trim().toLowerCase()) ?? null) : null;
    const to = named && heard.has(wordsOf(named)[0] ?? '') ? named : null;
    out.push({
      who: r.who === 'other' ? 'other' : 'owner',
      kind: r.kind === 'request' ? 'request' : 'promise',
      to,
      what,
      due: typeof r.due === 'string' && r.due.trim() !== '' ? r.due.trim().slice(0, 40) : null,
      quote: quote.length > 160 ? `${quote.slice(0, 159)}…` : quote,
    });
    if (out.length === MAX_MEETING_PROMISES) break;
  }
  return out;
}
