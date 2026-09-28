import type { Rule } from '@sundial/kernel/types.js';

interface BrowserTabPayload {
  timestamp?: string;
  app?: string;
  url?: string;
  host?: string;
  path?: string;
  title?: string | null;
}

interface BrowserStatusPayload {
  app?: string;
  authorized?: boolean;
  error?: string | null;
}

/**
 * `browser:tab` → `state.browser.current`: the page the owner is looking at,
 * as origin + path, and since when. Window titles told Gnomon "GitHub"; this
 * tells it which pull request. `browser:status` → `state.browser.authorized`,
 * so a read path can say "the browser helper was never allowed" instead of
 * reading an empty slice as "not browsing". A window change away from the
 * browser does NOT clear `current`: the presence line uses `since`/`updatedAt`
 * freshness for that, and "the last page you had open" is worth keeping.
 */
export const browserTrack: Rule = (state, event) => {
  if (event.type === 'browser:status') {
    const payload = event.payload as BrowserStatusPayload;
    const authorized = payload.authorized !== false;
    if (state.browser.authorized === authorized && state.browser.lastError === (payload.error ?? null)) return { state, effects: [] };
    return { state: { ...state, browser: { ...state.browser, authorized, lastError: payload.error ?? null } }, effects: [] };
  }
  if (event.type !== 'browser:tab') return { state, effects: [] };
  const payload = event.payload as BrowserTabPayload;
  const host = typeof payload.host === 'string' ? payload.host : '';
  if (host === '') return { state, effects: [] };
  const app = typeof payload.app === 'string' ? payload.app : 'browser';
  const path = typeof payload.path === 'string' ? payload.path : '/';
  const prior = state.browser.current;
  const same = prior !== null && prior.host === host && prior.path === path && prior.app === app;
  return {
    state: {
      ...state,
      browser: {
        ...state.browser,
        current: { app, host, path, title: typeof payload.title === 'string' ? payload.title : null, since: same ? prior.since : event.ts, updatedAt: event.ts },
        authorized: true,
      },
    },
    effects: [],
  };
};
