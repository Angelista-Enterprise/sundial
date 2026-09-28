import { spawn } from 'node:child_process';

export interface KnownDevice {
  name: string;
  isOutput: boolean;
}

/**
 * `audio:device-changed` is an audio-channel signal — keyboards, mice,
 * trackpads, AirTags and game controllers should never produce one.
 * Allowlist patterns for audio sources/sinks (headphones, speakers,
 * headsets, mics, in-ear monitors); anything else is dropped at parse time
 * and never emitted.
 */
const AUDIO_PATTERN = /headphone|headset|earphone|earbud|airpod|in-?ear|speaker|loud-?speaker|soundbar|microphone|mic\b|hands-?free|audio/i;

/** Denylist of obvious non-audio peripherals — defence in depth when minorType is missing. */
const NON_AUDIO_PATTERN = /\b(keyboard|magic\s?keyboard|magic\s?mouse|trackpad|mouse|airtag|controller|gamepad|joystick|stylus|pencil|watch|fitness|hr\s?strap)\b/i;

export function isAudioDevice(name: string, minorType: string): boolean {
  if (NON_AUDIO_PATTERN.test(name) || NON_AUDIO_PATTERN.test(minorType)) return false;
  return AUDIO_PATTERN.test(minorType) || AUDIO_PATTERN.test(name);
}

export function parseBluetoothJson(jsonText: string): Map<string, KnownDevice> {
  const result = new Map<string, KnownDevice>();
  if (!jsonText.trim()) return result;
  const parsed = JSON.parse(jsonText) as {
    SPBluetoothDataType?: Array<{
      device_connected?: Array<Record<string, { device_minorType?: string; device_isconnected?: string }>>;
    }>;
  };
  const root = parsed.SPBluetoothDataType?.[0]?.device_connected ?? [];
  for (const entry of root) {
    for (const [name, info] of Object.entries(entry)) {
      const connected = info.device_isconnected !== 'attrib_No';
      if (!connected) continue;
      const minor = info.device_minorType ?? '';
      if (!isAudioDevice(name, minor)) continue;
      const isOutput =
        /headphone|headset|earphone|earbud|airpod|in-?ear|speaker|loud-?speaker|soundbar/i.test(minor) ||
        /headphone|headset|earphone|earbud|airpod|in-?ear|speaker|loud-?speaker|soundbar/i.test(name);
      result.set(name, { name, isOutput });
    }
  }
  return result;
}

const TIMEOUT_MS = 8_000;

export function readConnectedBluetoothDevices(): Promise<Map<string, KnownDevice> | null> {
  // macOS-only: `system_profiler SPBluetoothDataType` doesn't exist elsewhere.
  // Guard explicitly rather than spawning a missing binary and silently
  // resolving null every poll on Linux (no bluetoothctl equivalent yet).
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    const proc = spawn('system_profiler', ['SPBluetoothDataType', '-json', '-detailLevel', 'mini'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve(null);
    }, TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
    });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(parseBluetoothJson(out));
      } catch {
        resolve(null);
      }
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}
