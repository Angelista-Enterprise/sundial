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

  it("carries Gnomon's acts, its apps and goals, before the screen, so a search for its work finds the moment", () => {
    const text = momentEmbedText('Zed', { windowTitles: ['notes.md'], acts: { n: 3, apps: ['Spotify', 'TextEdit'], goals: ['play the album', 'append a line'] }, screenExcerpt: 'screen words' });
    expect(text).toBe('Zed notes.md Gnomon acted in Spotify, TextEdit: play the album; append a line screen words');
    expect(momentEmbedText('Zed', { windowTitles: [], acts: { n: 1, apps: [], goals: [] } })).toBe('Zed');
  });

  it('tags the text version on a moment vector without leaving its vector space', () => {
    expect(embeddingSpace(momentModelTag('minilm-384'))).toBe('minilm-384');
    expect(embeddingSpace('minilm-384')).toBe('minilm-384');
  });
});
