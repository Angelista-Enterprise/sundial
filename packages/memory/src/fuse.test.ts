import { describe, it, expect } from 'vitest';
import { bm25, reciprocalRankFusion, tokenize } from './fuse.js';

describe('tokenize', () => {
  it('keeps identifiers intact enough to match, lowercased', () => {
    expect(tokenize('BOX-508 compact header')).toEqual(['box', '508', 'compact', 'header']);
  });

  it('drops single characters, which carry no retrieval signal', () => {
    expect(tokenize('a b cd')).toEqual(['cd']);
  });
});

describe('bm25', () => {
  const docs = [
    { id: 'a', text: 'moment Code gnomon working on BOX-508 compact header' },
    { id: 'b', text: 'moment Chrome reading the news' },
    { id: 'c', text: 'knowledge entry about the compact header redesign' },
  ];

  it('finds the rare identifier an embedding model would blur', () => {
    const scores = bm25('BOX-508', docs);
    expect([...scores.keys()]).toEqual(['a']);
  });

  it('ranks the more focused document above the incidental mention', () => {
    const scores = bm25('compact header', docs);
    expect(scores.has('a')).toBe(true);
    expect(scores.has('c')).toBe(true);
    // 'c' is shorter and more about the phrase, so length normalisation should lift it.
    expect(scores.get('c')!).toBeGreaterThan(scores.get('a')!);
  });

  it('omits non-matching documents entirely rather than scoring them zero', () => {
    // A tail of zero-scored documents would be rewarded by rank fusion for placing
    // above nothing, which is the failure this omission prevents.
    const scores = bm25('nonexistent', docs);
    expect(scores.size).toBe(0);
  });

  it('ignores stop words so a natural-language question does not match everything', () => {
    expect(bm25('what is the', docs).size).toBe(0);
  });

  it('returns nothing for an empty corpus or empty query', () => {
    expect(bm25('anything', []).size).toBe(0);
    expect(bm25('', docs).size).toBe(0);
  });
});

describe('reciprocalRankFusion', () => {
  it('rewards an item both retrievers rank well over one retriever’s favourite', () => {
    const semantic = new Map([
      ['a', 0.9],
      ['b', 0.8],
    ]);
    const lexical = new Map([
      ['b', 12],
      ['c', 11],
    ]);

    const fused = reciprocalRankFusion([semantic, lexical]);
    // 'b' is second in one and first in the other; 'a' is first in only one.
    expect(fused.get('b')!).toBeGreaterThan(fused.get('a')!);
    expect(fused.get('b')!).toBeGreaterThan(fused.get('c')!);
  });

  it('fuses by rank, so incommensurable score scales cannot distort the result', () => {
    // The lexical scores here are three orders of magnitude larger. Any
    // score-additive fusion would let them dominate outright; RRF must not.
    const semantic = new Map([['a', 0.99]]);
    const lexical = new Map([['b', 5000]]);

    const fused = reciprocalRankFusion([semantic, lexical]);
    expect(fused.get('a')).toBe(fused.get('b'));
  });

  it('degrades to the single ranking it is given', () => {
    const only = new Map([
      ['a', 3],
      ['b', 1],
    ]);
    const fused = reciprocalRankFusion([only]);
    expect(fused.get('a')!).toBeGreaterThan(fused.get('b')!);
  });
});

describe('lexicalWeightFor', () => {
  it('gives an identifier-shaped query the full lexical vote and prose a boost', async () => {
    const { lexicalWeightFor } = await import('./fuse.js');
    for (const q of ['PBX-689', 'claude-plan-ohno-svelte5', 'moment-rollup.ts', 'reduceAndRule', '#4357', 'webhook']) {
      expect(lexicalWeightFor(q), q).toBe(1);
    }
    for (const q of ['what did I work on yesterday afternoon', 'Claude-heavy afternoon with rapid app switching', 'the payment webhook']) {
      expect(lexicalWeightFor(q), q).toBe(0.3);
    }
  });

  it('weighted fusion lets a strong retriever outvote a weak one', async () => {
    const { reciprocalRankFusion } = await import('./fuse.js');
    const a = new Map([['x', 2], ['y', 1]]);
    const b = new Map([['y', 2], ['x', 1]]);
    const equal = reciprocalRankFusion([a, b]);
    expect(equal.get('x')).toBeCloseTo(equal.get('y')!, 10);
    const weighted = reciprocalRankFusion([a, b], 60, [1, 0.3]);
    expect(weighted.get('x')!).toBeGreaterThan(weighted.get('y')!);
  });
});
