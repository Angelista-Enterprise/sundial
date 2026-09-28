import { describe, it, expect } from 'vitest';
import {
  canonicalizeConversationCandidate,
  conversationExtractionInstructions,
  formatTranscript,
  selectOwnerTurns,
  MAX_CONVERSATION_CONFIDENCE,
  MAX_TURN_CHARS,
  type RawSessionEvent,
} from './conversation-extract.js';

const T0 = Date.parse('2026-09-04T08:00:00.000Z');
const owner = (time: number, text: string, kind?: string): RawSessionEvent => ({
  type: 'user/message',
  time,
  data: { ...(kind ? { source: { kind } } : {}), content: [{ type: 'text', text }] },
});

describe('selectOwnerTurns', () => {
  it('keeps only what the owner typed, inside the window', () => {
    const events: RawSessionEvent[] = [
      owner(T0 - 1, 'too early: my partner is called Sam'),
      owner(T0 + 1000, 'I usually go climbing on Thursdays'),
      owner(T0 + 2000, 'ok'),
      owner(T0 + 3000, 'The owner is looking at: Today.', 'plugin'),
      { type: 'assistant/message', time: T0 + 4000, data: { content: [{ type: 'text', text: 'Noted — you climb on Thursdays.' }] } },
      owner(T0 + 5000, 'Also, I dislike meetings before 10'),
      owner(T0 + 999_999_999, 'too late'),
    ];
    const turns = selectOwnerTurns('s1', events, T0, T0 + 10_000);
    expect(turns.map((turn) => turn.text)).toEqual(['I usually go climbing on Thursdays', 'Also, I dislike meetings before 10']);
    expect(turns[0]).toMatchObject({ sessionId: 's1', at: new Date(T0 + 1000).toISOString() });
  });

  it('truncates a paste rather than dropping it — the first line is usually the owner\'s own', () => {
    const long = `Here is the log: ${'x'.repeat(5000)}`;
    const [turn] = selectOwnerTurns('s1', [owner(T0, long)], T0, T0 + 1);
    expect(turn.text.length).toBe(MAX_TURN_CHARS + 1);
    expect(turn.text.startsWith('Here is the log:')).toBe(true);
  });
});

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
