import { describe, it, expect, vi, beforeEach } from 'vitest';
import { composeFigure } from './figure-tools.js';

const mocks = vi.hoisted(() => ({
  findEntitiesByName: vi.fn(),
  getAllEntities: vi.fn(),
  getEntityFactTimeline: vi.fn(),
  getEntityGraphEdges: vi.fn(),
  getMemoryTierCounts: vi.fn(),
  getMomentsSince: vi.fn(),
  getMultiDayCommitments: vi.fn(),
  getOpenCommitments: vi.fn(),
  getPipelineCoverage: vi.fn(),
}));

vi.mock('@sundial/db/index.js', () => mocks);
vi.mock('@sundial/helpers/sundial-config.js', () => ({ loadSundialConfig: () => ({ timezone: 'UTC' }) }));

describe('composeFigure', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getMultiDayCommitments.mockResolvedValue([]);
    mocks.getOpenCommitments.mockResolvedValue([]);
    mocks.getAllEntities.mockResolvedValue([]);
  });

  /**
   * The refusal path matters more than the happy one. A figure with empty
   * innards renders as a chart of nothing, which reads as "there was no work"
   * rather than "there is nothing to draw" — so every composer that cannot find
   * its subject has to say so in words the model can pass on.
   */
  describe('refusing rather than drawing nothing', () => {
    it('refuses a graph-neighborhood with no entity named', async () => {
      expect(await composeFigure({ kind: 'graph-neighborhood' }, new Date())).toEqual({ unavailable: expect.stringContaining('needs the name') });
    });

    it('refuses when the named entity does not exist', async () => {
      mocks.findEntitiesByName.mockResolvedValue([]);
      expect(await composeFigure({ kind: 'graph-neighborhood', name: 'nobody' }, new Date())).toEqual({ unavailable: expect.stringContaining('No entity matches') });
    });

    it('refuses a neighbourhood for an entity that carries no facts — 21 of 33 real entities are in exactly this state', async () => {
      mocks.findEntitiesByName.mockResolvedValue([{ id: 'e1', canonicalName: 'isa', kind: 'person' }]);
      mocks.getEntityGraphEdges.mockResolvedValue([]);
      expect(await composeFigure({ kind: 'graph-neighborhood', name: 'isa' }, new Date())).toEqual({ unavailable: expect.stringContaining('no facts attached') });
    });

    it('refuses a commitment-thread when nothing is tracked', async () => {
      expect(await composeFigure({ kind: 'commitment-thread' }, new Date())).toEqual({ unavailable: expect.stringContaining('No commitments') });
    });

    it('refuses a trend-slice when no day in the range was observed', async () => {
      mocks.getMomentsSince.mockResolvedValue([]);
      expect(await composeFigure({ kind: 'trend-slice', days: 7 }, new Date())).toEqual({ unavailable: expect.stringContaining('Nothing was observed') });
    });
  });

  describe('trend-slice', () => {
    it('emits a row for every day in the range, marking the unobserved ones absent rather than zero', async () => {
      const today = new Date().toISOString().slice(0, 10);
      mocks.getMomentsSince.mockResolvedValue([{ startTime: `${today}T10:00:00.000Z`, durationMs: 90 * 60000 }]);

      const figure = await composeFigure({ kind: 'trend-slice', days: 3 }, new Date());
      if (!('kind' in figure)) throw new Error('expected a figure');
      if (figure.kind !== 'trend-slice') throw new Error('wrong kind');

      expect(figure.days).toHaveLength(3);
      // The distinction the whole grammar rests on: a day with no observation is
      // `observed: false`, which renders absent. A range that showed it as a
      // zero-height bar would read as "you did nothing", which is a claim.
      expect(figure.days.filter((d) => d.observed)).toHaveLength(1);
      expect(figure.days.find((d) => d.date === today)?.minutes).toBe(90);
      expect(figure.caption).toContain('2 empty');
    });
  });

  describe('fact-chain', () => {
    it('orders links oldest-first and carries supersession, so the chain reads the way it was built', async () => {
      mocks.findEntitiesByName.mockResolvedValue([{ id: 'e1', canonicalName: 'bob', kind: 'person' }]);
      mocks.getEntityFactTimeline.mockResolvedValue([
        { predicate: 'worksOn', object: 'gnomon', validFrom: '2026-07-25T09:00:00.000Z', validTo: null, confidence: 88, provenance: 'inference' },
        { predicate: 'worksOn', object: 'wcs', validFrom: '2026-06-18T15:40:00.000Z', validTo: '2026-07-25T09:00:00.000Z', confidence: 70, provenance: 'inference' },
        { predicate: 'worksWith', object: 'isa', validFrom: '2026-06-01T09:00:00.000Z', validTo: null, confidence: 60, provenance: 'assertion' },
      ]);

      const figure = await composeFigure({ kind: 'fact-chain', name: 'bob', predicate: 'worksOn' }, new Date());
      if (!('kind' in figure) || figure.kind !== 'fact-chain') throw new Error('expected a fact-chain');

      expect(figure.links.map((l) => l.object)).toEqual(['wcs', 'gnomon']);
      expect(figure.links[0].supersededAt).toBe('2026-07-25T09:00:00.000Z');
      expect(figure.caption).toContain('1 superseded');
    });

    it('falls back to the entity’s most recent predicate when none is named', async () => {
      mocks.findEntitiesByName.mockResolvedValue([{ id: 'e1', canonicalName: 'bob', kind: 'person' }]);
      mocks.getEntityFactTimeline.mockResolvedValue([
        { predicate: 'worksOn', object: 'gnomon', validFrom: '2026-07-25T09:00:00.000Z', validTo: null, confidence: 88, provenance: 'inference' },
      ]);

      const figure = await composeFigure({ kind: 'fact-chain', name: 'bob' }, new Date());
      if (!('kind' in figure) || figure.kind !== 'fact-chain') throw new Error('expected a fact-chain');
      expect(figure.predicate).toBe('worksOn');
    });
  });

  describe('census', () => {
    it('leaves a count with no real denominator as null rather than inventing a share', async () => {
      mocks.getMemoryTierCounts.mockResolvedValue({ signals: 216325, moments: 3150, knowledgeEntries: 102, entities: 33, entityFacts: 88 });
      mocks.getPipelineCoverage.mockResolvedValue({ moments: 3150, momentsWithIntent: 2913, momentsWithProject: 728 });

      const figure = await composeFigure({ kind: 'census' }, new Date());
      if (!('kind' in figure) || figure.kind !== 'census') throw new Error('expected a census');

      expect(figure.rows.find((r) => r.label === 'with a project')).toEqual({ label: 'with a project', count: 728, total: 3150 });
      // `entities` has no denominator in the record, and one must not be implied.
      expect(figure.rows.find((r) => r.label === 'entities')?.total).toBeNull();
    });
  });

  describe('graph-neighborhood', () => {
    it('resolves both edge directions to names and drops superseded edges', async () => {
      mocks.findEntitiesByName.mockResolvedValue([{ id: 'e1', canonicalName: 'bob', kind: 'person' }]);
      mocks.getAllEntities.mockResolvedValue([
        { id: 'e1', canonicalName: 'bob' },
        { id: 'e2', canonicalName: 'gnomon' },
        { id: 'e3', canonicalName: 'isa' },
      ]);
      mocks.getEntityGraphEdges.mockResolvedValue([
        { fromEntityId: 'e1', toEntityId: 'e2', predicate: 'worksOn', provenance: 'inference', superseded: false },
        { fromEntityId: 'e3', toEntityId: 'e1', predicate: 'worksWith', provenance: 'assertion', superseded: false },
        { fromEntityId: 'e1', toEntityId: 'e3', predicate: 'worksOn', provenance: 'inference', superseded: true },
      ]);

      const figure = await composeFigure({ kind: 'graph-neighborhood', name: 'bob' }, new Date());
      if (!('kind' in figure) || figure.kind !== 'graph-neighborhood') throw new Error('expected a neighbourhood');

      // An edge pointing INTO the centre is still a connection; "what is this
      // connected to" is not a question about predicate direction.
      expect(figure.edges.map((e) => e.toName).sort()).toEqual(['gnomon', 'isa']);
      expect(figure.edges).toHaveLength(2);
    });
  });
});
