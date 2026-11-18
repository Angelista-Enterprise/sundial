// Set 2 R4 item 2: the owner's hand wins. No act goes while the owner's last key or click is under 2 s old; held past the wait, the
// chain stops without acting. A correction the owner sent after the call began stops it too. Made-up values only.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { HAND_MS, helperHandAt, ownerHand } from './owner-hand.js'
import { screenTools } from './screen-tools.js'

const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8'))
const ROW = lookForLog(LINE)

/** A clock that moves only when the hold waits. */
const clock = (t = Date.parse('2026-11-15T10:00:00.000Z')) => ({ now: () => t, wait: async (ms) => void (t += ms), at: (ms) => new Date(t + ms).toISOString() })

describe('ownerHand: the hold before one act', () => {
  it('quiet (no owner key, or one 2 s old) lets the act go at once', async () => {
    const c = clock()
    expect(await ownerHand(() => ({}), c)).toBeNull()
    expect(await ownerHand(() => ({ lifeEvent: { idle: { ownerHandAt: c.at(-HAND_MS) } } }), c)).toBeNull()
  })

  it('a key 0.5 s ago holds the act until 2 s after it, never sooner', async () => {
    const c = clock()
    const state = { lifeEvent: { idle: { ownerHandAt: c.at(-500) } } }
    const start = c.now()
    expect(await ownerHand(() => state, c)).toBeNull()
    expect(c.now() - start).toBeGreaterThanOrEqual(1500)
    expect(c.now() - Date.parse(state.lifeEvent.idle.ownerHandAt)).toBeGreaterThanOrEqual(HAND_MS)
  })

  it('an owner who keeps typing past the wait: paused, nothing acts', async () => {
    const c = clock()
    const getState = () => ({ lifeEvent: { idle: { ownerHandAt: c.at(0) } } })
    expect(await ownerHand(getState, c)).toEqual({ refused: expect.stringMatching(/the owner is using the Mac; paused/), reason: 'owner-hand' })
  })

  it('a correction in this chat after the call began stops it; one before it, or in another chat, does not', async () => {
    const c = clock()
    const since = c.now()
    const corrected = (at, session = 's1') => () => ({ task: { id: 't1', at: c.at(-60), session, corrected: { at, session, text: 'no, I meant Juniper, not Kestrel' } } })
    expect(await ownerHand(corrected(c.at(10)), { ...c, since, session: 's1' })).toEqual({ refused: expect.stringMatching(/the owner just said "no, I meant Juniper, not Kestrel"\. Nothing more was done: follow that over the earlier goal/), reason: 'corrected' })
    expect(await ownerHand(corrected(c.at(-10)), { ...c, since, session: 's1' })).toBeNull()
    expect(await ownerHand(corrected(c.at(10), 's2'), { ...c, since, session: 's1' })).toBeNull()
    // No call start known (an act from outside a screen_act call): no correction check, the hand check only.
    expect(await ownerHand(corrected(c.at(10)), { ...c, session: 's1' })).toBeNull()
  })

  it('says when it starts holding and when the hold ends, once each, and nothing when it never holds', async () => {
    const c = clock()
    const seen = []
    const onHold = (on) => seen.push(on)
    await ownerHand(() => ({}), { ...c, onHold })
    expect(seen, 'quiet: no hold, nothing said').toEqual([])
    await ownerHand(() => ({ lifeEvent: { idle: { ownerHandAt: c.at(-500) } } }), { ...c, onHold })
    expect(seen, 'held 1.5 s, then the act goes').toEqual([true, false])
    seen.length = 0
    expect((await ownerHand(() => ({ lifeEvent: { idle: { ownerHandAt: c.at(0) } } }), { ...c, onHold })).reason).toBe('owner-hand')
    expect(seen, 'held past the wait, then refused: the hold still ends').toEqual([true, false])
    seen.length = 0
    await ownerHand(() => ({ task: { corrected: { at: c.at(10), session: 's1', text: 'stop' } } }), { ...c, since: c.now(), session: 's1', onHold })
    expect(seen, 'a correction stops it before any hold').toEqual([])
  })
})

