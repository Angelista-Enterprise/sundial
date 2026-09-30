/**
 * SensorRuntime — Gnomon's 28 capture sources, packaged for the dsh process
 * (Phase 3 of PLAN.md; the `sundial-sensors` plugin is the thin adapter).
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
 * the Swift launcher's children (Sundial.app starts the launcher as its own
 * child; a --no-app install's LaunchAgent runs
 * `apps/harness/bin/sundial-sidecars.js start`). Sidecar staleness
 * is surfaced by `getSensorHealth()`; nothing is ever respawned from here.
 *
 * SANCTIONED EXCEPTION — calendar (grandfathered, PLAN.md Phase 3 decision):
 * `CalendarSensor` still `execFile`s `sundial-calendar-helper` from the app
 * bundle on demand, exactly as the daemon did. EventKit has no
 * file-sidecar shape (the helper answers a query, it doesn't stream state),
 * and the helper carries the bundle's code identity. The TCC
 * responsibility chain bottoms out at whatever starts dsh: Sundial.app, or
 * launchd for a --no-app install.
 */
import fs from 'node:fs';
import { getSundialHome } from '@sundial/helpers/config.js';
import os from 'node:os';
import path from 'node:path';
import { loadSundialConfig, type ResolvedSundialConfig } from '@sundial/helpers/sundial-config.js';
import { getAllProjects } from '@sundial/db/index.js';
import { openLlmAudit } from '@sundial/llm/audit.js';
import { consentedNetworkFingerprint } from '@sundial/rules/presence-track.js';
import type { KernelState } from '@sundial/kernel/index.js';
import {
  AgentFleetSensor,
  ArcTabsSensor,
  AgentSessionSensor,
  ClaudeHookSensor,
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
  readAudioStatus,
} from '@sundial/sensors/index.js';
import { getSensorHealth, healthSignal, type SensorHealth } from './sensor-health.js';
// lane H
import { isSundialConfigUnreadable } from '@sundial/helpers/sundial-config.js';
import { getScreenOcrStatusJsonPath } from '@sundial/helpers/sundial-paths.js';

/** lane H (H2): how often the sidecars' health is read into a `sensor:health` state. */
export const HEALTH_POLL_MS = 60_000;

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
  /** W5: `ctx.gnomonKernel.reserveLlmCall`, the one budget gate, for the sensors that call a model (screen vision). */
  reserveLlmCall?: (purpose: 'vision', options: { caller: string }) => Promise<string | null>;
}

export class SensorRuntime {
  private readonly appendSignal: SensorRuntimeOptions['appendSignal'];
  private readonly getState: SensorRuntimeOptions['getState'];
  private readonly getAllProjectsFn: () => Promise<{ rootPath: string }[]>;
  private readonly config: ResolvedSundialConfig;

  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;

  // The sensors, constructed as the daemon did (:171-201), plus the ones added since.
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
  private readonly arcTabsSensor = new ArcTabsSensor();
  private readonly claudeHookSensor = new ClaudeHookSensor();
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
  /** J3.6: Mail.app subjects and senders when `privacy.mail`, Messages senders when `privacy.messages` (both need Full Disk Access). */
  private readonly mailSensor: MailSensor;
  /** Opt-in, off by default — gated on `config.clipboardEnabled`, same as the daemon's startDaemon reconstruction. */
  private readonly clipboardMetaSensor: ClipboardMetaSensor;
  /** P7 — gated on `config.ocr.enabled` (default off); inert until the owner opts in. */
  private readonly screenOcrSensor: ScreenOcrSensor;
  private readonly audioTranscriptSensor: AudioTranscriptSensor;
  private readonly hearingWindowPath: string;
  /** Last window written, so a one-second poll does not rewrite an unchanged file. */
  private lastHearingWindow = '';
  // lane H (H2, H8)
  /** When `sensor:health` was last read; the first poll reads it at once. */
  private lastHealthAt = 0;
  /** Read at boot, with the config it describes: the defaults this process runs on. */
  private readonly configUnreadable = isSundialConfigUnreadable();

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
    this.screenVisionSensor = new ScreenVisionSensor({ enabled: this.config.ocr.enabled && this.config.ocr.vision.enabled, model: this.config.ocr.vision.model, intervalMs: this.config.ocr.vision.intervalMs, openAudit: openLlmAudit, ...(options.reserveLlmCall ? { reserve: (purpose) => options.reserveLlmCall!(purpose, { caller: 'screen-vision' }) } : {}) });
    this.mailSensor = new MailSensor({ enabled: this.config.privacy.mail, messages: this.config.privacy.messages });
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
    return { ...getSensorHealth(this.config), ocrSecureInputDrops: { ...this.screenOcrSensor.secureInputDrops } };
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

  /**
   * One poll pass over every poll-driven sensor. Ported from pollTick (:1386-1485); each sensor self-gates internally.
   * Each sensor runs in its own `step`, so one that throws loses only its own
   * reading for this tick, never every sensor after it.
   */
  private async pollTick(): Promise<void> {
    type Emitted = { type: string; payload: object };
    const emit = async (events: Iterable<Emitted> | Emitted | null | undefined): Promise<void> => {
      if (!events) return;
      for (const e of Symbol.iterator in events ? events : [events]) await this.handleSensorEvent(e.type, { ...e.payload } as Record<string, unknown>);
    };
    const step = async (name: string, run: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await run();
      } catch (error) {
        console.error(`[sundial-sensors] ${name} poll failed:`, error);
      }
    };

