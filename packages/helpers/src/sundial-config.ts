import { hostTimeZone } from './local-day.js';
import { type LlmProvider, parseProviders, parseUse } from './llm-providers.js';
import fs from 'node:fs';
import path from 'node:path';
import { getSundialConfigPath, getSundialHome } from './config.js';

const MIN_POLL_INTERVAL_MS = 200;
const VALID_TIERS = new Set([1, 2, 3]);

/**
 * `~/.sundial/config.json`'s on-disk shape — every field optional, since a
 * missing file (the common case — nobody has written one) and a
 * partially-filled file are both completely valid. Kept a plain interface,
 * not a class/Zod schema — same "deliberately small, grow only when a real
 * need shows up" posture as `packages/helpers/src/config.ts`'s own comment.
 *
 * `sensitiveApps`/`hiddenApps`/`shellRedactPatterns` are deliberately
 * **additive** — appended to the built-in defaults, never a replacement —
 * so a config file can only ever add redaction coverage, not accidentally
 * remove it (e.g. an empty array here does not disable the built-in
 * password/token/bearer shell patterns or the default sensitive-app list).
 */
/**
 * P1 (docs/design/07) — a user-authored project-attribution rule. Matched by
 * `resolveAttribution` (in `@sundial/rules`) against a `window:changed`'s
 * already-available fields; a match routes the window to `project`. Kept a
 * plain structural interface here (no `LocatorSource`/`AttributionConfidence`
 * import) since `@sundial/helpers` sits below `@sundial/kernel` — `@sundial/kernel`
 * declares a structurally-identical `ProjectRule` it consumes.
 *
 * `*Contains` fields are case-insensitive substring tests: `titleContains`/
 * `urlContains` both match the window title (Gnomon has no separate URL field —
 * a browser URL rides in the title), `pathContains` matches `documentPath`,
 * `gitBranch` matches the current branch. `processIs` optionally restricts a
 * rule to one `processName`. All present fields must match (AND).
 */
export interface ProjectRule {
  titleContains?: string;
  /**
   * Matches the title of the calendar event in progress, and ONLY while the
   * focused window is a call (Meet, Teams, Zoom, the native apps). This is how
   * call time becomes project time: the window title of a Meet tab is a
   * meeting code, so nothing else in it can say which project the hour was.
   * Deliberately inert outside a call window — a meeting running while the
   * owner writes code must not claim the code.
   */
  meetingContains?: string;
  urlContains?: string;
  pathContains?: string;
  gitBranch?: string;
  processIs?: string;
  project: string;
  confidence?: 'certain' | 'weak';
}

/**
 * The owner-curated work/leisure taxonomy, read by `classifyActivity`.
 *
 * Structurally duplicated in `@sundial/kernel`'s `types.ts` for the same reason
 * `ProjectRule` is — `@sundial/helpers` sits below `@sundial/kernel`.
 *
 * ## Why the browser profile leads
 *
 * Measured on the 23-day reference corpus: `youtube.com` was the fourth busiest
 * domain at 213 visits, and **202 of them sat in one Chrome profile**. No domain
 * list can resolve that, because the same domain is a conference talk in one
 * profile and an evening's television in another. Reading the profile first, with
 * domains only as an override, settles the largest ambiguity in the data from a
 * signal already present in every window title.
 *
 * The override direction matters and is not symmetric: the leisure profile in that
 * corpus still contained `claude.ai` and `localhost:3000`, so a profile is a strong
 * prior, never a verdict.
 *
 * ## Why `unknown` is never leisure
 *
 * A false "you had downtime" is much worse than a false "you didn't", because it
 * silently CANCELS a true "no downtime in eight days" and leaves no trace that it
 * did. Anything unclassified therefore counts as neither side.
 */
export interface LeisureRules {
  /** Browser-profile name (as it appears in the window title) -> class. */
  browserProfiles: Record<string, ActivityClass>;
  /** Host globs that override whatever the profile said. `*` matches any run of characters. */
  domainOverrides: Partial<Record<ActivityClass, string[]>>;
  /** Process-name overrides, checked before the browser path. */
  processes: Partial<Record<ActivityClass, string[]>>;
  /** Hosts that are machine traffic, not the owner — never classified, never counted. */
  excluded: string[];
}

/**
 * `ambient` is the class most taxonomies lack and this one needs: music playing
 * while you code is not downtime, and counting it as leisure would mean the owner
 * effectively never lacks rest, which silently disables the detector that exists to
 * notice exactly that.
 *
 * `personal-work` separates the owner's own projects from their employer's. It
 * counts as work for rest detection — you were still working — while staying
 * distinguishable for attribution.
 */
export type ActivityClass = 'work' | 'personal-work' | 'personal' | 'ambient' | 'unknown';

