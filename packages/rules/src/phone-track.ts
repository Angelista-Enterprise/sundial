import type { KernelState, Rule } from '@sundial/kernel/types.js';

/**
 * aspiration A01 (account for my whole day) (phase 1) — folds what a PAIRED PHONE
 * reports into `state.coverage`, the live readout of the hours the desk machine
 * cannot see: asleep, or away with the laptop closed.
 *
 * Reacts to three event types the iOS app posts to `POST /ingest/phone`:
 *   - `phone:place`  a visit at an on-device-labelled place (`label`, `arrival`,
 *                    and `departure` once it ends). Only the LABEL travels — the
 *                    phone matches its own geofences and never sends coordinates.
 *   - `phone:sleep`  a completed sleep interval (`start`, `end`) from HealthKit.
 *   - `phone:motion` the owner's current motion state (`walking`, `automotive`,
 *                    …) — a live-readout bit, not a coverage interval.
 *
 * `phone:workout` and `phone:steps` also arrive but need no state field: they
 * land in the append-only log (where A01 counts workouts as coverage), and
 * fold to no live readout, so this rule leaves them for the log alone.
 *
 * A boundary rule like `feedbackTrack`/`presenceTrack`: the payload originates
 * off-machine, so anything malformed is dropped rather than folded. The coverage
 * MEASUREMENT (A01) reads the append-only log; this slice is only the live "where
 * is the owner now" readout.
 */

interface PlacePayload {
  label?: unknown;
  arrival?: unknown;
  departure?: unknown;
}

interface SleepPayload {
  start?: unknown;
  end?: unknown;
}

interface MotionPayload {
  state?: unknown;
  start?: unknown;
}

const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** An ISO time as given; an EMPTY or missing value as the event's own time; anything else (garbage like "yesterday") as null, to be dropped. */
const timeOrNow = (v: unknown, now: string): string | null => (isIso(v) ? v : v === undefined || v === null || v === '' ? now : null);

export const phoneTrack: Rule = (state, event) => {
  if (event.type === 'phone:place') {
    const p = event.payload as PlacePayload;
    const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim() : null;
    if (!label) return { state, effects: [] };

    // The sender may leave a time EMPTY (Shortcuts automations post at the very
    // moment they fire and have no reliable date token), in which case the
    // event's own timestamp is the time. A departure is signalled by the KEY
    // being present — its value, if any, is when.
    const arrival = timeOrNow(p.arrival, event.ts);
    if (arrival === null) return { state, effects: [] };
    const departed = 'departure' in p && p.departure !== undefined && p.departure !== null;
    const departure = departed ? timeOrNow(p.departure, event.ts) : null;
    if (departed && departure === null) return { state, effects: [] };
    const left = departure !== null;
    const coverage: KernelState['coverage'] = left
      ? // A completed visit: the owner has left. Clear the place only if it is
        // the one we were showing; a late report about an earlier place must not
        // wipe a newer arrival.
        { ...state.coverage, place: state.coverage.place === label ? null : state.coverage.place, placeSince: state.coverage.place === label ? null : state.coverage.placeSince, updatedAt: event.ts }
      : { ...state.coverage, place: label, placeSince: arrival, updatedAt: event.ts };

    return { state: { ...state, coverage }, effects: [] };
  }

  if (event.type === 'phone:sleep') {
    const p = event.payload as SleepPayload;
    // An empty end means "I just woke": the automation fires on waking.
    const end = timeOrNow(p.end, event.ts);
    if (end === null || !isIso(p.start) || Date.parse(end) < Date.parse(p.start)) return { state, effects: [] };
    return { state: { ...state, coverage: { ...state.coverage, lastSleepEnd: end, updatedAt: event.ts } }, effects: [] };
  }

  if (event.type === 'phone:motion') {
    const p = event.payload as MotionPayload;
    const activity = typeof p.state === 'string' && p.state.trim() ? p.state.trim() : null;
    if (!activity || !isIso(p.start)) return { state, effects: [] };
    return { state: { ...state, coverage: { ...state.coverage, activity, activitySince: p.start as string, updatedAt: event.ts } }, effects: [] };
  }

  return { state, effects: [] };
};
