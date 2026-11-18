import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordLlmAudit = vi.fn();
const updateLlmAudit = vi.fn();
vi.mock('@sundial/db/index.js', () => ({
  recordLlmAudit: (...args: unknown[]) => recordLlmAudit(...args),
  updateLlmAudit: (...args: unknown[]) => updateLlmAudit(...args),
}));

const callChatCompletion = vi.fn();
vi.mock('./transport.js', () => ({ callChatCompletion: (...args: unknown[]) => callChatCompletion(...args) }));
let configured: Record<string, unknown> = { model: 'qwen/qwen3.8-flash-next', baseUrl: 'https://api.tensorx.ai/v1', route: 'openai', access: 'api' };
let candidates: Record<string, unknown>[] | null = null;
let held = new Set<string>();
vi.mock('./config.js', () => ({ modelForPurpose: () => configured.model, getLlmConfig: () => configured, resolveRole: () => candidates ?? [configured], isRouteHeld: (route: string) => held.has(route) }));

const { runAuditedLlmCall } = await import('./audited-call.js');
const { auditIdOf } = await import('./types.js');

const options = { purpose: 'intent' as const, momentId: 'm1', messages: [{ role: 'user' as const, content: 'hello' }] };

beforeEach(() => {
  recordLlmAudit.mockReset().mockResolvedValue(undefined);
  updateLlmAudit.mockReset().mockResolvedValue(undefined);
  callChatCompletion.mockReset();
  candidates = null;
  held = new Set();
});

