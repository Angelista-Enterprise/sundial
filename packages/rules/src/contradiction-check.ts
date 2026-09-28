import { deriveId } from '@sundial/helpers/derive-id.js';
import type { KernelState, Rule } from '@sundial/kernel/types.js';
import type { FactCandidate } from './entity-extract.js';
import { predicateCardinality } from './predicate-cardinality.js';
import { knownProjectNames, rejectEntityName, REDACTION_ALIAS } from './entity-name-validation.js';

const MAX_RECENT_ENTITY_IDS = 64;
const MAX_FACT_CURSOR_ENTRIES = 512;

/** Phase 2a (D7) — how much a single re-observation reinforces a confirmed fact's Beta posterior. */
const REINFORCE_DELTA = 1;

/**
 * D3 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.5) —
 * "a `primaryTool` candidate must recur across M distinct moments... before
 * insert." Applied generically to every predicate (not special-cased to
 * `primaryTool`), since the mechanism — count distinct observations in
 * `factCursor` before acting — is the same regardless of which predicate is
 * being observed.
 */
const MIN_OBSERVATIONS_FOR_NEW_FACT = 2;

/**
 * D3 — "contradictions require sustained observation (e.g. conflicting
 * object seen in >=3 consecutive moments) before supersession," closing the
 * gap this file's original doc comment named: "a one-off anomalous
 * observation could flip a stable fact."
 */
const MIN_OBSERVATIONS_FOR_SUPERSESSION = 3;

/**
 * `topic` carries a higher bar than every other entity kind, and the reason is
 * evidential rather than aesthetic.
 *
 * A `person`, `project` or `tool` candidate names something with an independent
 * existence — a git remote, a running process, a calendar attendee — so two
 * consecutive sightings really are two pieces of evidence about a stable thing. A
 * `topic` is a label someone or something inferred from text, and the historical
 * record shows how weak that is: 320 topic candidates produced 2 entities
 * (concepts/memory-tiers), because a value derived from prose differs slightly
 * every time it is derived. The ones that DO accumulate consecutive matches are
 * therefore not necessarily the most real — just the most repetitively phrased.
 *
 * The concrete case that set this threshold: the first full recompute promoted
 * eleven search queries into core memory (`toy story 5`, `ney york times games`,
 * `020 vs 010`) from `entity:fact-candidate` events emitted before the
 * `search:performed` → topic path was removed from `entityExtract`. Those events
 * are permanent, so the producer's removal does not stop them replaying, and each
 * had cleared a bar of two. They are well-formed, so
 * `entity-name-validation.ts`'s shape gate correctly leaves them alone — this is
 * the corroboration question rather than the shape question.
 *
 * Four rather than two keeps a genuinely recurring interest (searched or read
 * about repeatedly, which is real signal about what the owner cares about and the
 * only route to interests that never appear in a window title or a repo) while
 * dropping a passing curiosity. An owner assertion still promotes on one
 * observation; this is a bar on inference, not on the owner.
 */
const MIN_OBSERVATIONS_BY_KIND: Record<string, number> = { topic: 4 };

/**
 * Predicates whose evidence is a structured record rather than an inference, and
 * which therefore promote on a single observation.
 *
 * Keyed by PREDICATE, not by entity kind, and that distinction is the whole design.
 * `person` as a kind must keep the ordinary bar: the nightly `extract` pass also
 * produces person facts, and those are a model's reading of prose evidence lines —
 * exactly the weak, differently-phrased-every-time inference `topic`'s bar above
 * exists to catch. `attendedMeetingWith` is a different class of claim entirely. Its
 * evidence is the calendar server's own attendee list on its own event id: the
 * person was in the meeting or they were not, and seeing the same invite twice adds
 * no information a second look could confirm.
 *
 * Three properties make one observation safe here, and all three have to hold before
 * a predicate belongs in this table:
 *
 * 1. **Structured provenance.** The value is copied from a field an external system
 *    populated, not derived from text. No paraphrase, no spelling drift.
 * 2. **Set-valued and additive.** Co-attendance never contradicts prior
 *    co-attendance, so a single observation cannot flip a stable belief — the
 *    failure `MIN_OBSERVATIONS_FOR_SUPERSESSION` exists to prevent. Supersession is
 *    untouched by this table and still needs its three.
 * 3. **Falsifiable and decaying.** The fact seeds a modest posterior (confidence 60)
 *    and `factConfidenceDecay` drifts it toward 50% if it is never reconfirmed, so a
 *    one-off contact fades to "I remember believing this" rather than standing as
 *    settled truth for ever.
 *
 * Measured justification, 2026-08-14: across the live 14-day corpus NO real-named
 * attendee appears in two distinct meetings. The only attendees clearing a bar of
 * two are the owner's own redaction alias (9 meetings), a project alias
 * (`puzzlebox-team`, 10), and meeting-room codes — every one of which
 * `rejectEntityName` then correctly discards. Under the ordinary bar this producer
 * yields exactly zero colleagues, not as a tuning problem but by construction: real
 * people mostly attend one meeting each within any short window. The bar was
 * measuring repetition, and repetition is not what makes an invite true.
 */
