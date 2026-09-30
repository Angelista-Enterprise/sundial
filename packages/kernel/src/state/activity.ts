// The present moment and where it sits: the window, the open moment, the project, the resume line, the day's coverage, presence and hearing.
import type { AgentFleetState, LocatorSource, TicketThread } from '../types.js';

/** KernelState's Activity fields; `KernelState` extends this. */
export interface ActivitySlices {
  device: { id: string };
  window: {
    active: WindowRef | null;
    previous: WindowRef | null;
    /** Per-window project attribution, recomputed on each `window:changed`. `momentClose` reads the same resolution (via the shared `resolveAttribution` helper) to stamp a moment's `projectId`. */
    attribution: WindowAttribution;
  };
  moment: {
    id: string;
    sessionId: string;
    startTime: string;
    /** W6 D1: where the dropped sub-20-s predecessors merged into it began; the written row starts there. */
    carriedFrom?: string | null;
    processName: string;
    projectId: string | null;
    rollup: MomentRollup;
    intent: {
      status: 'none' | 'scheduled' | 'inflight' | 'done';
      text?: string;
      analyzedAt?: string;
    };
  } | null;
  /**
   * The timestamp of the last event the daemon folded — i.e. the most recent
   * instant it is known to have been running.
   *
   * Every event updates this, which is what makes it useful: a gap between
   * consecutive events is a gap in OBSERVATION, so the daemon can tell "nothing
   * happened for an hour" apart from "I was not watching for an hour".
   * `clock:tick` fires once a minute and keeps the stream dense during genuinely
   * quiet periods, so a gap here means the process really was stopped, asleep or
   * suspended.
   *
   * Written and read only by `momentClose`, which uses it to close a runaway
   * moment at the last observed instant instead of at "now". It is state rather
   * than a module-level variable for the reason CLAUDE.md gives: a module
   * variable resets on restart, and a restart is precisely one of the
   * discontinuities this exists to detect.
   *
   * Deliberately NOT derived from `system:sleep-wake`. That signal was measured
   * unbalanced — 587 sleeps against 726 wakes — so reconciliation built on it
   * would inherit its losses.
   */
  observation: { lastObservedAt: string | null };
  /**
   * Last recorded value of each STATE signal, so an observation identical to the
   * previous one is never written to the log — see `state-signature.ts`.
   *
   * Durable on purpose. Every sensor already deduplicates in an instance field,
   * which a restarted process does not have, so each restart re-emitted the
   * current value of every state signal once. Snapshotting the comparison is what
   * makes it survive the event it exists to survive.
   */
  observed: Record<string, string>;
  /**
   * `current` is the most-recently-detected project (still read by
   * `entityExtract`/`deploy`/`contextSwitch` as an ambient "what am I working
   * on" hint). `known` is the registry that per-window attribution
   * prefix-matches against — populated by `projectTrack` from every
   * `project:detected`, snapshotted so a restart doesn't lose it. `org` is
   * legacy and unused by attribution (org now rides on each `known` entry).
   */
  /**
   * `recentDetections` is the entry hysteresis behind `current` — the last few
   * canonical roots `project:detected` reported, newest last, bounded.
   *
   * It exists because `current` moved on every single detection, and the
   * detection stream is not a sequence of decisions — it is a poll over whatever
   * locator was sampled (an editor's open document, a shell's cwd), which rotate
   * between repositories continuously. Measured: 21,212 detections produced
   * 18,194 pointer moves, 86% of them differing from the one before, at a median
   * hold of zero seconds. `current` is read by the `shell-cwd` attribution tier
   * and by `momentClose`'s `git-activity` fallback, so that churn was stamped
   * onto stored moments — 59% of all A→B→A reversals in the record came from
   * those two paths.
   *
   * A strict-majority window rather than a run of consecutive detections,
   * deliberately: consecutive-run hysteresis was measured against the real
   * sequence and suppressed genuine switches along with the flicker, because
   * rotating locators rarely produce two identical detections in a row.
   */
  project: {
    current: ProjectRef | null;
    org: OrgRef | null;
    known: Record<string, KnownProject>;
    recentDetections: string[];
    /**
     * The attribution of the most recently WRITTEN moment — the exit hysteresis
     * behind brief-excursion absorption in `momentClose`. Null before the first
     * moment is written, and after an observation gap (whatever preceded a gap
     * the daemon did not watch cannot vouch for what follows it). `endedAt` and
     * `durationMs` (J2.2) let a rule folded AFTER `momentClose` see the close on
     * the same event via `endedAt === event.ts`; absent on older snapshots.
     */
    lastClosedMoment: { projectId: string | null; confidence: AttributionConfidence | null; endedAt?: string; durationMs?: number } | null;
  };
  /**
   * Where the active coding agent (Claude Code) is working, from its own session
   * transcript — `null` when no session has been written to recently.
   *
   * This exists because a Claude Code desktop window exposes NO locator of its
   * own: no AX document, and a window title that is the constant `"Claude"`. It
   * was the single largest unattributable surface in the log (86 moments /
   * 141.8 min over two days). Written by `agentSessionTrack`, read by
   * `resolveAttribution`'s agent tier.
   */
  /**
   * "Where was I" (UC2): the last line built on a return, and what it is built
   * from that no other slice keeps. Single writer: `returnFromBreak`. Optional:
   * older snapshots predate it.
   */
  resume?: {
    last: ResumeLine | null;
    /** The last intent line per project (`''` for none), from `moment:intent`. Bounded at `MAX_RESUME_INTENTS`. */
    intents: Record<string, { text: string; at: string }>;
    /** The last local file a window had open (`documentPath`), tool caches excluded. */
    lastFile?: { path: string; app: string; at: string } | null;
    /**
     * Which pieces get used (U2-F36 F37): per piece, how many lines carried it and
     * how many times its restore link was opened; and how many lines were
     * followed by the owner back on the named project within 10 minutes.
     */
    learn?: { pieces: Record<string, { shown: number; opened: number }>; lines: number; followed: number };
    /** The owner's next step, written before leaving (U2-F35); shown first on the next return, then spent. */
    note?: { text: string; at: string } | null;
    /** When each project last had a certain moment end, for a return after days (U2-F5). Bounded at 40. */
    seen?: Record<string, string>;
    /** The last three runs of certain moments on one project, for A→B→A (U2-F6). */
    runs?: { projectId: string; from: string; to: string }[];
    /** The last closed moment already folded here, so a close is read once. */
    closedAt?: string | null;
    /** The meeting under way and what was left before it, for one line when it ends (U2-F4). */
    meeting?: { key: string; title: string; end: string; pieces: ResumePieces; said: boolean } | null;
    /** Arc's focused space and its tabs, from `browser:arc-space` (sent on change only). */
    arc?: { space: string | null; tabs: { url: string; title: string | null }[]; at: string } | null;
  };
  /**
   * Wave 3e's life-event rule decomposition (see docs/phase-3-implementation-
   * plan.md). `debugging` (needs a not-yet-built "screen topics" signal) is
   * deliberately not represented here — nothing to track without the signal
   * that would drive it.
   */
  lifeEvent: {
    /** Project of the last closed moment that had one, and process of the last closed moment — for cross-moment context-switch detection. */
    lastMomentProject: string | null;
    lastMomentProcess: string | null;
    /** Keyed by `${cwd}|${testKey}` — most recent failing run awaiting a passing re-run within the recovery window. */
    failedTests: Record<string, { command: string; failedAt: string }>;
    /**
     * The in-progress sustained-focus span, if any. `sampleCount`/`sampleSum` (a running mean,
     * not a stored array) rather than `samples: number[]` — a span can run for hours of
     * unbroken same-process typing with no upper bound on how many `input:activity` ticks
     * arrive, and the mean is all `event:focus-flow` ever reports.
     */
    flow: { processName: string; startedAt: string; sampleCount: number; sampleSum: number } | null;
    /** Rolling window-change timestamps for thrashing detection. */
    recentSwitches: { at: string; process: string }[];
    lastThrashEmitAt: string | null;
    /** B3 (docs/audit/production-proposal-and-enhancements.md) — consecutive zero-activity `input:activity` windows; `isIdle` flips once that count crosses `idleTrack`'s threshold, driving `idle:start`/`idle:end` emission and `momentClose`'s idle-gap boundary. */
    idle: {
      consecutiveZeroWindows: number;
      isIdle: boolean;
      /**
       * The last `input:activity` window with real input. A break is measured from
       * here on the wall clock (U2-F1): zero windows stop while the Mac sleeps, so
       * counting them hid the long breaks. Optional: older snapshots predate it.
       */
      lastActiveAt?: string | null;
    };
  };
  /**
   * Procedural memory: which sequences of activity the owner repeats.
   *
   * The tier none of the four memory tiers covered — not what happened, but HOW the
   * owner does things. `trail` is the bounded run of recent steps being matched
   * against; `learned` is the support count per sequence. Written only by
   * `routineLearn`, which has no opinion about any of it.
   */
  routines: {
    trail: string[];
    learned: Record<string, { steps: string[]; support: number; firstSeenAt: string; lastSeenAt: string }>;
  };
  /** `name` is the custom/named mode's display name when `state` is `'custom'` (or a system mode's own name, if the sidecar reports one) — `null` otherwise. Written by `focusModeTrack` (C1); previously dead — no rule wrote this at all. */
  focusMode: { state: FocusModeState; name: string | null; since: string };
  network: { fingerprint: string; label?: string };
  /**
   * enhancements/presence-as-absence-ground-truth — whether the owner is
   * *present*, observed from devices answering on the local network, so that
   * "the daemon heard nothing" stops being the only available reading of an
   * absent hour. The daemon records no signal at all for 48% of hours, and
   * `dayShapeForecast`'s target is defined by exactly that silence, so this
   * slice exists to correct a LABEL rather than to add a feature — see the
   * enhancement page for why presence is worth adding when power state and
   * network location, both already captured, measured at or below zero.
   *
   * `networks` is every network Gnomon has been on, keyed by the same
   * fingerprint `state.network` carries, and it is the whole consent
   * mechanism. A subnet sweep observes devices belonging to other people, which
   * no other Gnomon sensor does, so it is gated per network on an explicit
   * grant from the owner: home yes, an office or a café no. `consent` starts
   * `unset` and an unset network is never swept — the default is silence, and
   * a network only becomes sweepable by a deliberate act recorded as a
   * `presence:consent` event.
   *
   * Entries are never pruned. A network's record IS its consent decision, so
   * dropping a network the owner has not visited lately would silently revoke
   * a grant (or worse, re-ask for one already refused).
   *
   * `lastScan` holds only aggregate counts and opaque per-device hashes; a raw
   * MAC address never enters an event payload in the first place (see
   * `sensors/presence`). `deviceCount` is the load-bearing number — MAC
   * rotation makes individual hashes unstable across days, so this is a coarse
   * "how many known-ish devices are here" reading and deliberately not per-person
   * identity.
   */
  presence: {
    networks: Record<string, PresenceNetwork>;
    lastScan: PresenceScan | null;
  };
  /**
   * aspiration A01 (account for my whole day), phase 1 — what a PAIRED PHONE knows
   * about the hours the desk machine physically cannot see (asleep, or away with
   * the laptop closed). Folded by `phoneTrack` from `phone:*` events the iOS app
   * posts to `POST /ingest/phone` over Tailscale.
   *
   * This is the live readout ("at the office since 09:12", "last slept until
   * 07:10"); the coverage MEASUREMENT (A01) reads the append-only log directly,
   * not this slice. A known state is coverage: knowing you were asleep 23:00-07:00
   * accounts for those hours, which is what "account for my whole day" asks.
   *
   * On-device labels only: the phone matches a location against its own geofence
   * set and sends the LABEL, never coordinates — so `place` is a name like
   * `office`, and a raw position never enters an event payload (the same posture
   * `presence` takes with MAC addresses).
   */
  coverage: {
    /** The place label the phone last reported the owner arriving at, or null when last seen leaving/unknown. */
    place: string | null;
    /** When that arrival was, in the phone's clock. */
    placeSince: string | null;
    /** The end of the most recent reported sleep interval — "awake since". */
    lastSleepEnd: string | null;
    /**
     * The owner's latest motion state from the phone (`walking`, `automotive`,
     * `stationary`, …). Context for the live readout, NOT counted toward A01
     * coverage — continuous motion telemetry would saturate "accounted for" into
     * "the phone was on".
     */
    activity: string | null;
    /** When that motion state began. */
    activitySince: string | null;
    /** Last phone report of any kind (staleness). */
    updatedAt: string | null;
    /**
     * Local-hour bucket (`YYYY-MM-DDTHH`) -> count of `input:activity` emits seen
     * in it. The DESK machine's own coverage, as distinct from everything above,
     * which is what the phone knows.
     *
     * This exists because absence detection is worthless without it, and the
     * measurement is not close: over four live days the daemon observed 1.2, 8.6,
     * 11.5 and 5.4 hours respectively. A claim like "you took no break today" made
     * over a 1.2-hour observation is a statement about the daemon, not the owner —
     * see `expectationWatch`, where this scales the precision of every omission.
     *
     * `input:activity` emits on a fixed ~10s cadence whenever the daemon is up
     * regardless of how active the owner is (see that sensor's doc comment), so
     * COUNTING emits measures observation time and nothing else. That property is
     * the whole reason this is cheap: no new sensor, no new event type.
     *
     * Bounded like every other snapshot-riding map. `MAX_COVERAGE_BUCKETS` holds
     * about two weeks, which covers the longest recurrence interval anything
     * currently learns.
     */
    observedHours: Record<string, number>;
  };
  /**
   * The last screen capture, filtered — by `screenTrack` (runs before
   * `momentRollup`, which reads `kept` when `eventId` is the event in hand).
   * `prevLines` is the furniture reference: what the previous capture of the
   * same app showed. `audit` is the running count that makes the filter a
   * measurement rather than an assertion (`enhancements/auditable-ocr-extraction`,
   * retired from the almanac once built).
   */
  /** See {@link HearingWindow}. Ambient hearing sleeps unless something wakes it. */
  hearing: HearingWindow;
  baselines: {
    hourlyDurationsByKind: RollingBaseline;
    lastAnomalyByKind: Record<string, string>;
  };
}

