import fs from 'node:fs';
import {
  getNotificationBadgesJsonPath,
  getWindowInfoJsonPath,
  getScreenOcrStatusJsonPath,
  getInputActivityJsonPath,
  getFocusInfoJsonPath,
  getCalendarInfoJsonPath,
  getLocationInfoJsonPath,
} from './sundial-paths.js';

/**
 * macOS TCC permissions Gnomon's sensors depend on. Deliberately the *grant*
 * axis only — distinct from signal freshness (`getSignalFreshness`), which
 * answers "has this sensor produced data recently". A sensor can be granted
 * and quiet (a sparse calendar) or ungranted and quiet; conflating the two is
 * exactly the false "Grant access" affordance this surface exists to fix
 * (docs/design/06-macos-ui-data-wiring.md).
 */
export type PermissionKey =
  | 'accessibility'
  | 'screenRecording'
  | 'inputMonitoring'
  | 'fullDiskAccess'
  | 'calendar'
  | 'locationServices';

export interface PermissionStatus {
  key: PermissionKey;
  label: string;
  /**
   * `true` granted, `false` denied, `null` unknown — the helper that would
   * report it isn't running / hasn't written its sidecar yet, so we can't
   * tell. Never guess "denied" from absence: that reintroduces the freshness
   * conflation. Only a present sidecar with a false grant flag is a denial.
   */
  granted: boolean | null;
  /** One line the UI shows when `granted` is false or null. */
  hint: string;
}

const HINTS: Record<PermissionKey, string> = {
  accessibility: 'Add "Sundial" to System Settings → Privacy & Security → Accessibility.',
  screenRecording: 'Add "Sundial" to System Settings → Privacy & Security → Screen Recording.',
  inputMonitoring: 'Add "Sundial" to System Settings → Privacy & Security → Input Monitoring.',
  fullDiskAccess: 'Only needed for Mail and Messages capture (off by default) and to read the Focus mode name. Leave it off unless you want those.',
  calendar: 'Grant "Sundial" Calendar access in System Settings → Privacy & Security → Calendars.',
  locationServices:
    'macOS hides Wi-Fi names without Location Services, so places show as gateway addresses. Sundial never asks for your location; name places in config.json (locationLabels) instead.',
};

const LABELS: Record<PermissionKey, string> = {
  accessibility: 'Accessibility',
  screenRecording: 'Screen Recording',
  inputMonitoring: 'Input Monitoring',
  fullDiskAccess: 'Full Disk Access',
  calendar: 'Calendar',
  locationServices: 'Location Services',
};

/** Reads a sidecar JSON without staleness-gating — grant state is slow-varying, so a stale-but-present file still reflects the last-known grant. Missing/unparseable → `null` (can't tell). */
function readSidecar(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `notification-badges.json` carries the launcher's `AXIsProcessTrusted()` result — the authoritative Accessibility check. */
function accessibilityGranted(): boolean | null {
  const sidecar = readSidecar(getNotificationBadgesJsonPath());
  if (!sidecar) return null;
  return sidecar.accessGranted === true;
}

/**
 * The window helper prefers AX for titles and only falls back to CGWindowList
 * (Screen Recording) when AX is unavailable. So: a `diagnostics.cgwindow`
 * denial note is a hard "denied"; a working `cgwindow` method is a "granted";
 * an `accessibility` method never exercises Screen Recording, so it's honestly
 * unknown rather than a guess either way.
 */
function screenRecordingGranted(): boolean | null {
  // The screen-text helper asks for Screen Recording itself and reports its own
  // answer; when it has, that is the grant that matters. Without it (OCR off),
  // the window helper's fallback below is the only evidence.
  const ocr = readSidecar(getScreenOcrStatusJsonPath());
  if (ocr && typeof ocr.accessGranted === 'boolean') return ocr.accessGranted;
  const sidecar = readSidecar(getWindowInfoJsonPath());
  if (!sidecar) return null;
  const diagnostics = sidecar.diagnostics as Record<string, unknown> | undefined;
  if (diagnostics && typeof diagnostics.cgwindow === 'string') return false;
  if (sidecar.method === 'cgwindow') return true;
  return null;
}

/** `input-activity.json.listenAccessGranted` = `CGPreflightListenEventAccess()` — the readers strip it, so read the sidecar directly here. */
function inputMonitoringGranted(): boolean | null {
  const sidecar = readSidecar(getInputActivityJsonPath());
  if (!sidecar) return null;
  return sidecar.listenAccessGranted === true;
}

/** `focus-info.json.assertionsReadable` = the launcher could read `~/Library/DoNotDisturb/DB/Assertions.json`, which requires Full Disk Access. */
function fullDiskAccessGranted(): boolean | null {
  const sidecar = readSidecar(getFocusInfoJsonPath());
  if (!sidecar) return null;
  return sidecar.assertionsReadable === true;
}

/** Calendar's grant lives in the marker the calendar sensor persists (`calendar-capture.ts`) — the EventKit helper is on-demand, not a timer sidecar. */
function calendarGranted(): boolean | null {
  const sidecar = readSidecar(getCalendarInfoJsonPath());
  if (!sidecar) return null;
  return sidecar.accessGranted === true;
}

/**
 * Location Services has no preflight API and no sidecar of its own — the grant is
 * only observable as a side effect of macOS redacting the SSID from
 * `ipconfig getsummary`. So the network sensor infers it on each poll
 * (`inferLocationServicesGrant`) and leaves a marker here; absent marker → `null`,
 * meaning the sensor hasn't reached a conclusive reading yet (never polled, no
 * WiFi interface, or mid-association).
 *
 * Caveat worth knowing before trusting a stuck `false`: like Full Disk Access,
 * this permission is evaluated against the responsibility chain, which bottoms
 * out at whatever started the launcher rather than the app bundle — and an
 * app only appears in the Location Services list once it has actually requested
 * authorization, which `ipconfig` never does on our behalf. Granting to
 * "Sundial" may therefore not be offered; that needs a CoreLocation-requesting
 * helper, the same shape of fix as the FDA `posix_spawn` disclaim workaround.
 */
function locationServicesGranted(): boolean | null {
  const sidecar = readSidecar(getLocationInfoJsonPath());
  if (!sidecar) return null;
  if (typeof sidecar.locationServicesGranted !== 'boolean') return null;
  return sidecar.locationServicesGranted;
}

function toStatus(key: PermissionKey, granted: boolean | null): PermissionStatus {
  return { key, label: LABELS[key], granted, hint: HINTS[key] };
}

/**
 * Real TCC grant state for the sensors that need it, read from the sidecars
 * the Swift helpers write. Backs `/status`'s `permissions` field and the
 * Observability "Access & permissions" section — the honest replacement for
 * inferring "denied" from a sensor having gone quiet.
 */
export function getPermissionStatus(): PermissionStatus[] {
  return [
    toStatus('accessibility', accessibilityGranted()),
    toStatus('screenRecording', screenRecordingGranted()),
    toStatus('inputMonitoring', inputMonitoringGranted()),
    toStatus('fullDiskAccess', fullDiskAccessGranted()),
    toStatus('calendar', calendarGranted()),
    toStatus('locationServices', locationServicesGranted()),
  ];
}
