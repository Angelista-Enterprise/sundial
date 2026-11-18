// @vitest-environment jsdom
// The slip's locator (eye.js, Set 3 R1 round 4: "where and what" inside the slip) and its read (host/read-eye.js). Made-up values only.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { drawLocator, eyeKey, locatorOf, mountLocator, posWord, roleWord } from './eye.js'
import { readEye, screenOf } from '../host/read-eye.js'
import { lookForLog } from '../../../packages/harness-runtime/src/app-channel.ts'

const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(join(__dirname, '../../sundial-actions/screen-look.fixture.json'), 'utf8'))
const ROW = { ...lookForLog(LINE), tag: undefined, screen: { size: [1440, 900] } }
const AT = '2026-11-12T00:30:00.000Z'
const marks = (extra = {}) => ({ now: [], lastLook: { id: ROW.id, app: 'Notes', n: 4, at: AT }, ...extra })
const queries = (row = ROW) => ({ getSignalsInRange: async () => [{ data: { id: 'look-other' } }, { data: row }] })
const SCREEN = [0, 0, 1512, 982]

describe('readEye: the smallest data the locator uses', () => {
  it('the acted part and the ask\'s part (label, role, area, frame), the app, the window and its frame, the screen; nothing else', async () => {
    const state = { marks: marks({ lastAct: { id: 'act-1', outcome: 'performed', target: { app: 'Notes', look: ROW.id, ref: 'e7' } }, now: [{ id: 'ask:a1', target: { app: 'Notes', look: ROW.id, ref: 'e1' } }, { id: 'm2', target: { app: 'Notes', label: 'Title' } }] }) }
    const got = await readEye({ state, queries: queries() })
    expect(got).toEqual({
      key: `${ROW.id}|act-1|ask:a1|m2`,
      look: { id: ROW.id, at: AT, app: 'Notes', window: 'Lunch Thursday', frame: [0, 25, 1440, 875] },
      screen: [0, 0, 1440, 900],
      acted: { role: 'AXSearchFieldAXTextField', label: 'Search', area: 'toolbar', frame: [1180, 58, 220, 24] },
      asked: { role: 'AXButton', label: 'New Note', area: 'toolbar', frame: [412, 58, 28, 24] },
    })
    expect(eyeKey({ ...state.marks, now: [] })).not.toBe(got.key)
  })

  it('never sends what is typed in a field: a field is named by its label, a text by its words', async () => {
    const row = { id: 'look-p1', processName: 'Zen', windowTitle: 'New message', frame: [40, 40, 700, 392], screen: { size: [1512, 982] }, elements: [
      { ref: 'e1', role: 'AXTextField', screenText: ['To', 'test@example.com', 'New message'], frame: [252, 100, 468, 28] },
      { ref: 'e2', role: 'AXTextArea', screenText: ['', 'The test on BOX-484 is green.', ''], frame: [252, 172, 468, 196] },
      { ref: 'e3', role: 'AXStaticText', screenText: ['', 'New message', ''], frame: [252, 62, 200, 22] },
    ] }
    const at = (ref) => ({ marks: { lastLook: { id: 'look-p1', app: 'Zen', at: AT }, lastAct: { id: 'act-p', target: { look: 'look-p1', ref } }, now: [] } })
    expect((await readEye({ state: at('e1'), queries: queries(row) })).acted).toEqual({ role: 'AXTextField', label: 'To', area: 'New message', frame: [252, 100, 468, 28] })
    expect((await readEye({ state: at('e2'), queries: queries(row) })).acted.label).toBe('')
    expect((await readEye({ state: at('e3'), queries: queries(row) })).acted.label).toBe('New message')
    expect(JSON.stringify(await readEye({ state: at('e2'), queries: queries(row) }))).not.toMatch(/BOX-484|test@example/)
  })

  it('no act on another look; a private app is a refusal with no names; no look yet', async () => {
    const other = await readEye({ state: { marks: marks({ lastAct: { id: 'act-1', target: { look: 'look-old', ref: 'e7' } } }) }, queries: queries() })
    expect(other.acted).toBeNull()
    expect((await readEye({ state: { marks: marks({ lastLook: { id: 'look-9', app: '[private]', n: 0, at: AT, refused: 'private app' } }) }, queries: queries() })).look).toEqual({ id: 'look-9', at: AT, refused: true })
    expect((await readEye({ state: {}, queries: queries() })).look).toBeNull()
  })

  it('the screen is the display the window is on', () => {
    expect(screenOf({ frame: [2000, 100, 800, 600], screen: { size: [1512, 982], displays: [[0, 0, 1512, 982], [1512, 0, 1920, 1080]] } })).toEqual([1512, 0, 1920, 1080])
    expect(screenOf({ frame: [40, 44, 700, 312], screen: { size: [1512, 982] } })).toEqual([0, 0, 1512, 982])
    expect(screenOf({ frame: [40, 44, 700, 312] })).toEqual([0, 0, 740, 356])
    expect(screenOf({})).toBeNull()
  })
})