export interface WindowRef {
  processName: string;
  windowTitle: string;
  windowId: string;
  /**
   * Editor-exposed open-file path (macOS `kAXDocumentAttribute`), when the
   * frontmost app provides one — the locator that drives per-window project
   * attribution. `null`/absent for apps that don't expose it (browsers,
   * chat). Captured by the Swift window helper; previously dropped at the
   * `readWindowSidecar` boundary until per-window attribution needed it.
   */
  documentPath?: string | null;
}

/**
 * Phase 2 scope was just enough to prove the rollup pattern (`processName`/
 * `windowTitles` only). B4 (docs/audit/production-proposal-and-
 * enhancements.md, fixes A§4.3) grows it with everything `momentRollup`
 * accumulates while the moment is open — shell/git/calendar/input activity
 * and derived life-events — so the LLM analyzing a moment sees more than
 * one window title. See `packages/rules/src/moment-rollup.ts`.
 */
export interface MomentRollup {
  processName: string;
  windowTitles: string[];
  shellCommandCount: number;
  notableCommands: string[];
  gitCommitCount: number;
  gitBranch: string | null;
  calendarActive: boolean;
  /**
   * Count of `input:activity` EMISSIONS during the moment — presence, not typing.
   *
   * Misleadingly named, kept for compatibility with everything already reading it.
   * The sensor emits on a fixed ~10s cadence whenever the daemon is up REGARDLESS of
   * activity level (the same property `coverageTrack` relies on), so this counts
   * elapsed observed time, not work. Anything asking "was the owner actually doing
   * something" must read `inputEventCount`/`activeMs` below instead.
   */
  typingEventCount: number;
  /**
   * Real input events — key presses and clicks — during the moment.
   *
   * Activity Frames measured the cost of conflating these two: 45% of naively
   * credited "active" time was presence-only, the app focused and the human
   * elsewhere. The sensor has carried `keyDownCount`/`mouseClickCount` on every
   * emission all along; the rollup simply discarded them and counted emissions
   * instead, so no consumer could tell a working hour from an idle one.
   *
   * Mouse MOVEMENT and scroll are deliberately excluded: a moved mouse is presence,
   * a pressed key or a click is intent.
   */
  inputEventCount: number;
  /**
   * Milliseconds of the moment covered by emission windows that carried real input.
   *
   * The attention half of Activity Frames' active-versus-wall split. `durationMs` on
   * the closed row stays wall-clock — the calendar answer to "how long was the
   * editor open" — while this answers "how long was anyone working in it", and the
   * two are allowed to differ by a lot.
   */
  activeMs: number;
  lifeEvents: string[];
  /**
   * How this moment's `projectId` was attributed (see `LocatorSource` /
   * `AttributionConfidence`) — set once when the moment opens (not
   * accumulated), so the read surface can distinguish a `certain`
   * editor/terminal attribution from a `weak` title-folder guess. `null` when
   * the moment has no attributed project.
   */
  projectSource: LocatorSource | null;
  projectConfidence: AttributionConfidence | null;
  /**
   * Phase 5 #6 — the location bucket (home/office/…) this moment happened in,
   * resolved at close from the active network fingerprint via
   * `config.locationLabels`. Optional/`null` when the fingerprint is unlabeled
   * (or unknown). Makes "ROI by location" answerable without any macOS Location
   * permission — the fingerprint is a gateway/BSSID hash.
   */
  location?: string | null;
  /**
   * P2b (docs/design/07) — meeting truth, accumulated during the moment.
   * `micActive`/`cameraActive` are set by `momentRollup`'s `media:state`
   * branch (sticky once seen); `meetingTitle`/
   * `meetingAttendees` are carried from the `calendar:active` payload
   * (previously flattened to a bare `calendarActive: true`). A moment is a
   * *real* meeting when `calendarActive && (meetingAttendees.length > 0 ||
   * micActive || cameraActive)` — the signal `computeMomentKind` gates on, so
   * all-day zero-attendee calendar events no longer read as meetings. Camera
   * is approximate (CPU-proxy, see docs/design/07 §7 2b) — never asserted as
   * hard fact downstream.
   */
  micActive: boolean;
  cameraActive: boolean;
  meetingTitle: string | null;
  meetingAttendees: string[];
  /**
   * C17 — playback fusion. `micActive`/`cameraActive` already tell a call; these
   * two add what the audio DEVICE alone cannot (the refuted proxy): whether sound
   * was PLAYING and which app drove it, so `computeAudioContext` can separate a
   * call from music from a YouTube video at close. Optional — a moment closed
   * before C17 has neither.
   */
  playbackActive?: boolean;
  audioApp?: string | null;
  /**
   * P7 (docs/design/07) — screen OCR, accumulated during the moment from the
   * `screen:ocr` sensor (opt-in). `screenTopics` is the deduped set of
   * lightweight topic tags (github/terminal/chat/…); `screenExcerpt` is the
   * most-recent salient OCR line — both already through the sanitize-at-ingest
   * redaction pass (OCR is never a redaction bypass). Empty/null when OCR is
   * off (the default) or the moment predates it.
   */
  screenTopics: string[];
  screenExcerpt: string | null;
  /**
   * Ambient hearing, accumulated during the moment from the `audio:transcript`
   * sensor (opt-in, off by default). `spokenExcerpt` is the tail of what was
   * said while this moment was open — already through the sanitize-at-ingest
   * secret pass — and `spokenLanguages` the set whisper detected, which is the
   * cheapest available signal that an hour was a Dutch conversation rather than
   * an English one.
   *
   * It is what was said NEAR the machine, not what the owner said: no engine
   * available here separates speakers, so the rollup does not pretend to know
   * whose voice it was.
   */
  spokenExcerpt?: string | null;
  spokenLanguages?: string[];
  /**
   * The same speech, tidied for reading — BESIDE the capture, never over it.
   *
   * A local speech model's output reads like a room: no punctuation, run-on,
   * the odd word plainly wrong. `transcriptClean` asks for a readable version,
   * and the owner's rule is that the raw one stays the source of truth until
   * they say otherwise. A transcript is evidence; a model that tidies evidence
   * in place has destroyed what the evidence was for, and one confident
   * correction of a word that was right starts the record lying in the owner's
   * own voice. `spokenCleanAccepted` is them saying which copy they trust,
   * through `moment:transcript-accepted`.
   *
   * Two fields rather than one object because `UpdateMomentData` merges
   * shallowly: accepting would have to rewrite the whole `spokenClean` object,
   * and a rule cannot read the moment's stored row to do that without inventing
   * a read inside the fold.
   */
  spokenClean?: { text: string; cleanedAt: string } | null;
  spokenCleanAccepted?: boolean;
  /**
   * Pages the browser sensor saw while this moment was open, as `host/path`
   * (never a query string), deduped, bounded. Read by the embedding text, the
   * search text, and the journal timeline — so what the owner READ is
   * retrievable and narratable the way what they typed already was.
   */
  pages?: string[];
  /**
   * Commits made during this moment's repository but not yet pushed — the high
   * water mark of `git:status`'s `ahead` while the moment was open.
   *
   * Added because `ahead` was being captured on every one of 15,120 `git:status`
   * emissions and read by nothing at all: a producer with no consumer, so the
   * question it answers ("what have I built and not shipped") was unanswerable
   * despite the data being on hand the whole time. Optional, since a moment
   * closed before this field existed genuinely has no value for it.
   */
  unpushedCommits?: number | null;
  /**
   * Where this moment's OWN dev activity actually happened: known-project root →
   * count of `shell:command`/`git:commit`/`git:status` events whose `cwd`
   * resolved under that root while the moment was open. This is the evidence the
   * close-time `git-activity` fallback attributes from, replacing the ambient
   * `state.project.current` pointer it used to stamp — a background `git:status`
   * poll from one repo landing inside an unrelated foreground moment used to be
   * enough to hand that moment to whatever project the pointer last held
   * (measured: 1.15 h of one Sunday's gnomon work stamped `doe` off a
   * single stray `cd`). Events whose cwd resolves under no known root
   * contribute nothing. Optional — a moment closed before this field existed
   * genuinely has no value for it (same contract as `playbackActive`).
   */
  devActivityByProject?: Record<string, number>;
  /**
   * The last pull-request status the moment saw for its branch, from the
   * `git:pr-status` sensor. Before this existed the mere presence of a status
   * event in `lifeEvents` marked a commitment MERGED, so an open PR getting a
   * review made its branch look finished and no quiet notice could ever fire.
   */
  pr?: { number: number; state: string; reviewState: string | null } | null;
  /** Ticket keys and PR numbers seen on screen during the moment (from `state.screen.refs`), most recent last, capped. */
  screenRefs?: string[];
  /** J3.3 — what a local vision model said was on screen during this moment (≤ 6 short facts, sanitized at ingest). */
  screenFacts?: string[];
  /** J3.4 — the text of the last page read in the browser during this moment (clipped), for the fan-out's subject evidence. */
  pageExcerpt?: string | null;
  /** Identifiers the owner edited during the moment (from `symbol:edited`), most recent last, capped. Used to be reduced to a count. */
  symbolsEdited?: string[];
}

