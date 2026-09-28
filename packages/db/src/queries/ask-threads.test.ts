import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { upsertAskThread, getRecentAskThreads, getAskThreadById, type UpsertAskThreadInput } from './ask-threads.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE ask_threads (
    id text PRIMARY KEY NOT NULL,
    question text NOT NULL,
    answer text,
    reason text,
    source_count integer DEFAULT 0 NOT NULL,
    sources text,
    asked_at text NOT NULL,
    rounds integer DEFAULT 1 NOT NULL,
    tools_used text,
    figures text,
    remembered integer DEFAULT false NOT NULL,
    remembered_at text,
    remembered_entry_id text,
    source_event_id text
  )`);
  return db;
}

function thread(overrides: Partial<UpsertAskThreadInput> = {}): UpsertAskThreadInput {
  return {
    id: 't1',
    question: 'What did I work on last Tuesday?',
    answer: 'Mostly the kernel package.',
    reason: null,
    sourceCount: 6,
    sources: '[]',
    askedAt: '2026-07-28T14:00:00.000Z',
    rounds: 1,
    toolsUsed: null,
    figures: null,
    remembered: false,
    rememberedAt: null,
    rememberedEntryId: null,
    sourceEventId: 'e1',
    ...overrides,
  };
}

describe('upsertAskThread', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('writes a thread and reads it back', async () => {
    await upsertAskThread(thread());
    expect(await getAskThreadById('t1')).toMatchObject({
      question: 'What did I work on last Tuesday?',
      answer: 'Mostly the kernel package.',
      sourceCount: 6,
      remembered: false,
    });
  });

  it('a remember updates the remember columns in place, not a second row', async () => {
    await upsertAskThread(thread());
    await upsertAskThread(
      thread({ remembered: true, rememberedAt: '2026-07-28T14:05:00.000Z', rememberedEntryId: 'k1', sourceEventId: 'e2' }),
    );

    const rows = await getRecentAskThreads();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ remembered: true, rememberedAt: '2026-07-28T14:05:00.000Z', rememberedEntryId: 'k1' });
  });

  it('a second write CANNOT rewrite the question or the answer — they are what was actually asked and answered', async () => {
    await upsertAskThread(thread());
    await upsertAskThread(thread({ question: 'something else entirely', answer: 'a different answer', remembered: true }));

    expect(await getAskThreadById('t1')).toMatchObject({
      question: 'What did I work on last Tuesday?',
      answer: 'Mostly the kernel package.',
      remembered: true,
    });
  });

  it('keeps a thread the record could not answer', async () => {
    await upsertAskThread(thread({ id: 't2', answer: null, reason: 'no memory to answer from yet', sourceCount: 0, sources: null }));
    expect(await getAskThreadById('t2')).toMatchObject({ answer: null, reason: 'no memory to answer from yet', sourceCount: 0 });
  });

  it('lists most recent first and bounds the read', async () => {
    for (const [id, askedAt] of [
      ['a', '2026-07-26T09:00:00.000Z'],
      ['b', '2026-07-27T09:00:00.000Z'],
      ['c', '2026-07-28T09:00:00.000Z'],
    ]) {
      await upsertAskThread(thread({ id: id!, askedAt: askedAt! }));
    }
    expect((await getRecentAskThreads()).map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect((await getRecentAskThreads(2)).map((r) => r.id)).toEqual(['c', 'b']);
  });

  it('returns null for a thread that was never written', async () => {
    expect(await getAskThreadById('nope')).toBeNull();
  });
});
