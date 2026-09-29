import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { GAP, ROW_PAD, boardTrack, defaultSize, liveSpan, resolveSpan, DEFAULT_SIZE } from './board-track.js';

const ev = (type: string, payload: Record<string, unknown>, ts = '2026-09-12T10:00:00.000Z'): SanitizedEvent => ({ id: type + ts, type, ts, payload, sanitized: true });
const fold = (state: KernelState, ...events: SanitizedEvent[]) => events.reduce((s, e) => boardTrack(s, e).state, state);

describe('boardTrack', () => {
  it('places, moves, removes any card, and brings a scene back whole', () => {
    let s = fold(
      createInitialState('d1'),
      ev('board:place', { id: 'today', kind: 'today', pinned: true, by: 'owner' }),
      ev('board:place', { id: 'inst:memory', kind: 'instrument', x: 1000, y: 0, by: 'gnomon' }),
    );
    expect(s.board.cards.today!.w).toBe(1120);
    expect(s.board.cards['inst:memory']!.by).toBe('gnomon');

    // Tiled: today first in the row, the instrument after it, both at the row's height.
    expect(s.board.cards.today!.x).toBe(GAP);
    expect(s.board.cards['inst:memory']!.x).toBe(GAP + 1120 + GAP);
    s = fold(s, ev('board:move', { id: 'inst:memory', x: 1200, h: 50 }));
    expect(s.board.cards['inst:memory']!.x).toBe(GAP + 1120 + GAP); // still second in its row
    expect(s.board.cards['inst:memory']!.h).toBe(800); // the row's height, not its own floor

    s = fold(s, ev('board:save', { name: 'review' }), ev('board:remove', { id: 'today' }));
    expect(s.board.cards.today).toBeUndefined(); // nothing is pinned
    s = fold(s, ev('board:remove', { id: 'inst:memory' }));
    expect(s.board.cards['inst:memory']).toBeUndefined();
    s = fold(s, ev('board:load', { name: 'review' }));
    expect(Object.keys(s.board.cards).sort()).toEqual(['inst:memory', 'today']);
    expect(s.board.focus?.ids).toEqual(['today', 'inst:memory']);
  });

  it('brings a closed card back at the width the owner last gave it', () => {
    let s = fold(
      createInitialState('d1'),
      ev('board:place', { id: 'chat', kind: 'chat', w: 720, by: 'owner' }),
      ev('board:move', { id: 'chat', w: 1400 }),
      ev('board:remove', { id: 'chat' }),
      ev('board:place', { id: 'chat', kind: 'chat', w: 720, by: 'owner' }),
    );
    expect(s.board.cards.chat!.w).toBe(1400);
    // Another card of the same kind starts there too; Gnomon's resize is not the owner's.
    s = fold(s, ev('board:place', { id: 'entity:a', kind: 'entity' }), ev('board:move', { id: 'entity:a', w: 1300, by: 'gnomon' }), ev('board:remove', { id: 'entity:a' }), ev('board:place', { id: 'entity:a', kind: 'entity' }));
    expect(s.board.cards['entity:a']!.w).toBe(defaultSize('entity')[0]);
  });

  /**
   * A lens card is disposable; the question it encodes is not. Before the shelf
   * a lens died with its card and had to be composed again from prose.
   */
  it('keeps a lens on the shelf after its card is thrown away', () => {
    const spec = JSON.stringify({ title: 'Commits per project', source: { tool: 'gnomon_code_activity' } });
    let s = fold(createInitialState('d1'), ev('board:place', { id: 'lens:a1', kind: 'lens', text: spec, by: 'gnomon' }));
    expect(s.board.lenses['lens:a1']).toMatchObject({ title: 'Commits per project', spec });

    s = fold(s, ev('board:remove', { id: 'lens:a1' }), ev('board:clear', {}));
    expect(s.board.cards['lens:a1']).toBeUndefined();
    expect(s.board.lenses['lens:a1']?.spec).toBe(spec);

    // A card that is not a lens leaves the shelf alone, and a lens whose spec
    // will not parse is still shelved — under its id, which is all there is.
    s = fold(s, ev('board:place', { id: 'note:n', kind: 'note', text: 'hello' }), ev('board:place', { id: 'lens:bad', kind: 'lens', text: 'not json' }));
    expect(Object.keys(s.board.lenses).sort()).toEqual(['lens:a1', 'lens:bad']);
    expect(s.board.lenses['lens:bad']!.title).toBe('lens:bad');
  });

  it('tiles every card into one row when there are no sections, left to right by x, one shared height', () => {
    const s = fold(
      createInitialState('d1'),
      ev('board:place', { id: 'today', kind: 'today', pinned: true, x: 0, y: 0 }),
      ev('board:place', { id: 'n1', kind: 'note', x: -500, y: -500 }, '2026-09-12T10:00:01.000Z'),
      ev('board:place', { id: 'n2', kind: 'note', x: -900, y: 300 }, '2026-09-12T10:00:02.000Z'),
    );
    const { n2, n1, today } = s.board.cards as Record<string, { x: number; y: number; h: number }>;
    expect([n2!.x, n1!.x, today!.x]).toEqual([GAP, GAP * 2 + 320, GAP * 3 + 640]);
    expect([n2!.y, n1!.y, today!.y]).toEqual([ROW_PAD, ROW_PAD, ROW_PAD]);
    expect([n2!.h, n1!.h, today!.h]).toEqual([800, 800, 800]);
    // Tiling is idempotent: arrange changes nothing.
    expect(fold(s, ev('board:arrange', {})).board.cards).toEqual(s.board.cards);
  });

  it('stacks sections as rows, moves a card between rows by its centre, and orders a row by x', () => {
    let s = fold(
      createInitialState('d1'),
      ev('board:section', { id: 'a', label: 'A', x: 0, y: 0, w: 1000, h: 800 }),
      ev('board:place', { id: 'n1', kind: 'note', near: 'a' }),
      ev('board:place', { id: 'n2', kind: 'note', near: 'a' }, '2026-09-12T10:00:01.000Z'),
    );
    expect(s.board.sections.a!.y).toBe(0);
    expect([s.board.cards.n1!.x, s.board.cards.n2!.x]).toEqual([GAP, GAP * 2 + 320]);
    // Swap: n1 asks to stand just right of n2.
    s = fold(s, ev('board:move', { id: 'n1', x: s.board.cards.n2!.x + 1 }));
    expect([s.board.cards.n2!.x, s.board.cards.n1!.x]).toEqual([GAP, GAP * 2 + 320]);
    // A new row, made right before a card moves in (an empty row does not outlive the next event).
    s = fold(s, ev('board:section', { id: 'b', label: 'B', x: 0, y: 2000, w: 1000, h: 800 }));
    expect(s.board.sections.b!.y).toBe(s.board.sections.a!.h + GAP); // rows stack, a GAP apart
    // Down a row: its head lands in B's band.
    s = fold(s, ev('board:move', { id: 'n1', y: s.board.sections.b!.y + 100 }));
    expect(s.board.cards.n1!.y).toBe(s.board.sections.b!.y + ROW_PAD);
    expect(s.board.cards.n1!.x).toBe(GAP);
    expect(s.board.cards.n2!.x).toBe(GAP);
    expect(Object.keys(s.board.sections).sort()).toEqual(['a', 'b']); // both hold a card
  });

  it('drops a row a card leaves, but never one a placement passed over', () => {
    let s = fold(
      createInitialState('d1'),
      ev('board:section', { id: 'a', label: 'A', x: 0, y: 0, w: 400, h: 200 }),
      ev('board:place', { id: 'n1', kind: 'note', near: 'a' }),
      ev('board:section', { id: 'b', label: 'B', x: 0, y: 5000, w: 400, h: 200 }),
    );
    // `b` is new and empty, and a placement does not prune — this is exactly
    // what a fresh board does: write every row, then fill them one at a time.
    expect(Object.keys(s.board.sections).sort()).toEqual(['a', 'b']);
    s = fold(s, ev('board:place', { id: 'n2', kind: 'note', near: 'a' }));
    expect(Object.keys(s.board.sections).sort()).toEqual(['a', 'b']);
    // A card LEAVING does prune: `a` is now empty and goes.
    s = fold(s, ev('board:move', { id: 'n1', y: s.board.sections.b!.y + ROW_PAD }), ev('board:remove', { id: 'n2' }));
    expect(Object.keys(s.board.sections)).toEqual(['b']);
  });

  it('keeps the owner’s comment on a card, apart from its content', () => {
    let s = fold(createInitialState('d1'), ev('board:place', { id: 'n1', kind: 'note', text: 'the note itself' }));
    expect(s.board.cards.n1!.comment).toBeNull();
    s = fold(s, ev('board:place', { id: 'n1', comment: 'the numbers overlap at this width' }, '2026-09-13T10:00:01.000Z'));
    expect(s.board.cards.n1!.comment).toBe('the numbers overlap at this width');
    expect(s.board.cards.n1!.text).toBe('the note itself'); // content untouched
    // An empty string clears it; omitting it leaves it alone.
    s = fold(s, ev('board:place', { id: 'n1', text: 'edited' }, '2026-09-13T10:00:02.000Z'));
    expect(s.board.cards.n1!.comment).toBe('the numbers overlap at this width');
    s = fold(s, ev('board:place', { id: 'n1', comment: '' }, '2026-09-13T10:00:03.000Z'));
    expect(s.board.cards.n1!.comment).toBeNull();
  });

  it('places beside a named neighbour, right after it in the row', () => {
    let s = fold(createInitialState('d1'), ev('board:place', { id: 'today', kind: 'today', pinned: true, x: 0, y: 0 }));
    s = fold(s, ev('board:place', { id: 'n1', kind: 'note', x: 5000, y: 0 }));
    s = fold(s, ev('board:place', { id: 'inst:people', kind: 'inst', near: 'today' }));
    expect(Object.values(s.board.cards).sort((a, b) => a.x - b.x).map((c) => c.id)).toEqual(['today', 'inst:people', 'n1']);
  });

  it('clears every card, and keeps a walkthrough of steps', () => {
    let s = fold(
      createInitialState('d1'),
      ev('board:place', { id: 'today', kind: 'today', pinned: true }),
      ev('board:place', { id: 'inst:people', kind: 'inst' }),
      ev('board:walk', { steps: [{ ids: ['today'], text: 'The day.' }, { ids: ['inst:people'], text: 'Who you met.' }, { ids: [], text: '' }] }),
    );
    expect(s.board.walk?.steps).toHaveLength(2);
    s = fold(s, ev('board:clear', {}));
    expect(Object.keys(s.board.cards)).toEqual([]);
    expect(s.board.walk).toBeNull();
  });

  it('places a card inside a named section, below its anchor', () => {
    const s = fold(
      createInitialState('d1'),
      ev('board:section', { id: 'kanban', label: 'Kanban', x: 0, y: 1200, w: 1400, h: 900, anchor: 'kanban' }),
      ev('board:place', { id: 'kanban', kind: 'kanban', pinned: true, x: 40, y: 1260, w: 1300, h: 700, exact: true }),
      ev('board:place', { id: 'n1', kind: 'note', near: 'kanban' }),
    );
    // `near: kanban` names the card first (it exists), so the note lands beside it.
    expect(s.board.cards.n1!.x).toBe(GAP + 1300 + GAP);
    const s2 = fold(createInitialState('d1'), ev('board:section', { id: 'mood', label: 'Mood', x: 2000, y: 0, w: 1000, h: 800 }), ev('board:place', { id: 'n2', kind: 'note', near: 'mood' }));
    expect(s2.board.cards.n2!.x).toBe(2000 + GAP);
    expect(s2.board.cards.n2!.y).toBe(ROW_PAD);
  });

  it('grows a walk one step at a time and records when the owner has caught up', () => {
    let s = fold(createInitialState('d1'), ev('board:step', { ids: ['today'], text: 'First.' }));
    expect(s.board.walk?.steps).toHaveLength(1);
    expect(s.board.walk?.cursor).toBe(0);
    s = fold(s, ev('board:continue', {}), ev('board:step', { ids: [], text: 'Second.' }, '2026-09-12T10:00:02.000Z'));
    expect(s.board.walk?.steps).toHaveLength(2);
    expect(s.board.walk?.cursor).toBe(1);
  });

  it('keeps the last eight moves, oldest first, and skips what it ignored', () => {
    let s = createInitialState('d1');
    for (let i = 0; i < 10; i++) s = fold(s, ev('board:place', { id: `n${i}`, kind: 'note', by: i % 2 ? 'gnomon' : undefined }, `2026-09-12T10:00:${String(i).padStart(2, '0')}.000Z`));
    expect(s.board.recent).toHaveLength(8);
    expect(s.board.recent[0]).toMatchObject({ type: 'place', id: 'n2', by: 'owner' });
    expect(s.board.recent[7]).toMatchObject({ type: 'place', id: 'n9', by: 'gnomon' });
    const before = s.board.recent;
    s = fold(s, ev('board:remove', { id: 'missing' }));
    expect(s.board.recent).toBe(before);
  });

  it('weights steps, defaults to heavy, and keeps only a positive dwell', () => {
    let s = fold(createInitialState('d1'), ev('board:walk', { steps: [{ ids: ['today'], text: 'a', weight: 'light' }, { ids: [], text: 'b', weight: 'bold' }], autoAdvanceMs: -1 }));
    expect(s.board.walk?.steps.map((x) => x.weight)).toEqual(['light', 'heavy']);
    expect(s.board.walk?.autoAdvanceMs).toBeNull();
    s = fold(s, ev('board:step', { text: 'c' }));
    expect(s.board.walk?.steps[2]?.weight).toBe('heavy');
  });

  it('keeps the owner-edited plan, drops malformed items, and clears it with the board', () => {
    let s = fold(createInitialState('d1'), ev('board:plan', { steps: [{ content: 'Read', status: 'completed' }, { content: '', status: 'pending' }, { content: 'Skip me', status: 'skipped' }, { status: 'pending' }, { content: 'Odd', status: 'weird' }] }));
    expect(s.board.plan?.steps).toEqual([
      { content: 'Read', status: 'completed' },
      { content: 'Skip me', status: 'skipped' },
      { content: 'Odd', status: 'pending' },
    ]);
    s = fold(s, ev('board:clear', {}));
    expect(s.board.plan).toBeNull();
  });

  it('floors a web card at its minimum size', () => {
    const s = fold(createInitialState('d1'), ev('board:place', { id: 'web:https://example.com', kind: 'web', w: 100, h: 50 }));
    expect([s.board.cards['web:https://example.com']!.w, s.board.cards['web:https://example.com']!.h]).toEqual([400, 300]);
  });

  it('raises a notice, and makes a question stand until it is answered', () => {
    // A plain line runs on the default clock.
    let s = fold(createInitialState('d1'), ev('board:notice', { text: 'Committed to sundial.' }));
    expect(s.board.notice).toMatchObject({ text: 'Committed to sundial.', kind: 'say', ms: 5000, actions: [] });

    // Replies make it a question, and a question with a clock has not been
    // asked — it is only shown. So `ms` defaults to 0: it stands.
    s = fold(
      s,
      ev('board:notice', {
        text: 'Shall I open a thread for it?',
        actions: [{ label: 'Yes', say: 'yes please' }, { label: 'Not now', say: 'not now' }],
      }),
    );
    expect(s.board.notice).toMatchObject({ kind: 'ask', ms: 0 });
    expect(s.board.notice?.actions).toEqual([{ label: 'Yes', say: 'yes please' }, { label: 'Not now', say: 'not now' }]);

    // A caller may still put a clock on a question.
    s = fold(s, ev('board:notice', { text: 'Quick one?', kind: 'ask', ms: 3000, actions: [{ label: 'Ok', say: 'ok' }] }));
    expect(s.board.notice?.ms).toBe(3000);
  });

  it('refuses a notice with nothing to say, and bounds what it accepts', () => {
    const before = fold(createInitialState('d1'), ev('board:place', { id: 'today', kind: 'today' }));
    // No text is not a notice. The prior one — none — stands.
    expect(fold(before, ev('board:notice', { text: '   ' })).board.notice).toBeNull();

    const s = fold(
      before,
      ev('board:notice', {
        text: 'Whose stretch was that?',
        // A row is one line high: a fourth button is a card's worth of choice.
        actions: [
          { label: 'a', say: 'a' },
          { label: 'b', say: 'b' },
          { label: 'c', say: 'c' },
          { label: 'd', say: 'd' },
          { label: 'no say' },
        ],
        // An hour-long notice is not a notice.
        ms: 999_999,
      }),
    );
    expect(s.board.notice?.actions.map((a) => a.label)).toEqual(['a', 'b', 'c']);
    expect(s.board.notice?.ms).toBe(60_000);
  });

  it('ignores every other event', () => {
    const s = createInitialState('d1');
    expect(boardTrack(s, ev('clock:tick', {})).state).toBe(s);
  });

  it('holds ONE span for the whole board, and rolls it against today', () => {
    // Before this there were three unrelated mechanisms and "show me last week"
    // had three different answers depending on which card you asked.
    let s = fold(createInitialState('d1'), ev('board:span', { label: '7d' }, '2026-09-18T09:00:00.000Z'));
    expect(s.board.span).toMatchObject({ from: '2026-09-12', to: '2026-09-18', label: '7d' });

    // A preset is resolved against today every time it is set, so tomorrow the
    // last seven days is still the last seven days.
    s = fold(s, ev('board:span', { label: '7d' }, '2026-09-19T09:00:00.000Z'));
    expect(s.board.span).toMatchObject({ from: '2026-09-13', to: '2026-09-19' });

    // Today is one day, not a range ending today.
    s = fold(s, ev('board:span', { label: 'today' }, '2026-09-18T09:00:00.000Z'));
    expect(s.board.span).toMatchObject({ from: '2026-09-18', to: '2026-09-18' });

    // The ruler: one date is that day alone.
    s = fold(s, ev('board:span', { from: '2026-09-11' }));
    expect(s.board.span).toMatchObject({ from: '2026-09-11', to: '2026-09-11', label: 'day' });

    // A span nobody can read puts the board back on today rather than leaving
    // it somewhere nobody chose.
    s = fold(s, ev('board:span', { label: 'last fortnight-ish' }));
    expect(s.board.span).toBeNull();
  });

  it('resolves a span the same way for every reader', () => {
    expect(resolveSpan({ label: '14d' }, '2026-09-18')).toEqual({ from: '2026-09-05', to: '2026-09-18', label: '14d' });
    // Backwards dates are a slip, not a refusal.
    expect(resolveSpan({ from: '2026-09-18', to: '2026-09-01' }, '2026-09-18')).toEqual({ from: '2026-09-01', to: '2026-09-18', label: 'custom' });
    // Across a month end, by dates, so no clock arithmetic and no DST.
    expect(resolveSpan({ label: '7d' }, '2026-03-02')).toEqual({ from: '2026-02-24', to: '2026-03-02', label: '7d' });
    expect(resolveSpan({}, '2026-09-18')).toBeNull();
  });

  it('reads a stored preset against the day it is read on (L1)', () => {
    const stored = { from: '2026-09-18', to: '2026-09-18', label: 'today', at: '2026-09-18T21:00:00.000Z' };
    expect(liveSpan(stored, '2026-09-19')).toEqual({ ...stored, from: '2026-09-19', to: '2026-09-19' });
    expect(liveSpan({ from: '2026-09-12', to: '2026-09-18', label: '7d' }, '2026-09-19')).toMatchObject({ from: '2026-09-13', to: '2026-09-19' });
    const day = { from: '2026-09-16', to: '2026-09-16', label: 'day' };
    expect(liveSpan(day, '2026-09-19')).toBe(day);
    expect(liveSpan(null, '2026-09-19')).toBeNull();
  });

  it('keeps the owner\'s remark on a move, as on a place', () => {
    // The 2026-09-17 board audit wrote 35 verdicts with `move` + `comment` and
    // lost every one: the field had no home here. Geometry and remark are both
    // "any subset" of a card.
    let s = fold(createInitialState('d1'), ev('board:place', { id: 'inst:day', kind: 'instrument', by: 'gnomon' }));
    expect(s.board.cards['inst:day']!.comment).toBeNull();

    s = fold(s, ev('board:move', { id: 'inst:day', comment: 'newest should be on top' }));
    expect(s.board.cards['inst:day']!.comment).toBe('newest should be on top');

    // A move that says nothing about the remark leaves it standing...
    s = fold(s, ev('board:move', { id: 'inst:day', x: 400 }));
    expect(s.board.cards['inst:day']!.comment).toBe('newest should be on top');
    // ...and an empty one clears it, the same rule `place` follows.
    s = fold(s, ev('board:move', { id: 'inst:day', comment: '  ' }));
    expect(s.board.cards['inst:day']!.comment).toBeNull();
  });
});

describe('defaultSize', () => {
  it('gives every card but a note room to be read in', () => {
    for (const kind of ['today', 'threads', 'shelf', 'week', 'work', 'inst', 'web', 'unknown']) {
      const [w, h] = defaultSize(kind);
      expect(w, kind).toBeGreaterThanOrEqual(1120);
      expect(h, kind).toBeGreaterThanOrEqual(800);
    }
    expect(defaultSize('note')).toEqual([320, 200]);
    // Nothing is TALLER than the floor either: a row is as tall as its tallest
    // card, so one overlong card would push its whole row past the screen at 1:1.
    for (const kind of Object.keys(DEFAULT_SIZE)) expect(defaultSize(kind)[1], kind).toBeLessThanOrEqual(800);
    expect(defaultSize('kanban')).toEqual([1640, 800]);
  });
});
