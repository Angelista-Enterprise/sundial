import type { KernelState, PresenceConsent, PresenceNetwork, Rule } from '@sundial/kernel/types.js';

/** Bounded so a busy network can't grow the snapshot without limit. Presence is a count question; the hashes are corroboration. */
const MAX_DEVICE_HASHES = 64;

interface LocationNetworkPayload {
  fingerprint?: string;
  ssid?: string;
  sname?: string;
  /** The sensor's own `ssid ?? sname ?? gatewayIp` fallback — see the read below. */
  label?: string;
  gatewayIp?: string;
  security?: string;
  interfaceType?: string;
}

/**
 * The name to show when the owner has not given the network one.
 *
 * Reads the sensor's `label` as the last resort, which is the fix for every row
 * on this surface reading "Unnamed network": `readMacOSNetworkState` already
 * computes `ssid ?? sname ?? gatewayIp`, but this rule used to recompute
 * `ssid ?? sname` and throw the gateway away — and since macOS withholds the
 * SSID without Location Services, `ssid` is null on every real signal. The
 * gateway is a poor name and an excellent discriminator, which is exactly what
 * an unnamed network needs.
 */
function observedLabel(payload: LocationNetworkPayload): string | null {
  return payload.ssid ?? payload.sname ?? payload.label ?? null;
}

/**
 * Back-fills the three details, preferring what is already known.
 *
 * Prefers `existing` rather than the incoming payload so that a later event
 * missing a field — a payload from an older sensor, or a network whose security
 * mode reads as null on one poll — cannot blank a detail that was captured
 * correctly once. These describe the network's identity, not its current state;
 * for them, the first good reading is the right one to keep.
 */
function backfilledDetail(existing: PresenceNetwork | undefined, payload: LocationNetworkPayload) {
  return {
    gatewayIp: existing?.gatewayIp ?? payload.gatewayIp ?? null,
    security: existing?.security ?? payload.security ?? null,
    interfaceType: existing?.interfaceType ?? payload.interfaceType ?? null,
  };
}

interface PresenceScanPayload {
  timestamp?: string;
  networkFingerprint?: string;
  deviceCount?: number;
  deviceHashes?: unknown;
}

interface PresenceConsentPayload {
  fingerprint?: string;
  consent?: string;
}

function isConsent(value: unknown): value is PresenceConsent {
  return value === 'unset' || value === 'granted' || value === 'denied';
}

/**
 * enhancements/presence-as-absence-ground-truth — the one rule folding the
 * presence slice. Reacts to three event types, which is why it is one rule
 * rather than three: all three write the same `state.presence` map, and
 * splitting them would put three writers on one slice for no gain.
 *
 * `location:network` — registers the network as one the owner could be asked
 * about. Deliberately does NOT grant anything: a newly-seen network lands as
 * `consent: 'unset'`, which the UI offers as an unanswered checkbox and the
 * sensor treats as a refusal. This rule shares the event with `networkTrack`
 * (which writes `state.network`) and has no ordering dependency on it — the two
 * write different slices from the same payload.
 *
 * `presence:consent` — the owner's answer, arriving through the same
 * deliberate-act path `feedback:verdict` and `ask:*` use. Consent is recorded as
 * an EVENT rather than read from `~/.sundial/config.json`, and that is the
 * load-bearing choice in this design: a permission in a config file is a value
 * with no history, whereas an event log answers "when did I allow this, and was
 * it ever revoked" by construction. It also means the macOS checkbox and a CLI
 * flag are two producers of one auditable fact, not two sources of truth.
 *
 * `presence:scan` — a sweep result. Defends the consent invariant a third time
 * (after the daemon's poll gate and the sensor's own refusal): a scan naming a
 * network that is not `granted` is DROPPED rather than folded. That case should
 * be unreachable, and it is checked anyway, because the failure mode is
 * retaining observations of other people's devices that the owner never agreed
 * to — and a replayed log from before a revocation is exactly how that would
 * happen quietly.
 */
