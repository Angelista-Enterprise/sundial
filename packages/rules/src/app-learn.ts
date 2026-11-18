import { noteKey, type AppNote, type AppNoteTally, type AppNotesSide, type AppNotesSlice } from '@sundial/helpers/app-notes.js';
import { isRigSession } from '@sundial/helpers/sandbox.js';
import { taskOf } from '@sundial/helpers/task-of.js';
import type { Rule } from '@sundial/kernel/types.js';
import { byGnomonMarked, isRigWindow } from './by-gnomon.js';

/**
 * What the owner's own apps are, counted from the record instead of typed by hand.
 *
 * On 2026-11-13 an audit of 29 spoken requests lost about 65 s to a note
 * written through Obsidian's windows (Gnomon did not know the vault) and about
 * 60 s to the wrong place to do a task (it opened Mail, where the owner has not
 * worked in weeks, because the task said "mail"). Both facts were already in
 * the log, in the one field every focus change carries: the window title.
 *
 * Two facts, both counted, both bounded:
 *
 *   - `used` — how often each app came to the front, and when it last did. An
 *     app NOT in this list is not where the owner works.
 *   - `workspaces` — an app whose title reads `<document> - <workspace> - <App
 *     version>` names its workspace in the middle (Obsidian's vault). The last
 *     segment must start with the app's own name, which is what makes the rule
 *     general instead of a list of apps: nothing else in the record has that
 *     shape, and a title with no shape is simply not counted.
 *
 * The tally is the fold's own, so a replay rebuilds it and a snapshot carries
 * it; it never mirrors a table, and it is capped, so it cannot grow with the
 * log (`log over kernel mirror`). The counts are the evidence: the brief prints
 * them with their n, so the owner can see what Gnomon believes and say when it
 * is wrong. Their own `appNotes` always win, as an assertion beats an
 * inference everywhere else in memory.
 */
export const APPS_KEPT = 24;
const WORKSPACES_KEPT = 4;
const WORKSPACE_APPS_KEPT = 4;

/** `NOTE - puzzlebox - Obsidian 1.15.0` with app `Obsidian` → `puzzlebox`. Anything else → null. */
export function workspaceOf(processName: string, windowTitle: string): string | null {
  const parts = windowTitle.split(' - ');
  if (parts.length !== 3) return null;
  const [, workspace, tail] = parts;
  const app = processName.trim();
  if (!app || !tail.startsWith(app)) return null;
  const name = workspace.trim();
  return name && name.length <= 60 ? name : null;
}

/** The n highest-scoring of a tally, as a new object: a cap the fold applies on every write. */
const top = <T>(tally: Record<string, T>, n: number, by: (value: T) => number): Record<string, T> =>
  Object.fromEntries(Object.entries(tally).sort((a, b) => by(b[1]) - by(a[1])).slice(0, n));

export const appLearn: Rule = (state, event) => {
  if (event.type !== 'window:changed') return { state, effects: [] };
  const payload = event.payload as { processName?: unknown; windowTitle?: unknown };
  const processName = typeof payload.processName === 'string' ? payload.processName.trim() : '';
  const windowTitle = typeof payload.windowTitle === 'string' ? payload.windowTitle : '';
  if (!processName) return { state, effects: [] };

  const seen = state.apps.used[processName];
  // Kept by when it was last in front, never by the total: the owner changed browser twice this year, and a
  // 30-day count still named the old one. The count stays as the evidence; recency decides who is on the list.
  const used = top({ ...state.apps.used, [processName]: { n: (seen?.n ?? 0) + 1, last: event.ts } }, APPS_KEPT, (v) => Date.parse(v.last) || 0);

  const name = workspaceOf(processName, windowTitle);
  const of = state.apps.workspaces[processName] ?? {};
  const workspaces =
    name === null ? state.apps.workspaces
    : top({ ...state.apps.workspaces, [processName]: top({ ...of, [name]: (of[name] ?? 0) + 1 }, WORKSPACES_KEPT, (v) => v) }, WORKSPACE_APPS_KEPT, (v) => Math.max(0, ...Object.values(v)));

  return { state: { ...state, apps: { used, workspaces } }, effects: [] };
};

