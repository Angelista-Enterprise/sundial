import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { momentFanout } from './questions/moment-fanout.js';
import { MAX_VAULT_NOTES, notesEditedToday, vaultTrack } from './vault-track.js';

const ev = (notes: unknown, ts = '2026-09-22T10:00:00.000Z'): SanitizedEvent => ({ id: `e-${ts}`, type: 'vault:changed', ts, payload: { notes, count: Array.isArray(notes) ? notes.length : 0 }, sanitized: true });

describe('vaultTrack (J3.5)', () => {
  it('keeps today\'s edited notes by path, counts repeats, newest first for the fan-out, and drops junk', () => {
    let state = createInitialState('d1');
    state = vaultTrack(state, ev(['Dailies/2026-09-22.md', 'Apps/gnomon.md'])).state;
    state = vaultTrack(state, ev(['Apps/gnomon.md', 7, ''], '2026-09-22T11:00:00.000Z')).state;
    expect(state.vault.notesToday['Apps/gnomon.md']).toEqual({ changes: 2, lastAt: '2026-09-22T11:00:00.000Z' });
    expect(notesEditedToday(state)).toEqual(['Apps/gnomon', 'Dailies/2026-09-22']);
    expect(vaultTrack(state, ev('nope')).state).toBe(state);
  });

  it('a new day starts over — by the event\'s own day and on the boundary; the slice stays bounded', () => {
    let state = createInitialState('d1');
    state = vaultTrack(state, ev(['a.md'], '2026-09-22T10:00:00.000Z')).state;
    state = vaultTrack(state, ev(['b.md'], '2026-09-23T10:00:00.000Z')).state;
    expect(Object.keys(state.vault.notesToday)).toEqual(['b.md']);
    state = vaultTrack(state, ev(Array.from({ length: 80 }, (_, i) => `n${i}.md`), '2026-09-23T11:00:00.000Z')).state;
    expect(Object.keys(state.vault.notesToday)).toHaveLength(MAX_VAULT_NOTES);
    state = vaultTrack(state, { id: 'b', type: 'day:boundary', ts: '2026-09-24T00:00:00.000Z', payload: {}, sanitized: true }).state;
    expect(state.vault).toEqual({ day: null, notesToday: {} });
  });

  it('the fan-out carries the notes as evidence, not as a subject option', () => {
    const [sample] = momentFanout.samples()[0];
    const built = momentFanout.build({ ...sample, notesEditedToday: ['Apps/gnomon', 'Dailies/2026-09-22'] });
    expect(built.state.notes_edited_today).toEqual(['Apps/gnomon', 'Dailies/2026-09-22']);
    expect(Object.keys(built.questions.subject.criteria ?? {})).not.toContain('note');
  });
});
