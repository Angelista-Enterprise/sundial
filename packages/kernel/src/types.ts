import type { Event, SanitizedEvent } from '@sundial/helpers/sanitize-at-ingest.js';
import type { ResolvedSundialConfig } from '@sundial/helpers/sundial-config.js';
import type { AnsweredQuestion as AnsweredOwnerAsk } from '@sundial/helpers/asked.js';
import type { DriftState } from './drift.js';
import type { FactTestsState } from './fact-tests.js';

export type { Event, SanitizedEvent };

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
   * `micActive`/`cameraActive` are set by `momentRollup`'s `media:usage`
   * branch (mic ⇐ `audio-input`, camera ⇐ `camera`); `meetingTitle`/
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

/**
 * docs/design/06-macos-ui-data-wiring.md's Timeline classification — a
 * closed-moment display concern computed once at write time
 * (`packages/rules/src/moment-kind.ts`'s `computeMomentKind`), not part of
 * `MomentRollup` itself (a still-open moment has no `kind` yet). Lives here,
 * not in `packages/rules`, so `MomentRow.data` below can reference it
 * without `@sundial/kernel` depending on the rules package.
 */
/**
 * `leisure` was added for the noticing gate's omission detector: "no downtime in
 * eight days" is not computable without a category for downtime, and every other
 * kind here describes a flavour of work. It sits in this union rather than in a
 * separate boolean because a moment has exactly one kind, and a moment that is
 * leisure is not simultaneously `browse`.
 *
 * Deliberately NOT inferred from "absence of work signals" — see
 * `classifyActivity`, which reads the browser profile first. The measured reason
 * is in that function's doc comment: 202 of 213 youtube.com visits in the
 * reference corpus sat in one Chrome profile, so the profile carries the signal
 * that a domain list cannot.
 */
export type MomentKind = 'setup' | 'focus' | 'meeting' | 'switch' | 'browse' | 'leisure';

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

/**
 * P2a (docs/design/07) — a numeric per-moment focus score (0–1) and its
 * bucket, computed once at close (`packages/rules/src/focus-score.ts`) from
 * duration + within-moment disruption/engagement, then merged into
 * `MomentRow.data` alongside `kind` (not on the open `MomentRollup`, same as
 * `kind`). Deliberately treats a long single-activity moment as focused — the
 * WCS deepWorkBlocks false-negative this fixes at the moment level.
 */
export type FocusQuality = 'deep' | 'steady' | 'shallow';

/**
 * C17 — what a moment's audio actually was, computed once at close by
 * `computeAudioContext` from the fused mic/playback/app/title/calendar signals
 * (the audio DEVICE alone was the refuted proxy). Lives here beside `MomentKind`
 * for the same reason: a close-time display derivation on `MomentRow.data`, not a
 * field of the open `MomentRollup`.
 */
export type AudioContext = 'call' | 'music' | 'video' | 'audio' | 'none';

export interface ProjectRef {
  id: string;
  name: string;
}

export interface OrgRef {
  id: string;
  name: string;
}

/**
 * How a moment/window's project attribution was derived — recorded so a weak
 * guess never masquerades as a fact. `editor-doc` (AX documentPath under a
 * known root) and `shell-cwd` (a terminal window, project from the last
 * shell/git cwd) are `certain`; `title-folder` (an editor window with no
 * documentPath but a `"… — <name>"` title matching a known project) is `weak`.
 * `git-activity` is reserved for a future direct-from-git attribution.
 *
 * `span-continuation` is not a locator at all — it records that a moment INHERITED
 * the surrounding project because its own attribution was too brief and too weak
 * to count as having left (see `momentClose`'s brief-excursion absorption). It is
 * a distinct value rather than a silent overwrite so the record still says how the
 * project got there, and anyone who disagrees with the heuristic can filter these
 * out instead of being unable to find them.
 */
export type LocatorSource = 'editor-doc' | 'shell-cwd' | 'agent-session' | 'title-folder' | 'git-activity' | 'rule-match' | 'span-continuation';
export type AttributionConfidence = 'certain' | 'weak';

/**
 * Where a `entity:fact-candidate` came from — `contradictionCheck` branches
 * on this rather than treating every candidate as a noisy sensor reading
 * needing corroboration (see almanac's concepts/entity-facts-and-belief).
 * `inference`: a heuristic or LLM-derived guess from observed activity —
 * today's 2-of-3 promotion/supersession thresholds apply unchanged.
 * `assertion`: the owner directly stating or correcting a fact — supersedes
 * (never deletes) on a single observation and seeds a posterior that decays
 * slowly. `assistant`: reserved for a future assistant-authored claim (see
 * decisions/assistant-as-an-event-source) — not produced by anything today,
 * modeled now so adding it later isn't a migration. Absent on an
 * `entity:fact-candidate` event logged before this field existed; treat as
 * `inference` on replay.
 */
/**
 * `conversation` — the owner said it in a chat turn and the nightly
 * conversation pass extracted it (`conversationFactExtract`). Promotes on one
 * observation like an assertion, because a thing the owner said once never
 * recurs as the same triple and would otherwise never clear the two-observation
 * bar; seeded with LESS evidence than an assertion (`CONVERSATION_EVIDENCE_WEIGHT`)
 * because an extraction is one model's reading of a sentence, not the owner's
 * own typed claim. See `architecture/rules/memory-and-knowledge-rules`.
 */
export type FactProvenance = 'inference' | 'assertion' | 'assistant' | 'conversation';

/**
 * The five kinds an entity can be. `owner` is the person Gnomon works for:
 * exactly one entity, named by `config.ownerAliases[0]`, kept OUT of `person`
 * so a calendar attendee list never records the owner meeting themselves
 * (`entity-name-validation` refuses an owner alias as a person for that
 * reason). Every producer canonicalises an owner alias onto this kind with
 * `canonicalOwnerName` before minting a candidate.
 */
export type EntityKind = 'person' | 'project' | 'tool' | 'topic' | 'task' | 'owner' | 'goal';

/**
 * P1 (docs/design/07) — a user-authored project-attribution rule, loaded from
 * `~/.sundial/config.json` into `state.config.projectRules`.
 *
 * Re-exported from `@sundial/helpers`, not restated: the kernel already imports
 * types from there (see `Event`/`SanitizedEvent` above), and the structural
 * copy that used to live here had to be edited in step with the original —
 * adding `meetingContains` meant two edits, and a mismatch only surfaced as a
 * build error in a third package. `resolveAttribution` matches these after the
 * certain filesystem locators and before the weak title-folder one.
 */
export type { ProjectRule } from '@sundial/helpers/sundial-config.js';

/**
 * The subset of `~/.sundial/config.json` a PURE rule may read, copied onto
 * `state.config` every boot so a rule stays a `(state, event)` function.
 *
 * DERIVED from the resolved config rather than hand-listed: the hand-written
 * version meant one new field cost seven edits (the helpers interface, its
 * default, its parser, this type, `createInitialState`, the harness copy and
 * the retired daemon's copy) and a field added to only six of them type-checks
 * everywhere except the one file that reads it. `Pick` makes the list of what
 * rules may see the single thing to maintain.
 *
 * `screenTextRetentionDays`, `transcriptRetentionDays` and `autoHearMeetings`
 * are named differently from the file's (`ocr.retentionDays`,
 * `audio.retentionDays`, `audio.autoMeetings`), so they are stated separately.
 */
export type KernelConfig = Pick<
  ResolvedSundialConfig,
  'retentionDays' | 'decayFactor' | 'projectRules' | 'sharedPlaces' | 'projectAliases' | 'orgByPath' | 'locationLabels' | 'ownerAliases' | 'timezone' | 'refutationEnabled' | 'leisureRules' | 'experiments' | 'vault'
> & {
  /** Days `screen:ocr` signals are kept — shorter than `retentionDays`; see `OcrConfig.retentionDays`. */
  screenTextRetentionDays: number;
  /** Days `audio:transcript` signals are kept; `AudioConfig.retentionDays`. */
  transcriptRetentionDays: number;
  /** `audio.autoMeetings`: meetings and calls open the microphone by themselves. Off: only Listen does. */
  autoHearMeetings: boolean;
  // lane E (#12)
  /** `config.jobs` (the night shift). Optional: absent means off, and so does every snapshot from before it. */
  jobs?: NightJobsConfig;
};

// lane E (#12)
/** The night shift's switch and caps, resolved from `config.jobs`. See `SundialConfigFile.jobs`. */
export type NightJobsConfig = ResolvedSundialConfig['jobs'];

/**
 * `queued` → `starting` (the runner was asked) → `running` / `waiting` (the
 * fleet shows the session working, or waiting on the owner: a permission, a
 * question, a plan) → `finishing` / `stopping` (the runner was asked to collect
 * or to stop) → `done` / `failed` / `stopped`.
 */
export type NightJobStatus = 'queued' | 'starting' | 'running' | 'waiting' | 'finishing' | 'stopping' | 'done' | 'failed' | 'stopped';

export interface NightJob {
  id: string;
  /** The project root, as `state.project.known` keys it. The job never runs here: it runs in `worktree`. */
  repo: string;
  project: string;
  subject: string;
  brief: string;
  requestedAt: string;
  status: NightJobStatus;
  /** When the runner was asked to start it, and when it said it had. */
  openedAt?: string;
  startedAt?: string;
  /** Reported by the runner: the worktree Sundial made, its branch, and the commit it started from. */
  worktree?: string;
  branch?: string;
  base?: string;
  /** The fleet showed the session working at least once; a turn over before that is not the end. */
  seenWorking?: boolean;
  costUsd?: number;
  /** Why it was asked to stop: `owner`, `budget`, `time`, `switched-off`. */
  stopReason?: string;
  closedAt?: string;
  commits?: number;
  note?: string;
}

export interface NightShiftState {
  queue: NightJob[];
  open: NightJob | null;
  /** Closed jobs, newest last, bounded. */
  recent: NightJob[];
  /** The night the counters are for (the local date of the evening it began), and what it has used. */
  night: string | null;
  countTonight: number;
  spentUsdTonight: number;
}

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

export interface PendingCall {
  scheduledAt: string;
}

/** Rolling per-hour-bucket durations, keyed by "kind" — populated starting Phase 5 (anomalyZscore). */
export type RollingBaseline = Record<string, number[]>;

export interface ContextSnapshot {
  ts: string;
  summary?: string;
}

/**
 * P0-3 (docs/design/08-endogenous-life.md §11.2) — one near-future calendar
 * event, folded into `state.schedule` by `scheduleTrack`. The most directly
 * predictive raw signal for the forward model (Phase 2b): "what's coming next".
 * Times are ISO; `attendees` are already alias-sanitized at ingest.
 */
export interface UpcomingEvent {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  isAllDay: boolean;
  /** Lane B: the calendar marks it as one of a series. Absent when it does not, and on older snapshots. */
  recurring?: boolean;
}

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

/**
 * Phase 2b forward model (docs/design/08-endogenous-life.md §4). An
 * outstanding, falsifiable prediction awaiting resolution, kept in state
 * (bounded) until it resolves.
 *
 * `day-ending` ("this active hour is the day's last one"), resolved either
 * when a later hour is promoted to active (miss) or at `day:boundary` (hit) —
 * see `day-shape-forecast.ts`. Its hour-conditioned prior is the one measured
 * to carry real information (+46.1% skill).
 *
 * Still written as a union with one member on purpose. A second kind,
 * `project-continuity`, lived here until 2026-07-29 and was retired for
 * measuring 0.2% skill over 2,362 resolutions — the argument is in
 * `rules/forward-model.ts`. A snapshot predating that retirement can still
 * hold an open prediction of the dead kind, which `hydrateSnapshot` drops;
 * see `initial-state.ts`'s `hydrateRetiredForecasters`. Keeping the union
 * shape means adding the next forecaster is a new member rather than a
 * refactor, which is what this array was always typed to allow.
 */
/**
 * The `project-touched` forecaster's bet: will this project be worked on at all
 * today? Opened per candidate project when the day becomes active, resolved
 * against the day's own record of attributed windows (`predictions.projectTouch.touched`).
 */
export interface ProjectTouchedPrediction {
  id: string;
  createdAt: string;
  kind: 'project-touched';
  /** Local day this bet is about. */
  day: string;
  /** The project id, as `window.attribution.projectId` names it. */
  project: string;
  priorProb: number;
}
/**
 * J2.2: one bet in the forecast tournament, carrying every forecaster's
 * probability for the same case so they resolve on the same truth. `kind` is
 * `tournament:<target>` so the existing per-kind rules never mistake a twin
 * for their own bet; the recorded predictions carry the bare target with the
 * forecaster's name.
 */
export interface TournamentPrediction {
  id: string;
  kind: `tournament:${string}`;
  /** The target the recorded rows are filed under: `return-today` | `meeting-overrun` | `hour-fragmented`. */
  target: string;
  /** Dedupe key for the case (`<day>|<project>`, `meeting|<start>`, `hf|<day>|<hour>`). */
  key: string;
  createdAt: string;
  /** When the truth is known by the clock, or null when an event or the day boundary settles it. */
  resolveBy: string | null;
  about: string;
  features: Record<string, number | boolean | null>;
  /** forecaster → probability; `null` while Jev's answer is still out. */
  forecasters: Record<string, number | null>;
}

export type OpenPrediction = DayEndingPrediction | HourFragmentedPrediction | ProjectTouchedPrediction | TournamentPrediction;

/**
 * "This hour will come apart" — open on the hour's FIRST recorded context
 * switch, resolved at the hour's end against the switches actually counted.
 *
 * The second forecaster in the system, and the first whose conditioning feature
 * is a LAG rather than a position in the calendar. Measured with
 * `measure-forecast-skill.ts` (Q7) at +13.7% skill from the previous hour's own
 * outcome, against +6.5% from hour of day — and stable at +15.0% / +16.4% /
 * +13.7% over three corpus cutoffs, which is why this target was built and
 * "do you return to the same work after an interruption" was not: that one read
 * +9.5% / +9.7% / +15.3%, so its best number was its least typical one.
 *
 * Two cells, not forty-eight. `previous hour` alone beat `prev hour x hour` in
 * the measurement (+13.7% vs +11.0%), so the cell space is exactly
 * {prev-frag, prev-calm} — the finest split the evidence supports and no finer.
 */
export interface HourFragmentedPrediction {
  id: string;
  createdAt: string;
  kind: 'hour-fragmented';
  /** Local day this bet belongs to. Carried so resolution never has to re-derive it from the resolving event's clock. */
  day: string;
  /** Local hour being forecast. */
  hour: number;
  priorProb: number;
  /** The conditioning cell this prior came from — whether the PREVIOUS hour came apart. */
  prevState: 'prev-frag' | 'prev-calm';
}

export type DayEndingPrediction = {
  id: string;
  createdAt: string;
  kind: 'day-ending';
  hour: number;
  priorProb: number;
  /**
   * The conditioning arm this bet was placed under, when the hour has an
   * accepted conditioned cell (see `predictions.conditioned`). Stamped at OPEN
   * time because that is the only moment the condition is evaluable — by
   * resolution the next morning, "today" is a different day. Absent when the
   * hour is unconditioned or the conditioner returned `null` (unknowable).
   */
  condition?: { variable: string; value: boolean };
};

/**
 * The one question Gnomon is waiting on. See `KernelState.ownerAsk`.
 *
 * The question text lives here, unlike `AskThreadEntry`'s deliberate omission of
 * the answer: a question is one bounded line the delivery path has to render,
 * and there is at most one of them, so it costs the snapshot nothing.
 */
/**
 * One host or app whose focus time keeps landing unattributed. Gathered per
 * focus period (each `window:changed` closes the last one), NOT per moment —
 * a moment under 20s is dropped and its titles folded into whatever came next,
 * which is exactly how 71 of 136 unattributed minutes on 2026-09-07 carried
 * puzzles titles while counting for nothing. Measured at the window, the same
 * tab visited 156 times for 12 seconds each still adds up to a candidate.
 */
