/**
 * Model providers: every OpenAI-compatible endpoint Sundial can talk to.
 *
 * One is Gnomon's own model, the route `openai`: `SUNDIAL_LLM_BASE_URL`,
 * `SUNDIAL_LLM_MODEL` and `SUNDIAL_LLM_API_KEY` in `$SUNDIAL_HOME/.env`. It
 * answers the chat by default and writes every summary and the journal.
 * Any others live in `config.json` under `llm.providers` and are one more
 * route each, chosen per conversation in the chat's model picker. Their keys
 * stay in `.env` too (`SUNDIAL_LLM_KEY_<ID>`), never in `config.json`.
 */
import fs from 'node:fs';

/** Gnomon's own route. `tensorx` is its name from before v0.2, kept as a hidden alias. */
export const DEFAULT_PROVIDER = 'openai';
export const LEGACY_PROVIDER = 'tensorx';

/**
 * The wire protocol a provider speaks (docs/provider-architecture.md §2). Sundial's own
 * adapter (plugins/sundial-llm-openai) and the kernel's raw fetch speak `openai-chat`;
 * the other two go through dsh's pi-ai adapter in the chat and through the kernel's
 * model port (`@sundial/llm` `setModelPort`) for background calls. Since 2026-10-05
 * (step 2 of docs/provider-implementation.md).
 */
export const PROTOCOLS = ['openai-chat', 'anthropic-messages', 'openai-responses'] as const;
export type LlmProtocol = (typeof PROTOCOLS)[number];
export const isProtocol = (v: unknown): v is LlmProtocol => typeof v === 'string' && (PROTOCOLS as readonly string[]).includes(v);

export interface LlmProvider {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  protocol: LlmProtocol;
  /** `provider:model` (or a bare route) a chat hedge goes to instead of this route again. */
  hedgeTo?: string;
  /** Merged into every chat request body for this route, under the fields Sundial sets. */
  body?: Record<string, unknown>;
}

/**
 * The `providers` config of dsh's pi-ai adapter for the providers Sundial's own adapter does
 * not speak: one hand-declared route each (`api`, `baseURL`, `models`), so pi-ai's installed
 * catalog never adds models or sign-in flows of its own, and always `apiKeyEnv`, so a route is
 * never authenticated through pi-ai's ambient discovery (`ANTHROPIC_AUTH_TOKEN` and the Claude
 * plan sign-in among it). The key reference is the same `.env` name Sundial's adapter reads;
 * the installer links `$DSH_HOME/.env` to that file so dsh's credential layer finds it.
 */
export function piAiProfiles(providers: readonly LlmProvider[]): Record<string, { displayName: string; api: 'anthropic-messages' | 'openai-responses'; baseURL: string; apiKeyEnv: string; models: { id: string }[] }> {
  const out: ReturnType<typeof piAiProfiles> = {};
  for (const p of providers) {
    const api = p.protocol ?? 'openai-chat';
    if (api === 'openai-chat') continue;
    out[p.id] = { displayName: p.label, api, baseURL: p.baseUrl, apiKeyEnv: providerKeyEnv(p.id), models: [{ id: p.model }] };
  }
  return out;
}

const KNOWN_HOSTS: [RegExp, string][] = [
  [/^api\.openai\.com$/, 'OpenAI'],
  [/^api\.anthropic\.com$/, 'Anthropic'],
  [/(^|\.)openrouter\.ai$/, 'OpenRouter'],
  [/^api\.deepseek\.com$/, 'DeepSeek'],
  [/(^|\.)tensorx\.ai$/, 'TensorX'],
  [/^api\.groq\.com$/, 'Groq'],
  [/^api\.mistral\.ai$/, 'Mistral'],
  [/^generativelanguage\.googleapis\.com$/, 'Google Gemini'],
  [/^api\.together\.xyz$/, 'Together'],
];

/**
 * The chat's default route and model, for a new thread, the companion and the
 * work agent. dsh's `agent-default-model` names Gnomon's own route; with no
 * `.env` model that route has no adapter ("no adapter registered for provider
 * openai"), so an install whose only model is a saved provider uses the one
 * `llm.use.default` names, and its model. A selection of any other route stays.
 */
