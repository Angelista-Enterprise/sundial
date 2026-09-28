import { deriveId } from '@sundial/helpers/derive-id.js';
import { wasAbsent } from './meeting-followup.js';
import type { Effect, Rule } from '@sundial/kernel/types.js';
import { looksLikePersonName } from '@sundial/helpers/person-name.js';
import { REDACTION_ALIAS } from './entity-name-validation.js';

/**
 * Asking who the hashed people are.
 *
 * The calendar sends some attendees as bare addresses; `sanitizeAtIngest` turns
 * each into a stable `person-<hash>` alias, and every later meeting with that
 * person accumulates evidence on the alias. Nothing could ever turn the alias
 * into a name — the record knew person-c205ca11f2 had met the owner nine times
 * and could not say who that was, and the post-meeting question read "with
 * person-c205ca11f2, person-d1feb17d9f".
 *
 * One question per alias, once, through the same `ask:owner-opened` path as
 * every other question Gnomon asks, so the one-open-question rule and the gate
 * govern it. The answer lands twice: in `state.people.names` for rules that
 * render attendees, and as a `knownAs` fact on the alias entity (provenance
 * `assertion`, the owner's word), so core memory carries it too.
 *
 * Only aliases from meetings that already ENDED are asked about, and only a
 * little while after: a name is worth asking for once the person has actually
 * been in the room, and not while the meeting question itself is waiting.
 */

/** An alias the owner did not name is asked about again after this long, at most. */
export const REASK_ALIAS_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * At most one of these questions a day, whatever alias it is about.
 *
 * The per-alias mute below is not a limit on the CLASS: one meeting carries
 * several hashed attendees, so this rule walked to the next hash the moment the
 * previous question closed. Seven went out on 2026-09-09, three of them at
 * 06:36, 06:37 and 06:38.
 */
export const ASK_CLASS_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a non-name answer silences the whole class.
 *
 * The owner's refusal is a statement about the question, not about the one hash
 * they were shown. Before this, "I dont know, we need to handle this in code"
 * marked that alias asked and the next hash went out two minutes later — four
 * times over one day. A week is long enough that the automatic resolver
 * (`identity-resolve`) gets its turn first, which is where a name should come
 * from anyway.
 */
export const MUTE_CLASS_AFTER_REFUSAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Ask about a meeting's people this long after it ended, so the meeting question goes first. */
const ASK_AFTER_END_MS = 30 * 60 * 1000;
/** Meetings older than this are not mined for names: the owner will not remember who "the second person" was. */
const MEETING_HORIZON_MS = 2 * 24 * 60 * 60 * 1000;

export const WHO_ASK_PREFIX = 'owner-ask:who-';

/** Words the owner uses to say they do not know or do not care. Recorded as asked, not as a name. */
const DECLINED = new Set(['skip', 'no idea', "don't know", 'dont know', 'unknown', 'nobody', 'not sure', 'no', '-', '?']);

function isAlias(name: string): boolean {
  return REDACTION_ALIAS.test(name.trim());
}

function cleanName(answer: string): string | null {
  const trimmed = answer.trim().replace(/^(that is|that's|it's|its|this is|thats)\s+/i, '').replace(/[.!]+$/, '').trim();
  if (trimmed === '' || DECLINED.has(trimmed.toLowerCase())) return null;
  // A name is a few words with no question in it. The first answer this rule
  // ever got was "in which meeting where they?", and it filed it as a name.
  if (!looksLikePersonName(trimmed)) return null;
  return trimmed;
}

/**
 * The question, phrased so a human can answer it.
 *
 * The shipped wording was "Who is person-c7e3af19c4? They were in "Android
 * developer meeting" with you and person-fdc656585a, Acme Office,
 * person-44d889e0a7." — it asks the owner to decode one hash by giving them two
 * more, and a room name in the middle of the people. The owner answered "I dont
 * know, we need to handle this in code" and they were right: nothing in that
 * sentence is anchored to anything they remember.
 *
 * What a person remembers about a meeting is WHEN it was, what it was called,
 * and who else they know was there. So the hash never appears and the answer
 * being asked for is a position in the room — "the other person" — rather than
 * an identifier.
 *
 * That phrasing is only HONEST when exactly one attendee is unnamed, which is
 * why the caller refuses to ask otherwise. With two unnamed attendees "who was
 * the other person" has two right answers and the rule would file whichever one
 * the owner gave against whichever hash it happened to be iterating — a durable
 * false fact about a real colleague, which is a worse outcome than not asking.
 * Meetings with several hashed attendees are the automatic resolver's job.
 */
export function meetingQuestion(meeting: { title: string; start: string }, known: readonly string[], timezone: string): string {
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(meeting.start));
  const withWhom = known.length > 0 ? `, with ${known.slice(0, 3).join(', ')}` : '';
  return `${when} · "${meeting.title}"${withWhom}. Who was the other person there?`;
}

