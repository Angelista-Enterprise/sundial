import { readArpDevices } from './presence-capture.js';

export interface PresenceScanEvent {
  type: 'presence:scan';
  payload: Record<string, unknown>;
}

/**
 * Five minutes. Much slower than the 10s input cadence, because this signal is
 * about hours-scale presence, not activity — and every scan is a subprocess.
 */
const POLL_INTERVAL_MS = 300_000;

/**
 * enhancements/presence-as-absence-ground-truth — records whether devices are
 * answering on the local network, so an hour with no Gnomon signal can be read
 * as "the owner left" rather than only as "the daemon heard nothing".
 *
 * Same shape as `LocationNetworkSensor`: self-gated to its own interval so the
 * daemon can call `poll()` on every tick, and safe to call when there is nothing
 * to do.
 *
 * The consent gate is a REQUIRED ARGUMENT, not an internal lookup, and that is
 * the important design decision here. A sensor cannot read `KernelState`, so the
 * alternative would be this class holding its own copy of the owner's consent —
 * a module-level mutable cache of a permission, which is both the bug class
 * CLAUDE.md forbids and the worst possible thing to get stale. Instead the
 * daemon passes the fingerprint of the network it has already confirmed consent
 * for, and `null` means "do not scan". The permission lives in one place
 * (`state.presence.networks[…].consent`, folded from an event) and this sensor
 * cannot scan without being handed the answer.
 */
export class PresenceSensor {
  private lastCheckedAt = 0;

  /**
   * @param consentedNetworkFingerprint The network to attribute this scan to,
   *   which the caller must already have verified carries `consent: 'granted'`.
   *   `null` — no current network, or consent not granted — is a no-op.
   */
  async poll(consentedNetworkFingerprint: string | null): Promise<PresenceScanEvent | null> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
    // Defence in depth: the daemon is expected to have checked consent before
    // calling, and this refuses anyway. A sweep that happens without a grant is
    // the one failure in this feature that cannot be walked back by an apology.
    if (!consentedNetworkFingerprint) return null;

    const now = Date.now();
    if (now - this.lastCheckedAt < POLL_INTERVAL_MS) return null;
    this.lastCheckedAt = now;

    const devices = await readArpDevices();
    // `null` is "could not look", which must not be recorded as "nobody home" —
    // emitting nothing leaves the hour genuinely unobserved, which is honest.
    if (!devices) return null;

    return {
      type: 'presence:scan',
      payload: {
        timestamp: new Date().toISOString(),
        networkFingerprint: consentedNetworkFingerprint,
        deviceCount: devices.length,
        deviceHashes: devices.map((d) => d.hash),
      },
    };
  }
}
