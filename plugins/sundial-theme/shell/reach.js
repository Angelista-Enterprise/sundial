// What Gnomon can reach past this machine, and what happens when it tries.
//
// **Every verdict on this card comes from the gate itself.** `ctx.gnomonReach.
// verdict(tool, preset)` runs the same `decideAction` the `tools/pre-execute`
// hook runs. Nothing here re-derives the preset ladder: a second
// copy of `PRESET_POLICY` on a surface would agree today and diverge silently
// the first time either changed, on the one card whose entire job is to be
// trusted about what Gnomon can do to the owner's services. D-R4 asked for the
// badge to come from "the same `isRead` call the gate uses"; this goes one
// further and asks for the whole decision.
//
// **The audit's "destructive tier" does not exist and cannot be faked.** The
// gate knows two kinds of integration tool: a READ, matched by the server's
// own `reads` globs, and everything else. `delete_vault_file` and
// `append_to_vault_file` are the same thing to it. A card could badge deletes
// by name, and then it would be showing a tier the gate does not enforce —
// which on a permission surface is worse than showing none. What it says
// instead is the true and more alarming version: on Auto, a delete runs
// without a prompt, exactly like an append.
//
// **And "last used + error count per integration" has no data.** Gnomon's own
// tools append an `action:performed` signal; MCP calls do not, so of the 120
// action rows in the record 119 are `run_shell` and one is `calendar_create`,
// and not one MCP call has ever been recorded. The card says so rather than
// drawing an empty column.

/**
 * The two rungs the owner can actually be in.
 *
 * `read-only` is in the gate's own `PRESET_POLICY` and the board cannot select
 * it: the permission chip in `app.js` toggles between exactly these two. A
 * column for a rung the owner cannot reach is a column about somewhere else,
 * so it is named in prose instead of drawn.
 */
export const RUNGS = [
  { preset: 'workspace-write', word: 'Ask' },
  { preset: 'danger-full-access', word: 'Auto' },
]

/** What the gate's three verdict kinds mean where the owner is standing. */
export const VERDICT = {
  allow: { word: 'runs', tone: 'open' },
  ask: { word: 'asks you', tone: 'gated' },
  deny: { word: 'refused', tone: 'shut' },
}

/** The gate's verdict for one tool at one rung, defaulting to the loudest thing we can honestly say. */
export const verdictAt = (tool, preset) => tool?.verdicts?.[preset]?.kind ?? 'ask'

/**
 * One capability line per integration, built from the verdicts rather than
 * written — "reads freely; writes and deletes ask you", with the ladder taken
 * from the gate.
 *
 * Returns the pieces rather than a sentence so the card can mark the alarming
 * half. `unpromptedWrites` is true where a write runs at some rung with no
 * prompt, which on this record is Auto, and is the one thing an owner reading
 * a permission surface most needs to know.
 */
export function capability(integration) {
  const tools = integration?.tools ?? []
  const reads = tools.filter((t) => t.read)
  const writes = tools.filter((t) => !t.read)
  const readEverywhere = reads.length > 0 && reads.every((t) => RUNGS.every((r) => verdictAt(t, r.preset) === 'allow'))
  const writeLadder = RUNGS.map((rung) => ({
    ...rung,
    // Every write on one server takes the same path through the gate, so the
    // ladder is a property of the SERVER. Computed off the first write rather
    // than assumed: if that ever stops being true, `mixed` says so instead of
    // the card quietly reporting one tool's fate as all of them.
    kind: writes.length ? verdictAt(writes[0], rung.preset) : null,
    mixed: writes.length > 1 && new Set(writes.map((t) => verdictAt(t, rung.preset))).size > 1,
  }))
  return {
    reads: reads.length,
    writes: writes.length,
    readEverywhere,
    writeLadder,
    unpromptedWrites: writeLadder.filter((r) => r.kind === 'allow').map((r) => r.word),
  }
}

/**
 * Gnomon's own tools, grouped by what the gate does with them at each rung.
 *
 * Grouped rather than listed because there are twenty-eight of them and the
 * question is never "what does `gnomon_shelve` do" — it is "what can this thing
 * do without asking me". A list of twenty-eight names answers the first.
 */