/** A fake Notes; `sent` keeps the wall time of each act sent, `rows` the `screen:step` rows. */
function tools(state, hand, onAct = () => {}, held = undefined) {
  const rows = []
  const sent = []
  const looks = { [ROW.id]: ROW }
  Object.assign(state, { config: { experiments: { screenAct: true } }, window: { active: { processName: 'Notes', windowTitle: 'Lunch Thursday', windowId: 'w1' } }, marks: { now: [], guideTally: {}, lastLook: { id: ROW.id, app: 'Notes', window: 'Lunch Thursday', n: 4 } } })
  const send = (command) => {
    if (command.type !== 'act') return
    sent.push(Date.now())
    onAct(sent.length)
    state.marks.lastAct = { id: command.id, outcome: 'performed' }
    const id = `look-after-${command.id}`
    looks[id] = { ...ROW, id, after: command.id }
    state.marks.lastLook = { id, after: command.id, app: 'Notes', n: 5 }
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(looks).findLast((row) => row[field] === id) ?? null
  const append = async (type, data) => void (type === 'screen:step' && rows.push(data))
  const [, , act] = screenTools(append, () => state, send, readRow, async () => [], { hand, held })
  return { act, rows, sent }
}
const chain = { app: 'Notes', goal: 'start a note', steps: [{ app: 'Notes', role: 'button', label: 'New Note', action: 'press' }, { action: 'key', value: 'cmd+c' }] }

describe('screen_act holds for the owner (no act within the quiet gap after an owner key)', () => {
  it('a key just now: the first act goes only after the gap, and the chain runs on', async () => {
    const state = { lifeEvent: { idle: { ownerHandAt: new Date().toISOString() } } }
    const t = tools(state, { quietMs: 80, waitMs: 1000 })
    await t.act.execute(chain)
    expect(t.sent).toHaveLength(2)
    expect(t.sent[0] - Date.parse(state.lifeEvent.idle.ownerHandAt)).toBeGreaterThanOrEqual(75)
  })

  it('the hold reaches the chat it runs in (fast.held), held then let go, before the act; no chat, nothing is said', async () => {
    const state = { lifeEvent: { idle: { ownerHandAt: new Date().toISOString() } } }
    const said = []
    const t = tools(state, { quietMs: 80, waitMs: 1000 }, (n) => said.push(`act ${n}`), (h) => said.push(h))
    await t.act.execute(chain, { agent: { session: { id: 'session-box' } } })
    expect(said.slice(0, 3)).toEqual([{ session: 'session-box', held: true }, { session: 'session-box', held: false }, 'act 1'])
    const quiet = []
    const u = tools({ lifeEvent: { idle: { ownerHandAt: new Date().toISOString() } } }, { quietMs: 80, waitMs: 1000 }, () => {}, (h) => quiet.push(h))
    await u.act.execute(chain)
    expect(quiet).toEqual([])
  })

  it('the owner types on: paused, no act sent, no step kept, the answer says why', async () => {
    const state = {}
    Object.defineProperty(state, 'lifeEvent', { get: () => ({ idle: { ownerHandAt: new Date().toISOString() } }), enumerable: true })
    const t = tools(state, { quietMs: 80, waitMs: 120 })
    await expect(t.act.execute(chain)).rejects.toThrow(/the owner is using the Mac; paused[\s\S]*Stopped at step 1/)
    expect(t.sent).toEqual([])
    expect(t.rows).toEqual([])
  })

  it('a correction folded mid-chain stops the steps after it and names the owner\'s words', async () => {
    const state = {}
    // The correction lands while step 1 runs: the fold's `task.corrected`, newer than the call.
    const t = tools(state, { quietMs: 80, waitMs: 120 }, (n) => {
      if (n === 1) state.task = { id: 't1', corrected: { at: new Date().toISOString(), session: '', text: 'no, I meant Juniper' } }
    })
    const three = { ...chain, steps: [...chain.steps, { action: 'key', value: 'cmd+v' }] }
    await expect(t.act.execute(three)).resolves.toMatch(/2\. .*refused: the owner just said "no, I meant Juniper"\. Nothing more was done[\s\S]*Stopped at step 2: step 3 did not run/)
    expect(t.sent).toHaveLength(1)
    expect(t.rows).toHaveLength(1)
  })
})

// Set 3 R5: the input helper's per-second file (macos-input-helper.swift). `lastKeyAt`/`lastClickAt` are hardware keys and
// clicks only; `keyDownCount` counts every key, Gnomon's posted ones too. The fold's ownerHandAt is empty in these cases: the
// ~10 s input row has not landed yet, so only the file can see the key.
const helperFile = () => join(mkdtempSync(join(tmpdir(), 'owner-hand-')), 'input-activity.json')
const writeHelper = (file, fields) => writeFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), windowMs: 1000, keyDownCount: 0, mouseClickCount: 0, mouseMoveCount: 0, scrollCount: 0, listenAccessGranted: true, tapActive: true, ownerKeyDownCount: 0, ownerClickCount: 0, ownerOnly: true, ...fields }))

