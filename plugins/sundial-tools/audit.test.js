// The chat half of the ledger: record-then-patch of `llm_audit` from the
// `llm/stream` seam. The contract under test is the one the Ledger page reads:
// a row exists before the provider is contacted, and it ends up holding the
// model, the tokens, the latency, the body, and the outcome.
import { describe, it, expect, vi } from 'vitest';
import {
  auditPurpose,
  boundBody,
  createLlmAuditRecorder,
  DEFAULT_AUDIT_PURPOSE,
  mapUsageToColumns,
  MAX_BODY_CHARS,
  serializePrompt,
} from './audit.js';

function fakeQueries() {
  return { recordLlmAudit: vi.fn().mockResolvedValue(undefined), updateLlmAudit: vi.fn().mockResolvedValue(undefined) };
}

/** A clock that advances a fixed step per read, so latency is deterministic. */
function steppingClock(start, step) {
  let t = start - step;
  return () => (t += step);
}

/** `openLlmAudit`'s shape over the two fake writes, so the assertions read the rows it would write. */
const openAuditOver = (queries) => async (row) => {
  await queries.recordLlmAudit(row);
  return { id: row.id, settle: (patch) => queries.updateLlmAudit(row.id, patch) };
};

function recorderWith(queries, overrides = {}) {
  return createLlmAuditRecorder({
    openAudit: openAuditOver(queries),
    getMomentId: () => 'moment-1',
    newId: () => 'audit-1',
    clock: steppingClock(1_000_000, 250),
    ...overrides,
  });
}

const OPTIONS = {
  provider: 'tensorx',
  model: 'qwen/qwen3.8-2.4t-a95b',
  system: 'You are Gnomon.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'what did I do today?' }] }],
};

describe('serializePrompt', () => {
  it('renders the system slot and every role, in order', () => {
    expect(serializePrompt(OPTIONS)).toBe('[system] You are Gnomon.\n\n[user] what did I do today?');
  });

  it('renders tool calls and tool results, so a tool-only turn is not a blank row', () => {
    const prompt = serializePrompt({
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'gnomon_summary', arguments: '{"day":"today"}' }] },
        { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '3 moments' }] }] },
      ],
    });
    expect(prompt).toBe('[assistant] gnomon_summary({"day":"today"})\n\n[user] → 3 moments');
  });

  it('a tool schema that cannot be stringified is sized by its name, not a thrown row', () => {
    const cyclic = { name: 'gnomon_loop', parameters: {} };
    cyclic.parameters.self = cyclic;
    expect(serializePrompt({ ...OPTIONS, tools: [cyclic] })).toContain('[tools] 1 · 11 chars: gnomon_loop');
  });

  it('names, counts and sizes the tools the call carried', () => {
    const tools = [{ name: 'gnomon_today_summary', description: 'd', parameters: {} }, { name: 'gnomon_people', description: 'p', parameters: {} }];
    const prompt = serializePrompt({ ...OPTIONS, tools });
    const chars = tools.reduce((sum, t) => sum + JSON.stringify(t).length, 0);
    expect(prompt).toBe(`[system] You are Gnomon.\n\n[tools] 2 · ${chars} chars: gnomon_today_summary, gnomon_people\n\n[user] what did I do today?`);
  });

  it('bounds the body — a chat prompt replays the whole history every turn', () => {
    const huge = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(MAX_BODY_CHARS + 500) }] }] };
    const prompt = serializePrompt(huge);
    expect(prompt.length).toBeLessThan(MAX_BODY_CHARS + 200);
    expect(prompt).toContain('more characters not recorded');
  });

  it('leaves a body at the bound untouched', () => {
    expect(boundBody('y'.repeat(MAX_BODY_CHARS))).toHaveLength(MAX_BODY_CHARS);
  });
});

describe('auditPurpose', () => {
  it("files an ordinary conversation turn as 'ask' — the seat /ask held", () => {
    expect(auditPurpose(OPTIONS)).toBe(DEFAULT_AUDIT_PURPOSE);
    expect(DEFAULT_AUDIT_PURPOSE).toBe('ask');
  });

  it("keeps dsh's auxiliary purposes under their own names", () => {
    expect(auditPurpose({ ...OPTIONS, purpose: 'compaction' })).toBe('compaction');
    expect(auditPurpose({ ...OPTIONS, purpose: 'session-title' })).toBe('session-title');
  });
});

describe('mapUsageToColumns', () => {
  it('adds cache reads back into prompt tokens — TokenUsage is disjoint, the column is the billed input', () => {
    expect(mapUsageToColumns({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 })).toEqual({
      promptTokens: 1000,
      completionTokens: 20,
      totalTokens: 1020,
      cacheReadTokens: 900,
    });
  });

  it('keeps the cache read as its own column, so the cached half can be priced at the cached rate', () => {
    // The whole point of the column: 900 of these 1000 prompt tokens cost a
    // twentieth of the other 100. Summing them into `promptTokens` alone —
    // which is what this function used to do — is what made the ledger's `ask`
    // line overstated the input side by 2.79x.
    const columns = mapUsageToColumns({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 });
    expect(columns.cacheReadTokens).toBe(900);
    expect(columns.promptTokens - columns.cacheReadTokens).toBe(100);
  });

  it('reports a zero cache read rather than omitting it when the provider says nothing', () => {
    // Omitting would leave the column NULL and be priced as fully fresh, which
    // is the honest default — but a 0 says so without the reader having to
    // guess whether the field was lost on the way.
    expect(mapUsageToColumns({ inputTokens: 100, outputTokens: 20 })).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 0,
    });
  });

  it('writes no token columns when the provider sent no usage', () => {
    expect(mapUsageToColumns(undefined)).toEqual({});
  });
});

