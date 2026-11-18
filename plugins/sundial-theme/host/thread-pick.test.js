import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../shell/app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../shell/index.html', import.meta.url), 'utf8')
const overlay = readFileSync(new URL('../shell/overlay.js', import.meta.url), 'utf8')
const sessions = readFileSync(new URL('./api-sessions.js', import.meta.url), 'utf8')
const pill = readFileSync(new URL('../shell/thread-pill.js', import.meta.url), 'utf8')
const strip = readFileSync(new URL('../shell/live-strip.js', import.meta.url), 'utf8')

describe('the thread pill (run 18: every run landed in the same growing conversation)', () => {
  it('is the model pill\'s shape, so the slip restyles it with no new rules', () => {
    // One idiom: `.model` is what the slip turns into a pill and what carries the menu's paper.
    expect(html).toMatch(/<div class="model" id="thread" hidden>/)
    expect(html).toMatch(/id="thread-pick"[\s\S]*aria-haspopup="listbox"/)
    expect(html).toMatch(/<div class="model-menu" id="thread-menu" role="listbox"/)
  })

  it('is hidden on the board and shown only when the slip takes it', () => {
    expect(html).toMatch(/id="thread" hidden/)
    expect(overlay).toMatch(/const thread = document\.getElementById\('thread'\)\n\s+if \(thread\) thread\.hidden = false/)
    // Set 3 R1: the field has its own line; the thread sits under it, in the row.
    expect(overlay).toMatch(/el\('div', \{ class: 'ov-tick' \}, \[el\('div', \{ class: 'ov-one' \}, \[mark, field\]\), thread, /)
  })

  it('sends the turn to the thread it holds, instead of always the companion', () => {
    // The old line pinned the slip to one conversation; the new one asks what the pill holds.
    expect(app).not.toMatch(/dataset\.overlay \? COMPANION_SESSION_ID : null/)
    expect(app).toMatch(/dataset\.overlay \? state\.sessionId \?\? COMPANION_SESSION_ID : null/)
  })

  it('remembers the thread across a reload, and follows one picked from outside', () => {
    expect(pill).toMatch(/localStorage\.setItem\(SLIP_THREAD/)
    expect(app).toMatch(/case 'thread':[\s\S]{0,400}dataset\.overlay\) joinPicked\(frame\)/)
  })

  it('leaves the board on the owner\'s thread, and shows every other working thread in the live strip', () => {
    // The board used to join a picked thread without opening it: the transcript stayed, the next message went elsewhere.
    expect(html).toMatch(/id="thread-bar"><\/div>[\s\S]{0,140}<div class="live-strip" id="live-strip"[^>]*hidden>/)
    expect(app).toMatch(/case 'run':[\s\S]{0,40}runFrame\(frame\)/)
    expect(strip).toMatch(/runs\.set\(frame\.id, frame\)[\s\S]{0,300}drawRuns\(\)/)
    expect(strip).toMatch(/dataset\.overlay \? \[\] : \[\.\.\.runs\.values\(\)\]\.filter\(\(run\) => run\.id !== state\.sessionId\)/)
    expect(strip).toMatch(/class: 'live-run'[\s\S]{0,160}onclick: \(\) => openSession\(run\.id\)/)
  })

  it('offers a new thread under the threads there are', () => {
    expect(pill).toMatch(/text: 'New thread'/)
    expect(pill).toMatch(/'\/gnomon\/api\/session\/new'[\s\S]{0,200}method: 'POST'/)
  })

  it('lets a caller that is not the page pick the thread it just made', () => {
    expect(sessions).toMatch(/body\?\.pick === true\) broadcast\(\{ type: 'thread', \.\.\.last\.picked \}\)/)
    // A body is only read when one was sent: a read on a request without one never returns.
    expect(sessions).toMatch(/content-length'\] \?\? 0\) > 0 \? await readJson/)
  })
})

describe('an open question never takes the slip\'s words (run 200: a rig task landed in the companion)', () => {
  // At the day boundary a rule opened a question for the owner. The slip shows no question seat, yet the composer took
  // the next typed task as the ANSWER and, answering, switched to the companion thread: the run's task ran there.
  const source = app.match(/function answeringNow\(\) \{\n([^\n]*)\n\}/)?.[1]
  const answering = (overlay, answering) => new Function('openAsk', 'input', 'document', source)({ askId: 'a1', question: 'Did the BOX-484 review land?' }, { dataset: answering === undefined ? {} : { answering } }, { documentElement: { dataset: overlay ? { overlay: 'slip' } : {} } })

  it('in the slip a typed message is never an answer; on the board it still is', () => {
    expect(source).toBeTruthy()
    expect(answering(true)).toBe(false)
    expect(answering(false)).toBe(true)
    expect(answering(false, '0')).toBe(false)
  })

  it('and the only switch to the companion on a send is behind that answer', () => {
    const submit = app.slice(app.indexOf("bar.addEventListener('submit'"), app.indexOf("bar.addEventListener('submit'") + 2400)
    expect(submit).toMatch(/const ask = answeringNow\(\) \? openAsk : null/)
    expect([...submit.matchAll(/openSession\(COMPANION_SESSION_ID\)/g)]).toHaveLength(1)
    expect(submit).toMatch(/if \(ask !== null\) \{[\s\S]*if \(state\.sessionId !== COMPANION_SESSION_ID\) await openSession\(COMPANION_SESSION_ID\)/)
  })
})

describe('a pick made before the slip page loads (run 20: the run went into the old thread)', () => {
  /** The pill mounted in a slip page with no DOM: what the browser had stored, and what the host says was picked. */
  async function slip(stored, picked) {
    const node = () => ({ addEventListener() {}, setAttribute() {}, contains: () => false, hidden: true, textContent: '' })
    vi.stubGlobal('document', { documentElement: { dataset: { overlay: '1' } }, addEventListener() {} })
    vi.stubGlobal('localStorage', { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v } })
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ sessions: [], picked }) }))
    const state = { sessionId: null }
    const { mountThreadPill } = await import('../shell/thread-pill.js')
    mountThreadPill({ state, el: node, $: node, COMPANION_SESSION_ID: 'companion', loadModels() {} })
    await new Promise((done) => setTimeout(done, 0))
    vi.unstubAllGlobals()
    return state.sessionId
  }

  it('joins the thread the host remembers, unless the owner chose one here after it', async () => {
    expect(sessions).toMatch(/picked = \{ id, at: Date\.now\(\) \}/)
    expect(sessions).toMatch(/return \{ sessions: rows, [^}]*picked \}/)
    expect(await slip({ 'gnomon.slip.thread': 'session-old' }, { id: 'session-run', at: Date.now() })).toBe('session-run')
    expect(await slip({ 'gnomon.slip.thread': 'session-mine', 'gnomon.slip.thread.at': String(Date.now()) }, { id: 'session-run', at: Date.now() - 60_000 })).toBe('session-mine')
    expect(await slip({ 'gnomon.slip.thread': 'session-old' }, null)).toBe('session-old')
  })

  it('a page that connects after the pick gets it from the live feed, and joins it only when it is newer (run 27)', async () => {
    // The feed was reconnecting when the runner picked: the broadcast was lost. Every connect sends the last pick again.
    expect(sessions).toMatch(/api\('\/gnomon\/api\/live'[\s\S]{0,1200}if \(last\.picked\) emit\(\{ type: 'thread', \.\.\.last\.picked \}\)/)
    const stored = { 'gnomon.slip.thread': 'gnomon-companion', 'gnomon.slip.thread.at': String(Date.now() - 60_000) }
    const node = () => ({ addEventListener() {}, setAttribute() {}, contains: () => false, hidden: true, textContent: '' })
    vi.stubGlobal('document', { documentElement: { dataset: { overlay: '1' } }, addEventListener() {} })
    vi.stubGlobal('localStorage', { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v } })
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ sessions: [], picked: null }) }))
    const state = { sessionId: null }
    const { mountThreadPill } = await import('../shell/thread-pill.js')
    const { joinPicked } = mountThreadPill({ state, el: node, $: node, COMPANION_SESSION_ID: 'companion', loadModels() {} })
    await new Promise((done) => setTimeout(done, 0))
    // The page loaded before the pick and the frame came on the reconnect: joined.
    joinPicked({ type: 'thread', id: 'session-run', at: Date.now() - 1_000 })
    expect(state.sessionId).toBe('session-run')
    // The owner then chose a thread here; the same pick sent again on the next reconnect leaves it.
    stored['gnomon.slip.thread.at'] = String(Date.now())
    state.sessionId = 'session-mine'
    joinPicked({ type: 'thread', id: 'session-run', at: Date.now() - 1_000 })
    expect(state.sessionId).toBe('session-mine')
    vi.unstubAllGlobals()
  })

  it('and the boot, which opens the companion, gives the slip its thread back', () => {
    expect(app).toMatch(/const slipThread = document\.documentElement\.dataset\.overlay \? state\.sessionId : null\nopenSession\(COMPANION_SESSION_ID, \{ quiet: true \}\)[\s\S]{0,120}if \(slipThread\) \{\n  state\.sessionId = slipThread/)
  })
})

