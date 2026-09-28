import type { Rule } from '@sundial/kernel/types.js';
import { OCCURRENCE_STREAMS, bucketFor, recordDayEnd, recordOccurrence } from './expectations.js';

/**
 * Learns what recurs, so `expectationWatch` can notice when it stops.
 *
 * The whole of the omission capability rests on this rule, and it is deliberately
 * dumb: for each declared stream, does this event count as an occurrence, and if so
 * fold the gap since the last one into a running interval. No thresholds, no
 * emission, no opinion about whether anything is interesting.
 *
 * Also maintains the day-end phase series, which is separate from the interval
 * machinery for the reason `expectations.dayEnd`'s doc comment gives: the gap
 * between consecutive day-ends is always ~24h however early or late the owner
 * stopped, so an interval model cannot see a stop time move.
 *
 * No ordering constraint against the `window:changed` cluster even though two
 * streams read `window:changed`: it consults `state.project.current`, which
 * `projectTrack` writes on `project:detected` rather than on this event, and it
 * never reads `state.moment`. Placed before `expectationWatch` so a tick's
 * occurrences are folded before the same tick asks what is missing.
 */
export const expectationLearn: Rule = (state, event) => {
  let recurring = state.expectations.recurring;
  let changed = false;

  for (const stream of OCCURRENCE_STREAMS) {
    if (!stream.matches(state, event)) continue;

    const subject = stream.subject ? stream.subject(state, event) : null;
    // A stream that declares a subject function and returns null for this event has
    // nothing to key on — a `window:changed` with no resolved project, which is the
    // majority case (roughly 78% of moments resolve to no project at all).
    if (stream.subject && !subject) continue;

    const streamName = subject ? `${stream.key}:${subject}` : stream.key;
    const bucket = bucketFor(stream, event.ts, state.config.timezone);
    recurring = recordOccurrence(recurring, `${streamName}|${bucket}`, streamName, bucket, event.ts, stream.valueHalfLifeMs, stream.maxGapMs, stream.minSessionGapMs);
    changed = true;
  }

  // `input:activity` is the densest event in the log (~360/hour), so this branch runs
  // constantly and must stay allocation-free in the common case. `recordDayEnd`
  // returns the SAME array when the minute has not advanced, which it usually has
  // not, and the identity check below is what keeps that cheap.
  const dayEnd = event.type === 'input:activity' ? recordDayEnd(state.expectations.dayEnd, event.ts, state.config.timezone) : state.expectations.dayEnd;

  if (!changed && dayEnd === state.expectations.dayEnd) return { state, effects: [] };

  return { state: { ...state, expectations: { ...state.expectations, recurring, dayEnd } }, effects: [] };
};