/**
 * Set 5 R2 (doc 18 piece 2, plan 21 item 3.6): how an app behaves under Gnomon's own steps, mined from them.
 *
 * `taskBoundary` drops a task's failed steps at the next `task:started`, so a wall was hit again in every task: the
 * Save sheet that is out of process, the pop-up that needs a press and then a pick. Here a failed `screen:step` waits,
 * per chat and app, for the next step that worked in the same task. When that step is a different move (a retry of the
 * same move teaches nothing), the pair is one pattern: the app, the failure's reason, the failed move and the fix. The
 * same pattern in `NOTE_AFTER` distinct tasks is a note, `{app, note, n, lastAt}`, which the screen tools print the
 * next time a chat works in that app (helpers app-notes.ts), the n beside it.
 *
 * A move is its verb and the role it acted on (the key, for a key), never the thing's name: a name is an old task's
 * value. Reasons that say something about Gnomon or the owner rather than the app (a stale look, the owner's hand, a
 * policy refusal, a malformed call) are not counted. The rig's chats and test windows fold into their own side, so a
 * bench can neither write nor push out a note the owner's chats are shown. Event-driven: the rows themselves, no clock.
 */
export const NOTE_AFTER = 3;
const OPEN_KEPT = 8;
const TALLY_KEPT = 48;
const NOTES_PER_APP = 3;
const NOTES_KEPT = 12;
const TASKS_REMEMBERED = 4;
const NOT_THE_APP = new Set([
  'look again', 'owner-moved', 'owner-hand', 'corrected', 'stopped', "replaced the owner's own text", 'private app', 'protected-app',
  'secure-input', 'secure-field', 'sign-in', 'refused-key', 'unknown-action', 'unknown-key', 'bad-click', 'no-access', 'no-such-app',
]);
const EMPTY: AppNotesSlice = { open: {}, owner: { tally: {}, notes: [] }, rig: { tally: {}, notes: [] } };

const word = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, n) : '');
/** Review S5R2 L5: a key's name, with its modifiers; anything else a key step carries is not kept (it may be typed text). */
const KEY_NAME = /^(?:(?:cmd|command|meta|shift|alt|option|opt|ctrl|control|fn)\s*\+\s*)*(?:[a-z0-9]|return|enter|kp[_-]enter|tab|escape|esc|space|delete|backspace|forward-delete|up|down|left|right|page-?up|page-?down|home|end|f\d{1,2})$/i;
/** A step as a move: its verb and role, or the key it pressed. */
export function moveOf(p: Record<string, unknown>): string {
  const verb = word(p.verb, 20) || 'step';
  const key = word(p.key, 24);
  const what = verb === 'key' ? (KEY_NAME.test(key) ? key : '') : word(p.role, 30);
  return what ? `${verb} ${what}` : verb;
}

/** The newest `max` entries of a record, by a time each holds. */
const newest = <T>(map: Record<string, T>, max: number, at: (v: T) => string): Record<string, T> =>
  Object.fromEntries(Object.entries(map).sort((a, b) => at(a[1]).localeCompare(at(b[1]))).slice(-max));

/**
 * A pattern counted once more in a task, and the notes that follow. A pattern is a note at `NOTE_AFTER` tasks when it is
 * also most of what came after that failure (`group`: the app, the reason and the failed move): a failure followed by
 * a different move each time has no fix, only a next step. At most `NOTES_PER_APP` per app and `NOTES_KEPT` in all.
 */
