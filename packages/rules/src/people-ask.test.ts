import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { WHO_ASK_PREFIX, namedAttendees, peopleAsk } from './people-ask.js';

const END = '2026-09-07T09:30:00.000Z';
const tick = (ts: string): SanitizedEvent => ({ id: `t-${ts}`, type: 'clock:tick', ts, payload: {}, sanitized: true });
const emitted = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { type: 'EmitEvent' }> => e.type === 'EmitEvent').map((e) => e.event);

function withMeeting(attendees: string[]): KernelState {
  const base = createInitialState('d1');
  return { ...base, meetings: { seen: { 'RRA|x': { title: 'RRA: Kruiswoorden testen', start: '2026-09-07T09:00:00.000Z', end: END, attendees, askedAt: END } } } };
}

describe('peopleAsk', () => {
  it('asks who a hashed attendee is, half an hour after the meeting, once', () => {
    const state = withMeeting(['person-c205ca11f2', 'Alex']);
    // Too soon: the meeting question goes first.
    expect(peopleAsk(state, tick('2026-09-07T09:40:00.000Z')).effects).toEqual([]);
    const { state: next, effects } = peopleAsk(state, tick('2026-09-07T10:05:00.000Z'));
    const [ask] = emitted(effects);
    expect(ask?.type).toBe('ask:owner-opened');
    expect(ask?.payload.askId).toBe(`${WHO_ASK_PREFIX}person-c205ca11f2`);
    // Phrased by the MEETING, never by the hash — the owner cannot decode a
    // hash, and the shipped wording asked them to do it using two more hashes.
    expect(String(ask?.payload.question)).toBe('Monday 09:00 · "RRA: Kruiswoorden testen", with Alex. Who was the other person there?');
    expect(String(ask?.payload.question)).not.toContain('person-');
    // Marked asked: the next tick does not ask again.
    expect(peopleAsk(next, tick('2026-09-07T10:06:00.000Z')).effects).toEqual([]);
  });

  // The 2026-09-09 defect: seven of these went out in one day, three of them at
  // 06:36, 06:37 and 06:38, because `asked` mutes one hash and a meeting holds
  // several. These four tests are the cap, the refusal, and the ambiguity guard.
  it('asks at most once a day, whatever alias the next one would be about', () => {
    const state = withMeeting(['person-c205ca11f2', 'person-d1feb17d9f', 'Alex']);
    // Two unnamed in one meeting is not asked about at all (see below), so use
    // two meetings, each with exactly one unnamed attendee.
    const twoMeetings: KernelState = {
      ...state,
      meetings: {
        seen: {
          a: { title: 'One', start: '2026-09-07T09:00:00.000Z', end: END, attendees: ['person-c205ca11f2', 'Alex'], askedAt: END },
          b: { title: 'Two', start: '2026-09-07T09:00:00.000Z', end: END, attendees: ['person-d1feb17d9f', 'Alex'], askedAt: END },
        },
      },
    };
    const { state: next, effects } = peopleAsk(twoMeetings, tick('2026-09-07T10:05:00.000Z'));
    expect(emitted(effects)).toHaveLength(1);
    // An hour later, the second meeting's alias is still due — and still not asked.
    expect(peopleAsk(next, tick('2026-09-07T11:05:00.000Z')).effects).toEqual([]);
    // A day later it may ask again.
    expect(emitted(peopleAsk(next, tick('2026-09-08T11:05:00.000Z')).effects)).toHaveLength(1);
  });

  it('a non-name answer silences the whole class for a week, not just that alias', () => {
    const state = withMeeting(['person-c205ca11f2', 'Alex']);
    const refused = peopleAsk(state, {
      id: 'a1',
      type: 'ask:owner-answered',
      ts: '2026-09-07T10:10:00.000Z',
      payload: { askId: `${WHO_ASK_PREFIX}person-c205ca11f2`, answer: 'I dont know, we need to handle this in code' },
      sanitized: true,
    }).state;
    expect(refused.people.mutedUntil).toBeDefined();
    // A DIFFERENT alias, in a different meeting, two minutes later — the exact
    // shape of the 06:36/06:37/06:38 run. Silent now.
    const other: KernelState = { ...refused, meetings: { seen: { b: { title: 'Two', start: '2026-09-07T09:00:00.000Z', end: END, attendees: ['person-d1feb17d9f', 'Alex'], askedAt: END } } } };
    expect(peopleAsk(other, tick('2026-09-07T10:12:00.000Z')).effects).toEqual([]);
    // Still silent six days on. (Past that, MEETING_HORIZON_MS has retired this
    // meeting anyway, so the mute's far edge is asserted on the value itself.)
    expect(peopleAsk(other, tick('2026-09-13T10:12:00.000Z')).effects).toEqual([]);
    expect(refused.people.mutedUntil).toBe('2026-09-14T10:10:00.000Z');
  });

  it('never asks about a meeting with two unnamed attendees — the answer would be filed against the wrong one', () => {
    const state = withMeeting(['person-c205ca11f2', 'person-d1feb17d9f', 'Alex']);
    expect(peopleAsk(state, tick('2026-09-07T10:05:00.000Z')).effects).toEqual([]);
  });

  it('asks once the graph names all but one of them', () => {
    const base = withMeeting(['person-c205ca11f2', 'person-d1feb17d9f', 'Alex']);
    const partly: KernelState = { ...base, memory: { ...base.memory, aliasNames: { 'person-d1feb17d9f': 'Jordan' } } };
    const [ask] = emitted(peopleAsk(partly, tick('2026-09-07T10:05:00.000Z')).effects);
    expect(ask?.payload.askId).toBe(`${WHO_ASK_PREFIX}person-c205ca11f2`);
  });

  it('never asks about an alias the graph already names', () => {
    const base = withMeeting(['person-c205ca11f2']);
    const named: KernelState = { ...base, memory: { ...base.memory, aliasNames: { 'person-c205ca11f2': 'Alex Morgan' } } };
    expect(peopleAsk(named, tick('2026-09-07T10:05:00.000Z')).effects).toEqual([]);
  });

  it('does not ask while another question is open, and never about a named attendee', () => {
    const state = withMeeting(['Alex', 'Jordan']);
    expect(peopleAsk(state, tick('2026-09-07T10:05:00.000Z')).effects).toEqual([]);
    const busy = { ...withMeeting(['person-c205ca11f2']), ownerAsk: { open: { askId: 'owner-ask:1', question: 'q', reason: '', choices: [], ts: END }, askedCount: 1, answeredCount: 0, recent: [], lastBackfillAt: null, backfillDone: false, classGain: {} } };
    expect(peopleAsk(busy, tick('2026-09-07T10:05:00.000Z')).effects).toEqual([]);
  });

  it('keeps the name the owner gives, and records it as the owner\'s word in core memory', () => {
    const state = withMeeting(['person-c205ca11f2']);
    const { state: next, effects } = peopleAsk(state, { id: 'a1', type: 'ask:owner-answered', ts: '2026-09-07T10:10:00.000Z', payload: { askId: `${WHO_ASK_PREFIX}person-c205ca11f2`, answer: "That's Noah" }, sanitized: true });
    // The name goes to the GRAPH as a candidate; `contradictionCheck` confirms it
    // and mirrors it into `memory.aliasNames`, which is the one place a rule reads.
    const [fact] = emitted(effects);
    expect(fact?.type).toBe('entity:fact-candidate');
    expect(fact?.payload).toMatchObject({ entityKind: 'person', canonicalName: 'person-c205ca11f2', predicate: 'knownAs', object: 'Noah', provenance: 'assertion' });
    expect(next.people.asked['person-c205ca11f2']).toBeDefined();
    expect(namedAttendees(['person-c205ca11f2', 'Alex'], { 'person-c205ca11f2': 'Noah' })).toEqual(['Noah', 'Alex']);
  });

  it('does not file a question back as a name', () => {
    const state = withMeeting(['person-c205ca11f2']);
    const { state: next, effects } = peopleAsk(state, { id: 'a1', type: 'ask:owner-answered', ts: '2026-09-07T10:10:00.000Z', payload: { askId: `${WHO_ASK_PREFIX}person-c205ca11f2`, answer: 'in which meeting where they?' }, sanitized: true });
    expect(effects).toEqual([]);
    expect(next.people.asked['person-c205ca11f2']).toBeDefined();
  });

  it('takes "no idea" as asked, not as a name', () => {
    const state = withMeeting(['person-c205ca11f2']);
    const { state: next, effects } = peopleAsk(state, { id: 'a1', type: 'ask:owner-answered', ts: '2026-09-07T10:10:00.000Z', payload: { askId: `${WHO_ASK_PREFIX}person-c205ca11f2`, answer: 'no idea' }, sanitized: true });
    expect(effects).toEqual([]);
    expect(next.people.asked['person-c205ca11f2']).toBeDefined();
  });

  it('ignores answers to other questions', () => {
    const state = withMeeting(['person-c205ca11f2']);
    expect(peopleAsk(state, { id: 'a1', type: 'ask:owner-answered', ts: END, payload: { askId: 'owner-ask:meeting-1', answer: 'fine' }, sanitized: true })).toEqual({ state, effects: [] });
  });
});
