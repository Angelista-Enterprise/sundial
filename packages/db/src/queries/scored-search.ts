import { bm25, computeEmbedding, computeRecencyWeight, computeScore, cosineSimilarity, lexicalWeightFor, reciprocalRankFusion, salienceFromConfidence, salienceFromScore } from '@sundial/memory/index.js';
import { embeddingSpace } from '@sundial/helpers/moment-embed-text.js';
import { deleteEmbeddingsByIds, getAllEmbeddings } from './embeddings.js';
import { getEntityFactsWithEntityByIds } from './entities.js';
import { getKnowledgeEntriesByIds, touchKnowledgeAccessBatch } from './knowledge-entries.js';
import { getMomentsByIds, touchMomentAccessBatch } from './moments.js';

export interface ScoredSearchHit {
  refType: 'moment' | 'knowledge_entry' | 'entity_fact';
  refId: string;
  score: number;
  /**
   * What this hit IS, in the owner's words — a moment's intent, an entry's
   * title, the name a fact is about. It used to be the ref type, the ISO
   * instant and the process name concatenated, which is a debug line: a reader
   * got `moment  2026-09-10T07:38:22.862Z  Obsidian` above a `text` that
   * repeated all three. The instant moved to `at`, where a surface can format
   * it, and the type is already `refType`.
   */
  label: string;
  /** When the hit happened, ISO — the same instant its ranking used for recency. */
  at: string;
  /** The retrieval text: what BM25 indexes and what a reading quotes. Never trimmed for display. */
  text: string;
}

/**
 * Shared by `gnomon search`, `gnomon ask`, and the MCP `gnomon_semantic_search`
 * tool — one implementation of §1's scored ranking (recency + importance +
 * relevance) over `memory_embeddings`, rather than three near-duplicates.
 * Linear scan, not a vector index (see `embeddings.ts`'s doc comment).
 * Bumps `lastAccessedAt` on every returned hit (an LRU-like signal,
 * independent of `memoryDecay`) — callers don't need to remember to do this
 * themselves.
 *
 * D2 (docs/audit/production-proposal-and-enhancements.md, fixes A§2.2,
 * A§2.3) — the vector scan is still a full table read (unavoidable without
 * a real vector index, per `embeddings.ts`'s doc comment), but resolving
 * each hit's underlying moment/knowledge entry is now two batched
 * `IN (...)` queries total, not one `getMomentById`/`getKnowledgeEntryById`
 * round-trip per embedding row. Orphaned embeddings found during the same
 * scan (their ref no longer resolves) are deleted right here instead of
 * waiting for a separate sweep to re-derive the same fact later, and the
 * post-ranking access-touch is one batched `UPDATE ... WHERE id IN (...)`
 * per ref type instead of one per hit.
 *
 * D1 (fixes A§5.4) — the query itself is embedded with the same
 * `computeEmbedding` a moment/knowledge-entry's own vector was (a real
 * local model if one's reachable, the hashing-trick fallback otherwise).
 * A stored vector whose `model` tag differs from the query's scheme is
 * skipped outright: it lives in a different semantic space, so comparing it
 * is meaningless. This replaces relying on `cosineSimilarity`'s length check
 * alone (which only caught scheme changes that also changed the dimension —
 * two different 384-dim models would have silently cross-compared).
 *
 * D3 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.5) —
 * `entity_fact` is a third resolvable ref type alongside moment/
 * knowledge_entry. A fact's `confidence` (stored 0-100) stands in for
 * `importance` (expected 1-10, see `score.ts`), and `validFrom` for the
 * recency timestamp. Unlike the other two ref types, a fact row is never
 * deleted on supersession (`entities.ts`'s "never overwritten" model) — so
 * "the ref no longer resolves" isn't the only staleness signal here; a fact
 * with `validTo` set has resolved to a *superseded* fact, no longer current
 * knowledge, and is swept via the same `orphanedEmbeddingIds` mechanism D2
 * already uses for a genuinely-deleted ref (same effect — the embedding
 * shouldn't keep surfacing — different cause).
 */