const MIN_OBSERVATIONS_BY_PREDICATE: Record<string, number> = { attendedMeetingWith: 1 };

function minObservationsForNewFact(entityKind: string, predicate: string): number {
  return MIN_OBSERVATIONS_BY_PREDICATE[predicate] ?? MIN_OBSERVATIONS_BY_KIND[entityKind] ?? MIN_OBSERVATIONS_FOR_NEW_FACT;
}

type FactCursorEntry = KernelState['memory']['factCursor'][string];

const EMPTY_CURSOR_ENTRY: FactCursorEntry = { object: null, factId: null, confidence: 0, pendingObject: null, pendingCount: 0, projectId: null };

/** Backfills `pendingObject`/`pendingCount`/`projectId` for a cursor entry written before those fields existed — see `types.ts`'s `factCursor` doc comment. */
function normalizeCursorEntry(entry: FactCursorEntry | undefined): FactCursorEntry {
  if (!entry) return EMPTY_CURSOR_ENTRY;
  return { object: entry.object, factId: entry.factId, confidence: entry.confidence, pendingObject: entry.pendingObject ?? null, pendingCount: entry.pendingCount ?? 0, projectId: entry.projectId ?? null };
}

function pushRecentEntity(recentEntityIds: string[], entityId: string): string[] {
  const withoutExisting = recentEntityIds.filter((id) => id !== entityId);
  return [...withoutExisting, entityId].slice(-MAX_RECENT_ENTITY_IDS);
}

// A§1.4 — every distinct `${entityId}:${predicate}` ever observed
// accumulated in this map forever (unbounded in the number of entities/
// predicates ever seen, e.g. every calendar attendee). LRU by touch order:
// re-inserting `key` last (after dropping its old position) makes it the
// most-recently-touched entry, so eviction below drops the entries that have
// gone longest without a repeated or contradicting observation.
//
// Confirmed entries (`object !== null`) evict LAST, after every unconfirmed
// one, regardless of recency: a long-confirmed fact that simply hasn't been
// re-observed must not silently drop out of the cursor. If it did, a later
// re-observation would see an empty slot, restart the full promotion streak
// from scratch, and — worse — be unable to `SupersedeFact` the prior confirmed
// value even for a genuine sustained contradiction (it would insert a second,
// unrelated row instead). Only if there are more confirmed entries than the
// cap itself does eviction reach into them (oldest-first).
export function touchFactCursor(
  factCursor: KernelState['memory']['factCursor'],
  key: string,
  value: KernelState['memory']['factCursor'][string],
): KernelState['memory']['factCursor'] {
  const rest = Object.fromEntries(Object.entries(factCursor).filter(([k]) => k !== key));
  const next = { ...rest, [key]: value };
  const keys = Object.keys(next);
  if (keys.length <= MAX_FACT_CURSOR_ENTRIES) return next;
  const overflow = keys.length - MAX_FACT_CURSOR_ENTRIES;
  // Insertion order (oldest first) is preserved by Object.keys; filtering
  // keeps that order within each group. Drain unconfirmed oldest-first, only
  // then confirmed oldest-first.
  const evictionOrder = [...keys.filter((k) => next[k]!.object === null), ...keys.filter((k) => next[k]!.object !== null)];
  for (const staleKey of evictionOrder.slice(0, overflow)) delete next[staleKey];
  return next;
}

