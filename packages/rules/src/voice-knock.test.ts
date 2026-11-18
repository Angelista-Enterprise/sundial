import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { DeliveredNotice, Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { isEcho } from '@sundial/kernel/voice-lines.js';
import { KNOCK_LOST_MS, MUTE_MS, RETURN_STALE_MS, voiceKnock } from './voice-knock.js';

const T0 = Date.parse('2026-03-10T09:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const ev = (type: string, sec: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${sec}`, type, ts: at(sec), payload, sanitized: true });
const KEY = 'day-runs-long:1';

/** The state right after the gate delivered one phasic notice with a knock at second 0. */
function delivered(knock: DeliveredNotice['knock'], over: Partial<DeliveredNotice> = {}): KernelState {
  const base = createInitialState('d1');
  const item: DeliveredNotice = { key: KEY, kind: 'day-runs-long', channel: 'phasic', cost: 0.2, evidence: ['n=20'], sessionId: 'session-7f', askId: null, ...(knock ? { knock } : {}), ...over };
  return { ...base, notices: { ...base.notices, lastDelivered: { at: at(0), items: [item] }, recentPhasic: [{ kind: 'day-runs-long', observation: 'The day runs long.', evidence: ['n=20'], weight: 2, at: at(0), noticeKey: KEY }] } };
}

function fold(state: KernelState, events: SanitizedEvent[]) {
  const effects: Effect[] = [];
  for (const e of events) {
    const out = voiceKnock(state, e);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}
const emitted = (effects: Effect[]) => effects.flatMap((e) => (e.type === 'EmitEvent' ? [{ type: e.event.type, ...e.event.payload }] : []));

describe('voiceKnock (plan 15 step 1)', () => {
  it('a delivered notice with a knock: the knock is pending, in the log, and on its way to the app', () => {
    const { state, effects } = fold(delivered({ mode: 'knock-wait', turn: true }), [ev('notice:candidate', 0)]);
    expect(state.voice?.pendingKnock).toEqual({ noticeKey: KEY, kind: 'day-runs-long', mode: 'knock-wait', at: at(0), sessionId: 'session-7f', askId: null, turn: true });
    expect(emitted(effects)).toEqual([{ type: 'voice:knock', noticeKey: KEY, kind: 'day-runs-long', mode: 'knock-wait' }]);
    expect(effects[1]).toEqual({ type: 'Speak', text: 'The day runs long.', sound: 'knock', mode: 'knock-wait', noticeKey: KEY });
  });

  it('no knock on the item, or an event the gate does not deliver on: nothing', () => {
    const plain = delivered(undefined);
    expect(voiceKnock(plain, ev('notice:candidate', 0))).toEqual({ state: plain, effects: [] });
    const other = delivered({ mode: 'knock-wait', turn: true });
    expect(voiceKnock(other, ev('window:changed', 0))).toEqual({ state: other, effects: [] });
  });

  it('the go starts the chat turn that waited, once, and does not count the notice again', () => {
    const knocked = fold(delivered({ mode: 'knock-wait', turn: true }), [ev('notice:candidate', 0)]).state;
    const { state, effects } = fold(knocked, [ev('voice:go', 2, { noticeKey: KEY }), ev('voice:go', 3, { noticeKey: KEY })]);
    expect(state.voice?.pendingKnock).toBeNull();
    expect(effects).toEqual([expect.objectContaining({ type: 'Notify', channel: 'phasic-notice', payload: expect.objectContaining({ noticeKey: KEY, kind: 'day-runs-long', observation: 'The day runs long.', sessionId: 'session-7f', acts: ['turn'], afterGo: true }) })]);
  });

  it('a go for a plain notice, the app\'s own go, and a go for another key start no turn', () => {
    const plain = fold(delivered({ mode: 'knock-wait', turn: false }), [ev('notice:candidate', 0), ev('voice:go', 2, { noticeKey: KEY })]);
    expect(plain.effects.filter((e) => e.type === 'Notify')).toEqual([]);
    expect(plain.state.voice?.pendingKnock).toBeNull();
    const auto = fold(delivered({ mode: 'knock-speak', turn: false }), [ev('notice:candidate', 0), ev('voice:go', 0, { noticeKey: KEY, auto: true })]);
    expect(auto.effects.filter((e) => e.type === 'Notify')).toEqual([]);
    const stray = fold(delivered({ mode: 'knock-wait', turn: true }), [ev('notice:candidate', 0), ev('voice:go', 2, { noticeKey: 'other:1' })]);
    expect(stray.state.voice?.pendingKnock?.noticeKey).toBe(KEY);
  });

  it('Esc counts against the notice; secure input and no answer do not', () => {
    const knocked = fold(delivered({ mode: 'knock-wait', turn: true }), [ev('notice:candidate', 0)]).state;
    const esc = fold(knocked, [ev('voice:declined', 2, { noticeKey: KEY, reason: 'esc' })]);
    expect(emitted(esc.effects)).toEqual([{ type: 'feedback:verdict', artifactKind: 'notice', artifactId: KEY, verdict: 'not-now', via: 'knock' }]);
    expect(esc.state.voice?.pendingKnock).toBeNull();
    for (const e of [ev('voice:declined', 0, { noticeKey: KEY, reason: 'secure-input' }), ev('voice:unanswered', 5, { noticeKey: KEY })]) {
      const out = fold(knocked, [e]);
      expect(out.effects).toEqual([]);
      expect(out.state.voice?.pendingKnock).toBeNull();
    }
  });

  it('no answer from the app at all: the knock is given up, and the log says why', () => {
    const knocked = fold(delivered({ mode: 'knock-wait', turn: true }), [ev('notice:candidate', 0)]).state;
    expect(fold(knocked, [ev('clock:tick', KNOCK_LOST_MS / 1000)]).state.voice?.pendingKnock).not.toBeNull();
    const lost = fold(knocked, [ev('clock:tick', KNOCK_LOST_MS / 1000 + 1)]);
    expect(lost.state.voice?.pendingKnock).toBeNull();
    expect(emitted(lost.effects)).toEqual([{ type: 'voice:unanswered', noticeKey: KEY, kind: 'day-runs-long', reason: 'no-app' }]);
  });

  it('keeps the last key press and the last speech, and "Quiet for one hour" on and off', () => {
    const { state } = fold(createInitialState('d1'), [ev('input:activity', 1, { keyDownCount: 0 }), ev('input:activity', 2, { keyDownCount: 4 }), ev('audio:transcript', 3), ev('voice:muted', 4)]);
    expect(state.voice).toMatchObject({ typedAt: at(2), heardAt: at(3), mutedUntil: new Date(T0 + 4000 + MUTE_MS).toISOString() });
    expect(voiceKnock(state, ev('voice:muted', 5, { off: true })).state.voice?.mutedUntil).toBeNull();
  });
});

describe('the return sound (plan 15 4.4)', () => {
  const atMac = (channel: 'mac' | 'phone' | 'hold' = 'mac'): KernelState => {
    const base = createInitialState('d1');
    return { ...base, route: { channel, reason: 'active', since: at(0), awaySince: null } };
  };
  const sounds = (effects: Effect[]) => effects.filter((e) => e.type === 'Speak').map((e) => (e as { sound: string }).sound);

  it('a shelved job plays the return sound at the next boundary, once', () => {
    const { effects } = fold(atMac(), [ev('work:shelved', 0, { title: 'Notes for BOX-484' }), ev('boundary:reached', 60, { kind: 'commit' }), ev('boundary:reached', 120, { kind: 'commit' })]);
    expect(sounds(effects)).toEqual(['return']);
  });

  it('a finished night job counts only when done', () => {
    expect(sounds(fold(atMac(), [ev('job:finished', 0, { outcome: 'failed' }), ev('boundary:reached', 60)]).effects)).toEqual([]);
    expect(sounds(fold(atMac(), [ev('job:finished', 0, { outcome: 'done' }), ev('boundary:reached', 60)]).effects)).toEqual(['return']);
  });

  it('away, in a call, muted or too late: no sound', () => {
    expect(sounds(fold(atMac('phone'), [ev('work:shelved', 0, { title: 'x' }), ev('boundary:reached', 60)]).effects)).toEqual([]);
    expect(sounds(fold(atMac('hold'), [ev('work:shelved', 0, { title: 'x' }), ev('boundary:reached', 60)]).effects)).toEqual([]);
    expect(sounds(fold(atMac(), [ev('voice:muted', 0), ev('work:shelved', 1, { title: 'x' }), ev('boundary:reached', 60)]).effects)).toEqual([]);
    const late = fold(atMac(), [ev('work:shelved', 0, { title: 'x' }), ev('boundary:reached', RETURN_STALE_MS / 1000 + 1)]);
    expect(sounds(late.effects)).toEqual([]);
    expect(late.state.voice?.returnAt).toBeNull();
  });
});

describe('talking (plan 15 step 3)', () => {
  it('a spoken "yes" while a knock waits is the go: the sentence is said and the held turn runs', () => {
    const waiting = fold(delivered({ mode: 'knock-wait', turn: true }), [ev('notice:candidate', 0)]).state;
    const { state, effects } = fold(waiting, [ev('audio:transcript', 2, { spokenText: 'Yes.', channel: 'mic', wordCount: 1 })]);
    expect(emitted(effects)).toEqual([{ type: 'voice:go', noticeKey: KEY, spoken: true }]);
    expect(effects[1]).toEqual({ type: 'Speak', text: 'The day runs long.', sound: null, mode: 'notice', noticeKey: KEY });
    expect(fold(state, [ev('voice:go', 2, { noticeKey: KEY, spoken: true })]).state.voice?.pendingKnock).toBeNull();
    expect(fold(waiting, [ev('audio:transcript', 2, { spokenText: 'the build broke again' })]).effects).toEqual([]);
    expect(fold(waiting, [ev('audio:transcript', 2, { spokenText: 'Yeah, so about the release', wordCount: 5 })]).effects).toEqual([]);
    expect(fold(waiting, [ev('audio:transcript', 2, { spokenText: 'yes', channel: 'system', wordCount: 1 })]).effects).toEqual([]);
    expect(fold(waiting, [ev('audio:transcript', 2, { spokenText: 'Yeah, so about the release', wordCount: 5 })]).effects).toEqual([]);
    expect(fold(waiting, [ev('audio:transcript', 2, { spokenText: 'yes', channel: 'system', wordCount: 1 })]).effects).toEqual([]);
  });

  it('a spoken go on a notice that carries an offer presses it through the host (Set 2 R3); no offer, no press', () => {
    const offer = { tool: 'gnomon_brief', args: { kind: 'day' }, label: 'Open the day', kind: 'day-runs-long', at: at(0) };
    const base = fold(delivered({ mode: 'knock-wait', turn: true }), [ev('notice:candidate', 0)]).state;
    const withOffer = { ...base, notices: { ...base.notices, offers: { [KEY]: offer } } };
    const { effects } = fold(withOffer, [ev('audio:transcript', 2, { spokenText: 'Go.', channel: 'mic', wordCount: 1 })]);
    expect(emitted(effects)).toEqual([{ type: 'voice:go', noticeKey: KEY, spoken: true }]);
    expect(effects.filter((e) => e.type === 'Notify')).toEqual([{ type: 'Notify', channel: 'offer-take', payload: { noticeKey: KEY, via: 'knock' } }]);
    // The call itself never rides the effect: the host reads it from `notices.offers` by the key.
    expect(JSON.stringify(effects)).not.toContain('gnomon_brief');
    expect(fold(base, [ev('audio:transcript', 2, { spokenText: 'yes', wordCount: 1 })]).effects.filter((e) => e.type === 'Notify')).toEqual([]);
    const other = { ...base, notices: { ...base.notices, offers: { 'other:1': offer } } };
    expect(fold(other, [ev('audio:transcript', 2, { spokenText: 'yes', wordCount: 1 })]).effects.filter((e) => e.type === 'Notify')).toEqual([]);
  });

  it('keeps the holding lines and the said replies, bounded, and the last stop', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ev('voice:line', i, { line: `line ${i}` }));
    const said = Array.from({ length: 7 }, (_, i) => ev('voice:said', 20 + i, { text: `reply ${i}`, mode: 'reply' }));
    const { state } = fold(createInitialState('d1'), [...lines, ...said, ev('voice:interrupted', 40)]);
    expect(state.voice?.recentLines).toEqual(['line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9']);
    expect(state.voice?.recentSaid?.map((s) => s.text)).toEqual(['reply 2', 'reply 3', 'reply 4', 'reply 5', 'reply 6']);
    expect(state.voice?.interruptedAt).toBe(at(40));
  });

  it("Round 5: a screen step's line folds like a holding line, and its voice:said like a reply, so hearing drops its own step line", () => {
    const { state } = fold(createInitialState('d1'), [
      ev('voice:line', 1, { line: 'Open the Sort By menu', tool: 'screen_act', stepId: 'act-1' }),
      ev('voice:said', 2, { text: 'Open the Sort By menu', mode: 'step', stepId: 'act-1' }),
    ]);
    expect(state.voice?.recentLines.at(-1)).toBe('Open the Sort By menu');
    expect(state.voice?.recentSaid).toEqual([{ text: 'Open the Sort By menu', at: at(2) }]);
    expect(isEcho('open the sort by menu', state.voice?.recentSaid, at(4))).toBe(true);
  });

  it('Set 2 R3: the newest spoken turn and the lines sent in it, bounded; another turn or chat is not its line; the last line ends it', () => {
    const turnAt = at(0);
    const line = (sec: number, text: string, over = {}) => ev('voice:line', sec, { line: text, reply: true, session: 'session-7f', turnAt, seq: sec - 1, ...over });
    const rows = [ev('voice:turn', 0, { session: 'session-7f', turnAt, lang: 'en' }), ...Array.from({ length: 14 }, (_, i) => line(i + 1, `Sentence ${i}.`))];
    const { state } = fold(createInitialState('d1'), [...rows, line(20, 'Other chat.', { session: 'session-9a' }), line(21, 'Old turn.', { turnAt: at(-60) })]);
    expect(state.voice?.said).toMatchObject({ session: 'session-7f', at: turnAt, lang: 'en', seq: 14 });
    expect(state.voice?.said?.lines).toHaveLength(12);
    expect(state.voice?.said?.lines.at(-1)).toBe('Sentence 13.');
    expect(state.voice?.said?.ended).toBeUndefined();
    // A reply's own sentences are not holding lines.
    expect(state.voice?.recentLines).toEqual([]);
    expect(fold(state, [line(30, '', { last: true, seq: 14 })]).state.voice?.said).toMatchObject({ ended: true, seq: 15 });
    expect(fold(state, [ev('voice:turn', 40, { session: 'session-9a', turnAt: at(40), lang: null })]).state.voice?.said).toEqual({ session: 'session-9a', at: at(40), lang: null, lines: [], seq: 0 });
  });
});
