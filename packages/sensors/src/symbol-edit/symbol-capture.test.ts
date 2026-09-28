import { describe, it, expect } from 'vitest';
import { extractSymbolsFromDiff, symbolFromHunkContext } from './symbol-capture.js';

describe('symbolFromHunkContext', () => {
  it('extracts a function name', () => {
    expect(symbolFromHunkContext('function fooBar(arg) {')).toBe('fooBar');
    expect(symbolFromHunkContext('async function bar() {')).toBe('bar');
  });

  it('extracts a class/interface/type name', () => {
    expect(symbolFromHunkContext('class Foo {')).toBe('Foo');
    expect(symbolFromHunkContext('export interface Bar {')).toBe('Bar');
  });

  it('extracts a Python def', () => {
    expect(symbolFromHunkContext('def handle_request(req):')).toBe('handle_request');
  });

  it('extracts a Go func, including method receivers', () => {
    expect(symbolFromHunkContext('func Name(x int) {')).toBe('Name');
    expect(symbolFromHunkContext('func (s *Server) Handle() {')).toBe('Handle');
  });

  it('extracts a const/let assignment, skipping reserved words', () => {
    expect(symbolFromHunkContext('const handler = async () => {')).toBe('handler');
    expect(symbolFromHunkContext('export const foo = 1')).toBe('foo');
  });

  it('returns null for empty or unmatchable context', () => {
    expect(symbolFromHunkContext('')).toBeNull();
    expect(symbolFromHunkContext('   ')).toBeNull();
  });
});

describe('extractSymbolsFromDiff', () => {
  it('extracts symbols and counts hunks from a real diff shape', () => {
    const diff = [
      '@@ -12,5 +12,7 @@ function fooBar(arg) {',
      '-old line',
      '+new line',
      '@@ -30,2 +32,3 @@ class Foo {',
      '+another line',
    ].join('\n');

    const result = extractSymbolsFromDiff(diff);
    expect(result.hunkCount).toBe(2);
    expect(result.symbols.sort()).toEqual(['Foo', 'fooBar']);
  });

  it('returns empty symbols with zero hunks for a diff with no hunk headers', () => {
    expect(extractSymbolsFromDiff('no hunks here')).toEqual({ symbols: [], hunkCount: 0 });
  });
});
