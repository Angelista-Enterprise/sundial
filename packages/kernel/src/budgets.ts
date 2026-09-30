import type { LlmPurpose } from './types.js';

/**
 * Default daily per-purpose caps (Phase 4, docs/design/03-effects-and-llm-
 * policy.md). Lives here, not in one consumer, so the kernel runtime
 * (`packages/harness-runtime`), the chat's budget guard (`sundial-tools`) and
 * the Ledger (`sundial-theme`) all enforce and show the same numbers.
 */
/**
 * Background model calls in flight at once on one route (the chat is not
 * counted). A burst after a gap sent 86 in 12 s and hit the provider's rate
 * limit; and a breaker opened after 10 failures still failed every call
 * already in flight (17 and 25 in the 2026-09-30 E2E), so this also bounds
 * an outage at 10 + this many failures.
 */
export const MAX_BACKGROUND_IN_FLIGHT = 4;

/**
 * Caps are a runaway-loop backstop, not a cost lever (docs/design/07 §14) —
 * the owner self-hosts the LLM, so these are tuned HIGH enough never to bind
 * in normal use. `intent: 200` in particular would throttle a busy day (a
 * heavy day closes well over 200 moments); every cap here now sits above
 * realistic daily volume. All remain editable in `~/.sundial/config.json`.
 */
export const DEFAULT_DAILY_CAPS: Record<LlmPurpose, number> = {
  // `intent` is the MERGED intent+narrate call (B2, see
  // `momentAnalysisSchedule`): one completion returns both fields, so the
  // former `narrate` purpose is gone rather than idle. `knowledge` went the
  // same way — it has had no producer since the dsh rebuild. Both kept a row
  // here long after they stopped being reachable, which put 2500 calls of
  // phantom headroom on the Ledger's budget table for work nothing can do.
  intent: 2000,
  companion: 500,
  reflect: 30,
  extract: 300,
  /**
   * One pass a night over five facts, plus headroom for a retry and for the
   * owner triggering an extra pass by hand. Deliberately the smallest cap in
   * the table: this is the only purpose whose output SHRINKS core memory, and a
   * skeptic given room to run all day would put more wrong negations through
   * `contradictionCheck` than a day of observation puts facts in.
   */
  refute: 30,
  // Research-goal hypothesis proposals. One goal open at a time, at most two
  // proposals per goal, so 12 is a bug backstop rather than a budget.
  goal: 12,
  /**
   * Counted in ROUND TRIPS since the journal became a tool loop — up to eight
   * per day written, plus a forced final answer. 50 was fifty journals; it is
   * now about six, which a single month's backfill would exhaust twice over.
   */
  journal: 300,
  /**
   * UNCAPPED by owner decision (2026-08-15): "no more capped ask budgets".
   * Conversation is the path the owner actually drives, and a backstop that
   * can tell them "come back tomorrow" mid-thought is friction, not safety.
   *
   * `Infinity` is the uncapped sentinel throughout: `resolveDailyCaps` still
   * lets `config.budgets.ask` set a finite number to re-impose a cap, and the
   * spend is still recorded on every call (the ledger and `state.budgets`
   * stay accurate) — only the block is gone. The other purposes keep their
   * runaway-loop backstops; those are batch machinery, not the owner talking.
   */
  ask: Infinity,
  /**
   * Cleaning up what ambient hearing wrote down. One call per closed moment
   * that actually heard something, which is a small share of a day's moments —
   * 200 is a runaway backstop, not a budget. The raw capture is never replaced
   * by this, only shown alongside it, so a day that hits the cap loses a
   * convenience and no evidence.
   */
  transcript: 200,
  /**
   * W3: the Claude hand (`hands.claude`): one call is a whole background job on
   * the owner's Claude Code, already capped in dollars per job. Twenty is a
   * loop backstop — the workbench opens a handful of jobs a day.
   */
  hand: 20,
  /**
   * W5: the screen-vision sensor (a local model, one frame per call). Its own
   * interval bounds it (15 s at the least): 6,000 is a whole day at that, a
   * loop backstop only.
   */
  vision: 6000,
  /**
   * Jev's purposes (docs/jarvis/02, "Budgets: new purposes, generous caps").
   * Loop guards, not cost controls: at ~700 input tokens a call, a day at
   * every cap at once is ≈ 10 M tokens ≈ $0.45. Each number is the day's
   * realistic maximum with headroom, so none binds in normal use.
   */
  // One per tick; 16 h × 60 min × up to 4 debounced changes.
  perceive: 5000,
  // Moments close ~500 times a day at most.
  classify: 3000,
  // One per `ask` plus one per journal moment.
  rank: 2000,
  // One per line shown.
  judge: 3000,
  // 477 facts + aliases, once a night, with retries.
  audit: 1000,
  // Targets × hours.
  forecast: 1000,
  // One per owner reply.
  listen: 200,
};

/**
 * C4 (docs/audit/production-proposal-and-enhancements.md, fixes A§5.6) —
 * `overrides` comes from `~/.sundial/config.json`'s `budgets` field
 * (`@sundial/helpers/sundial-config.js`'s `loadSundialConfig().budgets`), a
 * loosely-typed `Partial<Record<string, number>>` since `@sundial/helpers`
 * can't import `LlmPurpose` (it sits below `@sundial/kernel` in the
 * dependency graph) — only recognized purpose keys with a positive number
 * actually override anything; an unrecognized key or a bad value is
 * silently ignored rather than injecting a bogus purpose into the caps
 * object. Every caller passes the *same* loaded config, so no two of them
 * can drift apart.
 */
export function resolveDailyCaps(overrides?: Partial<Record<string, number>>): Record<LlmPurpose, number> {
  const resolved = { ...DEFAULT_DAILY_CAPS };
  if (!overrides) return resolved;

  for (const purpose of Object.keys(resolved) as LlmPurpose[]) {
    const value = overrides[purpose];
    if (typeof value === 'number' && value > 0) resolved[purpose] = value;
  }
  return resolved;
}
