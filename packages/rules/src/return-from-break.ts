import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { classifyActivity } from '@sundial/helpers/window-classification.js';
import type { Commitment, Effect, KernelState, NoticeCandidate, Rule } from '@sundial/kernel/types.js';

/**
 * One `input:activity` window, from the sensor's own `EMIT_WINDOW_MS`. The break
 * length is `consecutiveZeroWindows` of these, so this is the only unit available
 * to size it — there is no learned distribution of break DURATIONS (the `break`
 * occurrence stream learns the interval BETWEEN breaks, not how long one lasts).
 */
const EMIT_WINDOW_MS = 10_000;
const MINUTE = 60_000;

/**
 * Below this, a pause is not a break worth a check-in — a bathroom trip, a phone
 * glance. Keeping the FLOOR here (not just in the gate) is deliberate: it holds the
 * candidate STREAM down rather than relying on `noticeGate` to suppress a flood, the
 * same discipline `anomalyZscore`'s own emission floor follows. Fifteen minutes is
 * long enough that the owner has genuinely context-switched (lost their place), short
 * enough to still be a break rather than an errand.
 */
const MIN_BREAK_MS = 15 * MINUTE;
/**
 * Above this it is not "stepped away for a bit", it is end-of-day, a meeting off the
 * machine, or an open laptop left overnight — none of which is a break to reconnect a
 * thread after. Without this cap a laptop left on all night would produce a
 * "back after 600 minutes" the morning it is touched, an enormous surprise on a
 * non-event.
 */
const MAX_BREAK_MS = 4 * 3_600_000;
/**
 * The break length at which surprise reaches 1.0. A return from an ordinary break
 * reads as unremarkable; only a genuinely long absence carries weight. Combined with
 * the honest precision below and the short half-life (phasic channel), the effective
 * bar is high: with `concernGain` 1.5 a candidate only clears `phasicThreshold` (1.6)
 * once the break is well over an hour, so ordinary breaks stay silent by construction.
 */
const REFERENCE_BREAK_MS = 30 * MINUTE;
/** From here up a return is worth interrupting for; below it is worth knowing. */
const LONG_BREAK_MS = 60 * MINUTE;
/**
 * Honest, and deliberately low. A return-from-break is a routine transition, not a
 * measured expectation being violated; it earns attention only when the absence was
 * long AND there is an open thread to reconnect — never on its own.
 */
/**
 * A thread touched shortly before the break is a HOT anchor: "you were on
 * BOX-484 when you stepped away" is checkable and useful. A thread last
 * touched three days ago is not what the owner left; it is just the newest
 * open branch. Thirty-nine candidates in a month were suppressed at the old
 * flat precision of 0.4 — with a hot anchor the claim is stronger, and without
 * one there is no candidate at all.
 */
export const HOT_ANCHOR_MS = 3 * 60 * MINUTE;
export const HOT_PRECISION = 0.7;
/**
 * Useful for a few minutes and worthless after. "The thread you left" is a reconnect
 * prompt at the instant of return; an hour later the owner has already re-oriented, so
 * this decays fast and routes to the phasic channel (see `noticeGate.decide`), which
 * carries its own high bar rather than competing for the one-a-day tonic budget that
 * the higher-value omission/commitment notices depend on.
 */
const VALUE_HALF_LIFE_MS = 10 * MINUTE;

interface InputActivityPayload {
  keyDownCount?: number;
  mouseClickCount?: number;
  mouseMoveCount?: number;
  scrollCount?: number;
}

/** Mirrors `idleTrack`'s own definition of a non-empty window — a real return, not another zero window. */
function hasActivity(payload: InputActivityPayload): boolean {
  return (payload.keyDownCount ?? 0) > 0 || (payload.mouseClickCount ?? 0) > 0 || (payload.mouseMoveCount ?? 0) > 0 || (payload.scrollCount ?? 0) > 0;
}