export interface SundialConfigFile {
  privacy?: {
    redactionTier?: 1 | 2 | 3;
    sensitiveApps?: string[];
    hiddenApps?: string[];
    shellRedactPatterns?: string[];
    // lane E (#11)
    /** `false` keeps the Claude Code SessionStart context hook silent. Read by `packages/sensors/claude-context.mjs` itself, never by the daemon. Default on: the owner approved it on 2026-09-29. */
    claudeContext?: boolean;
    /** `true` reads Mail.app's senders, recipients and subjects. */
    mail?: boolean;
    /** `true` reads Messages (`chat.db`) senders and chats. Its own switch, off by default: the owner declined Messages on 2026-09-28, and it used to ride on `mail`. */
    messages?: boolean;
  };
  /** Per-purpose daily LLM call cap overrides, e.g. `{ "intent": 300 }` — merged over `@sundial/kernel`'s `DEFAULT_DAILY_CAPS`, not typed against `LlmPurpose` here since `@sundial/helpers` sits below `@sundial/kernel` in the dependency graph. */
  budgets?: Partial<Record<string, number>>;
  /** P1 (docs/design/07) — ordered project-attribution rules; first match wins. */
  projectRules?: ProjectRule[];
  /**
   * Hosts and apps that are WORK but belong to no single project — Slack, the
   * shared Obsidian vault, Google Meet, the org calendar. A host like
   * `meet.google.com` carries a different project every hour and an app like
   * Slack carries the whole organisation, so a project rule for either would be
   * a lie; without this they sit in "untracked time" for ever and are proposed
   * again every week. An entry is a host (`meet.google.com`) or an app
   * (`app:Slack`). The time is still counted — it is reported as shared work
   * rather than as time nothing could explain.
   */
  sharedPlaces?: string[];
  /** P1 — variant→canonical project-name map (e.g. `{ "WCS": "wcs", "PB-Games": "puzzlebox-studio" }`) so casing/alias splits collapse to one project. Applied on top of a lowercase-collapse. */
  projectAliases?: Record<string, string>;
  /**
   * Variant→canonical PERSON-name map (e.g. `{ "Alexm": "Alex Morgan", "Noah": "Thomas" }`),
   * mirroring `projectAliases`. Applied at resolve time on the people surface,
   * in explore, and in entity history — never written back into the record.
   *
   * A calendar hands out several names for one human: the display name they
   * were invited under, the address this machine hashed, and whatever
   * `identity-resolve` derived from that address. Rows whose RESOLVED names
   * already match are folded without anyone deciding anything; this map is for
   * the ones that do not, and those are genuinely ambiguous — "Jordan" is either
   * Jordan Holm or Jordan De Wit and no rule can tell which. So it
   * is the owner's decision, which is what makes it configuration.
   *
   * There is deliberately no `entity:merge` signal behind it. A merge that
   * rewrote facts would collide with "facts are never overwritten"; an alias
   * leaves every fact where it is and only changes what the person answers to.
   */
  personAliases?: Record<string, string>;
  /** Path-prefix→organization map (e.g. `{ "~/Projects/acme": "Acme", "~/Playground": "playground" }`) — the owner-curated org assignment. Longest-prefix wins; takes precedence over the noisy remote-owner slug the `project` sensor derives (which mis-labels forks/personal remotes). */
  orgByPath?: Record<string, string>;
  /**
   * IANA timezone the owner's DAYS are measured in (e.g. `Europe/Amsterdam`).
   * Defaults to the host's zone.
   *
   * Every timestamp is stored in UTC, which is right for an instant, but a day is
   * a human unit and Gnomon reports in days — today's summary, the daily journal,
   * per-day budgets, decay, retention. Those were derived with `ts.slice(0, 10)`,
   * making them UTC days: in Amsterdam the boundary sat at 02:00 local, so
   * midnight-to-2am work was filed under the previous day.
   *
   * It is CONFIGURATION rather than a `new Date()` lookup because rules must fold
   * deterministically — see `local-day.ts` for why reading the host's zone inside
   * a rule would make a replay disagree with the daemon that produced it.
   */
  timezone?: string;
  /**
   * Let the nightly skeptic run (`nightlyRefutation`) — on unless set to false.
   *
   * The only pass whose job is to make core memory SMALLER. Its dangerous
   * failure is a FALSE refutation: it removes something true while the system
   * looks like it is self-correcting, and the beliefs it takes are the
   * well-corroborated ones a person actually relies on. Measure the rate with
   * `node apps/daemon/dist/scripts/measure-skeptic.js` before turning this on —
   * the harness corrupts a share of real facts and reports what the model
   * caught and what it wrongly took.
   */
  refutationEnabled?: boolean;
  /**
   * Switches that stay OFF until a measurement earns them (docs/jarvis/04).
   * `ownerStateInGateCost` (J2.1): let the owner-state filter price an
   * interruption — only after two weeks of self-report taps and Brier ≤ 0.15.
   * (`learnedGate`, J5.1, had no reader and went in W6 P6: what it would have
   * learned, the gate calibrates from outcomes now — `calibrate`, W5.)
   * `forecasting`: the day-shape, fragmented-hour and project-touch forecasters,
   * their tournament, the uncertainty map and research goals.
   * `gateFeatures` (J1.6): the judge's gate features, logged beside each notice
   * decision. `presence`: the network presence scan and its rule (its consent
   * has no UI yet). All three are experimental and off for a new install;
   * `sundial migrate` turns them on for an install that already ran them.
   */
  experiments?: { ownerStateInGateCost?: boolean; forecasting?: boolean; gateFeatures?: boolean; presence?: boolean };
  /**
   * J3.5 — the Obsidian vault Gnomon may read as a sense (notes edited today →
   * subject candidates; paths only) and write as a sink (the day's journal page
   * under `<vault>/Gnomon/<date>.md`). Unset or null = off. The owner picks the
   * vault; nothing here chooses one.
   */
  vault?: string | null;
  /** More model providers beside Gnomon's own (the `.env` one), each a route in the chat's model picker. See `llm-providers.ts`. */
  llm?: {
    providers?: { id: string; label?: string; baseUrl: string; model: string }[];
    /** Which provider does what: `default` for every background purpose, or one purpose (`journal`, `intent`…) by name. A value is `openai` (the `.env` model) or a provider id. Unset: the `.env` model. */
    use?: Record<string, string>;
  };
  /** See `LeisureRules`. Merged over the built-in process defaults, never replacing them. */
  leisureRules?: {
    browserProfiles?: Record<string, string>;
    domainOverrides?: Record<string, string[]>;
    processes?: Record<string, string[]>;
    excluded?: string[];
  };
  /** Phase 5 #6 — network-fingerprint→location-bucket map (e.g. `{ "<fingerprint>": "office" }`), set by hand in config.json (the retired CLI's `gnomon location label` used to write it). Lets moments carry a home/office/… bucket without any macOS Location permission (the fingerprint is a gateway/BSSID hash, available unredacted). */
  /** Phase 5 #6 — network-fingerprint→location-bucket map (e.g. `{ "<fingerprint>": "office" }`), set by hand in config.json (the retired CLI's `gnomon location label` used to write it). Lets moments carry a home/office/… bucket without any macOS Location permission — not because the fingerprint's inputs are unredacted (BSSID and NetworkID *are* redacted without Location Services), but because the parts that survive and stay stable (networkId, sname, gateway, interface, security mode) already distinguish networks well enough to label. */
  locationLabels?: Record<string, string>;
  /**
   * Every name the owner
   * appears under in their own calendar's attendee lists (display name, short
   * username, the email-alias hash `sanitizeAtIngest` produces). `entityExtract`
   * drops these so the owner is not recorded as having attended a meeting with
   * themselves, which is what the live data showed. Matched
   * case-insensitively; there is no way to derive this list automatically,
   * because an attendee string is just whatever the calendar server sent.
   */
  ownerAliases?: string[];
  /** P7 (docs/design/07) — screen OCR. `enabled` defaults OFF in code (privacy baseline); the owner's config turns it on. Intervals/region tune the sidecar's capture cadence. */
  ocr?: {
    /** Days to keep raw `screen:ocr` signals; default 14, always shorter than `retentionDays` in practice. */
    retentionDays?: number;
    enabled?: boolean;
    fullIntervalMs?: number;
    cursorIntervalMs?: number;
    cursorRegionPx?: number;
  };
  /**
   * Ambient hearing. `enabled` defaults OFF in code, the same privacy baseline
   * as `ocr`; the owner's config turns it on, and the launcher gates SPAWNING
   * the audio sidecar on it so a disabled Gnomon never opens the microphone at
   * all. Audio is never written to disk — only the transcript.
   */
  audio?: {
    enabled?: boolean;
    /**
     * Whether a meeting with attendees, or a call, opens the microphone BY
     * ITSELF. Default false: hearing opens only when the owner presses Listen.
     * The others in the room are not told, and recording them by default is
     * the owner's call to make, per meeting, not the software's.
     */
    autoMeetings?: boolean;
    /**
     * Days to keep raw `audio:transcript` signals. Short for the same reason
     * OCR's is: a transcript is high-volume free text, and the moment rollups
     * keep what it contributed.
     */
    retentionDays?: number;
    /** Quiet that ends an utterance. */
    silenceFlushMs?: number;
    /** Hard ceiling on one utterance, so a long meeting still lands in pieces. */
    maxUtteranceMs?: number;
    /** Where the local transcriber answers. Loopback only. */
    whisperUrl?: string;
    /** The multilingual whisper model. Both English and Dutch need this one; Apple's on-device engines cannot do Dutch. */
    modelPath?: string;
    /** Silero VAD weights. Absent, whisper returns one block per utterance instead of per sentence. */
    vadModelPath?: string;
    /**
     * The languages spoken near this machine, as whisper names them
     * (`"english"`, `"dutch"`). An utterance whisper labels as any OTHER
     * language is dropped at ingest: handed noise, whisper invents speech with
     * full confidence, and on the live record ~800 utterances came back in
     * Spanish, Portuguese, Russian and two dozen more. Empty keeps everything;
     * an utterance with no language is always kept.
     */
    languages?: string[];
  };
  /**
   * Native macOS notification for PHASIC notices. Off by default: a banner is
   * the one delivery act that reaches the owner outside a chat window they
   * chose to open, so enabling it is a deliberate consent, not a default.
   * Tonic notices never post — they are ambient context by definition.
   */
  notifications?: {
    enabled?: boolean;
    /**
     * Where a push goes when Gnomon speaks first or shelves something: a full
     * ntfy URL, e.g. `https://ntfy.sh/<topic>`. Off when unset. What is sent is
     * the notice's already-sanitized text, nothing else; a public ntfy.sh topic
     * is as private as its name, so pick a long one or self-host.
     */
    ntfy?: string;
    /**
     * Where the PHONE reaches the :8767 listener — the Tailscale Serve URL,
     * e.g. `https://<mac>.<tailnet>.ts.net:8767`. With it set, every push
     * carries three ntfy actions (Useful / Not now / Wrong) that post a signed
     * `feedback:verdict` back. Unset, a push is one-way.
     */
    verdictUrl?: string;
    /** Push to the phone while you are at the Mac too (default true). `false`: the banner only, the phone when you are away. */
    pushAtMac?: boolean;
  };
  /**
   * Who does the workbench's jobs. With `claude: true` a job runs on the local
   * Claude Code CLI (`claude -p`, the owner's own login) with Sundial's
   * read-only MCP server mounted, web search and fetch, and nothing else — no
   * shell, no edits. Off by default: the job prompt and whatever Claude reads
   * from the record go to Anthropic. `claudePath` when `claude` is not on the
   * login shell's PATH; `maxBudgetUsd` caps one job (default 1).
   */
  hands?: { claude?: boolean; claudePath?: string; maxBudgetUsd?: number };
  // lane E (#12)
  /**
   * The night shift: Gnomon starts a supervised Claude Code job (an
   * interactive `claude` in a detached tmux session) in a git worktree it makes
   * under `$SUNDIAL_HOME/night-shift/`, never in the project's own checkout,
   * while the owner is away. It watches the job through the agent fleet, and
   * the result (a branch with commits, nothing pushed) goes on the shelf.
   *
   * **`enabled` is false by default and stays false until the owner says yes**
   * (asked 2026-09-29, not yet given): off, no job is queued or started,
   * whatever asks for one, and the request tool is not even registered.
   *
   * No permission is ever approved for a job: it runs in Claude's `manual`
   * mode with the project's settings only (not the owner's allow rules), and
   * `git push` is refused. A job that needs a permission waits, and the fleet's
   * own `agent-permission` notice says so through the gate.
   *
   * Caps: `maxMinutes` a job (default 90) and `maxJobsPerNight` (default 2)
   * always hold. `maxUsdPerJob` (default 2) stops a job once Claude's own cost
   * record shows it — Claude writes that record only at a session's end or
   * resume, so during a run the time cap is the bound. `maxUsdPerNight`
   * (default 5) refuses the next job once the finished ones reach it.
   */
  jobs?: { enabled?: boolean; maxUsdPerJob?: number; maxUsdPerNight?: number; maxJobsPerNight?: number; maxMinutes?: number };
  retentionDays?: number;
  decayFactor?: number;
  pollIntervalMs?: number;
  clipboardEnabled?: boolean;
  /**
   * An OPTIONAL, TIGHTEN-ONLY override on what the assistant is allowed to DO.
   *
   * NOT the primary control anymore. The single source of truth is dsh's
   * permission preset (the "Permissions" chip: read-only / workspace-write /
   * danger-full-access), which drives dsh's built-ins natively AND — via
   * plugins/sundial-actions/gate.js — gnomon's own tools. This `actions` block
   * is a secondary knob layered on top: it can only make a gnomon tool's
   * preset-derived verdict STRICTER (off < ask < auto), never looser, and it
   * governs ONLY gnomon's own tools (gnomon_claim/assert/propose/
   * record_outcome and gnomon_run_shell) — never dsh's built-ins.
   *
   * The no-actuation constraint (D11) was lifted by owner decision on
   * 2026-07-27; this block used to be the socket's whole control surface but
   * was demoted when gnomon adopted dsh's permission language (see
   * plugins/sundial-actions/README.md).
   *
   * Each capability resolves to one of three policies:
   *   - `'off'`  — the tool is not registered AND denied at the gate; a hard
   *                opt-out that always tightens.
   *   - `'ask'`  — caps the preset at "runs only through dsh's approval gate";
   *                a preset that would auto-allow is forced to prompt.
   *   - `'auto'` — the neutral value: it never loosens, so the preset decides.
   *
   * `internal`/`outward` take either a single policy (applied to every tool in
   * that class) or a per-tool map. Defaults: internal writes `auto` (neutral —
   * the preset decides), everything outward `off`.
   *
   * `filesystemAllow` is retained for compatibility (and pinned by
   * config.test.ts) but the gate no longer enforces it: dsh's own sandbox mode,
   * bundled into the preset, now bounds filesystem writes for dsh's built-ins,
   * and gnomon's own tools take no path argument.
   */
  actions?: {
    internal?: ActionPolicy | Record<string, ActionPolicy>;
    outward?: ActionPolicy | Record<string, ActionPolicy>;
    filesystemAllow?: string[];
  };
  /**
   * The owner's OWN services, reached over MCP — Obsidian, Notion, Slack, and
   * whatever else speaks the protocol. Each entry mounts one MCP client inside
   * the harness (plugins/sundial-actions/integrations.js) and its tools appear to
   * the model as `mcp__<name>__<tool>`.
   *
   * Declared HERE rather than in the dsh profile because reach is Gnomon's
   * concern and sits behind Gnomon's gate: every integration tool is treated as
   * an outward WRITE (asks under workspace-write, denied under read-only) unless
   * its name matches one of the entry's `reads`, which are allowed at every
   * preset the way any read is. A tool that only searches or fetches belongs in
   * `reads`; one that creates, edits, sends or deletes does not.
   *
   * Secrets never go in this file. `env` and `headers` values of the form
   * `$NAME` or `${NAME}` are expanded from the process environment and from
   * `~/.sundial/.env` at mount time; an integration whose secret is missing is
   * skipped with a log line rather than started with an empty credential.
   */
  integrations?: IntegrationConfig[];
}

