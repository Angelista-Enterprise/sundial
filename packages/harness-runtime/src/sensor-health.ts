/**
 * Sensor/sidecar health — the pure staleness classifier plus its check table,
 * ported from `apps/cli/src/cli/commands/doctor.ts` (the daemon-era doctor,
 * deleted with the CLI) so the `sundial-sensors` plugin can report health.
 * The classification semantics are identical; the deleted doctor.ts had the
 * long-form rationale (opt-in vs enabled, event-driven files, permission
 * attribution).
 *
 * There is NO respawning here, ever: the dsh process never manages TCC-gated
 * children. Health is a report for the owner, who restarts Sundial
 * (`node bin/sundial restart`) and re-grants TCC themselves.
 */
import fs from 'node:fs';
import {
  getAvContextJsonPath,
  getCalendarInfoJsonPath,
  getFocusInfoJsonPath,
  getInputActivityJsonPath,
  getNotificationBadgesJsonPath,
  getScreenOcrJsonPath,
  getSleepWakeInfoJsonPath,
  getWindowInfoJsonPath,
  getBrowserInfoJsonPath,
} from '@sundial/helpers/sundial-paths.js';
import { loadSundialConfig, type ResolvedSundialConfig } from '@sundial/helpers/sundial-config.js';
import { getPermissionStatus, type PermissionKey, type PermissionStatus } from '@sundial/helpers/permission-status.js';

/**
 * One sidecar JSON the Swift helpers/launcher write. `staleMs` is the cadence
 * beyond which a *timer-driven* sidecar not having updated means it's dead or
 * hung; `null` marks an event-driven (sleep-wake) or on-demand (calendar)
 * file whose mtime says nothing about liveness — presence alone is reported,
 * never flagged stale. `optIn`/`enabled` distinguish "owner chose off" from
 * "owner chose on but nothing is produced" (a fault, usually TCC).
 */
export interface SidecarCheck {
  label: string;
  path: string;
  staleMs: number | null;
  optIn?: boolean;
  enabled?: boolean;
  permission?: PermissionKey;
}

export type SidecarStatus = 'ok' | 'stale' | 'idle' | 'off' | 'blocked' | 'missing';

/** Pure classification of a sidecar from its file age (`null` = file absent). Identical to doctor.ts's. */
export function classifySidecar(check: SidecarCheck, ageMs: number | null): SidecarStatus {
  if (ageMs === null) {
    // An opt-in sensor the owner turned ON that has produced nothing is broken,
    // not off — the whole point of distinguishing `enabled` from `optIn`.
    if (check.optIn) return check.enabled ? 'blocked' : 'off';
    if (check.staleMs === null) return 'idle'; // event/on-demand: no output yet isn't a fault
    return 'missing';
  }
  if (check.staleMs !== null && ageMs > check.staleMs) return 'stale';
  return 'ok';
}

export function sidecarChecks(config: ResolvedSundialConfig = loadSundialConfig()): SidecarCheck[] {
  return [
    { label: 'window', path: getWindowInfoJsonPath(), staleMs: 10_000, permission: 'accessibility' },
    { label: 'focus-mode', path: getFocusInfoJsonPath(), staleMs: 10_000, permission: 'fullDiskAccess' },
    { label: 'audio/camera', path: getAvContextJsonPath(), staleMs: 10_000 },
    { label: 'input-activity', path: getInputActivityJsonPath(), staleMs: 10_000, permission: 'inputMonitoring' },
    { label: 'notifications', path: getNotificationBadgesJsonPath(), staleMs: 120_000, permission: 'accessibility' },
    {
      label: 'screen-ocr',
      path: getScreenOcrJsonPath(),
      // lane H (H2): no heartbeat. The helper writes this file only when it read
      // text, so a locked or blank screen left it "stale" for hours with nothing
      // wrong. Its grant (`screen-ocr-status.json`) is judged instead.
      staleMs: null,
      optIn: true,
      enabled: config.ocr.enabled,
      permission: 'screenRecording',
    },
    { label: 'sleep-wake', path: getSleepWakeInfoJsonPath(), staleMs: null },
    // Heartbeat every 30 s; the Automation grant is per browser and reported in the file itself (`authorized`).
    { label: 'browser', path: getBrowserInfoJsonPath(), staleMs: 65_000 },
    { label: 'calendar', path: getCalendarInfoJsonPath(), staleMs: null, permission: 'calendar' },
  ];
}

