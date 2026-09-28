import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { networkTrack } from './network-track.js';

function event(payload: Record<string, unknown>, ts = '2026-01-01T00:00:00.000Z'): SanitizedEvent {
  return { id: 'e1', type: 'location:network', ts, payload, sanitized: true };
}

describe('networkTrack', () => {
  it('writes fingerprint and label (from ssid)', () => {
    const state = createInitialState('d1');
    const { state: next } = networkTrack(state, event({ fingerprint: 'abc123', ssid: 'HomeWifi' }));
    expect(next.network).toEqual({ fingerprint: 'abc123', label: 'HomeWifi' });
  });

  it('falls back to sname when ssid is absent', () => {
    const state = createInitialState('d1');
    const { state: next } = networkTrack(state, event({ fingerprint: 'abc123', sname: 'Office Ethernet' }));
    expect(next.network.label).toBe('Office Ethernet');
  });

  it('defaults fingerprint to empty string when missing', () => {
    const state = createInitialState('d1');
    const { state: next } = networkTrack(state, event({}));
    expect(next.network.fingerprint).toBe('');
  });

  it('ignores non-location:network events', () => {
    const state = createInitialState('d1');
    const other: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = networkTrack(state, other);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
