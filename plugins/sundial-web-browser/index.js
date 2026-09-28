// sundial-web-browser: `web_fetch` through a headless Chrome, `web_search`
// through a self-hosted SearXNG. No browser window, ever.
//
// Why this exists. The harness ships both tools over the `ctx.web` seam, but
// the shipped composition mounts a DeepSeek search API (whose key the tooling
// audit found dead) and disables fetch entirely, with a stated reason: that
// provider "defers SSRF protection and the model would choose the request
// target". A browser answers that objection rather than waiving it —
// navigation is confined to http(s) by `assertFetchableUrl`, and the request is
// made by Chrome on the owner's own machine.
//
// The two halves use different transports because testing showed they had to:
//
//   FETCH  — headless Chrome, launched and managed by this plugin (launcher.js).
//            Verified identical to a windowed browser on GitHub, MDN, docs
//            sites, Hacker News and raw files: all 200, all under 1.5s warm.
//
//   SEARCH — SearXNG over its JSON API (searxng.js), NOT a browser. Public
//            search engines serve an anti-bot challenge to a headless browser
//            while serving results to a windowed one, and defeating that check
//            is not something Gnomon does. A self-hosted instance removes the
//            problem instead of evading it: it is the owner's own service, it
//            publishes a JSON API meant for programs, and it has no quota.
//
// Everything here is audited into the signal log (audit.js), so "which pages
// did it read, what came back, how long did it take" is answerable from the
// same record as every other observation.
//
// Named exports only — a default export drops `inject`.
import { connectCdp, discoverBrowserSocket } from './cdp.js';
import { assertFetchableUrl, loadPage, MAX_BODY_CHARS } from './browser-page.js';
import { createWebAuditor } from './audit.js';
import { createBrowserSupervisor, managedBrowser, resolveChromePath } from './launcher.js';
import { createSearxngSearch, DEFAULT_SEARXNG_URL } from './searxng.js';
import { fence } from './page-session.js';

export { connectCdp, discoverBrowserSocket } from './cdp.js';
export { assertFetchableUrl, capBody, loadPage, MAX_BODY_CHARS } from './browser-page.js';
export { createWebAuditor, clip, MAX_RECORDED_SNIPPET } from './audit.js';
export { createBrowserSupervisor, resolveChromePath, headlessArgs, probeEndpoint, MANAGED_PORT, MANAGED_PROFILE_DIR } from './launcher.js';
export { createSearxngSearch, buildQueryUrl, toSearchResult, describeFailure, DEFAULT_SEARXNG_URL } from './searxng.js';

export const name = 'sundial-web-browser';
export const inject = ['web', 'gnomonKernel'];

export const PROVIDER_ID = 'gnomon-browser';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222';

/**
 * One CDP connection per operation.
 *
 * A pooled connection would be faster, but it would also hold a socket open
 * against the owner's browser for the life of the daemon and would have to
 * survive every Chrome restart, quit and crash. Web calls are rare and already
 * cost a page load; correctness under a browser that comes and goes is worth
 * more here than the handshake.
 */