export const peopleAsk: Rule = (state, event) => {
  const people = state.people ?? { names: {}, asked: {} };

  if (event.type === 'ask:owner-answered') {
    const askId = typeof event.payload.askId === 'string' ? event.payload.askId : '';
    if (!askId.startsWith(WHO_ASK_PREFIX)) return { state, effects: [] };
    const alias = askId.slice(WHO_ASK_PREFIX.length);
    if (!isAlias(alias)) return { state, effects: [] };
    const name = cleanName(typeof event.payload.answer === 'string' ? event.payload.answer : '');
    // Declined, or not a name: the CLASS goes quiet, not just this alias. The
    // owner cannot be expected to phrase a refusal in one of `DECLINED`'s exact
    // words — theirs was a whole sentence, four times over — and every reading
    // of a non-name answer is the same reading: this is not a question I can
    // answer. `asked` is still stamped so the alias keeps its own fortnight.
    if (name === null) {
      return {
        state: { ...state, people: { ...people, asked: { ...people.asked, [alias]: event.ts }, mutedUntil: new Date(Date.parse(event.ts) + MUTE_CLASS_AFTER_REFUSAL_MS).toISOString() } },
        effects: [],
      };
    }

    const effects: Effect[] = [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'people-ask', alias),
          type: 'entity:fact-candidate',
          ts: event.ts,
          payload: {
            entityId: `person:${alias}`,
            entityKind: 'person',
            canonicalName: alias,
            predicate: 'knownAs',
            object: name,
            confidence: 100,
            provenance: 'assertion',
            sourceEventId: event.id,
            projectId: null,
          },
        },
      },
    ];
    return { state: { ...state, people: { ...people, asked: { ...people.asked, [alias]: event.ts } } }, effects };
  }

  if (event.type !== 'clock:tick') return { state, effects: [] };
  if (state.ownerAsk.open !== null) return { state, effects: [] };
  const now = Date.parse(event.ts);
  // The class's own two gates, checked before any alias is considered.
  if (people.mutedUntil !== undefined && now < Date.parse(people.mutedUntil)) return { state, effects: [] };
  if (people.lastAskedAt !== undefined && now - Date.parse(people.lastAskedAt) < ASK_CLASS_INTERVAL_MS) return { state, effects: [] };
  // Who is already named, read from the ONE place a name lives: the `knownAs`
  // facts. A parallel `names` map in this slice was a second store for the same
  // fact, invisible to every other writer of `knownAs` (the nightly pass,
  // `gnomon_assert`, a replay) and empty on a snapshot from before the slice.
  const namedInGraph = new Set(Object.keys(state.memory.aliasNames ?? {}));

  for (const meeting of Object.values(state.meetings.seen)) {
    const since = now - Date.parse(meeting.end);
    if (since < ASK_AFTER_END_MS || since > MEETING_HORIZON_MS) continue;
    // A room the owner was not in has nobody they can name.
    if (wasAbsent(meeting)) continue;
    // Unnamed attendees in THIS meeting. Asking is only honest when there is
    // exactly one: "who was the other person there?" has a single right answer
    // then, and the name can be attached to that alias with confidence. With
    // two, the owner's answer names one of them and this rule cannot tell
    // which, so it would write a real name onto whichever hash it happened to
    // reach first. A meeting with several hashes is left to `identity-resolve`.
    const unnamed = meeting.attendees.filter((a) => isAlias(a) && !namedInGraph.has(a));
    if (unnamed.length !== 1) continue;
    const attendee = unnamed[0]!;
    {
      const askedAt = people.asked[attendee];
      if (askedAt !== undefined && now - Date.parse(askedAt) < REASK_ALIAS_AFTER_MS) continue;
      // Only the attendees the owner can RECOGNISE are named in the question.
      // Listing the other hashes was the defect on the surface: "Who is
      // person-c7e3af19c4? They were in ... with you and person-fdc656585a,
      // Acme Office, person-44d889e0a7" asks the owner to decode one hash using
      // two more, with a room name sitting among the people.
      const known = meeting.attendees.filter((a) => a !== attendee && !isAlias(a));
      return {
        state: { ...state, people: { ...people, lastAskedAt: event.ts, asked: { ...people.asked, [attendee]: event.ts } } },
        effects: [
          {
            type: 'EmitEvent',
            event: {
              id: deriveId(event.ts, event.id, 'people-ask', `ask:${attendee}`),
              type: 'ask:owner-opened',
              ts: event.ts,
              payload: {
                askId: `${WHO_ASK_PREFIX}${attendee}`,
                question: meetingQuestion(meeting, known, state.config.timezone),
                reason: 'your calendar sent this attendee as a bare address, so the record has no name for them',
                choices: [],
              },
            },
          },
        ],
      };
    }
  }
  return { state, effects: [] };
};

/**
 * An attendee list with known names in place of the aliases, read from the
 * `knownAs` beliefs rather than from a cache beside them.
 */
export function namedAttendees(attendees: readonly string[], aliasNames: Record<string, string> | undefined): string[] {
  return attendees.map((a) => aliasNames?.[a] ?? a);
}
