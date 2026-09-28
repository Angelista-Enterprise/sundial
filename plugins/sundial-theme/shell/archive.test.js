import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archivePath, forget, readArchive, setArchived } from './archive.js';

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gnomon-archive-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('the archive', () => {
  it('is empty when the file does not exist, and that is not an error', () => {
    expect(readArchive(home)).toEqual(new Set());
  });

  it('archives, persists, and reads back sorted', () => {
    setArchived(home, ['session-b', 'session-a'], true);
    expect(readArchive(home)).toEqual(new Set(['session-a', 'session-b']));
    expect(JSON.parse(readFileSync(archivePath(home), 'utf8')).sessionIds).toEqual(['session-a', 'session-b']);
  });

  it('restores exactly, and leaves the others', () => {
    setArchived(home, ['a', 'b', 'c'], true);
    expect(setArchived(home, ['b'], false)).toEqual(new Set(['a', 'c']));
  });

  // A stale tab's second click, or two tabs racing: neither should be able to
  // make the list wrong.
  it('is idempotent both ways', () => {
    setArchived(home, ['a'], true);
    setArchived(home, ['a'], true);
    expect(readArchive(home)).toEqual(new Set(['a']));
    setArchived(home, ['zzz'], false);
    expect(readArchive(home)).toEqual(new Set(['a']));
  });

  it('ignores ids that are not strings', () => {
    setArchived(home, ['a', 42, null, ''], true);
    expect(readArchive(home)).toEqual(new Set(['a']));
  });

  it('treats a corrupt file as empty rather than throwing', () => {
    mkdirSync(join(home, '.daemon'), { recursive: true });
    writeFileSync(archivePath(home), 'not json');
    expect(readArchive(home)).toEqual(new Set());
  });

  it('forgets a deleted session so the archive does not name a ghost', () => {
    setArchived(home, ['a', 'b'], true);
    expect(forget(home, ['a'])).toEqual(new Set(['b']));
  });
});
