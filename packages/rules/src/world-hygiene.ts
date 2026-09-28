import type { Effect, KernelState, Rule } from '@sundial/kernel/types.js';
import { slugifyEntityName } from './entity-extract.js';
import { canonicalOwnerName, knownProjectNames, rejectEntityName, type EntityNameContext } from './entity-name-validation.js';
import { predicateCardinality } from './predicate-cardinality.js';

/**
 * W2 — what today's writer would refuse, the record stops holding.
 *
 * The 2026-09-23 card audit found the world model's worst faults were not live
 * bugs but LEFTOVERS of bugs already fixed: 68 topics minted from edited code
 * symbols by a producer retired on 2026-09-07; four goals recorded twice by a
 * second write door that was removed; the owner's own assertions stranded on a
 * capital-R `topic:Pat` the September migration missed. Every fix upstream
 * stopped new damage and left the old in place, and every card that reads
 * entities has been drawing it since.
 *
 * So one deterministic pass, in `nightlyBeliefAudit`'s shape — this rule asks,
 * the executor reads the DB and runs `planHygiene`, a `world:hygiene` event
 * carries the plan into the log, and `applyWorldHygiene` emits the effects. The
 * plan being in the log is the point: every retraction and merge it makes is
 * attributable to a named rule and a reason, and a second run on a clean record
 * plans nothing. Arithmetic, not judgement — no model is asked anything here.
 */

export interface HygieneEntity {
  id: string;
  kind: string;
  canonicalName: string;
}

export interface HygieneFact {
  id: string;
  entityId: string;
  predicate: string;
  object: string;
  confidence: number;
  provenance: string;
  createdAt: string;
  /** The `signal_type` of the event the fact came from, or null. */
  sourceType: string | null;
}

export type HygieneAction = { op: 'retract'; factId: string; reason: string } | { op: 'merge'; from: string; into: string; alias: string; reason: string };

/**
 * Producers whose output is no longer knowledge. `symbol:edited` and
 * `screen:ocr` minted `topic relatesToProject` facts until 2026-09-07; measured
 * over thirty days they wrote 85 and the owner marked none useful. The events
 * stay in the log and in the moments; only the facts go.
 */
const RETIRED_SOURCES = new Set(['symbol', 'screen']);

const norm = (text: string): string => text.trim().toLowerCase();

/**
 * The plan, pure. Order matters and is kept: retractions first, then merges,
 * because a merge moves every fact the `from` entity still holds and a fact that
 * should not survive must be gone before it is carried across.
 */
