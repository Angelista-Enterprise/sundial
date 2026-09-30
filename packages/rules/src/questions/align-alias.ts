/**
 * `align-alias` — do two names mean one thing? (J2.4)
 *
 * The lab's `alias` flow wording: 4 of 6 config aliases recognised, 0 of 6
 * cross pairs wrongly merged; the miss was a codename (WCS ↔ gnomon), which
 * no text can know. Safe direction of error, so the answer is LOGGED as a
 * suggestion on the Trust surface and never merges on its own — the owner's
 * `projectAliases` is the key that merges (two keys, 05). State is the two
 * names, what each is also known as when a `knownAs` belief exists, and one
 * line of where names come from. No verdict of ours in it.
 */
import { clip, noul, type QuestionSet, keyed } from './index.js';

export interface AlignAliasInput {
  kind: 'project' | 'person';
  nameA: string;
  nameB: string;
  alsoKnownAsA?: string | null;
  alsoKnownAsB?: string | null;
}

export const ALIGN_CONTEXT: Record<AlignAliasInput['kind'], string> = {
  project: "Both names were seen in a software developer's window titles, git paths, calendar entries or speech. Aliases include short forms, code names, team names and predecessors.",
  person: "Both names were seen in a software developer's calendar attendee lists, speech and notes. The same colleague can appear as a first name, a full name, a nickname or a spelling variant; a `person-<hash>` is an address the assistant could not read.",
};

export const ALIGN_ALIAS_QUESTIONS = keyed('align-alias', {
  same: noul('Do `name_a` and `name_b` refer to the same `entity_kind`?', { true: 'One thing under two names.', false: 'Two different things, or not enough here to say.' }),
});

export const alignAlias: QuestionSet<[AlignAliasInput]> = {
  id: 'align-alias',
  build: (input) => ({
    state: {
      entity_kind: input.kind,
      name_a: clip(input.nameA, 120),
      name_b: clip(input.nameB, 120),
      ...(input.alsoKnownAsA ? { name_a_also_known_as: clip(input.alsoKnownAsA, 120) } : {}),
      ...(input.alsoKnownAsB ? { name_b_also_known_as: clip(input.alsoKnownAsB, 120) } : {}),
      context: ALIGN_CONTEXT[input.kind],
    },
    questions: ALIGN_ALIAS_QUESTIONS,
  }),
  samples: () => [
    [{ kind: 'project', nameA: 'PB-Games', nameB: 'puzzlebox-studio' }],
    [{ kind: 'person', nameA: 'person-c205ca11f2', nameB: 'Alex Morgan', alsoKnownAsA: 'Alex Morgan' }],
  ],
};
