// The questions Gnomon asked the owner, joined to the owner's verdict on each question, what each answer became in memory, and the answer's own event id.
import { getFactsBySourceEventIds, getRecentOwnerAsks, getSignalsInRange } from '@sundial/db/index.js'

export async function readAsks({ state, now }) {
  // Pinned to the whole record and the card says so, which is the case
  // DESIGN.md allows: asking is a habit measured over weeks, and a span of
  // Today would empty the card most mornings. Capped well above the live 48
  // so the census cannot be quietly computed over a truncated list.
  const asks = await getRecentOwnerAsks(500)
  if (asks.length === 0) return { asks: [] }
  const from = asks[asks.length - 1].askedAt
  const to = new Date(now + 60_000).toISOString()
  const [askSignals, feedbackSignals] = await Promise.all([
    getSignalsInRange(from, to, 4000, ['ask']),
    getSignalsInRange(from, to, 4000, ['feedback']),
  ])

  const answerEventId = new Map()
  for (const signal of askSignals) {
    if (signal.eventType !== 'owner-answered') continue
    const askId = typeof signal.data?.askId === 'string' ? signal.data.askId : null
    if (askId !== null) answerEventId.set(askId, signal.id)
  }
  const routed = new Map()
  for (const fact of await getFactsBySourceEventIds([...new Set(answerEventId.values())])) {
    const list = routed.get(fact.sourceEventId) ?? []
    list.push({ id: fact.id, subject: fact.canonicalName, predicate: fact.predicate, object: fact.object, provenance: fact.provenance, retracted: fact.validTo !== null })
    routed.set(fact.sourceEventId, list)
  }
  const verdicts = new Map()
  for (const signal of feedbackSignals) {
    const { artifactKind, artifactId, verdict } = signal.data ?? {}
    if (artifactKind === 'owner_ask' && typeof artifactId === 'string' && typeof verdict === 'string') verdicts.set(artifactId, { verdict, at: signal.capturedAt })
  }

  // What the verdicts DID, which is new: a `wrong` or `not-now` on an ask now
  // lowers that whole CLASS's precision (`askClass`/`askPrecision`), and B1
  // says a write the card cannot read back is a button that looks like it did
  // nothing. Read from the fold rather than recomputed here — the gate's
  // arithmetic has one home.
  // Handed over as `fires` and `at`, NOT as a gain. The stored gain is what
  // it was at the verdict and recovers from there, so printing it would be a
  // stale number; recomputing it here would be a second copy of the gate's
  // curve on a surface that has no business owning one. What `fires` says is
  // exact and needs no arithmetic: once means the class stopped interrupting,
  // twice or more means it went silent.
  const quieted = state?.ownerAsk?.classGain ?? {}

  return {
    quieted,
    asks: asks.map((a) => {
      const eventId = answerEventId.get(a.id) ?? null
      const rated = verdicts.get(a.id)
      return {
        id: a.id,
        question: a.question,
        reason: a.reason,
        askedAt: a.askedAt,
        answer: a.answer,
        answeredAt: a.answeredAt,
        outcome: a.outcome,
        // H1's three states, carried through as three: `null` is nobody has
        // read this answer yet, `[]` is read and there was nothing in it, and
        // a list is a form waiting for one press. The card says different
        // things about all three.
        proposals: a.proposals,
        answerEventId: eventId,
        routed: (eventId === null ? null : routed.get(eventId)) ?? [],
        verdict: rated?.verdict ?? null,
        verdictAt: rated?.at ?? null,
      }
    }),
  }
}
