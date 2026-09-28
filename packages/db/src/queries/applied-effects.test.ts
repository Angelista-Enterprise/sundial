import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { getEffectJournalStatus, markEffectStarted, markEffectCompleted, markEffectIndeterminate, markEffectFailed, markEffectEmitted, getRecentRuleTriggers } from './applied-effects.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE applied_effects (
    event_id text NOT NULL,
    effect_index integer NOT NULL,
    applied_at text NOT NULL,
    status text DEFAULT 'completed' NOT NULL,
    rule_name text,
    event_type text,
    effect_detail text,
    failures integer DEFAULT 0 NOT NULL,
    last_error text,
    emitted_event_id text,
    PRIMARY KEY (event_id, effect_index)
  )`);
  return db;
}

/** The full two-phase write, as `executeEffects` performs it. */
async function runEffect(eventId: string, effectIndex: number, trigger?: { ruleName: string; eventType: string; effectDetail: string }) {
  await markEffectStarted(eventId, effectIndex, trigger);
  await markEffectCompleted(eventId, effectIndex);
}

describe('applied-effects journal', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('reports no status for an effect that was never attempted', async () => {
    expect(await getEffectJournalStatus('e1', 0)).toBeNull();
  });

  /**
   * The state that did not exist before the journal became two-phase, and the
   * only reason it exists: a row written before execution means the effect was
   * in flight, so its outcome is unknown rather than absent.
   */
  it('reports started after phase one and before phase two', async () => {
    await markEffectStarted('e1', 0);
    expect(await getEffectJournalStatus('e1', 0)).toBe('started');
  });

  it('reports completed after both phases', async () => {
    await runEffect('e1', 0);
    expect(await getEffectJournalStatus('e1', 0)).toBe('completed');
  });

  it('reports indeterminate once an abandoned effect is recorded', async () => {
    await markEffectStarted('e1', 0);
    await markEffectIndeterminate('e1', 0);
    expect(await getEffectJournalStatus('e1', 0)).toBe('indeterminate');
  });

  it('tracks each (event, index) pair independently', async () => {
    await runEffect('e1', 0);
    expect(await getEffectJournalStatus('e1', 1)).toBeNull();
    expect(await getEffectJournalStatus('e2', 0)).toBeNull();
  });

  /**
   * Phase one must never overwrite a status that already exists. Boot replay
   * consults the journal and then, for an `at-least-once` effect it decides to
   * re-run, calls `markEffectStarted` again — if that reset a `completed` row to
   * `started`, every subsequent boot would see an in-flight effect that had
   * actually finished long ago.
   */
  it('phase one does not reset an already-completed effect back to started', async () => {
    await runEffect('e1', 0);
    await markEffectStarted('e1', 0);
    expect(await getEffectJournalStatus('e1', 0)).toBe('completed');
  });

  it('phase one does not resurrect an abandoned effect', async () => {
    await markEffectStarted('e1', 0);
    await markEffectIndeterminate('e1', 0);
    await markEffectStarted('e1', 0);
    expect(await getEffectJournalStatus('e1', 0)).toBe('indeterminate');
  });

  it('running the same effect through both phases twice is a harmless no-op', async () => {
    await runEffect('e1', 0);
    await expect(runEffect('e1', 0)).resolves.toBeUndefined();
    expect(await getEffectJournalStatus('e1', 0)).toBe('completed');
  });

  /**
   * Rows predating the `status` column were only ever written after a successful
   * run, so the column's `completed` default is the accurate reading of them —
   * not a guess. The migration relies on this, and so does boot replay's
   * decision to skip them.
   */
  it('reads a row written without an explicit status as completed', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO applied_effects (event_id, effect_index, applied_at) VALUES ('legacy', 0, '2026-01-01T00:00:00.000Z')`);
    expect(await getEffectJournalStatus('legacy', 0)).toBe('completed');
  });
});