/** Why Gnomon is listening right now — or, when `listening` is false, nothing. */
export type HearingReason = 'meeting' | 'meeting-soon' | 'call' | 'manual' | null;

/**
 * When ambient hearing is AWAKE.
 *
 * Listening all day does not work, and a day of it proved the point rather
 * than suggesting it: 229 utterances in 28 minutes, across 15 languages
 * including Urdu, Greek and Japanese, every one scored by whisper as
 * confidently speech. Handed a quiet room, the model invents. No confidence
 * threshold catches that, because the model is not in doubt — the audio simply
 * was not speech.
 *
 * So the fix is not a better filter, it is less listening. Hearing wakes for a
 * reason and sleeps again, and the two reasons are the two the owner named: a
 * CALL is already in progress (something else holds the microphone), or a
 * MEETING is about to start (the calendar said so). Both are facts Gnomon
 * already had.
 */
export interface HearingWindow {
  listening: boolean;
  reason: HearingReason;
  /** ISO instant the window closes on its own; null when nothing is holding it. */
  until: string | null;
  /** The meeting that woke it, for the transcript to be filed against later. */
  title: string | null;
  /**
   * ISO instant a manual STOP stops holding.
   *
   * A stop that only closed the window would be undone by the next calendar
   * poll — the meeting is still on, so the rule would wake straight back up and
   * the button would read as broken. So a stop mutes: until this passes, only
   * the owner's own start can reopen the window.
   */
  mutedUntil: string | null;
}

