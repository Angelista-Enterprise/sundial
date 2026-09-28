import { LlmHttpError } from './transport.js';

const DEFAULT_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;

/**
 * Status-aware retry around an LLM call. Retries a transient failure — a
 * network error/timeout, or an `LlmHttpError` with status 429 or >= 500 —
 * with exponential backoff, honoring a `Retry-After` header when the endpoint
 * sent one. A 4xx client error (other than 429) is not retried: retrying a
 * malformed request or a bad key just wastes calls.
 *
 * The daemon's effect executor has its own detached, re-scheduling retry for
 * `ScheduleLLM`-dispatched calls; this exists for the CLI-direct callers
 * (`gnomon ask`'s fallback, `gnomon journal`) that never go through that path
 * (see almanac/architecture/llm/llm-transport-and-budgets).
 */
export async function withLlmRetry<T>(fn: () => Promise<T>, opts: { retries?: number } = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retriable = error instanceof LlmHttpError ? error.status === 429 || error.status >= 500 : true;
      if (attempt === retries || !retriable) throw error;
      const retryAfter = error instanceof LlmHttpError ? error.retryAfterMs : null;
      const backoff = retryAfter ?? Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastError;
}
