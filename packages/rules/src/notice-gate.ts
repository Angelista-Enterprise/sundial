import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { classifyActivity } from '@sundial/helpers/window-classification.js';
import { NO_DIAGNOSIS, withPersona } from '@sundial/kernel/persona.js';
import type { DeferredNotice, Effect, HabituationEntry, KernelState, NoticeCandidate, PhasicNotice, Rule } from '@sundial/kernel/types.js';

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
 * PERSISTED with its own arithmetic — `unsaid-room-gate-decision-persistence`:
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
  reason: 'admitted' | 'below-threshold' | 'habituated' | 'budget-spent' | 'too-costly-now' | 'owner-silent';
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
  // Just above `phasicThreshold`: a candidate this heavy always earns its row in the
  // list, but never the right to interrupt on weight alone. Measured 2026-08-16 —
  // see the budget sweep in `measure-noticing.ts`.
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
}

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
  if (urgent) {
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

/**
 * How costly it is to interrupt right now, 0..1 — computed by the RULE, never
 * inside `decide`.
 *
 * That split is the whole reason this is a separate exported function. `decide`
 * must stay pure with no `KernelState` read, because the offline harness simulates
 * five policies against one recorded candidate stream rather than replaying two
 * million events per variant. Cost depends on live state, so the rule reads state,
 * reduces it to a number, and hands that number in — the harness then records the
 * cost alongside each candidate and five variants still cost one replay.
 *
 * Deliberately does NOT call `computeMomentKind`. A `kind` is computed at close
 * time and is meaningless on a still-open moment — which is the only kind of moment
 * an interruption can ever land in. The three signals below are all present on an
 * open rollup, and each maps to a finding rather than a preference: a call is the
 * one context where interrupting is unambiguously worst; leisure is the context the
 * owner's own taxonomy already marks as theirs; and typing is the best available
 * proxy for mid-thought, which is where Codellaborator measured disruptions
 * concentrating (32.7% during focused implementation against 7.3% while debugging).
 */
export function interruptionCostOf(state: KernelState, now: string | null = null): number {
  // An app holding the microphone (`callSpanTrack`) is a call whatever the
  // open moment thinks it is — a WhatsApp call under PR review still makes
  // this the worst possible time.
  if (state.av?.call) return 1;
  const moment = state.moment;
  if (!moment) return 0; // Nothing open to interrupt.
  const rollup = moment.rollup;

  // A live call. Nothing else the owner does is as expensive to talk over, and
  // there is no within-call gradient worth modelling.
  if (rollup.micActive || rollup.cameraActive || rollup.calendarActive) return 1;

  const activity = classifyActivity(rollup.processName, rollup.windowTitles.at(-1) ?? '', state.config.leisureRules);
  // `ambient` is music behind work, not rest — the same distinction `computeMomentKind`
  // draws, and for the same reason: treating it as leisure would license interrupting
  // someone who is in fact working.
  const base = activity === 'personal' ? LEISURE_COST : WORK_COST;

  // `inputEventCount`, NOT `typingEventCount`. The latter counts `input:activity`
  // EMISSIONS, and that sensor fires on a fixed cadence whenever the daemon is up
  // regardless of activity — so it measures elapsed observed time, and reading it
  // here would have priced a long idle moment as maximally busy. The real key and
  // click counts have always been on the payload; `momentRollup` began accumulating
  // them 2026-08-14 precisely so this decision could be made on activity rather than
  // on presence. This is Activity Frames' 45%-presence-only finding, in one field.
  //
  // Saturating, not linear: the gap between silence and work carries far more
  // information than the gap between brisk and furious.
  const input = rollup.inputEventCount ?? 0;
  const moving = input <= 0 ? 0 : Math.min(1, input / INPUT_SATURATION);

  let cost = Math.min(1, base * (QUIET_FLOOR + (1 - QUIET_FLOOR) * moving));

  // J2.1's GATE — off by default. The owner-state filter may price an
  // interruption only once two weeks of self-report taps put its Brier at or
  // under 0.15; until then the flag stays false and this line is inert.
  if (state.config.experiments?.ownerStateInGateCost) {
    const focus = state.owner?.focus;
    if (focus) cost = Math.max(cost, focus.alpha / (focus.alpha + focus.beta));
  }
  // J3.1 — a short night, in the morning, makes every interruption dearer. A
  // sensor reading, not a judge's, so it needs no bar; Health sends the span.
  const sleep = state.owner?.energy?.sleepHours;
  if (now !== null && typeof sleep === 'number' && sleep < SHORT_NIGHT_HOURS && localHourOf(now, state.config.timezone) < MORNING_ENDS_HOUR) cost = Math.min(1, cost + SHORT_NIGHT_COST);

  return cost;
}

const SHORT_NIGHT_HOURS = 6;
const MORNING_ENDS_HOUR = 11;
const SHORT_NIGHT_COST = 0.2;
/** The event's own hour in the owner's zone — never the wall clock, so a replay prices the same night the same way. */
function localHourOf(iso: string, timeZone: string): number {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone }).format(new Date(iso)));
  } catch {
    return new Date(iso).getUTCHours();
  }
}

