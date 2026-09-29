import type { BetaBelief, Effect, JudgementResultPayload, KernelState, Rule } from '@sundial/kernel/types.js';
import { selfReportDue } from '@sundial/kernel/self-report.js';
import { PERCEIVE_QUESTIONS, perceive } from './questions/perceive.js';

/** The judge's likelihood moves a belief by this much a tick (docs/jarvis/02: small, so one odd reading cannot flip it). */
export const PERCEIVE_WEIGHT = 0.2;
/** Each tick the belief slides this fraction of the way back to the prior, so a stale belief widens on its own. */
export const PERCEIVE_DECAY = 0.9;
const PRIOR: BetaBelief = { alpha: 1, beta: 1 };
/** Input windows kept: the sidecar reports every ~10 s, so six is the last minute. */
const MAX_INPUT_WINDOWS = 6;
const MAX_SELF_REPORTS = 60;
const TEN_MIN_MS = 10 * 60_000;
/** With only the self-report chips reading it, the judge runs at most once an hour: a tap is due all waking day. */
export const PERCEIVE_TAP_INTERVAL_MS = 60 * 60_000;

export const mean = (b: BetaBelief): number => b.alpha / (b.alpha + b.beta);
const decay = (b: BetaBelief): BetaBelief => ({ alpha: PRIOR.alpha + (b.alpha - PRIOR.alpha) * PERCEIVE_DECAY, beta: PRIOR.beta + (b.beta - PRIOR.beta) * PERCEIVE_DECAY });
const update = (b: BetaBelief, p: number): BetaBelief => ({ alpha: b.alpha + p * PERCEIVE_WEIGHT, beta: b.beta + (1 - p) * PERCEIVE_WEIGHT });

function localHour(ts: string, timeZone: string): number {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone }).format(new Date(ts)));
  } catch {
    return new Date(ts).getUTCHours();
  }
}

/** The raw rates for one tick, or null when there is nothing to perceive (no open moment, or the owner is idle). */
export function perceiveInput(state: KernelState, ts: string): ReturnType<typeof perceive.build>['state'] | null {
  const moment = state.moment;
  if (!moment || state.lifeEvent.idle?.isIdle) return null;
  const now = Date.parse(ts);
  const switches = (state.lifeEvent.recentSwitches ?? []).map((s) => Date.parse(s.at)).filter((t) => Number.isFinite(t));
  const lastSwitch = switches.length > 0 ? Math.max(...switches) : null;
  const windows = state.owner.perception.input;
  const windowMs = windows.reduce((sum, w) => sum + w.windowMs, 0);
  const perMinute = (n: number): number => (windowMs > 0 ? Math.round((n / windowMs) * 60_000) : 0);
  const r = moment.rollup;
  return perceive.build({
    switches_last_10_min: switches.filter((t) => now - t <= TEN_MIN_MS).length,
    minutes_since_last_switch: lastSwitch === null ? null : Math.max(0, Math.round((now - lastSwitch) / 60_000)),
    minutes_in_current_session: Math.max(0, Math.round((now - Date.parse(moment.startTime)) / 60_000)),
    distinct_windows_in_session: new Set(r.windowTitles).size,
    keys_per_minute: perMinute(windows.reduce((sum, w) => sum + w.keys, 0)),
    input_events_per_minute: perMinute(windows.reduce((sum, w) => sum + w.events, 0)),
    mic_on: Boolean(r.micActive) || state.av?.call !== null,
    playback_on: Boolean(r.playbackActive),
    calendar_event_active: Boolean(r.calendarActive),
    hour_local: localHour(ts, state.config.timezone),
  }).state;
}

/** The Brier score of the two beliefs against one tap: flow → (1, 0), stuck → (0, 1), meh → (0, 0). */
export function brierOf(pFlow: number, pStuck: number, tap: 'flow' | 'meh' | 'stuck'): number {
  const oFlow = tap === 'flow' ? 1 : 0;
  const oStuck = tap === 'stuck' ? 1 : 0;
  return ((pFlow - oFlow) ** 2 + (pStuck - oStuck) ** 2) / 2;
}

