// @vitest-environment jsdom
//
// The renderers build DOM, so they are tested against a DOM.
//
// What these pin is the thing that broke: every kind `composeFigure` can return
// must reach a renderer. The tool shipped with six kinds and the client drew
// none of them — the figure JSON sat in the tool row while the prose referred
// to a drawing nobody could see. A kind added to the union without an arm here
// fails loudly instead of silently becoming a paragraph of JSON.
import { describe, expect, it, vi } from 'vitest';
import { FIGURE_KINDS, figureStage, renderFigure } from './figures.js';
import { grid } from './surfaces.js';

/** The smallest payload of each kind that the composer could actually return. */
const FIXTURES = {
  'dial-slice': {
    kind: 'dial-slice',
    caption: 'dial-slice · today · 4h 54m observed of 10h 36m',
    fromHour: 8,
    toHour: 24,
    curve: [{ hour: 9, score: 10 }, { hour: 10, score: 4 }],
    meetings: [{ startHour: 13, endHour: 13.5 }],
    deepBlocks: [],
    nowHour: 19.5,
  },
  'trend-slice': {
    kind: 'trend-slice',
    caption: 'trend-slice · 3 days',
    days: [
      { date: '2026-09-08', minutes: 335, observed: true },
      { date: '2026-09-09', minutes: 0, observed: false },
      { date: '2026-09-10', minutes: 294, observed: true },
    ],
  },
  'graph-neighborhood': {
    kind: 'graph-neighborhood',
    caption: 'graph-neighborhood · sundial',
    center: { id: 'project:sundial', name: 'sundial', kind: 'project' },
    edges: [
      { toName: 'Claude', predicate: 'usesTool', provenance: 'inference' },
      { toName: 'Warp', predicate: 'usesTool', provenance: 'assertion' },
    ],
  },
  'fact-chain': {
    kind: 'fact-chain',
    caption: 'fact-chain · sundial usesTool · 2 links',
    entityName: 'sundial',
    predicate: 'usesTool',
    links: [
      { at: '2026-08-01T10:45:35.944Z', object: 'Claude', confidence: 100, provenance: 'inference', supersededAt: null },
      { at: '2026-08-02T10:45:35.944Z', object: 'Warp', confidence: 80, provenance: 'inference', supersededAt: '2026-08-14T09:00:00.000Z' },
    ],
  },
  'commitment-thread': {
    kind: 'commitment-thread',
    caption: 'commitment-thread · BOX-484',
    name: 'BOX-484',
    branch: 'fix/queens',
    openedAt: '2026-08-01T09:18:19.924Z',
    activeDays: 3,
    touches: 90,
  },
  census: {
    kind: 'census',
    caption: 'census · all time',
    rows: [
      { label: 'moments', count: 5239, total: null },
      { label: 'with a project', count: 3290, total: 5239 },
    ],
  },
};

const text = (node) => node.textContent;

describe('renderFigure', () => {
  it('draws every kind composeFigure can return — no kind falls through to the JSON it came from', () => {
    for (const kind of FIGURE_KINDS) {
      const node = renderFigure(FIXTURES[kind]);
      expect(node, kind).not.toBeNull();
      expect(text(node.querySelector('.surface-body')), kind).not.toContain('No renderer');
    }
  });

  it('has a fixture for every kind, so a new kind cannot pass the test above by being absent', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...FIGURE_KINDS].sort());
  });

  it('puts the composed caption in the head, split at its first separator', () => {
    const node = renderFigure(FIXTURES['dial-slice']);
    expect(text(node.querySelector('.surface-title'))).toBe('dial-slice');
    expect(text(node.querySelector('.surface-because'))).toContain('4h 54m observed of 10h 36m');
  });

  // `{ unavailable }` is the composer's real answer for a day with nothing in
  // it. Drawing nothing at all would read as a bug in the client.
  it('shows the composer\'s reason when there is no shape to draw', () => {
    const node = renderFigure({ unavailable: 'Nothing was observed on 2026-01-01, so there is no shape to draw.' });
    expect(text(node.querySelector('.surface-fail'))).toContain('Nothing was observed');
  });

  it('says so rather than drawing wrong when the kind is unknown or the payload does not fit it', () => {
    expect(text(renderFigure({ kind: 'weather-map' }).querySelector('.surface-fail'))).toContain('No renderer for "weather-map"');
    expect(text(renderFigure({ kind: 'census', rows: 'not an array' }).querySelector('.surface-fail'))).toContain('No renderer');
  });

  it('is null for something that is not a figure at all', () => {
    expect(renderFigure(null)).toBeNull();
    expect(renderFigure({ nothing: true })).toBeNull();
  });

  // A day the sensors missed must not draw as a day of zero minutes. The chart
  // renderer owns that rule; this pins that the adapter hands it a null rather
  // than the `minutes` field of an unobserved day.
  it('passes an unobserved day through as absent, not as a zero', () => {
    const svg = renderFigure(FIXTURES['trend-slice']).querySelector('svg');
    expect([...svg.querySelectorAll('title')].map(text)).toContain('2026-09-09 · nothing observed');
  });

  it('marks a superseded link in the chain rather than dropping it', () => {
    const rows = [...renderFigure(FIXTURES['fact-chain']).querySelectorAll('tbody tr')].map(text);
    expect(rows[0]).toContain('current');
    expect(rows[1]).toContain('superseded 2026-08-14');
  });

  // A census row with no denominator is a bare count. A full bar would be a
  // claim about completeness that nothing in the record supports.
  it('draws a bar only for a census row that has a denominator', () => {
    const node = renderFigure(FIXTURES.census);
    expect(node.querySelectorAll('.gauge-track')).toHaveLength(1);
    expect(text(node)).toContain('no denominator');
  });
});

