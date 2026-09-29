import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { AgentFleetEntry, Commitment, KernelState, NoticeCandidate, SanitizedEvent, TicketThread } from '@sundial/kernel/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_GATE_POLICY } from './notice-gate.js';
import { decide } from '@sundial/kernel/gate.js';
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
    id: 'commitment:redesign-and-tablet',
    name: 'redesign-and-tablet',
    source: 'git-branch',
    branch: 'feat/redesign-and-tablet',
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

/** Away since `startAt` for `breakMin` (as consecutive zero windows), with `threads` open and the given active window. */
function idleWith(state: KernelState, breakMin: number, threads: Commitment[], active: { processName: string; windowTitle: string } | null = { processName: 'Code', windowTitle: 'gnomon — main.ts' }, startAt = '2026-03-10T09:00:00.000Z'): KernelState {
  return {
    ...state,
    lifeEvent: { ...state.lifeEvent, idle: { consecutiveZeroWindows: Math.round((breakMin * MIN) / WINDOW_MS), isIdle: true, lastActiveAt: startAt } },
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
    expect(candidate!.concerns).toEqual(['commitment:redesign-and-tablet']);
    expect(candidate!.observation).toContain('redesign-and-tablet');
    // The line is kept for the Today card, whatever the gate decides.
    expect(next.resume?.last).toMatchObject({ at: '2026-03-10T09:40:00.000Z', trigger: 'break', line: candidate!.observation, key: candidate!.key });
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

  it('measures the break by the wall clock, so a closed lid counts (U2-F1)', () => {
    // Asleep 40 minutes: the input sensor emitted no zero windows, so the owner never went idle.
    let state = idleWith(base(), 40, [openThread()]);
    state = { ...state, lifeEvent: { ...state.lifeEvent, idle: { consecutiveZeroWindows: 3, isIdle: false, lastActiveAt: '2026-03-10T09:00:00.000Z' } } };
    const candidate = candidateOf(returnFromBreak(state, activity('2026-03-10T09:40:00.000Z')).effects);
    expect(candidate?.surprise).toBeCloseTo(40 / 30, 2);
    expect(candidate?.evidence[0]).toBe('away 40 min');
  });

  it('stays silent with no input seen before — there was nothing to return from', () => {
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
    const c2 = candidateOf(returnFromBreak(idleWith(base(), 50, [openThread({ lastTouchedAt: '2026-03-10T13:30:00.000Z' })], undefined, '2026-03-10T13:50:00.000Z'), activity('2026-03-10T14:40:00.000Z')).effects)!;
    expect(c1.key).toBe('return-from-break:2026-03-10');
    expect(c2.key).toBe(c1.key);
  });

  it('stays silent when the newest open thread was not touched near the break — it is not what the owner left', () => {
    // Last touched at 09:00 the day before; the break began at 09:00 today. A day-old
    // thread is just the newest open branch, not the work stepped away from.
    const stale = openThread({ lastTouchedAt: '2026-03-09T09:00:00.000Z' });
    expect(returnFromBreak(idleWith(base(), 40, [stale]), activity('2026-03-10T09:40:00.000Z')).effects).toEqual([]);
  });

  it('never anchors on a promise heard aloud, however recent (U2-F10)', () => {
    const branch = openThread({ lastTouchedAt: '2026-03-10T08:50:00.000Z' });
    const heard = openThread({ id: 'commitment:send-the-deck', name: 'send the deck', source: 'speech', lastTouchedAt: '2026-03-10T08:59:00.000Z' });
    const candidate = candidateOf(returnFromBreak(idleWith(base(), 40, [branch, heard]), activity('2026-03-10T09:40:00.000Z')).effects);
    expect(candidate?.concerns).toEqual(['commitment:redesign-and-tablet']);
    expect(returnFromBreak(idleWith(base(), 40, [heard]), activity('2026-03-10T09:40:00.000Z')).effects).toEqual([]);
  });

  it('a wake alone says nothing; the first input after it says it once (U2-F2)', () => {
    // The wake event lags the first key in 223 of 399 live wakes, and 55 were dark
    // wakes with no input for 3 minutes: the first real input is the trigger.
    const state = idleWith(base(), 40, [openThread()]);
    const wake: SanitizedEvent = { id: 'w', type: 'system:sleep-wake', ts: '2026-03-10T09:39:00.000Z', payload: { kind: 'wake', source: 'workspace' }, sanitized: true };
    expect(returnFromBreak(state, wake).effects).toEqual([]);
    expect(returnFromBreak(state, zeroActivity('2026-03-10T09:40:00.000Z')).effects).toEqual([]);
    expect(returnFromBreak(state, activity('2026-03-10T09:41:00.000Z')).effects).toHaveLength(1);
  });

  it('leads with the last intent line before the break, from moment:intent (U2-F9)', () => {
    let state = idleWith(base(), 40, [openThread()]);
    state = { ...state, project: { ...state.project, known: { p1: { name: 'gnomon', org: null, remote: null, branch: null } } } };
    const landed = (projectId: string | null, text: string, ts: string): SanitizedEvent => ({ id: `i-${ts}`, type: 'moment:intent', ts, payload: { momentId: 'm', projectId, text }, sanitized: true });
    state = returnFromBreak(state, landed('p1', 'Fixing the retry backoff test', '2026-03-10T08:58:00.000Z')).state;
    // A line only guessed onto a project is not that project's.
    state = returnFromBreak(state, { id: 'g', type: 'moment:intent', ts: '2026-03-10T08:59:00.000Z', payload: { projectId: 'p1', confidence: 'weak', text: 'Watching a video' }, sanitized: true }).state;
    expect(state.resume?.intents.p1.text).toBe('Fixing the retry backoff test');
    // A later line with no project does not displace the work thread's.
    state = returnFromBreak(state, landed(null, 'Reading the news', '2026-03-10T09:01:00.000Z')).state;
    const candidate = candidateOf(returnFromBreak(state, activity('2026-03-10T09:40:00.000Z')).effects)!;
    expect(candidate.observation).toBe('Back after 40 min — Fixing the retry backoff test · gnomon · feat/redesign-and-tablet');
    expect(candidate.evidence).toContain('intent: Fixing the retry backoff test');
    // Another project's branch is not this work.
    const elsewhere = returnFromBreak({ ...state, commitments: { ...state.commitments, open: [openThread({ projectId: 'p2' })] } }, activity('2026-03-10T09:40:00.000Z'));
    expect(candidateOf(elsewhere.effects)!.observation).toBe('Back after 40 min — Fixing the retry backoff test · gnomon');
    // An intent a day old is not what the owner left.
    const stale = returnFromBreak(idleWith(base(), 40, []), landed('p1', 'Old work', '2026-03-09T08:00:00.000Z')).state;
    expect(returnFromBreak(stale, activity('2026-03-10T09:40:00.000Z')).effects).toEqual([]);
  });

  it('keeps the line under 120 characters (U2-F28)', () => {
    let state = idleWith(base(), 40, [openThread({ name: 'x'.repeat(80) })]);
    state = returnFromBreak(state, { id: 'i', type: 'moment:intent', ts: '2026-03-10T08:58:00.000Z', payload: { projectId: 'p1', text: 'y'.repeat(200) }, sanitized: true }).state;
    const candidate = candidateOf(returnFromBreak(state, activity('2026-03-10T09:40:00.000Z')).effects)!;
    expect(candidate.observation.length).toBeLessThanOrEqual(120);
  });

  it('says what the agent was doing, leading when the owner left from Claude (U2-F15 F16)', () => {
    const session = (over: Partial<AgentFleetEntry> = {}): AgentFleetEntry => ({ id: 'abcd1234', cwd: '~/code/puzzlebox', branch: null, state: 'waiting', since: '2026-03-10T08:59:00.000Z', title: 'Fix retry backoff', lastPrompt: 'why does the retry test flake', ...over });
    let state = idleWith(base(), 40, [], { processName: 'Claude', windowTitle: 'Claude' });
    state = returnFromBreak(state, { id: 'i', type: 'moment:intent', ts: '2026-03-10T08:58:00.000Z', payload: { projectId: '~/code/puzzlebox', text: 'Reviewing the retry change' }, sanitized: true }).state;
    state = { ...state, agent: { ...state.agent, fleet: [session({ id: 'other', state: 'working', title: 'Unrelated' }), session()] } };
    const fromClaude = candidateOf(returnFromBreak(state, activity('2026-03-10T09:40:00.000Z')).effects)!;
    expect(fromClaude.observation).toBe('Back after 40 min — Claude waits on "Fix retry backoff" · puzzlebox');
    expect(fromClaude.evidence).toContain('agent: waiting · Fix retry backoff');
    // From the editor, the intent leads and a waiting agent follows.
    const fromEditor = { ...state, window: { ...state.window, active: { processName: 'Code', windowTitle: 'retry.ts', windowId: 'w' } } };
    expect(candidateOf(returnFromBreak(fromEditor, activity('2026-03-10T09:40:00.000Z')).effects)!.observation).toBe('Back after 40 min — Reviewing the retry change · Claude waits on "Fix retry backoff" · puzzlebox');
    // A session the owner prompted just before leaving is theirs, even while it works; untitled, its last prompt names it.
    const attended = { ...state, agent: { ...state.agent, fleet: [session({ id: 'mine', state: 'working', title: undefined })], attended: { id: 'mine', at: '2026-03-10T08:55:00.000Z' } } };
    expect(candidateOf(returnFromBreak(attended, activity('2026-03-10T09:40:00.000Z')).effects)!.observation).toBe('Back after 40 min — Claude was still working on "why does the retry test flake" · puzzlebox');
    // With neither, it names no folder: the project clause already does.
    const bare = { ...state, agent: { ...state.agent, fleet: [session({ title: undefined, lastPrompt: undefined })] } };
    expect(candidateOf(returnFromBreak(bare, activity('2026-03-10T09:40:00.000Z')).effects)!.observation).toBe('Back after 40 min — Claude waits on you · puzzlebox');
  });

  it('names the branch the repository is on, and a ticket only once work reached it (U2-F11 F12)', () => {
    const ticket = (id: string, stage: TicketThread['stage'], pr: TicketThread['pr'] = null): TicketThread => ({ id, firstSeen: '2026-03-10T08:00:00.000Z', lastSeen: '2026-03-10T08:50:00.000Z', days: ['2026-03-10'], sources: {}, stage, commits: 0, pr });
    let state = idleWith(base(), 40, []);
    state = returnFromBreak(state, { id: 'i', type: 'moment:intent', ts: '2026-03-10T08:58:00.000Z', payload: { projectId: 'p1', text: 'Fixing the retry test' }, sanitized: true }).state;
    state = { ...state, project: { ...state.project, known: { p1: { name: 'puzzlebox', org: null, remote: null, branch: 'feature/box-484' } } } };
    // An OCR-only key, seen later, never appears; the branch's own ticket shows only its PR.
    state = { ...state, tickets: { 'BOX-484': ticket('BOX-484', 'pr', { number: 812, state: 'OPEN', reviewState: 'CHANGES_REQUESTED' }), 'BOX-848': ticket('BOX-848', 'seen') } };
    expect(candidateOf(returnFromBreak(state, activity('2026-03-10T09:40:00.000Z')).effects)!.observation).toBe('Back after 40 min — Fixing the retry test · puzzlebox · feature/box-484 · PR #812 changes requested');
    // On a branch that does not name it, a ticket committed to just before the break is named.
    const main = { ...state, project: { ...state.project, known: { p1: { name: 'puzzlebox', org: null, remote: null, branch: 'main' } } }, tickets: { 'BOX-484': ticket('BOX-484', 'commit') } };
    const c = candidateOf(returnFromBreak(main, activity('2026-03-10T09:40:00.000Z')).effects)!;
    expect(c.observation).toBe('Back after 40 min — Fixing the retry test · puzzlebox · main · BOX-484');
    expect(c.evidence).toEqual(expect.arrayContaining(['branch: main', 'ticket: BOX-484 (commit)']));
  });

  it('adds the failing command and the last file, and keeps recent unpushed work for the details (U2-F13 F17 F20 F21)', () => {
    let state = idleWith(base(), 40, []);
    state = returnFromBreak(state, { id: 'i', type: 'moment:intent', ts: '2026-03-10T08:58:00.000Z', payload: { projectId: '~/code/puzzlebox', text: 'Fixing the retry test' }, sanitized: true }).state;
    const win = (documentPath: string, ts: string): SanitizedEvent => ({ id: `w-${ts}`, type: 'window:changed', ts, payload: { processName: 'Code', windowTitle: 'x', documentPath }, sanitized: true });
    state = returnFromBreak(state, win('~/code/puzzlebox/src/retry.ts', '2026-03-10T08:57:00.000Z')).state;
    // A page URL and a tool's cache are not the file the owner left.
    state = returnFromBreak(state, win('https://example.test/a', '2026-03-10T08:58:00.000Z')).state;
    state = returnFromBreak(state, win('~/code/puzzlebox/.claude/worktrees/x/a.ts', '2026-03-10T08:59:00.000Z')).state;
    state = {
      ...state,
      shell: { ...state.shell, lastFailure: { '~/code/puzzlebox': { command: 'pnpm test', exitCode: 1, at: '2026-03-10T08:56:00.000Z' }, '~/elsewhere': { command: 'make', exitCode: 2, at: '2026-03-10T08:59:00.000Z' } } },
      git: { ...state.git, unpushed: { '~/code/puzzlebox': { branch: 'main', ahead: 3, since: '2026-03-10T08:00:00.000Z', updatedAt: '2026-03-10T08:00:00.000Z' } } },
    };
    const { state: next, effects } = returnFromBreak(state, activity('2026-03-10T09:40:00.000Z'));
    expect(candidateOf(effects)!.observation).toBe('Back after 40 min — Fixing the retry test · puzzlebox · `pnpm test` failed · retry.ts');
    expect(next.resume?.last?.pieces).toMatchObject({ file: { path: '~/code/puzzlebox/src/retry.ts', app: 'Code' }, failure: { command: 'pnpm test', exitCode: 1 }, unpushed: { ahead: 3 } });
    // Weeks-old unpushed work is not what the owner left.
    const old = { ...state, git: { ...state.git, unpushed: { '~/code/puzzlebox': { branch: 'main', ahead: 3, since: '2026-02-01T08:00:00.000Z', updatedAt: '2026-02-01T08:00:00.000Z' } } } };
    expect(returnFromBreak(old, activity('2026-03-10T09:40:00.000Z')).state.resume?.last?.pieces.unpushed).toBeUndefined();
  });

  it('a 1-4 h return is pushed, and past the day\'s interruptions it falls to the list (U2-F29)', () => {
    let state = idleWith(base(), 90, []);
    state = returnFromBreak(state, { id: 'i', type: 'moment:intent', ts: '2026-03-10T08:58:00.000Z', payload: { projectId: 'p1', text: 'Fixing the retry test' }, sanitized: true }).state;
    const c = candidateOf(returnFromBreak(state, activity('2026-03-10T10:30:00.000Z')).effects)!;
    const notices = { habituation: {}, day: '2026-03-10', spentToday: 0, phasicToday: 0 };
    expect(decide(DEFAULT_GATE_POLICY, notices, c, '2026-03-10T10:30:00.000Z', '2026-03-10').channel).toBe('phasic');
    expect(decide(DEFAULT_GATE_POLICY, { ...notices, phasicToday: DEFAULT_GATE_POLICY.phasicDailyCap }, c, '2026-03-10T10:30:00.000Z', '2026-03-10').channel).toBe('tonic');
  });

  it('offers the tabs of the Arc space the owner left from (item 5)', () => {
    let state = idleWith(base(), 40, [openThread()], { processName: 'Arc', windowTitle: 'Board' });
    state = returnFromBreak(state, { id: 'arc', type: 'browser:arc-space', ts: '2026-03-10T08:30:00.000Z', payload: { title: 'Work', tabs: [{ url: 'https://example.test/pull/812', title: 'PR 812' }, { nope: 1 }] }, sanitized: true }).state;
    const next = returnFromBreak(state, activity('2026-03-10T09:40:00.000Z')).state;
    expect(next.resume?.last?.pieces.tabs).toEqual({ space: 'Work', tabs: [{ url: 'https://example.test/pull/812', title: 'PR 812' }] });
    // Left from the editor, the browser's space is not what the owner left.
    const fromEditor = { ...state, window: { ...state.window, active: { processName: 'Code', windowTitle: 'x', windowId: 'w' } } };
    expect(returnFromBreak(fromEditor, activity('2026-03-10T09:40:00.000Z')).state.resume?.last?.pieces.tabs).toBeUndefined();
  });

  it('a first return in the morning says what was left yesterday, pushed once (U2-F3)', () => {
    let state = idleWith(base(), 14 * 60, [], undefined, '2026-03-09T18:10:00.000Z');
    state = returnFromBreak(state, { id: 'i', type: 'moment:intent', ts: '2026-03-09T18:05:00.000Z', payload: { projectId: 'p1', text: 'Fixing the retry test' }, sanitized: true }).state;
    const c = candidateOf(returnFromBreak(state, activity('2026-03-10T08:10:00.000Z')).effects)!;
    expect(c.observation).toBe('Morning. You stopped at 18:10 yesterday — Fixing the retry test · p1');
    expect(c.key).toBe('resume-morning:2026-03-10');
    expect(c.valueHalfLifeMs).toBe(10 * MIN);
    expect(c.surprise * c.precision * DEFAULT_GATE_POLICY.concernGain).toBeGreaterThan(DEFAULT_GATE_POLICY.phasicThreshold);
    // The same night, returned to in the afternoon, is not a morning: a line for Today, no push.
    const afternoon = idleWith(base(), 20 * 60, [], undefined, '2026-03-09T18:10:00.000Z');
    const late = returnFromBreak(returnFromBreak(afternoon, { id: 'i', type: 'moment:intent', ts: '2026-03-09T18:05:00.000Z', payload: { projectId: 'p1', text: 'x' }, sanitized: true }).state, activity('2026-03-10T14:10:00.000Z'));
    expect(late.effects).toEqual([]);
    expect(late.state.resume?.last?.trigger).toBe('break');
  });

  it('back from a meeting, says what was left before it, once, to the list (U2-F4)', () => {
    let state = idleWith(base(), 0, []);
    state = { ...state, lifeEvent: { ...state.lifeEvent, idle: { consecutiveZeroWindows: 0, isIdle: false, lastActiveAt: '2026-03-10T09:59:50.000Z' } } };
    state = returnFromBreak(state, { id: 'i', type: 'moment:intent', ts: '2026-03-10T09:55:00.000Z', payload: { projectId: 'p1', text: 'Fixing the retry test' }, sanitized: true }).state;
    state = { ...state, meetings: { seen: { 'Design review|2026-03-10T10:00:00.000Z': { title: 'Design review', start: '2026-03-10T10:00:00.000Z', end: '2026-03-10T10:30:00.000Z', attendees: ['Mira Bakker'], askedAt: null } } } };
    const during = returnFromBreak(state, activity('2026-03-10T10:05:00.000Z'));
    expect(during.effects).toEqual([]);
    // A later meeting-time input keeps the line from before the meeting, not from inside it.
    state = returnFromBreak(returnFromBreak(during.state, { id: 'j', type: 'moment:intent', ts: '2026-03-10T10:20:00.000Z', payload: { projectId: 'p1', text: 'In the design review' }, sanitized: true }).state, activity('2026-03-10T10:25:00.000Z')).state;
    const after = returnFromBreak(state, activity('2026-03-10T10:31:00.000Z'));
    const c = candidateOf(after.effects)!;
    expect(c.observation).toBe('Back from Design review. Before it: Fixing the retry test · p1');
    expect(c.valueHalfLifeMs).toBeNull();
    expect(after.state.resume?.last?.trigger).toBe('meeting-end');
    const moved = { ...after.state, lifeEvent: { ...after.state.lifeEvent, idle: { ...after.state.lifeEvent.idle, lastActiveAt: '2026-03-10T10:31:00.000Z' } } };
    expect(returnFromBreak(moved, activity('2026-03-10T10:32:00.000Z')).effects).toEqual([]);
  });

  describe('returns to a project, off closed moments', () => {
    /** A certain moment on `projectId` closing at `end` after `minutes`. */
    const close = (state: KernelState, projectId: string, end: string, minutes: number) => {
      const s = { ...state, project: { ...state.project, lastClosedMoment: { projectId, confidence: 'certain' as const, endedAt: end, durationMs: minutes * MIN } } };
      return returnFromBreak(s, { id: `c-${end}`, type: 'window:changed', ts: end, payload: {}, sanitized: true });
    };
    const withIntent = (state: KernelState, projectId: string, text: string, ts: string) => returnFromBreak(state, { id: `i-${ts}`, type: 'moment:intent', ts, payload: { projectId, text }, sanitized: true }).state;

    it('back on a project after days: pushed, with the last line on it (U2-F5)', () => {
      let state = withIntent(base(), 'p1', 'Drafting the export spec', '2026-03-02T17:00:00.000Z');
      state = close(state, 'p1', '2026-03-02T17:00:00.000Z', 30).state;
      state = close(state, 'p2', '2026-03-09T12:00:00.000Z', 30).state;
      const back = close(state, 'p1', '2026-03-10T09:10:00.000Z', 5);
      const c = candidateOf(back.effects)!;
      expect(c.observation).toBe('Back on p1 after 7 days — Drafting the export spec');
      expect(c.valueHalfLifeMs).toBe(10 * MIN);
      expect(back.state.resume?.last?.trigger).toBe('project-return');
      // Read once: the same close seen again on the next rule pass says nothing.
      expect(returnFromBreak(back.state, { id: 'again', type: 'clock:tick', ts: '2026-03-10T09:10:00.000Z', payload: {}, sanitized: true }).effects).toEqual([]);
    });

    it('A→B→A the same day, each run ten minutes or more: one line to the list (U2-F6)', () => {
      let state = withIntent(base(), 'p1', 'Fixing the retry test', '2026-03-10T09:30:00.000Z');
      state = close(state, 'p1', '2026-03-10T09:30:00.000Z', 30).state;
      state = close(state, 'p2', '2026-03-10T09:50:00.000Z', 15).state;
      const back = close(state, 'p1', '2026-03-10T09:55:00.000Z', 4);
      const c = candidateOf(back.effects)!;
      expect(c.observation).toBe('Back on p1 — Fixing the retry test');
      expect(c.valueHalfLifeMs).toBeNull();
      // A flip through B for three minutes is not a detour.
      let flip = close(base(), 'p1', '2026-03-10T09:30:00.000Z', 30).state;
      flip = close(flip, 'p2', '2026-03-10T09:33:00.000Z', 3).state;
      expect(close(flip, 'p1', '2026-03-10T09:35:00.000Z', 2).effects).toEqual([]);
    });
  });

  it('the owner\'s leave note leads the next return, and is spent by it (U2-F35)', () => {
    let state = idleWith(base(), 40, [openThread()]);
    state = returnFromBreak(state, { id: 'n', type: 'resume:note', ts: '2026-03-10T08:59:00.000Z', payload: { text: '  re-run the flaky test with --seed 7  ' }, sanitized: true }).state;
    const { state: next, effects } = returnFromBreak(state, activity('2026-03-10T09:40:00.000Z'));
    expect(candidateOf(effects)!.observation).toBe('Back after 40 min — your note: “re-run the flaky test with --seed 7” · gnomon · feat/redesign-and-tablet');
    expect(next.resume?.note).toBeNull();
    expect(next.resume?.last?.pieces.note?.text).toBe('re-run the flaky test with --seed 7');
    // An empty note clears one.
    expect(returnFromBreak(state, { id: 'x', type: 'resume:note', ts: '2026-03-10T09:00:00.000Z', payload: { text: ' ' }, sanitized: true }).state.resume?.note).toBeNull();
  });

  it('counts which pieces were shown and opened, and a line followed back to its project (U2-F36 F37)', () => {
    let state = idleWith(base(), 40, []);
    state = returnFromBreak(state, { id: 'i', type: 'moment:intent', ts: '2026-03-10T08:58:00.000Z', payload: { projectId: '/p1', text: 'Fixing the retry test' }, sanitized: true }).state;
    state = returnFromBreak(state, { id: 'w', type: 'window:changed', ts: '2026-03-10T08:59:00.000Z', payload: { processName: 'Code', documentPath: '/p1/src/retry.ts' }, sanitized: true }).state;
    state = returnFromBreak(state, activity('2026-03-10T09:40:00.000Z')).state;
    state = returnFromBreak(state, { id: 'o', type: 'resume:opened', ts: '2026-03-10T09:41:00.000Z', payload: { piece: 'file' }, sanitized: true }).state;
    // A piece the line did not carry is not counted.
    state = returnFromBreak(state, { id: 'o2', type: 'resume:opened', ts: '2026-03-10T09:41:00.000Z', payload: { piece: 'tabs' }, sanitized: true }).state;
    state = { ...state, project: { ...state.project, lastClosedMoment: { projectId: '/p1', confidence: 'certain', endedAt: '2026-03-10T09:45:00.000Z', durationMs: 5 * MIN } } };
    state = returnFromBreak(state, { id: 'c', type: 'window:changed', ts: '2026-03-10T09:45:00.000Z', payload: {}, sanitized: true }).state;
    expect(state.resume?.learn).toEqual({ pieces: { intent: { shown: 1, opened: 0 }, file: { shown: 1, opened: 1 } }, lines: 1, followed: 1 });
  });

  it('keeps the badges that rose while away for the details, never the line (U2-F25)', () => {
    let state = idleWith(base(), 40, [openThread()]);
    state = { ...state, pressure: { ...state.pressure, byApp: { Slack: { count: 4, since: '2026-03-10T09:20:00.000Z', updatedAt: '2026-03-10T09:20:00.000Z' }, Mail: { count: 9, since: '2026-03-09T09:20:00.000Z', updatedAt: '2026-03-10T09:20:00.000Z' } } } };
    const { state: next, effects } = returnFromBreak(state, activity('2026-03-10T09:40:00.000Z'));
    expect(next.resume?.last?.pieces.badges).toEqual([{ app: 'Slack', count: 4 }]);
    expect(candidateOf(effects)!.observation).not.toContain('Slack');
  });
});
