import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserSnapshot } from './browser-capture.js';

/** Firefox-family browsers have no AppleScript tab API. Each keeps a session file with every open tab: no extension, no grant. Window process name → its profiles folder. */
const PROFILES: Record<string, string> = { Zen: 'zen/Profiles', Firefox: 'Firefox/Profiles' };

const MAX_SESSION_BYTES = 256 * 1024 * 1024;

/** `mozLz40\0`, the plain size as a u32, then one LZ4 block. */
export function decodeMozLz4(buf: Buffer): Buffer {
  if (buf.subarray(0, 8).toString('latin1') !== 'mozLz40\0') throw new Error('not a mozlz4 file');
  const size = buf.readUInt32LE(8);
  if (size > MAX_SESSION_BYTES) throw new Error('mozlz4 size out of range');
  const out = Buffer.alloc(size);
  let i = 12;
  let o = 0;
  const more = (n: number) => {
    let b = 255;
    while (n >= 15 && b === 255 && i < buf.length) n += b = buf[i++]!;
    return n;
  };
  while (i < buf.length) {
    const token = buf[i++]!;
    const literals = more(token >> 4);
    buf.copy(out, o, i, i + literals);
    i += literals;
    o += literals;
    if (i >= buf.length) break;
    const offset = buf[i]! | (buf[i + 1]! << 8);
    i += 2;
    if (offset === 0 || offset > o) throw new Error('mozlz4 offset out of range');
    // A match can overlap its own output, so it is copied one byte at a time.
    for (const end = Math.min(size, o + more(token & 15) + 4); o < end; o++) out[o] = out[o - offset]!;
  }
  return out.subarray(0, o);
}

interface SessionFile {
  selectedWindow?: number;
  windows?: Array<{ selected?: number; tabs?: SessionTab[] }>;
}

interface SessionTab {
  index?: number;
  lastAccessed?: number;
  entries?: Array<{ url?: unknown; title?: unknown }>;
}

/** The page in the front tab of the selected window (the indexes count from 1). */
export function selectedTab(session: SessionFile): { url: string; title: string | null } | null {
  const win = session.windows?.[(session.selectedWindow ?? 1) - 1];
  const tabs = win?.tabs ?? [];
  // The front tab is stamped "accessed now" at each write. `selected` is the fallback only: on Zen it was measured one off.
  const tab = tabs.reduce<SessionTab | undefined>((best, t) => ((t.lastAccessed ?? 0) > (best?.lastAccessed ?? 0) ? t : best), tabs[(win?.selected ?? 1) - 1]);
  const entry = tab?.entries?.[(tab.index ?? 1) - 1];
  return typeof entry?.url === 'string' ? { url: entry.url, title: typeof entry.title === 'string' ? entry.title : null } : null;
}

/** Origin and path only: the query never leaves this file. */
const pageUrl = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !/^https?:/.test(raw) || !URL.canParse(raw)) return null;
  const parsed = new URL(raw);
  return parsed.origin + parsed.pathname;
};

/** Every open web page by its title. A title on two different pages names neither. */
export function pagesByTitle(session: SessionFile): Map<string, string | null> {
  const pages = new Map<string, string | null>();
  for (const tab of (session.windows ?? []).flatMap((w) => w.tabs ?? [])) {
    const entry = tab.entries?.[(tab.index ?? 1) - 1];
    const url = pageUrl(entry?.url);
    if (typeof entry?.title !== 'string' || entry.title === '' || url === null) continue;
    pages.set(entry.title, pages.has(entry.title) && pages.get(entry.title) !== url ? null : url);
  }
  return pages;
}

/**
 * The front tab of a Firefox-family browser, in the helper's own shape, or null for an app with no known session file.
 * The browser rewrites the file about every 15 s, so a tab can be up to 15 s late. A private window is never in it.
 */
export class SessionStoreReader {
  private cache: { file: string; mtimeMs: number; snapshot: BrowserSnapshot; pages: Map<string, string | null> } | null = null;

  constructor(private readonly root = path.join(os.homedir(), 'Library', 'Application Support')) {}

  read(app: string): BrowserSnapshot | null {
    const dir = PROFILES[app];
    if (dir === undefined) return null;
    try {
      // The profile in use is the one whose session file changed last.
      const newest = fs
        .readdirSync(path.join(this.root, dir))
        .map((profile) => path.join(this.root, dir, profile, 'sessionstore-backups', 'recovery.jsonlz4'))
        .map((file) => ({ file, mtimeMs: fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
      if (!newest || newest.mtimeMs === 0) return null;
      if (this.cache?.file === newest.file && this.cache.mtimeMs === newest.mtimeMs) return this.cache.snapshot;
      // ponytail: the whole file is parsed on each rewrite (a few MB, at most every 15 s while that browser is in front); stream it if that shows in a profile.
      const session = JSON.parse(decodeMozLz4(fs.readFileSync(newest.file)).toString('utf-8')) as SessionFile;
      const tab = selectedTab(session);
      const url = pageUrl(tab?.url);
      const snapshot: BrowserSnapshot = { timestamp: new Date(newest.mtimeMs).toISOString(), app, bundleId: app, url, title: url ? tab!.title : null, authorized: true, error: null };
      this.cache = { ...newest, snapshot, pages: pagesByTitle(session) };
      return snapshot;
    } catch {
      return null;
    }
  }

  /** The page a window's title names, or null. The title is the proof: the "front tab" is not asked, it can be 15 s old. */
  urlOf(app: string, windowTitle: string): string | null {
    return this.read(app) ? (this.cache?.pages.get(windowTitle) ?? null) : null;
  }
}

/** One reader for the window sensor and the browser sensor, so the file is parsed once per rewrite. */
export const sessionStore = new SessionStoreReader();
