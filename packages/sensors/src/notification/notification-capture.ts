import fs from 'node:fs';
import { getNotificationBadgesJsonPath } from '@sundial/helpers/sundial-paths.js';

export interface BadgeSnapshot {
  timestamp: string;
  accessGranted: boolean;
  badges: Record<string, number>;
  totalCount: number;
}

const STALE_MS = 90_000;

/** Reads the Dock-badge sidecar the notification Swift helper writes. Never reads notification title/body — badge counts only. */
export function readNotificationSidecar(): BadgeSnapshot | null {
  const sidecarPath = getNotificationBadgesJsonPath();
  try {
    const stat = fs.statSync(sidecarPath);
    if (Date.now() - stat.mtimeMs > STALE_MS) return null;
    return JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
  } catch {
    return null;
  }
}
