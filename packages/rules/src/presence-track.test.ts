import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { presenceTrack, consentedNetworkFingerprint } from './presence-track.js';

const TS = '2026-07-29T10:00:00.000Z';
const LATER = '2026-07-29T18:00:00.000Z';
const FP = 'net_abc123';

function ev(type: string, payload: Record<string, unknown>, ts = TS): SanitizedEvent {
  return { id: `e-${type}-${ts}`, type, ts, payload, sanitized: true };
}

function withNetworkSeen(base: KernelState, consent: 'unset' | 'granted' | 'denied' = 'unset'): KernelState {
  const seen = presenceTrack(base, ev('location:network', { fingerprint: FP, ssid: 'Home' })).state;
  if (consent === 'unset') return seen;
  return presenceTrack(seen, ev('presence:consent', { fingerprint: FP, consent })).state;
}

describe('presenceTrack — network discovery', () => {
  it('registers a newly-seen network as unset rather than granted', () => {
    const { state } = presenceTrack(createInitialState('d1'), ev('location:network', { fingerprint: FP, ssid: 'Home' }));

    expect(state.presence.networks[FP]).toMatchObject({ fingerprint: FP, label: 'Home', consent: 'unset', consentAt: null, firstSeenAt: TS });
  });

  it('falls back to the service name when there is no SSID, and to null when there is neither', () => {
    const withSname = presenceTrack(createInitialState('d1'), ev('location:network', { fingerprint: FP, sname: 'Wired' })).state;
    expect(withSname.presence.networks[FP].label).toBe('Wired');

    const unnamed = presenceTrack(createInitialState('d1'), ev('location:network', { fingerprint: FP })).state;
    expect(unnamed.presence.networks[FP].label).toBeNull();
  });

  /**
   * The bug that made every row on the System page read "Unnamed network". macOS
   * withholds the SSID without Location Services, so `ssid` is null on every real
   * signal; the sensor already falls back to the gateway and puts it on the
   * payload as `label`, and this rule used to stop at `sname` and drop it.
   */
  it('falls back to the sensor label when there is no SSID or service name', () => {
    const { state } = presenceTrack(
      createInitialState('d1'),
      ev('location:network', { fingerprint: FP, label: '192.168.1.1', gatewayIp: '192.168.1.1' }),
    );

    expect(state.presence.networks[FP].label).toBe('192.168.1.1');
  });

  it('prefers a real SSID over the sensor gateway fallback', () => {
    const { state } = presenceTrack(
      createInitialState('d1'),
      ev('location:network', { fingerprint: FP, ssid: 'Home', label: '192.168.1.1' }),
    );

    expect(state.presence.networks[FP].label).toBe('Home');
  });

  it('records the gateway, security mode and interface type so two unnamed networks can be told apart', () => {
    const { state } = presenceTrack(
      createInitialState('d1'),
      ev('location:network', { fingerprint: FP, gatewayIp: '10.10.8.1', security: 'SHA256_8021X', interfaceType: 'WiFi' }),
    );

    expect(state.presence.networks[FP]).toMatchObject({ gatewayIp: '10.10.8.1', security: 'SHA256_8021X', interfaceType: 'WiFi' });
  });

  /**
   * These describe the network's identity, not its current state, so a later poll
   * that reads one of them as null must not blank a value captured correctly once.
   */
  it('keeps a detail already known when a later event arrives without it', () => {
    const first = presenceTrack(
      createInitialState('d1'),
      ev('location:network', { fingerprint: FP, gatewayIp: '10.10.8.1', security: 'SHA256_8021X' }),
    ).state;

    const { state } = presenceTrack(first, ev('location:network', { fingerprint: FP }));

    expect(state.presence.networks[FP]).toMatchObject({ gatewayIp: '10.10.8.1', security: 'SHA256_8021X' });
  });

  it('leaves the details intact when the owner answers the consent question', () => {
    const seen = presenceTrack(
      createInitialState('d1'),
      ev('location:network', { fingerprint: FP, gatewayIp: '10.10.8.1', security: 'SHA256_8021X' }),
    ).state;

    const { state } = presenceTrack(seen, ev('presence:consent', { fingerprint: FP, consent: 'granted' }));

    expect(state.presence.networks[FP]).toMatchObject({ gatewayIp: '10.10.8.1', security: 'SHA256_8021X', consent: 'granted' });
  });

  it('ignores a payload with no fingerprint rather than creating an empty-keyed network', () => {
    const { state } = presenceTrack(createInitialState('d1'), ev('location:network', { ssid: 'Home' }));
    expect(state.presence.networks).toEqual({});
  });

  /**
   * Re-joining a network is not a re-answer. If rediscovery reset consent, every
   * morning's reconnect would silently revoke a grant — or worse, re-open a
   * question the owner already declined.
   */
  it('refreshes lastSeenAt on rediscovery without disturbing an existing consent', () => {
    const granted = withNetworkSeen(createInitialState('d1'), 'granted');
    const { state } = presenceTrack(granted, ev('location:network', { fingerprint: FP, ssid: 'Home' }, LATER));

    expect(state.presence.networks[FP].consent).toBe('granted');
    expect(state.presence.networks[FP].firstSeenAt).toBe(TS);
    expect(state.presence.networks[FP].lastSeenAt).toBe(LATER);
  });
});