describe('createLlmAuditRecorder', () => {
  it('opens the row BEFORE the call, with the model, purpose, moment and prompt', async () => {
    const queries = fakeQueries();
    await recorderWith(queries)(OPTIONS);

    expect(queries.recordLlmAudit).toHaveBeenCalledTimes(1);
    expect(queries.recordLlmAudit).toHaveBeenCalledWith({
      id: 'audit-1',
      momentId: 'moment-1',
      purpose: 'ask',
      model: 'qwen/qwen3.8-2.4t-a95b',
      prompt: '[system] You are Gnomon.\n\n[user] what did I do today?',
      requestedAt: new Date(1_000_000).toISOString(),
      // W5: the dsh route, for `llm:failed` and the breaker (not a column).
      route: expect.any(String),
    });
    // Nothing is patched until the stream ends.
    expect(queries.updateLlmAudit).not.toHaveBeenCalled();
  });

  it('closes a successful turn with tokens, latency and the response body', async () => {
    const queries = fakeQueries();
    const audit = await recorderWith(queries)(OPTIONS);

    audit.observe({ type: 'text-delta', index: 0, text: 'You wrote ' });
    audit.observe({ type: 'text-delta', index: 0, text: 'some code.' });
    audit.observe({ type: 'usage', usage: { inputTokens: 40, outputTokens: 8, cacheReadTokens: 10 } });
    audit.observe({ type: 'finish', reason: { kind: 'stop' } });
    await audit.settle();

    expect(queries.updateLlmAudit).toHaveBeenCalledWith('audit-1', {
      respondedAt: new Date(1_000_250).toISOString(),
      latencyMs: 250,
      success: true,
      responseContent: 'You wrote some code.',
      promptTokens: 50,
      completionTokens: 8,
      totalTokens: 58,
      cacheReadTokens: 10,
    });
  });

  it('records a tool-requesting turn as a success, with the calls as its body', async () => {
    const queries = fakeQueries();
    const audit = await recorderWith(queries)(OPTIONS);

    audit.observe({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'gnomon_summary', arguments: '{}' } });
    audit.observe({ type: 'finish', reason: { kind: 'tool-calls' } });
    await audit.settle();

    const [, patch] = queries.updateLlmAudit.mock.calls[0];
    expect(patch.success).toBe(true);
    expect(patch.responseContent).toBe('gnomon_summary({})');
  });

  it('records a provider failure with its message', async () => {
    const queries = fakeQueries();
    const audit = await recorderWith(queries)(OPTIONS);

    audit.observe({ type: 'finish', reason: { kind: 'error', failure: { message: 'HTTP 429', code: 'RATE_LIMIT' } } });
    await audit.settle();

    const [, patch] = queries.updateLlmAudit.mock.calls[0];
    expect(patch.success).toBe(false);
    expect(patch.error).toBe('HTTP 429');
  });

  it('records a thrown stream as a failure — the provider was contacted either way', async () => {
    const queries = fakeQueries();
    const audit = await recorderWith(queries)(OPTIONS);

    await audit.settle(new Error('socket hang up'));

    const [, patch] = queries.updateLlmAudit.mock.calls[0];
    expect(patch.success).toBe(false);
    expect(patch.error).toBe('socket hang up');
  });

  it('records a stream that ended without a finish chunk as a failure, not a silent success', async () => {
    const queries = fakeQueries();
    const audit = await recorderWith(queries)(OPTIONS);
    await audit.settle();

    const [, patch] = queries.updateLlmAudit.mock.calls[0];
    expect(patch.success).toBe(false);
    expect(patch.error).toBe('stream ended without a finish chunk');
  });

  it('settles once, however many times it is called', async () => {
    const queries = fakeQueries();
    const audit = await recorderWith(queries)(OPTIONS);
    audit.observe({ type: 'finish', reason: { kind: 'stop' } });
    await audit.settle();
    await audit.settle();
    expect(queries.updateLlmAudit).toHaveBeenCalledTimes(1);
  });

  it('a failed INSERT is contained: begin returns null and the chat is not broken', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queries = fakeQueries();
    queries.recordLlmAudit.mockRejectedValue(new Error('db locked'));

    await expect(recorderWith(queries)(OPTIONS)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a failed UPDATE is contained (logged), not thrown at the caller', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const queries = fakeQueries();
    queries.updateLlmAudit.mockRejectedValue(new Error('db locked'));

    const audit = await recorderWith(queries)(OPTIONS);
    audit.observe({ type: 'finish', reason: { kind: 'stop' } });
    await expect(audit.settle()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('records a bare model id from a hosted route under that route, and leaves a local one alone', async () => {
    const queries = fakeQueries();
    const routeBaseUrl = (id) => ({ groq: 'https://api.groq.com/openai/v1', local: 'http://127.0.0.1:11434/v1' })[id];
    await recorderWith(queries, { routeBaseUrl })({ provider: 'groq', model: 'llama-3.3-70b', messages: [] });
    await recorderWith(queries, { routeBaseUrl })({ provider: 'local', model: 'qwen3.8:27b-mlx', messages: [] });
    expect(queries.recordLlmAudit.mock.calls.map((c) => c[0].model)).toEqual(['groq/llama-3.3-70b', 'qwen3.8:27b-mlx']);
  });

  it("falls back to 'unknown' rather than violating the NOT NULL model column", async () => {
    const queries = fakeQueries();
    await recorderWith(queries)({ messages: [] });
    expect(queries.recordLlmAudit.mock.calls[0][0].model).toBe('unknown');
  });
});
