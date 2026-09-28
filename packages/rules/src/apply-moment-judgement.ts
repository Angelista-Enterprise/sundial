import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Effect, JudgementResultPayload, Rule } from '@sundial/kernel/types.js';
import { THRESHOLD_MIN_N } from './judgement-track.js';
import { questionId } from './questions/index.js';
import { GOAL_ADVANCE_QUESTIONS, goalAdvanceSlot, MAX_GOAL_SLOTS, MAX_PROMISE_SLOTS, MOMENT_FANOUT_QUESTIONS, momentFanout, PROMISE_RESOLVE_QUESTIONS, promiseSlot } from './questions/moment-fanout.js';

/**
 * J2.7's operating point for "this session advanced that goal" until the
 * question earns its own (n ≥ 20). Above the noul default of 0.5 on purpose:
 * the bench of 2026-09-22 (`goals` flow) is the number this was set from, and
 * a goal credited on a coin flip would make the Monday check-in cite noise.
 */
export const GOAL_ADVANCE_DEFAULT_THRESHOLD = 0.6;
/**
 * J4.4: a promise is opened from speech at this noul until the question earns
 * its own. From the 2026-09-22 backfill: 397 speech moments, 20 at ≥ 0.7 and
 * the top of that list reads as promises ("dan zal ik Marco jouw feedback
 * zetten erin" 0.90, "ik ga het even doorsturen" 0.76); at 0.5 it is 50 and
 * the tail is small talk.
 */
export const COMMITMENT_DEFAULT_THRESHOLD = 0.7;

/**
 * Two keys before speech opens a promise, from the 2026-09-23 card audit: all
 * four live promises were room noise the speech model mis-heard (Spanish,
 * Arabic and Dutch in one excerpt, a television in the room). The judge read
 * them as promises at 0.73–0.79; neither key below needs the judge.
 *
 * The words: English or Dutch, which is all the owner speaks and all the
 * sensor keeps (R1). A letter from another script, or ¿ ¡ ñ, means the room.
 */
const FOREIGN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]|[¿¡ñÑ]/u;
export const inTheOwnersLanguage = (text: string): boolean => !FOREIGN.test(text);

/**
 * The room: a meeting or a call the owner was in (`state.meetings.seen`, which
 * holds calendar meetings and unscheduled calls alike). A promise is made to
 * someone; talk overheard outside any meeting is the room's. Placed by the
 * moment id, a ULID whose clock is the moment's start, with five minutes'
 * slack at each edge for a meeting that starts or ends late.
 */
const MEETING_SLACK_MS = 5 * 60_000;
const ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulidMs = (id: string): number | null => {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  let ms = 0;
  for (const ch of id.slice(0, 10)) ms = ms * 32 + ULID.indexOf(ch);
  return ms;
};
export function inAMeeting(meetings: Record<string, { start: string; end: string }>, momentId: string, durationMs: number): boolean {
  const start = ulidMs(momentId);
  if (start === null) return false;
  const end = start + Math.max(0, durationMs);
  return Object.values(meetings).some((m) => Date.parse(m.start) - MEETING_SLACK_MS <= end && start <= Date.parse(m.end) + MEETING_SLACK_MS);
}

/**
 * What a promise is called: the sentence in the excerpt that makes it — the
 * one with a first person and a future ("ik ga", "zal ik", "I'll", "we will")
 * — clipped. The whole excerpt was the name before, so a thread read as
 * forty words of a room.
 */
const PROMISING = /\b(ik ga|ga ik|ik zal|zal ik|ik stuur|stuur ik|we gaan|gaan we|ik kijk|kijk ik|i'll|i will|i'm going to|we'll|we will|let me)\b/i;
export function promiseName(spoken: string): string {
  const sentences = spoken.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  const said = sentences.find((x) => PROMISING.test(x)) ?? sentences[0] ?? spoken;
  return said.length > 90 ? `${said.slice(0, 89).trimEnd()}…` : said;
}
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

  // J4.4: a promise heard aloud opens a thread — only when the words exist to
  // quote (the metadata carries the clipped excerpt) and the noul clears θ.
  const commitmentP = noul(payload.answers.contains_commitment);
  const spoken = typeof payload.metadata?.spoken === 'string' ? payload.metadata.spoken : null;
  const heardInAMeeting = inAMeeting(state.meetings.seen, payload.momentId ?? '', typeof payload.metadata?.durationMs === 'number' ? payload.metadata.durationMs : 0);
  if (commitmentP !== null && spoken && inTheOwnersLanguage(spoken) && heardInAMeeting) {
    const record = state.judgement.questions[questionId(MOMENT_FANOUT_QUESTIONS.contains_commitment)];
    const threshold = record && record.n >= THRESHOLD_MIN_N ? record.threshold : COMMITMENT_DEFAULT_THRESHOLD;
    if (commitmentP >= threshold) {
      effects.push({
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'commitment-heard', payload.momentId),
          type: 'commitment:heard',
          ts: event.ts,
          payload: { momentId: payload.momentId, text: promiseName(spoken), p: commitmentP, projectId: typeof payload.metadata?.projectId === 'string' ? payload.metadata.projectId : null, projectName: typeof payload.metadata?.projectName === 'string' ? payload.metadata.projectName : null },
        },
      });
    }
  }

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
