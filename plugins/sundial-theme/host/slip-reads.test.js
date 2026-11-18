// The host half of the slip polish: the thread list's last answers (/gnomon/api/sessions) and the owner's hand, pushed as a
// `step` frame with `hand` (server.js) when owner-hand.js holds a step. Made-up values only; no live data folder is read or written.
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answerOf, mountSessions } from './api-sessions.js'
import { readPath } from './http.js'
import { mountBrief } from './routes-brief.js'
import { mountInstruments } from './routes-instruments.js'
import { createInitialState } from '../../../packages/kernel/src/initial-state.ts'
import { dayDoing } from '../../../packages/kernel/src/read/doing.ts'

/** The log the Ledger reads, for this file only: made-up rows, never a database (the audit queries answer empty). */
const DB_ROWS = vi.hoisted(() => [])
const REGISTERED = []
vi.mock('@sundial/db/index.js', async (original) => ({
  ...(await original()),
  getAllSignalsInRange: async () => DB_ROWS,
  getLlmAuditOverview: async () => ({ summary: { calls: 0, estimatedCostUsd: 0 }, byPurpose: [], latencyHistogram: [], failureReasons: [], unpricedRemoteModels: [] }),
  getLlmAuditByModel: async () => [],
  getLlmAuditDaily: async () => [],
  getRecentLlmAudit: async () => [],
  getLostAnswers: async () => [],
}))

