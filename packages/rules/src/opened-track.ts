import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js';
import { plainTitle as plain, SEEN_MAX } from '@sundial/helpers/opened.js';
import { taskOf } from '@sundial/helpers/task-of.js';
import { isRigSession } from '@sundial/kernel/read/rig-session.js';
import type { KernelState, OpenedItem, OpenedSlice, Rule } from '@sundial/kernel/types.js';

/**
 * Set 5 R2 (plan 21, 2E): what Gnomon opened and is still open. "Leave the app as you found it" was one sentence in the tool text,
 * and no state held what Gnomon had opened: runs 215, 217 and 224 typed into, or landed on, a Save sheet an earlier task had left.
 *
 * Folded from the screen tools' own rows. A step that worked (`screen:step`, ok) opened something when:
 * - its after-look (`screen:looked` with `after` = the step's id, which lands before the step row) shows a sheet or dialog that the
 *   look before it did not: a sheet;
 * - or its verb and thing say so: cmd+n or a menu's New (Window, Document) a window; cmd+t, a menu's New Tab or a web address a tab;
 *   cmd+s, cmd+shift+s, cmd+o, cmd+p, or a menu item or button whose name ends in an ellipsis (Save As…, Export…) a sheet. A sheet
 *   whose after-look shows none was not opened (a cmd+s that saved in place).
 * It is closed when the log shows it: a later look of the app with no sheet in that window, a look whose window list lacks the window,
 * a close step (cmd+w, Close, a close button) in that window, or a quit of the app.
 *
 * Per chat (the step's session), the newest `OPENED_ITEMS`; at most `OPENED_CHATS` chats, a rig chat's dropped before the owner's.
 * Per app, its newest look's sheet or dialog (`fronts`, at most `MAX_FRONTS`), for the check before a task's first key
 * (helpers `leftModal`). The brief says what is still open (helpers `openedLine`).
 * Per app, the window sensor's newest sheet or dialog as the owner left it (`sensed`, `window:changed`): with `fronts`, what the
 * brief names as left open by someone else (helpers `leftOpen`).
 */
export const OPENED_ITEMS = 6;
export const OPENED_CHATS = 8;
const MAX_FRONTS = 12;

type Front = OpenedSlice['fronts'][string];
const EMPTY: OpenedSlice = { chats: {}, fronts: {} };
const ELLIPSIS = /\s*(…|\.\.\.)$/;
const SHEET_KEYS: Record<string, string> = { 'cmd+s': 'Save', 'cmd+shift+s': 'Save As', 'cmd+alt+shift+s': 'Save As', 'cmd+o': 'Open', 'cmd+p': 'Print' };

const str = (v: unknown, n = 120) => (typeof v === 'string' && v.trim() !== '' && !isRedactedPlaceholder(v.trim()) ? v.trim().slice(0, n) : '');
/** A menu path's last item ("File > Save As…" is "Save As…"). */
const itemOf = (name: string) => name.split('>').at(-1)!.trim();
/** The newest `n` entries of a record kept in insertion order, with `key` moved to the end (or dropped when `value` is undefined). */
const newest = <T>(rec: Record<string, T>, key: string, value: T | undefined, n: number): Record<string, T> =>
  Object.fromEntries([...Object.entries(rec).filter(([k]) => k !== key), ...(value === undefined ? [] : [[key, value] as [string, T]])].slice(-n));

/** What a step that worked opened, by its verb and thing; null for nothing. */
function opener(verb: unknown, name: string, key: string, title: string): Pick<OpenedItem, 'kind' | 'label'> | null {
  const tab = { kind: 'tab' as const, label: `${title || name || 'new'} tab` };
  if (verb === 'open') return /^[^\s/]+\.[^\s]/.test(name) ? tab : null;
  if (verb === 'key') {
    if (key === 'cmd+n') return { kind: 'window', label: title ? `"${title}" window` : 'new window' };
    if (key === 'cmd+t') return tab;
    return SHEET_KEYS[key] ? { kind: 'sheet', label: `${SHEET_KEYS[key]} sheet` } : null;
  }
  const item = itemOf(name);
  if (verb === 'pick-menu' && /^new\b.*\btab$/i.test(item.replace(ELLIPSIS, ''))) return tab;
  if (verb === 'pick-menu' && /^new( (private |incognito )?(window|document))?$/i.test(item.replace(ELLIPSIS, ''))) return { kind: 'window', label: title ? `"${title}" window` : 'new window' };
  return ['pick-menu', 'press', 'click'].includes(String(verb)) && ELLIPSIS.test(item) ? { kind: 'sheet', label: `${item.replace(ELLIPSIS, '')} sheet` } : null;
}

/** `chats` with each item `gone` says is closed taken out, and a chat left empty dropped. */
function without(chats: OpenedSlice['chats'], gone: (i: OpenedItem) => boolean): OpenedSlice['chats'] {
  let changed = false;
  const out: OpenedSlice['chats'] = {};
  for (const [session, chat] of Object.entries(chats)) {
    const items = chat.items.filter((i) => !gone(i));
    if (items.length !== chat.items.length) changed = true;
    if (items.length > 0) out[session] = items.length === chat.items.length ? chat : { ...chat, items };
  }
  return changed ? out : chats;
}

