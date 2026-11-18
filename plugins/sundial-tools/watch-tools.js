// The writes behind Gnomon's own rules (see @sundial/kernel/watch.ts):
// adopting a tested watch rule (alone, or as a step of a flow), dropping,
// pausing and resuming one or a whole flow. Each appends one event per rule to
// Gnomon's own log — `rule:adopted` / `rule:dropped` / `rule:paused` /
// `rule:resumed` — and the `watchRules` interpreter folds it. All are
// owner-turn-only in the gate: a rule is adopted on the owner's yes in a
// conversation, never by a job or a notice.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { validateWatchRule } from '@sundial/kernel/watch.js'
import { flowBefore, flowFrom, watchRoomFor } from '@sundial/kernel/watch-flow.js'
import { toBlueprint } from '@sundial/kernel/watch-words.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { reachRefusal } from '../sundial-actions/gate.js'
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
import { sandboxView } from '@sundial/kernel/read/rig-session.js'

/**
 * S4: in a rig chat with a live sandbox (the gate lets these tools through only there) a rule is adopted, paused,
 * resumed and dropped in that chat's own sandbox: the rows carry its `sessionId` and the rules named are its own, never
 * the owner's. Anywhere else: the owner's rules, the rows as they were.
 */
const seat = (getState, exec) => {
  const sessionId = exec?.agent?.session?.id
  return sandboxView(getState?.(), sessionId) ? { read: () => sandboxView(getState?.(), sessionId), mark: { sessionId } } : { read: getState, mark: {} }
}

/** The rules a write names: `{id}`, or every rule adopted in `{flow}`. Throws what the model should hear. */
function named(getState, args) {
  const watch = getState?.()?.watch
  const rules = watch?.rules ?? []
  const flow = String(args.flow ?? '').trim()
  const id = String(args.id ?? '').trim()
  if ((flow === '') === (id === '')) throw new Error('name one rule by id, or one flow by flow')
  const ids = flow ? rules.filter((r) => watch?.stats?.[r.id]?.flow?.id === flow).map((r) => r.id) : rules.some((r) => r.id === id) ? [id] : []
  if (ids.length === 0) throw new Error(rules.length ? `no ${flow ? `flow "${flow}"` : `rule "${id}"`}; adopted: ${rules.map((r) => r.id).join(', ')}` : 'no rules are adopted')
  return ids
}

