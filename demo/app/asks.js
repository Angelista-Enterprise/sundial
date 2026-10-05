// What asking cost, read out of the questions themselves.
//
// The audit asked for "question precision (answered / expired / wrong-question)"
// and the record refuses two thirds of it. `owner_asks.outcome` holds exactly
// two values, `answered` and `expired`, and on the live record that is 47 and
// 1 — a 98% precision figure that flatters the asker and teaches the owner to
// ignore the number. Nothing anywhere stores "this was a meeting I wasn't in":
// the calendar carries an attendee LIST, which is an invitation, not
// attendance. So the wrong-question verdict cannot be derived, and it is now
// the owner's to give — `feedback:verdict` with `owner_ask` as its artifact
// kind, where `wrong` is the wrong question and `not-now` is the bad moment.
//
// What the record CAN answer exactly, with no guessing and no model, is the
// shape of the asking: Gnomon has four question templates, it put one of them
// (who is this calendar attendee?) fourteen times, and fifteen of forty-eight
// questions landed within an hour of another of the same kind. That is the
// calibration data the audit was reaching for, and it is a count rather than a
// judgement.

/**
 * Which of Gnomon's questions this is.
 *
 * Read off the ask's own id, which the minting rules build from the subject —
 * `owner-ask:meeting-<id>`, `owner-ask:who-person-<alias>`,
 * `owner-ask:goals-<date>`. Not off the question text: the text is a template
 * with the subject substituted in, so matching it is matching the template
 * badly. Anything else is `other`, which is where every question Gnomon
 * composed for itself lands.
 */
export function askKind(id) {
  const tail = String(id ?? '').replace(/^owner-ask:/, '')
  if (tail.startsWith('who-')) return 'who'
  if (tail.startsWith('meeting-')) return 'meeting'
  if (tail.startsWith('goals-')) return 'goals'
  return 'other'
}

/** What each template is FOR, said once at the head of its group. */
export const KIND_WORDS = {
  meeting: 'asking what a meeting was worth keeping',
  who: 'asking who a calendar attendee is',
  goals: 'asking about the week against the open goals',
  other: 'something Gnomon could not work out from the record',
}

/**
 * The question, without its template tail.
 *
 * The complaint the owner made about the shipped card: 25 of 49 closed rows
 * open with the same eleven words — "Anything worth remembering — decisions,
 * who said what, follow-ups?" — so the tango decision looked exactly like "Fine,
 * nothing to keep". Every template Gnomon has puts its SUBJECT in the first
 * sentence and its boilerplate after it, so the first question mark is the cut,
 * and the whole question is still in the fold's meta one click away.
 *
 * A question with no `?` in it, or one whose first clause is too short to name
 * anything, keeps all its words: the weekly goals ask opens "New week." and
 * cutting there would leave a row saying nothing at all.
 */
export function askSubject(question) {
  const text = String(question ?? '').trim()
  const end = text.indexOf('?')
  return end > 12 ? text.slice(0, end + 1) : text
}

/**
 * What is IN the answer, for the closed row — one line, or nothing.
 *
 * Three states, because `owner_asks.proposals` has three and they are different
 * facts about the record. `null` is "no model has read this yet" and says
 * NOTHING: a row cannot claim an answer is empty on the strength of not having
 * looked. `[]` is a reading, and "nothing to keep" is what it read. A list is
 * the strongest proposal said as a sentence, with a count when there are more.
 *
 * `said` is `factSentence`, handed in rather than imported so this file stays
 * free of the display layer the way `askCensus` is.
 */
export function askGist(ask, said) {
  const proposals = ask?.proposals
  if (!Array.isArray(proposals)) return null
  if (proposals.length === 0) return { text: 'nothing to keep', empty: true }
  const first = proposals[0]
  return { text: said(first, first.canonicalName), empty: false, more: proposals.length - 1 }
}

/**
 * What the owner's verdicts have DONE to the asking — B1, on its fourth
 * surface: a write the card cannot read back is a button that looks like it did
 * nothing.
 *
 * Until this, a verdict on an ask was recorded and dropped. Now a `wrong` or a
 * `not-now` lowers that whole CLASS's precision (`askClass`/`askPrecision` in
 * `packages/rules/src/owner-ask.ts`), and this is the sentence that says so.
 *
 * Read off `fires` and nothing else. The stored gain is what it was at the
 * verdict and recovers from there, so drawing it would be a stale number, and
 * recomputing the gate's curve on a card would be a second copy of it. What
 * `fires` says is exact: one verdict puts an ask under the bar that lets a
 * question interrupt, two put it under the bar that lets one be listed at all.
 */
