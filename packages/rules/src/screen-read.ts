import type { Effect, JudgementResultPayload, Rule, ScreenFrameReading } from '@sundial/kernel/types.js';
import { screenRead as screenReadSet, screenReadingOf } from './questions/screen-read.js';
import { screenProfileFor } from './screen-text-filter.js';

/** Jev reads the screen text at most this often, and only when what is on screen changed. */
export const SCREEN_READ_MIN_MS = 2 * 60_000;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 40) : null);

function frameOf(payload: Record<string, unknown>, at: string): ScreenFrameReading {
  const f = payload.focus as Record<string, unknown> | null | undefined;
  const focus = f && [f.x, f.y, f.w, f.h].every((n) => num(n) !== null) ? { x: num(f.x)!, y: num(f.y)!, w: num(f.w)!, h: num(f.h)! } : null;
  return { at, app: str(payload.bundleId) ?? str(payload.processName), shows: str(payload.shows), showsP: num(payload.showsP), meeting: num(payload.meeting), error: num(payload.error), focus };
}

/**
 * Runs right after `screenTrack`, before `momentRollup`. The Jev layers over
 * the screen, both behind the owner's consent:
 *
 * - `screen:ocr`, when `state.config.screenJevText`: put the capture's cleaned
 *   lines and typed facts to Jev (`screen-read`, purpose `screen`), when the
 *   app or what it shows changed and two minutes have passed since the last
 *   ask. Only lines the fold already holds go, so only sanitized text leaves.
 * - `judgement:result` for `screen-read`: keep the reading in `state.screen.read`.
 * - `screen:frame` (the frame sensor's typed answer, `ocr.jev.frames`): keep
 *   it in `state.screen.frame`. Numbers and fixed labels only; no pixels.
 */
export const screenRead: Rule = (state, event) => {
  if (event.type === 'screen:ocr') {
    const screen = state.screen;
    if (state.config.screenJevText !== true || screen.eventId !== event.id || screen.kept.length === 0) return { state, effects: [] };
    const facts = screen.facts ?? [];
    const signature = JSON.stringify([screen.app, facts.map((f) => `${f.kind}:${f.value}`), screen.kept.slice(0, 3)]);
    const last = screen.read;
    if (last && (last.signature === signature || Date.parse(event.ts) - Date.parse(last.askedAt) < SCREEN_READ_MIN_MS)) return { state, effects: [] };
    const built = screenReadSet.build({ app: screen.app, appFamily: screenProfileFor(screen.app), lines: screen.kept, facts });
    const effects: Effect[] = [{ type: 'Judge', purpose: 'screen', questionSetId: screenReadSet.id, momentId: state.moment?.id ?? null, delayMs: 0, state: built.state, questions: built.questions, metadata: { at: event.ts } }];
    return { state: { ...state, screen: { ...screen, read: { askedAt: event.ts, signature, answer: last?.answer ?? null } } }, effects };
  }
  if (event.type === 'judgement:result') {
    const payload = event.payload as unknown as JudgementResultPayload;
    if (payload.questionSetId !== screenReadSet.id || !state.screen.read) return { state, effects: [] };
    return { state: { ...state, screen: { ...state.screen, read: { ...state.screen.read, answer: screenReadingOf(payload.answers, event.ts) } } }, effects: [] };
  }
  if (event.type === 'screen:frame') {
    return { state: { ...state, screen: { ...state.screen, frame: frameOf(event.payload as Record<string, unknown>, event.ts) } }, effects: [] };
  }
  return { state, effects: [] };
};
