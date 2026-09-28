// Search through a self-hosted SearXNG instance.
//
// This replaces browser-driven scraping of a public search engine, which could
// not work headless: engines serve an anti-bot challenge to a headless browser
// and results to a windowed one, and defeating that check is not something
// Gnomon does. SearXNG removes the problem rather than working around it — the
// instance belongs to the owner, it publishes a documented JSON API meant to be
// called by programs, there is nothing to evade, and there is no quota.
//
// It is also plain HTTP: no browser is involved in a search at all, which is
// what makes the whole stack windowless.
//
// Requires `formats: [html, json]` in the instance's settings.yml — stock
// SearXNG serves HTML only and answers a JSON request with 403. That failure is
// detected by name below, because "403" alone would send someone hunting for an
// auth problem that does not exist.
//
// Named exports only.

export const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8888';

/** Build the JSON search URL. `format=json` is the whole API. */
export function buildQueryUrl(baseUrl, query, { language, timeRange, categories } = {}) {
  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  if (language) url.searchParams.set('language', language);
  if (timeRange) url.searchParams.set('time_range', timeRange);
  if (categories) url.searchParams.set('categories', categories);
  return url.toString();
}

/**
 * SearXNG's JSON payload → the seam's `WebSearchResult`.
 *
 * A row without a usable http(s) URL is dropped: the seam's contract is that a
 * source always has one, and SearXNG's non-web categories (images, torrents)
 * can carry rows that are not citeable pages.
 */
export function toSearchResult(payload, maxResults) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const sources = [];
  const seen = new Set();

  for (const row of rows) {
    const url = usableUrl(row?.url);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url,
      ...(row.title ? { title: String(row.title) } : {}),
      // SearXNG calls the snippet `content`; the seam calls it `snippet`.
      ...(row.content ? { snippet: String(row.content) } : {}),
      ...(row.publishedDate ? { publishedAt: String(row.publishedDate) } : {}),
    });
    if (typeof maxResults === 'number' && sources.length >= maxResults) break;
  }

  // `answers` is SearXNG's direct-answer box (a calculation, a definition). It
  // maps onto the seam's optional provider-generated `content`.
  const answers = Array.isArray(payload?.answers) ? payload.answers.map(answerText).filter(Boolean) : [];

  return {
    ...(answers.length > 0 ? { content: answers.join('\n') } : {}),
    sources,
    // The SEAM sets `truncated` when it enforces `maxResults`; a provider that
    // also claimed it would double-report.
    truncated: false,
  };
}

/** An answer is a string in older SearXNG and an object in newer builds. */
function answerText(answer) {
  if (typeof answer === 'string') return answer;
  if (answer && typeof answer === 'object') return typeof answer.answer === 'string' ? answer.answer : '';
  return '';
}

function usableUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Turn a failed response into a message that names the actual fix. */
export function describeFailure(status, bodyText = '') {
  if (status === 403 || /format .*not/i.test(bodyText) || /json/i.test(bodyText)) {
    return `SearXNG refused a JSON search (HTTP ${status}). Its settings.yml needs "formats: [html, json]" under "search:" — stock SearXNG serves HTML only.`;
  }
  if (status === 429) return 'SearXNG rate-limited the request — set "limiter: false" in its settings.yml for a single-caller instance.';
  return `SearXNG answered HTTP ${status}`;
}

/**
 * Build the provider.
 *
 * @param options.baseUrl the instance, default `http://127.0.0.1:8888`
 * @param options.doFetch injection point for tests
 */
export function createSearxngSearch({ baseUrl = DEFAULT_SEARXNG_URL, timeoutMs = 20_000, doFetch = fetch, language, categories } = {}) {
  return {
    baseUrl,

    async search(query, { maxResults, signal } = {}) {
      const url = buildQueryUrl(baseUrl, query, { language, categories });
      let response;
      try {
        response = await doFetch(url, {
          signal: signal ?? AbortSignal.timeout(timeoutMs),
          headers: { accept: 'application/json' },
        });
      } catch (cause) {
        if (signal?.aborted) throw new Error('the search was cancelled');
        throw new Error(
          `no SearXNG instance is answering at ${baseUrl}. Start one with: docker start gnomon-searxng`,
          { cause },
        );
      }
      if (!response.ok) {
        let body = '';
        try {
          body = (await response.text()).slice(0, 300);
        } catch {
          // Body unreadable; the status alone still names the likely cause.
        }
        throw new Error(describeFailure(response.status, body));
      }
      return toSearchResult(await response.json(), maxResults);
    },
  };
}
