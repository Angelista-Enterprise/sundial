/**
 * The question registry (docs/jarvis/02, "Question registry"). Pure data and
 * pure builders, no I/O: a set is a function from evidence to
 * `{ state, questions }`, obeying the ten laws of state, that a rule puts on
 * a `Judge` effect. One file per set; this file holds what every set shares.
 *
 * Law 4, as W6 D4 changed it: a question's id is its set and slot
 * (`moment-fanout:is_work`), stamped on the question by `keyed`. Thresholds,
 * calibration bins and verdict counts hang off that id. It used to be the hash
 * of the wording, so every rewording restarted at n = 0: the record's 53 ids
 * held 22 graded answers, and none could reach the n = 20 the threshold learns
 * at. (The phrasing probe showed five wordings of one question moving mean p
 * from 0.34 to 0.74 while their rankings agreed: a rewording now keeps its
 * bins, and the answers after it move the threshold.) `wordingHash` is the old
 * id, kept for the one-time mapping (`migrateQuestionIds`).
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

/** The pre-D4 id: the hash of the wording. */
export function wordingHash(q: Question): string {
  return crypto
    .createHash('sha1')
    .update(q.instructions + JSON.stringify(q.criteria ?? null))
    .digest('hex')
    .slice(0, 12);
}

/** Non-enumerable, so the question sent to Jev and logged is unchanged. */
const TEMPLATE = Symbol('question template');

/** Stamp each question of a set with its template id, `<setId>:<slot>`; returns the same object. */
export function keyed<Q extends Record<string, Question>>(setId: string, questions: Q): Q {
  for (const [key, q] of Object.entries(questions)) if (!(TEMPLATE in q)) Object.defineProperty(q, TEMPLATE, { value: `${setId}:${key}` });
  return questions;
}

/** The id thresholds and bins hang off: the template (set and slot); the wording hash for a question no set stamped. */
export function questionId(q: Question): string {
  return (q as { [TEMPLATE]?: string })[TEMPLATE] ?? wordingHash(q);
}

// The three primitives, matching docs.typesafe.ai/primitives (as `lab/jev/client.mjs`).
export const choice = (instructions: string, criteria: Record<string, string>): Question => ({ type: 'choice', instructions, criteria });
export const score = (instructions: string, criteria: string[]): Question => ({ type: 'score', instructions, criteria });
/** A noul may name what its two poles mean; the lab's `speak_now` does, and the wording is part of the id. */
export const noul = (instructions: string, criteria?: Record<string, string>): Question => (criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions });

/** Law 8: speech is clipped to 600 chars; a 30-minute dictation is most of the state budget on its own. */
export const SPEECH_MAX_CHARS = 600;
export const clip = (text: string, max = SPEECH_MAX_CHARS): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
