import { describe, expect, it } from 'vitest';
import { recentlyAnswered, sameQuestion } from './asked.js';

/**
 * The predicate that stops the double ask. Shared by the `ownerAsk` reducer and
 * the `gnomon_ask_owner` tool — it lived in both as a copy first, which is how
 * a tool comes to refuse a question the reducer accepts.
 */
const NOW = '2026-09-07T12:00:00.000Z';
const answered = (question: string, answeredAt: string) => ({ askId: 'a1', question, answer: 'fine', answeredAt });

describe('sameQuestion', () => {
  it('ignores case, spacing and the punctuation a question carries', () => {
    expect(sameQuestion('How did "Standup" go?', 'how did standup go')).toBe(true);
    expect(sameQuestion('  How   did it go? ', 'How did it go?')).toBe(true);
    expect(sameQuestion('How did Standup go?', 'How did the retro go?')).toBe(false);
  });
});

describe('recentlyAnswered', () => {
  it('finds the repeat inside the window and forgets it after', () => {
    const recent = [answered('How did "RRA: Kruiswoorden testen" go?', '2026-09-07T09:00:00.000Z')];
    expect(recentlyAnswered(recent, 'How did "RRA: Kruiswoorden testen" go?', NOW)?.askId).toBe('a1');
    // Seven hours later the same words are a new question about a new meeting.
    expect(recentlyAnswered(recent, 'How did "RRA: Kruiswoorden testen" go?', '2026-09-07T16:30:00.000Z')).toBeNull();
  });

  it('is empty-safe', () => {
    expect(recentlyAnswered(undefined, 'anything', NOW)).toBeNull();
    expect(recentlyAnswered([], 'anything', NOW)).toBeNull();
  });
});
