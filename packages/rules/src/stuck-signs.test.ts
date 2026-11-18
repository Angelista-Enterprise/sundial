import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { AGREE_MS, NOTICE_GAP_MS, pullUpOffer, stuckSigns } from './stuck-signs.js';

const T0 = Date.parse('2026-03-10T09:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const ev = (type: string, sec: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${sec}`, type, ts: at(sec), payload, sanitized: true });
const base = createInitialState('d1');

/** The state the trackers before the rule leave: a failing streak, a failed command, switches. Made-up values. */
const streak = (s: KernelState, sec: number, count: number): KernelState => ({ ...s, shell: { ...s.shell, streak: { command: 'pnpm test --filter puzzlebox', cwd: '~/Projects/puzzlebox-studio', count, exitCode: 1, firstAt: at(0), lastAt: at(sec), noticedAtCount: 0 }, lastFailure: { '~/Projects/puzzlebox-studio': { command: 'pnpm test --filter puzzlebox', exitCode: 1, at: at(sec) } } } });
const switches = (s: KernelState, sec: number): KernelState => ({ ...s, lifeEvent: { ...s.lifeEvent, recentSwitches: Array.from({ length: 6 }, (_, i) => ({ at: at(sec - 60 + i * 10), process: i % 2 ? 'Code' : 'Safari' })) } });

const emitted = (effects: Effect[]) => effects.flatMap((e) => (e.type === 'EmitEvent' ? [{ type: e.event.type, ...e.event.payload }] : []));
function run(steps: [KernelState | ((s: KernelState) => KernelState), SanitizedEvent][]) {
  let state = base;
  const effects: Effect[] = [];
  for (const [prep, event] of steps) {
    state = typeof prep === 'function' ? prep(state) : prep;
    const out = stuckSigns(state, event);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

describe('stuckSigns (plan 15 4.3)', () => {
  it('one sign is a row, not a notice', () => {
    const { effects } = run([[(s) => streak(s, 30, 2), ev('shell:command', 30)]]);
    expect(emitted(effects)).toEqual([{ type: 'stuck:sign', sign: 'test-again', line: '`pnpm test --filter puzzlebox` failed 2 times in a row' }]);
  });

  it('the same sign again inside ten minutes is not a second sign', () => {
    const { effects } = run([[(s) => streak(s, 30, 2), ev('shell:command', 30)], [(s) => streak(s, 90, 3), ev('shell:command', 90)]]);
    expect(emitted(effects).filter((e) => e.type === 'stuck:sign')).toHaveLength(1);
  });

  it('two different signs inside ten minutes make one stuck notice', () => {
    const { effects } = run([[(s) => streak(s, 30, 2), ev('shell:command', 30)], [(s) => switches(s, 200), ev('window:changed', 200)]]);
    const notice = emitted(effects).find((e) => e.type === 'notice:candidate') as Record<string, unknown>;
    expect(notice).toMatchObject({ kind: 'stuck', key: 'stuck:ping-pong+test-again' });
    expect(String(notice.observation)).toMatch(/^You may be stuck: 6 switches between Safari and Code in two minutes, and `pnpm test/);
  });

  it('Round 4: the notice offers to pull up the failing command; a stuck sign with no failed command offers nothing', () => {
    const { effects } = run([[(s) => streak(s, 30, 2), ev('shell:command', 30)], [(s) => switches(s, 200), ev('window:changed', 200)]]);
    const notice = emitted(effects).find((e) => e.type === 'notice:candidate') as Record<string, unknown>;
    expect(notice.offer).toEqual({ tool: 'gnomon_signals', args: { date: '2026-03-10', signalType: 'shell', contains: 'pnpm test --filter puzzlebox', limit: 5 }, label: 'Pull it up' });
    expect(pullUpOffer(switches(base, 200), at(200))).toBeNull();
    // A failure older than the window is not the line the owner is stuck on.
    expect(pullUpOffer(streak(base, 30, 2), at(30 + AGREE_MS / 1000 + 1))).toBeNull();
  });

  it('a second notice waits thirty minutes', () => {
    const later = (NOTICE_GAP_MS / 1000) | 0;
    const { effects } = run([
      [(s) => streak(s, 30, 2), ev('shell:command', 30)],
      [(s) => switches(s, 200), ev('window:changed', 200)],
      [(s) => s, ev('idle:start', 260)],
      [(s) => streak(s, later + 300, 2), ev('shell:command', later + 300)],
      [(s) => switches(s, later + 400), ev('window:changed', later + 400)],
    ]);
    expect(emitted(effects).filter((e) => e.type === 'notice:candidate')).toHaveLength(2);
  });

  it('an error line that goes away and comes back is a sign; one that stays on screen is not', () => {
    const screen = (sec: number) => ev('screen:ocr', sec, { screenText: 'build\nTypeError: undefined is not a function at line 42\nok' });
    const clear = (sec: number) => ev('screen:ocr', sec, { screenText: 'all green' });
    expect(emitted(run([[base, screen(10)]]).effects)).toEqual([]);
    expect(emitted(run([[base, screen(10)], [(s) => s, screen(70)]]).effects)).toEqual([]);
    expect(emitted(run([[base, screen(10)], [(s) => s, clear(40)], [(s) => s, screen(70)]]).effects)).toMatchObject([{ type: 'stuck:sign', sign: 'error-again' }]);
  });

  it('stepping away right after a failure is a sign', () => {
    const { effects } = run([[(s) => streak(s, 30, 1), ev('idle:start', 60)]]);
    expect(emitted(effects)).toMatchObject([{ type: 'stuck:sign', sign: 'idle-after-fail' }]);
  });

  it('other events leave the state as it was', () => {
    expect(stuckSigns(base, ev('clock:tick', 0))).toEqual({ state: base, effects: [] });
  });
});
