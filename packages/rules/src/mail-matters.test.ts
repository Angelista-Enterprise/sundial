import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { recentMailSubjects } from './mail-track.js';
import { mailMatters } from './mail-matters.js';
import { mailBearing, promiseTrack } from './promise-track.js';

let seq = 0;
const ev = (type: string, ts: string, payload: Record<string, unknown>): SanitizedEvent => ({ id: `m${++seq}`, type, ts, payload: { timestamp: ts, ...payload }, sanitized: true });
const MEETING = { meetingKey: 'Numbers|2026-09-29T08:00:00.000Z', title: 'Numbers', start: '2026-09-29T08:00:00.000Z', end: '2026-09-29T08:30:00.000Z', attendees: ['Mira Bakker'] };
const AFTER = '2026-09-29T12:00:00.000Z';
const noticesOf = (effects: Effect[]) => effects.filter((e) => e.type === 'EmitEvent' && e.event.type === 'notice:candidate').map((e) => (e as { event: { payload: Record<string, unknown> } }).event.payload);

/** One open promise with Mira: she owes the numbers (`awaiting`), or the owner owes her the draft. */
function withPromise(who: 'owner' | 'other', due: string | null = null): KernelState {
  const s = createInitialState('d');
  s.config.timezone = 'Europe/Amsterdam';
  s.config.ownerAliases = ['pat'];
  const promise = who === 'other' ? { who: 'other', kind: 'promise', to: 'Mira Bakker', what: 'the numbers', due, quote: 'I will share the numbers' } : { who: 'owner', kind: 'promise', to: 'Mira Bakker', what: 'the draft', due, quote: "I'll send you the draft" };
  return promiseTrack(s, ev('meeting:promises', '2026-09-29T08:31:00.000Z', { ...MEETING, promises: [promise] })).state;
}
const mail = (subject: string, from = 'Mira Bakker') => ev('mail:received', AFTER, { from, subject });

describe('mail that matters (lane B #17)', () => {
  it('reads what a mail says about a promise: a fresh mail keeps what they owed, a reply is only a sign', () => {
    const owed = withPromise('other').commitments.promises[0]!;
    expect(mailBearing(owed, 'Mira Bakker', 'Numbers for Q3')).toBe('keeps');
    expect(mailBearing(owed, 'mira bakker', 'Re: the numbers?')).toBe('about');
    expect(mailBearing(owed, 'Mira Bakker', 'Lunch on Friday')).toBe('contact');
    expect(mailBearing(owed, 'Bob Jansen', 'Numbers for Q3')).toBeNull();
    const mine = withPromise('owner').commitments.promises[0]!;
    expect(mailBearing(mine, 'Mira Bakker', 'The draft?'), 'mail about what the owner owes proves nothing').toBe('about');
  });

  it('a reply in the thread updates the promise and keeps it open; a fresh mail naming it closes it as kept', () => {
    const state = withPromise('other');
    const replied = promiseTrack(state, mail('Re: the numbers'));
    expect(replied.state.commitments.promises[0]!.promise!.evidence).toEqual([{ kind: 'mail-weak', at: AFTER, strong: false, text: 'mail from Mira Bakker: Re: the numbers' }]);
    const kept = promiseTrack(replied.state, mail('Numbers for Q3'));
    expect(kept.state.commitments.recentClosed.at(-1)).toMatchObject({ closedBecause: 'kept', promise: { evidence: [{ kind: 'mail-weak' }, { kind: 'reply', strong: true }] } });
  });

  it('says it in passing, through the gate, per person — before the promise can close', () => {
    const state = withPromise('other');
    expect(noticesOf(mailMatters(state, mail('Numbers for Q3')).effects)).toEqual([
      expect.objectContaining({ kind: 'mail-matters', key: 'mail-matters:Mira Bakker', valueHalfLifeMs: null, plain: true, observation: 'Mira Bakker sent the numbers: “Numbers for Q3”. Kept.' }),
    ]);
    expect(noticesOf(mailMatters(state, mail('Re: the numbers')).effects)[0]).toMatchObject({ observation: 'Mira Bakker replied about the numbers: “Re: the numbers”. Open until it arrives.' });
    expect(noticesOf(mailMatters(state, mail('Lunch on Friday')).effects), 'about something else, from someone who owes you: not worth a line').toEqual([]);
    expect(noticesOf(mailMatters(state, mail('Numbers for Q3', 'Bob Jansen')).effects), 'not the person').toEqual([]);
  });

  it('mail about something else, from someone the owner owes: only when it is due within two days', () => {
    const soon = withPromise('owner', 'tomorrow');
    expect(noticesOf(mailMatters(soon, mail('Lunch on Friday')).effects)[0]).toMatchObject({ observation: 'Mail from Mira Bakker: “Lunch on Friday”. You owe them the draft, due 2026-09-30.' });
    const later = withPromise('owner', 'next week');
    expect(noticesOf(mailMatters(later, mail('Lunch on Friday')).effects)).toEqual([]);
  });

  it('ranks mail from someone a promise is with first', () => {
    const state = withPromise('other');
    state.mail.recent = [
      { from: 'Mira Bakker', subject: 'Numbers draft', at: '2026-09-29T11:00:00.000Z' },
      { from: 'Newsletter', subject: 'This week', at: '2026-09-29T11:30:00.000Z' },
    ];
    expect(recentMailSubjects(state, AFTER)).toEqual(['Numbers draft', 'This week']);
  });
});
