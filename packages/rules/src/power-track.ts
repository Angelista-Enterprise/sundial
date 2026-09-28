import type { Rule } from '@sundial/kernel/types.js';

interface SystemPowerPayload {
  source?: string;
  batteryPercent?: number | null;
  charging?: boolean;
  timeRemainingMinutes?: number | null;
}

/**
 * C1 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.1) —
 * `system:power` was already polled every 60s and self-gated to real
 * source/charging/battery-delta changes by the sensor itself, but nothing
 * wrote it into `state.power`; the field stayed at its `{source: 'ac'}`
 * default forever regardless of the machine's actual power state.
 */
export const powerTrack: Rule = (state, event) => {
  if (event.type !== 'system:power') return { state, effects: [] };

  const payload = event.payload as SystemPowerPayload;
  const source = payload.source === 'battery' ? 'battery' : 'ac';

  return {
    state: {
      ...state,
      power: {
        source,
        batteryPercent: typeof payload.batteryPercent === 'number' ? payload.batteryPercent : undefined,
        charging: typeof payload.charging === 'boolean' ? payload.charging : undefined,
        timeRemainingMinutes: typeof payload.timeRemainingMinutes === 'number' ? payload.timeRemainingMinutes : null,
      },
    },
    effects: [],
  };
};
