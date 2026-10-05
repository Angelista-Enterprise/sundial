// The work around the owner: tickets, coding agents, files, the shell, git, the screen and the browser, calls, the workbench, drafts, mail and untracked places.

/** KernelState's Work fields; `KernelState` extends this. */
export interface WorkSlices {
  /** Ticket threads by key, bounded. Written by `ticketTrack`; optional because older snapshots predate it. */
  tickets?: Record<string, TicketThread>;
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
    /** `pushSeen`: a `git:push` was folded for it, so its drop to 0 is not derived as another (W6 D2). */
    unpushed: Record<string, { branch: string | null; ahead: number; since: string; updatedAt: string; pushSeen?: boolean }>;
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
   * J3.5 — the vault notes edited today (`vaultTrack`), paths only, keyed by
   * the note's path inside the vault. Reset daily. Empty when `config.vault`
   * is unset.
   */
  vault: {
    day: string | null;
    notesToday: Record<string, { changes: number; lastAt: string }>;
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
}

/**
 * The one question Gnomon is waiting on. See `KernelState.ownerAsk`.
 *
 * The question text lives here: a question is one bounded line the delivery path has to render,
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
  /** The agent's last finished reply, capped; since 2026-10-05. */
  lastReply?: string;
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