/** Work costs the full price at full typing; the owner's own time costs a fifth of it. */
const WORK_COST = 1;
const LEISURE_COST = 0.2;
/**
 * Real input events (keys + clicks) within the open moment at which cost saturates.
 *
 * The live sensor reports up to ~44 key presses in a single 10-second window, so a
 * few hundred is an ordinary few minutes of writing. 200 puts saturation at roughly
 * a minute of steady work — long enough that a stray keystroke does not read as deep
 * focus, short enough that genuine work reaches full cost quickly.
 */
const INPUT_SATURATION = 200;
/**
 * Cost of a silent moment as a fraction of a busy one.
 *
 * Not zero: a quiet moment is often reading or thinking, not absence, and inactivity
 * is an imperfect proxy for low cognitive load — Codellaborator says so explicitly
 * ("high mental workload often manifests as stillness during problem-solving"). The
 * floor is what stops this rule from mistaking concentration for availability.
 */
const QUIET_FLOOR = 0.4;

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
const MAX_RECENT_PHASIC = 20;

/** Bound on the defer ring. Small on purpose: a queue nobody drains is a memory leak wearing a feature's name. */
export const MAX_DEFERRED = 8;

/**
 * One decision, as a durable effect for the `gate_decisions` table
 * (`unsaid-room-gate-decision-persistence`). The id derives from the
 * triggering event's ts/id plus the candidate's key, so an arrival decision
 * and each re-scoring tick's decision get distinct rows, while a boot replay
 * of the same event offers the identical row (`onConflictDoNothing`).
 */
/** The decision row's id, from the candidate event alone — so J1.6's features can find the row they belong to without a read. */
export const gateDecisionId = (ts: string, eventId: string, key: string): string => deriveId(ts, eventId, 'notice-gate', 'decision', key);

function decisionEffect(candidate: NoticeCandidate, decision: Decision, ts: string, eventId: string, policy: GatePolicy): Effect {
  return {
    type: 'RecordGateDecision',
    id: gateDecisionId(ts, eventId, candidate.key),
    noticeKey: candidate.key,
    kind: candidate.kind,
    channel: decision.channel,
    reason: decision.reason,
    weight: decision.weight,
    utility: decision.utility,
    surprise: decision.terms.surprise,
    precision: decision.terms.precision,
    habituation: decision.terms.habituation,
    concern: decision.terms.concern,
    interruptionCost: decision.terms.cost,
    // K0.2 — the bars as the dial left them, not as the policy ships them.
    tonicBar: policy.tonicThreshold,
    phasicBar: policy.phasicThreshold,
    decidedAt: ts,
  };
}