export function chatDefault<S extends { provider: string; model: string }>(selection: S, llm: { providers: LlmProvider[]; use: Record<string, string>; roles?: Record<string, string[]> } | undefined, ownRoute = Boolean(process.env.SUNDIAL_LLM_BASE_URL)): S {
  // `llm.roles.chat` (step 3 of the provider plan): the first listed source is the chat's default, a saved
  // provider or Gnomon's own route; the rest of the list is what a limit falls through to (host/server.js).
  const head = chatCandidates(llm)[0];
  if (head) return { ...selection, ...head };
  if (ownRoute || (selection.provider !== DEFAULT_PROVIDER && selection.provider !== LEGACY_PROVIDER)) return selection;
  const p = llm?.providers.find((x) => x.id === llm.use.default);
  return p ? { ...selection, provider: p.id, model: p.model } : selection;
}

/** `llm.roles.chat` as `{provider, model}` candidates, in order: saved providers and Gnomon's own route (`openai`), unknown sources skipped. */
export function chatCandidates(llm: { providers: LlmProvider[]; roles?: Record<string, string[]> } | undefined): { provider: string; model: string }[] {
  const out: { provider: string; model: string }[] = [];
  for (const entry of llm?.roles?.chat ?? []) {
    const i = entry.indexOf(':');
    const [source, model] = i < 0 ? [entry, null] : [entry.slice(0, i), entry.slice(i + 1) || null];
    if (source === DEFAULT_PROVIDER) {
      const own = model ?? process.env.SUNDIAL_LLM_MODEL;
      if (process.env.SUNDIAL_LLM_BASE_URL && own) out.push({ provider: DEFAULT_PROVIDER, model: own });
    } else {
      const p = llm?.providers.find((x) => x.id === source);
      if (p) out.push({ provider: p.id, model: model ?? p.model });
    }
  }
  return out;
}

/** Where a held route's thread may go, in order (Set 2 R4): its own `hedgeTo` first, then `llm.roles.chat`. */
export function pausedCandidates(llm: { providers: LlmProvider[]; roles?: Record<string, string[]> } | undefined, route: string | undefined): { provider: string; model: string }[] {
  const hedgeTo = llm?.providers.find((p) => p.id === route)?.hedgeTo;
  return [...(hedgeTo ? chatCandidates({ providers: llm!.providers, roles: { chat: [hedgeTo] } }) : []), ...chatCandidates(llm)];
}

/**
 * The chat source a thread continues on when `current` is held (the breaker open, a 429's cooldown):
 * the first listed chat candidate that is not held, or null when `current` is fine or nothing else is open.
 */
export function openChatSource(current: { provider: string; model: string } | null | undefined, candidates: { provider: string; model: string }[], held: (route: string) => boolean): { provider: string; model: string } | null {
  if (!current || !held(current.provider)) return null;
  return candidates.find((c) => !held(c.provider) && c.provider !== current.provider) ?? null;
}

/** Whether `state.reliability.llm[route]` holds the route right now (the kernel's breaker or a 429's cooldown). */
export function routeHeldIn(reliability: Record<string, { openUntil?: string | null; cooldownUntil?: string | null }> | undefined, route: string, now = Date.now()): boolean {
  const r = reliability?.[route];
  const past = (at: string | null | undefined) => typeof at === 'string' && Date.parse(at) > now;
  return Boolean(r && (past(r.openUntil) || past(r.cooldownUntil)));
}

