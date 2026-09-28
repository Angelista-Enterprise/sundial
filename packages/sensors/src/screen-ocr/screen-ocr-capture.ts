import fs from 'node:fs';
import { getScreenOcrJsonPath } from '@sundial/helpers/sundial-paths.js';

/** Mirrors the Swift `ScreenOcrSnapshot` (`macos-screen-ocr-helper`). `text` is RAW OCR — it is sanitized at ingest, never before. */
export interface ScreenOcrSnapshot {
  region: string;
  processName: string;
  bundleId: string | null;
  text: string;
  topics: string[];
  captureTimestamp: string;
}

/**
 * P7 — the OCR sidecar is written at the capture cadence (cursor-region every
 * ~1.5s by default), so a 10s staleness gate comfortably covers even the
 * slower full-window cadence while still going null when the helper isn't
 * running (OCR disabled, or the daemon is down).
 */
const SCREEN_OCR_STALE_MS = 10_000;

export function readScreenOcrSnapshot(): ScreenOcrSnapshot | null {
  const sidecarPath = getScreenOcrJsonPath();
  try {
    const stat = fs.statSync(sidecarPath);
    if (Date.now() - stat.mtimeMs > SCREEN_OCR_STALE_MS) return null;
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')) as Record<string, unknown>;
    if (typeof parsed.text !== 'string') return null;
    return {
      region: typeof parsed.region === 'string' ? parsed.region : 'focused',
      processName: typeof parsed.processName === 'string' ? parsed.processName : '',
      bundleId: typeof parsed.bundleId === 'string' ? parsed.bundleId : null,
      text: parsed.text,
      topics: Array.isArray(parsed.topics) ? parsed.topics.filter((t): t is string => typeof t === 'string') : [],
      captureTimestamp: typeof parsed.captureTimestamp === 'string' ? parsed.captureTimestamp : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
