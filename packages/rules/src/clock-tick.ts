import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import type { Rule } from '@sundial/kernel/types.js';

/**
 * Reacts to the synthetic `clock:tick` event the daemon's own interval fires
 * (docs/design/01-events-and-log.md's "new synthetic events" — clockTick
 * itself produces them, it isn't triggered by them). Phase 2 scope: only
 * day-boundary detection (resets budgets). `memory:reflection-due` needs
 * `state.memory.accumulatedImportance`, which no rule populates until
 * Phase 6 — accumulatedImportance stays 0, so that threshold never fires;
 * left out entirely rather than stubbed.
 */
export const clockTick: Rule = (state, event) => {
  if (event.type !== 'clock:tick') return { state, effects: [] };

  // The owner's local day, not the UTC one. `ts.slice(0, 10)` put this boundary at
  // 02:00 in Amsterdam (01:00 in winter), so midnight-to-2am work was journaled,
  // budgeted and decayed as part of the previous day. The zone comes from
  // `state.config` rather than the host so the fold stays replayable — see
  // helpers/local-day.ts.
  const eventDate = localDate(event.ts, state.config.timezone);
  if (eventDate === state.budgets.day) return { state, effects: [] };
  // The first tick of a fresh state only learns the day; nothing ended.
  if (state.budgets.day === '') return { state: { ...state, budgets: { ...state.budgets, day: eventDate } }, effects: [] };

  return {
    state: {
      ...state,
      budgets: {
        ...state.budgets,
        day: eventDate,
        byPurpose: {
          intent: { callsToday: 0 },
          companion: { callsToday: 0 },
          reflect: { callsToday: 0 },
          extract: { callsToday: 0 },
          journal: { callsToday: 0 },
          ask: { callsToday: 0 },
          refute: { callsToday: 0 },
          goal: { callsToday: 0 },
          transcript: { callsToday: 0 },
          hand: { callsToday: 0 },
          vision: { callsToday: 0 },
        perceive: { callsToday: 0 },
        classify: { callsToday: 0 },
        rank: { callsToday: 0 },
        judge: { callsToday: 0 },
        audit: { callsToday: 0 },
        forecast: { callsToday: 0 },
        listen: { callsToday: 0 },
        },
      },
    },
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'clock-tick'),
          type: 'day:boundary',
          ts: event.ts,
          payload: { previousDate: state.budgets.day, newDate: eventDate },
        },
      },
    ],
  };
};
