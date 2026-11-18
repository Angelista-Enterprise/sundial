import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { BrowserSensor, tabKey } from './index.js';
import { SessionStoreReader, decodeMozLz4, selectedTab } from './session-store.js';
import { parseBrowserSnapshot, type BrowserSnapshot } from './browser-capture.js';

const snap = (over: Partial<BrowserSnapshot> = {}): BrowserSnapshot => ({
  timestamp: '2026-09-04T16:00:00.000Z',
  app: 'Google Chrome',
  bundleId: 'com.google.Chrome',
  url: 'https://github.com/pat/sundial/pull/12',
  title: 'PR 12',
  authorized: true,
  error: null,
  ...over,
});

class NoopSupervisor {
  ensure() {}
  isRunning() {
    return false;
  }
  stop() {}
}

const sensor = () => new BrowserSensor({ supervisor: new NoopSupervisor() as never });

describe('BrowserSensor', () => {
  it('emits a tab event once per (browser, origin+path), with host and path split out', () => {
    const s = sensor();
    const first = s.eventsFor(snap());
    expect(first.map((e) => e.type)).toEqual(['browser:status', 'browser:tab']);
    expect(first[1]).toMatchObject({ payload: { app: 'Google Chrome', host: 'github.com', path: '/pat/sundial/pull/12', title: 'PR 12' } });
    expect(s.eventsFor(snap())).toEqual([]);
    expect(s.eventsFor(snap({ url: 'https://github.com/pat/sundial/pull/13' }))).toHaveLength(1);
  });

  it('never carries a query or fragment, whatever the helper wrote', () => {
    const [, tab] = sensor().eventsFor(snap({ url: 'https://example.com/a?token=abc#frag' }));
    expect(tab.type).toBe('browser:tab');
    expect((tab as { payload: { url: string } }).payload.url).toBe('https://example.com/a');
  });

  it('a browser with no tab, a private window, or an unauthorized read produces no tab event', () => {
    expect(sensor().eventsFor(snap({ url: null })).filter((e) => e.type === 'browser:tab')).toEqual([]);
    const s = sensor();
    const out = s.eventsFor(snap({ url: null, authorized: false, error: 'Not authorized to send Apple events to Google Chrome.' }));
    expect(out).toEqual([{ type: 'browser:status', payload: { timestamp: '2026-09-04T16:00:00.000Z', app: 'Google Chrome', authorized: false, error: 'Not authorized to send Apple events to Google Chrome.' } }]);
    // Authorization flips back → one status event, then the tab.
    expect(s.eventsFor(snap()).map((e) => e.type)).toEqual(['browser:status', 'browser:tab']);
  });

  it('parses the helper file defensively and keys on browser + url', () => {
    const parsed = parseBrowserSnapshot('{"timestamp":"2026-09-04T16:00:00.000Z","app":"Safari","bundleId":"com.apple.Safari","url":"https://a.b/c","title":"t","authorized":true,"error":null,"disclaimed":true}');
    expect(parsed).toMatchObject({ app: 'Safari', url: 'https://a.b/c', authorized: true });
    expect(tabKey(parsed!)).toBe('com.apple.Safari|https://a.b/c');
    expect(parseBrowserSnapshot('not json')).toBeNull();
    expect(parseBrowserSnapshot('{}')).toBeNull();
  });
});

describe('J3.4 page text', () => {
  it('parses the helper\'s text and emits it as its own event beside the tab', () => {
    const snapshot = parseBrowserSnapshot(JSON.stringify({ timestamp: '2026-09-22T10:00:00.000Z', app: 'Arc', bundleId: 'company.thebrowser.Browser', url: 'https://example.com/docs', title: 'Docs', authorized: true, text: '  the page said this  ' }));
    expect(snapshot?.text).toBe('  the page said this  ');
    const events = new BrowserSensor({ enabled: true, supervisor: { ensure: () => undefined, stop: () => undefined, isRunning: () => true } as never }).eventsFor(snapshot!);
    expect(events.map((e) => e.type)).toEqual(['browser:status', 'browser:tab', 'page:text']);
    expect((events[2] as { payload: { text: string; host: string } }).payload).toMatchObject({ text: 'the page said this', host: 'example.com' });
    // No text: no event.
    const bare = parseBrowserSnapshot(JSON.stringify({ timestamp: '2026-09-22T10:01:00.000Z', app: 'Arc', bundleId: 'company.thebrowser.Browser', url: 'https://example.com/other', title: 'Other', authorized: true }));
    expect(bare?.text).toBeNull();
  });
});

