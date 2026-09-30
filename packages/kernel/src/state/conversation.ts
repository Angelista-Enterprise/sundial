import type { AnsweredQuestion as AnsweredOwnerAsk } from '@sundial/helpers/asked.js';
import type { HabituationEntry } from '../types.js';
// W1: what each chat was shown and said, as the fold keeps it (`conversationTrack`).

/** One turn, clipped to 280 characters. `shownId` is the brief the reply was written against. */
export interface ChatTurn {
  at: string;
  by: 'owner' | 'gnomon';
  turnId: string;
  text: string;
  shownId?: string | null;
}

/** A fact a brief showed: its key and the value it rests on, without the clause. */
export interface ShownFact {
  key: string;
  value: Record<string, unknown>;
}

export interface ChatSession {
  lastAt: string;
  shown: { briefId: string; facts: ShownFact[] } | null;
  /** Why the latest turn happened: the notice or question that woke it, when one did. */
  cause: { noticeKey: string | null; askId: string | null } | null;
  /** The last six turns. */
  turns: ChatTurn[];
}

/** A fact Gnomon told the owner: shown in the brief and named in the reply. `value` is what matched. */
export interface SaidFact {
  key: string;
  value: string | number;
  at: string;
  sessionId: string;
  turnId: string;
}

export interface ConversationState {
  /** At most twelve sessions, the least recently active going first. */
  sessions: Record<string, ChatSession>;
  /** A ring of fifty. */
  said: SaidFact[];
}

/** KernelState's Conversation fields; `KernelState` extends this. */
export interface ConversationSlices {
  /** W1: what each chat was shown and said, by `conversationTrack` from `chat:*`. */
  conversation: ConversationState;
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
    /** W2 M2: the proposals themselves are `proposal` loops in `loops` (`proposalsOf`). */
    proposedCount: number;
    acceptedCount: number;
    rejectedCount: number;
    /** Claims routed into core memory as `provenance: 'assistant'` candidates. */
    claimedCount: number;
    lastAt: string | null;
  };
  ownerAsk: {
    /** W2 M3: the open question itself is an `owner-ask` loop in `loops` (`openAsk`). */
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
}

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
