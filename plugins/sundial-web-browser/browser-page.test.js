import { describe, expect, it } from 'vitest';
import { DEFAULT_LOAD_TIMEOUT_MS, loadPage, within } from './browser-page.js';

/**
 * A fake CDP client. `events` are what the tab fires after Page.navigate, each a method or [method, ms]; the page's
 * text is filled in by its load event, as an app page's is. `waitError` makes every wait fail with it. Made-up page.
 */
function fakeClient(events, navigation = {}, waitError = null) {
  const listeners = new Set();
  const page = { loaded: false };
  const emit = (frame) => [...listeners].forEach((l) => l(frame));
  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitFor(method, { predicate = () => true, timeoutMs }) {
      if (waitError) return Promise.reject(waitError);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => (dispose(), reject(new Error(`timed out waiting for ${method}`))), timeoutMs);
        const dispose = this.on((f) => f.method === method && predicate(f) && (clearTimeout(timer), dispose(), resolve(f)));
      });
    },
    async send(method) {
      if (method === 'Target.createTarget') return { targetId: 't1' };
      if (method === 'Target.attachToTarget') return { sessionId: 's1' };
      if (method === 'Page.navigate') {
        for (const [m, at = 5] of events.map((e) => [].concat(e))) setTimeout(() => ((page.loaded ||= m === 'Page.loadEventFired'), emit({ method: m, sessionId: 's1' })), at);
        return navigation;
      }
      if (method === 'Runtime.evaluate') return { result: { value: { title: 'Lantern', url: 'https://example.org/lantern', text: page.loaded ? 'A lantern is a light.' : '' } } };
      return {};
    },
  };
}

describe('loadPage (run 103 T03)', () => {
  it('after DOMContentLoaded it waits for the load event, but no longer than settleMs', async () => {
    const page = await loadPage(fakeClient(['Page.domContentEventFired', ['Page.loadEventFired', 30]]), 'https://example.org/lantern', { loadTimeoutMs: 200, settleMs: 150 });
    expect(page).toMatchObject({ title: 'Lantern', text: 'A lantern is a light.', statusCode: 200 });
    const started = Date.now();
    const early = await loadPage(fakeClient(['Page.domContentEventFired', ['Page.loadEventFired', 500]]), 'https://example.org/lantern', { loadTimeoutMs: 1000, settleMs: 20 });
    expect(early.text).toBe('');
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('the live event order: the navigate reply comes after the frame starts loading, then DOMContentLoaded, then load (run 110)', async () => {
    const order = ['Page.frameStartedNavigating', 'Page.frameStartedLoading', ['Page.frameNavigated', 20], ['Page.domContentEventFired', 90], ['Page.loadEventFired', 95], ['Page.frameStoppedLoading', 96]];
    const client = fakeClient(order);
    const send = client.send.bind(client);
    // The navigate reply lands at 15 ms, after the frame started loading at 5 ms.
    client.send = async (method, ...rest) => {
      const reply = await send(method, ...rest);
      if (method === 'Page.navigate') await new Promise((done) => setTimeout(done, 15));
      return reply;
    };
    const page = await loadPage(client, 'https://example.org/lantern');
    expect(page).toMatchObject({ title: 'Lantern', text: 'A lantern is a light.', statusCode: 200 });
    expect(DEFAULT_LOAD_TIMEOUT_MS).toBe(25_000);
  });

  it('only a timeout reads as a slow site: any other error comes back as it was', async () => {
    const closed = new Error('CDP socket closed');
    await expect(loadPage(fakeClient(['Page.domContentEventFired'], {}, closed), 'https://example.org/lantern', { loadTimeoutMs: 50 })).rejects.toBe(closed);
  });

  it('a page that never loads fails with its own reason, inside the tool budget', async () => {
    expect(DEFAULT_LOAD_TIMEOUT_MS).toBeLessThan(30_000);
    await expect(loadPage(fakeClient([]), 'https://example.org/slow', { loadTimeoutMs: 50 })).rejects.toThrow('https://example.org/slow did not load within 0.05 s: the site is slow or not answering');
  });

  it('the whole fetch, a browser that never comes up included, answers within its budget', async () => {
    const started = Date.now();
    await expect(within(50, 'https://example.org/slow', new Promise(() => {}))).rejects.toThrow('https://example.org/slow did not load within 0.05 s');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await within(50, 'https://example.org/lantern', Promise.resolve('page'))).toBe('page');
  });

  it('a failed navigation leaves no unhandled rejection behind', async () => {
    const unhandled = [];
    const note = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', note);
    try {
      await expect(loadPage(fakeClient([], { errorText: 'net::ERR_NAME_NOT_RESOLVED' }), 'https://example.org/gone', { loadTimeoutMs: 20 })).rejects.toThrow('navigation failed: net::ERR_NAME_NOT_RESOLVED');
      await new Promise((done) => setTimeout(done, 60));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', note);
    }
  });
});
