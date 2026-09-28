import type { Rule } from '@sundial/kernel/types.js';

/**
 * Work out who the hashed attendees are, instead of asking the owner.
 *
 * `peopleAsk` used to be the FIRST resort for an unnamed `person-<hash>`, and
 * it asks the one party who cannot possibly answer: a hash means nothing to a
 * human. Seven of those questions went out on 2026-09-09 and all seven were
 * refused; the fourth answer was "I dont know, we need to handle this in code".
 *
 * This is that code. The alias is a hash of an email address, and the same
 * colleague's address is sitting in plain text elsewhere on the machine — as a
 * git commit author in the project roots Gnomon already tracks. So the
 * resolution is a forward hash and a comparison: exact, local, no model, no
 * question.
 *
 * All this rule decides is WHEN. It deliberately does NOT enumerate which
 * aliases to resolve, and the first version's attempt to is worth recording: it
 * walked `state.meetings.seen`, which is a bounded map of RECENT meetings, so
 * on a machine whose last meeting had aged out the sweep found nothing to do
 * while 25 hashed people sat in the `entities` table. The authoritative list
 * lives in that table, a rule may not query it, and the executor already can —
 * so the executor owns the question "which", and this rule is a clock.
 *
 * It runs ahead of `peopleAsk` in the manifest: on any tick where both could
 * act, the machine should try itself before it interrupts the owner. That
 * ordering is the invariant, not an optimisation.
 */

/** A sweep reads git history in every known root, so it is a daily job. */
export const RESOLVE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const identityResolve: Rule = (state, event) => {
  if (event.type !== 'clock:tick') return { state, effects: [] };

  const people = state.people ?? { asked: {} };
  const now = Date.parse(event.ts);
  if (people.resolvedAt !== undefined && now - Date.parse(people.resolvedAt) < RESOLVE_SWEEP_INTERVAL_MS) {
    return { state, effects: [] };
  }

  return {
    state: { ...state, people: { ...people, resolvedAt: event.ts } },
    effects: [{ type: 'ResolveAliases', ts: event.ts }],
  };
};
