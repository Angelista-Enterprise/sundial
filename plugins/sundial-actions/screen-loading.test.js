// Run 206 T17: screen_act pressed on a page whose title said loading, and was refused not-found. Before its first step it now
// waits for "loading" to leave the window title, as gnomon_await `gone` does, and the wait is on the record. Made-up values only.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { screenTools } from './screen-tools.js'

const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8'))
const ROW = lookForLog(LINE)

/** A fake Notes whose window title is `title`; `titles` are what the short looks read, one each; `sent` the acts, `rows` every row. */
function tools(title, titles, waitMs = 200, onAct = () => {}, more = {}) {
  const rows = []
  const sent = []
  const asked = []
  const looks = { [ROW.id]: ROW }
  const state = { config: { experiments: { screenAct: true } }, window: { active: { processName: 'Notes', windowTitle: title, windowId: 'w1' } }, marks: { now: [], guideTally: {}, lastLook: { id: ROW.id, app: 'Notes', window: title, n: 4 } } }
  const send = (command) => {
    if (command.type !== 'act') return
    sent.push(asked.length)
    onAct(state, sent.length)
    state.marks.lastAct = { id: command.id, outcome: 'performed' }
    const id = `look-after-${command.id}`
    looks[id] = { ...ROW, id, after: command.id }
    state.marks.lastLook = { id, after: command.id, app: 'Notes', n: 5 }
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(looks).findLast((row) => row[field] === id) ?? null
  const append = async (type, data) => void rows.push([type, data])
  const load = { title: async (app) => (asked.push(app), titles.length > 1 ? titles.shift() : titles[0]), waitMs, pollMs: 5, ...more.load }
  const [, , act] = screenTools(append, () => state, send, readRow, async () => [], { hand: { quietMs: 0 }, ...more, load })
  return { act, rows, sent, asked, state }
}
const press = { app: 'Notes', goal: 'start a note', steps: [{ app: 'Notes', role: 'button', label: 'New Note', action: 'press' }, { action: 'key', value: 'cmd+c' }] }
const waited = (rows) => rows.filter(([type]) => type === 'screen:waited').map(([, data]) => data)

describe('screen_act waits for a loading window before its first step', () => {
  it('a title that says loading: no act until the title loses it, and the wait is a screen:waited row', async () => {
    const t = tools('Order desk, loading', ['Order desk, loading', 'Order desk, loading', 'Order desk, ready'])
    await t.act.execute(press)
    // Three reads for the wait, then one before the second step (the fold still shows the old title: Fable review M4).
    expect(t.asked).toEqual(['Notes', 'Notes', 'Notes', 'Notes'])
    expect(t.sent[0], 'the first act went after the third read, the one that said ready').toBe(3)
    expect(waited(t.rows)).toEqual([expect.objectContaining({ processName: 'Notes', gone: 'loading', ok: true, goal: 'start a note' })])
  })

  it('still loading after the bound: it acts anyway, and the row says the wait did not end', async () => {
    const t = tools('Order desk, loading', ['Order desk, loading'], 30)
    await t.act.execute(press)
    expect(t.sent.length).toBeGreaterThan(0)
    // The window still says loading before the second step too: it waits again, inside the call's budget.
    expect(waited(t.rows)).toEqual([expect.objectContaining({ ok: false }), expect.objectContaining({ ok: false })])
  })

  it('a window that is not loading, or another app loading: no wait, no read, no row', async () => {
    const plain = tools('Lunch Thursday', ['Lunch Thursday'])
    await plain.act.execute(press)
    expect(plain.asked).toEqual([])
    expect(waited(plain.rows)).toEqual([])
    const other = tools('Order desk, loading', ['Order desk, loading'])
    await other.act.execute({ ...press, app: 'TextEdit', steps: [{ app: 'TextEdit', action: 'open' }] }).catch(() => {})
    expect(other.asked).toEqual([])
  })
})

describe('Set 4 R1: no act-first anywhere, every step of a chain waits for a loading window', () => {
  // A press brings up the order desk while it loads (the fold's front window says so); the key after it must wait.
  const chain = { app: 'Notes', goal: 'start an order', steps: [{ app: 'Notes', role: 'button', label: 'New Note', action: 'press' }, { app: 'Notes', action: 'key', value: 'cmd+c' }] }
  it('a step that brought up a loading window: the next step waits, then acts', async () => {
    const t = tools('Lunch Thursday', ['Order desk, loading', 'Order desk, ready'], 200, (state, n) => { if (n === 1) state.window.active.windowTitle = 'Order desk, loading' })
    await t.act.execute(chain)
    expect(t.sent[0], 'the press went at once: nothing said loading').toBe(0)
    expect(t.sent[1], 'the key went after the read that said ready').toBe(2)
    expect(waited(t.rows)).toEqual([expect.objectContaining({ processName: 'Notes', gone: 'loading', ok: true })])
  })
  it('a title already waited out in this call is not waited for again while the fold still shows it', async () => {
    const t = tools('Order desk, loading', ['Order desk, ready'])
    await t.act.execute(chain)
    // The wait's read, then one read for the second step that finds the title no longer says loading (Fable review M4).
    expect(t.asked).toEqual(['Notes', 'Notes'])
    expect(waited(t.rows)).toHaveLength(1)
  })
  it('Fable M4: the same title loading again after a click is waited for again', async () => {
    // First wait: loading, ready. Before step 2 the fold still says "Order desk, loading", and so does the window: a reload.
    const t = tools('Order desk, loading', ['Order desk, loading', 'Order desk, ready', 'Order desk, loading', 'Order desk, loading', 'Order desk, ready'])
    await t.act.execute(chain)
    expect(waited(t.rows)).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })])
    expect(t.sent[1], 'the key went after the second wait').toBe(5)
  })
  it('a route replay (and gnomon_skill, which replays through screen_act) waits as a planned call does', async () => {
    const route = async () => ({ goal: 'start an order', steps: press.steps })
    const t = tools('Order desk, loading', ['Order desk, loading', 'Order desk, ready'], 200, () => {}, { route })
    await t.act.execute({ app: 'Notes', goal: 'start an order', route: true })
    expect(t.sent[0]).toBe(2)
    expect(waited(t.rows)).toEqual([expect.objectContaining({ ok: true })])
  })
})