/**
 * Applies one decision, returning the state and effects it implies.
 *
 * Shared by the `notice:candidate` path and the `clock:tick` re-scoring path below,
 * so a deferred candidate that later clears the bar is delivered by exactly the same
 * code — and habituates, and spends budget — as one that cleared it first time.
 *
 * Every decision that passes through here also emits a `RecordGateDecision`
 * effect (appended LAST, after the delivery effect). The suppressed path
 * therefore stops being effect-free — the almanac page accepts exactly that
 * trade: persistence as an effect, not as state, so `reduce` replay cost is
 * one small object per candidate and nothing downstream folds over it.
 */
/**
 * Passes an `owner-question` candidate's `askId` through to the delivery
 * payload, the same additive way `noticeKey` rides along.
 *
 * The gate does not read it and no policy depends on it: without it the
 * companion would deliver Gnomon's own question but have no id to record the
 * answer against, so the answer would land nowhere. Absent on every other
 * candidate, which is why it spreads rather than being a fixed key.
 */
function askIdOf(candidate: NoticeCandidate): { askId?: string } {
  const askId = (candidate as unknown as { askId?: unknown }).askId;
  return typeof askId === 'string' && askId !== '' ? { askId } : {};
}

function applyDecision(
  state: KernelState,
  candidate: NoticeCandidate,
  decision: Decision,
  ts: string,
  localDay: string,
  policy: GatePolicy,
  deferred: DeferredNotice[],
  eventId: string,
): { state: KernelState; effects: Effect[] } {
  const gateState: NoticeState = { habituation: state.notices.habituation, day: state.notices.day, spentToday: state.notices.spentToday };
  const record = decisionEffect(candidate, decision, ts, eventId, policy);

  if (decision.channel === 'suppressed') {
    // Not even the budget day is advanced. A suppressed candidate must leave no
    // trace in the gate's memory, or a stream that offers the same thing repeatedly
    // would habituate itself into silence before ever being said once.
    //
    // Returns the SAME state object when the defer ring is untouched, not a copy
    // with equal contents. Suppression is the overwhelmingly common outcome — 110
    // of every 121 candidates on the corpus — so allocating a fresh state for each
    // one would churn the hot path of a two-million-event replay for nothing.
    if (deferred === state.notices.deferred) return { state, effects: [record] };
    return { state: { ...state, notices: { ...state.notices, deferred } }, effects: [record] };
  }

  if (decision.channel === 'deferred') {
    // Held, not delivered: no habituation, no budget. Both are consequences of the
    // owner having been told something, and nobody has been told anything yet.
    const already = deferred.some((d) => d.candidate.key === candidate.key);
    const nextDeferred = already ? deferred : [...deferred, { candidate, since: ts, reconsidered: 0 }].slice(-MAX_DEFERRED);
    return { state: { ...state, notices: { ...state.notices, deferred: nextDeferred } }, effects: [record] };
  }

  const next = applyDelivery(gateState, candidate, ts, localDay, decision.channel, policy);
  const event = { ts };
  const notDeferred = deferred.filter((d) => d.candidate.key !== candidate.key);

  if (decision.channel === 'phasic') {
    const phasic: PhasicNotice = { kind: candidate.kind, observation: candidate.observation, evidence: candidate.evidence, weight: Math.round(decision.weight * 1000) / 1000, at: event.ts };
    return {
      state: { ...state, notices: { ...next, recentPhasic: [...state.notices.recentPhasic, phasic].slice(-MAX_RECENT_PHASIC), deferred: notDeferred } },
      effects: [
        // `noticeKey` rides on the payload (2026-08-15) so the delivery channel —
        // the harness's companion agent — can name the gate entry when the owner
        // answers `not-now`. Additive: no consumer matched on the payload shape.
        { type: 'Notify', channel: 'phasic-notice', payload: { kind: candidate.kind, observation: candidate.observation, evidence: candidate.evidence, weight: phasic.weight, noticeKey: candidate.key, ...askIdOf(candidate) } },
        record,
      ],
    };
  }

  return {
    state: { ...state, notices: { ...next, recentPhasic: state.notices.recentPhasic, deferred: notDeferred } },
    effects: [
      // The tonic admission's own delivery event (2026-08-15). The ScheduleLLM
      // below produces the polished knowledge entry MINUTES later (LLM latency,
      // budget willing); this Notify is what lets the delivery channel inject
      // the raw observation as ambient context NOW, without a wake-up — the
      // "tonic → inject only" half of `notice-delivery-channel`.
      {
        type: 'Notify',
        channel: 'tonic-notice',
        payload: { kind: candidate.kind, observation: candidate.observation, evidence: candidate.evidence, weight: Math.round(decision.weight * 1000) / 1000, noticeKey: candidate.key, ...askIdOf(candidate) },
      },
      {
        type: 'ScheduleLLM',
        purpose: 'companion',
        momentId: state.moment?.id ?? null,
        delayMs: 0,
        // `noticeKey` rides along so the delivered insight can be traced back to the
        // gate entry that produced it — the join `feedbackTrack` needs to habituate a
        // key the owner answered `not-now` to. Without it the verdict knows only a
        // `knowledge_entries` id, which the gate has never seen.
        metadata: { kind: candidate.kind, noticeKey: candidate.key },
        messages: [
          {
            role: 'system',
            content: withPersona(
              NO_DIAGNOSIS,
              'You are writing one short, factual note about something you noticed in that record.',
              'Respond with STRICT JSON only, no markdown fencing, matching exactly: {"title": "...", "body": "...", "severity": "info"|"warning"}. Title under 60 characters, body one or two sentences, plain language, no judgment and no advice.',
              'Ground the note ENTIRELY in the observation and evidence given — never add a cause, a feeling, or a recommendation. You have no tools here and no wider view of the day; the two lines below are the whole of what you know. If the observation is about something that did NOT happen, say so plainly rather than describing what did.',
            ),
          },
          { role: 'user', content: [candidate.observation, candidate.evidence.length > 0 ? `Evidence: ${candidate.evidence.join('; ')}.` : null].filter((line): line is string => line !== null).join('\n') },
        ],
      },
      record,
    ],
  };
};

