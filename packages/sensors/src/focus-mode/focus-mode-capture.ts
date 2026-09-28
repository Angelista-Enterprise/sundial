import fs from 'node:fs';
import { getFocusInfoJsonPath } from '@sundial/helpers/sundial-paths.js';

export type FocusModeState = 'off' | 'do-not-disturb' | 'work' | 'personal' | 'sleep' | 'custom';

export interface FocusModeSnapshot {
  state: FocusModeState;
  name?: string;
  modeIdentifier?: string;
  assertionsReadable: boolean;
}

const STALE_MS = 5000;

/**
 * Reads the sidecar the launcher itself writes (FocusModeCapture.swift,
 * embedded — not a separate helper binary). `assertionsReadable: false`
 * means Full Disk Access isn't granted to the terminal that ran
 * `gnomon start` — see .claude/CLAUDE.md's TCC section.
 */
export function readFocusModeSidecar(): FocusModeSnapshot | null {
  const sidecarPath = getFocusInfoJsonPath();
  try {
    const stat = fs.statSync(sidecarPath);
    if (Date.now() - stat.mtimeMs > STALE_MS) return null;
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    return {
      state: parsed.state,
      name: parsed.name ?? undefined,
      modeIdentifier: parsed.modeIdentifier ?? undefined,
      assertionsReadable: parsed.assertionsReadable === true,
    };
  } catch {
    return null;
  }
}
