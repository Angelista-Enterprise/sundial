import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RUNGS, VERDICT, byVerdict, capability, daysAgoWord, registry, tightenedByConfig, usedSentence, usedWord, verdictAt } from './reach.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATE = readFileSync(join(HERE, '../../sundial-actions/gate.js'), 'utf8')
const CHIP = readFileSync(join(HERE, 'app.js'), 'utf8')

/** Obsidian as the route serves it: eight reads, ten writes, verdicts from the gate. */
const read = (tool) => ({ tool, read: true, verdicts: { 'workspace-write': { kind: 'allow' }, 'danger-full-access': { kind: 'allow' } } })
const write = (tool) => ({ tool, read: false, verdicts: { 'workspace-write': { kind: 'ask', reason: 'runs behind your approval' }, 'danger-full-access': { kind: 'allow' } } })
const OBSIDIAN = { name: 'obsidian', mounted: true, tools: [read('search_vault'), read('get_vault_file'), write('append_to_vault_file'), write('delete_vault_file')] }

describe('the rungs this card draws', () => {
  it('draws the two the permission chip can actually reach', () => {
    // The gate's `PRESET_POLICY` has three rungs and the board's chip toggles
    // exactly two. A column for `read-only` would be a column about somewhere
    // the owner cannot go, so it is named in prose instead.
    expect(RUNGS.map((r) => r.preset)).toEqual(['workspace-write', 'danger-full-access'])
    for (const rung of RUNGS) expect(CHIP, `the chip must still offer ${rung.preset}`).toContain(`'${rung.preset}'`)
    expect(GATE, 'and the gate must still know the third').toContain("'read-only'")
  })

  it('names all three verdicts the gate can return', () => {
    // A verdict kind the card has no word for would render blank on a
    // permission surface, which is the worst place for one.
    const kinds = [...GATE.matchAll(/kind:\s*'(allow|ask|deny)'/g)].map(([, k]) => k)
    for (const kind of new Set(kinds)) expect(VERDICT[kind], `${kind} has no word`).toBeDefined()
  })

  it('falls back to the loudest thing it can honestly say', () => {
    // A tool the route could not get a verdict for must not render as "runs".
    expect(verdictAt({ verdicts: {} }, 'workspace-write')).toBe('ask')
    expect(verdictAt(undefined, 'workspace-write')).toBe('ask')
  })
})

describe('the capability line', () => {
  it('is assembled from the gate, never written down', () => {
    const cap = capability(OBSIDIAN)
    expect(cap.reads).toBe(2)
    expect(cap.writes).toBe(2)
    expect(cap.readEverywhere, 'a read is allowed at every rung').toBe(true)
    expect(cap.writeLadder.map((r) => r.kind)).toEqual(['ask', 'allow'])
  })

  it('names the rung where a write runs with no prompt', () => {
    // The one thing on this card an owner most needs to have read. The gate
    // has no destructive tier — `delete_vault_file` and `append_to_vault_file`
    // are the same thing to it — so on Auto a delete goes through exactly like
    // an append, and that has to be a sentence rather than a table cell.
    expect(capability(OBSIDIAN).unpromptedWrites).toEqual(['Auto'])
    const asking = { tools: [write('x')].map((t) => ({ ...t, verdicts: { 'workspace-write': { kind: 'ask' }, 'danger-full-access': { kind: 'ask' } } })) }
    expect(capability(asking).unpromptedWrites, 'nothing to warn about when nothing runs unprompted').toEqual([])
  })

  it('says when one server\'s writes do not share a fate', () => {
    // The ladder is read off the first write because every write on one server
    // takes the same path through the gate. If that stops being true the card
    // must not report one tool's fate as all of them.
    const odd = { tools: [write('a'), { ...write('b'), verdicts: { 'workspace-write': { kind: 'deny' }, 'danger-full-access': { kind: 'allow' } } }] }
    expect(capability(odd).writeLadder[0].mixed).toBe(true)
    expect(capability(OBSIDIAN).writeLadder.every((r) => r.mixed)).toBe(false)
  })

  it('has nothing to say about a server with no tools', () => {
    const cap = capability({ name: 'nothing', mounted: false, tools: [] })
    expect(cap.readEverywhere).toBe(false)
    expect(cap.writeLadder.map((r) => r.kind)).toEqual([null, null])
    expect(cap.unpromptedWrites).toEqual([])
  })
})