export interface ProjectRef {
  id: string;
  name: string;
}

export interface OrgRef {
  id: string;
  name: string;
}

export type AttributionConfidence = 'certain' | 'weak';

/** One entry in `state.project.known` — the in-memory registry attribution prefix-matches against (no DB read from a rule). Keyed by root path. */
export interface KnownProject {
  name: string;
  org: string | null;
  remote: string | null;
  branch: string | null;
}

/** The active window's resolved project attribution, recomputed on every `window:changed` by `windowTrack`. */
export interface WindowAttribution {
  projectId: string | null;
  source: LocatorSource | null;
  confidence: AttributionConfidence | null;
}

/**
 * C1 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.1) —
 * widened from the original `'on' | 'off' | 'unknown'` to match what the
 * sensor actually captures (`packages/sensors/src/focus-mode/focus-mode-
 * capture.ts`'s own `FocusModeState`): a coarse on/off tri-state would have
 * thrown away exactly the distinction ("work" vs "personal" vs "do-not-
 * disturb" vs a named custom mode) that makes this field worth writing at
 * all.
 */
export type FocusModeState = 'off' | 'do-not-disturb' | 'work' | 'personal' | 'sleep' | 'custom' | 'unknown';

/** Rolling per-hour-bucket durations, keyed by "kind" — populated starting Phase 5 (anomalyZscore). */
export type RollingBaseline = Record<string, number[]>;

