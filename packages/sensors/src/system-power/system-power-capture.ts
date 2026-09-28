import { execFile } from 'node:child_process';

export type PowerSource = 'ac' | 'battery';

export interface PowerState {
  source: PowerSource;
  batteryPercent: number | null;
  charging: boolean;
  timeRemainingMinutes: number | null;
}

export function parseMacOSPowerState(stdout: string): PowerState {
  const isAc = /'AC Power'/i.test(stdout);
  const source: PowerSource = isAc ? 'ac' : 'battery';

  const pctMatch = stdout.match(/(\d+)%/);
  const batteryPercent = pctMatch ? parseInt(pctMatch[1], 10) : null;

  const charging = /;\s*charging/i.test(stdout);

  let timeRemainingMinutes: number | null = null;
  const remainMatch = stdout.match(/(\d+):(\d{2})\s+(?:remaining|to full)/i);
  if (remainMatch) {
    const hours = parseInt(remainMatch[1], 10);
    const minutes = parseInt(remainMatch[2], 10);
    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
      timeRemainingMinutes = hours * 60 + minutes;
    }
  }

  return { source, batteryPercent, charging, timeRemainingMinutes };
}

export function parseLinuxPowerState(stdout: string): PowerState {
  const lines = stdout.split('\n');
  const online = lines[0]?.trim() === '1';
  const capacity = lines[1] ? parseInt(lines[1].trim(), 10) : NaN;
  const status = (lines[2] ?? '').trim().toLowerCase();
  const energyNow = lines[3] ? parseInt(lines[3].trim(), 10) : NaN;
  const energyFull = lines[4] ? parseInt(lines[4].trim(), 10) : NaN;
  const powerNow = lines[5] ? parseInt(lines[5].trim(), 10) : NaN;

  const source: PowerSource = online ? 'ac' : 'battery';
  const batteryPercent = Number.isFinite(capacity) ? capacity : null;
  const charging = status === 'charging';

  let timeRemainingMinutes: number | null = null;
  if (Number.isFinite(powerNow) && powerNow > 0) {
    const energy = charging ? (Number.isFinite(energyFull) && Number.isFinite(energyNow) ? energyFull - energyNow : NaN) : energyNow;
    if (Number.isFinite(energy) && energy > 0) {
      timeRemainingMinutes = Math.round((energy / powerNow) * 60);
    }
  }

  return { source, batteryPercent, charging, timeRemainingMinutes };
}

export function readMacOSPowerState(): Promise<PowerState | null> {
  return new Promise((resolve) => {
    execFile('pmset', ['-g', 'batt'], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(parseMacOSPowerState(stdout));
    });
  });
}

export function readLinuxPowerState(): Promise<PowerState | null> {
  return new Promise((resolve) => {
    execFile(
      'cat',
      [
        '/sys/class/power_supply/AC/online',
        '/sys/class/power_supply/BAT0/capacity',
        '/sys/class/power_supply/BAT0/status',
        '/sys/class/power_supply/BAT0/energy_now',
        '/sys/class/power_supply/BAT0/energy_full',
        '/sys/class/power_supply/BAT0/power_now',
      ],
      { timeout: 1500 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(parseLinuxPowerState(stdout));
      },
    );
  });
}
