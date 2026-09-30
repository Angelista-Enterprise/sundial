// The feedback and judgement slices' types (the owner's verdicts, and what they teach the judge). Moved from types.ts.
import type { RejudgeState } from './actions.js';

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
 * The feedback loop (decisions/assistant-as-an-event-source) — the return path. Until this
 * existed, nothing anywhere observed whether an insight, journal, or fact
 * Gnomon produced was accurate, useful, or unwelcome, which is why both
 * "move a fact's confidence on predictive success" (fact-lifecycle-policy)
 * and D12's escalation gate were unimplementable as designed. `recent` is
 * a bounded window (same treatment as `predictions.recentResolved`);
 * `countsByVerdict` is the cumulative tally that survives that window
 * rolling over.
 */
export interface FeedbackState {
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
}

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
export interface JudgementState {
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
  /** W3: `judgement:consulted` per question set — answers a tool asked for inside a turn. */
  consulted: Record<string, number>;
  /** W3: the rejudge job; null before the first. */
  rejudge: RejudgeState | null;
  /**
   * W5 step 4: the owner's verdicts by artifact, so an answer that arrives AFTER
   * the verdict (the nightly fact audit, a rejudge) is graded when it lands.
   * `graded` names the sets already graded for it: one verdict grades a set's
   * answers once, however often that set re-asks. Optional: older snapshots.
   */
  verdicts?: JudgedArtifact[];
}

/** One verdict an answer can still be graded by (W5 step 4). */
export interface JudgedArtifact {
  artifactId: string;
  useful: boolean;
  ts: string;
  graded: string[];
}

/** KernelState's Feedback fields; `KernelState` extends this. */
export interface FeedbackSlices {
  /** The feedback loop: the owner's verdicts. See `FeedbackState`. */
  feedback: FeedbackState;
  /** docs/jarvis/02: thresholds and calibration, per question id. See `JudgementState`. */
  judgement: JudgementState;
}
