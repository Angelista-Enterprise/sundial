import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { answered, answerSentence } from '../sundial-tools/answer-only.js'
import { pickRecent, placeOf, pullUpTool, recentWork, wordsOf } from './pull-up.js'

// Made-up record: every name, title and page here is invented. TextEdit's own title for a changed file, " \u2014 Edited" after the name.
const EDITED = 'kestrel-memo.txt \u2014 Edited'
const OWNER = { id: 'm-owner', processName: 'TextEdit', startTime: '2026-11-10T09:00:00.000Z', endTime: '2026-11-10T09:30:00.000Z', data: { windowTitles: ['groceries.txt', EDITED], symbolsEdited: ['juniperTotal'] } }
const MOMENTS = {
  'm-rig': { id: 'm-rig', processName: 'Safari', startTime: '2026-11-15T08:00:00.000Z', data: { windowTitles: ['Rig fixture: kestrel memo'], pages: ['example.org/kestrel-memo'] } },
  // Wholly inside the fold's last run of Gnomon's acts in TextEdit: its windows were Gnomon's.
  'm-gnomon': { id: 'm-gnomon', processName: 'TextEdit', startTime: '2026-11-15T10:00:05.000Z', endTime: '2026-11-15T10:00:40.000Z', data: { windowTitles: ['kestrel-memo copy.txt'] } },
  'm-sundial': { id: 'm-sundial', processName: 'Sundial', startTime: '2026-11-15T09:00:00.000Z', data: { windowTitles: ['Kestrel memo chat'] } },
  'm-owner': OWNER,
}
const HITS = [{ refType: 'knowledge_entry', refId: 'k1', label: 'Kestrel memo notes' }, ...['m-rig', 'm-gnomon', 'm-sundial', 'm-owner'].map((refId) => ({ refType: 'moment', refId, label: refId }))]
const LOOK = { id: 'look-ab12', tag: 'ab12', processName: 'TextEdit', windowTitle: EDITED, elements: [{ ref: 'e1', role: 'AXStaticText', screenText: [EDITED] }, { ref: 'e2', role: 'AXTextArea', screenText: ['', 'Mira Bakker\njuniperTotal = 4'] }] }
// The log's last half hour, made up: an older owner edit, Gnomon's own raise of it (and keys while it acted), the owner's newer
// edit with its path, then Finder, the rig's fixture window and Sundial's chat tab (typing there is the request itself).
const row = (eventType, capturedAt, data) => ({ signalType: { changed: 'window', activity: 'input' }[eventType] ?? 'action', eventType, capturedAt, data })
const RECENT = [
  row('changed', '2026-11-15T10:40:00.000Z', { processName: 'TextEdit', windowTitle: 'Log Kestrel.txt', documentPath: 'file:///Users/test/fix/Log%20Kestrel.txt' }),
  row('activity', '2026-11-15T10:40:10.000Z', { keyDownCount: 40, windowMs: 10_000 }),
  row('decided', '2026-11-15T10:50:00.000Z', { tool: 'screen_act', action: 'screen_act', verdict: 'allow' }),
  row('changed', '2026-11-15T10:50:00.500Z', { processName: 'TextEdit', windowTitle: 'Log Kestrel.txt' }),
  row('activity', '2026-11-15T10:50:01.000Z', { keyDownCount: 12, windowMs: 10_000 }),
  row('performed', '2026-11-15T10:50:02.000Z', { tool: 'screen_act', action: 'screen_act', outcome: 'ok' }),
  row('changed', '2026-11-15T10:56:00.000Z', { processName: 'TextEdit', windowTitle: 'Brief Onyx.txt \u2014 Edited', documentPath: 'file:///Users/test/fix/Brief%20Onyx.txt' }),
  row('changed', '2026-11-15T10:56:05.000Z', { processName: 'Finder', windowTitle: 'Downloads' }),
  // Five seconds in each: the keys are the document's, never Finder's.
  row('activity', '2026-11-15T10:56:10.000Z', { keyDownCount: 30, windowMs: 10_000 }),
  row('changed', '2026-11-15T10:57:00.000Z', { processName: 'Safari', windowTitle: 'Rig fixture: notes' }),
  row('activity', '2026-11-15T10:57:10.000Z', { keyDownCount: 9, windowMs: 10_000 }),
  row('changed', '2026-11-15T10:58:00.000Z', { processName: 'Zen', windowTitle: 'Sundial' }),
  row('activity', '2026-11-15T10:58:10.000Z', { keyDownCount: 50, windowMs: 10_000 }),
]
const BODY = 'the document body is ringed (keys are counted, never read, so which line changed is not on record)'
const text = (t) => ({ content: [{ type: 'text', text: t }] })
/** The answer for a thing brought up: the thing first, said to answer the newest message, then the one sentence to say. */
const shown = (name, app, ring = '') => `${name} in ${app} is what the owner's newest message asks for, now in front: answer about it alone and open nothing else, whatever was named earlier in the chat. Say exactly this, nothing more and no other claim about what is ringed: "Here is ${name} in ${app}${ring}."`

