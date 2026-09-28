import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { SanitizedEvent } from '@sundial/kernel/types.js';
import { bigCommit } from './big-commit.js';

function commitEvent(filesChanged: number): SanitizedEvent {
  return {
    id: 'e1',
    type: 'git:commit',
    ts: '2026-01-01T00:00:00.000Z',
    payload: { commitLine: 'abc123 fix stuff', branch: 'main', cwd: '/x/gnomon', filesChanged },
    sanitized: true,
  };
}

describe('bigCommit', () => {
  it('does not emit for a small commit', () => {
    const state = createInitialState('d1');
    const { effects } = bigCommit(state, commitEvent(3));
    expect(effects).toEqual([]);
  });

  it('emits event:big-commit immediately using the filesChanged already on the event — no delayed subprocess', () => {
    const state = createInitialState('d1');
    const { effects } = bigCommit(state, commitEvent(25));

    expect(effects).toEqual([
      {
        type: 'EmitEvent',
        event: {
          id: expect.any(String),
          type: 'event:big-commit',
          ts: '2026-01-01T00:00:00.000Z',
          payload: { timestamp: '2026-01-01T00:00:00.000Z', commitLine: 'abc123 fix stuff', branch: 'main', filesChanged: 25, cwd: '/x/gnomon' },
        },
      },
    ]);
  });

  it('ignores non-git:commit events', () => {
    const state = createInitialState('d1');
    const { state: next, effects } = bigCommit(state, { id: 'e1', type: 'window:changed', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