describe('presenceTrack — consent', () => {
  it('records a grant with the time it was given', () => {
    const { state } = presenceTrack(withNetworkSeen(createInitialState('d1')), ev('presence:consent', { fingerprint: FP, consent: 'granted' }, LATER));

    expect(state.presence.networks[FP]).toMatchObject({ consent: 'granted', consentAt: LATER });
  });

  it('records a revocation, which must be able to follow a grant', () => {
    const granted = withNetworkSeen(createInitialState('d1'), 'granted');
    const { state } = presenceTrack(granted, ev('presence:consent', { fingerprint: FP, consent: 'denied' }, LATER));

    expect(state.presence.networks[FP].consent).toBe('denied');
  });

  /**
   * The owner may revoke a network from a machine that has not re-joined it
   * since a reset, so the decision has to be recordable without the network
   * being in the map first.
   */
  it('accepts a decision for a network never seen before', () => {
    const { state } = presenceTrack(createInitialState('d1'), ev('presence:consent', { fingerprint: 'net_unseen', consent: 'denied' }));
    expect(state.presence.networks['net_unseen'].consent).toBe('denied');
  });

  it('drops an unrecognised consent value rather than coercing it', () => {
    const seen = withNetworkSeen(createInitialState('d1'));
    const { state } = presenceTrack(seen, ev('presence:consent', { fingerprint: FP, consent: 'maybe' }));
    expect(state.presence.networks[FP].consent).toBe('unset');
  });
});

describe('presenceTrack — scans', () => {
  const scan = { timestamp: LATER, networkFingerprint: FP, deviceCount: 4, deviceHashes: ['dev_a', 'dev_b'] };

  it('folds a scan on a granted network', () => {
    const { state } = presenceTrack(withNetworkSeen(createInitialState('d1'), 'granted'), ev('presence:scan', scan));

    expect(state.presence.lastScan).toEqual({ at: LATER, networkFingerprint: FP, deviceCount: 4, deviceHashes: ['dev_a', 'dev_b'] });
  });

  /**
   * The consent invariant, checked here for the third time (after the daemon's
   * poll gate and the sensor's own refusal). This case should be unreachable in
   * a live daemon — but a log REPLAYED across a revocation would otherwise fold
   * observations the owner has since withdrawn permission for, which is exactly
   * how a privacy guarantee erodes quietly.
   */
  it('drops a scan on a network whose consent is unset', () => {
    const { state } = presenceTrack(withNetworkSeen(createInitialState('d1')), ev('presence:scan', scan));
    expect(state.presence.lastScan).toBeNull();
  });

  it('drops a scan on a network whose consent was revoked', () => {
    const { state } = presenceTrack(withNetworkSeen(createInitialState('d1'), 'denied'), ev('presence:scan', scan));
    expect(state.presence.lastScan).toBeNull();
  });

  it('drops a scan naming a network it has never heard of', () => {
    const { state } = presenceTrack(withNetworkSeen(createInitialState('d1'), 'granted'), ev('presence:scan', { ...scan, networkFingerprint: 'net_other' }));
    expect(state.presence.lastScan).toBeNull();
  });

  /** Truncating hashes for snapshot size must never understate how many devices were actually seen. */
  it('keeps the sensor count even when the hash list is truncated', () => {
    const many = Array.from({ length: 200 }, (_, i) => `dev_${i}`);
    const { state } = presenceTrack(withNetworkSeen(createInitialState('d1'), 'granted'), ev('presence:scan', { ...scan, deviceCount: 200, deviceHashes: many }));

    expect(state.presence.lastScan?.deviceCount).toBe(200);
    expect(state.presence.lastScan?.deviceHashes).toHaveLength(64);
  });

  it('is a no-op for an unrelated event', () => {
    const before = withNetworkSeen(createInitialState('d1'), 'granted');
    const { state, effects } = presenceTrack(before, ev('window:changed', {}));
    expect(state).toBe(before);
    expect(effects).toEqual([]);
  });
});

describe('consentedNetworkFingerprint', () => {
  it('returns the fingerprint only when the CURRENT network is granted', () => {
    const granted = withNetworkSeen(createInitialState('d1'), 'granted');
    const onThatNetwork: KernelState = { ...granted, network: { fingerprint: FP, label: 'Home' } };

    expect(consentedNetworkFingerprint(onThatNetwork)).toBe(FP);
  });

  it('returns null when the owner is on a different, ungranted network', () => {
    const granted = withNetworkSeen(createInitialState('d1'), 'granted');
    const atTheOffice: KernelState = { ...granted, network: { fingerprint: 'net_office', label: 'Office' } };

    expect(consentedNetworkFingerprint(atTheOffice)).toBeNull();
  });

  it('returns null for an unset network, so silence is the default', () => {
    const seen = withNetworkSeen(createInitialState('d1'));
    expect(consentedNetworkFingerprint({ ...seen, network: { fingerprint: FP } })).toBeNull();
  });

  it('returns null when there is no current network at all', () => {
    expect(consentedNetworkFingerprint(createInitialState('d1'))).toBeNull();
  });
});
