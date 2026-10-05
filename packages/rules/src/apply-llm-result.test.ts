import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { applyLlmResult, parseCompanionInsight, parseMomentAnalysis } from './apply-llm-result.js';

function resultEvent(purpose: string, momentId: string | null, text: string | null, metadata?: Record<string, unknown>): SanitizedEvent {
  return { id: 'e1', type: 'llm:result', ts: '2026-01-01T00:10:00.000Z', payload: { purpose, momentId, text, metadata }, sanitized: true };
}

const ANALYSIS_JSON = '{"intent": "Debugging the reducer.", "narrative": "Fixed the reducer bug."}';
const EVIDENCE = { app: 'Code', minutes: 12 };

describe('applyLlmResult', () => {
  it('emits one UpdateMomentData patching both intent.status=done and narrative from a merged intent result (B2)', () => {
    const state = createInitialState('d1');
    const { effects } = applyLlmResult(state, resultEvent('intent', 'm1', ANALYSIS_JSON));

    expect(effects).toEqual([
      {
        type: 'UpdateMomentData',
        momentId: 'm1',
        patch: {
          intent: { status: 'done', text: 'Debugging the reducer.', analyzedAt: '2026-01-01T00:10:00.000Z' },
          narrative: 'Fixed the reducer bug.',
        },
      },
      // The line as an event the fold can read after the moment closed (U2-F9).
      { type: 'EmitEvent', event: expect.objectContaining({ type: 'moment:intent', payload: expect.objectContaining({ momentId: 'm1', projectId: null, text: 'Debugging the reducer.' }) }) },
    ]);
  });

  // J1.1: a render that carries its evidence is judged first (`verifyLine`);
  // this rule applies it only when nothing is judging.
  it('leaves a render with evidence to the judge, unless judging is off', () => {
    const state = createInitialState('d1');
    expect(applyLlmResult(state, resultEvent('intent', 'm1', ANALYSIS_JSON, { evidence: EVIDENCE })).effects).toEqual([]);
    const off = { ...state, judgement: { ...state.judgement, degraded: 'off' as const } };
    expect(applyLlmResult(off, resultEvent('intent', 'm1', ANALYSIS_JSON, { evidence: { ...EVIDENCE, project: '~/p' } })).effects[1]).toMatchObject({ event: { payload: { projectId: '~/p' } } });
  });

  it('does nothing for an intent result with unparseable JSON', () => {
    const state = createInitialState('d1');
    expect(applyLlmResult(state, resultEvent('intent', 'm1', 'not json at all')).effects).toEqual([]);
  });

  it('does nothing for an intent result missing either field', () => {
    const state = createInitialState('d1');
    expect(applyLlmResult(state, resultEvent('intent', 'm1', '{"intent": "only intent"}')).effects).toEqual([]);
    expect(applyLlmResult(state, resultEvent('intent', 'm1', '{"narrative": "only narrative"}')).effects).toEqual([]);
  });

  it('does nothing for an unrecognized purpose', () => {
    const state = createInitialState('d1');
    expect(applyLlmResult(state, resultEvent('knowledge', 'm1', 'something')).effects).toEqual([]);
    expect(applyLlmResult(state, resultEvent('narrate', 'm1', 'something')).effects).toEqual([]);
  });

  it('does nothing when momentId or text is missing', () => {
    const state = createInitialState('d1');
    expect(applyLlmResult(state, resultEvent('intent', null, ANALYSIS_JSON)).effects).toEqual([]);
    expect(applyLlmResult(state, resultEvent('intent', 'm1', null)).effects).toEqual([]);
    expect(applyLlmResult(state, resultEvent('intent', 'm1', '   ')).effects).toEqual([]);
  });

  it('ignores non-llm:result events', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };
    expect(applyLlmResult(state, event).effects).toEqual([]);
  });

  it('emits a WriteDB/knowledge_entries effect plus an Embed effect for a companion result, even with an empty momentId', () => {
    const state = createInitialState('d1');
    const text = '{"title": "Late night session", "body": "You worked much later than usual.", "severity": "info"}';
    const { effects } = applyLlmResult(state, resultEvent('companion', '', text));

    expect(effects).toEqual([
      {
        type: 'WriteDB',
        table: 'knowledge_entries',
        row: {
          id: expect.any(String),
          kind: 'companion-insight',
          title: 'Late night session',
          body: 'You worked much later than usual.',
          severity: 'info',
          dedupeKey: 'companion:late night session',
          sourceEventId: 'e1',
          createdAt: '2026-01-01T00:10:00.000Z',
          importanceScore: 8,
        },
      },
      {
        type: 'Embed',
        id: expect.any(String),
        refType: 'knowledge_entry',
        refId: expect.any(String),
        text: 'Late night session. You worked much later than usual.',
      },
    ]);
  });

  it('does nothing for a companion result with unparseable JSON', () => {
    const state = createInitialState('d1');
    expect(applyLlmResult(state, resultEvent('companion', '', 'not json at all')).effects).toEqual([]);
  });

  it('D5: appends the new insight to state.memory.recentInsights, tagged with metadata.kind', () => {
    const state = createInitialState('d1');
    const text = '{"title": "Late night session", "body": "You worked much later than usual.", "severity": "info"}';
    const { state: next, effects } = applyLlmResult(state, resultEvent('companion', '', text, { kind: 'late-night' }));

    // `id` is carried so `solicitFeedback` can name the artifact; it is the same
    // id as the knowledge_entries row this rule writes.
    const written = effects.find((e) => e.type === 'WriteDB' && e.table === 'knowledge_entries');
    const entryId = written && written.type === 'WriteDB' ? written.row.id : undefined;
    expect(entryId).toBeTruthy();
    expect(next.memory.recentInsights).toEqual([{ title: 'Late night session', dedupeKey: 'companion:late night session', kind: 'late-night', createdAt: '2026-01-01T00:10:00.000Z', id: entryId }]);
  });

  it('D5: tags the recentInsights entry "unknown" when no metadata.kind is present', () => {
    const state = createInitialState('d1');
    const text = '{"title": "Late night session", "body": "You worked much later than usual.", "severity": "info"}';
    const { state: next } = applyLlmResult(state, resultEvent('companion', '', text));

    expect(next.memory.recentInsights[0].kind).toBe('unknown');
  });

  it('D5: caps recentInsights at MAX_RECENT_INSIGHTS (30), dropping the oldest first', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < 31; i++) {
      const text = `{"title": "Insight ${i}", "body": "body", "severity": "info"}`;
      state = applyLlmResult(state, resultEvent('companion', '', text, { kind: 'k' })).state;
    }
    expect(state.memory.recentInsights).toHaveLength(30);
    expect(state.memory.recentInsights[0].title).toBe('Insight 1');
    expect(state.memory.recentInsights[29].title).toBe('Insight 30');
  });
});

