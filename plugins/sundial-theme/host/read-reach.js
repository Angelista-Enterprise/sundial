// Reach — what Gnomon can touch outside its own record, and on what terms: dsh's tool registry, with the read/write verdicts from sundial-actions (`gnomonReach`).
import { getToolCalls } from '@sundial/db/index.js'

export async function readReach({ state, tools, reach }) {
  const schemas = tools.schemas()
  const presets = reach.presets?.() ?? []
  // What the GATE says will happen, asked of the gate. Not re-derived here:
  // a second copy of the preset ladder on a surface is a second policy that
  // agrees today and diverges silently, on the one card whose whole job is
  // to be trusted about what Gnomon can do to the owner's services.
  const verdicts = (name) =>
    Object.fromEntries(presets.map((preset) => [preset, reach.verdict?.(name, preset) ?? { kind: 'allow' }]))

  const byServer = new Map()
  for (const schema of schemas) {
    const match = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/.exec(schema.name)
    if (match === null) continue
    const list = byServer.get(match[1]) ?? []
    list.push({
      name: schema.name,
      tool: match[2],
      description: schema.description ?? '',
      read: reach.isRead(match[1], match[2]),
      verdicts: verdicts(schema.name),
    })
    byServer.set(match[1], list)
  }
  const integrations = reach.integrations().map((i) => {
    const tools = (byServer.get(i.name) ?? []).sort((a, b) => Number(b.read) - Number(a.read) || a.tool.localeCompare(b.tool))
    return { ...i, tools, readCount: tools.filter((t) => t.read).length, writeCount: tools.filter((t) => !t.read).length }
  })

  // Gnomon's OWN hands, and all of them — the list was two names typed out,
  // which meant a tool added to `GNOMON_TOOLS` never appeared on the card
  // that exists to enumerate what Gnomon can do.
  const own = schemas
    // The web task tools (web_page, web_act) are Gnomon's own too, though not gnomon_-named.
    .filter((t) => t.name.startsWith('gnomon_') || t.name === 'web_page' || t.name === 'web_act')
    .map((t) => ({ name: t.name, tool: t.name.replace(/^gnomon_/, ''), description: t.description ?? '', verdicts: verdicts(t.name) }))
    .sort((a, b) => a.tool.localeCompare(b.tool))

  const mcpCount = [...byServer.values()].reduce((sum, list) => sum + list.length, 0)

  // K0.1 — what has actually run. Until the gate started writing a row per
  // call this was empty by construction, and the card had to close with a
  // section saying so. Keyed by the bare tool name as the SERVER knows it,
  // which is what the rows above are keyed by too.
  const calls = await getToolCalls()
  const usage = new Map(calls.map((row) => [`${row.server ?? ''}/${row.action}`, row]))
  const used = (server, tool) => usage.get(`${server ?? ''}/${tool}`) ?? null

  return {
    integrations: integrations.map((i) => ({
      ...i,
      tools: i.tools.map((t) => ({ ...t, used: used(i.name, t.tool) })),
      // The integration's own line: when it was last reached at all, and how
      // many of its calls went wrong. Summed from its tools rather than
      // queried again, so the two can never disagree.
      used: (() => {
        const rows = i.tools.map((t) => used(i.name, t.tool)).filter(Boolean)
        if (rows.length === 0) return null
        return {
          calls: rows.reduce((n, r) => n + r.calls, 0),
          failed: rows.reduce((n, r) => n + r.failed, 0),
          refused: rows.reduce((n, r) => n + r.refused, 0),
          lastAt: rows.map((r) => r.lastAt).sort().pop(),
        }
      })(),
    })),
    own,
    totalTools: schemas.length,
    presets,
    // The disclosure the audit asked for, COUNTED rather than written down.
    // D-R4 recorded 56 tools and "+36 built-in"; the registry is 49 today, so
    // a figure typed into the copy would already be wrong twice over.
    builtIn: schemas.length - mcpCount - own.length,
    // The owner's own dial, which tightens every outward verdict below `act`
    // — the card cannot explain an `ask` without it.
    autonomy: state?.settings?.autonomy ?? null,
    // When the counting began. Every row before this is silence that means
    // nothing, and the card must not read it as "never used".
    countingSince: calls.length === 0 ? null : calls.map((r) => r.lastAt).sort()[0],
    ownUsed: Object.fromEntries(own.map((t) => [t.tool, used(null, t.name)])),
  }
}
