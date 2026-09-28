import { describe, it, expect, vi } from 'vitest';
import { clip, createWebAuditor, MAX_RECORDED_SNIPPET } from './audit.js';
import { assertFetchableUrl, capBody, MAX_BODY_CHARS } from './browser-page.js';

const NOW = '2026-08-16T12:00:00.000Z';

function auditorWith(appendSignal = vi.fn().mockResolvedValue(undefined)) {
  return { appendSignal, audit: createWebAuditor({ appendSignal, now: () => NOW }) };
}

describe('clip', () => {
  it('marks a cut rather than silently shortening', () => {
    expect(clip('x'.repeat(MAX_RECORDED_SNIPPET + 10))).toHaveLength(MAX_RECORDED_SNIPPET + 1);
    expect(clip('x'.repeat(MAX_RECORDED_SNIPPET + 10)).endsWith('…')).toBe(true);
    expect(clip('short')).toBe('short');
  });
});

describe('createWebAuditor', () => {
  it('records a successful fetch under web:fetch, with the outcome', async () => {
    const { appendSignal, audit } = auditorWith();
    await audit.fetch({ url: 'https://x.dev/a', statusCode: 200, title: 'A', chars: 1234, durationMs: 900 });

    expect(appendSignal).toHaveBeenCalledWith('web:fetch', {
      timestamp: NOW,
      url: 'https://x.dev/a',
      statusCode: 200,
      title: 'A',
      chars: 1234,
      durationMs: 900,
      ok: true,
    });
  });

  it('keeps the redirect visible — a trail that hides it is not a trail', async () => {
    const { appendSignal, audit } = auditorWith();
    await audit.fetch({ url: 'https://x.dev/a', finalUrl: 'https://x.dev/b', statusCode: 200 });
    expect(appendSignal.mock.calls[0][1].finalUrl).toBe('https://x.dev/b');
  });

  it('omits finalUrl when nothing redirected', async () => {
    const { appendSignal, audit } = auditorWith();
    await audit.fetch({ url: 'https://x.dev/a', finalUrl: 'https://x.dev/a', statusCode: 200 });
    expect(appendSignal.mock.calls[0][1]).not.toHaveProperty('finalUrl');
  });

  it('records a FAILED fetch — the attempt is the thing being audited', async () => {
    const { appendSignal, audit } = auditorWith();
    await audit.fetch({ url: 'https://x.dev/a', durationMs: 50, error: 'navigation failed: ERR_NAME_NOT_RESOLVED' });

    const [type, payload] = appendSignal.mock.calls[0];
    expect(type).toBe('web:fetch');
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('ERR_NAME_NOT_RESOLVED');
  });

  it('records a search with its hosts, not full result URLs', async () => {
    const { appendSignal, audit } = auditorWith();
    await audit.search({
      query: 'rust async',
      engine: 'html.duckduckgo.com',
      resultCount: 2,
      sources: [{ url: 'https://doc.rust-lang.org/book/' }, { url: 'https://doc.rust-lang.org/std/' }, { url: 'https://tokio.rs/x' }],
      durationMs: 1500,
    });

    const payload = appendSignal.mock.calls[0][1];
    expect(payload.query).toBe('rust async');
    expect(payload.hosts).toEqual(['doc.rust-lang.org', 'tokio.rs']); // de-duplicated
    expect(payload.resultCount).toBe(2);
    expect(payload.ok).toBe(true);
  });

  it('does NOT write to search:performed — that type means the OWNER searched', async () => {
    const { appendSignal, audit } = auditorWith();
    await audit.search({ query: 'x', engine: 'e' });
    expect(appendSignal.mock.calls[0][0]).toBe('web:search');
    expect(appendSignal.mock.calls.map((c) => c[0])).not.toContain('search:performed');
  });

  it('swallows a failed audit write — the trail must not break the fetch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { audit } = auditorWith(vi.fn().mockRejectedValue(new Error('kernel down')));
    await expect(audit.fetch({ url: 'https://x.dev' })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('assertFetchableUrl', () => {
  it('accepts http and https', () => {
    expect(assertFetchableUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(assertFetchableUrl('http://example.com/a')).toBe('http://example.com/a');
  });

  it('refuses schemes that would turn a fetch into a local read or a browser escape', () => {
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'devtools://devtools/x', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(() => assertFetchableUrl(url)).toThrow(/only http and https/);
    }
  });

  it('refuses junk with a readable message', () => {
    expect(() => assertFetchableUrl('not a url')).toThrow(/not a valid URL/);
  });

  it.each([
    'http://127.0.0.1:3080/gnomon/api/session?id=x',
    'http://localhost:9222/json',
    'http://[::1]:11434/',
    'http://192.168.1.1/',
    'http://10.0.0.8/',
    'http://172.20.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://printer.local/',
    'http://100.101.102.103/',
  ])('refuses this Mac and the local network: %s', (url) => {
    expect(() => assertFetchableUrl(url)).toThrow(/not fetchable/);
  });

  it('refuses credentials in the URL', () => {
    expect(() => assertFetchableUrl('https://user:pw@example.com/')).toThrow(/credentials/);
  });
});

describe('capBody', () => {
  it('reports truncation instead of silently returning a prefix', () => {
    expect(capBody('abc', 10)).toEqual({ content: 'abc', truncated: false });
    expect(capBody('abcdef', 3)).toEqual({ content: 'abc', truncated: true });
  });

  it('caps at a size that cannot swamp a prompt', () => {
    expect(MAX_BODY_CHARS).toBeLessThanOrEqual(200_000);
  });
});
