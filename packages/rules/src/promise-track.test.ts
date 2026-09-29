import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { CommitmentRow, Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { meetingFollowup } from './meeting-followup.js';
import { MAX_PROMISES, adoptHeardThreads, meetingPromiseId, promiseTrack } from './promise-track.js';

const TZ = 'Europe/Amsterdam';
let seq = 0;
export const ev = (type: string, ts: string, payload: Record<string, unknown>): SanitizedEvent => ({ id: `e${++seq}`, type, ts, payload, sanitized: true });
const rowOf = (effects: Effect[]): CommitmentRow | undefined => (effects.find((e) => e.type === 'WriteDB' && e.table === 'commitments') as { row: CommitmentRow } | undefined)?.row;

export function base(): KernelState {
  const s = createInitialState('d1');
  s.config.timezone = TZ;
  s.config.ownerAliases = ['pat'];
  return s;
}

// A Tuesday 1:1 with Mira, 10:00–10:30 in Amsterdam.
export const MEETING = { meetingKey: 'Draft review|2026-09-29T08:00:00.000Z', title: 'Draft review', start: '2026-09-29T08:00:00.000Z', end: '2026-09-29T08:30:00.000Z', attendees: ['Mira Bakker'] };
export const heardDraft = (promises: unknown[] = [{ who: 'owner', kind: 'promise', to: null, what: 'the draft', due: null, quote: "I'll send you the draft" }]) => ev('meeting:promises', '2026-09-29T08:31:00.000Z', { ...MEETING, promises });

describe('promiseTrack opens promises with their terms (UC1 U1-F2 F14 F15 F18)', () => {
  it('a meeting promise is owed to the other person in a 1:1, due by default, keyed by the meeting', () => {
    const out = promiseTrack(base(), heardDraft());
    const opened = out.state.commitments.promises[0]!;
    expect(opened).toMatchObject({ id: meetingPromiseId(MEETING.start, MEETING.meetingKey, 0), source: 'meeting', name: 'the draft for Mira Bakker' });
    expect(opened.promise).toMatchObject({ direction: 'owner', counterparty: 'Mira Bakker', deliverable: 'the draft', keys: ['draft'], dueKind: 'default', due: '2026-10-02T15:00:00.000Z', heardAt: { title: 'Draft review', start: MEETING.start }, confirmed: false });
    expect(rowOf(out.effects)).toMatchObject({ source: 'meeting', promise: { counterparty: 'Mira Bakker' } });
    expect(out.state.commitments.open, 'branch threads untouched').toEqual([]);
    expect(promiseTrack(out.state, heardDraft()).effects, 'the same answer twice opens nothing').toEqual([]);
  });

  it('a said due date wins, the direction follows who spoke, and nothing in a group is owed to a guess', () => {
    const group = ev('meeting:promises', '2026-09-29T08:31:00.000Z', {
      ...MEETING,
      attendees: ['Mira Bakker', 'Bob Jansen'],
      promises: [
        { who: 'owner', kind: 'promise', to: null, what: 'the deck', due: 'dinsdag', quote: 'ik stuur het deck dinsdag' },
        { who: 'other', kind: 'promise', to: 'Bob Jansen', what: 'the numbers', due: 'tomorrow', quote: 'I will share the numbers tomorrow' },
        { who: 'other', kind: 'request', to: 'Mira Bakker', what: 'a review', due: null, quote: 'can you review my PR' },
      ],
    });
    const [deck, numbers, review] = promiseTrack(base(), group).state.commitments.promises;
    expect(deck!.promise).toMatchObject({ direction: 'owner', counterparty: null, dueKind: 'explicit', due: '2026-10-06T15:00:00.000Z' });
    expect(numbers!.promise).toMatchObject({ direction: 'awaiting', counterparty: 'Bob Jansen', due: '2026-09-30T15:00:00.000Z' });
    expect(numbers!.name).toBe('Bob Jansen owes you the numbers');
    expect(review!.promise).toMatchObject({ direction: 'request', counterparty: 'Mira Bakker' });
  });

  it('keeps promises apart from branch threads, with a cap of their own (U1-F22)', () => {
    let state = base();
    state.commitments.open = Array.from({ length: 20 }, (_, i) => ({ id: `commitment:b${i}`, name: `b${i}`, source: 'git-branch' as const, branch: `b${i}`, projectId: null, projectName: null, openedAt: MEETING.start, lastTouchedAt: MEETING.start, touches: 1, activeDays: ['2026-09-29'], lastTouchUnpushed: 0, merged: false }));
    state = promiseTrack(state, heardDraft()).state;
    expect(state.commitments.open).toHaveLength(20);
    expect(state.commitments.promises).toHaveLength(1);
    for (let i = 0; i < MAX_PROMISES + 3; i += 1) state = promiseTrack(state, ev('commitment:heard', `2026-09-29T09:${String(i).padStart(2, '0')}:00.000Z`, { source: 'chat', id: `commitment:promise:c${i}`, deliverable: `thing ${i}`, counterparty: 'Mira Bakker' })).state;
    expect(state.commitments.promises).toHaveLength(MAX_PROMISES);
  });

  it('replays a J4.4 promise heard in one moment, and closes promises by the owner or the judge', () => {
    let state = promiseTrack(base(), ev('commitment:heard', '2026-09-22T08:00:00.000Z', { momentId: 'm1', text: 'dan stuur ik het morgen door', p: 0.9, projectId: 'p1', projectName: 'puzzles' })).state;
    expect(state.commitments.promises[0]).toMatchObject({ id: 'commitment:speech:m1', source: 'speech', heardIn: { momentId: 'm1', p: 0.9 }, promise: { dueKind: 'explicit', due: '2026-09-23T15:00:00.000Z' } });
    const judged = promiseTrack(state, ev('commitment:resolved', '2026-09-23T08:00:00.000Z', { id: 'commitment:speech:m1', momentId: 'm2', p: 0.8 }));
    expect(judged.state.commitments.recentClosed[0]).toMatchObject({ closedBecause: 'kept', promise: { evidence: [{ kind: 'judge', strong: true }] } });
    state = promiseTrack(state, ev('commitment:closed', '2026-09-23T08:00:00.000Z', { id: 'commitment:speech:m1', by: 'owner' })).state;
    expect(state.commitments.promises).toEqual([]);
    expect(state.commitments.recentClosed[0]).toMatchObject({ closedBecause: 'owner' });
  });
});

describe('meetingFollowup asks for one promise pass per meeting (U1-F2)', () => {
  const tick = (ts: string) => ev('clock:tick', ts, {});
  const upcoming = (s: KernelState) => {
    s.schedule.upcoming = [{ title: MEETING.title, start: MEETING.start, end: MEETING.end, attendees: ['pat', 'Mira Bakker'], isAllDay: false }];
    return s;
  };
  it('once it ended, when something was heard in it, and once only', () => {
    let state = meetingFollowup(upcoming(base()), tick('2026-09-29T07:50:00.000Z')).state;
    state = meetingFollowup(state, ev('audio:transcript', '2026-09-29T08:10:00.000Z', { spokenText: "I'll send you the draft", channel: 'mic' })).state;
    expect(meetingFollowup(state, tick('2026-09-29T08:20:00.000Z')).effects.filter((e) => e.type === 'RunMeetingPromises'), 'not while it runs').toEqual([]);
    const ended = meetingFollowup(state, tick('2026-09-29T08:31:00.000Z'));
    expect(ended.effects.filter((e) => e.type === 'RunMeetingPromises')).toEqual([{ type: 'RunMeetingPromises', meetingKey: MEETING.meetingKey, title: MEETING.title, start: MEETING.start, end: MEETING.end, attendees: ['Mira Bakker'], ts: '2026-09-29T08:31:00.000Z' }]);
    expect(meetingFollowup(ended.state, tick('2026-09-29T08:32:00.000Z')).effects.filter((e) => e.type === 'RunMeetingPromises')).toEqual([]);
    const silent = meetingFollowup(meetingFollowup(upcoming(base()), tick('2026-09-29T07:50:00.000Z')).state, tick('2026-09-29T08:31:00.000Z'));
    expect(silent.effects.filter((e) => e.type === 'RunMeetingPromises'), 'nothing heard, nothing to read').toEqual([]);
  });

  it('reads overlapping entries (a meeting and its room booking) once, for the one with the most attendees', () => {
    const both = (s: KernelState) => {
      s.schedule.upcoming = [
        { title: 'Room 3', start: MEETING.start, end: MEETING.end, attendees: ['pat'], isAllDay: false },
        { title: MEETING.title, start: MEETING.start, end: MEETING.end, attendees: ['pat', 'Mira Bakker'], isAllDay: false },
      ];
      return s;
    };
    let state = meetingFollowup(both(base()), tick('2026-09-29T07:50:00.000Z')).state;
    state = meetingFollowup(state, ev('audio:transcript', '2026-09-29T08:10:00.000Z', { spokenText: "I'll send you the draft", channel: 'mic' })).state;
    const passes = meetingFollowup(state, tick('2026-09-29T08:31:00.000Z')).effects.filter((e) => e.type === 'RunMeetingPromises');
    expect(passes.map((e) => (e as { title: string }).title)).toEqual([MEETING.title]);
  });
});

describe('the deliverable is the proof (UC1-X2, U1-F20 F24 F26)', () => {
  const opened = () => promiseTrack(base(), heardDraft()).state;
  const after = '2026-09-29T13:00:00.000Z';
  const closedBy = (event: SanitizedEvent) => {
    const out = promiseTrack(opened(), event);
    return { open: out.state.commitments.promises, closed: out.state.commitments.recentClosed[0], row: rowOf(out.effects) };
  };

  it('a mail to the counterparty naming the deliverable keeps it, and says so on the row', () => {
    const { open, closed, row } = closedBy(ev('mail:sent', after, { timestamp: after, subject: 'Re: the draft, v2', recipients: [{ to: 'Mira Bakker' }] }));
    expect(open).toEqual([]);
    expect(closed).toMatchObject({ closedBecause: 'kept', promise: { evidence: [{ kind: 'mail', strong: true, text: 'mail to Mira Bakker: Re: the draft, v2' }], lastMailTo: { subject: 'Re: the draft, v2' } } });
    expect(row).toMatchObject({ closedBecause: 'kept' });
  });

  it('a mail to them about something else is cited and closes nothing', () => {
    const { open } = closedBy(ev('mail:sent', after, { timestamp: after, subject: 'Lunch on Friday', recipients: [{ to: 'mira bakker' }] }));
    expect(open[0]!.promise).toMatchObject({ evidence: [{ kind: 'mail-weak', strong: false }], lastMailTo: { at: after, subject: 'Lunch on Friday' } });
  });

  it.each([
    ['a commit', ev('git:commit', after, { commitLine: 'a1b2c3 docs: first draft of the proposal', branch: 'main' }), 'commit'],
    ['a PR', ev('git:pr-status', after, { number: 12, title: 'Draft for review', branch: 'x', state: 'OPEN' }), 'pr'],
    ['a file', ev('file:changed', after, { projectRoot: '/p', changes: [{ relPath: 'notes/todo.md' }, { relPath: 'docs/Draft-v2.md' }] }), 'file'],
    ['an Arc tab', ev('browser:arc-space', after, { title: 'Work', tabs: [{ url: 'https://docs.example.com/d', title: 'Draft — Docs' }] }), 'tab'],
    ['a tab', ev('browser:tab', after, { title: 'The draft - Docs', url: 'https://docs.example.com/d', host: 'docs.example.com' }), 'tab'],
    ['a Meet caption that it was shared', ev('page:text', after, { host: 'meet.google.com', text: 'Mira Bakker\nI just shared the draft in the chat.' }), 'caption'],
  ])('%s naming it keeps it', (_what, event, kind) => {
    expect(closedBy(event).closed).toMatchObject({ closedBecause: 'kept', promise: { evidence: [{ kind, strong: true }] } });
  });

  it('a caption that only mentions it, anything before it was made, and unrelated work keep nothing', () => {
    expect(closedBy(ev('page:text', after, { host: 'meet.google.com', text: 'The draft is not ready yet.' })).open).toHaveLength(1);
    expect(closedBy(ev('mail:sent', after, { timestamp: '2026-09-28T09:00:00.000Z', subject: 'The draft', recipients: [{ to: 'Mira Bakker' }] })).open[0]!.promise!.evidence, 'a back-filled mail from before').toEqual([]);
    expect(closedBy(ev('git:commit', after, { commitLine: 'fix: hint borders', branch: 'main' })).open).toHaveLength(1);
  });

  it('what someone owes the owner is kept by their mail about it (U1-F26)', () => {
    const state = promiseTrack(base(), heardDraft([{ who: 'other', kind: 'promise', to: 'Mira Bakker', what: 'the numbers', due: 'tomorrow', quote: 'I will share the numbers tomorrow' }])).state;
    const out = promiseTrack(state, ev('mail:received', after, { timestamp: after, from: 'Mira Bakker', subject: 'Numbers for Q3' }));
    expect(out.state.commitments.recentClosed[0]).toMatchObject({ closedBecause: 'kept', promise: { evidence: [{ kind: 'reply', strong: true }] } });
  });
});

describe('the promise clock speaks once per deadline, then asks (U1-F19 F21 F28 F30 F31 F32)', () => {
  const noticesOf = (effects: Effect[]) => effects.filter((e) => e.type === 'EmitEvent' && e.event.type === 'notice:candidate').map((e) => (e as { event: { payload: Record<string, unknown> } }).event.payload);
  const asksOf = (effects: Effect[]) => effects.filter((e) => e.type === 'EmitEvent' && e.event.type === 'ask:owner-opened').map((e) => (e as { event: { payload: Record<string, unknown> } }).event.payload);
  const withDue = (due: string | null) => promiseTrack(base(), heardDraft([{ who: 'owner', kind: 'promise', to: 'Mira Bakker', what: 'the draft', due, quote: `I'll send you the draft ${due ?? ''}` }])).state;
  const tick = (ts: string) => ev('clock:tick', ts, {});

  it('an hour before a said deadline it is worth an interruption, and says what is missing', () => {
    // "by Thursday", said Tuesday: due Thursday 17:00 Amsterdam = 15:00Z.
    const state = withDue('by Thursday');
    expect(noticesOf(promiseTrack(state, tick('2026-10-01T13:30:00.000Z')).effects), 'not yet').toEqual([]);
    const out = promiseTrack(state, tick('2026-10-01T14:05:00.000Z'));
    const [notice] = noticesOf(out.effects);
    expect(notice).toMatchObject({ kind: 'promise-fading', key: 'promise-fading:Mira Bakker', valueHalfLifeMs: 3_600_000, surprise: 1.5, precision: 0.8, observation: 'The draft is not sent — due to Mira Bakker at 17:00. No mail to Mira Bakker since Tuesday.' });
    expect(notice!.evidence).toEqual(expect.arrayContaining(['said in Draft review, Tuesday', 'WhatsApp, Slack and calls are not read', 'found by the meeting pass, not confirmed']));
    expect(noticesOf(promiseTrack(out.state, tick('2026-10-01T14:10:00.000Z')).effects), 'once per deadline').toEqual([]);
    expect(noticesOf(promiseTrack(out.state, tick('2026-10-01T16:00:00.000Z')).effects), 'not again when it passes').toEqual([]);
  });

  it('a default deadline is spoken after it passes, as a line for the next conversation, naming the last unrelated mail', () => {
    let state = withDue(null);
    state = promiseTrack(state, ev('mail:sent', '2026-09-30T09:00:00.000Z', { timestamp: '2026-09-30T09:00:00.000Z', subject: 'Lunch on Friday', recipients: [{ to: 'Mira Bakker' }] })).state;
    expect(noticesOf(promiseTrack(state, tick('2026-10-02T14:00:00.000Z')).effects)).toEqual([]);
    const [notice] = noticesOf(promiseTrack(state, tick('2026-10-02T15:10:00.000Z')).effects);
    expect(notice).toMatchObject({ valueHalfLifeMs: null, observation: 'The draft is not sent for Mira Bakker, promised Tuesday. Your last mail to Mira Bakker, Wednesday, was about "Lunch on Friday".' });
    expect(notice!.evidence).toContain('mail to Mira Bakker: Lunch on Friday');
  });

  it('two days past with nothing seen, it asks rather than calls it broken — and the answer closes it the right way', () => {
    let state = withDue('by Thursday');
    state = promiseTrack(state, tick('2026-10-01T15:10:00.000Z')).state; // spoken after the deadline
    const out = promiseTrack(state, tick('2026-10-03T15:10:00.000Z'));
    const [ask] = asksOf(out.effects);
    expect(ask).toMatchObject({ question: 'Did the draft reach Mira Bakker?', choices: ['Sent it', 'Moved — tell me when', 'Not kept', 'Dropped'], promiseAsk: { kind: 'kept' } });
    expect(asksOf(promiseTrack(out.state, tick('2026-10-03T15:20:00.000Z')).effects), 'asked once').toEqual([]);
    const opened = promiseTrack(out.state, ev('ask:owner-opened', '2026-10-03T15:10:00.000Z', ask!)).state;
    const answer = (text: string) => promiseTrack(opened, ev('ask:owner-answered', '2026-10-03T16:00:00.000Z', { askId: ask!.askId, answer: text })).state;
    expect(answer('Sent it').commitments.recentClosed[0]).toMatchObject({ closedBecause: 'kept', promise: { evidence: [{ kind: 'reply', text: 'you said: Sent it' }] } });
    expect(answer('Not kept').commitments.recentClosed[0]).toMatchObject({ closedBecause: 'broken' });
    expect(answer('Dropped').commitments.recentClosed[0]).toMatchObject({ closedBecause: 'dropped' });
    const moved = answer('next Tuesday');
    expect(moved.commitments.promises[0]!.promise).toMatchObject({ due: '2026-10-06T15:00:00.000Z', dueKind: 'explicit', moved: ['2026-10-01T15:00:00.000Z'], confirmed: true });
    expect(moved.commitments.promiseAsk).toBeNull();
  });

  it('closes, silently, a fortnight past its deadline; and the owner can close it with a reason or move it (U1-F29)', () => {
    const state = withDue('by Thursday');
    expect(promiseTrack(state, tick('2026-10-16T00:00:00.000Z')).state.commitments.recentClosed[0]).toMatchObject({ closedBecause: 'went-quiet' });
    const id = state.commitments.promises[0]!.id;
    expect(promiseTrack(state, ev('commitment:closed', '2026-10-01T09:00:00.000Z', { id, by: 'owner', reason: 'dropped' })).state.commitments.recentClosed[0]).toMatchObject({ closedBecause: 'dropped' });
    expect(promiseTrack(state, ev('commitment:closed', '2026-10-01T09:00:00.000Z', { id, by: 'owner', due: '2026-10-09T15:00:00.000Z' })).state.commitments.promises[0]!.promise).toMatchObject({ due: '2026-10-09T15:00:00.000Z', moved: ['2026-10-01T15:00:00.000Z'] });
  });

  it('says "the draft is not sent" the way the owner would', async () => {
    const { notDone } = await import('./promise-track.js');
    expect(notDone('the draft')).toBe('The draft is not sent');
    expect(notDone('review the PR')).toBe('The PR is not reviewed');
    expect(notDone('the numbers')).toBe('The numbers are not sent');
  });
});

describe('the next meeting is the deadline (UC1-X1)', () => {
  const cal = (ts: string, events: { title: string; startDate: string; attendees: string[]; isAllDay?: boolean }[]) => ev('calendar:upcoming', ts, { events });
  it('a promise with a person and no date is due at the next event they attend; a said date is never replaced', async () => {
    const { nextMeetingWith } = await import('./promise-track.js');
    expect(nextMeetingWith([{ title: 'All hands', start: '2026-09-30T08:00:00.000Z', attendees: ['Bob Jansen'] }, { title: 'Mira 1:1', start: '2026-10-01T12:00:00.000Z', attendees: ['pat', 'mira bakker'] }], 'Mira Bakker', '2026-09-29T09:00:00.000Z')).toEqual({ title: 'Mira 1:1', start: '2026-10-01T12:00:00.000Z' });
    let state = promiseTrack(base(), heardDraft()).state;
    state = promiseTrack(state, cal('2026-09-29T09:00:00.000Z', [{ title: 'Mira 1:1', startDate: '2026-10-01T12:00:00.000Z', attendees: ['pat', 'Mira Bakker'] }])).state;
    expect(state.commitments.promises[0]!.promise).toMatchObject({ due: '2026-10-01T12:00:00.000Z', dueKind: 'next-meeting', nextMeeting: { title: 'Mira 1:1' } });
    state = promiseTrack(state, cal('2026-09-30T09:00:00.000Z', [])).state;
    expect(state.commitments.promises[0]!.promise, 'the meeting was cancelled: back to the default').toMatchObject({ dueKind: 'default', due: '2026-10-02T15:00:00.000Z', nextMeeting: null });
    const met = promiseTrack(promiseTrack(state, cal('2026-09-30T10:00:00.000Z', [{ title: 'Mira 1:1', startDate: '2026-10-01T12:00:00.000Z', attendees: ['Mira Bakker'] }])).state, cal('2026-10-01T13:00:00.000Z', [{ title: 'Mira 1:1', startDate: '2026-10-08T12:00:00.000Z', attendees: ['Mira Bakker'] }])).state;
    expect(met.commitments.promises[0]!.promise, 'the meeting passed: it was due then, not at the next one').toMatchObject({ due: '2026-10-01T12:00:00.000Z', dueKind: 'next-meeting' });
    const said = promiseTrack(base(), heardDraft([{ who: 'owner', kind: 'promise', to: 'Mira Bakker', what: 'the draft', due: 'morgen', quote: 'ik stuur je morgen het concept' }])).state;
    const after = promiseTrack(said, cal('2026-09-29T09:00:00.000Z', [{ title: 'Mira 1:1', startDate: '2026-10-01T12:00:00.000Z', attendees: ['Mira Bakker'] }])).state;
    expect(after.commitments.promises[0]!.promise).toMatchObject({ dueKind: 'explicit', due: '2026-09-30T15:00:00.000Z' });
  });
  it('an event with a date that does not parse is skipped, never a throw', () => {
    const state = promiseTrack(base(), heardDraft()).state;
    const out = promiseTrack(state, cal('2026-09-29T09:00:00.000Z', [{ title: 'Broken', startDate: 'not a date', attendees: ['Mira Bakker'] }, { title: 'Mira 1:1', startDate: '2026-10-01T12:00:00.000Z', attendees: ['Mira Bakker'] }]));
    expect(out.state.commitments.promises[0]!.promise).toMatchObject({ due: '2026-10-01T12:00:00.000Z', nextMeeting: { title: 'Mira 1:1' } });
  });
});

describe('ask once at the end of a meeting (UC1-X3)', () => {
  const tick = (ts: string) => ev('clock:tick', ts, {});
  const asksOf = (effects: Effect[]) => effects.filter((e) => e.type === 'EmitEvent' && e.event.type === 'ask:owner-opened').map((e) => (e as { event: { payload: Record<string, unknown> } }).event.payload);
  /** Both rules, in manifest order, the way `ask:owner-opened` reaches them: promiseTrack before ownerAsk opens it. */
  const both = (state: KernelState, event: SanitizedEvent) => {
    const a = meetingFollowup(state, event);
    const b = promiseTrack(a.state, event);
    return { state: b.state, effects: [...a.effects, ...b.effects] };
  };
  function meetingDone(withPass: boolean, promises: unknown[] = []) {
    let state = base();
    state.schedule.upcoming = [{ title: MEETING.title, start: MEETING.start, end: MEETING.end, attendees: ['pat', 'Mira Bakker'], isAllDay: false }];
    state = both(state, tick('2026-09-29T07:50:00.000Z')).state;
    state = both(state, ev('audio:transcript', '2026-09-29T08:10:00.000Z', { spokenText: 'we talked', channel: 'mic' })).state;
    state = both(state, tick('2026-09-29T08:31:00.000Z')).state; // the pass is asked for
    if (withPass) state = both(state, heardDraft(promises)).state;
    return state;
  }

  it('waits for the promise pass, then shows what it found for confirmation instead of asking', () => {
    const waiting = meetingDone(false);
    expect(asksOf(both(waiting, tick('2026-09-29T08:34:00.000Z')).effects), 'the pass is still out').toEqual([]);
    expect(asksOf(both(waiting, tick('2026-09-29T08:40:00.000Z')).effects)[0], 'eight minutes on, it asks without it').toMatchObject({ question: 'How did "Draft review" go — did you promise anything?' });

    const found = meetingDone(true, [{ who: 'owner', kind: 'promise', to: 'Mira Bakker', what: 'the draft', due: 'by Thursday', quote: "I'll send you the draft by Thursday" }]);
    const [ask] = asksOf(both(found, tick('2026-09-29T08:34:00.000Z')).effects);
    expect(ask).toMatchObject({ question: 'How did "Draft review" go? I heard you promise: the draft for Mira Bakker, by Thursday. Keep track of it?', choices: ['Track it', 'Not a promise'], promiseAsk: { kind: 'meeting', ids: [found.commitments.promises[0]!.id] } });
    const opened = both(found, ev('ask:owner-opened', '2026-09-29T08:34:00.000Z', ask!)).state;
    const answer = (text: string) => both(opened, ev('ask:owner-answered', '2026-09-29T08:36:00.000Z', { askId: ask!.askId, answer: text })).state.commitments;
    expect(answer('Track it').promises[0]!.promise!.confirmed).toBe(true);
    expect(answer('Not a promise').recentClosed[0]).toMatchObject({ closedBecause: 'dropped' });
  });

  it('a "yes" in the owner\'s words opens the promise they describe, owed to the meeting\'s person', () => {
    const state = meetingDone(true, []);
    const [ask] = asksOf(both(state, tick('2026-09-29T08:34:00.000Z')).effects);
    expect(ask).toMatchObject({ question: 'How did "Draft review" go — did you promise anything?', choices: ['No', 'Yes — tell me'] });
    const opened = both(state, ev('ask:owner-opened', '2026-09-29T08:34:00.000Z', ask!)).state;
    const told = both(opened, ev('ask:owner-answered', '2026-09-29T08:40:00.000Z', { askId: ask!.askId, answer: "I told Mira I'd send the deck tomorrow" })).state;
    expect(told.commitments.promises[0]).toMatchObject({ source: 'owner', promise: { counterparty: 'Mira Bakker', deliverable: 'send the deck', dueKind: 'explicit', due: '2026-09-30T15:00:00.000Z', confirmed: true, heardAt: { title: 'Draft review' } } });
    expect(both(opened, ev('ask:owner-answered', '2026-09-29T08:40:00.000Z', { askId: ask!.askId, answer: 'No' })).state.commitments.promises).toEqual([]);
  });
});

describe('a promise mirrored in Apple Reminders (U1-F38)', () => {
  const snap = (ts: string, items: Record<string, unknown>[]) => ev('reminders:snapshot', ts, { items });
  it('takes the reminder Gnomon made, and its due date; completed, it is kept', () => {
    let state = promiseTrack(base(), heardDraft()).state;
    const id = state.commitments.promises[0]!.id;
    state = promiseTrack(state, ev('action:performed', '2026-09-29T09:00:00.000Z', { tool: 'reminder_create', reminderId: 'R1', promiseId: id, due: '2026-10-01T08:00:00.000Z' })).state;
    expect(state.commitments.promises[0]!.promise).toMatchObject({ reminderId: 'R1', due: '2026-10-01T08:00:00.000Z', dueKind: 'explicit', confirmed: true });
    state = promiseTrack(state, snap('2026-09-30T09:00:00.000Z', [{ id: 'R1', text: 'Send Mira the draft', due: '2026-10-02T08:00:00.000Z', completed: false }])).state;
    expect(state.commitments.promises[0]!.promise, 'moved in Reminders, moved here').toMatchObject({ due: '2026-10-02T08:00:00.000Z', moved: ['2026-10-01T08:00:00.000Z'] });
    const done = promiseTrack(state, snap('2026-10-01T09:00:00.000Z', [{ id: 'R1', text: 'Send Mira the draft', completed: true, completedAt: '2026-10-01T08:55:00.000Z' }]));
    expect(done.state.commitments.recentClosed[0]).toMatchObject({ closedBecause: 'kept', promise: { evidence: [{ kind: 'reminder', at: '2026-10-01T08:55:00.000Z' }] } });
  });

  it('adopts a reminder the owner made by hand when it names the thing and the person', () => {
    const state = promiseTrack(base(), heardDraft()).state;
    expect(promiseTrack(state, snap('2026-09-29T10:00:00.000Z', [{ id: 'R9', text: 'Buy milk', completed: false }])).state.commitments.promises[0]!.promise!.reminderId).toBeUndefined();
    expect(promiseTrack(state, snap('2026-09-29T10:00:00.000Z', [{ id: 'R7', text: 'draft for mira', due: null, completed: false }])).state.commitments.promises[0]!.promise!.reminderId).toBe('R7');
  });
});

describe('the same promise said again is one promise (U1-F27)', () => {
  it('a new date moves it and keeps the old one; the owner saying it confirms it; a different thing opens its own', () => {
    let state = promiseTrack(base(), heardDraft([{ who: 'owner', kind: 'promise', to: 'Mira Bakker', what: 'the draft', due: 'by Thursday', quote: "I'll send you the draft by Thursday" }])).state;
    state = promiseTrack(state, ev('commitment:heard', '2026-09-30T08:00:00.000Z', { source: 'chat', deliverable: 'the draft', counterparty: 'Mira Bakker', dueText: 'Friday', quote: "I'll send Mira the draft Friday instead" })).state;
    expect(state.commitments.promises).toHaveLength(1);
    expect(state.commitments.promises[0]!.promise).toMatchObject({ due: '2026-10-02T15:00:00.000Z', moved: ['2026-10-01T15:00:00.000Z'], confirmed: true });
    state = promiseTrack(state, ev('commitment:heard', '2026-09-30T09:00:00.000Z', { source: 'chat', deliverable: 'the slides', counterparty: 'Mira Bakker', quote: 'and the slides' })).state;
    expect(state.commitments.promises).toHaveLength(2);
  });
});

describe('promises and requests in a subject line (U1-F5 F6 F7)', () => {
  const at = '2026-09-29T13:00:00.000Z';
  it('a sent "Draft coming Tuesday" is a promise to the recipient, due Tuesday; a sent question waits on them', () => {
    const sent = promiseTrack(base(), ev('mail:sent', at, { timestamp: at, subject: 'Draft coming Tuesday', recipients: [{ to: 'Mira Bakker' }] })).state.commitments.promises[0]!;
    expect(sent).toMatchObject({ source: 'mail', promise: { direction: 'owner', counterparty: 'Mira Bakker', deliverable: 'Draft', dueKind: 'explicit', due: '2026-10-06T15:00:00.000Z' } });
    const asked = promiseTrack(base(), ev('mail:sent', at, { timestamp: at, subject: 'Can you send the Q3 numbers?', recipients: [{ to: 'Bob Jansen' }] })).state.commitments.promises[0]!;
    expect(asked.promise).toMatchObject({ direction: 'awaiting', counterparty: 'Bob Jansen', deliverable: 'send the Q3 numbers' });
    expect(promiseTrack(base(), ev('mail:sent', at, { timestamp: at, subject: 'Re: Draft coming Tuesday', recipients: [{ to: 'Mira Bakker' }] })).state.commitments.promises, 'a reply is the thread').toEqual([]);
    expect(promiseTrack(base(), ev('mail:sent', at, { timestamp: at, subject: 'Lunch?', recipients: [{ to: 'Mira Bakker' }] })).state.commitments.promises).toEqual([]);
  });

  it('a request received is one only from someone the owner meets', () => {
    const met = base();
    met.meetings.seen = { k: { title: 'Sync', start: at, end: at, attendees: ['Mira Bakker'], askedAt: null } };
    const request = ev('mail:received', at, { timestamp: at, from: 'Mira Bakker', subject: 'Can you review the proposal?' });
    expect(promiseTrack(met, request).state.commitments.promises[0]!.promise).toMatchObject({ direction: 'request', counterparty: 'Mira Bakker', deliverable: 'review the proposal' });
    expect(promiseTrack(base(), request).state.commitments.promises, 'a stranger, or a tool').toEqual([]);
  });
});

describe('the brief before a meeting leads with what is owed (U1-F33)', () => {
  it('lists the open promises with the people in the room, never anyone else\'s', async () => {
    const { pickJob } = await import('./workbench.js');
    let state = promiseTrack(base(), heardDraft()).state;
    state = promiseTrack(state, ev('commitment:heard', '2026-09-29T09:00:00.000Z', { source: 'chat', direction: 'awaiting', deliverable: 'the numbers', counterparty: 'Mira Bakker' })).state;
    state = promiseTrack(state, ev('commitment:heard', '2026-09-29T09:00:00.000Z', { source: 'chat', deliverable: 'the slides', counterparty: 'Bob Jansen' })).state;
    state.schedule.upcoming = [{ title: 'Mira 1:1', start: '2026-10-01T12:00:00.000Z', end: '2026-10-01T12:30:00.000Z', attendees: ['pat', 'Mira Bakker'], isAllDay: false }];
    const job = pickJob(state, '2026-10-01T11:40:00.000Z');
    expect(job?.detail).toMatchObject({ promises: ['the draft for Mira Bakker', 'Mira Bakker owes you the numbers'] });
  });
});

describe('a promise heard before promiseTrack becomes a promise at boot (Q2)', () => {
  const heardThread = (id: string, name: string, at: string) => ({
    id: `commitment:speech:${id}`, name, source: 'speech' as const, branch: '', projectId: '~/Projects/puzzlebox-studio', projectName: 'puzzlebox-studio',
    openedAt: at, lastTouchedAt: at, touches: 1, activeDays: ['2026-09-28'], lastTouchUnpushed: 0, merged: false, pr: null, heardIn: { momentId: id, p: 0.85 },
  });
  const branchThread = { ...heardThread('b1', 'feature/x', '2026-09-28T08:00:00.000Z'), id: 'commitment:git:x', source: 'git-branch' as const, branch: 'feature/x' };

  it('moves each branch-less speech thread into promises with terms as of when it was said; branch threads stay; a second run moves nothing', () => {
    const s = base();
    s.commitments = { ...s.commitments, open: [branchThread, heardThread('m1', "I'll send the deck to the studio", '2026-09-28T08:04:00.000Z'), heardThread('m2', 'ik kijk morgen naar de offerte', '2026-09-28T08:10:00.000Z')] };
    const out = adoptHeardThreads(s);
    expect(out.moved).toBe(2);
    expect(out.state.commitments.open.map((c) => c.id)).toEqual(['commitment:git:x']);
    expect(out.state.commitments.promises.map((c) => c.id)).toEqual(['commitment:speech:m1', 'commitment:speech:m2']);
    const [deck, offer] = out.state.commitments.promises;
    expect(deck).toMatchObject({ source: 'speech', openedAt: '2026-09-28T08:04:00.000Z', projectName: 'puzzlebox-studio', heardIn: { momentId: 'm1', p: 0.85 } });
    expect(deck!.promise).toMatchObject({ direction: 'owner', counterparty: null, deliverable: "I'll send the deck to the studio", dueKind: 'default', due: '2026-10-01T15:00:00.000Z', confirmed: false });
    // "morgen", said on the 28th, is the 29th.
    expect(offer!.promise).toMatchObject({ dueKind: 'explicit' });
    expect(offer!.promise!.due!.slice(0, 10)).toBe('2026-09-29');
    expect(out.effects.filter((e) => e.type === 'WriteDB').map((e) => (e as { row: CommitmentRow }).row.id)).toEqual(['commitment:speech:m1', 'commitment:speech:m2']);
    expect(out.effects.every((e) => e.type === 'WriteDB' && (e as { row: CommitmentRow }).row.promise !== null && (e as { row: CommitmentRow }).row.closedAt === null)).toBe(true);
    // Adopted, so the "did you get to it?" question counts as asked, in the fold and in the table.
    expect(deck!.promise!.askedAt).toBe('2026-09-28T08:04:00.000Z');
    expect(out.effects.every((e) => e.type !== 'WriteDB' || Boolean((e as { row: CommitmentRow }).row.promise?.askedAt))).toBe(true);
    const again = adoptHeardThreads(out.state);
    expect([again.moved, again.effects, again.state]).toEqual([0, [], out.state]);
  });

  it('the same words heard twice are one promise; the copy closes in the table', () => {
    const s = base();
    s.commitments = { ...s.commitments, open: [heardThread('m1', "I'll send the deck", '2026-09-28T08:04:00.000Z'), heardThread('m2', "I'll send the deck", '2026-09-28T08:06:00.000Z')] };
    const out = adoptHeardThreads(s);
    expect(out.state.commitments.promises.map((c) => c.id)).toEqual(['commitment:speech:m1']);
    expect(out.state.commitments.open).toEqual([]);
    expect(rowsOf(out.effects).find((r) => r.id === 'commitment:speech:m2')).toMatchObject({ closedBecause: 'dropped' });
  });
});

const rowsOf = (effects: Effect[]): CommitmentRow[] => effects.filter((e) => e.type === 'WriteDB' && e.table === 'commitments').map((e) => (e as { row: CommitmentRow }).row);
