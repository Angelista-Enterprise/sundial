import { describe, expect, it } from 'vitest'
import { screenTools } from './screen-tools.js'

/** Zen over a fake record: every act is performed, its after-look is `afters[n]`, else `after`; a fresh look is the last after-look with `row` over it. Made-up titles. */
function zen({ row = {}, afters = [], after = {} } = {}) {
  const sent = []
  const rows = {}
  const state = { config: { experiments: {} }, marks: { now: [], guideTally: {} } }
  let latest = { processName: 'Zen', elements: [] }
  const send = (command) => {
    sent.push(command)
    if (command.type === 'look') {
      rows[command.id] = { ...latest, id: command.id, after: undefined, ...row }
      state.marks.lastLook = { id: command.id, app: 'Zen', n: 1 }
      return
    }
    const n = sent.filter((c) => c.type === 'act').length - 1
    state.marks.lastAct = { id: command.id, outcome: 'performed' }
    latest = rows[`look-after${n}`] = { ...latest, id: `look-after${n}`, after: command.id, ...(afters[n] ?? after) }
    state.marks.lastLook = { id: latest.id, after: command.id, app: 'Zen', n: 1 }
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(rows).findLast((r) => (field === 'tag' ? String(r.id).endsWith(id) : r[field] === id)) ?? null
  const act = screenTools(async () => {}, () => state, send, readRow, async () => [], {})[2]
  return { act, acts: () => sent.filter((c) => c.type === 'act') }
}
const title = (windowTitle) => ({ processName: 'Zen', windowTitle })

describe('a tab step in a chain (run 88 T03)', () => {
  it('a tab step that reaches no tab ends the steps: Close Tab is never sent', async () => {
    const t = zen({ row: title('Clock - Wikipedia'), afters: Array.from({ length: 12 }, (_, i) => title(`Page ${i} - Wikipedia`)) })
    const call = t.act.execute({ app: 'Zen', goal: 'close a tab', steps: [{ action: 'raise', tab: 'Pendulum' }, { action: 'pick-menu', value: 'File > Close Tab' }] })
    await expect(call).rejects.toThrow(/^1\. Show the tab "Pendulum" in Zen: refused: no tab with that title after 12 tabs\.[^]*\nStopped at step 1: step 2 did not run\. Look again, then go on\./)
    expect(t.acts().map((c) => c.value)).toEqual(Array(12).fill('ctrl+tab'))
  })

  it('a close right after a tab step runs only when a fresh look shows that tab in front', async () => {
    const steps = [{ tab: 'Pendulum' }, { action: 'pick-menu', value: 'File > Close Tab' }]
    // The after-look named the tab, but the window in front is another page: nothing is closed.
    const stale = () => zen({ row: title('Abacus - Wikipedia'), afters: ['Pendulum', 'Abacus', 'Pendulum'].map((t) => title(`${t} - Wikipedia`)) })
    const once = stale()
    expect(await once.act.execute({ app: 'Zen', steps })).toContain('\n2. Pick-menu "File > Close Tab" in Zen: refused: this step closes something, and the window in front is "Abacus - Wikipedia", not the tab "Pendulum": nothing was closed.')
    expect(once.acts().map((c) => c.value)).toEqual(['ctrl+tab', 'ctrl+tab', 'ctrl+tab'])
    // Review of round 22: a wait between them does not lift the guard, and a "Close" button or a close button is a close.
    for (const close of [{ action: 'pick-menu', value: 'Close Tab' }, { role: 'button', label: 'Close' }, { role: 'close button', label: 'x' }]) {
      const t = stale()
      expect(await t.act.execute({ app: 'Zen', steps: [{ tab: 'Pendulum' }, { action: 'wait', seconds: 0 }, close] })).toContain('refused: this step closes something')
      expect(t.acts().every((c) => c.action === 'key')).toBe(true)
    }
    // The fresh look shows the tab: the close runs. With no way round, the walk comes back to the one match by ctrl+shift+tab.
    const shown = zen({ afters: [title('Pendulum - Wikipedia')] })
    expect(await shown.act.execute({ app: 'Zen', steps })).toMatch(/^1\. Show the tab "Pendulum" in Zen: done\. "Pendulum - Wikipedia" is in front, after 12 ctrl\+tab and 11 ctrl\+shift\+tab\n/)
    expect(shown.acts().map((c) => c.value ?? c.action)).toEqual([...Array(12).fill('ctrl+tab'), ...Array(11).fill('ctrl+shift+tab'), 'File > Close Tab'])
  })

  it('two tabs hold the words: the walk goes round, refuses ambiguous-tab, and closes nothing (review of round 22)', async () => {
    const t = zen({ row: title('Clock - Wikipedia'), afters: ['Gnomon - Wikipedia', 'Gnomon test runs', 'Clock - Wikipedia'].map(title) })
    await expect(t.act.execute({ app: 'Zen', steps: [{ tab: 'Gnomon' }, { action: 'pick-menu', value: 'Close Tab' }] })).rejects.toThrow('1. Show the tab "Gnomon" in Zen: refused: ambiguous-tab: more than one tab holds "Gnomon": "Gnomon - Wikipedia", "Gnomon test runs". Send words only one of them has.\nStopped at step 1: step 2 did not run.')
    expect(t.acts().map((c) => c.value)).toEqual(['ctrl+tab', 'ctrl+tab', 'ctrl+tab'])
  })

  it('with no tab buttons in the look, the refusal lists the titles and says not to guess', async () => {
    const walk = { afters: [], after: title('Inbox - Mail') }
    await expect(zen({ ...walk, row: title('Clock - Wikipedia') }).act.execute({ app: 'Zen', tab: 'pendulum' })).rejects.toThrow('The titles seen: "Clock - Wikipedia", "Inbox - Mail". In front now: "Inbox - Mail". The look shows no tab buttons (the tab bar or sidebar is hidden), so these titles are all that was seen: do not guess a tab. The tab a url step opened is in front right after it, so act there in the same call; or open the page again with a url step, {app, url}.')
    const bar = { ...title('Clock - Wikipedia'), elements: [{ ref: 'e7', role: 'AXRadioButton', sub: 'AXTabButton', screenText: ['Clock - Wikipedia', '1', 'tab bar'], actions: ['AXPress'] }] }
    const said = await zen({ ...walk, row: bar }).act.execute({ app: 'Zen', tab: 'pendulum' }).catch((e) => e.message)
    expect(said).toMatch(/^refused: no tab with that title after 12 tabs\./)
    expect(said).not.toContain('no tab buttons')
  })

  it('Set 5 R1 (plan 2F): the owner\'s Stop between the ctrl+tab presses of one tab step ends the walk at the next press', async () => {
    const t = zen({ row: title('Clock - Wikipedia'), afters: Array.from({ length: 12 }, (_, i) => title(`Page ${i} - Wikipedia`)) })
    const signal = { get aborted() { return t.acts().length >= 2 } }
    await expect(t.act.execute({ app: 'Zen', steps: [{ tab: 'Pendulum' }, { action: 'pick-menu', value: 'File > Close Tab' }] }, { signal })).rejects.toThrow(/^1\. Show the tab "Pendulum" in Zen: refused: stopped: the owner stopped the turn, so this step did not run\.\nStopped at step 1: step 2 did not run\./)
    expect(t.acts().map((c) => c.value)).toEqual(['ctrl+tab', 'ctrl+tab'])
  })
})