describe('W6 D1: a browser the helper does not know', () => {
  const none = snap({ app: null, bundleId: null, url: null, title: null, timestamp: '2026-09-04T16:00:10.000Z' });
  const T = Date.parse('2026-09-04T16:00:00.000Z');
  /** A mozlz4 file with one block of literals only. */
  const mozlz4 = (text: string) => {
    const body = Buffer.from(text);
    const ext: number[] = [];
    for (let rest = body.length - 15; rest >= 0; rest -= 255) ext.push(Math.min(rest, 255));
    const size = Buffer.alloc(4);
    size.writeUInt32LE(body.length);
    return Buffer.concat([Buffer.from('mozLz40\0', 'latin1'), size, Buffer.from(body.length < 15 ? [body.length << 4] : [0xf0, ...ext]), body]);
  };
  const profile = (session: unknown) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-session-'));
    const dir = path.join(root, 'zen', 'Profiles', 'abc.Default', 'sessionstore-backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'recovery.jsonlz4'), mozlz4(JSON.stringify(session)));
    return new SessionStoreReader(root);
  };

  it('decodes a mozlz4 block, a match that overlaps its own output included', () => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(9);
    // "ab", then 6 bytes copied from 2 back, then "!".
    const block = Buffer.concat([Buffer.from('mozLz40\0', 'latin1'), size, Buffer.from([0x22, 0x61, 0x62, 0x02, 0x00, 0x10, 0x21])]);
    expect(decodeMozLz4(block).toString()).toBe('abababab!');
    expect(decodeMozLz4(mozlz4('x'.repeat(600))).toString()).toBe('x'.repeat(600));
    expect(() => decodeMozLz4(Buffer.from('not a session file'))).toThrow();
  });

  it('reads the selected tab of a Firefox-family session file as a tab event, with no query', () => {
    const session = { selectedWindow: 1, windows: [{ selected: 2, tabs: [{ index: 1, entries: [{ url: 'https://a.example/first', title: 'First' }] }, { index: 2, entries: [{ url: 'https://a.example/old', title: 'Old' }, { url: 'https://docs.example.com/guide?token=abc', title: 'Guide' }] }] }] };
    const s = new BrowserSensor({ supervisor: new NoopSupervisor() as never, session: profile(session) });
    const events = s.eventsWith(none, 'Zen', T);
    expect(events.map((e) => e.type)).toEqual(['browser:status', 'browser:tab']);
    expect(events[1]).toMatchObject({ payload: { app: 'Zen', url: 'https://docs.example.com/guide', host: 'docs.example.com', title: 'Guide' } });
    expect(s.eventsWith(none, 'Zen', T + 1000)).toEqual([]);
    // The tab accessed last wins over `selected`.
    expect(selectedTab({ windows: [{ selected: 1, tabs: [{ lastAccessed: 5, entries: [{ url: 'https://a.example/one' }] }, { lastAccessed: 9, entries: [{ url: 'https://a.example/two', title: 'Two' }] }] }] })).toEqual({ url: 'https://a.example/two', title: 'Two' });
    // A page that is not on the web (about:, a file) is no tab event.
    const local = new BrowserSensor({ supervisor: new NoopSupervisor() as never, session: profile({ windows: [{ tabs: [{ entries: [{ url: 'about:preferences', title: 'Settings' }] }] }] }) });
    expect(local.eventsWith(none, 'Zen', T).filter((e) => e.type === 'browser:tab')).toEqual([]);
  });

  it('W6 D8: names the page of a window by its title, and no page for a title two pages share', () => {
    const tab = (url: string, title: string) => ({ index: 1, entries: [{ url, title }] });
    const reader = profile({ windows: [{ tabs: [tab('https://docs.example.com/guide?token=abc', 'Guide'), tab('https://a.example/one', 'Same'), tab('about:preferences', 'Settings')] }, { tabs: [tab('https://b.example/two', 'Same')] }] });
    expect(reader.urlOf('Zen', 'Guide')).toBe('https://docs.example.com/guide');
    expect(reader.urlOf('Zen', 'Same')).toBeNull();
    expect(reader.urlOf('Zen', 'Settings')).toBeNull();
    expect(reader.urlOf('Zen', 'Not open')).toBeNull();
    expect(reader.urlOf('Google Chrome', 'Guide')).toBeNull();
  });

  it('says once that a browser in front cannot be read, and never for an app that is no browser', () => {
    const s = new BrowserSensor({ supervisor: new NoopSupervisor() as never, session: new SessionStoreReader(os.tmpdir()) });
    expect(s.eventsWith(none, 'Opera', T)).toEqual([{ type: 'browser:status', payload: { timestamp: none.timestamp, app: 'Opera', authorized: true, supported: false, error: null } }]);
    expect(s.eventsWith(none, 'Opera', T + 1000)).toEqual([]);
    expect(s.eventsWith(none, 'Archive Utility', T + 2000)).toEqual([]);
    // The helper's "no browser" is older than the switch to a browser it knows: not a verdict yet.
    expect(sensor().eventsWith(none, 'Google Chrome', T + 60_000)).toEqual([]);
  });

  it('S4: the helper\'s Accessibility read of the page rides on the session tab, only when the titles agree, once a tab', () => {
    const session = { windows: [{ tabs: [{ index: 1, entries: [{ url: 'https://docs.example.com/guide?token=abc', title: 'Guide' }] }] }] };
    const words = (title: string | null, text = 'Invoice BOX-484 for Puzzlebox Studio', windowTitle: string | null = title === null ? null : `${title} - Zen Browser`) => snap({ app: null, bundleId: 'app.zen-browser.zen', url: null, title, text, windowTitle, timestamp: none.timestamp });
    const s = new BrowserSensor({ supervisor: new NoopSupervisor() as never, session: profile(session) });
    // Another page's words (a private window, a tab the session file has not caught up with) never ride on this tab.
    expect(s.eventsWith(words('Lunch Thursday'), 'Zen', T).map((e) => e.type)).toEqual(['browser:status', 'browser:tab']);
    // The helper catches up: the words come once, under the session's url.
    const late = s.eventsWith(words('Guide'), 'Zen', T + 1000);
    expect(late).toEqual([{ type: 'page:text', payload: { timestamp: expect.any(String), app: 'Zen', url: 'https://docs.example.com/guide', host: 'docs.example.com', path: '/guide', title: 'Guide', text: 'Invoice BOX-484 for Puzzlebox Studio' } }]);
    expect(s.eventsWith(words('Guide'), 'Zen', T + 2000)).toEqual([]);
    const fresh = new BrowserSensor({ supervisor: new NoopSupervisor() as never, session: profile(session) });
    expect(fresh.eventsWith(words('Guide'), 'Zen', T).map((e) => e.type)).toEqual(['browser:status', 'browser:tab', 'page:text']);
    expect(new BrowserSensor({ supervisor: new NoopSupervisor() as never, session: profile(session) }).eventsWith(words(null), 'Zen', T).map((e) => e.type)).toEqual(['browser:status', 'browser:tab']);
  });

  it('Fable M2: the window\'s own title, minus its suffix, must name the session tab too; none is no words', () => {
    const session = { windows: [{ tabs: [{ index: 1, entries: [{ url: 'https://docs.example.com/guide', title: 'Guide' }] }] }] };
    const types = (windowTitle: string | null) => new BrowserSensor({ supervisor: new NoopSupervisor() as never, session: profile(session) })
      .eventsWith(snap({ app: null, bundleId: 'app.zen-browser.zen', url: null, title: 'Guide', text: 'Invoice BOX-484', windowTitle, timestamp: none.timestamp }), 'Zen', T).map((e) => e.type);
    expect(types('Guide \u2014 Zen Browser')).toContain('page:text');
    expect(types('Guide')).toContain('page:text');
    expect(types('Lunch Thursday \u2014 Zen Browser')).not.toContain('page:text');
    expect(types(null)).not.toContain('page:text');
  });

  it('Fable H3: page text is dropped on a private host, a page naming a private app, or a sign-in page; the tab stays', () => {
    const page = (url: string, title: string) => {
      const s = new BrowserSensor({ supervisor: new NoopSupervisor() as never, session: profile({ windows: [{ tabs: [{ index: 1, entries: [{ url, title }] }] }] }) });
      return s.eventsWith(snap({ app: null, bundleId: 'app.zen-browser.zen', url: null, title, text: 'Invoice BOX-484 for Puzzlebox Studio', windowTitle: title, timestamp: none.timestamp }), 'Zen', T).map((e) => e.type);
    };
    expect(page('https://docs.example.com/guide', 'Guide')).toEqual(['browser:status', 'browser:tab', 'page:text']);
    for (const [url, title] of [['https://outlook.office.com/mail/', 'Inbox'], ['https://eu.mail.proton.me/u/0/inbox', 'Inbox'], ['https://web.whatsapp.com/', 'Chats'], ['https://docs.example.com/a', 'Mira on Slack'], ['https://docs.example.com/b', 'Sign in to Puzzlebox'], ['https://docs.example.com/c', 'Inloggen']]) {
      expect(page(url, title), url).toEqual(['browser:status', 'browser:tab']);
    }
    // Chromium's own page text passes the same gate.
    const s = new BrowserSensor({ supervisor: new NoopSupervisor() as never });
    expect(s.eventsFor(snap({ url: 'https://outlook.office.com/mail/0/', title: 'Inbox', text: 'Lunch Thursday' })).map((e) => e.type)).toEqual(['browser:status', 'browser:tab']);
  });
});
