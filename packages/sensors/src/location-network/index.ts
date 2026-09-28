import { readLinuxNetworkState, readMacOSNetworkState } from './location-network-capture.js';

export interface LocationNetworkEvent {
  type: 'location:network';
  payload: Record<string, unknown>;
}

const POLL_INTERVAL_MS = 120_000;

export class LocationNetworkSensor {
  private lastFingerprint: string | null = null;
  private lastCheckedAt = 0;

  async poll(): Promise<LocationNetworkEvent | null> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
    const now = Date.now();
    if (now - this.lastCheckedAt < POLL_INTERVAL_MS) return null;
    this.lastCheckedAt = now;

    const state = process.platform === 'darwin' ? await readMacOSNetworkState() : await readLinuxNetworkState();
    if (!state) return null;
    if (state.fingerprint === this.lastFingerprint) return null;
    this.lastFingerprint = state.fingerprint;

    return {
      type: 'location:network',
      payload: {
        timestamp: new Date().toISOString(),
        fingerprint: state.fingerprint,
        gatewayIp: state.gatewayIp,
        interfaceName: state.interfaceName,
        ssid: state.ssid,
        bssid: state.bssid,
        networkId: state.networkId,
        sname: state.sname,
        interfaceType: state.interfaceType,
        isExpensive: state.isExpensive,
        security: state.security,
        label: state.label,
      },
    };
  }
}