export function watchTools(appendSignal, getState, test = null, scan = piiScan, integrations = () => loadSundialConfig().integrations ?? []) {
  /** The backtest an adoption is made on: 30 days, the same report the owner was shown. A list is a flow, replayed jointly. */
  test ??= (rule) => executeGnomonTool('gnomon_test_rule', { rule, days: 30 }, toolEnv(getState))
  return [
    defineTool({
      name: 'gnomon_adopt_rule',
      description:
        "Adopt a watch rule the owner said yes to, AFTER gnomon_test_rule showed them what it would have said. From then on Gnomon notices it by itself; what it says still goes through the noticing gate. The same id again is the rule's next version. It is backtested once more over 30 days on adoption, and that rate is what its live fires are held against. Never adopt a rule the owner has not seen tested.",
      parameters: {
        rule: { type: 'json', required: true, description: 'The same spec that was tested with gnomon_test_rule.' },
        flow: { type: 'json', description: 'Adopting a step of a flow: {id, title, step} (1 first). Steps are adopted one call each, in order; a later step is held against the joint backtest of the steps before it.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { adopted: { type: 'boolean' }, id: { type: 'string' }, title: { type: 'string' }, version: { type: 'number' }, test: { type: 'boolean' }, predicted: { type: 'object', additionalProperties: false, properties: { fired: { type: 'number' }, days: { type: 'number' }, heard: { type: 'number' } } } } },
        render: (_args, value) => [{ type: 'text', text: value.test ? `Adopted "${value.title}" (${value.id}, v${value.version}) in this test chat only: it is kept here to pause, resume or drop, and never watches the owner's record.` : value.predicted ? `Adopted "${value.title}" (${value.id}, v${value.version}): it would have fired ${value.predicted.fired} times in ${value.predicted.days} days, ${value.predicted.heard} of them heard. Gnomon watches for it from now on.` : `Adopted "${value.title}" (${value.id}, v${value.version}). It waits on your answer to an earlier step, so it has no backtest rate. Gnomon watches for it from now on.` }],
      },
      async execute(args, exec) {
        const { read, mark } = seat(getState, exec)
        let spec = args.rule
        if (typeof spec === 'string') spec = JSON.parse(spec)
        // The test resolves a person to their aliases; what it tested is what is adopted.
        const tested = await test(spec)
        if (!tested?.valid) throw new Error(tested?.error ?? 'the rule could not be backtested')
        const checked = validateWatchRule(tested.rule)
        if ('error' in checked) throw new Error(checked.error)
        // A reach may only name a tool the action gate governs.
        const unreachable = reachRefusal(checked.rule, integrations())
        if (unreachable !== null) throw new Error(unreachable)
        let flow
        if (args.flow !== undefined && args.flow !== null) {
          flow = flowFrom(typeof args.flow === 'string' ? JSON.parse(args.flow) : args.flow)
          if ('error' in flow) throw new Error(flow.error)
        }
        const watch = read?.()?.watch
        const rules = watch?.rules ?? []
        const full = watchRoomFor(watch, checked.rule.id, flow)
        if (full !== null) throw new Error(full)
        let predicted = { fired: tested.fired, days: tested.days, heard: tested.gate.phasic + tested.gate.tonic }
        const before = flow ? flowBefore(watch, checked.rule.id, flow) : []
        if (before.length > 0) {
          // A later step hears the earlier ones: its rate is the joint replay's.
          const joint = await test([...before, checked.rule])
          if (!joint?.valid) throw new Error(joint?.error ?? 'the flow could not be backtested')
          const step = joint.steps.at(-1)
          predicted = step.fired === undefined ? undefined : { fired: step.fired, days: joint.days, heard: step.heard }
        }
        await appendSignal('rule:adopted', { rule: checked.rule, ...(predicted ? { predicted } : {}), ...(flow ? { flow } : {}), ...mark })
        const version = (rules.some((r) => r.id === checked.rule.id) ? (read?.()?.watch?.stats?.[checked.rule.id]?.version ?? 1) : 0) + 1
        return { adopted: true, id: checked.rule.id, title: checked.rule.title, version, predicted, ...(mark.sessionId ? { test: true } : {}) }
      },
    }),
    ...[
      ['drop', 'dropped', 'Stop a watch rule the owner no longer wants'],
      ['pause', 'paused', 'Pause a watch rule the owner wants kept but quiet for now (it is not stepped and says nothing)'],
      ['resume', 'resumed', 'Resume a paused watch rule (it starts again from a fresh state)'],
    ].map(([op, done, what]) =>
      defineTool({
        name: `gnomon_${op}_rule`,
        description: `${what}, by its id, or every step of a flow by its flow id (gnomon_test_rule with no rule lists them).`,
        parameters: { id: { type: 'string', description: 'The rule id.' }, flow: { type: 'string', description: 'A flow id: every rule adopted in it.' } },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { [done]: { type: 'string' } } },
          render: (_args, value) => [{ type: 'text', text: `${done[0].toUpperCase()}${done.slice(1)} "${value[done]}".` }],
        },
        async execute(args, exec) {
          const { read, mark } = seat(getState, exec)
          const ids = named(read, args)
          for (const id of ids) await appendSignal(`rule:${done}`, { id, ...mark })
          return { [done]: ids.join(', ') }
        },
      }),
    ),
    defineTool({
      name: 'gnomon_reach_revoke',
      description: "Take back a watch rule's leave to run its reach alone, when the owner says so: it asks before every act again, and its count of yeses starts over. Granting is never yours to do: the day-boundary review offers it, and the owner's answer grants it.",
      parameters: { id: { type: 'string', required: true, description: 'The rule id.' }, tool: { type: 'string', required: true, description: 'The reach tool.' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { revoked: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: `"${value.revoked}" asks first again.` }],
      },
      async execute(args) {
        const id = String(args.id ?? '').trim()
        const tool = String(args.tool ?? '').trim()
        if (getState?.()?.watch?.stats?.[id]?.reach?.[tool]?.auto !== true) throw new Error(`rule "${id}" does not run ${tool} alone`)
        await appendSignal('rule:auto-revoked', { id, tool })
        return { revoked: id }
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
