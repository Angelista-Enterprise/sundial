import { deriveId } from '@sundial/helpers/derive-id.js';
import type { Rule } from '@sundial/kernel/types.js';

const THRASH_WINDOW_MS = 90_000;
/**
 * Flips between DIFFERENT apps inside the window before this counts as
 * thrashing — one every ten seconds, nine in a row.
 *
 * **Measured, not chosen.** Over the live corpus, bucketing every real app flip
 * into fixed 90-second windows: five or more happens in about a third of the
 * windows that hold any flip at all, eight or more in 12%, nine in 8.7%, twelve
 * in 3.6%. A detector that fires on a third of ordinary working windows is not
 * detecting anything. Nine puts it in the top tenth, which is what "rapid
 * window flipping" has to mean if the word is to survive being read.
 *
 * Was 5 — against a stream that also counted an app re-titling its own window.
 * The two faults compounded: 4,932 bursts over 54 days, 220 of them on
 * 2026-09-09 alone, which is one every three and a half minutes of a working
 * day. At nine real flips the same days give eight to thirty, before the
 * debounce below takes its cut.
 */
const THRASH_MIN_FLIPS = 9;
const THRASH_DEBOUNCE_MS = 60_000;

interface WindowChangedPayload {
  processName?: string;
}

/**
 * Bursts of flipping between apps — ported from WCS's `LifeEventSensor`, and
 * corrected here after the live record was read.
 *
 * **It counted `window:changed`, which is not a switch.** That event fires on
 * every window TITLE change too, and 56% of the record's 52,365 of them are
 * one app re-titling itself — a terminal running a build, an editor moving
 * between files, a browser loading a page. So **935 of the 4,932 recorded
 * "bursts of rapid window flipping" involve exactly ONE process**, which is
 * not flipping between things; it is the opposite, sustained work in one app.
 * And 2,553 of them sat at exactly the old threshold of five, a detector whose
 * modal value is its own bar.
 *
 * It counts transitions between different processes now. `switchCount` keeps
 * its old meaning — raw window events in the burst — so the 4,932 rows already
 * in the log stay readable as what they were, and `flips` is the corrected
 * measure. A row with no `flips` is a row from before this fix, which is a
 * thing a reader needs to be able to tell.
 */
export const thrashing: Rule = (state, event) => {
  if (event.type !== 'window:changed') return { state, effects: [] };

  const process = typeof (event.payload as WindowChangedPayload).processName === 'string' ? (event.payload as WindowChangedPayload).processName! : 'unknown';
  const nowMs = Date.parse(event.ts);
  const cutoff = nowMs - THRASH_WINDOW_MS;

  const recentSwitches = [...state.lifeEvent.recentSwitches, { at: event.ts, process }].filter((e) => Date.parse(e.at) >= cutoff);

  // Transitions between different apps, not window events. The first entry in
  // the window has nothing before it to differ from, so a burst that began
  // just outside the window loses its opening flip — conservative, and the
  // right direction for a detector that was firing far too often.
  const flips = recentSwitches.reduce((count, entry, index) => (index > 0 && entry.process !== recentSwitches[index - 1]!.process ? count + 1 : count), 0);

  const lastEmitMs = state.lifeEvent.lastThrashEmitAt ? Date.parse(state.lifeEvent.lastThrashEmitAt) : -Infinity;
  const shouldEmit = flips >= THRASH_MIN_FLIPS && nowMs - lastEmitMs >= THRASH_DEBOUNCE_MS;

  if (!shouldEmit) {
    return { state: { ...state, lifeEvent: { ...state.lifeEvent, recentSwitches } }, effects: [] };
  }

  const processes: string[] = [];
  for (const e of recentSwitches) {
    if (!processes.includes(e.process)) processes.push(e.process);
    if (processes.length >= 8) break;
  }

  return {
    state: { ...state, lifeEvent: { ...state.lifeEvent, recentSwitches: [], lastThrashEmitAt: event.ts } },
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'thrashing'),
          type: 'event:thrashing',
          ts: event.ts,
          payload: {
            timestamp: event.ts,
            momentId: state.moment?.id ?? null,
            // Raw window events, unchanged, so the rows already in the log keep
            // meaning what they meant.
            switchCount: recentSwitches.length,
            // The corrected measure, and the one the threshold is set on.
            flips,
            windowMs: THRASH_WINDOW_MS,
            processes,
          },
        },
      },
    ],
  };
};
