import { type KnownDevice, readConnectedBluetoothDevices } from './bluetooth-audio-capture.js';

export interface BluetoothAudioEvent {
  type: 'audio:device-changed';
  payload: Record<string, unknown>;
}

/** Pure diff, directly testable — primed on the first call (no emit for already-connected devices, matches WCS). */
export function diffBluetoothDevices(now: Map<string, KnownDevice>, lastSeen: Map<string, KnownDevice>, prime: boolean): BluetoothAudioEvent[] {
  const out: BluetoothAudioEvent[] = [];
  const timestamp = new Date().toISOString();
  for (const [name, dev] of now) {
    if (!lastSeen.has(name) && !prime) {
      out.push({ type: 'audio:device-changed', payload: { timestamp, kind: 'connected', deviceName: name, isAudioOutput: dev.isOutput } });
    }
  }
  for (const [name, dev] of lastSeen) {
    if (!now.has(name)) {
      out.push({ type: 'audio:device-changed', payload: { timestamp, kind: 'disconnected', deviceName: name, isAudioOutput: dev.isOutput } });
    }
  }
  return out;
}

const POLL_INTERVAL_MS = 60_000;

export class BluetoothAudioSensor {
  private lastSeen = new Map<string, KnownDevice>();
  private lastCheckedAt = 0;
  private primed = false;

  async poll(): Promise<BluetoothAudioEvent[]> {
    const now = Date.now();
    if (now - this.lastCheckedAt < POLL_INTERVAL_MS) return [];
    this.lastCheckedAt = now;

    const devices = await readConnectedBluetoothDevices();
    if (!devices) return [];

    const events = diffBluetoothDevices(devices, this.lastSeen, !this.primed);
    this.primed = true;
    this.lastSeen = devices;
    return events;
  }
}
