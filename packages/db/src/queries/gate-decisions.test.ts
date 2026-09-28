import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { getGateDecisionsBetween, insertGateDecision, updateGateDecisionFeatures } from './gate-decisions.js';

const row = { id: 'dec-1', noticeKey: 'k', kind: 'commitment-quiet', channel: 'tonic', reason: 'admitted', weight: 1.6, utility: 1.2, surprise: 1, precision: 1, habituation: 1, concern: 1, interruptionCost: 0.2, decidedAt: '2026-09-22T10:10:22.146Z' };

describe('gate_decisions.features (J1.6)', () => {
  beforeEach(async () => {
    resetDb();
    const db = getDb('file::memory:');
    await db.run(sql`CREATE TABLE gate_decisions (id text PRIMARY KEY NOT NULL, notice_key text NOT NULL, kind text NOT NULL, channel text NOT NULL, reason text NOT NULL, weight real NOT NULL, utility real NOT NULL, surprise real NOT NULL, precision real NOT NULL, habituation real NOT NULL, concern real NOT NULL, interruption_cost real NOT NULL, tonic_bar real, phasic_bar real, decided_at text NOT NULL, features text)`);
  });

  it('writes the features JSON beside the arithmetic, idempotently, and leaves a missing row alone', async () => {
    await insertGateDecision(row);
    const features = { speak_now: 0.16, channel: 'ambient', at: 't' };
    expect(await updateGateDecisionFeatures('dec-1', features)).toBe(true);
    expect(await updateGateDecisionFeatures('dec-1', features)).toBe(true);
    expect(await updateGateDecisionFeatures('nope', features)).toBe(false);
    const [stored] = await getGateDecisionsBetween('2026-09-22T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
    expect(stored.weight).toBe(1.6);
    // K0.2: a row written without the bars keeps them null rather than
    // acquiring today's. There is no honest backfill, so "not known" has to
    // survive the round trip to reach the reader that must say so.
    expect(stored.tonicBar).toBeNull();
    expect(stored.phasicBar).toBeNull();
    expect(JSON.parse(stored.features ?? 'null')).toEqual(features);
  });
});
