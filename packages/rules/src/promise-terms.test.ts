import { describe, expect, it } from 'vitest';
import { counterpartyIn, defaultDue, keyNouns, namesDeliverable, parseDue, parseStatedPromise } from './promise-terms.js';
import { parseMeetingPromises } from './promise-extract.js';

const TZ = 'Europe/Amsterdam';
// Thursday 2026-10-01, 12:00 in Amsterdam.
const THU = '2026-10-01T10:00:00.000Z';

describe('the terms of a promise (UC1 U1-F14 F15 F16 F17)', () => {
  it('resolves a due date against when it was said, in the owner\'s timezone', () => {
    expect(parseDue('dinsdag', THU, TZ)).toBe('2026-10-06T15:00:00.000Z'); // said Thursday: next Tuesday, 17:00
    expect(parseDue('by Tuesday', THU, TZ)).toBe('2026-10-06T15:00:00.000Z');
    expect(parseDue('EOD', THU, TZ)).toBe('2026-10-01T15:00:00.000Z');
    expect(parseDue('morgen', THU, TZ)).toBe('2026-10-02T15:00:00.000Z');
    expect(parseDue('vanavond', THU, TZ)).toBe('2026-10-01T19:00:00.000Z');
    expect(parseDue('before Friday', THU, TZ)).toBe('2026-10-02T15:00:00.000Z');
    expect(parseDue('donderdag', THU, TZ), 'the same weekday is next week').toBe('2026-10-08T15:00:00.000Z');
    expect(parseDue('volgende week', THU, TZ), 'next week is its Friday').toBe('2026-10-09T15:00:00.000Z');
    expect(parseDue('over 2 dagen', THU, TZ)).toBe('2026-10-03T15:00:00.000Z');
    expect(parseDue('later', THU, TZ)).toBeNull();
    expect(parseDue(null, THU, TZ)).toBeNull();
  });

  it('defaults to three working days, skipping the weekend', () => {
    expect(defaultDue(THU, TZ)).toBe('2026-10-06T15:00:00.000Z'); // Fri, Mon, Tue
  });

  it('keeps the deliverable\'s nouns, and matches them in a file name, a subject or a tab title', () => {
    expect(keyNouns('the draft')).toEqual(['draft']);
    expect(keyNouns('send the Q3 board deck')).toEqual(['q3', 'board', 'deck']);
    expect(keyNouns('fix BOX-484')).toEqual(['box-484']);
    expect(keyNouns('de notulen')).toEqual(['notul']);
    expect(keyNouns('it')).toEqual([]);
    expect(namesDeliverable(['draft'], 'Re: Draft v2')).toBe(true);
    expect(namesDeliverable(['q3', 'board', 'deck'], 'board-deck-final.key')).toBe(true);
    expect(namesDeliverable(['q3', 'board', 'deck'], 'notes.md')).toBe(false);
    expect(namesDeliverable(['box-484'], 'BOX-484 hint borders')).toBe(true);
    expect(namesDeliverable(['draft'], 'Lunch on Friday')).toBe(false);
    expect(namesDeliverable([], 'anything')).toBe(false);
  });

  it('finds whom it is owed to among the people who were there, or nobody', () => {
    const people = ['Mira Bakker', 'Bob Jansen', 'pat'];
    expect(counterpartyIn("I'll send you the draft", ['Mira Bakker', 'pat'], ['pat']), 'a 1:1').toBe('Mira Bakker');
    expect(counterpartyIn('Bob, I will do it', people, ['pat'])).toBe('Bob Jansen');
    expect(counterpartyIn('I will do it', people, ['pat']), 'a group, nobody named').toBeNull();
    expect(counterpartyIn('I will do it', ['person-0123456789', 'pat'], ['pat']), 'a hashed 1:1 is still the one person').toBe('person-0123456789');
  });

  it('reads a promise the owner states in their own words', () => {
    const opts = { ts: THU, tz: TZ, attendees: ['Mira Bakker', 'Bob Jansen', 'pat'], ownerAliases: ['pat'] };
    expect(parseStatedPromise('I owe Mira the draft by Tuesday', opts)).toEqual({ counterparty: 'Mira Bakker', deliverable: 'the draft', due: '2026-10-06T15:00:00.000Z', dueText: 'by Tuesday' });
    expect(parseStatedPromise("I promised Bob I'd review the PR", opts)).toMatchObject({ counterparty: 'Bob Jansen', deliverable: 'review the PR', due: null });
    expect(parseStatedPromise('ik stuur Mira morgen de notulen', opts)).toMatchObject({ counterparty: 'Mira Bakker', deliverable: 'de notulen', due: '2026-10-02T15:00:00.000Z' });
    expect(parseStatedPromise('I owe Mira Bakker the deck', { ts: THU, tz: TZ })).toMatchObject({ counterparty: 'Mira Bakker', deliverable: 'the deck' });
    expect(parseStatedPromise('No, nothing', opts)).toBeNull();
    expect(parseStatedPromise('It went fine', opts)).toBeNull();
  });
});