/** One MCP server the assistant may reach. See `SundialConfigFile.integrations`. */
export interface IntegrationConfig {
  /** Namespace for the tool names: `mcp__<name>__…`. `[A-Za-z0-9_-]{1,32}`. */
  name: string;
  /** Off without deleting the entry. Default true. */
  enabled?: boolean;
  transport: 'stdio' | 'streamable-http';
  /** stdio: the executable and its arguments. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** streamable-http: the endpoint and any headers (a bearer token, typically). */
  url?: string;
  headers?: Record<string, string>;
  /** Tool names (the raw server-side name, or a `prefix*` glob) that are READS and never need approval. */
  reads?: string[];
  /** Per-call timeout. Default 30 000. */
  toolCallTimeoutMs?: number;
}

/** How supervised one assistant action is. See `SundialConfigFile.actions`. */
export type ActionPolicy = 'off' | 'ask' | 'auto';

/** Resolved action policy: a class default plus per-tool overrides. */
export interface ActionClassConfig {
  default: ActionPolicy;
  byTool: Record<string, ActionPolicy>;
}

export interface ActionsConfig {
  internal: ActionClassConfig;
  outward: ActionClassConfig;
  /** Absolute or `~`-prefixed path prefixes the companion may write under. Empty = no filesystem writes. */
  filesystemAllow: string[];
}