/** A look of `app`: its front kept, and what it shows closed taken out. A refused look says nothing about the app. */
function looked(was: OpenedSlice, p: Record<string, unknown>, app: string, at: string): OpenedSlice {
  const look = str(p.id, 80);
  if (!look || typeof p.refused === 'string') return was;
  const dialog = p.dialog === true;
  // Doc 30 (run 252): with a sheet in front the look's own title is blank; the sheet sits on the app's main window.
  const main = dialog && Array.isArray(p.windows) ? (p.windows as ({ windowTitle?: unknown; main?: unknown } | null)[]).find((w) => w?.main === true)?.windowTitle : '';
  const [window, after] = [str(p.windowTitle) || str(main), str(p.after, 80)];
  const titles = Array.isArray(p.windows) && p.windows.length > 0 ? p.windows.map((w) => plain(str((w as { windowTitle?: unknown } | null)?.windowTitle))) : null;
  const before = was.fronts[app];
  // Review S5R2 M3: the same sheet while looks of that window keep showing one; its sightings go with it.
  const same = dialog && before?.dialog === true && plain(before.window) === plain(window);
  const since = dialog ? (same ? (before.since ?? before.at) : at) : undefined;
  const seen = same && before.seen?.length ? before.seen : undefined;
  const front: Front = { dialog, look, at, ...(window ? { window } : {}), ...(after ? { after } : {}), ...(before ? { was: before.dialog } : {}), ...(since ? { since } : {}), ...(seen ? { seen } : {}) };
  const lacks = (title?: string) => Boolean(title && titles && !titles.includes(plain(title)));
  const gone = (i: OpenedItem) =>
    i.app === app && (i.kind === 'sheet' ? (!dialog && (!i.window || !window || plain(i.window) === plain(window))) || lacks(i.window) : i.kind === 'window' && lacks(i.name));
  return { ...was, chats: without(was.chats, gone), fronts: newest(was.fronts, app, front, MAX_FRONTS) };
}

/** A step that worked: a quit or a close takes out what it ends, anything else may open one thing in its chat. */
function stepped(state: KernelState, was: OpenedSlice, p: Record<string, unknown>, app: string, at: string): OpenedSlice {
  if (p.ok !== true) return was;
  const name = str(Array.isArray(p.screenText) ? p.screenText[0] : '');
  const key = p.verb === 'key' ? (str(p.key, 40) || name).toLowerCase().replace(/\s/g, '') : '';
  const item = itemOf(name);
  if (p.quit === true || key === 'cmd+q' || (p.verb === 'pick-menu' && /^quit\b/i.test(item))) {
    const chats = without(was.chats, (i) => i.app === app);
    if (chats === was.chats && !was.fronts[app] && !was.sensed?.[app]) return was;
    return { ...was, chats, fronts: newest(was.fronts, app, undefined, MAX_FRONTS), ...(was.sensed ? { sensed: newest(was.sensed, app, undefined, MAX_FRONTS) } : {}) };
  }
  const window = str(p.windowTitle);
  if (key === 'cmd+w' || key === 'cmd+shift+w' || (p.verb === 'pick-menu' && /^close\b/i.test(item)) || (['press', 'click'].includes(String(p.verb)) && /close button/i.test(String(p.role ?? '')))) {
    const chats = window ? without(was.chats, (i) => i.app === app && ((Boolean(i.name) && plain(i.name) === plain(window)) || (i.kind === 'sheet' && plain(i.window) === plain(window)))) : was.chats;
    return chats === was.chats ? was : { ...was, chats };
  }
  const [session, id] = [typeof p.session === 'string' ? p.session : '', str(p.id, 80)];
  if (!session || !id) return was;
  const title = str((p.then as { windowTitle?: unknown } | undefined)?.windowTitle);
  // The step's own after-look, when it came: the sheet it shows (or does not) is the proof.
  const front = was.fronts[app];
  const after = front?.after === id ? front : null;
  const task = taskOf(state, session)?.id;
  // Review S5R2 M3: this chat's own step's after-look showed the sheet (its act result printed it): seen in this task.
  const sighted = after?.dialog && !(after.seen ?? []).some((s) => s.chat === session && s.task === task)
    ? { ...was, fronts: { ...was.fronts, [app]: { ...after, seen: [...(after.seen ?? []), { chat: session, ...(task ? { task } : {}) }].slice(-SEEN_MAX) } } }
    : was;
  let opened = opener(p.verb, name, key, title);
  if (opened?.kind === 'sheet' && after && (!after.dialog || after.was === true)) opened = null;
  if (!opened && after?.dialog && after.was === false) opened = { kind: 'sheet', label: name ? `sheet after "${item.slice(0, 40)}"` : 'a sheet' };
  if (!opened) return sighted;
  was = sighted;
  // Doc 30 (run 252): a later look can replace the step's after-look before its row lands, and with a sheet in front the step's
  // own window is blank: then the newest look's sheet says which window it sits on.
  const sheetOn = after?.window || window || (front?.dialog ? front.window : undefined);
  const add: OpenedItem = {
    ...opened,
    app,
    ...(opened.kind !== 'sheet' && title ? { name: title } : {}),
    ...(opened.kind === 'sheet' && sheetOn ? { window: sheetOn } : {}),
    at,
    step: id,
    ...(task ? { task } : {}),
  };
  const chat = was.chats[session];
  // A second Save sheet over another window is another sheet, not this one again.
  const items = [...(chat?.items ?? []).filter((i) => !(i.app === app && i.kind === add.kind && i.label === add.label && plain(i.window) === plain(add.window))), add].slice(-OPENED_ITEMS);
  // The oldest chat out past the cap, a rig chat's before the owner's.
  const all = Object.entries({ ...was.chats, [session]: { at, items } }).sort((a, b) => (a[1].at < b[1].at ? -1 : a[1].at > b[1].at ? 1 : 0));
  while (all.length > OPENED_CHATS) {
    const rig = all.findIndex(([s]) => isRigSession(state, s));
    all.splice(rig >= 0 ? rig : 0, 1);
  }
  return { ...was, chats: Object.fromEntries(all) };
}

