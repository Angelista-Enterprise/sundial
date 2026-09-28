import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withLlmRetry } from './retry.js';
import { LlmHttpError } from './transport.js';

describe('withLlmRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withLlmRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new LlmHttpError(503, null, 'down')).mockResolvedValue('ok');
    const p = withLlmRetry(fn);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 and honors its Retry-After delay', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new LlmHttpError(429, 2_000, 'slow down')).mockResolvedValue('ok');
    const p = withLlmRetry(fn);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fn).toHaveBeenCalledTimes(1); // still waiting out the Retry-After
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx client error (other than 429)', async () => {
    const fn = vi.fn().mockRejectedValue(new LlmHttpError(400, null, 'bad request'));
    const err = await withLlmRetry(fn).catch((e) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a network error (non-HTTP) then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue('ok');
    const p = withLlmRetry(fn);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget and throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new LlmHttpError(503, null, 'down'));
    const p = withLlmRetry(fn, { retries: 2 }).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
