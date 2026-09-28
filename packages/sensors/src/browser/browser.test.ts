import { describe, it, expect } from 'vitest';
import { BrowserSensor, tabKey } from './index.js';
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
