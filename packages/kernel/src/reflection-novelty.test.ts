import { describe, expect, it } from 'vitest';
import { repeatsRecent, titleSimilarity } from './reflection-novelty.js';

describe('reflection novelty', () => {
  it('sees the live repeats for what they are', () => {
    expect(repeatsRecent('Claude-heavy afternoon with rapid app switching', ['Claude-heavy day with rapid context switching'])).not.toBeNull();
    expect(repeatsRecent('Afternoon Chrome/Claude alternation, evening Claude block', ['Afternoon Chrome/Claude alternation, evening WhatsApp block'])).not.toBeNull();
  });

  it('lets a different finding through', () => {
    expect(repeatsRecent('Morning messaging block, then deep Claude focus', ['Claude-heavy afternoon with rapid app switching'])).toBeNull();
    expect(repeatsRecent('Day end drifting later by 20 min a day', ['Morning Claude focus with brief interruptions'])).toBeNull();
  });

  it('ignores stop words and case', () => {
    expect(titleSimilarity('The Claude focus', 'claude FOCUS')).toBe(1);
    expect(titleSimilarity('', 'anything')).toBe(0);
  });
});
