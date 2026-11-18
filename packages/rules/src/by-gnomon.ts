import type { KernelState, NotOwners, Rule, SanitizedEvent } from '@sundial/kernel/types.js';

/**
 * Which rows Gnomon caused. Its own screen acts move the focus, and those
 * `window:changed` rows (and the tab, screen-text and input rows beside them)
 * arrive looking exactly like the owner's: on the rig days they minted a
 * `usesTool` fact for a music app on a real project and put rig apps into 5 of
 * 64 learned routines. No row is edited: this rule marks the event being folded,
 * and the owner-learning rules (`ownerOnly` in the manifest) fold nothing on a
 * marked one. The rule itself sits at the top of the manifest, so every reader
 * sees the mark for the same event.
 *
 * Gnomon is acting from an ALLOWED screen tool decision (`action:decided`
 * `allow`, which the first focus change can follow by 70 ms, before the app's
 * answer), the app's answer (`screen:acted`), each step (`screen:step`) and the
 * call's end (`action:performed`), each extending the window by `SETTLE_MS` of
 * event time; an approval (`approval:answered`) only extends a window already
 * open. Inside it, a focus row is Gnomon's when it is in an app this run acted
 * in. Only a window an allowed decision opened, before any app is named, takes
 * a focus row in any app. An `ask` that has not been answered, or a yes, opens
 * nothing: the owner often switches apps right then, to answer the slip. An
 * owner change after the settle, or in another app, stays the owner's.
 *
 * The screen rig's own test windows (a title holding "Testbox" or starting
 * "Rig fixture:") are never the owner's, whenever they come.
 *
 * Known limits: a bare `screen_look` that raises a window has no row before the
 * raise, so its first focus change outside a run reads as the owner's. A slow
 * act is the same: a focus change that lands more than `SETTLE_MS` after the
 * last act row, before the next one (an asked act's first move, a look that
 * takes long), is still the owner's.
 */
export const SETTLE_MS = 3_000;
const MAX_APPS = 4;

const SCREEN_TOOLS = new Set(['screen_act', 'screen_undo']);
/** Rows that say what is in front: the owner-model rules learn from these. */
const FOCUS = new Set(['window:changed', 'browser:tab', 'screen:ocr', 'screen:frame']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The rig's test windows: its mail box and its fixture pages. */
export const isRigWindow = (title: unknown): boolean => typeof title === 'string' && (title.includes('Testbox') || title.startsWith('Rig fixture:'));

/** The rig's fixture folders (`/tmp/gnomon-run*`, `lab/screen-rig/data/fix`): a task that names one is the rig's. */
const RIG_PATH = /\/tmp\/gnomon-run|lab\/screen-rig\/data\/fix/;

/** Text that carries one of the rig's own signs: its test window's name anywhere, or a fixture folder. For a lab read of old
 * rows only: the owner types these words too, so the fold never marks a chat by them (`rigSessions`). */
export const isRigText = (text: unknown): boolean => typeof text === 'string' && (text.includes('Testbox') || text.includes('Rig fixture:') || RIG_PATH.test(text));

/** Why the event being folded is not the owner's, or null when it is. Every owner-learning rule asks this. */
export function byGnomonMarked(state: KernelState, event: SanitizedEvent): NotOwners | null {
  const marked = state.byGnomon?.marked;
  return marked && marked.id === event.id ? marked.why : null;
}

/**
 * What a row says about Gnomon acting on screen: `any` opens a window that takes a focus row in any app until one is
 * named (an allowed decision), `open` opens or extends one for the apps named, `extend` only extends an open one.
 */
function extends_(event: SanitizedEvent): 'any' | 'open' | 'extend' | null {
  const p = event.payload;
  const screen = SCREEN_TOOLS.has(String(p.tool));
  switch (event.type) {
    case 'screen:acted':
    case 'screen:step':
      return 'open';
    case 'action:decided':
      return screen && p.verdict === 'allow' ? 'any' : null;
    case 'approval:answered':
      return screen && String(p.answer ?? '').startsWith('allowed') ? 'extend' : null;
    case 'action:performed':
      return screen ? 'open' : null;
    default:
      return null;
  }
}

/** The app an act row names: the step's, or the target of the app's answer. */
function actApp(event: SanitizedEvent): string | null {
  if (event.type === 'screen:step') return str(event.payload.processName);
  if (event.type === 'screen:acted') return str((event.payload.target as { processName?: unknown } | undefined)?.processName);
  return null;
}

export const byGnomon: Rule = (state, event) => {
  const was = state.byGnomon;
  const p = event.payload;
  const at = Date.parse(event.ts);
  const acting = was.until !== null && at <= Date.parse(was.until);
  const app = str(p.processName) ?? str(p.app);

  let why: NotOwners | null = null;
  if (isRigWindow(p.windowTitle ?? p.title)) why = 'rig';
  else if (acting && FOCUS.has(event.type)) why = app !== null && (was.apps.includes(app) || (was.apps.length === 0 && was.anyApp)) ? 'act' : null;
  else if (acting && event.type === 'input:activity') {
    const ms = typeof p.windowMs === 'number' ? p.windowMs : 0;
    why = ms > 0 && was.since !== null && at - ms >= Date.parse(was.since) ? 'act' : null;
  } else if ((event.type === 'project:detected' || event.type === 'project:switched') && (was.focus === 'rig' || (was.focus === 'act' && acting))) why = was.focus;

  const kind = extends_(event);
  const extend = kind !== null && (kind !== 'extend' || acting);
  const focusChanged = event.type === 'window:changed' && was.focus !== why;
  if (!extend && why === null && !focusChanged) return { state, effects: [] };

  let next = { ...was };
  if (event.type === 'window:changed') next.focus = why;
  if (why !== null) next = { ...next, marked: { id: event.id, why }, n: { ...was.n, [why]: was.n[why] + 1 } };
  if (extend) {
    const named = actApp(event);
    const apps = acting ? was.apps : [];
    next = {
      ...next,
      since: acting ? was.since : event.ts,
      anyApp: (acting && was.anyApp) || kind === 'any',
      until: new Date(Math.max(acting ? Date.parse(was.until!) : 0, at + SETTLE_MS)).toISOString(),
      apps: named === null || apps.includes(named) ? apps : [...apps, named].slice(-MAX_APPS),
    };
  }
  return { state: { ...state, byGnomon: next }, effects: [] };
};
