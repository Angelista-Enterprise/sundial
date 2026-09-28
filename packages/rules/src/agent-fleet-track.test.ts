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
  it('keeps the latest sample whole and drops malformed sessions', () => {
    const { state } = run(present(), [fleet(waiting, { id: 'b', cwd: '~/x', state: 'sleeping', since: at(0) })]);
    expect(state.agent.fleet).toEqual([waiting]);
  });

  it('says nothing for a short wait, then once for a long one', () => {
    const { candidates } = run(present(), [fleet(waiting), ev('clock:tick', {}, at(3)), ev('clock:tick', {}, at(7)), ev('clock:tick', {}, at(9))]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kind: 'agent-waiting', key: `agent-waiting:aaaa1111@${at(0)}`, precision: 0.85 });
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
    const { candidates } = run(present(), [fleet({ ...waiting, state: 'working' }, { ...waiting, id: 'old', since: at(-200) }), ev('clock:tick', {}, at(8))]);
    expect(candidates).toEqual([]);
  });

  it('names a pending tool call as a possible approval, and counts the others', () => {
    const { candidates } = run(present(), [fleet({ ...waiting, state: 'tool', branch: 'main' }, { ...waiting, id: 'bbbb2222', since: at(2) }), ev('clock:tick', {}, at(9))]);
    expect(candidates[0]).toMatchObject({ kind: 'agent-tool-pending', precision: 0.5 });
    expect(candidates[0].observation).toBe('Your Claude session in puzzlebox-studio has been on one tool call for 9 min — it may be waiting for your approval (1 more waiting).');
  });

  it('warns once when two sessions work in one checkout, even from inside Claude', () => {
    const a = { ...waiting, id: 'a1', cwd: '~/Projects/sundial', state: 'working' };
    const b = { ...waiting, id: 'b2', cwd: '~/Projects/sundial', state: 'tool' };
    const { candidates, state } = run(present('Claude'), [fleet(a, b), fleet(a, b, { ...waiting, id: 'c3' })]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kind: 'agent-shared-checkout', precision: 0.9 });
    expect(candidates[0].observation).toContain('2 Claude sessions are working in ~/Projects/sundial at the same time');
    expect(state.agent.nudged).toContain('collide:~/Projects/sundial:a1+b2');
  });

  it('a waiting session and a worktree are not collisions', () => {
    const a = { ...waiting, id: 'a1', cwd: '~/Projects/sundial', state: 'working' };
    const { candidates } = run(present(), [fleet(a, { ...waiting, id: 'b2', cwd: '~/Projects/sundial' }, { ...a, id: 'c3', cwd: '~/Projects/sundial/.claude/worktrees/x' })]);
    expect(candidates).toEqual([]);
  });
});
