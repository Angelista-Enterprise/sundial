import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { feedbackTrack } from './feedback-track.js';
import { rebuildAskClassGain } from './owner-ask.js';
import { judgementTrack } from './judgement-track.js';
import { questionId } from './questions/index.js';
import { MOMENT_FANOUT_QUESTIONS } from './questions/moment-fanout.js';

function verdictEvent(payload: Record<string, unknown>, ts = '2026-01-01T10:00:00.000Z', id = 'e1'): SanitizedEvent {
  return { id, type: 'feedback:verdict', ts, payload, sanitized: true };
}

const USEFUL = { verdict: 'useful', artifactKind: 'knowledge_entry', artifactId: 'k1' };

describe('feedbackTrack', () => {
  it('ignores unrelated event types', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = feedbackTrack(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('records a verdict onto the slice and bumps its cumulative count', () => {
    const { state: next, effects } = feedbackTrack(createInitialState('d1'), verdictEvent(USEFUL));
    expect(effects).toEqual([]);
    expect(next.feedback.recent).toEqual([
      { artifactKind: 'knowledge_entry', artifactId: 'k1', verdict: 'useful', solicited: false, note: null, ts: '2026-01-01T10:00:00.000Z' },
    ]);
    expect(next.feedback.countsByVerdict).toEqual({ useful: 1 });
    expect(next.feedback.lastVerdictAt).toBe('2026-01-01T10:00:00.000Z');
  });

  it('a `wrong` verdict feeds the shared surprise drive — it is real prediction error', () => {
    const { state: next } = feedbackTrack(createInitialState('d1'), verdictEvent({ ...USEFUL, verdict: 'wrong' }));
    expect(next.memory.accumulatedImportance).toBeGreaterThan(0);
    expect(next.feedback.countsByVerdict).toEqual({ wrong: 1 });
  });

  it('`useful` and `not-now` leave the drive untouched — confirmation is not error, and bad timing is not incorrectness', () => {
    for (const verdict of ['useful', 'not-now']) {
      const { state: next } = feedbackTrack(createInitialState('d1'), verdictEvent({ ...USEFUL, verdict }));
      expect(next.memory.accumulatedImportance).toBe(0);
    }
  });

  it('carries `solicited` and a trimmed note through', () => {
    const { state: next } = feedbackTrack(createInitialState('d1'), verdictEvent({ ...USEFUL, solicited: true, note: '  not my project  ' }));
    expect(next.feedback.recent[0]).toMatchObject({ solicited: true, note: 'not my project' });
  });

  it('treats a blank note as absent rather than storing an empty string', () => {
    const { state: next } = feedbackTrack(createInitialState('d1'), verdictEvent({ ...USEFUL, note: '   ' }));
    expect(next.feedback.recent[0].note).toBeNull();
  });

  it.each([
    ['an unknown verdict', { ...USEFUL, verdict: 'meh' }],
    ['a missing verdict', { artifactKind: 'moment', artifactId: 'm1' }],
    ['an unknown artifact kind', { ...USEFUL, artifactKind: 'tarot_card' }],
    ['a missing artifact id', { verdict: 'useful', artifactKind: 'moment' }],
    ['a blank artifact id', { ...USEFUL, artifactId: '   ' }],
  ])('drops %s rather than folding junk into the tally', (_label, payload) => {
    const state = createInitialState('d1');
    const { state: next } = feedbackTrack(state, verdictEvent(payload));
    expect(next).toBe(state);
    expect(next.feedback.countsByVerdict).toEqual({});
  });

  it('accumulates several verdicts, keeping counts per verdict', () => {
    let state = createInitialState('d1');
    state = feedbackTrack(state, verdictEvent(USEFUL, '2026-01-01T10:00:00.000Z', 'e1')).state;
    state = feedbackTrack(state, verdictEvent({ ...USEFUL, artifactId: 'k2' }, '2026-01-01T11:00:00.000Z', 'e2')).state;
    state = feedbackTrack(state, verdictEvent({ ...USEFUL, verdict: 'wrong', artifactId: 'k3' }, '2026-01-01T12:00:00.000Z', 'e3')).state;

    expect(state.feedback.recent).toHaveLength(3);
    expect(state.feedback.countsByVerdict).toEqual({ useful: 2, wrong: 1 });
    expect(state.feedback.lastVerdictAt).toBe('2026-01-01T12:00:00.000Z');
  });

  it('caps `recent` at 50 while the cumulative counts keep growing past it', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < 60; i++) {
      state = feedbackTrack(state, verdictEvent({ ...USEFUL, artifactId: `k${i}` }, '2026-01-01T10:00:00.000Z', `e${i}`)).state;
    }
    expect(state.feedback.recent).toHaveLength(50);
    expect(state.feedback.recent[49].artifactId).toBe('k59');
    expect(state.feedback.countsByVerdict).toEqual({ useful: 60 });
  });

  /**
   * The reducer decides `solicited` from whether Gnomon actually asked, so a
   * solicited rating is recorded correctly no matter which surface submits it —
   * the CLI/macOS/iOS all still send `solicited:false`.
   */
  describe('solicited stamping — the answering half of the ask', () => {
    function withOpenAsk(artifactId = 'k1') {
      const state = createInitialState('d1');
      return {
        ...state,
        feedback: { ...state.feedback, solicitation: { artifactKind: 'knowledge_entry' as const, artifactId, question: 'Was this useful? “X”', ts: '2026-01-01T09:00:00.000Z' } },
      };
    }

    it('marks a verdict solicited when it answers the open ask, even though the client sent solicited:false', () => {
      const { state: next } = feedbackTrack(withOpenAsk('k1'), verdictEvent(USEFUL));
      expect(next.feedback.recent[0].solicited).toBe(true);
    });

    it('clears the solicitation once its artifact is answered', () => {
      const { state: next } = feedbackTrack(withOpenAsk('k1'), verdictEvent(USEFUL));
      expect(next.feedback.solicitation).toBeNull();
    });

    it('also counts a verdict solicited when the ask pointer has rotated but the id is still in solicitedRecently', () => {
      const base = createInitialState('d1');
      const state = { ...base, feedback: { ...base.feedback, solicitedRecently: ['k1'] } };
      const { state: next } = feedbackTrack(state, verdictEvent(USEFUL));
      expect(next.feedback.recent[0].solicited).toBe(true);
    });

    it('leaves an unrelated verdict unsolicited and the open ask untouched', () => {
      const { state: next } = feedbackTrack(withOpenAsk('k1'), verdictEvent({ ...USEFUL, artifactId: 'k2' }));
      expect(next.feedback.recent[0].solicited).toBe(false);
      expect(next.feedback.solicitation?.artifactId).toBe('k1');
    });
  });

  /**
   * The return path used to stop at recording the verdict, which made the whole
   * feedback mechanism write-only. These cover the consumer side.
   */
  describe('retraction — the consumer side of a `wrong` verdict', () => {
    const WRONG_FACT = { verdict: 'wrong', artifactKind: 'entity_fact', artifactId: 'f1' };

    /** A cursor entry in the state `contradictionCheck` would have left after promoting `f1`. */
    function withConfirmedFact(key = 'person:jesse:collaboratesOn:WCS') {
      const state = createInitialState('d1');
      return {
        ...state,
        memory: {
          ...state.memory,
          factCursor: { [key]: { object: 'WCS', factId: 'f1', confidence: 80, pendingObject: null, pendingCount: 0, projectId: null } },
        },
      };
    }

    it('emits a RetractFact for a `wrong` verdict on a fact', () => {
      const { effects } = feedbackTrack(withConfirmedFact(), verdictEvent(WRONG_FACT));
      expect(effects).toEqual([{ type: 'RetractFact', factId: 'f1', reason: 'owner verdict: wrong', ts: '2026-01-01T10:00:00.000Z' }]);
    });

    it('clears the cursor entry so the next observation cannot reinforce the rejected belief', () => {
      // Without this the very next sighting takes contradictionCheck's "repeat
      // of confirmed truth" branch and strengthens the fact the owner just
      // rejected, never going near the promotion threshold.
      const { state: next } = feedbackTrack(withConfirmedFact(), verdictEvent(WRONG_FACT));
      expect(next.memory.factCursor['person:jesse:collaboratesOn:WCS']).toEqual({
        object: null,
        factId: null,
        confidence: 80,
        pendingObject: null,
        pendingCount: 0,
        projectId: null,
      });
    });

    it('leaves cursor entries for other facts alone', () => {
      const base = withConfirmedFact();
      const state = {
        ...base,
        memory: {
          ...base.memory,
          factCursor: { ...base.memory.factCursor, 'person:sam:collaboratesOn:WCS': { object: 'WCS', factId: 'f2', confidence: 70, pendingObject: null, pendingCount: 0, projectId: null } },
        },
      };
      const { state: next } = feedbackTrack(state, verdictEvent(WRONG_FACT));
      expect(next.memory.factCursor['person:sam:collaboratesOn:WCS'].factId).toBe('f2');
    });

    it('still records the verdict and feeds the drive while retracting', () => {
      const { state: next } = feedbackTrack(withConfirmedFact(), verdictEvent(WRONG_FACT));
      expect(next.feedback.countsByVerdict).toEqual({ wrong: 1 });
      expect(next.memory.accumulatedImportance).toBeGreaterThan(0);
    });

    it.each(['useful', 'not-now'])('retracts nothing on a `%s` verdict — only `wrong` withdraws a belief', (verdict) => {
      const { state: next, effects } = feedbackTrack(withConfirmedFact(), verdictEvent({ ...WRONG_FACT, verdict }));
      expect(effects.some((e) => e.type === 'RetractFact')).toBe(false);
      expect(next.memory.factCursor['person:jesse:collaboratesOn:WCS'].factId).toBe('f1');
    });

    it('`useful` on a fact REINFORCES it — the half of the loop that was missing', () => {
      // Until 2026-08-14 belief could only fall on owner input, never rise: `wrong`
      // retracted and `useful` was counted and discarded. The owner confirming a
      // fact from outside the sensor stream is the strongest evidence available.
      const { effects } = feedbackTrack(withConfirmedFact(), verdictEvent({ ...WRONG_FACT, verdict: 'useful' }));
      expect(effects).toEqual([{ type: 'ReinforceFact', factId: 'f1', delta: 1, ts: '2026-01-01T10:00:00.000Z' }]);
    });

    it('`not-now` still moves no belief at all — it is a claim about timing', () => {
      const { effects } = feedbackTrack(withConfirmedFact(), verdictEvent({ ...WRONG_FACT, verdict: 'not-now' }));
      expect(effects).toEqual([]);
    });

    it('retracts nothing for a `moment` — a moment embeds what the sensor saw, and no verdict makes an observation untrue', () => {
      // Deliberately still inert, and the reason is checkable rather than
      // assumed: `embeddingIndex` builds a moment's vector from its process
      // name and window titles, with none of the LLM's narrative in it. There
      // is no claim in the retrievable text to withdraw.
      const { effects } = feedbackTrack(withConfirmedFact(), verdictEvent({ ...WRONG_FACT, artifactKind: 'moment' }));
      expect(effects).toEqual([]);
    });

    it('a `wrong` verdict on a KNOWLEDGE ENTRY retracts it — an entry is indexed, so leaving it would let Gnomon cite its own mistake', () => {
      const { effects } = feedbackTrack(withConfirmedFact(), verdictEvent({ ...WRONG_FACT, artifactKind: 'knowledge_entry', artifactId: 'k9' }));
      expect(effects).toEqual([{ type: 'RetractKnowledgeEntry', entryId: 'k9', reason: 'owner verdict: wrong', ts: '2026-01-01T10:00:00.000Z' }]);
    });

    it.each(['useful', 'not-now'])('leaves a knowledge entry standing on a `%s` verdict', (verdict) => {
      const { effects } = feedbackTrack(withConfirmedFact(), verdictEvent({ verdict, artifactKind: 'knowledge_entry', artifactId: 'k9' }));
      expect(effects.some((e) => e.type === 'RetractKnowledgeEntry')).toBe(false);
    });

    it('still retracts when no cursor entry holds the fact, and says so in the reason', () => {
      // The cursor is bounded at 512 entries, so a fact promoted long ago may
      // have been evicted. The row must still be withdrawn.
      const { effects } = feedbackTrack(createInitialState('d1'), verdictEvent(WRONG_FACT));
      expect(effects).toEqual([
        { type: 'RetractFact', factId: 'f1', reason: 'owner verdict: wrong (no cursor entry held it)', ts: '2026-01-01T10:00:00.000Z' },
      ]);
    });
  });

  describe('a verdict on an answer (a chat turn)', () => {
    const TURN = { verdict: 'wrong', artifactKind: 'ask_thread', artifactId: 'session-7f#3' };
    it('is recorded, and withdraws nothing: an answer is history, not memory (W6 P4)', () => {
      const { state: next, effects } = feedbackTrack(createInitialState('d1'), verdictEvent(TURN));
      expect(next.feedback.recent[0].artifactKind).toBe('ask_thread');
      expect(next.feedback.countsByVerdict).toEqual({ wrong: 1 });
      expect(effects).toEqual([]);
    });
  });

  // The interrupting channel's return path. A phasic notice leaves no artifact
  // row anywhere — it is a `Notify` and nothing more — so its verdict names the
  // gate key directly rather than a knowledge entry that was never written.
  describe('a `notice` verdict', () => {
    const NOTICE = { artifactKind: 'notice', artifactId: 'absent:break', verdict: 'not-now' };

    it('quiets the gate key it names, with no knowledge entry to look up', () => {
      const { state: next } = feedbackTrack(createInitialState('d1'), verdictEvent(NOTICE));
      const entry = next.notices.habituation['absent:break'];
      expect(entry?.fires).toBe(1);
      expect(entry?.gain).toBeLessThan(1);
    });

    it('deepens on repetition — being told "not now" twice is quieter than once', () => {
      const first = feedbackTrack(createInitialState('d1'), verdictEvent(NOTICE)).state;
      const second = feedbackTrack(first, verdictEvent(NOTICE, '2026-01-01T11:00:00.000Z', 'e2')).state;
      expect(second.notices.habituation['absent:break']!.fires).toBe(2);
      expect(second.notices.habituation['absent:break']!.gain).toBeLessThan(first.notices.habituation['absent:break']!.gain);
    });

    it('is recorded in the tally like any other verdict', () => {
      const { state: next } = feedbackTrack(createInitialState('d1'), verdictEvent(NOTICE));
      expect(next.feedback.recent[0]).toMatchObject({ artifactKind: 'notice', artifactId: 'absent:break', verdict: 'not-now' });
      expect(next.feedback.countsByVerdict).toEqual({ 'not-now': 1 });
    });

    it('never quiets on `useful` — quieting a key the owner called useful would punish the gate for being right', () => {
      const { state: next } = feedbackTrack(createInitialState('d1'), verdictEvent({ ...NOTICE, verdict: 'useful' }));
      expect(next.notices.habituation['absent:break']).toBeUndefined();
    });

    it('`useful` restores a worn key to full response, for the notice key and for a tonic insight alike', () => {
      const worn = createInitialState('d1');
      worn.notices.habituation = { 'watch:ci:ab12': { gain: 0.16, at: '2026-01-01T09:00:00.000Z', fires: 2 }, other: { gain: 0.4, at: '2026-01-01T09:00:00.000Z', fires: 1 } };
      const direct = feedbackTrack(worn, verdictEvent({ artifactKind: 'notice', artifactId: 'watch:ci:ab12', verdict: 'useful' })).state;
      expect(direct.notices.habituation).toEqual({ other: worn.notices.habituation.other });
      worn.memory.recentInsights = [{ id: 'k1', noticeKey: 'other' } as (typeof worn.memory.recentInsights)[number]];
      const viaInsight = feedbackTrack(worn, verdictEvent({ artifactKind: 'knowledge_entry', artifactId: 'k1', verdict: 'useful' })).state;
      expect(viaInsight.notices.habituation.other).toBeUndefined();
    });
  });

  describe('grading the Jev answers behind the artifact (docs/jarvis/02, J0.7)', () => {
    const answered = (state = createInitialState('d1')) =>
      judgementTrack(state, {
        id: 'j1',
        type: 'judgement:result',
        ts: '2026-09-21T09:59:00.000Z',
        payload: { purpose: 'classify', questionSetId: 'moment-fanout', momentId: 'm-1', answers: { is_work: { type: 'noul', noul: 0.82 }, depth: { type: 'score', score: 3, probabilities: { '3': 0.66 } } }, model: 'typesafe/jev-latest', latencyMs: 300 },
        sanitized: true,
      }).state;
    const isWork = questionId(MOMENT_FANOUT_QUESTIONS.is_work);
    const depth = questionId(MOMENT_FANOUT_QUESTIONS.depth);

    it('`useful` on the moment is a hit in each answer\'s decile; `wrong` is a miss', () => {
      const useful = feedbackTrack(answered(), verdictEvent({ verdict: 'useful', artifactKind: 'moment', artifactId: 'm-1' })).state;
      expect(useful.judgement.questions[isWork]).toMatchObject({ n: 1, hits: 1, lastVerdictAt: '2026-01-01T10:00:00.000Z' });
      expect(useful.judgement.questions[isWork].bins.hits[8]).toBe(1);
      expect(useful.judgement.questions[depth].bins.n[6]).toBe(1);
      const wrong = feedbackTrack(answered(), verdictEvent({ verdict: 'wrong', artifactKind: 'moment', artifactId: 'm-1' })).state;
      expect(wrong.judgement.questions[isWork]).toMatchObject({ n: 1, hits: 0 });
      expect(wrong.judgement.questions[isWork].bins.n[8]).toBe(1);
    });

    it('J5.4: a `notice` verdict finds the gate features behind the notice KEY, and an `entity_fact` verdict the audit behind the fact id', () => {
      const tagged = (set: string, artifactId: string, answers: Record<string, unknown>) =>
        judgementTrack(createInitialState('d1'), { id: `j-${artifactId}`, type: 'judgement:result', ts: '2026-09-21T09:59:00.000Z', payload: { purpose: 'classify', questionSetId: set, momentId: null, answers, model: 'm', latencyMs: 1, metadata: { artifactId } }, sanitized: true }).state;
      const notice = feedbackTrack(tagged('gate-features', 'absent:break', { speak_now: { type: 'noul', noul: 0.3 } }), verdictEvent({ verdict: 'useful', artifactKind: 'notice', artifactId: 'absent:break' })).state;
      expect(Object.values(notice.judgement.questions).some((q) => q.n === 1 && q.hits === 1)).toBe(true);
      // W5 step 4: `is_false` at 0.8 on a fact the owner called wrong was RIGHT — an inverted question.
      const fact = feedbackTrack(tagged('audit-fact', 'f-1', { is_false: { type: 'noul', noul: 0.8 } }), verdictEvent({ verdict: 'wrong', artifactKind: 'entity_fact', artifactId: 'f-1' })).state;
      expect(fact.judgement.questions['audit-fact:is_false']).toMatchObject({ n: 1, hits: 1 });
    });

    it('W5 step 4: an answer that lands after the verdict is graded when it lands, once per set', () => {
      const audit = (state: ReturnType<typeof createInitialState>, id: string, noul: number) =>
        judgementTrack(state, { id, type: 'judgement:result', ts: '2026-09-22T02:00:00.000Z', payload: { purpose: 'classify', questionSetId: 'audit-fact', momentId: null, answers: { is_false: { type: 'noul', noul } }, model: 'm', latencyMs: 1, metadata: { artifactId: 'f-9' } }, sanitized: true }).state;
      const rated = feedbackTrack(createInitialState('d1'), verdictEvent({ verdict: 'useful', artifactKind: 'entity_fact', artifactId: 'f-9' })).state;
      expect(rated.judgement.questions['audit-fact:is_false']).toBeUndefined();
      const first = audit(rated, 'a1', 0.1);
      // A fact the owner confirmed is not false: graded, and not a hit for `is_false` (a low answer there was right).
      expect(first.judgement.questions['audit-fact:is_false']).toMatchObject({ n: 1, hits: 0 });
      // The next night's audit of the same fact is not a second sample of the one verdict.
      expect(audit(first, 'a2', 0.2).judgement.questions['audit-fact:is_false']).toMatchObject({ n: 1 });
    });

    it('W5 step 4: a verdict on a notice\'s knowledge entry finds the answers behind the notice key', () => {
      let state = judgementTrack(createInitialState('d1'), { id: 'g1', type: 'judgement:result', ts: '2026-09-21T09:59:00.000Z', payload: { purpose: 'classify', questionSetId: 'gate-features', momentId: null, answers: { speak_now: { type: 'noul', noul: 0.7 } }, model: 'm', latencyMs: 1, metadata: { artifactId: 'absent:flow' } }, sanitized: true }).state;
      state.memory.recentInsights = [{ id: 'k7', noticeKey: 'absent:flow' } as (typeof state.memory.recentInsights)[number]];
      state = feedbackTrack(state, verdictEvent({ verdict: 'useful', artifactKind: 'knowledge_entry', artifactId: 'k7' })).state;
      expect(state.judgement.questions['gate-features:speak_now']).toMatchObject({ n: 1, hits: 1 });
    });

    it('W5 step 4: the nightly audit cannot flush a notice\'s answers out of the ring', () => {
      let state = judgementTrack(createInitialState('d1'), { id: 'g1', type: 'judgement:result', ts: '2026-09-21T20:00:00.000Z', payload: { purpose: 'classify', questionSetId: 'gate-features', momentId: null, answers: { speak_now: { type: 'noul', noul: 0.7 } }, model: 'm', latencyMs: 1, metadata: { artifactId: 'absent:flow' } }, sanitized: true }).state;
      for (let i = 0; i < 250; i += 1) state = judgementTrack(state, { id: `a${i}`, type: 'judgement:result', ts: '2026-09-22T02:00:00.000Z', payload: { purpose: 'classify', questionSetId: 'audit-fact', momentId: null, answers: { is_false: { type: 'noul', noul: 0.1 } }, model: 'm', latencyMs: 1, metadata: { artifactId: `f-${i}` } }, sanitized: true }).state;
      expect(state.judgement.recentByArtifact.filter((r) => r.questionSetId === 'audit-fact')).toHaveLength(200);
      state = feedbackTrack(state, verdictEvent({ verdict: 'useful', artifactKind: 'notice', artifactId: 'absent:flow' })).state;
      expect(state.judgement.questions['gate-features:speak_now']).toMatchObject({ n: 1, hits: 1 });
    });

    it('`not-now` grades nothing, and a verdict on an unrelated artifact grades nothing', () => {
      const state = answered();
      expect(feedbackTrack(state, verdictEvent({ verdict: 'not-now', artifactKind: 'moment', artifactId: 'm-1' })).state.judgement).toBe(state.judgement);
      expect(feedbackTrack(state, verdictEvent({ verdict: 'useful', artifactKind: 'moment', artifactId: 'm-2' })).state.judgement.questions).toBe(state.judgement.questions);
    });

    it('the threshold stays at the lab default until twenty graded answers', () => {
      // Twenty moments, one verdict each: a second verdict on one moment does not grade it again (W5 step 4).
      const on = (state: ReturnType<typeof createInitialState>, m: string) =>
        judgementTrack(state, { id: `j-${m}`, type: 'judgement:result', ts: '2026-09-21T09:59:00.000Z', payload: { purpose: 'classify', questionSetId: 'moment-fanout', momentId: m, answers: { is_work: { type: 'noul', noul: 0.82 } }, model: 'm', latencyMs: 1 }, sanitized: true }).state;
      let state = createInitialState('d1');
      for (let i = 0; i < 19; i += 1) state = feedbackTrack(on(state, `m-${i}`), verdictEvent({ verdict: 'useful', artifactKind: 'moment', artifactId: `m-${i}` }, `2026-01-01T10:${String(i).padStart(2, '0')}:00.000Z`, `e${i}`)).state;
      expect(state.judgement.questions[isWork]).toMatchObject({ n: 19, threshold: 0.5 });
      state = feedbackTrack(state, verdictEvent({ verdict: 'useful', artifactKind: 'moment', artifactId: 'm-18' }, '2026-01-01T10:19:30.000Z', 'e19b')).state;
      expect(state.judgement.questions[isWork]).toMatchObject({ n: 19 });
      state = feedbackTrack(on(state, 'm-19'), verdictEvent({ verdict: 'useful', artifactKind: 'moment', artifactId: 'm-19' }, '2026-01-01T10:20:00.000Z', 'e20')).state;
      // Twenty hits, all in the 0.8 decile: any edge at or below 0.8 is perfect; ties keep the lowest, 0.1.
      expect(state.judgement.questions[isWork]).toMatchObject({ n: 20, hits: 20, threshold: 0.1 });
    });
  });
});

