import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Rule } from '@sundial/kernel/types.js';

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
export const idleTrack: Rule = (state, event) => {
  if (event.type !== 'input:activity') return { state, effects: [] };

  const zero = isZeroActivity(event.payload as InputActivityPayload);
  const wasIdle = state.lifeEvent.idle.isIdle;
  const consecutiveZeroWindows = zero ? state.lifeEvent.idle.consecutiveZeroWindows + 1 : 0;
  const isIdle = consecutiveZeroWindows >= IDLE_THRESHOLD_WINDOWS;

  const lastActiveAt = zero ? (state.lifeEvent.idle.lastActiveAt ?? null) : event.ts;
  const nextState = { ...state, lifeEvent: { ...state.lifeEvent, idle: { consecutiveZeroWindows, isIdle, lastActiveAt } } };

  if (isIdle && !wasIdle) {
    return {
      state: nextState,
      effects: [
        { type: 'EmitEvent' as const, event: { id: deriveId(event.ts, event.id, 'idle-track', 'start'), type: 'idle:start', ts: event.ts, payload: { timestamp: event.ts } } },
      ],
    };
  }

  if (!isIdle && wasIdle) {
    return {
      state: nextState,
      effects: [
        { type: 'EmitEvent' as const, event: { id: deriveId(event.ts, event.id, 'idle-track', 'end'), type: 'idle:end', ts: event.ts, payload: { timestamp: event.ts } } },
      ],
    };
  }

  return { state: nextState, effects: [] };
};
