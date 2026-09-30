// The rules card: every adopted watch rule with its record — the gate's decisions on it this month
// and when each version was adopted (UC4 F20).
import { getGateDecisionsBetween, getSignalsInRange } from '@sundial/db/index.js'
import { rulesView } from './rules-view.js'

export async function readRules({ state, now }) {
  const at = new Date(now).toISOString()
  const month = new Date(now - 30 * 86_400_000).toISOString()
  const [decisions, adoptions] = await Promise.all([
    getGateDecisionsBetween(month, at).then((rows) => rows.filter((d) => d.kind.startsWith('watch:'))),
    getSignalsInRange(new Date(now - 365 * 86_400_000).toISOString(), at, 500, ['rule:adopted']).then((rows) => rows.map((r) => ({ ts: r.capturedAt, payload: r.data }))),
  ])
  return { rules: rulesView(state?.watch, decisions, adoptions, at) }
}