describe('a verdict on an ASK quiets its class', () => {
  const ask = (verdict: string, askId = 'owner-ask:who-person-4b3c2d1e0f') => verdictEvent({ verdict, artifactKind: 'owner_ask', artifactId: askId });

  // The one verdict the live record actually holds, on 2026-09-21. Before this
  // it was recorded and dropped: the gate key was the ask's own id, an ask is
  // asked once, so nothing the owner pressed could move anything.
  it('a `wrong` verdict lowers the class the ask belongs to', () => {
    const { state: next } = feedbackTrack(createInitialState('d1'), ask('wrong'));
    expect(next.ownerAsk.classGain.who).toEqual({ gain: 0.4, at: '2026-01-01T10:00:00.000Z', fires: 1 });
    // And only that class. The meeting questions are the ones that work.
    expect(next.ownerAsk.classGain.meeting).toBeUndefined();
  });

  it('W5 loop H: a `useful` verdict raises the class back to full', () => {
    const quiet = feedbackTrack(createInitialState('d1'), ask('wrong')).state;
    expect(feedbackTrack(quiet, ask('useful', 'owner-ask:who-person-9a8b7c6d5e')).state.ownerAsk.classGain.who).toBeUndefined();
    expect(rebuildAskClassGain([{ askId: 'owner-ask:who-person-4b3c2d1e0f', verdict: 'wrong', at: '2026-01-01T10:00:00.000Z' }, { askId: 'owner-ask:who-person-9a8b7c6d5e', verdict: 'useful', at: '2026-01-02T10:00:00.000Z' }])).toEqual({});
  });

  it('a `not-now` lowers it the same way — it is the timing verdict and the gate is about timing', () => {
    const { state: next } = feedbackTrack(createInitialState('d1'), ask('not-now'));
    expect(next.ownerAsk.classGain.who?.gain).toBeCloseTo(0.4, 5);
  });

  // `wrong` counts here and does NOT count for a notice. A notice's `wrong` is
  // about truth and already lowers belief further down; an ask asserts nothing,
  // and on this card's own vocabulary `wrong` means "the wrong question".
  it('a `useful` verdict moves nothing — quieting a key the owner called useful punishes the gate for being right', () => {
    const { state: next } = feedbackTrack(createInitialState('d1'), ask('useful'));
    expect(next.ownerAsk.classGain).toEqual({});
  });

  it('a second verdict compounds, and the class keeps its own count of them', () => {
    const once = feedbackTrack(createInitialState('d1'), ask('wrong')).state;
    const twice = feedbackTrack(once, verdictEvent({ verdict: 'wrong', artifactKind: 'owner_ask', artifactId: 'owner-ask:who-person-2' }, '2026-01-01T11:00:00.000Z', 'e2')).state;
    expect(twice.ownerAsk.classGain.who?.fires).toBe(2);
    expect(twice.ownerAsk.classGain.who?.gain).toBeLessThan(0.4);
  });

  it('leaves the notice gate alone — two habituation maps, two subjects', () => {
    const { state: next } = feedbackTrack(createInitialState('d1'), ask('not-now'));
    expect(next.notices.habituation).toEqual({});
  });
})