/**
 * Whether the owner has allowed a subnet sweep on one network.
 *
 * `unset` is not a synonym for `denied` even though both stop the sweep. The
 * difference is what the UI does: an `unset` network is offered as a checkbox
 * the owner has not answered yet, a `denied` one is a question already answered
 * no and must not be re-asked. Collapsing them would make the consent list nag.
 */
export type PresenceConsent = 'unset' | 'granted' | 'denied';

/** One network Gnomon has been on, and the owner's sweep decision for it. */
export interface PresenceNetwork {
  /**
   * Same value as `state.network.fingerprint` — `networkKeyFor`'s `net2_…`. A
   * `net_…` value here predates the stable-key change and means this entry's
   * consent has not been remapped yet (see `remap-network-keys`).
   */
  fingerprint: string;
  /**
   * The best name the sensor could observe: SSID, else the Bonjour service name,
   * else the gateway IP. **On macOS the SSID is effectively never available** —
   * `CWWiFiClient` withholds it without Location Services, and it is null across
   * every `location:network` signal on live data — so in practice this is a
   * service name on a phone hotspot and a gateway IP everywhere else. That is
   * why the owner-given name in `config.locationLabels` is what a surface should
   * show first; this is the fallback, not the identity.
   */
  label: string | null;
  /**
   * The three details that let a person tell two same-shaped networks apart, all
   * already on the `location:network` payload and previously dropped on the floor:
   * the gateway (distinguishes `192.168.1.1` at home from `10.10.8.1` at work),
   * the security mode (`WPA3_SAE` at home vs `SHA256_8021X` on an enterprise
   * network vs `WPA2_PSK` on a hotspot — often the only difference visible
   * without an SSID), and the interface type.
   *
   * Optional because snapshots written before this existed hydrate without them,
   * and a missing detail must degrade one row rather than fail the hydrate.
   */
  gatewayIp?: string | null;
  security?: string | null;
  interfaceType?: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  consent: PresenceConsent;
  /** When the owner last answered. `null` while `consent` is `unset`. */
  consentAt: string | null;
}

