import { localDate } from '@sundial/helpers/local-day.js';
import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { agentFleetTrack } from './agent-fleet-track.js';

let seq = 0;
const at = (minutes: number) => new Date(Date.parse('2026-09-28T10:00:00.000Z') + minutes * 60_000).toISOString();
const ev = (type: string, payload: Record<string, unknown>, ts: string): SanitizedEvent => ({ id: `e${++seq}`, type, ts, payload, sanitized: true });

/** Daytime, at the keyboard, in Arc — the case the nudge is for. */
function present(front = 'Arc'): KernelState {
  const s = createInitialState('d');
  return { ...s, mind: { ...s.mind, circadian: 'day' }, window: { ...s.window, active: { processName: front, windowTitle: 'YouTube' } as never } };
}
const fleet = (...sessions: Record<string, unknown>[]) => ev('agent:fleet', { sessions }, at(0));
const waiting = { id: 'aaaa1111', cwd: '~/Projects/acme/puzzlebox-studio', branch: 'feature/x', state: 'waiting', since: at(0) };

function run(state: KernelState, events: SanitizedEvent[]) {
  const effects: { type: string; event?: SanitizedEvent }[] = [];
  for (const e of events) {
    const out = agentFleetTrack(state, e);
    state = out.state;
    effects.push(...(out.effects as never[]));
  }
  return { state, candidates: effects.filter((e) => e.type === 'EmitEvent').map((e) => e.event!.payload as Record<string, unknown>) };
}

