// Sixty-nine rows that are about forty-five humans, three rooms and a group.
//
// The card had one entity per NAME, and a calendar hands out several names for
// one person: the display name it was invited under, the address this machine
// hashed, and whatever `identity-resolve` derived from that address. So the
// owner met Alex, Alex Morgan, Alexm and `person-c205ca11f2` — four rows,
// one colleague — and had no way to say so.
//
// Two mechanisms, and they are deliberately different things.
//
// **The fold is free, and it is not a guess.** `person-c205ca11f2` already
// carries `knownAs: "Alex Morgan"`, and an entity called `Alex Morgan`
// already exists. Resolving the display name first and grouping on THAT merges
// eight pairs in the live record without anyone deciding anything: the record
// already said they were the same, in two places, and nothing read both.
//
// **The alias is a decision, so it is the owner's.** `Alexm` and `Alex
// Morgan` are not the same string and no rule can make them one — "Jordan"
// is genuinely ambiguous between Jordan Holm and Jordan De Wit, and
// the 17 Sep audit's own list got that wrong. So a variant→canonical map lives
// in config (`personAliases`, mirroring `projectAliases`) and is applied at
// resolve time, and the card's merge control writes the same thing as a
// `knownAs` assertion on the duplicate. No `entity:merge` signal: a merge that
// rewrote facts would collide with "facts are never overwritten", and neither of
// these does — the loser keeps every fact it ever had, it just answers to
// another name.
//
// The rest of this file is about what is NOT a person. The calendar's attendee
// list carries meeting rooms (`RTM-1-08 (12)`), distribution groups (`Acme
// Employees`, `Studio - developers`) and the owner themselves, and all three
// became `person` entities. They are detected rather than listed, because the
// list would be out of date the first time the office added a room.

/** Nothing about a name should depend on its case, its accents or its punctuation. */
export const normalizeName = (name) =>
  String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** A hashed attendee: an address this machine could not match to a human. */
export const isHash = (name) => /^person-[0-9a-f]{6,}$/i.test(String(name ?? ''))

/**
 * A meeting room.
 *
 * Every room in the live record ends in its capacity — `RTM-1-08 (12)`,
 * `AMS-1-07 - The Board Room (14)`, `GTP-5-04-INTERNAL (4)` — and every one also
 * opens with a three-letter site code. Either is enough on its own; both are
 * tested so a site that names rooms one way and not the other still works. No
 * human name ends in a number in brackets.
 */
export const isRoom = (name) => /\(\d+\)\s*$/.test(String(name ?? '')) || /^[A-Z]{2,4}-\d/.test(String(name ?? ''))

/**
 * A distribution list, a team, or the office itself.
 *
 * `Acme Employees`, `Acme Interns`, `Acme Office`, `puzzlebox-team`, `Studio -
 * developers`. Matched on the collective noun rather than on the organisation,
 * so this does not have to be taught about the next company.
 */
export const isGroup = (name) => /(^|[\s-])(team|teams|employees|interns|office|developers|designers|calendar|everyone|all)([\s-]|$)/i.test(String(name ?? ''))

/** The owner, under any of the names they told the config they appear as. */
export const isOwner = (name, ownerAliases = []) => {
  const key = normalizeName(name)
  return key !== '' && ownerAliases.some((alias) => normalizeName(alias) === key)
}

/**
 * Why this attendee string is not a person, or `null` when it is one.
 *
 * Returned as a word rather than a boolean because the card SAYS it: three
 * calendar artefacts silently dropped is three rows the owner cannot find again
 * and has no way to know were ever there.
 */
export function notAPerson(name, ownerAliases = []) {
  if (isOwner(name, ownerAliases)) return 'you'
  if (isRoom(name)) return 'a room'
  if (isGroup(name)) return 'a group'
  return null
}

/**
 * What to call this entity, after everything that has a say.
 *
 * Order matters and it is the order of authority: what the owner asserted
 * (`knownAs`), then what they configured (`personAliases`), then what the
 * calendar called it. A `knownAs` is itself run through the alias map, so an
 * assertion naming a variant still lands on the canonical spelling.
 */
export function displayName(entity, aliases = {}) {
  const byAlias = (name) => {
    const key = normalizeName(name)
    const hit = Object.entries(aliases).find(([from]) => normalizeName(from) === key)
    return hit ? hit[1] : name
  }
  const raw = entity?.knownAs || entity?.name || entity?.alias || ''
  return byAlias(raw)
}

/**
 * Many rows, one human.
 *
 * Grouped on the normalized display name, which is what makes the fold free:
 * two ids that resolve to the same words ARE the same person as far as the
 * record is concerned, and if they are not, the owner has a naming problem the
 * card cannot solve for them anyway.
 *
 * Counts are summed and meeting lists concatenated, but the meetings are keyed
 * by event so a person invited under two addresses to ONE meeting counts once.
 * Without that the fold would make the duplicates look twice as sociable, which
 * is the opposite of the point.
 */
