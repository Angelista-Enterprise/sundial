// Lane B: what the standup draft, the meeting prep and the week review read (`briefClock`).
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
  /** The week in review as last composed (`ComposeWeekReview` → `brief:week-composed`), for Today and `gnomon_brief`. */
  week?: WeekBrief | null;
  /** When `briefClock` last asked for the week to be composed. */
  weekAskedAt?: string;
}

export interface WeekBrief {
  from: string;
  to: string;
  lines: string[];
  at: string;
}

/**
 * W4 step 7: compose the week in review. The executor reads the week from the log
 * (`buildWeekReview`, about a second), keeps it as a `week-review` knowledge entry, and
 * answers `brief:week-composed`, which `briefClock` folds into `briefs.week`.
 */
export interface ComposeWeekReviewEffect {
  type: 'ComposeWeekReview';
  at: string;
}

/** KernelState's Briefs fields; `KernelState` extends this. */
export interface BriefsSlices {
  // lane B — briefs (standup draft, meeting prep). Written by `briefClock`; optional because older snapshots predate it.
  briefs?: BriefState;
}
