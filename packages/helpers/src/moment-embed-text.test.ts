import { describe, it, expect } from 'vitest';
import { embeddingSpace, momentEmbedText, momentModelTag } from './moment-embed-text.js';

describe('momentEmbedText', () => {
  it('leads with the narrative, then app, titles, speech, pages and a little screen', () => {
    const text = momentEmbedText('Arc', {
      narrative: 'Reviewing the hint strategy with Marco.',
      windowTitles: ['tango — hints'],
      spokenExcerpt: 'we gooien de hints om',
      pages: ['github.com/acme/tango'],
      screenExcerpt: 'x'.repeat(1000),
    });
    expect(text.startsWith('Reviewing the hint strategy with Marco. Arc tango — hints we gooien de hints om github.com/acme/tango')).toBe(true);
    expect(text.length).toBeLessThan(600);
  });

  it('falls back to the intent when there is no narrative, and skips what is missing', () => {
    expect(momentEmbedText('Claude', { intent: { text: 'Writing the plan' }, windowTitles: [] })).toBe('Writing the plan Claude');
  });

  it('tags the text version on a moment vector without leaving its vector space', () => {
    expect(embeddingSpace(momentModelTag('minilm-384'))).toBe('minilm-384');
    expect(embeddingSpace('minilm-384')).toBe('minilm-384');
  });
});
