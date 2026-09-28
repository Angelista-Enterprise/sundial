import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Commitment, KernelState, NoticeCandidate, SanitizedEvent } from '@sundial/kernel/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_GATE_POLICY } from './notice-gate.js';
import { returnFromBreak } from './return-from-break.js';

const MIN = 60_000;
const WINDOW_MS = 10_000;

const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function base(): KernelState {
  const s = createInitialState('d1');
  return { ...s, config: { ...s.config, timezone: 'UTC' } };
}

/** An `input:activity` window carrying real input — a genuine return, not another zero window. */
function activity(ts: string, opts: { keys?: number } = {}): SanitizedEvent {
  return { id: `a-${ts}`, type: 'input:activity', ts, payload: { keyDownCount: opts.keys ?? 5, mouseClickCount: 0, mouseMoveCount: 0, scrollCount: 0 }, sanitized: true };
}

/** A zero window — nothing happened. */
function zeroActivity(ts: string): SanitizedEvent {
  return { id: `z-${ts}`, type: 'input:activity', ts, payload: { keyDownCount: 0, mouseClickCount: 0, mouseMoveCount: 0, scrollCount: 0 }, sanitized: true };
}

function openThread(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: 'commitment:redesign-and-ios',
    name: 'redesign-and-ios',
    source: 'git-branch',
    branch: 'feat/redesign-and-ios',
    projectId: 'p1',
    projectName: 'gnomon',
    openedAt: '2026-03-10T08:00:00.000Z',
    lastTouchedAt: '2026-03-10T09:00:00.000Z',
    touches: 4,
    lastTouchUnpushed: 2,
    merged: false,
    activeDays: ['2026-03-09', '2026-03-10'],
    ...overrides,
  };
}

/** Idle for `breakMin` (as consecutive zero windows), with `threads` open and the given active window. */
function idleWith(state: KernelState, breakMin: number, threads: Commitment[], active: { processName: string; windowTitle: string } | null = { processName: 'Code', windowTitle: 'gnomon — main.ts' }): KernelState {
  return {
    ...state,
    lifeEvent: { ...state.lifeEvent, idle: { consecutiveZeroWindows: Math.round((breakMin * MIN) / WINDOW_MS), isIdle: true } },
    commitments: { ...state.commitments, open: threads },
    window: { ...state.window, active: active ? { processName: active.processName, windowTitle: active.windowTitle, windowId: 'w1' } : null },
  };
}

function candidateOf(effects: unknown[]): NoticeCandidate | undefined {
  const e = effects[0] as { event?: { type?: string; payload?: NoticeCandidate } } | undefined;
  return e?.event?.type === 'notice:candidate' ? e.event.payload : undefined;
}

