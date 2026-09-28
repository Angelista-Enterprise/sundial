import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { askCensus, askGist, askKind, askQuieting, askSubject, routePrefill, waitMinutes } from './asks.js'

/**
 * Shaped like the live record on 2026-09-21: four templates, the
 * who-is-this-attendee one repeated inside a few minutes, one expired.
 */
const LIVE = [
  { id: 'owner-ask:meeting-01M31C7CC0Q9', askedAt: '2026-09-21T08:32:04.940Z', answeredAt: '2026-09-21T08:55:35.045Z', outcome: 'answered', verdict: null, routed: [] },
  { id: 'owner-ask:goals-2026-09-20', askedAt: '2026-09-20T22:08:04.468Z', answeredAt: '2026-09-21T07:38:32.426Z', outcome: 'answered', verdict: null, routed: [] },
  { id: 'owner-ask:meeting-01M2WKQ0', askedAt: '2026-09-18T10:02:29.386Z', answeredAt: null, outcome: 'expired', verdict: null, routed: [] },
  { id: 'owner-ask:who-person-35941f3bc4', askedAt: '2026-09-09T14:22:48.973Z', answeredAt: '2026-09-09T14:24:00.112Z', outcome: 'answered', verdict: 'wrong', routed: [] },
  { id: 'owner-ask:who-person-31321a245a', askedAt: '2026-09-09T14:24:48.974Z', answeredAt: '2026-09-09T14:26:30.237Z', outcome: 'answered', verdict: null, routed: [] },
  { id: 'owner-ask:who-person-74b836557b', askedAt: '2026-09-09T14:26:48.975Z', answeredAt: '2026-09-09T14:28:19.157Z', outcome: 'answered', verdict: 'useful', routed: [{ id: 'f1', subject: 'person-74b836557b', predicate: 'knownAs', object: 'Jordan', retracted: false }] },
  { id: 'owner-ask:mu6o3nsw', askedAt: '2026-09-18T07:59:18.848Z', answeredAt: '2026-09-18T07:59:55.870Z', outcome: 'answered', verdict: null, routed: [] },
]

describe('which question this is', () => {
  it('reads the template off the id, never off the text', () => {
    expect(askKind('owner-ask:who-person-35941f3bc4')).toBe('who')
    expect(askKind('owner-ask:meeting-01M31C7CC0Q9')).toBe('meeting')
    expect(askKind('owner-ask:goals-2026-09-20')).toBe('goals')
    expect(askKind('owner-ask:mu6o3nsw')).toBe('other')
    expect(askKind(undefined)).toBe('other')
  })

  it('reads an id that was minted without the prefix the same way', () => {
    // `ownerAsk` accepts both shapes and re-prefixes; the card must not care.
    expect(askKind('who-person-35941f3bc4')).toBe('who')
  })
})

describe('how long the owner was left holding it', () => {
  it('is minutes, and null when there was no answer', () => {
    expect(waitMinutes(LIVE[0])).toBe(24)
    expect(waitMinutes(LIVE[2])).toBeNull()
  })

  it('counts a question answered the next morning as the whole night', () => {
    // 22:08 to 07:38 is the case a clock column has to survive: the answer is
    // on the following day, so a naive same-day subtraction goes negative.
    expect(waitMinutes(LIVE[1])).toBe(570)
  })
})

