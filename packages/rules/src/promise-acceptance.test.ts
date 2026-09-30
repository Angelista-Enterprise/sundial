/**
 * UC1 acceptance: the headline, end to end, through the whole manifest and the
 * real gate. A Tuesday 1:1 with Mira Bakker, "I'll send you the draft", no
 * date said; the calendar shows the next 1:1 with her on Thursday at 14:00.
 *
 * - Case A, no mail: about an hour before Thursday's meeting Gnomon says
 *   "You see Mira Bakker at 14:00. The draft is not sent.", and the gate lets
 *   it through. Since lane B it is said as that meeting's prep: one notice.
 * - Case B, a mail to Mira about the draft on Tuesday afternoon: the promise
 *   closes as kept, and nothing is said on Thursday.
 *
 * The twins differ by one event, so the control fails exactly where it should.
 */
import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { reduce } from '@sundial/kernel/reduce.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { RULE_MANIFEST } from './index.js';

let seq = 0;
const ev = (type: string, ts: string, payload: Record<string, unknown>): SanitizedEvent => ({ id: `acc-${String(++seq).padStart(6, '0')}`, type, ts, payload: { timestamp: ts, ...payload }, sanitized: true });

/** The executor's order: fold an event, then each event it emits, depth first. The meeting pass is played by `meetingPass`. */
function play(start: KernelState, events: SanitizedEvent[], meetingPass: (effect: Extract<Effect, { type: 'RunMeetingPromises' }>) => SanitizedEvent | null) {
  let state = start;
  const decisions: { kind: string; channel: string; key: string }[] = [];
  const candidates: Record<string, unknown>[] = [];
  const apply = (event: SanitizedEvent): void => {
    const out = reduce(state, event, RULE_MANIFEST);
    state = out.state;
    for (const { effect } of out.effects) {
      if (effect.type === 'EmitEvent') {
        if (effect.event.type === 'notice:candidate') candidates.push(effect.event.payload as Record<string, unknown>);
        apply({ ...effect.event, sanitized: true } as SanitizedEvent);
      } else if (effect.type === 'RecordGateDecision') decisions.push({ kind: effect.kind, channel: effect.channel, key: effect.noticeKey });
      else if (effect.type === 'RunMeetingPromises') {
        const answer = meetingPass(effect);
        if (answer) apply(answer);
      }
    }
  };
  for (const event of events) apply(event);
  return { state, decisions, candidates };
}

const TUE_1to1 = { eventId: 'e1', title: 'Draft review', startDate: '2026-09-29T08:00:00.000Z', endDate: '2026-09-29T08:30:00.000Z', attendees: ['pat', 'Mira Bakker'], isAllDay: false, isRecurring: false, calendar: 'Work' };
const THU_1to1 = { eventId: 'e2', title: 'Mira 1:1', startDate: '2026-10-01T12:00:00.000Z', endDate: '2026-10-01T12:30:00.000Z', attendees: ['pat', 'Mira Bakker'], isAllDay: false, isRecurring: true, calendar: 'Work' };

function scenario(withMail: boolean) {
  // W5 step 10: the prep has earned interrupting alone (30 of 30 judged worth hearing), and the owner said yes.
  const state = createInitialState('acc');
  state.calibrated.params['notice.precision:meeting-prep'] = { n: 30, hits: 30, sum: 30, updatedAt: null };
  state.autonomy.granted['notice:meeting-prep'] = '2026-09-01T00:00:00.000Z';
  state.config.timezone = 'Europe/Amsterdam';
  state.config.ownerAliases = ['pat'];
  const tick = (ts: string) => ev('clock:tick', ts, {});
  const events: SanitizedEvent[] = [
    ev('calendar:upcoming', '2026-09-29T07:50:00.000Z', { events: [TUE_1to1, THU_1to1] }),
    tick('2026-09-29T07:55:00.000Z'),
    ev('audio:transcript', '2026-09-29T08:10:00.000Z', { spokenText: "Okay, I'll send you the draft.", channel: 'mic' }),
    tick('2026-09-29T08:31:00.000Z'),
    ...(withMail ? [ev('mail:sent', '2026-09-29T13:00:00.000Z', { subject: 'The draft', recipients: [{ to: 'Mira Bakker' }] })] : []),
    ev('calendar:upcoming', '2026-09-30T07:00:00.000Z', { events: [THU_1to1] }),
    tick('2026-10-01T10:30:00.000Z'),
    tick('2026-10-01T11:05:00.000Z'),
    tick('2026-10-01T11:10:00.000Z'),
  ];
  return play(state, events, (effect) =>
    ev('meeting:promises', '2026-09-29T08:31:30.000Z', {
      meetingKey: effect.meetingKey,
      title: effect.title,
      start: effect.start,
      end: effect.end,
      attendees: effect.attendees,
      promises: [{ who: 'owner', kind: 'promise', to: 'Mira Bakker', what: 'the draft', due: null, quote: "I'll send you the draft" }],
    }),
  );
}

