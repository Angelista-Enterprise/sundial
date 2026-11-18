import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { privateAppNames, privateApps } from '@sundial/helpers/redact/redact-policy.js';
import { getSundialRuntimeDir } from '@sundial/helpers/sundial-paths.js';

/**
 * The app channel (plan 15, section 2.2): Node tells `Sundial.app` what to do in `app-commands.jsonl`,
 * the app tells Node what the owner did in `app-events.jsonl`. One JSON object per line: a command has
 * `id`, `type` and `at` (UTC); an event has `type` and `at`, and its `id` (a mark's, an act's) is payload. Both sides watch; nobody polls. The app drops a command older than 5 s.
 */
export const APP_COMMANDS = 'app-commands.jsonl';
export const APP_EVENTS = 'app-events.jsonl';

/** What the app may tell the fold. A same-user process that writes the file can never approve, grant or act through it. */
export const ALLOWED = /^(?:voice|overlay):[a-z][a-z-]*$|^screen:(?:mark-(?:placed|cleared)|acted|looked)$|^guide:(?:step|ended)$/;

/** The app's word for a refusal on a private app, as the fold says it for a look the redaction pass blanked: one word for both. */
const said = (reason: unknown) => (reason === 'private-app' ? 'private app' : reason);

/**
 * A look (`screen:looked`) in the field names the one redaction pass knows: the app as `processName` (its `bundleId` beside it:
 * the pass reads both), the title as `windowTitle` (the app's other windows too), every word read off the screen as `screenText`. Things that say and do
 * nothing go (`n` keeps the count the app sent), and an action name that is not the system's own (`AXPress`) is an app's string: it goes too.
 */
export function lookForLog(p: Record<string, unknown>): Record<string, unknown> {
  const { app, window, windows, menus, elements, refused, defaultButton, ...rest } = p;
  const texts = (v: unknown[]) => v.map((x) => (typeof x === 'string' ? x : ''));
  const things = (Array.isArray(elements) ? elements : []).map((e) => (e ?? {}) as Record<string, unknown>);
  // S5R1: the window's default button by its ref alone; its words are its part's `screenText`, which the redaction pass reads.
  const button = (defaultButton ?? {}) as { ref?: unknown };
  return {
    ...rest,
    ...(typeof button.ref === 'string' ? { defaultButton: { ref: button.ref } } : {}),
    ...(refused === undefined ? {} : { refused: said(refused) }),
    ...(typeof app === 'string' ? { processName: app, windowTitle: typeof window === 'string' ? window : '' } : {}),
    ...(Array.isArray(menus) ? { screenText: texts(menus) } : {}),
    ...(Array.isArray(windows) ? { windows: windows.slice(0, 12).map((w) => ({ windowTitle: typeof w?.title === 'string' ? w.title : '', main: w?.main === true, minimized: w?.minimized === true })) } : {}),
    ...(Array.isArray(elements)
      ? {
          n: things.length,
          elements: things
            // S5R1: a group's role description is the app's (a page's aria-roledescription is the page's): a word read off the screen, its fourth.
            .map(({ label, value, in: within, actions, roleDescription, ...shape }) => ({ ...shape, actions: (Array.isArray(actions) ? actions : []).filter((a) => typeof a === 'string' && /^AX[A-Za-z]+$/.test(a)), screenText: texts([label, value, within, ...(typeof roleDescription === 'string' && roleDescription ? [roleDescription] : [])]) }))
            .filter((e: Record<string, unknown> & { actions: unknown[]; screenText: string[] }) => e.screenText[0] || e.screenText[1] || e.actions.length || e.settable === true || (e.ref !== undefined && e.ref === p.focused)),
        }
      : {}),
  };
}

/** An act's answer (`screen:acted`) for the log: its target's app and window in the names the redaction pass knows, so a hidden app is not named. */
function actedForLog(p: Record<string, unknown>): Record<string, unknown> {
  const { app, window, ...target } = (p.target && typeof p.target === 'object' ? p.target : {}) as Record<string, unknown>;
  return {
    ...p,
    ...(p.reason === undefined ? {} : { reason: said(p.reason) }),
    ...(p.target === undefined ? {} : { target: { ...target, ...(typeof app === 'string' ? { processName: app } : {}), ...(typeof window === 'string' ? { windowTitle: window } : {}) } }),
  };
}
const FOR_LOG: Record<string, (p: Record<string, unknown>) => Record<string, unknown>> = { 'screen:looked': lookForLog, 'screen:acted': actedForLog };

export interface AppCommand {
  type: string;
  [field: string]: unknown;
}

/** Appends one command for the app. A command's own id (an act's) stays: the app answers with it. A look, an act or a place carries the private list: the app refuses such an app before it reads a word of it or moves its window. The names a private app goes by in other languages ride as "=name" (item 4, 2026-11-17): the app matches those whole (lookPrivate), the rest as parts. */
export function sendAppCommand(command: AppCommand, dir = getSundialRuntimeDir(), now = new Date()): void {
  fs.mkdirSync(dir, { recursive: true });
  const hidden = ['look', 'act', 'place'].includes(command.type) ? { private: [...privateApps(), ...privateAppNames().map((name) => `=${name}`)] } : {};
  fs.appendFileSync(path.join(dir, APP_COMMANDS), `${JSON.stringify({ id: randomUUID(), ...command, ...hidden, at: now.toISOString() })}\n`, { mode: 0o600 });
}

export interface AppEventWatch {
  /** Reads what the app appended since the last read. The watch calls it; a test may too. */
  poll: () => void;
  stop: () => void;
  /** Lines refused since boot: unparsable, no time, or a type outside the allow list. */
  dropped: () => number;
}

/**
 * Cuts both files to zero (a command never plays twice, an event is never folded twice), then hands
 * each allowed event the app appends to `onEvent`, with the app's time.
 */
export function watchAppEvents(onEvent: (type: string, payload: Record<string, unknown>, ts: string) => void, dir = getSundialRuntimeDir()): AppEventWatch {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of [APP_COMMANDS, APP_EVENTS]) fs.writeFileSync(path.join(dir, name), '', { mode: 0o600 });
  const file = path.join(dir, APP_EVENTS);
  let offset = 0;
  let rest = '';
  const decoder = new StringDecoder('utf8'); // a look is 30 to 80 KB: a read may end inside a character
  let dropped = 0;
  const poll = () => {
    let text = '';
    try {
      const size = fs.statSync(file).size;
      if (size < offset) offset = 0;
      if (size === offset) return;
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        text = decoder.write(buf);
      } finally {
        fs.closeSync(fd);
      }
      offset = size;
    } catch {
      return;
    }
    const lines = (rest + text).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {}
      const { type, at, ...payload } = parsed ?? {};
      if (typeof type !== 'string' || !ALLOWED.test(type) || typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
        dropped++;
        console.warn(`[app-channel] dropped a line from the app (${typeof type === 'string' ? type : 'no type'}); ${dropped} since boot`);
        continue;
      }
      onEvent(type, FOR_LOG[type]?.(payload) ?? payload, new Date(at).toISOString());
    }
    // What the app read off the screen does not stay on disk outside the log: a drained file is cut, when nothing landed since the read.
    if (rest !== '') return;
    try {
      const fd = fs.openSync(file, 'r+');
      try {
        if (fs.fstatSync(fd).size === offset) {
          fs.ftruncateSync(fd, 0);
          offset = 0;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {}
  };
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, (_change, name) => {
      if (name === APP_EVENTS) poll();
    });
  } catch (error) {
    console.warn(`[app-channel] cannot watch ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { poll, stop: () => watcher?.close(), dropped: () => dropped };
}