describe('the slip is one row: the thread, the field, the readout, one control (Set 3 R1)', () => {
  const css = readFileSync(new URL('../shell/overlay.css', import.meta.url), 'utf8')

  it('gives the field a line of its own, with the thread in the row under it and no pills row', () => {
    expect(overlay).toMatch(/const row = el\('div', \{ class: 'ov-tick' \}, \[el\('div', \{ class: 'ov-one' \}, \[mark, field\]\), thread, traceBtn, ro, slot\]\)/)
    expect(css).toMatch(/\.ov-one \{ flex: 1 0 100%; min-width: 0;/)
    expect(css).toMatch(/\.ov-field #input \{ width: 100%; min-width: 0;/)
    expect(overlay).not.toMatch(/ov-tools|What I see/)
  })

  it('opens the threads upward with Alt+L, starts one with Alt+K, and carries the model for the thread as its last line', () => {
    expect(pill).toMatch(/event\.code !== 'KeyL' && event\.code !== 'KeyK'/)
    expect(pill).toMatch(/const model = document\.documentElement\.dataset\.overlay \? \$\('model'\) : null/)
    expect(pill).toMatch(/text: 'Model for this thread'/)
    expect(css).toMatch(/\.ov-slip #thread-menu \{ left: -1px; right: -1px; bottom: calc\(100% \+ 8px\);/)
  })
})

describe('the keyboard on a summon (the field took no keys when summoned by hand)', () => {
  const swift = readFileSync(new URL('../../../apps/macos/Sundial.swift', import.meta.url), 'utf8')

  it("the slip dims only for the owner's own hand: Gnomon's posted clicks and keys never step it back (run202: grey while Gnomon acted)", () => {
    expect(swift).toMatch(/event\.getIntegerValueField\(\.eventSourceStateID\) == Int64\(CGEventSourceStateID\.hidSystemState\.rawValue\)/)
    // Doc 32 item 1: a press meant for the slip that went through it while Gnomon clicked is pressed on the slip, not a step back.
    expect(swift).toMatch(/if !self\.caught\(event\), event\.type == \.leftMouseDown \|\| event\.type == \.rightMouseDown, event\.cgEvent\.map\(fromHardware\) \?\? true \{ self\.stepBack\(\) \}/)
    expect(swift).toMatch(/input\[input\["ownerOnly"\] as\? Bool == true \? "ownerKeyDownCount" : "keyDownCount"\]/)
    expect(swift).not.toMatch(/\(input\["keyDownCount"\] as\? Int \?\? 0\) > 0/)
  })

  it('the key opens the slip the same way for a tap and a hold, so the app cannot give the keyboard itself', () => {
    expect(swift).toMatch(/if !shown \{ summon\(toTalk: true\) \}/)
    expect(swift).toMatch(/message\.name == "focus" \{ panel\?\.makeKey\(\)/)
  })

  it('so the page asks for it, once a summon has heard no hold: that was a tap', () => {
    expect(overlay).toMatch(/const byHand = \(\) => \{\s+clearTimeout\(tap\.timer\)\s+tap\.timer = setTimeout\(\(\) => \{\s+window\.webkit\?\.messageHandlers\?\.focus\?\.postMessage\(true\)/)
    expect(overlay).toMatch(/input\?\.focus\(\{ preventScroll: true \}\)\s+byHand\(\)/)
    // The app says hold(true) 250 ms after key-down; the page must wait longer than that.
    expect(Number(overlay.match(/const TAP_MS = (\d+)/)[1])).toBeGreaterThan(250)
  })

  it('and a hold takes that back, so talking leaves the keys in the app below', () => {
    expect(overlay).toMatch(/const hold = \(on\) => \{\s+clearTimeout\(tap\.timer\)/)
  })
})
