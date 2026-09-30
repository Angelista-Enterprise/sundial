/**
 * The Threads card, as Gnomon reads it.
 *
 * `gnomon_look` answers "what does that card show", so this shows what the RAIL
 * shows, not what `/gnomon/api/sessions` returns. Those differ, and the
 * difference is the whole reason this file exists: the route returns every
 * session on disk, while the card hides three kinds of row —
 *
 *   the companion    — it has its own seat above the rail, never a row in it
 *   Gnomon's own job sessions — machine noise in a list meant for the owner
 *   blank sessions   — opened, never spoken in
 *
 * — and splits what is left into live threads and an archive behind a toggle.
 * A reader that returned the raw route would have Gnomon describing rows the
 * owner cannot see, which is worse than having no reader at all.
 *
 * The rules are `drawRail` in `plugins/sundial-theme/shell/app.js`, kept in step
 * by the test beside this file. `archived` is counted rather than listed: the
 * card counts it too, and the owner has to press to see it.
 */
import { COMPANION_SESSION_ID } from '@sundial/helpers/vocab.js';

/**
 * A session the rail hides: Gnomon's own work sessions, ones with no turn in
 * them, and any session not minted as `session-…` by the shell — a helper's
 * sub-task or a job's paper (the rail's `ownThread`). Without that last rule
 * this reader listed three helper sessions, titled by their first words
 * ("Task: across the current week"), that the owner's list never showed.
 */
const isNoise = (row) => !String(row.id ?? '').startsWith('session-') || /^Gnomon opened a job/i.test(row.title ?? '') || row.blank === true;

/** The name the rail draws, including its two fallbacks for a session dsh never titled. */
const nameOf = (row) => row.title || (row.blank === true ? 'Empty session' : 'Untitled session');

/**
 * dsh keeps session times as epoch milliseconds; every other reading Gnomon
 * gets is an ISO instant. A model handed `1789673260044` cannot say what hour
 * that was, so the conversion happens here rather than in the prompt.
 */
const instant = (value) => {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/**
 * `{ sessions }` from `/gnomon/api/sessions` → what the Threads card shows.
 *
 * Live first, then last touched — the order the rail draws, not the order the
 * route answers in.
 */
export function threadRows(body) {
  const all = Array.isArray(body?.sessions) ? body.sessions : [];
  const owned = all.filter((row) => row.id !== COMPANION_SESSION_ID && !isNoise(row));
  const rows = owned.filter((row) => !row.archived);
  // The order the RAIL draws: live on top, then last touched. The route answers
  // in creation order, which put the session the owner was speaking in fourth.
  // A reader that listed them in a different order would describe a card the
  // owner is not looking at — the whole reason this file exists.
  const at = (row) => row.lastPromptAt ?? row.createdAt ?? 0;
  const ordered = [...rows].sort((a, b) => Number(b.live === true) - Number(a.live === true) || Number(at(b)) - Number(at(a)));
  return {
    threads: ordered.map((row) => ({
      id: row.id,
      title: nameOf(row),
      live: row.live === true,
      at: instant(row.lastPromptAt ?? row.createdAt ?? null),
    })),
    archived: owned.length - rows.length,
    hidden: all.length - owned.length,
  };
}