export interface AttributionCandidate {
  /** `host:<hostname[:port]>` for a browser page, `app:<processName>` for an app with no locator. */
  key: string;
  kind: 'host' | 'app';
  /**
   * The distinguishable parts of this place, each with its own time: the URL
   * paths under a host (`/puzzlez/scrypto`, query stripped) or the cleaned
   * window titles of an app. This is what makes a MULTI-PROJECT place
   * answerable — figma.com carries Northwind, Puzzles and overture files, and one
   * rule for `figma.com` could only be wrong. Bounded; smallest evicted first.
   */
  parts?: Record<string, { kind: 'path' | 'title' | 'meeting'; label: string; seconds: number; visits: number }>;
  /** What the owner sees: the host, or the app name. */
  label: string;
  processName: string;
  /** Unattributed focus, summed. Each period is capped so a forgotten window does not become a proposal by itself. */
  seconds: number;
  visits: number;
  /** Local dates it was seen on, most recent last, bounded. */
  days: string[];
  /** Distinct window titles, most recent last, bounded; `[private]` never lands here. */
  titles: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * One answered question, kept briefly so it is not asked again. See
 * `KernelState.ownerAsk.recent`. Re-exported from helpers, where the re-ask
 * predicate that reads it lives — the tool and the reducer share both.
 */
export type { AnsweredQuestion as AnsweredOwnerAsk } from '@sundial/helpers/asked.js';

export interface OpenOwnerAsk {
  /** `owner-ask:<derived>` — the id the answering tool must name, so an answer is matched rather than assumed. */
  askId: string;
  question: string;
  /**
   * The asking turn is BLOCKED on this answer (`gnomon_ask_owner` with
   * `wait: true`): the owner was talking to Gnomon when it asked. The seat shows
   * it at once instead of through the gate, and a typed answer must not open a
   * second turn — the paused one carries it.
   */
  waiting?: boolean;
  /** Why it was worth asking. Empty string when the model gave no reason. */
  reason: string;
  /**
   * Answers the owner can give with one tap, when the question has a small
   * closed set of them ("which project?", "abandoned or paused?").
   *
   * Empty when the question is genuinely open-ended. It is a SHORTCUT, never a
   * constraint: typing something else is always allowed and is recorded
   * verbatim, because a question whose real answer is not on the list is
   * exactly the question worth having asked.
   */
  choices: string[];
  /** When it was asked, in the event stream's clock — used for expiry. */
  ts: string;
}

/**
 * One wake-up: a time, and why it was set. See `KernelState.wakeups`.
 *
 * `reason` is carried verbatim into the notice's observation rather than
 * re-derived at fire time, because the context that made the wake-up worth
 * setting ("the deploy should be green by then") is gone by the time it fires,
 * and a bare "you asked me to check something" is a notice the owner cannot act
 * on.
 */
export interface ScheduledWakeup {
  /**
   * Stable identity, so re-scheduling the same concern MOVES it rather than
   * opening a second one. Derived from the reason when the caller does not
   * supply one — a model that sets "check the deploy" twice means one wake-up.
   */
  key: string;
  /** ISO instant to fire at. */
  at: string;
  /** The owner's or model's own words for why. */
  reason: string;
  /** ISO instant the wake-up was set, for the notice's evidence line. */
  scheduledAt: string;
}

/**
 * One piece of work spanning hours to weeks — the memory tier
 * `decisions/assistant-as-an-event-source` named as missing.
 *
 * Working memory covers the present moment, episodic memory roughly one app
 * dwell, reflective memory a calendar day, and core memory durable facts.
 * Nothing covered "the thing I was doing last Tuesday and mean to finish",
 * which is the unit a person actually plans in. `entityExtract` already mints a
 * `task` ENTITY from a git branch (C13); this is the deferred other half — the
 * live thread with a history, rather than a name in the knowledge graph.
 *
 * Identity is the task name `taskIdentity` derives from the branch, so the two
 * halves agree on what a piece of work is called and a reader can cross the
 * ledger and the graph without a join table.
 */
export interface Commitment {
  /** `commitment:<slug>` — derived from the name, so re-seeing a branch finds the same thread rather than opening a second one. */
  id: string;
  /** `BOX-508`, or `redesign-and-tablet` — whatever `taskIdentity` made of the branch. */
  name: string;
  /**
   * Where it came from: the git branch a moment carried; (J4.4) a promise heard
   * aloud in one moment; (UC1) a promise found in a whole meeting (`meeting`),
   * typed to Gnomon (`chat`), told in answer to a question (`owner`), a
   * reminder the owner made (`reminder`), or a mail's subject (`mail`).
   */
  source: 'git-branch' | 'speech' | 'meeting' | 'chat' | 'owner' | 'reminder' | 'mail';
  /** UC1: what a promise is, beyond its words. Absent on a branch thread. */
  promise?: PromiseTerms;
  /** J4.4: the moment the promise was heard in, and the noul it cleared. Absent on a branch thread. */
  heardIn?: { momentId: string; p: number };
  /** The raw branch, kept because the name is lossy and a person recognises the branch. */
  branch: string;
  projectId: string | null;
  projectName: string | null;
  openedAt: string;
  lastTouchedAt: string;
  /**
   * When the owner was told this thread had gone quiet for a few days — the
   * `commitment-fading` notice, which fires ONCE per thread. Absent until then.
   * A touch after it clears the marker, so a thread picked up and dropped again
   * can be mentioned again.
   */
  fadingNoticedAt?: string;
  /** How many moments carried this branch. */
  touches: number;
  /**
   * State of the working tree the last time this thread was touched.
   *
   * The discriminator between a thread ABANDONED and a thread FINISHED, and the only
   * thing that tells them apart from the log. Both look identical to a staleness sweep:
   * work, then silence.
   *
   * The synthetic corpus plants both shapes as twins and every gate variant fired on the
   * merged one until this existed — announcing completed work as abandoned, which is the
   * single most annoying thing this producer could do.
   *
   * `unpushed` is the high-water mark of `git:status`'s `ahead` (`rollup.unpushedCommits`,
   * a field that was captured on all 15,120 status emissions and read by nothing until
   * now). `merged` records a `git:pr-status` life-event on the thread.
   */
  lastTouchUnpushed: number;
  merged: boolean;
  /** The PR the branch carries, as last seen. `undefined` on threads from before this field; `null` when no PR has been seen. */
  pr?: { number: number; state: string; reviewState: string | null } | null;
  /**
   * LOCAL days this thread was seen on, bounded.
   *
   * A day count rather than elapsed time, because "spanning hours to weeks" is
   * about how many times you came back, not how long the clock ran. A branch
   * opened Friday and touched Monday spans two days and three calendar days,
   * and the two-day reading is the true one.
   */
  activeDays: string[];
}

/**
 * UC1: one piece of evidence about a promise. `strong` evidence closes it as
 * kept; weak evidence is cited and closes nothing (a mail to Mira about
 * something else).
 */
export interface PromiseEvidence {
  kind: 'mail' | 'mail-weak' | 'commit' | 'branch' | 'pr' | 'file' | 'tab' | 'caption' | 'reply' | 'reminder' | 'judge';
  at: string;
  strong: boolean;
  /** What was seen, short, already sanitized: "mail to Mira Bakker: The draft". */
  text: string;
}

/**
 * UC1: the terms of a promise. Parsed once, when it opens; the deliverable's
 * key nouns (`keys`) are what every later piece of evidence is matched on.
 */
export interface PromiseTerms {
  /** `owner`: the owner promised. `request`: someone asked the owner, who agreed. `awaiting`: someone promised the owner, or the owner asked them. */
  direction: 'owner' | 'request' | 'awaiting';
  /** The other side, as the log holds people: a name or `person-<hash>`. Null: nobody in particular. */
  counterparty: string | null;
  /** The thing promised, a few words: "the draft". */
  deliverable: string;
  /** The deliverable's key nouns, normalized: `["draft"]`. Empty when it named nothing matchable. */
  keys: string[];
  /** The words it was made in, clipped; already sanitized at ingest. */
  quote: string;
  /** When it is due, or null until known. */
  due: string | null;
  /** `explicit`: it was said. `next-meeting` (UC1-X1): the next event the counterparty attends. `default`: three working days. */
  dueKind: 'explicit' | 'next-meeting' | 'default';
  /** The meeting it was made in. */
  heardAt?: { title: string; start: string } | null;
  /** UC1-X1: the next calendar event the counterparty attends, once the calendar shows one. */
  nextMeeting?: { title: string; start: string } | null;
  /** The three-working-day default, kept so a meeting deadline that leaves the calendar can fall back to it. */
  defaultDue?: string;
  /** Newest last, bounded. */
  evidence: PromiseEvidence[];
  /** The last mail the owner sent the counterparty, whatever it was about — the "no mail to Mira since" line. */
  lastMailTo?: { at: string; subject: string } | null;
  /** The owner said it stands (X3), or it was their own words. False: found by a model, not yet confirmed. */
  confirmed: boolean;
  /** When the fading notice was said, and for which deadline — once per deadline. */
  spokeFor?: string;
  /** When the owner was asked whether it was kept (U1-F32). */
  askedAt?: string;
  /** Earlier dues, oldest first, when it was moved (U1-F27). */
  moved?: string[];
  /** The Apple Reminders item mirroring it (U1-F38). */
  reminderId?: string;
}

/** A thread that went quiet, with the reason it was closed. */
export interface ClosedCommitment extends Commitment {
  closedAt: string;
  /**
   * `went-quiet`: the staleness sweep. `seen-done` (J4.4): a later moment's
   * fan-out said the promise was kept AND the moment carried non-text evidence
   * (a commit, commands, a meeting). `owner`: the owner's tap. UC1: `kept` on
   * evidence or the owner's word, `broken` and `dropped` on the owner's word.
   */
  closedBecause: 'went-quiet' | 'seen-done' | 'owner' | 'kept' | 'broken' | 'dropped';
}

/**
 * The durable row. `activeDays` flattens to a COUNT here, unlike the in-state
 * list: the list exists so the rule can tell a repeat day from a new one, and
 * the table only ever needs the measure.
 */
export interface CommitmentRow {
  id: string;
  name: string;
  source: string;
  branch: string;
  projectId: string | null;
  projectName: string | null;
  openedAt: string;
  lastTouchedAt: string;
  touches: number;
  activeDays: number;
  closedAt: string | null;
  closedBecause: string | null;
  /** UC1: `PromiseTerms` as JSON; null on a branch thread. */
  promise?: PromiseTerms | null;
}

/**
 * One cell of a forecaster's conditioning table where it expects to do badly.
 *
 * Note what this is NOT: a measure of how little evidence the cell holds. That
 * was the first version and it was measurably backwards — see
 * `packages/rules/src/uncertainty-map.ts`.
 */
export interface UncertaintyGap {
  kind: string;
  forecaster: string;
  /** The conditioning value, as the forecaster keys it — an hour, for `day-ending`. */
  cell: string;
  /** The same value in the owner's terms, e.g. `17:00`. Built here so a surface never has to know how a forecaster spells its own key. */
  label: string;
  n: number;
  hits: number;
  /**
   * Expected log-loss in nats under the cell's Beta posterior, given what the
   * forecaster will actually predict there. Higher means more error expected —
   * validated out-of-sample at 1.46× against the hours it stays quiet about.
   *
   * This is the RANKING metric and it is the sum of two different things:
   * `H(believed) + excessLoss`. Use it to choose what to look at, never to
   * judge whether looking helped — see `excessLoss`.
   */
  expectedLoss: number;
  /**
   * The part of `expectedLoss` that more evidence can actually remove: the KL
   * divergence between what the cell's posterior believes and what the
   * forecaster will bet there.
   *
   * Split out because conflating the two produced a rule that could never tell
   * the truth. `expectedLoss` also contains `H(believed)`, the cell's own
   * entropy, which is a FLOOR — an hour that genuinely is a coin flip costs
   * 0.69 nats no matter how long it is watched, and watching harder makes the
   * daemon more certain it is a coin flip rather than more accurate. Because a
   * goal only opens on a high-loss (therefore high-entropy) cell, any criterion
   * demanding a fraction of `expectedLoss` burn off sets its target BELOW that
   * floor and can never be met: measured across true rates 0.2–0.6, the 30%
   * target was 0.50–0.59 nats against floors of 0.50–0.69.
   *
   * `excessLoss` has no such floor. It goes to zero exactly when the forecaster
   * has learned the cell, which is the thing a research goal is about.
   */
  excessLoss: number;
}

/**
 * One question the daemon set ITSELF, and what became of it.
 *
 * The first thing in the system that is chosen rather than triggered. Every other
 * producer reacts: something happened, and a rule had an opinion about it. This
 * starts from what Gnomon does not know — `mind.gaps`, already ranked by expected
 * loss — picks the cell it expects to learn most from, and then watches that one
 * cell until the evidence moves.
 *
 * Ranked by expected learning progress rather than by importance on purpose. A
 * gap can be enormous and unlearnable (an hour the owner is simply never awake
 * for), and a system that chased size alone would keep re-opening the same dead
 * cell forever. `expectedLoss` is what the forecaster expects to get WRONG there,
 * so improvement in it is the thing actually being pursued.
 */
export interface ResearchGoal {
  /** Stable across the goal's life; derived from the gap's forecaster + cell. */
  id: string;
  forecaster: string;
  cell: string;
  /** The gap in the owner's terms, e.g. `17:00` — carried so a surface need not re-derive it. */
  label: string;
  /** The question in one sentence, written at open time so the report can quote it. */
  question: string;
  openedAt: string;
  /**
   * Evidence count and loss AT OPEN — the baseline the finding is measured
   * against. `excessLoss` is the one progress is judged on; `expectedLoss` is
   * kept because it is what ranked the cell in the first place.
   */
  openedWith: { n: number; expectedLoss: number; excessLoss: number };
  /** Set when the goal is settled; `null` while it is still open. */
  closedAt: string | null;
  /**
   * Why it closed, and no two of these mean the same thing — K0.4.
   *
   * `learned` = a hypothesis was PROPOSED, TESTED and ACCEPTED: the goal has a
   * variable, two arms and a measured gain, and `finding` holds all three. It
   * is the only ending that claims anything was understood, and it is reached
   * from the trial path alone.
   *
   * `faded` = the cell's correctable error fell past the bar without anything
   * being tested. This used to say `learned` too, and that was the Lab card's
   * central complaint: `MIN_EXCESS_TO_OPEN` is 0.02 and `LEARNED_LOSS_DROP` is
   * 0.3, so a goal may open on two hundredths of a nat and declare victory on
   * six thousandths of one, which two coin flips produce — and not one of the
   * record's five goals ever formed a hypothesis at all. The gap closing on
   * its own is a real and useful thing to report; it is not understanding, and
   * one word cannot mean both.
   *
   * `stale` = it sat open for three weeks, or exhausted the variable menu,
   * without the evidence moving. A real finding about the question.
   *
   * `superseded` = a hotter gap displaced it. The ending that most looks like
   * a result and least is one: it says nothing whatever about the question.
   */
  outcome: 'learned' | 'faded' | 'stale' | 'superseded' | null;
  /**
   * Evidence count and loss at close, for the delta the report states.
   *
   * `excessLoss` is here for the same reason it is on `openedWith` and it was
   * missing until K0.4: the close is DECIDED on the excess loss and stored the
   * expected one, so the arithmetic of a closed goal could not be checked
   * afterwards from the record. Optional, because the two goals closed before
   * this have none.
   */
  closedWith: { n: number; expectedLoss: number; excessLoss?: number } | null;
  /**
   * The propose-and-verify state machine, all optional so goals persisted
   * before it existed hydrate cleanly (the same lesson `openedWith.excessLoss`
   * taught — see `researchGoals`' re-baseline branch).
   *
   * Flow: open → `proposalRequestedAt` set when the ScheduleLLM proposal goes
   * out → `hypothesis` set when a valid llm:result lands (and a RunGoalTrial
   * is emitted) → the trial's verdict either closes the goal `learned` with
   * `finding` populated, or appends the variable to `tried`, clears the
   * hypothesis, and allows ONE more proposal. The model picks the variable;
   * the arithmetic renders every verdict.
   */
  proposalRequestedAt?: string | null;
  hypothesis?: { variable: string; because: string; proposedAt: string } | null;
  /** Variables already tested and rejected for this goal — excluded from later proposal menus. */
  tried?: string[];
  /**
   * What the goal concluded — one shape for both endings, K0.4.
   *
   * It existed and only the TRIAL path ever wrote it, and that path has never
   * fired: all five of the record's closed goals carry `null`, so the Lab card
   * had to print "no conclusion was written" on every row. The threshold path
   * was already building the honest sentence for its own notice — what came
   * down, from what to what, over how many new observations — and throwing it
   * away. Now both paths write here.
   *
   * `variable` and `arms` are non-null only where something was actually
   * tested. A `faded` goal has neither and says so, rather than leaving a
   * reader to guess whether the split is missing or was never made — which is
   * the same distinction `outcome` now draws, kept consistent on purpose.
   *
   * Numbers, not prose: a surface phrases them. `stalled` marks the shape a
   * `stale` close leaves behind, where the excess loss is recorded and no
   * progress is claimed.
   */
  finding?: {
    variable: string | null;
    /** Information gain of the split in nats per sample (see `conditioners.ts`), or the excess loss burnt off on a `faded` close. */
    gain: number;
    arms: { when: { n: number; hits: number }; otherwise: { n: number; hits: number } } | null;
    /** K0.4 — the correctable error at open and at close, which is what the threshold judged. */
    excessFrom?: number;
    excessTo?: number;
    /** How much new evidence arrived while the goal was open. The number that makes a verdict word believable or not. */
    newObservations?: number;
    stalled?: boolean;
  } | null;
}

/** A resolved prediction — the fitness record. `surprise` = −ln(p assigned to the actual outcome), in nats. */
export interface ResolvedPrediction {
  kind: string;
  priorProb: number;
  hit: boolean;
  surprise: number;
  resolvedAt: string;
}

/**
 * The feedback loop (decisions/assistant-as-an-event-source) — the owner's verdict on one artifact
 * Gnomon produced. Deliberately three distinct verdicts rather than a graded
 * score: `wrong` (factually incorrect — should lower confidence) and
 * `not-now` (correct but unwelcome *timing* — should NOT touch confidence)
 * demand opposite updates, and collapsing them loses exactly that
 * distinction. `useful` says the artifact was worth producing.
 */
export type FeedbackVerdict = 'useful' | 'wrong' | 'not-now';

/**
 * One recorded verdict. `artifactKind`/`artifactId` name what was judged —
 * a knowledge entry (insight/journal/reflection), a moment, an entity
 * fact, or an ask thread. `solicited` distinguishes a verdict Gnomon ASKED for
 * from one volunteered unprompted: asking changes what is being measured, and
 * the two have different reliability, so they must not be merged (the
 * distinction is unrecoverable afterwards). Silence is never recorded at all —
 * an ignored question is not a `no`.
 *
 * `ask_thread` was added with the v3 conversation (2026-08-15). Until then a
 * verdict on an ANSWER had nowhere to land: the surface the redesign makes the
 * home screen was the one surface that took no verdict at all, so the turn
 * could not show its record and the loop the design depends on was open at its
 * most-used point.
 */
export interface FeedbackEntry {
  /**
   * `notice` (2026-08-15) is the PHASIC delivery itself, identified by its
   * `noticeKey`. The other four are artifacts with a row somewhere; a phasic
   * notice has none — it is a `Notify` and nothing else — so before this kind
   * existed the interrupting path was the one path whose `not-now` could not
   * be recorded, and the loudest channel was the only untrainable one.
   *
   * `owner_ask` (2026-09-21) is a question GNOMON asked the OWNER, identified
   * by its `owner_asks.id`. Every other kind judges something Gnomon produced;
   * this one judges its asking, which is the only channel that spends the
   * owner's attention before it has said anything useful. The three verdicts
   * land exactly on the three things that can be wrong with a question:
   * `useful` it was worth asking, `wrong` it was the wrong question (the
   * record cannot know that a meeting on the calendar was one the owner did
   * not attend), `not-now` the question was fine and the moment was not.
   * Without it the asks surface could only report `answered` against
   * `expired`, which is 47 of 48 and flatters the asker.
   */
  artifactKind: 'knowledge_entry' | 'moment' | 'entity_fact' | 'ask_thread' | 'notice' | 'owner_ask';
  artifactId: string;
  verdict: FeedbackVerdict;
  solicited: boolean;
  note: string | null;
  ts: string;
}

/**
 * An open request for the owner to rate one artifact Gnomon produced — the
 * ASKING half of the feedback loop, without which `solicited` was always false
 * and A07/A15 were permanently unmeasurable for want of ratings.
 *
 * `solicitFeedback` opens exactly one of these at a time and clears it when the
 * matching verdict arrives (or it expires unanswered). Because it names the
 * artifact Gnomon asked about, `feedbackTrack` can mark the answering verdict
 * `solicited: true` from the reducer itself — so a solicited rating is recorded
 * correctly whichever surface (CLI, macOS, iOS) submits it, with no per-client
 * flag to set.
 */
export interface FeedbackSolicitation {
  artifactKind: FeedbackEntry['artifactKind'];
  artifactId: string;
  /** The human-facing prompt a surface renders, e.g. `Was this useful? "…"`. */
  question: string;
  /** When the ask was opened, in the event stream's clock — used for expiry. */
  ts: string;
}

/**
 * One question the owner asked, as `state.ask` carries it: metadata only.
 *
 * The answer itself is deliberately absent. `KernelState` is serialized whole
 * into every snapshot, and an answer is unbounded model prose — keeping fifty of
 * them here would grow every snapshot without any rule ever reading one. The
 * full thread lives in the `ask_threads` table, written by `askTrack`'s own
 * effect; this slice is what a rule can decide with.
 *
 * `sourceCount` is the one substantive field: it is how many observed rows the
 * answer was drawn from, which is the only defensible confidence an answer has
 * (there is no probability attached to it). It is kept in state precisely so a
 * later rule can promote a well-sourced answer into the knowledgebase on its
 * own — the manual "remember this" button is the first version of that policy,
 * not a substitute for it. `remembered` is what that policy must not
 * double-apply.
 */
export interface AskThreadEntry {
  id: string;
  question: string;
  askedAt: string;
  /** Null when the record did not contain an answer — a real outcome, not a failure. */
  answered: boolean;
  sourceCount: number;
  remembered: boolean;
  /**
   * The `knowledge_entries` row this answer became when the owner kept it, or
   * null while it is only history.
   *
   * Carried in state so `feedbackTrack` can act on a `wrong` verdict without a
   * DB read: a remembered answer is retrievable evidence, so correcting it has
   * to retract the entry, and a pure rule cannot go looking for the id. The
   * value is derived deterministically by `askTrack` at fold time, so this is
   * a copy of something the fold already knows rather than new state.
   */
  rememberedEntryId?: string | null;
}

/**
 * How a notice was DETECTED, not what it is about.
 *
 * The taxonomy is by mechanism because that is what determines whether the thing
 * is detectable at all. Grouping by topic ("health", "work", "focus") produced a
 * wishlist whose entries had no common machinery; grouping this way showed that
 * `omission` and `drift` had no producers anywhere in the system, which is why
 * nothing personal could ever be surfaced however much the topic list grew.
 */
export type NoticeShape = 'prediction-error' | 'transition' | 'omission' | 'drift' | 'self-report' | 'anticipatory';

/** One file the owner keeps coming back to today. See `KernelState.files`. */
/**
 * One card on the board — a pane the owner (or Gnomon) placed in the space.
 * `id` is the pane id the client resolves (`today`, `session`, `inst:memory`,
 * `entity:<name>`, `moment:<id>`, `note:<key>` …). Coordinates are world units;
 * `z` is depth (0 is the front, negative recedes). A `pinned` card is permanent:
 * `board:remove` and `board:load` leave it standing.
 */
export interface BoardCard {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  pinned: boolean;
  /** A note's text, or a label the placer gave the card. */
  text: string | null;
  /**
   * The owner's own note ON this card — what to fix, what renders wrong, what
   * it is for. Distinct from `text`, which is the card's CONTENT (a note's
   * words, a lens's spec): this is a remark about the surface itself, and
   * Gnomon reads it in the board context so "fix the thing I flagged" resolves.
   */
  comment: string | null;
  /**
   * What this card is set to — a date, a tab, a query — from the keys its
   * catalog entry (`plugins/sundial-theme/shell/cards.js`) declares. The card
   * applies them and shows them as chips; `gnomon_look` reads with them.
   */
  filters?: Record<string, string> | null;
  by: 'owner' | 'gnomon';
  at: string;
}

export interface HotFile {
  projectRoot: string;
  relPath: string;
  /** Change events today (a save burst counts once per `file:changed` event). */
  changes: number;
  /** Of those, how many landed while the editor was the focused window. */
  focusedChanges: number;
  firstAt: string;
  lastAt: string;
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

/** Consecutive failures of one command. See `KernelState.shell`. */
/** One ticket, stitched from every sense that saw its key. Written by `ticketTrack`. */
export interface TicketThread {
  id: string;
  firstSeen: string;
  lastSeen: string;
  /** Owner-local dates it was seen on, oldest first, at most 30. */
  days: string[];
  /** Sightings per source: window, browser, screen, page, shell, speech, calendar, git, branch, pr. */
  sources: Record<string, number>;
  /** How far work on it got: only seen, a branch, commits, a pull request. */
  stage: 'seen' | 'branch' | 'commit' | 'pr';
  commits: number;
  pr: { number: number | null; state: string | null; reviewState: string | null } | null;
}

/**
 * One coding-agent session, as `agent:fleet` reports it (the `agent-session`
 * sensor's `AgentFleetSession`, redacted at ingest).
 *
 * `waiting`: turn over, waiting for a new prompt. `permission`: waiting on an
 * approval. `question` / `plan`: it asked the owner, or wants a plan approved.
 * `tool`: a tool call without a result yet. `failed`: the turn ended on an API
 * error. `working`: mid-turn.
 */
export type AgentFleetState = 'working' | 'waiting' | 'tool' | 'question' | 'plan' | 'permission' | 'failed';
export interface AgentFleetEntry {
  id: string;
  /** The whole session id, for `claude --resume` (U2-F32). Absent on samples from before it was sent. */
  sid?: string;
  cwd: string;
  branch: string | null;
  state: AgentFleetState;
  since: string;
  /** Where the state came from: Claude's live registry, a background job, a transcript alone, or a hook. Absent on samples from before 2026-09-28. */
  source?: 'registry' | 'job' | 'transcript' | 'hook';
  /** Who started it: the desktop app, a terminal, a script (sdk), Claude's background supervisor. */
  origin?: 'desktop' | 'cli' | 'sdk' | 'bg' | 'other';
  title?: string;
  lastPrompt?: string;
  costUsd?: number;
  lines?: { added: number; removed: number };
  pr?: { number: number; url: string };
  /** The API error a failed turn ended on. */
  error?: string;
  /** The same failing tool call this many times in a row (from 3). */
  repeats?: number;
}

/** One Claude Code hook event, as the report-only hook wrote it: names and types, never content. */
export interface AgentHook {
  event: string;
  /** `notification_type`, `error_type`, a SessionStart `source`, a SessionEnd `reason`. */
  detail: string | null;
  at: string;
}

export interface AgentEdit {
  id: string;
  cwd: string;
  /** Relative to `cwd`. */
  file: string;
  at: string;
}

export interface ShellFailureStreak {
  /** The command with its arguments, as typed, trimmed. */
  command: string;
  cwd: string | null;
  count: number;
  /** The most recent non-zero exit code. */
  exitCode: number;
  firstAt: string;
  lastAt: string;
  /** When a notice was last raised for this streak, so it fires at 3, not at 3, 4, 5 … */
  noticedAtCount: number;
}

/** What kind of thing the work loop makes. See `KernelState.workbench`. */
/** The three Gnomon picks for itself, and the one the owner hands it (`gnomon_start_job` → `work:requested`). */
export type WorkJobKind = 'topic-brief' | 'handoff-note' | 'meeting-brief' | 'owner-request' | 'rule-idea';

/** One job the work loop opened. The payload the `work-job` Notify channel carries verbatim. */
export interface WorkJob {
  id: string;
  kind: WorkJobKind;
  /** Dedupe key: the subject and, for time-bound kinds, the occasion. */
  key: string;
  /** What it is about, in the owner's terms — an entity name, a thread name, a meeting title. */
  subject: string;
  /** Why now, one line, shown on the shelf card. */
  reason: string;
  /** Kind-specific facts the worker needs and a rule already holds (attendees, branch, project). */
  detail: Record<string, string | string[] | null>;
  openedAt: string;
}

export interface WorkJobRecord extends WorkJob {
  closedAt: string;
  outcome: 'shelved' | 'nothing' | 'failed' | 'timed-out';
  title: string | null;
}

/** A span with an app holding the microphone. See `KernelState.av`. */
export interface CallSpan {
  app: string;
  /** From a small app list: conferencing → `work-call`, messengers → `personal-call`, anything else `call`. */
  kind: 'work-call' | 'personal-call' | 'call';
  since: string;
  cameraEver: boolean;
}

/**
 * A thing worth possibly saying, emitted by a producer that does no gating of its
 * own.
 *
 * Producers emit these on a genuine state TRANSITION and then stop caring. All
 * suppression — habituation, thresholds, the daily budget, channel choice — is
 * `noticeGate`'s, in one place. That split is the point: the previous design had
 * one producer that also decided when to speak, and it printed "fifteenth spike
 * this week" because nothing anywhere held the thought "I have said this before".
 */
export interface NoticeCandidate {
  shape: NoticeShape;
  /** Pattern type, e.g. `absent:break`, `commitment-abandoned`, `drift:day-end`. */
  kind: string;
  /**
   * The habituation key. Same key means the same stimulus, and the gate's response
   * to it decays per delivery and recovers with time. Anything that wants to be
   * repeatable-but-not-repetitive varies this (per commitment, per recurrence);
   * anything that should only ever be said once keeps it constant.
   */
  key: string;
  /** −ln p(what happened), in nats, under whatever model the producer holds. */
  surprise: number;
  /**
   * Confidence in the expectation that was violated, 0..1 — the inverse-variance
   * term of precision-weighted prediction error.
   *
   * This is the field that fixes the shipped detector rather than tuning it. Every
   * one of the 17 companion insights deleted on 2026-08-02 came from a z-score
   * over a baseline of as few as TWO samples; weighted by precision, a two-sample
   * baseline earns almost nothing and cannot reach any surface however large its
   * z-score gets.
   */
  precision: number;
  /**
   * How fast the value of SAYING this decays, or `null` when it does not decay at
   * all. The ONLY input to channel choice.
   *
   * Deliberately not "importance". A commitment that went quiet nine days ago is
   * important and keeps perfectly until tomorrow morning, so it belongs in a list.
   * "It is 02:40 and your days normally end at 18:00" is worth little by breakfast,
   * so it belongs in an interruption. Asking "would this be just as useful
   * tomorrow?" is mechanical, which means the corpus can label it and the harness
   * can score the two channels separately.
   */
  valueHalfLifeMs: number | null;
  /**
   * The countable claim, in the owner's terms. Never a state no sensor observes:
   * "twelve days without a day away from the keyboard" is an observation, "you
   * seem burned out" names something nothing here can see.
   */
  observation: string;
  /** Supporting numbers, so a reader can weigh the claim rather than trust it. */
  evidence: string[];
  /** Ids of open commitments this touches — the current-concerns gain. */
  concerns: string[];
}

/**
 * One thing that recurs, learned from the log — the only way to notice an absence.
 *
 * A survival model rather than a schedule, and that is what lets ONE mechanism
 * cover a break every ~90 minutes, a day off every ~9 days, a standup every ~24
 * hours and a repository touched every couple of days. None of those needs its own
 * rule, which is the difference between this and the bespoke-detector-per-topic
 * shape the noticing surface started with.
 *
 * Welford accumulators rather than a sample array, the same choice
 * `lifeEvent.flow` already makes: an occurrence stream has no upper bound on
 * length and the spread is all anything reads.
 */
export interface Recurrence {
  /**
   * `${stream}|${bucket}`.
   *
   * Bucketed for exactly the reason `predictions.hourlyDoneRate` buckets by hour.
   * `git:commit` runs several times a day on weekdays and zero at weekends, so an
   * unconditioned interval learns a bimodal gap and then reports every Saturday as
   * an absence — a detector that fires 52 times a year and is wrong every time.
   */
  key: string;
  stream: string;
  bucket: RecurrenceBucket;
  /** Welford over the gap between consecutive occurrences, in ms. */
  intervalMs: { mean: number; m2: number; n: number };
  lastSeenAt: string;
  /**
   * Slope of the interval over recent occurrences, ms per day.
   *
   * Separate from the interval itself because habituation HIDES drift: a bedtime
   * moving twenty minutes later each night never produces a single surprising
   * night, so no surprise-based detector can ever see it. Measuring the slope
   * explicitly is the one place this design deliberately refuses to copy the
   * biology, since slow change is precisely what a nervous system is worst at.
   */
  driftPerDayMs: number;
  /** Occurrences behind `driftPerDayMs`, so the drift term has its own evidence count. */
  driftSamples: number;
  /**
   * Whether an omission for this recurrence is currently allowed to fire.
   *
   * Edge-triggering, and it is load-bearing rather than an optimisation.
   * `expectationWatch` runs on `clock:tick`, so a level-triggered overdue check
   * would emit a candidate every 60 seconds for as long as the thing stayed
   * absent — 1,440 log rows and 1,440 recursive `reduce()` passes a day, for one
   * missing break. Disarmed on emit, re-armed when the occurrence next happens.
   */
  armed: boolean;
  /**
   * Local day the omission was last announced on, or null.
   *
   * Re-arming strictly on an occurrence is correct edge-triggering and catastrophic in
   * one case: an absence that never ends never re-arms, so the worst instance of it can
   * never be reported. This lets a standing absence be raised once per day and no more.
   */
  disarmedOn: string | null;
  /** Declared by the stream: whoever knows what this is knows whether saying it late is useless. */
  valueHalfLifeMs: number | null;
}

export type RecurrenceBucket = 'weekday' | 'weekend' | 'any';

/**
 * The owner-curated work/leisure taxonomy the rules see, copied onto
 * `state.config` every boot. Re-exported from `@sundial/helpers` for the same
 * reason `ProjectRule` is: one shape, one place to change it.
 */
export type { ActivityClass, LeisureRules } from '@sundial/helpers/sundial-config.js';

/** Per-key habituation state: response `gain` as of `at`, recovering toward 1 since. */
export interface HabituationEntry {
  gain: number;
  at: string;
  fires: number;
}

/**
 * A notice that cleared the interrupting bar. Kept in state (bounded) because the
 * owner chose "log plus a surface in the app" over real delivery for now:
 * `NotifyEffect` has no delivery channel, so this slice IS the channel until the
 * measured false-positive rate justifies building one.
 */
/**
 * One thing an external assistant proposed, and what became of it.
 *
 * `outcome` starts `open` and is closed by an `assistant:response` carrying the
 * owner's verdict. The pair is what makes assistant output falsifiable rather than
 * merely fluent — the same argument D6 already makes for every prediction.
 */
export interface AssistantProposal {
  id: string;
  /** What was proposed, in one line, already sanitized at ingest. */
  summary: string;
  /** Free-form label for the kind of proposal, e.g. `refactor`, `answer`, `plan`. */
  kind: string;
  outcome: 'open' | 'accepted' | 'rejected';
  at: string;
  resolvedAt: string | null;
}

/**
 * The Lab instrument's reading (`GET /gnomon/lab`): Gnomon's self-evolving
 * state, joined at read time from records that already exist — `wakeups.open`
 * keyed `experiment-*`, `mind.goals` with the cell's live `n`, and the week's
 * `assistant`/`feedback` verdicts. Nothing here is a new record kind.
 */
export interface LabReading {
  experiments: { key: string; name: string; at: string; scheduledAt: string; reason: string; status: 'scheduled' | 'due' }[];
  questions: { id: string; question: string; label: string; evidence: number; status: 'open' | 'learned' | 'stale' | 'superseded' | 'closed'; openedAt: string; closedAt: string | null }[];
  weekVerdicts: {
    /** All-time tally, the way the strip and the model quote it: accepted of resolved. */
    accepted: number;
    rejected: number;
    resolved: number;
    /** This week's decided proposals, newest first. */
    proposals: { id: string; summary: string; kind: string; outcome: 'accepted' | 'rejected'; at: string }[];
    /** This week's verdicts on notices. */
    notices: { useful: number; wrong: number; notNow: number };
  };
}

/**
 * The owner's settings, as the whole system sees them.
 *
 * Deliberately kernel state, not a file and not `localStorage`: a rule must be
 * able to read them (the notice gate asks whether it may speak at all), the
 * model's tools must be refused by them, and every open tab must agree. They
 * arrive as `settings:set` events like everything else, so a replay reproduces
 * the settings that were in force when a decision was made.
 */
export interface OwnerSettings {
  /**
   * How much Gnomon does unasked.
   *
   * `off` — it answers, and nothing else: the gate admits no notice, the board
   * tools refuse. `notice` — it may speak first when the gate says so, but it
   * does not touch the board. `act` — it may also place cards, walk the owner
   * through something, and open surfaces.
   */
  autonomy: 'off' | 'notice' | 'act';
  /**
   * How much a notice must be worth before it is said, as a nudge on the gate's
   * own bar: 0 leaves the policy alone, +1 is twice as hard to clear, -1 half.
   */
  noticeBias: number;
  /** Walk steps advance on their own after this many ms; `null` waits for Next. */
  autoAdvanceMs: number | null;
  /** The paper, for every tab: `system` follows the machine. */
  paper: 'system' | 'light' | 'dark';
  /** `reduced` stills every animation, whatever the machine says. */
  motion: 'full' | 'reduced';
  /**
   * How much a card's glass blurs what is behind it, for every tab.
   *
   * `off` is not a zero blur: it spends no backdrop layer at all, which is the
   * whole reason the switch exists — a blur is re-sampled on every frame, and
   * it was the board's hottest cost.
   */
  blur: 'off' | 'soft' | 'full';
  /** Notice groups the owner turned off (`notice-groups.ts`). Missing on an older fold = none. */
  quiet?: string[];
  /** When the settings last changed, or null if they never have. */
  updatedAt: string | null;
}

export interface PhasicNotice {
  kind: string;
  observation: string;
  evidence: string[];
  weight: number;
  at: string;
}

/**
 * A candidate the gate judged worth saying but not worth saying *now*.
 *
 * Carries the whole candidate rather than a summary, because re-scoring it later
 * means running the same `decide` over it against a changed interruption cost — a
 * summary would force the gate to reconstruct what it already had.
 */
export interface DeferredNotice {
  candidate: NoticeCandidate;
  /** When it was first deferred, so its own `valueHalfLifeMs` can retire it. */
  since: string;
  /** How many ticks have re-scored it, for the harness's deferred-then-expired counter. */
  reconsidered: number;
}

/**
 * One object, one source of truth, replayable from the log. Copied from
 * docs/design/02-state-and-reducer.md — the full shape exists from Phase 2
 * onward (not grown field-by-field later) because decision #2 (snapshot +
 * tail-replay, docs/design/00-overview.md) requires the *whole* state to
 * snapshot/replay correctly, even though most slices below stay at their
 * zero-value until the rules that populate them land in Phases 4-6.
 */
export interface KernelState {
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
  /** Ticket threads by key, bounded. Written by `ticketTrack`; optional because older snapshots predate it. */
  tickets?: Record<string, TicketThread>;
  /**
   * Watch rules the owner adopted (`rule:adopted`), and each one's running
   * state. Written by `watchRules`; see `watch.ts`. Optional: older snapshots
   * predate it.
   */
  watch?: {
    rules: import('./watch.js').WatchRule[];
    runtime: Record<string, import('./watch.js').WatchRuntime>;
    /** Active time and away, folded from `WATCH_FLAG_TYPES` by the same reducer the backtest runs. */
    flags?: import('./watch.js').WatchFlags;
    /** Each rule's version, backtest promise, fires and verdicts (the rules card and the review read them). */
    stats?: Record<string, import('./watch.js').WatchStats>;
    /** Rules kept but not stepped: their runtime is frozen and they emit nothing. */
    paused?: string[];
    /** Rules Gnomon proposed on the shelf, by shelf entry id; the owner's Keep adopts one. At most 10. */
    proposed?: Record<string, import('./watch.js').WatchRule>;
  };
  agent: {
    session: { cwd: string; branch: string | null } | null;
    /**
     * Every coding-agent session and its state, from the last `agent:fleet`
     * sample. Written by `agentFleetTrack`; optional because older snapshots
     * predate it.
     */
    fleet?: AgentFleetEntry[];
    /** `id@since` of each wait already raised as a notice, so one wait is one candidate. Only keys of the current fleet are kept. */
    nudged?: string[];
    /**
     * The last Claude Code hook per session id (`agent:hook`, U3-F8), overlaid
     * on each fleet sample when newer than the entry's state. Entries older than
     * the fleet window are dropped. Optional: older snapshots predate it.
     */
    hooks?: Record<string, AgentHook>;
    /** The session the owner last sent a prompt to (a `UserPromptSubmit` hook), U3-F13. */
    attended?: { id: string; at: string } | null;
    /** Files agents edited in the last `AGENT_EDIT_WINDOW_MS` (a `PostToolUse` hook), for file-level collisions, U3-F23. */
    edits?: AgentEdit[];
    /** When the owner went away (idle, night, a call) with agents open, for one digest on return (U3-F16). */
    away?: string | null;
    /** The owner's own waits by kind, in minutes, the last 200 each — when an answered session went back to work (U3-F21). */
    waits?: Record<string, number[]>;
  };
  /** `name` is the custom/named mode's display name when `state` is `'custom'` (or a system mode's own name, if the sidecar reports one) — `null` otherwise. Written by `focusModeTrack` (C1); previously dead — no rule wrote this at all. */
  focusMode: { state: FocusModeState; name: string | null; since: string };
  /** `charging`/`timeRemainingMinutes` added by C1 alongside actually wiring this slice — the sensor already captured both, they just had nowhere to go before. */
  power: { source: 'battery' | 'ac'; batteryPercent?: number; charging?: boolean; timeRemainingMinutes?: number | null };
  network: { fingerprint: string; label?: string };

