import { loadSundialConfig } from '@sundial/helpers/sundial-config.js';
import { DEFAULT_PROVIDER, providerKeyEnv, type LlmProtocol, type LlmProvider } from '@sundial/helpers/llm-providers.js';
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
  /** How the endpoint is spoken to: the raw fetch here for `openai-chat`, the model port (`model-port.ts`) for the rest, the runtime for `claude-cli`. */
  protocol: LlmProtocol | 'claude-cli' | 'copilot-sdk';
  /** The source id as the Ledger records it (today the same as `route`). */
  source: string;
  /** `api`: a key or a local server, billed per token; `runtime`: a vendor's own binary on the owner's plan. */
  access: 'api' | 'runtime';
}

/** TensorX's GLM flash: the default for every purpose (qwen3.8-flash-next until TensorX withdrew it, 2026-11-02). Also the dsh agent default (plugins/sundial-llm-tensorx). */
export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';

/** The hosted endpoint the two defaults below are model ids FOR. */
const DEFAULT_MODEL_HOST = 'api.tensorx.ai';

type LlmSection = ReturnType<typeof loadSundialConfig>['llm'];

/**
 * The runtime source id: Claude Code headless, not an http endpoint
 * (`claude-code.ts`). Until 2026-10-05 it was the route id `claude-code`; ledger
 * rows and `state.reliability.llm` keys from then keep that name, and readers
 * take both.
 */
export const CLAUDE_SOURCE = 'claude';
/** The Copilot SDK runtime source (step 4): the owner's own GitHub Copilot login. */
export const COPILOT_SOURCE = 'copilot';
export const COPILOT_DEFAULT_MODEL = 'claude-sonnet-4.5';
const JUDGEMENT_PURPOSES = new Set<string>(['perceive', 'classify', 'rank', 'judge', 'audit', 'forecast', 'listen', 'screen', 'frame']);

/** `source:model` → its parts; a bare source has no model. */
export function splitSourceModel(entry: string): { source: string; model: string | null } {
  const i = entry.indexOf(':');
  return i < 0 ? { source: entry, model: null } : { source: entry.slice(0, i), model: entry.slice(i + 1) || null };
}
/** The role a purpose belongs to (docs/provider-implementation.md, step 3): Jev's questions are `judge`, the rest `background`. */
export type LlmRole = 'judge' | 'background' | 'jobs' | 'lookout';
export function roleOf(purpose?: LlmPurpose): LlmRole {
  if (purpose && JUDGEMENT_PURPOSES.has(purpose)) return 'judge';
  if (purpose === 'hand') return 'jobs';
  if (purpose === 'companion') return 'lookout';
  return 'background';
}
/** The ordered `source:model` list the owner set for a role; empty when the role runs on `use` and `providers`. */
export function roleSources(role: string): string[] {
  const llm = llmSource?.() ?? loadSundialConfig().llm;
  return llm.roles?.[role] ?? [];
}
/**
 * W3: where the `llm` section is read. The kernel runtime points it at
 * `state.config.llm` (config in the log), so a per-purpose model change applies
 * without a restart; with no source (a process with no kernel) the file is read.
 */
let llmSource: (() => LlmSection | undefined) | null = null;
export function setLlmConfigSource(fn: (() => LlmSection | undefined) | null): void {
  llmSource = fn;
}

/**
 * Whether a route is held right now: the breaker open or a 429's cooldown
 * (`state.reliability.llm`, read by the kernel runtime through this seam, like
 * `setLlmConfigSource`). Without a source nothing is held.
 */
let routeHeld: ((route: string) => boolean) | null = null;
export function setRouteHealthSource(fn: ((route: string) => boolean) | null): void {
  routeHeld = fn;
}
export const isRouteHeld = (route: string): boolean => routeHeld?.(route) ?? false;

const asProvider = (p: LlmProvider, model?: string | null): LlmConfig => ({ route: p.id, source: p.id, access: 'api', baseUrl: p.baseUrl, apiKey: process.env[providerKeyEnv(p.id)] || null, model: model ?? p.model, protocol: p.protocol });

/**
 * The router (docs/provider-implementation.md, step 3): every candidate for a
 * purpose, in order. A role the owner listed (`llm.roles`, `source:model`
 * entries) is the whole list; `jev` is Jev's own path and an unknown source is
 * skipped; `lookout` with no list runs as `background` (`jarvis`, its name until 2026-10-06, is read first). Without a list, the one
 * route `llm.use` or `.env` names, as before. `runAuditedLlmCall` walks the
 * list on a limit; `firstOpenConfig` skips a held source.
 */
export function resolveRole(purpose?: LlmPurpose): LlmConfig[] {
  const llm = llmSource?.() ?? loadSundialConfig().llm;
  const role = roleOf(purpose);
  const listed = llm.roles?.[role] ?? (role === 'lookout' ? (llm.roles?.jarvis ?? llm.roles?.background) : undefined) ?? [];
  const out: LlmConfig[] = [];
  for (const entry of listed) {
    const { source, model } = splitSourceModel(entry);
    if (source === CLAUDE_SOURCE) out.push({ route: CLAUDE_SOURCE, source: CLAUDE_SOURCE, access: 'runtime', baseUrl: '', apiKey: null, model: model ?? 'sonnet', protocol: 'claude-cli' });
    else if (source === COPILOT_SOURCE) out.push({ route: COPILOT_SOURCE, source: COPILOT_SOURCE, access: 'runtime', baseUrl: '', apiKey: null, model: model ?? COPILOT_DEFAULT_MODEL, protocol: 'copilot-sdk' });
    else if (source === DEFAULT_PROVIDER) {
      const own = ownRoute();
      if (own) out.push(model ? { ...own, model } : own);
    } else {
      const p = llm.providers.find((x) => x.id === source);
      if (p) out.push(asProvider(p, model));
    }
  }
  if (out.length > 0) return out;
  const id = (purpose && llm.use[purpose]) || llm.use.default;
  const provider = llm.providers.find((p) => p.id === id);
  if (provider) return [asProvider(provider)];
  const own = ownRoute();
  return own ? [own] : [];
}

/** The first candidate that is not held, else the first: what a reservation and the slot count against. */
export function firstOpenConfig(purpose?: LlmPurpose): LlmConfig | null {
  const candidates = resolveRole(purpose);
  return candidates.find((c) => !isRouteHeld(c.route)) ?? candidates[0] ?? null;
}

/** The endpoint and model for one purpose: the router's first candidate. */
export function getLlmConfig(purpose?: LlmPurpose): LlmConfig | null {
  return resolveRole(purpose)[0] ?? null;
}

/** Gnomon's own route, from `.env`; null when none is set. */
function ownRoute(): LlmConfig | null {
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
    source: DEFAULT_PROVIDER,
    access: 'api',
    baseUrl,
    apiKey: process.env.SUNDIAL_LLM_API_KEY ?? null,
    model: model || DEFAULT_MODEL,
    protocol: 'openai-chat',
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