export function byVerdict(tools, preset) {
  const groups = new Map()
  for (const tool of tools ?? []) {
    const kind = verdictAt(tool, preset)
    groups.set(kind, [...(groups.get(kind) ?? []), tool])
  }
  return ['allow', 'ask', 'deny'].filter((kind) => groups.has(kind)).map((kind) => ({ kind, ...VERDICT[kind], tools: groups.get(kind) }))
}

/**
 * Where the registry's tools actually come from.
 *
 * D-R4 recorded 56 tools and asked for a "+36 built-in tools" disclosure. The
 * registry is 49 today and only THREE of them are dsh's — 28 are Gnomon's own
 * and 18 come from its one connected service. A figure typed into the copy
 * would have been wrong twice over, so the card counts.
 */
export function registry(data) {
  const mcp = (data?.integrations ?? []).reduce((sum, i) => sum + (i.tools?.length ?? 0), 0)
  const own = (data?.own ?? []).length
  return { total: data?.totalTools ?? 0, mcp, own, builtIn: Math.max(0, (data?.totalTools ?? 0) - mcp - own) }
}

/**
 * Tools the owner's own `config.actions` holds tighter than the chip does.
 *
 * Without this the card shows `calendar_create` and `run_shell` asking on Auto
 * as well as on Ask, and gives the reader no way to tell a policy from a bug.
 * The gate already says why in its reason string — `config.actions
 * outward.<tool> = ask tightens the preset` — so this reads the gate rather
 * than re-deriving the override.
 */
export function tightenedByConfig(tools) {
  return (tools ?? [])
    .filter((tool) => RUNGS.some((r) => /config\.actions/.test(tool.verdicts?.[r.preset]?.reason ?? '')))
    .map((tool) => tool.tool)
}

/**
 * When a tool last ran — and nothing else in the cell.
 *
 * "Absent, not zero" (DESIGN.md), and here the absence has a second meaning
 * the card has to protect: until K0.1 the gate wrote nothing when a call went
 * through, so an empty count is "not since the counting began", never "never".
 * The card says which once, at the foot; this cell says "—" rather than a
 * zero, because a column of zeroes trains the eye to skip the line.
 *
 * **It carries the recency alone, and the reason is width rather than
 * height.** The first draft put the whole sentence here and I recorded that it
 * pushed every row to two lines; re-measured against a control it does not —
 * at the card's 860px the rows are 45-47px with the cell empty and 45-47px
 * with it full. What it actually costs is the track: "12× · 2 days ago · 3
 * failed, 1 refused" takes the Used column from 44px to 139px and the
 * description column from 478px to 397px, to say something about three of
 * eighteen rows — and at a narrower pane it is the column that wraps. So the
 * counts go to the integration's own line, where they are said once, and the
 * exact figures stay on this cell's hover, which is where DESIGN.md already
 * puts a number a picture is carrying.
 */
export function usedWord(used) {
  if (used === null || used === undefined || !(used.calls > 0)) return '—'
  return daysAgoWord(used.lastAt)
}

/** The hover on that cell: the exact figures, for the row that has them. */
export function usedTitle(used) {
  if (used === null || used === undefined || !(used.calls > 0)) return 'Not called since Gnomon started counting'
  return usedSentence(used)
}

/**
 * An integration's own line — said once, above its tools.
 *
 * A failure and a refusal are kept apart on purpose: a refusal is the gate
 * working, and a failure is the service saying no. Summed into one number a
 * well-guarded tool reads as a broken one.
 */
export function usedSentence(used) {
  if (used === null || used === undefined || !(used.calls > 0)) return null
  const trouble = [used.failed > 0 ? `${used.failed} failed` : null, used.refused > 0 ? `${used.refused} refused` : null].filter(Boolean)
  return `${used.calls} call${used.calls === 1 ? '' : 's'}, last ${daysAgoWord(used.lastAt)}${trouble.length ? ` — ${trouble.join(' and ')}` : ' — none of them failed'}.`
}

/** "today" / "yesterday" / "3 days ago" — the resolution this column deserves. */
export function daysAgoWord(at) {
  const then = Date.parse(at ?? '')
  if (!Number.isFinite(then)) return 'at some point'
  const days = Math.floor((Date.now() - then) / 86400000)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
}