describe('grid sorting', () => {
  const columns = [
    { key: 'name', label: 'person' },
    { key: 'meetings', label: 'meetings', type: 'number' },
  ];
  const rows = [
    { name: 'Alex', meetings: 4 },
    { name: 'Marco', meetings: 12 },
    { name: 'Priya', meetings: null },
    { name: 'hana', meetings: 2 },
  ];
  /** Render into a container and hand back the header buttons plus a column reader. */
  const mount = () => {
    const host = document.createElement('div');
    for (const part of grid({ columns, rows })) if (part) host.append(part);
    return {
      head: (label) => [...host.querySelectorAll('.grid-sort')].find((b) => b.textContent === label),
      column: (i) => [...host.querySelectorAll('tbody tr')].map((tr) => tr.children[i].textContent),
      marks: () => [...host.querySelectorAll('th')].map((th) => th.getAttribute('aria-sort')),
    };
  };

  it('sorts a number column as numbers, not as strings', () => {
    const g = mount();
    g.head('meetings').click();
    // Lexically this would be 12, 2, 4 — the bug this test exists to catch.
    expect(g.column(1)).toEqual(['2', '4', '12', '—']);
  });

  it('reverses on the second click and restores the sent order on the third', () => {
    const g = mount();
    g.head('meetings').click();
    g.head('meetings').click();
    expect(g.column(1)).toEqual(['12', '4', '2', '—']);
    expect(g.marks()).toEqual(['none', 'descending']);
    g.head('meetings').click();
    expect(g.column(0)).toEqual(['Alex', 'Marco', 'Priya', 'hana']);
    expect(g.marks()).toEqual(['none', 'none']);
  });

  // Not observed sorts LAST in both directions: it is not a zero and not an
  // empty string, and putting it first would make the emptiest rows the answer.
  it('keeps a missing value last whichever way the column is sorted', () => {
    const g = mount();
    g.head('meetings').click();
    expect(g.column(1).at(-1)).toBe('—');
    g.head('meetings').click();
    expect(g.column(1).at(-1)).toBe('—');
  });

  it('sorts text case-insensitively, so a lowercase name is not exiled to the end', () => {
    const g = mount();
    g.head('person').click();
    expect(g.column(0)).toEqual(['Alex', 'hana', 'Marco', 'Priya']);
  });

  it('marks only the column actually sorted', () => {
    const g = mount();
    g.head('meetings').click();
    g.head('person').click();
    expect(g.marks()).toEqual(['ascending', 'none']);
  });
});

describe('figureStage (L3)', () => {
  /** A board with one seat per id, and the three acts the stage offers. */
  const board = () => {
    const cards = new Set();
    const seats = new Map();
    const stage = {
      onBoard: (id) => cards.has(id),
      pane: vi.fn((id, { node }) => {
        const body = seats.get(id) ?? document.createElement('div');
        body.className = 'pane-body';
        body.replaceChildren(node);
        seats.set(id, body);
        cards.add(id);
      }),
      focusPane: vi.fn(),
      dismissPane: vi.fn(),
    };
    return { cards, seats, stage };
  };
  /** A drawn surface in a turn of the transcript. */
  const drawn = (transcript, title) => {
    const node = document.createElement('div');
    node.innerHTML = `<div class="surface-head"><span class="surface-title">${title}</span></div><div class="surface-body">bars</div>`;
    transcript.append(node);
    return node;
  };

  it('keeps a staged figure on the board when the thread changes, and lifts it back in when the thread returns', () => {
    const { seats, stage } = board();
    const figures = figureStage(stage);
    const transcript = document.createElement('div');
    document.body.append(transcript);

    // Gnomon draws it live: it takes the stage, a stub keeps its place.
    figures.add(drawn(transcript, 'Hours by day'), 'surface:c1', { live: true });
    expect(stage.pane).toHaveBeenCalledTimes(1);
    expect(transcript.querySelector('.surface-stub')?.textContent).toContain('Hours by day');

    // Another thread opens: the transcript goes, the card stays, nothing is removed.
    figures.clear();
    transcript.replaceChildren();
    expect(stage.dismissPane).not.toHaveBeenCalled();

    // The thread comes back and is replayed: its figure fills the same card, quietly.
    const again = drawn(transcript, 'Hours by day');
    figures.add(again, 'surface:c1', { live: false });
    expect(stage.pane).toHaveBeenCalledTimes(2);
    expect(seats.get('surface:c1').firstChild).toBe(again);
    expect(stage.focusPane).toHaveBeenCalledTimes(1);
    expect(stage.dismissPane).not.toHaveBeenCalled();
  });

  it('leaves a replayed figure in its turn when its card is not on the board', () => {
    const { stage } = board();
    const figures = figureStage(stage);
    const transcript = document.createElement('div');
    document.body.append(transcript);
    const node = drawn(transcript, 'Old figure');
    figures.add(node, 'figure:c2', { live: false });
    expect(stage.pane).not.toHaveBeenCalled();
    expect(node.parentElement).toBe(transcript);
    // A card the record holds with nothing drawing it asks for the node by id.
    expect(figures.relift('figure:c2')).toBe(true);
    expect(stage.pane).toHaveBeenCalledTimes(1);
    expect(figures.relift('figure:unknown')).toBe(false);
  });
});