describe('the router (step 3): a limit moves to the next source', () => {
  const far = { route: 'far', source: 'far', access: 'api', model: 'big-model', baseUrl: 'https://llm.example.com/v1', protocol: 'openai-chat' };
  const near = { route: 'near', source: 'near', access: 'api', model: 'small', baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'openai-chat' };
  const ok = { content: 'hi', statusCode: 200, promptTokens: 1, completionTokens: 1, totalTokens: 2, toolCalls: [], finishReason: 'stop' };
  const limit = (status: number) => { const { LlmHttpError } = { LlmHttpError: class extends Error { constructor(public status: number, public retryAfterMs: number | null, m: string) { super(m); this.name = 'LlmHttpError'; } } }; return new LlmHttpError(status, 500, `LLM endpoint returned ${status}`); };

  it('a 429 on the first source answers on the second, two rows chained by parentCallId, each under its own source', async () => {
    candidates = [far, near];
    callChatCompletion.mockRejectedValueOnce(limit(429)).mockResolvedValueOnce(ok);
    const out = await runAuditedLlmCall({ ...options, callId: 'call-1' });
    expect(out.content).toBe('hi');
    expect(recordLlmAudit.mock.calls.map((c) => [c[0].id, c[0].source, c[0].attempt, c[0].parentCallId])).toEqual([['call-1', 'far', 1, null], [expect.any(String), 'near', 2, 'call-1']]);
    expect(callChatCompletion.mock.calls.map((c) => c[1].config.route)).toEqual(['far', 'near']);
    expect(updateLlmAudit.mock.calls[0][1]).toMatchObject({ success: false, errorClass: 'rate-limit' });
  });

  it('a 402 falls through too; a 500 stops at the source it hit; the last source has nowhere to go', async () => {
    candidates = [far, near];
    callChatCompletion.mockRejectedValueOnce(limit(402)).mockResolvedValueOnce(ok);
    expect((await runAuditedLlmCall(options)).content).toBe('hi');
    callChatCompletion.mockReset().mockRejectedValueOnce(limit(500));
    await expect(runAuditedLlmCall(options)).rejects.toThrow(/500/);
    expect(callChatCompletion).toHaveBeenCalledTimes(1);
    callChatCompletion.mockReset().mockRejectedValueOnce(limit(429)).mockRejectedValueOnce(limit(429));
    await expect(runAuditedLlmCall(options)).rejects.toThrow(/429/);
    expect(callChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('a held source is skipped before the call; when every source is held, the first is tried anyway', async () => {
    candidates = [far, near];
    held = new Set(['far']);
    callChatCompletion.mockResolvedValueOnce(ok);
    await runAuditedLlmCall(options);
    expect(callChatCompletion.mock.calls[0][1].config.route).toBe('near');
    held = new Set(['far', 'near']);
    callChatCompletion.mockReset().mockResolvedValueOnce(ok);
    await runAuditedLlmCall(options);
    expect(callChatCompletion.mock.calls[0][1].config.route).toBe('far');
  });
});

describe('billed tokens on a failed row', () => {
  it('a timed-out call records the prompt it uploaded, not zero', async () => {
    const timedOut = new Error('This operation was aborted');
    timedOut.name = 'AbortError';
    callChatCompletion.mockRejectedValueOnce(timedOut);

    await runAuditedLlmCall(options).catch(() => undefined);

    const [, patch] = updateLlmAudit.mock.calls[0];
    expect(patch.success).toBe(false);
    expect(patch.errorClass).toBe('timeout');
    expect(patch.billedPromptTokens).toBeGreaterThan(0);
  });

  it('leaves the billed column off a success — that row has a measured count', async () => {
    callChatCompletion.mockResolvedValueOnce({ content: 'hi', statusCode: 200, promptTokens: 9, completionTokens: 1, totalTokens: 10, toolCalls: [], finishReason: 'stop' });
    await runAuditedLlmCall(options);

    const [, patch] = updateLlmAudit.mock.calls[0];
    expect(patch.billedPromptTokens).toBeUndefined();
    expect(patch.promptTokens).toBe(9);
  });
});

describe('retry lineage', () => {
  it('a forced network failure leaves a row whose id the retry can point at', async () => {
    callChatCompletion.mockRejectedValueOnce(new TypeError('fetch failed'));
    const failure = await runAuditedLlmCall(options).catch((error: unknown) => error);

    const [first] = recordLlmAudit.mock.calls[0];
    expect(first.attempt).toBe(1);
    expect(first.parentCallId).toBeNull();
    expect(auditIdOf(failure)).toBe(first.id);

    // The second try, as the retry layer makes it: same effect, next attempt,
    // pointing at the row the first one left behind.
    callChatCompletion.mockResolvedValueOnce({ content: 'hi', statusCode: 200, promptTokens: 1, completionTokens: 1, totalTokens: 2, toolCalls: [], finishReason: 'stop' });
    await runAuditedLlmCall({ ...options, attempt: 2, parentCallId: auditIdOf(failure) });

    const [second] = recordLlmAudit.mock.calls[1];
    expect(second.attempt).toBe(2);
    expect(second.parentCallId).toBe(first.id);
    expect(second.id).not.toBe(first.id);
  });
});

describe('the model the ledger records', () => {
  it('namespaces a bare hosted id by its route, so it is priced as remote', async () => {
    configured = { model: 'gpt-5', baseUrl: 'https://api.openai.com/v1' };
    callChatCompletion.mockResolvedValueOnce({ content: 'hi', statusCode: 200, promptTokens: 9, completionTokens: 1, totalTokens: 10, toolCalls: [], finishReason: 'stop' });
    await runAuditedLlmCall(options);
    expect(recordLlmAudit.mock.calls[0][0].model).toBe('openai/gpt-5');
    // What is sent to the provider is still its own id.
    expect(callChatCompletion.mock.calls[0][1].model).toBe('gpt-5');
    configured = { model: 'qwen/qwen3.8-flash-next', baseUrl: 'https://api.tensorx.ai/v1' };
  });
});

// lane H (H3)
describe('a refused call keeps its status', () => {
  it('writes the HTTP status on the failed row and reports the refusal once', async () => {
    const { setLlmOutcomeListener } = await import('./outcome.js');
    const seen: unknown[] = [];
    setLlmOutcomeListener((o) => seen.push(o));
    callChatCompletion.mockRejectedValueOnce(Object.assign(new Error('LLM endpoint returned 401: no'), { status: 401 }));

    await runAuditedLlmCall(options).catch(() => undefined);
    setLlmOutcomeListener(null);

    const [, patch] = updateLlmAudit.mock.calls[0];
    expect(patch.statusCode).toBe(401);
    expect(patch.errorClass).toBe('http-4xx');
    expect(seen).toEqual([{ provider: 'openai', label: 'TensorX', ok: false, statusCode: 401 }]);
  });

  it('a network failure has no status', async () => {
    callChatCompletion.mockRejectedValueOnce(new TypeError('fetch failed'));
    await runAuditedLlmCall(options).catch(() => undefined);
    const [, patch] = updateLlmAudit.mock.calls[0];
    expect(patch.statusCode).toBeUndefined();
  });
});
