import { describe, it, expect } from 'vitest';
import { parseMacOSPowerState, parseLinuxPowerState } from './system-power-capture.js';
import { shouldEmitPowerState } from './index.js';

describe('parseMacOSPowerState', () => {
  it('parses AC power with charging and time-to-full', () => {
    const state = parseMacOSPowerState("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1) 82%; charging; 0:32 to full present: true");
    expect(state).toEqual({ source: 'ac', batteryPercent: 82, charging: true, timeRemainingMinutes: 32 });
  });

  it('parses battery power with discharging and time remaining', () => {
    const state = parseMacOSPowerState("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1) 45%; discharging; 2:14 remaining present: true");
    expect(state).toEqual({ source: 'battery', batteryPercent: 45, charging: false, timeRemainingMinutes: 134 });
  });
});

describe('parseLinuxPowerState', () => {
  it('parses /sys/class/power_supply output while charging', () => {
    const stdout = ['1', '60', 'Charging', '30000000', '50000000', '10000000'].join('\n');
    const state = parseLinuxPowerState(stdout);
    expect(state.source).toBe('ac');
    expect(state.batteryPercent).toBe(60);
    expect(state.charging).toBe(true);
    expect(state.timeRemainingMinutes).toBe(120); // (50M-30M)/10M hours = 2h = 120min
  });
});

describe('shouldEmitPowerState', () => {
  it('always emits on the first observation', () => {
    expect(shouldEmitPowerState({ source: 'ac', batteryPercent: 50, charging: true, timeRemainingMinutes: null }, null)).toBe(true);
  });

  it('does not emit for a small battery delta', () => {
    const last = { source: 'battery' as const, batteryPercent: 50, charging: false, timeRemainingMinutes: null };
    const next = { source: 'battery' as const, batteryPercent: 52, charging: false, timeRemainingMinutes: null };
    expect(shouldEmitPowerState(next, last)).toBe(false);
  });

  it('emits when the battery delta reaches 5%', () => {
    const last = { source: 'battery' as const, batteryPercent: 50, charging: false, timeRemainingMinutes: null };
    const next = { source: 'battery' as const, batteryPercent: 45, charging: false, timeRemainingMinutes: null };
    expect(shouldEmitPowerState(next, last)).toBe(true);
  });

  it('emits on a source flip even with no battery delta', () => {
    const last = { source: 'battery' as const, batteryPercent: 50, charging: false, timeRemainingMinutes: null };
    const next = { source: 'ac' as const, batteryPercent: 50, charging: true, timeRemainingMinutes: null };
    expect(shouldEmitPowerState(next, last)).toBe(true);
  });
});
