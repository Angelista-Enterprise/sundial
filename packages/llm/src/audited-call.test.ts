import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordLlmAudit = vi.fn();
const updateLlmAudit = vi.fn();
vi.mock('@sundial/db/index.js', () => ({
  recordLlmAudit: (...args: unknown[]) => recordLlmAudit(...args),
  updateLlmAudit: (...args: unknown[]) => updateLlmAudit(...args),
}));

const callChatCompletion = vi.fn();
vi.mock('./transport.js', () => ({ callChatCompletion: (...args: unknown[]) => callChatCompletion(...args) }));
vi.mock('./config.js', () => ({ modelForPurpose: () => 'qwen/qwen3.8-flash-next' }));

const { runAuditedLlmCall } = await import('./audited-call.js');
const { auditIdOf } = await import('./types.js');

const options = { purpose: 'intent' as const, momentId: 'm1', messages: [{ role: 'user' as const, content: 'hello' }] };

beforeEach(() => {
  recordLlmAudit.mockReset().mockResolvedValue(undefined);
  updateLlmAudit.mockReset().mockResolvedValue(undefined);
  callChatCompletion.mockReset();
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
