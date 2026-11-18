import { describe, expect, it } from 'vitest';
import { STALE_TURN_MS, staleLine, staleTurn } from './stale-turn.js';

const T = 1_800_000_000_000;
const min = (m: number) => T + m * 60_000;
// Run 200 T07's turn, made-up path: a shell read held on an ask nobody answered, the ask running out at five minutes.
const run200 = [
  { type: 'turn/start', time: min(0), data: {} },
  { type: 'step/start', time: min(0), data: {} },
  { type: 'tool/call', time: min(0.05), data: { callId: 'call_1' } },
  { type: 'approval/asked', time: min(0.05), data: { id: 'ap1', callId: 'call_1' } },
  { type: 'approval/decided', time: min(5.05), data: { id: 'ap1', outcome: 'rejected' } },
  { type: 'tool/result', time: min(5.05), data: { message: { toolCallId: 'call_1' } } },
  { type: 'step/start', time: min(5.05), data: {} },
  { type: 'tool/call', time: min(5.15), data: { callId: 'call_2' } },
];

describe('staleTurn (run 202: a run 200 turn kept acting on the screen for 28 minutes)', () => {
  it('a turn that waited out an ask with nobody there is stale, and stays stale for every later call in it', () => {
    expect(staleTurn(run200, min(5.15))).toBe(5 * 60_000);
    expect(staleTurn([...run200, { type: 'tool/result', time: min(5.2), data: { message: { toolCallId: 'call_2' } } }], min(9))).toBe(5 * 60_000);
    expect(staleLine(5 * 60_000)).toBe('This turn sat 5 minutes with no step (an ask nobody answered), so it is withdrawn: do not act. Say in one line that you stopped and why.');
  });

  it('an ask the owner grants late, a long tool run, a turn that ended, or one still moving is not stale', () => {
    const granted = run200.map((e) => (e.type === 'approval/decided' ? { ...e, data: { ...e.data, outcome: 'approved' } } : e));
    expect(staleTurn(granted, min(5.15))).toBeNull();
    const job = [{ type: 'turn/start', time: min(0) }, { type: 'tool/call', time: min(0.1), data: { callId: 'call_9' } }, { type: 'tool/result', time: min(9), data: { message: { toolCallId: 'call_9' } } }];
    expect(staleTurn(job, min(9.1))).toBeNull();
    expect(staleTurn([...run200, { type: 'turn/end', time: min(6) }], min(30))).toBeNull();
    expect(staleTurn(run200.slice(0, 4), min(3))).toBeNull();
  });

  it('a turn silent past the limit with nothing running is stale as of now', () => {
    const silent = [{ type: 'turn/start', time: min(0) }, { type: 'step/start', time: min(0) }];
    expect(staleTurn(silent, T + STALE_TURN_MS - 1)).toBeNull();
    expect(staleTurn(silent, T + STALE_TURN_MS)).toBe(STALE_TURN_MS);
  });
});