describe('Fable M3: the loading wait stops, and has one budget per call', () => {
  const chain = { app: 'Notes', goal: 'start an order', steps: [{ app: 'Notes', role: 'button', label: 'New Note', action: 'press' }, { app: 'Notes', action: 'key', value: 'cmd+c' }] }
  it('the owner\'s Stop ends the wait at once, and nothing acts', async () => {
    const t = tools('Order desk, loading', ['Order desk, loading'], 5000)
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 50)
    const started = Date.now()
    await expect(t.act.execute(press, { signal: stop.signal })).rejects.toThrow(/stopped/)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(t.sent).toEqual([])
    expect(waited(t.rows)).toEqual([expect.objectContaining({ ok: false, stopped: true })])
  })
  it('the owner\'s correction ends the wait at once, and the step is refused as corrected', async () => {
    const t = tools('Order desk, loading', ['Order desk, loading'], 5000)
    setTimeout(() => { t.state.task = { id: 't1', at: new Date(Date.now() - 60_000).toISOString(), session: 's1', corrected: { session: 's1', at: new Date().toISOString() } } }, 50)
    const started = Date.now()
    await t.act.execute(press, { agent: { session: { id: 's1' } } }).catch(() => {})
    expect(Date.now() - started).toBeLessThan(1500)
    expect(t.sent).toEqual([])
    expect(waited(t.rows)).toEqual([expect.objectContaining({ stopped: true })])
  })
  it('the steps of one call share one budget: a second loading window gets what the first left', async () => {
    const t = tools('Order desk, loading', ['Order desk, loading'], 400, (state, n) => { if (n === 1) state.window.active.windowTitle = 'Checkout, loading' }, { load: { budget: { ms: 500 } } })
    await t.act.execute(chain)
    const rows = waited(t.rows)
    expect(rows).toHaveLength(2)
    expect(rows[0].ms).toBeGreaterThanOrEqual(400)
    expect(rows[1].ms, 'the second wait had about 100 ms left').toBeLessThan(300)
  })
})