describe('returnFromBreak', () => {
  it('ignores everything but input:activity', () => {
    const state = idleWith(base(), 40, [openThread()]);
    const { state: next, effects } = returnFromBreak(state, { id: 't', type: 'clock:tick', ts: '2026-03-10T09:40:00.000Z', payload: {}, sanitized: true });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('emits a light transition candidate when a long work break ends with a thread to return to', () => {
    const state = idleWith(base(), 40, [openThread()]);
    const { state: next, effects } = returnFromBreak(state, activity('2026-03-10T09:40:00.000Z'));

    const candidate = candidateOf(effects);
    expect(candidate).toBeDefined();
    expect(candidate!.shape).toBe('transition');
    expect(candidate!.kind).toBe('return-from-break');
    // 40 min against a 30-min reference.
    expect(candidate!.surprise).toBeCloseTo(40 / 30, 2);
    expect(candidate!.precision).toBe(0.7);
    // A 40-minute break is AMBIENT: no half-life, so the gate judges it on the tonic
    // path, where it clears the bar and lands as context for the next turn. Sent to
    // the phasic path (the first version), a break this length weighed 0.6 against
    // 1.6 and was dropped 13 times in a week.
    expect(candidate!.valueHalfLifeMs).toBeNull();
    expect(candidate!.concerns).toEqual(['commitment:redesign-and-ios']);
    expect(candidate!.observation).toContain('redesign-and-ios');
    // A pure producer never mutates state.
    expect(next).toBe(state);
  });

  it('names the MOST RECENTLY touched open thread as the one you left', () => {
    const older = openThread({ id: 'commitment:old', name: 'old-thing', lastTouchedAt: '2026-03-10T07:00:00.000Z' });
    const newer = openThread({ id: 'commitment:new', name: 'new-thing', lastTouchedAt: '2026-03-10T08:55:00.000Z' });
    const state = idleWith(base(), 40, [older, newer]);
    const candidate = candidateOf(returnFromBreak(state, activity('2026-03-10T09:40:00.000Z')).effects);
    expect(candidate!.concerns).toEqual(['commitment:new']);
    expect(candidate!.observation).toContain('new-thing');
  });

  it('stays silent when there is no open thread to return to — nothing useful to say', () => {
    const state = idleWith(base(), 40, []);
    expect(returnFromBreak(state, activity('2026-03-10T09:40:00.000Z')).effects).toEqual([]);
  });

  it('stays silent when not idle — no break ended', () => {
    let state = idleWith(base(), 40, [openThread()]);
    state = { ...state, lifeEvent: { ...state.lifeEvent, idle: { consecutiveZeroWindows: 0, isIdle: false } } };
    expect(returnFromBreak(state, activity('2026-03-10T09:40:00.000Z')).effects).toEqual([]);
  });

  it('stays silent on another zero window — that is still the break, not the return', () => {
    const state = idleWith(base(), 40, [openThread()]);
    expect(returnFromBreak(state, zeroActivity('2026-03-10T09:40:00.000Z')).effects).toEqual([]);
  });

  it('stays silent for a pause too short to be a break', () => {
    // 10 minutes — under the 15-minute floor.
    const state = idleWith(base(), 10, [openThread()]);
    expect(returnFromBreak(state, activity('2026-03-10T09:10:00.000Z')).effects).toEqual([]);
  });

  it('stays silent for an absence too long to be a break (overnight / away)', () => {
    // Six hours — beyond the 4-hour cap; a laptop left on, not a break.
    const state = idleWith(base(), 6 * 60, [openThread()]);
    expect(returnFromBreak(state, activity('2026-03-10T15:00:00.000Z')).effects).toEqual([]);
  });

  it('stays silent when returning to leisure rather than a work thread', () => {
    // `classifyActivity` reads only what the taxonomy declares personal — the same
    // owner-curated list production loads into `config.leisureRules`.
    const s = base();
    const withTv: KernelState = { ...s, config: { ...s.config, leisureRules: { ...s.config.leisureRules, processes: { ...s.config.leisureRules.processes, personal: ['TV'] } } } };
    const state = idleWith(withTv, 40, [openThread()], { processName: 'TV', windowTitle: 'Some Show' });
    expect(returnFromBreak(state, activity('2026-03-10T09:40:00.000Z')).effects).toEqual([]);
  });

  it('an ordinary break does not clear the interrupting bar; a very long one can', () => {
    // The gate, not the producer, decides delivery — but a producer whose numbers could
    // never clear the bar would be pointless, and one that always could would be noise.
    const ordinary = candidateOf(returnFromBreak(idleWith(base(), 40, [openThread()]), activity('2026-03-10T09:40:00.000Z')).effects)!;
    const long = candidateOf(returnFromBreak(idleWith(base(), 130, [openThread()]), activity('2026-03-10T11:10:00.000Z')).effects)!;

    // weight = surprise x precision x concernGain (habituation 1 on first fire).
    const weightOf = (c: NoticeCandidate) => c.surprise * c.precision * DEFAULT_GATE_POLICY.concernGain;
    expect(weightOf(ordinary)).toBeLessThan(DEFAULT_GATE_POLICY.phasicThreshold);
    expect(weightOf(long)).toBeGreaterThan(DEFAULT_GATE_POLICY.phasicThreshold);
  });

  it('routes a short break to the tonic path and a long one to the phasic path', () => {
    const short = candidateOf(returnFromBreak(idleWith(base(), 40, [openThread()]), activity('2026-03-10T09:40:00.000Z')).effects)!;
    const long = candidateOf(returnFromBreak(idleWith(base(), 90, [openThread()]), activity('2026-03-10T10:30:00.000Z')).effects)!;
    expect(short.valueHalfLifeMs).toBeNull();
    expect(long.valueHalfLifeMs).toBe(10 * MIN);
    // And the short one now actually clears the bar it is judged against.
    const weightOf = (c: NoticeCandidate) => c.surprise * c.precision * DEFAULT_GATE_POLICY.concernGain;
    expect(weightOf(short)).toBeGreaterThan(DEFAULT_GATE_POLICY.tonicThreshold);
  });

  it('keys once per local day so a second long break habituates instead of re-announcing', () => {
    const c1 = candidateOf(returnFromBreak(idleWith(base(), 40, [openThread()]), activity('2026-03-10T09:40:00.000Z')).effects)!;
    // The thread was picked up again before the afternoon break, so it is still the one left.
    const c2 = candidateOf(returnFromBreak(idleWith(base(), 50, [openThread({ lastTouchedAt: '2026-03-10T13:30:00.000Z' })]), activity('2026-03-10T14:40:00.000Z')).effects)!;
    expect(c1.key).toBe('return-from-break:2026-03-10');
    expect(c2.key).toBe(c1.key);
  });

  it('stays silent when the newest open thread was not touched near the break — it is not what the owner left', () => {
    // Last touched at 09:00 the day before; the break began at 09:00 today. A day-old
    // thread is just the newest open branch, not the work stepped away from.
    const stale = openThread({ lastTouchedAt: '2026-03-09T09:00:00.000Z' });
    expect(returnFromBreak(idleWith(base(), 40, [stale]), activity('2026-03-10T09:40:00.000Z')).effects).toEqual([]);
  });
});
