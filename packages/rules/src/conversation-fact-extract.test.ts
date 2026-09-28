import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { conversationFactExtract } from './conversation-fact-extract.js';

const boundary = (ts: string): SanitizedEvent => ({ id: `evt-${ts}`, type: 'day:boundary', ts, payload: {}, sanitized: true });

describe('conversationFactExtract', () => {
  it('ignores everything but the day boundary', () => {
    const state = createInitialState('dev');
    const tick: SanitizedEvent = { id: 't', type: 'clock:tick', ts: '2026-09-04T10:00:00.000Z', payload: {}, sanitized: true };
    expect(conversationFactExtract(state, tick)).toEqual({ state, effects: [] });
  });

  it('first pass reads the last 24 hours, then advances its own cursor', () => {
    const state = createInitialState('dev');
    const { state: next, effects } = conversationFactExtract(state, boundary('2026-09-04T22:00:00.000Z'));
    expect(effects).toEqual([{ type: 'RunConversationExtraction', since: '2026-09-03T22:00:00.000Z', ts: '2026-09-04T22:00:00.000Z' }]);
    expect(next.memory.lastConversationExtractAt).toBe('2026-09-04T22:00:00.000Z');
    // Untouched: the sibling pass keeps its own cursor.
    expect(next.memory.lastFactExtractAt).toBeNull();

    const { effects: later } = conversationFactExtract(next, boundary('2026-09-05T22:00:00.000Z'));
    expect(later).toEqual([{ type: 'RunConversationExtraction', since: '2026-09-04T22:00:00.000Z', ts: '2026-09-05T22:00:00.000Z' }]);
  });
});
