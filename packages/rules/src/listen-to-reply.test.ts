import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { applyOwnerReply, listenToReply } from './listen-to-reply.js';

const TS = '2026-09-21T12:05:00.000Z';
const ASKED_AT = '2026-09-21T12:03:00.000Z';

function withOpenAsk(askId: string, question: string, over: Partial<KernelState> = {}): KernelState {
  const state = createInitialState('d1');
  return {
    ...state,
    ownerAsk: { ...state.ownerAsk, open: { askId, question, reason: 'ended 14:00 with Alex', choices: [], ts: ASKED_AT } },
    meetings: { seen: { 'Puzzlez - Planning|2026-09-21T11:00:00.000Z': { title: 'Puzzlez - Planning', start: '2026-09-21T11:00:00.000Z', end: '2026-09-21T12:00:00.000Z', attendees: ['Alex'], askedAt: ASKED_AT } } },
    ...over,
  };
}
const answered = (askId: string, answer: string): SanitizedEvent => ({ id: 'e-ans', type: 'ask:owner-answered', ts: TS, payload: { askId, answer }, sanitized: true });
const judged = (answers: Record<string, unknown>, metadata: Record<string, unknown>): SanitizedEvent => ({
  id: 'e-jr',
  type: 'judgement:result',
  ts: TS,
  payload: { purpose: 'listen', questionSetId: 'listen-reply', momentId: null, answers, model: 'typesafe/jev-latest', latencyMs: 258, metadata },
  sanitized: true,
});
const judgeOf = (effects: Effect[]) => effects.find((e) => e.type === 'Judge') as Extract<Effect, { type: 'Judge' }> | undefined;

describe('listenToReply', () => {
  it('puts a meeting answer to the judge with the meeting it was about', () => {
    const state = withOpenAsk('owner-ask:meeting-abc', 'How did "Puzzlez - Planning" go?');
    const { effects } = listenToReply(state, answered('owner-ask:meeting-abc', "good, i've got a transcript, attach it to this question."));
    const judge = judgeOf(effects);
    expect(judge).toMatchObject({ purpose: 'listen', questionSetId: 'listen-reply', delayMs: 0 });
    expect(judge?.state).toMatchObject({ assistant_asked: 'How did "Puzzlez - Planning" go?', owner_replied: "good, i've got a transcript, attach it to this question." });
    expect(judge?.state).not.toHaveProperty('open_goals');
    expect(judge?.metadata).toMatchObject({ askId: 'owner-ask:meeting-abc', meeting: { title: 'Puzzlez - Planning', start: '2026-09-21T11:00:00.000Z' }, goals: [] });
  });

  it('puts a goal answer to the judge with the open goals, one slot each', () => {
    const base = withOpenAsk('owner-ask:goals-2026-09-21', 'New week. Your open goals: sleep; demo. Which got real time?');
    const state: KernelState = { ...base, memory: { ...base.memory, factCursor: { 'goal:consistent-sleep:status': { object: 'active', factId: 'f1', pendingObject: null, pendingCount: 0 } as never, 'goal:demo-0hh1:status': { object: 'active', factId: 'f2', pendingObject: null, pendingCount: 0 } as never } } };
    const judge = judgeOf(listenToReply(state, answered('owner-ask:goals-2026-09-21', 'demo landed, pause sleep for now')).effects);
    expect((judge?.state as Record<string, unknown>).open_goals).toEqual({ g0: 'consistent sleep', g1: 'demo 0hh1' });
    expect(Object.keys(judge?.questions ?? {})).toContain('goal_g1');
    expect(judge?.metadata).toMatchObject({ goals: [{ entityId: 'goal:consistent-sleep', name: 'consistent sleep' }, { entityId: 'goal:demo-0hh1', name: 'demo 0hh1' }], meeting: null });
  });

  it('ignores a stale answer, an empty answer, and no open ask', () => {
    const state = withOpenAsk('owner-ask:meeting-abc', 'q');
    expect(listenToReply(state, answered('owner-ask:meeting-other', 'x')).effects).toEqual([]);
    expect(listenToReply(state, answered('owner-ask:meeting-abc', '  ')).effects).toEqual([]);
    expect(listenToReply(createInitialState('d1'), answered('owner-ask:meeting-abc', 'x')).effects).toEqual([]);
  });
});

