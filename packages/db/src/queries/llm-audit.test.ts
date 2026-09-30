import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { LLM_ERROR_CLASSES, type LlmErrorClass } from '@sundial/helpers/llm-error-class.js';
import { llmAudit } from '../schemas/db-schema.js';
import {
  recordLlmAudit,
  updateLlmAudit,
  getRecentLlmAudit,
  getLlmAuditOverview,
  getLlmAuditDaily,
  getLlmAuditByModel,
  getLlmLedgerRows,
  getLostAnswers,
  getMomentCost,
  estimateCostUsd,
  llmProvider,
} from './llm-audit.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE llm_audit (
    id text PRIMARY KEY NOT NULL,
    moment_id text,
    purpose text NOT NULL,
    model text NOT NULL,
    prompt text NOT NULL,
    requested_at text NOT NULL,
    responded_at text,
    latency_ms integer,
    status_code integer,
    success integer DEFAULT false NOT NULL,
    response_content text,
    prompt_tokens integer,
    completion_tokens integer,
    total_tokens integer,
    error text,
    error_class text,
    billed_prompt_tokens integer,
    cache_read_tokens integer,
    attempt integer DEFAULT 1 NOT NULL,
    parent_call_id text
  )`);
  // `getLostAnswers` resolves each row's `momentId` against the moments it can
  // actually find, so the table has to exist even when no test stores one.
  await db.run(sql`CREATE TABLE moments (
    id text PRIMARY KEY NOT NULL,
    start_time text NOT NULL,
    end_time text,
    duration_ms integer,
    process_name text,
    data text,
    importance_score integer,
    project_id text
  )`);
  return db;
}

describe('recordLlmAudit / updateLlmAudit', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('records a placeholder row before the call, with success:false', async () => {
    await recordLlmAudit({ id: 'a1', momentId: 'm1', purpose: 'intent', model: 'test-model', prompt: 'hello', requestedAt: '2026-01-01T00:00:00.000Z' });

    const db = getDb();
    const [row] = await db.select().from(llmAudit).where(eq(llmAudit.id, 'a1'));
    expect(row.success).toBe(false);
    expect(row.respondedAt).toBeNull();
  });

  it('patches the row on success with response fields', async () => {
    await recordLlmAudit({ id: 'a1', momentId: 'm1', purpose: 'intent', model: 'test-model', prompt: 'hello', requestedAt: '2026-01-01T00:00:00.000Z' });
    await updateLlmAudit('a1', { respondedAt: '2026-01-01T00:00:01.000Z', latencyMs: 1000, statusCode: 200, success: true, responseContent: 'hi there', promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    const db = getDb();
    const [row] = await db.select().from(llmAudit).where(eq(llmAudit.id, 'a1'));
    expect(row.success).toBe(true);
    expect(row.responseContent).toBe('hi there');
    expect(row.totalTokens).toBe(15);
  });

  it('patches the row on failure with an error string, no response fields', async () => {
    await recordLlmAudit({ id: 'a1', momentId: null, purpose: 'narrate', model: 'test-model', prompt: 'hello', requestedAt: '2026-01-01T00:00:00.000Z' });
    await updateLlmAudit('a1', { respondedAt: '2026-01-01T00:00:01.000Z', latencyMs: 500, success: false, error: 'endpoint unreachable' });

    const db = getDb();
    const [row] = await db.select().from(llmAudit).where(eq(llmAudit.id, 'a1'));
    expect(row.success).toBe(false);
    expect(row.error).toBe('endpoint unreachable');
    expect(row.responseContent).toBeNull();
  });
});

describe('getRecentLlmAudit', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('lists calls most-recent-first, without prompt/responseContent bodies', async () => {
    await recordLlmAudit({ id: 'a1', momentId: 'm1', purpose: 'intent', model: 'test-model', prompt: 'first prompt', requestedAt: '2026-01-01T00:00:00.000Z' });
    await updateLlmAudit('a1', { respondedAt: '2026-01-01T00:00:01.000Z', latencyMs: 500, success: true, responseContent: 'first response' });
    await recordLlmAudit({ id: 'a2', momentId: 'm1', purpose: 'knowledge', model: 'test-model', prompt: 'second prompt', requestedAt: '2026-01-02T00:00:00.000Z' });
    await updateLlmAudit('a2', { respondedAt: '2026-01-02T00:00:01.000Z', latencyMs: 800, success: true, responseContent: 'second response' });

    const recent = await getRecentLlmAudit(10);

    expect(recent.map((row) => row.id)).toEqual(['a2', 'a1']);
    expect(recent[0]).not.toHaveProperty('prompt');
    expect(recent[0]).not.toHaveProperty('responseContent');
  });

  it('respects the limit', async () => {
    await recordLlmAudit({ id: 'a1', momentId: null, purpose: 'intent', model: 'test-model', prompt: 'p1', requestedAt: '2026-01-01T00:00:00.000Z' });
    await recordLlmAudit({ id: 'a2', momentId: null, purpose: 'intent', model: 'test-model', prompt: 'p2', requestedAt: '2026-01-02T00:00:00.000Z' });

    expect(await getRecentLlmAudit(1)).toHaveLength(1);
  });

  it('offset pages past the most recent results (pagination)', async () => {
    await recordLlmAudit({ id: 'a1', momentId: null, purpose: 'intent', model: 'test-model', prompt: 'p1', requestedAt: '2026-01-01T00:00:00.000Z' });
    await recordLlmAudit({ id: 'a2', momentId: null, purpose: 'intent', model: 'test-model', prompt: 'p2', requestedAt: '2026-01-02T00:00:00.000Z' });
    await recordLlmAudit({ id: 'a3', momentId: null, purpose: 'intent', model: 'test-model', prompt: 'p3', requestedAt: '2026-01-03T00:00:00.000Z' });

    const firstPage = await getRecentLlmAudit(2, 0);
    const secondPage = await getRecentLlmAudit(2, 2);

    expect(firstPage.map((r) => r.id)).toEqual(['a3', 'a2']);
    expect(secondPage.map((r) => r.id)).toEqual(['a1']);
  });
});

describe('getLlmAuditOverview', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('returns an empty-but-well-formed overview when there are no calls', async () => {
    const overview = await getLlmAuditOverview();
    expect(overview.summary).toEqual({
      calls: 0,
      failedCount: 0,
      successRate: 1,
      avgLatencyMs: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCostUsd: 0,
      remoteCalls: 0,
      localCalls: 0,
      remoteTokens: 0,
      localTokens: 0,
      billedOnFailureTokens: 0,
      billedOnFailureUsd: 0,
      retrySpendUsd: 0,
      failedMs: 0,
      lastFailureAt: null,
      unredactedErrorCount: 0,
    });
    expect(overview.unpricedRemoteModels).toEqual([]);
    expect(overview.byPurpose).toEqual([]);
    expect(overview.latencyHistogram.map((b) => b.count)).toEqual([0, 0, 0, 0, 0]);
    expect(overview.failureReasons).toEqual([]);
  });

  it('aggregates summary, per-purpose stats, and the latency histogram', async () => {
    // intent: 50ms ok (10 tok), knowledge: 800ms ok (20 tok), knowledge: fail w/ 400ms latency, reflect: timeout (no latency)
    await recordLlmAudit({ id: 'a1', momentId: null, purpose: 'intent', model: 'm', prompt: 'p', requestedAt: '2026-01-01T00:00:00.000Z' });
    await updateLlmAudit('a1', { respondedAt: '2026-01-01T00:00:00.050Z', latencyMs: 50, success: true, totalTokens: 10 });
    await recordLlmAudit({ id: 'a2', momentId: null, purpose: 'knowledge', model: 'm', prompt: 'p', requestedAt: '2026-01-02T00:00:00.000Z' });
    await updateLlmAudit('a2', { respondedAt: '2026-01-02T00:00:00.800Z', latencyMs: 800, success: true, totalTokens: 20 });
    await recordLlmAudit({ id: 'a3', momentId: null, purpose: 'knowledge', model: 'm', prompt: 'p', requestedAt: '2026-01-03T00:00:00.000Z' });
    await updateLlmAudit('a3', { respondedAt: '2026-01-03T00:00:00.400Z', latencyMs: 400, success: false, error: 'x' });
    await recordLlmAudit({ id: 'a4', momentId: null, purpose: 'reflect', model: 'm', prompt: 'p', requestedAt: '2026-01-04T00:00:00.000Z' });

    const overview = await getLlmAuditOverview();

    expect(overview.summary.calls).toBe(4);
    // a3 failed explicitly; a4 never responded (placeholder row stays success:false) — both count as failed.
    expect(overview.summary.failedCount).toBe(2);
    expect(overview.summary.successRate).toBeCloseTo(0.5);
    expect(overview.summary.totalTokens).toBe(30);
    expect(overview.summary.avgLatencyMs).toBe(417); // (50+800+400)/3 rounded, timeout (null) excluded
    // histogram: 50ms → <100ms, 400ms → 100–500ms, 800ms → 0.5–2s
    expect(overview.latencyHistogram.map((b) => b.count)).toEqual([1, 1, 1, 0, 0]);
    const knowledge = overview.byPurpose.find((p) => p.purpose === 'knowledge');
    expect(knowledge).toMatchObject({ calls: 2, failedCount: 1, totalTokens: 20, avgLatencyMs: 600 });
    // byPurpose sorted by call count desc → knowledge (2) first
    expect(overview.byPurpose[0].purpose).toBe('knowledge');
  });

  it('scopes to sinceIso when provided', async () => {
    await recordLlmAudit({ id: 'old', momentId: null, purpose: 'intent', model: 'm', prompt: 'p', requestedAt: '2026-01-01T00:00:00.000Z' });
    await updateLlmAudit('old', { respondedAt: '2026-01-01T00:00:00.100Z', latencyMs: 100, success: true, totalTokens: 5 });
    await recordLlmAudit({ id: 'new', momentId: null, purpose: 'intent', model: 'm', prompt: 'p', requestedAt: '2026-02-01T00:00:00.000Z' });
    await updateLlmAudit('new', { respondedAt: '2026-02-01T00:00:00.100Z', latencyMs: 100, success: true, totalTokens: 7 });

    const overview = await getLlmAuditOverview('2026-01-15T00:00:00.000Z');
    expect(overview.summary.calls).toBe(1);
    expect(overview.summary.totalTokens).toBe(7);
  });

  it('groups failures by error class, most common first, and the classes sum to failedCount', async () => {
    const fail = async (id: string, error: string, errorClass?: LlmErrorClass) => {
      await recordLlmAudit({ id, momentId: null, purpose: 'intent', model: 'm', prompt: 'p', requestedAt: '2026-01-01T00:00:00.000Z' });
      await updateLlmAudit(id, { respondedAt: '2026-01-01T00:00:00.100Z', latencyMs: 100, success: false, error, errorClass });
    };
    await fail('f1', 'LLM endpoint returned 401: {"message":"No api key passed in."}', 'http-4xx');
    await fail('f2', 'LLM endpoint returned 401: {"message":"Authentication Error"}', 'http-4xx');
    await fail('f3', 'This operation was aborted', 'timeout');
    // A row from before the column existed — and the shape that used to report
    // an endpoint URL as its own reason.
    await fail('f4', 'https://api.tensorx.ai/v1/chat/completions?key=secret');

    const overview = await getLlmAuditOverview();
    expect(overview.failureReasons[0]).toEqual({ reason: 'http-4xx', count: 2 });
    expect(overview.failureReasons.find((r) => r.reason === 'timeout')?.count).toBe(1);
    expect(overview.failureReasons.map((r) => r.reason)).toEqual(expect.arrayContaining(['network']));
    expect(overview.failureReasons.every((r) => LLM_ERROR_CLASSES.includes(r.reason as LlmErrorClass))).toBe(true);
    expect(overview.failureReasons.reduce((sum, r) => sum + r.count, 0)).toBe(overview.summary.failedCount);
  });

  it('estimates cost from prompt/completion tokens by model, and splits token totals', async () => {
    await recordLlmAudit({ id: 'c1', momentId: null, purpose: 'journal', model: 'deepseek/deepseek-v4-flash', prompt: 'p', requestedAt: '2026-01-01T00:00:00.000Z' });
    // 1,000,000 prompt @ $0.27/1M + 1,000,000 completion @ $1.10/1M = $1.37
    await updateLlmAudit('c1', { respondedAt: '2026-01-01T00:00:01.000Z', latencyMs: 1000, success: true, promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 });

    const overview = await getLlmAuditOverview();
    expect(overview.summary.promptTokens).toBe(1_000_000);
    expect(overview.summary.completionTokens).toBe(1_000_000);
    expect(overview.summary.estimatedCostUsd).toBeCloseTo(1.37, 2);
    expect(overview.byPurpose[0].estimatedCostUsd).toBeCloseTo(1.37, 2);
  });

  it('prices the pinned deepseek snapshot at its own rate, not the generic deepseek fallback', async () => {
    await recordLlmAudit({ id: 's1', momentId: null, purpose: 'journal', model: 'deepseek/deepseek-v4-flash-0731', prompt: 'p', requestedAt: '2026-01-01T00:00:00.000Z' });
    // 1,000,000 prompt @ $0.25/1M + 1,000,000 completion @ $0.30/1M = $0.55
    await updateLlmAudit('s1', { respondedAt: '2026-01-01T00:00:01.000Z', latencyMs: 1000, success: true, promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 });

    const overview = await getLlmAuditOverview();
    expect(overview.summary.estimatedCostUsd).toBeCloseTo(0.55, 2);
  });

  it('estimates zero cost for an unknown/self-hosted model', async () => {
    await recordLlmAudit({ id: 'u1', momentId: null, purpose: 'intent', model: 'my-local-model', prompt: 'p', requestedAt: '2026-01-01T00:00:00.000Z' });
    await updateLlmAudit('u1', { respondedAt: '2026-01-01T00:00:01.000Z', latencyMs: 100, success: true, promptTokens: 500, completionTokens: 500, totalTokens: 1000 });
    const overview = await getLlmAuditOverview();
    expect(overview.summary.estimatedCostUsd).toBe(0);
  });
});

describe('getLlmAuditDaily', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  const call = async (id: string, requestedAt: string, totalTokens: number, model = 'm') => {
    await recordLlmAudit({ id, momentId: null, purpose: 'intent', model, prompt: 'p', requestedAt });
    await updateLlmAudit(id, { respondedAt: requestedAt, latencyMs: 100, success: true, promptTokens: Math.floor(totalTokens / 2), completionTokens: Math.ceil(totalTokens / 2), totalTokens });
  };

  it('returns an empty array when there are no calls', async () => {
    expect(await getLlmAuditDaily('UTC')).toEqual([]);
  });

  it('buckets calls by the owner-local calendar day, not the UTC day', async () => {
    // Amsterdam is UTC+2 in August: 23:30Z on the 15th is already 01:30 on the 16th local.
    await call('late', '2026-08-15T23:30:00.000Z', 100);
    await call('evening', '2026-08-15T21:00:00.000Z', 50);

    const days = await getLlmAuditDaily('Europe/Amsterdam');

    expect(days.map((d) => d.date)).toEqual(['2026-08-15', '2026-08-16']);
    expect(days[0].totalTokens).toBe(50); // 21:00Z → 23:00 local, still the 15th
    expect(days[1].totalTokens).toBe(100); // 23:30Z → 01:30 local, rolled to the 16th
  });

  it('sums tokens and calls within a day and returns days ascending', async () => {
    await call('b', '2026-01-02T10:00:00.000Z', 30);
    await call('a', '2026-01-01T10:00:00.000Z', 10);
    await call('c', '2026-01-01T12:00:00.000Z', 20);

    const days = await getLlmAuditDaily('UTC');

    expect(days.map((d) => d.date)).toEqual(['2026-01-01', '2026-01-02']);
    expect(days[0]).toMatchObject({ calls: 2, totalTokens: 30, promptTokens: 15, completionTokens: 15 });
    expect(days[1]).toMatchObject({ calls: 1, totalTokens: 30 });
  });

  it('prices a day as the summary does, cache reads included', async () => {
    // The Ledger's header said $0.38 and its day line $0.82 for the same calls:
    // the day line ignored the cache discount.
    await recordLlmAudit({ id: 'c1', momentId: null, purpose: 'ask', model: 'qwen/qwen3.8-flash-next', prompt: 'p', requestedAt: '2026-01-01T10:00:00.000Z' });
    await updateLlmAudit('c1', { respondedAt: '2026-01-01T10:00:01.000Z', latencyMs: 100, success: true, promptTokens: 1_000_000, completionTokens: 10_000, totalTokens: 1_010_000, cacheReadTokens: 900_000 });
    const [day] = await getLlmAuditDaily('UTC');
    const overview = await getLlmAuditOverview();
    const [model] = await getLlmAuditByModel();
    expect(day.estimatedCostUsd).toBeCloseTo(overview.summary.estimatedCostUsd, 9);
    expect(model.estimatedCostUsd).toBeCloseTo(overview.summary.estimatedCostUsd, 9);
  });

  it('counts failed calls per day', async () => {
    await recordLlmAudit({ id: 'f', momentId: null, purpose: 'intent', model: 'm', prompt: 'p', requestedAt: '2026-01-01T10:00:00.000Z' });
    await updateLlmAudit('f', { respondedAt: '2026-01-01T10:00:01.000Z', latencyMs: 100, success: false, error: 'boom' });
    await call('ok', '2026-01-01T11:00:00.000Z', 10);

    const [day] = await getLlmAuditDaily('UTC');
    expect(day.calls).toBe(2);
    expect(day.failedCount).toBe(1);
  });

  it('omits days with no calls rather than emitting zero rows', async () => {
    await call('a', '2026-01-01T10:00:00.000Z', 10);
    await call('b', '2026-01-03T10:00:00.000Z', 10);

    const days = await getLlmAuditDaily('UTC');
    expect(days.map((d) => d.date)).toEqual(['2026-01-01', '2026-01-03']);
  });

  it('scopes to sinceIso when provided', async () => {
    await call('old', '2026-01-01T10:00:00.000Z', 10);
    await call('new', '2026-02-01T10:00:00.000Z', 20);

    const days = await getLlmAuditDaily('UTC', '2026-01-15T00:00:00.000Z');
    expect(days.map((d) => d.date)).toEqual(['2026-02-01']);
    expect(days[0].totalTokens).toBe(20);
  });
});

describe('a credential in a stored error string', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('never survives the write path', async () => {
    await recordLlmAudit({ id: 'a1', momentId: null, purpose: 'ask', model: 'm', prompt: 'p', requestedAt: '2026-01-10T10:00:00.000Z' });
    await updateLlmAudit('a1', {
      respondedAt: '2026-01-10T10:00:01.000Z',
      latencyMs: 100,
      success: false,
      error: 'POST https://api.tensorx.ai/v1/chat/completions?api_key=sk-live-123 failed',
      errorClass: 'network',
    });

    const db = getDb();
    const [row] = await db.select().from(llmAudit).where(eq(llmAudit.id, 'a1'));
    expect(row.error).toBe('POST https://api.tensorx.ai/v1/chat/completions failed');
    expect(row.error).not.toContain('sk-live-123');
  });

  /**
   * The detector, against a row written BEHIND the guard — which is the only
   * way one can appear now, and exactly the case that would otherwise sit
   * unnoticed forever since the class replaced the message on every readout.
   */
  it('is counted when something bypasses the write path', async () => {
    const db = getDb();
    await recordLlmAudit({ id: 'a1', momentId: null, purpose: 'ask', model: 'm', prompt: 'p', requestedAt: '2026-01-10T10:00:00.000Z' });
    await db.run(sql`UPDATE llm_audit SET error = 'https://api.example.com/v1?access_token=leaked' WHERE id = 'a1'`);

    expect((await getLlmAuditOverview()).summary.unredactedErrorCount).toBe(1);
  });

  it('counts zero for an endpoint that carries no credential', async () => {
    await recordLlmAudit({ id: 'a1', momentId: null, purpose: 'ask', model: 'm', prompt: 'p', requestedAt: '2026-01-10T10:00:00.000Z' });
    await updateLlmAudit('a1', { respondedAt: '2026-01-10T10:00:01.000Z', latencyMs: 100, success: false, error: 'TensorX API request to https://api.tensorx.ai/v1 failed' });

    const overview = await getLlmAuditOverview();
    expect(overview.summary.unredactedErrorCount).toBe(0);
    // The URL stays: which endpoint failed is the diagnostic, and there is no
    // secret in it.
    expect((await getLostAnswers())[0].message).toContain('https://api.tensorx.ai/v1');
  });
});

describe('getMomentCost', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('adds up what one moment cost, failures included', async () => {
    // A failed call still uploaded its prompt. Leaving that out would make the
    // flattering number the one on the card. The model ids carry a provider
    // prefix because that is what marks a call as REMOTE and therefore priced —
    // a bare `gpt-4o` is read as a local model and costs nothing.
    await recordLlmAudit({ id: 'a', purpose: 'intent', model: 'openai/gpt-4o', prompt: 'p', requestedAt: '2026-09-17T09:00:00.000Z', momentId: 'm1' });
    await updateLlmAudit('a', { success: true, respondedAt: '2026-09-17T09:00:02.000Z', latencyMs: 2000, promptTokens: 1000, completionTokens: 200, totalTokens: 1200 });
    await recordLlmAudit({ id: 'b', purpose: 'ask', model: 'openai/gpt-4o', prompt: 'p', requestedAt: '2026-09-17T09:01:00.000Z', momentId: 'm1' });
    await updateLlmAudit('b', { success: false, respondedAt: '2026-09-17T09:01:09.000Z', latencyMs: 9000, error: 'timeout', errorClass: 'timeout', billedPromptTokens: 500 });
    await recordLlmAudit({ id: 'c', purpose: 'intent', model: 'openai/gpt-4o', prompt: 'p', requestedAt: '2026-09-17T09:02:00.000Z', momentId: 'other' });
    await updateLlmAudit('c', { success: true, respondedAt: '2026-09-17T09:02:01.000Z', latencyMs: 1000, promptTokens: 9999, completionTokens: 9999, totalTokens: 19998 });

    const got = await getMomentCost('m1');
    expect(got.calls).toBe(2);
    expect(got.failed).toBe(1);
    expect(got.purposes).toEqual(['ask', 'intent']);
    expect(got.costUsd).toBeGreaterThan(0);
    // The other moment's spend is the other moment's.
    expect(got.costUsd).toBeLessThan((await getMomentCost('other')).costUsd);
  });

  it('says zero for a moment nothing was ever spent on', async () => {
    expect(await getMomentCost('never')).toEqual({ calls: 0, failed: 0, costUsd: 0, purposes: [] });
  });
});

describe('getLostAnswers', () => {

  it('says whether the moment a lost call names was ever kept', async () => {
    // A moment's id is minted when it OPENS and a moment under twenty seconds is
    // dropped without a row, so a valid pointer can name a moment that will
    // never exist. The audit read one of these as a broken lookup.
    const db = getDb();
    await db.run(sql`INSERT INTO moments (id, start_time) VALUES ('kept', '2026-09-17T09:00:00.000Z')`);
    await recordLlmAudit({ id: 'a', purpose: 'ask', model: 'm', prompt: 'p', requestedAt: '2026-09-17T09:01:00.000Z', momentId: 'kept' });
    await updateLlmAudit('a', { success: false, error: 'boom', errorClass: 'network', respondedAt: '2026-09-17T09:01:05.000Z', latencyMs: 5000 });
    await recordLlmAudit({ id: 'b', purpose: 'ask', model: 'm', prompt: 'p', requestedAt: '2026-09-17T09:02:00.000Z', momentId: 'never-written' });
    await updateLlmAudit('b', { success: false, error: 'boom', errorClass: 'network', respondedAt: '2026-09-17T09:02:05.000Z', latencyMs: 5000 });
    await recordLlmAudit({ id: 'c', purpose: 'ask', model: 'm', prompt: 'p', requestedAt: '2026-09-17T09:03:00.000Z', momentId: null });
    await updateLlmAudit('c', { success: false, error: 'boom', errorClass: 'network', respondedAt: '2026-09-17T09:03:05.000Z', latencyMs: 5000 });

    const byId = new Map((await getLostAnswers()).map((row) => [row.id, row.momentState]));
    expect(byId.get('a')).toBe('stored');
    expect(byId.get('b')).toBe('absent');
    expect(byId.get('c')).toBe('none');
  });
  beforeEach(async () => {
    await setupTestDb();
  });

  const fail = async (id: string, at: string, purpose: string, momentId: string | null, extra: { attempt?: number; parentCallId?: string } = {}) => {
    await recordLlmAudit({ id, momentId, purpose, model: 'm', prompt: 'p', requestedAt: at, ...extra });
    await updateLlmAudit(id, { respondedAt: at, latencyMs: 100, success: false, error: 'boom', errorClass: 'network' });
  };
  const win = async (id: string, at: string, purpose: string, momentId: string | null, extra: { attempt?: number; parentCallId?: string } = {}) => {
    await recordLlmAudit({ id, momentId, purpose, model: 'm', prompt: 'p', requestedAt: at, ...extra });
    await updateLlmAudit(id, { respondedAt: at, latencyMs: 100, success: true, totalTokens: 10 });
  };

  it('marks a failure answered by the retry that replaced it', async () => {
    await fail('f1', '2026-01-10T10:00:00.000Z', 'narrate', 'm1');
    await win('r1', '2026-01-10T10:00:02.000Z', 'narrate', 'm1', { attempt: 2, parentCallId: 'f1' });

    const [lost] = await getLostAnswers();
    expect(lost.id).toBe('f1');
    expect(lost.answeredBy).toBe('r1');
  });

  it('follows the chain back through every attempt', async () => {
    await fail('f1', '2026-01-10T10:00:00.000Z', 'narrate', 'm1');
    await fail('f2', '2026-01-10T10:00:01.000Z', 'narrate', 'm1', { attempt: 2, parentCallId: 'f1' });
    await win('r1', '2026-01-10T10:00:03.000Z', 'narrate', 'm1', { attempt: 3, parentCallId: 'f2' });

    const answers = new Map((await getLostAnswers()).map((row) => [row.id, row.answeredBy]));
    expect(answers.get('f1')).toBe('r1');
    expect(answers.get('f2')).toBe('r1');
  });

  it('leaves a failure with nothing after it unanswered', async () => {
    await fail('f1', '2026-01-10T10:00:00.000Z', 'journal', null);
    // Same purpose, but hours later and about a different moment — not this question.
    await win('w1', '2026-01-10T18:00:00.000Z', 'journal', 'm9');

    const [lost] = await getLostAnswers();
    expect(lost.answeredBy).toBeNull();
    expect(lost.errorClass).toBe('network');
  });

  it('accepts a nearby success on the same purpose and moment, for rows with no lineage', async () => {
    await fail('f1', '2026-01-10T10:00:00.000Z', 'narrate', 'm1');
    await win('w1', '2026-01-10T10:05:00.000Z', 'narrate', 'm1');
    expect((await getLostAnswers())[0].answeredBy).toBe('w1');
  });
});

describe('getLlmLedgerRows', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  const ok = async (id: string, at: string, purpose: string, promptTokens: number) => {
    await recordLlmAudit({ id, momentId: null, purpose, model: 'deepseek/deepseek-v4-flash-0731', prompt: 'p', requestedAt: at });
    await updateLlmAudit(id, { respondedAt: at, latencyMs: 100, success: true, promptTokens, completionTokens: 0, totalTokens: promptTokens });
  };
  const dead = async (id: string, at: string, purpose: string, errorClass: LlmErrorClass, billedPromptTokens: number) => {
    await recordLlmAudit({ id, momentId: null, purpose, model: 'deepseek/deepseek-v4-flash-0731', prompt: 'p', requestedAt: at });
    await updateLlmAudit(id, { respondedAt: at, latencyMs: 9000, success: false, error: 'boom', errorClass, billedPromptTokens });
  };

  it('groups by owner-local day, newest first, and honours the window', async () => {
    await ok('a', '2026-01-01T10:00:00.000Z', 'ask', 1_000_000);
    await ok('b', '2026-01-10T10:00:00.000Z', 'ask', 2_000_000);
    await ok('c', '2026-01-11T10:00:00.000Z', 'journal', 1_000_000);

    const rows = await getLlmLedgerRows('day', 'UTC', '2026-01-05T00:00:00.000Z');
    expect(rows.map((r) => r.key)).toEqual(['2026-01-11', '2026-01-10']);
    // 2,000,000 prompt tokens @ $0.25/1M = $0.50
    expect(rows[1].costUsd).toBeCloseTo(0.5, 4);
  });

  it('counts what a failure cost: the upload, the wall clock, and the price of both', async () => {
    await dead('f1', '2026-01-10T10:00:00.000Z', 'ask', 'timeout', 1_000_000);
    const [row] = await getLlmLedgerRows('day', 'UTC');
    expect(row.failed).toBe(1);
    expect(row.billedOnFailureTokens).toBe(1_000_000);
    expect(row.failedMs).toBe(9000);
    expect(row.costUsd).toBeCloseTo(0.25, 4);
  });

  it('buckets only the failures on the errorClass axis', async () => {
    await ok('a', '2026-01-10T10:00:00.000Z', 'ask', 10);
    await dead('f1', '2026-01-10T11:00:00.000Z', 'ask', 'network', 5);
    await dead('f2', '2026-01-10T12:00:00.000Z', 'journal', 'network', 5);
    await dead('f3', '2026-01-10T13:00:00.000Z', 'ask', 'timeout', 5);

    const rows = await getLlmLedgerRows('errorClass', 'UTC');
    expect(rows.map((r) => [r.key, r.calls])).toEqual([
      ['network', 2],
      ['timeout', 1],
    ]);
  });

  it('groups by purpose and by model', async () => {
    await ok('a', '2026-01-10T10:00:00.000Z', 'ask', 10);
    await ok('b', '2026-01-10T11:00:00.000Z', 'ask', 10);
    await ok('c', '2026-01-10T12:00:00.000Z', 'journal', 10);

    expect((await getLlmLedgerRows('purpose', 'UTC')).map((r) => [r.key, r.calls])).toEqual([
      ['ask', 2],
      ['journal', 1],
    ]);
    expect((await getLlmLedgerRows('model', 'UTC')).map((r) => r.key)).toEqual(['deepseek/deepseek-v4-flash-0731']);
  });

  it('prices the cached half of a prompt at the cached rate, and carries the split on the row', async () => {
    // The live shape: 1,000,000 prompt tokens of which 900,000 were served from
    // the provider's prefix cache. Fresh 100,000 @ $0.25/1M = $0.025; cached
    // 900,000 @ $0.06/1M = $0.054. Total $0.079 — against the $0.25 the ledger
    // reported while every prompt token was priced as fresh.
    await recordLlmAudit({ id: 'c1', momentId: null, purpose: 'ask', model: 'deepseek/deepseek-v4-flash-0731', prompt: 'p', requestedAt: '2026-01-10T10:00:00.000Z' });
    await updateLlmAudit('c1', {
      respondedAt: '2026-01-10T10:00:00.000Z',
      latencyMs: 100,
      success: true,
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
      cacheReadTokens: 900_000,
    });

    const [row] = await getLlmLedgerRows('day', 'UTC');
    expect(row.cacheReadTokens).toBe(900_000);
    expect(row.costUsd).toBeCloseTo(0.079, 4);
  });

  it('prices a row from before the column as fully fresh, so a historical number does not change shape', async () => {
    // `cache_read_tokens` is NULL on every row written before 2026-09-18. The
    // honest reading of a NULL is "nothing is known to have been cached", which
    // is the old, high estimate — not a retrospective discount.
    await ok('old', '2026-01-10T10:00:00.000Z', 'ask', 1_000_000);
    const [row] = await getLlmLedgerRows('day', 'UTC');
    expect(row.cacheReadTokens).toBe(0);
    expect(row.costUsd).toBeCloseTo(0.25, 4);
  });

  it('never turns an over-reported cache read into a discount', async () => {
    // A provider that claims more cached tokens than it billed input for must
    // clamp to the input, not produce a negative fresh count and a refund.
    await recordLlmAudit({ id: 'odd', momentId: null, purpose: 'ask', model: 'deepseek/deepseek-v4-flash-0731', prompt: 'p', requestedAt: '2026-01-10T10:00:00.000Z' });
    await updateLlmAudit('odd', {
      respondedAt: '2026-01-10T10:00:00.000Z',
      latencyMs: 100,
      success: true,
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
      cacheReadTokens: 5_000_000,
    });
    const [row] = await getLlmLedgerRows('day', 'UTC');
    // Everything cached, nothing fresh: 1,000,000 @ $0.06/1M.
    expect(row.costUsd).toBeCloseTo(0.06, 4);
    expect(row.costUsd).toBeGreaterThan(0);
  });
});

describe('estimateCostUsd — Jev', () => {
  it('typesafe/jev-latest is remote and priced at $0.042 per M input, output free', () => {
    expect(llmProvider('typesafe/jev-latest')).toBe('remote');
    expect(estimateCostUsd('typesafe/jev-latest', 1_000_000, 500_000)).toBeCloseTo(0.042, 6);
    // The bare id the API itself reports would read as a free local tag.
    expect(llmProvider('jev-latest')).toBe('local');
  });
});

describe('estimateCostUsd — the cached half', () => {
  it('splits the prompt into a fresh part and a cached part', () => {
    // qwen3.8-flash-next: $0.20/1M input, $0.05/1M cache read, $0.50/1M output.
    // 200,000 fresh @ $0.20 = $0.04; 800,000 cached @ $0.05 = $0.04.
    expect(estimateCostUsd('qwen/qwen3.8-flash-next', 1_000_000, 0, 800_000)).toBeCloseTo(0.08, 5);
  });

  it('matches the old behaviour exactly when no cache read is passed', () => {
    // Every caller that has not been taught about the column must keep pricing
    // the way it always did — the argument defaults to 0, not to a guess.
    expect(estimateCostUsd('qwen/qwen3.8-flash-next', 1_000_000, 0)).toBeCloseTo(0.2, 5);
    expect(estimateCostUsd('qwen/qwen3.8-flash-next', 1_000_000, 0, 0)).toBeCloseTo(0.2, 5);
  });

  it('prices a model with no cache tier at the full input rate, rather than silently cheap', () => {
    // `kimi-k3` has no `cacheReadPer1M`. An unknown tier must read HIGH: a
    // model quietly priced at a twentieth would hide real spend.
    expect(estimateCostUsd('moonshot/kimi-k3', 1_000_000, 0, 900_000)).toBeCloseTo(3, 5);
  });

  it('is still free for a local model whatever the cache says', () => {
    expect(estimateCostUsd('ollama/nomic-embed-text', 1_000_000, 1_000_000, 900_000)).toBe(0);
  });

  it('shows the size of the error it corrects', () => {
    // The measured live ratio: 85.5% of chat input served from cache, on the
    // model the harness actually runs. qwen3.8-flash-next's cache tier is a
    // quarter of its input tier ($0.05 against $0.20), so pricing the whole
    // prompt as fresh overstates the INPUT side by 2.79x. Pinned as an exact
    // figure rather than a bound: if a rate in `LLM_PRICING` moves, this should
    // fail and be re-read, not quietly keep passing.
    const prompt = 1_000_000;
    const cached = 855_000;
    const truthful = estimateCostUsd('qwen/qwen3.8-flash-next', prompt, 0, cached);
    const asBefore = estimateCostUsd('qwen/qwen3.8-flash-next', prompt, 0, 0);
    expect(asBefore / truthful).toBeCloseTo(2.79, 2);
  });
});

describe('getLlmAuditByModel', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  const call = async (id: string, model: string, totalTokens: number, requestedAt = '2026-01-01T10:00:00.000Z') => {
    await recordLlmAudit({ id, momentId: null, purpose: 'intent', model, prompt: 'p', requestedAt });
    await updateLlmAudit(id, { respondedAt: requestedAt, latencyMs: 100, success: true, promptTokens: Math.floor(totalTokens / 2), completionTokens: Math.ceil(totalTokens / 2), totalTokens });
  };

  it('returns an empty array when there are no calls', async () => {
    expect(await getLlmAuditByModel()).toEqual([]);
  });

  it('aggregates per model and sorts by token volume, biggest first', async () => {
    await call('s', 'small-model', 10);
    await call('b', 'big-model', 100);
    await call('b2', 'big-model', 50);

    const models = await getLlmAuditByModel();

    expect(models.map((m) => m.model)).toEqual(['big-model', 'small-model']);
    expect(models[0]).toMatchObject({ calls: 2, totalTokens: 150 });
    expect(models[1]).toMatchObject({ calls: 1, totalTokens: 10 });
  });

  it('estimates cost per model from its own pricing tier', async () => {
    // generic deepseek: $0.27/1M in, $1.10/1M out; 1M prompt + 1M completion = $1.37
    await recordLlmAudit({ id: 'd', momentId: null, purpose: 'intent', model: 'deepseek/deepseek-v4-flash', prompt: 'p', requestedAt: '2026-01-01T10:00:00.000Z' });
    await updateLlmAudit('d', { respondedAt: '2026-01-01T10:00:01.000Z', latencyMs: 100, success: true, promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 });
    await call('free', 'my-local-model', 1000);

    const models = await getLlmAuditByModel();
    const deepseek = models.find((m) => m.model === 'deepseek/deepseek-v4-flash');
    const local = models.find((m) => m.model === 'my-local-model');
    expect(deepseek?.estimatedCostUsd).toBeCloseTo(1.37, 2);
    expect(local?.estimatedCostUsd).toBe(0);
  });

  it('scopes to sinceIso when provided', async () => {
    await call('old', 'm', 10, '2026-01-01T10:00:00.000Z');
    await call('new', 'm', 20, '2026-02-01T10:00:00.000Z');

    const models = await getLlmAuditByModel('2026-01-15T00:00:00.000Z');
    expect(models).toHaveLength(1);
    expect(models[0].totalTokens).toBe(20);
  });

  it('never bills a local Ollama tag, even when its name matches a paid remote family', async () => {
    // `qwen3.8:27b-mlx` substring-matched the paid `qwen3.8-…` tier before
    // provider was taken into account, and 2M tokens on-device read as spend.
    await recordLlmAudit({ id: 'l', momentId: null, purpose: 'intent', model: 'qwen3.8:27b-mlx', prompt: 'p', requestedAt: '2026-01-01T10:00:00.000Z' });
    await updateLlmAudit('l', { respondedAt: '2026-01-01T10:00:01.000Z', latencyMs: 100, success: true, promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 });

    const [local] = await getLlmAuditByModel();
    expect(local).toMatchObject({ provider: 'local', estimatedCostUsd: 0, unpriced: false });
  });

  it('marks a hosted model with no rate as unpriced rather than free', async () => {
    await call('u', 'somevendor/unknown-model', 1000);
    await call('p', 'qwen/qwen3.8-2.4t-a95b', 1000);

    const models = await getLlmAuditByModel();
    expect(models.find((m) => m.model === 'somevendor/unknown-model')).toMatchObject({ provider: 'remote', unpriced: true });
    expect(models.find((m) => m.model === 'qwen/qwen3.8-2.4t-a95b')).toMatchObject({ provider: 'remote', unpriced: false });
  });
});

describe('getLlmAuditOverview — provider split', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  const call = async (id: string, model: string, tokens: number) => {
    await recordLlmAudit({ id, momentId: null, purpose: 'intent', model, prompt: 'p', requestedAt: '2026-01-01T10:00:00.000Z' });
    await updateLlmAudit(id, { respondedAt: '2026-01-01T10:00:01.000Z', latencyMs: 100, success: true, promptTokens: tokens / 2, completionTokens: tokens / 2, totalTokens: tokens });
  };

  it('counts hosted and local calls separately and lists unpriced hosted models', async () => {
    await call('r', 'qwen/qwen3.8-2.4t-a95b', 1000);
    await call('l', 'gemma4:26b-mlx', 4000);
    await call('u', 'somevendor/unknown-model', 2000);

    const { summary, unpricedRemoteModels } = await getLlmAuditOverview();

    expect(summary).toMatchObject({ calls: 3, remoteCalls: 2, localCalls: 1, remoteTokens: 3000, localTokens: 4000 });
    expect(unpricedRemoteModels).toEqual([{ model: 'somevendor/unknown-model', totalTokens: 2000 }]);
  });
});
