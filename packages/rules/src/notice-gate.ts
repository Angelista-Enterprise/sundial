import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { classifyActivity } from '@sundial/helpers/window-classification.js';
import { NO_DIAGNOSIS, withPersona } from '@sundial/kernel/persona.js';
import { isZeroActivity } from './idle-track.js';
import { routeFor } from './notice-route.js';
import { isQuieted, noticeTitle } from '@sundial/kernel/notice-groups.js';
import { NOT_A_CALL_APPS } from '@sundial/kernel/watch.js';
import type { DeferredNotice, Effect, KernelState, NoticeCandidate, PhasicNotice, Rule } from '@sundial/kernel/types.js';

export { DEFAULT_GATE_POLICY, MAX_HABITUATION_KEYS, applyDelivery, decide, habituatedGain, policyForBias, simulateGate } from '@sundial/kernel/gate.js';
export type { Channel, Decision, DecisionTerms, GatePolicy, GateSimulation, NoticeState } from '@sundial/kernel/gate.js';
import { applyDelivery, decide, policyForBias, type Decision, type GatePolicy, type NoticeState } from '@sundial/kernel/gate.js';

/**
 * A call or a meeting now: an app holding the microphone, or the open moment's
 * camera or calendar. Not Gnomon's own hearing, which holds the mic too: the
 * moment's `micActive` stays on once any app used it, so it is not read.
 */
