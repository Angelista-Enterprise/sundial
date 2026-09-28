import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { CARD_KINDS } from '@sundial/rules/board-track.js';
import { createCardReaders, INSTRUMENT_ROUTES } from './card-readers.js';

/**
 * The anti-drift test.
 *
 * `CARD_KINDS` is the record's own list of what a board may hold. This asserts
 * every one of them can be READ, so a kind that gains a renderer without
 * gaining a reader fails here rather than answering "No reader for a … card
 * yet" to the owner. Both halves of that drift had already happened: a `dial`
 * card nothing could read, and a reader for a `today` id the client draws under
 * five other names.
 */
const readers = (over = {}) =>
  createCardReaders({
    route: over.route ?? vi.fn(async () => ({})),
    tool: over.tool ?? vi.fn(async () => []),
    state: over.state ?? (() => null),
  });

describe('card readers', () => {
  it('covers every card kind the record can hold', () => {
    const have = readers();
    expect(CARD_KINDS.filter((kind) => typeof have[kind] !== 'function')).toEqual([]);
  });

  it('reads the dial from the three routes the face is drawn from', async () => {
    const route = vi.fn(async (p) =>
      p.startsWith('/gnomon/dial')
        ? { observedMin: 300, wallClockMin: 600 }
        : p.startsWith('/gnomon/today')
          ? { date: '2026-09-17', focus: { deepMin: 66 }, projects: [{ name: 'gnomon' }], noticed: ['a'], coverage: { trackedMin: 310, wallClockMin: 620 } }
          : { date: '2026-09-17', moments: [{ id: 'm1', startTime: '2026-09-17T09:00:00.000Z', durationMin: 30, activeMin: 20, processName: 'Arc' }] },
    );
    const got = await readers({ route }).dial('', null, {});
    expect(route.mock.calls.map((c) => c[0])).toEqual(['/gnomon/dial', '/gnomon/day', '/gnomon/today']);
    expect(got.observedMin).toBe(310);
    expect(got.focus).toEqual({ deepMin: 66 });
    expect(got.moments).toHaveLength(1);
  });

  it('keeps only the moments around an hour when one is given', async () => {
    const at = (h) => new Date(2026, 8, 17, h, 0, 0).toISOString();
    const route = vi.fn(async (p) =>
      p.startsWith('/gnomon/day')
        ? {
            date: '2026-09-17',
            moments: [
              { id: 'morning', startTime: at(9), durationMin: 30, activeMin: 30 },
              { id: 'afternoon', startTime: at(15), durationMin: 30, activeMin: 30 },
            ],
          }
        : {},
    );
    const got = await readers({ route }).dial('', null, { hour: 15 });
    expect(got.moments.map((m) => m.id)).toEqual(['afternoon']);
  });

  it('reads the brief as the brief — a sentence and what is left, not the moment list', async () => {
    // The `today` card is the one-sentence brief beside the dial. Answering it
    // with the day's moments described the card next to the one that was asked about.
    const route = vi.fn(async (p) =>
      p.startsWith('/gnomon/today')
        ? { date: '2026-09-17', coverage: { trackedMin: 310 }, projects: [{ name: 'gnomon', minutes: 120 }], meetings: 2, noticed: ['a', 'b'] }
        : { items: [{ title: 'Kept one', verdict: null }, { title: 'Judged one', verdict: 'useful' }] },
    );
    const got = await readers({ route }).today('', null, {});
    expect(got).toEqual({
      date: '2026-09-17',
      observedMin: 310,
      projects: [{ name: 'gnomon', minutes: 120 }],
      meetings: 2,
      noticed: 2,
      leftForYou: [{ title: 'Kept one', verdict: null }],
    });
  });

  it('names no window of its own, so the board\'s span decides', async () => {
    const route = vi.fn(async () => ({ days: [{ date: '2026-09-22' }] }));
    const got = await readers({ route }).rhythm('', null, {});
    // A `?days=` here would pin the reading to a span the owner did not choose,
    // and it was written in three places that a test had to hold in step.
    expect(route).toHaveBeenCalledWith('/gnomon/shape');
    expect(got.days).toHaveLength(1);
    const one = await readers({ route }).rhythm('', { filters: { view: 'days' } }, {});
    expect(Object.keys(one)).toEqual(['view', 'days']);
  });

  it('reads In play as its own card with a project filter', async () => {
    const play = vi.fn(async (p) => (p.startsWith('/gnomon/habits') ? { commitments: { open: [{ id: 'c1', project: 'sundial' }, { id: 'c2', project: 'wcs' }] } } : { goals: [{ goal: 'demo' }] }));
    const all = await readers({ route: play }).play('', null, {});
    expect(all.commitments).toHaveLength(2);
    expect(all.goals).toHaveLength(1);
    const one = await readers({ route: play }).play('', { filters: { project: 'sundial' } }, {});
    expect(one.commitments.map((c) => c.id)).toEqual(['c1']);
  });

  it('reads a card whose content is only on the card itself', async () => {
    const got = await readers().note('', { text: 'Ring the dentist', by: 'owner', kind: 'note' }, {});
    expect(got.text).toBe('Ring the dentist');
    expect(got.by).toBe('owner');
  });

  it('says so plainly when the bench has not been read yet', async () => {
    expect(await readers().work('', null, {})).toEqual({ unavailable: 'The bench has not been read yet.' });
  });

  it('reads the bench the way the card shows it: newest jobs first, last eight', async () => {
    // `recent` is a ring, written oldest to newest. Taking the FRONT of it hands
    // back the jobs the card is no longer showing — the drift this test exists
    // to hold shut. `nowSnapshot` takes `.slice(-8).reverse()`; so does this.
    const ring = Array.from({ length: 10 }, (_, i) => ({
      id: `job-${i}`,
      kind: 'topic-brief',
      subject: `s${i}`,
      outcome: 'shelved',
      openedAt: '2026-09-17T09:00:00.000Z',
      closedAt: '2026-09-17T09:30:00.000Z',
    }));
    const got = await readers({ state: () => ({ workbench: { open: null, queue: [], recent: ring, countToday: 4 } }) }).work('', null, {});
    expect(got.recent).toHaveLength(8);
    expect(got.recent[0].id).toBe('job-9');
    expect(got.recent.at(-1).id).toBe('job-2');
    expect(got.recent[0].min).toBe(30);
    expect(got.today).toBe(4);
  });

  it('gives the open job the minutes the card prints, not a raw instant', async () => {
    const openedAt = new Date(Date.now() - 12 * 60_000).toISOString();
    const got = await readers({
      state: () => ({ workbench: { open: { id: 'j1', kind: 'meeting-brief', subject: 'Standup', openedAt }, queue: [{ id: 'j2' }, { id: 'j3' }], recent: [] } }),
    }).work('', null, {});
    expect(got.open).toEqual({ jobId: 'j1', kind: 'meeting-brief', subject: 'Standup', reason: null, min: 12 });
    expect(got.waiting).toBe(2);
  });

  it('counts the roster by kind for the Explore card', async () => {
    const route = vi.fn(async () => ({
      entities: [
        { canonicalName: 'gnomon', kind: 'project', factCount: 9 },
        { canonicalName: 'Ada', kind: 'person', factCount: 2 },
        { canonicalName: 'sundial', kind: 'project', factCount: 4 },
      ],
    }));
    const got = await readers({ route }).explore('', null, {});
    expect(got.counts).toEqual({ project: 2, person: 1 });
    expect(got.entities[0]).toEqual({ name: 'gnomon', kind: 'project', facts: 9 });
  });

  it('reads a lens by running it, and says so when its spec cannot be read', async () => {
    const spec = { title: 'Long moments', source: { tool: 'gnomon_recent_activity', args: {} }, show: 'table' };
    const tool = vi.fn(async () => ({ rows: [{ app: 'Arc' }, { app: 'Claude' }] }));
    const got = await readers({ tool }).lens('long', { text: JSON.stringify(spec) }, {});
    expect(tool).toHaveBeenCalledWith('gnomon_recent_activity', {});
    expect(got.title).toBe('Long moments');
    expect(JSON.stringify(got.rows)).toContain('Claude');
    const empty = await readers({ tool }).lens('x', { text: 'Where today went, hour by hour' }, {});
    expect(empty.is).toContain('no readable spec');
  });

  it('reads the Engine room by its tab, and says when a tab does not exist', async () => {
    const route = vi.fn(async (p) => ({ from: p }));
    expect((await readers({ route }).engine('', null, {})).from).toBe('/gnomon/ledger');
    expect((await readers({ route }).engine('', { filters: { tab: 'trust' } }, {})).from).toBe('/gnomon/trust');
    const got = await readers({ route }).engine('', { filters: { tab: 'threads' } }, {});
    expect(got.error).toContain('no "threads" tab');
    expect(got.tabs).toContain('reach');
  });

  /**
   * The other direction of the same drift, and the one that actually bit.
   *
   * `CARD_KINDS` already proves every kind the RECORD can hold has a reader.
   * It cannot prove the reverse: that every kind the CLIENT can draw is a kind
   * the record names and a reader answers for. That gap is how a `dial` card
   * came to exist with nothing able to read it, and how the audit met two
   * surfaces — threads, explore — the companion critiquing them could not see.
   *
   * The client's own source is the assertion, as it is for `PANELS` above: the
   * kinds `materialize` knows by name, and the ids the resolver seats a pane
   * for. A kind added to either without a reader fails here, on the day it is
   * added, instead of in front of the owner.
   */
  it('can read every kind the client can draw', () => {
    const read = (name) => readFileSync(fileURLToPath(new URL(`../sundial-theme/shell/${name}`, import.meta.url)), 'utf8');
    const stage = read('stage.js');
    const app = read('app.js');

    // `materialize` draws these by kind outright.
    const byKind = [...stage.matchAll(/card\.kind === '([a-z]+)'/g)].map((m) => m[1]);
    // The resolver turns an id into a pane: a singleton by name, a family by prefix.
    const resolver = app.slice(app.indexOf('const resolveCard = async ('), app.indexOf('setResolver(resolveCard)'));
    expect(resolver.length, 'the resolver block was not found in app.js').toBeGreaterThan(200);
    const byId = [
      ...[...resolver.matchAll(/id === '([a-z]+)'/g)].map((m) => m[1]),
      ...[...resolver.matchAll(/id\.startsWith\('([a-z]+):'\)/g)].map((m) => m[1]),
    ];

    const drawn = [...new Set([...byKind, ...byId])];
    expect(drawn.length, 'no card kinds were found in the client — this test cannot check what it cannot read').toBeGreaterThan(8);

    // `inst` is the record's name for the family the client calls `inst:`; the
    // reader keys on the record's name, which `normKind` maps both ways.
    const known = new Set(CARD_KINDS);
    expect(drawn.filter((kind) => !known.has(kind)), 'the client draws a card kind the record cannot name').toEqual([]);

    const have = readers();
    expect(drawn.filter((kind) => typeof have[kind] !== 'function'), 'the client draws a card kind nothing can read').toEqual([]);
  });

  it('asks the entity tool by the name after the colon', async () => {
    const tool = vi.fn(async () => [{ entity: { canonicalName: 'Ada' } }]);
    await readers({ tool }).entity('Ada', null, {});
    expect(tool).toHaveBeenCalledWith('gnomon_entity_history', { name: 'Ada' });
  });
});

