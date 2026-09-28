// The repeat-call handle, and the two things it must never do: serve a stale
// "now", and outlive the message it points at.
import { describe, it, expect } from 'vitest';
import { callKey, createHandleCache, digestOf, isSettledCall } from './handles.js';

const TODAY = '2026-09-18';
const S = 'session-1';

describe('callKey', () => {
  it('treats the same arguments in a different order as one call', () => {
    expect(callKey('gnomon_code_activity', { date: '2026-09-11', projectRoot: 'sundial' })).toBe(
      callKey('gnomon_code_activity', { projectRoot: 'sundial', date: '2026-09-11' }),
    );
  });

  it('keeps different arguments apart, including a different page of the same day', () => {
    expect(callKey('gnomon_signals', { date: '2026-09-11', offset: 0 })).not.toBe(callKey('gnomon_signals', { date: '2026-09-11', offset: 25 }));
    expect(callKey('gnomon_signals', { date: '2026-09-11' })).not.toBe(callKey('gnomon_today_summary', { date: '2026-09-11' }));
  });
});

describe('isSettledCall', () => {
  it('is true only for a day that has finished', () => {
    expect(isSettledCall({ date: '2026-09-11' }, TODAY)).toBe(true);
  });

  it('is false for today, which is still being written', () => {
    expect(isSettledCall({ date: TODAY }, TODAY)).toBe(false);
  });

  it('is false with no date at all — an undated call is a question about now', () => {
    // gnomon_current_context is the one that must never be answered from a
    // cache. No time-to-live exists here precisely so there is no window in
    // which a stale "now" could be served as current.
    expect(isSettledCall({}, TODAY)).toBe(false);
    expect(isSettledCall({ limit: 20 }, TODAY)).toBe(false);
  });

  it('is false for a date it cannot parse, rather than guessing', () => {
    expect(isSettledCall({ date: 'yesterday' }, TODAY)).toBe(false);
    expect(isSettledCall({ date: '11-09-2026' }, TODAY)).toBe(false);
    expect(isSettledCall({ date: 42 }, TODAY)).toBe(false);
  });

  it('is false for a FUTURE date, which has nothing settled about it', () => {
    expect(isSettledCall({ date: '2026-12-25' }, TODAY)).toBe(false);
  });
});

describe('digestOf', () => {
  it('leads with the paging numbers, the most informative thing a result carries', () => {
    expect(digestOf({ count: 25, total: 412, signals: [1, 2, 3] })).toContain('25 of 412 rows');
  });

  it('falls back to naming the lists it found', () => {
    expect(digestOf({ files: [1, 2], commits: [3] })).toBe('2 files, 1 commits');
  });

  it('says something for a result with no lists at all', () => {
    expect(digestOf({ a: 1, b: 2 })).toBe('2 fields');
  });
});

