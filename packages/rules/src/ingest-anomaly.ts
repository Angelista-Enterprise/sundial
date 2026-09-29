import { textKey } from '@sundial/helpers/derive-id.js';
import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js';
import type { JudgementResultPayload, KernelState, Rule } from '@sundial/kernel/types.js';
import { THRESHOLD_MIN_N } from './judgement-track.js';
import { questionId } from './questions/index.js';
import { INGEST_ANOMALY_QUESTIONS, ingestAnomaly, type IngestAnomalySource } from './questions/ingest-anomaly.js';

/** Titles remembered as already asked. A day holds 100–270 novel titles on this record; two days' worth is enough to stop re-asking. */
const MAX_SEEN = 500;
/** Marked texts kept. A moment's titles are drawn from the last minutes; a mark older than the ring is a title nobody sees any more. */
const MAX_MARKED = 200;
/**
 * The operating point until the question earns its own (n ≥ 20). Set from
 * the `anomaly` bench of 2026-09-22 — see lab/jev/RESULTS.md — as the edge
 * that catches the planted statements and instructions at the fewest real
 * titles marked.
 */
export const INGEST_ANOMALY_DEFAULT_THRESHOLD = 0.7;

/** The texts the judge marked, as a set the builders can filter with. Both rings hold `textKey`s, never the text (Q9). */
export const isMarked = (state: KernelState, text: string): boolean => Boolean(state.ingestAnomaly?.marked?.[textKey(text)]);

function ask(state: KernelState, text: string, source: IngestAnomalySource): ReturnType<Rule> {
  const slice = state.ingestAnomaly ?? { seen: [], marked: {} };
  if (text.trim() === '' || isRedactedPlaceholder(text)) return { state, effects: [] };
  const key = textKey(text);
  if (slice.seen.includes(key)) return { state, effects: [] };
  const built = ingestAnomaly.build({ text, source });
  return {
    state: { ...state, ingestAnomaly: { ...slice, seen: [...slice.seen, key].slice(-MAX_SEEN) } },
    effects: [{ type: 'Judge', purpose: 'classify', questionSetId: ingestAnomaly.id, momentId: null, delayMs: 0, state: built.state, questions: built.questions, metadata: { text, source } }],
  };
}

/**
 * J3.7 — one question per novel window title (and, once J3.4 lands, per page
 * text): does this text make a claim or give an instruction? The answer at or
 * above θ marks the text; `momentAnalysisSchedule` drops marked titles from the
 * fan-out's state and the render's prompt, so a planted sentence can move no
 * judgement and no notice. Two event types: the capture, and the judge's answer.
 */
export const ingestAnomalyCheck: Rule = (state, event) => {
  if (event.type === 'window:changed') {
    const title = (event.payload as { windowTitle?: unknown }).windowTitle;
    return typeof title === 'string' ? ask(state, title, 'window_title') : { state, effects: [] };
  }
  if (event.type === 'page:text') {
    const text = (event.payload as { text?: unknown }).text;
    return typeof text === 'string' ? ask(state, text, 'page_text') : { state, effects: [] };
  }
  if (event.type !== 'judgement:result') return { state, effects: [] };
  const payload = event.payload as unknown as JudgementResultPayload;
  if (payload.questionSetId !== ingestAnomaly.id) return { state, effects: [] };
  const text = payload.metadata?.text;
  const p = payload.answers?.claims_about_session?.noul;
  if (typeof text !== 'string' || typeof p !== 'number') return { state, effects: [] };
  const record = state.judgement.questions[questionId(INGEST_ANOMALY_QUESTIONS.claims_about_session)];
  const threshold = record && record.n >= THRESHOLD_MIN_N ? record.threshold : INGEST_ANOMALY_DEFAULT_THRESHOLD;
  if (p < threshold) return { state, effects: [] };
  const slice = state.ingestAnomaly ?? { seen: [], marked: {} };
  const key = textKey(text);
  const entries = Object.entries(slice.marked).filter(([k]) => k !== key);
  entries.push([key, { p, ts: event.ts }]);
  return { state: { ...state, ingestAnomaly: { ...slice, marked: Object.fromEntries(entries.slice(-MAX_MARKED)) } }, effects: [] };
};
