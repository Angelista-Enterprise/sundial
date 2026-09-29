import { localDate } from '@sundial/helpers/local-day.js';
import type { HabituationEntry, NoticeCandidate } from './types.js';

/*
 * The notice gate's pure core: the policy, habituation and `decide`.
 *
 * Lives in the kernel rather than beside the `noticeGate` rule because two
 * readers outside the fold need the same arithmetic: the offline harness, and
 * `gnomon_test_rule`, which shows the owner what a watch rule would have SAID,
 * not only how often it fired. `@sundial/rules` re-exports all of it.
 */
/**
 * Everything the gate does, as data rather than constants.
 *
 * Swappable because the offline harness scores five policies over ONE replay of the
 * candidate stream. Habituation is a deterministic function of that stream, so a
 * policy can be simulated without re-folding two million events per variant — which
 * is the difference between five variants being affordable and being a day's work
 * each. `decide` must therefore stay pure: no `KernelState`, no clock, no IO.
 */
export interface GatePolicy {
  name: string;
  /**
   * Multiplicative drop in response per delivery of the same key. 1 disables
   * habituation entirely, which is the control's behaviour and how the surface came
   * to print "fifteenth spike this week".
   */
  habituationStep: number;
  /** Time for a habituated key to recover half the response it lost. */
  recoveryHalfLifeMs: number;
  /** Weight a candidate must clear to reach the tonic list. */
  tonicThreshold: number;
  /**
   * Weight required to interrupt. Deliberately far above `tonicThreshold`: a weak row
   * in a list is a minor cost, while a false alert spends trust that every later
   * alert depends on.
   */
  phasicThreshold: number;
  /** Candidates whose value half-life is at or under this are alert-shaped. */
  urgentBelowMs: number;
  /** Tonic notices per local day. Phasic ones deliberately do not count against it. */
  dailyBudget: number;
  /**
   * Interruptions per local day. Past it, an alert-shaped candidate is judged
   * as an ambient one instead: it can still reach the list, never the owner's
   * attention. Measured 2026-09-28: 36 interruptions in 14 days, 8 in one day,
   * with nothing counting them.
   */
  phasicDailyCap: number;
  /**
   * Weight at which a tonic candidate stops paying the daily budget. `null` disables
   * the exemption, which is every policy measured before 2026-08-16.
   *
   * The budget is spent first-come-first-served, and the gate cannot see the rest of
   * the day, so a weak-but-passing candidate at 09:00 takes the only slot and the
   * strongest thing that happens all day is refused at 20:00. That is not the budget
   * being scarce, it is the budget being spent on the wrong thing — production's
   * first full day did exactly this, discarding a 4.84 as `budget-spent` after a
   * 0.6 had already landed.
   *
   * Set above `phasicThreshold` so the exemption is narrower than the bar to
   * interrupt: something this heavy is worth a row in the list whatever else the day
   * held, but it still does not earn the right to break into the owner's attention.
   */
  budgetExemptAbove: number | null;
  /** Multiplier when the candidate touches an open commitment. Salience is relative to current concerns. */
  concernGain: number;
  /**
   * How hard the cost of interrupting pushes back, in the same units as `weight`.
   *
   * The term the gate did not have. Every other term prices how much a thing is
   * WORTH saying; none priced what saying it costs, so a candidate clearing
   * `phasicThreshold` interrupted a deep-focus block exactly as readily as an idle
   * one. ProMemAssist's shape is `utility = value − cost`, and its measured result
   * on the same decision was 24.6% positive response against 9.34% for an LLM
   * baseline choosing its own timing, with significantly lower frustration
   * (p = 0.043). Codellaborator measured the same effect from the failure side:
   * 12.1% of proactive interventions were outright disruptions, and they
   * concentrated in focused implementation (32.7% of all disruptions) while
   * debugging — a natural boundary state — produced almost none (7.3%).
   *
   * Scales a 0..1 cost supplied by the caller. Zero disables the term, which is
   * what every pre-2026-08-14 policy variant is simulated with so the harness can
   * still compare against the shipped behaviour.
   */
  interruptionCostWeight: number;
  /**
   * Below this utility a phasic candidate is dropped rather than deferred.
   *
   * Deferral is not free — a deferred candidate occupies the ring and gets
   * re-scored on every tick — so something has to separate "wait for a better
   * moment" from "never worth an interruption". ProMemAssist's rule is the same
   * three-way split at zero utility.
   */
  deferFloor: number;
}