describe('the position words', () => {
  const win = [120, 40, 700, 392]
  it('a menu-bar item by the screen; every other part by its window, in thirds', () => {
    expect(posWord({ role: 'AXMenuBarItem', frame: [74, 3, 47, 18] }, [40, 44, 700, 312], SCREEN)).toBe('top left of the screen')
    expect(posWord({ role: 'AXButton', frame: [252, 386, 72, 30] }, win, SCREEN)).toBe('bottom left of the window')
    expect(posWord({ role: 'AXButton', frame: [430, 220, 60, 20] }, win, SCREEN)).toBe('middle of the window')
    expect(posWord({ role: 'AXButton', frame: [130, 220, 40, 20] }, win, SCREEN)).toBe('left side of the window')
    expect(posWord({ role: 'AXButton', frame: [450, 45, 40, 20] }, win, SCREEN)).toBe('top middle of the window')
    expect(posWord({ role: 'AXButton', frame: [760, 400, 40, 20] }, win, SCREEN)).toBe('bottom right of the window')
    // No window frame: the screen.
    expect(posWord({ role: 'AXButton', frame: [1400, 900, 40, 20] }, null, SCREEN)).toBe('bottom right of the screen')
  })
  it('a role as one word', () => {
    expect(['AXMenuBarItem', 'AXButton', 'AXSearchFieldAXTextField', 'AXOutlineRowAXRow', 'AXStaticText'].map(roleWord)).toEqual(['menu', 'button', 'field', 'row', 'part'])
  })
})

describe('the locator', () => {
  const data = {
    key: 'k',
    look: { id: 'look-7', at: AT, app: 'Finder', window: 'notes', frame: [40, 44, 700, 312] },
    screen: SCREEN,
    acted: { role: 'AXMenuBarItem', label: 'File', area: 'menu bar', frame: [74, 3, 47, 18] },
    asked: { role: 'AXButton', label: 'Send', area: 'notes', frame: [600, 320, 72, 30] },
  }

  it('says what and where: the part, its kind and area; the app, the window, the position', () => {
    expect(locatorOf(data)).toEqual({ label: 'File', role: 'menu', area: 'menu bar', app: 'Finder', window: 'notes', pos: 'top left of the screen', screen: [1512, 982], win: [40, 44, 700, 312], frame: [74, 3, 47, 18] })
    // On an ask: the part the yes presses. An area that is only the window's title, and a window named as its app, are left out.
    expect(locatorOf(data, { ask: true })).toMatchObject({ label: 'Send', role: 'button', area: '', pos: 'bottom right of the window' })
    expect(locatorOf({ ...data, look: { ...data.look, window: 'Finder' } }).window).toBe('')
  })

  it('draws the part at its true relative place on the screen, as one ochre mark never under 5 by 4 px', () => {
    const svg = drawLocator(locatorOf(data, { ask: true }))
    expect([svg.getAttribute('width'), svg.getAttribute('height'), svg.getAttribute('viewBox')]).toEqual(['72', String(Math.round(982 * 72 / 1512)), '0 0 1512 982'])
    const hit = svg.querySelector('rect.ov-loc-hit')
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => Number(hit.getAttribute(k)))
    // Its centre is the part's centre: the same fraction of the screen across and down.
    expect((x + w / 2) / 1512).toBeCloseTo((600 + 36) / 1512, 3)
    expect((y + h / 2) / 982).toBeCloseTo((320 + 15) / 982, 3)
    expect(w * (72 / 1512)).toBeGreaterThanOrEqual(5 - 1e-9)
    expect(h * (72 / 1512)).toBeGreaterThanOrEqual(4 - 1e-9)
    expect(svg.querySelectorAll('rect.ov-loc-hit')).toHaveLength(1)
    expect(svg.querySelector('rect.ov-loc-win').getAttribute('x')).toBe('40')
  })

  it('keeps a mark at the screen\'s edge inside the outline, and uses class names the app\'s sheet does not style', () => {
    const hit = drawLocator(locatorOf(data)).querySelector('rect.ov-loc-hit')
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => Number(hit.getAttribute(k)))
    expect(x).toBeGreaterThanOrEqual(0)
    expect(y).toBe(0)
    expect(x + w).toBeLessThanOrEqual(1512)
    expect(y + h).toBeLessThanOrEqual(982)
    // app.css styles .hit, .bar and .win; a CSS width beats an SVG rect's width attribute, which once drew the mark 72 px wide.
    const css = readFileSync(join(__dirname, 'app.css'), 'utf8')
    for (const node of drawLocator(locatorOf(data)).querySelectorAll('[class]')) {
      const name = node.getAttribute('class')
      expect(name.startsWith('ov-loc'), name).toBe(true)
      expect(css.includes(`.${name}`), name).toBe(false)
    }
  })

  it('on a second display, the place is on that display', () => {
    const loc = locatorOf({ ...data, screen: [1512, 0, 1920, 1080], look: { ...data.look, frame: [1600, 100, 800, 600] }, acted: { role: 'AXButton', label: 'Save', area: '', frame: [2300, 640, 60, 24] } })
    expect(loc).toMatchObject({ screen: [1920, 1080], win: [88, 100, 800, 600], frame: [788, 640, 60, 24], pos: 'bottom right of the window' })
  })

  it('shows nothing that is not true: no look, a private app (no names), no part', () => {
    expect(locatorOf(null)).toBeNull()
    expect(locatorOf({ key: 'k', look: { id: 'look-9', at: AT, refused: true }, screen: SCREEN, acted: data.acted })).toBeNull()
    expect(locatorOf({ ...data, acted: null })).toBeNull()
    expect(locatorOf({ ...data, screen: null })).toBeNull()
  })
})