export interface ScoredSearchOptions {
  /**
   * `false` ranks by the semantic (embedding × recency × salience) score alone —
   * the retriever as it was before 2026-08. Exists for measurement
   * (`lab/measure-retrieval.mjs` compares the two on the live corpus); every
   * product caller leaves it on.
   */
  fusion?: boolean;
  /** Per-retriever vote weights for the rank fusion. Defaults to `DEFAULT_FUSION_WEIGHTS`; exists for measurement. */
  weights?: { semantic?: number; lexical?: number; graph?: number };
}

/**
 * Chosen by measurement, not taste — see `lab/measure-retrieval.mjs` and the
 * numbers in its commit. Semantic carries the full vote. The lexical vote
 * FOLLOWS THE QUERY (`lexicalWeightFor`): full for an identifier-shaped query
 * the embedding cannot place, a boost for prose. The graph hop is a small vote
 * always: its job is to bring a colleague's other facts into the top five,
 * never to displace an exact hit from the top.
 */
export const DEFAULT_FUSION_WEIGHTS = { semantic: 1, lexical: undefined as number | undefined, graph: 0.15 };

export async function scoredSearch(query: string, limit: number, now: string = new Date().toISOString(), options: ScoredSearchOptions = {}): Promise<ScoredSearchHit[]> {
  const { vector: queryVector, model: queryModel } = await computeEmbedding(query);
  const embeddings = await getAllEmbeddings();

  const momentIds = embeddings.filter((e) => e.refType === 'moment').map((e) => e.refId);
  const knowledgeIds = embeddings.filter((e) => e.refType === 'knowledge_entry').map((e) => e.refId);
  const factIds = embeddings.filter((e) => e.refType === 'entity_fact').map((e) => e.refId);

  const [moments, knowledgeEntries, facts] = await Promise.all([getMomentsByIds(momentIds), getKnowledgeEntriesByIds(knowledgeIds), getEntityFactsWithEntityByIds(factIds)]);
  const momentsById = new Map(moments.map((m) => [m.id, m]));
  const knowledgeById = new Map(knowledgeEntries.map((k) => [k.id, k]));
  const factsById = new Map(facts.map((f) => [f.id, f]));

  const resolved: ScoredSearchHit[] = [];
  const orphanedEmbeddingIds: string[] = [];

  for (const embedding of embeddings) {
    // Never compare across embedding schemes: a row tagged with a different
    // model lives in a different vector space (see D1). Skipped, not scored 0
    // — it's not orphaned debris, just incompatible with the current scheme,
    // and a backfill (`reembedStaleEmbeddings`) migrates it forward.
    if (embeddingSpace(embedding.model) !== queryModel) continue;
    const relevance = cosineSimilarity(queryVector, embedding.vector);

    if (embedding.refType === 'moment') {
      const moment = momentsById.get(embedding.refId);
      if (!moment) {
        orphanedEmbeddingIds.push(embedding.id);
        continue;
      }
      const score = computeScore({ recency: computeRecencyWeight(moment.startTime, now), salience: salienceFromScore(moment.importanceScore), relevance });
      const windowTitles = (moment.data.windowTitles as string[] | undefined)?.join(', ') ?? '';
      // Pages the browser sensor saw during the moment (host+path): a URL path
      // carries the ticket, the repo, the document — tokens the lexical
      // retriever is for and a window title rarely holds.
      const pages = (moment.data.pages as string[] | undefined)?.join(', ') ?? '';
      // The intent pass's sentence when it ran, the first window title when it
      // did not, the app when there was no title either. Never all three at
      // once: the point of a label is that it is the one line a reader needs.
      const intent = (moment.data.intent as { text?: string } | undefined)?.text;
      const firstTitle = (moment.data.windowTitles as string[] | undefined)?.[0];
      resolved.push({
        refType: 'moment',
        refId: moment.id,
        score,
        label: intent || firstTitle || moment.processName,
        at: moment.startTime,
        text: `[moment ${moment.startTime}] ${moment.processName}: ${windowTitles}${pages ? ` — ${pages}` : ''}`,
      });
      continue;
    }

    if (embedding.refType === 'entity_fact') {
      const fact = factsById.get(embedding.refId);
      if (!fact || fact.validTo !== null) {
        orphanedEmbeddingIds.push(embedding.id);
        continue;
      }
      const score = computeScore({ recency: computeRecencyWeight(fact.validFrom, now), salience: salienceFromConfidence(fact.confidence), relevance });
      resolved.push({
        refType: 'entity_fact',
        refId: fact.id,
        score,
        label: fact.canonicalName,
        at: fact.validFrom,
        text: `${fact.canonicalName} ${fact.predicate} ${fact.object}`,
      });
      continue;
    }

    // A RETRACTED entry is swept exactly as a superseded fact is, and for the
    // same reason: the row survives as history, but the claim must never be
    // handed to a later question as evidence. Without this, correcting an
    // insight would leave it ranking — and Gnomon would go on citing something
    // the owner had already said was false.
    const entry = knowledgeById.get(embedding.refId);
    if (!entry || entry.retractedAt !== null) {
      orphanedEmbeddingIds.push(embedding.id);
      continue;
    }
    const score = computeScore({ recency: computeRecencyWeight(entry.createdAt, now), salience: salienceFromScore(entry.importanceScore), relevance });
    resolved.push({
      refType: 'knowledge_entry',
      refId: entry.id,
      score,
      label: entry.title,
      at: entry.createdAt,
      text: `[${entry.kind} ${entry.createdAt}] ${entry.title}: ${entry.body}`,
    });
  }

  if (orphanedEmbeddingIds.length > 0) await deleteEmbeddingsByIds(orphanedEmbeddingIds);

  // ---- Phase 2: fuse a lexical ranking with the semantic one ----
  //
  // The semantic score above is one retriever. On its own it is weakest on exactly
  // the queries a personal knowledgebase gets most: a ticket id, a branch, a process
  // name, a colleague's surname — rare tokens a small local embedding model maps
  // poorly. BM25 is strongest there and weakest where the embedding is strong, which
  // is what makes fusing them worth more than either.
  //
  // Fused by rank, not by score: see `reciprocalRankFusion`. The blended
  // recency/salience/relevance score stays as the semantic retriever's OWN ranking
  // rather than being replaced, so recency and salience keep the influence the
  // corpus already calibrated them for.
  const byId = new Map(resolved.map((hit) => [`${hit.refType}:${hit.refId}`, hit]));
  const semanticRanking = new Map([...byId].map(([key, hit]) => [key, hit.score]));
  const lexicalRanking = bm25(
    query,
    [...byId].map(([key, hit]) => ({ id: key, text: hit.text })),
  );

  // One hop out from every fact the lexical retriever matched, so a query naming a
  // person also surfaces what is known about their projects. Bounded to facts
  // already resolved in this scan — this adds no query and cannot walk the graph
  // unboundedly; it only re-weights rows the search had already loaded.
  const graphRanking = new Map<string, number>();
  const matchedEntityIds = new Set<string>();
  for (const key of lexicalRanking.keys()) {
    const hit = byId.get(key);
    if (hit?.refType !== 'entity_fact') continue;
    const entityId = factsById.get(hit.refId)?.entityId;
    if (entityId) matchedEntityIds.add(entityId);
  }
  if (matchedEntityIds.size > 0) {
    for (const [key, hit] of byId) {
      if (hit.refType !== 'entity_fact') continue;
      const fact = factsById.get(hit.refId);
      if (fact && matchedEntityIds.has(fact.entityId)) graphRanking.set(key, fact.confidence);
    }
  }

  const weights = { ...DEFAULT_FUSION_WEIGHTS, ...(options.weights ?? {}) };
  const rankings = [semanticRanking, lexicalRanking];
  const votes = [weights.semantic ?? 1, weights.lexical ?? lexicalWeightFor(query)];
  if (graphRanking.size > 0) {
    rankings.push(graphRanking);
    votes.push(weights.graph ?? 0.15);
  }
  const fused = options.fusion === false ? semanticRanking : reciprocalRankFusion(rankings, 60, votes);

  const ranked = [...byId]
    .map(([key, hit]) => ({ ...hit, score: fused.get(key) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const rankedMomentIds = ranked.filter((h) => h.refType === 'moment').map((h) => h.refId);
  const rankedKnowledgeIds = ranked.filter((h) => h.refType === 'knowledge_entry').map((h) => h.refId);
  await Promise.all([touchMomentAccessBatch(rankedMomentIds, now), touchKnowledgeAccessBatch(rankedKnowledgeIds, now)]);

  return ranked;
}
