import type { KernelState, Rule } from '@sundial/kernel/types.js';

/**
 * J3.1 — the body, as the phone reports it over the `:8767` ingest (Shortcuts
 * is the sender, docs/jarvis/08). Three event types, each a boundary rule
 * like `phoneTrack`: malformed is dropped, never folded.
 * - `health:sleep { start, end }` → last night, as hours and as a span.
 * - `health:hr { resting }`      → the resting heart rate the phone computed.
 * - `health:steps { count }`     → the day's steps so far.
 * All land on `state.owner.energy`; Today and the strip show the night, and
 * the gate's morning cost term reads a short night (`interruptionCostOf`).
 */
const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export const healthTrack: Rule = (state, event) => {
  const energy = state.owner.energy;
  const patch = (over: Partial<KernelState['owner']['energy']>): ReturnType<Rule> => ({ state: { ...state, owner: { ...state.owner, energy: { ...energy, ...over, updatedAt: event.ts } } }, effects: [] });
  // `phone:sleep` is the OLDER Shortcut's name for the same interval (`phoneTrack` keeps its wake time); one night, two readers.
  if (event.type === 'health:sleep' || event.type === 'phone:sleep') {
    const p = event.payload as { start?: unknown; end?: unknown };
    if (!isIso(p.start) || !isIso(p.end) || Date.parse(p.end) <= Date.parse(p.start)) return { state, effects: [] };
    const hours = (Date.parse(p.end) - Date.parse(p.start)) / 3_600_000;
    if (hours > 20) return { state, effects: [] };
    return patch({ sleepHours: Math.round(hours * 10) / 10, sleptFrom: p.start, sleptTo: p.end });
  }
  if (event.type === 'health:hr') {
    const resting = num((event.payload as { resting?: unknown }).resting);
    return resting === null || resting < 25 || resting > 220 ? { state, effects: [] } : patch({ restingHr: Math.round(resting) });
  }
  if (event.type === 'health:steps') {
    const count = num((event.payload as { count?: unknown }).count);
    return count === null ? { state, effects: [] } : patch({ steps: Math.round(count) });
  }
  return { state, effects: [] };
};