export function foldPeople(rows) {
  const byName = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = normalizeName(row?.name) || String(row?.alias ?? '')
    const seen = byName.get(key)
    if (!seen) {
      byName.set(key, { ...row, aliases: [row.alias], events: new Map(row.events ?? []) })
      continue
    }
    seen.aliases.push(row.alias)
    for (const [id, meeting] of row.events ?? []) seen.events.set(id, meeting)
    // The longest spelling wins the display: "Alex Morgan" over "Alex".
    // A longer name is never less specific, and the owner asked to see people,
    // not first names.
    if (String(row.name ?? '').length > String(seen.name ?? '').length) seen.name = row.name
    if (row.named) seen.named = true
  }
  return [...byName.values()].map((person) => {
    const meetings = [...person.events.entries()].map(([id, m]) => ({ ...m, id })).sort((a, b) => String(b.at).localeCompare(String(a.at)))
    return {
      ...person,
      events: undefined,
      meetings: meetings.length,
      lastSeen: meetings[0]?.at ?? null,
      // The trail's marks. One per meeting, on the list's one axis — which is
      // the only honest picture this record can draw (see the card).
      life: meetings.map((m) => ({ at: m.at, kind: 'met' })),
      met: meetings.slice(0, 30),
    }
  })
}

/** How many co-attendees a fold will draw before it stops and says how many more. */
export const WITH_SHOWN = 8

/**
 * Who else was in the room.
 *
 * The one connection this record actually holds. A person carries two
 * predicates and neither is about another person — but a calendar event carries
 * an attendee LIST, so "you and Isa were both in Puzzlez - Refinement" is a fact
 * already written down, twice, and nothing read it.
 *
 * Measured across the record before it was built, because a global relationship
 * map was the thing asked for and the numbers refuse it: 554 pairs of which 510
 * have weight one, almost all minted by three all-hands invitations. Per PERSON
 * the same data reads clearly — Isa has seven, three of whom are in both of her
 * meetings and four in one. That "3 of 3" versus "1 of 3" IS the relationship,
 * and it is the thing a flat count of meetings cannot say.
 *
 * Returns everyone, ordered strongest first; the surface decides where to stop.
 * A person with an empty list is not a gap in the data — Marco Kuiper has three
 * meetings and no co-attendees, which means the owner sees him one to one, and
 * that is worth saying out loud.
 */
export function withWhom(person, eventsById, resolve = (n) => n) {
  const mine = normalizeName(person?.name)
  const shared = new Map()
  for (const meeting of person?.met ?? []) {
    const event = eventsById?.get?.(meeting.id) ?? eventsById?.[meeting.id]
    for (const attendee of event?.attendees ?? []) {
      const name = resolve(attendee)
      const key = normalizeName(name)
      if (key === '' || key === mine) continue
      const seen = shared.get(key) ?? { name, shared: 0, life: [] }
      seen.shared += 1
      // `with`, not `met`: a co-attendee's marks are CONTEXT under the person's
      // own, and drawn at the same weight the fold read as eight identical
      // trails with no subject. Same argument as the goal trail's tall "you
      // said" against its short "a commit landed".
      seen.life.push({ at: meeting.at, kind: 'with' })
      // A hash reaching a screen is the rule this card exists to enforce; it is
      // still a real person in a real room, so it is counted and unnamed rather
      // than dropped.
      seen.unnamed = isHash(name)
      shared.set(key, seen)
    }
  }
  // Rooms shared, then most recently, then a name before a hash — an unnamed
  // attendee sorted into the middle of a list of colleagues is the one row the
  // reader cannot use, and it has no business above one they can.
  return [...shared.values()].sort(
    (a, b) => b.shared - a.shared || String(b.life[0]?.at ?? '').localeCompare(String(a.life[0]?.at ?? '')) || Number(a.unnamed) - Number(b.unnamed) || a.name.localeCompare(b.name),
  )
}

/**
 * "Alex" is almost certainly "Alex Morgan". "Jordan" is either of two.
 *
 * The one merge a machine may suggest without guessing: a row whose whole name
 * is the first word (or words) of a longer row's. That is the shape every
 * remaining duplicate in the live record has — a bare first name with no
 * meetings, sitting under the full name it belongs to.
 *
 * It is only ever a SUGGESTION, and where the prefix fits two people it says so
 * and offers both rather than picking. The 17 Sep audit's own list read "Jordan×3
 * → one human" and the record says Jordan is two different colleagues plus a bare
 * first name; a card that had auto-merged on that list would have welded two
 * people together and called it a fix.
 */
export function mergeHint(person, everyone) {
  const mine = normalizeName(person?.name)
  if (mine === '' || isHash(person?.name)) return null
  const longer = everyone
    .filter((other) => other !== person && normalizeName(other.name).startsWith(`${mine} `))
    .map((other) => other.name)
  if (longer.length === 0) return null
  return { sure: longer.length === 1, could: longer }
}

/** Whole days since, or `null` when they have never been in a room with the owner. */
export function daysSince(iso, now = Date.now()) {
  if (!iso) return null
  const ms = now - new Date(iso).getTime()
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : null
}

/** Most recently seen first; anyone never seen sorts last, because unknown is not old. */
export const bySeen = (a, b) => (a.lastSeen ? 0 : 1) - (b.lastSeen ? 0 : 1) || String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')) || String(a.name).localeCompare(String(b.name))
