import { describe, it, expect } from 'vitest';
import { isAudioDevice, parseBluetoothJson } from './bluetooth-audio-capture.js';
import { diffBluetoothDevices } from './index.js';

describe('isAudioDevice', () => {
  it('allows headphones/speakers/mics', () => {
    expect(isAudioDevice('AirPods Pro', 'Headphones')).toBe(true);
    expect(isAudioDevice('Desk Mic', 'Microphone')).toBe(true);
  });

  it('rejects keyboards/mice/trackpads even if name is ambiguous', () => {
    expect(isAudioDevice('Magic Keyboard', '')).toBe(false);
    expect(isAudioDevice('Magic Trackpad', '')).toBe(false);
  });

  it('rejects devices matching neither pattern', () => {
    expect(isAudioDevice('AirTag', '')).toBe(false);
  });
});

describe('parseBluetoothJson', () => {
  it('includes only connected audio devices, distinguishing output vs input-only', () => {
    const json = JSON.stringify({
      SPBluetoothDataType: [
        {
          device_connected: [
            { 'AirPods Pro': { device_minorType: 'Headphones', device_isconnected: 'attrib_Yes' } },
            { 'Magic Keyboard': { device_minorType: 'Keyboard', device_isconnected: 'attrib_Yes' } },
            { 'Old Headset': { device_minorType: 'Headset', device_isconnected: 'attrib_No' } },
          ],
        },
      ],
    });

    const result = parseBluetoothJson(json);

    expect(result.size).toBe(1);
    expect(result.get('AirPods Pro')).toEqual({ name: 'AirPods Pro', isOutput: true });
  });

  it('returns an empty map for empty input', () => {
    expect(parseBluetoothJson('').size).toBe(0);
  });
});

describe('diffBluetoothDevices', () => {
  it('does not emit for already-connected devices on the priming poll', () => {
    const now = new Map([['AirPods', { name: 'AirPods', isOutput: true }]]);
    const events = diffBluetoothDevices(now, new Map(), true);
    expect(events).toEqual([]);
  });

  it('emits connected for a genuinely new device on a non-priming poll', () => {
    const now = new Map([['AirPods', { name: 'AirPods', isOutput: true }]]);
    const events = diffBluetoothDevices(now, new Map(), false);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe('connected');
  });

  it('emits disconnected when a device drops out of the current set', () => {
    const lastSeen = new Map([['AirPods', { name: 'AirPods', isOutput: true }]]);
    const events = diffBluetoothDevices(new Map(), lastSeen, false);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe('disconnected');
  });
});