export function planHygiene(entities: HygieneEntity[], facts: HygieneFact[], context: EntityNameContext): HygieneAction[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const retract = new Map<string, string>();
  const merges: HygieneAction[] = [];
  const drop = (factId: string, reason: string) => {
    if (!retract.has(factId)) retract.set(factId, reason);
  };

  const ownerName = context.ownerAliases?.[0];
  const ownerId = ownerName ? `owner:${slugifyEntityName(ownerName)}` : null;

  // Two ids for one name within a kind — the goal write door that stored the
  // raw name beside the slug. The slugged id is the canonical one.
  const canonicalId = (e: HygieneEntity) => `${e.kind}:${slugifyEntityName(e.canonicalName)}`;

  for (const fact of facts) {
    const entity = byId.get(fact.entityId);
    if (!entity) continue;
    const asserted = fact.provenance === 'assertion';

    if (fact.sourceType !== null && RETIRED_SOURCES.has(fact.sourceType) && !asserted) {
      drop(fact.id, `from a retired producer (${fact.sourceType})`);
      continue;
    }
    // An alias that is its own name says nothing, whoever said it.
    if (fact.predicate === 'knownAs' && norm(fact.object) === norm(entity.canonicalName)) {
      drop(fact.id, 'an alias equal to its own name');
      continue;
    }
    // An owner alias under another kind is MERGED below, not judged by name —
    // today's validator refuses it, and that refusal is exactly why it moves.
    if (entity.kind !== 'owner' && ownerId !== null && canonicalOwnerName(entity.canonicalName, context.ownerAliases) !== null) continue;
    // What today's validator refuses, the record should not still hold. Never
    // an assertion: the owner's word is kept even when its shape is odd.
    if (!asserted) {
      const rejected = rejectEntityName(entity.kind, entity.canonicalName, fact.provenance as never, context);
      if (rejected) drop(fact.id, `the name is refused today: ${rejected.reason}`);
    }
  }

  // Two current values of a ONE-value predicate on one entity: the newer word
  // wins. This is the invariant, and the merge block below only keeps a merge
  // from breaking it — the first live pass (2026-09-23 17:51) ran before that
  // block existed and left the four merged goals each holding two statuses
  // (done and dropped), which this is what repaired.
  const functional = new Map<string, HygieneFact[]>();
  for (const fact of facts) {
    if (retract.has(fact.id) || predicateCardinality(fact.predicate) !== 'functional') continue;
    const key = `${fact.entityId}\u0000${fact.predicate}`;
    functional.set(key, [...(functional.get(key) ?? []), fact]);
  }
  for (const group of functional.values()) {
    if (group.length < 2) continue;
    const [newest, ...older] = [...group].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const fact of older) drop(fact.id, `superseded by ${newest.id} (${fact.predicate}, newer)`);
  }

  // Identical current facts — one entity, one predicate, one object, said
  // twice. The strongest stays; ties keep the older.
  const groups = new Map<string, HygieneFact[]>();
  for (const fact of facts) {
    if (retract.has(fact.id)) continue;
    const key = `${fact.entityId}\u0000${fact.predicate}\u0000${norm(fact.object)}`;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = [...group].sort((a, b) => b.confidence - a.confidence || a.createdAt.localeCompare(b.createdAt));
    for (const fact of rest) drop(fact.id, `a duplicate of ${keep.id}`);
  }

  for (const entity of entities) {
    if (entity.kind !== 'owner' && ownerId !== null && byId.has(ownerId) && canonicalOwnerName(entity.canonicalName, context.ownerAliases) !== null) {
      merges.push({ op: 'merge', from: entity.id, into: ownerId, alias: entity.canonicalName, reason: 'an owner alias recorded as another kind' });
      continue;
    }
    const canonical = canonicalId(entity);
    if (canonical !== entity.id && byId.has(canonical)) {
      merges.push({ op: 'merge', from: entity.id, into: canonical, alias: entity.canonicalName, reason: 'the same name under a second id' });
    }
  }

  // The owner said this name IS another one the record already holds (W5:
  // `Alexm` knownAs `Alex Morgan`). Only the owner's word merges — a
  // model's or a conversation's `knownAs` stays a suggestion. The alias fact is
  // spent by the merge (the survivor keeps the name as an alias), so it goes.
  for (const fact of facts) {
    const entity = byId.get(fact.entityId);
    if (!entity || fact.predicate !== 'knownAs' || fact.provenance !== 'assertion' || retract.has(fact.id)) continue;
    const into = `${entity.kind}:${slugifyEntityName(fact.object)}`;
    if (into === entity.id || !byId.has(into) || merges.some((m) => m.op === 'merge' && m.from === entity.id)) continue;
    drop(fact.id, `carried out as a merge into ${into}`);
    merges.push({ op: 'merge', from: entity.id, into, alias: entity.canonicalName, reason: 'the owner named it as another entity' });
  }

  // A merge must not leave two values of a one-value predicate on the survivor.
  // Measured on the four twice-recorded goals: every pair held two DIFFERENT
  // statuses — done on one id, dropped on the other — because the owner's later
  // tap landed on the phantom twin while the card kept reading the first. So
  // for each functional predicate held on both sides, the NEWER word wins,
  // whichever side it is on. The owner merge is the same case: the August
  // bedtime on `topic:Pat` loses to the September one on the owner.
  const current = (entityId: string) => facts.filter((f) => f.entityId === entityId && !retract.has(f.id));
  for (const merge of merges) {
    if (merge.op !== 'merge') continue;
    const into = current(merge.into);
    for (const stray of current(merge.from)) {
      if (predicateCardinality(stray.predicate) !== 'functional') continue;
      for (const held of into.filter((f) => f.predicate === stray.predicate)) {
        const [older, newer] = stray.createdAt < held.createdAt ? [stray, held] : [held, stray];
        drop(older.id, `superseded on merge by ${newer.id} (${stray.predicate}, newer)`);
      }
    }
  }

  return [...[...retract].map(([factId, reason]) => ({ op: 'retract' as const, factId, reason })), ...merges];
}

/** First tick after it ships, then every day boundary — `nightlyBeliefAudit`'s cadence. */
export const worldHygiene: Rule = (state, event) => {
  const first = (state.memory.lastHygieneAt ?? null) === null && event.type === 'clock:tick';
  // `world:hygiene-requested` — an operator asking for a pass now rather than at
  // midnight. Added to repair the first run's leftovers the same evening.
  if (!first && event.type !== 'day:boundary' && event.type !== 'world:hygiene-requested') return { state, effects: [] };
  return {
    state: { ...state, memory: { ...state.memory, lastHygieneAt: event.ts } },
    effects: [{ type: 'RunWorldHygiene', ts: event.ts }],
  };
};

/** The name context the executor plans against — the same one `contradictionCheck` refuses candidates with. */
export function hygieneContext(state: KernelState): EntityNameContext {
  return { ownerAliases: state.config.ownerAliases, projectNames: knownProjectNames(state.config.projectAliases, state.project.known) };
}

/** The plan comes back as an event and becomes effects here, so no rule is bypassed and nothing is written that the log cannot explain. */
export const applyWorldHygiene: Rule = (state, event) => {
  if (event.type !== 'world:hygiene') return { state, effects: [] };
  const actions = (event.payload as { actions?: HygieneAction[] }).actions ?? [];
  const effects: Effect[] = actions.map((action) =>
    action.op === 'retract'
      ? { type: 'RetractFact', factId: action.factId, reason: `hygiene: ${action.reason}`, ts: event.ts }
      : { type: 'MergeEntity', from: action.from, into: action.into, alias: action.alias, ts: event.ts },
  );
  return { state, effects };
};
