import { describe, expect, it } from 'vitest';
import { looksLikePersonName } from './person-name.js';

describe('looksLikePersonName', () => {
  it('accepts the names actually on this record', () => {
    for (const name of ['Alex', 'Jordan De Wit', 'Irina Petrova', 'Bob', "Anne O'Brien", 'Jean-Luc Picard', 'Elias Ernst']) {
      expect(looksLikePersonName(name)).toBe(true);
    }
  });

  it('rejects the question the ask rule once filed as a name', () => {
    expect(looksLikePersonName('in which meeting where they?')).toBe(false);
    expect(looksLikePersonName('Who is that')).toBe(false);
    expect(looksLikePersonName('no idea')).toBe(false);
    expect(looksLikePersonName('the guy from the crossword call')).toBe(false);
    expect(looksLikePersonName('He was in the meeting, I think')).toBe(false);
    expect(looksLikePersonName('')).toBe(false);
    expect(looksLikePersonName('?')).toBe(false);
  });
});
