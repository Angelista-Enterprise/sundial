import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { fileWatcherCapacity } from './file-watcher-capacity.js';

function ev(type: string, payload: Record<string, unknown>): SanitizedEvent {
  return { id: 'e1', type, ts: '2026-01-01T00:00:00.000Z', payload, sanitized: true };
}

describe('fileWatcherCapacity', () => {
  it('emits a Notify effect naming the rejected root on file-watcher:capacity', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = fileWatcherCapacity(
      state,
      ev('file-watcher:capacity', { maxRoots: 10, activeRoots: ['/a', '/b'], rejectedRoot: '/c' }),
    );
    expect(next).toBe(state); // pure projection, no state change
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      type: 'Notify',
      channel: 'file-watcher-capacity',
      payload: { rejectedRoot: '/c', maxRoots: 10, activeRoots: ['/a', '/b'] },
    });
  });

  it('ignores unrelated events', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = fileWatcherCapacity(state, ev('file:changed', {}));
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
