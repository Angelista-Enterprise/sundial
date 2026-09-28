import fs from 'node:fs';
import { getWindowInfoJsonPath, WINDOW_INFO_SIDECAR_STALE_MS } from '@sundial/helpers/sundial-paths.js';

export interface WindowRef {
  processName: string;
  windowTitle: string;
  windowId: string;
  /** Editor open-file path (AX `kAXDocumentAttribute`); the Swift helper already captures it, this now carries it through instead of dropping it. `null` when the frontmost app exposes none. */
  documentPath: string | null;
}

interface SidecarWindowInfo {
  processName: string;
  bundleId: string;
  windowTitle: string;
  windowId: string;
  method: string;
  documentPath?: string | null;
  isOnscreen?: boolean;
  isMinimized?: boolean;
}

/**
 * Strips leading spinner/progress glyphs (Braille Patterns block, U+2800-
 * U+28FF — the frames used by common CLI spinners) from a window title.
 * Some terminal apps (e.g. Warp) put a live spinner in the title while a
 * command runs, which flips every ~second with no actual change in what
 * window is focused — without this, every glyph frame reads as a distinct
 * window and fragments one continuous session into a moment per second.
 * This is a sensor-level concern (deciding "is this actually a different
 * window" is the sensor's job, not momentClose's — see
 * docs/design/01-events-and-log.md), not a momentClose fix.
 */
export function normalizeWindowTitle(title: string): string {
  return title.replace(/^[⠀-⣿]+\s*/, '');
}

/**
 * Reads the sidecar JSON the Swift window-helper writes (bypasses node's TCC
 * denials — see .claude/CLAUDE.md). Ignores stale files (helper crashed/not
 * running) and captures that failed to get a title.
 */
export function readWindowSidecar(): WindowRef | null {
  const sidecarPath = getWindowInfoJsonPath();
  let raw: string;
  try {
    const stat = fs.statSync(sidecarPath);
    if (Date.now() - stat.mtimeMs > WINDOW_INFO_SIDECAR_STALE_MS) return null;
    raw = fs.readFileSync(sidecarPath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: SidecarWindowInfo;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed.method === 'failed' || parsed.method === 'none') return null;
  if (parsed.isMinimized || parsed.isOnscreen === false) return null;

  const windowClass = parsed.bundleId || parsed.processName.toLowerCase().replace(/\s+/g, '.');
  const windowId = parsed.windowId && parsed.windowId !== '0' ? `${windowClass}:${parsed.windowId}` : `${windowClass}:main`;

  return {
    processName: parsed.processName,
    windowTitle: normalizeWindowTitle(parsed.windowTitle),
    windowId,
    documentPath: typeof parsed.documentPath === 'string' && parsed.documentPath.length > 0 ? parsed.documentPath : null,
  };
}