describe('applyOwnerReply', () => {
  const state = createInitialState('d1');
  const meetingMeta = { askId: 'owner-ask:meeting-abc', question: 'How did "Puzzlez - Planning" go?', answer: "good, i've got a transcript, attach it to this question.", meeting: { title: 'Puzzlez - Planning', start: '2026-09-21T11:00:00.000Z', end: '2026-09-21T12:00:00.000Z', attendees: ['Anna'] }, goals: [] };

  it('"attach the transcript" on a meeting question attaches it — and only on a meeting question', () => {
    const { effects } = applyOwnerReply(state, judged({ wants_transcript_attached: { type: 'noul', noul: 0.64 }, worth_remembering: { type: 'score', score: 0.4, probabilities: { '0': 0.7, '1': 0.2, '2': 0.1 } } }, meetingMeta));
    expect(effects).toEqual([{ type: 'AttachTranscript', askId: 'owner-ask:meeting-abc', title: 'Puzzlez - Planning', start: '2026-09-21T11:00:00.000Z', end: '2026-09-21T12:00:00.000Z', attendees: ['Anna'], answer: meetingMeta.answer, ts: TS }]);
    const noMeeting = applyOwnerReply(state, judged({ wants_transcript_attached: { type: 'noul', noul: 0.9 } }, { ...meetingMeta, meeting: null }));
    expect(noMeeting.effects).toEqual([]);
    const below = applyOwnerReply(state, judged({ wants_transcript_attached: { type: 'noul', noul: 0.3 } }, meetingMeta));
    expect(below.effects).toEqual([]);
  });

  it('a goal the owner pauses or drops becomes a status assertion on THAT goal, at the choice threshold', () => {
    const meta = { askId: 'owner-ask:goals-2026-09-21', question: 'New week…', answer: 'demo landed, pause sleep, drop screen recording', meeting: null, goals: [{ entityId: 'goal:consistent-sleep', name: 'consistent sleep' }, { entityId: 'goal:demo-0hh1', name: 'demo 0hh1' }, { entityId: 'goal:screen-recording', name: 'screen recording' }] };
    const { effects } = applyOwnerReply(
      state,
      judged(
        {
          goal_g0: { type: 'choice', choice: 'pause', probabilities: { pause: 0.9, unmentioned: 0.1 } },
          goal_g1: { type: 'choice', choice: 'progress', probabilities: { progress: 0.99 } },
          goal_g2: { type: 'choice', choice: 'drop', probabilities: { drop: 0.6, unmentioned: 0.4 } }, // under the 0.7 default
        },
        meta,
      ),
    );
    const emitted = effects.filter((e) => e.type === 'EmitEvent') as Extract<Effect, { type: 'EmitEvent' }>[];
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toMatchObject({ type: 'entity:fact-candidate', payload: { entityKind: 'goal', canonicalName: 'consistent sleep', entityId: 'goal:consistent-sleep', predicate: 'status', object: 'paused', provenance: 'assertion', confidence: 100 } });
  });

  it('a reply worth keeping becomes a knowledge entry in the owner\'s words, embedded; a shrug does not', () => {
    const decision = { ...meetingMeta, askId: 'owner-ask:meeting-def', answer: 'we decided to change the error hinting strategy.', meeting: null };
    const { effects } = applyOwnerReply(state, judged({ worth_remembering: { type: 'score', score: 2.99, probabilities: { '2': 0.05, '3': 0.95 } } }, decision));
    const write = effects.find((e) => e.type === 'WriteDB') as Extract<Effect, { type: 'WriteDB'; table: 'knowledge_entries' }>;
    expect(write.row).toMatchObject({ kind: 'owner-reply', title: 'How did "Puzzlez - Planning" go?', body: 'we decided to change the error hinting strategy.', dedupeKey: 'reply:owner-ask:meeting-def', createdAt: TS });
    expect(effects.find((e) => e.type === 'Embed')).toMatchObject({ refType: 'knowledge_entry', refId: write.row.id });
    expect(applyOwnerReply(state, judged({ worth_remembering: { type: 'score', score: 0.1, probabilities: { '0': 0.9, '1': 0.1 } } }, decision)).effects).toEqual([]);
  });

  it('ignores another set and a payload without the exchange', () => {
    expect(applyOwnerReply(state, judged({}, { ...meetingMeta, answer: '' })).effects).toEqual([]);
    const other = judged({}, meetingMeta);
    (other.payload as { questionSetId: string }).questionSetId = 'judge-line';
    expect(applyOwnerReply(state, other).effects).toEqual([]);
  });
});
