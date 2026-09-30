// The two writes behind Gnomon's own rules (see @sundial/kernel/watch.ts):
// adopting a tested watch rule and dropping one. Each appends one event to
// Gnomon's own log — `rule:adopted` / `rule:dropped` — and the `watchRules`
// interpreter folds it. Both are owner-turn-only in the gate: a rule is
// adopted on the owner's yes in a conversation, never by a job or a notice.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAX_WATCH_RULES, toBlueprint, validateWatchRule } from '@sundial/kernel/watch.js'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The release PII scan: words from the owner's own record. Absent on an install without the release folder. */
const PII_SCAN = fileURLToPath(new URL('../../release/pii-scan.py', import.meta.url))

/** Run the scan over one file's text: `clean`, `hits` (a count, never the words), or `unavailable`. */
export async function piiScan(text, script = PII_SCAN) {
  if (!existsSync(script)) return { unavailable: true }
  const dir = await mkdtemp(join(tmpdir(), 'sundial-blueprint-'))
  try {
    await writeFile(join(dir, 'blueprint.json'), text, { mode: 0o600 })
    return await new Promise((resolve) =>
      execFile('python3', [script, dir], { timeout: 30_000 }, (error, stdout) => {
        if (!error) return resolve({ clean: true })
        if (error.code === 1) return resolve({ hits: Math.max(1, String(stdout).split('\n').filter((l) => l.trim() !== '').length - 1) })
        resolve({ unavailable: true })
      }),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
import { executeGnomonTool, toolEnv } from '@sundial/kernel/tools/index.js'

export function watchTools(appendSignal, getState, test = null, scan = piiScan) {
  /** The backtest an adoption is made on: 30 days, the same report the owner was shown. */
  test ??= (rule) => executeGnomonTool('gnomon_test_rule', { rule, days: 30 }, toolEnv(getState))
  return [
    defineTool({
      name: 'gnomon_adopt_rule',
      description:
        "Adopt a watch rule the owner said yes to, AFTER gnomon_test_rule showed them what it would have said. From then on Gnomon notices it by itself; what it says still goes through the noticing gate. The same id again is the rule's next version. It is backtested once more over 30 days on adoption, and that rate is what its live fires are held against. Never adopt a rule the owner has not seen tested.",
      parameters: {
        rule: { type: 'json', required: true, description: 'The same spec that was tested with gnomon_test_rule.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { adopted: { type: 'boolean' }, id: { type: 'string' }, title: { type: 'string' }, version: { type: 'number' }, predicted: { type: 'object', additionalProperties: false, properties: { fired: { type: 'number' }, days: { type: 'number' }, heard: { type: 'number' } } } } },
        render: (_args, value) => [{ type: 'text', text: `Adopted "${value.title}" (${value.id}, v${value.version}): it would have fired ${value.predicted.fired} times in ${value.predicted.days} days, ${value.predicted.heard} of them heard. Gnomon watches for it from now on.` }],
      },
      async execute(args) {
        let spec = args.rule
        if (typeof spec === 'string') spec = JSON.parse(spec)
        // The test resolves a person to their aliases; what it tested is what is adopted.
        const tested = await test(spec)
        if (!tested?.valid) throw new Error(tested?.error ?? 'the rule could not be backtested')
        const checked = validateWatchRule(tested.rule)
        if ('error' in checked) throw new Error(checked.error)
        const rules = getState?.()?.watch?.rules ?? []
        if (rules.length >= MAX_WATCH_RULES && !rules.some((r) => r.id === checked.rule.id)) throw new Error(`${MAX_WATCH_RULES} rules already: ${rules.map((r) => r.id).join(', ')}; ask which to drop`)
        const predicted = { fired: tested.fired, days: tested.days, heard: tested.gate.phasic + tested.gate.tonic }
        await appendSignal('rule:adopted', { rule: checked.rule, predicted })
        const version = (rules.some((r) => r.id === checked.rule.id) ? (getState?.()?.watch?.stats?.[checked.rule.id]?.version ?? 1) : 0) + 1
        return { adopted: true, id: checked.rule.id, title: checked.rule.title, version, predicted }
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
    defineTool({
      name: 'gnomon_export_rule',
      description:
        "Export an adopted watch rule as a blueprint someone else can use: every condition value becomes a named input, the id is dropped, and the whole blueprint must pass the release PII scan (the owner's own names, projects, places, domains) before it is returned — a hit refuses the export and says to reword the title or sentence. To use a blueprint, fill its inputs, test it with gnomon_test_rule on this owner's log, and adopt only on their yes.",
      parameters: { id: { type: 'string', required: true, description: 'The rule id.' } },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_args, value) => [{ type: 'text', text: '```json\n' + JSON.stringify(value, null, 2) + '\n```' }],
      },
      async execute(args) {
        const rule = (getState?.()?.watch?.rules ?? []).find((r) => r.id === String(args.id ?? '').trim())
        if (!rule) throw new Error(`no rule "${args.id}"`)
        const out = toBlueprint(rule)
        const text = JSON.stringify(out, null, 2)
        const verdict = await scan(text)
        if (verdict.unavailable) throw new Error('The PII scan is not available on this install, so nothing is exported.')
        if (verdict.hits) throw new Error(`The PII scan found ${verdict.hits} private word(s) in the blueprint (its title or sentence). Reword them, adopt that version, and export again.`)
        return out
      },
    }),
  ]
}
