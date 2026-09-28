/**
 * The question registry (docs/jarvis/02, "Question registry"). Pure data and
 * pure builders, no I/O: a set is a function from evidence to
 * `{ state, questions }`, obeying the ten laws of state, that a rule puts on
 * a `Judge` effect. One file per set; this file holds what every set shares.
 *
 * Law 4: a question's id is the hash of its instruction text and criteria.
 * Thresholds, calibration bins and verdict counts hang off that id, so a
 * wording edit is a new question with a fresh threshold — the phrasing probe
 * showed five wordings of one question moving mean p from 0.34 to 0.74 while
 * their rankings agreed, so a threshold learned for one wording is wrong for
 * the next.
 */
import crypto from 'node:crypto';
import type { JudgeQuestion } from '@sundial/kernel/types.js';

export type Question = JudgeQuestion;

export interface QuestionSet<Input extends unknown[]> {
  /** Stable id a consuming rule pattern-matches on (`judgement:result.questionSetId`). */
  id: string;
  build: (...input: Input) => { state: Record<string, unknown>; questions: Record<string, Question> };
  /** Inputs the lint (J0.6) and the id snapshot walk. Every shape a builder can take should appear once. */
  samples: () => Input[];
}

export function questionId(q: Question): string {
  return crypto
    .createHash('sha1')
    .update(q.instructions + JSON.stringify(q.criteria ?? null))
    .digest('hex')
    .slice(0, 12);
}

// The three primitives, matching docs.typesafe.ai/primitives (as `lab/jev/client.mjs`).
export const choice = (instructions: string, criteria: Record<string, string>): Question => ({ type: 'choice', instructions, criteria });
export const score = (instructions: string, criteria: string[]): Question => ({ type: 'score', instructions, criteria });
/** A noul may name what its two poles mean; the lab's `speak_now` does, and the wording is part of the id. */
export const noul = (instructions: string, criteria?: Record<string, string>): Question => (criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions });

/** Law 8: speech is clipped to 600 chars; a 30-minute dictation is most of the state budget on its own. */
export const SPEECH_MAX_CHARS = 600;
export const clip = (text: string, max = SPEECH_MAX_CHARS): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
