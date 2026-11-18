import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { JOBS_KEPT, SHELLS_KEPT, shellJobs } from './shell-jobs.js';

const exited = (jobId: string, ts: string, over = {}): SanitizedEvent =>
  ({ id: `e-${jobId}`, type: 'shell:exited', ts, payload: { jobId, exitCode: 0, lastLine: 'line 6', ms: 24_000, ...over } }) as unknown as SanitizedEvent;
const fold = (events: SanitizedEvent[]) => events.reduce((s, e) => shellJobs(s, e).state, createInitialState('test-device'));

describe('shellJobs (the fact that was missing: a background job ended)', () => {
  it('keeps how a job ended, so a wait can end with it', () => {
    const state = fold([exited('job-1', '2026-11-13T12:00:00.000Z')]);
    expect(state.jobs['job-1']).toEqual({ exitCode: 0, lastLine: 'line 6', at: '2026-11-13T12:00:00.000Z', ms: 24_000 });
  });

  it('ignores a row with no job, and cuts a long last line', () => {
    expect(fold([exited('', '2026-11-13T12:00:00.000Z')]).jobs).toEqual({});
    expect(fold([exited('job-2', '2026-11-13T12:00:00.000Z', { lastLine: 'x'.repeat(400) })]).jobs['job-2'].lastLine).toHaveLength(300);
  });

  it('Set 2 R3: per chat, the last shell call: the job it started (running until it exits), or a failed start; bounded, event time only', () => {
    const started = (session: string, ts: string, payload = {}) => ({ id: `s-${session}-${ts}`, type: 'shell:started', ts, payload: { session, background: true, ...payload } }) as unknown as SanitizedEvent;
    const rows = [started('chat-a', '2026-11-13T12:00:00.000Z', { jobId: 'job-1' }), started('chat-b', '2026-11-13T12:00:01.000Z', { failed: true, background: false })];
    const state = fold(rows);
    expect(state.shells).toEqual({ 'chat-a': { at: '2026-11-13T12:00:00.000Z', failed: false, job: 'job-1' }, 'chat-b': { at: '2026-11-13T12:00:01.000Z', failed: true, job: null } });
    expect(state.jobs['job-1']).toBeUndefined();
    // Replay-safe: the same rows fold to the same state, from a snapshot as from scratch.
    const snap = JSON.parse(JSON.stringify(fold(rows.slice(0, 1))));
    expect(shellJobs(snap, rows[1]).state.shells).toEqual(state.shells);
    expect(fold([...rows, exited('job-1', '2026-11-13T12:00:30.000Z')]).jobs['job-1']).toBeDefined();
    const many = Array.from({ length: SHELLS_KEPT + 5 }, (_, i) => started(`chat-${i}`, `2026-11-13T12:${String(i).padStart(2, '0')}:00.000Z`));
    expect(Object.keys(fold(many).shells ?? {})).toHaveLength(SHELLS_KEPT);
    expect(fold(many).shells?.['chat-0']).toBeUndefined();
  });

  it('stays bounded, keeping the newest', () => {
    const many = Array.from({ length: JOBS_KEPT + 5 }, (_, i) => exited(`job-${i}`, `2026-11-13T12:${String(i).padStart(2, '0')}:00.000Z`));
    const state = fold(many);
    expect(Object.keys(state.jobs)).toHaveLength(JOBS_KEPT);
    expect(state.jobs[`job-${JOBS_KEPT + 4}`]).toBeDefined();
    expect(state.jobs['job-0']).toBeUndefined();
  });
});
