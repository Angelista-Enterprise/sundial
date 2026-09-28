import fs from 'node:fs';
import path from 'node:path';
import { getSundialHome } from './config.js';

/** ~/.sundial/.daemon — PID, logs, sidecar JSON, device id, etc. */
export function getSundialRuntimeDir(): string {
  return path.join(getSundialHome(), '.daemon');
}

export function getDaemonPidPath(): string {
  return path.join(getSundialRuntimeDir(), 'daemon.pid');
}

export function getDaemonStartedAtPath(): string {
  return path.join(getSundialRuntimeDir(), 'started-at');
}

export function getDaemonLogPath(): string {
  return path.join(getSundialRuntimeDir(), 'daemon.log');
}

/**
 * D4 (docs/audit/production-proposal-and-enhancements.md, fixes A§5.1's
 * "daemon read API") — the daemon generates and writes this once at
 * startup (`apps/daemon/src/daemon/daemon-runtime.ts`'s
 * `loadOrGenerateApiToken`); the CLI reads it to authenticate against the
 * loopback HTTP API (`apps/cli/src/cli/daemon-api-client.ts`). Lives in
 * `@sundial/helpers` (not `@sundial/daemon`) for the same reason
 * `getDaemonPidPath` does — both the daemon (writer) and the CLI (reader)
 * need the same path without the CLI depending on the daemon app's
 * internal modules.
 */
export function getApiTokenPath(): string {
  return path.join(getSundialRuntimeDir(), 'api-token');
}

/**
 * The app bundle. The real install keeps it in /Applications, where the owner
 * can open it like any app; `sundial install` puts that path in app.env as
 * SUNDIAL_APP_PATH, which the app hands to this process. A test install, or a
 * LaunchAgent install, keeps it in the data folder.
 */
// Not SUNDIAL_APP: the app sets that to "1" to tell the web process it runs under the app.
export function getSundialAppDir(): string {
  return process.env.SUNDIAL_APP_PATH || path.join(getSundialHome(), 'Sundial.app');
}

/** Sidecar JSON written by the Swift window-helper. */
export function getWindowInfoJsonPath(): string {
  return path.join(getSundialRuntimeDir(), 'window-info.json');
}

/** Ignore sidecar JSON older than this when deciding whether to use it. */
export const WINDOW_INFO_SIDECAR_STALE_MS = 3000;

/** Shell hook writes JSONL entries here (cwd/exitCode/durationMs per command) — preferred over history-file parsing when present. */
export function getShellHookFilePath(): string {
  return path.join(getSundialRuntimeDir(), 'shell-events.jsonl');
}

/** Sidecar JSON written by the launcher itself (FocusModeCapture.swift), every 1s. */
export function getFocusInfoJsonPath(): string {
  return path.join(getSundialRuntimeDir(), 'focus-info.json');
}

/**
 * Sidecar JSON written by the launcher itself (AvSnapshot.swift), every 1s.
 * Lives here, not in window-info.json, because only the launcher's process
 * identity gets accurate Camera TCC reads — see
 * macos-daemon-launcher/AvCamera.swift's comment (live-tested 2026-07-17).
 */
export function getAvContextJsonPath(): string {
  return path.join(getSundialRuntimeDir(), 'av-context.json');
}

/**
 * P7 (docs/design/07) — sidecar JSON written by the screen-OCR helper
 * (`sundial-screen-ocr-helper`, opt-in): the most recent capture's focused-app
 * process name, OCR text, and derived topic tags. Read by the `screen-ocr`
 * sensor with the same staleness gate as the other sidecars.
 */
/** The screen-text helper's own Screen Recording check (`accessGranted`), written when it changes. */
export function getScreenOcrStatusJsonPath(): string {
  return path.join(getSundialRuntimeDir(), 'screen-ocr-status.json');
}

export function getScreenOcrJsonPath(): string {
  return path.join(getSundialRuntimeDir(), 'screen-ocr.json');
}

/**
 * Sidecar JSON written by the launcher itself (SleepWakeCapture.swift) —
 * event-driven (NSWorkspace notifications), not polled, so this file only
 * updates on an actual sleep/wake transition, unlike the 1s-cadence sidecars
 * above.
 */
