import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { DEFAULT_PROVIDER, providerKeyEnv } from '@sundial/helpers/llm-providers.js';
import type { LlmPurpose } from './types.js';

/**
 * Deliberately simplified vs WCS's `@wcs/llm`: no multi-endpoint fallback.
 * The `.env` endpoint is the default; `config.json` `llm.use` can send a
 * purpose, or all of them, to one of the `llm.providers` instead.
 *
 * Between 2026-09-06 and 2026-09-09 there were two: `intent` was routed to
 * `deepseek/deepseek-v4-flash-0731` on the grounds that the most frequent call
 * least needs a strong model. Retired because the saving was not real. Measured
 * over the 4,130 `intent` calls on the live record, DeepSeek flash is dearer on
 * input ($0.25 vs $0.20 per 1M) and cheaper on output ($0.30 vs $0.50), and an
 * `intent` completion is a phrase plus one sentence — so the split traded a
 * rounding error for a second model id, a second env var, and a branch in
 * `modelForPurpose`. One model is the lazier and the cheaper answer.
 *
 * Any OpenAI-compatible chat-completions endpoint works (local Ollama,
 * llama.cpp's server mode, or a real hosted API) — set the env vars below.
 * No default base URL: if unset, `isLlmConfigured()` returns false and
 * `ScheduleLLM` effects fail fast with a clear error rather than silently
 * trying to reach `localhost:11434` on a machine that isn't running anything
 * there.
 */
export interface LlmConfig {
  /** The route that serves it: `openai` (the `.env` model) or a `config.json` provider id. */
  route: string;
  baseUrl: string;
  apiKey: string | null;
  /** The model every purpose runs on. */
  model: string;
}

/** TensorX's qwen flash: the default for every purpose. Also the dsh agent default (plugins/sundial-llm-tensorx). */
export const DEFAULT_MODEL = 'qwen/qwen3.8-flash-next';

/** The hosted endpoint the two defaults below are model ids FOR. */
const DEFAULT_MODEL_HOST = 'api.tensorx.ai';

// config.json is read once: a change to it waits for a restart, like every other setting.
let llmFile: ReturnType<typeof loadSundialConfig>['llm'] | null = null;

/**
 * The endpoint and model for one purpose: `llm.use[purpose]`, else
 * `llm.use.default`, else the `.env` model. A route id that names no saved
 * provider falls through to the `.env` model rather than stopping the call.
 */
export function getLlmConfig(purpose?: LlmPurpose): LlmConfig | null {
  llmFile ??= loadSundialConfig().llm;
  const id = (purpose && llmFile.use[purpose]) || llmFile.use.default;
  const provider = llmFile.providers.find((p) => p.id === id);
  if (provider) return { route: provider.id, baseUrl: provider.baseUrl, apiKey: process.env[providerKeyEnv(provider.id)] || null, model: provider.model };
  const baseUrl = process.env.SUNDIAL_LLM_BASE_URL;
  if (!baseUrl) return null;
  const model = process.env.SUNDIAL_LLM_MODEL;
  // The defaults are TensorX model ids, so they are only a default FOR TensorX.
  // Applied to any endpoint, they turned "no model configured" — which used to
  // make `isLlmConfigured()` false and schedule nothing — into a call that 404s
  // at the provider on every purpose, burning retries and budget while `doctor`
  // reported the LLM as configured and the journal silently produced nothing.
  if (!model && !baseUrl.includes(DEFAULT_MODEL_HOST)) return null;
  return {
    route: DEFAULT_PROVIDER,
    baseUrl,
    apiKey: process.env.SUNDIAL_LLM_API_KEY ?? null,
    model: model || DEFAULT_MODEL,
  };
}

export function isLlmConfigured(): boolean {
  return getLlmConfig() !== null;
}

/**
 * Which model a purpose runs on. `null` when no endpoint is configured, which
 * is what stops a `ScheduleLLM` from dispatching.
 *
 * One model for every purpose was the owner's decision on 2026-09-22; since
 * 2026-09-29 the owner can mix providers per purpose (`llm.use`, set on /setup).
 */
export function modelForPurpose(purpose: LlmPurpose): string | null {
  return getLlmConfig(purpose)?.model ?? null;
}
