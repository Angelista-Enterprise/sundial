import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import { isUnchangedObservation, MAX_OBSERVED_ENTRIES, stateSignature } from '@sundial/kernel/state-signature.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { observedTrack } from './observed-track.js';

function event(type: string, payload: Record<string, unknown>, ts = '2026-07-29T12:00:00.000Z'): SanitizedEvent {
  return { id: `e-${type}-${ts}`, type, ts, payload, sanitized: true };
}

/** What the daemon's ingest gate asks: would this event be dropped as unchanged? */
function wouldDrop(state: KernelState, e: SanitizedEvent): boolean {
  const sig = stateSignature(e.type, e.payload as Record<string, unknown>);
  return sig !== null && isUnchangedObservation(state.observed, sig);
}

describe('observedTrack', () => {
  it('records a state observation so the next identical one can be dropped', () => {
    const net = { timestamp: '2026-07-29T12:00:00.000Z', fingerprint: 'net2_abc', gatewayIp: '192.168.1.1' };
    let state = createInitialState('d1');

    expect(wouldDrop(state, event('location:network', net))).toBe(false);
    state = observedTrack(state, event('location:network', net)).state;
    // Same payload, later timestamp — the restart re-emit, byte-identical apart
    // from when it was taken.
    expect(wouldDrop(state, event('location:network', { ...net, timestamp: '2026-07-29T13:00:00.000Z' }))).toBe(true);
  });

  it('lets a genuine change through', () => {
    let state = createInitialState('d1');
    state = observedTrack(state, event('location:network', { fingerprint: 'net2_home', gatewayIp: '192.168.1.1' })).state;
    expect(wouldDrop(state, event('location:network', { fingerprint: 'net2_tether', gatewayIp: '172.20.10.1' }))).toBe(false);
  });

  /**
   * The reason the signature is the whole payload rather than chosen fields:
   * `system:power` carries a battery percentage that changes legitimately, and a
   * hand-picked `(source, charging)` signature would have stopped recording it.
   */
  it('does not suppress a payload that differs only in a continuously-varying field', () => {
    let state = createInitialState('d1');
    state = observedTrack(state, event('system:power', { source: 'ac', charging: true, batteryPercent: 79 })).state;
    expect(wouldDrop(state, event('system:power', { source: 'ac', charging: true, batteryPercent: 80 }))).toBe(false);
  });

  /** Two repositories are two subjects, not one changing state. */
  it('scopes git:status per repository', () => {
    let state = createInitialState('d1');
    const a = { cwd: '~/p/a', branch: 'main', dirtyFiles: 0 };
    const b = { cwd: '~/p/b', branch: 'main', dirtyFiles: 0 };
    state = observedTrack(state, event('git:status', a)).state;

    expect(wouldDrop(state, event('git:status', a))).toBe(true);
    // Identical apart from the repo — must not be mistaken for a repeat of A.
    expect(wouldDrop(state, event('git:status', b))).toBe(false);
  });

  describe('occurrences are never deduplicated', () => {
    /**
     * The allow-list exists for this: two identical payloads can be two real
     * events, and there is no way to tell from the payload alone.
     */
    it('leaves an undeclared type alone even when the payload repeats exactly', () => {
      let state = createInitialState('d1');
      const cmd = { command: 'npm test', cwd: '~/p/a', exitCode: 0 };
      state = observedTrack(state, event('shell:command', cmd)).state;
      expect(wouldDrop(state, event('shell:command', cmd))).toBe(false);
      expect(state.observed).toEqual({});
    });

    it('does not record window changes, which repeat constantly and legitimately', () => {
      const state = observedTrack(createInitialState('d1'), event('window:changed', { processName: 'Code' })).state;
      expect(state.observed).toEqual({});
    });
  });

  it('emits no effects — it exists purely to remember', () => {
    const { effects } = observedTrack(createInitialState('d1'), event('location:network', { fingerprint: 'x' }));
    expect(effects).toEqual([]);
  });

  it('bounds the map so a pathological number of scopes cannot grow the snapshot', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < MAX_OBSERVED_ENTRIES + 20; i += 1) {
      state = observedTrack(state, event('git:status', { cwd: `~/p/r${i}`, branch: 'main' })).state;
    }
    expect(Object.keys(state.observed).length).toBe(MAX_OBSERVED_ENTRIES);
    // Oldest evicted, newest kept.
    expect(state.observed[`git:status|~/p/r0`]).toBeUndefined();
    expect(state.observed[`git:status|~/p/r${MAX_OBSERVED_ENTRIES + 19}`]).toBeDefined();
  });

  it('survives a snapshot round-trip, which is the whole point', () => {
    const net = { fingerprint: 'net2_abc', gatewayIp: '192.168.1.1' };
    const live = observedTrack(createInitialState('d1'), event('location:network', net)).state;

    // What a restart does: serialise, and rebuild from the snapshot.
    const restored = JSON.parse(JSON.stringify(live)) as KernelState;
    expect(wouldDrop(restored, event('location:network', { ...net, timestamp: 'later' }))).toBe(true);
  });
});
