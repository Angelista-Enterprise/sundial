/**
 * Lexical scoring and rank fusion — the two halves of Zep's retrieval pipeline
 * Gnomon was missing.
 *
 * `scoredSearch` ranked on one signal: cosine similarity against a local embedding
 * model, blended with recency and salience. Zep (arXiv:2501.13956) fuses four
 * retrievers — semantic, BM25, graph traversal, then reranking — and its measured
 * advantage on DMR and LongMemEval comes from the combination rather than from any
 * one of them. This module supplies the lexical retriever and the fusion; the graph
 * hop lives in `scored-search.ts` where the fact rows are already in hand.
 *
 * BM25 is computed IN PROCESS rather than through an FTS5 virtual table, which is a
 * deliberate simplification of the original plan. `scoredSearch` already reads every
 * embedding row and resolves every underlying document on each query — the linear
 * scan `embeddings.ts` documents as the accepted design at this corpus size — so the
 * texts BM25 needs are in memory before this is called. A virtual table would add a
 * schema migration, a second write path to keep in sync, and a source of truth that
 * can silently drift from `memory_embeddings`, to index a few thousand short
 * documents. If the linear scan is ever replaced by a real vector index, this should
 * move to FTS5 in the same change, for the same reason.
 */

/**
 * BM25 free parameters, at their standard values.
 *
 * `k1` controls how fast term frequency saturates — a word appearing five times
 * rather than once matters, but not five times as much. `b` controls length
 * normalisation, how much a long document is penalised for its length. 1.2/0.75 are
 * the values the literature settled on; they are not tuned here because tuning
 * retrieval weights against one's own corpus is precisely the trap the salience
 * normalisation defect fell into once already.
 */
const K1 = 1.2;
const B = 0.75;

/** Words carrying no retrieval signal, dropped from the query only. */
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'is', 'was', 'were', 'be', 'been', 'did', 'do', 'does', 'i', 'me', 'my', 'it', 'this', 'that', 'what', 'when', 'who', 'how', 'which']);

/**
 * Splits text into comparable terms.
 *
 * Deliberately keeps digits and splits on everything else, because the queries BM25
 * exists to serve here are exactly the ones embeddings handle worst: a ticket id
 * (`BOX-508`), a branch name, a process name, a rare proper noun. Lowercased so
 * matching is case-insensitive; not stemmed, because stemming a corpus this small
 * and this full of identifiers loses more than it merges.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export interface LexicalDoc {
  id: string;
  text: string;
}

/**
 * BM25 relevance of every document to `query`, keyed by document id.
 *
 * Documents scoring zero are omitted rather than included at zero — a caller fusing
 * by RANK must not be handed a tail of irrelevant documents all tied at the bottom,
 * because rank fusion would then reward them for placing above nothing.
 */
export function bm25(query: string, docs: LexicalDoc[]): Map<string, number> {
  const terms = tokenize(query).filter((t) => !STOP_WORDS.has(t));
  const scores = new Map<string, number>();
  if (terms.length === 0 || docs.length === 0) return scores;

  const tokenized = docs.map((doc) => ({ id: doc.id, tokens: tokenize(doc.text) }));
  const avgLength = tokenized.reduce((sum, d) => sum + d.tokens.length, 0) / tokenized.length || 1;

  // Document frequency per query term, computed once rather than per document.
  const docFrequency = new Map<string, number>();
  for (const term of new Set(terms)) {
    docFrequency.set(term, tokenized.filter((d) => d.tokens.includes(term)).length);
  }

  for (const doc of tokenized) {
    let score = 0;
    for (const term of terms) {
      const n = docFrequency.get(term) ?? 0;
      if (n === 0) continue;
      const frequency = doc.tokens.filter((t) => t === term).length;
      if (frequency === 0) continue;
      // Standard BM25 IDF with the +0.5 smoothing that keeps a term appearing in
      // every document from going negative.
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      const normalized = frequency * (K1 + 1);
      const denominator = frequency + K1 * (1 - B + (B * doc.tokens.length) / avgLength);
      score += idf * (normalized / denominator);
    }
    if (score > 0) scores.set(doc.id, score);
  }

  return scores;
}

/**
 * Reciprocal rank fusion: combine several rankings of the same items into one.
 *
 * Fuses by RANK POSITION, never by score, and that is the whole reason to prefer it
 * here. A cosine similarity and a BM25 score are not on the same scale, do not have
 * the same distribution, and cannot be compared or weighted without a tuning
 * exercise against the very corpus the result is meant to be honest about. RRF needs
 * no such exercise: an item ranked second by one retriever and ninth by another gets
 * a defensible combined position with no free parameters except `k`.
 *
 * `k` damps the influence of the very top ranks so that one retriever's confident
 * first place cannot by itself decide the fused order. 60 is the value from the
 * original RRF paper and is used unchanged, for the same reason K1/B are.
 */
export function reciprocalRankFusion(rankings: Array<Map<string, number>>, k = 60, weights: number[] = []): Map<string, number> {
  const fused = new Map<string, number>();

  for (const [index, ranking] of rankings.entries()) {
    // A retriever's vote can be scaled: measured on the live corpus
    // (`lab/measure-retrieval.mjs`, 2026-09-05), equal votes let the lexical
    // pass overturn an exact semantic match — hit@1 on title queries fell from
    // 0.80 to 0.40 — so the semantic ranking carries the full vote and the
    // others a fraction, enough to lift a rare token the embedding cannot place.
    const weight = weights[index] ?? 1;
    if (weight <= 0) continue;
    // Descending by score gives the rank order this retriever asserts.
    const ordered = [...ranking.entries()].sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < ordered.length; i++) {
      const id = ordered[i]![0];
      fused.set(id, (fused.get(id) ?? 0) + weight / (k + i + 1));
    }
  }

  return fused;
}

/**
 * How much the lexical retriever's vote should count for THIS query.
 *
 * Measured on the live corpus (`lab/measure-retrieval.mjs`, 2026-09-05): a
 * fixed lexical weight cannot serve both kinds of query. At equal votes,
 * rare-token queries (a ticket id, a branch slug) went from MRR 0.05 to 0.40
 * while exact prose queries (a title) fell from hit@1 0.80 to 0.40; at 0.3 the
 * prose recovered and the rare tokens fell back to 0.10. The two kinds are
 * recognisable from the query alone: an identifier carries digits, hyphens,
 * or is a single long token, and prose does not. So the vote follows the query.
 */
export function lexicalWeightFor(query: string, prose = 0.3, identifier = 1): number {
  const terms = tokenize(query).filter((t) => !STOP_WORDS.has(t));
  if (terms.length === 0) return prose;
  const raw = query.trim();
  const looksLikeIdentifier =
    terms.length === 1 ||
    /\d/.test(raw) ||
    // A slug (two or more hyphens) or a ticket id (hyphen next to a digit); a
    // single hyphenated word ("Claude-heavy afternoon") is still prose.
    /[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/i.test(raw) ||
    /[a-z]+-\d|\d-[a-z]/i.test(raw) ||
    /[a-z][A-Z]/.test(raw) || // camelCase
    /[\/_.:#]/.test(raw); // a path, a file, a PR number
  return looksLikeIdentifier ? identifier : prose;
}