/** A pull-up with a fake dsh pipeline: each inner call is recorded. */
function rig({ hits = HITS, moments = MOMENTS, act = () => text('The window of TextEdit is in front.'), look = LOOK, recent = [], shell = (args) => ({ value: { ran: true, exitCode: 0 } }) } = {}) {
  const state = { byGnomon: { since: '2026-11-15T10:00:00.000Z', until: '2026-11-15T10:01:00.000Z', apps: ['TextEdit'] }, marks: {} }
  const calls = []
  const signals = []
  const tools = {
    execute: async (req) => {
      calls.push({ name: req.name, args: req.arguments, parent: req.parent })
      if (req.name === 'gnomon_semantic_search') return { value: hits }
      if (req.name === 'gnomon_moment_detail') return { value: moments[req.arguments.momentId] ?? { error: 'No moment is stored under that id.' } }
      if (req.name === 'screen_act') {
        const r = act(req.arguments, calls)
        if (!r.isError) state.marks.lastLook = { id: look.id, app: look.processName, at: '2026-11-15T11:00:00.000Z' }
        return r
      }
      if (req.name === 'gnomon_run_shell') return shell(req.arguments)
      if (req.name === 'gnomon_await') return text('TextEdit is in front.')
      if (req.name === 'screen_look') {
        state.marks.lastLook = { id: look.id, app: look.processName, at: '2026-11-15T11:00:00.000Z' }
        return text('Read off the screen.')
      }
      if (req.name === 'screen_mark') return text('Marked (mark-0a1b2c3d). It stays until you clear it or the thing goes away.')
      throw new Error(`unexpected ${req.name}`)
    },
    schemas: () => [{ name: 'gnomon_run_shell' }],
  }
  const tool = pullUpTool({ tools, getState: () => state, appendSignal: async (type, payload) => signals.push({ type, ...payload }), readLook: async (id) => (id === look.id ? look : null), readRecent: async () => recent })
  const run = (what) => tool.execute(Object.freeze({ what }), { callId: 'c1', token: 't1', agent: { session: { id: 's1' } } })
  return { run, calls, signals, tool }
}