/**
 * Reacts to `entity:fact-candidate` (`entityExtract`, previous rule).
 * `state.memory.factCursor` — keyed `${entityId}:${predicate}` — is the
 * in-memory "what did we last assert about this" cache (docs/design/02-
 * state-and-reducer.md), avoiding a DB read for the common case of a
 * repeated observation.
 *
 * D3 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.5)
 * replaced the original "act on the very first observation" behavior with
 * a promotion policy, unifying two cases the proposal describes separately
 * into one mechanism — a cursor entry tracks at most one *pending* value
 * (`pendingObject`/`pendingCount`) alongside the currently-confirmed one
 * (`object`/`factId`, `null` until something has actually been promoted):
 *
 * 1. Candidate matches the confirmed `object` → a repeated observation of
 *    known truth. No-op besides refreshing `confidence` and clearing any
 *    in-flight pending value — reverting to the confirmed truth breaks a
 *    contradiction's "consecutive" streak (see 3 below).
 * 2. Candidate matches the pending value → one more consecutive
 *    observation of the same not-yet-promoted value. Bump `pendingCount`;
 *    once it reaches the threshold, promote: `UpsertEntityFact` (+ an
 *    `Embed` of the fact sentence, so `ask`/`search` can retrieve it) and,
 *    if there was a prior confirmed fact, `SupersedeFact` on it first (the
 *    old fact is never overwritten — see `entities.ts`'s doc comments).
 * 3. Candidate matches neither → a brand-new pending value, count reset to
 *    1. (This also covers "no cursor entry at all yet," which starts from
 *    an implicit `{object: null, pendingObject: null, pendingCount: 0}`.)
 *
 * Two thresholds, per the proposal's own wording: `object === null` (no
 * confirmed fact yet) needs `minObservationsForNewFact(kind)` — which is
 * `MIN_OBSERVATIONS_FOR_NEW_FACT` for every kind except `topic`, whose weaker
 * evidence earns a higher bar — distinct
 * moments before the *first* insert; `object !== null` (a real
 * contradiction against known truth) needs the stricter
 * `MIN_OBSERVATIONS_FOR_SUPERSESSION` — this is what closes the gap this
 * file used to name explicitly: "a one-off anomalous observation could
 * flip a stable fact."
 */
