// Memory — every name Gnomon holds a belief about, with the beliefs ON it (current facts with proof, the graph between names, each belief's record).
import { factRecordLine } from '@sundial/kernel/fact-tests.js'
import { getAllEntities, getCurrentFactsWithProof, getEntityGraphEdges } from '@sundial/db/index.js'

export async function readMemory({ state }) {
  const [everything, edges, facts] = await Promise.all([getAllEntities(), getEntityGraphEdges(), getCurrentFactsWithProof()])
  // W2 — an entity with no CURRENT fact is a shell: everything it held was
  // retracted or superseded. The world-hygiene pass left 67 topics like that
  // (code symbols whose one fact came from a retired producer), and served
  // they read as "75 topics" on a record holding eight. Absent, not zero.
  const held = new Set(facts.map((fact) => fact.entityId))
  const entities = everything.filter((entity) => held.has(entity.id))

  const byEntity = new Map()
  // lane C: each testable belief's record against what the owner then did.
  const records = state?.factTests?.records ?? {}
  for (const fact of facts) {
    const list = byEntity.get(fact.entityId) ?? []
    const record = records[fact.id]
    list.push({
      record: record && factRecordLine(record) ? { right: record.right, wrong: record.wrong, line: factRecordLine(record) } : null,
      id: fact.id,
      predicate: fact.predicate,
      object: fact.object,
      confidence: fact.confidence,
      alpha: fact.alpha,
      validFrom: fact.validFrom,
      provenance: fact.provenance,
      momentId: fact.momentId ?? null,
      momentStart: fact.momentStart ?? null,
    })
    byEntity.set(fact.entityId, list)
  }

  const byKind = new Map()
  for (const entity of entities) byKind.set(entity.kind, (byKind.get(entity.kind) ?? 0) + 1)

  const rows = entities.map((entity) => {
    const own = byEntity.get(entity.id) ?? []
    return {
      id: entity.id,
      kind: entity.kind,
      canonicalName: entity.canonicalName,
      facts: own,
      // `getAllEntities().factCount` counts superseded rows too. The card
      // draws current belief, so the number beside a name is the number of
      // rows its fold opens on — a reader and a renderer disagreeing about a
      // count is exactly what F exists to catch.
      factCount: own.length,
      ownerSaid: own.filter((f) => f.provenance === 'assertion').length,
      lastLearned: own.reduce((latest, f) => (String(f.validFrom) > latest ? String(f.validFrom) : latest), ''),
    }
  })

  return {
    counts: {
      entities: entities.length,
      facts: facts.length,
      // What can actually be SHOWN as evidence, said three ways because the
      // three are different answers, not one number with holes in it.
      ownerSaid: facts.filter((f) => f.provenance === 'assertion').length,
      proved: facts.filter((f) => f.momentId).length,
      edges: edges.length,
      // A superseded edge is history, not belief: counted apart so "what does
      // it think now" and "what has it changed its mind about" stay separate.
      supersededEdges: edges.filter((edge) => edge.superseded).length,
      byKind: [...byKind.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    },
    // Most-known first: an entity with one fact is a name, and an entity with
    // twenty is something Gnomon actually has a picture of.
    entities: rows.sort((a, b) => b.factCount - a.factCount || String(b.lastLearned).localeCompare(String(a.lastLearned))),
  }
}
