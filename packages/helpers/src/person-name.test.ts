import { describe, expect, it } from 'vitest';
import { isMeetingRoom, looksLikePersonName } from './person-name.js';

describe('looksLikePersonName', () => {
  it('accepts the names actually on this record', () => {
    for (const name of ['Alex', 'Jordan De Wit', 'Irina Petrova', 'Bob', "Nora O'Brien", 'Jean-Luc Picard', 'Elias Ernst']) {
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

describe('isMeetingRoom', () => {
  it('knows a room by its capacity or by its site code, and never a person', () => {
    for (const room of ['HQ-2-14 (8)', 'HQ-3-02 - The Long Room (14)', 'LAB-5-04-INTERNAL (4)', 'HQ-2-14', 'Aquarium (6)']) expect(isMeetingRoom(room), room).toBe(true);
    for (const human of ['Mira Bakker', 'Alex Morgan', 'person-c205ca11f2', 'Tess de Wit', '', null]) expect(isMeetingRoom(human), String(human)).toBe(false);
  });
});
