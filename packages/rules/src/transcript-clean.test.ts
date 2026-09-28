import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, MomentRollup, SanitizedEvent } from '@sundial/kernel/types.js';
import { transcriptAccept, transcriptClean } from './transcript-clean.js';

const SPEECH =
  "dictate right now what I'm saying and it'll just pick it up and keep that into its memory so if you've seen the puppy meeting it'll know that I said this you said that";

const rollup = (over: Partial<MomentRollup> = {}): MomentRollup =>
  ({
    processName: 'Arc',
    windowTitles: ['Gnomon'],
    shellCommandCount: 0,
    notableCommands: [],
    gitCommitCount: 0,
    gitBranch: null,
    calendarActive: false,
    typingEventCount: 0,
    inputEventCount: 0,
    activeMs: 60_000,
    lifeEvents: [],
    projectSource: null,
    projectConfidence: null,
    micActive: true,
    cameraActive: false,
    meetingTitle: null,
    meetingAttendees: [],
    screenTopics: [],
    screenExcerpt: null,
    ...over,
  }) as MomentRollup;

function withMoment(state: KernelState, over: Partial<MomentRollup> = {}): KernelState {
  return { ...state, moment: { id: 'm1', sessionId: 's1', startTime: '2026-01-01T00:00:00.000Z', processName: 'Arc', projectId: null, rollup: rollup(over), intent: { status: 'none' } } } as KernelState;
}

const closing = (ts = '2026-01-01T00:10:00.000Z'): SanitizedEvent => ({ id: 'e1', type: 'window:changed', ts, payload: { processName: 'Warp' }, sanitized: true });

describe('transcriptClean', () => {
  it('asks for a readable copy when a moment actually heard something', () => {
    const { effects } = transcriptClean(withMoment(createInitialState('d1'), { spokenExcerpt: SPEECH, spokenLanguages: ['english'] }), closing());
    expect(effects).toHaveLength(1);
    const effect = effects[0] as { type: string; purpose: string; momentId: string; messages: { role: string; content: string }[] };
    expect(effect.type).toBe('ScheduleLLM');
    expect(effect.purpose).toBe('transcript');
    expect(effect.momentId).toBe('m1');
    expect(effect.messages[1]!.content).toContain(SPEECH);
    expect(effect.messages[1]!.content).toContain('Spoken in: english');
  });

  it('tells the model the failure that matters is a tidy transcript that lies', () => {
    const { effects } = transcriptClean(withMoment(createInitialState('d1'), { spokenExcerpt: SPEECH }), closing());
    const system = (effects[0] as { messages: { content: string }[] }).messages[0]!.content;
    // Not translating, not summarising, not finishing a sentence, not repairing
    // a name or a number: every one of those would put words in the owner's
    // mouth and the page shows this as something they said.
    for (const rule of ['Do not translate', 'summarise', 'Keep every name, number and quantity exactly as captured', 'leave it exactly as it is rather than guessing']) {
      expect(system).toContain(rule);
    }
  });

  it('says nothing about a moment that heard nothing, or barely anything', () => {
    expect(transcriptClean(withMoment(createInitialState('d1')), closing()).effects).toEqual([]);
    expect(transcriptClean(withMoment(createInitialState('d1'), { spokenExcerpt: 'yeah okay' }), closing()).effects).toEqual([]);
  });

  it('never sends a capture the redactor already masked', () => {
    // `sanitizeAtIngest` has already decided this must not leave the machine;
    // a prompt is the one place that decision is easiest to undo by accident.
    for (const masked of [`${SPEECH} [private]`, `${SPEECH} [REDACTED]`]) {
      expect(transcriptClean(withMoment(createInitialState('d1'), { spokenExcerpt: masked }), closing()).effects).toEqual([]);
    }
  });

  it('ignores an event that closes no moment', () => {
    const state = withMoment(createInitialState('d1'), { spokenExcerpt: SPEECH });
    expect(transcriptClean(state, { id: 'e2', type: 'input:activity', ts: '2026-01-01T00:05:00.000Z', payload: {}, sanitized: true }).effects).toEqual([]);
  });
});

describe('transcriptAccept', () => {
  it('records which copy the owner trusts, and deletes nothing', () => {
    const before = createInitialState('d1');
    const { state, effects } = transcriptAccept(before, { id: 'e3', type: 'moment:transcript-accepted', ts: '2026-01-01T01:00:00.000Z', payload: { momentId: 'm1' }, sanitized: true });
    // One flag beside the capture. The raw text is not in the patch at all:
    // accepting a cleaner reading is not the same as the room having been
    // quieter than it was.
    expect(effects).toEqual([{ type: 'UpdateMomentData', momentId: 'm1', patch: { spokenCleanAccepted: true } }]);
    expect(state).toBe(before);
  });

  it('ignores an accept with no moment behind it', () => {
    expect(transcriptAccept(createInitialState('d1'), { id: 'e4', type: 'moment:transcript-accepted', ts: '2026-01-01T01:00:00.000Z', payload: {}, sanitized: true }).effects).toEqual([]);
  });
});
