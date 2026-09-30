import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordLlmAudit = vi.fn();
const updateLlmAudit = vi.fn();
vi.mock('@sundial/db/index.js', () => ({
  recordLlmAudit: (...args: unknown[]) => recordLlmAudit(...args),
  updateLlmAudit: (...args: unknown[]) => updateLlmAudit(...args),
}));

const { openLlmAudit, setLlmAuditListener } = await import('./audit.js');

beforeEach(() => {
  recordLlmAudit.mockReset().mockResolvedValue(undefined);
  updateLlmAudit.mockReset().mockResolvedValue(undefined);
});

describe('openLlmAudit (W3: the one llm_audit writer)', () => {
  it('records the row under the reservation id before the call, and settles it once', async () => {
    const audit = await openLlmAudit({ id: 'call-1', momentId: null, purpose: 'hand', model: 'claude-code', prompt: 'p' });
    expect(audit.id).toBe('call-1');
    expect(recordLlmAudit).toHaveBeenCalledWith(expect.objectContaining({ id: 'call-1', purpose: 'hand', requestedAt: expect.any(String) }));
    const patch = { respondedAt: 'now', latencyMs: 5, success: true };
    await audit.settle(patch);
    await audit.settle({ ...patch, success: false });
    expect(updateLlmAudit.mock.calls).toEqual([['call-1', patch]]);
  });

  it('mints an id when no reservation was made', async () => {
    const audit = await openLlmAudit({ momentId: null, purpose: 'vision', model: 'gemma4:e4b-mlx', prompt: 'p' });
    expect(audit.id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('W5: reports each settle once to the listener, with the class and never the error text', async () => {
    const heard: unknown[] = [];
    setLlmAuditListener((o) => heard.push(o));
    try {
      const failed = await openLlmAudit({ id: 'call-2', momentId: null, purpose: 'intent', model: 'm', prompt: 'p', attempt: 2, route: 'openai' });
      await failed.settle({ respondedAt: 'now', latencyMs: 5, success: false, error: 'bad key sk-abcdefghijklmnopqrstuv1234', errorClass: 'http-4xx' });
      await failed.settle({ respondedAt: 'now', latencyMs: 5, success: false });
      const ok = await openLlmAudit({ id: 'call-3', momentId: null, purpose: 'ask', model: 'm', prompt: 'p' });
      await ok.settle({ respondedAt: 'now', latencyMs: 5, success: true });
      const limited = await openLlmAudit({ id: 'call-4', momentId: null, purpose: 'intent', model: 'm', prompt: 'p', route: 'openai' });
      await limited.settle({ respondedAt: 'now', latencyMs: 5, success: false, errorClass: 'rate-limit', retryAfterMs: 7000 });
      expect(heard).toEqual([
        { callId: 'call-2', purpose: 'intent', route: 'openai', ok: false, errorClass: 'http-4xx', attempt: 2 },
        { callId: 'call-3', purpose: 'ask', route: 'unknown', ok: true, errorClass: null, attempt: 1 },
        { callId: 'call-4', purpose: 'intent', route: 'openai', ok: false, errorClass: 'rate-limit', attempt: 1, retryAfterMs: 7000 },
      ]);
      expect(updateLlmAudit.mock.calls.at(-1)![1]).not.toHaveProperty('retryAfterMs'); // not a column either
      expect(JSON.stringify(heard)).not.toContain('sk-');
      // The route is not a column.
      expect(recordLlmAudit.mock.calls[0][0]).not.toHaveProperty('route');
    } finally {
      setLlmAuditListener(null);
    }
  });
});
