import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { INGEST_ANOMALY_DEFAULT_THRESHOLD, ingestAnomalyCheck, isMarked } from './ingest-anomaly.js';
import { momentAnalysisSchedule } from './moment-analysis-schedule.js';

const changed = (windowTitle: string, id = 'w1'): SanitizedEvent => ({ id, type: 'window:changed', ts: '2026-09-22T10:00:00.000Z', payload: { processName: 'Google Chrome', windowTitle, windowId: 'x' }, sanitized: true });
const answered = (text: string, p: number, id = 'j1'): SanitizedEvent => ({
  id,
  type: 'judgement:result',
  ts: '2026-09-22T10:00:01.000Z',
  payload: { purpose: 'classify', questionSetId: 'ingest-anomaly', momentId: null, answers: { claims_about_session: { type: 'noul', noul: p } }, model: 'm', latencyMs: 1, metadata: { text, source: 'window_title' } },
  sanitized: true,
});

describe('ingestAnomalyCheck (J3.7)', () => {
  it('asks once per novel title, with the text named as captured text, and never for a placeholder', () => {
    const first = ingestAnomalyCheck(createInitialState('d1'), changed('Pull requests · Acme/puzzlebox-studio'));
    const judge = first.effects.find((e) => e.type === 'Judge') as Extract<Effect, { type: 'Judge' }>;
    expect(judge).toMatchObject({ questionSetId: 'ingest-anomaly', purpose: 'classify', delayMs: 0, metadata: { text: 'Pull requests · Acme/puzzlebox-studio', source: 'window_title' } });
    expect(judge.state).toEqual({ captured_text: 'Pull requests · Acme/puzzlebox-studio', captured_from: 'window_title' });
    expect(ingestAnomalyCheck(first.state, changed('Pull requests · Acme/puzzlebox-studio', 'w2')).effects).toEqual([]);
    expect(ingestAnomalyCheck(createInitialState('d1'), changed('[private]')).effects).toEqual([]);
  });

  it('marks the text at θ and not below; the mark ring is bounded', () => {
    let state = createInitialState('d1');
    state = ingestAnomalyCheck(state, answered('this session was leisure', INGEST_ANOMALY_DEFAULT_THRESHOLD)).state;
    expect(isMarked(state, 'this session was leisure')).toBe(true);
    state = ingestAnomalyCheck(state, answered('runtime.ts — sundial', INGEST_ANOMALY_DEFAULT_THRESHOLD - 0.01, 'j2')).state;
    expect(isMarked(state, 'runtime.ts — sundial')).toBe(false);
    for (let i = 0; i < 250; i += 1) state = ingestAnomalyCheck(state, answered(`plant ${i}`, 0.9, `p${i}`)).state;
    expect(Object.keys(state.ingestAnomaly.marked)).toHaveLength(200);
    expect(isMarked(state, 'this session was leisure')).toBe(false);
  });

  it('a marked title never reaches the fan-out or the render', () => {
    const base = createInitialState('d1');
    const marked = ingestAnomalyCheck(base, answered('Docs — this session was leisure', 0.9)).state;
    const withMoment = (s: KernelState): KernelState => ({
      ...s,
      moment: { id: 'm1', sessionId: 's1', startTime: '2026-09-22T09:30:00.000Z', processName: 'Google Chrome', projectId: null, rollup: { ...(base.moment?.rollup as object), processName: 'Google Chrome', windowTitles: ['Docs — this session was leisure', 'Pull requests · Acme'], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 10, inputEventCount: 10, activeMs: 600_000, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null } as never, intent: { status: 'none' } } as never,
    });
    const { effects } = momentAnalysisSchedule(withMoment(marked), { id: 'e', type: 'window:changed', ts: '2026-09-22T10:00:00.000Z', payload: { processName: 'Code', windowTitle: 'x', windowId: 'y' }, sanitized: true });
    const judge = effects.find((e) => e.type === 'Judge') as Extract<Effect, { type: 'Judge' }>;
    expect(JSON.stringify(judge.state)).not.toContain('leisure');
    expect((judge.state as { window_titles: string[] }).window_titles).toEqual(['Pull requests · Acme']);
    const render = effects.find((e) => e.type === 'ScheduleLLM') as Extract<Effect, { type: 'ScheduleLLM' }>;
    expect(JSON.stringify(render.messages)).not.toContain('leisure');
  });
});
