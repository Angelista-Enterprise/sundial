import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { boundaryTrack } from './boundary-track.js';

const T0 = Date.parse('2026-03-10T09:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ev = (type: string, min: number, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `${type}-${min}`, type, ts: at(min), payload, sanitized: true });

function fold(events: SanitizedEvent[], state: KernelState = createInitialState('d1')) {
  const kinds: unknown[] = [];
  for (const e of events) {
    const out = boundaryTrack(state, e);
    state = out.state;
    for (const fx of out.effects) if (fx.type === 'EmitEvent' && fx.event.type === 'boundary:reached') kinds.push(fx.event.payload.kind);
  }
  return { state, kinds };
}

describe('boundaryTrack (plan 15 step 1)', () => {
  it('a commit, the end of a test or build run, and an agent stop are boundaries', () => {
    const { state, kinds } = fold([
      ev('git:commit', 0),
      ev('shell:command', 1, { command: 'pnpm vitest run', exitCode: 1 }),
      ev('shell:command', 2, { command: 'npx tsc -b tsconfig.json', exitCode: 0 }),
      ev('agent:hook', 3, { event: 'Stop' }),
    ]);
    expect(kinds).toEqual(['commit', 'test-end', 'test-end', 'agent-stop']);
    expect(state.boundary?.last).toEqual({ kind: 'agent-stop', at: at(3) });
  });

  it('other commands, a command with no exit code, and other hooks are not', () => {
    const start = createInitialState('d1');
    const { state, kinds } = fold([ev('shell:command', 0, { command: 'ls -la', exitCode: 0 }), ev('shell:command', 1, { command: 'pnpm vitest run' }), ev('agent:hook', 2, { event: 'PreToolUse' })], start);
    expect(kinds).toEqual([]);
    expect(state).toBe(start);
  });

  it('a return is the end of a break of 15 minutes or more', () => {
    expect(fold([ev('idle:start', 0), ev('idle:end', 9)]).kinds).toEqual([]);
    const long = fold([ev('idle:start', 0), ev('idle:end', 10)]);
    expect(long.kinds).toEqual(['return']);
    expect(long.state.boundary).toEqual({ last: { kind: 'return', at: at(10) }, idleSince: null });
    expect(fold([ev('idle:end', 30)]).kinds).toEqual([]);
  });

  it('a call ends on the event that closed it', () => {
    const base = createInitialState('d1');
    const closed: KernelState = { ...base, av: { call: null, lastCall: { app: 'Zoom', kind: 'work-call', since: at(0), cameraEver: false, until: at(30) } } };
    expect(fold([ev('media:state', 30)], closed).kinds).toEqual(['call-end']);
    expect(fold([ev('media:state', 31)], closed).kinds).toEqual([]);
  });
});
