import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { env } from '@xenova/transformers';
import { computeModelEmbedding } from './model-embedding.js';

/**
 * The sharp override (pnpm-workspace.yaml) is safe only while transformers still
 * loads with it: the import above runs its `import sharp from 'sharp'`. The real
 * model runs only when this checkout already has it cached; a test never downloads it.
 */
const cached = existsSync(join(env.cacheDir, 'Xenova', 'all-MiniLM-L6-v2'));

describe('local embeddings under the sharp override', () => {
  it('@xenova/transformers loads', () => {
    expect(typeof env.cacheDir).toBe('string');
  });

  it.skipIf(!cached)('the cached model still embeds: 384 dims, a paraphrase closer than an unrelated line', async () => {
    env.allowRemoteModels = false;
    const [a, b, c] = await Promise.all(['debugging the payment flow', 'fixing the billing bug', 'watching a movie tonight'].map(computeModelEmbedding));
    const dot = (x: number[], y: number[]) => x.reduce((n, v, i) => n + v * y[i]!, 0);
    expect(a!.length).toBe(384);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!) + 0.2);
  }, 60_000);
});
