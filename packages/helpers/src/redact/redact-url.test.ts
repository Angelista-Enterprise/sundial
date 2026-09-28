import { describe, it, expect } from 'vitest';
import { stripUrlQuery } from './redact-url.js';

describe('stripUrlQuery', () => {
  it('returns the url unchanged at tier 1', () => {
    expect(stripUrlQuery('https://site.com/a?token=abc', 1)).toBe('https://site.com/a?token=abc');
  });

  it('strips query and fragment at tier 2, keeping origin + path', () => {
    expect(stripUrlQuery('https://site.com/reset?token=abc#frag', 2)).toBe('https://site.com/reset');
  });

  it('keeps only the origin at tier 3', () => {
    expect(stripUrlQuery('https://site.com/a/b?x=1', 3)).toBe('https://site.com');
  });

  it('redacts a malformed URL at tiers 2/3 instead of passing the raw string (query included) through', () => {
    expect(stripUrlQuery('not a url ?token=secret', 2)).toBe('[redacted-url]');
    expect(stripUrlQuery('ht!tp://broken?session=xyz', 3)).toBe('[redacted-url]');
  });

  it('leaves file:// URLs alone (local paths are handled by the path redactor)', () => {
    expect(stripUrlQuery('file:///Users/x/secret.txt', 3)).toBe('file:///Users/x/secret.txt');
  });
});