/** Whether a base URL points at this Mac. */
export function isLocalUrl(baseUrl: string): boolean {
  try {
    return /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The model id the ledger records for a call. The Ledger prices a call as
 * remote only when its id carries a vendor prefix (`llmProvider` in
 * packages/db/src/queries/llm-audit.ts), and a hosted API that names its models
 * bare (`gpt-5`, `deepseek-chat`) would read as a free local tag: billed in
 * reality, $0 on the Ledger, and missing from its unpriced list. So a bare id
 * from a route that is not on this Mac is recorded under its route
 * (`groq/llama-3.3-70b`). An unknown address keeps the id as it was.
 */
export function ledgerModel(model: string, routeId: string | undefined, baseUrl: string | undefined): string {
  // The `claude` runtime source has no URL: its calls are recorded under the source, like the hand jobs. (`claude-code/` until 2026-10-05.)
  if (routeId === 'claude' || routeId === 'claude-code') return `${routeId}/${model}`;
  if (model.includes('/') || !routeId || !baseUrl || isLocalUrl(baseUrl)) return model;
  return `${routeId}/${model}`;
}

/** A name a person recognizes: the service, "Ollama on this Mac", or the host. */
export function providerLabel(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'OpenAI-compatible';
  }
  if (isLocalUrl(baseUrl)) return url.port === '11434' ? 'Ollama on this Mac' : url.port === '1234' ? 'LM Studio on this Mac' : 'A model on this Mac';
  return KNOWN_HOSTS.find(([re]) => re.test(url.hostname))?.[1] ?? url.hostname;
}

/** The `.env` key that holds one extra provider's API key. */
export function providerKeyEnv(id: string): string {
  return id === DEFAULT_PROVIDER ? 'SUNDIAL_LLM_API_KEY' : `SUNDIAL_LLM_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** The route ids Sundial itself owns: Gnomon's own route and its old name, the runtime sources and the judge. */
export const RESERVED_IDS = new Set([DEFAULT_PROVIDER, LEGACY_PROVIDER, 'claude', 'copilot', 'jev']);
/** A provider id the config may use: a short slug, and never one of Sundial's own route ids. */
export function isProviderId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(id) && !RESERVED_IDS.has(id);
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** Request fields a provider's `body` never sets. */
const PROTECTED_BODY = new Set(['model', 'messages', 'tools', 'stream']);

/** `config.json`'s `llm.providers`, shape-checked; a bad entry is dropped, not fatal. */
export function parseProviders(raw: unknown): LlmProvider[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: LlmProvider[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    if (!p || !isProviderId(p.id) || seen.has(p.id) || !isHttpUrl(p.baseUrl) || typeof p.model !== 'string' || p.model.trim() === '') continue;
    seen.add(p.id);
    const baseUrl = p.baseUrl.replace(/\/+$/, '');
    const hedgeTo = typeof p.hedgeTo === 'string' && /^[a-z][a-z0-9-]{1,30}(:\S+)?$/.test(p.hedgeTo) ? p.hedgeTo : undefined;
    const body = p.body && typeof p.body === 'object' && !Array.isArray(p.body) ? Object.fromEntries(Object.entries(p.body).filter(([k]) => !PROTECTED_BODY.has(k))) : {};
    out.push({ id: p.id, baseUrl, model: p.model.trim(), label: typeof p.label === 'string' && p.label.trim() !== '' ? p.label.trim() : providerLabel(baseUrl), protocol: isProtocol(p.protocol) ? p.protocol : 'openai-chat', ...(hedgeTo ? { hedgeTo } : {}), ...(Object.keys(body).length > 0 ? { body } : {}) });
  }
  return out;
}

/** `config.json`'s `llm.use`: purpose (or `default`) → route id. Which ids exist is checked where it is used, so a removed provider falls back instead of failing. */
export function parseUse(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k, v]) => /^[a-z]+$/.test(k) && typeof v === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(v)) as [string, string][]);
}

/** Model id → window in tokens; a value outside 8k–2M is dropped, not clamped. */
export function parseContextWindows(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => Number.isInteger(v) && (v as number) >= 8_000 && (v as number) <= 2_000_000) as [string, number][]);
}

/**
 * Set or clear lines in an env file, keeping every other line as it was. An
 * empty value removes the key. Written 0600: the file holds API keys.
 */
export function setEnvValues(file: string, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) throw new Error(`refusing to write ${key}`);
  }
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    lines = [];
  }
  const keyOf = (line: string) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
  const pending = new Map(Object.entries(values));
  const kept: string[] = [];
  for (const line of lines) {
    const key = keyOf(line);
    if (key === undefined || !pending.has(key)) {
      kept.push(line);
      continue;
    }
    const value = pending.get(key)!;
    pending.delete(key);
    if (value !== '') kept.push(`${key}=${value}`);
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  for (const [key, value] of pending) if (value !== '') kept.push(`${key}=${value}`);
  fs.writeFileSync(file, `${kept.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