export const contradictionCheck: Rule = (state, event) => {
  if (event.type !== 'entity:fact-candidate') return { state, effects: [] };

  const candidate = event.payload as unknown as FactCandidate;
  // Absent on an `entity:fact-candidate` logged before `FactProvenance`
  // existed (replay) — treat as the conservative default, same as every
  // producer wired before this change.
  const provenance = candidate.provenance ?? 'inference';

  /**
   * Shape gate, before the candidate is allowed to touch the cursor at all.
   *
   * This is deliberately on the CONSUMER side. A candidate event is permanent, so
   * removing a defective producer stops new junk but does nothing about what it
   * already wrote to the log — and the first full recompute proved that, by
   * resurrecting a bare `)` as a topic and the redaction alias
   * `person-0a1b2c3d4e` as a person from events emitted before the producer was
   * fixed. Rejecting here is what makes every future replay clean without
   * rewriting history. See `entity-name-validation.ts`.
   *
   * Rejected before the cursor rather than after: a junk candidate must not even
   * break the consecutive-observation streak of a legitimate pending value that
   * happens to share its key.
   */
  const nameContext = {
    ownerAliases: state.config.ownerAliases,
    projectNames: knownProjectNames(state.config.projectAliases, state.project.known),
  };
  if (rejectEntityName(candidate.entityKind, candidate.canonicalName, provenance, nameContext)) return { state, effects: [] };

  // Phase 2a (D9) — cardinality decides the cursor key. Functional predicates
  // (one value per entity) key by (entity, predicate) so a competing object
  // supersedes; set-valued predicates key by (entity, predicate, object) so
  // each value is tracked and promoted independently and coexists — the fix for
  // `collaboratesOn`-style predicates wrongly superseding each other.
  const key =
    predicateCardinality(candidate.predicate) === 'set'
      ? `${candidate.entityId}:${candidate.predicate}:${candidate.object}`
      : `${candidate.entityId}:${candidate.predicate}`;
  const existing = normalizeCursorEntry(state.memory.factCursor[key]);

  const recentEntityIds = pushRecentEntity(state.memory.recentEntityIds, candidate.entityId);

  /**
   * A confirmed `knownAs` on a redaction alias, mirrored into
   * `memory.aliasNames` so a pure rule can read who the hashed people are —
   * every producer of the belief passes through here, so the map cannot miss
   * one the way a per-rule copy did.
   */
  function withAliasName(names: Record<string, string>): Record<string, string> {
    if (candidate.predicate !== 'knownAs' || !REDACTION_ALIAS.test(candidate.canonicalName)) return names;
    const name = candidate.object.trim();
    if (name === '' || names[candidate.canonicalName] === name) return names;
    return { ...names, [candidate.canonicalName]: name };
  }

  function withCursor(entry: FactCursorEntry) {
    return { ...state, memory: { ...state.memory, recentEntityIds, aliasNames: withAliasName(state.memory.aliasNames ?? {}), factCursor: touchFactCursor(state.memory.factCursor, key, entry) } };
  }

  function promote() {
    const factId = deriveId(event.ts, event.id, 'contradiction-check', candidate.entityId, candidate.predicate);
    const embedId = deriveId(event.ts, event.id, 'contradiction-check-embed', candidate.entityId, candidate.predicate);
    const upsert = {
      type: 'UpsertEntityFact' as const,
      factId,
      entityId: candidate.entityId,
      entityKind: candidate.entityKind,
      canonicalName: candidate.canonicalName,
      predicate: candidate.predicate,
      object: candidate.object,
      confidence: candidate.confidence,
      sourceEventId: candidate.sourceEventId,
      ts: event.ts,
      provenance,
    };
    // D3 — embedded so `ask`/`search` retrieve graph knowledge, not just episodic moments/knowledge entries.
    const embed = { type: 'Embed' as const, id: embedId, refType: 'entity_fact' as const, refId: factId, text: `${candidate.canonicalName} ${candidate.predicate} ${candidate.object}` };

    const nextState = withCursor({ object: candidate.object, factId, confidence: candidate.confidence, pendingObject: null, pendingCount: 0, projectId: candidate.projectId ?? existing.projectId });

    if (existing.factId === null) {
      return { state: nextState, effects: [upsert, embed] };
    }
    // Superseded, never deleted — even an owner's correction keeps the prior
    // fact's timeline (see assertions-versus-observations: "you used to
    // believe X and I corrected it" is itself information worth keeping).
    return { state: nextState, effects: [{ type: 'SupersedeFact' as const, factId: existing.factId, supersededByFactId: factId, ts: event.ts }, upsert, embed] };
  }

  // Case 1 — repeat of the confirmed truth: supporting evidence. Cancel any
  // in-flight contradiction and (Phase 2a, D7) REINFORCE the fact's Beta
  // posterior so its confidence rises with re-observation instead of staying
  // pinned at its insert value. `confidence` on the cursor is a stale hint; the
  // authoritative posterior lives on the DB row the executor updates.
  if (existing.object !== null && existing.object === candidate.object) {
    const nextState = withCursor({ ...existing, confidence: candidate.confidence, pendingObject: null, pendingCount: 0, projectId: candidate.projectId ?? existing.projectId });
    if (existing.factId === null) return { state: nextState, effects: [] };
    return { state: nextState, effects: [{ type: 'ReinforceFact', factId: existing.factId, delta: REINFORCE_DELTA, ts: event.ts }] };
  }

  // An assertion (the owner directly stating or correcting a fact) supersedes
  // on a single observation — being told something twice doesn't make it
  // truer, and an inference's corroboration bar doesn't apply to a claim that
  // was never a noisy signal in the first place (assertions-versus-observations).
  if (provenance === 'assertion') return promote();
  // Same for a fact the owner stated in chat: the sentence was said once and
  // will not recur as the same triple, so a corroboration bar would keep every
  // conversational fact pending forever. Its weaker seed evidence
  // (`CONVERSATION_EVIDENCE_WEIGHT`) is where the difference from a typed
  // assertion lives, not here.
  if (provenance === 'conversation') return promote();

  // Supersession keeps one uniform bar: overturning an already-confirmed fact
  // is the same risk whatever kind it is about, and a kind-specific bar there
  // would make some beliefs harder to CORRECT than to establish.
  const threshold = existing.object === null ? minObservationsForNewFact(candidate.entityKind, candidate.predicate) : MIN_OBSERVATIONS_FOR_SUPERSESSION;

  // Case 2 — one more consecutive observation of the pending value.
  if (existing.pendingObject !== null && existing.pendingObject === candidate.object) {
    const pendingCount = existing.pendingCount + 1;

    if (pendingCount < threshold) {
      return { state: withCursor({ ...existing, confidence: candidate.confidence, pendingCount, projectId: candidate.projectId ?? existing.projectId }), effects: [] };
    }

    return promote();
  }

  // Case 3 — a value neither confirmed nor already-pending: start a fresh pending streak.
  //
  // A predicate whose bar is one has nothing to wait for: the first sighting IS the
  // full evidence, so parking it as `pending` would mean a fact that can never be
  // written (nothing would ever supply the second observation the cursor is waiting
  // for). Only reachable for a brand-new fact — supersession's bar is three, never
  // one, so a conflicting value still has to earn its streak.
  if (existing.object === null && threshold <= 1) return promote();

  return { state: withCursor({ ...existing, confidence: candidate.confidence, pendingObject: candidate.object, pendingCount: 1, projectId: candidate.projectId ?? existing.projectId }), effects: [] };
};
