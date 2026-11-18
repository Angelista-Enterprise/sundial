import { deriveId } from '@sundial/helpers/derive-id.js';
import { wakingDate } from '@sundial/helpers/local-day.js';
import type { Effect, Rule } from '@sundial/kernel/types.js';
import { byGnomonMarked } from './by-gnomon.js';

// Each `input:activity` window is ~10s (packages/sensors/src/input-activity/
// index.ts's EMIT_WINDOW_MS) — 30 consecutive zero-activity windows is ~5
// minutes of genuine inactivity before calling it idle, not just a pause
// between keystrokes.
const IDLE_THRESHOLD_WINDOWS = 30;

interface InputActivityPayload {
  keyDownCount?: number;
  mouseClickCount?: number;
  mouseMoveCount?: number;
  scrollCount?: number;
  /** Set 2 R5: a newer input helper's hardware-only fields (packages/sensors/src/input-activity). */
  ownerOnly?: boolean;
  lastKeyAt?: string;
  lastClickAt?: string;
}

/**
 * The owner's last key or click. From a helper that writes the hardware-only times (`ownerOnly`): the newest of
 * them and the one before, with no by-Gnomon filtering (a posted event never sets them). From an older helper:
 * the end of the last window with a key or click that `byGnomon` did not mark (Set 2 R4).
 */
export function ownerHandAt(p: InputActivityPayload, ts: string, marked: boolean, was: string | null): string | null {
  if (p.ownerOnly === true) {
    const times = [was, p.lastKeyAt, p.lastClickAt].filter((t): t is string => typeof t === 'string' && Number.isFinite(Date.parse(t)));
    return times.reduce<string | null>((a, b) => (a === null || Date.parse(b) > Date.parse(a) ? b : a), null);
  }
  return ((p.keyDownCount ?? 0) > 0 || (p.mouseClickCount ?? 0) > 0) && !marked ? ts : was;
}

export function isZeroActivity(payload: InputActivityPayload): boolean {
  return (payload.keyDownCount ?? 0) === 0 && (payload.mouseClickCount ?? 0) === 0 && (payload.mouseMoveCount ?? 0) === 0 && (payload.scrollCount ?? 0) === 0;
}

/**
 * B3 (docs/audit/production-proposal-and-enhancements.md) — the
 * input-activity sidecar already counts events every ~10s; this rule just
 * counts consecutive zero-activity windows and emits `idle:start` once the
 * threshold is crossed, `idle:end` on the first non-zero window after
 * having been idle. Unblocks the `interruption` life-event's stated-but-
 * missing micro-break path, fixes all-night-session anomaly blindness
 * (A§3.4 — a long session in one window was invisible until the user
 * finally switched away), and gives `momentClose` (B1) a real idle-gap
 * boundary instead of only a system-process gap.
 */
/**
 * The first touch of the day: the owner's first real input of a waking day
 * (`wakingDate`, so work at 00:30 still belongs to the evening before), raised
 * once as `owner:first-touch` for the rules that start the day on it (the
 * morning packet in `workbench`, the standup draft in `briefClock`). Input
 * `byGnomon` marked as its own act never counts. Every day, weekends included:
 * which days want a packet is the reader's question (`config.workdays`).
 */
export const idleTrack: Rule = (state, event) => {
  if (event.type !== 'input:activity') return { state, effects: [] };

  const zero = isZeroActivity(event.payload as InputActivityPayload);
  const wasIdle = state.lifeEvent.idle.isIdle;
  const consecutiveZeroWindows = zero ? state.lifeEvent.idle.consecutiveZeroWindows + 1 : 0;
  const isIdle = consecutiveZeroWindows >= IDLE_THRESHOLD_WINDOWS;

  const lastActiveAt = zero ? (state.lifeEvent.idle.lastActiveAt ?? null) : event.ts;
  const was = state.lifeEvent.idle;
  const day = wakingDate(event.ts, state.config.timezone);
  // A snapshot from before the field: input already seen today means today's touch is past, not news.
  const touched = was.firstTouchDay !== undefined ? was.firstTouchDay : was.lastActiveAt ? wakingDate(was.lastActiveAt, state.config.timezone) : null;
  const touch = !zero && byGnomonMarked(state, event) === null && touched !== day;
  const firstTouchDay = touch ? day : touched;
  // Set 2 R4: the owner's own key or click, for the screen tools' hold. A window Gnomon's acts filled is not the owner's hand.
  const hand = ownerHandAt(event.payload as InputActivityPayload, event.ts, byGnomonMarked(state, event) !== null, was.ownerHandAt ?? null);
  const nextState = { ...state, lifeEvent: { ...state.lifeEvent, idle: { consecutiveZeroWindows, isIdle, lastActiveAt, firstTouchDay, ownerHandAt: hand } } };
  const firstTouch: Effect[] = touch ? [{ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'idle-track', 'first-touch'), type: 'owner:first-touch', ts: event.ts, payload: { timestamp: event.ts, day } } }] : [];

  if (isIdle && !wasIdle) {
    return {
      state: nextState,
      effects: [
        ...firstTouch,
        { type: 'EmitEvent' as const, event: { id: deriveId(event.ts, event.id, 'idle-track', 'start'), type: 'idle:start', ts: event.ts, payload: { timestamp: event.ts } } },
      ],
    };
  }

  if (!isIdle && wasIdle) {
    return {
      state: nextState,
      effects: [
        ...firstTouch,
        { type: 'EmitEvent' as const, event: { id: deriveId(event.ts, event.id, 'idle-track', 'end'), type: 'idle:end', ts: event.ts, payload: { timestamp: event.ts } } },
      ],
    };
  }

  return { state: nextState, effects: firstTouch };
};
