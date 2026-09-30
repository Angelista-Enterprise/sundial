/**
 * `rank-evidence` — pointwise relevance of retrieved candidates to a question
 * (J1.3). The lab's `rank` probe: pointwise 83 % > listwise 80 % > pairwise
 * 77 % at a fifth of the tokens, target 1.62 vs distractors 0.36 on the
 * 0–3 scale. The candidates sit in STATE, under fixed keys, and each question
 * names its key — so the ids are twelve stable ones (law 4), not one per
 * candidate text, and a threshold can be learned for "slot c3 answers it".
 *
 * Consumed as `relevance(answer)` = P(level ≥ 2), "partly or directly
 * answers it" — the probability the consuming tool gates on (law 5, law 6).
 */
import type { JudgeQuestion } from '@sundial/kernel/types.js';
import { clip, score, type QuestionSet, keyed } from './index.js';

export const MAX_CANDIDATES = 12;
export const CANDIDATE_MAX_CHARS = 300;

export interface RankEvidenceInput {
  question: string;
  /** Already-sanitized candidate texts (`label: text`), in retrieval order. At most twelve reach the judge. */
  candidates: string[];
}

const LEVELS = ['Unrelated.', 'Touches the topic but does not answer it.', 'Partly answers it.', 'Directly answers it.'];
export const slotKey = (i: number): string => `c${i}`;
const slotQuestion = (i: number): JudgeQuestion => score(`How well does \`candidates.${slotKey(i)}\` answer \`question\`?`, LEVELS);

/** The twelve slot questions, fixed. */
export const RANK_EVIDENCE_QUESTIONS: Record<string, JudgeQuestion> = keyed('rank-evidence', Object.fromEntries(Array.from({ length: MAX_CANDIDATES }, (_, i) => [slotKey(i), slotQuestion(i)])));

/** P(level ≥ 2) off the vector; null when the answer carries no vector. */
export function relevance(answer: { probabilities?: Record<string, number>; score?: number } | undefined): number | null {
  const p = answer?.probabilities;
  if (p) {
    const mass = Object.entries(p).reduce((sum, [level, v]) => (Number(level) >= 2 && typeof v === 'number' ? sum + v : sum), 0);
    return Math.min(1, Math.max(0, mass));
  }
  return typeof answer?.score === 'number' ? (answer.score >= 2 ? 1 : 0) : null;
}

export const rankEvidence: QuestionSet<[RankEvidenceInput]> = {
  id: 'rank-evidence',
  build: (input) => {
    const kept = input.candidates.slice(0, MAX_CANDIDATES);
    return {
      state: { question: clip(input.question), candidates: Object.fromEntries(kept.map((c, i) => [slotKey(i), clip(c, CANDIDATE_MAX_CHARS)])) },
      questions: Object.fromEntries(kept.map((_, i) => [slotKey(i), RANK_EVIDENCE_QUESTIONS[slotKey(i)]])),
    };
  },
  samples: () => [
    // Full width first: `judgementTrack` reads a set's ids off its first sample.
    [{ question: 'When did I last review the onboarding pull request?', candidates: Array.from({ length: MAX_CANDIDATES }, (_, i) => `note ${i}: ${'x'.repeat(400)}`) }],
    [{ question: 'Which branch was the moment-close bug on?', candidates: ['Debugging moment-close on lab/noticing-gate: the rule fired twice.'] }],
    [{ question: 'q', candidates: [] }],
  ],
};
