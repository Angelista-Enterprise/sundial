import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../initial-state.js';
import { toolEnv } from '../tool-env.js';
import { MEMORY_TOOLS } from './memory-tools.js';

const mocks = vi.hoisted(() => ({
  findEntitiesByName: vi.fn(),
  getAllEntities: vi.fn(),
  getCurrentEntityFacts: vi.fn(),
  getEntityFactTimeline: vi.fn(),
  getKnowledgeEntriesForDate: vi.fn(),
  getMomentsMentioning: vi.fn(),
  getPromises: vi.fn(),
  loadAliasNames: vi.fn(),
  scoredSearch: vi.fn(),
}));

vi.mock('@sundial/db/index.js', () => mocks);
vi.mock('@sundial/helpers/sundial-config.js', async (original) => ({ ...(await original<object>()), loadSundialConfig: () => ({ timezone: 'UTC' }) }));

const tool = (name: string) => MEMORY_TOOLS.find((t) => t.name === name)!;
const NOW = new Date('2026-11-16T10:00:00.000Z');
const fact = (id: string, predicate: string, object: string, extra: Record<string, unknown> = {}) => ({ id, predicate, object, validFrom: '2026-11-01T09:00:00.000Z', validTo: null, provenance: 'extracted', ...extra });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getPromises.mockResolvedValue([]);
  mocks.loadAliasNames.mockResolvedValue({});
  mocks.getMomentsMentioning.mockResolvedValue({ total: 0, byPlace: {}, moments: [] });
});

describe('gnomon_anomalies', () => {
  it("reads the day's companion insights only, today when no date is given", async () => {
    mocks.getKnowledgeEntriesForDate.mockResolvedValue([{ kind: 'companion-insight', text: 'A late night on puzzlebox-studio' }, { kind: 'daily-journal', text: 'The day' }]);
    expect(await tool('gnomon_anomalies').handler({}, toolEnv(() => null, NOW))).toEqual([{ kind: 'companion-insight', text: 'A late night on puzzlebox-studio' }]);
    expect(mocks.getKnowledgeEntriesForDate).toHaveBeenCalledWith('2026-11-16', 'UTC');
    await tool('gnomon_anomalies').handler({ date: '2026-11-10' }, toolEnv(() => null, NOW));
    expect(mocks.getKnowledgeEntriesForDate).toHaveBeenLastCalledWith('2026-11-10', 'UTC');
  });
});

describe('gnomon_goals', () => {
  it("lists goals only, open first, with whose word the status is", async () => {
    mocks.getAllEntities.mockResolvedValue([
      { id: 'g1', kind: 'goal', canonicalName: 'Ship the puzzle editor' },
      { id: 'g2', kind: 'goal', canonicalName: 'Learn Dutch' },
      { id: 'g3', kind: 'goal', canonicalName: 'Answer every BOX ticket' },
      { id: 'p1', kind: 'person', canonicalName: 'Mira Bakker' },
    ]);
    mocks.getCurrentEntityFacts.mockImplementation(async (id: string) =>
      ({
        g1: [fact('f1', 'status', 'done', { provenance: 'assertion' })],
        g2: [fact('f2', 'status', 'open: two lessons a week', { provenance: 'assertion' }), fact('f3', 'deadline', 'June')],
        g3: [],
      })[id] ?? [],
    );
    const out = (await tool('gnomon_goals').handler({}, toolEnv(() => null, NOW))) as Record<string, unknown>[];
    expect(out.map((g) => g.goal)).toEqual(['Answer every BOX ticket', 'Learn Dutch', 'Ship the puzzle editor']);
    expect(out[0]).toMatchObject({ status: 'open', since: null, saidBy: null, otherFacts: [] });
    expect(out[1]).toMatchObject({ status: 'open: two lessons a week', saidBy: 'owner', otherFacts: ['deadline June'] });
    expect(out[2]).toMatchObject({ status: 'done', saidBy: 'owner' });
  });
});

