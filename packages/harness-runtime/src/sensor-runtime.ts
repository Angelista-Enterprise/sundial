/**
 * SensorRuntime — Gnomon's 20 sensors, packaged for the dsh process
 * (Phase 3 of PLAN.md; the `gnomon-sensors` plugin is the thin adapter).
 *
 * ORIGIN: ported from `apps/daemon/src/daemon/index.ts` — sensor
 * construction (:171-201), the cross-sensor wiring (`crossWire`,
 * :1296-1384), the poll tick with overlap-drop (`pollTick` /
 * `pollTickGuarded`, :1386-1505), and the boot rehydration of known project
 * roots (:1702-1712). The daemon's `serialized()` wrapper around every
 * ingest is NOT reproduced here: `appendSignal` (KernelRuntime) already
 * serializes the whole sanitize→log→fold→effects pipeline on the kernel's
 * one event lane, so awaiting it gives the same strict ordering.
 *
 * INVARIANT (PLAN.md #6): this process never spawns TCC-gated subprocesses.
 * Every macOS-permission-gated sensor here READS a sidecar JSON written by
 * the Swift launcher's children (`~/.sundial/Sundial.app`, started
 * separately via `apps/harness/bin/sundial-sidecars.js`). Sidecar staleness
 * is surfaced by `getSensorHealth()`; nothing is ever respawned from here.
 *
 * SANCTIONED EXCEPTION — calendar (grandfathered, PLAN.md Phase 3 decision):
 * `CalendarSensor` still `execFile`s `sundial-calendar-helper` from the app
 * bundle on demand, exactly as the daemon did. EventKit has no
 * file-sidecar shape (the helper answers a query, it doesn't stream state),
 * and the helper carries the bundle's code identity. Note the TCC
 * responsibility chain now bottoms out at whatever starts dsh (the terminal
 * or launchd), so Calendar consent may need re-granting after the cutover.
 */
import fs from 'node:fs';
import { getSundialHome } from '@sundial/helpers/config.js';
import os from 'node:os';
import path from 'node:path';
import { loadSundialConfig, type ResolvedSundialConfig } from '@sundial/helpers/sundial-config.js';
import { getAllProjects } from '@sundial/db/index.js';
import { consentedNetworkFingerprint } from '@sundial/rules/presence-track.js';
import type { KernelState } from '@sundial/kernel/index.js';
import {
  AgentFleetSensor,
  AgentSessionSensor,
  AudioContextSensor,
  ScreenOcrSensor,
  AudioTranscriptSensor,
  BluetoothAudioSensor,
  CalendarSensor,
  ClipboardMetaSensor,
  FileWatcherSensor,
  FocusModeSensor,
  GitHubPrSensor,
  GitSensor,
  InputActivitySensor,
  LocationNetworkSensor,
  NotificationSensor,
  PresenceSensor,
  ProjectSensor,
  ShellSensor,
  SleepWakeSensor,
  BrowserSensor,
  SymbolEditSensor,
  SystemPowerSensor,
  VaultSensor,
  ScreenVisionSensor,
  MailSensor,
  BrowserHelperSupervisor,
  localFilePathFromDocument,
  pollWindowSensor,
} from '@sundial/sensors/index.js';
import { getSensorHealth, type SensorHealth } from './sensor-health.js';

/**
 * C3 — `projects.rootPath` is stored already-redacted (`~/...`), but
 * GitSensor/FileWatcherSensor need a real filesystem path. Ported verbatim.
 */
export function expandHomePath(storedPath: string): string {
  if (storedPath === '~') return os.homedir();
  if (storedPath.startsWith('~/')) return path.join(os.homedir(), storedPath.slice(2));
  return storedPath;
}

export interface SensorRuntimeOptions {
  /** `ctx.gnomonKernel.appendSignal` — sanitize-at-ingest + fold, serialized on the kernel's lane. */
  appendSignal: (type: string, payload: Record<string, unknown>, ts?: string) => Promise<void>;
  /** `ctx.gnomonKernel.getState` — live KernelState for the shell focus gate and the presence consent gate. */
  getState: () => KernelState | null;
  /** Known-project rows for boot rehydration; defaults to @sundial/db's own query (the plugin passes gnomonDb's). */
  getAllProjects?: () => Promise<{ rootPath: string }[]>;
  /** Injectable for tests; defaults to `loadSundialConfig()`. */
  config?: ResolvedSundialConfig;
}

