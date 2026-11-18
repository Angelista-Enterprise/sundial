// lane H: Sundial's own health (`sensorHealth`). Moved from types.ts.

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
  /** Keyed by what broke: `input-grant`, `input-keys`, `sidecar:<label>`, `microphone`, `screen-recording`, `config`, `llm-auth:<provider>`, `downtime`, `blind:<pair>`. */
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
  /** W6 D9: the uptime heartbeat — minutes with a `clock:tick` per local day, the last seven. Optional: older snapshots. */
  uptime?: { day: string; minutes: number }[];
  /** The last clean stop (`sundial:down`) and the last time the Mac went to sleep: what the next start reads to name its gap. */
  downAt?: string;
  sleptAt?: string | null;
}

/** W5: one model route's record (`openai`, a provider id, `jev`, `ollama`, …), by `llmReliability`. */
export interface LlmRouteReliability {
  /** Failed calls in a row (a cancelled call counts neither way). */
  streak: number;
  /** The longest run of failures while the breaker was closed (scorecard row 2): at most `BREAKER_FAILURES` while it works. Replaced `longest`, which also counted the failed probes of an open breaker (a 26 h outage read as 140). Optional: older snapshots. */
  longestClosed?: number;
  /** When the breaker opened; null while closed. */
  openedAt: string | null;
  /** No call on this route before this, except the one half-open probe after it; null while closed. */
  openUntil: string | null;
  /** A 429 is backpressure, not an outage: background calls on this route wait until this (the chat never does). Optional: older snapshots. */
  cooldownUntil?: string | null;
  /** 429s since the last success, for the backoff when no `Retry-After` came. Optional: older snapshots. */
  rateLimited?: number;
  /** Calls reserved and calls failed per local day, the last seven: the rolling success. */
  days: { day: string; calls: number; failed: number }[];
}

export interface ReliabilityState {
  llm: Record<string, LlmRouteReliability>;
}

/** A local day's volume: input windows (one per 10 s awake), LLM dispatches, entity candidates, and rows per watched stream. */
export interface StreamDay {
  day: string;
  inputWindows: number;
  llm: number;
  entity: number;
  streams: Record<string, number>;
}

export interface StreamCoverageState {
  /** The last 28 local days, oldest first. Single writer: `streamSilence`. */
  days: StreamDay[];
  /** Stream → the first local day it was seen (its presence share is judged from there). */
  firstDay: Record<string, string>;
  /** Stream → the first full day it missed, once said; cleared by its next row. */
  silentSince: Record<string, string>;
  /** The last completed day judged, so a day is judged once whatever event opened the next one. */
  judgedDay?: string | null;
  /** Full days judged an outage (the pipeline collapsed, or three or more daily streams were silent): a baseline that is tagged by day leaves them out. Last 28. */
  outageDays?: string[];
}

/** W6 D6: one witness pair. The left stream predicts the right one; left with no right is a blind sensor. */
export interface WitnessPair {
  /** The last left-side evidence, and the last right-side event. */
  leftAt: string | null;
  rightAt: string | null;
  /** The first left-side evidence since the last right-side event. */
  brokenSince: string | null;
  /** Minutes of left-side evidence since the last right-side event, in ms. */
  leftMs: number;
  /** `sensor:blind` was emitted for this break. */
  told: boolean;
}

export interface WitnessState {
  /** The window in front, as the last `window:changed` gave it (already sanitized). */
  front: { process: string; title: string } | null;
  /** The last browser window title that counted as evidence: the same tab back in front is not new evidence. */
  browserTitle: string | null;
  /** Keyed by pair id (`browser`, `screen`, `audio`): the fixed table in `witness-pairs.ts`. */
  pairs: Record<string, WitnessPair>;
}

/** KernelState's Reliability fields; `KernelState` extends this. */
export interface ReliabilitySlices {
  /** W6 D6: which sensor is blind, from two streams that disagree. Single writer: `witnessPairs`. Optional: older snapshots. */
  witness?: WitnessState;
  /** Which owner-side streams are alive, from their own cadence, and the day's pipeline volume. Single writer: `streamSilence`. */
  streamCoverage: StreamCoverageState;
  /** W5: each model route's failure streak and circuit breaker, by `llmReliability`. */
  reliability: ReliabilityState;
  // lane H
  /** Sundial's own health: what broke, since when, and whether it was said. Single writer: `sensorHealth`. */
  sensorHealth: SensorHealthState;
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
      screen: { callsToday: number };
      frame: { callsToday: number };
      /** W3: one job run on a runtime source (`llm.roles.jobs`), a whole job per call. */
      hand: { callsToday: number };
      vision: { callsToday: number };
      /** Nodus: a card's storyboard, one call plus at most one repair. */
      visualize: { callsToday: number };
      /** S6: `offerNow`'s one question on a held context, "is there one offer of help for this?" */
      offer: { callsToday: number };
    };
    day: string;
  };
  /** Last-seen times `contextUrlClassify` debounces by (W6 P17: `llmCalls` and `timers` had no reader). */
  pending: {
    debounces: Record<string, string>;
  };
  /** Set by `retentionPrune` each time it fires, so the latest snapshot shows the daily prune actually ran, not just that the rule exists. */
  retention: { lastPrunedAt: string | null };
}