describe('gnomon_people', () => {
  it('names a hashed attendee by its alias, never by the hash, and carries the promise ledger', async () => {
    mocks.getAllEntities.mockResolvedValue([
      { id: 'e1', kind: 'person', canonicalName: 'person-0a1b2c3d4e' },
      { id: 'e2', kind: 'person', canonicalName: 'person-ffeeddccbb' },
      { id: 'e3', kind: 'person', canonicalName: 'Rook Hallam' },
      { id: 'e4', kind: 'project', canonicalName: 'puzzlebox-studio' },
    ]);
    mocks.loadAliasNames.mockResolvedValue({ 'person-0a1b2c3d4e': 'Mira Bakker' });
    mocks.getCurrentEntityFacts.mockImplementation(async (id: string) => (id === 'e1' ? [fact('a', 'attendedMeetingWith', 'owner'), fact('b', 'attendedMeetingWith', 'owner'), fact('c', 'role', 'designer')] : []));
    mocks.getPromises.mockResolvedValue([
      { closedAt: null, closedBecause: null, promise: { direction: 'owed', counterparty: 'person-0a1b2c3d4e' } },
      { closedAt: '2026-11-10T09:00:00.000Z', closedBecause: 'kept', promise: { direction: 'owed', counterparty: 'person-0a1b2c3d4e' } },
    ]);
    const out = (await tool('gnomon_people').handler({}, toolEnv(() => null, NOW))) as Record<string, any>[];
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ name: 'Mira Bakker', id: 'e1', named: true, factCount: 3, metWith: 2, promises: { youOwe: 1, theyOwe: 0, keptToThem: '1 of 1 closed' } });
    expect(out[1]).toMatchObject({ name: null, named: false, factCount: 0 });
    expect(out[1]).not.toHaveProperty('promises');
    expect(out[2]).toMatchObject({ name: 'Rook Hallam', named: true });
  });
});

describe('gnomon_entity_history', () => {
  it('resolves the display name from knownAs, attaches a belief record, and lists where the name appears', async () => {
    mocks.findEntitiesByName.mockResolvedValue([{ id: 'e1', kind: 'person', canonicalName: 'person-0a1b2c3d4e', aliasesJson: '["mira"]' }]);
    mocks.getEntityFactTimeline.mockResolvedValue([fact('k1', 'knownAs', 'Mira Bakker'), fact('w1', 'worksOn', 'puzzlebox-studio'), fact('w0', 'worksOn', 'old-site', { validTo: '2026-10-01T00:00:00.000Z' })]);
    mocks.getMomentsMentioning.mockResolvedValue({ total: 1, byPlace: { meeting: 1 }, moments: [{ id: 'm1', where: 'meeting' }] });
    const state = createInitialState('d1');
    state.factTests = { records: { w1: { right: 12, wrong: 1 } } } as never;
    const [out] = (await tool('gnomon_entity_history').handler({ name: 'mira' }, toolEnv(() => state, NOW))) as Record<string, any>[];
    expect(out.entity).toEqual({ id: 'e1', kind: 'person', canonicalName: 'Mira Bakker', alias: 'person-0a1b2c3d4e' });
    expect(out.facts.find((f: { id: string }) => f.id === 'w1').record).toEqual({ right: 12, wrong: 1, line: 'right 12 of 13, gathering' });
    expect(out.facts.find((f: { id: string }) => f.id === 'w0')).not.toHaveProperty('record');
    expect(mocks.getMomentsMentioning).toHaveBeenCalledWith(['person-0a1b2c3d4e', 'mira', 'Mira Bakker'], 12);
    expect(out.appearances.total).toBe(1);
  });

  it("never looks up the owner's own appearances: they are in every moment", async () => {
    mocks.findEntitiesByName.mockResolvedValue([{ id: 'o1', kind: 'owner', canonicalName: 'Owner', aliasesJson: 'not json' }]);
    mocks.getEntityFactTimeline.mockResolvedValue([]);
    const [out] = (await tool('gnomon_entity_history').handler({ name: 'owner' }, toolEnv(() => null, NOW))) as Record<string, any>[];
    expect(out.appearances).toEqual({ total: 0, byPlace: {}, moments: [] });
    expect(mocks.getMomentsMentioning).not.toHaveBeenCalled();
  });
});

describe('gnomon_semantic_search', () => {
  it('passes the query through with a default of ten', async () => {
    mocks.scoredSearch.mockResolvedValue([{ refType: 'moment', refId: 'm1' }]);
    expect(await tool('gnomon_semantic_search').handler({ query: 'the retro' }, toolEnv(() => null, NOW))).toEqual([{ refType: 'moment', refId: 'm1' }]);
    expect(mocks.scoredSearch).toHaveBeenCalledWith('the retro', 10);
    await tool('gnomon_semantic_search').handler({ query: 'the retro', limit: 3 }, toolEnv(() => null, NOW));
    expect(mocks.scoredSearch).toHaveBeenLastCalledWith('the retro', 3);
  });

  it('passes a period through, so "in March" filters instead of ranking', async () => {
    mocks.scoredSearch.mockResolvedValue([]);
    await tool('gnomon_semantic_search').handler({ query: 'doctor', since: '2023-03-01', until: '2023-03-31' }, toolEnv(() => null, NOW));
    expect(mocks.scoredSearch).toHaveBeenLastCalledWith('doctor', 10, undefined, { since: '2023-03-01', until: '2023-03-31' });
  });
});
