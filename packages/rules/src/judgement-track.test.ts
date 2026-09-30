import { describe, expect, it } from 'vitest';
import { createInitialState, hydrateSnapshot } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { answerProbability, bestThreshold, gradeAnswer, judgementTrack, THRESHOLD_MIN_N } from './judgement-track.js';
import { questionId } from './questions/index.js';
import { MOMENT_FANOUT_QUESTIONS } from './questions/moment-fanout.js';

const result = (answers: Record<string, unknown>, extra: Record<string, unknown> = {}): SanitizedEvent => ({
  id: 'e1',
  type: 'judgement:result',
  ts: '2026-09-21T10:00:00.000Z',
  payload: { purpose: 'classify', questionSetId: 'moment-fanout', momentId: 'm-1', answers, model: 'typesafe/jev-latest', latencyMs: 300, ...extra },
  sanitized: true,
});

describe('judgementTrack', () => {
  it('opens a record per question at the lab default, and keeps the decided-on probability by moment', () => {
    const { state } = judgementTrack(
      createInitialState('d1'),
      result({
        is_work: { type: 'noul', noul: 0.82, confidence: 0.82 },
        subject: { type: 'choice', choice: 'project', probabilities: { project: 0.6, app: 0.4 }, confidence: 0.6 },
        depth: { type: 'score', score: 2, probabilities: { '2': 0.7, '3': 0.3 } },
      }),
    );
    const isWork = questionId(MOMENT_FANOUT_QUESTIONS.is_work);
    const subject = questionId(MOMENT_FANOUT_QUESTIONS.subject);
    expect(state.judgement.questions[isWork]).toMatchObject({ type: 'noul', threshold: 0.5, n: 0 });
    expect(state.judgement.questions[subject]).toMatchObject({ type: 'choice', threshold: 0.7 });
    expect(state.judgement.recent).toHaveLength(1);
    expect(state.judgement.recent[0]).toMatchObject({ momentId: 'm-1', artifactId: null, questionSetId: 'moment-fanout' });
    expect(state.judgement.recent[0].p[isWork]).toBe(0.82);
    expect(state.judgement.recent[0].p[subject]).toBe(0.6);
  });

  it('a backfilled answer (J2.6) opens the record but stays out of `recent`', () => {
    const { state } = judgementTrack(createInitialState('d1'), result({ is_work: { type: 'noul', noul: 0.82 } }, { metadata: { backfill: true } }));
    expect(state.judgement.questions[questionId(MOMENT_FANOUT_QUESTIONS.is_work)]).toMatchObject({ n: 0 });
    expect(state.judgement.recent).toHaveLength(0);
  });

  it('J5.4: an answer tagged with an artifact keeps its own ring; two results for one moment merge into one entry', () => {
    let state = createInitialState('d1');
    state = judgementTrack(state, result({ is_work: { type: 'noul', noul: 0.8 } })).state;
    state = judgementTrack(state, { ...result({ hedges: { type: 'noul', noul: 0.1 } }, { questionSetId: 'judge-line' }), id: 'e2' }).state;
    expect(state.judgement.recent).toHaveLength(1);
    expect(Object.keys(state.judgement.recent[0].p)).toHaveLength(2);
    state = judgementTrack(state, { ...result({ speak_now: { type: 'noul', noul: 0.3 } }, { questionSetId: 'gate-features', momentId: null, metadata: { artifactId: 'absent:break' } }), id: 'e3' }).state;
    expect(state.judgement.recent).toHaveLength(1);
    expect(state.judgement.recentByArtifact).toHaveLength(1);
    expect(state.judgement.recentByArtifact[0]).toMatchObject({ artifactId: 'absent:break', questionSetId: 'gate-features' });
  });

  it('J5.4: degraded time is clocked — starts when the mark leaves none, banks when it returns', () => {
    const degraded = (mode: string, ts: string): SanitizedEvent => ({ id: `d-${ts}`, type: 'judgement:degraded', ts, payload: { mode }, sanitized: true });
    let state = createInitialState('d1');
    state = judgementTrack(state, degraded('local-fallback', '2026-09-22T10:00:00.000Z')).state;
    expect(state.judgement).toMatchObject({ degraded: 'local-fallback', degradedSince: '2026-09-22T10:00:00.000Z', degradedMs: 0 });
    state = judgementTrack(state, degraded('off', '2026-09-22T10:05:00.000Z')).state;
    expect(state.judgement.degradedSince).toBe('2026-09-22T10:00:00.000Z');
    state = judgementTrack(state, degraded('none', '2026-09-22T10:10:00.000Z')).state;
    expect(state.judgement).toMatchObject({ degraded: 'none', degradedSince: null, degradedMs: 10 * 60_000 });
  });

  it('ignores an unknown set and a malformed payload; never emits effects', () => {
    const state = createInitialState('d1');
    expect(judgementTrack(state, result({}, { questionSetId: 'nope' })).state).toBe(state);
    expect(judgementTrack(state, result({ is_work: { type: 'noul', noul: 0.5 } })).effects).toEqual([]);
  });

  it('judgement:degraded moves the mark and nothing else', () => {
    const { state } = judgementTrack(createInitialState('d1'), { id: 'e2', type: 'judgement:degraded', ts: '2026-09-21T10:00:00.000Z', payload: { mode: 'local-fallback' }, sanitized: true });
    expect(state.judgement.degraded).toBe('local-fallback');
    expect(judgementTrack(state, { id: 'e3', type: 'judgement:degraded', ts: 'x', payload: { mode: 'weird' }, sanitized: true }).state).toBe(state);
  });

  it('a snapshot round-trips the slice, and one from before the field gets the defaults', () => {
    const { state } = judgementTrack(createInitialState('d1'), result({ is_work: { type: 'noul', noul: 0.82 } }));
    const graded = { ...state, judgement: { ...state.judgement, degraded: 'off' as const } };
    const back = hydrateSnapshot('d1', JSON.parse(JSON.stringify(graded)) as Partial<KernelState>);
    expect(back.judgement).toEqual(graded.judgement);
    const { judgement: _dropped, ...old } = createInitialState('d1');
    expect(hydrateSnapshot('d1', old as Partial<KernelState>).judgement).toEqual({ questions: {}, recent: [], recentByArtifact: [], degraded: 'none', degradedSince: null, degradedMs: 0, consulted: {}, rejudge: null });
  });
});

