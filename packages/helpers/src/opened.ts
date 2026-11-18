/**
 * Set 5 R2 (plan 21, 2E): what Gnomon opened and the log has not seen closed (`state.opened`, folded by rules `openedTrack`), and the
 * sheet or dialog in front of an app that the task did not open. Runs 215, 217 and 224 typed into a Save sheet an earlier task had
 * left. Plain structural types, so screen_act (sundial-actions, which does not depend on the kernel) reads the same predicate the
 * brief does (kernel `read/opened.ts`).
 */
import { taskOf, type TaskHost } from './task-of.js';

/** One thing a step opened: a window, a tab, or a sheet (any sheet, dialog or panel). `name` is the title it showed, `label` the words said. */
export interface OpenedItem {
  kind: 'window' | 'tab' | 'sheet';
  app: string;
  label: string;
  name?: string;
  /** For a sheet: the window it sits on. */
  window?: string;
  at: string;
  /** The `screen:step` that opened it, and its chat's task then. */
  step: string;
  task?: string;
}

export interface OpenedSlice {
  /** Per chat (its session), the newest items still open; bounded, a rig chat's dropped before the owner's. */
  chats: Record<string, { at: string; items: OpenedItem[] }>;
  /**
   * Per app, its newest look: a sheet or dialog held the keyboard or not, the window read, the act it followed, whether the look before had one.
   * Review S5R2 M3: `since`, when a look of that window first showed this sheet (one sheet for as long as looks keep showing it), and
   * `seen`, the chats and tasks whose own step's after-look showed it (the act result printed it): at most `SEEN_MAX`.
   */
  fronts: Record<string, { dialog: boolean; look: string; at: string; window?: string; after?: string; was?: boolean; since?: string; seen?: { chat: string; task?: string }[] }>;
  /**
   * S5R2 (leftover mention): per app, the window sensor's word on it as the owner left it (`previousWindow`) or brought it to the
   * front: a sheet or dialog in front of `window`, or none. Kept when it says one, or when it is newer than a look that said one.
   */
  sensed?: Record<string, { sheet: boolean; window?: string; at: string }>;
  /**
   * Doc 30 (runs 250 to 253): per chat (its session), the leftover sheets its screen tools' answers named (`screen:leftover-said`),
   * newest last: each app once per task, and a route replay adds the ones its steps named. Bounded.
   */
  said?: Record<string, LeftoverSaid[]>;
}

/** One leftover sheet a screen tool's answer named: the app, the window it sits on, whether an earlier task of the chat left it. */
export interface LeftoverSaid {
  app: string;
  window?: string;
  earlier?: boolean;
  task?: string;
  at: string;
}

/** Review S5R2 L1: a window title without the tail an unsaved change adds ("Untitled \u2014 Edited" is "Untitled"). */
export const plainTitle = (title?: string) => String(title ?? '').replace(/\s+[\u2014\u2013-]\s+Edited$/, '').trim();

/**
 * Doc 30 (runs 252, 253): one sheet is one app and the window it sits on. A sheet on record with no window is only a sighting with
 * none: as a wildcard, the wall task's cmd+s (no window on record) hid the Save sheet the mess had left over another document.
 */
export const sameSheet = (i: OpenedItem, app: string, window?: string) => i.kind === 'sheet' && i.app === app && plainTitle(i.window) === plainTitle(window);

/** Review S5R2 M3: how many chats' sightings of one sheet a front keeps. */
export const SEEN_MAX = 4;

interface OpenedHost extends TaskHost {
  opened?: OpenedSlice;
  marks?: { chats?: Record<string, { look?: { id: string; app?: string; at?: string } }> } | null;
}

/** A sheet seen longer ago than this is not said: the owner has had the app since. */
export const LEFT_MODAL_MS = 2 * 3_600_000;

