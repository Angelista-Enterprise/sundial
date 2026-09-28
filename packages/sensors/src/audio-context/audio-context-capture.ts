import fs from 'node:fs';
import { getAvContextJsonPath, WINDOW_INFO_SIDECAR_STALE_MS } from '@sundial/helpers/sundial-paths.js';

export interface AvProcessUsage {
  pid: number;
  processName: string;
  bundleId?: string;
}

export interface AvSnapshot {
  microphoneActive: boolean;
  cameraActive: boolean;
  audioInputProcesses: AvProcessUsage[];
  audioOutputProcesses: AvProcessUsage[];
  cameraProcesses: AvProcessUsage[];
}

/**
 * Reads `av-context.json`, written by the launcher (not window-helper) every
 * 1s. Originally this shared window-info.json (matching WCS's single-sidecar
 * design), but live testing (2026-07-17) found window-helper's process
 * identity can never get an accurate Camera TCC read — see
 * macos-daemon-launcher/AvCamera.swift's comment — so AV capture moved to
 * its own sidecar, owned by the launcher.
 */
export function readAvSnapshot(): AvSnapshot | null {
  const sidecarPath = getAvContextJsonPath();
  try {
    const stat = fs.statSync(sidecarPath);
    if (Date.now() - stat.mtimeMs > WINDOW_INFO_SIDECAR_STALE_MS) return null;
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    return {
      microphoneActive: parsed.microphoneActive === true,
      cameraActive: parsed.cameraActive === true,
      audioInputProcesses: parsed.audioInputProcesses ?? [],
      audioOutputProcesses: parsed.audioOutputProcesses ?? [],
      cameraProcesses: parsed.cameraProcesses ?? [],
    };
  } catch {
    return null;
  }
}