export function inCall(state: KernelState): boolean {
  const call = state.av?.call;
  const rollup = state.moment?.rollup;
  const theirs = !!call && !NOT_A_CALL_APPS.some((name) => call.app.toLowerCase().includes(name));
  return theirs || !!(rollup && (rollup.cameraActive || rollup.calendarActive));
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
  // A live call. Nothing else the owner does is as expensive to talk over, and
  // there is no within-call gradient worth modelling.
  if (inCall(state)) return 1;
  const moment = state.moment;
  if (!moment) return 0; // Nothing open to interrupt.
  const rollup = moment.rollup;

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

const MAX_RECENT_PHASIC = 20;

/** The gate's slice of `state.notices`, with today's interruptions counted from the phasic queue. */
function gateStateOf(state: KernelState, localDay: string): NoticeState {
  const { habituation, day, spentToday, recentPhasic } = state.notices;
  const phasicToday = recentPhasic.filter((p) => localDate(p.at, state.config.timezone) === localDay).length;
  return { habituation, day: localDay, spentToday: day === localDay ? spentToday : 0, phasicToday };
}

/** Bound on the defer ring. Small on purpose: a queue nobody drains is a memory leak wearing a feature's name. */
export const MAX_DEFERRED = 8;

/**
 * One decision, as a durable effect for the `gate_decisions` table
 * (`architecture/rules/noticing-and-expectations`). The id derives from the
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
const isPlain = (candidate: NoticeCandidate) => (candidate as unknown as { plain?: unknown }).plain === true;

function askIdOf(candidate: NoticeCandidate): { askId?: string; plain?: true } {
  const askId = (candidate as unknown as { askId?: unknown }).askId;
  // UC4 §10: a watch rule marked plain is delivered as its own sentence — banner and push — with no model turn behind it.
  const plain = isPlain(candidate) ? { plain: true as const } : {};
  return typeof askId === 'string' && askId !== '' ? { askId, ...plain } : plain;
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
  // lane D — #6: an interruption the route holds (a call, a focus mode) waits in
  // the defer ring like a too-costly one. The tick releases it when the hold ends.
  const route = routeFor(state.route, candidate.kind);
  if (decision.channel === 'phasic' && route === 'hold') decision = { ...decision, channel: 'deferred', reason: state.route.reason === 'call' ? 'held-call' : 'held-focus' };

  const gateState = gateStateOf(state, localDay);
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
    const grown = already ? deferred : [...deferred, { candidate, since: ts, reconsidered: 0 }];
    // lane D — #6: a full ring lets its oldest go WITH a record, never in silence.
    const displaced = grown.slice(0, Math.max(0, grown.length - MAX_DEFERRED)).map((d) => decisionEffect(d.candidate, { ...decision, channel: 'suppressed', reason: 'displaced' }, ts, eventId, policy));
    return { state: { ...state, notices: { ...state.notices, deferred: grown.slice(-MAX_DEFERRED) } }, effects: [record, ...displaced] };
  }

  const next = applyDelivery(gateState, candidate, ts, localDay, decision.channel, policy);
  const event = { ts };
  const notDeferred = deferred.filter((d) => d.candidate.key !== candidate.key);

  if (decision.channel === 'phasic') {
    const phasic: PhasicNotice = { kind: candidate.kind, observation: candidate.observation, evidence: candidate.evidence, weight: Math.round(decision.weight * 1000) / 1000, at: event.ts };
    return {
      state: { ...state, notices: { ...state.notices, ...next, recentPhasic: [...state.notices.recentPhasic, phasic].slice(-MAX_RECENT_PHASIC), deferred: notDeferred } },
      effects: [
        // `noticeKey` rides on the payload (2026-08-15) so the delivery channel —
        // the harness's companion agent — can name the gate entry when the owner
        // answers `not-now`. Additive: no consumer matched on the payload shape.
        // `route` (lane D, #6): where the delivery plugin sends it — `mac` or `phone`. It never decides.
        { type: 'Notify', channel: 'phasic-notice', payload: { kind: candidate.kind, observation: candidate.observation, evidence: candidate.evidence, weight: phasic.weight, noticeKey: candidate.key, ...askIdOf(candidate), route, title: noticeTitle(candidate.kind) } }, // lane H (H4): the push's title
        record,
      ],
    };
  }

  return {
    state: { ...state, notices: { ...state.notices, ...next, deferred: notDeferred } },
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
      // A plain rule's note is its own sentence: no model call writes it up.
      ...(isPlain(candidate)
        ? []
        : ([
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
          ] satisfies Effect[])),
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
  const policy = policyForBias(settings?.noticeBias ?? 0);

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

  // Away and back (UC2 finding 3, the long-absence half). Idle or asleep
  // starts the clock; the first real input ends it and weighs what was held.
  if (event.type === 'idle:start' || (event.type === 'system:sleep-wake' && (event.payload as { kind?: unknown }).kind === 'sleep')) {
    if (state.notices.away?.since) return { state, effects: [] };
    return { state: { ...state, notices: { ...state.notices, away: { since: event.ts, held: state.notices.away?.held ?? [] } } }, effects: [] };
  }
  if (event.type === 'input:activity') {
    const away = state.notices.away;
    if (!away?.since || isZeroActivity(event.payload)) return { state, effects: [] };
    return welcomeBack(state, event.ts, event.id, policy, away.held);
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
    const gateState = gateStateOf(state, localDay);
    // Decision records for held candidates the re-score RETIRES this tick. A
    // still-deferred re-score deliberately writes nothing — one row per tick
    // per held candidate would be noise, and its verdict has not changed.
    // An expiry is a retirement too: until 2026-09-28 it wrote nothing, so a
    // held notice that ran out of time stayed "held" on the Unsaid card for good.
    const retired: Effect[] = [];
    const live: DeferredNotice[] = [];
    for (const entry of held) {
      const halfLife = entry.candidate.valueHalfLifeMs;
      const expired = halfLife !== null && nowMs - Date.parse(entry.since) > halfLife;
      if (!expired) live.push({ ...entry, reconsidered: entry.reconsidered + 1 });
      else retired.push(decisionEffect(entry.candidate, { ...decide(policy, gateState, entry.candidate, event.ts, localDay, cost), channel: 'suppressed', reason: 'expired' }, event.ts, event.id, policy));
    }
    if (live.length === 0) return { state: { ...state, notices: { ...state.notices, deferred: [] } }, effects: retired };

    // At most one deferred candidate is released per tick: releasing a backlog all
    // at once is precisely the burst the gate exists to prevent, and the owner
    // stepping away from a focus block should not be met with four alerts.
    for (let i = 0; i < live.length; i++) {
      const entry = live[i]!;
      // lane D — #6: still in the call or the focus. It waits, without a row per tick.
      if (routeFor(state.route, entry.candidate.kind) === 'hold') continue;
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
  const offered = event.payload as unknown as NoticeCandidate;
  const quietGroup = isQuieted(settings?.quiet, offered?.kind);
  if (settings?.autonomy === 'off' || quietGroup) {
    const quiet = offered;
    if (typeof quiet?.key !== 'string') return { state, effects: [] };
    return {
      state,
      effects: [
        decisionEffect(
          quiet,
          { channel: 'suppressed', reason: settings?.autonomy === 'off' ? 'owner-silent' : 'owner-quiet', weight: 0, utility: 0, terms: { surprise: 0, precision: 0, habituation: 0, concern: 0, cost: 0 } },
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
  const gateState = gateStateOf(state, localDay);
  // The rule reads state and reduces it to a number; `decide` never sees the state.
  // That split is what keeps five-policies-one-replay affordable.
  const decision = decide(policy, gateState, candidate, event.ts, localDay, interruptionCostOf(state, event.ts));

  // An hour or more away: something worth a row in the list waits for the
  // owner rather than landing now, where only an empty room would read it.
  // Interruptions are not held — they already reach the phone.
  const away = state.notices.away;
  if (decision.channel === 'tonic' && away?.since && Date.parse(event.ts) - Date.parse(away.since) >= AWAY_HOLD_AFTER_MS) {
    const held = [...away.held.filter((h) => h.candidate.key !== candidate.key), { candidate, since: event.ts, reconsidered: 0 }].slice(-MAX_HELD_AWAY);
    const record = decisionEffect(candidate, { ...decision, channel: 'deferred', reason: 'owner-away' }, event.ts, event.id, policy);
    return { state: { ...state, notices: { ...state.notices, away: { ...away, held } } }, effects: [record] };
  }

  return applyDecision(state, candidate, decision, event.ts, localDay, policy, state.notices.deferred, event.id);
};

/** Away this long before a tonic notice waits for the return instead of landing. */
export const AWAY_HOLD_AFTER_MS = 60 * 60_000;
/** Held for the return, at most. The newest win: an absence of a week keeps its last few, not its first. */
const MAX_HELD_AWAY = 8;

/**
 * The first real input after an absence: everything held is weighed again NOW,
 * in arrival order, and each goes through the same `applyDecision` a fresh
 * candidate would — so it habituates and spends today's budget, and can still
 * be refused if the budget is gone.
 */
function welcomeBack(state: KernelState, ts: string, eventId: string, policy: GatePolicy, held: DeferredNotice[]): { state: KernelState; effects: Effect[] } {
  let next: KernelState = { ...state, notices: { ...state.notices, away: { since: null, held: [] } } };
  const effects: Effect[] = [];
  const localDay = localDate(ts, state.config.timezone);
  const cost = interruptionCostOf(state, ts);
  for (const entry of held) {
    const decision = decide(policy, gateStateOf(next, localDay), entry.candidate, ts, localDay, cost);
    const applied = applyDecision(next, entry.candidate, decision, ts, localDay, policy, next.notices.deferred, eventId);
    next = applied.state;
    effects.push(...applied.effects);
  }
  return { state: next, effects };
}