describe('gnomon_pull_up', () => {
  it('finds the owner\'s own thing (the rig\'s window, Gnomon\'s run and Sundial left out), raises it, rings the last edit', async () => {
    const r = rig()
    expect(await r.run("Tuesday's memo")).toBe(shown('kestrel-memo.txt', 'TextEdit', '; the part you last changed is ringed'))
    const act = r.calls.find((c) => c.name === 'screen_act')
    expect(act.args).toEqual({ app: 'TextEdit', window: 'kestrel-memo.txt', action: 'raise', goal: 'pull it up', because: `Bring up ${EDITED}` })
    // Every inner call goes through dsh's pipeline under its own name, a child of this call.
    expect(r.calls.map((c) => [c.name, c.parent])).toEqual([
      ['gnomon_semantic_search', 't1'], ...['m-rig', 'm-gnomon', 'm-sundial', 'm-owner'].map(() => ['gnomon_moment_detail', 't1']), ['screen_act', 't1'], ['screen_mark', 't1'],
    ])
    expect(r.calls.at(-1).args).toEqual({ ref: 'e2@ab12' })
    // The measure: the start, and the end naming the mark whose screen:mark-placed row the app writes.
    expect(r.signals).toEqual([
      { type: 'screen:pull-up', id: expect.stringMatching(/^pull-/), phase: 'start', session: 's1' },
      { type: 'screen:pull-up', id: r.signals[0].id, phase: 'end', outcome: 'shown', ms: expect.any(Number), session: 's1', app: 'TextEdit', mark: 'mark-0a1b2c3d' },
    ])
  })

  it('opens a page of a browser by its address, and rings a word of the request when nothing was edited', async () => {
    const moments = { 'm-web': { processName: 'Safari', data: { windowTitles: ['Stocks'], pages: ['example.org/watch', 'example.org/stock-list'] } } }
    const look = { id: 'look-cd34', tag: 'cd34', processName: 'Safari', windowTitle: 'Stocks', elements: [{ ref: 'e4', role: 'AXHeading', screenText: ['Puzzlebox list'] }] }
    const r = rig({ hits: [{ refType: 'moment', refId: 'm-web' }], moments, look })
    expect(await r.run('the stock list')).toBe(shown('example.org/stock-list', 'Safari', '; \"Puzzlebox list\" is ringed'))
    expect(r.calls.find((c) => c.name === 'screen_act').args).toMatchObject({ app: 'Safari', url: 'https://example.org/stock-list' })
  })

  it('a window no longer open is opened again from the app\'s recent list; a refusal is said plainly, never as shown', async () => {
    const act = (args) => (args.steps ? { isError: true, error: { message: 'Gnomon: the owner said no.' } } : { isError: true, error: { message: 'refused: no-such-window. No window of that app has that in its title.' } })
    const r = rig({ act })
    expect(await r.run('the kestrel memo')).toBe(`I found the kestrel memo (${EDITED} in TextEdit) but could not bring it up: Gnomon: the owner said no. Say that in one sentence.`)
    expect(r.calls.filter((c) => c.name === 'screen_act').at(-1).args).toMatchObject({ app: 'TextEdit', steps: [{ app: 'TextEdit' }, { app: 'TextEdit', action: 'pick-menu', value: 'File > Open Recent > kestrel-memo.txt' }] })
    expect(r.calls.some((c) => c.name === 'screen_mark')).toBe(false)
    expect(r.signals.at(-1)).toMatchObject({ phase: 'end', outcome: 'refused' })
    // Run 217 T13: the app came up and the menu step was refused; the steps' answer is no error, and it is no "shown".
    const menu = (args) => (args.steps ? text('1. Open TextEdit: done\n2. Pick "File > Open Recent > kestrel-memo.txt" in TextEdit: refused: not-found. No menu item by that name.\nStopped at step 2: steps 3 to 2 did not run. Look again, then go on.') : act(args))
    const m = rig({ act: menu })
    expect(await m.run('the kestrel memo')).toBe(`I found the kestrel memo (${EDITED} in TextEdit) but could not bring it up: Pick "File > Open Recent > kestrel-memo.txt" in TextEdit: refused: not-found. No menu item by that name. Say that in one sentence.`)
    expect(m.signals.at(-1)).toMatchObject({ phase: 'end', outcome: 'refused' })
  })

  it('a private app is refused before anything is opened, and the row never names it', async () => {
    for (const processName of ['Messages', '[private]']) {
      const r = rig({ hits: [{ refType: 'moment', refId: 'm-chat' }], moments: { 'm-chat': { processName, data: { windowTitles: ['Mira Bakker'] } } } })
      expect(await r.run('the chat with Mira')).toMatch(/^That is in a private app, so I do not open it\./)
      expect(r.calls.map((c) => c.name)).toEqual(['gnomon_semantic_search', 'gnomon_moment_detail'])
      expect(r.signals.at(-1)).toEqual({ type: 'screen:pull-up', id: r.signals[0].id, phase: 'end', outcome: 'private', ms: expect.any(Number), session: 's1' })
    }
  })

  it('nothing of the owner\'s found: says so, opens nothing', async () => {
    const r = rig({ hits: [HITS[0], { refType: 'moment', refId: 'm-rig' }, { refType: 'moment', refId: 'm-gone' }] })
    expect(await r.run('the BOX-484 ticket')).toBe('I could not find the BOX-484 ticket in what I have seen you work on. Say so in one sentence.')
    expect(r.calls.some((c) => c.name === 'screen_act')).toBe(false)
    expect(r.signals.at(-1)).toMatchObject({ outcome: 'not-found' })
    await expect(r.run('  ')).rejects.toThrow(/invalid arguments/)
  })

  it('the owner\'s newest edit, minutes old and in no moment yet, wins over an older moment (runs 163 to 166)', async () => {
    const r = rig({ recent: RECENT })
    expect(await r.run('the document I was editing a few minutes ago')).toBe(shown('Brief Onyx.txt', 'TextEdit', `; ${BODY}`))
    expect(r.calls.map((c) => c.name)).toEqual(['screen_act', 'screen_mark'])
    expect(r.calls[0].args).toMatchObject({ app: 'TextEdit', window: 'Brief Onyx.txt', action: 'raise' })
  })

  it('a closed document is opened by its path through the shell, then waited for and looked at; Open Recent only without a path', async () => {
    const closed = (args) => (args.window ? { isError: true, error: { message: 'refused: no-such-window. No window of that app has that in its title.' } } : text('done'))
    const r = rig({ recent: RECENT, act: closed })
    expect(await r.run('the document I was just editing')).toMatch(/"Here is Brief Onyx\.txt in TextEdit; the document body is ringed \(keys are counted, never read, so which line changed is not on record\)\."$/)
    expect(r.calls.map((c) => c.name)).toEqual(['screen_act', 'gnomon_run_shell', 'gnomon_await', 'screen_look', 'screen_mark'])
    expect(r.calls[1].args).toEqual({ command: "open -a 'TextEdit' '/Users/test/fix/Brief Onyx.txt'" })
    expect(r.calls[2].args).toEqual({ app: 'TextEdit', window: 'Brief Onyx.txt', seconds: 8 })
    // The shell refused: said plainly, no second way tried behind the owner's no.
    const no = rig({ recent: RECENT, act: closed, shell: () => ({ isError: true, error: { message: 'Gnomon: the owner said no.' } }) })
    expect(await no.run('the document I was just editing')).toMatch(/could not bring it up: Gnomon: the owner said no\./)
    expect(no.calls.map((c) => c.name)).toEqual(['screen_act', 'gnomon_run_shell'])
    // Run 217 T13: the record keeps the home folder as "~/" (sanitize-at-ingest); the path is still the document's.
    const home = RECENT.map((x) => (x.data.documentPath?.includes('Brief') ? { ...x, data: { ...x.data, documentPath: '~/fix/Brief%20Onyx.txt' } } : x))
    const tilde = rig({ recent: home, act: closed })
    await tilde.run('the document I was just editing')
    expect(tilde.calls[1].args).toEqual({ command: `open -a 'TextEdit' '${homedir()}/fix/Brief Onyx.txt'` })
  })

  it('live windows: Gnomon\'s own focus and keys, Sundial, the rig\'s windows and Finder never count as the owner\'s edit', () => {
    const work = recentWork(RECENT)
    expect(work.map((w) => w.window).sort()).toEqual(['Brief Onyx.txt \u2014 Edited', 'Downloads', 'Log Kestrel.txt'])
    expect(pickRecent(work, [], true)).toMatchObject({ app: 'TextEdit', window: 'Brief Onyx.txt \u2014 Edited', path: '/Users/test/fix/Brief Onyx.txt' })
    // By name: a live window whose title holds the words; none holds them, so the record is asked instead.
    expect(pickRecent(work, ['kestrel'], false)).toMatchObject({ window: 'Log Kestrel.txt' })
    expect(pickRecent(work, ['juniper'], false)).toBeNull()
    // Without the newer edit, the older one: Gnomon's later raise of it did not make it newer, and its keys are not the owner's.
    const older = recentWork(RECENT.filter((r) => !/Brief|Downloads/.test(JSON.stringify(r.data))))
    expect(pickRecent(older, [], true)).toMatchObject({ window: 'Log Kestrel.txt', typedAt: Date.parse('2026-11-15T10:40:10.000Z') })
  })

  it('keys typed while the slip is up are the request, never an edit of the window under it (runs 180-182: a Finder Info window won)', () => {
    const slip = (eventType, capturedAt) => ({ signalType: 'overlay', eventType, capturedAt, data: {} })
    const rows = [
      row('changed', '2026-11-15T10:12:27.000Z', { processName: 'Zen', windowTitle: 'Outline Cobalt' }),
      row('changed', '2026-11-15T10:12:33.000Z', { processName: 'Finder', windowTitle: 'notes.txt Info' }),
      row('activity', '2026-11-15T10:12:33.100Z', { keyDownCount: 31, windowMs: 10_000 }),
      slip('summoned', '2026-11-15T10:14:37.000Z'),
      row('activity', '2026-11-15T10:14:45.000Z', { keyDownCount: 9, windowMs: 10_000 }),
    ]
    expect(pickRecent(recentWork(rows), [], true)).toMatchObject({ app: 'Zen', window: 'Outline Cobalt' })
    // Once the slip is gone (or the owner went to another window), keys count again.
    const after = [...rows, slip('dismissed', '2026-11-15T10:15:00.000Z'), row('changed', '2026-11-15T10:15:01.000Z', { processName: 'TextEdit', windowTitle: 'Plan Onyx.txt' }), row('activity', '2026-11-15T10:15:09.000Z', { keyDownCount: 5, windowMs: 8_000 })]
    expect(pickRecent(recentWork(after), [], true)).toMatchObject({ app: 'TextEdit', window: 'Plan Onyx.txt' })
  })

  it('a summon never dismissed before the next one ends there, not at the end of the log (run 173: no edit counted at all)', () => {
    const slip = (eventType, capturedAt) => ({ signalType: 'overlay', eventType, capturedAt, data: {} })
    const rows = [
      slip('summoned', '2026-11-15T06:20:00.000Z'),
      slip('summoned', '2026-11-15T06:21:00.000Z'),
      row('changed', '2026-11-15T06:21:10.000Z', { processName: 'TextEdit', windowTitle: 'Brief Kestrel.txt' }),
      row('activity', '2026-11-15T06:21:20.000Z', { keyDownCount: 33, windowMs: 10_000 }),
    ]
    expect(pickRecent(recentWork(rows), [], true)).toMatchObject({ window: 'Brief Kestrel.txt' })
  })

  it('a row that runs into the next summon keeps its keys from before it; one stray key and a Finder window are no edit (run 184)', () => {
    const slip = (eventType, capturedAt) => ({ signalType: 'overlay', eventType, capturedAt, data: {} })
    const rows = [
      row('changed', '2026-11-15T11:19:20.000Z', { processName: 'TextEdit', windowTitle: 'Log Kestrel.txt' }),
      row('activity', '2026-11-15T11:19:30.000Z', { keyDownCount: 20, windowMs: 10_000 }),
      // The rig's edit of the fixture, then its neutral front (a Finder Info window), then the next task's summon 7 s into the row.
      row('changed', '2026-11-15T11:19:44.000Z', { processName: 'Zen', windowTitle: 'Outline Tamarind' }),
      row('changed', '2026-11-15T11:19:49.000Z', { processName: 'Finder', windowTitle: 'Juniper.txt Info' }),
      slip('summoned', '2026-11-15T11:19:53.000Z'),
      row('activity', '2026-11-15T11:19:56.000Z', { keyDownCount: 32, windowMs: 10_000 }),
      row('changed', '2026-11-15T11:20:30.000Z', { processName: 'Zen', windowTitle: 'Rig fixture: Long form' }),
      row('changed', '2026-11-15T11:21:24.000Z', { processName: 'Finder', windowTitle: 'Juniper.txt Info' }),
      // The pull-up's own summon key, alone in a row just before its summoned row.
      row('activity', '2026-11-15T11:21:29.000Z', { keyDownCount: 1, windowMs: 10_000 }),
      slip('summoned', '2026-11-15T11:21:29.600Z'),
    ]
    const work = recentWork(rows)
    expect(pickRecent(work, [], true)).toMatchObject({ app: 'Zen', window: 'Outline Tamarind' })
    expect(work.find((w) => w.app === 'Finder').typedAt).toBeUndefined()
  })

  it('the newest ask wins in one long thread: the call takes the newest words, and the answer names the thing first as the answer to them (runs 173, 174)', async () => {
    // An earlier ask in the same thread had found Log Kestrel.txt; the model then sent that name for "the document I was editing".
    const tool = rig().tool
    expect(tool.description).toMatch(/newest message/)
    expect(tool.parameters.properties.what.description).toMatch(/newest message.*Never a name you take from an earlier ask/s)
    const said = await rig({ recent: RECENT }).run('the document I was editing a few minutes ago')
    expect(said.startsWith("Brief Onyx.txt in TextEdit is what the owner's newest message asks for")).toBe(true)
    expect(said).toMatch(/open nothing else, whatever was named earlier in the chat/)
  })

  it('a look that carries the caret rings the line the owner was on and names it; numbers only, the text never read', async () => {
    const caret = { line: 12, frame: [240, 410, 900, 18], ref: 'c2' }
    const look = { ...LOOK, elements: [LOOK.elements[0], { ...LOOK.elements[1], caret }] }
    const r = rig({ recent: RECENT, look })
    expect(await r.run('pull up the document I was editing and point at the line I changed')).toBe(shown('Brief Onyx.txt', 'TextEdit', '; the line you were on is ringed (line 12)'))
    expect(r.calls.at(-1)).toMatchObject({ name: 'screen_mark', args: { ref: 'c2@ab12' } })
    // Set 4 R1: the caret ring ends the hunt: the next call has no tools (answered) and says this line alone (answerSentence).
    const pulled = [{ role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'gnomon_pull_up', arguments: '{}' }] }, { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: await r.run('pull up the document I was editing and point at the line I changed') }] }]
    expect(answered(pulled)).toBe(true)
    expect(answerSentence(pulled)).toBe('Here is Brief Onyx.txt in TextEdit; the line you were on is ringed (line 12).')
    // No caret (a web page, an app that gives none): the body, as before.
    expect(await rig({ recent: RECENT }).run('the document I was editing a few minutes ago')).toBe(shown('Brief Onyx.txt', 'TextEdit', `; ${BODY}`))
    // Runs 215 to 221 T13: closed and opened again, its caret is the app's fresh one (line 1), never the owner's: the body.
    const closed = (args) => (args.window ? { isError: true, error: { message: 'refused: no-such-window. No window of that app has that in its title.' } } : text('done'))
    expect(await rig({ recent: RECENT, look, act: closed }).run('the document I was editing a few minutes ago')).toBe(shown('Brief Onyx.txt', 'TextEdit', `; ${BODY}`))
  })

  it('nothing to ring: the answer names the document and claims no ring', async () => {
    const r = rig({ recent: RECENT, look: { ...LOOK, elements: [] } })
    expect(await r.run('the document I was editing')).toBe(shown('Brief Onyx.txt', 'TextEdit', ''))
    expect(r.calls.map((c) => c.name)).toEqual(['screen_act'])
  })

  it('a file extension is never a matching word on its own (run 173: "Log Tamarind.txt" matched "Brief Kestrel.txt")', () => {
    expect(wordsOf('Log Tamarind.txt')).toEqual(['log', 'tamarind'])
    const work = [{ app: 'TextEdit', window: 'Brief Kestrel.txt', seenAt: 1, typedAt: 1 }]
    expect(pickRecent(work, wordsOf('Log Tamarind.txt'), false)).toBeNull()
    expect(pickRecent(work, wordsOf('Brief Kestrel.txt'), false)).toMatchObject({ window: 'Brief Kestrel.txt' })
  })

  it('words and places: no day or filler words; the best-matching title, the latest on a tie', () => {
    expect(wordsOf("Tuesday's memo from the morning")).toEqual(['memo'])
    expect(placeOf({ processName: 'Preview', data: { windowTitles: ['a.pdf', 'b.pdf'] } }, ['memo'], {})).toMatchObject({ window: 'b.pdf' })
    expect(placeOf({ processName: 'Preview', data: { windowTitles: ['memo.pdf', 'b.pdf'] } }, ['memo'], {})).toMatchObject({ window: 'memo.pdf' })
    expect(placeOf({ processName: 'loginwindow', data: {} }, [], {})).toBeNull()
  })
})
