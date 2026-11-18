import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { JudgeEffect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { lintState } from './questions/state-lint.js';
import { SCREEN_READ_QUESTIONS, screenRead as screenReadSet, screenReadingOf } from './questions/screen-read.js';
import { boxOf, screenFrame, screenFrameOf } from './questions/screen-frame.js';
import { SCREEN_READ_MIN_MS, screenRead } from './screen-read.js';
import { screenTrack } from './screen-track.js';

const at = (ms: number): string => new Date(Date.parse('2026-09-04T10:00:00.000Z') + ms).toISOString();
const ocr = (id: string, ms: number, screenText: string, bundleId = 'dev.warp.Warp-Stable'): SanitizedEvent => ({ id, type: 'screen:ocr', ts: at(ms), payload: { bundleId, processName: 'Warp', region: 'focused', screenText }, sanitized: true });
const consented = (on: boolean): KernelState => {
  const s = createInitialState('d');
  return { ...s, config: { ...s.config, screenJevText: on } };
};
/** The two rules in manifest order: `screenTrack` decides the lines, `screenRead` may ask about them. */
const fold = (state: KernelState, event: SanitizedEvent) => {
  const tracked = screenTrack(state, event).state;
  return screenRead(tracked, event);
};

describe('screenRead (Jev on the screen text)', () => {
  it('asks nothing without the owner\'s consent', () => {
    const out = fold(consented(false), ocr('e1', 0, 'TypeError: boom'));
    expect(out.effects).toEqual([]);
    expect(out.state.screen.read).toBeUndefined();
  });

  it('asks once with consent, with only the cleaned lines and facts the fold holds', () => {
    const out = fold(consented(true), ocr('e1', 0, '$ pnpm test\nTypeError: boom in card.ts'));
    expect(out.effects).toHaveLength(1);
    const judge = out.effects[0] as JudgeEffect;
    expect(judge).toMatchObject({ type: 'Judge', purpose: 'screen', questionSetId: 'screen-read', questions: SCREEN_READ_QUESTIONS });
    expect(judge.state).toEqual({ app: 'dev.warp.Warp-Stable', app_family: 'terminal', lines: ['$ pnpm test', 'TypeError: boom in card.ts'], error_line: 'TypeError: boom in card.ts', files: ['card.ts'], call_controls_on_screen: false });
    expect(out.state.screen.read).toMatchObject({ askedAt: at(0), answer: null });
  });

  it('asks again only when the screen changed AND two minutes passed', () => {
    let state = fold(consented(true), ocr('e1', 0, 'TypeError: boom')).state;
    const same = fold(state, ocr('e2', SCREEN_READ_MIN_MS + 1, 'TypeError: boom'));
    expect(same.effects).toEqual([]);
    const soon = fold(state, ocr('e3', 30_000, 'a different line entirely'));
    expect(soon.effects).toEqual([]);
    state = soon.state;
    const later = fold(state, ocr('e4', SCREEN_READ_MIN_MS + 1, 'yet another different line'));
    expect(later.effects).toHaveLength(1);
  });

  it('keeps Jev\'s answer, and a frame\'s, in state', () => {
    let state = fold(consented(true), ocr('e1', 0, 'TypeError: boom')).state;
    const result: SanitizedEvent = { id: 'r1', type: 'judgement:result', ts: at(1000), sanitized: true, payload: { purpose: 'screen', questionSetId: 'screen-read', momentId: null, model: 'typesafe/jev-latest', latencyMs: 150, answers: { activity: { type: 'choice', choice: 'debugging', probabilities: { debugging: 0.8, coding: 0.2 } }, meeting: { type: 'noul', noul: 0.02 }, blocked: { type: 'noul', noul: 0.7 }, work: { type: 'noul', noul: 0.95 } } } };
    state = screenRead(state, result).state;
    expect(state.screen.read?.answer).toEqual({ at: at(1000), activity: 'debugging', activityP: 0.8, meeting: 0.02, blocked: 0.7, work: 0.95 });
    const frame: SanitizedEvent = { id: 'f1', type: 'screen:frame', ts: at(2000), sanitized: true, payload: { timestamp: at(2000), processName: 'Warp', bundleId: 'dev.warp.Warp-Stable', shows: 'terminal', showsP: 0.9, meeting: 0.01, error: 0.6, focus: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } } };
    state = screenRead(state, frame).state;
    expect(state.screen.frame).toEqual({ at: at(2000), app: 'dev.warp.Warp-Stable', shows: 'terminal', showsP: 0.9, meeting: 0.01, error: 0.6, focus: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } });
  });

  it('ignores another set\'s answer', () => {
    const state = fold(consented(true), ocr('e1', 0, 'TypeError: boom')).state;
    const other: SanitizedEvent = { id: 'r1', type: 'judgement:result', ts: at(1000), sanitized: true, payload: { purpose: 'perceive', questionSetId: 'perceive', momentId: null, model: 'm', latencyMs: 1, answers: {} } };
    expect(screenRead(state, other).state).toBe(state);
  });
});

describe('the screen question sets', () => {
  it('obey the laws of state on every sample', () => {
    for (const sample of screenReadSet.samples()) expect(lintState(screenReadSet.build(...sample).state)).toEqual([]);
    for (const sample of screenFrame.samples()) expect(lintState(screenFrame.build(...sample).state)).toEqual([]);
  });

  it('read a missing or foreign answer as null, never a guess', () => {
    expect(screenReadingOf(undefined, at(0))).toEqual({ at: at(0), activity: null, activityP: null, meeting: null, blocked: null, work: null });
    expect(screenReadingOf({ activity: { type: 'choice', choice: 'not-a-label' } }, at(0)).activity).toBeNull();
  });

  it('read a box in pixels, in 0..1, as corners or as an array', () => {
    const size = { width: 768, height: 480 };
    expect(boxOf({ x: 0, y: 0, w: 384, h: 240 }, size)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(boxOf({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, size)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(boxOf([76.8, 48, 768, 480], size)).toEqual({ x: 0.1, y: 0.1, w: 0.9, h: 0.9 });
    expect(boxOf({ x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.2 }, size)).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    expect(boxOf({ x: 5, y: 5, w: -1, h: 3 }, size)).toBeNull();
    expect(boxOf('somewhere', size)).toBeNull();
  });

  it('turn a frame\'s answers into a reading', () => {
    const answers = { shows: { type: 'choice', choice: 'video_call', probabilities: { video_call: 0.7 } }, meeting: { type: 'noul', noul: 0.9 }, error: { type: 'noul', noul: 0.05 }, focus: { type: 'box', box: { x: 0, y: 0, w: 768, h: 480 } } };
    expect(screenFrameOf(answers as never, { width: 768, height: 480 })).toEqual({ shows: 'video_call', showsP: 0.7, meeting: 0.9, error: 0.05, focus: { x: 0, y: 0, w: 1, h: 1 } });
  });
});