/**
 * The one place a candidate becomes something the owner sees. Single writer of
 * `state.notices`.
 *
 * Two entry points, one decision function. A `notice:candidate` is judged on
 * arrival; `clock:tick` re-judges anything deferred, because the only term that
 * changed is the cost of interrupting and that is a property of the moment rather
 * than of the candidate. A deferred candidate delivered later goes through exactly
 * the same `applyDecision`, so it habituates its key and spends the budget on the
 * same terms as one that landed first time.
 */
export const noticeGate: Rule = (state, event) => {
  // The owner's settings are the outermost gate. `autonomy: 'off'` means
  // Gnomon answers and nothing else, so no candidate is even weighed; the bias
  // moves both thresholds together, so the dial nudges the same bar the policy
  // already uses rather than introducing a second one.
  const settings = state.settings;
  const scale = 2 ** (settings?.noticeBias ?? 0);
  const policy: GatePolicy =
    scale === 1 ? DEFAULT_GATE_POLICY : { ...DEFAULT_GATE_POLICY, tonicThreshold: DEFAULT_GATE_POLICY.tonicThreshold * scale, phasicThreshold: DEFAULT_GATE_POLICY.phasicThreshold * scale };

  // The owner answered a question that is still waiting its turn in the ring
  // (asked mid-call, deferred, answered in the web seat before the gate got
  // round to it). Delivering it later would ask a question already answered.
  if (event.type === 'ask:owner-answered') {
    const askId = typeof event.payload.askId === 'string' ? event.payload.askId.trim() : '';
    if (askId === '' || state.notices.deferred.length === 0) return { state, effects: [] };
    const remaining = state.notices.deferred.filter((entry) => {
      const carried = (entry.candidate as unknown as { askId?: unknown }).askId;
      return carried !== askId && entry.candidate.key !== askId && entry.candidate.key !== `owner-ask:${askId}`;
    });
    if (remaining.length === state.notices.deferred.length) return { state, effects: [] };
    return { state: { ...state, notices: { ...state.notices, deferred: remaining } }, effects: [] };
  }

  if (event.type === 'clock:tick') {
    const held = state.notices.deferred;
    if (held.length === 0) return { state, effects: [] };

    const localDay = localDate(event.ts, state.config.timezone);
    const nowMs = Date.parse(event.ts);
    const cost = interruptionCostOf(state, event.ts);

    // Retire anything whose value has decayed past usefulness before re-scoring the
    // rest. A deferred candidate is not owed delivery — it is owed a fair second
    // look while it still matters, which is what `valueHalfLifeMs` measures.
    const live: DeferredNotice[] = [];
    for (const entry of held) {
      const halfLife = entry.candidate.valueHalfLifeMs;
      const expired = halfLife !== null && nowMs - Date.parse(entry.since) > halfLife;
      if (!expired) live.push({ ...entry, reconsidered: entry.reconsidered + 1 });
    }
    if (live.length === 0) return { state: { ...state, notices: { ...state.notices, deferred: [] } }, effects: [] };

    // At most one deferred candidate is released per tick: releasing a backlog all
    // at once is precisely the burst the gate exists to prevent, and the owner
    // stepping away from a focus block should not be met with four alerts.
    const gateState: NoticeState = { habituation: state.notices.habituation, day: state.notices.day, spentToday: state.notices.spentToday };
    // Decision records for held candidates the re-score RETIRES this tick. A
    // still-deferred re-score deliberately writes nothing — one row per tick
    // per held candidate would be noise, and its verdict has not changed.
    const retired: Effect[] = [];
    for (let i = 0; i < live.length; i++) {
      const entry = live[i]!;
      const decision = decide(policy, gateState, entry.candidate, event.ts, localDay, cost);
      if (decision.channel === 'phasic' || decision.channel === 'tonic') {
        const remaining = live.filter((_, index) => index !== i);
        const applied = applyDecision(state, entry.candidate, decision, event.ts, localDay, policy, remaining, event.id);
        return { state: applied.state, effects: [...applied.effects, ...retired] };
      }
      // Still too costly, or now genuinely not worth saying — `decide` settles which.
      if (decision.channel === 'suppressed') {
        retired.push(decisionEffect(entry.candidate, decision, event.ts, event.id, policy));
        live.splice(i--, 1);
      }
    }

    return { state: { ...state, notices: { ...state.notices, deferred: live } }, effects: retired };
  }

  if (event.type !== 'notice:candidate') return { state, effects: [] };
  // Silent by the owner's own setting. Recorded as a decision like any other
  // suppression, so the Unsaid surface can say WHY it never heard of this.
  if (settings?.autonomy === 'off') {
    const quiet = event.payload as unknown as NoticeCandidate;
    if (typeof quiet?.key !== 'string') return { state, effects: [] };
    return {
      state,
      effects: [
        decisionEffect(
          quiet,
          { channel: 'suppressed', reason: 'owner-silent', weight: 0, utility: 0, terms: { surprise: 0, precision: 0, habituation: 0, concern: 0, cost: 0 } },
          event.ts,
          event.id,
          policy,
        ),
      ],
    };
  }

  const candidate = event.payload as unknown as NoticeCandidate;
  if (typeof candidate?.key !== 'string' || typeof candidate.surprise !== 'number' || typeof candidate.precision !== 'number') return { state, effects: [] };

  const localDay = localDate(event.ts, state.config.timezone);
  const gateState: NoticeState = { habituation: state.notices.habituation, day: state.notices.day, spentToday: state.notices.spentToday };
  // The rule reads state and reduces it to a number; `decide` never sees the state.
  // That split is what keeps five-policies-one-replay affordable.
  const decision = decide(policy, gateState, candidate, event.ts, localDay, interruptionCostOf(state, event.ts));

  return applyDecision(state, candidate, decision, event.ts, localDay, policy, state.notices.deferred, event.id);
};
