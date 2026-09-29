import { describe, it, expect } from 'vitest';
import { accumulateInputActivity, createInputActivityAccumulator } from './index.js';
import type { InputActivitySnapshot } from './input-activity-capture.js';

function snapshot(ts: string, overrides: Partial<InputActivitySnapshot> = {}): InputActivitySnapshot {
  return { timestamp: ts, keyDownCount: 0, mouseClickCount: 0, mouseMoveCount: 0, scrollCount: 0, ...overrides };
}

describe('accumulateInputActivity', () => {
  it('does not emit before the 10s window elapses', () => {
    const acc = createInputActivityAccumulator(0);
    const event = accumulateInputActivity(snapshot('t1', { keyDownCount: 5 }), acc, 3000);
    expect(event).toBeNull();
  });

  it('sums counts across multiple 1s snapshots and emits once the window elapses', () => {
    const acc = createInputActivityAccumulator(0);
    accumulateInputActivity(snapshot('t1', { keyDownCount: 5 }), acc, 1000);
    accumulateInputActivity(snapshot('t2', { keyDownCount: 3, mouseClickCount: 2 }), acc, 2000);

    const event = accumulateInputActivity(snapshot('t3', { scrollCount: 1 }), acc, 10_000);

    expect(event?.payload).toMatchObject({ keyDownCount: 8, mouseClickCount: 2, scrollCount: 1, windowMs: 10_000 });
  });

  it('does not double-count the same snapshot timestamp seen twice', () => {
    const acc = createInputActivityAccumulator(0);
    accumulateInputActivity(snapshot('t1', { keyDownCount: 5 }), acc, 1000);
    accumulateInputActivity(snapshot('t1', { keyDownCount: 5 }), acc, 1500); // same timestamp, stale file re-read

    const event = accumulateInputActivity(null, acc, 10_000);

    expect(event?.payload.keyDownCount).toBe(5);
  });

  it('resets the accumulator after emitting', () => {
    const acc = createInputActivityAccumulator(0);
    accumulateInputActivity(snapshot('t1', { keyDownCount: 5 }), acc, 1000);
    accumulateInputActivity(null, acc, 10_000);

    const secondWindow = accumulateInputActivity(null, acc, 20_000);

    expect(secondWindow?.payload.keyDownCount).toBe(0);
  });

  // lane H (H1)
  it('carries the helper grant flags, and marks a window with no fresh snapshot stale', () => {
    const acc = createInputActivityAccumulator(0);
    accumulateInputActivity(snapshot('t1', { mouseClickCount: 2, listenAccessGranted: false, tapActive: false }), acc, 1000);
    const denied = accumulateInputActivity(null, acc, 10_000);
    expect(denied?.payload).toMatchObject({ listenAccessGranted: false, tapActive: false });
    expect(denied?.payload.stale).toBeUndefined();

    const stale = accumulateInputActivity(null, acc, 20_000);
    expect(stale?.payload.stale).toBe(true);
    expect(stale?.payload.listenAccessGranted).toBeUndefined();
  });
});