describe('agentFleetTrack', () => {
  const DAY = localDate(at(0), present().config.timezone);
  it('keeps the latest sample whole and drops malformed sessions', () => {
    const { state } = run(present(), [fleet(waiting, { id: 'b', cwd: '~/x', state: 'sleeping', since: at(0) })]);
    expect(state.agent.fleet).toEqual([waiting]);
  });

  it('keys every wait of one session the same, so the gate habituates a session that keeps asking', () => {
    const again = { ...waiting, since: at(20) };
    const { candidates } = run(present(), [fleet(waiting), ev('clock:tick', {}, at(9)), ev('agent:fleet', { sessions: [again] }, at(20)), ev('clock:tick', {}, at(29))]);
    expect(candidates.map((c) => c.key)).toEqual([`agent-waiting:~/Projects/acme/puzzlebox-studio:${DAY}`, `agent-waiting:~/Projects/acme/puzzlebox-studio:${DAY}`]);
  });

  it('keys by kind, folder and day, not session: a new session in the same checkout is the same stimulus (Q1)', () => {
    const next = { ...waiting, id: 'bbbb2222', since: at(20) };
    const elsewhere = { ...waiting, id: 'cccc3333', cwd: '~/Projects/other', since: at(40) };
    const { candidates } = run(present(), [
      fleet(waiting), ev('clock:tick', {}, at(9)),
      ev('agent:fleet', { sessions: [next] }, at(20)), ev('clock:tick', {}, at(29)),
      ev('agent:fleet', { sessions: [elsewhere] }, at(40)), ev('clock:tick', {}, at(49)),
    ]);
    expect(candidates.map((c) => c.key)).toEqual([`agent-waiting:~/Projects/acme/puzzlebox-studio:${DAY}`, `agent-waiting:~/Projects/acme/puzzlebox-studio:${DAY}`, `agent-waiting:~/Projects/other:${DAY}`]);
  });

  it('an owner typing in a work app is here, not away: the wait is still said', () => {
    const base = present();
    const typing = { ...base, moment: { rollup: { processName: 'Xcode', windowTitles: ['main.swift'], inputEventCount: 900, micActive: false, cameraActive: false, calendarActive: false } } } as never as KernelState;
    const { state, candidates } = run(typing, [fleet(waiting), ev('clock:tick', {}, at(9))]);
    expect(state.agent.away ?? null).toBeNull();
    expect(candidates.map((c) => c.kind)).toEqual(['agent-waiting']);
  });

  it('says nothing for a short wait, then once for a long one', () => {
    const { candidates } = run(present(), [fleet(waiting), ev('clock:tick', {}, at(3)), ev('clock:tick', {}, at(7)), ev('clock:tick', {}, at(9))]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kind: 'agent-waiting', key: `agent-waiting:~/Projects/acme/puzzlebox-studio:${DAY}`, precision: 0.85 });
    expect(candidates[0].observation).toBe('Your Claude session in puzzlebox-studio (feature/x) finished 7 min ago and is waiting for you.');
  });

  it('a new wait on the same session is a new candidate', () => {
    const { candidates } = run(present(), [fleet(waiting), ev('clock:tick', {}, at(6)), fleet({ ...waiting, since: at(10) }), ev('clock:tick', {}, at(16))]);
    expect(candidates).toHaveLength(2);
  });

  it('is quiet while the owner is in an agent host, idle, or it is evening', () => {
    const inClaude = run(present('Claude'), [fleet(waiting), ev('clock:tick', {}, at(8))]);
    const idle = present();
    const asleep = run({ ...idle, lifeEvent: { ...idle.lifeEvent, idle: { ...idle.lifeEvent.idle, isIdle: true } } }, [fleet(waiting), ev('clock:tick', {}, at(8))]);
    const evening = run({ ...present(), mind: { ...present().mind, circadian: 'evening' } }, [fleet(waiting), ev('clock:tick', {}, at(8))]);
    expect([inClaude.candidates, asleep.candidates, evening.candidates]).toEqual([[], [], []]);
  });

  it('ignores working sessions and waits older than two hours', () => {
    const { candidates } = run(present(), [fleet({ ...waiting, state: 'working' }, { ...waiting, id: 'old', cwd: '~/Projects/other', since: at(-200) }), ev('clock:tick', {}, at(8))]);
    expect(candidates).toEqual([]);
  });

  it('names a pending tool call as a possible approval, and counts the others', () => {
    const { candidates } = run(present(), [fleet({ ...waiting, state: 'tool', branch: 'main' }, { ...waiting, id: 'bbbb2222', cwd: '~/Projects/other', state: 'tool', since: at(2) }), ev('clock:tick', {}, at(9))]);
    expect(candidates[0]).toMatchObject({ kind: 'agent-tool-pending', precision: 0.5 });
    expect(candidates[0].observation).toBe('Your Claude session in puzzlebox-studio has been on one tool call for 9 min — it may be waiting for your approval. 1 more session waiting too.');
  });

  it('one notice kind per wait, named by the session title (U3-F14)', () => {
    const typed = (state: string, extra: Record<string, unknown> = {}) =>
      run(present(), [fleet({ ...waiting, state, source: 'registry', title: 'Fix the checkout timeout', ...extra }), ev('clock:tick', {}, at(4))]).candidates[0];
    expect(typed('permission')).toMatchObject({ kind: 'agent-permission', precision: 0.9, valueHalfLifeMs: 10 * 60_000, observation: "Your Claude session 'Fix the checkout timeout' in puzzlebox-studio (feature/x) has waited 4 min for your approval." });
    expect(typed('question').kind).toBe('agent-question');
    expect(typed('plan').kind).toBe('agent-plan');
    expect(typed('failed', { error: 'rate_limit' }).observation).toContain('stopped on a rate limit 4 min ago');
    // A finished turn is not yet worth saying at four minutes.
    expect(typed('waiting')).toBeUndefined();
  });

  it('at the same wait an approval outranks a finished turn, and the transcript is trusted least', () => {
    const both = run(present(), [fleet({ ...waiting, id: 'done0001', source: 'registry' }, { ...waiting, id: 'perm0002', cwd: '~/Projects/other', state: 'permission', source: 'registry' }), ev('clock:tick', {}, at(10))]);
    expect(both.candidates[0]).toMatchObject({ kind: 'agent-permission' });
    const surprise = (c: Record<string, unknown>) => (c.surprise as number) * (c.precision as number);
    const done = run(present(), [fleet({ ...waiting, source: 'registry' }), ev('clock:tick', {}, at(10))]).candidates[0];
    expect(surprise(both.candidates[0])).toBeGreaterThan(surprise(done));
    expect(run(present(), [fleet({ ...waiting, source: 'transcript' }), ev('clock:tick', {}, at(10))]).candidates[0].precision).toBe(0.6);
  });

  it('falls back to the last prompt when a session has no title', () => {
    const c = run(present(), [fleet({ ...waiting, lastPrompt: 'make the retry loop back off' }), ev('clock:tick', {}, at(7))]).candidates[0];
    expect(c.observation).toBe("Your Claude session 'make the retry loop back off' in puzzlebox-studio (feature/x) finished 7 min ago and is waiting for you.");
  });

  it('warns once when two sessions work in one checkout, even from inside Claude', () => {
    const a = { ...waiting, id: 'a1', cwd: '~/Projects/sundial', state: 'working' };
    const b = { ...waiting, id: 'b2', cwd: '~/Projects/sundial', state: 'tool' };
    const { candidates, state } = run(present('Claude'), [fleet(a, b), fleet(a, b, { ...waiting, id: 'c3' })]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kind: 'agent-shared-checkout', precision: 0.9 });
    expect(candidates[0].observation).toContain('2 Claude sessions are open in ~/Projects/sundial at the same time');
    expect(state.agent.nudged).toContain('collide:~/Projects/sundial');
  });

  it('a worktree is not a collision', () => {
    const a = { ...waiting, id: 'a1', cwd: '~/Projects/sundial', state: 'working' };
    const { candidates } = run(present(), [fleet(a, { ...a, id: 'c3', cwd: '~/Projects/sundial/.claude/worktrees/x' })]);
    expect(candidates).toEqual([]);
  });

  /** N3 — a turn end used to hide the collision for one sample, prune `nudged`, and re-announce it on the next turn. */
  it('a session that ends its turn still holds the checkout, so the warning is not repeated', () => {
    const a = { ...waiting, id: 'a1', cwd: '~/Projects/sundial', state: 'working' };
    const b = { ...waiting, id: 'b2', cwd: '~/Projects/sundial', state: 'tool' };
    const bWaits = { ...b, state: 'waiting' };
    const { candidates } = run(present(), [fleet(a, b), fleet(a, bWaits), fleet(a, b), fleet(a, bWaits, { ...a, id: 'c3' })]);
    expect(candidates).toHaveLength(1);
  });

  it('a session waiting over 30 minutes no longer holds the checkout', () => {
    const a = { ...waiting, id: 'a1', cwd: '~/Projects/sundial', state: 'working', since: at(40) };
    const quit = { ...waiting, id: 'b2', cwd: '~/Projects/sundial', state: 'waiting', since: at(0) };
    const sample = (minutes: number) => ev('agent:fleet', { sessions: [a, quit] }, at(minutes));
    expect(run(present(), [sample(30)]).candidates).toHaveLength(1);
    expect(run(present(), [sample(31)]).candidates).toEqual([]);
  });

  describe('hooks (U3-F8, F13)', () => {
    const hook = (event: string, minutes: number, extra: Record<string, unknown> = {}) => ev('agent:hook', { event, session: 'aaaa1111', ...extra }, at(minutes));
    const working = { ...waiting, state: 'working', source: 'registry' };

    it('a permission prompt is known at once, trusted most, and survives the next registry sample', () => {
      const { state, candidates } = run(present(), [fleet(working), hook('Notification', 1, { detail: 'permission_prompt' }), fleet(working), ev('clock:tick', {}, at(5))]);
      expect(state.agent.fleet![0]).toMatchObject({ state: 'permission', since: at(1), source: 'hook' });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ kind: 'agent-permission', precision: 0.95 });
    });

    it('idle_prompt a minute after Stop is the same wait, not a second one', () => {
      const { candidates } = run(present(), [fleet(working), hook('Stop', 1), ev('clock:tick', {}, at(7)), hook('Notification', 2, { detail: 'idle_prompt' }), ev('clock:tick', {}, at(9))]);
      expect(candidates.map((c) => c.kind)).toEqual(['agent-waiting']);
    });

    it('a failed turn carries its error type; SessionEnd takes the session out', () => {
      const failed = run(present(), [fleet(working), hook('StopFailure', 1, { detail: 'rate_limit' })]).state.agent.fleet![0];
      expect(failed).toMatchObject({ state: 'failed', error: 'rate_limit' });
      const ended = run(present(), [fleet(working), hook('SessionEnd', 1, { detail: 'prompt_input_exit' }), fleet(working)]).state.agent.fleet;
      expect(ended).toEqual([]);
    });

    it('a newer registry state wins over an older hook', () => {
      const { state } = run(present(), [hook('Notification', 1, { detail: 'permission_prompt' }), fleet({ ...working, since: at(2) })]);
      expect(state.agent.fleet![0]).toMatchObject({ state: 'working', since: at(2) });
    });

    it('inside Claude, only another session\'s question or approval is said — never the one the owner is typing to', () => {
      const b = { ...waiting, id: 'bbbb2222', cwd: '~/Projects/other', state: 'permission', source: 'registry' };
      const c = { ...waiting, id: 'cccc3333', cwd: '~/Projects/third', state: 'waiting', source: 'registry' };
      const a = { ...waiting, state: 'permission', source: 'registry' };
      const typedTo = run(present('Claude'), [fleet(a, b, c), ev('agent:hook', { event: 'UserPromptSubmit', session: 'aaaa1111' }, at(1)), ev('clock:tick', {}, at(8)), ev('clock:tick', {}, at(9))]);
      expect(typedTo.state.agent.attended).toEqual({ id: 'aaaa1111', at: at(1) });
      // Blocked on the owner: keyed by its session, so an earlier one never wears it down.
      expect(typedTo.candidates.map((x) => x.key)).toEqual(['agent-permission:bbbb2222']);
      // Without a prompt hook the app is taken as the owner being with all of them.
      expect(run(present('Claude'), [fleet(a, b, c), ev('clock:tick', {}, at(8))]).candidates).toEqual([]);
    });
  });

  it('a busy session on one tool call for 15 min may be stuck; a transcript-only one may be an approval (U3-F32)', () => {
    const busy = { ...waiting, state: 'tool', source: 'registry' };
    expect(run(present(), [fleet(busy), ev('clock:tick', {}, at(10))]).candidates).toEqual([]);
    const c = run(present(), [fleet(busy), ev('clock:tick', {}, at(16))]).candidates[0];
    expect(c).toMatchObject({ kind: 'agent-stuck', precision: 0.6 });
    expect(c.observation).toContain('with no result — it may be stuck');
  });

  it('the same failing call five times is said once, while it lasts (U3-F33)', () => {
    const loop = { ...waiting, state: 'working', source: 'registry', repeats: 5 };
    const { candidates } = run(present(), [fleet(loop), ev('clock:tick', {}, at(1)), fleet({ ...loop, repeats: 6 }), ev('clock:tick', {}, at(2))]);
    expect(candidates.map((c) => c.kind)).toEqual(['agent-looping']);
    expect(candidates[0].observation).toContain('same failing tool call 5 times in a row');
    expect(run(present(), [fleet({ ...loop, repeats: 4 }), ev('clock:tick', {}, at(1))]).candidates).toEqual([]);
  });

  describe('collisions from hooks (U3-F23, F24)', () => {
    const edit = (session: string, file: string, minutes: number) => ev('agent:hook', { event: 'PostToolUse', session, cwd: '~/Projects/sundial', tool: 'Edit', file }, at(minutes));
    const changed = (relPath: string, minutes: number) => ev('file:changed', { projectRoot: '~/Projects/sundial', changes: [{ relPath, kind: 'modify' }] }, at(minutes));

    it('two sessions editing one file is said once; different files are not a collision', () => {
      const { candidates } = run(present(), [edit('a1', 'src/x.ts', 0), edit('b2', 'src/y.ts', 1), edit('b2', 'src/x.ts', 2), edit('a1', 'src/x.ts', 3)]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ kind: 'agent-file-collision', precision: 0.95 });
      expect(candidates[0].observation).toBe("Two Claude sessions edited src/x.ts in sundial within ten minutes of each other — one may undo the other's change.");
      // Past the window the older edit no longer counts.
      expect(run(present(), [edit('a1', 'src/x.ts', 0), edit('b2', 'src/x.ts', 11)]).candidates).toEqual([]);
    });

    it('the owner changing a file an agent did not touch, while it works there, is said once per turn', () => {
      const a = { ...waiting, id: 'a1', cwd: '~/Projects/sundial', state: 'working', source: 'registry', title: 'Split the gate' };
      const { candidates } = run(present('Code'), [fleet(a), edit('a1', 'src/agent.ts', 1), changed('src/agent.ts', 1), changed('README.md', 2), changed('docs/x.md', 3)]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ kind: 'agent-owner-collision', precision: 0.7 });
      expect(candidates[0].observation).toBe("You are changing README.md in sundial while your Claude session 'Split the gate' is mid-turn there.");
    });

    it('no owner collision without the session\'s hooks, or when the agent is not working', () => {
      const a = { ...waiting, id: 'a1', cwd: '~/Projects/sundial', state: 'working', source: 'registry' };
      expect(run(present('Code'), [fleet(a), changed('README.md', 2)]).candidates).toEqual([]);
      expect(run(present('Code'), [edit('a1', 'x', 0), fleet({ ...a, state: 'waiting', since: at(1) }), changed('README.md', 2)]).candidates).toEqual([]);
    });
  });

  describe('digest on return (U3-F16)', () => {
    const onCall = (st: KernelState): KernelState => ({ ...st, av: { ...st.av, call: { app: 'zoom.us', kind: 'work-call', since: at(0), cameraEver: false } } });
    const offCall = (st: KernelState): KernelState => ({ ...st, av: { ...st.av, call: null } });
    const s3 = [
      { ...waiting, id: 'a1', cwd: '~/Projects/a', state: 'waiting', source: 'registry', since: at(5) },
      { ...waiting, id: 'b2', cwd: '~/Projects/b', state: 'permission', source: 'registry', since: at(10), title: 'Migrate the ledger' },
      { ...waiting, id: 'c3', cwd: '~/Projects/c', state: 'waiting', source: 'registry', since: at(20) },
    ];

    it('three waits during a call are one candidate when it ends, and none of them is said again', () => {
      let st = onCall(present());
      const first = run(st, [fleet(), ev('clock:tick', {}, at(1)), ev('agent:fleet', { sessions: s3 }, at(25)), ev('clock:tick', {}, at(30))]);
      expect(first.candidates).toEqual([]);
      st = offCall(first.state);
      const back = run(st, [ev('clock:tick', {}, at(40)), ev('clock:tick', {}, at(41)), ev('clock:tick', {}, at(50))]);
      expect(back.candidates).toHaveLength(1);
      // Keyed by the owner's day, not the away start, so a second digest that day habituates.
      expect(back.candidates[0]).toMatchObject({ kind: 'agent-digest', key: 'agent-digest:2026-09-28', precision: 0.9 });
      expect(back.candidates[0].observation).toBe("While you were away, your Claude sessions: 1 needs your approval ('Migrate the ledger' in b (feature/x)), 2 finished.");
    });

    it('a single wait while away is left to the ordinary notice', () => {
      const idle = present();
      const away = run({ ...idle, lifeEvent: { ...idle.lifeEvent, idle: { ...idle.lifeEvent.idle, isIdle: true } } }, [ev('agent:fleet', { sessions: [s3[0]] }, at(6)), ev('clock:tick', {}, at(7))]);
      expect(away.state.agent.away).toBe(at(7));
      const back = run({ ...away.state, lifeEvent: idle.lifeEvent }, [ev('clock:tick', {}, at(20)), ev('clock:tick', {}, at(21))]);
      expect(back.candidates.map((c) => c.kind)).toEqual(['agent-waiting']);
    });
  });

  it('an agent\'s PR going red is said once per failure (U3-F36)', () => {
    const a = { ...waiting, id: 'a1', state: 'working', source: 'registry' };
    const pr = (checkState: string, minutes: number, branch = 'feature/x') => ev('git:pr-status', { cwd: waiting.cwd, branch, number: 42, checkState, url: 'https://github.com/acme/puzzlebox-studio/pull/42' }, at(minutes));
    const { candidates } = run(present(), [fleet(a), pr('pending', 1), pr('failure', 2), fleet(a), pr('failure', 3), pr('success', 4), pr('failure', 5)]);
    expect(candidates.map((c) => c.kind)).toEqual(['agent-pr-red', 'agent-pr-red']);
    expect(candidates[0].observation).toBe('The checks failed on PR #42, which your Claude session in puzzlebox-studio (feature/x) is working on — https://github.com/acme/puzzlebox-studio/pull/42.');
    expect(run(present(), [fleet(a), pr('failure', 2, 'feature/other')]).candidates).toEqual([]);
  });

  it('a finished session says what it leaves to review (U3-F35)', () => {
    const c = run(present(), [fleet({ ...waiting, lines: { added: 120, removed: 30 }, pr: { number: 42, url: 'https://github.com/acme/puzzlebox-studio/pull/42' } }), ev('clock:tick', {}, at(7))]).candidates[0];
    expect(c.observation).toBe('Your Claude session in puzzlebox-studio (feature/x) finished 7 min ago and is waiting for you (+120 −30, PR #42).');
  });

  it('learns the owner\'s own wait threshold per kind, and says so with n (U3-F21)', () => {
    const w = (min: number) => ({ ...waiting, id: 'a1', source: 'registry', since: at(min) });
    const back = (min: number) => ({ ...waiting, id: 'a1', source: 'registry', state: 'working', since: at(min) });
    const events: SanitizedEvent[] = [];
    // 20 answered waits of 10 minutes each.
    for (let i = 0; i < 20; i++) events.push(ev('agent:fleet', { sessions: [w(i * 20)] }, at(i * 20)), ev('agent:fleet', { sessions: [back(i * 20 + 10)] }, at(i * 20 + 10)));
    const { state } = run(present(), events);
    expect(state.agent.waits?.waiting).toHaveLength(20);
    const t0 = 500;
    const quiet = run(state, [ev('agent:fleet', { sessions: [w(t0)] }, at(t0)), ev('clock:tick', {}, at(t0 + 7))]);
    expect(quiet.candidates).toEqual([]);
    const said = run(quiet.state, [ev('clock:tick', {}, at(t0 + 11))]).candidates[0];
    expect(said.kind).toBe('agent-waiting');
    expect(said.evidence).toContain("said after 10 min: the owner's p75, n = 20");
    // Below 20 the default holds, and the evidence says so.
    expect(run(present(), [fleet(waiting), ev('clock:tick', {}, at(6))]).candidates[0].evidence).toContain('said after 5 min: the default, n = 0');
  });
});