export const presenceTrack: Rule = (state, event) => {
  if (event.type === 'location:network') {
    const payload = event.payload as LocationNetworkPayload;
    const fingerprint = typeof payload.fingerprint === 'string' ? payload.fingerprint : '';
    if (!fingerprint) return { state, effects: [] };

    const existing = state.presence.networks[fingerprint];
    const label = observedLabel(payload);
    const updated: PresenceNetwork = existing
      ? // Refresh `lastSeenAt` and pick up a label or a detail that was missing
        // before, but never touch `consent` — re-joining a network is not a
        // re-answer. A re-join is the only chance to fill in details for an entry
        // folded by a build that did not record them.
        { ...existing, lastSeenAt: event.ts, label: existing.label ?? label, ...backfilledDetail(existing, payload) }
      : { fingerprint, label, ...backfilledDetail(undefined, payload), firstSeenAt: event.ts, lastSeenAt: event.ts, consent: 'unset', consentAt: null };

    return {
      state: { ...state, presence: { ...state.presence, networks: { ...state.presence.networks, [fingerprint]: updated } } },
      effects: [],
    };
  }

  if (event.type === 'presence:consent') {
    const payload = event.payload as PresenceConsentPayload;
    const fingerprint = typeof payload.fingerprint === 'string' ? payload.fingerprint : '';
    if (!fingerprint || !isConsent(payload.consent)) return { state, effects: [] };

    const existing = state.presence.networks[fingerprint];
    // An answer can arrive for a network not yet in the map — the owner may
    // revoke a network from a device that has not re-joined it since a reset.
    // Recording the decision matters more than having seen the network first.
    const updated: PresenceNetwork = {
      fingerprint,
      label: existing?.label ?? null,
      gatewayIp: existing?.gatewayIp ?? null,
      security: existing?.security ?? null,
      interfaceType: existing?.interfaceType ?? null,
      firstSeenAt: existing?.firstSeenAt ?? event.ts,
      lastSeenAt: existing?.lastSeenAt ?? event.ts,
      consent: payload.consent,
      consentAt: event.ts,
    };

    return {
      state: { ...state, presence: { ...state.presence, networks: { ...state.presence.networks, [fingerprint]: updated } } },
      effects: [],
    };
  }

  if (event.type === 'presence:scan') {
    const payload = event.payload as PresenceScanPayload;
    const fingerprint = typeof payload.networkFingerprint === 'string' ? payload.networkFingerprint : '';
    if (!fingerprint) return { state, effects: [] };
    if (state.presence.networks[fingerprint]?.consent !== 'granted') return { state, effects: [] };

    const deviceHashes = Array.isArray(payload.deviceHashes) ? payload.deviceHashes.filter((h): h is string => typeof h === 'string').slice(0, MAX_DEVICE_HASHES) : [];
    // Trust the sensor's own count over the (possibly truncated) hash list, so
    // truncation for snapshot size never silently understates presence.
    const deviceCount = typeof payload.deviceCount === 'number' ? payload.deviceCount : deviceHashes.length;

    return {
      state: {
        ...state,
        presence: {
          ...state.presence,
          lastScan: { at: typeof payload.timestamp === 'string' ? payload.timestamp : event.ts, networkFingerprint: fingerprint, deviceCount, deviceHashes },
        },
      },
      effects: [],
    };
  }

  return { state, effects: [] };
};

/**
 * Read-time helper for the daemon's poll gate: the fingerprint to hand
 * `PresenceSensor.poll()`, or `null` when the current network has no grant.
 *
 * Lives beside the rule rather than in the daemon so that the one place defining
 * "this network is sweepable" is the same file that folds the consent event —
 * the same read-time-analytic-not-a-rule shape `forecastDayEnd` uses.
 */
export function consentedNetworkFingerprint(state: KernelState): string | null {
  const fingerprint = state.network.fingerprint;
  if (!fingerprint) return null;
  return state.presence.networks[fingerprint]?.consent === 'granted' ? fingerprint : null;
}
