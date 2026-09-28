import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { mailTrack, recentMailSubjects } from './mail-track.js';
import { momentFanout } from './questions/moment-fanout.js';

const ev = (type: string, payload: Record<string, unknown>, ts = '2026-09-22T10:00:00.000Z'): SanitizedEvent => ({ id: `e-${ts}-${type}`, type, ts, payload, sanitized: true });

describe('mailTrack (J3.6)', () => {
  it('keeps subjects and senders only, names access, and hands the fan-out the recent subjects', () => {
    let state = createInitialState('d1');
    state = mailTrack(state, ev('mail:status', { accessible: false, reason: 'EPERM' })).state;
    expect(state.mail.accessible).toBe(false);
    state = mailTrack(state, ev('mail:received', { from: 'person-ab12', subject: 'Re: hint border', timestamp: '2026-09-22T09:00:00.000Z' })).state;
    state = mailTrack(state, ev('mail:received', { from: 'person-cd34', subject: 'Standup notes', timestamp: '2026-09-22T09:30:00.000Z' })).state;
    state = mailTrack(state, ev('message:received', { from: 'phone', chat: 'Team', fromMe: false, timestamp: '2026-09-22T09:40:00.000Z' })).state;
    expect(state.mail).toMatchObject({ accessible: true, recent: [{ subject: 'Re: hint border' }, { subject: 'Standup notes' }], messages: [{ from: 'phone', chat: 'Team', fromMe: false }] });
    expect(JSON.stringify(state.mail)).not.toContain('body');
    expect(recentMailSubjects(state, '2026-09-22T10:00:00.000Z')).toEqual(['Standup notes', 'Re: hint border']);
    expect(recentMailSubjects(state, '2026-09-22T14:00:00.000Z')).toEqual([]);
    expect(mailTrack(state, ev('mail:received', { from: 'x', subject: '' })).state).toBe(state);
    const [sample] = momentFanout.samples()[0];
    expect(momentFanout.build({ ...sample, mailSubjects: ['Standup notes'] }).state.mail_subjects_recent).toEqual(['Standup notes']);
  });
});