describe('helperHandAt: the owner\'s last hardware key or click, from the helper\'s file', () => {
  it('the newer of the key and the click; null with no file, an older helper, or no hardware key yet', () => {
    const file = helperFile()
    expect(helperHandAt(file)).toBeNull()
    writeHelper(file, { lastKeyAt: '2026-11-15T10:00:01.000Z', lastClickAt: '2026-11-15T10:00:03.500Z' })
    expect(helperHandAt(file)).toBe('2026-11-15T10:00:03.500Z')
    writeHelper(file, { keyDownCount: 9 })
    expect(helperHandAt(file), 'Gnomon typed nine keys, the owner none').toBeNull()
    writeHelper(file, { ownerOnly: undefined, lastKeyAt: '2026-11-15T10:00:01.000Z' })
    expect(helperHandAt(file), 'an older helper: its fields are not trusted').toBeNull()
  })

  it('a hardware key 1 s ago in the file holds the act though the fold has not seen it; Gnomon\'s own keys never do', async () => {
    const c = clock()
    const file = helperFile()
    writeHelper(file, { ownerKeyDownCount: 1, keyDownCount: 1, lastKeyAt: c.at(-1000) })
    const start = c.now()
    expect(await ownerHand(() => ({}), { ...c, handAt: () => helperHandAt(file) })).toBeNull()
    expect(c.now() - start, 'held until 2 s after the key').toBeGreaterThanOrEqual(1000)
    writeHelper(file, { keyDownCount: 12, mouseClickCount: 3, lastKeyAt: c.at(-HAND_MS - 1) })
    const again = c.now()
    expect(await ownerHand(() => ({}), { ...c, handAt: () => helperHandAt(file) })).toBeNull()
    expect(c.now(), 'twelve posted keys and three posted clicks now, the owner\'s last key over 2 s ago: no hold').toBe(again)
  })
})

describe('the helper writes the owner\'s hand at once (run 202: two acts went in the first second of the hand)', () => {
  // The file was written once a second, so a step checked 0.4 s after the owner's first key read a file without it. A
  // hardware key or click now rewrites the file within 100 ms; counts-only, hardware-only, and no count is read twice.
  const swift = readFileSync(new URL('../../apps/daemon/src/daemon/macos-input-helper.swift', import.meta.url), 'utf8')

  it('a hardware key or click (never a posted one, never a move) asks for a rewrite, at most every 100 ms', () => {
    expect(swift).toMatch(/let hardware = isHardware\(event\)\n\s+counter\.record\(type: type, hardware: hardware\)\n\s+if hardware, type == \.keyDown \|\| type == \.leftMouseDown \|\| type == \.rightMouseDown \|\| type == \.otherMouseDown \{ handNow\(\) \}/)
    expect(swift).toMatch(/let handGap: TimeInterval = 0\.1\n/)
    expect(swift).toMatch(/func handNow\(\) \{\n\s+guard !handPending[\s\S]{0,200}if wait <= 0 \{ return writeHand\(\) \}\n\s+handPending = true\n\s+DispatchQueue\.main\.asyncAfter/)
  })

  it('the rewrite keeps the last window\'s counts and timestamp and changes only the hand times; the 1 s window still writes', () => {
    const hand = swift.slice(swift.indexOf('func writeHand()'), swift.indexOf('func save('))
    expect(hand).toMatch(/timestamp: window\.timestamp/)
    expect(hand).toMatch(/keyDownCount: window\.keyDownCount/)
    expect(hand).toMatch(/lastKeyAt: hand\.lastKeyAt/)
    expect(hand).not.toMatch(/snapshotAndReset/)
    expect(swift).toMatch(/lastWindow = payload\n\s+save\(payload, to: path\)/)
    expect(swift).toMatch(/Timer\.scheduledTimer\(withTimeInterval: TimeInterval\(windowMs\) \/ 1000\.0, repeats: true\) \{ _ in\n\s+writeJSON\(to: outputPath, windowMs: windowMs\)/)
    // Counts only: the hand rewrite reads no key code and no character.
    expect(swift).not.toMatch(/keyboardEventKeycode|keyboardGetUnicodeString/)
  })
})

describe('screen_act: the owner\'s hardware key stops the next step', () => {
  const run = (onAct) => {
    const file = helperFile()
    writeHelper(file, {})
    const t = tools({}, { quietMs: HAND_MS, waitMs: 120, handAt: () => helperHandAt(file) }, (n) => onAct(file, n))
    return t
  }

  it('a key on the keyboard during step 1: step 2 does not go, the answer says the owner is using the Mac', async () => {
    const t = run((file, n) => n === 1 && writeHelper(file, { keyDownCount: 1, ownerKeyDownCount: 1, lastKeyAt: new Date().toISOString() }))
    await expect(t.act.execute(chain)).resolves.toMatch(/2\. .*the owner is using the Mac; paused/)
    expect(t.sent).toHaveLength(1)
  })

  it('a click on the trackpad stops it the same way', async () => {
    const t = run((file, n) => n === 1 && writeHelper(file, { mouseClickCount: 1, ownerClickCount: 1, lastClickAt: new Date().toISOString() }))
    await expect(t.act.execute(chain)).resolves.toMatch(/2\. .*the owner is using the Mac; paused/)
    expect(t.sent).toHaveLength(1)
  })

  it('Gnomon\'s own posted keys (counted, never a hardware time) never stop it', async () => {
    const t = run((file, n) => n === 1 && writeHelper(file, { keyDownCount: 4, mouseClickCount: 1 }))
    await t.act.execute(chain)
    expect(t.sent).toHaveLength(2)
  })
})
