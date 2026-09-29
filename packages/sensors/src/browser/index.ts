import { stripUrlQuery } from '@sundial/helpers/redact/redact-url.js';
import { isSensitiveProcess } from '@sundial/helpers/redact/redact-policy.js';
import { BrowserHelperSupervisor, readBrowserSidecar, type BrowserSnapshot } from './browser-capture.js';

export interface BrowserTabEvent {
  type: 'browser:tab';
  payload: { timestamp: string; app: string; url: string; host: string; path: string; title: string | null };
}

export interface BrowserStatusEvent {
  type: 'browser:status';
  payload: { timestamp: string; app: string; authorized: boolean; error: string | null };
}

/** J3.4: the page's own words, sanitized at ingest, used only as fan-out evidence (and by the ingest anomaly check). */
export interface PageTextEvent {
  type: 'page:text';
  payload: { timestamp: string; app: string; url: string; host: string; path: string; title: string | null; text: string };
}

export type BrowserEvent = BrowserTabEvent | BrowserStatusEvent | PageTextEvent;

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
  private lastAuthorized: boolean | null = null;
  private readonly supervisor: BrowserHelperSupervisor;

  constructor(options: { enabled?: boolean; supervisor?: BrowserHelperSupervisor } = {}) {
    this.enabled = options.enabled ?? true;
    this.supervisor = options.supervisor ?? new BrowserHelperSupervisor();
  }

  private readonly enabled: boolean;

  poll(now = Date.now()): BrowserEvent[] {
    if (!this.enabled) return [];
    this.supervisor.ensure(now);
    const snapshot = readBrowserSidecar(now);
    if (!snapshot) return [];
    return this.eventsFor(snapshot);
  }

  /** Pure: which events a fresh snapshot produces given what was last seen. */
  eventsFor(snapshot: BrowserSnapshot): BrowserEvent[] {
    const events: BrowserEvent[] = [];
    if (snapshot.app !== null && this.lastAuthorized !== snapshot.authorized) {
      this.lastAuthorized = snapshot.authorized;
      events.push({ type: 'browser:status', payload: { timestamp: snapshot.timestamp, app: snapshot.app, authorized: snapshot.authorized, error: snapshot.error } });
    }
    const key = tabKey(snapshot);
    if (key === this.lastKey) return events;
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
    events.push({ type: 'browser:tab', payload: { timestamp: snapshot.timestamp, app: snapshot.app, url, host, path, title: snapshot.title } });
    // J3.4: the text rides as its own event so a rule can take the tab without the words.
    if (typeof snapshot.text === 'string' && snapshot.text.trim() !== '') events.push({ type: 'page:text', payload: { timestamp: snapshot.timestamp, app: snapshot.app, url, host, path, title: snapshot.title, text: snapshot.text.trim().slice(0, 6000) } });
    return events;
  }

  stop(): void {
    this.supervisor.stop();
  }

  isHelperRunning(): boolean {
    return this.supervisor.isRunning();
  }
}
