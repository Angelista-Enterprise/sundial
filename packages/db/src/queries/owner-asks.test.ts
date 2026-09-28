import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, resetDb } from '../db-client.js';
import { getOldestUnharvestedOwnerAsk, getRecentOwnerAsks, updateOwnerAsk, upsertOwnerAsk, type UpsertOwnerAskInput } from './owner-asks.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE owner_asks (
    id text PRIMARY KEY NOT NULL,
    question text NOT NULL,
    reason text,
    asked_at text NOT NULL,
    answer text,
    answered_at text,
    outcome text NOT NULL,
    proposals text
  )`);
  // The backfill cursor joins against the verdict the owner gave the QUESTION,
  // which lives in the log rather than in a column.
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

async function verdict(askId: string, word: string) {
  const db = getDb();
  const data = JSON.stringify({ artifactKind: 'owner_ask', artifactId: askId, verdict: word });
  await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at)
    VALUES (${`v-${askId}`}, 'feedback', 'verdict', ${data}, '2026-09-21T09:00:00.000Z')`);
}

function ask(overrides: Partial<UpsertOwnerAskInput> = {}): UpsertOwnerAskInput {
  return {
    id: 'owner-ask:a1',
    question: 'Does the sundial branch belong to gnomon, or is it its own project?',
    reason: null,
    askedAt: '2026-09-03T12:10:00.000Z',
    answer: 'gnomon',
    answeredAt: '2026-09-03T12:18:00.000Z',
    outcome: 'answered',
    ...overrides,
  };
}

const PROPOSAL = { entityKind: 'project', canonicalName: 'sundial', predicate: 'relatesToProject', object: 'gnomon', confidence: 90 };

describe('owner_asks.proposals', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('round-trips a proposal the model read, parsed', async () => {
    await upsertOwnerAsk(ask());
    await updateOwnerAsk('owner-ask:a1', { proposals: [PROPOSAL] });
    expect((await getRecentOwnerAsks())[0]?.proposals).toEqual([PROPOSAL]);
  });

  // The whole reason the column is nullable: "nothing there" is a reading and
  // "not looked at yet" is the absence of one, and the card says different
  // things about them.
  it('tells an empty reading apart from no reading at all', async () => {
    await upsertOwnerAsk(ask());
    expect((await getRecentOwnerAsks())[0]?.proposals).toBeNull();
    await updateOwnerAsk('owner-ask:a1', { proposals: [] });
    expect((await getRecentOwnerAsks())[0]?.proposals).toEqual([]);
  });

  it('a later answer write does not wipe a reading already stored beside it', async () => {
    await upsertOwnerAsk(ask());
    await updateOwnerAsk('owner-ask:a1', { proposals: [PROPOSAL] });
    await upsertOwnerAsk(ask({ answer: 'gnomon, definitely' }));
    expect((await getRecentOwnerAsks())[0]).toMatchObject({ answer: 'gnomon, definitely', proposals: [PROPOSAL] });
  });

  it('the backfill cursor takes the oldest ANSWERED ask nobody has read, and drains to null', async () => {
    await upsertOwnerAsk(ask({ id: 'new', answeredAt: '2026-09-20T09:00:00.000Z' }));
    await upsertOwnerAsk(ask({ id: 'old', answeredAt: '2026-09-04T09:00:00.000Z' }));
    await upsertOwnerAsk(ask({ id: 'expired', answer: null, answeredAt: null, outcome: 'expired' }));

    expect((await getOldestUnharvestedOwnerAsk())?.id).toBe('old');
    await updateOwnerAsk('old', { proposals: [] });
    expect((await getOldestUnharvestedOwnerAsk())?.id).toBe('new');
    await updateOwnerAsk('new', { proposals: [] });
    // The expired one has no answer to read, so the sweep ends rather than
    // spending a call on a question the owner ignored.
    expect(await getOldestUnharvestedOwnerAsk()).toBeNull();
  });
});

describe('the backfill skips a question the owner called wrong', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  // If the question was wrong, its answer is unlikely to hold a fact, and
  // asking a model to find one is spending a call to argue with them. The live
  // case: `owner-ask:who-person-35941f3bc4`, answered "I dont know, we need to
  // handle this in code so you you ask me".
  it('passes over a `wrong` ask and takes the next one', async () => {
    await upsertOwnerAsk(ask({ id: 'bad', answeredAt: '2026-09-09T14:22:00.000Z' }));
    await upsertOwnerAsk(ask({ id: 'good', answeredAt: '2026-09-10T09:22:00.000Z' }));
    await verdict('bad', 'wrong');

    expect((await getOldestUnharvestedOwnerAsk())?.id).toBe('good');
  });

  it('still reads one the owner called useful, or a bad moment', async () => {
    await upsertOwnerAsk(ask({ id: 'a', answeredAt: '2026-09-09T14:22:00.000Z' }));
    await verdict('a', 'not-now');
    expect((await getOldestUnharvestedOwnerAsk())?.id).toBe('a');
  });
});
