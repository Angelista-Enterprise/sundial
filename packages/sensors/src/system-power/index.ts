import { type PowerState, readLinuxPowerState, readMacOSPowerState } from './system-power-capture.js';

export interface SystemPowerEvent {
  type: 'system:power';
  payload: Record<string, unknown>;
}

/** Emit on every transition (source flip or charging flip), and on every 5% battery change — avoids per-poll noise. */
export function shouldEmitPowerState(next: PowerState, last: PowerState | null): boolean {
  if (!last) return true;
  if (next.source !== last.source) return true;
  if (next.charging !== last.charging) return true;
  if (next.batteryPercent != null && last.batteryPercent != null) {
    if (Math.abs(next.batteryPercent - last.batteryPercent) >= 5) return true;
  }
  return false;
}

const POLL_INTERVAL_MS = 60_000;

export class SystemPowerSensor {
  private last: PowerState | null = null;
  private lastCheckedAt = 0;

  async poll(): Promise<SystemPowerEvent | null> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
    const now = Date.now();
    if (now - this.lastCheckedAt < POLL_INTERVAL_MS) return null;
    this.lastCheckedAt = now;

    const state = process.platform === 'darwin' ? await readMacOSPowerState() : await readLinuxPowerState();
    if (!state) return null;
    if (!shouldEmitPowerState(state, this.last)) return null;

    this.last = state;
    return {
      type: 'system:power',
      payload: {
        timestamp: new Date().toISOString(),
        source: state.source,
        batteryPercent: state.batteryPercent,
        charging: state.charging,
        timeRemainingMinutes: state.timeRemainingMinutes,
      },
    };
  }
}
