/**
 * §1's `score(item, query?) = w_r · recency + w_i · importance + w_v · relevance`
 * (docs/design/05-memory-and-knowledgebase.md). Kept as small, pure,
 * independently-testable functions — no context-engine consumer wires this
 * in yet (there is no `buildWcsContext`-equivalent in Gnomon), but `gnomon
 * search`'s ranking uses it directly, which is the one place Gnomon
 * currently reads back episodic/reflective items at all.
 */

const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

/** Exponential decay from `ts` — 1.0 right now, 0.5 after one half-life, asymptotically 0 after that. */
export function computeRecencyWeight(ts: string, now: string, halfLifeMs: number = DEFAULT_HALF_LIFE_MS): number {
  const ageMs = Math.max(0, Date.parse(now) - Date.parse(ts));
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/**
 * C2 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.2's
 * "feed computeMomentImportance") — `signals` is a loose, structural shape
 * (not an import of `@sundial/kernel`'s `MomentRollup`, to avoid a new
 * cross-package dependency for one function signature) so a moment's
 * `rollup` — B4's enrichment — satisfies it directly at the call site
 * without an explicit conversion. A significant life-event during the
 * moment (a real deploy, a big commit, recovering a failing test) now
 * outweighs duration alone; before this, a 45-minute deploy session and a
 * 45-minute idle-browser session scored identically.
 */
export interface ImportanceSignals {
  lifeEvents?: string[];
  notableCommands?: string[];
  gitCommitCount?: number;
}

const SIGNIFICANT_LIFE_EVENTS = new Set(['event:deploy', 'event:big-commit', 'event:test-recovery']);

/**
 * Heuristic 1-10 at write time (§1) — duration is still the base signal
 * (deploy/big-commit/anomaly moments already tend to run longer as a side
 * effect of the work itself, so it was never a bad proxy), now adjusted by
 * whatever `momentRollup` (B4) actually observed during the moment.
 */
/**
 * Duration is mapped through a saturating curve rather than the linear
 * `1 + minutes/30` this used to be, and the result is NOT rounded.
 *
 * Both changes address the same measured failure: 3,542 of 3,571 stored moments
 * scored exactly 1. The old form only reached 1.5 — the first value that rounds
 * to 2 — at 15 minutes, and the median moment is 4 minutes long, so rounding
 * flattened almost the entire corpus onto the floor and the score carried no
 * information at all. A 4-minute glance and a 14-minute stretch of work were
 * indistinguishable.
 *
 * The curve puts its resolution where the data actually is: 4 min ≈ 1.8,
 * 15 min ≈ 3.6, 45 min ≈ 6.7, 3 h ≈ 9.8. Duration remains the base signal and a
 * significant life-event still dominates, exactly as before.
 *
 * The return value is deliberately fractional. `moments.importance_score` is
 * declared `integer()`, but SQLite applies NUMERIC affinity — a value that
 * cannot be losslessly narrowed to an integer is kept as a REAL — so the
 * fraction survives the round trip. That precision is what makes the daily
 * decay behave as its own design intends (see `decayMomentScores`).
 */
export function computeMomentImportance(durationMs: number, signals?: ImportanceSignals): number {
  const minutes = Math.max(0, durationMs / 60_000);
  const base = 1 + 9 * (1 - Math.exp(-minutes / 45));

  const hasSignificantLifeEvent = signals?.lifeEvents?.some((e) => SIGNIFICANT_LIFE_EVENTS.has(e)) ?? false;
  // Git activity now carries magnitude, not a flat +1: a sustained session
  // (>= 5 commits) outweighs a single trivial commit. A notable non-git
  // command still earns the base +1. A significant life-event (+3) dominates.
  const gitCommits = signals?.gitCommitCount ?? 0;
  const hasNotableCommand = (signals?.notableCommands?.length ?? 0) > 0;
  const gitBonus = gitCommits >= 5 ? 2 : gitCommits > 0 || hasNotableCommand ? 1 : 0;
  const bonus = hasSignificantLifeEvent ? 3 : gitBonus;

  return Math.max(1, Math.min(10, base + bonus));
}

export interface ScoreInputs {
  recency: number; // 0-1, see computeRecencyWeight
  /** 0-1. Each ref type maps its OWN quantity onto this range — see `salienceFromScore`/`salienceFromConfidence`. */
  salience: number;
  relevance: number; // 0-1, cosine similarity against a query embedding; 0 when there's no active query
}

export interface ScoreWeights {
  recency: number;
  salience: number;
  relevance: number;
}

/**
 * This parameter used to be `importance`, taking a raw 1-10 domain quantity that
 * `computeScore` divided by 10 itself. That signature is what allowed the defect
 * it now prevents: every caller passed a DIFFERENT quantity, and nothing in the
 * type said they had to agree on a range.
 *
 * A moment passed `importanceScore`, which measured 1.01 on average because the
 * write-time heuristic saturated. An entity fact passed `confidence / 10`, which
 * measured 8.15 because confidence is stored 0-100. Both were nominally "1-10"
 * and both were honest readings of their own domain, so the mismatch was
 * invisible at every call site — yet it handed each fact a flat +0.21 head start
 * over each moment before relevance was consulted, 54% of the entire relevance
 * term. Measured consequence: entity facts took 93% of the top 10 and moments
 * took 0%, while self-retrieval recall@1 sat at 3%.
 *
 * Making the parameter a normalised `salience: 0..1` moves the responsibility to
 * the ref type that owns the quantity, and turns a scale mismatch from something
 * a reader must notice into something the conversion functions below make
 * explicit.
 */
export function salienceFromScore(importanceScore: number): number {
  return Math.min(1, Math.max(0, (importanceScore - 1) / 9));
}

/** `entity_facts.confidence` is a 0-100 Beta posterior, not a 1-10 heuristic. */
export function salienceFromConfidence(confidence: number): number {
  return Math.min(1, Math.max(0, confidence / 100));
}

/**
 * Weights measured with `measure-retrieval.ts` (removed in 9a6988c; recoverable
 * with `git show 9a6988c^:apps/daemon/src/scripts/measure-retrieval.ts`) over the real corpus rather than
 * chosen by taste, because the shipped 0.3/0.3/0.4 was demonstrably wrong and
 * "looks balanced" is what made it look right.
 *
 * Measured on 40 self-retrieval probes over 3,574 real embeddings
 * (recall@1 · moment share of the top ten):
 *
 *     0.3/0.3/0.4  (was shipped)    3% ·  0%
 *     0.15/0.15/0.7                48% · 14%
 *     0.1/0.1/0.8   ← chosen       55% · 30%
 *     0.05/0.05/0.9                58% · 58%
 *     relevance only               58% · 69%
 *
 * The old weighting returned NO moments at all in any top ten, and both
 * non-relevance terms were implicated rather than salience alone: a 0.3 recency
 * weight likewise outranks relevance on an exact textual match.
 *
 * `0.05/0.05/0.9` measures strictly better, and is deliberately not chosen.
 * Self-retrieval is a floor test — the query IS the document, so recency and
 * salience can only ever be noise within it, and any ordering by this metric
 * alone drives every weight to relevance. That would silently discard the
 * "prefer what happened recently" behaviour real questions depend on, which this
 * probe has no way to score. So the metric is used as a threshold to clear, not
 * a quantity to maximise: these weights clear it with margin (55% against a 50%
 * gate) while retaining twice the non-relevance signal of the better-scoring
 * candidate. Re-measure before moving them — `measure-retrieval.ts` failed if
 * whatever was set here was not among the weightings it compared.
 */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = { recency: 0.1, salience: 0.1, relevance: 0.8 };

export function computeScore(inputs: ScoreInputs, weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS): number {
  return weights.recency * inputs.recency + weights.salience * inputs.salience + weights.relevance * inputs.relevance;
}