/**
 * J2.1 — the owner-state filter. Four event types:
 * - `input:activity`: keep the last minute of raw counts.
 * - `clock:tick`: decay the beliefs toward the prior, then — with a moment open,
 *   the owner not idle, and something that reads the answer — put the raw
 *   rates to the judge (`perceive`, one call a tick, under its own cap). The
 *   readers are the gate (only behind the flag below) and a due self-report
 *   tap, which is scored against the belief; with neither, the call fed
 *   nothing (1,840 calls in a week, measured 2026-09-28). A tap is due all
 *   waking day, so for the tap alone the judge runs at most once an hour.
 * - `judgement:result` for `perceive`: move each belief by the likelihood.
 * - `owner:self-report`: the owner's tap, scored against the belief it met.
 *
 * Nothing here reaches the gate. `interruptionCostOf` reads these beliefs
 * only behind `config.experiments.ownerStateInGateCost`, which stays off until
 * two weeks of taps put the Brier at or under 0.15 (docs/jarvis/04, J2.1).
 */
export const ownerPerceive: Rule = (state, event) => {
  const owner = state.owner;
  if (event.type === 'input:activity') {
    const p = event.payload as { windowMs?: unknown; keyDownCount?: unknown; mouseClickCount?: unknown; scrollCount?: unknown };
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const keys = num(p.keyDownCount);
    const window = { ts: event.ts, windowMs: num(p.windowMs) || 10_000, keys, events: keys + num(p.mouseClickCount) + num(p.scrollCount) };
    return { state: { ...state, owner: { ...owner, perception: { ...owner.perception, input: [...owner.perception.input, window].slice(-MAX_INPUT_WINDOWS) } } }, effects: [] };
  }
  if (event.type === 'clock:tick') {
    const decayed = { ...owner, focus: decay(owner.focus), stuck: decay(owner.stuck), interruptible: decay(owner.interruptible) };
    const lastJudged = Date.parse(owner.perception.lastJudgedAt ?? '');
    const tapRead = selfReportDue(owner, event.ts, state.config.timezone) && !(Date.parse(event.ts) - lastJudged < PERCEIVE_TAP_INTERVAL_MS);
    const read = state.config.experiments?.ownerStateInGateCost === true || tapRead;
    const input = read ? perceiveInput(state, event.ts) : null;
    if (input === null) return { state: { ...state, owner: decayed }, effects: [] };
    const effects: Effect[] = [{ type: 'Judge', purpose: 'perceive', questionSetId: perceive.id, momentId: state.moment?.id ?? null, delayMs: 0, state: input, questions: PERCEIVE_QUESTIONS, metadata: { at: event.ts } }];
    return { state: { ...state, owner: { ...decayed, perception: { ...decayed.perception, lastJudgedAt: event.ts } } }, effects };
  }
  if (event.type === 'judgement:result') {
    const payload = event.payload as unknown as JudgementResultPayload;
    if (payload.questionSetId !== perceive.id) return { state, effects: [] };
    const noul = (key: string): number | null => (typeof payload.answers?.[key]?.noul === 'number' ? payload.answers[key].noul : null);
    const inFlow = noul('in_flow');
    const stuck = noul('stuck');
    const interruptible = noul('interruptible');
    return {
      state: {
        ...state,
        owner: {
          ...owner,
          focus: inFlow === null ? owner.focus : update(owner.focus, inFlow),
          stuck: stuck === null ? owner.stuck : update(owner.stuck, stuck),
          interruptible: interruptible === null ? owner.interruptible : update(owner.interruptible, interruptible),
        },
      },
      effects: [],
    };
  }
  if (event.type === 'owner:self-report') {
    const raw = (event.payload as { tap?: unknown }).tap;
    if (raw !== 'flow' && raw !== 'meh' && raw !== 'stuck') return { state, effects: [] };
    const tap: 'flow' | 'meh' | 'stuck' = raw;
    const pFlow = mean(owner.focus);
    const pStuck = mean(owner.stuck);
    const brier = brierOf(pFlow, pStuck, tap);
    return {
      state: {
        ...state,
        owner: {
          ...owner,
          selfReports: [...owner.selfReports, { ts: event.ts, tap, pFlow, pStuck, brier }].slice(-MAX_SELF_REPORTS),
          brier: { n: owner.brier.n + 1, sum: owner.brier.sum + brier, firstAt: owner.brier.firstAt ?? event.ts },
        },
      },
      effects: [],
    };
  }
  return { state, effects: [] };
};
