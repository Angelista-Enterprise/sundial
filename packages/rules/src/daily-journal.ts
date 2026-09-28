import type { Rule } from '@sundial/kernel/types.js';
import { assessNovelty } from './llm-novelty-gate.js';

interface DayBoundaryPayload {
  previousDate?: string;
  newDate?: string;
}

/**
 * P5 (docs/design/07) — the day-writer trigger. Reacts to `day:boundary` (the
 * same midnight cadence as `memoryReflection`/`nightlyFactExtract`) and emits a
 * `RunJournal` effect for the day that just ended (`previousDate`). Placed
 * AFTER `memoryReflection` and `nightlyFactExtract` in `RULE_MANIFEST` so that
 * day's reflection and freshly-extracted facts already exist when the executor
 * builds the journal's `DailyContext`.
 *
 * Pure like its siblings: it just names the day; `performDailyJournalCall`
 * builds the context, calls the LLM (purpose `journal`), and writes the
 * `kind: 'daily'` knowledge entry. No retry on the background job — a missed
 * midnight run is recoverable via an on-demand regenerate (`gnomon journal`).
 */
export const dailyJournal: Rule = (state, event) => {
  if (event.type !== 'day:boundary') return { state, effects: [] };
  const previousDate = (event.payload as DayBoundaryPayload).previousDate;
  if (!previousDate) return { state, effects: [] };

  // The journal is the single largest LLM cost in the system — 4.25M of 6.18M tokens
  // over the measured fortnight, 69% of all spend — so it is where a skip is worth
  // the most. A day the daemon barely watched cannot support a day's account of it.
  const novelty = assessNovelty(state, `${previousDate}T00:00:00.000Z`, event.ts);
  if (!novelty.worthCalling) {
    return {
      state,
      effects: [
        {
          type: 'EmitEvent',
          event: {
            id: `${event.id}-journal-skipped`,
            type: 'llm:skipped',
            ts: event.ts,
            payload: { purpose: 'journal', reason: novelty.reason, observedHours: Math.round(novelty.observedHours * 100) / 100, date: previousDate },
          },
        },
      ],
    };
  }

  return { state, effects: [{ type: 'RunJournal', date: previousDate, ts: event.ts }] };
};