/** The brief's line: what this chat opened and is still open, this task's first. Null when nothing is. */
export function openedLine(state: OpenedHost | null | undefined, session: string): string | null {
  const items = state?.opened?.chats?.[session]?.items ?? [];
  if (items.length === 0) return null;
  const task = taskOf(state, session)?.id;
  const say = (xs: OpenedItem[]) => xs.map((i) => `${i.label} in ${i.app}`).join('; ');
  const mine = items.filter((i) => task !== undefined && i.task === task);
  const earlier = items.filter((i) => !mine.includes(i));
  return [mine.length ? `Still open from this task: ${say(mine)}.` : '', earlier.length ? `Still open from an earlier task in this chat: ${say(earlier)}.` : ''].filter(Boolean).join(' ');
}

/**
 * Before a key goes to `app`: its newest look had a sheet or dialog in front, this chat's task did not open it, and this chat has not
 * been shown it. The line to refuse with, or null. Review S5R2 M3: shown once is shown for that sheet, not for one look (every act's
 * after-look replaces the newest): a look of the app this chat printed since the sheet first showed and since its task began, or an
 * after-look of this chat's own step in this task that showed it. A chat with no task that opened the sheet itself goes on too.
 */
export function leftModal(state: OpenedHost | null | undefined, session: unknown, app: unknown, now: number): string | null {
  const want = String(app ?? '').toLowerCase();
  const [name, front] = Object.entries(state?.opened?.fronts ?? {}).find(([a]) => a.toLowerCase() === want) ?? [];
  if (!name || !front?.dialog || !(now - Date.parse(front.at) <= LEFT_MODAL_MS)) return null;
  const chat = typeof session === 'string' ? session : '';
  const printed = state?.marks?.chats?.[chat]?.look;
  if (printed?.id === front.look) return null;
  const mine = taskOf(state, chat);
  const task = mine?.id;
  const after = (at: string | undefined, than: string | undefined) => Boolean(at && than && Date.parse(at) >= Date.parse(than));
  if (String(printed?.app ?? '').toLowerCase() === want && after(printed?.at, front.since ?? front.at) && (!mine || after(printed?.at, mine.at))) return null;
  if ((front.seen ?? []).some((s) => s.chat === chat && s.task === task)) return null;
  const ours = [...(state?.opened?.chats?.[chat]?.items ?? [])].reverse().find((i) => i.app === name && i.kind === 'sheet' && (!i.window || !front.window || i.window === front.window));
  if (ours && ours.task === task) return null;
  const whose = ours ? `you opened it in an earlier task (${ours.label})` : 'this task did not open it';
  return `${name} has a sheet or dialog in front${front.window ? ` of "${front.window}"` : ''}, and ${whose}: a key sent now goes into it. screen_look ${name} first, then close it (key escape, or its Cancel) or finish it.`;
}

/**
 * S5R2 (owner, 2026-11-17): the sheets or dialogs in front of an app that this chat did not open, for the brief to name so the
 * answer can say it left them alone. Per app the newer of Gnomon's own look (`fronts`) and the window sensor (`sensed`), seen
 * within `LEFT_MODAL_MS`. A sheet this chat opened is `openedLine`'s. A private app is never here: its look is refused and the
 * fold keeps no sighting of a window whose title sanitize-at-ingest replaced.
 */
export function leftOpen(state: OpenedHost | null | undefined, session: string, now: number): { app: string; window?: string }[] {
  const { fronts = {}, sensed = {} } = state?.opened ?? {};
  const mine = state?.opened?.chats?.[session]?.items ?? [];
  return [...new Set([...Object.keys(fronts), ...Object.keys(sensed)])].flatMap((app) => {
    const [look, seen] = [fronts[app], sensed[app]];
    const last = look && (!seen || Date.parse(look.at) > Date.parse(seen.at)) ? { open: look.dialog, window: look.window, at: look.at } : seen ? { open: seen.sheet, window: seen.window, at: seen.at } : null;
    if (!last?.open || !(now - Date.parse(last.at) <= LEFT_MODAL_MS)) return [];
    if (mine.some((i) => sameSheet(i, app, last.window))) return [];
    return [{ app, ...(last.window ? { window: last.window } : {}) }];
  });
}
