/**
 * Set 5 R3: `state.chores` folded from the log's last four weeks, once, for a boot whose snapshot holds no counters
 * (after a deploy they started empty, three workdays without an offer). The same move as `rebuildTickets`: the rules
 * folded alone over the rows they read, in time order, paged. Only the counters are taken: an offer the history
 * "made" never reached the owner, so today's is still to make, and the live `byGnomon` window stays as it is.
 */
import { getSignalsInRange } from '@sundial/db/index.js';
import { CHORE_HORIZON_DAYS } from '@sundial/kernel/read/chores.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { CHORE_REBUILD_TYPES, choresCleared, foldChoreRows } from '@sundial/rules/chore-learn.js';

export async function rebuildChoresFromLog(state: KernelState, nowMs = Date.now()): Promise<KernelState['chores']> {
  const to = new Date(nowMs + 60_000).toISOString();
  const from = new Date(nowMs - (CHORE_HORIZON_DAYS + 1) * 86_400_000).toISOString();
  const PAGE = 5000;
  let folded = choresCleared(state);
  let n = 0;
  for (let offset = 0; ; offset += PAGE) {
    const page = await getSignalsInRange(from, to, PAGE, CHORE_REBUILD_TYPES, offset);
    folded = foldChoreRows(folded, page.map((row) => ({ id: row.id, type: `${row.signalType}:${row.eventType}`, ts: row.capturedAt, payload: row.data, sanitized: true }) as SanitizedEvent));
    n += page.length;
    if (page.length < PAGE) break;
  }
  console.log(`[sundial-kernel] rebuilt ${Object.keys(folded.chores?.keys ?? {}).length} chore counter(s) from ${n} signal(s) of the last ${CHORE_HORIZON_DAYS} days`);
  return { ...folded.chores!, offered: state.chores?.offered ?? {} };
}
