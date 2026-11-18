import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { awaitShelf } from './await-shelf.js';
import { RULE_MANIFEST } from './manifest.js';

// Set 4 R2: a long job on the shelf, and the knock when its row lands. Made-up values only.
const ev = (type: string, ts: string, payload: Record<string, unknown>) => ({ id: `e-${type}-${ts}`, type, ts, payload }) as unknown as SanitizedEvent;
const shelved = ev('await:shelved', '2026-11-16T14:00:00.000Z', { sessionId: 'session-box', job: 'job-7', about: 'the build' });
const exited = (jobId: string, exitCode: number, lastLine = 'FAIL src/box.test.ts > BOX-484 export') => ev('shell:exited', '2026-11-16T14:01:30.000Z', { jobId, exitCode, lastLine, ms: 90_000 });

describe('awaitShelf (Set 4 R2: a long job on the shelf)', () => {
  it('keeps the shelved wait, and knocks in its own chat when the job ends: the result and one offer', () => {
    const s1 = awaitShelf(createInitialState('t'), shelved).state;
    expect(s1.awaits).toEqual([{ job: 'job-7', session: 'session-box', about: 'the build', at: '2026-11-16T14:00:00.000Z' }]);
    const { state, effects } = awaitShelf(s1, exited('job-7', 1));
    expect(state.awaits).toEqual([]);
    expect(effects).toHaveLength(1);
    const p = (effects[0] as { event: { type: string; payload: Record<string, unknown> } }).event;
    expect(p.type).toBe('notice:candidate');
    expect(p.payload).toMatchObject({ kind: 'work-awaited', key: 'work-awaited:job-7', sessionId: 'session-box', observation: 'The build failed with exit code 1. Its last line: "FAIL src/box.test.ts > BOX-484 export".' });
    expect(p.payload.offer).toMatchObject({ tool: 'gnomon_signals', label: 'Show the failing line', args: { signalType: 'shell', contains: 'job-7' } });
    // A job that passed offers its output instead.
    const ok = awaitShelf(s1, exited('job-7', 0, 'built in 88 s')).effects[0] as unknown as { event: { payload: { observation: string; offer: { label: string } } } };
    expect([ok.event.payload.observation, ok.event.payload.offer.label]).toEqual(['The build finished. Its last line: "built in 88 s".', 'Show the output']);
  });

  it("a job nobody shelved, or a row with no chat, knocks nothing; a rig chat's knock stays in its sandbox", () => {
    const s1 = awaitShelf(createInitialState('t'), shelved).state;
    expect(awaitShelf(s1, exited('job-8', 1)).effects).toEqual([]);
    expect(awaitShelf(createInitialState('t'), ev('await:shelved', '2026-11-16T14:00:00.000Z', { job: 'job-7' })).state.awaits).toBeUndefined();
    const rig = { ...s1, rigSessions: { 'session-box': '2026-11-16T13:00:00.000Z' } } as KernelState;
    const { effects } = awaitShelf(rig, exited('job-7', 1));
    expect(effects).toEqual([{ type: 'Notify', channel: 'sandbox-notice', payload: expect.objectContaining({ kind: 'work-awaited', sessionId: 'session-box', sandbox: 'session-box' }) }]);
  });

  it('is in the manifest', () => {
    expect(RULE_MANIFEST.some((r) => r === awaitShelf || r.name === 'awaitShelf')).toBe(true);
  });
});
