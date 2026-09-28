import type { HotFile, Rule } from '@sundial/kernel/types.js';
import { localDate } from '@sundial/helpers/local-day.js';

interface FileChangedPayload {
  timestamp?: string;
  projectRoot?: string;
  changes?: { relPath?: string; kind?: string }[];
  focused?: boolean;
}

/** Hot files kept per day; the rest of the tail falls off by change count. */
export const MAX_HOT_FILES = 50;

/** Files that are never the owner's own work, whatever the watcher says. */
const IGNORED_PATH = /(^|\/)(node_modules|dist|\.git|\.pnpm|coverage)\/|\.(lock|log|map|timestamp-[0-9a-z-]+\.mjs)$|(^|\/)\.[^/]*\.mjs$/;

function trimHot(hot: Record<string, HotFile>): Record<string, HotFile> {
  const entries = Object.entries(hot);
  if (entries.length <= MAX_HOT_FILES) return hot;
  entries.sort((a, b) => b[1].changes - a[1].changes || (a[1].lastAt < b[1].lastAt ? 1 : -1));
  return Object.fromEntries(entries.slice(0, MAX_HOT_FILES));
}

/**
 * `file:changed` had 3,207 rows and no rule: `getCodeActivityForDate` parsed it
 * on demand for the evidence tool, and nothing else ever saw it
 * (`enhancements/collected-but-unused-data`). This folds it into
 * `state.files.hot` — how many times each file was touched today, and how many
 * of those touches landed while the editor was the focused window — so the
 * presence line can say "you have been in this one file all afternoon" and a
 * later rule can notice a file returned to across days.
 *
 * Reset on the local day boundary: a count that spans days is a different
 * question (that is the commitment ledger's, per branch).
 */
export const fileTrack: Rule = (state, event) => {
  if (event.type === 'day:boundary') {
    if (Object.keys(state.files.hot).length === 0 && state.files.day === null) return { state, effects: [] };
    return { state: { ...state, files: { day: null, hot: {} } }, effects: [] };
  }
  if (event.type !== 'file:changed') return { state, effects: [] };

  const payload = event.payload as FileChangedPayload;
  const root = typeof payload.projectRoot === 'string' ? payload.projectRoot : '';
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const focused = payload.focused === true;
  const day = localDate(event.ts, state.config.timezone);

  // A new local day seen through the event itself (a boundary can be missed
  // across a sleep) starts the counts over.
  let hot: Record<string, HotFile> = state.files.day === day ? { ...state.files.hot } : {};
  let touched = false;
  for (const change of changes) {
    const relPath = typeof change.relPath === 'string' ? change.relPath : '';
    if (relPath === '' || change.kind === 'delete' || IGNORED_PATH.test(relPath)) continue;
    const key = `${root}|${relPath}`;
    const seen = hot[key];
    hot[key] = seen
      ? { ...seen, changes: seen.changes + 1, focusedChanges: seen.focusedChanges + (focused ? 1 : 0), lastAt: event.ts }
      : { projectRoot: root, relPath, changes: 1, focusedChanges: focused ? 1 : 0, firstAt: event.ts, lastAt: event.ts };
    touched = true;
  }
  if (!touched && state.files.day === day) return { state, effects: [] };
  hot = trimHot(hot);
  return { state: { ...state, files: { day, hot } }, effects: [] };
};

/** The file touched most today, if any file was touched at least `min` times. */
export function hottestFile(hot: Record<string, HotFile>, min = 3): HotFile | null {
  let best: HotFile | null = null;
  for (const file of Object.values(hot)) {
    if (file.changes < min) continue;
    if (best === null || file.changes > best.changes) best = file;
  }
  return best;
}
