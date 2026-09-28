import { describe, it, expect, vi } from 'vitest';
import { buildQueryUrl, createSearxngSearch, describeFailure, toSearchResult } from './searxng.js';

/** Shaped like a real SearXNG JSON payload (captured from the local instance, 2026-08-16). */
const PAYLOAD = {
  query: 'rust async book',
  results: [
    { url: 'https://rust-lang.github.io/async-book/', title: 'Introduction - Asynchronous Programming in Rust', content: 'Learn how to write…' },
    { url: 'https://doc.rust-lang.org/book/ch17-00-async-await.html', title: 'Fundamentals', content: 'That is exactly…', publishedDate: '2026-01-02' },
    { url: 'https://rust-lang.github.io/async-book/', title: 'duplicate' },
    { url: 'magnet:?xt=urn:btih:abc', title: 'not a page' },
  ],
  answers: ['42'],
};

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

describe('buildQueryUrl', () => {
  it('asks for JSON — the whole API is one query parameter', () => {
    const url = new URL(buildQueryUrl('http://127.0.0.1:8888', 'rust async'));
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('rust async');
    expect(url.searchParams.get('format')).toBe('json');
  });

  it('does not let a query smuggle in extra parameters', () => {
    const url = new URL(buildQueryUrl('http://127.0.0.1:8888', 'x&format=html&categories=images'));
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('categories')).toBeNull();
  });
});

describe('toSearchResult', () => {
  it('maps SearXNG rows onto the seam shape, renaming content → snippet', () => {
    const { sources } = toSearchResult(PAYLOAD);
    expect(sources[0]).toEqual({
      url: 'https://rust-lang.github.io/async-book/',
      title: 'Introduction - Asynchronous Programming in Rust',
      snippet: 'Learn how to write…',
    });
    expect(sources[1].publishedAt).toBe('2026-01-02');
  });

  it('drops duplicates and anything without a citeable http(s) URL', () => {
    const { sources } = toSearchResult(PAYLOAD);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.url)).not.toContain('magnet:?xt=urn:btih:abc');
  });

  it("carries SearXNG's direct answer as the seam's optional content", () => {
    expect(toSearchResult(PAYLOAD).content).toBe('42');
  });

  it('accepts the object-shaped answers newer builds emit', () => {
    expect(toSearchResult({ results: [], answers: [{ answer: 'forty two' }] }).content).toBe('forty two');
  });

  it('honors maxResults', () => {
    expect(toSearchResult(PAYLOAD, 1).sources).toHaveLength(1);
  });

  it('leaves `truncated` to the seam, which owns the bound', () => {
    expect(toSearchResult(PAYLOAD, 1).truncated).toBe(false);
  });

  it('survives an empty or malformed payload', () => {
    expect(toSearchResult({}).sources).toEqual([]);
    expect(toSearchResult(null).sources).toEqual([]);
  });
});

describe('describeFailure', () => {
  it('names the real cause of a 403 — the JSON format is off by default', () => {
    expect(describeFailure(403)).toMatch(/formats: \[html, json\]/);
  });

  it('names the limiter on a 429', () => {
    expect(describeFailure(429)).toMatch(/limiter: false/);
  });

  it('falls back to the plain status for anything else', () => {
    expect(describeFailure(500, 'boom')).toBe('SearXNG answered HTTP 500');
  });
});

describe('createSearxngSearch', () => {
  it('searches and returns the mapped result', async () => {
    const doFetch = vi.fn().mockResolvedValue(okResponse(PAYLOAD));
    const provider = createSearxngSearch({ baseUrl: 'http://127.0.0.1:8888', doFetch });

    const result = await provider.search('rust async book', { maxResults: 2 });
    expect(result.sources).toHaveLength(2);
    expect(doFetch.mock.calls[0][0]).toContain('format=json');
  });

  it('says how to start the instance when nothing answers', async () => {
    const provider = createSearxngSearch({ doFetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    await expect(provider.search('x')).rejects.toThrow(/docker start gnomon-searxng/);
  });

  it('turns a 403 into the settings fix, not an auth wild goose chase', async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'Forbidden' });
    const provider = createSearxngSearch({ doFetch });
    await expect(provider.search('x')).rejects.toThrow(/formats: \[html, json\]/);
  });
});