export class SensorRuntime {
  private readonly appendSignal: SensorRuntimeOptions['appendSignal'];
  private readonly getState: SensorRuntimeOptions['getState'];
  private readonly getAllProjectsFn: () => Promise<{ rootPath: string }[]>;
  private readonly config: ResolvedSundialConfig;

  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;

  // The 20 sensors, constructed exactly as the daemon did (:171-201).
  // Event-driven ones (git sweep, file watcher) push through the same
  // handleSensorEvent path as poll-driven ones.
  private readonly gitSensor = new GitSensor((e) => {
    void this.handleSensorEvent(e.type, e.payload).catch((error) => console.error('[sundial-sensors] git event failed:', error));
  });
  private readonly fileWatcherSensor = new FileWatcherSensor((e) => {
    void this.handleSensorEvent(e.type, e.payload).catch((error) => console.error('[sundial-sensors] file event failed:', error));
  });
  private readonly symbolEditSensor = new SymbolEditSensor();
  private readonly vaultSensor: VaultSensor | null;
  private readonly githubPrSensor = new GitHubPrSensor();
  private readonly shellSensor = new ShellSensor();
  private readonly projectSensor = new ProjectSensor();
  private readonly agentSessionSensor = new AgentSessionSensor();
  private readonly agentFleetSensor = new AgentFleetSensor();
  private readonly calendarSensor = new CalendarSensor();
  private readonly focusModeSensor = new FocusModeSensor();
  private readonly inputActivitySensor = new InputActivitySensor();
  private readonly notificationSensor = new NotificationSensor();
  private readonly audioContextSensor = new AudioContextSensor();
  private readonly bluetoothAudioSensor = new BluetoothAudioSensor();
  private readonly systemPowerSensor = new SystemPowerSensor();
  private readonly locationNetworkSensor = new LocationNetworkSensor();
  private readonly presenceSensor = new PresenceSensor();
  private readonly sleepWakeSensor = new SleepWakeSensor();
  private readonly browserSensor: BrowserSensor;
  /** J3.3: a local vision model over the OCR helper's frame, when `ocr.vision.enabled`. */
  private readonly screenVisionSensor: ScreenVisionSensor;
  /** J3.6: Mail.app / Messages subjects and senders, when `privacy.mail` (and Full Disk Access). */
  private readonly mailSensor: MailSensor;
  /** Opt-in, off by default — gated on `config.clipboardEnabled`, same as the daemon's startDaemon reconstruction. */
  private readonly clipboardMetaSensor: ClipboardMetaSensor;
  /** P7 — gated on `config.ocr.enabled` (default off); inert until the owner opts in. */
  private readonly screenOcrSensor: ScreenOcrSensor;
  private readonly audioTranscriptSensor: AudioTranscriptSensor;
  private readonly hearingWindowPath: string;
  /** Last window written, so a one-second poll does not rewrite an unchanged file. */
  private lastHearingWindow = '';

  constructor(options: SensorRuntimeOptions) {
    this.appendSignal = options.appendSignal;
    this.getState = options.getState;
    this.getAllProjectsFn = options.getAllProjects ?? getAllProjects;
    this.config = options.config ?? loadSundialConfig();
    this.clipboardMetaSensor = new ClipboardMetaSensor(this.config.clipboardEnabled);
    this.screenOcrSensor = new ScreenOcrSensor({ enabled: this.config.ocr.enabled });
    this.audioTranscriptSensor = new AudioTranscriptSensor({ enabled: this.config.audio.enabled, languages: this.config.audio.languages });
    // J3.4: the helper reads the page's text too when the owner has not turned it off; the browser must allow JavaScript from Apple Events.
    this.browserSensor = new BrowserSensor({ supervisor: new BrowserHelperSupervisor(undefined, this.config.browser.pageText ? ['--page-text'] : []) });
    this.screenVisionSensor = new ScreenVisionSensor({ enabled: this.config.ocr.enabled && this.config.ocr.vision.enabled, model: this.config.ocr.vision.model, intervalMs: this.config.ocr.vision.intervalMs });
    this.mailSensor = new MailSensor({ enabled: this.config.privacy.mail });
    this.hearingWindowPath = path.join(getSundialHome(), '.daemon', 'audio-listen.json');
    // J3.5: the vault, only when the owner named one. Paths only.
    this.vaultSensor = this.config.vault
      ? new VaultSensor(expandHomePath(this.config.vault), (e) => {
          void this.handleSensorEvent(e.type, e.payload).catch((error) => console.error('[sundial-sensors] vault event failed:', error));
        })
      : null;
  }