export function askQuieting(quieted) {
  return Object.entries(quieted ?? {})
    .filter(([, entry]) => Number(entry?.fires) > 0)
    .sort((a, b) => b[1].fires - a[1].fires)
    .map(([kind, entry]) => ({
      kind,
      words: KIND_WORDS[kind] ?? kind,
      fires: entry.fires,
      // Exactly what the gate will now do with it, in the owner's words.
      effect: entry.fires === 1 ? 'it no longer interrupts you, and waits in the list instead' : 'it stays quiet',
    }))
}

/** Minutes past local midnight, or null. */
export const minuteOfDay = (iso) => {
  const t = iso ? new Date(iso) : null
  return t !== null && Number.isFinite(t.getTime()) ? t.getHours() * 60 + t.getMinutes() : null
}

/** How long the owner was left holding it, in minutes, or null. */
export function waitMinutes(ask) {
  if (!ask?.askedAt || !ask?.answeredAt) return null
  const gap = Date.parse(ask.answeredAt) - Date.parse(ask.askedAt)
  return Number.isFinite(gap) ? Math.max(0, Math.round(gap / 60_000)) : null
}

/** The whole record's asking, as numbers the card states on its face. */
export function askCensus(asks) {
  const rows = Array.isArray(asks) ? asks : []
  const byKind = new Map()
  for (const ask of rows) {
    const kind = askKind(ask.id)
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
  }

  // Asked again, soon, about the same kind of thing. Structural — no reading
  // of any answer — and it is the measure that made the case: on 9 September
  // Gnomon put the same question eight times inside ten minutes, each time
  // after the owner had told it to stop. A precision percentage cannot say
  // that and a repeat count says nothing else.
  const previous = new Map()
  let repeated = 0
  for (const ask of [...rows].sort((a, b) => String(a.askedAt ?? '').localeCompare(String(b.askedAt ?? '')))) {
    const kind = askKind(ask.id)
    const at = Date.parse(ask.askedAt ?? '')
    if (!Number.isFinite(at)) continue
    if (previous.has(kind) && at - previous.get(kind) < 3_600_000) repeated += 1
    previous.set(kind, at)
  }

  const waits = rows.map(waitMinutes).filter((m) => m !== null).sort((a, b) => a - b)
  const judged = rows.filter((a) => a.verdict !== null && a.verdict !== undefined)
  return {
    total: rows.length,
    answered: rows.filter((a) => a.outcome === 'answered').length,
    expired: rows.filter((a) => a.outcome === 'expired').length,
    byKind: [...byKind.entries()].sort((a, b) => b[1] - a[1]),
    repeated,
    // Absent, not zero. No verdict yet is "not measured", and a 0% precision
    // drawn on an unjudged card would read as an answer.
    judged: judged.length,
    worthAsking: judged.length === 0 ? null : judged.filter((a) => a.verdict === 'useful').length,
    medianWait: waits.length === 0 ? null : waits[Math.floor(waits.length / 2)],
    longestWait: waits.length === 0 ? null : waits[waits.length - 1],
    slow: waits.filter((m) => m > 60).length,
    routed: rows.filter((a) => (a.routed ?? []).length > 0).length,
    // The inbox, as two counts. `waiting` is a row with a form filled in and
    // nobody's press on it yet — the work this card is now asking for. `unread`
    // is how far the backfill has got, and it is absent-not-zero on purpose:
    // an answer nobody has looked at is not an answer that held nothing.
    waiting: rows.filter((a) => Array.isArray(a.proposals) && a.proposals.length > 0 && (a.routed ?? []).length === 0).length,
    unread: rows.filter((a) => a.answer && !Array.isArray(a.proposals)).length,
  }
}

/**
 * What the ask's own id determines about a fact drawn from its answer.
 *
 * Only the subject, and only for the one template where the record knows it:
 * a `who is person-<alias>?` question is about that alias and the predicate
 * can only be `knownAs`. Everything else is the owner's to say.
 *
 * The OBJECT is never guessed, and the record says why. The one auto-router
 * that exists (`people-ask`) took the owner's counter-question — "in which
 * meeting where they?" — and wrote it as a human being's name, where it stood
 * until they corrected it. So this fills in what the id proves and leaves the
 * claim itself blank; the answer text goes in the field the owner edits, not
 * in the fact.
 */
export function routePrefill(ask) {
  const tail = String(ask?.id ?? '').replace(/^owner-ask:/, '')
  // `people-ask.ts` mints the id as `owner-ask:who-<alias>` and the alias IS
  // the entity's canonical name (`person-4b3c2d1e0f`), so the subject needs no
  // reconstruction — only the one prefix taken off.
  if (tail.startsWith('who-')) return { entityKind: 'person', canonicalName: tail.slice('who-'.length), predicate: 'knownAs' }
  return { entityKind: 'topic', canonicalName: '', predicate: '' }
}