export type Channel = 'tonic' | 'phasic' | 'suppressed' | 'deferred';

/**
 * The five factors behind one verdict: `weight = surprise × precision ×
 * habituation × concern`, `utility = weight − cost` on the interrupting path.
 *
 * Returned (rather than recomputed by callers) so the decision can be
 * PERSISTED with its own arithmetic — `architecture/rules/noticing-and-expectations`:
 * the room's whole content was computed here and thrown away microseconds
 * later, and `habituation` in particular cannot be reconstructed after the
 * fact once `applyDelivery` has moved the key.
 */
export interface DecisionTerms {
  surprise: number;
  precision: number;
  /** `habituatedGain` at decision time: 1 = never said, → 0 as the key wears down. */
  habituation: number;
  /** `concernGain` when the candidate touches an open commitment, else 1. */
  concern: number;
  /** The priced interruption cost (0 on the tonic path, which never pays one). */
  cost: number;
}

export interface Decision {
  channel: Channel;
  weight: number;
  /**
   * `weight` minus the interruption cost, for a phasic candidate. Equal to `weight`
   * for tonic and urgent-exempt paths, which do not pay a cost.
   */
  utility: number;
  /** Which term settled it — read by the harness, and by anyone asking why Gnomon stayed quiet. */
  reason: 'admitted' | 'below-threshold' | 'habituated' | 'budget-spent' | 'too-costly-now' | 'owner-silent' | 'owner-quiet' | 'owner-away' | 'expired'
    // lane D — #6: an interruption held by the route (a call, a focus mode), or pushed out of a full defer ring.
    | 'held-call' | 'held-focus' | 'displaced';
  /** The arithmetic, for the decision record. */
  terms: DecisionTerms;
}

/** ~1 tonic notice a day, urgency exempt. The band `measure-proactivity-triggers.ts` measured as useful is 0.3-3 per active day. */
export const DEFAULT_GATE_POLICY: GatePolicy = {
  name: 'v4-interruption-cost',
  habituationStep: 0.4,
  // Per delivery, and scaled by `fires` — see `habituatedGain`. Five days rather
  // than a fortnight because the scaling already stretches it: a fourth mention
  // recovers over twenty days.
  recoveryHalfLifeMs: 5 * 86_400_000,
  tonicThreshold: 0.55,
  phasicThreshold: 1.6,
  urgentBelowMs: 2 * 3_600_000,
  // Four, not one. At one, the second ambient observation of any day was dropped
  // as `budget-spent` however good it was — measured over a week, the gate said
  // 0–4 things a day and most of what cleared the bar was thrown away by this
  // line alone. Four is still a budget: it caps ambient context, not urgency,
  // and phasic notices above `budgetExemptAbove` were never counted against it.
  dailyBudget: 4,
  phasicDailyCap: 6,
  // Just above `phasicThreshold`: a candidate this heavy always earns its row in the
  // list, but never the right to interrupt on weight alone. Measured 2026-08-16 —
  // see the budget sweep in `apps/daemon/src/scripts/lab/measure-noticing.ts`
  // (removed in 9a6988c; recoverable with `git show 9a6988c^:<path>`).
  budgetExemptAbove: 1.6,
  concernGain: 1.5,
  // Sized against `phasicThreshold`: at full cost (deep focus, hands moving) an
  // interruption has to be worth 1.6 + 0.8 to land now, and anything between
  // `deferFloor` and that waits for the block to end rather than being lost.
  interruptionCostWeight: 0.8,
  deferFloor: 0,
};

/**
 * Response to a key, given how often it has been delivered and how long ago.
 *
 * Multiplicative decay per delivery, exponential recovery toward 1 — the standard
 * dual-process shape. With a step of 0.45 the fourth identical stimulus sits at 0.09
 * and clears nothing worth clearing, which is the mechanical answer to a detector
 * that fired fifteen times in a week and numbered them in the copy.
 *
 * Recovery matters as much as decay, and is the half most systems leave out: a
 * routine that breaks again next month should be as loud as it was the first time. A
 * plain "have I said this before" set cannot express that.
 *
 * Decays on DELIVERY, not on presentation — a deliberate divergence from the biology,
 * where the gain drops on repeated stimulation whether or not a response follows.
 * Producers here can legitimately re-offer a candidate before it ever clears the bar
 * (a drift keyed by week, restated daily until it does), and habituating on
 * presentation would kill exactly those before they were ever said once.
 */
