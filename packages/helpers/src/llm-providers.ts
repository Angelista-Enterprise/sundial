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

export interface LlmProvider {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}

const KNOWN_HOSTS: [RegExp, string][] = [
  [/^api\.openai\.com$/, 'OpenAI'],
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
export function chatDefault<S extends { provider: string; model: string }>(selection: S, llm: { providers: LlmProvider[]; use: Record<string, string> } | undefined, ownRoute = Boolean(process.env.SUNDIAL_LLM_BASE_URL)): S {
  if (ownRoute || (selection.provider !== DEFAULT_PROVIDER && selection.provider !== LEGACY_PROVIDER)) return selection;
  const p = llm?.providers.find((x) => x.id === llm.use.default);
  return p ? { ...selection, provider: p.id, model: p.model } : selection;
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

/** A provider id the config may use: a short slug, and never the default route's names. */
export function isProviderId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(id) && id !== DEFAULT_PROVIDER && id !== LEGACY_PROVIDER;
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

/** `config.json`'s `llm.providers`, shape-checked; a bad entry is dropped, not fatal. */
export function parseProviders(raw: unknown): LlmProvider[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: LlmProvider[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    if (!p || !isProviderId(p.id) || seen.has(p.id) || !isHttpUrl(p.baseUrl) || typeof p.model !== 'string' || p.model.trim() === '') continue;
    seen.add(p.id);
    const baseUrl = p.baseUrl.replace(/\/+$/, '');
    out.push({ id: p.id, baseUrl, model: p.model.trim(), label: typeof p.label === 'string' && p.label.trim() !== '' ? p.label.trim() : providerLabel(baseUrl) });
  }
  return out;
}

/** `config.json`'s `llm.use`: purpose (or `default`) → route id. Which ids exist is checked where it is used, so a removed provider falls back instead of failing. */
export function parseUse(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k, v]) => /^[a-z]+$/.test(k) && typeof v === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(v)) as [string, string][]);
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