  /**
   * Boot rehydration + timers. Ported from startDaemon (:1702-1716): without
   * the rehydration a restart leaves the git sweep and the file watcher blind
   * to every already-known project until a fresh trigger re-detects it.
   */
  async start(): Promise<void> {
    const knownProjects = await this.getAllProjectsFn();
    for (const project of knownProjects) {
      const root = expandHomePath(project.rootPath);
      this.gitSensor.registerKnownRoot(root);
      this.fileWatcherSensor.notifyProjectDetected(root);
    }
    if (knownProjects.length > 0) {
      console.log(`[sundial-sensors] rehydrated ${knownProjects.length} known project root(s) for git sweep + file watch`);
    }

    this.gitSensor.start();
    if (this.vaultSensor) console.log(`[sundial-sensors] vault watch ${this.vaultSensor.start() ? 'on' : 'could not start'}: ${this.config.vault}`);

    this.pollTimer = setInterval(() => {
      this.pollTickGuarded().catch((error) => console.error('[sundial-sensors] poll tick failed:', error));
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.gitSensor.stop();
    this.fileWatcherSensor.stop();
    this.vaultSensor?.stop();
    this.browserSensor.stop();
  }

  /** Sidecar freshness + TCC grant snapshot (never respawns anything). */
  getSensorHealth(): SensorHealth {
    return getSensorHealth(this.config);
  }

  /**
   * Ingest an event, then cross-wire it — using the RAW (pre-sanitize)
   * payload, since `crossWire` walks the real filesystem and needs real
   * paths, not the `~`-rewritten ones sanitize produces for storage.
   * `appendSignal` never mutates its input, so the payload is safe to reuse.
   */
  private async handleSensorEvent(type: string, payload: Record<string, unknown>, ts?: string): Promise<void> {
    await this.appendSignal(type, payload, ts);
    await this.crossWire(type, payload);
  }

  /** Cross-sensor wiring, ported verbatim from the daemon's crossWire (:1301-1384). */
  private async crossWire(type: string, payload: Record<string, unknown>): Promise<void> {
    if (type === 'project:detected') {
      const projectRoot = payload.projectRoot;
      if (typeof projectRoot === 'string') {
        this.gitSensor.registerKnownRoot(projectRoot);
        this.fileWatcherSensor.notifyProjectDetected(projectRoot);
      }
      return;
    }

    // A focused editor window exposes the open file's path (AX documentPath) —
    // the trigger that lets editor-only projects get detected. URI → local
    // path via localFilePathFromDocument (browser URLs yield null, skipped).
    if (type === 'window:changed') {
      const documentPath = localFilePathFromDocument(typeof payload.documentPath === 'string' ? payload.documentPath : null);
      if (documentPath) {
        for (const e of this.projectSensor.notifyPath(path.dirname(documentPath))) {
          await this.handleSensorEvent(e.type, e.payload);
        }
      }
      return;
    }

    // The coding agent's own session cwd is a project locator exactly like a shell's.
    if (type === 'agent:session') {
      const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
      if (cwd) {
        for (const e of this.projectSensor.notifyPath(cwd)) {
          await this.handleSensorEvent(e.type, e.payload);
        }
      }
      return;
    }

    if (type === 'shell:command') {
      const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
      const command = typeof payload.command === 'string' ? payload.command : '';
      const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : null;
      this.gitSensor.notifyShellCommand(command, cwd, exitCode);
      for (const e of this.projectSensor.notifyPath(cwd)) {
        await this.handleSensorEvent(e.type, e.payload);
      }
      return;
    }

    if (type === 'git:status') {
      const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
      const branch = typeof payload.branch === 'string' ? payload.branch : null;
      if (cwd && branch) this.githubPrSensor.notifyGitStatus(cwd, branch);
      for (const e of this.projectSensor.notifyPath(cwd)) {
        await this.handleSensorEvent(e.type, e.payload);
      }
      return;
    }

    if (type === 'file:changed') {
      const projectRoot = typeof payload.projectRoot === 'string' ? payload.projectRoot : null;
      const changes = (Array.isArray(payload.changes) ? payload.changes : []) as { relPath: string; kind: 'add' | 'modify' | 'delete' }[];
      if (!projectRoot) return;
      // file:changed is a project-detection trigger too (branch-change
      // re-detection while editing) — see the daemon's comment.
      for (const e of this.projectSensor.notifyPath(projectRoot)) {
        await this.handleSensorEvent(e.type, e.payload);
      }
      const symbolEvent = await this.symbolEditSensor.handleFileChanged(projectRoot, changes);
      if (symbolEvent) await this.handleSensorEvent(symbolEvent.type, symbolEvent.payload);
    }
  }

  /** One poll pass over every poll-driven sensor. Ported verbatim from pollTick (:1386-1485); each sensor self-gates internally. */
  private async pollTick(): Promise<void> {
    const windowEvent = pollWindowSensor();
    if (windowEvent) {
      await this.handleSensorEvent(windowEvent.type, { ...windowEvent.payload });
    }

    // Shell focus gate: commands read from the hook file are attributed to a
    // focused terminal via the LIVE kernel state's active window.
    const currentProcessName = this.getState()?.window.active?.processName ?? null;
    for (const shellEvent of this.shellSensor.poll(currentProcessName)) {
      // L2 — the command's own captured time becomes the event ts (replay
      // orders by ULID id, never by ts, so historical ts values are safe).
      const capturedTs = typeof shellEvent.payload.timestamp === 'string' ? shellEvent.payload.timestamp : undefined;
      await this.handleSensorEvent(shellEvent.type, shellEvent.payload, capturedTs);
    }

    await this.handleSensorEvent('agent:session', this.agentSessionSensor.poll().payload);
    await this.handleSensorEvent('agent:fleet', this.agentFleetSensor.poll().payload);

    const focusModeEvent = this.focusModeSensor.poll();
    if (focusModeEvent) {
      await this.handleSensorEvent(focusModeEvent.type, focusModeEvent.payload);
    }

    // The browser tab: the helper is spawned by the sensor on first poll and
    // re-execs itself disclaimed (see macos-browser-helper.swift).
    for (const factEvent of this.screenVisionSensor.poll()) {
      await this.handleSensorEvent(factEvent.type, factEvent.payload);
    }
    for (const mailEvent of this.mailSensor.poll()) {
      await this.handleSensorEvent(mailEvent.type, mailEvent.payload);
    }
    for (const browserEvent of this.browserSensor.poll()) {
      await this.handleSensorEvent(browserEvent.type, browserEvent.payload);
    }

    const inputActivityEvent = this.inputActivitySensor.poll();
    if (inputActivityEvent) {
      await this.handleSensorEvent(inputActivityEvent.type, inputActivityEvent.payload);
    }

    const notificationEvent = this.notificationSensor.poll();
    if (notificationEvent) {
      await this.handleSensorEvent(notificationEvent.type, notificationEvent.payload);
    }

    // Calendar is on-demand (execFile — the grandfathered TCC exception, see
    // the file header), self-gated to its own poll interval internally.
    const calendarEvents = await this.calendarSensor.poll();
    for (const calendarEvent of calendarEvents) {
      await this.handleSensorEvent(calendarEvent.type, calendarEvent.payload);
    }

    const audioContextEvents = this.audioContextSensor.poll();
    for (const audioContextEvent of audioContextEvents) {
      await this.handleSensorEvent(audioContextEvent.type, audioContextEvent.payload);
    }

    const screenOcrEvents = this.screenOcrSensor.poll();
    for (const screenOcrEvent of screenOcrEvents) {
      await this.handleSensorEvent(screenOcrEvent.type, screenOcrEvent.payload);
    }

    // Tell the audio sidecar whether to have the microphone open. The DECISION
    // is the `hearingWindow` rule's, folded into state like everything else;
    // this only projects it onto the file the Swift helper watches, because a
    // sidecar cannot read `KernelState`.
    this.publishHearingWindow();

    // Ambient hearing. Reads whatever the audio sidecar appended since the last
    // poll, so a pause here delays utterances rather than dropping them.
    const audioTranscriptEvents = this.audioTranscriptSensor.poll();
    for (const audioTranscriptEvent of audioTranscriptEvents) {
      await this.handleSensorEvent(audioTranscriptEvent.type, audioTranscriptEvent.payload);
    }

    // bluetooth-audio/system-power/location-network/clipboard-meta all
    // self-gate to their own (much longer) poll intervals internally.
    const bluetoothEvents = await this.bluetoothAudioSensor.poll();
    for (const bluetoothEvent of bluetoothEvents) {
      await this.handleSensorEvent(bluetoothEvent.type, bluetoothEvent.payload);
    }

    const systemPowerEvent = await this.systemPowerSensor.poll();
    if (systemPowerEvent) {
      await this.handleSensorEvent(systemPowerEvent.type, systemPowerEvent.payload);
    }

    const locationNetworkEvent = await this.locationNetworkSensor.poll();
    if (locationNetworkEvent) {
      await this.handleSensorEvent(locationNetworkEvent.type, locationNetworkEvent.payload);
    }

    const clipboardEvent = await this.clipboardMetaSensor.poll();
    if (clipboardEvent) {
      await this.handleSensorEvent(clipboardEvent.type, clipboardEvent.payload);
    }

    // Presence consent gate: a subnet sweep runs only on a network the owner
    // explicitly granted — `consentedNetworkFingerprint` over the LIVE state
    // keeps the permission in exactly one place (the folded presence:consent events).
    const state = this.getState();
    const presenceEvent = state?.config.experiments?.presence ? await this.presenceSensor.poll(consentedNetworkFingerprint(state)) : null;
    if (presenceEvent) {
      await this.handleSensorEvent(presenceEvent.type, presenceEvent.payload);
    }

    const prEvents = await this.githubPrSensor.poll();
    for (const prEvent of prEvents) {
      await this.handleSensorEvent(prEvent.type, prEvent.payload);
    }

    // Event-driven sidecar (launcher writes on an actual NSWorkspace
    // sleep/wake notification) — cheap no-op file read otherwise.
    const sleepWakeEvent = this.sleepWakeSensor.poll();
    if (sleepWakeEvent) {
      await this.handleSensorEvent(sleepWakeEvent.type, sleepWakeEvent.payload);
    }
  }

  /**
   * A6 — overlap drop, ported verbatim: a tick that fires while the previous
   * one is still running is DROPPED (not queued). Every sensor self-gates to
   * its own interval internally, so a dropped tick is a free no-op.
   */
  async pollTickGuarded(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      await this.pollTick();
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * Project the `hearingWindow` rule's decision onto the file the Swift audio
   * sidecar watches. The DECISION is the rule's and is folded into state like
   * everything else; this is only the handoff, because a sidecar cannot read
   * `KernelState`.
   */
  private publishHearingWindow(): void {
    if (!this.config.audio.enabled) return;
    // A snapshot written before `hearing` existed replays without the field, so
    // boot can legitimately reach here with nothing to publish. Silence is the
    // right default: hearing stays asleep until a rule wakes it.
    const hearing = this.getState()?.hearing;
    if (!hearing) return;
    const payload = JSON.stringify({
      listen: hearing.listening,
      reason: hearing.reason,
      until: hearing.until,
      title: hearing.title,
    });
    // ponytail: the existsSync is what makes this self-healing — write-on-change
    // alone leaves a deleted file gone until state next changes, which on a quiet
    // day is hours. One stat per poll is cheaper than a helper with no instruction.
    if (payload === this.lastHearingWindow && fs.existsSync(this.hearingWindowPath)) return;
    this.lastHearingWindow = payload;
    try {
      // Atomic, like every other sidecar handoff: the helper polls this file
      // and must never read a half-written one and stop mid-meeting.
      const tmp = `${this.hearingWindowPath}.tmp`;
      fs.writeFileSync(tmp, `${payload}\n`);
      fs.renameSync(tmp, this.hearingWindowPath);
    } catch {
      // A window that cannot be published leaves the helper on its last
      // instruction, which is the safe direction: a meeting keeps being heard.
    }
  }

}
