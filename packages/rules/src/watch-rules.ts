import type { Rule } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { emptyWatchRuntime, MAX_WATCH_RULES, stepWatch, validateWatchRule } from '@sundial/kernel/watch.js';

/**
 * The interpreter for the rules Gnomon writes (see `@sundial/kernel/watch.ts`).
 *
 * `rule:adopted` adds or replaces a watch (by id), `rule:dropped` removes one.
 * Every other event steps every watch; a fire becomes one `notice:candidate`
 * of kind `watch:<id>`, and the gate decides as it does for every rule a
 * person wrote. A spec that fails validation in the log is ignored, so a bad
 * row can never break the fold.
 */
export const watchRules: Rule = (state, event) => {
  const watch = state.watch ?? { rules: [], runtime: {} };

  if (event.type === 'rule:adopted') {
    const checked = validateWatchRule((event.payload as { rule?: unknown })?.rule);
    if (!('rule' in checked)) return { state, effects: [] };
    const rules = [...watch.rules.filter((r) => r.id !== checked.rule.id), checked.rule].slice(-MAX_WATCH_RULES);
    return { state: { ...state, watch: { ...watch, rules, runtime: { ...watch.runtime, [checked.rule.id]: emptyWatchRuntime() } } }, effects: [] };
  }
  if (event.type === 'rule:dropped') {
    const id = (event.payload as { id?: unknown })?.id;
    if (!watch.rules.some((r) => r.id === id)) return { state, effects: [] };
    const { [id as string]: _gone, ...runtime } = watch.runtime;
    return { state: { ...state, watch: { ...watch, rules: watch.rules.filter((r) => r.id !== id), runtime } }, effects: [] };
  }
  // A rule Gnomon proposed on the shelf (a `rule-idea` job), held until the owner answers the card.
  if (event.type === 'work:shelved') {
    const checked = validateWatchRule((event.payload as { rule?: unknown })?.rule);
    if (!('rule' in checked)) return { state, effects: [] };
    const proposed = Object.fromEntries([...Object.entries(watch.proposed ?? {}), [deriveId(event.ts, event.id, 'shelf'), checked.rule]].slice(-10));
    return { state: { ...state, watch: { ...watch, proposed } }, effects: [] };
  }
  if (event.type === 'feedback:verdict') {
    const v = event.payload as { artifactKind?: unknown; artifactId?: unknown; verdict?: unknown };
    const rule = v.artifactKind === 'knowledge_entry' && typeof v.artifactId === 'string' ? watch.proposed?.[v.artifactId] : undefined;
    if (!rule) return { state, effects: [] };
    const { [v.artifactId as string]: _answered, ...proposed } = watch.proposed ?? {};
    // Keep is the owner's yes. Adopted through the same event a chat adoption appends, so the log says so.
    const effects: ReturnType<Rule>['effects'] =
      v.verdict === 'useful' ? [{ type: 'EmitEvent', event: { id: deriveId(event.ts, event.id, 'watch-rules', 'adopt'), type: 'rule:adopted', ts: event.ts, payload: { rule, via: v.artifactId } } }] : [];
    return { state: { ...state, watch: { ...watch, proposed } }, effects };
  }
  if (watch.rules.length === 0 || event.type === 'notice:candidate') return { state, effects: [] };

  const daytime = state.mind.circadian === 'day';
  const runtime = { ...watch.runtime };
  const effects: ReturnType<Rule>['effects'] = [];
  let changed = false;
  for (const rule of watch.rules) {
    const before = runtime[rule.id] ?? emptyWatchRuntime();
    const { rt, fire } = stepWatch(rule, before, event, daytime);
    if (rt !== before) {
      runtime[rule.id] = rt;
      changed = true;
    }
    if (fire === null) continue;
    effects.push({
      type: 'EmitEvent',
      event: {
        id: deriveId(event.ts, event.id, 'watch-rules', rule.id),
        type: 'notice:candidate',
        ts: event.ts,
        payload: {
          timestamp: event.ts,
          shape: 'transition',
          kind: `watch:${rule.id}`,
          key: `watch:${rule.id}`,
          // The owner asked for exactly this, so it is worth saying; the gate still prices the moment.
          surprise: 1.5,
          precision: 0.9,
          valueHalfLifeMs: 30 * 60 * 1000,
          observation: fire,
          evidence: [`watch rule "${rule.title}" (${rule.id})`],
          concerns: [],
        },
      },
    });
  }
  return changed || effects.length > 0 ? { state: { ...state, watch: { ...watch, runtime } }, effects } : { state, effects: [] };
};
