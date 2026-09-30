// Who Gnomon has met: every person entity, named through the owner's own aliases and the fold's known-as names, with the meetings each was in (from the calendar LOG, not the two-day `state.meetings.seen`), who they meet with, and what is not a person.
import { bySeen, daysSince, displayName, foldPeople, isHash, mergeHint, notAPerson, WITH_SHOWN, withWhom } from '../shell/people.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { getAllEntities, getSignalsInRange } from '@sundial/db/index.js'

/**
 * Every calendar event on the record, once, with its attendees.
 *
 * Deduplicated by `eventId + startDate`: the sensor re-logs an upcoming
 * meeting on every poll, so the 2,807 calendar signals in the live record are
 * 98 actual events. All-day entries are dropped — `Passiedag`, `Bob middag
 * vrij` — because a whole-office all-day invite is not a room the owner was in
 * with anybody, and counting it would make "most seen" mean "on the most
 * mailing lists".
 */
async function calendarEvents(now, sinceDays = 400) {
  const to = new Date(now + 86_400_000).toISOString()
  const from = new Date(now - sinceDays * 86_400_000).toISOString()
  const rows = await getSignalsInRange(from, to, 20_000, ['calendar'])
  const events = new Map()
  for (const row of rows) {
    const event = row?.data?.event
    if (!event?.eventId || event.isAllDay) continue
    const attendees = Array.isArray(event.attendees) ? event.attendees : []
    if (attendees.length === 0) continue
    events.set(`${event.eventId}|${event.startDate}`, { at: String(event.startDate ?? row.capturedAt), title: String(event.title ?? 'a meeting'), attendees })
  }
  return [...events.entries()]
}

export async function readPeople({ state, now }) {
  const aliasNames = state.memory?.aliasNames ?? {}
  const config = loadSundialConfig()
  const personAliases = config.personAliases ?? {}
  const ownerAliases = config.ownerAliases ?? []

  // attendee string → the events they were in. Keyed by event so a fold
  // of two ids that were both invited to one meeting counts it once.
  const events = new Map(await calendarEvents(now))
  const met = new Map()
  for (const [id, event] of events) {
    for (const attendee of event.attendees) {
      if (!met.has(attendee)) met.set(attendee, new Map())
      met.get(attendee).set(id, { at: event.at, title: event.title })
    }
  }

  const entities = (await getAllEntities()).filter((e) => e.kind === 'person')
  const notPeople = []
  const rows = []
  for (const entity of entities) {
    const key = entity.canonicalName ?? entity.id
    const knownAs = aliasNames[key]
    const name = displayName({ alias: key, name: key, knownAs }, personAliases)
    // A room, a distribution list, or the owner. Named rather than
    // dropped: three rows that silently vanish are three rows nobody can
    // question, and the owner asked to know these were filtered.
    const why = notAPerson(name, ownerAliases) ?? notAPerson(key, ownerAliases)
    if (why) {
      notPeople.push({ name, why })
      continue
    }
    rows.push({
      alias: key,
      name,
      named: knownAs !== undefined || !isHash(name),
      // Both spellings, because the calendar may have invited this
      // person under the hash on one event and the name on another.
      events: [...(met.get(key) ?? new Map()), ...(knownAs ? (met.get(knownAs) ?? new Map()) : new Map())],
    })
  }

  const folded = foldPeople(rows)
  const named = folded.filter((p) => p.named)

  // A co-attendee is resolved through the SAME fold the list uses, so
  // `person-c205ca11f2` in someone's room reads "Alex Morgan" and
  // lands on the row that is already on this card. Built from the folded
  // result rather than re-deriving, because two resolutions of one name
  // is how a surface starts disagreeing with itself.
  const byAlias = new Map()
  for (const person of folded) for (const alias of person.aliases ?? []) byAlias.set(alias, person.name)
  const resolve = (attendee) => byAlias.get(attendee) ?? displayName({ name: attendee }, personAliases)
  // Rooms, groups and the owner are not company — the owner is in every
  // one of these rooms by definition, and "you were also there" is not a
  // connection worth drawing.
  const company = (person) => withWhom(person, events, resolve).filter((w) => notAPerson(w.name, ownerAliases) === null)

  const people = named
    .map((p) => {
      const all = company(p)
      return {
        ...p,
        daysSince: daysSince(p.lastSeen),
        hint: mergeHint(p, named),
        with: all.slice(0, WITH_SHOWN),
        withMore: Math.max(0, all.length - WITH_SHOWN),
      }
    })
    .sort(bySeen)
  // The unnamed are ONE bucket, not eight rows at the top of the list.
  // They are the same question asked eight times, and the answer to each
  // is a name the owner may not have — seven of the eight have never
  // been in a timed meeting, so there is nothing to jog it with.
  const unnamed = folded
    .filter((p) => !p.named)
    .map((p) => ({ ...p, daysSince: daysSince(p.lastSeen), with: company(p).slice(0, WITH_SHOWN) }))
    .sort(bySeen)
  return {
    people,
    unnamed,
    notPeople: notPeople.sort((a, b) => a.name.localeCompare(b.name)),
    aliasesApplied: Object.keys(personAliases).length,
  }
}
