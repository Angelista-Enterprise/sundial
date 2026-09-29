import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb, insertSignal, insertMoment, getMomentsForDate } from '@sundial/db/index.js';
import { replayTail } from './snapshot.js';
import { createInitialState, hydrateSnapshot, unknownSnapshotKeys } from './initial-state.js';
import type { KernelState, MomentRollup } from './types.js';

async function setupTestDb() {
  resetDb();
  // getDb(), not createDb() — this registers the in-memory instance as the
  // module singleton, which is what insertSignal/insertMoment/etc. read via
  // their own no-arg getDb() calls. createDb() alone would build a second,
  // disconnected in-memory instance that those functions never touch.
  const db = getDb('file::memory:');

  await db.run(sql`CREATE TABLE signals (
    id text PRIMARY KEY NOT NULL,
    signal_type text NOT NULL,
    event_type text NOT NULL,
    session_id text,
    data text NOT NULL,
    captured_at text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE moments (
    id text PRIMARY KEY NOT NULL,
    start_time text NOT NULL,
    end_time text NOT NULL,
    duration_ms integer NOT NULL,
    process_name text NOT NULL,
    data text NOT NULL,
    importance_score integer NOT NULL DEFAULT 1,
    last_accessed_at text,
    project_id text
  )`);

  return db;
}