export function habituatedGain(entry: HabituationEntry | undefined, nowMs: number, policy: GatePolicy): number {
  if (!entry) return 1;

  const fires = Math.max(1, entry.fires);
  // Two ways `fires` shapes recovery, both of them long-term habituation and both
  // needed. Repeated habituation series in real nervous systems habituate faster and
  // recover slower each time; a gate that only decays per delivery has neither
  // property, and a strong recurring candidate is then re-admitted every second or
  // third day forever — measured at five mentions of the same absence in ten days.
  //
  // 1. Recovery SLOWS in proportion to how often this key has already been said.
  const halfLife = Math.max(policy.recoveryHalfLifeMs, 1) * fires;
  // 2. Recovery no longer aims at full volume. Something said four times cannot
  //    become as loud as it was the first time without new information, so the
  //    ceiling itself habituates. This is the term that bounds a persistent problem
  //    to a few mentions rather than an endless slow drip.
  const ceiling = 1 / fires;

  const recovery = Math.pow(0.5, Math.max(0, nowMs - Date.parse(entry.at)) / halfLife);
  return ceiling - (ceiling - entry.gain) * recovery;
}

/** The gate's own state, isolated from `KernelState` so the harness can simulate it. */
export interface NoticeState {
  habituation: Record<string, HabituationEntry>;
  day: string;
  spentToday: number;
  /** Interruptions already delivered on `day`. Absent = none (the harness's simulations). */
  phasicToday?: number;
}

/** Kinds that keep an interruption when the day's cap is spent, and how many over it. */
const RESERVED_KINDS = new Set(['owner-question']);
const RESERVED_OVER_CAP = 1;

/**
 * Whether to say this, and through which channel.
 *
 * Pure, and the harness depends on it staying that way.
 *
 * Channel is settled BEFORE any threshold, from decay of value alone. An urgent
 * candidate must never lose its slot to a day's worth of ordinary ones, and a
 * retrospective one must never interrupt however heavy it is.
 */
export function decide(policy: GatePolicy, notices: NoticeState, candidate: NoticeCandidate, ts: string, localDay: string, interruptionCost = 0): Decision {
  const gain = habituatedGain(notices.habituation[candidate.key], Date.parse(ts), policy);
  const concern = candidate.concerns.length > 0 ? policy.concernGain : 1;
  const weight = candidate.surprise * candidate.precision * gain * concern;

  const urgent = candidate.valueHalfLifeMs !== null && candidate.valueHalfLifeMs <= policy.urgentBelowMs;
  // Over the day's interruptions, an urgent candidate falls through to the tonic path below.
  // An owner question may take one slot over the cap: the best-rated kind should not lose to the day's other noticing.
  const cap = policy.phasicDailyCap + (RESERVED_KINDS.has(candidate.kind) ? RESERVED_OVER_CAP : 0);
  const capped = notices.day === localDay && (notices.phasicToday ?? 0) >= cap;
  if (urgent && !capped) {
    // Cost applies to the interrupting channel only. A tonic notice is a row in a
    // list the owner reads when they choose to; pricing it would starve the daily
    // budget for an interruption that never happens.
    const cost = Math.max(0, Math.min(1, interruptionCost)) * policy.interruptionCostWeight;
    const utility = weight - cost;
    const terms: DecisionTerms = { surprise: candidate.surprise, precision: candidate.precision, habituation: gain, concern, cost };

    if (utility >= policy.phasicThreshold) return { channel: 'phasic', weight, utility, reason: 'admitted', terms };
    // Habituation and the threshold are judgments about the candidate and settle it
    // for good; cost is a judgment about the MOMENT and will be different in twenty
    // minutes. Only the latter earns a place in the defer ring — checking it second
    // is what keeps a genuinely weak candidate from being deferred for ever.
    if (weight >= policy.phasicThreshold && utility > policy.deferFloor) return { channel: 'deferred', weight, utility, reason: 'too-costly-now', terms };
    return { channel: 'suppressed', weight, utility, reason: gain < 0.5 ? 'habituated' : 'below-threshold', terms };
  }

  const terms: DecisionTerms = { surprise: candidate.surprise, precision: candidate.precision, habituation: gain, concern, cost: 0 };
  if (weight < policy.tonicThreshold) return { channel: 'suppressed', weight, utility: weight, reason: gain < 0.5 ? 'habituated' : 'below-threshold', terms };

  const spent = notices.day === localDay ? notices.spentToday : 0;
  const exempt = policy.budgetExemptAbove !== null && weight >= policy.budgetExemptAbove;
  if (spent >= policy.dailyBudget && !exempt) return { channel: 'suppressed', weight, utility: weight, reason: 'budget-spent', terms };

  return { channel: 'tonic', weight, utility: weight, reason: 'admitted', terms };
}

