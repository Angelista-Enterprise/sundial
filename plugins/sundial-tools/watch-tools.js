// The two writes behind Gnomon's own rules (see @sundial/kernel/watch.ts):
// adopting a tested watch rule and dropping one. Each appends one event to
// Gnomon's own log — `rule:adopted` / `rule:dropped` — and the `watchRules`
// interpreter folds it. Both are owner-turn-only in the gate: a rule is
// adopted on the owner's yes in a conversation, never by a job or a notice.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAX_WATCH_RULES, validateWatchRule } from '@sundial/kernel/watch.js'

export function watchTools(appendSignal, getState) {
  return [
    defineTool({
      name: 'gnomon_adopt_rule',
      description:
        "Adopt a watch rule the owner said yes to, AFTER gnomon_test_rule showed them what it would have said. From then on Gnomon notices it by itself; what it says still goes through the noticing gate. The same id again replaces the rule. Never adopt a rule the owner has not seen tested.",
      parameters: {
        rule: { type: 'json', required: true, description: 'The same spec that was tested with gnomon_test_rule.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { adopted: { type: 'boolean' }, id: { type: 'string' }, title: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: `Adopted "${value.title}" (${value.id}). Gnomon watches for it from now on.` }],
      },
      async execute(args) {
        let spec = args.rule
        if (typeof spec === 'string') spec = JSON.parse(spec)
        const checked = validateWatchRule(spec)
        if ('error' in checked) throw new Error(checked.error)
        const rules = getState?.()?.watch?.rules ?? []
        if (rules.length >= MAX_WATCH_RULES && !rules.some((r) => r.id === checked.rule.id)) throw new Error(`${MAX_WATCH_RULES} rules already: ${rules.map((r) => r.id).join(', ')}; ask which to drop`)
        await appendSignal('rule:adopted', { rule: checked.rule })
        return { adopted: true, id: checked.rule.id, title: checked.rule.title }
      },
    }),
    defineTool({
      name: 'gnomon_drop_rule',
      description: 'Stop a watch rule the owner no longer wants, by its id (gnomon_test_rule with no rule lists them).',
      parameters: { id: { type: 'string', required: true, description: 'The rule id.' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { dropped: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: `Dropped "${value.dropped}".` }],
      },
      async execute(args) {
        const id = String(args.id ?? '').trim()
        const rules = getState?.()?.watch?.rules ?? []
        if (!rules.some((r) => r.id === id)) throw new Error(rules.length ? `no rule "${id}"; adopted: ${rules.map((r) => r.id).join(', ')}` : 'no rules are adopted')
        await appendSignal('rule:dropped', { id })
        return { dropped: id }
      },
    }),
  ]
}