describe('answerProbability (law 5)', () => {
  it('reads the vector, not confidence', () => {
    expect(answerProbability({ type: 'noul', noul: 0.3, confidence: 0.9 })).toBe(0.3);
    expect(answerProbability({ type: 'choice', choice: 'a', probabilities: { a: 0.55, b: 0.45 }, confidence: 0.1 })).toBe(0.55);
    expect(answerProbability({ type: 'score', score: 1, confidence: 0.4 })).toBe(0.4);
    expect(answerProbability({ type: 'score' })).toBeNull();
  });
});

describe('gradeAnswer and bestThreshold', () => {
  it('moves the threshold off the default only at n ≥ 20, to the edge that maximises accuracy', () => {
    let record = judgementTrack(createInitialState('d1'), result({ is_work: { type: 'noul', noul: 0.5 } })).state.judgement.questions[questionId(MOMENT_FANOUT_QUESTIONS.is_work)];
    // Ten useful answers at p ≈ 0.85, ten wrong at p ≈ 0.65: the true edge is 0.8, not the default 0.5.
    for (let i = 0; i < THRESHOLD_MIN_N - 1; i += 1) record = gradeAnswer(record, i % 2 === 0 ? 0.85 : 0.65, i % 2 === 0, 't');
    expect(record.threshold).toBe(0.5);
    expect(record.n).toBe(THRESHOLD_MIN_N - 1);
    record = gradeAnswer(record, 0.65, false, 't');
    expect(record.n).toBe(THRESHOLD_MIN_N);
    expect(record.threshold).toBe(0.7);
    expect(record.bins.n[8]).toBe(10);
    expect(record.bins.hits[8]).toBe(10);
    expect(record.bins.hits[6]).toBe(0);
    expect(bestThreshold(record.bins)).toBe(0.7);
  });
});