/** `notices` after a delivery: habituate the key, and charge the budget for a tonic one. */
export function applyDelivery(notices: NoticeState, candidate: NoticeCandidate, ts: string, localDay: string, channel: 'tonic' | 'phasic', policy: GatePolicy): NoticeState {
  const previous = notices.habituation[candidate.key];
  const gain = habituatedGain(previous, Date.parse(ts), policy) * policy.habituationStep;
  const habituation = { ...notices.habituation, [candidate.key]: { gain, at: ts, fires: (previous?.fires ?? 0) + 1 } };

  const keys = Object.keys(habituation);
  if (keys.length > MAX_HABITUATION_KEYS) {
    const oldest = keys.sort((a, b) => Date.parse(habituation[a]!.at) - Date.parse(habituation[b]!.at)).slice(0, keys.length - MAX_HABITUATION_KEYS);
    for (const key of oldest) delete habituation[key];
  }

  const spentToday = notices.day === localDay ? notices.spentToday : 0;
  return { habituation, day: localDay, spentToday: channel === 'tonic' ? spentToday + 1 : spentToday };
}

/**
 * Bound on the habituation map. Generous, because evicting a key resets its response
 * to full — losing a key means repeating something the owner has already been told,
 * which is the failure this whole slice exists to prevent.
 */
export const MAX_HABITUATION_KEYS = 200;

/** The policy under the owner's dial: the bias moves both bars together, `2^bias` (settings keep it within ±3). */
export function policyForBias(bias = 0): GatePolicy {
  const scale = 2 ** bias;
  return scale === 1 ? DEFAULT_GATE_POLICY : { ...DEFAULT_GATE_POLICY, tonicThreshold: DEFAULT_GATE_POLICY.tonicThreshold * scale, phasicThreshold: DEFAULT_GATE_POLICY.phasicThreshold * scale };
}

export interface GateSimulation {
  phasic: number;
  tonic: number;
  suppressed: number;
  /** Why the suppressed ones were suppressed. */
  reasons: Record<string, number>;
  /** One channel per candidate, in order. */
  channels: Channel[];
}

/**
 * What the gate would have done with one stream of candidates, oldest first,
 * habituating and counting the day's interruptions as it goes.
 *
 * Two things a replay cannot know, and both are left out on purpose: the rest
 * of the day's notices spending the tonic budget, and the interruption cost of
 * the moment (0 here, so nothing is ever deferred). The result is therefore an
 * upper bound on what would have been said.
 */
export function simulateGate(policy: GatePolicy, items: { candidate: NoticeCandidate; ts: string; cost?: number }[], timeZone: string): GateSimulation {
  const out: GateSimulation = { phasic: 0, tonic: 0, suppressed: 0, reasons: {}, channels: [] };
  let notices: NoticeState = { habituation: {}, day: '', spentToday: 0, phasicToday: 0 };
  for (const { candidate, ts, cost } of items) {
    const day = localDate(ts, timeZone);
    if (notices.day !== day) notices = { ...notices, day, spentToday: 0, phasicToday: 0 };
    const decision = decide(policy, notices, candidate, ts, day, cost ?? 0);
    out.channels.push(decision.channel);
    if (decision.channel === 'phasic' || decision.channel === 'tonic') {
      out[decision.channel]++;
      const phasicToday = (notices.phasicToday ?? 0) + (decision.channel === 'phasic' ? 1 : 0);
      notices = { ...applyDelivery(notices, candidate, ts, day, decision.channel, policy), phasicToday };
    } else {
      out.suppressed++;
      out.reasons[decision.reason] = (out.reasons[decision.reason] ?? 0) + 1;
    }
  }
  return out;
}