describe('getRecentRuleTriggers', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('returns rows with trigger attribution, most recent first', async () => {
    await runEffect('e1', 0, { ruleName: 'momentClose', eventType: 'window:changed', effectDetail: 'WriteDB moment m1' });
    await runEffect('e2', 0, { ruleName: 'entityExtract', eventType: 'window:changed', effectDetail: 'UpsertEntityFact project:gnomon' });

    const triggers = await getRecentRuleTriggers();

    expect(triggers).toHaveLength(2);
    expect(triggers[0].ruleName).toBe('entityExtract');
    expect(triggers[1].ruleName).toBe('momentClose');
  });

  it('omits rows written without trigger attribution (pre-migration rows)', async () => {
    await runEffect('e1', 0); // no `trigger` — simulates a row from before the migration
    await runEffect('e2', 0, { ruleName: 'momentClose', eventType: 'window:changed', effectDetail: 'WriteDB moment m1' });

    const triggers = await getRecentRuleTriggers();

    expect(triggers).toHaveLength(1);
    expect(triggers[0].eventId).toBe('e2');
  });

  /**
   * Attribution is written in phase one, so an effect that started and never
   * completed is still attributable to the rule that asked for it — which is the
   * case an operator investigating a crash most wants to see.
   */
  it('shows an effect that started but never completed', async () => {
    await markEffectStarted('e1', 0, { ruleName: 'someRule', eventType: 'clock:tick', effectDetail: 'Notify test' });

    const triggers = await getRecentRuleTriggers();

    expect(triggers).toHaveLength(1);
    expect(triggers[0].ruleName).toBe('someRule');
  });

  it('respects the limit', async () => {
    await runEffect('e1', 0, { ruleName: 'a', eventType: 'x', effectDetail: 'd' });
    await runEffect('e2', 0, { ruleName: 'b', eventType: 'x', effectDetail: 'd' });

    expect(await getRecentRuleTriggers(1)).toHaveLength(1);
  });

  it('returns an empty array when nothing has been journaled', async () => {
    expect(await getRecentRuleTriggers()).toEqual([]);
  });

  it('offset pages past the most recent results (pagination)', async () => {
    await runEffect('e1', 0, { ruleName: 'a', eventType: 'x', effectDetail: 'd' });
    await runEffect('e2', 0, { ruleName: 'b', eventType: 'x', effectDetail: 'd' });
    await runEffect('e3', 0, { ruleName: 'c', eventType: 'x', effectDetail: 'd' });

    const firstPage = await getRecentRuleTriggers(2, 0);
    const secondPage = await getRecentRuleTriggers(2, 2);

    expect(firstPage.map((t) => t.eventId)).toEqual(['e3', 'e2']);
    expect(secondPage.map((t) => t.eventId)).toEqual(['e1']);
  });
});

describe('a failure, and the emit edge (K0.5)', () => {
  beforeEach(setupTestDb);

  it('counts a throw and keeps the count after the retry succeeds', async () => {
    // The whole item. Before this, an effect that threw left `started`, was
    // re-run on the next boot because every variant is at-least-once, and was
    // stamped `completed` — so the journal reported the opposite of what
    // happened, on all 27,029 of its rows. A status cannot hold "worked on the
    // third try"; a counter beside it can.
    const trigger = { ruleName: 'r', eventType: 'x', effectDetail: 'd' };
    await markEffectStarted('e1', 0, trigger);
    await markEffectFailed('e1', 0, 'boom');
    expect(await getEffectJournalStatus('e1', 0)).toBe('failed');

    await markEffectFailed('e1', 0, 'boom again');
    await markEffectCompleted('e1', 0);
    expect(await getEffectJournalStatus('e1', 0)).toBe('completed');

    const [row] = await getRecentRuleTriggers(1);
    expect(row.failures, 'the count survives the success that follows it').toBe(2);
    expect(row.lastError, 'and the newest message with it').toBe('boom again');
  });

  it('reads a row from before the column as never counted, not as never failed', async () => {
    await markEffectStarted('e2', 0, { ruleName: 'r', eventType: 'x', effectDetail: 'd' });
    await markEffectCompleted('e2', 0);
    const [row] = await getRecentRuleTriggers(1);
    // `0` is what the card must render as "not counted". Nothing is backfilled:
    // a failure that healed before this landed left no trace anywhere.
    expect(row.failures).toBe(0);
    expect(row.lastError).toBeNull();
  });

  it('records which event an emit became, as the call-tree edge', async () => {
    await markEffectStarted('e3', 0, { ruleName: 'r', eventType: 'x', effectDetail: 'EmitEvent judgement:result' });
    await markEffectEmitted('e3', 0, 'child-1');
    await markEffectCompleted('e3', 0);
    const [row] = await getRecentRuleTriggers(1);
    expect(row.emittedEventId).toBe('child-1');
  });
});
