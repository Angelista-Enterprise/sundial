// Rerank before ask (J1.3): the candidates `gnomon_semantic_search` retrieved
// go through Jev's `rank-evidence` set, and only the ones that answer the
// question reach the prompt. Bench (RESULTS.md, J1.3a): hit@1 95 %, the right
// note kept 35/40 at θ 0.5, 1.3 of 8 candidates survive.
//
// The tool keeps its shape — an array of hits — so the model reads it as it
// always did; each hit gains `relevance`, and the array is ordered by it. The
// top-ranked hit is always kept: a search that found something must never
// come back empty because the judge was strict. Jev down, off, or over
// budget → the hits exactly as the retriever ranked them.
import { questionId } from '@sundial/rules/questions/index.js'
import { RANK_EVIDENCE_QUESTIONS, rankEvidence, relevance, slotKey } from '@sundial/rules/questions/rank-evidence.js'

const DEFAULT_THRESHOLD = 0.5

/** @param {{ judgeNow: Function, getState: Function, log?: Function }} deps */
export function createRerank({ judgeNow, getState, log = console.log }) {
  /** The slot's own learned threshold (law 4), or the default until it has one. */
  const thresholdFor = (slot) => getState()?.judgement?.questions?.[questionId(RANK_EVIDENCE_QUESTIONS[slot])]?.threshold ?? DEFAULT_THRESHOLD

  return async function rerank(query, hits) {
    if (!Array.isArray(hits) || hits.length < 2 || typeof query !== 'string' || query.trim() === '') return hits
    const built = rankEvidence.build({ query, question: query, candidates: hits.map((h) => `${h.label ?? ''}: ${h.text ?? ''}`) })
    const judged = await judgeNow({ purpose: 'rank', questionSetId: rankEvidence.id, momentId: null, state: built.state, questions: built.questions })
    if (judged === null) return hits

    const scored = hits.map((hit, i) => ({ hit, slot: slotKey(i), relevance: relevance(judged.answers?.[slotKey(i)]) }))
    // A slot the judge left unanswered keeps the retriever's word: not dropped.
    const kept = scored.filter((s) => s.relevance === null || s.relevance >= thresholdFor(s.slot))
    const top = scored.reduce((best, s) => ((s.relevance ?? -1) > (best.relevance ?? -1) ? s : best), scored[0])
    if (!kept.includes(top)) kept.unshift(top)
    kept.sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1))
    log(`[sundial-tools] rerank kept ${kept.length}/${hits.length} for "${query.slice(0, 60)}"`)
    return kept.map((s) => (s.relevance === null ? s.hit : { ...s.hit, relevance: Number(s.relevance.toFixed(2)) }))
  }
}
