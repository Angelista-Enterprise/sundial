import { loadSundialEnv, SUNDIAL_ENV_FILE } from '@sundial/helpers/sundial-env.js';
import { LlmHttpError } from './transport.js';

/**
 * The transport for TypeSafe's System One model (Jev) — a sibling of
 * `callChatCompletion`, not a mode of it. Jev is not a chat endpoint: one POST
 * with `{ state, questions }` comes back as one answer per question, each a
 * probability vector. No SDK, for the reason `transport.ts` has none: the wire
 * shape is one request, and an SDK that owns the call owns where the audit
 * row gets written. Ported from `lab/jev/client.mjs`, which stays the bench's.
 *
 * Retry lives one layer up (the executor), status-aware through
 * `LlmHttpError`: 429/5xx honour `Retry-After`, 4xx fail fast.
 */
export const SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const SYSTEMONE_DEFAULT_MODEL = 'jev-latest';
/** p95 is 500 ms; 30 s is the "the network is gone" bound, not a budget. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface SystemOneQuestion {
  type: 'choice' | 'score' | 'noul';
  instructions: string;
  criteria?: Record<string, string> | string[];
}

export interface SystemOneAnswer {
  type: string;
  choice?: string;
  score?: number;
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
  legend?: Record<string, string>;
}

export interface SystemOneResult {
  answers: Record<string, SystemOneAnswer>;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  statusCode: number;
}

/** Where the call goes. `SUNDIAL_SYSTEMONE_URL` exists for tests and the chaos drill, nothing else. */
export function systemOneUrl(): string {
  return process.env.SUNDIAL_SYSTEMONE_URL || SYSTEMONE_URL;
}

/** The key, or a clear error naming the one file it belongs in. */
export function systemOneApiKey(): string {
  loadSundialEnv();
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error(`TYPESAFE_API_KEY is not set. Add it to ${SUNDIAL_ENV_FILE} (the only env file Sundial reads).`);
  return key;
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

export async function callSystemOne(
  state: unknown,
  questions: Record<string, SystemOneQuestion>,
  opts: { model?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<SystemOneResult> {
  const apiKey = systemOneApiKey();
  const model = opts.model ?? SYSTEMONE_DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const startedAt = performance.now();
  try {
    const response = await (opts.fetchImpl ?? fetch)(systemOneUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model, questions }),
      signal: controller.signal,
    });
    const latencyMs = performance.now() - startedAt;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new LlmHttpError(response.status, parseRetryAfterMs(response.headers.get('retry-after')), `Jev returned ${response.status}: ${text.slice(0, 500)}`);
    }
    const parsed = (await response.json()) as {
      answers?: Record<string, SystemOneAnswer>;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      answers: parsed.answers ?? {},
      model: parsed.model ?? model,
      inputTokens: parsed.usage?.input_tokens ?? null,
      outputTokens: parsed.usage?.output_tokens ?? null,
      latencyMs,
      statusCode: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}
