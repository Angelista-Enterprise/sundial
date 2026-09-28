import fs from 'node:fs';
import { getSleepWakeInfoJsonPath } from '@sundial/helpers/sundial-paths.js';

export interface SleepWakeSnapshot {
  kind: 'sleep' | 'wake';
  timestamp: string;
  gapSeconds?: number;
}

/**
 * No staleness check here (unlike window-info.json/av-context.json) — those
 * are rewritten every 1s so an old file means the writer died; this file is
 * only ever rewritten on an actual sleep/wake transition, so it can be
 * legitimately hours old and still be the current, correct state.
 */
export function readSleepWakeSidecar(): SleepWakeSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSleepWakeInfoJsonPath(), 'utf-8'));
    if (parsed.kind !== 'sleep' && parsed.kind !== 'wake') return null;
    if (typeof parsed.timestamp !== 'string') return null;
    return { kind: parsed.kind, timestamp: parsed.timestamp, gapSeconds: typeof parsed.gapSeconds === 'number' ? parsed.gapSeconds : undefined };
  } catch {
    return null;
  }
}