describe('replayTail', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('excludes signals at or before the given offset, includes everything after', async () => {
    await insertSignal({ id: 'a', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:00:00.000Z' });
    await insertSignal({ id: 'b', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:00:01.000Z' });
    await insertSignal({ id: 'c', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:00:02.000Z' });

    const tail = await replayTail('b');

    expect(tail.map((e) => e.id)).toEqual(['c']);
  });

  it('replays everything when there is no prior offset (fresh boot, no snapshot yet)', async () => {
    await insertSignal({ id: 'a', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:00:00.000Z' });
    await insertSignal({ id: 'b', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:00:01.000Z' });

    const tail = await replayTail(null);

    expect(tail.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('insertMoment upsert idempotency', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('replaying the same moment-close effect twice does not duplicate the row', async () => {
    const moment = {
      id: 'm1',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:05:00.000Z',
      durationMs: 300_000,
      processName: 'Terminal',
      data: { processName: 'Terminal', windowTitles: ['zsh'] },
      importanceScore: 2,
      projectId: null,
    };

    // Simulates: live execution writes the row, then a crash + replay re-runs
    // the same reduce() fold and re-executes the same WriteDB effect.
    await insertMoment(moment);
    await insertMoment(moment);

    const rows = await getMomentsForDate('2026-01-01');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('m1');
  });
});

describe('hydrateSnapshot', () => {
  it('fills in a top-level field missing from an old, pre-this-field snapshot with its default', () => {
    const fresh = createInitialState('device-1');
    // Simulate an old snapshot predating a field the current KernelState type
    // has — e.g. a future phase's new top-level slice. `as any` + `delete`
    // stands in for "this key genuinely isn't in the persisted JSON,"
    // which `JSON.parse` of an old row would also produce.
    const staleSnapshotJson = { ...fresh } as Record<string, unknown>;
    delete staleSnapshotJson.memory;

    const hydrated = hydrateSnapshot('device-1', staleSnapshotJson);

    expect(hydrated.memory).toEqual(fresh.memory);
  });

  it('preserves fields the snapshot does have, not just defaults', () => {
    const fresh = createInitialState('device-1');
    const persisted = { ...fresh, window: { active: { processName: 'Code', windowTitle: 'foo.ts', windowId: 'x:1', documentPath: null }, previous: null, attribution: { projectId: null, source: null, confidence: null } } };

    const hydrated = hydrateSnapshot('device-1', persisted);

    expect(hydrated.window.active?.processName).toBe('Code');
  });

  it('fills in a field missing from an EXISTING nested slice (A§1.7) — not just brand-new top-level slices', () => {
    const fresh = createInitialState('device-1');
    // Simulate a snapshot written before `memory.factCursor` existed: the
    // `memory` key itself is present (so the old shallow top-level merge
    // would have kept this stale object wholesale), but one of its fields
    // predates the current shape.
    const staleMemory = { ...fresh.memory } as Record<string, unknown>;
    delete staleMemory.factCursor;
    const persisted = { ...fresh, memory: staleMemory as unknown as typeof fresh.memory };

    const hydrated = hydrateSnapshot('device-1', persisted);

    expect(hydrated.memory.factCursor).toEqual({});
    expect(hydrated.memory.recentEntityIds).toEqual(fresh.memory.recentEntityIds);
  });

  it('does not merge array elements — a persisted array wins wholesale over the default', () => {
    const fresh = createInitialState('device-1');
    const persisted = { ...fresh, recentHistory: [{ ts: '2026-01-01T00:00:00.000Z', summary: 'test' }] };

    const hydrated = hydrateSnapshot('device-1', persisted);

    expect(hydrated.recentHistory).toEqual([{ ts: '2026-01-01T00:00:00.000Z', summary: 'test' }]);
  });

  it('backfills a missing MomentRollup extra on a carried-over open moment (regression: appendCapped crash)', () => {
    // `state.moment` is `null` in `createInitialState`, so `deepMergeDefaults` has no default
    // object to recurse into for it — it takes `persisted.moment` wholesale. A snapshot written
    // before `lifeEvents` existed on `MomentRollup` (or before this open moment's carry-over
    // chain started) would leave it `undefined` forever, which is exactly what crashed
    // `moment-rollup.ts`'s `appendCapped` in production: `[...undefined, item]` is not iterable.
    const fresh = createInitialState('device-1');
    const staleRollup = {
      processName: 'Terminal',
      windowTitles: ['zsh'],
      shellCommandCount: 3,
      gitCommitCount: 0,
      gitBranch: null,
      calendarActive: false,
      typingEventCount: 0, inputEventCount: 0, activeMs: 0,
      // notableCommands/lifeEvents intentionally absent — the pre-fix shape.
    } as unknown as MomentRollup;
    const persisted: Partial<KernelState> = {
      ...fresh,
      moment: {
        id: 'm1',
        sessionId: 's1',
        startTime: '2026-01-01T00:00:00.000Z',
        processName: 'Terminal',
        projectId: null,
        rollup: staleRollup,
        intent: { status: 'none' as const },
      },
    };

    const hydrated = hydrateSnapshot('device-1', persisted);

    expect(hydrated.moment?.rollup.lifeEvents).toEqual([]);
    expect(hydrated.moment?.rollup.notableCommands).toEqual([]);
    // Real accumulated values on the stale rollup must survive the backfill, not just defaults.
    expect(hydrated.moment?.rollup.shellCommandCount).toBe(3);
  });

  /**
   * The pre-per-kind pooled record was the retired `project-continuity`
   * forecaster's own history, so it is discarded rather than migrated onto that
   * key — migrating it would resurrect a counter with no producer.
   */
  it('discards a pre-per-kind pooled predictions.calibration', () => {
    const fresh = createInitialState('device-1');
    const persisted: Partial<KernelState> = {
      ...fresh,
      predictions: { ...fresh.predictions, calibration: { n: 2362, hits: 1084, brierSum: 590.2 } as unknown as KernelState['predictions']['calibration'] },
    };

    const hydrated = hydrateSnapshot('device-1', persisted);

    expect(hydrated.predictions.calibration).toEqual({});
  });

  it('leaves a live per-kind predictions.calibration untouched', () => {
    const fresh = createInitialState('device-1');
    const persisted: Partial<KernelState> = {
      ...fresh,
      predictions: { ...fresh.predictions, calibration: { 'day-ending': { n: 3, hits: 3, brierSum: 0.2 } } },
    };

    const hydrated = hydrateSnapshot('device-1', persisted);

    expect(hydrated.predictions.calibration).toEqual({ 'day-ending': { n: 3, hits: 3, brierSum: 0.2 } });
  });

  /**
   * A snapshot written before the 2026-07-29 retirement carries the dead kind
   * in three places at once, and all three have to go — a surviving open
   * prediction would never resolve, and a surviving calibration counter or
   * resolution list would render in the macOS app as a forecaster that cannot
   * produce another data point.
   */
  it('purges a retired forecaster from calibration, open predictions and recentResolved', () => {
    const fresh = createInitialState('device-1');
    const persisted: Partial<KernelState> = {
      ...fresh,
      predictions: {
        ...fresh.predictions,
        calibration: { 'project-continuity': { n: 2362, hits: 1084, brierSum: 590.2 }, 'day-ending': { n: 3, hits: 3, brierSum: 0.2 } },
        open: [
          { id: 'pc1', createdAt: '2026-07-28T09:00:00.000Z', kind: 'project-continuity', predictedProjectId: 'proj:g', priorProb: 0.46 },
          { id: 'de1', createdAt: '2026-07-28T09:00:00.000Z', kind: 'day-ending', hour: 9, priorProb: 0.1 },
        ] as unknown as KernelState['predictions']['open'],
        recentResolved: [
          { kind: 'project-continuity', priorProb: 0.46, hit: false, surprise: 0.62, resolvedAt: '2026-07-28T09:05:00.000Z' },
          { kind: 'day-ending', priorProb: 0.1, hit: true, surprise: 2.3, resolvedAt: '2026-07-28T23:05:00.000Z' },
        ],
      },
    };

    const hydrated = hydrateSnapshot('device-1', persisted);

    expect(hydrated.predictions.calibration).toEqual({ 'day-ending': { n: 3, hits: 3, brierSum: 0.2 } });
    expect(hydrated.predictions.open.map((p) => p.kind)).toEqual(['day-ending']);
    expect(hydrated.predictions.recentResolved.map((p) => p.kind)).toEqual(['day-ending']);
  });

  it('back-fills a new nested key inside a once-optional slice (F1)', () => {
    // A snapshot from before `drift.holding` existed: the slice is there, the key is not.
    const persisted = { ...createInitialState('d'), drift: { days: { '2026-09-01': {} }, meetings: [], checkedWeek: null } } as never;
    const hydrated = hydrateSnapshot('d', persisted);
    expect(hydrated.drift?.holding).toEqual({});
    expect(Object.keys(hydrated.drift?.days ?? {})).toEqual(['2026-09-01']);
    for (const k of ['resume', 'tickets', 'watch', 'nightShift', 'drift', 'factTests', 'briefs'] as const) expect(createInitialState('d')[k]).toBeDefined();
  });

  it('names the top-level keys no default knows (F1)', () => {
    expect(unknownSnapshotKeys(createInitialState('d'))).toEqual([]);
    expect(unknownSnapshotKeys({ ...createInitialState('d'), oldSlice: {}, renamedThing: 1 })).toEqual(['oldSlice', 'renamedThing']);
  });
});

describe('hydrateSnapshot keys an old ingestAnomaly ring (Q9)', () => {
  it('turns whole texts into keys, so nothing asked is asked again and nothing marked is lost', async () => {
    const { textKey } = await import('@sundial/helpers/derive-id.js');
    const old = { ingestAnomaly: { seen: ['Pull requests · puzzlebox-studio', textKey('already a key')], marked: { 'this session was leisure': { p: 0.9, ts: '2026-09-22T10:00:00.000Z' } } } };
    const hydrated = hydrateSnapshot('d1', old as never);
    expect(hydrated.ingestAnomaly.seen).toEqual([textKey('Pull requests · puzzlebox-studio'), textKey('already a key')]);
    expect(hydrated.ingestAnomaly.marked).toEqual({ [textKey('this session was leisure')]: { p: 0.9, ts: '2026-09-22T10:00:00.000Z' } });
    expect(hydrateSnapshot('d1', hydrated).ingestAnomaly).toEqual(hydrated.ingestAnomaly);
  });
});