export interface SensorHealthEntry {
  label: string;
  status: SidecarStatus;
  ageMs: number | null;
  /** One-line reason when a denied TCC grant explains the no-output verdict; null = no denial known. */
  permissionReason: string | null;
  /** lane H: a timer-driven file, whose silence is a fault. */
  heartbeat?: boolean;
}

export interface SensorHealth {
  sidecars: SensorHealthEntry[];
  permissions: PermissionStatus[];
  /** OCR captures dropped because secure input held the keyboard, since boot. */
  ocrSecureInputDrops?: { count: number; lastAt: string | null };
}

function sidecarAgeMs(path: string, now: number): number | null {
  try {
    return now - fs.statSync(path).mtimeMs;
  } catch {
    return null; // absent (or unreadable) — treated as "no output"
  }
}

/** Same honesty rule as doctor.ts: only a hard `granted: false` is a reason; `null` is unknown, not a denial. */
function permissionReason(check: SidecarCheck, permissions: PermissionStatus[]): string | null {
  if (!check.permission) return null;
  const permission = permissions.find((p) => p.key === check.permission);
  if (!permission || permission.granted !== false) return null;
  return `${permission.label} is not granted — ${permission.hint}`;
}

/** Snapshot of every sidecar's freshness + the TCC grant states, as data (the plugin serves it; no console output). */
export function getSensorHealth(config?: ResolvedSundialConfig, now: number = Date.now()): SensorHealth {
  const permissions = getPermissionStatus();
  const sidecars = sidecarChecks(config).map((check) => {
    const ageMs = sidecarAgeMs(check.path, now);
    return {
      label: check.label,
      status: classifySidecar(check, ageMs),
      ageMs,
      permissionReason: permissionReason(check, permissions),
      heartbeat: check.staleMs !== null,
    };
  });
  return { sidecars, permissions };
}

// lane H (H1, H2, H8)
/** Audio helper states that mean hearing is on but nothing is being heard. */
export const MIC_TROUBLE_STATES = ['denied', 'no-transcriber', 'no-model', 'transcriber-failed', 'capture-failed', 'transcribe-failed'] as const;

export interface HealthSignalInputs {
  health: SensorHealth;
  /** `audio.enabled`: the microphone is only reported when hearing is on. */
  hearing: boolean;
  /** The audio helper's own status (`readAudioStatus`), or null. */
  audio: { state: string; at?: string } | null;
  /** mtime of the transcript file, ms, or null: a transcript newer than a transcribe failure means the failure passed. */
  transcriptMtimeMs: number | null;
  /** `ocr.enabled` and the OCR helper's own `accessGranted`, or null when it has not said. */
  ocr: boolean;
  ocrAccessGranted: boolean | null;
  configUnreadable: boolean;
  /** False where no Swift helpers run (not macOS, or `SUNDIAL_NATIVE_HELPERS=0`): no sidecar is judged. */
  nativeHelpers: boolean;
}

/**
 * The `sensor:health` payload: a STATE, deduped by `stateSignature` against
 * `state.observed`, so it reaches the log only when something changes. Only
 * sidecars with a heartbeat are judged (a timer-driven file, `staleMs` set):
 * an event-driven or on-demand file's silence says nothing (almanac: silence
 * is not a health signal). No ages, no messages: an age changes every poll
 * and would defeat the dedupe; a message can quote the file it failed on.
 */
export function healthSignal(inputs: HealthSignalInputs): Record<string, unknown> {
  const sidecars: Record<string, string> = {};
  if (inputs.nativeHelpers) {
    for (const s of inputs.health.sidecars) {
      if (s.status === 'off' || s.status === 'idle' || s.heartbeat !== true) continue;
      sidecars[s.label] = s.status;
    }
  }
  let microphone: string | null = null;
  if (inputs.hearing && inputs.nativeHelpers && inputs.audio) {
    microphone = inputs.audio.state;
    // One failed POST leaves the state behind until the next listen; it is
    // only trouble while nothing has been transcribed since.
    if (microphone === 'transcribe-failed' && inputs.transcriptMtimeMs !== null && inputs.audio.at && inputs.transcriptMtimeMs > Date.parse(inputs.audio.at)) microphone = 'listening';
  }
  return {
    timestamp: new Date().toISOString(),
    sidecars,
    microphone,
    screenRecording: inputs.ocr && inputs.nativeHelpers ? inputs.ocrAccessGranted : null,
    configUnreadable: inputs.configUnreadable,
  };
}
