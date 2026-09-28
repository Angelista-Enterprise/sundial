import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { focusModeTrack } from './focus-mode-track.js';

function event(state: string | undefined, name: string | undefined, ts = '2026-01-01T00:00:00.000Z'): SanitizedEvent {
  return { id: 'e1', type: 'focus-mode:changed', ts, payload: { timestamp: ts, state, name }, sanitized: true };
}

describe('focusModeTrack', () => {
  it('writes a known state and name into state.focusMode', () => {
    const state = createInitialState('d1');
    const { state: next } = focusModeTrack(state, event('work', 'Deep Work'));
    expect(next.focusMode).toEqual({ state: 'work', name: 'Deep Work', since: '2026-01-01T00:00:00.000Z' });
  });

  it('defaults name to null when absent', () => {
    const state = createInitialState('d1');
    const { state: next } = focusModeTrack(state, event('do-not-disturb', undefined));
    expect(next.focusMode.name).toBeNull();
  });

  it('falls back to unknown for an unrecognized raw state string', () => {
    const state = createInitialState('d1');
    const { state: next } = focusModeTrack(state, event('some-future-mode', undefined));
    expect(next.focusMode.state).toBe('unknown');
  });

  it('ignores non-focus-mode:changed events', () => {
    const state = createInitialState('d1');
    const other: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = focusModeTrack(state, other);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
