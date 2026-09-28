import type { Rule } from '@sundial/kernel/types.js';

interface LocationNetworkPayload {
  fingerprint?: string;
  ssid?: string;
  sname?: string;
  /** The sensor's `ssid ?? sname ?? gatewayIp` fallback. */
  label?: string;
}

/**
 * C1 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.1) —
 * `location:network` was already self-gated to 120s and real fingerprint
 * changes by the sensor, but nothing wrote it into `state.network`; the
 * field stayed at its `{fingerprint: ''}` default forever. Only
 * `fingerprint`/a human-readable `label` are kept — the sensor also
 * captures `gatewayIp`/`bssid`/`interfaceType`/etc., which have no
 * corresponding `KernelState.network` field and no current consumer;
 * widening the slice to mirror every raw field is deferred until something
 * actually needs one of them, consistent with C1's "don't force-fit
 * unneeded fields" posture elsewhere in this pass.
 */
export const networkTrack: Rule = (state, event) => {
  if (event.type !== 'location:network') return { state, effects: [] };

  const payload = event.payload as LocationNetworkPayload;
  const fingerprint = typeof payload.fingerprint === 'string' ? payload.fingerprint : '';
  // Falls through to the sensor's own `label` (gateway IP) rather than stopping at
  // `sname`. macOS withholds the SSID without Location Services, so `ssid` is null
  // on every real signal and this field was permanently undefined off a hotspot.
  const label = payload.ssid ?? payload.sname ?? payload.label;

  return {
    state: { ...state, network: { fingerprint, label } },
    effects: [],
  };
};
