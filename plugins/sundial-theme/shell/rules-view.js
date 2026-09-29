// The rules card's reading (UC4 F20): every adopted watch rule with its words,
// its version, what its backtest promised against what it did this week, the
// gate's outcome for its last fires, and the owner's verdicts with their n.
//
// Server-side and pure: `server.js` hands it the kernel's `state.watch`, the
// gate's decisions on `watch:*` keys and the `rule:adopted` rows, and the
// client draws what comes back. Nothing here reads the log itself.
import { describeRule, ruleDrift } from '@sundial/kernel/watch.js'

/**
 * @param {{ rules?: any[], stats?: Record<string, any>, paused?: string[] } | undefined} watch
 * @param {{ kind: string, channel: string, reason: string, decidedAt: string }[]} decisions oldest first
 * @param {{ ts: string, payload: { rule?: { id?: string } } }[]} adoptions oldest first
 * @param {string} now
 */
export function rulesView(watch, decisions, adoptions, now) {
  const paused = new Set(watch?.paused ?? [])
  return (watch?.rules ?? []).map((rule) => {
    const stats = watch?.stats?.[rule.id] ?? null
    const heard = decisions.filter((d) => d.kind === `watch:${rule.id}`)
    const versions = adoptions.filter((a) => a.payload?.rule?.id === rule.id).map((a, i) => ({ version: i + 1, at: a.ts }))
    const drift = stats ? ruleDrift(stats, now) : null
    const { useful = 0, wrong = 0, 'not-now': notNow = 0 } = stats?.verdicts ?? {}
    const view = {
      id: rule.id,
      title: rule.title,
      words: describeRule(rule),
      rule,
      paused: paused.has(rule.id),
      version: stats?.version ?? Math.max(1, versions.length),
      since: stats?.adoptedAt ?? versions.at(-1)?.at ?? null,
      versions,
      predicted: stats?.predicted ?? null,
      fires: stats?.fires ?? 0,
      week: drift ? { live: drift.live, expected: drift.expected, drifting: drift.drifting } : null,
      lastFires: heard.slice(-3).reverse().map((d) => ({ at: d.decidedAt, channel: d.channel, reason: d.reason })),
      verdicts: { useful, wrong, notNow, n: useful + wrong + notNow },
    }
    return { ...view, line: ruleLine(view) }
  })
}

/** One rule's standing in a line: version, this week against the backtest, verdicts with n. */
export function ruleLine(r) {
  const parts = [`v${r.version}`]
  if (r.paused) parts.push('paused')
  if (r.week && r.predicted) parts.push(`${r.week.live} this week, backtest ~${r.week.expected}${r.week.drifting ? ' — drifting' : ''}`)
  else if (r.week) parts.push(`${r.week.live} this week`)
  parts.push(r.verdicts.n === 0 ? 'no verdicts yet' : `useful ${r.verdicts.useful} · wrong ${r.verdicts.wrong} · not now ${r.verdicts.notNow} (n=${r.verdicts.n})`)
  return parts.join(' · ')
}