describe('judgementTrack: W3 consults and the rejudge job', () => {
  const ev = (type: string, ts: string, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${ts}`, type, ts, payload, sanitized: true });

  it('counts a consult per question set; the answers stay in the log', () => {
    let state = createInitialState('d1');
    for (const set of ['rank-evidence', 'rank-evidence', 'route-ask']) state = judgementTrack(state, ev('judgement:consulted', '2026-09-29T10:00:00.000Z', { callId: 'c', questionSetId: set, answers: {} })).state;
    expect(state.judgement.consulted).toEqual({ 'rank-evidence': 2, 'route-ask': 1 });
  });

  it('a request opens the job and asks for RunRejudge; a second while it runs does nothing; a finish closes it', () => {
    const opened = judgementTrack(createInitialState('d1'), ev('rejudge:requested', '2026-09-29T10:00:00.000Z', { all: false, limit: 50, bench: 'x', pack: -1 }));
    expect(opened.effects).toEqual([{ type: 'RunRejudge', options: { limit: 50 } }]);
    expect(opened.state.judgement.rejudge).toMatchObject({ running: true, startedAt: '2026-09-29T10:00:00.000Z', options: { limit: 50 } });
    expect(judgementTrack(opened.state, ev('rejudge:requested', '2026-09-29T10:05:00.000Z', { all: true })).effects).toEqual([]);
    const done = judgementTrack(opened.state, ev('rejudge:finished', '2026-09-29T10:06:00.000Z', { total: 50, done: 48, calls: 50, failedCalls: 2 })).state;
    expect(done.judgement.rejudge).toMatchObject({ running: false, finishedAt: '2026-09-29T10:06:00.000Z', total: 50, done: 48, calls: 50, failedCalls: 2, error: null });
    expect(judgementTrack(done, ev('rejudge:requested', '2026-09-29T10:07:00.000Z', { all: true })).effects).toEqual([{ type: 'RunRejudge', options: { all: true } }]);
  });

  it('a job that never reported back stops holding the slot after an hour', () => {
    const opened = judgementTrack(createInitialState('d1'), ev('rejudge:requested', '2026-09-29T10:00:00.000Z')).state;
    expect(judgementTrack(opened, ev('rejudge:requested', '2026-09-29T11:00:01.000Z')).effects).toEqual([{ type: 'RunRejudge', options: {} }]);
  });
});

describe('migrateQuestionIds (W6 D4, the one-time mapping)', () => {
  it('moves records and rings from wording hashes to template ids, pools what lands on one, and is idempotent', async () => {
    const { migrateQuestionIds, gradeAnswer: grade } = await import('./judgement-track.js');
    const { wordingHash } = await import('./questions/index.js');
    const hash = wordingHash(MOMENT_FANOUT_QUESTIONS.is_work);
    const base = createInitialState('d1').judgement;
    const empty = { type: 'noul', threshold: 0.5, n: 0, hits: 0, bins: { n: Array(10).fill(0), hits: Array(10).fill(0) }, lastVerdictAt: null };
    const old = grade(empty, 0.8, true, '2026-09-20T10:00:00.000Z');
    const already = grade(empty, 0.3, false, '2026-09-21T10:00:00.000Z');
    const before = { ...base, questions: { [hash]: old, 'moment-fanout:is_work': already, 'f00dfeedbeef': empty }, recent: [{ ts: 't', questionSetId: 'moment-fanout', momentId: 'm-1', artifactId: null, p: { [hash]: 0.8 } }] };
    const after = migrateQuestionIds(before);
    expect(Object.keys(after.questions).sort()).toEqual(['f00dfeedbeef', 'moment-fanout:is_work']);
    expect(after.questions['moment-fanout:is_work']).toMatchObject({ n: 2, hits: 1, lastVerdictAt: '2026-09-21T10:00:00.000Z' });
    expect(after.recent[0]!.p).toEqual({ 'moment-fanout:is_work': 0.8 });
    expect(migrateQuestionIds(after)).toBe(after);
  });
});