/**
 * S5R2 (leftover mention): a `window:changed` says the app it left (`previousWindow`) and the one it brought up, each with or
 * without a sheet or dialog in front (the window helper's `sheet`). One is kept when it says a sheet, or when it says none and is
 * newer than what was kept or than a look that said one; else nothing is written. A window whose title sanitize-at-ingest
 * replaced is a private app's: its sighting goes, and nothing is kept.
 */
function sensedOf(was: OpenedSlice, p: Record<string, unknown>, at: string): OpenedSlice {
  const start = was.sensed ?? {};
  let sensed = start;
  for (const w of [p.previousWindow, p] as (Record<string, unknown> | null | undefined)[]) {
    const app = str(w?.processName, 80);
    if (!app) continue;
    const title = typeof w?.windowTitle === 'string' ? w.windowTitle.trim() : '';
    const [had, look] = [sensed[app], was.fronts[app]];
    if (isRedactedPlaceholder(title)) {
      if (had) sensed = newest(sensed, app, undefined, MAX_FRONTS);
    } else if (w?.sheet === true) {
      const window = title === 'No Title Found' ? '' : str(title);
      sensed = newest(sensed, app, { sheet: true, ...(window ? { window } : {}), at }, MAX_FRONTS);
    } else if (had?.sheet || (look?.dialog && !(had && had.at >= look.at))) {
      sensed = newest(sensed, app, { sheet: false, at }, MAX_FRONTS);
    }
  }
  return sensed === start ? was : { ...was, sensed };
}

/** Doc 30: how many leftover sheets named a chat keeps, and how many chats. */
export const SAID_ITEMS = 8;
const SAID_CHATS = 16;

/** A `screen:leftover-said`: one leftover sheet a chat's screen tool answer named, kept for the once-per-task rule and a replay's answer. */
function saidOf(was: OpenedSlice, p: Record<string, unknown>, at: string): OpenedSlice {
  const [session, app] = [str(p.session, 120), str(p.app, 80)];
  if (!session || !app) return was;
  const [window, task] = [str(p.window), str(p.task, 80)];
  const one = { app, ...(window ? { window } : {}), ...(p.earlier === true ? { earlier: true } : {}), ...(task ? { task } : {}), at };
  return { ...was, said: newest(was.said ?? {}, session, [...(was.said?.[session] ?? []), one].slice(-SAID_ITEMS), SAID_CHATS) };
}

/** Single writer of `state.opened`. */
export const openedTrack: Rule = (state, event) => {
  if (event.type === 'screen:leftover-said') {
    const was = state.opened ?? EMPTY;
    const next = saidOf(was, (event.payload ?? {}) as Record<string, unknown>, event.ts);
    return next === was ? { state, effects: [] } : { state: { ...state, opened: next }, effects: [] };
  }
  if (event.type !== 'screen:step' && event.type !== 'screen:looked' && event.type !== 'window:changed') return { state, effects: [] };
  const p = (event.payload ?? {}) as Record<string, unknown>;
  if (event.type === 'window:changed') {
    const was = state.opened ?? EMPTY;
    const next = sensedOf(was, p, event.ts);
    return next === was ? { state, effects: [] } : { state: { ...state, opened: next }, effects: [] };
  }
  const app = str(p.processName, 80);
  if (!app) return { state, effects: [] };
  const was = state.opened ?? EMPTY;
  const next = event.type === 'screen:looked' ? looked(was, p, app, event.ts) : stepped(state, was, p, app, event.ts);
  return next === was ? { state, effects: [] } : { state: { ...state, opened: next }, effects: [] };
};
