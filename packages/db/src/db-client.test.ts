import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDb, resetDb, closeDb } from './db-client.js';

describe('getDb (L4, docs/audit/remediation-todo.md standalone bug list)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetDb();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetDb();
    warnSpy.mockRestore();
  });

  it('returns the same cached instance across repeated calls with no url', () => {
    const a = getDb('file::memory:');
    const b = getDb();
    expect(b).toBe(a);
  });

  it('warns and still returns the ORIGINAL instance when a later call passes a different explicit url (the multi-url case)', () => {
    const first = getDb('file::memory:');
    const second = getDb('file:/tmp/some-other-gnomon.db');

    expect(second).toBe(first);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('file:/tmp/some-other-gnomon.db');
    expect(warnSpy.mock.calls[0][0]).toContain('file::memory:');
  });

  it('does not warn when the same explicit url is passed again', () => {
    getDb('file::memory:');
    getDb('file::memory:');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when a later call omits the url entirely', () => {
    getDb('file::memory:');
    getDb();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resetDb() clears the cached url too, so a subsequent different url does not spuriously warn', () => {
    getDb('file::memory:');
    resetDb();
    getDb('file:/tmp/some-other-gnomon.db');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('closeDb() also clears the cached url', () => {
    getDb('file::memory:');
    closeDb();
    getDb('file:/tmp/some-other-gnomon.db');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
