import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, SanitizedEvent } from '@sundial/kernel/types.js';
import { draftTrack } from './draft-track.js';

const ev = (type: string, payload: Record<string, unknown>, id = 'e1'): SanitizedEvent => ({ id, type, ts: '2026-09-22T10:00:00.000Z', payload, sanitized: true });

describe('draftTrack (J4.3)', () => {
  it('records a draft with its evidence, asks the judge with the draft id as the artifact, files the answers, and closes on the tap', () => {
    const { state, effects } = draftTrack(createInitialState('d1'), ev('assistant:draft', { kind: 'email', to: 'Marco', subject: 'Hint border', body: 'Hi Marco, the fix is in PR #4701.', evidence: ['PR #4701 opened 2026-09-18'] }));
    expect(state.drafts.recent[0]).toMatchObject({ id: 'draft:e1', kind: 'email', to: 'Marco', status: 'open', judged: null, evidence: ['PR #4701 opened 2026-09-18'] });
    const judge = effects.find((e) => e.type === 'Judge') as Extract<Effect, { type: 'Judge' }>;
    expect(judge).toMatchObject({ questionSetId: 'judge-draft', purpose: 'judge', metadata: { artifactId: 'draft:e1', draftId: 'draft:e1' } });
    expect(JSON.stringify(judge.state)).toContain('PR #4701');
    const judged = draftTrack(state, ev('judgement:result', { purpose: 'judge', questionSetId: 'judge-draft', momentId: null, answers: { grounded: { type: 'noul', noul: 0.88 }, tone: { type: 'score', score: 2.3 } }, model: 'm', latencyMs: 1, metadata: { draftId: 'draft:e1' } }, 'e2')).state;
    expect(judged.drafts.recent[0].judged).toEqual({ grounded: 0.88, tone: 2 });
    const sent = draftTrack(judged, ev('draft:closed', { id: 'draft:e1', outcome: 'sent' }, 'e3')).state;
    expect(sent.drafts.recent[0]).toMatchObject({ status: 'sent', closedAt: '2026-09-22T10:00:00.000Z' });
    expect(draftTrack(sent, ev('draft:closed', { id: 'draft:e1', outcome: 'dismissed' }, 'e4')).state).toBe(sent);
  });

  it('drops a draft with no kind, subject or body', () => {
    const base = createInitialState('d1');
    expect(draftTrack(base, ev('assistant:draft', { kind: 'letter', subject: 'x', body: 'y' })).state).toBe(base);
    expect(draftTrack(base, ev('assistant:draft', { kind: 'note', subject: '', body: 'y' })).effects).toEqual([]);
  });
});