describe("the thread list's last answer (/gnomon/api/sessions)", () => {
  it("answerOf: the newest turn that answered, its first words on one line, cut at a word; null when none did", () => {
    expect(answerOf(undefined)).toBeNull()
    expect(answerOf([{ turn: 1, prompt: 'rename it', response: '' }])).toBeNull()
    expect(answerOf([{ turn: 1, response: 'Old answer.' }, { turn: 2, response: '**Renamed** `notes.txt`\nto notes-old.txt in Finder.' }, { turn: 3, response: '' }])).toBe('Renamed notes.txt to notes-old.txt in Finder.')
    const long = answerOf([{ turn: 1, response: 'The test on BOX-484 is green: 14 passed, 0 failed, and the puzzlebox-studio export step took 38 s on the second run.' }])
    expect(long.length).toBeLessThanOrEqual(81)
    expect(long).toBe('The test on BOX-484 is green: 14 passed, 0 failed, and the puzzlebox-studio…')
  })

  it('the view carries it per thread from the listing cache alone, behind the guard, and never reads a log for it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slip-sessions-'))
    const read = []
    const registered = []
    const outline = [{ turn: 1, seq: 4, prompt: 'run the test', response: 'The test on BOX-484 is green: 14 passed.' }]
    const ctx = {
      effect: (fn) => fn(),
      on: () => () => {},
      connection: {},
      webServer: { register: (r) => registered.push(r) },
      sessionQuery: {
        listSessions: async () => [{ header: { id: 'session-box', createdAt: 2 }, live: false }, { header: { id: 'session-mira', createdAt: 1 }, live: false }],
        readTitleSnapshots: async (ids) => ids.map((sessionId) => ({ status: 'fulfilled', sessionId, value: { title: { title: 'Mira’s deck notes' } } })),
        readSession: async (id) => (read.push(id), null),
      },
      sessionProjectionCache: { cachedSnapshot: (header) => (header.id === 'session-box' ? { values: { title: 'BOX-484 test', sessionListMetadata: { lastPromptAt: '2026-11-15T10:30:00.000Z' }, turnOutline: outline } } : undefined) },
    }
    try {
      mountSessions(ctx, { api: () => {}, home, threadModel: () => null, selection: () => ({ model: null }) })
      const body = await readPath('/gnomon/api/sessions')
      expect(body.sessions.map((r) => [r.id, r.title, r.answer])).toEqual([['session-box', 'BOX-484 test', 'The test on BOX-484 is green: 14 passed.'], ['session-mira', 'Mira’s deck notes', null]])
      expect(read).toEqual([])
      // Registered behind the fence like every view (guard.js wraps the handler).
      const route = registered.find((r) => r.path === '/gnomon/api/sessions')
      expect(route?.kind).toBe('exact')
      const res = { writeHead() {}, end() {} }
      let status = 0
      res.writeHead = (s) => (status = s)
      await route.handler({ headers: {}, url: '/gnomon/api/sessions', socket: {} }, res)
      expect([401, 403]).toContain(status)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('an ask closes everywhere, and a dead one is never offered as live', () => {
  it('an open ask with no live call (a restart) goes out marked dead; a live one does not', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slip-asks-'))
    const at = new Date().toISOString()
    const open = [{ id: 'approval-live', sessionId: 'session-box', tool: 'screen_act', callId: 'c1', kind: 'send', line: 'Press "Send" in Zen', at }, { id: 'approval-dead', sessionId: 'session-box', tool: 'screen_act', callId: 'c2', kind: 'send', line: 'Press "Send" in Zen', at }]
    const ctx = { effect: (fn) => fn(), on: () => () => {}, connection: {}, webServer: { register: () => {} }, gnomonKernel: { getState: () => ({ approvals: { open } }) }, sessionQuery: { listSessions: async () => [] }, sessionProjectionCache: { cachedSnapshot: () => undefined } }
    try {
      mountSessions(ctx, { api: () => {}, home, threadModel: () => null, selection: () => ({ model: null }), pending: new Map([['approval-live', { settle() {}, reason: 'Gnomon: this sends a mail' }]]) })
      const { open: frames } = await readPath('/gnomon/api/approvals?session=session-box')
      expect(frames.map((f) => [f.id, f.dead === true])).toEqual([['approval-live', false], ['approval-dead', true]])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a close goes to the session\'s streams and the live channel; every page settles it there; a dead ask has no `_ask`', () => {
    const server = readFileSync(new URL('./server.js', import.meta.url), 'utf8')
    const sessions = readFileSync(new URL('./api-sessions.js', import.meta.url), 'utf8')
    const app = readFileSync(new URL('../shell/app.js', import.meta.url), 'utf8')
    expect(server).toMatch(/for \(const send of \[\(frame\) => push\(sessionId, frame\), broadcast\]\) send\(\{ type: 'approval-closed', id, outcome \}\)/)
    expect(sessions).toMatch(/for \(const send of \[\(frame\) => push\(ask\.sessionId, frame\), broadcast\]\) send\(\{ type: 'approval-closed', id, outcome, ran: false \}\)/)
    expect(app).toMatch(/function openLive\(\) \{[\s\S]{0,400}case 'approval-closed':[^\n]*\n\s+settleApproval\(frame\)/)
    expect(app).toMatch(/card\._ask = frame\.dead \? undefined : \{/)
  })
})

describe("the owner's hand is pushed, not polled", () => {
  it('server.js pushes the hold as a step frame with `hand`; app.js marks the running screen_act row; no hand view is left to poll', () => {
    const server = readFileSync(new URL('./server.js', import.meta.url), 'utf8')
    const app = readFileSync(new URL('../shell/app.js', import.meta.url), 'utf8')
    const routes = readFileSync(new URL('./routes-instruments.js', import.meta.url), 'utf8')
    expect(server).toMatch(/ctx\.on\('gnomon\/hand', \(\{ session, held \} = \{\}\) => typeof session === 'string' && push\(session, \{ type: 'step', hand: held === true \}\)\)/)
    expect(app).toMatch(/case 'step': \{[\s\S]{0,500}frame\.line \? Object\.assign\(row\.dataset, [\s\S]{0,120}: row\.toggleAttribute\('data-hand', frame\.hand === true\)/)
    expect(routes).not.toMatch(/\/gnomon\/api\/hand/)
    expect(existsSync(new URL('./read-hand.js', import.meta.url))).toBe(false)
  })
})

describe("Set 4 R2: the evening line is the Ledger's own day line, and the Ledger answers for one thread", () => {
  const state = { ...createInitialState('t'), rigSessions: { 'session-rig': '2026-11-16T09:00:00.000Z' } }
  const row = (signalType, eventType, data) => ({ signalType, eventType, data })
  const rows = [
    row('screen', 'step', { session: 'session-box', processName: 'Finder' }),
    row('screen', 'step', { session: 'session-box', processName: 'TextEdit' }),
    row('approval', 'asked', { sessionId: 'session-box' }),
    row('approval', 'answered', { sessionId: 'session-box', by: 'owner', answer: 'allowed-once' }),
    row('screen', 'step', { session: 'session-rig', processName: 'Calculator' }),
    row('screen', 'step', { session: 'session-rig', processName: 'TextEdit' }),
    row('approval', 'asked', { sessionId: 'session-rig' }),
    row('approval', 'answered', { sessionId: 'session-rig', by: 'rig', answer: 'allowed-once' }),
  ]
  const OWNER = 'Gnomon did 2 steps in 2 apps today, asked 1 time, you said yes 1.'
  const ctx = () => ({ effect: (fn) => fn(), connection: {}, webServer: { register: (r) => REGISTERED.push(r) }, gnomonKernel: { getState: () => state } })

  it("/gnomon/summon carries `day`: the owner's day only, the Ledger's own line, whatever thread is named", async () => {
    vi.stubEnv('SUNDIAL_HOME', mkdtempSync(join(tmpdir(), 'slip-day-')))
    try {
      mountBrief(ctx(), async () => rows)
      const summon = await readPath('/gnomon/summon?id=s1')
      expect(summon.day).toBe(OWNER)
      expect(summon.day).toBe(dayDoing(state, rows).line)
      // A rig chat named, as an old slip page might: still the owner's view, never the rig's.
      expect((await readPath('/gnomon/summon?id=s1&session=session-rig')).day).toBe(OWNER)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("/gnomon/ledger?session=<id>: that chat's counts in didToday.session, a rig chat's too; the owner's view unchanged; behind the guard", async () => {
    vi.stubEnv('SUNDIAL_HOME', mkdtempSync(join(tmpdir(), 'slip-ledger-')))
    DB_ROWS.splice(0, DB_ROWS.length, ...rows)
    try {
      mountInstruments(ctx())
      const plain = await readPath('/gnomon/ledger')
      expect(plain.didToday).toEqual({ steps: 2, apps: 2, asked: 1, yes: 1, line: OWNER })
      const rig = await readPath('/gnomon/ledger?session=session-rig')
      expect(rig.didToday).toEqual({ steps: 2, apps: 2, asked: 1, yes: 1, line: OWNER, session: { id: 'session-rig', steps: 2, apps: 2, asked: 1, yes: 1 } })
      expect((await readPath('/gnomon/ledger?session=session-box')).didToday.session).toEqual({ id: 'session-box', steps: 2, apps: 2, asked: 1, yes: 1 })
      const route = REGISTERED.find((r) => r.path === '/gnomon/ledger')
      let status = 0
      await route.handler({ headers: {}, url: '/gnomon/ledger?session=session-rig', socket: {} }, { writeHead: (s) => (status = s), end() {} })
      expect([401, 403]).toContain(status)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