export function getSleepWakeInfoJsonPath(): string {
  return path.join(getSundialRuntimeDir(), 'sleep-wake-info.json');
}

/** Sidecar JSON written by the input-activity Swift helper, every 1s. */
export function getInputActivityJsonPath(): string {
  return path.join(getSundialRuntimeDir(), 'input-activity.json');
}

/** Sidecar JSON written by the notification Swift helper, every 30s by default. */
export function getNotificationBadgesJsonPath(): string {
  return path.join(getSundialRuntimeDir(), 'notification-badges.json');
}

/**
 * The ONE file that flows node → Swift: a phasic notice the launcher's
 * NoticePresenter should post as a native banner. Every other sidecar file goes
 * the other way (Swift writes, node reads), which is why this one is named for
 * its direction rather than for a helper.
 *
 * Written by `plugins/sundial-proactive/native-notify.js`, consumed and DELETED
 * by the launcher — a request that survives its own delivery would be re-posted
 * on the next poll.
 */
export function getNoticeRequestJsonPath(): string {
  return path.join(getSundialRuntimeDir(), 'notice-request.json');
}

/**
 * Filename prefix for verdict drops written by the NoticePresenter's
 * notification delegate — one file per button press
 * (`notice-verdict-<uuid>.json`), never an appended log.
 *
 * One-file-per-verdict because the alternative (appending to a single file)
 * needs offset bookkeeping across two processes that never handshake; a
 * whole-file write the reader deletes is atomic without any.
 */
export const NOTICE_VERDICT_PREFIX = 'notice-verdict-';

/** Path to the on-demand calendar-helper CLI binary, invoked via execFile (not a persistent sidecar). */
export function getCalendarHelperPath(): string {
  return path.join(getSundialAppDir(), 'Contents', 'MacOS', 'sundial-calendar-helper');
}

/**
 * Marker JSON the calendar sensor persists on each read (`calendar-capture.ts`).
 * Unlike the other sidecars this isn't written by a Swift helper on a timer —
 * the calendar helper is on-demand (EventKit, `execFile`), so its grant state
 * would otherwise be invisible to the hot `/status` path. The marker records
 * the last-known `accessGranted` so permission reporting doesn't have to spawn
 * the helper. See `getPermissionStatus` in `permission-status.ts`.
 */
export function getCalendarInfoJsonPath(): string {
  return path.join(getSundialRuntimeDir(), 'calendar-info.json');
}

/**
 * Marker JSON the network sensor persists when its reading is conclusive
 * (`location-network-capture.ts`). Same reason as `calendar-info.json`: there is
 * no Location Services sidecar to read, and the grant is only observable as a
 * side effect of `ipconfig getsummary` redacting the SSID, so the sensor records
 * what it inferred instead of making `/status` re-run the probe. Written only
 * for a decided true/false, never for an inconclusive read — see
 * `inferLocationServicesGrant` and `getPermissionStatus`.
 */
export function getLocationInfoJsonPath(): string {
  return path.join(getSundialRuntimeDir(), 'location-info.json');
}

/** The browser helper (persistent, spawned by the node `browser` sensor, re-execs itself disclaimed). */
export function getBrowserHelperPath(): string {
  // Its own bundle (see apps/daemon/scripts/app.sh): the Automation prompt is
  // only raised for a requester tccd can show as an app. The self-contained app
  // (apps/macos/scripts/package.sh) carries it in Contents/Helpers; a checkout
  // install stages it in the data folder.
  const inside = path.join(getSundialAppDir(), 'Contents', 'Helpers', 'SundialBrowserHelper.app', 'Contents', 'MacOS', 'sundial-browser-helper');
  if (fs.existsSync(inside)) return inside;
  return path.join(getSundialHome(), 'SundialBrowserHelper.app', 'Contents', 'MacOS', 'sundial-browser-helper');
}

/** Written by the browser helper on every tab change (and as a 30 s heartbeat): the active tab's origin+path, title, and authorization state. */
export function getBrowserInfoJsonPath(): string {
  return path.join(getSundialRuntimeDir(), 'browser-info.json');
}
