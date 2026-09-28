import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { templateLine, verifyLine } from './verify-line.js';
import { questionId } from './questions/index.js';
import { JUDGE_LINE_QUESTIONS } from './questions/judge-line.js';

const EVIDENCE = { app: 'Code', project: '~/Projects/sundial', git_branch: 'main', window_titles: ['runtime.ts — sundial'], minutes: 31 };
const LINE = '{"intent": "Debugging the reducer", "narrative": "Fixed the reducer bug."}';
const TS = '2026-09-21T20:00:00.000Z';

const render = (metadata: Record<string, unknown> | null = { evidence: EVIDENCE, attempt: 1 }, text = LINE): SanitizedEvent => ({
  id: 'e1',
  type: 'llm:result',
  ts: TS,
  payload: { purpose: 'intent', momentId: 'm-1', text, auditId: 'audit-1', metadata },
  sanitized: true,
});

const judged = (answers: Record<string, { noul: number }>, metadata: Record<string, unknown>): SanitizedEvent => ({
  id: 'e2',
  type: 'judgement:result',
  ts: TS,
  payload: { purpose: 'judge', questionSetId: 'judge-line', momentId: 'm-1', answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { type: 'noul', ...v }])), model: 'typesafe/jev-latest', latencyMs: 280, metadata },
  sanitized: true,
});

const judgeOf = (effects: Effect[]) => effects.find((e) => e.type === 'Judge') as Extract<Effect, { type: 'Judge' }> | undefined;
const patchOf = (effects: Effect[]) => (effects.find((e) => e.type === 'UpdateMomentData') as Extract<Effect, { type: 'UpdateMomentData' }> | undefined)?.patch;

describe('verifyLine (J1.1)', () => {
  const state = createInitialState('d1');

  it('sends the rendered line to the judge with the evidence it was written from', () => {
    const { effects } = verifyLine(state, render());
    const judge = judgeOf(effects);
    expect(judge).toMatchObject({ purpose: 'judge', questionSetId: 'judge-line', momentId: 'm-1', delayMs: 0 });
    expect(judge?.state).toEqual({ evidence: EVIDENCE, assistant_wrote: { line: 'Debugging the reducer', narrative: 'Fixed the reducer bug.' } });
    expect(Object.keys(judge?.questions ?? {})).toEqual(Object.keys(JUDGE_LINE_QUESTIONS));
    expect(judge?.metadata).toMatchObject({ momentId: 'm-1', line: 'Debugging the reducer', attempt: 1, auditId: 'audit-1' });
  });

  it('leaves alone: a render without evidence, an unparseable one, judging off', () => {
    expect(verifyLine(state, render(null)).effects).toEqual([]);
    expect(verifyLine(state, render({ evidence: EVIDENCE }, 'not json')).effects).toEqual([]);
    const off: KernelState = { ...state, judgement: { ...state.judgement, degraded: 'off' } };
    expect(verifyLine(off, render()).effects).toEqual([]);
  });

  const meta = { momentId: 'm-1', line: 'Debugging the reducer', narrative: 'Fixed the reducer bug.', attempt: 1, evidence: EVIDENCE, auditId: 'audit-1' };

  it('applies a line that neither hedges nor invents', () => {
    const { effects } = verifyLine(state, judged({ hedges: { noul: 0.1 }, grounded: { noul: 0.9 } }, meta));
    expect(patchOf(effects)).toEqual({ intent: { status: 'done', text: 'Debugging the reducer', analyzedAt: TS, judged: 'passed' }, narrative: 'Fixed the reducer bug.' });
  });

  it('a hedged first render is rendered once more, told what was wrong, with the evidence and attempt 2', () => {
    const { effects } = verifyLine(state, judged({ hedges: { noul: 0.94 }, grounded: { noul: 0.9 } }, meta));
    const retry = effects.find((e) => e.type === 'ScheduleLLM') as Extract<Effect, { type: 'ScheduleLLM' }>;
    expect(retry).toMatchObject({ purpose: 'intent', momentId: 'm-1', attempt: 2, parentCallId: 'audit-1' });
    expect(retry.metadata).toMatchObject({ evidence: EVIDENCE, attempt: 2 });
    expect(retry.messages[1].content).toContain('"Debugging the reducer"');
    expect(retry.messages[1].content).toContain('it hedges');
    expect(patchOf(effects)).toBeUndefined();
  });

  it('an ungrounded second render becomes the template line — nothing invented', () => {
    const { effects } = verifyLine(state, judged({ hedges: { noul: 0.1 }, grounded: { noul: 0.2 } }, { ...meta, attempt: 2, line: 'Reviewing the Acme contract' }));
    expect(patchOf(effects)).toEqual({ intent: { status: 'done', text: 'Working on sundial', analyzedAt: TS, judged: 'template' } });
  });

  it('a clean second render is applied and marked retried', () => {
    const { effects } = verifyLine(state, judged({ hedges: { noul: 0.1 }, grounded: { noul: 0.9 } }, { ...meta, attempt: 2 }));
    expect(patchOf(effects)?.intent).toMatchObject({ judged: 'retried' });
  });

  it('reads each question\'s own learned threshold (law 4)', () => {
    const strict: KernelState = {
      ...state,
      judgement: { ...state.judgement, questions: { [questionId(JUDGE_LINE_QUESTIONS.hedges)]: { type: 'noul', threshold: 0.9, n: 25, hits: 20, bins: { n: [], hits: [] }, lastVerdictAt: null } } },
    };
    // 0.6 hedges: over the default 0.5, under this owner's learned 0.9 — applied.
    expect(patchOf(verifyLine(strict, judged({ hedges: { noul: 0.6 }, grounded: { noul: 0.9 } }, meta)).effects)?.intent).toMatchObject({ judged: 'passed' });
  });

  it('judgement:failed applies the unjudged line rather than losing it', () => {
    const failed: SanitizedEvent = { id: 'e3', type: 'judgement:failed', ts: TS, payload: { purpose: 'judge', questionSetId: 'judge-line', momentId: 'm-1', metadata: meta }, sanitized: true };
    expect(patchOf(verifyLine(state, failed).effects)?.intent).toMatchObject({ text: 'Debugging the reducer', judged: 'unjudged' });
    expect(verifyLine(state, { ...failed, payload: { ...failed.payload, questionSetId: 'moment-fanout' } }).effects).toEqual([]);
  });
});

describe('templateLine', () => {
  it('is the subject renderer on the most specific available subject', () => {
    expect(templateLine({ meeting_title: 'Standup', project: '~/p/x' })).toBe('Meeting: Standup');
    expect(templateLine({ project: '~/Projects/sundial', git_branch: 'main' })).toBe('Working on sundial');
    expect(templateLine({ project: '~/Projects/sundial', git_branch: 'lab/x' })).toBe('Working on sundial (lab/x)');
    expect(templateLine({ app: 'Arc', window_titles: ['Hub: Overview', 'b'] })).toBe('Arc: Hub: Overview');
    expect(templateLine({ app: 'Arc' })).toBe('In Arc');
  });
});
