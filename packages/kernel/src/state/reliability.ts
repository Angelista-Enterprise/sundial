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
  /** W6 D9: the uptime heartbeat — minutes with a `clock:tick` per local day, the last seven. Optional: older snapshots. */
  uptime?: { day: string; minutes: number }[];
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

/** KernelState's Reliability fields; `KernelState` extends this. */
export interface ReliabilitySlices {
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
      /** W3: one Claude hand run (`hands.claude`), a whole job per call. */
      hand: { callsToday: number };
      vision: { callsToday: number };
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