export interface ResolvedSundialConfig {
  privacy: {
    redactionTier: 1 | 2 | 3;
    extraSensitiveApps: string[];
    extraHiddenApps: string[];
    extraShellRedactPatterns: string[];
    /** J3.6 — the Mail.app reader (senders, recipients and subjects, behind Full Disk Access). Off by default; `"mail": true` turns it on. */
    mail: boolean;
    /** The Messages reader (`chat.db` senders and chats, never text). Off by default and separate from `mail`: the owner declined Messages on 2026-09-28. */
    messages: boolean;
  };
  /** J3.4 — the browser helper also reads the page's text (`page:text`), when the browser allows JavaScript from Apple Events. */
  browser: { pageText: boolean };
  budgets: Partial<Record<string, number>>;
  projectRules: ProjectRule[];
  /** Hosts (`meet.google.com`) and apps (`app:Slack`) that are work but not one project. See the file field. */
  sharedPlaces: string[];
  projectAliases: Record<string, string>;
  /** See `SundialConfigFile.personAliases`. Variant→canonical person names, applied at resolve time. */
  personAliases: Record<string, string>;
  orgByPath: Record<string, string>;
  locationLabels: Record<string, string>;
  timezone: string;
  refutationEnabled: boolean;
  /** See `SundialConfigFile.experiments`; all default false. */
  experiments: { ownerStateInGateCost: boolean; forecasting: boolean; gateFeatures: boolean; presence: boolean };
  /** See `SundialConfigFile.vault`; null = off. */
  vault: string | null;
  /** See `SundialConfigFile.llm`; entries that fail the shape check are dropped. */
  llm: { providers: LlmProvider[]; use: Record<string, string> };
  ownerAliases: string[];
  leisureRules: LeisureRules;
  ocr: OcrConfig;
  audio: AudioConfig;
  notifications: NotificationsConfig;
  /** See `SundialConfigFile.hands`. Off by default. */
  hands: { claude: boolean; claudePath: string | null; maxBudgetUsd: number };
  // lane E (#12)
  /** See `SundialConfigFile.jobs`. `enabled` is false unless the file says `true`. */
  jobs: { enabled: boolean; maxUsdPerJob: number; maxUsdPerNight: number; maxJobsPerNight: number; maxMinutes: number };
  retentionDays: number;
  decayFactor: number;
  pollIntervalMs: number;
  clipboardEnabled: boolean;
  /** See `SundialConfigFile.actions`. Internal writes default `auto`, outward `off`, filesystem empty. */
  actions: ActionsConfig;
  /** See `SundialConfigFile.integrations`. Validated; malformed entries are dropped with their reason logged. Empty by default. */
  integrations: ResolvedIntegration[];
}

/** A validated integration, every optional filled. */
export interface ResolvedIntegration {
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'streamable-http';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  url: string;
  headers: Record<string, string>;
  reads: string[];
  toolCallTimeoutMs: number;
}

const INTEGRATION_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_INTEGRATION_TIMEOUT_MS = 30_000;

const stringMap = (value: unknown): Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'string') as [string, string][])
    : {};
const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : []);

/**
 * Validate the integrations block. A bad entry is DROPPED and named on stderr,
 * never repaired into something the owner did not write: a guessed command is a
 * process this machine did not ask to run.
 */
export function resolveIntegrations(raw: unknown, warn: (message: string) => void = (m) => console.warn(m)): ResolvedIntegration[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn('[sundial-config] integrations must be an array; ignoring it');
    return [];
  }
  const out: ResolvedIntegration[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : '';
    const label = name || `#${index}`;
    if (!INTEGRATION_NAME.test(name)) return warn(`[sundial-config] integration ${label}: name must match [A-Za-z0-9_-]{1,32}; dropped`);
    if (seen.has(name)) return warn(`[sundial-config] integration ${label}: duplicate name; dropped`);
    const transport = e.transport;
    if (transport !== 'stdio' && transport !== 'streamable-http') return warn(`[sundial-config] integration ${label}: transport must be "stdio" or "streamable-http"; dropped`);
    const command = typeof e.command === 'string' ? e.command : '';
    const url = typeof e.url === 'string' ? e.url : '';
    if (transport === 'stdio' && command === '') return warn(`[sundial-config] integration ${label}: stdio needs a command; dropped`);
    if (transport === 'streamable-http' && !/^https?:\/\//.test(url)) return warn(`[sundial-config] integration ${label}: streamable-http needs an http(s) url; dropped`);
    const timeout = typeof e.toolCallTimeoutMs === 'number' && e.toolCallTimeoutMs >= 1000 ? Math.round(e.toolCallTimeoutMs) : DEFAULT_INTEGRATION_TIMEOUT_MS;
    seen.add(name);
    out.push({
      name,
      enabled: e.enabled !== false,
      transport,
      command,
      args: stringList(e.args),
      env: stringMap(e.env),
      cwd: typeof e.cwd === 'string' && e.cwd !== '' ? e.cwd : null,
      url,
      headers: stringMap(e.headers),
      reads: stringList(e.reads),
      toolCallTimeoutMs: timeout,
    });
  });
  return out;
}

/**
 * Whether a raw MCP tool name is one of an integration's declared reads.
 * Exact match, or a trailing `*` glob — `search*` covers `search_notes` and
 * `search_vault`, and nothing else.
 */
export function isIntegrationRead(integration: ResolvedIntegration, rawToolName: string): boolean {
  return integration.reads.some((pattern) => (pattern.endsWith('*') ? rawToolName.startsWith(pattern.slice(0, -1)) : rawToolName === pattern));
}

