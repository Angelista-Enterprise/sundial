import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { upsertEntity, findEntitiesByName, insertEntityFact, getAllEntities, loadAliasNames, getEntityFactTimeline, getEntityGraphEdges, supersedeEntityFact, reinforceEntityFact, decayCurrentFactConfidence, seedBetaFromConfidence, mergeEntityRows, resolveEntityAlias } from './entities.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE entities (
    id text PRIMARY KEY NOT NULL,
    kind text NOT NULL,
    canonical_name text NOT NULL,
    aliases_json text NOT NULL DEFAULT '[]',
    created_at text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE entity_facts (
    id text PRIMARY KEY NOT NULL,
    entity_id text NOT NULL,
    predicate text NOT NULL,
    object text NOT NULL,
    confidence integer NOT NULL,
    alpha real NOT NULL DEFAULT 1,
    beta real NOT NULL DEFAULT 1,
    valid_from text NOT NULL,
    valid_to text,
    superseded_by text,
    source_event_id text,
    created_at text NOT NULL,
    provenance text NOT NULL DEFAULT 'inference'
  )`);
  await db.run(sql`CREATE TABLE memory_embeddings (
    id text PRIMARY KEY NOT NULL, ref_type text NOT NULL, ref_id text NOT NULL, model text NOT NULL, vector blob NOT NULL, created_at text NOT NULL
  )`);
  return db;
}

describe('mergeEntityRows / resolveEntityAlias (J2.4 MergeEntity)', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('moves the facts, records the alias on the survivor, drops the hash row, and the alias resolves; a missing survivor merges nothing', async () => {
    await upsertEntity({ id: 'person:eva', kind: 'person', canonicalName: 'Eva', createdAt: '2026-01-01T00:00:00.000Z' });
    await upsertEntity({ id: 'person:person-e5a0c1d2b3', kind: 'person', canonicalName: 'person-e5a0c1d2b3', createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'person:person-e5a0c1d2b3', predicate: 'knownAs', object: 'Eva', confidence: 100, validFrom: '2026-01-02T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-02T00:00:00.000Z', provenance: 'assertion' });
    await insertEntityFact({ id: 'f2', entityId: 'person:person-e5a0c1d2b3', predicate: 'metWith', object: 'owner', confidence: 60, validFrom: '2026-01-03T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-03T00:00:00.000Z' });

    expect(await mergeEntityRows('person:person-e5a0c1d2b3', 'person:nobody', 'person-e5a0c1d2b3')).toBeNull();
    const moved = await mergeEntityRows('person:person-e5a0c1d2b3', 'person:eva', 'person-e5a0c1d2b3');
    expect(moved).toEqual({ facts: 2, embeddings: 0 });
    const all = await getAllEntities();
    expect(all.map((e) => e.id)).toEqual(['person:eva']);
    expect(await resolveEntityAlias('person-e5a0c1d2b3')).toBe('person:eva');
    expect(await resolveEntityAlias('person-ffffffffff')).toBeNull();
    // The fold still learns the hash is Eva, from the alias list rather than the moved fact.
    expect(await loadAliasNames()).toMatchObject({ 'person-e5a0c1d2b3': 'Eva' });
    // A repeat moves nothing and changes nothing.
    expect(await mergeEntityRows('person:person-e5a0c1d2b3', 'person:eva', 'person-e5a0c1d2b3')).toEqual({ facts: 0, embeddings: 0 });
  });
});

describe('findEntitiesByName (L5, docs/audit/remediation-todo.md standalone bug list)', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('finds a substring match for an ordinary name (baseline behavior unchanged)', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    const results = await findEntitiesByName('nom');
    expect(results).toHaveLength(1);
    expect(results[0].canonicalName).toBe('gnomon');
  });

  it("treats a literal '%' in the search name as a literal character, not a wildcard", async () => {
    await upsertEntity({ id: 'topic:50%-off', kind: 'topic', canonicalName: '50% off sale', createdAt: '2026-01-01T00:00:00.000Z' });
    await upsertEntity({ id: 'topic:unrelated', kind: 'topic', canonicalName: 'completely unrelated topic', createdAt: '2026-01-01T00:00:00.000Z' });

    const results = await findEntitiesByName('50% off');
    expect(results).toHaveLength(1);
    expect(results[0].canonicalName).toBe('50% off sale');
  });

  it("treats a literal '_' in the search name as a literal character, not a single-char wildcard", async () => {
    await upsertEntity({ id: 'tool:my_tool', kind: 'tool', canonicalName: 'my_tool', createdAt: '2026-01-01T00:00:00.000Z' });
    await upsertEntity({ id: 'tool:myXtool', kind: 'tool', canonicalName: 'myXtool', createdAt: '2026-01-01T00:00:00.000Z' });

    // Before the fix, `_` matched any single character, so this would have
    // matched both 'my_tool' and 'myXtool'.
    const results = await findEntitiesByName('my_tool');
    expect(results).toHaveLength(1);
    expect(results[0].canonicalName).toBe('my_tool');
  });

  it('is still case-insensitive after escaping', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'Gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    const results = await findEntitiesByName('gnomon');
    expect(results).toHaveLength(1);
  });

  it('returns an empty array when nothing matches', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(await findEntitiesByName('nonexistent')).toEqual([]);
  });
});

describe('getAllEntities', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('returns every entity with its fact count, alphabetical by canonical name', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    await upsertEntity({ id: 'person:priya', kind: 'person', canonicalName: 'priya nair', createdAt: '2026-01-02T00:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'project:gnomon', predicate: 'primaryTool', object: 'Xcode', confidence: 91, validFrom: '2026-01-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f2', entityId: 'project:gnomon', predicate: 'collaboratesOn', object: 'priya nair', confidence: 70, validFrom: '2026-01-02T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-02T00:00:00.000Z' });

    const all = await getAllEntities();

    expect(all).toHaveLength(2);
    expect(all[0].canonicalName).toBe('gnomon');
    expect(all[0].factCount).toBe(2);
    expect(all[1].canonicalName).toBe('priya nair');
    expect(all[1].factCount).toBe(0);
  });

  it('returns an empty array when no entities exist', async () => {
    expect(await getAllEntities()).toEqual([]);
  });

  it('respects limit/offset (pagination — the roster grows unbounded over the daemon lifetime)', async () => {
    await upsertEntity({ id: 'e1', kind: 'topic', canonicalName: 'alpha', createdAt: '2026-01-01T00:00:00.000Z' });
    await upsertEntity({ id: 'e2', kind: 'topic', canonicalName: 'bravo', createdAt: '2026-01-01T00:00:00.000Z' });
    await upsertEntity({ id: 'e3', kind: 'topic', canonicalName: 'charlie', createdAt: '2026-01-01T00:00:00.000Z' });

    const firstPage = await getAllEntities(2, 0);
    const secondPage = await getAllEntities(2, 2);

    expect(firstPage.map((e) => e.canonicalName)).toEqual(['alpha', 'bravo']);
    expect(secondPage.map((e) => e.canonicalName)).toEqual(['charlie']);
  });
});

describe('getEntityFactTimeline', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('orders by validFrom and respects limit/offset', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'project:gnomon', predicate: 'primaryTool', object: 'A', confidence: 90, validFrom: '2026-01-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f2', entityId: 'project:gnomon', predicate: 'primaryTool', object: 'B', confidence: 90, validFrom: '2026-01-02T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-02T00:00:00.000Z' });
    await insertEntityFact({ id: 'f3', entityId: 'project:gnomon', predicate: 'primaryTool', object: 'C', confidence: 90, validFrom: '2026-01-03T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-03T00:00:00.000Z' });

    const firstPage = await getEntityFactTimeline('project:gnomon', 2, 0);
    const secondPage = await getEntityFactTimeline('project:gnomon', 2, 2);

    expect(firstPage.map((f) => f.object)).toEqual(['A', 'B']);
    expect(secondPage.map((f) => f.object)).toEqual(['C']);
  });

  it('defaults to the full timeline when limit/offset are omitted', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'project:gnomon', predicate: 'primaryTool', object: 'A', confidence: 90, validFrom: '2026-01-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-01T00:00:00.000Z' });

    expect(await getEntityFactTimeline('project:gnomon')).toHaveLength(1);
  });
});

describe('getEntityGraphEdges', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('derives an edge when a fact object matches another entity canonical name, case-insensitively', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    await upsertEntity({ id: 'tool:xcode', kind: 'tool', canonicalName: 'Xcode', createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'project:gnomon', predicate: 'primaryTool', object: 'xcode', confidence: 91, validFrom: '2026-01-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-01T00:00:00.000Z' });

    const edges = await getEntityGraphEdges();

    expect(edges).toEqual([
      { factId: 'f1', fromEntityId: 'project:gnomon', toEntityId: 'tool:xcode', predicate: 'primaryTool', confidence: 91, superseded: false, provenance: 'inference' },
    ]);
  });

  it('does not derive a self-edge when a fact object happens to match its own entity', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'project:gnomon', predicate: 'about', object: 'gnomon', confidence: 80, validFrom: '2026-01-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-01T00:00:00.000Z' });

    expect(await getEntityGraphEdges()).toEqual([]);
  });

  it('does not derive an edge from a substring match (exact match only)', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    await upsertEntity({ id: 'project:gnomon-cli', kind: 'project', canonicalName: 'gnomon-cli', createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'project:gnomon-cli', predicate: 'relatesToProject', object: 'gnomon', confidence: 80, validFrom: '2026-01-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-01T00:00:00.000Z' });

    const edges = await getEntityGraphEdges();
    expect(edges).toEqual([{ factId: 'f1', fromEntityId: 'project:gnomon-cli', toEntityId: 'project:gnomon', predicate: 'relatesToProject', confidence: 80, superseded: false, provenance: 'inference' }]);
  });

  it('marks a superseded fact edge as superseded: true', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    await upsertEntity({ id: 'tool:terminal', kind: 'tool', canonicalName: 'Terminal', createdAt: '2026-01-01T00:00:00.000Z' });
    await upsertEntity({ id: 'tool:xcode', kind: 'tool', canonicalName: 'Xcode', createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'project:gnomon', predicate: 'primaryTool', object: 'Terminal', confidence: 80, validFrom: '2026-01-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f2', entityId: 'project:gnomon', predicate: 'primaryTool', object: 'Xcode', confidence: 91, validFrom: '2026-01-02T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-02T00:00:00.000Z' });
    await supersedeEntityFact('f1', 'f2', '2026-01-02T00:00:00.000Z');

    const edges = await getEntityGraphEdges();

    expect(edges).toContainEqual({ factId: 'f1', fromEntityId: 'project:gnomon', toEntityId: 'tool:terminal', predicate: 'primaryTool', confidence: 80, superseded: true, provenance: 'inference' });
    expect(edges).toContainEqual({ factId: 'f2', fromEntityId: 'project:gnomon', toEntityId: 'tool:xcode', predicate: 'primaryTool', confidence: 91, superseded: false, provenance: 'inference' });
  });

  it("carries the fact's provenance, so an asserted edge is distinguishable from a corroborated one", async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    await upsertEntity({ id: 'tool:xcode', kind: 'tool', canonicalName: 'Xcode', createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'project:gnomon', predicate: 'primaryTool', object: 'Xcode', confidence: 100, validFrom: '2026-01-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-01T00:00:00.000Z', provenance: 'assertion' });

    const [edge] = await getEntityGraphEdges();

    expect(edge.provenance).toBe('assertion');
  });

  it('returns an empty array when no fact object matches another entity', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'project:gnomon', predicate: 'primaryTool', object: 'some untracked tool', confidence: 80, validFrom: '2026-01-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-01T00:00:00.000Z' });

    expect(await getEntityGraphEdges()).toEqual([]);
  });
});

describe('Beta posterior confidence (Phase 2a)', () => {
  const T = '2026-01-01T00:00:00.000Z';
  beforeEach(async () => {
    await setupTestDb();
    await upsertEntity({ id: 'project:g', kind: 'project', canonicalName: 'g', createdAt: T });
  });

  it('seedBetaFromConfidence maps a 0-100 confidence to a Beta prior whose mean matches', () => {
    expect(seedBetaFromConfidence(70)).toEqual({ alpha: 7, beta: 3 });
    expect(seedBetaFromConfidence(50)).toEqual({ alpha: 5, beta: 5 });
    expect(seedBetaFromConfidence(0)).toEqual({ alpha: 1, beta: 10 });
    expect(seedBetaFromConfidence(100)).toEqual({ alpha: 10, beta: 1 });
  });

  it('insertEntityFact seeds alpha/beta from confidence', async () => {
    await insertEntityFact({ id: 'f1', entityId: 'project:g', predicate: 'primaryTool', object: 'Code', confidence: 70, validFrom: T, sourceEventId: null, createdAt: T });
    const [f] = await getEntityFactTimeline('project:g');
    expect(f.alpha).toBe(7);
    expect(f.beta).toBe(3);
    expect(f.confidence).toBe(70);
  });

  it('reinforceEntityFact bumps alpha and raises the derived confidence (diminishing)', async () => {
    await insertEntityFact({ id: 'f1', entityId: 'project:g', predicate: 'primaryTool', object: 'Code', confidence: 70, validFrom: T, sourceEventId: null, createdAt: T });
    await reinforceEntityFact('f1', 3); // alpha 7->10, beta 3 => round(100*10/13)=77
    const [f] = await getEntityFactTimeline('project:g');
    expect(f.alpha).toBe(10);
    expect(f.confidence).toBe(77);
  });

  it('reinforceEntityFact on the beta side is evidence against: confidence falls, the record stays', async () => {
    await insertEntityFact({ id: 'f1', entityId: 'project:g', predicate: 'usesTool', object: 'Code', confidence: 70, validFrom: T, sourceEventId: null, createdAt: T });
    await reinforceEntityFact('f1', 1, 'beta'); // alpha 7, beta 3->4 => round(100*7/11)=64
    const [f] = await getEntityFactTimeline('project:g');
    expect(f.beta).toBe(4);
    expect(f.confidence).toBe(64);
    expect(f.object).toBe('Code');
  });

  it('decayCurrentFactConfidence drifts certainty toward the prior WITHOUT touching the record (D8)', async () => {
    await insertEntityFact({ id: 'f1', entityId: 'project:g', predicate: 'primaryTool', object: 'Code', confidence: 90, validFrom: T, sourceEventId: null, createdAt: T });
    await decayCurrentFactConfidence(0.5); // alpha 1+(9-1)*.5=5, beta 1+(1-1)*.5=1 => round(100*5/6)=83
    const [f] = await getEntityFactTimeline('project:g');
    expect(f.alpha).toBe(5);
    expect(f.beta).toBe(1);
    expect(f.confidence).toBe(83);
    expect(f.object).toBe('Code'); // the record is immutable
    expect(f.validFrom).toBe(T);
  });

  it('decay skips superseded facts (only current beliefs fade)', async () => {
    await insertEntityFact({ id: 'f1', entityId: 'project:g', predicate: 'primaryTool', object: 'Code', confidence: 90, validFrom: T, sourceEventId: null, createdAt: T });
    await supersedeEntityFact('f1', 'f2', '2026-01-02T00:00:00.000Z');
    await decayCurrentFactConfidence(0.5);
    const [f] = await getEntityFactTimeline('project:g');
    expect(f.alpha).toBe(9); // untouched — it's superseded
    expect(f.confidence).toBe(90);
  });
});

/**
 * The boot-time rehydration of `KernelState.memory.aliasNames`.
 *
 * The defect this closes: that map is mirrored by `contradictionCheck` during a
 * fold, so it only survives if the fold that built it is inside the current
 * snapshot or the replayed tail. A name given last week is in neither, so this
 * machine booted on 2026-09-09 with an empty mirror against 18 valid `knownAs`
 * facts — and `peopleAsk`, which skips an alias the mirror names, asked the
 * owner to identify seven people it had already been told about.
 */
describe('loadAliasNames', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  const person = async (alias: string) =>
    upsertEntity({ id: `person:${alias}`, kind: 'person', canonicalName: alias, createdAt: '2026-01-01T00:00:00.000Z' });

  const knownAs = async (id: string, alias: string, name: string, at: string) => {
    await insertEntityFact({
      id,
      entityId: `person:${alias}`,
      predicate: 'knownAs',
      object: name,
      confidence: 100,
      validFrom: at,
      sourceEventId: null,
      createdAt: at,
      provenance: 'assertion',
    });
  };

  it('reads back the current name for each hashed person', async () => {
    await person('person-c205ca11f2');
    await person('person-d1feb17d9f');
    await knownAs('f1', 'person-c205ca11f2', 'Alex Morgan', '2026-09-01T00:00:00.000Z');
    await knownAs('f2', 'person-d1feb17d9f', 'Jordan De Wit', '2026-09-01T00:00:00.000Z');

    expect(await loadAliasNames()).toEqual({
      'person-c205ca11f2': 'Alex Morgan',
      'person-d1feb17d9f': 'Jordan De Wit',
    });
  });

  // The real row this guards: `person-c205ca11f2` carries three `knownAs` facts
  // on the live record — "in which meeting where they?" (a question filed as a
  // name, superseded), "Alexm" (a derivation, superseded) and the correction.
  // Only the correction is current, and only it may reach the mirror.
  it('ignores superseded names and returns only the correction', async () => {
    await person('person-c205ca11f2');
    await knownAs('f1', 'person-c205ca11f2', 'in which meeting where they?', '2026-09-07T13:00:00.000Z');
    await knownAs('f2', 'person-c205ca11f2', 'Alexm', '2026-09-07T14:07:00.000Z');
    await knownAs('f3', 'person-c205ca11f2', 'Alex Morgan', '2026-09-07T14:11:00.000Z');
    // Superseded through the real path, so the test exercises the same rows the
    // executor writes rather than a hand-built approximation of them.
    await supersedeEntityFact('f1', 'f2', '2026-09-07T14:06:56.992Z');
    await supersedeEntityFact('f2', 'f3', '2026-09-07T14:10:39.122Z');

    expect(await loadAliasNames()).toEqual({ 'person-c205ca11f2': 'Alex Morgan' });
  });

  it('is empty rather than absent when nothing is named', async () => {
    await person('person-c205ca11f2');
    expect(await loadAliasNames()).toEqual({});
  });

  it('carries no predicate other than knownAs, and no kind other than person', async () => {
    await person('person-c205ca11f2');
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({
      id: 'f9',
      entityId: 'person:person-c205ca11f2',
      predicate: 'worksOn',
      object: 'gnomon',
      confidence: 90,
      validFrom: '2026-09-01T00:00:00.000Z',
      sourceEventId: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      provenance: 'inference',
    });
    await insertEntityFact({
      id: 'f10',
      entityId: 'project:gnomon',
      predicate: 'knownAs',
      object: 'Sundial',
      confidence: 90,
      validFrom: '2026-09-01T00:00:00.000Z',
      sourceEventId: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      provenance: 'inference',
    });

    expect(await loadAliasNames()).toEqual({});
  });
});

/**
 * The identity join at the read boundary.
 *
 * A hashed attendee's entity is named for its hash, and the human name lives in
 * a `knownAs` fact — so a canonical-name-only search hid 18 of this record's 39
 * people from every tool the model has, and split five humans across two
 * entities each ("Alex" and `person-c205ca11f2` knownAs "Alex Morgan").
 */
describe('findEntitiesByName reaches a name held as a belief', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  const named = async (alias: string, name: string, id = `f-${alias}`) => {
    await upsertEntity({ id: `person:${alias}`, kind: 'person', canonicalName: alias, createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({
      id,
      entityId: `person:${alias}`,
      predicate: 'knownAs',
      object: name,
      confidence: 100,
      validFrom: '2026-09-01T00:00:00.000Z',
      sourceEventId: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      provenance: 'assertion',
    });
  };

  it('finds a hashed person by the name believed for them', async () => {
    await named('person-c205ca11f2', 'Alex Morgan');
    const found = await findEntitiesByName('Alex Morgan');
    expect(found.map((e) => e.canonicalName)).toEqual(['person-c205ca11f2']);
  });

  it('returns BOTH entities when one human exists twice, each holding half the facts', async () => {
    await named('person-c205ca11f2', 'Alex Morgan');
    await upsertEntity({ id: 'person:Alex', kind: 'person', canonicalName: 'Alex', createdAt: '2026-01-01T00:00:00.000Z' });

    const found = await findEntitiesByName('Alex');
    expect(found.map((e) => e.canonicalName).sort()).toEqual(['Alex', 'person-c205ca11f2']);
  });

  it('does not resurrect a person under a name that was corrected', async () => {
    await named('person-c205ca11f2', 'Alexm', 'f-old');
    await named('person-c205ca11f2', 'Alex Morgan', 'f-new');
    await supersedeEntityFact('f-old', 'f-new', '2026-09-07T14:10:39.122Z');

    expect(await findEntitiesByName('Alexm')).toEqual([]);
    expect((await findEntitiesByName('Alex Morgan')).map((e) => e.canonicalName)).toEqual(['person-c205ca11f2']);
  });

  it('lists an entity once even when both its name and its belief match', async () => {
    await named('Eva', 'Eva');
    expect(await findEntitiesByName('Eva')).toHaveLength(1);
  });

  it('matches on knownAs only, not on any other predicate', async () => {
    await upsertEntity({ id: 'person:p1', kind: 'person', canonicalName: 'person-aaaaaaaaaa', createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({
      id: 'f1',
      entityId: 'person:p1',
      predicate: 'worksOn',
      object: 'Kruiswoorden',
      confidence: 90,
      validFrom: '2026-09-01T00:00:00.000Z',
      sourceEventId: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      provenance: 'inference',
    });
    expect(await findEntitiesByName('Kruiswoorden')).toEqual([]);
  });
});