describe('createHandleCache', () => {
  it('returns nothing until the call has actually been made', () => {
    const cache = createHandleCache();
    expect(cache.lookup(S, 'gnomon_today_summary', { date: '2026-09-11' }, TODAY)).toBeNull();
  });

  it('hands back a handle the second time the same finished day is asked for', () => {
    const cache = createHandleCache();
    cache.remember(S, 'gnomon_today_summary', { date: '2026-09-11' }, { count: 8, total: 54, sessions: [] }, TODAY);

    const handle = cache.lookup(S, 'gnomon_today_summary', { date: '2026-09-11' }, TODAY);
    expect(handle.unchanged).toBe(true);
    expect(handle.digest).toContain('8 of 54 rows');
    expect(handle.note).toContain('already called gnomon_today_summary');
    // It must say where the data IS, not merely that it was withheld.
    expect(handle.note).toContain('still above');
  });

  it('is tiny compared with the result it replaces — the entire point', () => {
    const cache = createHandleCache();
    const big = { count: 25, total: 412, signals: Array.from({ length: 25 }, (_, i) => ({ i, blob: 'x'.repeat(200) })) };
    cache.remember(S, 'gnomon_signals', { date: '2026-09-11' }, big, TODAY);

    const handle = cache.lookup(S, 'gnomon_signals', { date: '2026-09-11' }, TODAY);
    expect(JSON.stringify(handle).length).toBeLessThan(JSON.stringify(big).length / 5);
  });

  it('never stubs a different page, so paging still works', () => {
    const cache = createHandleCache();
    cache.remember(S, 'gnomon_signals', { date: '2026-09-11', offset: 0 }, { count: 25 }, TODAY);
    expect(cache.lookup(S, 'gnomon_signals', { date: '2026-09-11', offset: 25 }, TODAY)).toBeNull();
  });

  it('never stubs today, however many times it is asked', () => {
    const cache = createHandleCache();
    cache.remember(S, 'gnomon_today_summary', { date: TODAY }, { count: 3 }, TODAY);
    expect(cache.lookup(S, 'gnomon_today_summary', { date: TODAY }, TODAY)).toBeNull();
    expect(cache.size(S)).toBe(0);
  });

  it('never stubs an undated call, so "what is happening now" always re-reads', () => {
    const cache = createHandleCache();
    cache.remember(S, 'gnomon_current_context', {}, { app: 'Code' }, TODAY);
    expect(cache.lookup(S, 'gnomon_current_context', {}, TODAY)).toBeNull();
  });

  it('starts stubbing a day only once that day is genuinely over', () => {
    // A session running past midnight. The same stored call is mutable while
    // the day is today and settled the morning after, because the comparison
    // happens at lookup, not at store.
    const cache = createHandleCache();
    cache.remember(S, 'gnomon_today_summary', { date: '2026-09-18' }, { count: 3 }, '2026-09-19');
    expect(cache.lookup(S, 'gnomon_today_summary', { date: '2026-09-18' }, '2026-09-18')).toBeNull();
    expect(cache.lookup(S, 'gnomon_today_summary', { date: '2026-09-18' }, '2026-09-19')).not.toBeNull();
  });

  it('keeps sessions apart — one conversation cannot answer for another', () => {
    const cache = createHandleCache();
    cache.remember(S, 'gnomon_today_summary', { date: '2026-09-11' }, { count: 8 }, TODAY);
    expect(cache.lookup('session-2', 'gnomon_today_summary', { date: '2026-09-11' }, TODAY)).toBeNull();
  });

  it('forgets a session when compaction rewrites its history', () => {
    // The handle claims the full result is still above. After compaction that
    // may be false, and a wrong claim is worse than a repeated call.
    const cache = createHandleCache();
    cache.remember(S, 'gnomon_today_summary', { date: '2026-09-11' }, { count: 8 }, TODAY);
    cache.clear(S);
    expect(cache.lookup(S, 'gnomon_today_summary', { date: '2026-09-11' }, TODAY)).toBeNull();
  });

  it('stays bounded on a long session, dropping the oldest calls first', () => {
    const cache = createHandleCache({ maxEntries: 3 });
    for (const d of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) {
      cache.remember(S, 'gnomon_today_summary', { date: d }, { count: 1 }, TODAY);
    }
    expect(cache.size(S)).toBe(3);
    expect(cache.lookup(S, 'gnomon_today_summary', { date: '2026-09-01' }, TODAY)).toBeNull();
    expect(cache.lookup(S, 'gnomon_today_summary', { date: '2026-09-04' }, TODAY)).not.toBeNull();
  });

  it('counts a repeated call as recent, so a thread being worked on is not evicted', () => {
    const cache = createHandleCache({ maxEntries: 2 });
    cache.remember(S, 'gnomon_today_summary', { date: '2026-09-01' }, { count: 1 }, TODAY);
    cache.remember(S, 'gnomon_today_summary', { date: '2026-09-02' }, { count: 1 }, TODAY);
    cache.remember(S, 'gnomon_today_summary', { date: '2026-09-01' }, { count: 1 }, TODAY);
    cache.remember(S, 'gnomon_today_summary', { date: '2026-09-03' }, { count: 1 }, TODAY);

    expect(cache.lookup(S, 'gnomon_today_summary', { date: '2026-09-01' }, TODAY)).not.toBeNull();
    expect(cache.lookup(S, 'gnomon_today_summary', { date: '2026-09-02' }, TODAY)).toBeNull();
  });
});
