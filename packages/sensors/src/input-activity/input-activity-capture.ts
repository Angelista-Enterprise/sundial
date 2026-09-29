import fs from 'node:fs';
import { getInputActivityJsonPath } from '@sundial/helpers/sundial-paths.js';

export interface InputActivitySnapshot {
  timestamp: string;
  keyDownCount: number;
  mouseClickCount: number;
  mouseMoveCount: number;
  scrollCount: number;
  /** `CGPreflightListenEventAccess()`: the Input Monitoring grant. Absent from an older helper. */
  listenAccessGranted?: boolean;
  /** The event tap is installed and enabled. Absent from an older helper. */
  tapActive?: boolean;
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
      ...(typeof parsed.listenAccessGranted === 'boolean' ? { listenAccessGranted: parsed.listenAccessGranted } : {}),
      ...(typeof parsed.tapActive === 'boolean' ? { tapActive: parsed.tapActive } : {}),
    };
  } catch {
    return null;
  }
}
