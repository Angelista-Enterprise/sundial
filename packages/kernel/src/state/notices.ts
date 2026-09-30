import type { DeliveredNotice } from './calibrated.js';
// What a producer hands the gate. Moved out of types.ts (W4 step 13's layout); types.ts re-exports it.

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
  /** W2: the chat this is addressed to (a follow-up), or absent/null for the conversation. */
  sessionId?: string | null;
}

/** KernelState's Notices fields; `KernelState` extends this. */
export interface NoticesSlices {
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
    /** W5: what the last delivering event delivered, for `calibrate` on the same event. */
    lastDelivered?: { at: string; items: DeliveredNotice[] };
    /** W5: suppressed candidates of a thin kind since its last exploration. */
    explore?: Record<string, number>;
  };
  // lane D
  /** Where an interruption goes right now (#6 the right channel). Single writer: `noticeRoute`. */
  route: NoticeRoute;
  /**
   * Watch rules the owner adopted (`rule:adopted`), and each one's running
   * state. Written by `watchRules`; see `watch.ts`. Optional: older snapshots
   * predate it.
   */
  watch?: {
    rules: import('../watch.js').WatchRule[];
    runtime: Record<string, import('../watch.js').WatchRuntime>;
    /** Active time and away, folded from `WATCH_FLAG_TYPES` by the same reducer the backtest runs. */
    flags?: import('../watch.js').WatchFlags;
    /** Each rule's version, backtest promise, fires and verdicts (the rules card and the review read them). */
    stats?: Record<string, import('../watch.js').WatchStats>;
    /** Rules kept but not stepped: their runtime is frozen and they emit nothing. */
    paused?: string[];
    /** Rules Gnomon proposed on the shelf, by shelf entry id; the owner's Keep adopts one. At most 10. */
    proposed?: Record<string, import('../watch.js').WatchRule>;
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
}

/** Per-key habituation state: response `gain` as of `at`, recovering toward 1 since. */
export interface HabituationEntry {
  gain: number;
  at: string;
  fires: number;
}

export interface PhasicNotice {
  kind: string;
  observation: string;
  evidence: string[];
  weight: number;
  at: string;
  /** W2: the key, so a `notice:dropped` finds it; `undelivered` then says why, and it stops counting toward the daily cap. */
  noticeKey?: string;
  undelivered?: string;
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
