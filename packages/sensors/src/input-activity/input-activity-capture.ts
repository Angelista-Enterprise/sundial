import fs from 'node:fs';
import { getInputActivityJsonPath } from '@sundial/helpers/sundial-paths.js';

export interface InputActivitySnapshot {
  timestamp: string;
  keyDownCount: number;
  mouseClickCount: number;
  mouseMoveCount: number;
  scrollCount: number;
}

const STALE_MS = 5000;

/** Reads the 1s rolling-window sidecar the input-helper Swift sidecar writes. Counts only — never keycodes/coordinates. */
export function readInputActivitySidecar(): InputActivitySnapshot | null {
  const sidecarPath = getInputActivityJsonPath();
  try {
    const stat = fs.statSync(sidecarPath);
    if (Date.now() - stat.mtimeMs > STALE_MS) return null;
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    return {
      timestamp: parsed.timestamp,
      keyDownCount: parsed.keyDownCount ?? 0,
      mouseClickCount: parsed.mouseClickCount ?? 0,
      mouseMoveCount: parsed.mouseMoveCount ?? 0,
      scrollCount: parsed.scrollCount ?? 0,
    };
  } catch {
    return null;
  }
}
