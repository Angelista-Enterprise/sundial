import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { contextUrlClassify } from './context-url-classify.js';

function windowEvent(ts: string, windowTitle: string, processName = 'Chrome'): SanitizedEvent {
  return { id: 'e1', type: 'window:changed', ts, payload: { processName, windowTitle }, sanitized: true };
}

describe('contextUrlClassify', () => {
  it('detects a Jira-ticket-shaped title and emits document:opened', () => {
    const state = createInitialState('d1');
    const { effects } = contextUrlClassify(state, windowEvent('2026-01-01T00:00:00.000Z', 'GNOM-123 — fix the thing · MyOrg'));

    expect(effects).toHaveLength(1);
    const event = (effects[0] as any).event;
    expect(event.type).toBe('document:opened');
    expect(event.payload).toMatchObject({ kind: 'jira-ticket', id: 'GNOM-123' });
  });

  it('detects a Google Search title and emits search:performed', () => {
    const state = createInitialState('d1');
    const { effects } = contextUrlClassify(state, windowEvent('2026-01-01T00:00:00.000Z', 'best pizza in rotterdam - Google Search'));

    expect(effects).toEqual([
      {
        type: 'EmitEvent',
        event: {
          id: expect.any(String),
          type: 'search:performed',
          ts: '2026-01-01T00:00:00.000Z',
          payload: { timestamp: '2026-01-01T00:00:00.000Z', engine: 'google', query: 'best pizza in rotterdam', host: 'google.search', source: 'title', processName: 'Chrome' },
        },
      },
    ]);
  });

  it('detects the Dutch "Google Zoeken" variant', () => {
    const state = createInitialState('d1');
    const { effects } = contextUrlClassify(state, windowEvent('2026-01-01T00:00:00.000Z', 'beste pizza rotterdam - Google Zoeken'));
    expect((effects[0] as any).event.payload.engine).toBe('google');
  });

  it('prioritizes tracker patterns over search patterns (first-match-wins)', () => {
    // A title that could plausibly look search-engine-shaped but starts with a ticket id.
    const state = createInitialState('d1');
    const { effects } = contextUrlClassify(state, windowEvent('2026-01-01T00:00:00.000Z', 'GNOM-1 - Google Search'));
    expect((effects[0] as any).event.type).toBe('document:opened');
  });

  it('dedupes the same document within the 5min window', () => {
    let state = createInitialState('d1');
    const first = contextUrlClassify(state, windowEvent('2026-01-01T00:00:00.000Z', 'GNOM-123 fix'));
    state = first.state;
    const second = contextUrlClassify(state, windowEvent('2026-01-01T00:02:00.000Z', 'GNOM-123 fix'));
    expect(second.effects).toEqual([]);
  });

  it('re-emits the same document after the 5min dedup window passes', () => {
    let state = createInitialState('d1');
    state = contextUrlClassify(state, windowEvent('2026-01-01T00:00:00.000Z', 'GNOM-123 fix')).state;
    const { effects } = contextUrlClassify(state, windowEvent('2026-01-01T00:06:00.000Z', 'GNOM-123 fix'));
    expect(effects).toHaveLength(1);
  });

  it('dedupes the same search query within the 30s window', () => {
    let state = createInitialState('d1');
    state = contextUrlClassify(state, windowEvent('2026-01-01T00:00:00.000Z', 'foo - Google Search')).state;
    const { effects } = contextUrlClassify(state, windowEvent('2026-01-01T00:00:10.000Z', 'foo - Google Search'));
    expect(effects).toEqual([]);
  });

  it('evicts stale debounce keys (A§1.4) instead of accumulating them forever', () => {
    let state = createInitialState('d1');
    state = contextUrlClassify(state, windowEvent('2026-01-01T00:00:00.000Z', 'GNOM-1 fix')).state;
    expect(Object.keys(state.pending.debounces)).toHaveLength(1);

    // 10 minutes later — well past the 5min document window — a second, unrelated key is written.
    state = contextUrlClassify(state, windowEvent('2026-01-01T00:10:00.000Z', 'GNOM-2 fix')).state;

    expect(Object.keys(state.pending.debounces)).toEqual(['docUrl:jira-ticket:GNOM-2']);
  });

  it('does nothing for a plain title with no tracker or search shape', () => {
    const state = createInitialState('d1');
    const { effects } = contextUrlClassify(state, windowEvent('2026-01-01T00:00:00.000Z', 'index.ts — gnomon'));
    expect(effects).toEqual([]);
  });
});