describe('parseMomentAnalysis', () => {
  it('parses strict JSON', () => {
    expect(parseMomentAnalysis(ANALYSIS_JSON)).toEqual({ intent: 'Debugging the reducer.', narrative: 'Fixed the reducer bug.' });
  });

  it('strips a markdown code fence the model added despite being asked not to', () => {
    expect(parseMomentAnalysis(`\`\`\`json\n${ANALYSIS_JSON}\n\`\`\``)).toEqual({ intent: 'Debugging the reducer.', narrative: 'Fixed the reducer bug.' });
  });

  it('returns null when either field is missing', () => {
    expect(parseMomentAnalysis('{"intent": "only intent"}')).toBeNull();
    expect(parseMomentAnalysis('{"narrative": "only narrative"}')).toBeNull();
  });

  it('returns null for unparseable text instead of throwing', () => {
    expect(parseMomentAnalysis('definitely not json')).toBeNull();
  });
});

describe('parseCompanionInsight', () => {
  it('parses strict JSON', () => {
    expect(parseCompanionInsight('{"title": "T", "body": "B", "severity": "warning"}')).toEqual({ title: 'T', body: 'B', severity: 'warning' });
  });

  it('strips a markdown code fence the model added despite being asked not to', () => {
    expect(parseCompanionInsight('```json\n{"title": "T", "body": "B", "severity": "info"}\n```')).toEqual({ title: 'T', body: 'B', severity: 'info' });
  });

  it('returns null when title or body is missing', () => {
    expect(parseCompanionInsight('{"title": "", "body": "B"}')).toBeNull();
    expect(parseCompanionInsight('{"body": "B"}')).toBeNull();
  });

  it('R1: a write-up cut off mid-stream (a route failing at 50%) is dropped whole, never half-written', () => {
    // The notice itself is the rule's own sentence, sent by the gate's Notify before any model call
    // (notice-gate.test.ts: Notify, then ScheduleLLM); only this note rides the route, and a partial one is no note.
    expect(parseCompanionInsight('{"title": "T", "body": "B')).toBeNull();
    expect(parseCompanionInsight('{"title": "T", "bo')).toBeNull();
  });

  it('returns null for unparseable text instead of throwing', () => {
    expect(parseCompanionInsight('definitely not json')).toBeNull();
  });

  it('defaults severity to null when absent', () => {
    expect(parseCompanionInsight('{"title": "T", "body": "B"}')).toEqual({ title: 'T', body: 'B', severity: null });
  });
});
