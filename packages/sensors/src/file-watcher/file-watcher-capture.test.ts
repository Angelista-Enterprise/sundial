import { describe, it, expect } from 'vitest';
import { makeIgnoreFn, mergeChangeKind } from './file-watcher-capture.js';

describe('makeIgnoreFn', () => {
  const ignore = makeIgnoreFn('/repo');

  it('ignores node_modules and .git paths', () => {
    expect(ignore('/repo/node_modules/foo/index.js')).toBe(true);
    expect(ignore('/repo/.git/HEAD')).toBe(true);
  });

  it('ignores dist/build output', () => {
    expect(ignore('/repo/dist/index.js')).toBe(true);
    expect(ignore('/repo/build/app.js')).toBe(true);
  });

  it('ignores files by suffix', () => {
    expect(ignore('/repo/foo.log')).toBe(true);
    expect(ignore('/repo/.DS_Store')).toBe(true);
    expect(ignore('/repo/tsconfig.tsbuildinfo')).toBe(true);
  });

  it('does not ignore real source files', () => {
    expect(ignore('/repo/src/index.ts')).toBe(false);
  });

  it('ignores extra caller-supplied substrings', () => {
    const withExtra = makeIgnoreFn('/repo', ['secret-dir']);
    expect(withExtra('/repo/secret-dir/file.ts')).toBe(true);
    expect(withExtra('/repo/src/index.ts')).toBe(false);
  });

  it('live-tested regression: does not ignore a project whose ANCESTOR path happens to contain a segment like "tmp" (only the project-relative path matters)', () => {
    const underTmp = makeIgnoreFn('/tmp/some-test-repo');
    expect(underTmp('/tmp/some-test-repo/README.md')).toBe(false);
    // A real tmp/ subdirectory INSIDE the project is still ignored.
    expect(underTmp('/tmp/some-test-repo/tmp/cache-file.txt')).toBe(true);
  });
});

describe('mergeChangeKind', () => {
  it('keeps add when followed by modify within the same window', () => {
    expect(mergeChangeKind('add', 'modify')).toBe('add');
  });

  it('otherwise uses the incoming kind', () => {
    expect(mergeChangeKind('modify', 'delete')).toBe('delete');
    expect(mergeChangeKind(undefined, 'add')).toBe('add');
    expect(mergeChangeKind('add', 'delete')).toBe('delete');
  });
});
