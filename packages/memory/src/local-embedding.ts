const DIMENSIONS = 256;

/** Identifies this embedding scheme in `memory_embeddings.model` — bump if the hashing/normalization scheme ever changes, so old vectors aren't compared against new ones as if they were the same space. */
export const LOCAL_EMBEDDING_MODEL = 'local-hash-256-v1';

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** FNV-1a — fast, deterministic, no external dependency; only needs to distribute tokens across buckets, not resist adversarial collisions. */
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A hashing-trick bag-of-words vector: deterministic, fully local (no
 * network call, no model download), computed only over already-sanitized
 * text. D1 (docs/audit/production-proposal-and-enhancements.md, fixes
 * A§5.4) demotes this from the primary embedding to `computeEmbedding`'s
 * fallback — kept exactly as it was, since it's still what runs when no
 * local embedding server is reachable.
 */
export function computeLocalEmbedding(text: string): number[] {
  const vector = new Array(DIMENSIONS).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const bucket = hashToken(token) % DIMENSIONS;
    vector[bucket] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * PE (docs/design/07) — an OpenAI-compatible `/embeddings` server is now
 * OPT-IN, used only when `SUNDIAL_EMBEDDING_BASE_URL` is explicitly set (a power
 * user pointing at their own Ollama with a heavier model). It is no longer the
 * default: the in-process sentence-transformer (`computeModelEmbedding`) is,
 * so real semantic embeddings work with zero setup and no server.
 */
let warnedRemote = false;

export function isLoopbackUrl(url: string): boolean {
  try {
    return /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function getEmbeddingConfig(): EmbeddingConfig | null {
  const baseUrl = process.env.SUNDIAL_EMBEDDING_BASE_URL;
  if (!baseUrl) return null;
  // Embeddings stay on this Mac, by decision: a server here must be loopback.
  // A remote URL is ignored (the in-process model runs instead), never used.
  if (!isLoopbackUrl(baseUrl)) {
    if (!warnedRemote) console.warn(`[sundial-memory] SUNDIAL_EMBEDDING_BASE_URL is not on this Mac (${baseUrl}); ignored — embeddings stay local.`);
    warnedRemote = true;
    return null;
  }
  return {
    baseUrl,
    model: process.env.SUNDIAL_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    apiKey: process.env.SUNDIAL_EMBEDDING_API_KEY ?? null,
  };
}

export interface ComputedEmbedding {
  vector: number[];
  model: string;
}

async function tryServerEmbedding(config: EmbeddingConfig, text: string): Promise<ComputedEmbedding | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.model, input: text }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`embedding endpoint returned ${response.status}`);
    const parsed = (await response.json()) as { data?: { embedding?: number[] }[] };
    const vector = parsed.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) throw new Error('embedding endpoint returned no vector');
    return { vector, model: `server-${config.model}-v1` };
  } catch (error) {
    console.warn(`[memory] configured embedding server unreachable (${(error as Error).message}) — falling through.`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * PE (docs/design/07) — real semantic embeddings, in this priority:
 *   1. an explicitly-configured `/embeddings` server (`SUNDIAL_EMBEDDING_BASE_URL`), if set;
 *   2. the in-process `all-MiniLM-L6-v2` sentence-transformer (the zero-setup default);
 *   3. the hashing-trick bag-of-words vector, as the last-resort fallback that
 *      keeps ingestion working when the model can't load (offline first-run, disk).
 *
 * The returned `model` tag is the scheme that ACTUALLY produced the vector —
 * callers persist it into `memory_embeddings.model` so `cosineSimilarity`/
 * `scoredSearch` never compare vectors from different spaces (a dimension
 * mismatch already scores 0). Different tags coexist in the table until the old
 * ones age out via retention, so swapping the hashing trick for the real model
 * needs no migration.
 *
 * Local-only throughout (docs/design/00 decision #5, `CLAUDE.md`'s "no
 * remote-embedding code path"): the model runs on-device; the optional server
 * is a loopback call to something the user runs themselves.
 */
export async function computeEmbedding(text: string): Promise<ComputedEmbedding> {
  const serverConfig = getEmbeddingConfig();
  if (serverConfig) {
    const served = await tryServerEmbedding(serverConfig, text);
    if (served) return served;
  }

  try {
    const { computeModelEmbedding, LOCAL_MODEL_EMBEDDING_MODEL } = await import('./model-embedding.js');
    return { vector: await computeModelEmbedding(text), model: LOCAL_MODEL_EMBEDDING_MODEL };
  } catch (error) {
    console.warn(`[memory] in-process embedding model unavailable (${(error as Error).message}) — falling back to the hashing-trick embedding.`);
    return { vector: computeLocalEmbedding(text), model: LOCAL_EMBEDDING_MODEL };
  }
}
