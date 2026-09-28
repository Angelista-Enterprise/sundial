import { localDate } from '@sundial/helpers/local-day.js';
import type { KernelState, Rule } from '@sundial/kernel/types.js';

/** Notes remembered per day. A day rarely touches more than a dozen; fifty is the ceiling that keeps the slice small. */
export const MAX_VAULT_NOTES = 50;

/**
 * J3.5 — which vault notes the owner edited today, from `vault:changed`
 * (paths only, never contents). Reset on the day boundary and by the event's
 * own day, as `fileTrack` does. The fan-out reads `notesEditedToday` as
 * subject candidates for a moment; the journal's sink is the executor's.
 */
export function notesEditedToday(state: KernelState, max = 8): string[] {
  return Object.entries(state.vault?.notesToday ?? {})
    .sort((a, b) => (a[1].lastAt < b[1].lastAt ? 1 : -1))
    .slice(0, max)
    .map(([rel]) => rel.replace(/\.md$/, ''));
}

export const vaultTrack: Rule = (state, event) => {
  const slice = state.vault ?? { day: null, notesToday: {} };
  if (event.type === 'day:boundary') {
    if (slice.day === null && Object.keys(slice.notesToday).length === 0) return { state, effects: [] };
    return { state: { ...state, vault: { day: null, notesToday: {} } }, effects: [] };
  }
  if (event.type !== 'vault:changed') return { state, effects: [] };
  const notes = (event.payload as { notes?: unknown }).notes;
  if (!Array.isArray(notes)) return { state, effects: [] };
  const day = localDate(event.ts, state.config.timezone);
  const notesToday: Record<string, { changes: number; lastAt: string }> = slice.day === day ? { ...slice.notesToday } : {};
  for (const note of notes) {
    if (typeof note !== 'string' || note === '') continue;
    notesToday[note] = { changes: (notesToday[note]?.changes ?? 0) + 1, lastAt: event.ts };
  }
  const entries = Object.entries(notesToday);
  const bounded = entries.length > MAX_VAULT_NOTES ? Object.fromEntries(entries.sort((a, b) => (a[1].lastAt < b[1].lastAt ? 1 : -1)).slice(0, MAX_VAULT_NOTES)) : notesToday;
  return { state: { ...state, vault: { day, notesToday: bounded } }, effects: [] };
};