describe('the locator in the slip', () => {
  const settle = () => new Promise((r) => setTimeout(r, 30))
  const data = { key: 'look-7|act-7|ask:a', look: { id: 'look-7', at: AT, app: 'Finder', window: 'notes', frame: [40, 44, 700, 312] }, screen: SCREEN, acted: { role: 'AXMenuBarItem', label: 'File', area: 'menu bar', frame: [74, 3, 47, 18] }, asked: { role: 'AXButton', label: 'Send', area: 'notes', frame: [600, 320, 72, 30] } }

  it('nothing at rest; while doing, the two lines with the step; on an ask, the figure; it reads the look once per key', async () => {
    const asked = []
    const root = document.createElement('div')
    const loc = mountLocator({ get: async (url) => (asked.push(url), data), root })
    loc.show(null)
    await settle()
    expect([loc.doing.hidden, loc.ask.hidden, asked.length]).toEqual([true, true, 0])
    loc.show('doing', { step: 7 })
    await settle()
    expect(loc.doing.hidden).toBe(false)
    expect(loc.doing.querySelector('.ov-stag').textContent).toBe('7')
    expect(loc.doing.querySelector('.ov-loc-what').textContent).toBe('7File· menu in the menu bar')
    expect(loc.doing.querySelector('p:last-child').textContent).toBe('Finder · notes · top left of the screen')
    loc.show('ask', { step: 7 })
    await settle()
    expect([loc.doing.hidden, loc.ask.hidden]).toEqual([true, false])
    expect(loc.ask.querySelector('figcaption').textContent).toBe('Send · bottom right')
    // Before the first eye frame the key is unknown: read once, not on every update.
    for (const mode of ['doing', 'ask', 'doing']) (loc.show(mode, { step: 7 }), await settle())
    expect(asked).toEqual(['/gnomon/api/eye'])
    root.dataset.eye = data.key
    await settle()
    expect(asked).toHaveLength(1)
    root.dataset.eye = 'look-8|act-8|'
    await settle()
    expect(asked).toHaveLength(2)
    loc.show(null)
    expect([loc.doing.hidden, loc.ask.hidden]).toEqual([true, true])
  })

  it("the ask's caption is one line: the label gives way, the place stays whole, and a menu-bar place drops 'of the screen'", async () => {
    // The caption once wrapped to two lines in the 72 px figure ("Send · bottom / left"); now two runs, no wrapping.
    const css = readFileSync(join(__dirname, 'overlay.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.ov-askloc figcaption \{[^}]*white-space: pre;/)
    expect(css).toMatch(/\.ov-askloc figcaption > :first-child \{[^}]*text-overflow: ellipsis;/)
    expect(css).toMatch(/\.ov-askloc figcaption > :last-child \{[^}]*flex: none;/)
    expect(css).not.toMatch(/\.ov-askloc figcaption \{[^}]*overflow-wrap: anywhere/)
    const loc = mountLocator({ get: async () => ({ ...data, asked: { role: 'AXMenuBarItem', label: 'Send to Mira Bakker and the puzzlebox-studio list', area: 'menu bar', frame: [74, 3, 47, 18] } }), root: document.createElement('div') })
    loc.show('ask')
    await settle()
    const [what, where] = loc.ask.querySelector('figcaption').children
    expect([what.textContent, what.title, where.textContent]).toEqual(['Send to Mira Bakker and the puzzlebox-studio list', 'Send to Mira Bakker and the puzzlebox-studio list', ' · top left'])
  })

  it('a private app: no locator and no names', async () => {
    const loc = mountLocator({ get: async () => ({ key: 'k', look: { id: 'look-9', at: AT, refused: true } }), root: document.createElement('div') })
    loc.show('doing', { step: 3 })
    await settle()
    expect(loc.doing.hidden).toBe(true)
    expect(loc.doing.textContent).toBe('')
  })
})