function counted(side: AppNotesSide, key: string, group: string, app: string, note: string, task: string, at: string, dropped: (n: AppNote) => boolean = () => false): AppNotesSide {
  const was = side.tally[key];
  if (was && was.tasks.includes(task)) return side;
  const tally: AppNoteTally = { app, note, n: (was?.n ?? 0) + 1, tasks: [...(was?.tasks ?? []), task].slice(-TASKS_REMEMBERED), lastAt: at };
  const tallies = newest({ ...side.tally, [key]: tally }, TALLY_KEPT, (t) => t.lastAt);
  const mates = Object.entries(tallies).filter(([k]) => k.startsWith(group)).map(([, t]) => t);
  const all = mates.reduce((sum, t) => sum + t.n, 0);
  const notes = mates.filter((t) => t.n >= NOTE_AFTER && 2 * t.n > all).map(({ app, note, n, lastAt }): AppNote => ({ app, note, n, lastAt })).filter((n) => !dropped(n));
  const ranked = [...side.notes.filter((n) => !mates.some((t) => t.app === n.app && t.note === n.note)), ...notes].sort((a, b) => b.n - a.n || b.lastAt.localeCompare(a.lastAt));
  const perApp = new Map<string, number>();
  return { tally: tallies, notes: ranked.filter((n) => { const k = (perApp.get(n.app) ?? 0) + 1; perApp.set(n.app, k); return k <= NOTES_PER_APP; }).slice(0, NOTES_KEPT) };
}

/** Set 5 R3: answers the proposals card keeps, the newest. */
const ANSWERS_KEPT = 24;

export const appNotes: Rule = (state, event) => {
  // The owner's answer on the proposals card: kept (shown no more there) or dropped (out of every brief, never mined again).
  if (event.type === 'proposal:answered' && event.payload.kind === 'app-note' && typeof event.payload.key === 'string') {
    const slice = state.appNotes ?? EMPTY;
    const key = event.payload.key;
    const verdict = event.payload.verdict === 'accepted' ? 'kept' : 'dropped';
    const answered = Object.fromEntries([...Object.entries(slice.answered ?? {}).filter(([k]) => k !== key), [key, verdict] as const].slice(-ANSWERS_KEPT));
    const owner = verdict === 'dropped' ? { ...slice.owner, notes: slice.owner.notes.filter((n) => noteKey(n) !== key) } : slice.owner;
    return { state: { ...state, appNotes: { ...slice, owner, answered } }, effects: [] };
  }
  if (event.type !== 'screen:step') return { state, effects: [] };
  const p = event.payload;
  const app = word(p.processName, 80);
  if (!app) return { state, effects: [] };
  const session = typeof p.session === 'string' ? p.session : '';
  const task = taskOf(state, session)?.id ?? '';
  const slice = state.appNotes ?? EMPTY;
  const at = `${session}\n${app}`;
  const move = moveOf(p);
  const put = (next: AppNotesSlice) => ({ state: { ...state, appNotes: next }, effects: [] });

  if (p.ok === false) {
    const reason = word(p.reason, 40) || 'unknown';
    if (NOT_THE_APP.has(reason)) return { state, effects: [] };
    // Review S5R2 L4: the newest OPEN_KEPT of each side, so a bench's failures never push out the owner's.
    const rig = isRigSession(state, session) || isRigWindow(p.windowTitle) || byGnomonMarked(state, event) === 'rig';
    const waiting = { ...slice.open, [at]: { task, reason, failed: move, at: event.ts, ...(rig ? { rig: true } : {}) } };
    const side = (r: boolean) => newest(Object.fromEntries(Object.entries(waiting).filter(([, o]) => (o.rig === true) === r)), OPEN_KEPT, (o) => o.at);
    return put({ ...slice, open: { ...side(false), ...side(true) } });
  }
  const failed = slice.open[at];
  if (!failed) return { state, effects: [] };
  const open = Object.fromEntries(Object.entries(slice.open).filter(([k]) => k !== at));
  // Another task's failure, or the same move again: closed, nothing learned.
  if (failed.task !== task || failed.failed === move) return put({ ...slice, open });
  const rig = isRigSession(state, session) || isRigWindow(p.windowTitle) || byGnomonMarked(state, event) === 'rig';
  const note = `${failed.failed} is refused here (${failed.reason}); ${move} worked after it`;
  const group = `${app}\n${failed.reason}\n${failed.failed}\n`;
  const side = counted(rig ? slice.rig : slice.owner, `${group}${move}`, group, app, note, task || session || event.id, event.ts, (n) => slice.answered?.[noteKey(n)] === 'dropped');
  return put({ ...slice, open, ...(rig ? { rig: side } : { owner: side }) });
};
