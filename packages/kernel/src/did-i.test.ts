import { describe, expect, it } from 'vitest';
import { blindSpots, judgeDidI, namesFor, needlesFor, parseDidI, type PromiseRow } from './did-i.js';
import type { LogRow, MomentRow } from './flight-recorder.js';

const TZ = 'Europe/Amsterdam';
const aliasNames = { 'person-0a1b2c3d4e': 'Mira Bakker', mira: 'Mira Bakker' };
const people = ['Mira Bakker', 'Tess de Wit'];
const row = (id: string, type: string, ts: string, data: Record<string, unknown>): LogRow => ({ id, type, ts, data });

describe('parseDidI', () => {
  it('reads the four headline questions', () => {
    expect(parseDidI('did I reply to Mira', { aliasNames, people })).toMatchObject({ action: 'mail', person: { asked: 'mira' } });
    expect(parseDidI('did I push BOX-484', { aliasNames, people })).toMatchObject({ action: 'push', tickets: ['BOX-484'], keys: [] });
    expect(parseDidI('did I send the invoice', { aliasNames, people })).toMatchObject({ action: 'mail', person: null, keys: ['invoice'] });
    expect(parseDidI('did I go to the retro', { aliasNames, people })).toMatchObject({ action: 'meet', keys: ['retro'] });
  });

  it('reads Dutch', () => {
    expect(parseDidI('heb ik de factuur gestuurd', { aliasNames, people })).toMatchObject({ action: 'mail', keys: ['factuur'] });
    expect(parseDidI('ben ik naar de retro gegaan', { aliasNames, people })).toMatchObject({ action: 'meet', keys: ['retro'] });
  });

  it('takes a capitalised name the record holds only as a mail sender', () => {
    const q = parseDidI('Did I answer Priya about the quote', { aliasNames, people });
    expect(q.person?.asked).toBe('Priya');
    expect(q.keys).toEqual(['quote']);
  });

  it('never takes a meeting word or a weekday for a person', () => {
    expect(parseDidI('did I go to the Retro on Friday', { aliasNames, people }).person).toBeNull();
  });
});

describe('namesFor', () => {
  it('finds the full name and every alias pointing at it from a first name', () => {
    expect(namesFor('Mira', aliasNames, people).sort()).toEqual(['Mira', 'Mira Bakker', 'mira', 'person-0a1b2c3d4e'].sort());
  });

  it('gives back a name nobody holds as itself', () => {
    expect(namesFor('Priya', aliasNames, people)).toEqual(['Priya']);
  });
});

