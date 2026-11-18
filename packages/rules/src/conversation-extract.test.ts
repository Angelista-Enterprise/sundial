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

describe('transcriptChunks (LongMemEval, 2026-11-17: a 240-turn day lost its first nine tenths)', () => {
  const turn = (i: number, day = '2026-09-04') => ({ sessionId: `s${i}`, at: `${day}T${String(8 + (i % 10)).padStart(2, '0')}:00:00.000Z`, text: `turn ${i} ${'x'.repeat(40)}` });

  it('keeps every turn, oldest first, in chunks under the cap', async () => {
    const { transcriptChunks } = await import('./conversation-extract.js');
    const turns = Array.from({ length: 30 }, (_, i) => turn(i));
    const chunks = transcriptChunks(turns, 400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 400)).toBe(true);
    const lines = chunks.flatMap((c) => c.text.split('\n'));
    expect(lines).toHaveLength(30);
    expect(lines[0]).toContain('turn 0 ');
    expect(lines[29]).toContain('turn 29 ');
  });

  it('marks a Gnomon line, and dates a fact to its day or else the chunk\'s last line', async () => {
    const { transcriptChunks, factInstant } = await import('./conversation-extract.js');
    const [chunk] = transcriptChunks([turn(1, '2026-09-03'), { ...turn(2, '2026-09-04'), by: 'gnomon' as const }]);
    expect(chunk!.text.split('\n')[1]).toBe(`[2026-09-04T10:00 · s2] (Gnomon) turn 2 ${'x'.repeat(40)}`);
    expect(chunk!.days).toEqual(['2026-09-03', '2026-09-04']);
    expect(factInstant(chunk!, '2026-09-03')).toBe('2026-09-03T09:00:00.000Z');
    expect(factInstant(chunk!, '2026-08-01')).toBe('2026-09-04T10:00:00.000Z');
    expect(factInstant(chunk!, undefined)).toBe('2026-09-04T10:00:00.000Z');
  });

  it('asks for concrete events with their date, many per call', async () => {
    const { MAX_CONVERSATION_FACTS } = await import('./conversation-extract.js');
    const text = conversationExtractionInstructions('pat');
    expect(MAX_CONVERSATION_FACTS).toBeGreaterThan(10);
    expect(text).toContain(`up to ${MAX_CONVERSATION_FACTS} objects`);
    expect(text).toContain('"at": "YYYY-MM-DD"');
    expect(text).toContain('A past event is worth keeping with its date');
    expect(text).not.toContain('most days, nothing does');
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
