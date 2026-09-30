import { describe, it, expect } from 'vitest';
import {
  canonicalizeConversationCandidate,
  conversationExtractionInstructions,
  formatTranscript,
  MAX_CONVERSATION_CONFIDENCE,
} from './conversation-extract.js';

describe('formatTranscript', () => {
  it('tags each line with day-time and session, and keeps the NEWEST lines under a cap', () => {
    const turns = [
      { sessionId: 'a', at: '2026-09-04T08:00:00.000Z', text: 'first thing\nin the morning' },
      { sessionId: 'b', at: '2026-09-04T20:00:00.000Z', text: 'last thing at night' },
    ];
    const full = formatTranscript(turns);
    expect(full.split('\n')).toEqual(['[2026-09-04T08:00 · a] first thing in the morning', '[2026-09-04T20:00 · b] last thing at night']);
    const capped = formatTranscript(turns, 60);
    expect(capped).toBe('[2026-09-04T20:00 · b] last thing at night');
  });
});

describe('canonicalizeConversationCandidate', () => {
  const aliases = ['pat', 'Pat Ang', 'person-c8cd3c6427'];
  const base = { predicate: 'prefers', object: 'async over meetings', confidence: 95 };

  it('folds the owner onto the owner kind whatever alias or kind the model used, and caps confidence', () => {
    expect(canonicalizeConversationCandidate({ ...base, entityKind: 'person', canonicalName: 'Pat Ang' }, aliases)).toEqual({
      ...base,
      entityKind: 'owner',
      canonicalName: 'pat',
      confidence: MAX_CONVERSATION_CONFIDENCE,
    });
    expect(canonicalizeConversationCandidate({ ...base, entityKind: 'topic', canonicalName: 'PAT' }, aliases)?.entityKind).toBe('owner');
    expect(canonicalizeConversationCandidate({ ...base, entityKind: 'owner', canonicalName: 'person-c8cd3c6427' }, aliases)?.canonicalName).toBe('pat');
  });

  it('drops an "owner" that is somebody else, and leaves other people alone', () => {
    expect(canonicalizeConversationCandidate({ ...base, entityKind: 'owner', canonicalName: 'Sam' }, aliases)).toBeNull();
    expect(canonicalizeConversationCandidate({ ...base, entityKind: 'person', canonicalName: 'Sam', confidence: 60 }, aliases)).toEqual({
      ...base,
      entityKind: 'person',
      canonicalName: 'Sam',
      confidence: 60,
    });
  });
});

describe('conversationExtractionInstructions', () => {
  it('names the owner, forbids making them a person, and bounds confidence', () => {
    const text = conversationExtractionInstructions('pat');
    expect(text).toContain('entityKind "owner" with canonicalName "pat"');
    expect(text).toContain('Never make the owner a "person"');
    expect(text).toContain(`Never above ${MAX_CONVERSATION_CONFIDENCE}`);
    expect(text).toContain('Respond with [] when nothing qualifies');
  });
});

describe('promises told to Gnomon in passing (UC1 U1-F11)', () => {
  it('opens only a promise stated outright to a named person, never a request to the assistant', async () => {
    const { promisesInTurns } = await import('./conversation-extract.js');
    const turn = (text: string) => ({ sessionId: 's1', at: '2026-10-01T10:00:00.000Z', text });
    const found = promisesInTurns([turn("Remind me: I owe Mira the draft by Tuesday. Also I'll look at the logs."), turn('ik heb Bob beloofd dat ik morgen de notulen stuur'), turn("I'll send the deck later"), turn('I promised to be careful')], 'Europe/Amsterdam');
    expect(found.map((f) => [f.counterparty, f.deliverable, f.dueText])).toEqual([
      ['Mira', 'the draft', 'by Tuesday'],
      ['Bob', 'de notulen', 'morgen'],
    ]);
  });
});