describe('judgeDidI', () => {
  const q = (what: string) => parseDidI(what, { aliasNames, people });

  it('a sent mail to her is the reply; her own mail is related, and says whether yours came after', () => {
    const rows = [
      row('r1', 'mail:received', '2026-09-28T08:00:00.000Z', { from: 'Mira Bakker', subject: 'The draft?' }),
      row('r2', 'mail:sent', '2026-09-28T09:30:00.000Z', { subject: 'Re: The draft?', recipients: [{ to: 'person-0a1b2c3d4e' }] }),
    ];
    const answer = judgeDidI(q('did I reply to Mira'), rows, [], [], TZ);
    expect(answer.answer).toBe('yes');
    expect(answer.evidence[0]).toMatchObject({ id: 'r2', strong: true, kind: 'mail:sent' });
    expect(answer.evidence[1]).toMatchObject({ id: 'r1', strong: false });
    expect(answer.reply).toMatchObject({ lastFromThem: { id: 'r1' }, sentAfter: true });
  });

  it('only her mail: related, and no reply after it', () => {
    const rows = [row('r1', 'mail:received', '2026-09-28T08:00:00.000Z', { from: 'Mira Bakker', subject: 'The draft?' })];
    const answer = judgeDidI(q('did I reply to Mira'), rows, [], [], TZ);
    expect(answer.answer).toBe('related only');
    expect(answer.reply?.sentAfter).toBe(false);
  });

  it('a push of the ticket branch, or its PR, is the push; a commit naming it is related', () => {
    const commit = row('c1', 'git:commit', '2026-09-28T10:00:00.000Z', { commitLine: 'BOX-484 fix the login', branch: 'feat/BOX-484-login', cwd: '~/Projects/puzzlebox-studio' });
    expect(judgeDidI(q('did I push BOX-484'), [commit], [], [], TZ).answer).toBe('related only');
    const push = row('p1', 'git:push', '2026-09-28T10:05:00.000Z', { branch: 'feat/BOX-484-login', cwd: '~/Projects/puzzlebox-studio', remote: 'origin' });
    expect(judgeDidI(q('did I push BOX-484'), [commit, push], [], [], TZ)).toMatchObject({ answer: 'yes', evidence: [{ id: 'p1', strong: true }, { id: 'c1', strong: false }] });
    const shell = row('s1', 'shell:command', '2026-09-28T10:05:00.000Z', { command: 'git push -u origin feat/BOX-484-login', exitCode: 0, cwd: '~/Projects/puzzlebox-studio' });
    expect(judgeDidI(q('did I push BOX-484'), [shell], [], [], TZ).answer).toBe('yes');
  });

  it('another ticket is no sign of it', () => {
    const push = row('p1', 'git:push', '2026-09-28T10:05:00.000Z', { branch: 'feat/BOX-485', cwd: '~/Projects/puzzlebox-studio' });
    expect(judgeDidI(q('did I push BOX-484'), [push], [], [], TZ).answer).toBe('no sign of it');
  });

  it('the retro: yes with the mic on in it, related when only on the calendar or only at the keyboard', () => {
    const cal = row('k1', 'calendar:active', '2026-09-26T13:00:00.000Z', { event: { eventId: 'e1', title: 'Sprint retro', startDate: '2026-09-26T13:00:00.000Z', endDate: '2026-09-26T14:00:00.000Z', attendees: '["Mira Bakker"]' } });
    const moment = (mic: boolean): MomentRow => ({ id: 'm1', start: '2026-09-26T13:02:00.000Z', end: '2026-09-26T13:50:00.000Z', projectId: null, process: 'Google Chrome', data: { meetingTitle: 'Sprint retro', micActive: mic, activeMs: 60_000 } });
    expect(judgeDidI(q('did I go to the retro'), [cal], [], [], TZ).answer).toBe('related only');
    expect(judgeDidI(q('did I go to the retro'), [cal], [moment(false)], [], TZ).evidence.find((e) => e.id === 'm1')?.why).toContain('no microphone');
    const yes = judgeDidI(q('did I go to the retro'), [cal], [moment(true)], [], TZ);
    expect(yes.answer).toBe('yes');
    expect(yes.evidence[0]).toMatchObject({ id: 'm1', strong: true, why: 'says retro, mic on during it' });
  });

  it('a kept promise answers "did I send the invoice"; an open one is related', () => {
    const promise = (closedBecause: string | null): PromiseRow => ({
      id: 'commitment:promise:1',
      name: 'the invoice',
      openedAt: '2026-09-24T09:00:00.000Z',
      closedAt: closedBecause ? '2026-09-25T09:00:00.000Z' : null,
      closedBecause,
      promise: { deliverable: 'the invoice', counterparty: 'Mira Bakker', keys: ['invoice'], evidence: [{ kind: 'mail', text: 'mail to Mira Bakker: Invoice September', at: '2026-09-25T09:00:00.000Z', strong: true }] },
    });
    expect(judgeDidI(q('did I send the invoice'), [], [], [promise('kept')], TZ)).toMatchObject({ answer: 'yes', evidence: [{ kind: 'promise', strong: true }] });
    expect(judgeDidI(q('did I send the invoice'), [], [], [promise(null)], TZ).answer).toBe('related only');
  });

  it('keeps the evidence short and says how many were left out', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`c${i}`, 'git:commit', `2026-09-28T1${i % 10}:00:00.000Z`, { commitLine: `invoice export step ${i}`, branch: 'main', cwd: '~/Projects/puzzlebox-studio' }));
    const answer = judgeDidI(q('did I commit the invoice export'), rows, [], [], TZ);
    expect(answer.evidence).toHaveLength(8);
    expect(answer.more).toBe(4);
  });
});

describe('needles and blind spots', () => {
  it('searches by ticket, every name and the long words', () => {
    const q = parseDidI('did I reply to Mira about the invoice', { aliasNames, people });
    expect(needlesFor(q)).toEqual(expect.arrayContaining(['Mira Bakker', 'person-0a1b2c3d4e', 'invoice']));
  });

  it('says outright when no sent mail is recorded at all', () => {
    const q = parseDidI('did I reply to Mira', { aliasNames, people });
    expect(blindSpots(q, { 'mail:sent': 0 })[0]).toContain('0 rows');
    expect(blindSpots(q, { 'mail:sent': 3 })[0]).not.toContain('0 rows');
  });
});
