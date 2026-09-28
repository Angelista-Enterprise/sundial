import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeLocalEmbedding, cosineSimilarity, computeEmbedding, getEmbeddingConfig, LOCAL_EMBEDDING_MODEL } from './local-embedding.js';

// Mock the in-process model so tests never load the real ~90MB ONNX model.
// computeEmbedding dynamically imports this module, so the mock is what it sees.
const mockComputeModelEmbedding = vi.fn(async (_text: string) => [0.9, 0.1, 0.0]);
vi.mock('./model-embedding.js', () => ({
  computeModelEmbedding: (text: string) => mockComputeModelEmbedding(text),
  LOCAL_MODEL_EMBEDDING_MODEL: 'local-minilm-384-v1',
  resetEmbeddingPipelineForTests: () => {},
}));

describe('computeLocalEmbedding', () => {
  it('is deterministic for the same text', () => {
    const a = computeLocalEmbedding('debugging the payment webhook');
    const b = computeLocalEmbedding('debugging the payment webhook');
    expect(a).toEqual(b);
  });

  it('produces a unit-normalized vector for non-empty text', () => {
    const v = computeLocalEmbedding('some real words here');
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('returns an all-zero vector for empty/whitespace-only text', () => {
    const v = computeLocalEmbedding('   ');
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(computeLocalEmbedding('Payment Webhook')).toEqual(computeLocalEmbedding('payment webhook'));
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical text embeddings', () => {
    const v = computeLocalEmbedding('debugging the reducer');
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('is higher for texts sharing words than for texts sharing none', () => {
    const a = computeLocalEmbedding('debugging the payment webhook flow');
    const b = computeLocalEmbedding('still stuck on the payment webhook issue');
    const c = computeLocalEmbedding('watching a movie with friends tonight');

    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });

  it('returns 0 for mismatched vector lengths', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe('getEmbeddingConfig (PE — server is now opt-in)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns null when no embedding server is configured (the in-process model is the default)', () => {
    delete process.env.SUNDIAL_EMBEDDING_BASE_URL;
    expect(getEmbeddingConfig()).toBeNull();
  });

  it('returns config only when SUNDIAL_EMBEDDING_BASE_URL is explicitly set', () => {
    process.env.SUNDIAL_EMBEDDING_BASE_URL = 'http://localhost:9999/v1';
    process.env.SUNDIAL_EMBEDDING_MODEL = 'mxbai-embed-large';
    process.env.SUNDIAL_EMBEDDING_API_KEY = 'secret';
    expect(getEmbeddingConfig()).toEqual({ baseUrl: 'http://localhost:9999/v1', model: 'mxbai-embed-large', apiKey: 'secret' });
  });

  it('ignores a server that is not on this Mac — embeddings never leave the machine', () => {
    process.env.SUNDIAL_EMBEDDING_BASE_URL = 'https://api.example.com/v1';
    expect(getEmbeddingConfig()).toBeNull();
  });
});

describe('computeEmbedding (PE — in-process model primary, server opt-in, hash fallback)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockComputeModelEmbedding.mockReset();
    mockComputeModelEmbedding.mockResolvedValue([0.9, 0.1, 0.0]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('uses the in-process sentence-transformer by default (no server configured)', async () => {
    vi.unstubAllEnvs();
    delete process.env.SUNDIAL_EMBEDDING_BASE_URL;
    const result = await computeEmbedding('debugging the payment webhook');
    expect(result.vector).toEqual([0.9, 0.1, 0.0]);
    expect(result.model).toBe('local-minilm-384-v1');
    expect(mockComputeModelEmbedding).toHaveBeenCalledOnce();
  });

  it('prefers a configured server over the in-process model when it succeeds', async () => {
    vi.stubEnv('SUNDIAL_EMBEDDING_BASE_URL', 'http://localhost:11434/v1');
    vi.stubEnv('SUNDIAL_EMBEDDING_MODEL', 'nomic-embed-text');
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 })) as unknown as typeof fetch;
    const result = await computeEmbedding('x');
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.model).toBe('server-nomic-embed-text-v1');
    expect(mockComputeModelEmbedding).not.toHaveBeenCalled();
  });

  it('falls THROUGH from an unreachable server to the in-process model (not straight to hash)', async () => {
    vi.stubEnv('SUNDIAL_EMBEDDING_BASE_URL', 'http://localhost:11434/v1');
    global.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await computeEmbedding('x');
    expect(result.model).toBe('local-minilm-384-v1');
    expect(mockComputeModelEmbedding).toHaveBeenCalledOnce();
  });

  it('falls back to the hashing trick only when the in-process model itself fails (offline first-run)', async () => {
    vi.unstubAllEnvs();
    delete process.env.SUNDIAL_EMBEDDING_BASE_URL;
    mockComputeModelEmbedding.mockRejectedValue(new Error('model download failed'));
    const result = await computeEmbedding('debugging the payment webhook');
    expect(result.vector).toEqual(computeLocalEmbedding('debugging the payment webhook'));
    expect(result.model).toBe(LOCAL_EMBEDDING_MODEL);
  });
});
