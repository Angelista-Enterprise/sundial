// What the owner wants and who they meet: the goals, the people, their meetings, and naming a person.
import { post, view } from './http.js'
import { readPeople } from './read-people.js'
import { readGoals } from './read-goals.js'
import { looksLikePersonName } from '@sundial/helpers/person-name.js'
import { readMeetings } from './read-meetings.js'

export function mountPeople(ctx) {

  // ── What the owner said they want ────────────────────────────────────────
  // Five goal entities on the live record, each with a real `status` fact
  // ("open — …", "done", "dropped"), and reachable by nothing: no route, no
  // tool, and only the top 40 entities by fact count reach the Memory table —
  // where three of the five fell outside. The write path (`gnomon_assert` on
  // kind 'goal') has existed all along, which is the same read/write asymmetry
  // the people roster had.

  view(ctx, '/gnomon/goals', 'The goals could not be read.', () => readGoals({ now: Date.now() }))

  // The second write door is gone. It wrote `goal:${goal}` — the raw name —
  // while `gnomon_assert` and `POST /gnomon/api/assert` wrote the slug, so
  // pressing Done on this card and saying "that's done" in the chat reached two
  // different entities. Four goals are split across two ids each in the live
  // record because of it, two of them carrying a live `done` AND a live
  // `dropped`. The card now writes through `/gnomon/api/assert` like everything
  // else, and the read folds the existing wreckage together by slug.

  // ── Who Gnomon has met ───────────────────────────────────────────────────
  // The page that makes automatic naming correctable. `identity-resolve` names
  // a hashed attendee from addresses already on the machine, and a derivation
  // can be imperfect — `alexm@example.com` yields "Alexm". Before this the only
  // way to fix that was to answer a question Gnomon chose to ask; now it is a
  // text field. The rename writes the same `knownAs` fact `gnomon_assert`
  // writes, so the owner's word supersedes a derived name on ONE observation.
  //
  // **Meetings are read from the LOG, not from `state.meetings.seen`.** That
  // map is swept at `SEEN_HORIZON_MS`, which is two days — so the "Met" and
  // "Last" columns were a 48-hour window wearing the words "how often" and
  // "when last", and thirty-five of sixty-nine people read `met 0` for no
  // reason except that the owner had not seen them since Wednesday. The
  // owner's actual question was "who haven't I seen in two weeks?", which that
  // map cannot answer at all. The calendar signals hold every event with its
  // attendees, and that is what this reads.

  // The meetings of one day, with their calendar times — the windows Explore's
  // "Said" reads speech inside. Not the day context's meetings: those are
  // stitched from moments, and the live standup of 2026-09-22 came out as 30
  // seconds. Not `state.meetings.seen` either: two days deep. The sensor logs an
  // event from a day ahead, so a week before the day finds every one of them.
  view(ctx, '/gnomon/meetings', 'The meetings could not be read.', (url) => readMeetings({ now: Date.now(), url }))

  view(ctx, '/gnomon/people', 'The people could not be read.', () => readPeople({ state: ctx.gnomonKernel.getState(), now: Date.now() }))

  // Through the SAME `entity:fact-candidate` path a sensor uses, with `provenance: 'assertion'` — the
  // owner's own word, which `contradictionCheck` promotes on one observation. The name must read like
  // one: the shallow test `peopleAsk` applies (its first answer ever was "in which meeting where they?").
  post(ctx, '/gnomon/people/name', { method: 'Naming takes a POST.', tooLong: 'That name is too long.' }, async (body) => {
    const [alias, name] = [body.alias, body.name].map((v) => (typeof v === 'string' ? v.trim() : ''))
    if (alias === '' || name === '') return 'A naming needs both an alias and a name.'
    if (!looksLikePersonName(name)) return 'That does not read like a name.'
    await ctx.gnomonKernel.appendSignal('entity:fact-candidate', { entityId: `person:${alias}`, entityKind: 'person', canonicalName: alias, predicate: 'knownAs', object: name, confidence: 100, provenance: 'assertion', projectId: null })
    return { recorded: true, alias, name }
  })
}
