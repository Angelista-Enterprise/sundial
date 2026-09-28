import type { JudgementQuestionRecord, JudgementRecent, JudgementResultPayload, KernelState, Rule } from '@sundial/kernel/types.js';
import { questionId } from './questions/index.js';
import { QUESTION_SETS } from './questions/registry.js';

/** How many results a verdict can still find the answers behind. A verdict lands within minutes of its line. */
const MAX_RECENT_JUDGEMENTS = 200;
/** Law 4's learning gate: below this many graded answers the lab's operating points stand. */
export const THRESHOLD_MIN_N = 20;
export const DECILES = 10;

/** The lab's operating points (docs/jarvis/02): top probability ≥ 0.7 for a choice, ≥ 0.5 for a noul or a score level. */
export const defaultThreshold = (type: string): number => (type === 'choice' ? 0.7 : 0.5);

/**
 * Law 5: decide on the probability vector, never on `confidence`. The one
 * number an answer is decided on: a noul's probability, a choice's top
 * probability, a score's probability of the level it picked.
 */
export function answerProbability(answer: JudgementResultPayload['answers'][string]): number | null {
  if (typeof answer.noul === 'number') return answer.noul;
  const probabilities = answer.probabilities ? Object.values(answer.probabilities).filter((v) => typeof v === 'number') : [];
  if (probabilities.length > 0) return Math.max(...probabilities);
  return typeof answer.confidence === 'number' ? answer.confidence : null;
}

export const decileOf = (p: number): number => Math.min(DECILES - 1, Math.max(0, Math.floor(p * DECILES)));

/**
 * The decile edge that maximises accuracy on the reliability bins: an answer
 * at or above the edge is called positive, and it was right when the owner
 * graded it useful; below the edge it is called negative, and it was right
 * when the owner did not. Ties keep the lower edge (say more, not less, until
 * the data says otherwise).
 */
export function bestThreshold(bins: JudgementQuestionRecord['bins']): number {
  let best = { edge: 0, correct: -1 };
  for (let edge = 1; edge < DECILES; edge += 1) {
    let correct = 0;
    for (let d = 0; d < DECILES; d += 1) correct += d >= edge ? bins.hits[d] : bins.n[d] - bins.hits[d];
    if (correct > best.correct) best = { edge, correct };
  }
  return best.edge / DECILES;
}

const emptyRecord = (type: string): JudgementQuestionRecord => ({
  type,
  threshold: defaultThreshold(type),
  n: 0,
  hits: 0,
  bins: { n: Array(DECILES).fill(0), hits: Array(DECILES).fill(0) },
  lastVerdictAt: null,
});

/**
 * Grade one answer with the owner's verdict: the decile its probability fell
 * in gets a count and, when the owner found the line useful, a hit. At
 * `THRESHOLD_MIN_N` graded answers the threshold moves to `bestThreshold`.
 * Pure; used by `feedbackTrack`, never by the executor.
 */
export function gradeAnswer(record: JudgementQuestionRecord, p: number, useful: boolean, ts: string): JudgementQuestionRecord {
  const d = decileOf(p);
  const bins = { n: [...record.bins.n], hits: [...record.bins.hits] };
  bins.n[d] += 1;
  if (useful) bins.hits[d] += 1;
  const n = record.n + 1;
  return {
    ...record,
    n,
    hits: record.hits + (useful ? 1 : 0),
    bins,
    lastVerdictAt: ts,
    threshold: n >= THRESHOLD_MIN_N ? bestThreshold(bins) : record.threshold,
  };
}

/**
 * Folds every `judgement:result` into `state.judgement` (docs/jarvis/02):
 * a question record exists from the first answer, at the lab's default
 * threshold, and the answer's probabilities join `recent` keyed by moment and
 * artifact so the owner's later verdict (`feedbackTrack`) can grade them.
 * The question set's ids come from the registry — pure data, no I/O.
 */
export const judgementTrack: Rule = (state, event) => {
  if (event.type === 'judgement:degraded') {
    const mode = (event.payload as { mode?: unknown }).mode;
    if (mode !== 'none' && mode !== 'local-fallback' && mode !== 'off') return { state, effects: [] };
    if (state.judgement.degraded === mode) return { state, effects: [] };
    // The clock on degraded time: starts when the mark leaves `none`, banks the spell when it returns.
    const since = state.judgement.degradedSince ?? null;
    const degradedMs = (state.judgement.degradedMs ?? 0) + (mode === 'none' && since ? Math.max(0, Date.parse(event.ts) - Date.parse(since)) : 0);
    const degradedSince = mode === 'none' ? null : (since ?? event.ts);
    return { state: { ...state, judgement: { ...state.judgement, degraded: mode, degradedSince, degradedMs } }, effects: [] };
  }
  if (event.type !== 'judgement:result') return { state, effects: [] };

  const payload = event.payload as unknown as JudgementResultPayload;
  const set = QUESTION_SETS.find((s) => s.id === payload.questionSetId);
  if (!set || typeof payload.answers !== 'object' || payload.answers === null) return { state, effects: [] };

  // The set's questions by key → id. A set builds the same questions for every
  // input (the snapshot test pins that), so any sample's questions will do.
  const sample = set.samples()[0];
  const questions = sample ? set.build(...sample).questions : {};

  const records: KernelState['judgement']['questions'] = { ...state.judgement.questions };
  const p: Record<string, number> = {};
  for (const [key, answer] of Object.entries(payload.answers)) {
    const question = questions[key];
    if (!question) continue;
    const id = questionId(question);
    const probability = answerProbability(answer);
    if (probability === null) continue;
    p[id] = probability;
    records[id] ??= emptyRecord(question.type);
  }

  const metadataArtifact = payload.metadata?.artifactId;
  const entry: JudgementRecent = {
    ts: event.ts,
    questionSetId: payload.questionSetId,
    momentId: payload.momentId ?? null,
    artifactId: typeof metadataArtifact === 'string' ? metadataArtifact : null,
    p,
  };

  // A backfilled answer (J2.6's rejudge job) opens records like any other but
  // stays out of the rings: seven thousand of them in a minute would flush what
  // the owner's next verdict needs to find the live answers behind a line.
  if (payload.metadata?.backfill === true) return { state: { ...state, judgement: { ...state.judgement, questions: records } }, effects: [] };
  // Tagged with an artifact (a notice key, a fact id): its own ring. Otherwise
  // by moment — and two results for one moment (the fan-out and the line's
  // judge) MERGE into one entry, so the ring holds moments, not calls.
  if (entry.artifactId !== null) {
    const recentByArtifact = [...(state.judgement.recentByArtifact ?? []).filter((r) => r.artifactId !== entry.artifactId), entry].slice(-MAX_RECENT_JUDGEMENTS);
    return { state: { ...state, judgement: { ...state.judgement, questions: records, recentByArtifact } }, effects: [] };
  }
  const existing = entry.momentId === null ? -1 : state.judgement.recent.findIndex((r) => r.momentId === entry.momentId);
  const recent =
    existing === -1
      ? [...state.judgement.recent, entry].slice(-MAX_RECENT_JUDGEMENTS)
      : state.judgement.recent.map((r, i) => (i === existing ? { ...r, ts: entry.ts, p: { ...r.p, ...entry.p } } : r));
  return {
    state: {
      ...state,
      judgement: { ...state.judgement, questions: records, recent },
    },
    effects: [],
  };
};