/** P7 — resolved screen-OCR capture settings. `enabled` off by default (code baseline); intervals in ms, region a square edge in px around the cursor. */
export interface OcrConfig {
  enabled: boolean;
  fullIntervalMs: number;
  cursorIntervalMs: number;
  cursorRegionPx: number;
  /**
   * J3.3 — screen understanding. When on, the OCR helper also writes a
   * downscaled frame (`~/.sundial/.daemon/screen-frame.jpg`, ≤ 768 px) and a
   * LOCAL vision model in Ollama turns it into at most three short facts
   * (`screen:fact`), sanitized at ingest. No pixel and no raw text leaves the
   * machine. Off by default; the helper rebuild it needs re-prompts Screen
   * Recording (cdhash).
   */
  vision: { enabled: boolean; model: string; intervalMs: number };
  /**
   * How many days `screen:ocr` signals are kept — SHORTER than `retentionDays`
   * on purpose. Screen text is the highest-volume, highest-sensitivity thing in
   * the log (measured ~13 MB an eight-hour day, and it can contain anything on
   * the display); the moment rollups keep the topics and excerpts it produced.
   * See almanac/concepts/sanitize-at-ingest.
   */
  retentionDays: number;
}

const DEFAULT_OCR_CONFIG: OcrConfig = { enabled: false, fullIntervalMs: 5000, cursorIntervalMs: 1500, cursorRegionPx: 480, retentionDays: 14, vision: { enabled: false, model: 'gemma4:e4b-mlx', intervalMs: 60_000 } };

/** See `SundialConfigFile.audio`. Off by default, like OCR. */
export interface AudioConfig {
  enabled: boolean;
  /** See `SundialConfigFile.audio.autoMeetings`. */
  autoMeetings: boolean;
  /** See `SundialConfigFile.audio.languages`. Lower-cased; empty keeps every language. */
  languages: string[];
  retentionDays: number;
  silenceFlushMs: number;
  maxUtteranceMs: number;
  whisperUrl: string;
  modelPath: string;
  vadModelPath: string;
  /**
   * J3.2 fallback — whisper.cpp tinydiarize. When set to a `*-tdrz.bin` model
   * the helper runs whisper-server on THAT model with `-tdrz`, which marks
   * speaker turns in the text (`[_SPEAKER_TURN_]`) — English only, so Dutch
   * is lost while it is on. Null (default) keeps the multilingual model. The
   * proper path (pyannote) is the owner's gated download (docs/jarvis/04).
   */
  diarizeModelPath: string | null;
}

const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  enabled: false,
  autoMeetings: false,
  languages: [],
  retentionDays: 14,
  silenceFlushMs: 900,
  maxUtteranceMs: 25_000,
  // 8771, not 8765: that port belongs to another app on the owner's machine.
  whisperUrl: 'http://127.0.0.1:8771/inference',
  modelPath: path.join(getSundialHome(), 'models', 'ggml-large-v3-turbo-q5_0.bin'),
  vadModelPath: path.join(getSundialHome(), 'models', 'ggml-silero-v5.1.2.bin'),
  diarizeModelPath: null,
};

/** See `SundialConfigFile.notifications`. Off by default. */
export interface NotificationsConfig {
  enabled: boolean;
  /** See `SundialConfigFile.notifications.ntfy`. Empty string when unset. */
  ntfy: string;
  /** See `SundialConfigFile.notifications.verdictUrl`. Empty string when unset. */
  verdictUrl: string;
  /** See `SundialConfigFile.notifications.pushAtMac`. */
  pushAtMac: boolean;
}

const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = { enabled: false, ntfy: '', verdictUrl: '', pushAtMac: true };
const MIN_OCR_INTERVAL_MS = 500;

/**
 * Deliberately almost empty, and that is the design rather than a stub.
 *
 * The general rules belong in CODE — `classifyActivity` falls back to
 * `isCodeEditor`/`isTerminal`/`isConferencingApp` for work and `isMusicApp` for
 * ambient, which hold for anyone. Which Chrome profile is the owner's employer,
 * which domains are their clients, and which hosts are their company's security
 * agent are facts about one person's world and belong in their config file.
 *
 * The processes listed are the few unambiguous anywhere. `Music` and `Spotify` are
 * pointedly NOT here: `isMusicApp` classifies them `ambient`, because an album
 * playing during a coding session is not downtime.
 */
const DEFAULT_LEISURE_RULES: LeisureRules = {
  browserProfiles: {},
  domainOverrides: {},
  processes: { personal: ['TV', 'Podcasts', 'Books', 'Photos', 'Photo Booth', 'Steam', 'Kindle'] },
  excluded: [],
};

const ACTIVITY_CLASSES = new Set<ActivityClass>(['work', 'personal-work', 'personal', 'ambient', 'unknown']);

const isActivityClass = (value: unknown): value is ActivityClass => typeof value === 'string' && ACTIVITY_CLASSES.has(value as ActivityClass);

/**
 * Config `processes`/`domainOverrides` are merged over the built-in lists rather
 * than replacing them, the same additive posture `sensitiveApps` takes: a config
 * file should only ever be able to add classification, not silently drop the
 * defaults by declaring an empty array.
 */
function resolveLeisureRules(value: unknown): LeisureRules {
  if (!isPlainObject(value)) return { ...DEFAULT_LEISURE_RULES };

  const browserProfiles: Record<string, ActivityClass> = {};
  if (isPlainObject(value.browserProfiles)) {
    for (const [profile, klass] of Object.entries(value.browserProfiles)) {
      if (profile.trim() && isActivityClass(klass)) browserProfiles[profile.trim()] = klass;
    }
  }

  const mergeByClass = (raw: unknown, base: Partial<Record<ActivityClass, string[]>>): Partial<Record<ActivityClass, string[]>> => {
    const out: Partial<Record<ActivityClass, string[]>> = {};
    for (const [klass, list] of Object.entries(base)) out[klass as ActivityClass] = [...(list ?? [])];
    if (isPlainObject(raw)) {
      for (const [klass, list] of Object.entries(raw)) {
        if (!isActivityClass(klass) || !Array.isArray(list)) continue;
        const clean = list.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
        out[klass] = [...(out[klass] ?? []), ...clean];
      }
    }
    return out;
  };

  return {
    browserProfiles,
    domainOverrides: mergeByClass(value.domainOverrides, DEFAULT_LEISURE_RULES.domainOverrides),
    processes: mergeByClass(value.processes, DEFAULT_LEISURE_RULES.processes),
    excluded: [...DEFAULT_LEISURE_RULES.excluded, ...stringArrayOrEmpty(value.excluded, 'leisureRules.excluded')],
  };
}