async function withBrowser(supervisor, signal, run) {
  const { endpoint } = await supervisor.resolve();
  const socketUrl = await discoverBrowserSocket(endpoint, signal);
  const client = await connectCdp(socketUrl);
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

export function apply(ctx, config = {}) {
  const maxBodyChars = config.maxBodyChars ?? MAX_BODY_CHARS;
  const enableSearch = config.search !== false;
  const enableFetch = config.fetch !== false;

  // Headless by default, and NO window ever: the plugin launches and manages a
  // private headless Chrome. It attaches to an existing browser only when an
  // `endpoint` is configured explicitly — attaching opportunistically would
  // silently route fetches through whatever window happened to be open, which
  // is neither predictable nor what "headless" was asked for.
  // Without an explicit endpoint this is Gnomon's own browser — the SAME
  // instance the page tools act in (`managedBrowser`), so the two never fight
  // over one profile.
  const supervisor = config.endpoint
    ? createBrowserSupervisor({ preferredEndpoint: config.endpoint, allowLaunch: config.headless !== false, ...(config.chromePath ? { chromePath: config.chromePath } : {}) })
    : managedBrowser({ allowLaunch: config.headless !== false, ...(config.chromePath ? { chromePath: config.chromePath } : {}) });
  // Kill the managed browser with the plugin. An attached one is left alone —
  // it was not ours to stop.
  ctx.effect(() => () => supervisor.stop());

  const audit = createWebAuditor({
    appendSignal: (type, payload) => ctx.gnomonKernel.appendSignal(type, payload),
  });

  // `available()` must be a CHEAP LOCAL CHECK — the seam's contract says it
  // must not make network calls, so it cannot probe or launch anything. It
  // answers "is this provider configured", and a browser that cannot be
  // reached surfaces as a clear error on first use instead.
  const available = () => enableFetch || enableSearch;

  if (enableFetch) {
    ctx.effect(() =>
      ctx.web.registerFetchProvider({
        id: PROVIDER_ID,
        available,
        async fetch(request, signal) {
          const startedAt = Date.now();
          let url;
          try {
            url = assertFetchableUrl(request.url);
          } catch (error) {
            await audit.fetch({ url: String(request.url), durationMs: 0, error: error.message });
            throw error;
          }
          try {
            const page = await withBrowser(supervisor, signal, (client) => loadPage(client, url, { maxBodyChars }));
            await audit.fetch({
              url,
              finalUrl: page.url,
              statusCode: page.statusCode,
              title: page.title,
              chars: page.text.length,
              truncated: page.truncated,
              durationMs: Date.now() - startedAt,
            });
            return {
              url: page.url,
              statusCode: page.statusCode,
              // `text`, not `html`: what comes back is the RENDERED page as the
              // owner would see it, already stripped of markup by the browser.
              // Declaring it html would invite a second, pointless strip.
              // Fenced as the site's words (H1): a page is written by strangers,
              // and an instruction inside it must read as its text, not as ours.
              body: { kind: 'text', content: fence(page.url, page.text) },
              truncated: page.truncated,
            };
          } catch (error) {
            await audit.fetch({ url, durationMs: Date.now() - startedAt, error: error.message });
            throw error;
          }
        },
      }),
    );
  }

  if (enableSearch) {
    const searxng = createSearxngSearch({
      baseUrl: config.searxngUrl ?? DEFAULT_SEARXNG_URL,
      ...(config.searchLanguage ? { language: config.searchLanguage } : {}),
    });

    ctx.effect(() =>
      ctx.web.registerSearchProvider({
        id: PROVIDER_ID,
        available,
        async search(request, signal) {
          const startedAt = Date.now();
          const query = String(request.query ?? '').trim();
          const engine = hostOf(searxng.baseUrl);
          if (query.length === 0) {
            const error = new Error('an empty query has nothing to search for');
            await audit.search({ query, engine, durationMs: 0, error: error.message });
            throw error;
          }
          try {
            const result = await searxng.search(query, { maxResults: request.maxResults, signal });
            await audit.search({
              query,
              engine,
              resultCount: result.sources.length,
              sources: result.sources,
              durationMs: Date.now() - startedAt,
            });
            return result;
          } catch (error) {
            await audit.search({ query, engine, durationMs: Date.now() - startedAt, error: error.message });
            throw error;
          }
        },
      }),
    );
  }

  const browser = resolveChromePath();
  const fetchRoute = config.endpoint
    ? `attaches to ${config.endpoint}`
    : config.headless === false
      ? 'DISABLED (headless launch off and no endpoint configured)'
      : browser === null
        ? 'NO BROWSER FOUND (install Chrome/Chromium/Edge, or set SUNDIAL_CHROME_PATH)'
        : `headless ${browser.split('/').pop()} on ${supervisor.managedEndpoint}`;
  console.log(
    `[sundial-web-browser] fetch: ${enableFetch ? fetchRoute : 'off'} | ` +
      `search: ${enableSearch ? config.searxngUrl ?? DEFAULT_SEARXNG_URL : 'off'} | audited as web:fetch / web:search`,
  );
}

/** Hostname for the audit trail's `engine` field, without throwing on a odd base URL. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}