describe('the census', () => {
  const c = askCensus(LIVE)

  it('counts the outcomes the record actually holds', () => {
    expect(c.total).toBe(7)
    expect(c.answered).toBe(6)
    expect(c.expired).toBe(1)
  })

  it('counts the templates, commonest first', () => {
    expect(c.byKind[0]).toEqual(['who', 3])
  })

  it('counts a question asked again within the hour about the same kind of thing', () => {
    // Three who-is-this questions, two minutes apart: the second and the third
    // are repeats. Nothing else on this card can say that, and it is a count
    // rather than a reading of any answer.
    expect(c.repeated).toBe(2)
  })

  it('reports precision as absent until the owner has judged something', () => {
    expect(c.judged).toBe(2)
    expect(c.worthAsking).toBe(1)
    expect(askCensus(LIVE.map((a) => ({ ...a, verdict: null }))).worthAsking).toBeNull()
  })

  it('never reports 98% from answered-against-expired', () => {
    // The whole point of the item: `outcome` is answered|expired and nothing
    // else, so the card must not present it as how good the questions were.
    expect(c).not.toHaveProperty('precision')
  })

  it('says how long answers take, and how many were slow', () => {
    expect(c.medianWait).toBe(2)
    expect(c.longestWait).toBe(570)
    expect(c.slow).toBe(1)
  })

  it('counts the answers that became something', () => {
    expect(c.routed).toBe(1)
  })

  it('has an honest empty shape', () => {
    const empty = askCensus([])
    expect(empty.total).toBe(0)
    expect(empty.medianWait).toBeNull()
    expect(empty.worthAsking).toBeNull()
  })
})

describe('what the routing door may fill in for the owner', () => {
  it('fills the subject and predicate a who-is question proves, and never the claim', () => {
    expect(routePrefill(LIVE[3])).toEqual({ entityKind: 'person', canonicalName: 'person-35941f3bc4', predicate: 'knownAs' })
  })

  it('leaves everything blank when the id proves nothing', () => {
    // The record's one auto-routed answer stored a counter-question as a
    // person's name. A guessed object is that bug; a blank field is not.
    expect(routePrefill(LIVE[0])).toEqual({ entityKind: 'topic', canonicalName: '', predicate: '' })
  })
})

describe('what a closed row says about its answer', () => {
  // The complaint this answers: 25 of 49 rows opened with the same eleven
  // words, so the tango decision looked exactly like "Fine, nothing to keep".
  it('cuts the template tail off every question Gnomon has', () => {
    expect(askSubject('How did "Standup" go? Anything worth remembering — decisions, who said what, follow-ups?')).toBe('How did "Standup" go?')
    expect(askSubject('Who is person-d1feb17d9f? They were in "RRA: Kruiswoorden testen" with you.')).toBe('Who is person-d1feb17d9f?')
  })

  it('keeps a question that is all subject, and one with no question mark at all', () => {
    expect(askSubject('Apples or pears?')).toBe('Apples or pears?')
    expect(askSubject('New week. Your open goals: consistent sleep rhythm; gnomon screen recording')).toBe('New week. Your open goals: consistent sleep rhythm; gnomon screen recording')
  })

  const said = (proposal, name) => `${name} ${proposal.predicate} ${proposal.object}.`

  // Three states, and the middle one is the whole reason the column is
  // nullable: a row cannot call an answer empty on the strength of not having
  // looked at it.
  it('says nothing at all about an answer nobody has read', () => {
    expect(askGist({ answer: 'gnomon' }, said)).toBeNull()
    expect(askGist({ answer: 'gnomon', proposals: null }, said)).toBeNull()
  })

  it('says "nothing to keep" only when a model read the answer and found nothing', () => {
    expect(askGist({ proposals: [] }, said)).toEqual({ text: 'nothing to keep', empty: true })
  })

  it('says the strongest reading as a sentence, and counts the rest', () => {
    const proposals = [
      { entityKind: 'project', canonicalName: 'tango', predicate: 'decided', object: 'outline only the anchor cell', confidence: 85 },
      { entityKind: 'person', canonicalName: 'Marco', predicate: 'worksWith', object: 'Pat', confidence: 80 },
    ]
    expect(askGist({ proposals }, said)).toEqual({ text: 'tango decided outline only the anchor cell.', empty: false, more: 1 })
  })
})