export const DEFAULT_SUNDIAL_CONFIG: ResolvedSundialConfig = {
  privacy: { redactionTier: 2, extraSensitiveApps: [], extraHiddenApps: [], extraShellRedactPatterns: [], mail: false, messages: false },
  browser: { pageText: false },
  budgets: {},
  projectRules: [],
  sharedPlaces: [],
  projectAliases: {},
  personAliases: {},
  orgByPath: {},
  locationLabels: {},
  timezone: hostTimeZone(),
  // On by default since 2026-09-07. It was off pending a measured false-
  // refutation rate; meanwhile the owner marked twelve facts wrong by hand that
  // a running skeptic is built to catch. `refutationEnabled: false` in
  // ~/.sundial/config.json turns it back off.
  refutationEnabled: true,
  experiments: { ownerStateInGateCost: false, forecasting: false, gateFeatures: false, presence: false },
  vault: null,
  llm: { providers: [], use: {} },
  ownerAliases: [],
  leisureRules: { ...DEFAULT_LEISURE_RULES },
  ocr: { ...DEFAULT_OCR_CONFIG },
  audio: { ...DEFAULT_AUDIO_CONFIG },
  notifications: { ...DEFAULT_NOTIFICATIONS_CONFIG },
  hands: { claude: false, claudePath: null, maxBudgetUsd: 1 },
  // lane E (#12)
  jobs: { enabled: false, maxUsdPerJob: 2, maxUsdPerNight: 5, maxJobsPerNight: 2, maxMinutes: 90 },
  retentionDays: 180,
  decayFactor: 0.95,
  pollIntervalMs: 1000,
  clipboardEnabled: false,
  actions: {
    // Internal writes only touch Gnomon's own store and each leave an
    // overturnable proposal, so they run unprompted. Anything outward is off
    // until the owner names it. The companion writes no files until a path is
    // allowlisted.
    internal: { default: 'auto', byTool: {} },
    outward: { default: 'off', byTool: {} },
    filesystemAllow: [],
  },
  integrations: [],
};

const ACTION_POLICIES = new Set<ActionPolicy>(['off', 'ask', 'auto']);
const isActionPolicy = (value: unknown): value is ActionPolicy => typeof value === 'string' && ACTION_POLICIES.has(value as ActionPolicy);

/**
 * Resolve one action class (`internal`/`outward`) from either a bare policy —
 * applied to every tool in the class — or a per-tool map, over the given
 * default. An `all` key in the map sets the class default; any other key
 * overrides one tool. Unknown policy values are dropped, never coerced, so a
 * typo cannot silently promote a tool to `auto`.
 */
function resolveActionClass(raw: unknown, fallbackDefault: ActionPolicy): ActionClassConfig {
  if (isActionPolicy(raw)) return { default: raw, byTool: {} };
  if (!isPlainObject(raw)) return { default: fallbackDefault, byTool: {} };

  let def = fallbackDefault;
  const byTool: Record<string, ActionPolicy> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isActionPolicy(value)) continue;
    if (key === 'all' || key === 'default') def = value;
    else byTool[key] = value;
  }
  return { default: def, byTool };
}

export function resolveActions(raw: unknown): ActionsConfig {
  const base = DEFAULT_SUNDIAL_CONFIG.actions;
  if (!isPlainObject(raw)) return { internal: { ...base.internal }, outward: { ...base.outward }, filesystemAllow: [] };
  return {
    internal: resolveActionClass(raw.internal, base.internal.default),
    outward: resolveActionClass(raw.outward, base.outward.default),
    filesystemAllow: stringArrayOrEmpty(raw.filesystemAllow, 'actions.filesystemAllow'),
  };
}

/**
 * The policy governing one named tool: its per-tool override if set, else the
 * class default. The single lookup every action tool asks before it registers
 * (`off` → do not register) and before it runs (`ask` → route through approval).
 */
export function resolveActionPolicy(actions: ActionsConfig, kind: 'internal' | 'outward', tool: string): ActionPolicy {
  const klass = actions[kind];
  return klass.byTool[tool] ?? klass.default;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `ProjectRule` is usable only if it has a non-empty `project` and at least one matcher. */
/** Every matcher a rule may carry. The one list every validator reads, so a new matcher is added once. */
export const PROJECT_RULE_MATCHERS = ['titleContains', 'meetingContains', 'urlContains', 'pathContains', 'gitBranch', 'processIs'] as const;

/**
 * ONE rule, re-established from untrusted input, or null.
 *
 * This is the single validator of the `ProjectRule` shape. It used to exist
 * three times — here for config.json, in the fold for the `attribution:rule-
 * decided` signal, and in the web route for a rule the owner stated — and the
 * three had already drifted: the fold's copy did not know `meetingContains`,
 * so an accepted meeting rule was written to disk and silently dropped from
 * the live state until the next boot.
 */
export function sanitizeProjectRule(raw: unknown): ProjectRule | null {
  if (!isPlainObject(raw)) return null;
  const project = typeof raw.project === 'string' ? raw.project.trim() : '';
  if (!project) return null;
  const rule: ProjectRule = { project };
  for (const key of PROJECT_RULE_MATCHERS) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') rule[key] = value.trim();
  }
  if (raw.confidence === 'certain' || raw.confidence === 'weak') rule.confidence = raw.confidence;
  // A rule with only `processIs` matches a whole app — a legitimate mapping for
  // an app that IS one project. A rule with no matcher would stamp every window.
  return PROJECT_RULE_MATCHERS.some((key) => rule[key] !== undefined) ? rule : null;
}

/**
 * A BARE loopback host, with or without a port: the name every dev server the
 * owner runs answers on, which is why it cannot tell one project from another.
 *
 * A NAMED subdomain of it is the opposite — `overture.localhost` and
 * `playerone-preview.localhost` are in this owner's config and each names
 * exactly one project. The first version of this pattern matched those too and
 * would have refused the owner adding another one.
 */
export const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(:\d+)?$/i;

/**
 * Why a NEW rule would stop matching within the week, or null when it is
 * durable. Two shapes, both learned from the record: a PORT (`localhost:8080`
 * is `:5173` after one config change) and a BARE LOOPBACK HOST (it would claim
 * every dev server for whichever project was named first). Applied to rules
 * the owner is about to add — never to rules already in config.json, which are
 * theirs to keep.
 */
export function unstableRuleReason(rule: ProjectRule): string | null {
  for (const key of ['urlContains', 'pathContains'] as const) {
    const matcher = rule[key];
    if (typeof matcher !== 'string') continue;
    if (/:\d{2,5}(\/|$)/.test(matcher)) return `"${matcher}" contains a port, which stops matching the next time that port moves.`;
    if (LOOPBACK_HOST.test(matcher.split('/')[0] ?? '')) return `"${matcher}" is a loopback host, which every dev server answers on. Match on the page title or path instead.`;
  }
  return null;
}

/** The distinguishable part of a timed place: a URL path, a cleaned page title, or the calendar meeting in a call. */
export interface PlacePart {
  kind: 'path' | 'title' | 'meeting';
  label: string;
}

/**
 * The rule to write for a place the owner just named — or the reason none can.
 *
 * A host claims the page URL, an app its process name, and a PART narrows that
 * to one path, one title or one meeting: that is what lets figma.com be Northwind
 * on one file and overture on another, and a Meet tab be whichever project
 * the calendar says. A call's rule carries the meeting alone: the matcher only
 * fires inside a call window, so the host adds nothing. A loopback host needs
 * a part before it can have a rule at all.
 */