    await step('window', () => emit(pollWindowSensor()));

    // Shell focus gate: commands read from the hook file are attributed to a
    // focused terminal via the LIVE kernel state's active window.
    await step('shell', async () => {
      const currentProcessName = this.getState()?.window.active?.processName ?? null;
      for (const shellEvent of this.shellSensor.poll(currentProcessName)) {
        // L2 — the command's own captured time becomes the event ts (replay
        // orders by ULID id, never by ts, so historical ts values are safe).
        const capturedTs = typeof shellEvent.payload.timestamp === 'string' ? shellEvent.payload.timestamp : undefined;
        await this.handleSensorEvent(shellEvent.type, shellEvent.payload, capturedTs);
      }
    });

    await step('agent-session', () => this.handleSensorEvent('agent:session', this.agentSessionSensor.poll().payload));
    await step('agent-fleet', () => this.handleSensorEvent('agent:fleet', this.agentFleetSensor.poll().payload));
    // Claude Code's report-only hooks, at each line's own time.
    await step('claude-hook', async () => {
      for (const hook of this.claudeHookSensor.poll()) await this.handleSensorEvent(hook.type, hook.payload, hook.ts);
    });

    await step('focus-mode', () => emit(this.focusModeSensor.poll()));
    // The browser tab: the helper is spawned by the sensor on first poll and
    // re-execs itself disclaimed (see macos-browser-helper.swift).
    await step('screen-vision', () => emit(this.screenVisionSensor.poll()));
    await step('mail', () => emit(this.mailSensor.poll()));
    await step('browser', () => emit(this.browserSensor.poll()));
    // Arc's tabs in the focused space, on change only (UC2: restore the space the owner left).
    await step('arc-tabs', () => emit(this.arcTabsSensor.poll()));
    await step('input-activity', () => emit(this.inputActivitySensor.poll()));
    await step('notification', () => emit(this.notificationSensor.poll()));

    // Calendar is on-demand (execFile — the grandfathered TCC exception, see
    // the file header), self-gated to its own poll interval internally.
    await step('calendar', async () => emit(await this.calendarSensor.poll()));
    await step('audio-context', () => emit(this.audioContextSensor.poll()));
    await step('screen-ocr', () => emit(this.screenOcrSensor.poll()));

    // Tell the audio sidecar whether to have the microphone open. The DECISION
    // is the `hearingWindow` rule's, folded into state like everything else;
    // this only projects it onto the file the Swift helper watches, because a
    // sidecar cannot read `KernelState`.
    await step('hearing-window', () => this.publishHearingWindow());

    // Ambient hearing. Reads whatever the audio sidecar appended since the last
    // poll, so a pause here delays utterances rather than dropping them.
    await step('audio-transcript', () => emit(this.audioTranscriptSensor.poll()));

    // bluetooth-audio/system-power/location-network/clipboard-meta all
    // self-gate to their own (much longer) poll intervals internally.
    await step('bluetooth-audio', async () => emit(await this.bluetoothAudioSensor.poll()));
    await step('system-power', async () => emit(await this.systemPowerSensor.poll()));
    await step('location-network', async () => emit(await this.locationNetworkSensor.poll()));
    await step('clipboard-meta', async () => emit(await this.clipboardMetaSensor.poll()));

    // Presence consent gate: a subnet sweep runs only on a network the owner
    // explicitly granted — `consentedNetworkFingerprint` over the LIVE state
    // keeps the permission in exactly one place (the folded presence:consent events).
    await step('presence', async () => {
      const state = this.getState();
      await emit(state?.config.experiments?.presence ? await this.presenceSensor.poll(consentedNetworkFingerprint(state)) : null);
    });

    await step('github-pr', async () => emit(await this.githubPrSensor.poll()));

    // Event-driven sidecar (launcher writes on an actual NSWorkspace
    // sleep/wake notification) — cheap no-op file read otherwise.
    await step('sleep-wake', () => emit(this.sleepWakeSensor.poll()));

    // lane H (H2): Sundial's own health, once a minute. A state: the ingest
    // gate drops it unless something changed, and `sensorHealth` speaks.
    await step('sensor-health', () => {
      if (Date.now() - this.lastHealthAt < HEALTH_POLL_MS) return;
      this.lastHealthAt = Date.now();
      return this.handleSensorEvent('sensor:health', this.healthPayload());
    });
  }

  /** lane H: the `sensor:health` payload from the sidecars, the audio helper and the OCR grant. */
  healthPayload(): Record<string, unknown> {
    const readJson = (file: string): Record<string, unknown> | null => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    const mtime = (file: string): number | null => {
      try {
        return fs.statSync(file).mtimeMs;
      } catch {
        return null;
      }
    };
    const ocrStatus = this.config.ocr.enabled ? readJson(getScreenOcrStatusJsonPath()) : null;
    return healthSignal({
      health: this.getSensorHealth(),
      hearing: this.config.audio.enabled,
      audio: this.config.audio.enabled ? readAudioStatus() : null,
      transcriptMtimeMs: this.config.audio.enabled ? mtime(path.join(getSundialHome(), '.daemon', 'audio-transcript.jsonl')) : null,
      ocr: this.config.ocr.enabled,
      ocrAccessGranted: typeof ocrStatus?.accessGranted === 'boolean' ? ocrStatus.accessGranted : null,
      configUnreadable: this.configUnreadable,
      nativeHelpers: process.platform === 'darwin' && process.env.SUNDIAL_NATIVE_HELPERS !== '0',
    });
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
