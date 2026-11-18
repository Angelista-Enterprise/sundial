// Plan 15 step 5: what Gnomon believes about the owner, each belief with its source, and the corrections this week.
import { getAllEntities, getAllSignalsInRange, getCurrentFactsWithProof } from '@sundial/db/index.js'

/** Five groups at most; the first whose words match the predicate wins. */
export const GROUPS = [
  ['days', 'Your days', /asleep|wake|sleep|bed|day|schedule|hours|morning|evening|break/i],
  ['work', 'Your work', /workson|occupation|role|job|project|tool|device|attended|team|client|employ/i],
  ['ways', 'How you work', /worksby|instruct|prefer|dislike|like|effective|expect|decid|habit|style/i],
  ['plans', 'Your plans', /plan|goal|intend|want|aim/i],
  ['other', 'Other', /.*/],
]

/** "worksOn" → "works on", "asleep_by" → "asleep by". */
export const words = (predicate) => String(predicate).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()

const day = (iso, timeZone = 'UTC') => {
  try {
    return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone }) : ''
  } catch {
    return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }) : ''
  }
}

/** The source of a belief, in plain words. */
export function sourceOf(fact, timeZone) {
  const on = day(fact.validFrom, timeZone)
  if (fact.provenance === 'assertion') return `you said so on ${on}`
  if (fact.provenance === 'conversation') return `from a chat on ${on}`
  const seen = fact.record?.right ?? 0
  return seen > 0 ? `seen ${seen} ${seen === 1 ? 'time' : 'times'}, since ${on}` : `inferred on ${on}`
}

export async function readBeliefs({ state, now }) {
  const [entities, facts, signals] = await Promise.all([getAllEntities(), getCurrentFactsWithProof(), getAllSignalsInRange(new Date(now - 7 * 86_400_000).toISOString(), new Date(now + 1).toISOString(), ['feedback', 'entity'])])
  // The owner entity; an older record may hold the owner as a person under one of the owner's aliases.
  const aliases = new Set((state?.config?.ownerAliases ?? []).map((a) => String(a).trim().toLowerCase()))
  const owner = entities.find((e) => e.kind === 'owner') ?? entities.find((e) => e.kind === 'person' && aliases.has(String(e.canonicalName).trim().toLowerCase()))
  const records = state?.factTests?.records ?? {}
  const mine = owner ? facts.filter((f) => f.entityId === owner.id) : []
  const groups = GROUPS.map(([id, label, re]) => ({ id, label, re, beliefs: [] }))
  for (const fact of mine.sort((a, b) => String(b.validFrom).localeCompare(String(a.validFrom)))) {
    const belief = { id: fact.id, predicate: fact.predicate, says: words(fact.predicate), object: fact.object, source: sourceOf({ ...fact, record: records[fact.id] }, state?.config?.timezone), momentId: fact.momentId ?? null }
    groups.find((g) => g.re.test(fact.predicate)).beliefs.push(belief)
  }
  // A belief corrected on this card: a new value asserted, or a fact marked wrong. Other verdicts with the mark do not count.
  const corrections = signals.filter((s) => s.data?.via === 'belief-page' && (s.signalType === 'entity' || s.data?.artifactKind === 'entity_fact')).length
  return { owner: owner?.canonicalName ?? null, corrections, groups: groups.filter((g) => g.beliefs.length > 0).map(({ id, label, beliefs }) => ({ id, label, beliefs })) }
}
