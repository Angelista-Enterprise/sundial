import type { AttributedEffect, KernelState, ReduceResult, Rule, SanitizedEvent } from './types.js';

/**
 * The fold, per docs/design/02-state-and-reducer.md. One deviation from the
 * doc's literal listing: `manifest` is a parameter here, not an import of
 * `RULE_MANIFEST` from `@sundial/rules` — `packages/rules` depends on
 * `packages/kernel` for the `KernelState`/`Rule`/`Effect` types, so kernel
 * importing rules back would be a build cycle `tsc -b` project references
 * can't express. The composition (`reduce(state, event, RULE_MANIFEST)`)
 * happens in `KernelRuntime.applyEvent` (`packages/harness-runtime`), which
 * depends on both packages — no cycle.
 * Behavior is identical; only where the manifest is bound differs.
 *
 * Each rule's effects are tagged with `rule.name` here — the one place that
 * knows which rule produced which effect — rather than any rule file
 * changing its own `{state, effects}` return shape.
 */
export function reduce(state: KernelState, event: SanitizedEvent, manifest: Rule[]): ReduceResult {
  let current = state;
  const allEffects: AttributedEffect[] = [];
  for (const rule of manifest) {
    const { state: next, effects } = rule(current, event);
    current = next;
    for (const effect of effects) allEffects.push({ ruleName: rule.name, effect });
  }
  return { state: current, effects: allEffects };
}
