import { describe, it, expect } from 'vitest';
import { BOARD_LOOK_ID, boardContextText, boardSummary } from './board-context.js';

const board = {
  cards: {
    today: { id: 'today', kind: 'today', x: 0, y: 0, w: 960, h: 620, pinned: true, by: 'owner' },
    'entity:mira bakker': { id: 'entity:mira bakker', kind: 'entity', x: 1000, y: 0, w: 400, h: 300, by: 'gnomon', comment: 'the dates run off the edge' },
  },
  groups: {},
  scenes: { standup: {} },
  sections: {},
  recent: [{ at: '2026-09-29T08:00:00.000Z', by: 'gnomon', type: 'move', id: 'entity:mira bakker' }],
  span: { from: '2026-09-22', to: '2026-09-28', label: '7d' },
  plan: null,
};

describe('the board in the chat context (Q12)', () => {
  it('says what each card is, the span and the remarks, and not where cards sit or how they moved', () => {
    const text = boardContextText({ board, settings: { autonomy: 'act' } });
    // The staging setting is named for the board, so it cannot be read as `state.autonomy`.
    expect(text.split('\n')[0]).toBe('Board staging: "act".');
    expect(text).not.toContain('Autonomy is');
    expect(boardContextText({ board, settings: { autonomy: 'ask' } })).toMatch(/^Board staging: "ask" — gnomon_board and gnomon_lens place will refuse/);
    expect(text).toContain('The board is looking at 2026-09-22 to 2026-09-28 (7d)');
    expect(text).toContain("[the owner's remark: the dates run off the edge]");
    expect(text).toContain(`gnomon_look with id "${BOARD_LOOK_ID}"`);
    expect(text).not.toMatch(/at \d+, \d+, \d+×\d+/);
    expect(text).not.toContain('Recent moves');
    // A move changes nothing the context says; a place does.
    const moved = { ...board, cards: { ...board.cards, today: { ...board.cards.today, x: 500 } }, recent: [...board.recent, { at: '2026-09-29T08:01:00.000Z', by: 'owner', type: 'move', id: 'today' }] };
    expect(boardContextText({ board: moved })).toBe(boardContextText({ board }));
    expect(boardContextText({ board: { ...board, cards: { ...board.cards, week: { id: 'week', kind: 'week', x: 0, y: 700, w: 400, h: 300, by: 'gnomon' } } } })).not.toBe(boardContextText({ board }));
    expect(boardContextText({})).toBe('');
  });

  it('the read-back holds positions, the scenes and the recent moves', () => {
    const summary = boardSummary(board);
    expect(summary).toMatch(/pinned, at 0, 0, 960×620, placed by owner/);
    expect(summary).toContain('Saved scenes: standup');
    expect(summary).toContain('Recent moves, oldest first:');
  });

  it('reads a preset span against today, so a board kept past midnight is not yesterday (L1)', () => {
    expect(boardContextText({ board }, '2026-09-30')).toContain('The board is looking at 2026-09-24 to 2026-09-30 (7d)');
    expect(boardSummary(board, '2026-09-30')).toContain('2026-09-24 to 2026-09-30');
  });
});
