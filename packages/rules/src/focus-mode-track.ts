import type { FocusModeState, Rule } from '@sundial/kernel/types.js';

const VALID_STATES = new Set<FocusModeState>(['off', 'do-not-disturb', 'work', 'personal', 'sleep', 'custom', 'unknown']);

interface FocusModeChangedPayload {
  state?: string;
  name?: string;
}

/**
 * C1 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.1) —
 * `focus-mode:changed` was captured every poll tick (the sensor itself
 * dedupes on real change) but had no rule writing it into `state.focusMode`
 * at all; the field stayed at its `'unknown'` default forever, and the MCP
 * `gnomon_current_context` tool returned that permanently-stale value to
 * any client asking "what's the daemon doing right now."
 */
export const focusModeTrack: Rule = (state, event) => {
  if (event.type !== 'focus-mode:changed') return { state, effects: [] };

  const payload = event.payload as FocusModeChangedPayload;
  const raw = payload.state;
  const focusState: FocusModeState = raw && VALID_STATES.has(raw as FocusModeState) ? (raw as FocusModeState) : 'unknown';
  const name = typeof payload.name === 'string' && payload.name ? payload.name : null;

  return {
    state: { ...state, focusMode: { state: focusState, name, since: event.ts } },
    effects: [],
  };
};
