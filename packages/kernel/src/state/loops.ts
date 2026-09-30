// W2: open loops — something raised that Gnomon will say one more thing about when it resolves (`loopTrack`).
import type { WatchRule } from '../watch.js';

export interface OpenLoop {
  id: string;
  origin: 'owner' | 'said' | 'rule' | 'tool';
  /** `unpushed` first; later `wakeup`, `owner-ask`, `proposal`. */
  kind: string;
  /** What the loop is about, stable across mentions: one open loop per kind and subject. */
  subject: string;
  /** What was raised, sanitized. */
  about: string;
  /** The watch-rule language (`matchesWatch`). With `by`, each matching event removes its `by` value from `left`; empty resolves. */
  resolve: { when: WatchRule['when']; by?: string; left?: string[] };
  /** The values when raised, e.g. `{ '<cwd>': 263 }`. */
  seen: Record<string, number>;
  /** The chat to follow up in; null = the conversation. */
  target: { sessionId: string | null };
  openedAt: string;
  expiresAt: string;
  status: 'open' | 'resolved' | 'said' | 'unsaid';
  /** The follow-up's notice key and line, once resolved: its delivery outcome finds the loop, and a drop can re-offer the line. */
  noticeKey?: string | null;
  line?: { observation: string; evidence: string[] } | null;
  /** What a migrated kind (W2 M1–M3) carried that a loop has no field for: a proposal's label and verdict, an ask's choices. */
  detail?: Record<string, unknown>;
}

export interface LoopsState {
  open: OpenLoop[];
  /** The last twenty closed. */
  recent: OpenLoop[];
  /** Follow-up lines delivered today, by session. */
  saidToday: Record<string, number>;
  /** The owner's local day `saidToday` counts. */
  day: string | null;
}

/** KernelState's Loops fields; `KernelState` extends this. */
export interface LoopsSlices {
  /** W2: what Gnomon raised and will follow up on when it resolves, by `loopTrack`. */
  loops: LoopsState;
}

/**
 * One wake-up: a time, and why it was set. W2 M1: a `wakeup` loop in `state.loops`, read as this through `wakeupsOf`.
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
