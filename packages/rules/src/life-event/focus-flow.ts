import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Effect, KernelState, Rule } from '@sundial/kernel/types.js';

const FLOW_MIN_DURATION_MS = 5 * 60_000;
/**
 * A span must show RECURRING engagement, not one stray event that then idled
 * out — active in at least this many input windows. Without it, a single mouse
 * move followed by five idle minutes would emit a deep-work block, because the
 * span opened and `idle:start` only closes it once the idle threshold is reached.
 */
const FLOW_MIN_ACTIVE_WINDOWS = 2;

interface InputActivityPayload {
  windowMs?: number;
  keyDownCount?: number;
  mouseClickCount?: number;
  mouseMoveCount?: number;
  scrollCount?: number;
}

interface WindowChangedPayload {
  processName?: string;
}

/** Total input activity in a window — typing OR reading (scroll/mouse), the whole point of C15. */
function activityCount(p: InputActivityPayload): number {
  return (p.keyDownCount ?? 0) + (p.mouseClickCount ?? 0) + (p.mouseMoveCount ?? 0) + (p.scrollCount ?? 0);
}

/** Emits `event:focus-flow` only if the span met the minimum duration AND showed recurring engagement — short or one-off spans are noise. */
function closeFlowSpan(state: KernelState, ts: string, eventId: string): { state: KernelState; effects: Effect[] } {
  const flow = state.lifeEvent.flow;
  const cleared = { ...state, lifeEvent: { ...state.lifeEvent, flow: null } };
  if (!flow) return { state: cleared, effects: [] };

  const durationMs = Date.parse(ts) - Date.parse(flow.startedAt);
  if (durationMs < FLOW_MIN_DURATION_MS || flow.sampleCount < FLOW_MIN_ACTIVE_WINDOWS) {
    return { state: cleared, effects: [] };
  }

  const mean = flow.sampleSum / flow.sampleCount;
  return {
    state: cleared,
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(ts, eventId, 'focus-flow'),
          type: 'event:focus-flow',
          ts,
          // `activityRatePerMin` (was `typingRatePerMin`): mean input events per
          // minute across the span, counting reading (scroll/mouse), not just
          // keystrokes — the field kept its two backing scalars, only its meaning
          // widened.
          payload: { timestamp: ts, momentId: state.moment?.id ?? null, processName: flow.processName, durationMs, activityRatePerMin: Math.round(mean) },
        },
      },
    ],
  };
}

/**
 * Deep work = SUSTAINED SINGLE-APP ENGAGEMENT, not keystroke volume.
 *
 * C15 refuted typing rate as the deep-work proxy: it measured 0 hours of flow
 * over three days because reading and reviewing — no typing, real focus — were
 * invisible to it. This rule now opens a span on ANY input activity (a scroll or
 * a mouse move counts, so reading is visible), keeps it while the same process
 * stays foreground, tolerates the pauses of thinking, and ends it on a real
 * break. "Low context-switching" falls out for free: any `window:changed` to a
 * different process closes the span, so a span is single-app by construction.
 *
 * The span ends on three things: a switch to a different process
 * (`window:changed`, or a process change seen on `input:activity`), or
 * `idle:start` — the sustained-inactivity signal `idleTrack` already emits (~5
 * min of zero input). Reusing `idle:start` is deliberate: a pure rule cannot hold
 * a cancellable timer, and re-counting consecutive idle windows here would
 * duplicate state `idleTrack` already keeps. A single quiet window is a pause,
 * not the end, so it neither extends nor closes the span.
 *
 * Attributed to `state.moment.processName` (Gnomon's live analog of the focused
 * app — there is no `moment:start` event to key off).
 */
export const focusFlow: Rule = (state, event) => {
  // Sustained inactivity ends a span (reuses idleTrack's detection rather than a
  // private timer/counter — see the doc comment).
  if (event.type === 'idle:start') {
    return state.lifeEvent.flow ? closeFlowSpan(state, event.ts, event.id) : { state, effects: [] };
  }

  if (event.type === 'window:changed') {
    const newProcess = typeof (event.payload as WindowChangedPayload).processName === 'string' ? (event.payload as WindowChangedPayload).processName! : '';
    if (state.lifeEvent.flow && state.lifeEvent.flow.processName !== newProcess) {
      return closeFlowSpan(state, event.ts, event.id);
    }
    return { state, effects: [] };
  }

  if (event.type !== 'input:activity') return { state, effects: [] };

  const payload = event.payload as InputActivityPayload;
  const windowMs = typeof payload.windowMs === 'number' ? payload.windowMs : 0;
  if (windowMs <= 0) return { state, effects: [] };

  const activity = activityCount(payload);
  const ratePerMin = (activity / windowMs) * 60_000;

  const process = state.moment?.processName ?? null;
  if (!process) return { state, effects: [] };

  // A quiet window is a pause (reading, thinking), not the end — leave the span
  // untouched and let idle:start or a window switch close it.
  if (activity === 0) return { state, effects: [] };

  const flow = state.lifeEvent.flow;
  if (!flow) {
    return { state: { ...state, lifeEvent: { ...state.lifeEvent, flow: { processName: process, startedAt: event.ts, sampleCount: 1, sampleSum: ratePerMin } } }, effects: [] };
  }
  if (flow.processName === process) {
    return {
      state: { ...state, lifeEvent: { ...state.lifeEvent, flow: { ...flow, sampleCount: flow.sampleCount + 1, sampleSum: flow.sampleSum + ratePerMin } } },
      effects: [],
    };
  }

  // Process changed without a window:changed firing — close + restart.
  const closed = closeFlowSpan(state, event.ts, event.id);
  return {
    state: { ...closed.state, lifeEvent: { ...closed.state.lifeEvent, flow: { processName: process, startedAt: event.ts, sampleCount: 1, sampleSum: ratePerMin } } },
    effects: closed.effects,
  };
};
