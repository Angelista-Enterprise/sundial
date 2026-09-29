import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Effect, JudgementResultPayload, Rule } from '@sundial/kernel/types.js';
import { THRESHOLD_MIN_N } from './judgement-track.js';
import { questionId } from './questions/index.js';
import { GOAL_ADVANCE_QUESTIONS, goalAdvanceSlot, MAX_GOAL_SLOTS, MAX_PROMISE_SLOTS, momentFanout, PROMISE_RESOLVE_QUESTIONS, promiseSlot } from './questions/moment-fanout.js';

/**
 * J2.7's operating point for "this session advanced that goal" until the
 * question earns its own (n ≥ 20). Above the noul default of 0.5 on purpose:
 * the bench of 2026-09-22 (`goals` flow) is the number this was set from, and
 * a goal credited on a coin flip would make the Monday check-in cite noise.
 */
export const GOAL_ADVANCE_DEFAULT_THRESHOLD = 0.6;
/**
 * The words key, from the 2026-09-23 card audit: all four live promises were
 * room noise the speech model mis-heard (Spanish, Arabic and Dutch in one
 * excerpt, a television in the room). English or Dutch is all the owner
 * speaks and all the sensor keeps (R1); a letter from another script, or
 * ¿ ¡ ñ, means the room. The meeting pass applies it to every quote.
 */
const FOREIGN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]|[¿¡ñÑ]/u;
export const inTheOwnersLanguage = (text: string): boolean => !FOREIGN.test(text);

export const PROMISE_RESOLVE_DEFAULT_THRESHOLD = 0.7;

/**
 * J1.2 (option A, O6): the fan-out rides every close. One text render per
 * moment stays — the side-by-side said the model's line is the better record
 * 31/40 — and Jev's answers land beside it, as numbers, for the rules that
 * want them: `is_work`, `depth`, `worth`, `commitment`, `blocker`,
 * `interrupt_ok`, and the `subject` pointer with its probability.
 *
 * Nothing here is prose and nothing is a verdict a later question could
 * follow: each field is the level Jev picked plus the probability it was
 * decided on (law 5, law 7). Consumers read `data.judgement` off the moment
 * row; the thresholds that turn a probability into an action live in
 * `state.judgement.questions` and belong to the consuming rule.
 */
interface MomentJudgement {
  subject: string | null;
  subject_p: number | null;
  is_work: number | null;
  depth: number | null;
  depth_p: number | null;
  worth: number | null;
  worth_p: number | null;
  commitment: number | null;
  blocker: number | null;
  interrupt_ok: number | null;
  model: string;
  at: string;
}

const top = (a: JudgementResultPayload['answers'][string] | undefined): number | null => {
  const values = a?.probabilities ? Object.values(a.probabilities).filter((v) => typeof v === 'number') : [];
  return values.length > 0 ? Math.max(...values) : typeof a?.confidence === 'number' ? a.confidence : null;
};
const noul = (a: JudgementResultPayload['answers'][string] | undefined): number | null => (typeof a?.noul === 'number' ? a.noul : null);
const level = (a: JudgementResultPayload['answers'][string] | undefined): number | null => (typeof a?.score === 'number' ? Math.round(a.score) : null);

export function momentJudgement(payload: JudgementResultPayload, ts: string): MomentJudgement {
  const a = payload.answers ?? {};
  return {
    subject: typeof a.subject?.choice === 'string' ? a.subject.choice : null,
    subject_p: top(a.subject),
    is_work: noul(a.is_work),
    depth: level(a.depth),
    depth_p: top(a.depth),
    worth: level(a.worth_remembering),
    worth_p: top(a.worth_remembering),
    commitment: noul(a.contains_commitment),
    blocker: noul(a.contains_blocker),
    interrupt_ok: noul(a.interrupt_ok),
    model: payload.model,
    at: ts,
  };
}

export const applyMomentJudgement: Rule = (state, event) => {
  if (event.type !== 'judgement:result') return { state, effects: [] };
  const payload = event.payload as unknown as JudgementResultPayload;
  if (payload.questionSetId !== momentFanout.id || typeof payload.momentId !== 'string' || payload.momentId === '') return { state, effects: [] };
  const effects: Effect[] = [{ type: 'UpdateMomentData', momentId: payload.momentId, patch: { judgement: momentJudgement(payload, event.ts) } }];

  // J2.7: a goal slot over its threshold is one `goal:progress`, credited to the
  // goal the metadata says was in that slot. No slot map, no credit — an answer
  // without its goal is not evidence about any goal.
  const goals = Array.isArray(payload.metadata?.goals) ? (payload.metadata.goals as unknown[]).filter((g): g is string => typeof g === 'string') : [];
  const minutes = typeof payload.metadata?.durationMs === 'number' ? Math.round(payload.metadata.durationMs / 60_000) : 0;
  for (let i = 0; i < Math.min(goals.length, MAX_GOAL_SLOTS); i += 1) {
    const p = noul(payload.answers[goalAdvanceSlot(i)]);
    if (p === null) continue;
    const record = state.judgement.questions[questionId(GOAL_ADVANCE_QUESTIONS[goalAdvanceSlot(i)])];
    const threshold = record && record.n >= THRESHOLD_MIN_N ? record.threshold : GOAL_ADVANCE_DEFAULT_THRESHOLD;
    if (p < threshold) continue;
    effects.push({
      type: 'EmitEvent',
      event: { id: deriveId(event.ts, event.id, 'goal-progress', goals[i]), type: 'goal:progress', ts: event.ts, payload: { goalId: goals[i], momentId: payload.momentId, p, minutes } },
    });
  }

  // J4.4 opened a promise here from the moment's 160-character clip of
  // speech. UC1 replaced it with one pass over the whole meeting
  // (`promise-extract.ts`): the clip rarely held the due date, and a moment's
  // speech outside a meeting was the room's.

  // J4.4: a promise slot over θ closes that promise — with the second key: the
  // moment must carry non-text evidence (commit, commands, calendar, mic). A
  // sentence alone, however sure the judge, closes nothing (docs/jarvis/05).
  const promises = Array.isArray(payload.metadata?.promises) ? (payload.metadata.promises as unknown[]).filter((c): c is string => typeof c === 'string') : [];
  if (payload.metadata?.nonText === true) {
    for (let i = 0; i < Math.min(promises.length, MAX_PROMISE_SLOTS); i += 1) {
      const p = noul(payload.answers[promiseSlot(i)]);
      if (p === null) continue;
      const record = state.judgement.questions[questionId(PROMISE_RESOLVE_QUESTIONS[promiseSlot(i)])];
      const threshold = record && record.n >= THRESHOLD_MIN_N ? record.threshold : PROMISE_RESOLVE_DEFAULT_THRESHOLD;
      if (p < threshold) continue;
      effects.push({
        type: 'EmitEvent',
        event: { id: deriveId(event.ts, event.id, 'commitment-resolved', promises[i]), type: 'commitment:resolved', ts: event.ts, payload: { id: promises[i], momentId: payload.momentId, p } },
      });
    }
  }
  return { state, effects };
};
