import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripUrlQuery } from '@sundial/helpers/redact/redact-url.js';
import { isSensitiveProcess } from '@sundial/helpers/redact/redact-policy.js';
import { isSensitiveProcessName } from '@sundial/helpers/redact/redact.js';
import { effectiveSensitiveApps } from '@sundial/helpers/redact/redaction-tier.js';
import { privacyConfig } from '@sundial/helpers/privacy-config.js';

/**
 * Arc's tabs in the space the owner is in (UC2 item 5), read from Arc's own
 * `StorableSidebar.json` and `StorableWindows.json`, so a return can offer the
 * tabs of the space it left. Read-only, own Application Support: no TCC.
 *
 * The format is undocumented. A space lists its containers as
 * `['pinned', id, 'unpinned', id]`; a container's `childrenIds` lead to items,
 * and a tab item holds `data.tab.savedURL`, `savedTitle` and `timeLastActiveAt`.
 * The focused space is the windows file's `lastFocusedSpaceID`. Anything that
 * does not parse is no event, never a guess.
 *
 * Every URL is cut to origin + path here (and again by `stripUrlQuery` and at
 * ingest): a query is where a token or a search lives. A tab whose host names
 * a sensitive or hidden app (paypal, bitwarden, mail, ...) is dropped whole,
 * the list the browser sensor drops a sensitive app by; Arc itself on that
 * list is no event at all. Emits only when the set of tabs changes, not on a
 * switch between them.
 */
export interface ArcSpaceEvent {
  type: 'browser:arc-space';
  payload: { timestamp: string; title: string | null; tabs: { url: string; title: string | null }[] };
}

/** The tabs kept per space, most recently active first. */
export const MAX_ARC_TABS = 12;
const POLL_MS = 15_000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** origin + path of an http(s) URL, or null. */
function cleanUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const cut = stripUrlQuery(u.origin + u.pathname);
    return cut === '[redacted-url]' ? null : cut;
  } catch {
    return null;
  }
}

/** A site the privacy lists name, matched on its host the way an app is matched on its name. */
function sensitiveSite(url: string): boolean {
  try {
    return isSensitiveProcessName(new URL(url).host, [...effectiveSensitiveApps(), ...privacyConfig.hiddenApps]);
  } catch {
    return true;
  }
}

/** The focused space and its tabs, from the two files' parsed contents. Pure. */
export function readArcSpace(sidebar: unknown, windows: unknown): Omit<ArcSpaceEvent['payload'], 'timestamp'> | null {
  const spaceId = isObj(windows) ? (windows.lastFocusedSpaceID ?? (Array.isArray(windows.windows) && isObj(windows.windows[0]) ? windows.windows[0].focusedSpaceID : null)) : null;
  const containers = isObj(sidebar) && isObj(sidebar.sidebar) && Array.isArray(sidebar.sidebar.containers) ? sidebar.sidebar.containers : [];
  const live = containers.find((c) => isObj(c) && Array.isArray(c.spaces) && Array.isArray(c.items));
  if (typeof spaceId !== 'string' || !isObj(live)) return null;
  const space = (live.spaces as unknown[]).find((s): s is Json => isObj(s) && s.id === spaceId);
  if (!space) return null;
  const items = new Map<string, Json>();
  for (const it of live.items as unknown[]) if (isObj(it) && typeof it.id === 'string') items.set(it.id, it);

  const tabs: { url: string; title: string | null; at: number }[] = [];
  const seen = new Set<string>();
  const walk = (id: unknown, depth: number) => {
    const item = typeof id === 'string' ? items.get(id) : undefined;
    if (!item || depth > 8 || seen.has(item.id as string)) return;
    seen.add(item.id as string);
    const tab = isObj(item.data) && isObj(item.data.tab) ? item.data.tab : null;
    const url = tab ? cleanUrl(tab.savedURL) : null;
    if (tab && url && !sensitiveSite(url)) tabs.push({ url, title: typeof item.title === 'string' ? item.title : typeof tab.savedTitle === 'string' ? tab.savedTitle : null, at: typeof tab.timeLastActiveAt === 'number' ? tab.timeLastActiveAt : 0 });
    for (const child of Array.isArray(item.childrenIds) ? item.childrenIds : []) walk(child, depth + 1);
  };
  for (const id of Array.isArray(space.containerIDs) ? space.containerIDs : []) if (id !== 'pinned' && id !== 'unpinned') walk(id, 0);
  tabs.sort((a, b) => b.at - a.at);
  return { title: typeof space.title === 'string' ? space.title : null, tabs: tabs.slice(0, MAX_ARC_TABS).map(({ url, title }) => ({ url, title })) };
}

export class ArcTabsSensor {
  private checkedAt = 0;
  private mtimes = '';
  private last = '';

  constructor(private readonly dir = path.join(os.homedir(), 'Library', 'Application Support', 'Arc')) {}

  poll(now = Date.now()): ArcSpaceEvent | null {
    if (now - this.checkedAt < POLL_MS) return null;
    this.checkedAt = now;
    const files = ['StorableSidebar.json', 'StorableWindows.json'].map((f) => path.join(this.dir, f));
    try {
      const mtimes = files.map((f) => fs.statSync(f).mtimeMs).join('|');
      if (mtimes === this.mtimes) return null;
      this.mtimes = mtimes;
      const [sidebar, windows] = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as unknown);
      const space = isSensitiveProcess('Arc') ? null : readArcSpace(sidebar, windows);
      // The set, not the order: switching tabs reorders them by last active.
      const key = JSON.stringify(space && { title: space.title, tabs: space.tabs.map((t) => `${t.url} ${t.title}`).sort() });
      if (!space || key === this.last) return null;
      this.last = key;
      return { type: 'browser:arc-space', payload: { timestamp: new Date(now).toISOString(), ...space } };
    } catch {
      return null;
    }
  }
}
