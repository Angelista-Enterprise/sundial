import { stripUrlQuery } from '@sundial/helpers/redact/redact-url.js';
import { isSensitiveProcess, privateApps } from '@sundial/helpers/redact/redact-policy.js';
import { privacyConfig } from '@sundial/helpers/privacy-config.js';
import { isBrowser } from '@sundial/helpers/window-classification.js';
import { BrowserHelperSupervisor, readBrowserSidecar, type BrowserSnapshot } from './browser-capture.js';
import { sessionStore, type SessionStoreReader } from './session-store.js';

export interface BrowserTabEvent {
  type: 'browser:tab';
  payload: { timestamp: string; app: string; url: string; host: string; path: string; title: string | null };
}

export interface BrowserStatusEvent {
  type: 'browser:status';
  /** `supported: false`: a browser in front whose tabs nothing here can read. */
  payload: { timestamp: string; app: string; authorized: boolean; error: string | null; supported?: false };
}

/** J3.4: the page's own words, sanitized at ingest, used only as fan-out evidence (and by the ingest anomaly check). */
export interface PageTextEvent {
  type: 'page:text';
  payload: { timestamp: string; app: string; url: string; host: string; path: string; title: string | null; text: string };
}

export type BrowserEvent = BrowserTabEvent | BrowserStatusEvent | PageTextEvent;

/** A window title without its browser's suffix ("Guide \u2014 Zen Browser" is "Guide"). */
const bareTitle = (title: string): string => title.replace(/\s[\u2014\u2013-]\s[^\u2014\u2013-]*$/u, '');

/** Fable M2: the helper's words are the session's front tab's only when the page and its window both name that tab. */
export function sameTab(snapshot: BrowserSnapshot, title: string | null): boolean {
  const window = snapshot.windowTitle ?? null;
  return title !== null && title !== '' && snapshot.title === title && window !== null && (window === title || bareTitle(window) === title);
}

const SIGN_IN = /sign in|log in|login|password|wachtwoord|inloggen/i;

/** Fable H3: a page whose words are never kept: a private host (and its subdomains), a host or title holding a private app's name, a sign-in page. */
export function privatePage(host: string, title: string | null): boolean {
  const h = host.toLowerCase();
  const t = (title ?? '').toLowerCase();
  return privacyConfig.privateHosts.some((p) => h === p || h.endsWith(`.${p}`)) || privateApps().some((app) => app !== '' && (h.includes(app) || t.includes(app))) || SIGN_IN.test(t);
}

/** Same key the helper changes on: the browser and the origin+path. */
export function tabKey(snapshot: BrowserSnapshot): string {
  return `${snapshot.bundleId ?? ''}|${snapshot.url ?? ''}`;
}

/**
 * The browser tab the owner is looking at, as an event when it changes.
 *
 * Reads the helper's snapshot file each poll (the helper is kept alive by the
 * supervisor and spawned on the first poll). Emits `browser:tab` on a change of
 * (browser, origin+path) and `browser:status` when authorization flips, so
 * the sensor health check can tell "no browser open" from "the owner never clicked
 * Allow". The URL is stripped of its query TWICE — the helper never writes one,
 * and `stripUrlQuery` applies the owner's redaction tier on top (tier 3 keeps
 * the origin alone). A sensitive process (the redaction policy's list) is
 * never reported; a private window never reaches the file.
 */
export class BrowserSensor {
  private lastKey: string | null = null;
  /** The tab whose words were said: a tab's words come once, with the tab or later. */
  private lastTextKey: string | null = null;
  private lastAuthorized: boolean | null = null;
  private lastUnsupported: string | null = null;
  private front: string | null = null;
  private frontSince = 0;
  private readonly supervisor: BrowserHelperSupervisor;
  private readonly session: SessionStoreReader;

  constructor(options: { enabled?: boolean; supervisor?: BrowserHelperSupervisor; session?: SessionStoreReader } = {}) {
    this.enabled = options.enabled ?? true;
    this.supervisor = options.supervisor ?? new BrowserHelperSupervisor();
    this.session = options.session ?? sessionStore;
  }

  private readonly enabled: boolean;

  /** `front`: the app the window sensor has in front, for the browsers the helper does not know. */
  poll(now = Date.now(), front: string | null = null): BrowserEvent[] {
    if (!this.enabled) return [];
    this.supervisor.ensure(now);
    const snapshot = readBrowserSidecar(now);
    if (!snapshot) return [];
    return this.eventsWith(snapshot, front, now);
  }

  /** The helper's snapshot, or for a browser it does not know: that browser's session file, or one `supported: false` status. */
  eventsWith(snapshot: BrowserSnapshot, front: string | null, now: number): BrowserEvent[] {
    if (front !== this.front) {
      this.front = front;
      this.frontSince = now;
    }
    if (snapshot.app !== null || front === null) return this.eventsFor(snapshot);
    const session = this.session.read(front);
    // S4: a Firefox-family page's words, read by the helper over Accessibility, belong to the session's front tab only when the titles agree.
    if (session) return this.eventsFor(snapshot.text && sameTab(snapshot, session.title) ? { ...session, text: snapshot.text } : session);
    // A browser in front that nothing here can read: said once, so the gap is on the record. The helper's "no browser" must be newer than the switch.
    if (!isBrowser(front) || front === this.lastUnsupported || Date.parse(snapshot.timestamp) <= this.frontSince) return this.eventsFor(snapshot);
    this.lastUnsupported = front;
    return [{ type: 'browser:status', payload: { timestamp: snapshot.timestamp, app: front, authorized: true, supported: false, error: null } }, ...this.eventsFor(snapshot)];
  }

  /** Pure: which events a fresh snapshot produces given what was last seen. */
  eventsFor(snapshot: BrowserSnapshot): BrowserEvent[] {
    const events: BrowserEvent[] = [];
    if (snapshot.app !== null) this.lastUnsupported = null;
    if (snapshot.app !== null && this.lastAuthorized !== snapshot.authorized) {
      this.lastAuthorized = snapshot.authorized;
      events.push({ type: 'browser:status', payload: { timestamp: snapshot.timestamp, app: snapshot.app, authorized: snapshot.authorized, error: snapshot.error } });
    }
    const key = tabKey(snapshot);
    const fresh = key !== this.lastKey;
    const text = typeof snapshot.text === 'string' ? snapshot.text.trim() : '';
    if (fresh) this.lastTextKey = null;
    if (!fresh && (text === '' || this.lastTextKey === key)) return events;
    this.lastKey = key;
    if (snapshot.app === null || snapshot.url === null || !snapshot.authorized) return events;
    if (isSensitiveProcess(snapshot.app)) return events;
    const url = stripUrlQuery(snapshot.url);
    if (url === '[redacted-url]') return events;
    let host = '';
    let path = '';
    try {
      const parsed = new URL(url);
      host = parsed.host;
      path = parsed.pathname;
    } catch {
      return events;
    }
    if (host === '') return events;
    if (fresh) events.push({ type: 'browser:tab', payload: { timestamp: snapshot.timestamp, app: snapshot.app, url, host, path, title: snapshot.title } });
    // J3.4: the text rides as its own event so a rule can take the tab without the words.
    if (text !== '' && !privatePage(host, snapshot.title)) {
      this.lastTextKey = key;
      events.push({ type: 'page:text', payload: { timestamp: snapshot.timestamp, app: snapshot.app, url, host, path, title: snapshot.title, text: text.slice(0, 6000) } });
    }
    return events;
  }

  stop(): void {
    this.supervisor.stop();
  }

  isHelperRunning(): boolean {
    return this.supervisor.isRunning();
  }
}
