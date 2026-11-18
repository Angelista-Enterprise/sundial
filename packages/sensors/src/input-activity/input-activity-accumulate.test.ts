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

  it("adds nothing for the helper's hand rewrite: the same window's counts and timestamp, only a newer lastKeyAt", () => {
    // Set 3: a hardware key rewrites the file within ~100 ms (macos-input-helper.swift `writeHand`); the counts stay the last window's.
    const acc = createInputActivityAccumulator(0);
    const window = snapshot('t1', { keyDownCount: 5, ownerOnly: true, ownerKeyDownCount: 5, ownerClickCount: 0, lastKeyAt: '2026-11-15T10:00:00.500Z' });
    accumulateInputActivity(window, acc, 1000);
    accumulateInputActivity({ ...window, lastKeyAt: '2026-11-15T10:00:00.900Z' }, acc, 1100);
    accumulateInputActivity({ ...window, lastKeyAt: '2026-11-15T10:00:01.000Z' }, acc, 1200);
    const event = accumulateInputActivity(null, acc, 10_000);
    expect(event?.payload.keyDownCount).toBe(5);
    expect(event?.payload.ownerKeyDownCount).toBe(5);
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

  // Set 2 R5
  it("passes the owner's hardware counts and newest times through, and nothing from an older helper", () => {
    const acc = createInputActivityAccumulator(0);
    accumulateInputActivity(snapshot('t1', { keyDownCount: 4, ownerOnly: true, ownerKeyDownCount: 1, ownerClickCount: 0, lastKeyAt: '2026-11-15T09:00:01.000Z' }), acc, 1000);
    accumulateInputActivity(snapshot('t2', { mouseClickCount: 1, ownerOnly: true, ownerKeyDownCount: 0, ownerClickCount: 1, lastKeyAt: '2026-11-15T09:00:01.000Z', lastClickAt: '2026-11-15T09:00:02.500Z' }), acc, 2000);
    const owned = accumulateInputActivity(null, acc, 10_000);
    expect(owned?.payload).toMatchObject({ keyDownCount: 4, ownerOnly: true, ownerKeyDownCount: 1, ownerClickCount: 1, lastKeyAt: '2026-11-15T09:00:01.000Z', lastClickAt: '2026-11-15T09:00:02.500Z' });

    accumulateInputActivity(snapshot('t3', { keyDownCount: 2 }), acc, 11_000);
    const old = accumulateInputActivity(null, acc, 20_000);
    expect(old?.payload.keyDownCount).toBe(2);
    expect(old?.payload.ownerOnly).toBeUndefined();
    expect(old?.payload.lastKeyAt).toBeUndefined();
  });
});
