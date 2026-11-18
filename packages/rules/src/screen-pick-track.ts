import type { JudgementQuestionRecord, KernelState, Rule } from '@sundial/kernel/types.js';
import { DECILES, defaultThreshold, gradeAnswer } from './judgement-track.js';

/** A pick waits this long for its step; after that it is dropped ungraded. */
export const PICK_WAIT_MS = 120_000;
const MAX_GRADES = 8;
/** Steps that name no thing on screen: a step the chat model took instead of a pick says nothing about the pick. */
const UNNAMED = new Set(['open', 'raise', 'key', 'type', 'pick-menu', 'scroll']);

const str = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n) : '');
const empty = (): JudgementQuestionRecord => ({ type: 'choice', threshold: defaultThreshold('choice'), n: 0, hits: 0, bins: { n: Array(DECILES).fill(0), hits: Array(DECILES).fill(0) }, lastVerdictAt: null });

/**
 * Doc 16's fast path (`screen-pick.js` in sundial-actions): how each pick of a screen_act `find` step turned out, graded
 * per question id so its threshold learns (law 4, `gradeAnswer`; it moves at 20 graded). A pick (`screen:picked`) waits
 * for the next `screen:step` in its app. A pick acted on was right when that step worked: ok, and the screen changed. A
 * pick not acted on (the chat model got the look instead) was right when the model then acted on the same thing (role and
 * name) and it worked. Single writer of `state.screenPick`; one pick held, at most eight question ids.
 */
export const screenPickTrack: Rule = (state, event) => {
  if (event.type === 'screen:picked') {
    const p = event.payload as Record<string, unknown>;
    if (typeof p.qid !== 'string' || typeof p.p !== 'number' || !Number.isFinite(p.p)) return { state, effects: [] };
    const words = Array.isArray(p.screenText) ? p.screenText : [];
    const last = { qid: str(p.qid, 60), p: Math.min(1, Math.max(0, p.p)), acted: p.acted === true, app: str(p.processName, 80), ...(typeof p.role === 'string' ? { role: str(p.role, 40) } : {}), name: str(words[0], 120), at: event.ts };
    return { state: { ...state, screenPick: { grades: state.screenPick?.grades ?? {}, last } }, effects: [] };
  }
  if (event.type !== 'screen:step') return { state, effects: [] };
  const last = state.screenPick?.last;
  if (!last) return { state, effects: [] };
  const p = event.payload as Record<string, unknown>;
  const stale = Date.parse(event.ts) - Date.parse(last.at) > PICK_WAIT_MS;
  if (stale || str(p.processName, 80).toLowerCase() !== last.app.toLowerCase()) return { state: stale ? drop(state) : state, effects: [] };
  if (!last.acted && UNNAMED.has(str(p.verb, 20))) return { state: drop(state), effects: [] };
  const worked = p.ok === true && p.changed === true;
  const same = str(p.role, 40) === (last.role ?? '') && str((p.screenText as unknown[] | undefined)?.[0], 120) === last.name;
  const record = gradeAnswer(state.screenPick?.grades?.[last.qid] ?? empty(), last.p, worked && (last.acted || same), event.ts);
  const grades = Object.fromEntries([...Object.entries(state.screenPick?.grades ?? {}).filter(([id]) => id !== last.qid), [last.qid, record]].slice(-MAX_GRADES));
  return { state: { ...state, screenPick: { grades, last: null } }, effects: [] };
};

const drop = (state: KernelState): KernelState => ({ ...state, screenPick: { grades: state.screenPick?.grades ?? {}, last: null } });