export function ruleForPlace(kind: 'host' | 'app', label: string, part: PlacePart | null, project: string): { rule: ProjectRule | null; reason?: string } {
  const bare = label.replace(/:\d+$/, '');
  if (kind === 'app') {
    if (part?.kind === 'title') return { rule: { processIs: label, titleContains: part.label, project } };
    if (part?.kind === 'meeting') return { rule: { processIs: label, meetingContains: part.label, project } };
    return { rule: { processIs: label, project } };
  }
  if (part?.kind === 'meeting') return { rule: { meetingContains: part.label, project } };
  if (LOOPBACK_HOST.test(label)) {
    if (part?.kind === 'path') return { rule: { urlContains: part.label, project } };
    if (part?.kind === 'title') return { rule: { titleContains: part.label, project } };
    return { rule: null, reason: 'a rule for localhost would claim every dev server you run. Pick one of the paths or page titles under it instead — that is what tells this project from the next one.' };
  }
  if (part?.kind === 'path') return { rule: { urlContains: `${bare}${part.label}`, project } };
  if (part?.kind === 'title') return { rule: { urlContains: bare, titleContains: part.label, project } };
  return { rule: { urlContains: bare, project } };
}

function sanitizeProjectRules(value: unknown): ProjectRule[] {
  if (!Array.isArray(value)) return [];
  const rules: ProjectRule[] = [];
  for (const raw of value) {
    const rule = sanitizeProjectRule(raw);
    if (rule === null) continue;
    rules.push(rule);
  }
  return rules;
}

function resolveOcr(value: unknown): OcrConfig {
  if (!isPlainObject(value)) return { ...DEFAULT_OCR_CONFIG };
  // A positive number is clamped up to `min` (e.g. a too-fast interval floors at MIN_OCR_INTERVAL_MS); a non-number / non-positive falls back to the default.
  const posInt = (v: unknown, fallback: number, min: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.max(min, Math.floor(v)) : fallback);
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_OCR_CONFIG.enabled,
    fullIntervalMs: posInt(value.fullIntervalMs, DEFAULT_OCR_CONFIG.fullIntervalMs, MIN_OCR_INTERVAL_MS),
    cursorIntervalMs: posInt(value.cursorIntervalMs, DEFAULT_OCR_CONFIG.cursorIntervalMs, MIN_OCR_INTERVAL_MS),
    cursorRegionPx: posInt(value.cursorRegionPx, DEFAULT_OCR_CONFIG.cursorRegionPx, 64),
    retentionDays: posInt(value.retentionDays, DEFAULT_OCR_CONFIG.retentionDays, 1),
    vision: isPlainObject(value.vision)
      ? {
          enabled: value.vision.enabled === true,
          model: typeof value.vision.model === 'string' && value.vision.model.trim() !== '' ? value.vision.model.trim() : DEFAULT_OCR_CONFIG.vision.model,
          intervalMs: posInt(value.vision.intervalMs, DEFAULT_OCR_CONFIG.vision.intervalMs, 15_000),
        }
      : { ...DEFAULT_OCR_CONFIG.vision },
  };
}

function resolveAudio(value: unknown): AudioConfig {
  if (!isPlainObject(value)) return { ...DEFAULT_AUDIO_CONFIG };
  const posInt = (v: unknown, fallback: number, min: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.max(min, Math.floor(v)) : fallback);
  const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback);
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_AUDIO_CONFIG.enabled,
    autoMeetings: value.autoMeetings === true,
    languages: Array.isArray(value.languages) ? value.languages.filter((l): l is string => typeof l === 'string' && l.trim() !== '').map((l) => l.trim().toLowerCase()) : [],
    retentionDays: posInt(value.retentionDays, DEFAULT_AUDIO_CONFIG.retentionDays, 1),
    // A flush shorter than a natural pause between words chops sentences in
    // half and costs accuracy, so the floor is not zero.
    silenceFlushMs: posInt(value.silenceFlushMs, DEFAULT_AUDIO_CONFIG.silenceFlushMs, 300),
    maxUtteranceMs: posInt(value.maxUtteranceMs, DEFAULT_AUDIO_CONFIG.maxUtteranceMs, 2000),
    whisperUrl: str(value.whisperUrl, DEFAULT_AUDIO_CONFIG.whisperUrl),
    modelPath: str(value.modelPath, DEFAULT_AUDIO_CONFIG.modelPath),
    vadModelPath: str(value.vadModelPath, DEFAULT_AUDIO_CONFIG.vadModelPath),
    diarizeModelPath: typeof value.diarizeModelPath === 'string' && value.diarizeModelPath.trim() !== '' ? value.diarizeModelPath.trim() : null,
  };
}

function resolveNotifications(value: unknown): NotificationsConfig {
  if (!isPlainObject(value)) return { ...DEFAULT_NOTIFICATIONS_CONFIG };
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_NOTIFICATIONS_CONFIG.enabled,
    ntfy: typeof value.ntfy === 'string' && /^https?:\/\//.test(value.ntfy) ? value.ntfy.trim() : DEFAULT_NOTIFICATIONS_CONFIG.ntfy,
    verdictUrl: typeof value.verdictUrl === 'string' && /^https:\/\//.test(value.verdictUrl) ? value.verdictUrl.trim().replace(/\/$/, '') : DEFAULT_NOTIFICATIONS_CONFIG.verdictUrl,
    pushAtMac: value.pushAtMac !== false,
  };
}

function resolveHands(value: unknown): ResolvedSundialConfig['hands'] {
  if (!isPlainObject(value)) return { ...DEFAULT_SUNDIAL_CONFIG.hands };
  return {
    claude: value.claude === true,
    claudePath: typeof value.claudePath === 'string' && value.claudePath.trim().startsWith('/') ? value.claudePath.trim() : null,
    maxBudgetUsd: typeof value.maxBudgetUsd === 'number' && value.maxBudgetUsd > 0 ? value.maxBudgetUsd : DEFAULT_SUNDIAL_CONFIG.hands.maxBudgetUsd,
  };
}

// lane E (#12)
function resolveJobs(value: unknown): ResolvedSundialConfig['jobs'] {
  const d = DEFAULT_SUNDIAL_CONFIG.jobs;
  if (!isPlainObject(value)) return { ...d };
  const pos = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
  return {
    enabled: value.enabled === true,
    maxUsdPerJob: pos(value.maxUsdPerJob, d.maxUsdPerJob),
    maxUsdPerNight: pos(value.maxUsdPerNight, d.maxUsdPerNight),
    maxJobsPerNight: Math.floor(pos(value.maxJobsPerNight, d.maxJobsPerNight)),
    maxMinutes: pos(value.maxMinutes, d.maxMinutes),
  };
}