describe('the meeting pass keeps only what it can ground (U1-F2)', () => {
  const transcript = "pat: Okay, then I'll send you the draft by Tuesday.\nMira Bakker: Great, and I will share the numbers tomorrow.";
  it('keeps grounded promises, names only attendees, and drops the invented and the foreign', () => {
    const answer = JSON.stringify([
      { who: 'owner', kind: 'promise', to: 'Mira Bakker', what: 'the draft', due: 'by Tuesday', quote: "I'll send you the draft by Tuesday" },
      { who: 'other', kind: 'promise', to: 'mira bakker', what: 'the numbers', due: 'tomorrow', quote: 'I will share the numbers tomorrow' },
      { who: 'owner', kind: 'promise', to: 'Someone Else', what: 'a contract', due: null, quote: 'I will sign the contract on Monday morning' },
      { who: 'owner', kind: 'promise', to: null, what: 'x', due: null, quote: '¿Te acuerdas que falta un trato?' },
      { who: 'owner', kind: 'promise', to: null, what: '', due: null, quote: "I'll send you the draft" },
    ]);
    const out = parseMeetingPromises(`\`\`\`json\n${answer}\n\`\`\``, transcript, ['Mira Bakker']);
    expect(out).toEqual([
      { who: 'owner', kind: 'promise', to: 'Mira Bakker', what: 'the draft', due: 'by Tuesday', quote: "I'll send you the draft by Tuesday" },
      { who: 'other', kind: 'promise', to: 'Mira Bakker', what: 'the numbers', due: 'tomorrow', quote: 'I will share the numbers tomorrow' },
    ]);
    expect(parseMeetingPromises('not json', transcript, [])).toEqual([]);
    expect(parseMeetingPromises('{"a":1}', transcript, [])).toEqual([]);
  });

  it('owes nothing to a room or a mailing list, and keeps what a cut-off reply finished', () => {
    const transcript = "I'll send you the draft by Tuesday. And then we will talk about the rest of the plan";
    const one = JSON.stringify({ who: 'owner', kind: 'promise', to: 'Room-2-04 (8)', what: 'the draft', due: 'by Tuesday', quote: "I'll send you the draft by Tuesday" });
    expect(parseMeetingPromises(`[${one}]`, transcript, ['Room-2-04 (8)', 'design-team'])[0]?.to).toBeNull();
    const guessed = JSON.stringify({ who: 'owner', kind: 'promise', to: 'Tess de Wit', what: 'the draft', due: null, quote: "I'll send you the draft by Tuesday" });
    expect(parseMeetingPromises(`[${guessed}]`, transcript, ['Tess de Wit'])[0]?.to, 'on the invite, never said').toBeNull();
    expect(parseMeetingPromises(`[${one}, {"who": "owner", "quote": "And then we will talk about the rest of`, transcript, [])).toHaveLength(1);
  });
});