  /**
   * Fold wave one (2026-09-04): five streams the log had been carrying with no
   * consumer, folded into state so a rule, the presence line or the ambient
   * slice can read them. Each is bounded; each is written by one rule.
   */
  /** Files returned to today, by `fileTrack` from `file:changed`. Reset at the day boundary. */
  files: {
    /** Local day the counts belong to. */
    day: string | null;
    /** Keyed `${projectRoot}|${relPath}`. Bounded at `MAX_HOT_FILES`. */
    hot: Record<string, HotFile>;
  };
  /** Shell commands that keep failing, by `shellFailureTrack` from `shell:command`. */
  shell: {
    /** The current run of consecutive non-zero exits of the same command, or null. */
    streak: ShellFailureStreak | null;
    lastCommandAt: string | null;
    /**
     * The last failing command per working directory (U2-F17), for "where was I".
     * Unlike the streak, a success elsewhere does not clear it: only the same
     * command passing in the same folder does. Bounded at `MAX_LAST_FAILURES`.
     * Optional: older snapshots predate it.
     */
    lastFailure?: Record<string, { command: string; exitCode: number; at: string }>;
  };
  /** Dock badge pressure, by `pressureTrack` from `event:notification`. */
  pressure: {
    /** Keyed by app name. `since` is when the count first reached its current value. */
    byApp: Record<string, { count: number; since: string; updatedAt: string }>;
    total: number;
    updatedAt: string | null;
  };
  /** Commits not yet pushed, by `gitAheadTrack` from `git:status` (`ahead`). Keyed by cwd. */
  git: {
    unpushed: Record<string, { branch: string | null; ahead: number; since: string; updatedAt: string }>;
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
  /**
   * The board: the owner's space, and Gnomon's. By `boardTrack` from
   * `board:*` — placed, moved, grouped, removed, saved as a scene and loaded
   * again — written by the owner's hands through the client and by Gnomon
   * through `gnomon_board`. Both go through the log, so the space replays.
   */
  board: {
    cards: Record<string, BoardCard>;
    /** Named arrangements of the unpinned cards, saved to be loaded later. */
    scenes: Record<string, { cards: BoardCard[]; savedAt: string }>;
    /**
     * Every lens ever composed, by card id — the shelf that outlives the card.
     *
     * A lens is a QUESTION someone worked out how to ask: which read tool,
     * which filters, which shape. The card carrying it was disposable from the
     * first day (remove, clear, load a scene all take it), and the question
     * went with it, so the same lens had to be invented again from prose. This
     * keeps the spec when the card goes, which is the only part worth keeping —
     * the rows were always re-read anyway.
     *
     * Kept forever and never pruned: a spec is a few hundred bytes, and a shelf
     * that forgets is a shelf nobody trusts to look on.
     */
    lenses: Record<string, { title: string; spec: string; at: string }>;
    /**
     * The last size the owner gave each card, by card id and by kind — kept
     * when the card goes, so a card opened again comes back at the owner's
     * width instead of the default. Optional: snapshots from before it lack it.
     */
    sizes?: Record<string, [number, number]>;
    /** What Gnomon last asked the owner's view to fit, with a line about it; the client animates there. */
    /** `mark`: words to light INSIDE those cards (a row, a day, a name) — the client finds them; the record only carries them. */
    focus: { ids: string[]; text: string | null; mark?: string | null; at: string } | null;
    /**
     * A notice: one line that arrives as a thin row at the top of the board and
     * leaves again. Gnomon speaking about NOW — not about any card, which is
     * what separates it from `focus`'s caption.
     *
     * `ms` is how long it stands; `0` means it stands until the owner answers
     * or dismisses it, which is what a question needs. `actions` are the
     * owner's replies: pressing one says `say` to Gnomon in the owner's own
     * voice, so an answer is an ordinary turn and not a second channel.
     */
    notice: { text: string; kind: 'say' | 'ask'; ms: number; actions: { label: string; say: string }[]; at: string } | null;
    /**
     * A walkthrough: steps the owner pages through at their own pace, each
     * fitting some cards and saying one thing about them. How Gnomon gives a
     * play-by-play instead of a wall of prose.
     */
    walk: { steps: { ids: string[]; text: string; weight: 'light' | 'heavy' }[]; cursor: number; autoAdvanceMs: number | null; at: string } | null;
    /** The plan as the owner last edited it (skip, reorder, add); the model's next todo_write replaces it. */
    plan: { steps: { content: string; status: 'pending' | 'in_progress' | 'completed' | 'skipped' }[]; at: string } | null;
    /**
     * WHEN the board is looking at, for every card at once.
     *
     * One span, not one per card. Before this there were three unrelated
     * mechanisms — a day ruler that moved only the four day-bound parts, a
     * private `7d`/`30d` tab strip inside the ledger that nothing else could
     * read, and a fourteen-day span hardcoded into two copies of a route
     * table — so "show me last week" had three different answers depending on
     * which card you asked. The owner's rule from the trace card: one time
     * control for all cards, decided before anything is built on it.
     *
     * It lives in the RECORD rather than in the client because Gnomon reads
     * cards too: a reader answering about a card the owner has wound back to
     * Tuesday must answer about Tuesday. Both hands move the same control.
     *
     * `from` and `to` are inclusive owner-local dates, `YYYY-MM-DD`. A single
     * day is `from === to`. `label` is the preset that produced it, kept so the
     * chip can show which one is lit and so a rolling span can be recomputed at
     * the day boundary rather than going stale at midnight. `null` is "today",
     * the default a fresh board wakes up in.
     */
    span: { from: string; to: string; label: string; at: string } | null;
    /** The last eight changes to the space, oldest first — what the owner (or Gnomon) just did. */
    /** The last few changes: what, to what, by whom — and `because`, the one line Gnomon gave for it, shown to the owner as a caption. */
    recent: { type: string; id: string | null; by: 'owner' | 'gnomon'; at: string; because?: string | null }[];
    /**
     * Sections: named regions of the space, each anchored by one pinned card.
     * A card placed `near` a section lands inside it. Drawn behind the cards.
     */
    sections: Record<string, { label: string; x: number; y: number; w: number; h: number; anchor: string | null; at: string }>;
    updatedAt: string | null;
  };
  screen: {
    app: string | null;
    prevLines: string[];
    eventId: string | null;
    kept: string[];
    /**
     * Identifiers read off the screen in the last capture: ticket keys
     * (`BOX-484`) and PR numbers (`#4592`). The per-app filter already keeps
     * these lines regardless of density; this pulls the tokens out so a rule,
     * the presence line, and the intent prompt can say WHICH ticket is on
     * screen rather than that some text was.
     */
    refs: string[];
    audit: { captures: number; lines: number; kept: number; furniture: number; noise: number };
  };
  /** The browser tab the owner is looking at, by `browserTrack` from `browser:tab` / `browser:status`. */
  browser: {
    current: { app: string; host: string; path: string; title: string | null; since: string; updatedAt: string } | null;
    /** False once the helper reported Apple Events denied — the owner never clicked Allow. */
    authorized: boolean;
    lastError: string | null;
  };
  /** A call in progress, by `callSpanTrack` from `media:state` (an app holding the microphone). */
  av: {
    call: CallSpan | null;
    /** The most recent closed call, for "how long was that". */
    lastCall: (CallSpan & { until: string }) | null;
  };

  /**
   * The work loop (2026-09-04): jobs Gnomon does on its own while the owner is
   * away, whose results land on the shelf (knowledge_entries of kind `shelf`)
   * for the owner to Keep or dismiss. One job open at a time, like a research
   * goal; a bounded number a day; picked by `workbench` from state alone.
   */
  /**
   * Meetings with other people the owner has been in, kept by `meetingFollowup`
   * so the question "how did it go?" can be asked once, shortly after the end.
   * Keyed `${title}|${start}`; pruned after two days.
   */
  meetings: {
    /**
     * `listened`: ambient hearing was awake at some point inside the meeting.
     * `heard`: utterances transcribed inside it. Together they say the owner was
     * not in the room — see `meetingFollowup`.
     */
    seen: Record<
      string,
      {
        title: string;
        start: string;
        end: string;
        attendees: string[];
        askedAt: string | null;
        listened?: boolean;
        /** Utterances the MICROPHONE heard inside it: the owner being in the room. */
        heard?: number;
        /** UC1: utterances heard on either stream — whether there is anything for the promise pass to read. */
        voices?: number;
        /** UC1: when the meeting's promise pass was asked for. */
        extractAt?: string;
        /** UC1: what the pass found — the promise ids and one line each, for the question at the end (X3). Absent until it answers. */
        promised?: { ids: string[]; lines: string[] };
      }
    >;
  };

  /**
   * Who the hashed people are. `sanitizeAtIngest` turns an attendee the calendar
   * has no display name for into a stable `person-<hash>` alias; 7 of 16
   * colleagues on the live record were only ever that. `peopleAsk` asks the
   * owner once per alias and keeps the answer here, so a meeting question can
   * say "with Alex" instead of "with person-c205ca11f2". The same answer goes
   * into core memory as a `knownAs` fact; this map is the fast lookup rules use.
   */
  people: {
    /** alias → when it was last asked about, so an unanswered alias is not asked every meeting. Fold state with no other home. */
    asked: Record<string, string>;
    /**
     * When the last "who is this attendee" question was opened, whatever alias
     * it was about — the CLASS-level clock, beside `asked`'s per-alias one.
     *
     * `asked` alone was not a limit. It mutes one alias for a fortnight, and a
     * single meeting carries several hashed attendees, so the rule simply walked
     * to the next hash as soon as the previous question closed: seven questions
     * on 2026-09-09, three of them in three consecutive minutes.
     */
    lastAskedAt?: string;
    /**
     * When the whole question class may be asked again, set when the owner
     * answers one of these with something that is not a name.
     *
     * A refusal is about the CLASS, not the hash. The owner said "I dont know,
     * we need to handle this in code" four times on 2026-09-09 and was asked
     * again each time, because a non-name answer only ever marked that one
     * alias as asked. There was no way for them to say "stop".
     */
    mutedUntil?: string;
    /**
     * When `identity-resolve` last swept the machine's own address sources for
     * these aliases. A sweep reads git history in every known project root, so
     * it is a daily job, not a per-tick one.
     */
    resolvedAt?: string;
  };

  workbench: {
    open: WorkJob | null;
    /**
     * Owner-requested jobs waiting for the open slot, oldest first. Optional
     * because snapshots from before it existed fold without it. Bounded (5):
     * a longer list is a backlog nobody asked to keep.
     */
    queue?: WorkJob[];
    /**
     * Jobs the owner asked for on a schedule ("every monday at 9am"), by a slug
     * of the subject. Each due occurrence joins `queue` as an owner request;
     * `lastRunAt` is the occurrence last queued (or the request itself), so a
     * replay or a restart never queues one twice. Bounded (10).
     */
    repeats?: Record<string, { subject: string; brief: string; schedule: string; lastRunAt: string }>;
    /** Bounded ring of closed jobs, newest last. */
    recent: WorkJobRecord[];
    /** Job keys already done (or declined), with when — so a subject is briefed once. Pruned by age. */
    done: Record<string, string>;
    /**
     * The lead phrases of a shelved MEETING brief, by the same key as `done`,
     * so the post-meeting question can offer them as one-tap answers ("Mostly:
     * open threads worth a slot") instead of a blank "how did it go?". Pruned
     * with `done`.
     */
    briefPoints?: Record<string, string[]>;
    /** Local day `countToday` belongs to. */
    day: string | null;
    countToday: number;
  };

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
   * What recurs, so an absence can be noticed at all.
   *
   * Every producer that existed before this slice fired on something HAPPENING,
   * which is why nothing could ever report a break not taken, a routine dropped, a
   * repository gone quiet or a day never spent away from the keyboard. Those are
   * the shape most of what a person actually wants noticed takes, and a nervous
   * system generates an error signal for an expected stimulus that fails to
   * arrive, not only for an unexpected one.
   *
   * Written by `expectationLearn`, read by `expectationWatch`. Bounded by stream
   * count times bucket count, which is declared in `OCCURRENCE_STREAMS` rather
   * than open-ended, so this cannot grow without a code change.
   */
  expectations: {
    recurring: Record<string, Recurrence>;
    /**
     * Per-local-day last observed activity, in minutes from local midnight.
     *
     * A separate series because a day's end is a PHASE, not an interval, and the
     * `Recurrence` machinery above measures gaps between occurrences. The gap
     * between one day ending and the next is always about 24 hours whatever time
     * the owner stopped, so an interval model is structurally blind to the very
     * thing worth noticing here.
     *
     * This is what makes bedtime drift detectable — a stop time sliding twenty
     * minutes later each night produces no surprising night, so it is invisible to
     * every surprise-based detector in the system, and a slope over this series is
     * the only thing that can see it.
     *
     * Bounded to `MAX_DAY_END_SAMPLES`. Newest last.
     */
    dayEnd: { day: string; minutes: number; basis?: string }[];
    /**
     * Edge-trigger markers for the day-end pair, which has no occurrence to re-arm on
     * the way `Recurrence.armed` does.
     *
     * Both candidates are computed from a standing condition — "you are past your usual
     * stop", "your stop time is sliding" — so without a marker they re-emit on every
     * `clock:tick` for as long as the condition holds. Measured on the synthetic corpus:
     * 146 `day-runs-long` candidates from a handful of genuinely late nights. The gate
     * suppressed all but a few, but the log filled with a producer talking to itself.
     */
    dayEndNotice: { runsLongDay: string | null; driftKey: string | null };
  };

  /**
   * The noticing gate's own memory — the single thing that decides whether Gnomon
   * says anything, and the slice whose absence explains the surface it replaces.
   *
   * Single writer: `noticeGate`.
   */
  notices: {
    /** Per-key response gain. See `habituatedGain`. */
    habituation: Record<string, HabituationEntry>;
    /** Local day the budget below belongs to; a different day resets it without needing a boundary event. */
    day: string;
    /** Tonic notices delivered today. Phasic ones deliberately do not count against it — that is what urgency means. */
    spentToday: number;
    /** Bounded ring of interrupting notices, for the app surface. */
    recentPhasic: PhasicNotice[];
    /**
     * Candidates worth saying that arrived at a bad moment — held, re-scored on each
     * `clock:tick`, delivered when the cost of interrupting falls.
     *
     * The third outcome the gate lacked. Before this, `decide` returned admitted or
     * suppressed, so "worth saying, wrong moment" had nowhere to live and became
     * silence indistinguishable from "not worth saying". ProMemAssist measured the
     * difference a defer queue makes on the same decision (24.6% vs 9.34% positive
     * response against an LLM baseline choosing its own timing).
     *
     * Deferral is deliberately NOT suppression, and the two must stay distinct: a
     * suppressed candidate leaves no trace in the gate's memory at all (see
     * `noticeGate`), while a deferred one is remembered precisely so it can be said
     * later. A deferred candidate has not been delivered, so it neither habituates
     * its key nor spends the daily budget until it actually reaches the owner.
     */
    deferred: DeferredNotice[];
    /**
     * The owner away from the Mac (idle, or the machine asleep) since `since`,
     * and what the gate admitted to the list meanwhile, kept for the return.
     *
     * After an hour away, a tonic notice is held here instead of being spent
     * into an empty room: it is weighed again at the first real input, so it
     * reaches the owner with its budget spent then, and its half-life counts
     * from when they could hear it. Absent = present, nothing held.
     */
    away?: { since: string | null; held: DeferredNotice[] };
  };

  /**
   * C4 (docs/audit/production-proposal-and-enhancements.md, fixes A§5.6) —
   * the two config values pure *rules* need (`retentionPrune`,
   * `memoryDecay`) live in `KernelState` itself rather than a module-level
   * config singleton, so a rule stays a pure `(state, event) => ...`
   * function with no external mutable read. `startDaemon` overwrites this
   * slice with the freshly-loaded `~/.sundial/config.json` values every
   * boot, *after* `hydrateSnapshot`/`createInitialState` — config is meant
   * to reflect what's on disk right now, not whatever a stale snapshot
   * captured, so it's deliberately exempt from the normal
   * snapshot-is-authoritative treatment every other slice gets.
   */
  config: KernelConfig;

  /** The owner's settings — see `OwnerSettings`. Written by `settingsTrack`. */
  settings: OwnerSettings;

  pending: {
    llmCalls: Record<string, PendingCall>;
    timers: Record<string, string>;
    debounces: Record<string, string>;
  };

  budgets: {
    byPurpose: {
      intent: { callsToday: number };
      companion: { callsToday: number };
      reflect: { callsToday: number };
      extract: { callsToday: number };
      journal: { callsToday: number };
      /**
       * The chat's answers (once `/ask` and `gnomon ask`), split off `knowledge` when the tool loop landed.
       *
       * Ask used to borrow the `knowledge` purpose because it was one call per
       * question and the sharing cost nothing. A tool loop is several round trips
       * per question, so a talkative afternoon would have quietly consumed the
       * knowledge rule's cap and stopped fact extraction — a background capability
       * failing because a foreground one was used a lot, with nothing in the
       * budget readout to explain it.
       */
      ask: { callsToday: number };
      /**
       * The nightly skeptic (`nightlyRefutation`). Its own line rather than a
       * share of `extract` because the two do opposite jobs — one grows core
       * memory, one tries to shrink it — and a budget that let a talkative
       * extraction night starve the pass that corrects it would hide exactly
       * the failure this purpose exists to catch.
       */
      refute: { callsToday: number };
      /**
       * Research-goal hypothesis proposals (`researchGoals` → `ScheduleLLM
       * purpose 'goal'`). One cheap call per proposal, at most two proposals
       * per goal and one goal open at a time, so the cap is a backstop against
       * a bug rather than a budget anyone should ever reach.
       */
      goal: { callsToday: number };
      /**
       * Tidying a speech capture for reading (`transcriptClean`). One call per
       * closed moment that actually heard something. Its own line because it is
       * the one purpose whose output is never trusted on its own — the raw
       * capture stays the record until the owner accepts the clean copy — and a
       * line nobody watches would hide a day of it running on silence.
       */
      transcript: { callsToday: number };
      perceive: { callsToday: number };
      classify: { callsToday: number };
      rank: { callsToday: number };
      judge: { callsToday: number };
      audit: { callsToday: number };
      forecast: { callsToday: number };
      listen: { callsToday: number };
    };
    day: string;
  };

  baselines: {
    hourlyDurationsByKind: RollingBaseline;
    lastAnomalyByKind: Record<string, string>;
  };

  /** Set by `retentionPrune` each time it fires, so the latest snapshot shows the daily prune actually ran, not just that the rule exists. */
  retention: { lastPrunedAt: string | null };

  recentHistory: ContextSnapshot[];

  memory: {
    accumulatedImportance: number;
    lastReflectionAt: string | null;
    /** D3 — last time `nightlyFactExtract` ran, same "since last run, or 24h back if never" pattern as `lastReflectionAt`. */
    lastFactExtractAt: string | null;
    /** Cursor for `conversationFactExtract`, the nightly pass over the owner's chat turns. Its own cursor, like the two above: the passes read different sources. */
    lastConversationExtractAt: string | null;
    /**
     * Last time the skeptic ran (`nightlyRefutation`). Rate-limits it to one
     * pass a day. Separate from `lastFactExtractAt` because the two passes do
     * opposite jobs — one grows core memory, one tries to shrink it — and
     * sharing a cursor would let a night of extraction suppress a night of
     * refutation.
     */
    lastRefutationAt: string | null;
    /** J2.3: the last belief-audit pass (`nightlyBeliefAudit`); null until the first tick after it shipped, which runs it once. */
    lastBeliefAuditAt: string | null;
    /** W2 (2026-09-23): the last world-hygiene pass (`worldHygiene`); null until the first tick after it shipped, which runs it once. */
    lastHygieneAt?: string | null;
    /** J2.4: the last alias-alignment pass (`nightlyAliasAlignment`); null until the first tick after it shipped. */
    lastAliasAlignmentAt: string | null;
    /** J2.4: pairs of names the exact leg or the judge says may be one thing, newest-highest first, bounded. The Trust page lists them; nothing acts on them. */
    aliasSuggestions: AliasSuggestion[];
    /**
     * `person-<hash>` alias → the name a confirmed `knownAs` belief gives it.
     *
     * A rule cannot query the graph, so the fold needs the mapping in state —
     * but it is maintained by `contradictionCheck`, the single writer of
     * confirmed facts, so EVERY path that establishes a name lands here: the
     * owner answering the question, `gnomon_assert`, the nightly conversation
     * pass, a replay. The first version kept its own copy inside `peopleAsk`,
     * which meant a name written by any other path was invisible to the rule
     * that asks for names, and it had to be patched to listen for candidates.
     */
    aliasNames: Record<string, string>;
    recentEntityIds: string[];
    /**
     * Meetings `entityExtract` has already minted attendee candidates for, so one
     * meeting corroborates a colleague ONCE.
     *
     * `calendar:active` polls while a meeting runs — 17 emissions covered 6 distinct
     * meetings on the live corpus — so without this an invite would re-propose the
     * same colleague on every tick.
     *
     * A bounded ring rather than one slot, because two meetings can overlap and a
     * poll alternating between them would defeat a last-one-wins field.
     *
     * Holds a hash of the calendar's own `eventId` (which carries the recurrence
     * instance, so each standup occurrence is distinct) — never the meeting title,
     * which `sanitizeAtIngest` leaves verbatim (nothing under `payload.event`
     * carries a `processName` to gate redaction on) and which therefore must not
     * spread into new surfaces. See `entityExtract`.
     */
    recentMeetingKeys: string[];
    /**
     * D3 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.5)
     * — `object`/`factId` are the currently-confirmed truth (`null` until a
     * candidate has been promoted at least once); `pendingObject`/
     * `pendingCount` track an in-flight candidate value that hasn't yet
     * recurred enough times to be promoted (no prior confirmed fact) or to
     * supersede the confirmed one (a genuine contradiction) — see
     * `contradiction-check.ts`'s doc comment for the full promotion policy.
     * A snapshot written before D3 lacks `pendingObject`/`pendingCount`;
     * `contradictionCheck` defaults them defensively rather than relying on
     * hydration to backfill every cursor entry.
     *
     * `projectId` (per-project working-memory filtering) is the entity's real,
     * resolved project scope — `state.project.current?.id` for the heuristic
     * candidates (`entityExtract`) and, for the nightly LLM pass, the
     * `relatesToProject` object resolved back against the actual project
     * registry (never the LLM's raw string) — `null` when no project could be
     * attributed, same "don't fabricate a fact from a weak guess" rule as
     * window/moment attribution. A snapshot written before this field lacks
     * it; `contradictionCheck` defaults it to `null` the same way it backfills
     * `pendingObject`/`pendingCount`.
     */
    factCursor: Record<string, { object: string | null; factId: string | null; confidence: number; pendingObject: string | null; pendingCount: number; projectId: string | null; /** lane Q: the local day the confirmed fact was last reinforced — one increment a day, however often it is re-seen. */ reinforcedOn?: string }>;
    /**
     * D5 (docs/audit/production-proposal-and-enhancements.md, addresses
     * A§5.1, A§5.5) — the last N companion insights (`kind` is the
     * triggering anomaly's `kind`, threaded through via `ScheduleLLMEffect.metadata`
     * so `applyLlmResult` can tag an entry without a DB read). `companionInsight`
     * reads this to (1) build a "don't repeat these" hint from recent titles
     * and (2) count how many same-`kind` insights landed in the trailing
     * window, so "third late night this week" is computed from in-memory
     * state, never a DB read a rule can't do.
     */
    recentInsights: { title: string; dedupeKey: string; kind: string; createdAt: string; id?: string; /** The `noticeGate` habituation key this insight came from, so a `not-now` verdict can quiet that key. */ noticeKey?: string }[];
    /**
     * D5 — "top entities/projects of the week," written by the daily
     * reflection pass (`performReflectionCall` in `apps/daemon/src/daemon/index.ts`,
     * which already reads the window's moments for its own summary — this
     * reuses that same read rather than a second query) via a synthetic
     * `memory:priorities` event, folded in by `memoryPriorities` (a plain
     * state-only rule, no effects). `momentAnalysisSchedule`'s intent prompt
     * includes this — the first genuine loop from memory back into
     * perception, per the proposal's own framing.
     */
    priorities: string[];
  };

  /**
   * Phase 1 endogenous-life (docs/design/08-endogenous-life.md §3, decisions
   * D2/D3). The surprise DRIVE itself lives in `memory.accumulatedImportance`
   * — the field the original design declared but never populated; `surpriseDrive`
   * now feeds it from `anomaly:detected`. This `mind` slice holds the derived,
   * human-legible readouts of that drive plus the endogenous-reflection cursor,
   * all maintained on `clock:tick` (no hidden timer — rides the existing tick,
   * per "the law", doc 00). Full mood readout (budget/contradiction inputs,
   * surfacing) is Phase 3.
   */
  mind: {
    /** Local-hour circadian phase, set by `mindTrack`; gates heavy autonomous work away from active daytime. */
    circadian: 'day' | 'evening' | 'night';
    /** Coarse mood, a readout of `memory.accumulatedImportance` (the surprise drive) — never an input to it. */
    mood: 'settled' | 'stirring' | 'restless';
    /** Last drive-triggered (endogenous) reflection — rate-limits `endogenousReflection`; distinct from the daily `memory.lastReflectionAt`. */
    lastEndogenousReflectionAt: string | null;
    /**
     * Where the daemon's own ignorance is concentrated — the forecaster cells it
     * is least sure of, worst first. Written by `uncertaintyMap`.
     *
     * This is a claim ABOUT A CLAIM, and that is what makes it worth ranking
     * rather than just counting. `predictions.hourlyDoneRate[h] = {n, hits}` is
     * a Beta posterior in disguise, and its variance depends on both how much
     * evidence a cell holds and how split that evidence is — so an hour observed
     * ten times and split five-five is genuinely less settled than one observed
     * ten times and never a day's last, which a bare sample count cannot say.
     *
     * Bounded, and cells with no observations at all are excluded: "I have never
     * seen you working at 04:00" is an absence of behaviour, not uncertainty
     * about it, and letting those dominate would fill the list with the small
     * hours and say nothing.
     */
    gaps: UncertaintyGap[];
    /**
     * The questions Gnomon has set itself, newest first — open ones first, then a
     * short tail of settled ones so a report can be written after the fact.
     *
     * Written by `researchGoals`. Bounded hard: this is a working set, not a
     * history. The durable record of what was learned is the `self-report` notice
     * the goal produces on closing, which goes through the same gate as everything
     * else and can therefore be habituated, deferred, or refused like any other
     * thing Gnomon might say.
     */
    goals: ResearchGoal[];
  };

  /**
   * P0-3 (docs/design/08-endogenous-life.md §11.2) — the near-future calendar,
   * refreshed by `scheduleTrack` from each `calendar:upcoming` emit (that signal
   * was imported but consumed by NO rule before this). Bounded to the next few
   * events, sorted by start. The forward model's most direct raw input; also
   * available to read paths now. `updatedAt` is the last emit ts (staleness).
   */
  schedule: {
    upcoming: UpcomingEvent[];
    updatedAt: string | null;
    /**
     * The meeting in progress, as of the last calendar poll, and null between
     * meetings. Lives HERE rather than being read off `state.moment.rollup`:
     * `momentClose` folds before `windowTrack`, so on the very window change
     * that enters a call the moment has just been re-opened with a blank
     * `meetingTitle`, and a `meetingContains` rule looking there matched
     * nothing for the whole call. The schedule slice survives moment
     * boundaries, which is what a rule needs.
     */
    /** `others`: attendees who are not the owner or a room; a block with 0 is not a call. Missing on an older fold. */
    active: { title: string; start: string; end: string; others?: number } | null;
  };

  /**
   * Phase 2b forward model (docs/design/08-endogenous-life.md §4, decisions
   * D4/D6/D12). The daemon predicts, then scores itself: `dayShapeForecast`
   * forms an `open` prediction when an hour becomes active and resolves it by
   * log-loss (surprise = −ln p_actual), feeds that surprise into the drive
   * (`memory.accumulatedImportance`) — the CONTINUOUS prediction-error signal
   * complementing Phase 1's discrete anomaly surprise — and updates
   * `calibration`, the running self-model of the daemon's own predictive
   * accuracy (D12, the first inward-pointing inference). `recentResolved` is a
   * bounded window for surfacing (M6). In-state only in v1; a persisted
   * predictions table (doc Q2) and LLM/belief-derived forecasts are deferred.
   */
  predictions: {
    open: OpenPrediction[];
    /**
     * Keyed by `OpenPrediction['kind']` rather than one pooled record, and it
     * stays that way now that only one kind is live. Pooling a learnable
     * target with an unlearnable one produces a number describing neither,
     * which is what forced this shape when `project-continuity` still existed
     * — and the per-kind split is also what let that forecaster be retired
     * without touching `day-ending`'s accumulated record. D12's calibration
     * gate reads this per kind, so a future forecaster arrives with its own
     * counter and cannot dilute an existing one.
     */
    calibration: Record<string, { n: number; hits: number; brierSum: number }>;
    recentResolved: ResolvedPrediction[];
    /**
     * `day-shape-forecast.ts`'s own bookkeeping for detecting "a new hour just
     * became active" from `input:activity` emits (which fire at a constant
     * ~10s cadence regardless of activity level — see that sensor's doc
     * comment — so "active" here means "the daemon was running and observing
     * this hour," not "the user was typing"; see
     * enhancements/presence-as-absence-ground-truth for that ground-truth
     * caveat). `day` uses the same `ts.slice(0,10)` convention as
     * `budgets.day`, checked independently rather than waiting on
     * `clock:tick`'s `day:boundary` — same reasoning `clockTick` itself uses
     * for its own day check.
     */
    dayShape: { day: string; candidateHour: number | null; emitsThisHour: number };
    /**
     * The `day-ending` forecaster's OWN learned prior — hour-of-day (0-23) ->
     * observed "was this hour the day's last active one" rate. Deliberately
     * separate from `calibration['day-ending']` (the self-model/score): using
     * a kind's own aggregate hit rate AS its prediction is the degenerate fixed
     * point that got the `project-continuity` forecaster retired (see
     * `rules/forward-model.ts`). This is the conditioning feature measured to
     * carry the skill; `calibration` only ever scores the result.
     */
    hourlyDoneRate: Record<number, { n: number; hits: number }>;
    /**
     * The previous resolved day's last active hour — written on every HIT
     * resolution, read only to evaluate `prev-day-ran-late` when a conditioned
     * bet opens. A single pair rather than a history: the conditioner needs
     * yesterday, and yesterday only.
     */
    lastDayEnd: { day: string; hour: number } | null;
    /**
     * J2.2's tournament (`forecastTournament`): the tallies its features are
     * read from, a ring of recent utterance timestamps for the meeting target,
     * and which forecasters it has retired per target. Calibration for the
     * tournament's forecasters is keyed `<target>/<forecaster>` in the shared
     * `calibration` map.
     */
    tournament: {
      day: string;
      projectToday: Record<string, { minutes: number; sessions: number }>;
      touchedDays: Record<string, string[]>;
      utterances: string[];
      retired: Record<string, string[]>;
    };
    /**
     * Conditioned cells: the structure research goals have PROVEN, installed
     * only by an accepted `goal:trial-result` (MDL-guarded information gain
     * over the forecaster's own recorded samples — see `conditioners.ts`).
     *
     * Keyed by hour like `hourlyDoneRate`. The flat cell keeps updating
     * regardless, so the original `hourly-rate` series stays comparable with
     * its +46.1% measurement; conditioned bets are recorded under their own
     * forecaster string for the same reason. The arms update at resolution
     * from the condition stamped on the open prediction; a bet whose condition
     * was unevaluable (`null`) updates the flat cell only.
     */
    conditioned: Record<number, {
      variable: string;
      arms: { when: { n: number; hits: number }; otherwise: { n: number; hits: number } };
      installedAt: string;
      goalId: string;
    }>;
    /**
     * The `hour-fragmented` forecaster's own accumulator — see
     * `HourFragmentedPrediction` for the measurement that justifies it.
     *
     * `switchesThisHour` is the evidence the open bet is resolved against, and it
     * is deliberately kept HERE rather than derived at resolution time from the
     * log. That is the lesson `dayShapeForecast`'s first version paid for: it
     * decided a hit from whichever of two differently-paced event types fired
     * first, and every hour learned the inverse of the truth. An outcome must be
     * a function of the prediction's own recorded state.
     */
    fragmentation: {
      /** Local day and hour currently accumulating, or null before any hour has become active. */
      current: { day: string; hour: number; switchesThisHour: number } | null;
      /** Activity emits seen in the hour being considered, until it crosses the active threshold. Mirrors `dayShape.emitsThisHour`. */
      emitsThisHour: number;
      /** The hour those emits belong to, as `day|hour`. Empty before the first emit. */
      emitsKey: string;
      /** Whether the hour that just closed came apart — the conditioning feature for the next bet. Null before any hour has closed. */
      prevFragmented: boolean | null;
      /**
       * The local day `prevFragmented` describes.
       *
       * Load-bearing, and a test caught its absence: without it the lag survived
       * a `day:boundary`, because that event clears `current` before the next
       * day's first switch can compare days — so a fragmented final hour of
       * Monday silently conditioned the first bet of Tuesday, which is a feature
       * nothing ever measured.
       */
      prevDay: string | null;
      /** Per-cell counts, keyed by the conditioning arm. Two cells only, because the measurement supported no finer split. */
      byPrevState: Record<'prev-frag' | 'prev-calm', { n: number; hits: number }>;
    };
    /**
     * The `project-touched` forecaster's own accumulator — see
     * `project-touch-forecast.ts` for the measurement that justifies it.
     *
     * `touched` is the evidence the open bets are resolved against, recorded by
     * this rule from `window.attribution` as the day goes, never re-derived at
     * resolution from whatever event happens to close the day — the lesson both
     * earlier forecasters paid for. Keyed by local day, and pruned to the bet
     * day and today, so a day that closes late (laptop shut overnight) still
     * finds its own record.
     */
    projectTouch: {
      /** Local day the open bets belong to, or null before any day has become active. */
      day: string | null;
      /** Activity emits seen in the hour being considered, until the day's first hour crosses the active threshold. */
      emitsThisHour: number;
      /** The hour those emits belong to, as `day|hour`. */
      emitsKey: string;
      /** Local day → projects attributed to at least one window that day. */
      touched: Record<string, string[]>;
      /** Project → the last local day it was touched. The candidate set a new day bets on, pruned by recency. */
      lastTouched: Record<string, string>;
      /** Project → resolved (n, hits): the forecaster's learned prior, per project. */
      byProject: Record<string, { n: number; hits: number }>;
    };
  };

  /**
   * The feedback loop (decisions/assistant-as-an-event-source) — the return path. Until this
   * existed, nothing anywhere observed whether an insight, journal, or fact
   * Gnomon produced was accurate, useful, or unwelcome, which is why both
   * "move a fact's confidence on predictive success" (fact-lifecycle-policy)
   * and D12's escalation gate were unimplementable as designed. `recent` is
   * a bounded window (same treatment as `predictions.recentResolved`);
   * `countsByVerdict` is the cumulative tally that survives that window
   * rolling over.
   */
  feedback: {
    recent: FeedbackEntry[];
    countsByVerdict: Record<string, number>;
    lastVerdictAt: string | null;
    /**
     * The one artifact the owner is currently being asked to rate, or null when
     * nothing is open. Written by `solicitFeedback`, cleared by `feedbackTrack`
     * when answered or by `solicitFeedback` when it expires.
     */
    solicitation: FeedbackSolicitation | null;
    /**
     * A bounded ring of artifact ids Gnomon has already asked about, so an
     * already-rated or already-asked insight is never solicited twice, and a
     * verdict arriving just after the pointer rotated still counts as solicited.
     */
    solicitedRecently: string[];
  };

  /**
   * docs/jarvis/02, "Thresholds and calibration live in KernelState". Jev's
   * answers are probabilities; what they MEAN for this owner is learned here,
   * per question id (law 4), from the owner's verdicts (J0.8) — never by the
   * executor. Extends `feedback` rather than duplicating it: `feedbackTrack`
   * keeps its tally and its retractions, and gains the bin update.
   *
   * `recent` is the bounded link from what the owner saw to the answers
   * behind it: `judgementTrack` records every `judgement:result` with the
   * probability each answer was decided on, keyed by moment or artifact, so a
   * verdict can find the questions it grades without a DB read. A snapshot
   * from before this field gets the defaults on boot (`deepMergeDefaults`);
   * the ring itself is not reloaded from a table because there is none — a
   * verdict lands within minutes of its line, inside the ring's window.
   */
  judgement: {
    questions: Record<string, JudgementQuestionRecord>;
    recent: JudgementRecent[];
    /**
     * J5.4's binding fix: answers a rule tagged with an `artifactId` (a notice
     * key, a fact id) keep their own ring, so the flood of per-moment results
     * cannot push a notice's features out before the owner's tap arrives hours
     * later. `feedbackTrack` searches both rings.
     */
    recentByArtifact: JudgementRecent[];
    /** Set by `judgement:degraded` from the executor's fallback (J0.9). Shown on the board. */
    degraded: 'none' | 'local-fallback' | 'off';
    /** When the mark last left `none`; null while judging is live. Trust shows the running time. */
    degradedSince: string | null;
    /** Milliseconds spent off `none`, over completed degraded spells. */
    degradedMs: number;
  };

  /**
   * The commitment ledger — open threads of work, and the ones that went quiet.
   *
   * See `Commitment`. Both lists are bounded the same way
   * `predictions.recentResolved` is: this slice rides in every snapshot, and an
   * unbounded list of every branch ever touched would grow the snapshot without
   * bound for the sake of rows the `commitments` TABLE already holds durably.
   *
   * Deliberately shipped WITHOUT a forecaster. The obvious target — "will this
   * thread be picked up again after today" — was measured first, per
   * `guides/measure-forecast-skill`, and the reference corpus offers 17 task
   * branches of which 5 span more than one day. The one available conditioning
   * feature (does the name carry a ticket id) splits that 4-of-9 against
   * 1-of-8, two-sided Fisher p = 0.29, and points the opposite way to intuition.
   * That is noise, and a prior fitted to it would be the `project-continuity`
   * mistake with a new name.
   */
  commitments: {
    open: Commitment[];
    recentClosed: ClosedCommitment[];
    /**
     * UC1: open promises, kept apart from the branch threads with a cap of
     * their own, so twenty branches can never evict one (the shared cap of 20
     * could). Written by `promiseTrack` only.
     */
    promises: Commitment[];
    /** UC1: the question about promises the owner has not answered yet, so the answer can be read after `ownerAsk` closes it. */
    promiseAsk: { askId: string; kind: 'meeting' | 'kept'; ids: string[]; attendees: string[]; meeting: { title: string; start: string } | null } | null;
  };

  /**
   * Wake-ups the owner or the model asked for — "check this again at 17:00".
   *
   * This is the whole of Gnomon's scheduling, and it deliberately rides
   * `clock:tick` rather than a timer of its own. dsh ships a schedule package
   * whose reminders are session-local with a five-minute floor; a wake-up set
   * on Monday would silently not exist on Tuesday's session, which is the
   * failure mode the event-sourced kernel exists to make impossible. A due
   * wake-up here is folded from the log, so it survives a restart, replays
   * identically, and is visible to `gnomon summary` like anything else.
   *
   * Bounded at `MAX_OPEN_WAKEUPS`, and firing REMOVES the entry — the same
   * edge-triggering `commitmentTrack` gets for free from a thread leaving
   * `open`. A recurring wake-up is therefore several deliberate acts, not one
   * standing timer nobody remembers arming.
   */
  wakeups: {
    open: ScheduledWakeup[];
  };

  /**
   * The question Gnomon is currently waiting on an answer to, if any.
   *
   * The inverse of `state.ask`, which records questions the OWNER asked. This is
   * the direction that never existed: Gnomon could observe, infer and speak, but
   * it could not ask and then know whether it had been answered — so anything
   * only the owner knows stayed unknowable, however cheap the question was.
   *
   * ONE open question at a time, deliberately, and for the same reason
   * `solicitFeedback` allows one solicitation: a queue of pending questions is
   * an interrogation, and an assistant that has asked three things and been
   * answered on one cannot tell which. The open question expires after
   * `OWNER_ASK_TTL_MS` — silence is not a `no`, it just unblocks the next
   * question, and it is recorded as an `expired` outcome because a question the
   * owner ignored is evidence about the asking.
   */
  /**
   * J2.7 — what the fan-out said each open goal got. `goalProgressTrack`
   * folds `goal:progress` (emitted by `applyMomentJudgement` when a goal slot
   * clears its threshold) into a bounded list per goal entity id, and the
   * Monday `goalCheckin` cites the week's sessions from it instead of guessing.
   * Fold-derived and snapshot-safe: an older snapshot lacks it and gets `{}`.
   */
  /**
   * J2.1 / J3.1 — the owner, as the machine believes them to be right now.
   *
   * `perception` is the raw-rate input the fold keeps for the `perceive`
   * question (law 7: numbers, never a rule's label): the last input windows
   * and nothing else — window switches come from `lifeEvent.recentSwitches`.
   * `focus` / `stuck` / `interruptible` are Beta beliefs the judge's
   * likelihoods move by w = 0.2 a tick and that decay toward the prior, so one
   * odd reading cannot flip them and a real change shows within three ticks.
   * `selfReports` are the owner's own "flow / meh / stuck" taps beside the
   * belief at that instant; `brier` is the filter scored against them — the
   * gate (docs/jarvis/02, J2.1) that decides whether these beliefs may ever
   * price an interruption. `energy` is the phone's night (J3.1).
   */
  owner: {
    perception: { input: { ts: string; windowMs: number; keys: number; events: number }[]; lastJudgedAt: string | null };
    focus: BetaBelief;
    stuck: BetaBelief;
    interruptible: BetaBelief;
    selfReports: { ts: string; tap: 'flow' | 'meh' | 'stuck'; pFlow: number; pStuck: number; brier: number }[];
    brier: { n: number; sum: number; firstAt: string | null };
    energy: { sleepHours: number | null; sleptFrom: string | null; sleptTo: string | null; restingHr: number | null; steps: number | null; updatedAt: string | null };
  };

  /**
   * J3.5 — the vault notes edited today (`vaultTrack`), paths only, keyed by
   * the note's path inside the vault. Reset daily. Empty when `config.vault`
   * is unset.
   */
  vault: {
    day: string | null;
    notesToday: Record<string, { changes: number; lastAt: string }>;
  };
  /** J4.3 — drafts the text model wrote from evidence, judged, waiting for the owner's tap. */
  drafts: {
    recent: Draft[];
  };
  /**
   * J3.6 — mail and messages, subjects and senders only (`mailTrack`). Bounded
   * rings; `accessible` says whether the readers could open the stores at all
   * (Full Disk Access), so a silence is named rather than mistaken for quiet.
   */
  mail: {
    recent: { from: string; subject: string; at: string }[];
    /** UC1: mail the owner sent — To and Cc as names or `person-<hash>`, the subject, when. Absent on a snapshot from before it. */
    sent?: { to: string[]; subject: string; at: string }[];
    messages: { from: string; chat: string | null; fromMe: boolean; at: string }[];
    accessible: boolean | null;
  };
  /**
   * J3.7 — the ingest anomaly check. `seen` is the ring of titles already put
   * to the judge (one question per NOVEL title); `marked` holds the text the
   * judge read as a claim or an instruction, with the probability, so the
   * fan-out and the render can leave it out (docs/jarvis/05, defence 3).
   * Marked text is never deleted from the log — only kept out of state above L2.
   * Both hold `textKey(text)` since lane Q (Q9), never the text itself.
   */
  ingestAnomaly: {
    seen: string[];
    marked: Record<string, { p: number; ts: string }>;
  };
  goals: {
    progress: Record<string, GoalProgressEntry[]>;
    /** J5.3 — this week's plan per ACTIVE goal, its steps and their grades. Snapshot-safe (`?? {}`). */
    pursuit?: Record<string, GoalPursuit>;
  };
  ownerAsk: {
    open: OpenOwnerAsk | null;
    /** Cumulative, so they survive the open slot turning over — same treatment `feedback.countsByVerdict` gets. */
    askedCount: number;
    answeredCount: number;
    /**
     * The last few questions the owner answered, newest last. This is what
     * stops the same question being asked twice: on 2026-09-07 the companion
     * lost the ask id of a meeting question the owner had already answered in
     * the web seat, opened a NEW ask with the same words to recover an id, and
     * the owner heard the question again. `ownerAsk` refuses an `ask:owner-opened`
     * whose question matches one of these within `REASK_WINDOW_MS`.
     */
    recent: AnsweredOwnerAsk[];
    /**
     * H4 — the backfill's pacing, and its end.
     *
     * `askHarvest` fires forwards only, and 49 answers already existed when it
     * landed. `askHarvestBackfill` takes the oldest unread one per hour; this
     * is when it last did, so a restart does not re-fire it immediately.
     * `backfillDone` is set when the executor reports nothing left to read, and
     * that is how the sweep ends on its own rather than needing a switch. A new
     * answer from then on is harvested live, so nothing turns it back on.
     */
    lastBackfillAt: string | null;
    backfillDone: boolean;
    /**
     * How much the owner still wants to be asked each KIND of question.
     *
     * The gate's own `notices.habituation` cannot do this and the record shows
     * why: an ask's gate key is its own id, an ask is asked once, so the key
     * never repeats and its gain is 1 forever. Measured 2026-09-22 over the 63
     * gate decisions an ask has ever had — `habituation` is 1.0 on every one of
     * them and `weight` is 2.0 on every one of them. The ask gate was not a
     * gate; the only thing that ever refused an ask was `too-costly-now`.
     *
     * So the stimulus is the CLASS (`askClass`) and this is its response,
     * `HabituationEntry` in the same shape and read with the same
     * `habituatedGain`, so there is one decay curve in the system rather than
     * two. It is moved ONLY by the owner's verdict, never by delivery — see
     * `askPrecision` for why delivery-decay would have killed the one class
     * that works.
     */
    classGain: Record<string, HabituationEntry>;
  };

  /**
   * Untracked time, gathered so the owner can be asked what it was.
   *
   * The resolver refuses to guess a project (decisions/no-ambient-project-
   * attribution), which is right — and it leaves a residue: hosts and apps that
   * take real time and never match a rule. `attributionPropose` times every
   * unattributed focus period by host or app, and the Today surface turns the
   * biggest into proposals: "acme.atlassian.net — 2h this week. Track as
   * puzzlebox-studio?" Accepting one writes a `ProjectRule` to config.json AND
   * onto `state.config.projectRules` in the same fold, so it applies to the
   * next window rather than the next boot. `decided` is what keeps a host
   * from being proposed twice, in either direction.
   */
  attributionProposals: {
    /** The unattributed window being timed right now, or null. */
    watching: { key: string; kind: 'host' | 'app'; label: string; processName: string; since: string; title: string | null; part?: { kind: 'path' | 'title' | 'meeting'; label: string } | null } | null;
    candidates: Record<string, AttributionCandidate>;
    decided: Record<string, { decision: 'assigned' | 'ignored' | 'shared' | 'personal' | 'ambient'; project: string | null; at: string }>;
  };

  /**
   * Questions the owner asked Ask, and which of their answers were promoted
   * into the knowledgebase. `recent` is a bounded window of metadata (see
   * `AskThreadEntry` for why the answers are not here); `askedCount` and
   * `rememberedCount` are the cumulative tallies that survive it rolling over,
   * same treatment `feedback.countsByVerdict` gets.
   *
   * Ask was single-turn and stateless before this: a thread lived in the macOS
   * app's `@State` and died with the window, so the product had no record that
   * a question was ever asked — the one signal that says, in the owner's own
   * words, what they wanted to know. Making it an ordinary event folded by an
   * ordinary rule is what puts it in the log with everything else.
   */
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

  /**
   * The assistant's own contributions to the log, folded like any sensor's.
   *
   * `decisions/assistant-as-an-event-source` makes the boundary two-way: what an
   * external assistant proposes and claims becomes ordinary events, so it can be
   * measured rather than merely trusted. A proposal the owner accepted or rejected
   * is the assistant's own outcome record, and a claim enters core memory through
   * the same `entity:fact-candidate` path a sensor uses — never a privileged write.
   */
  assistant: {
    /** Bounded ring of proposals and their eventual verdicts. */
    recent: AssistantProposal[];
    proposedCount: number;
    acceptedCount: number;
    rejectedCount: number;
    /** Claims routed into core memory as `provenance: 'assistant'` candidates. */
    claimedCount: number;
    lastAt: string | null;
  };

  ask: {
    recent: AskThreadEntry[];
    askedCount: number;
    rememberedCount: number;
    lastAskedAt: string | null;
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
  // lane E (#12)
  /**
   * The night shift: supervised Claude Code jobs, each in its own git worktree.
   * Single writer: `nightShift`. Optional: older snapshots predate it. Nothing
   * enters it, and nothing starts, while `config.jobs.enabled` is off.
   */
  nightShift?: NightShiftState;

  // lane D
  /** Where an interruption goes right now (#6 the right channel). Single writer: `noticeRoute`. */
  route: NoticeRoute;

  // lane C (enhancements 7, 8) — both optional: older snapshots predate them.
  /** Weekly trends from waking days (use case 8). Single writer: `driftTrack`. See `drift.ts`. */
  drift?: DriftState;
  /** Each testable belief's record against what the owner then did (use case 7). Single writer: `factTestTrack`. See `fact-tests.ts`. */
  factTests?: FactTestsState;

  // lane B — briefs (standup draft, meeting prep). Written by `briefClock`; optional because older snapshots predate it.
  briefs?: BriefState;

  // lane H
  /** Sundial's own health: what broke, since when, and whether it was said. Single writer: `sensorHealth`. */
  sensorHealth: SensorHealthState;
}

// lane H
/**
 * One thing wrong with Sundial itself (a grant dropped, a helper gone quiet,
 * a model refusing its key). Said once per incident: `raisedAt` is set when
 * the candidate goes to the gate, and the entry is removed when the trouble
 * clears, which re-arms it.
 */
export interface HealthTrouble {
  /** When it began, or when the Mac woke with it still standing (the clock restarts on a wake). */
  since: string;
  /** How long it must stand before it is said. */
  holdMs: number;
  observation: string;
  evidence: string[];
  raisedAt: string | null;
}

export interface SensorHealthState {
  /** Keyed by what broke: `input-grant`, `input-keys`, `sidecar:<label>`, `microphone`, `screen-recording`, `config`, `llm-auth:<provider>`. */
  troubles: Record<string, HealthTrouble>;
  /** The last `clock:tick`: a longer gap is a sleep, and restarts every trouble's clock. */
  lastTickAt: string | null;
  /** The run of input windows with no key press, timed in 30-minute windows. */
  keys: { since: string; windowStart: string; windowClicks: number; windowActive?: number; lastAt: string } | null;
  /** Consecutive auth refusals (401/403) per model provider. */
  llmAuth: Record<string, { count: number; label: string; statusCode: number | null }>;
  /** Purpose → the local day its budget last ran out (shown in Settings, never said). */
  budgetExhausted: Record<string, string>;
  /** The phone push: last success and last failure (shown in Settings). */
  push: { lastOkAt: string | null; lastFailedAt: string | null; lastError: string | null };
}

// lane D
/**
 * Where a notice the gate admitted as an interruption goes (#6 the right channel).
 *
 * One router, computed by `noticeRoute` from the log alone: `mac` (at the Mac
 * and active: the chat turn and the banner), `phone` (idle or asleep: ntfy),
 * `hold` (in a call, or a focus mode: wait for it to end). The gate reads it
 * with `routeFor`, and the phasic `Notify` carries the answer, so the
 * delivery plugin never decides.
 */
export interface NoticeRoute {
  channel: 'mac' | 'phone' | 'hold';
  /** `call` = an app holds the mic, or a calendar meeting is running. `focus` = a macOS focus mode is on. */
  reason: 'active' | 'away' | 'call' | 'focus';
  /** When this channel began. Null before the first event. */
  since: string | null;
  /** Idle or asleep since then; null = present. From `idle:start` / sleep until the first real input. */
  awaySince: string | null;
}

/** One owner-local day of work, as the standup draft reads it back. Bounded per field. */
export interface BriefDay {
  /** Commits per project (the repo folder's name), with up to three branches. */
  commits: Record<string, { n: number; branches: string[] }>;
  /** Pull requests whose state was first seen or changed that day, keyed `project#number`. */
  prs: Record<string, { number: number; title: string; state: string }>;
  /** Ticket keys named by that day's commits, branches and pull requests. */
  tickets: string[];
  /** Coding-agent session ids seen working, per project. */
  agents: Record<string, string[]>;
}

/** Lane B: what the briefs remember between ticks. */
export interface BriefState {
  /** The last few owner-local days, the oldest pruned at the day boundary. */
  days: Record<string, BriefDay>;
  /** Each pull request's last seen state, keyed `project#number`, so a change is counted once. Bounded. */
  prState: Record<string, string>;
  /** Person → the last meeting the owner was in with them (`calendar:active`). Bounded. */
  lastMet: Record<string, { title: string; start: string }>;
  /** Brief keys already raised, with when. Pruned with the days. */
  done: Record<string, string>;
  /** The last brief raised, for Today. */
  latest?: { kind: 'standup-draft' | 'meeting-prep'; title: string; start: string; end: string; lines: string[]; at: string } | null;
}

/**
 * Phase 2 scope: only the two effect types any rule actually produces this
 * phase. The rest of docs/design/03-effects-and-llm-policy.md's union
 * (ScheduleLLM, UpsertEntityFact, Embed, ...) lands in Phase 4/6 alongside
 * the rules that emit them — no speculative variants with nothing to test.
 */
export interface MomentRow {
  id: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  processName: string;
  /** `kind`/`focusScore`/`focusQuality` (docs/design/06, 07) exist here and not on `MomentRollup` itself — computed once at close time, meaningless on a still-open moment. */
  data: MomentRollup & { kind: MomentKind; focusScore: number; focusQuality: FocusQuality; audioContext?: AudioContext };
  /** §1's heuristic 1-10 importance, computed by `computeMomentImportance` (@sundial/memory) at write time — decayed by `memoryDecay` on `day:boundary`, never touched otherwise. */
  importanceScore: number;
  /** Phase 7 — persisted so `gnomon_project_status` (and any future project-scoped query) can filter moments by project; previously only lived in-memory on `state.moment.projectId`. */
  projectId: string | null;
}

/**
 * Minimal project-identity groundwork (not the WCS rule-learning system —
 * see docs/phase-3-implementation-plan.md's Wave 3a addendum). `id` is the
 * project's root path, assigned deterministically by the rule that emits
 * this effect — no DB read needed to know it.
 */
export interface ProjectRow {
  id: string;
  name: string;
  rootPath: string;
  organizationId: string | null;
}

/**
 * A git-remote-derived organization (e.g. `github.com/acme/x` → `acme`). `id`
 * is the owner slug itself — deterministic, so `projectTrack` (a pure rule)
 * assigns it and the matching `projects.organizationId` without a DB read.
 * Upserted alongside the project in the same rule pass.
 */
export interface OrganizationRow {
  id: string;
  name: string;
}

/** The same purposes as `state.budgets.byPurpose`. Kept as an inline literal union rather than imported from `@sundial/llm` to keep the rules' type surface free of a package a pure `(state, event)` function has no business reaching into — `packages/kernel` does now depend on `@sundial/llm`, but only for the tool registry's `ToolDefinition`, which is a read-path concern. The two unions must be edited together. */
export type LlmPurpose = 'intent' | 'companion' | 'reflect' | 'extract' | 'journal' | 'ask' | 'refute' | 'goal' | 'transcript' | JudgementPurpose;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Phase 4 (docs/design/03-effects-and-llm-policy.md). The rule builds the
 * full prompt from already-sanitized state — the executor's LLM dispatch
 * only ever does presentation trimming, never a redaction decision (that
 * boundary is restated in the design doc specifically because it matters
 * here). `delayMs` lets a rule debounce a burst of triggers (e.g. several
 * `window:changed` events firing before a moment truly settles) without the
 * rule itself holding a timer — the executor owns the actual wait.
 */
export interface ScheduleLLMEffect {
  type: 'ScheduleLLM';
  purpose: LlmPurpose;
  /**
   * L3 (docs/audit/remediation-todo.md's standalone bug list) — nullable
   * because not every purpose has a real moment to attach to: `companion`
   * insights are about a cross-session pattern, not any one moment.
   * `companionInsight` used to pass `state.moment?.id ?? ''`, landing an
   * empty string in `llm_audit.momentId` (a real value that looks like a
   * valid foreign key but breaks any future join against `moments.id`) —
   * `null` says "no moment" unambiguously, matching what the DB column and
   * `runAuditedLlmCall`'s own option type already accepted.
   */
  momentId: string | null;
  delayMs: number;
  messages: ChatMessage[];
  /**
   * Retry lineage for a render a RULE re-asks for (J1.1c): `verifyLine`'s
   * second render is attempt 2, pointing at the first render's audit row, so
   * the Ledger's retry view and `retrySpendUsd` see it exactly as they see a
   * transport retry. `llm:result` carries `auditId` so the rule can set it.
   */
  attempt?: number;
  parentCallId?: string | null;
  /**
   * D5 (docs/audit/production-proposal-and-enhancements.md, addresses
   * A§5.1) — opaque passthrough, copied verbatim onto the eventual
   * `llm:result` event's payload (`apps/daemon/src/daemon/index.ts`'s
   * `performScheduledLlmCall`). `companionInsight` is the first user: the
   * anomaly's `kind` needs to survive the schedule -> executor -> result
   * round trip so `applyLlmResult` can tag `state.memory.recentInsights`
   * with it without a DB read. Deliberately not folded into `momentId`
   * (already flagged as misused for this in the standalone bug list — L3).
   */
  metadata?: Record<string, unknown>;
}

/**
 * The purposes a `Judge` runs under (docs/jarvis/02). Jev's, apart from the
 * text model's, so a runaway fan-out cannot spend the journal's day. Mirrors
 * `JudgementPurpose` in `@sundial/llm/types.js`; kept here the way
 * `LlmPurpose` is, so a rule file imports one types module.
 */
export type JudgementPurpose = 'perceive' | 'classify' | 'rank' | 'judge' | 'audit' | 'forecast' | 'listen';

/** One question to Jev, as `callSystemOne` sends it (`@sundial/llm/systemone.js`). */
export interface JudgeQuestion {
  type: 'choice' | 'score' | 'noul';
  instructions: string;
  criteria?: Record<string, string> | string[];
}

/**
 * A question set for Jev (docs/jarvis/02, "one effect, one event"). Mirrors
 * `ScheduleLLMEffect` → `llm:result`: a rule builds `state` and `questions`
 * obeying the ten laws of state and emits this; the executor performs it
 * through `runAuditedJudgement` and ingests a `judgement:result` event
 * `{ purpose, questionSetId, momentId, answers, model, latencyMs, metadata }`;
 * a consuming rule pattern-matches on `questionSetId`. The fold never calls
 * Jev. Journaled like every effect (`markEffectStarted`/`Completed`), so a
 * replay of a log that already holds the answer never asks again.
 */
export interface JudgeEffect {
  type: 'Judge';
  purpose: JudgementPurpose;
  /** Which registry set built these questions (`packages/rules/src/questions/`). */
  questionSetId: string;
  momentId: string | null;
  /** 0 for perception; `ANALYSIS_DELAY_MS` for a closing moment. */
  delayMs: number;
  /** Named fields, short, numbers as numbers, no derived verdicts — the lint (J0.6) checks the builders. */
  state: unknown;
  questions: Record<string, JudgeQuestion>;
  /** Opaque passthrough onto the `judgement:result` payload, as `ScheduleLLMEffect.metadata`. */
  metadata?: Record<string, unknown>;
}

/** One draft (J4.3): an email or a note, the evidence it was written from, the judge's read, and the owner's tap. */
export interface Draft {
  id: string;
  kind: 'email' | 'note';
  to: string | null;
  subject: string;
  body: string;
  evidence: string[];
  at: string;
  status: 'open' | 'sent' | 'dismissed';
  closedAt?: string;
  /** `judge-draft`'s answers: P(grounded) and the tone level 0–3; null until they land. */
  judged: { grounded: number | null; tone: number | null } | null;
}

/** One step of a goal's weekly plan (J5.3). Internal steps run as jobs; outward ones are proposed to the owner and never run. */
export interface GoalPlanStep {
  id: string;
  text: string;
  outward: boolean;
  status: 'todo' | 'running' | 'done' | 'failed' | 'asked';
  /** `grade-step`'s noul on the shelved result. */
  grade?: number;
  resultTitle?: string;
}

export interface GoalPursuit {
  goalName: string;
  plannedAt: string;
  steps: GoalPlanStep[];
  reportedAt: string | null;
}

/** A Beta(α, β) belief; its mean is the probability. */
export interface BetaBelief {
  alpha: number;
  beta: number;
}

/** One moment the judge said advanced a goal (`goal:progress`). */
export interface GoalProgressEntry {
  momentId: string;
  ts: string;
  /** The noul the slot was decided on. */
  p: number;
  minutes: number;
}

/** The executor's answer to a `Judge`, as `judgement:result`'s payload. */
export interface JudgementResultPayload {
  purpose: JudgementPurpose;
  questionSetId: string;
  momentId: string | null;
  answers: Record<string, { type: string; choice?: string; score?: number; noul?: number; probabilities?: Record<string, number>; confidence?: number; legend?: Record<string, string> }>;
  model: string;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

/** One question's learned operating point and reliability record (law 4: keyed by `questionId`). */
export interface JudgementQuestionRecord {
  /** `choice` | `score` | `noul` — decides the default threshold. */
  type: string;
  /** Default 0.7 for a choice, 0.5 for a noul or score, until `n` ≥ 20; then the decile edge that maximises accuracy on the bins. */
  threshold: number;
  /** Verdict-scored outcomes: how many answers the owner graded, and how many were graded useful. */
  n: number;
  hits: number;
  /** Reliability by probability decile: graded answers per decile, and how many of them were useful. */
  bins: { n: number[]; hits: number[] };
  lastVerdictAt: string | null;
}

/** One `judgement:result`, reduced to the probability each answer was decided on, keyed so a verdict can find it. */
export interface JudgementRecent {
  ts: string;
  questionSetId: string;
  momentId: string | null;
  /** The artifact the answers produced, when the rule that built the `Judge` said so in `metadata.artifactId`. */
  artifactId: string | null;
  /** question id → the probability read off the answer (noul, top probability of a choice, or the chosen level's probability). */
  p: Record<string, number>;
}

/**
 * J1.6: Jev's reading of a notice, filed beside the gate's arithmetic on the
 * same `gate_decisions` row — logged, not used. Nothing branches on these
 * until J5.1 has a month of them and the owner's verdicts to fit against.
 * Numbers only: each field is a probability or a level plus its probability.
 */
export interface GateFeatures {
  speak_now: number | null;
  value: number | null;
  value_p: number | null;
  channel: string | null;
  channel_p: number | null;
  stale_soon: number | null;
  actionable: number | null;
  model: string;
  at: string;
}

export interface RecordGateFeaturesEffect {
  type: 'RecordGateFeatures';
  /** The `RecordGateDecision` row this sits beside — derived the same way, from the candidate event. */
  decisionId: string;
  noticeKey: string;
  features: GateFeatures;
}

/**
 * J1.5: the owner said "attach the transcript" to a question about a
 * meeting, and until this effect existed nothing did — the words were only
 * stored. The executor gathers what ambient hearing wrote down inside the
 * meeting's window (`audio:transcript` signals, then the moments' cleaned
 * excerpts as a fallback) and files it as a `meeting-transcript` knowledge
 * entry keyed by the ask, with the owner's own answer on top. Two keys: the
 * meeting is a calendar or AV row (`state.meetings.seen`), the instruction is
 * the owner's. Nothing on record → nothing written, and the log says so.
 */
export interface AttachTranscriptEffect {
  type: 'AttachTranscript';
  askId: string;
  title: string;
  start: string;
  end: string;
  /** Who was invited (alias-sanitized): in a 1:1 call, the far side of the transcript gets this name. */
  attendees?: string[];
  /** The owner's reply, filed above the transcript so the note reads as theirs. */
  answer: string;
  ts: string;
}

/**
 * Merges `patch` into a moment's `data` JSON column after it has already
 * closed (read-modify-write in the executor, not the rule — see
 * `packages/db/src/queries/moments.ts`'s `mergeMomentData` doc comment,
 * same accepted pattern as `projectTrack`'s org-assignment gap).
 */
export interface UpdateMomentDataEffect {
  type: 'UpdateMomentData';
  momentId: string;
  patch: Record<string, unknown>;
}

/**
 * One reading of an ask answer, offered to the owner as a filled-in form.
 *
 * Shaped exactly like `ExtractedFactCandidate` (`@sundial/rules`) so the two
 * paths into the same fact table cannot drift into two vocabularies — but it is
 * NOT a candidate and never enters the `entity:fact-candidate` door. The one
 * auto-router that exists wrote the owner's counter-question down as a human
 * being's name; see `askHarvest`'s own comment for why this stops short of
 * writing anything.
 */
export interface AskProposal {
  entityKind: 'person' | 'project' | 'tool' | 'topic' | 'owner' | 'goal';
  canonicalName: string;
  predicate: string;
  object: string;
  /** Orders the proposals and filters the weak ones. It is NOT a fact's confidence — nothing here writes a fact. */
  confidence: number;
}

/**
 * Merges `patch` into an `owner_asks` row after it has closed — the same
 * division of labour `UpdateMomentData` has, and for the same reason: the row
 * is already written by the time a model has read it, so the update is a
 * read-modify-write in the executor and never in the rule.
 *
 * `proposals` is the only patchable column today. The question and when it was
 * asked are what actually happened and stay unwritable, exactly as
 * `upsertOwnerAsk` already refuses to rewrite them.
 */
export interface UpdateOwnerAskEffect {
  type: 'UpdateOwnerAsk';
  askId: string;
  patch: { proposals?: AskProposal[] };
}

/**
 * H4 — read the oldest answer no model has looked at yet.
 *
 * Same division of labour as `RunFactExtraction`: the rule says a sweep is due,
 * the executor does the DB read a pure rule structurally cannot — which answer
 * is next, and whether there are any left. It calls no model itself; it appends
 * `ask:harvest-due` carrying the row it found, and `askHarvest` builds the one
 * prompt both doors share. When there is nothing left it appends
 * `ask:harvest-drained` instead, which is what ends the sweep.
 */
export interface RunAskHarvestBackfillEffect {
  type: 'RunAskHarvestBackfill';
  ts: string;
}

/**
 * The delivery channel. The harness executor forwards this to the Cordis
 * event `gnomon/notice`; the `sundial-proactive` plugin injects it into the
 * companion agent (and wakes it for `phasic-notice`). The old daemon could
 * only console.log it.
 */
export interface NotifyEffect {
  type: 'Notify';
  channel: string;
  payload: Record<string, unknown>;
}

/**
 * Phase 5's `companionInsight` output. `dedupeKey` maps to a real unique DB
 * index (`packages/db/src/schemas/db-schema.ts`) — the executor's insert is
 * `onConflictDoNothing`, so a repeat insight is a harmless no-op, not
 * something this rule needs to check for itself (no DB read from a rule).
 */
export interface KnowledgeEntryRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  severity: string | null;
  dedupeKey: string;
  sourceEventId: string | null;
  createdAt: string;
  /** Omitted defaults to the schema's baseline (5); an anomaly-driven companion insight is already known-significant, so `companionInsight`'s write sets it higher. */
  importanceScore?: number;
}

/**
 * One Ask thread, as it is written to `ask_threads`. Upserted by id, and the
 * second write (the remember) may only change the remember columns — the
 * question and the answer are what was actually asked and answered.
 */
/**
 * Where a Figure says it can be opened in full — the Study altitude whose page
 * draws the same data with the same marks. Shared with `show_view`, which
 * navigates to exactly these.
 */
export type ViewAltitude = 'today' | 'trend' | 'memory' | 'trust' | 'unsaid' | 'index';

/**
 * A typed visual fragment an answer carries alongside its prose — the
 * assistant drawing with the app's own hands.
 *
 * Three rules make this different from "the model returns a chart", and all
 * three are why the union is closed:
 *
 * - **Composed daemon-side, always.** Every variant below is built from the
 *   same queries the resident Study pages read. A model chooses WHICH figure to
 *   compose and over what window; it never supplies the numbers. There is no
 *   variant carrying model-authored data, and adding one would undo the point.
 * - **Rendered by the components that already exist.** The client maps each
 *   variant onto the page component that draws that shape, so an answer's chart
 *   and a page's chart cannot disagree — they are the same drawing code over
 *   the same numbers.
 * - **Captioned with its own scope.** `caption` states the window and the
 *   evidence count in words, composed here, because it is a claim about how
 *   much was seen and claims are computed daemon-side.
 *
 * An unknown `kind` must be ignored by a client rather than failing the answer:
 * a daemon that learns a seventh figure has to reach an older app as prose with
 * one fragment it quietly skips.
 */
export type Figure =
  | {
      kind: 'dial-slice';
      caption: string;
      openIn: ViewAltitude;
      /** `YYYY-MM-DD`, the owner's local day. */
      date: string;
      /** Hour bounds of the drawn axis, e.g. 6 → 24. */
      fromHour: number;
      toHour: number;
      /** Minutes a sensor actually accounted for, against the wall clock of the same window. The pair IS the unobserved hatch. */
      observedMin: number;
      wallClockMin: number;
      curve: { hour: number; score: number }[];
      meetings: { startHour: number; endHour: number }[];
      deepBlocks: { startHour: number; endHour: number }[];
      /** Where the gnomon stands, or null for a day that is not today. */
      nowHour: number | null;
    }
  | {
      kind: 'trend-slice';
      caption: string;
      openIn: ViewAltitude;
      /** `observed: false` is a day the sensors saw nothing — rendered as absent, never as a zero. */
      days: { date: string; minutes: number; observed: boolean }[];
    }
  | {
      kind: 'graph-neighborhood';
      caption: string;
      openIn: ViewAltitude;
      center: { id: string; name: string; kind: string };
      /** Direct edges only. A neighbourhood that fans out two hops stops being readable at this size. */
      edges: { toName: string; predicate: string; provenance: string }[];
    }
  | {
      kind: 'fact-chain';
      caption: string;
      openIn: ViewAltitude;
      entityName: string;
      predicate: string;
      /** Oldest first, so the chain reads the way it was built. `supersededAt` set marks a link that stopped being believed. */
      links: { at: string; object: string; confidence: number; provenance: string; supersededAt: string | null }[];
    }
  | {
      kind: 'commitment-thread';
      caption: string;
      openIn: ViewAltitude;
      name: string;
      branch: string | null;
      openedAt: string | null;
      /** Distinct days returned to — what separates a real thread from one long afternoon. */
      activeDays: number;
      touches: number;
    }
  | {
      kind: 'census';
      caption: string;
      openIn: ViewAltitude;
      /** `total: null` is a count with no denominator — shown as a bare count, never as a share it cannot support. */
      rows: { label: string; count: number; total: number | null }[];
    };

export interface AskThreadRow {
  id: string;
  question: string;
  answer: string | null;
  reason: string | null;
  sourceCount: number;
  /** Stringified `AskSource[]`, or null. A rule cannot read the DB, so the sources arrive on the event and are passed straight through. */
  sources: string | null;
  askedAt: string;
  /** LLM round trips the tool loop took. 1 for a question answered without calling a tool. */
  rounds: number;
  /** Stringified `string[]` of the tools that produced a result, or null. Serialized by the route for the same reason `sources` is — a rule does not serialize. */
  toolsUsed: string | null;
  /** Stringified `Figure[]`, or null. Serialized by the route, same reason again. */
  figures: string | null;
  remembered: boolean;
  rememberedAt: string | null;
  rememberedEntryId: string | null;
  sourceEventId: string | null;
}

/** One durable record of Gnomon asking the owner something. See `KernelState.ownerAsk`. */
export interface OwnerAskRow {
  id: string;
  question: string;
  /** Why the question was worth asking, in the model's words. Null when it gave none. */
  reason: string | null;
  askedAt: string;
  /** Null for an `expired` outcome — an unanswered question has no answer, and recording one would invent it. */
  answer: string | null;
  answeredAt: string | null;
  /** `answered` | `expired`. Silence is a real outcome, and the one that says the asking is miscalibrated. */
  outcome: string;
}

/**
 * Phase 5's `retentionPrune`. `olderThan` is an ISO timestamp, not a bare
 * day count — the rule computes the cutoff (it has `event.ts` in hand from
 * `day:boundary`), the executor just deletes anything before it. Scoped to
 * `signals`/`moments` only (see `packages/db/src/queries/retention.ts`'s
 * doc comment for why `llm_audit`/`knowledge_entries` aren't included).
 */
export interface DeleteRowsEffect {
  type: 'DeleteRows';
  olderThan: string;
  /**
   * When present, only `signals` rows of these `signal_type`s older than
   * `olderThan` go — the short-horizon sweep for screen text. Absent means the
   * general prune: signals, moments, llm_audit, orphaned embeddings.
   */
  signalTypes?: string[];
  /**
   * With `signalTypes`: only rows whose payload `processName`/`bundleId`
   * contains one of these — the purge of captures from an app that has since
   * joined the sensitive list. Bounded per run by the executor.
   */
  apps?: string[];
  /** With `signalTypes`: only these `event_type`s (`audio` + `transcript`). */
  eventTypes?: string[];
  /** lane Q (Q10): instead of deleting, clear `llm_audit` text and prune completed `applied_effects` rows older than `olderThan`. */
  trim?: 'audit-bodies';
}

/**
 * Phase 6 core memory (docs/design/05-memory-and-knowledgebase.md §4).
 * `factId` is generated by the rule proposing the fact (`contradictionCheck`),
 * not the executor — so the same rule can store it in
 * `state.memory.factCursor` for a future supersession without a DB
 * round-trip to learn what id the executor assigned. `entityKind`/
 * `canonicalName` let the executor upsert the parent `entities` row in the
 * same effect — a rule never needs to know whether the entity already
 * exists.
 */
export interface UpsertEntityFactEffect {
  type: 'UpsertEntityFact';
  factId: string;
  entityId: string;
  entityKind: EntityKind;
  canonicalName: string;
  predicate: string;
  object: string;
  confidence: number;
  sourceEventId: string;
  ts: string;
  /** See `FactProvenance` — carried onto the stored row so a later reader can tell a corrected fact from a well-corroborated one. */
  provenance: FactProvenance;
}

/**
 * Zep-style fact invalidation (§4) — the executor sets `validTo`/
 * `supersededBy` on the old fact; it never deletes or overwrites `object`.
 * Always paired with a `UpsertEntityFactEffect` for the new fact in the same
 * rule's return value.
 */
export interface SupersedeFactEffect {
  type: 'SupersedeFact';
  factId: string;
  supersededByFactId: string;
  ts: string;
}

/**
 * Closes a fact's validity with NO replacement — "this is false", as distinct
 * from supersession's "this changed to that".
 *
 * ## Why this had to be its own effect
 *
 * `feedbackTrack` recorded the owner's `wrong` verdict and deliberately stopped
 * short of acting on it, naming the exact reason: supersession replaces a fact
 * with a different VALUE, and retraction has no replacement value to offer, so
 * there was no effect that could express it. The consequence was that the whole
 * feedback return path was write-only — `feedback:verdict`, `state.feedback`,
 * `POST /feedback`, `gnomon feedback` and the macOS verdict buttons all shipped,
 * and no rule read any of it. Correcting Gnomon changed nothing.
 *
 * ## How a retracted fact reads back
 *
 * That was the open question, and the answer needs no migration and no new
 * column: `validTo` set with `supersededBy` left NULL is already a distinct,
 * representable state, and it is the only combination the existing writers never
 * produce. So:
 *
 * - Every "what do I currently believe" path filters `valid_to IS NULL`, so a
 *   retracted fact leaves the owner's beliefs the moment this applies — which is
 *   the entire point, and it happens without touching a single read path.
 * - Every history path keeps it, with `supersededBy: null` marking it as
 *   retracted rather than replaced. "You used to believe X and I told you it was
 *   wrong" stays in the timeline, exactly as `concepts/entity-facts-and-belief`
 *   argues a correction should.
 *
 * The fact's row is never deleted or rewritten, same invariant supersession
 * holds (see `entities.ts`).
 */
export interface RetractFactEffect {
  type: 'RetractFact';
  factId: string;
  /** Why it was retracted, for the effect journal. Currently only ever an owner `wrong` verdict. */
  reason: string;
  ts: string;
}

/**
 * The owner said a knowledge entry was wrong — withdraw it from retrieval
 * without deleting what Gnomon said.
 *
 * The argument for this existing at all: an insight, a journal entry and a kept
 * answer are all indexed, and `scoredSearch` hands them to the next question as
 * evidence. So an uncorrected wrong entry does not merely sit there being
 * wrong — it gets cited, and Gnomon starts reasoning from its own mistake. That
 * is the failure `RedesignAskPage` names when it refuses to auto-remember an
 * answer, and until now the owner had no way to undo it once an entry existed.
 *
 * Retraction, not deletion, for the same reason `RetractFactEffect` gives: the
 * row is the record that Gnomon claimed this, and that record is worth keeping
 * even — especially — when the claim was false. `retracted_at` set is a state no
 * other writer produces, so it is unambiguous; the entry keeps its place in
 * history, and `scoredSearch` sweeps its embedding exactly as it sweeps a
 * superseded fact's, so the claim cannot come back as evidence.
 */
/**
 * UC1 (U1-F2): one promise pass over a whole meeting that just ended. The
 * executor gathers what hearing wrote down inside the window (the utterances,
 * speaker-labelled when the far side was heard, and any Meet captions), asks
 * the `extract` model for the promises in it, keeps those grounded in the
 * words, and ingests one `meeting:promises` — with an empty list when nothing
 * was heard or nothing was promised, so the fold learns the pass is done.
 * The transcript never enters the log.
 */
export interface RunMeetingPromisesEffect {
  type: 'RunMeetingPromises';
  meetingKey: string;
  title: string;
  start: string;
  end: string;
  /** The other people on the invite, as the log names them. */
  attendees: string[];
  ts: string;
}

export interface RetractKnowledgeEntryEffect {
  type: 'RetractKnowledgeEntry';
  entryId: string;
  /** Why it was retracted, for the effect journal. Currently only ever an owner `wrong` verdict. */
  reason: string;
  ts: string;
}

/**
 * §6 — local embedding only (decision #5, docs/design/00-overview.md). The
 * rule hands over already-sanitized `text`; the executor computes the
 * vector (`packages/memory/src/local-embedding.ts`) and stores it. There is
 * no remote-embedding effect variant — adding one later would need to be a
 * deliberate, separately-reviewed decision, not a natural extension of this
 * one.
 */
export interface EmbedEffect {
  type: 'Embed';
  id: string;
  refType: 'moment' | 'knowledge_entry' | 'entity_fact';
  refId: string;
  text: string;
}

/**
 * Phase 6b's `memoryReflection` (docs/design/05-memory-and-knowledgebase.md
 * §2). Unlike `ScheduleLLM` (which schedules a call for a rule-named
 * `momentId`), the reflection LLM call needs to read a whole window of
 * moments/knowledge entries first to build its prompt — a DB read a pure
 * rule structurally can't do. Symmetric with how `dispatchScheduleLLM`
 * already does all I/O (budget check, retry, the call itself) outside the
 * rule layer: this effect just says "reflection is due, starting from
 * `since`" and the executor does everything else, same division of labor.
 */
export interface RunReflectionEffect {
  type: 'RunReflection';
  since: string;
  ts: string;
  /**
   * Phase 1 endogenous-life — `'daily'` (default/absent) is the `day:boundary`
   * reflection (`memoryReflection`), one per calendar day via a
   * `reflection:<date>` dedupeKey; `'endogenous'` is a drive-triggered early
   * reflection (`endogenousReflection`) that must persist ALONGSIDE the daily
   * one, so the executor gives it a distinct dedupeKey. See docs/design/08 §3.
   */
  reason?: 'daily' | 'endogenous';
}

/**
 * D3 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.5) —
 * "wire the unused `extract` LLM purpose to a nightly pass over the day's
 * rollups proposing typed facts... as `entity:fact-candidate` events through
 * the normal pipeline." Same division of labor as `RunReflectionEffect`
 * (a DB read over a time window a pure rule can't do, so the rule just says
 * "extraction is due" and the executor does the read + call + emits the
 * resulting candidates as ordinary events, through `contradictionCheck`'s
 * usual promotion policy — never a direct `UpsertEntityFact`).
 */
/**
 * The nightly pass over the owner's own chat turns (`conversationFactExtract`).
 * Same division of labour as `RunFactExtraction`: the rule names the window,
 * the executor reads the dsh session store through an injected
 * `ConversationSource`, redacts, calls the `extract` purpose, and re-enters
 * every finding as an ordinary `entity:fact-candidate` with
 * `provenance: 'conversation'`. The transcript itself never touches the log.
 */
export interface RunConversationExtractionEffect {
  type: 'RunConversationExtraction';
  /** ISO — owner turns at or after this instant are read. */
  since: string;
  ts: string;
}

export interface RunFactExtractionEffect {
  type: 'RunFactExtraction';
  since: string;
  ts: string;
}

/**
 * "Work out who these hashed attendees are, from what is already on this
 * machine."
 *
 * `sanitizeAtIngest` turns a calendar attendee the calendar sent as a bare
 * address into a `person-<hash>` alias, and for a long time nothing could turn
 * that back into a name — so `peopleAsk` asked the OWNER, who cannot read a
 * hash either. Seven such questions went out on 2026-09-09 and all seven were
 * refused, one of them with "I dont know, we need to handle this in code".
 *
 * The alias is a hash, not a lock. Every colleague's address also appears in
 * places the machine can read directly — git commit authors in the known
 * project roots, notes in the vault — so hashing each candidate with
 * `aliasIfEmail` and comparing is an EXACT test of identity, needing no model
 * and no question. Measured on the live record before this effect existed, git
 * history alone matched 6 of the 25 aliases.
 *
 * An effect rather than rule code because it reads the filesystem AND the
 * entities table, and a rule may do neither. It carries no alias list on
 * purpose: `identity-resolve` is only a clock, and the executor finds every
 * person entity whose canonical name is a hash and which has no `knownAs`
 * belief. The first version had the rule enumerate them from
 * `state.meetings.seen` and that map holds only RECENT meetings, so the sweep
 * did nothing while 25 hashed people sat in the table.
 *
 * The executor emits one `entity:fact-candidate` per match, carrying ONLY the
 * resolved name — the address itself never enters the log, which is the entire
 * reason the alias exists.
 */
export interface ResolveAliasesEffect {
  type: 'ResolveAliases';
  ts: string;
}

/**
 * "Try to disprove some of what you believe."
 *
 * The adversarial half of core memory. Every other path into belief is
 * corroborative — `entityExtract` proposes what it saw, `contradictionCheck`
 * promotes what recurred, `factConfidenceDecay` lets the unreconfirmed drift
 * toward uncertainty. Nothing has ever tried to show a confirmed fact FALSE, so
 * a wrong belief that stops being observed does not get corrected, it just
 * fades slowly while still being read — which is the compounding-error worry
 * `decisions/assistant-as-an-event-source` records as this codebase's main risk
 * once an assistant starts writing back what it concludes.
 *
 * Same division of labour as `RunFactExtraction`: the rule names the moment and
 * the size of the pass, the executor picks the sample, calls the model
 * (purpose `refute`), and turns each successful refutation into an ordinary
 * `entity:fact-candidate` for the NEGATION.
 *
 * The skeptic gets no privileged write. A refutation enters through the same
 * gate a sensor's observation does and is subject to the same promotion policy
 * — `contradictionCheck` stays the single writer of belief. That is what keeps
 * belief replayable from evidence rather than from whatever a model said one
 * night.
 */
export interface RunRefutationEffect {
  type: 'RunRefutation';
  /** How many facts to put up for refutation this pass. */
  sampleSize: number;
  ts: string;
}

/**
 * J2.3 — the nightly belief audit. The rule says a pass is due; the executor
 * reads every live inferred fact (a pure rule cannot) and puts each one to
 * the judge as its own `audit-fact` judgement, `factId` in the metadata, so
 * `applyFactAudit` retracts by id. Replay never calls the network: the
 * `judgement:result`s are in the log.
 */
export interface RunBeliefAuditEffect {
  type: 'RunBeliefAudit';
  ts: string;
}

/**
 * J2.4 — the Jev leg of alias alignment. The rule (`nightlyAliasAlignment`)
 * has already done the exact leg in the fold; the executor reads the entity
 * table (a rule cannot), shortlists pairs of project and person entities, and
 * puts each pair to the judge as one `align-alias` judgement. Its answers
 * become SUGGESTIONS on the Trust surface (`applyAliasAlignment`), never a
 * merge — the owner's `projectAliases` is the key that merges.
 */
export interface RunAliasAlignmentEffect {
  type: 'RunAliasAlignment';
  ts: string;
}

/** One "these two names may be one thing" the Trust surface shows (J2.4). `basis` says who said so. */
export interface AliasSuggestion {
  kind: 'project' | 'person';
  aId: string;
  a: string;
  bId: string;
  b: string;
  /** P(same): 1 for an exact same-name match, the judge's noul otherwise. */
  p: number;
  basis: 'same-name' | 'judge';
  at: string;
}

/**
 * P5 (docs/design/07) — "the day-writer is due for `date`." Same division of
 * labor as `RunReflectionEffect`: the rule (`dailyJournal`, on `day:boundary`)
 * just names the day that ended; the executor (`performDailyJournalCall`) builds
 * the day's `DailyContext`, calls the LLM (purpose `journal`), and writes the
 * `kind: 'daily'` knowledge entry. A missed run is picked up by an on-demand
 * regenerate, so — like reflection — the background job gets no retry.
 */
export interface RunJournalEffect {
  type: 'RunJournal';
  date: string;
  ts: string;
  /** P6 — regenerate: delete the existing `daily:<date>` entry first so the (otherwise no-op) insert overwrites it. Default false (the midnight auto-run never clobbers a hand-regenerated day). */
  overwrite?: boolean;
}

/**
 * §5 — decays every row's `importanceScore` by `factor` (a multiplier, e.g.
 * 0.95). Deliberately excludes `entity_facts`: core memory is curated, not
 * raw, and only changes via supersession (§4), never silent fade-out.
 */
export interface DecayScoresEffect {
  type: 'DecayScores';
  factor: number;
}

/**
 * Phase 2a (docs/design/08-endogenous-life.md §5, decision D7) — supporting
 * evidence for a confirmed fact: the executor bumps its Beta `alpha` by `delta`
 * and recomputes the derived `confidence`. Emitted by `contradictionCheck` when
 * a confirmed fact is re-observed (and, from Phase 2b, on a successful
 * prediction it generated). The record (object, validity window) is never
 * touched — only the certainty moves.
 */
export interface ReinforceFactEffect {
  type: 'ReinforceFact';
  factId: string;
  delta: number;
  ts: string;
  /** lane C: `beta` is evidence AGAINST — a prediction the fact made that failed (`factTestTrack`). Absent means `alpha`. */
  side?: 'alpha' | 'beta';
}

/**
 * Phase 2a (docs/design/08-endogenous-life.md §5, decision D8 — "decay the
 * certainty, never the record"). On `day:boundary`, decays every CURRENT fact's
 * Beta counts toward the uninformative prior by `factor`, drifting stale,
 * unreconfirmed beliefs toward uncertainty without ever altering the fact's
 * object or validity window. The entity_facts analogue of `DecayScores` (which
 * deliberately excludes entity_facts).
 */
export interface DecayFactConfidenceEffect {
  type: 'DecayFactConfidence';
  factor: number;
  ts: string;
}

/**
 * One resolved prediction, on its way to the durable `predictions` table.
 *
 * The fitness record used to live only in `predictions.recentResolved`, a
 * 50-entry window on a state object that gets snapshotted and truncated. A08
 * asks for 100 resolutions before it will report a calibration figure, so the
 * ambition could not be reached however long the daemon ran — see the table's
 * own doc comment in `packages/db/src/schemas/db-schema.ts`.
 *
 * A rule stays pure: `dayShapeForecast` folds the outcome into state AND returns
 * this, and the executor is the only thing that writes. `id` is the open
 * prediction's derived id, so a replayed effect offers the same row.
 */
/**
 * One project id folds into another, everywhere it is stored: `moments` and
 * `commitments` rows are re-pointed and the `projects` row for `from` is
 * deleted. Emitted by `projectTrack` when a real filesystem root is detected
 * for a name a synthetic `named:<project>` id was minted for earlier — the
 * split `attribution.ts`'s `findKnownByName` stops for NEW attributions but
 * could never repair in the rows already written. Idempotent: a replay
 * re-points nothing and deletes nothing.
 */
export interface MergeProjectEffect {
  type: 'MergeProject';
  from: string;
  into: string;
}

/**
 * J2.4's open half: fold one entity into another. `from` is a hashed attendee
 * (`person:person-<hash>`) whose live `knownAs` names `into` EXACTLY; the
 * executor re-points `entity_facts` and the entity's embeddings, records
 * `alias` (the hash's canonical name) in the survivor's `aliases_json` so the
 * upsert path never recreates the hash, and drops the `from` row. Never from a
 * judge's answer: exact matches only (docs/jarvis/05, two keys).
 */
/**
 * J5.3 — plan the week for an ACTIVE goal: the executor asks the tier-3 text
 * model for at most five steps, each marked internal or outward, and ingests
 * `goal:planned`. At-least-once: a repeat plan replaces the week's plan.
 */
export interface RunGoalPlanEffect {
  type: 'RunGoalPlan';
  goalId: string;
  goalName: string;
  /** Moments the fan-out credited to this goal lately — evidence for the planner, as ids. */
  progress: string[];
  ts: string;
}

/**
 * W2 — read the world model and plan what today's writer would refuse. The
 * executor does the DB read a pure rule cannot, runs the pure `planHygiene`, and
 * answers with one `world:hygiene` event carrying the plan; `applyWorldHygiene`
 * turns it into retractions and merges. No model is involved.
 */
export interface RunWorldHygieneEffect {
  type: 'RunWorldHygiene';
  ts: string;
}

export interface MergeEntityEffect {
  type: 'MergeEntity';
  from: string;
  into: string;
  alias: string;
  ts: string;
}

export interface RecordPredictionEffect {
  type: 'RecordPrediction';
  id: string;
  kind: string;
  forecaster: string;
  createdAt: string;
  resolvedAt: string;
  priorProb: number;
  /** The conditioning features the prior was formed from, so a later pass can re-fit without replaying the log. */
  features: Record<string, unknown> | null;
  outcome: 0 | 1;
  /** −ln(p assigned to the actual outcome), in nats — the same number folded into the surprise drive. */
  surprise: number;
  /**
   * The target's base rate over every resolution BEFORE this one — K0.3.
   *
   * The fair opponent. A skill figure against a constant fitted with hindsight
   * to the same bets it scores is an oracle, and the Calibration card had to
   * say so on its face; this is the running mean a forecaster could actually
   * have bet. Read off the calibration entry the rule is about to bump, so it
   * costs no new state and cannot disagree with the tally beside it.
   *
   * `null` on the first resolution of a target, which has no past to average,
   * and on every row written before this column. A reader must treat that as
   * "no opponent" rather than as zero.
   */
  baseProb: number | null;
}

/**
 * One gate verdict, on its way to the durable `gate_decisions` table
 * (`almanac/architecture/rules/noticing-and-expectations.md`).
 *
 * The gate computes channel, weight, utility and the five-term arithmetic for
 * every candidate and — before this effect existed — returned them in memory
 * only, throwing the "Unsaid" room's entire content away microseconds later.
 * The rule stays pure: `noticeGate` folds the decision into state exactly as
 * before AND returns this; the executor is the only writer.
 *
 * `id` is derived from the triggering event, so a boot replay offers the same
 * row (`onConflictDoNothing`) rather than a second one.
 */
export interface RecordGateDecisionEffect {
  type: 'RecordGateDecision';
  id: string;
  /** The candidate's habituation key — the join back to the `notice`/`candidate` signal rows. */
  noticeKey: string;
  kind: string;
  /** 'tonic' | 'phasic' | 'suppressed' | 'deferred' (the rules package owns the union). */
  channel: string;
  /** 'admitted' | 'below-threshold' | 'habituated' | 'budget-spent' | 'too-costly-now' | 'owner-silent'. */
  reason: string;
  weight: number;
  utility: number;
  /** The five factors of `weight`/`utility`: surprise × precision × habituation × concern − cost. */
  surprise: number;
  precision: number;
  habituation: number;
  concern: number;
  interruptionCost: number;
  /**
   * The two bars this row was actually weighed against — K0.2.
   *
   * `noticeGate` scales BOTH thresholds by `2 ** noticeBias` before it weighs
   * anything, so the policy's shipped 0.55/1.6 are not the bars any given row
   * met: on a machine with the dial at −1 they are 0.275 and 0.8. Without them
   * stored, a decision cannot be placed against its own line ever again — the
   * Unsaid card drew today's bar across the whole record and 40 of its 171 rows
   * fell on the wrong side of it, countable and unresolvable.
   *
   * Written by the RULE rather than recomputed at read time, for the same
   * reason the five factors are: the bar is part of the decision, and a second
   * derivation of it on a surface is a second policy that agrees on the day it
   * is written. Rows written before this landed carry `null`, and every reader
   * must treat that as "not known" rather than as today's value.
   */
  tonicBar: number;
  phasicBar: number;
  /** When the gate ruled — the arrival event's ts, or the re-scoring tick's. */
  decidedAt: string;
}

/**
 * Backtest one research-goal hypothesis against the forecaster's own recorded
 * samples — the closed half of propose-and-verify.
 *
 * The executor reads the durable `predictions` rows for this cell (the exact
 * samples the live `hourlyDoneRate` counts came from, so the trial validates
 * precisely what the forecaster would then bet on), splits their outcomes on
 * the ONE proposed conditioner, and appends a `goal:trial-result` signal with
 * the arms, the information gain, and the MDL verdict. No model is consulted:
 * the proposal was the model's whole contribution, and only the pre-registered
 * variable is tested — testing the menu and keeping the best would be
 * multiple-comparisons fishing at n≈13.
 */
export interface RunGoalTrialEffect {
  type: 'RunGoalTrial';
  goalId: string;
  /** Prediction rows to read, e.g. kind 'day-ending' forecaster 'hourly-rate'. */
  predictionKind: string;
  forecaster: string;
  /** The cell under question, as the forecaster keys it (an hour, for day-ending). */
  cell: string;
  /** The pre-registered conditioner id (see `conditioners.ts`). */
  variable: string;
}

export type Effect =
  | { type: 'WriteDB'; table: 'moments'; row: MomentRow }
  | { type: 'WriteDB'; table: 'projects'; row: ProjectRow }
  | { type: 'WriteDB'; table: 'organizations'; row: OrganizationRow }
  | { type: 'WriteDB'; table: 'knowledge_entries'; row: KnowledgeEntryRow }
  | { type: 'WriteDB'; table: 'ask_threads'; row: AskThreadRow }
  | { type: 'WriteDB'; table: 'commitments'; row: CommitmentRow }
  | { type: 'WriteDB'; table: 'owner_asks'; row: OwnerAskRow }
  | { type: 'EmitEvent'; event: Event }
  | ScheduleLLMEffect
  | JudgeEffect
  | AttachTranscriptEffect
  | RecordGateFeaturesEffect
  | UpdateMomentDataEffect
  | UpdateOwnerAskEffect
  | RunAskHarvestBackfillEffect
  | NotifyEffect
  | DeleteRowsEffect
  | UpsertEntityFactEffect
  | SupersedeFactEffect
  | RetractFactEffect
  | RetractKnowledgeEntryEffect
  | EmbedEffect
  | RunFactExtractionEffect
  | ResolveAliasesEffect
  | RunConversationExtractionEffect
  | RunMeetingPromisesEffect
  | RunRefutationEffect
  | RunBeliefAuditEffect
  | RunAliasAlignmentEffect
  | RunReflectionEffect
  | RunGoalTrialEffect
  | RunJournalEffect
  | DecayScoresEffect
  | ReinforceFactEffect
  | DecayFactConfidenceEffect
  | RecordPredictionEffect
  | RecordGateDecisionEffect
  | MergeProjectEffect
  | MergeEntityEffect
  | RunWorldHygieneEffect
  | RunGoalPlanEffect;

export type Rule = (state: KernelState, event: SanitizedEvent) => { state: KernelState; effects: Effect[] };

/**
 * `ruleName` is `Rule`'s own JS function name (`const momentClose: Rule = (state, event) => ...`
 * gets `.name === 'momentClose'` for free from ES2015 name inference on a const-bound function
 * expression) — attributed once here in `reduce()`, not by changing any individual rule's own
 * `{state, effects}` return shape. The Triggers tab's data source (docs/design/06-macos-ui-data-wiring.md).
 */
export interface AttributedEffect {
  ruleName: string;
  effect: Effect;
}

export interface ReduceResult {
  state: KernelState;
  effects: AttributedEffect[];
}