describe('UC1 acceptance: kept by the mail, or fading an hour before the next meeting with her', () => {
  it('case A — no mail: "You see Mira Bakker at 14:00. The draft is not sent.", let through by the gate, once', () => {
    const { state, decisions, candidates } = scenario(false);
    // Lane B: the meeting's prep says it — one notice for the meeting, in UC1's own words, an hour out.
    expect(candidates.filter((c) => c.kind === 'promise-fading')).toEqual([]);
    const prep = candidates.filter((c) => c.kind === 'meeting-prep');
    expect(prep).toHaveLength(1);
    expect(prep[0]!.observation).toBe('You see Mira Bakker at 14:00. The draft is not sent. No mail to Mira Bakker since Tuesday.');
    const decided = decisions.filter((d) => d.kind === 'meeting-prep');
    expect(decided).toHaveLength(1);
    expect(decided[0]!.channel, 'an hour before the meeting, it interrupts').toBe('phasic');
    expect(state.commitments.promises[0]!.promise).toMatchObject({ dueKind: 'next-meeting', due: THU_1to1.startDate, nextMeeting: { title: 'Mira 1:1' } });
  });

  it('case B — a mail to Mira about the draft: kept, and nothing said', () => {
    const { state, candidates } = scenario(true);
    expect(candidates.filter((c) => c.kind === 'promise-fading')).toEqual([]);
    expect(state.commitments.promises).toEqual([]);
    expect(state.commitments.recentClosed.find((c) => c.source === 'meeting')).toMatchObject({ closedBecause: 'kept', promise: { evidence: [{ kind: 'mail', strong: true }] } });
  });
});

/**
 * W6 P2: hearing → promises, end to end. On the live record 13,941 utterances made no promise: with
 * hearing awake, the absence test (the owner's microphone only, since S11) read a call the owner
 * mostly listened to as a room they were not in, and that test gated the promise pass too.
 */
describe('W6 P2: a meeting with speech produces its promise pass, and an answered question its transcript', () => {
  const LISTENED = { ...TUE_1to1, attendees: ['pat', 'Mira Bakker', 'Noah'] };
  function heard(mic: number) {
    const state = createInitialState('p2');
    state.config.ownerAliases = ['pat'];
    state.config.autoHearMeetings = true;
    const events: SanitizedEvent[] = [
      ev('calendar:upcoming', '2026-09-29T07:50:00.000Z', { events: [LISTENED] }),
      ev('calendar:active', '2026-09-29T08:01:00.000Z', { event: LISTENED }),
      ev('clock:tick', '2026-09-29T08:02:00.000Z', {}),
      ...Array.from({ length: 40 }, (_, i) => ev('audio:transcript', `2026-09-29T08:${String(3 + (i % 25)).padStart(2, '0')}:10.000Z`, { spokenText: 'Mira Bakker: the BOX-484 build is green, I will send the notes', channel: 'system' })),
      ...Array.from({ length: mic }, (_, i) => ev('audio:transcript', `2026-09-29T08:${String(3 + (i % 25)).padStart(2, '0')}:40.000Z`, { spokenText: "Okay, I'll send you the draft.", channel: 'mic' })),
      ev('clock:tick', '2026-09-29T08:31:00.000Z', {}),
      ev('clock:tick', '2026-09-29T08:33:00.000Z', {}),
    ];
    const passes: string[] = [];
    const out = play(state, events, (effect) => {
      passes.push(effect.meetingKey);
      return ev('meeting:promises', '2026-09-29T08:31:30.000Z', { meetingKey: effect.meetingKey, title: effect.title, start: effect.start, end: effect.end, attendees: effect.attendees, promises: [{ who: 'owner', kind: 'promise', to: 'Mira Bakker', what: 'the draft', due: null, quote: "I'll send you the draft" }] });
    });
    return { ...out, passes };
  }

  it('the owner said little (5 mic lines in 30 minutes, the far side 40): one pass, the promise opens, no question', () => {
    const { state, passes } = heard(5);
    expect(passes).toHaveLength(1);
    expect(state.commitments.promises.map((c) => c.source)).toEqual(['meeting']);
    expect(state.loops.open.filter((l) => l.kind === 'owner-ask')).toEqual([]);
  });

  it('the owner took part (40 mic lines): the pass, the question with what it found, and on an answer the transcript is attached', () => {
    const { state, passes } = heard(40);
    expect(passes).toHaveLength(1);
    const ask = state.loops.open.find((l) => l.kind === 'owner-ask');
    expect(ask?.about).toContain('I heard you promise');
    // The owner answers; the judge reads it as wanting the transcript on the record.
    const answered = reduce(state, ev('ask:owner-answered', '2026-09-29T08:40:00.000Z', { askId: ask!.subject, answer: 'Track it, and keep the notes' }), RULE_MANIFEST);
    const judge = answered.effects.map((e) => e.effect).find((e): e is Extract<Effect, { type: 'Judge' }> => e.type === 'Judge' && e.purpose === 'listen');
    expect(judge).toBeDefined();
    const result = reduce(answered.state, ev('judgement:result', '2026-09-29T08:40:05.000Z', { questionSetId: judge!.questionSetId, momentId: null, metadata: judge!.metadata, answers: { wants_transcript_attached: { type: 'noul', noul: 0.9 } } }), RULE_MANIFEST);
    expect(result.effects.map((e) => e.effect).filter((e) => e.type === 'AttachTranscript')).toHaveLength(1);
  });
});