function fmtMinutes(ms: number): string {
  const min = Math.max(1, Math.round(ms / MINUTE));
  if (min < 60) return `${min} min`;
  const hours = Math.round((min / 60) * 10) / 10;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** The open thread the owner most recently touched — the one "you left". */
function mostRecentOpenThread(state: KernelState): Commitment | null {
  let best: Commitment | null = null;
  for (const c of state.commitments.open) {
    if (!best || Date.parse(c.lastTouchedAt) > Date.parse(best.lastTouchedAt)) best = c;
  }
  return best;
}

/**
 * A light check-in when a work break ENDS: "back after ~40 min — want the thread you
 * left?".
 *
 * ## Why this is a producer at all
 *
 * Every omission producer notices something that did NOT happen; this notices a
 * TRANSITION that did — the moment of return, which is exactly when a reconnect prompt
 * is worth anything and never again. It is the complement of `absent:break`, not a
 * duplicate: that one fires when a break is overdue (too long WITHOUT a break), this
 * fires when an unusually long break ENDS and there is a thread to pick back up.
 *
 * ## Read the idle state BEFORE `idleTrack` clears it — the placement is load-bearing
 *
 * `idleTrack` resets `consecutiveZeroWindows` to 0 and flips `isIdle` off on the very
 * `input:activity` event that ends a break, and emits `idle:end` only afterwards (in a
 * later recursive `reduce` pass, by which time the count is already gone). So the break
 * length is only legible on the returning event itself, and only to a rule that folds
 * BEFORE `idleTrack`. This rule therefore rides `input:activity` and reads the
 * still-idle state directly, rather than reacting to `idle:end` where the duration has
 * already been erased. `RULE_MANIFEST` places it immediately before `idleTrack`.
 *
 * ## Gated to genuinely-useful returns, not every pause
 *
 * A pure producer states what it saw and lets `noticeGate` decide — but a producer
 * that offered a candidate on every idle:end would flood the stream, so the WELL-
 * FOUNDED conditions live here (the same split `expectationWatch` draws): the break was
 * real (25 min – 4 h), the owner is returning to WORK not leisure, and there is an open
 * commitment to reconnect. With no open thread there is nothing to say, so it stays
 * silent — which is most of the point of "useful, not yappin".
 */
export const returnFromBreak: Rule = (state, event) => {
  if (event.type !== 'input:activity') return { state, effects: [] };

  // Pre-transition idle state: this rule folds before `idleTrack`, so these still
  // describe the break that is ending on THIS event.
  const idle = state.lifeEvent.idle;
  if (!idle.isIdle) return { state, effects: [] };
  if (!hasActivity(event.payload as InputActivityPayload)) return { state, effects: [] };

  const breakMs = idle.consecutiveZeroWindows * EMIT_WINDOW_MS;
  if (breakMs < MIN_BREAK_MS || breakMs > MAX_BREAK_MS) return { state, effects: [] };

  // Nothing to reconnect to → nothing worth saying. This is the condition that keeps
  // the producer quiet the overwhelming majority of the time.
  const thread = mostRecentOpenThread(state);
  if (!thread) return { state, effects: [] };

  // Hot anchor only: the thread must have been touched within a few hours
  // BEFORE the break began, or it is not the thread the owner left.
  const breakStartMs = Date.parse(event.ts) - breakMs;
  const touchedMs = Date.parse(thread.lastTouchedAt);
  if (!(touchedMs <= breakStartMs + EMIT_WINDOW_MS && breakStartMs - touchedMs <= HOT_ANCHOR_MS)) return { state, effects: [] };

  // Returning to leisure is not returning to a work thread. `state.window.active` is the
  // last window seen before the break; if it reads as the owner's own time, this nudge
  // would be an intrusion rather than a help.
  const active = state.window.active;
  if (active && classifyActivity(active.processName, active.windowTitle, state.config.leisureRules) === 'personal') {
    return { state, effects: [] };
  }

  const surprise = Math.min(breakMs, MAX_BREAK_MS) / REFERENCE_BREAK_MS;

  const candidate: NoticeCandidate = {
    shape: 'transition',
    kind: 'return-from-break',
    // Once per local day: a second long break the same day habituates rather than
    // re-announcing. Keeping it constant within the day is what makes habituation do
    // that work.
    key: `return-from-break:${localDate(event.ts, state.config.timezone)}`,
    surprise,
    precision: HOT_PRECISION,
    // A SHORT break is ambient, a LONG one is worth a word. `valueHalfLifeMs` is
    // what routes a candidate to the urgent (phasic) path in the gate, and the
    // first version sent every break there. At the rule's own honest precision
    // of 0.4 a 30-minute break weighs 0.6 with an open thread — far under the
    // 1.6 phasic bar — so the producer fired 13 times in a week and was dropped
    // every time. Below an hour it is now tonic: it clears the 0.55 tonic bar,
    // and lands as context for the next turn rather than as an interruption,
    // which is what "you're back — you were on BOX-484" should be.
    valueHalfLifeMs: breakMs >= LONG_BREAK_MS ? VALUE_HALF_LIFE_MS : null,
    observation: `Back after ${fmtMinutes(breakMs)} away — the open thread you left was ${thread.name}`,
    evidence: [`away ${fmtMinutes(breakMs)}`, `branch ${thread.branch}`, `last touched ${thread.lastTouchedAt.slice(0, 10)}`],
    concerns: [thread.id],
  };

  const effect: Effect = {
    type: 'EmitEvent',
    event: {
      id: deriveId(event.ts, event.id, 'return-from-break', candidate.key),
      type: 'notice:candidate',
      ts: event.ts,
      payload: { timestamp: event.ts, ...candidate },
    },
  };

  return { state, effects: [effect] };
};