describe('its own hands', () => {
  it('groups twenty-eight tools by what the gate does, not by name', () => {
    // The question is never "what does gnomon_shelve do" — it is "what can
    // this thing do without asking me". A list of names answers the first.
    const own = [
      { tool: 'assert', verdicts: { 'workspace-write': { kind: 'allow' } } },
      { tool: 'draft', verdicts: { 'workspace-write': { kind: 'allow' } } },
      { tool: 'run_shell', verdicts: { 'workspace-write': { kind: 'ask' } } },
    ]
    const groups = byVerdict(own, 'workspace-write')
    expect(groups.map((g) => g.kind)).toEqual(['allow', 'ask'])
    expect(groups[0].tools.map((t) => t.tool)).toEqual(['assert', 'draft'])
  })
})

describe('the registry disclosure', () => {
  it('counts rather than repeating a figure that has already moved twice', () => {
    // D-R4 recorded 56 tools and "+36 built-in". The registry is 49 today and
    // only three of them are the harness's — 28 are Gnomon's own.
    const reg = registry({ totalTools: 49, integrations: [{ tools: new Array(18) }], own: new Array(28) })
    expect(reg).toEqual({ total: 49, mcp: 18, own: 28, builtIn: 3 })
    expect(registry({ totalTools: 0 }).builtIn, 'never negative').toBe(0)
  })
})

describe('the owner\'s own tightening', () => {
  it('reads it off the gate\'s reason, never re-derives it', () => {
    // Without this the card shows `calendar_create` asking on Auto as well as
    // on Ask and gives the reader no way to tell a policy from a bug.
    const tools = [
      { tool: 'calendar_create', verdicts: { 'workspace-write': { kind: 'ask', reason: "the 'workspace-write' preset asks first" }, 'danger-full-access': { kind: 'ask', reason: 'config.actions outward.calendar_create = ask tightens the preset' } } },
      { tool: 'assert', verdicts: { 'workspace-write': { kind: 'allow' }, 'danger-full-access': { kind: 'allow' } } },
    ]
    expect(tightenedByConfig(tools)).toEqual(['calendar_create'])
    expect(tightenedByConfig([tools[1]]), 'absent rather than zero').toEqual([])
  })
})

describe('what has actually run', () => {
  it('says nothing rather than zero where nothing was counted', () => {
    // K0.1's own trap. Before the gate wrote a row per call, an empty count
    // meant "nobody wrote it down" — so a `0` in this column would be the card
    // making a claim the record cannot back, on the one surface whose job is
    // to be trusted about what Gnomon reaches.
    expect(usedWord(null)).toBe('—')
    expect(usedWord(undefined)).toBe('—')
    expect(usedWord({ calls: 0, failed: 0, refused: 0, lastAt: null })).toBe('—')
  })

  it('puts only the recency in the cell, and the counts on the line above', () => {
    // Measured live against a control: the full sentence does not make the
    // rows taller, it takes the track — Used 44px → 139px and the description
    // 478px → 397px, to say something about three of eighteen rows.
    const at = new Date(Date.now() - 2 * 86400000).toISOString()
    expect(usedWord({ calls: 9, failed: 2, refused: 3, lastAt: at })).toBe('2 days ago')
  })

  it('keeps a refusal and a failure apart in the sentence', () => {
    // A refusal is the gate working; a failure is the service saying no.
    // Summed into one number a well-guarded tool reads as a broken one.
    const at = new Date(Date.now() - 2 * 86400000).toISOString()
    expect(usedSentence({ calls: 9, failed: 2, refused: 3, lastAt: at })).toBe('9 calls, last 2 days ago — 2 failed and 3 refused.')
    expect(usedSentence({ calls: 1, failed: 0, refused: 0, lastAt: at })).toBe('1 call, last 2 days ago — none of them failed.')
    expect(usedSentence(null)).toBeNull()
  })

  it('reads a bad timestamp as unknown rather than as today', () => {
    expect(daysAgoWord(null)).toBe('at some point')
    expect(daysAgoWord(new Date().toISOString())).toBe('today')
  })
})