/** One sweep's result. Only ever produced on a network whose consent is `granted`. */
export interface PresenceScan {
  at: string;
  /** The network the sweep ran on, so a scan can never be misread as belonging to another. */
  networkFingerprint: string;
  deviceCount: number;
  /** Opaque `dev_…` hashes. Never a MAC address — see `sensors/presence`. */
  deviceHashes: string[];
}

/** What brought a "where was I" line on (UC2). */
export type ResumeTrigger = 'break' | 'morning' | 'meeting-end' | 'project-return' | 'switch-back';

/**
 * The pieces of a "where was I" line, each present only when the record has it
 * fresh. Built by `returnFromBreak` from state alone; the Today card draws the
 * line and offers each piece's restore link on demand.
 */
export interface ResumePieces {
  /** The owner's own line, written when leaving (U2-F35). */
  note?: { text: string; at: string } | null;
  /**
   * The coding-agent session the owner left (U2-F15), from the fleet: its state
   * then, its title and the owner's last prompt to it (both redacted at ingest, U2-F16).
   */
  agent?: { id: string; sid?: string; cwd: string; state: AgentFleetState; title: string | null; lastPrompt: string | null; since: string } | null;
  /** The owner left from the agent app: the agent leads the line (36% of breaks). */
  leftFromAgent?: boolean;
  /** The last moment's intent line before the break. */
  intent?: { text: string; at: string } | null;
  project?: { id: string; name: string } | null;
  /** The branch the repository is on now (U2-F11), not the one a moment carried: 1,469 of 1,967 moments carried none. */
  branch?: string | null;
  /** A ticket the work got past `seen` on (U2-F12): OCR misreads never get a branch or a commit. */
  ticket?: { id: string; stage: TicketThread['stage']; pr: { number: number | null; state: string | null; reviewState: string | null } | null } | null;
  /** The last command that failed in this project and has not passed since (U2-F17). */
  failure?: { command: string; exitCode: number; cwd: string; at: string } | null;
  /** The last file open in a window before the break, from its `documentPath` (U2-F13, without a cursor). */
  file?: { path: string; app: string } | null;
  /** The browser tab in front before the break (U2-F18): origin and path only. */
  tab?: { url: string; title: string | null } | null;
  /** Arc's tabs in the space the owner was in, when they left from Arc (item 5). */
  tabs?: { space: string | null; tabs: { url: string; title: string | null }[] } | null;
  /** Dock badges that rose while the owner was away (U2-F25): details only, never the lead. */
  badges?: { app: string; count: number }[] | null;
  /** Commits not pushed, when recent and plausible (U2-F20). */
  unpushed?: { branch: string | null; ahead: number } | null;
  /** An open branch thread touched shortly before the break (never a speech one). */
  thread?: { id: string; name: string } | null;
}

export interface ResumeLine {
  at: string;
  trigger: ResumeTrigger;
  /** How long the owner was away, wall clock. */
  awayMs: number;
  /** The notice key the line was offered under, for the verdict buttons. */
  key: string;
  line: string;
  pieces: ResumePieces;
  /** The owner was back on its project within 10 minutes (U2-F37). */
  followed?: boolean;
}