function sanitizeAliases(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/**
 * P1 — collapse a project name to its canonical form: apply the alias map
 * (exact key, then case-insensitive), else lowercase-trim. Used at project
 * registration and at day-level aggregation so `WCS`/`wcs` and
 * `PB-Games`/`puzzlebox-studio` never split into two projects.
 */
export function canonicalProjectName(name: string, aliases: Record<string, string>): string {
  const trimmed = name.trim();
  if (aliases[trimmed]) return aliases[trimmed];
  const lower = trimmed.toLowerCase();
  for (const [variant, canonical] of Object.entries(aliases)) {
    if (variant.toLowerCase() === lower) return canonical;
  }
  return lower;
}

function resolvePollIntervalMs(fileValue: number | undefined): number {
  const envValue = process.env.SUNDIAL_POLL_INTERVAL_MS;
  const raw = envValue !== undefined ? Number(envValue) : typeof fileValue === 'number' ? fileValue : DEFAULT_SUNDIAL_CONFIG.pollIntervalMs;
  return Math.max(MIN_POLL_INTERVAL_MS, Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SUNDIAL_CONFIG.pollIntervalMs);
}

/**
 * `privacy.sensitiveApps`/`hiddenApps`/`shellRedactPatterns` are used as
 * name/pattern strings; a non-string entry (a stray number/object from a
 * hand-edit or a bad writer) would otherwise coerce to `"123"` /
 * `"[object Object]"` downstream and silently never match, quietly weakening
 * redaction. Keep only real strings, and warn if any were dropped so the
 * owner learns their edit did nothing rather than discovering it via a leak.
 */
function stringArrayOrEmpty(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return [];
  const strings = value.filter((v): v is string => typeof v === 'string');
  if (strings.length !== value.length) {
    console.warn(`[gnomon] privacy.${field} in config.json has ${value.length - strings.length} non-string entry(ies) — ignoring them.`);
  }
  return strings;
}

/**
 * C4 (docs/audit/production-proposal-and-enhancements.md, fixes A§5.6,
 * A§6.1) — reads `~/.sundial/config.json` once (called at daemon start, and
 * separately by any CLI command that needs the same numbers, e.g. `gnomon
 * ask`'s budget check). Tolerant of a missing file (pure defaults, not an
 * error — the overwhelmingly common case) and of malformed JSON (logs a
 * warning, falls back to defaults rather than crashing startup over a
 * typo). This is what activates the already-built hidden-apps/tier-3
 * auto-learning machinery for the first time — `privacyConfig` was
 * previously frozen at its hardcoded defaults with no override path at all.
 */
/**
 * A zone is accepted only if `Intl` will construct a formatter for it, which
 * throws `RangeError` on an unknown identifier. Checking via `localDate` would not
 * work: that deliberately falls back to the UTC date on failure, so a typo would
 * look like a success and silently shift every day by the host offset.
 */
function resolveTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return hostTimeZone();
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
    return value;
  } catch {
    console.warn(`[gnomon] unknown timezone ${JSON.stringify(value)} in config.json, using ${hostTimeZone()}`);
    return hostTimeZone();
  }
}

// lane H (H8)
/**
 * Whether `config.json` exists but cannot be parsed — the case where
 * `loadSundialConfig` falls back to every default and says so only in the
 * log. Pure over the file, so the sensor runtime can report it once at boot
 * (`sensor:health.configUnreadable`) and `sensorHealth` can say it once.
 */
export function isSundialConfigUnreadable(): boolean {
  const configPath = getSundialConfigPath();
  if (!fs.existsSync(configPath)) return false;
  try {
    JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return false;
  } catch {
    return true;
  }
}

export function loadSundialConfig(): ResolvedSundialConfig {
  const configPath = getSundialConfigPath();
  if (!fs.existsSync(configPath)) return DEFAULT_SUNDIAL_CONFIG;

  let parsed: SundialConfigFile;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as SundialConfigFile;
  } catch (error) {
    console.warn(`[gnomon] failed to parse ${configPath}, using defaults:`, error);
    return DEFAULT_SUNDIAL_CONFIG;
  }
  return resolveSundialConfig(parsed);
}

/** A parsed `config.json`, every field validated and defaulted (W3: the routes resolve what they are about to write). */
export function resolveSundialConfig(parsed: SundialConfigFile): ResolvedSundialConfig {
  const tier = parsed.privacy?.redactionTier;

  return {
    privacy: {
      redactionTier: typeof tier === 'number' && VALID_TIERS.has(tier) ? (tier as 1 | 2 | 3) : DEFAULT_SUNDIAL_CONFIG.privacy.redactionTier,
      extraSensitiveApps: stringArrayOrEmpty(parsed.privacy?.sensitiveApps, 'sensitiveApps'),
      extraHiddenApps: stringArrayOrEmpty(parsed.privacy?.hiddenApps, 'hiddenApps'),
      extraShellRedactPatterns: stringArrayOrEmpty(parsed.privacy?.shellRedactPatterns, 'shellRedactPatterns'),
      mail: (parsed.privacy as { mail?: unknown } | undefined)?.mail === true,
      messages: (parsed.privacy as { messages?: unknown } | undefined)?.messages === true,
    },
    browser: { pageText: (parsed as { browser?: { pageText?: unknown } }).browser?.pageText === true },
    budgets: isPlainObject(parsed.budgets) ? (parsed.budgets as Partial<Record<string, number>>) : {},
    projectRules: sanitizeProjectRules(parsed.projectRules),
    sharedPlaces: stringArrayOrEmpty(parsed.sharedPlaces, 'sharedPlaces'),
    projectAliases: sanitizeAliases(parsed.projectAliases),
    personAliases: sanitizeAliases(parsed.personAliases),
    orgByPath: sanitizeAliases(parsed.orgByPath),
    locationLabels: sanitizeAliases(parsed.locationLabels),
    // Validated by round-tripping a known instant: an unusable zone silently
    // falls back to the host's rather than shifting every day by an unknown offset.
    timezone: resolveTimezone(parsed.timezone),
    refutationEnabled: parsed.refutationEnabled !== false,
    experiments: {
      ownerStateInGateCost: parsed.experiments?.ownerStateInGateCost === true,
      forecasting: parsed.experiments?.forecasting === true,
      gateFeatures: parsed.experiments?.gateFeatures === true,
      presence: parsed.experiments?.presence === true,
    },
    vault: typeof parsed.vault === 'string' && parsed.vault.trim() !== '' ? parsed.vault.trim() : null,
    llm: { providers: parseProviders(parsed.llm?.providers), use: parseUse(parsed.llm?.use) },
    ownerAliases: stringArrayOrEmpty(parsed.ownerAliases, 'ownerAliases'),
    leisureRules: resolveLeisureRules(parsed.leisureRules),
    ocr: resolveOcr(parsed.ocr),
    audio: resolveAudio(parsed.audio),
    notifications: resolveNotifications(parsed.notifications),
    hands: resolveHands(parsed.hands),
    // lane E (#12)
    jobs: resolveJobs((parsed as { jobs?: unknown }).jobs),
    retentionDays: typeof parsed.retentionDays === 'number' && parsed.retentionDays > 0 ? parsed.retentionDays : DEFAULT_SUNDIAL_CONFIG.retentionDays,
    decayFactor: typeof parsed.decayFactor === 'number' && parsed.decayFactor > 0 && parsed.decayFactor <= 1 ? parsed.decayFactor : DEFAULT_SUNDIAL_CONFIG.decayFactor,
    pollIntervalMs: resolvePollIntervalMs(parsed.pollIntervalMs),
    clipboardEnabled: typeof parsed.clipboardEnabled === 'boolean' ? parsed.clipboardEnabled : DEFAULT_SUNDIAL_CONFIG.clipboardEnabled,
    actions: resolveActions(parsed.actions),
    integrations: resolveIntegrations(parsed.integrations),
  };
}
