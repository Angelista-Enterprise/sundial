/**
 * The ten laws of state, as a check over a builder's output (docs/jarvis/02;
 * J0.6). Run in vitest over every registry set's samples; a planted violation
 * fails the suite. Pure: returns the violations, throws nothing.
 *
 * What it refuses, and which law:
 * - a prose string over 600 chars (law 8: state is short; speech is clipped);
 * - an array of strings longer than 12 (law 8: history is a number, never a list);
 * - a field named for a derived verdict — `kind`, `intent`, `label`, `verdict`
 *   (law 2: a label in the state is followed, not checked — finding 2);
 * - `life_events` under any name (law 7: quantities go in as numbers, never as
 *   a rule's event name — the `live` flow failed on exactly this).
 */
export const PROSE_MAX_CHARS = 600;
export const LIST_MAX_ITEMS = 12;
/** Names a derived verdict travels under. A prior passed as a number is allowed when named as one (`historically_true_this_often`). */
export const DERIVED_VERDICT_FIELDS = new Set(['kind', 'intent', 'label', 'verdict', 'life_events', 'lifeEvents']);

export interface StateViolation {
  path: string;
  law: 2 | 7 | 8;
  reason: string;
}

export function lintState(state: unknown, path = 'state'): StateViolation[] {
  const out: StateViolation[] = [];
  const walk = (value: unknown, at: string): void => {
    if (typeof value === 'string') {
      if (value.length > PROSE_MAX_CHARS) out.push({ path: at, law: 8, reason: `string of ${value.length} chars (max ${PROSE_MAX_CHARS})` });
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > LIST_MAX_ITEMS && value.every((v) => typeof v === 'string')) out.push({ path: at, law: 8, reason: `list of ${value.length} strings (max ${LIST_MAX_ITEMS}); history is a number` });
      value.forEach((v, i) => walk(v, `${at}[${i}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        const here = `${at}.${key}`;
        if (key === 'life_events' || key === 'lifeEvents') out.push({ path: here, law: 7, reason: 'rule-derived events; give raw rates instead' });
        else if (DERIVED_VERDICT_FIELDS.has(key)) out.push({ path: here, law: 2, reason: 'a derived verdict in state is followed, not checked' });
        walk(v, here);
      }
    }
  };
  walk(state, path);
  return out;
}