describe('the ratio the card exists to move', () => {
  const asks = [
    { id: 'a', askedAt: '2026-09-21T08:00:00.000Z', answeredAt: '2026-09-21T08:01:00.000Z', outcome: 'answered', answer: 'yes', verdict: null, routed: [{ id: 'f1' }], proposals: [{ predicate: 'decided' }] },
    { id: 'b', askedAt: '2026-09-21T09:00:00.000Z', answeredAt: '2026-09-21T09:01:00.000Z', outcome: 'answered', answer: 'yes', verdict: null, routed: [], proposals: [{ predicate: 'decided' }] },
    { id: 'c', askedAt: '2026-09-21T10:00:00.000Z', answeredAt: '2026-09-21T10:01:00.000Z', outcome: 'answered', answer: 'yes', verdict: null, routed: [], proposals: [] },
    { id: 'd', askedAt: '2026-09-21T11:00:00.000Z', answeredAt: '2026-09-21T11:01:00.000Z', outcome: 'answered', answer: 'yes', verdict: null, routed: [], proposals: null },
    { id: 'e', askedAt: '2026-09-21T12:00:00.000Z', answeredAt: null, outcome: 'expired', answer: null, verdict: null, routed: [], proposals: null },
  ]

  it('counts kept, waiting for a press, and not yet read as three different things', () => {
    const c = askCensus(asks)
    expect(c.routed).toBe(1)
    // `b` has a form filled in and nobody's press on it. `a` already became a
    // belief, so it is kept rather than waiting.
    expect(c.waiting).toBe(1)
    // `d` only. `c` was read and held nothing, and `e` has no answer to read.
    expect(c.unread).toBe(1)
  })
})

describe('the class the client shows and the class the gate acts on are one split', () => {
  // `askKind` here and `askClass` in `packages/rules/src/owner-ask.ts` read the
  // same ids for the same four templates, and the shell cannot import the rule:
  // it is plain ES modules served from disk. So the copy is pinned against the
  // rule's own source, which is the "pinned against something that is not
  // itself" rule this client already applies to its colour tokens.
  //
  // It matters because the two are now one mechanism: the card draws a class as
  // quieted and the gate is what quieted it. A drift would have the card naming
  // a class nothing had acted on.
  const rule = readFileSync(join(import.meta.dirname, '../../../packages/rules/src/owner-ask.ts'), 'utf8')
  const body = rule.slice(rule.indexOf('export function askClass'), rule.indexOf('}', rule.indexOf('export function askClass')))

  it('splits the same prefixes onto the same words', () => {
    for (const [prefix, word] of [['who-', 'who'], ['meeting-', 'meeting'], ['goals-', 'goals']]) {
      expect(body, `askClass must map ${prefix} the way askKind does`).toContain(`startsWith('${prefix}')`)
      expect(body).toContain(`return '${word}'`)
      expect(askKind(`owner-ask:${prefix}x`)).toBe(word)
    }
    expect(body, 'and everything else is `other` on both sides').toContain("return 'other'")
    expect(askKind('owner-ask:mtlewddl')).toBe('other')
  })
})

describe('what pressing a word has done to the asking', () => {
  it('says nothing at all when nothing is quieted', () => {
    expect(askQuieting(undefined)).toEqual([])
    expect(askQuieting({})).toEqual([])
  })

  // One verdict puts an ask under `phasicThreshold`; two put it under
  // `tonicThreshold`. Read off `fires`, because the stored gain is what it was
  // at the verdict and recovers from there.
  it('says exactly what the gate will now do, from the count alone', () => {
    const once = askQuieting({ who: { gain: 0.4, at: '2026-09-21T10:44:00.000Z', fires: 1 } })
    expect(once).toEqual([{ kind: 'who', words: 'asking who a calendar attendee is', fires: 1, effect: 'it no longer interrupts you, and waits in the list instead' }])
    expect(askQuieting({ who: { gain: 0.16, at: 'x', fires: 2 } })[0].effect).toBe('it stays quiet')
  })

  it('puts the loudest complaint first and drops an entry that fired zero times', () => {
    const q = askQuieting({ meeting: { gain: 0.4, at: 'a', fires: 1 }, who: { gain: 0.16, at: 'b', fires: 3 }, goals: { gain: 1, at: 'c', fires: 0 } })
    expect(q.map((x) => x.kind)).toEqual(['who', 'meeting'])
  })
})
