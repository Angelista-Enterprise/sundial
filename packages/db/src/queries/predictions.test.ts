import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { insertPrediction, listResolvedPredictions, tallyPredictions } from './predictions.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE predictions (
    id text PRIMARY KEY NOT NULL,
    kind text NOT NULL,
    forecaster text NOT NULL,
    created_at text NOT NULL,
    resolved_at text NOT NULL,
    prior_prob real NOT NULL,
    features text,
    outcome integer NOT NULL,
    surprise real NOT NULL, base_prob real
  )`);
  return db;
}

const base = {
  kind: 'day-ending',
  forecaster: 'hourly-rate',
  createdAt: '2026-08-01T17:00:00.000Z',
  resolvedAt: '2026-08-01T18:00:00.000Z',
  priorProb: 0.2,
  features: { hour: 17 },
  outcome: 0 as const,
  surprise: 0.223,
};

describe('predictions', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('round-trips a resolution, including its features', async () => {
    await insertPrediction({ ...base, id: 'p1' });

    const [row] = await listResolvedPredictions();
    expect(row).toMatchObject({ id: 'p1', kind: 'day-ending', forecaster: 'hourly-rate', outcome: 0, priorProb: 0.2 });
    expect(row?.features).toEqual({ hour: 17 });
  });

  /**
   * The property the whole table exists for. A boot replay re-runs an
   * `at-least-once` effect, and this row is keyed by the open prediction's
   * derived id — so the second offer must be discarded rather than counted
   * twice. Double-counting here would inflate exactly the sample A08 gates on.
   */
  it('ignores a replayed insert of the same prediction id', async () => {
    await insertPrediction({ ...base, id: 'p1' });
    await insertPrediction({ ...base, id: 'p1', outcome: 1, surprise: 1.6 });

    const rows = await listResolvedPredictions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 0, surprise: 0.223 });
  });

  it('survives past the 50-entry recentResolved window that made A08 unreachable', async () => {
    for (let i = 0; i < 120; i += 1) {
      await insertPrediction({ ...base, id: `p${i}`, resolvedAt: `2026-08-01T${String(i % 24).padStart(2, '0')}:00:00.000Z` });
    }
    expect(await listResolvedPredictions()).toHaveLength(120);
  });

  it('filters by kind and by resolution time, newest first', async () => {
    await insertPrediction({ ...base, id: 'old', resolvedAt: '2026-07-01T10:00:00.000Z' });
    await insertPrediction({ ...base, id: 'new', resolvedAt: '2026-08-01T10:00:00.000Z' });
    await insertPrediction({ ...base, id: 'other', kind: 'meeting-attendance', resolvedAt: '2026-08-02T10:00:00.000Z' });

    expect((await listResolvedPredictions({ kind: 'day-ending' })).map((r) => r.id)).toEqual(['new', 'old']);
    expect((await listResolvedPredictions({ since: '2026-08-01T00:00:00.000Z' })).map((r) => r.id)).toEqual(['other', 'new']);
  });

  /** Two forecasters on ONE kind must score separately — the reason `forecaster` is a column rather than an inference from `kind`. */
  it('tallies each (kind, forecaster) pair on its own', async () => {
    await insertPrediction({ ...base, id: 'a1', outcome: 1, priorProb: 0.9 });
    await insertPrediction({ ...base, id: 'a2', outcome: 1, priorProb: 0.9 });
    await insertPrediction({ ...base, id: 'b1', forecaster: 'llm', outcome: 0, priorProb: 0.9 });

    const tally = await tallyPredictions();
    const hourly = tally.find((t) => t.forecaster === 'hourly-rate');
    const llm = tally.find((t) => t.forecaster === 'llm');

    expect(hourly).toMatchObject({ kind: 'day-ending', n: 2, hits: 2 });
    expect(hourly?.brier).toBeCloseTo(0.01, 5);
    expect(llm).toMatchObject({ kind: 'day-ending', n: 1, hits: 0 });
    expect(llm?.brier).toBeCloseTo(0.81, 5);
  });
});
