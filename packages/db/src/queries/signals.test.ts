import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { insertSignal, getRecentSignals, getSignalFreshness, getRedactionSummary, getSignalsForDate, getSignalsInRange, getSignalsAfter } from './signals.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE signals (
    id text PRIMARY KEY NOT NULL,
    signal_type text NOT NULL,
    event_type text NOT NULL,
    session_id text,
    data text NOT NULL,
    captured_at text NOT NULL
  )`);
  return db;
}

describe('getSignalFreshness', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('reports the latest captured_at per distinct signal_type/event_type pair', async () => {
    await insertSignal({ id: 's1', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:00:00.000Z' });
    await insertSignal({ id: 's2', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-02T00:00:00.000Z' });
    await insertSignal({ id: 's3', signalType: 'git', eventType: 'commit', data: {}, capturedAt: '2026-01-01T12:00:00.000Z' });

    const freshness = await getSignalFreshness();

    expect(freshness).toEqual(
      expect.arrayContaining([
        { signalType: 'window', eventType: 'changed', lastCapturedAt: '2026-01-02T00:00:00.000Z' },
        { signalType: 'git', eventType: 'commit', lastCapturedAt: '2026-01-01T12:00:00.000Z' },
      ]),
    );
  });

  it('returns an empty array when no signals exist', async () => {
    expect(await getSignalFreshness()).toEqual([]);
  });
});

describe('getRecentSignals with a signalType filter', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('filters before applying the limit, not after', async () => {
    await insertSignal({ id: 's1', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:00:00.000Z' });
    await insertSignal({ id: 's2', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:01:00.000Z' });
    await insertSignal({ id: 's3', signalType: 'git', eventType: 'commit', data: {}, capturedAt: '2026-01-01T00:02:00.000Z' });

    const rows = await getRecentSignals(1, 'window');

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('s2');
  });

  it('with no signalType, returns across all types', async () => {
    await insertSignal({ id: 's1', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:00:00.000Z' });
    await insertSignal({ id: 's2', signalType: 'git', eventType: 'commit', data: {}, capturedAt: '2026-01-01T00:01:00.000Z' });

    const rows = await getRecentSignals(20);
    expect(rows.map((r) => r.id).sort()).toEqual(['s1', 's2']);
  });

  it('offset pages past the most recent results (pagination)', async () => {
    await insertSignal({ id: 's1', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:00:00.000Z' });
    await insertSignal({ id: 's2', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:01:00.000Z' });
    await insertSignal({ id: 's3', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:02:00.000Z' });

    const firstPage = await getRecentSignals(2, undefined, 0);
    const secondPage = await getRecentSignals(2, undefined, 2);

    expect(firstPage.map((r) => r.id)).toEqual(['s3', 's2']);
    expect(secondPage.map((r) => r.id)).toEqual(['s1']);
  });
});

describe('getRedactionSummary', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('aggregates privacy:redacted signals into per-property and per-source counts within the range', async () => {
    await insertSignal({
      id: 'p1',
      signalType: 'privacy',
      eventType: 'redacted',
      data: { properties: { windowTitle: 3, url: 1 }, total: 4, sourceType: 'window:changed' },
      capturedAt: '2026-01-10T00:00:00.000Z',
    });
    await insertSignal({
      id: 'p2',
      signalType: 'privacy',
      eventType: 'redacted',
      data: { properties: { windowTitle: 2 }, total: 2, sourceType: 'window:changed' },
      capturedAt: '2026-01-11T00:00:00.000Z',
    });
    await insertSignal({
      id: 'p3',
      signalType: 'privacy',
      eventType: 'redacted',
      data: { properties: { command: 5 }, total: 5, sourceType: 'shell:command' },
      capturedAt: '2026-01-12T00:00:00.000Z',
    });
    // Outside the range + a non-privacy signal — both must be ignored.
    await insertSignal({ id: 'p0', signalType: 'privacy', eventType: 'redacted', data: { properties: { url: 99 }, total: 99, sourceType: 'window:changed' }, capturedAt: '2025-12-01T00:00:00.000Z' });
    await insertSignal({ id: 'g1', signalType: 'git', eventType: 'commit', data: {}, capturedAt: '2026-01-11T00:00:00.000Z' });

    const summary = await getRedactionSummary('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');

    expect(summary.events).toBe(3);
    expect(summary.total).toBe(11); // 4 + 2 + 5
    expect(summary.byProperty).toEqual([
      { property: 'windowTitle', count: 5 },
      { property: 'command', count: 5 },
      { property: 'url', count: 1 },
    ]);
    expect(summary.bySourceType).toEqual([
      { sourceType: 'window:changed', count: 6 },
      { sourceType: 'shell:command', count: 5 },
    ]);
  });

  it('returns zeroed totals when nothing was redacted in the window', async () => {
    const summary = await getRedactionSummary('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');
    expect(summary).toMatchObject({ events: 0, total: 0, byProperty: [], bySourceType: [] });
  });
});

describe('getSignalsInRange', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  async function seed() {
    for (const [id, capturedAt] of [
      ['s1', '2026-01-01T09:59:59.000Z'],
      ['s2', '2026-01-01T10:00:00.000Z'],
      ['s3', '2026-01-01T10:30:00.000Z'],
      ['s4', '2026-01-01T11:00:00.000Z'],
    ]) {
      await insertSignal({ id: id!, signalType: 'window', eventType: 'changed', data: { id }, capturedAt: capturedAt! });
    }
  }

  it('breaks a tie in captured_at by id, so offset pages never shuffle', async () => {
    for (const id of ['t3', 't1', 't2']) await insertSignal({ id, signalType: 'window', eventType: 'changed', data: { id }, capturedAt: '2026-01-01T10:00:00.000Z' });
    const pages = [...(await getSignalsInRange('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 2)), ...(await getSignalsInRange('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 2, undefined, 2))];
    expect(pages.map((r) => r.id)).toEqual(['t1', 't2', 't3']);
  });

  it('returns the window chronologically, inclusive of `from`', async () => {
    await seed();
    const rows = await getSignalsInRange('2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z');
    expect(rows.map((r) => r.id)).toEqual(['s2', 's3']);
  });

  it('is half-open at `to`, so two adjacent moments cannot both claim the boundary signal', async () => {
    await seed();
    const first = await getSignalsInRange('2026-01-01T09:00:00.000Z', '2026-01-01T10:00:00.000Z');
    const second = await getSignalsInRange('2026-01-01T10:00:00.000Z', '2026-01-01T12:00:00.000Z');
    expect(first.map((r) => r.id)).toEqual(['s1']);
    expect(second.map((r) => r.id)).toEqual(['s2', 's3', 's4']);
  });

  it('bounds the read — a long moment can hold thousands of input ticks', async () => {
    await seed();
    const rows = await getSignalsInRange('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 2);
    expect(rows.map((r) => r.id)).toEqual(['s1', 's2']);
  });

  it('parses each payload back out of its JSON column', async () => {
    await seed();
    const [row] = await getSignalsInRange('2026-01-01T10:00:00.000Z', '2026-01-01T10:15:00.000Z');
    expect(row?.data).toEqual({ id: 's2' });
  });
});

/**
 * The window is the OWNER's day, per
 * `almanac/decisions/day-boundaries-use-owner-timezone`. It used to be built as
 * `${date}T00:00:00.000Z`..`T23:59:59.999Z` — a UTC day, which in Amsterdam
 * begins at 02:00, so everything between local midnight and 02:00 was filed
 * under the previous date.
 *
 * That mattered most for this function's actual job. `buildDailyContext` calls
 * it for `system` signals to tag overnight sleep/wake crossings, and the
 * crossings that decide "was this gap a break or a night" are precisely the ones
 * in those two hours.
 */
describe('getSignalsForDate day boundaries', () => {
  const AMSTERDAM = 'Europe/Amsterdam';

  beforeEach(async () => {
    await setupTestDb();
  });

  it('puts 00:30 Amsterdam (22:30 UTC the day before) on the LATER local day', async () => {
    // The exact case the UTC window got wrong.
    await insertSignal({ id: 'justAfterMidnight', signalType: 'system', eventType: 'sleep-wake', data: {}, capturedAt: '2026-08-01T22:30:00.000Z' });

    const local = await getSignalsForDate('2026-08-02', undefined, AMSTERDAM);
    const previous = await getSignalsForDate('2026-08-01', undefined, AMSTERDAM);

    expect(local.map((row) => row.id)).toEqual(['justAfterMidnight']);
    expect(previous).toEqual([]);
  });

  it('still reads it as the earlier day in UTC, which is what the default preserves', async () => {
    await insertSignal({ id: 'justAfterMidnight', signalType: 'system', eventType: 'sleep-wake', data: {}, capturedAt: '2026-08-01T22:30:00.000Z' });

    // No timeZone argument: unchanged behaviour for any caller not given a zone.
    expect((await getSignalsForDate('2026-08-01')).map((row) => row.id)).toEqual(['justAfterMidnight']);
    expect(await getSignalsForDate('2026-08-02')).toEqual([]);
  });

  it('excludes 23:30 the previous local evening and includes 23:30 the same one', async () => {
    // 21:30Z is 23:30 local on the 1st; 21:30Z next day is 23:30 local on the 2nd.
    await insertSignal({ id: 'lateOn1st', signalType: 'system', eventType: 'power', data: {}, capturedAt: '2026-08-01T21:30:00.000Z' });
    await insertSignal({ id: 'lateOn2nd', signalType: 'system', eventType: 'power', data: {}, capturedAt: '2026-08-02T21:30:00.000Z' });

    expect((await getSignalsForDate('2026-08-02', undefined, AMSTERDAM)).map((row) => row.id)).toEqual(['lateOn2nd']);
  });

  it('is half-open at the end, so a signal at exactly local midnight belongs to the day it starts', async () => {
    // 22:00Z on the 1st is exactly 00:00 local on the 2nd.
    await insertSignal({ id: 'exactlyMidnight', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-08-01T22:00:00.000Z' });

    expect((await getSignalsForDate('2026-08-02', undefined, AMSTERDAM)).map((row) => row.id)).toEqual(['exactlyMidnight']);
    expect(await getSignalsForDate('2026-08-01', undefined, AMSTERDAM)).toEqual([]);
  });

  it('applies the signalType filter within the local window, not across it', async () => {
    await insertSignal({ id: 'searchLocal', signalType: 'search', eventType: 'performed', data: {}, capturedAt: '2026-08-01T22:30:00.000Z' });
    await insertSignal({ id: 'windowLocal', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-08-01T23:00:00.000Z' });
    await insertSignal({ id: 'searchPrevDay', signalType: 'search', eventType: 'performed', data: {}, capturedAt: '2026-08-01T10:00:00.000Z' });

    const rows = await getSignalsForDate('2026-08-02', 'search', AMSTERDAM);

    expect(rows.map((row) => row.id)).toEqual(['searchLocal']);
  });

  it('handles a winter date, where the Amsterdam offset is +01:00 rather than +02:00', async () => {
    // 23:30Z on 12 Jan is 00:30 local on the 13th — one hour of offset, not two.
    await insertSignal({ id: 'winterNight', signalType: 'system', eventType: 'sleep-wake', data: {}, capturedAt: '2026-01-12T23:30:00.000Z' });

    expect((await getSignalsForDate('2026-01-13', undefined, AMSTERDAM)).map((row) => row.id)).toEqual(['winterNight']);
    expect(await getSignalsForDate('2026-01-12', undefined, AMSTERDAM)).toEqual([]);
  });
});

/**
 * A LIST of types, added for `gnomon_recent_activity`. Unfiltered it returned
 * the newest rows of the whole log, and `screen:ocr`/`input:activity` are the
 * two highest-volume sensors — so "what just happened" answered with screen
 * dumps and input ticks. `getSignalsInRange` could not serve it: that one orders
 * ASCENDING before limiting, so it returns the OLDEST rows of a window.
 */
describe('getRecentSignals with a list of types', () => {
  beforeEach(async () => {
    await setupTestDb();
    // Interleaved on purpose: a naive "newest 20 then filter" would return the
    // ocr rows and drop the window ones.
    for (let i = 0; i < 6; i += 1) {
      await insertSignal({ id: `ocr-${i}`, signalType: 'screen', eventType: 'ocr', sessionId: null, data: { screenText: 'x' }, capturedAt: `2026-01-01T00:0${i}:30.000Z` });
      await insertSignal({ id: `win-${i}`, signalType: 'window', eventType: 'changed', sessionId: null, data: { processName: 'Code' }, capturedAt: `2026-01-01T00:0${i}:00.000Z` });
    }
  });

  it('returns the newest rows across the listed types and nothing else', async () => {
    const rows = await getRecentSignals(3, ['window', 'git']);
    expect(rows.map((r) => r.id)).toEqual(['win-5', 'win-4', 'win-3']);
  });

  it('filters BEFORE the limit, so a noisy type cannot crowd the answer out', async () => {
    const rows = await getRecentSignals(6, ['window']);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.signalType === 'window')).toBe(true);
  });

  it('still accepts a single type, as every existing caller passes', async () => {
    const rows = await getRecentSignals(2, 'screen');
    expect(rows.map((r) => r.id)).toEqual(['ocr-5', 'ocr-4']);
  });

  it('an empty list is not a filter at all', async () => {
    const rows = await getRecentSignals(1, []);
    expect(rows).toHaveLength(1);
  });
});

describe('getSignalsAfter (boot replay)', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('returns what was written after the offset, even when its id sorts lower', async () => {
    const put = (id: string) => insertSignal({ id, signalType: 'clock', eventType: 'tick', data: {}, capturedAt: '2026-01-01T00:00:00.000Z' });
    await put('01B');
    await put('01C'); // the snapshot's offset
    await put('01A'); // a derived child with an older millisecond
    await put('01D');
    expect((await getSignalsAfter('01C')).map((r) => r.id)).toEqual(['01A', '01D']);
    expect((await getSignalsAfter(null)).map((r) => r.id)).toEqual(['01B', '01C', '01A', '01D']);
    expect((await getSignalsAfter('01BB')).map((r) => r.id), 'an offset no longer in the log: id order').toEqual(['01C', '01D']);
  });
});
