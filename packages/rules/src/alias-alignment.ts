import { deriveId } from '@sundial/helpers/derive-id.js';
import { canonicalProjectName } from '@sundial/helpers/sundial-config.js';
import type { AliasSuggestion, Effect, JudgementResultPayload, KernelState, Rule } from '@sundial/kernel/types.js';
import { questionId } from './questions/index.js';
import { slugifyEntityName } from './entity-extract.js';
import { ALIGN_ALIAS_QUESTIONS, alignAlias } from './questions/align-alias.js';

/**
 * J2.4 — alias alignment, in two legs.
 *
 * The EXACT leg is this rule's own and needs no model: two registered project
 * roots whose names canonicalise onto one name (the owner's `projectAliases`
 * applied) are one project by the owner's own definition. A synthetic
 * `named:<x>` root beside a real one is merged the way `projectTrack` already
 * merges on detection — the same `project:merged` event, so the fold and the
 * rows move together — re-applied nightly because the live table held
 * `named:puzzlebox-studio` and `named:overture` beside their roots for weeks:
 * the on-detection merge only fires when a root is detected AFTER the synthetic
 * one exists. Two REAL roots with one name (a moved repository) are not merged
 * blind — which is home is the owner's call — and go on the Trust surface as an
 * exact suggestion instead.
 *
 * The JUDGE leg is the executor's (`RunAliasAlignment`): pairs of project and
 * person entities to `align-alias`; `applyAliasAlignment` files every answer at
 * or above the threshold as a suggestion. The lab's number for that question
 * is 4/6 aliases found and 0/6 wrong on a six-pair set — too small to hand it
 * a merge, and an entity merge has no undo — so a suggestion is where a model's
 * answer stops. The owner's alias table is the second key.
 */
export const SAME = questionId(ALIGN_ALIAS_QUESTIONS.same);
export const MAX_SUGGESTIONS = 80;
const NAMED_PREFIX = 'named:';

const pairKey = (s: Pick<AliasSuggestion, 'kind' | 'aId' | 'bId'>): string => `${s.kind}|${[s.aId, s.bId].sort().join('|')}`;

/** Upsert by pair, then keep the highest-p, newest MAX_SUGGESTIONS. */
export function withSuggestion(list: AliasSuggestion[], s: AliasSuggestion): AliasSuggestion[] {
  const key = pairKey(s);
  const next = [...list.filter((x) => pairKey(x) !== key), s];
  next.sort((x, y) => y.p - x.p || (x.at < y.at ? 1 : -1));
  return next.slice(0, MAX_SUGGESTIONS);
}

export const nightlyAliasAlignment: Rule = (state, event) => {
  const first = (state.memory.lastAliasAlignmentAt ?? null) === null && event.type === 'clock:tick';
  if (!first && event.type !== 'day:boundary') return { state, effects: [] };
  const effects: Effect[] = [];
  let suggestions = state.memory.aliasSuggestions ?? [];

  // The exact leg: group the registry by canonical name.
  const byCanonical = new Map<string, string[]>();
  for (const [root, project] of Object.entries(state.project.known)) {
    const canonical = canonicalProjectName(project.name, state.config.projectAliases);
    byCanonical.set(canonical, [...(byCanonical.get(canonical) ?? []), root]);
  }
  for (const roots of byCanonical.values()) {
    if (roots.length < 2) continue;
    const real = roots.filter((r) => !r.startsWith(NAMED_PREFIX));
    const synthetic = roots.filter((r) => r.startsWith(NAMED_PREFIX));
    if (real.length >= 1) {
      // One real home: every synthetic twin folds into it (projectTrack's own policy, re-applied).
      const into = real.length === 1 ? real[0] : null;
      if (into) for (const from of synthetic) effects.push({ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'alias-align', from), type: 'project:merged', ts: event.ts, payload: { from, into } } });
    }
    // Two real roots with one name: the owner decides which is home.
    for (let i = 0; i < real.length; i += 1)
      for (let j = i + 1; j < real.length; j += 1)
        suggestions = withSuggestion(suggestions, { kind: 'project', aId: real[i], a: state.project.known[real[i]].name, bId: real[j], b: state.project.known[real[j]].name, p: 1, basis: 'same-name', at: event.ts });
  }

  // The exact leg for PEOPLE (J2.4's open half): a hashed attendee whose live
  // `knownAs` — the owner's word, or a promoted belief — names a person is that
  // person. The named entity's id is deterministic (`person:<slug>`), so the
  // fold can name the survivor without seeing the table; the executor checks
  // it exists and moves nothing otherwise. Never from a judge's noul.
  for (const [alias, name] of Object.entries(state.memory.aliasNames ?? {})) {
    if (!alias.startsWith('person-') || typeof name !== 'string' || name.trim() === '') continue;
    const from = `person:${slugifyEntityName(alias)}`;
    const into = `person:${slugifyEntityName(name)}`;
    if (from === into || into === 'person:') continue;
    effects.push({ type: 'MergeEntity', from, into, alias, ts: event.ts });
  }

  effects.push({ type: 'RunAliasAlignment', ts: event.ts });
  return { state: { ...state, memory: { ...state.memory, lastAliasAlignmentAt: event.ts, aliasSuggestions: suggestions } }, effects };
};

interface AlignMetadata {
  kind: 'project' | 'person';
  aId: string;
  a: string;
  bId: string;
  b: string;
}
const isMeta = (m: unknown): m is AlignMetadata => typeof m === 'object' && m !== null && typeof (m as AlignMetadata).aId === 'string' && typeof (m as AlignMetadata).bId === 'string' && ((m as AlignMetadata).kind === 'project' || (m as AlignMetadata).kind === 'person');

export const applyAliasAlignment: Rule = (state, event) => {
  if (event.type !== 'judgement:result') return { state, effects: [] };
  const payload = event.payload as unknown as JudgementResultPayload;
  if (payload.questionSetId !== alignAlias.id) return { state, effects: [] };
  const meta = payload.metadata;
  const p = payload.answers?.same?.noul;
  if (!isMeta(meta) || typeof p !== 'number') return { state, effects: [] };
  const threshold = state.judgement.questions[SAME]?.threshold ?? 0.5;
  if (p < threshold) return { state, effects: [] };
  const next: KernelState = { ...state, memory: { ...state.memory, aliasSuggestions: withSuggestion(state.memory.aliasSuggestions ?? [], { kind: meta.kind, aId: meta.aId, a: meta.a, bId: meta.bId, b: meta.b, p, basis: 'judge', at: event.ts }) } };
  return { state: next, effects: [] };
};
