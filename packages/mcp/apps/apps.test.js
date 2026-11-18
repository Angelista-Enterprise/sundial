// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge'
import { boot, clock, dataOf } from './lib.js'
import { draw as drawToday } from './today.js'
import { draw as drawFigure } from './figure.js'
import { draw as drawGoals } from './goals.js'
import { draw as drawNotices } from './notices.js'
import { columns, draw as drawLedger } from './ledger.js'
import { draw as drawAsk } from './ask.js'

/**
 * B2's app harness: each page's drawing over made-up data, and one page driven
 * end to end over the MCP Apps bridge (AppBridge on the host side, App in the
 * page), with the host's theme and variables arriving the way a real host sends
 * them. Made-up names only; never the owner's record. The bundle itself is
 * checked in src/mcp-apps.test.ts: esbuild cannot run under jsdom.
 */
const DAY = 86_400_000
const now = Date.parse('2026-10-05T10:30:00Z')

const dial = {
  kind: 'dial-slice',
  caption: 'dial-slice · today · 4h 47m observed of 10h 27m',
  openIn: 'today',
  date: '2026-10-05',
  fromHour: 6,
  toHour: 24,
  observedMin: 287,
  wallClockMin: 627,
  curve: [6, 8, 10, 12, 14, 16].map((hour, i) => ({ hour, score: [10, 60, 85, 40, 70, 30][i] })),
  meetings: [{ startHour: 11, endHour: 12 }],
  deepBlocks: [{ startHour: 9, endHour: 10.5 }],
  nowHour: 12.5,
}

const today = {
  date: '2026-10-05',
  timeZone: 'Europe/Amsterdam',
  brief: { lines: ['Yesterday: 3 commits on puzzlebox-studio (feat/mcp-surface), BOX-484 moved.', 'Today: standup 09:30 with Mira Bakker.'], lastWorkDay: '2026-10-04' },
  dial,
  today: { date: '2026-10-05', projects: [{ name: 'puzzlebox-studio', minutes: 125, commits: 3, confidence: 'observed' }, { name: 'tinwhistle', minutes: 40, commits: 0, confidence: 'observed' }], meetings: 1, coverage: { trackedMin: 287, wallClockMin: 627 } },
  rhythm: {
    today: '2026-10-05',
    nowMin: 390,
    dayStartsAt: 4,
    days: [
      { date: '2026-10-03', firstMin: 280, lastMin: 850, hours: new Array(24).fill(0).map((_, h) => (h > 4 && h < 15 ? 0.9 : 0)), observedHours: 9.1, switches: 12 },
      { date: '2026-10-04', firstMin: 300, lastMin: 1250, hours: new Array(24).fill(0.3), observedHours: 7.2, switches: 4 },
      { date: '2026-10-05', firstMin: 290, lastMin: 390, hours: new Array(24).fill(0).map((_, h) => (h < 7 ? 0.8 : 0)), observedHours: 2.1, switches: 2 },
    ],
  },
}

const goals = {
  quietAfterDays: 14,
  goals: [
    { id: 'goal:ship-the-mcp-surface', goal: 'Ship the MCP surface', state: 'doing', why: 'So any host can draw Today', targetDate: '2026-10-31', life: [{ at: new Date(now - 20 * DAY).toISOString(), kind: 'said' }, { at: new Date(now - 2 * DAY).toISOString(), kind: 'did' }], progress: { done: 1, total: 7 }, quietDays: 2, stale: false },
    { id: 'goal:learn-the-tin-whistle', goal: 'Learn the tin whistle', state: 'open', why: null, targetDate: null, life: [{ at: new Date(now - 40 * DAY).toISOString(), kind: 'said' }], progress: { done: 0, total: 0 }, quietDays: 40, stale: true },
    { id: 'goal:a-child', goal: 'Record the first tune', state: 'done', why: null, targetDate: null, life: [{ at: new Date(now - 10 * DAY).toISOString(), kind: 'said' }], progress: { done: 0, total: 0 }, quietDays: null, stale: false, child: true },
  ],
}

describe('the Today page', () => {
  it('draws the brief, the dial, the projects and one arc per day, newest first, with now on today only', () => {
    const node = drawToday(today)
    expect([...node.querySelectorAll('.surface-title')].map((n) => n.textContent)).toEqual(['Today', 'Dial', 'Projects', 'Rhythm'])
    expect(node.querySelectorAll('.app-line')).toHaveLength(2)
    expect(node.querySelector('.plate svg path')).not.toBeNull()
    expect([...node.querySelectorAll('.surface-because')].map((n) => n.textContent)).toEqual(['· 2026-10-05', '· today · 4h 47m observed of 10h 27m', '· 1 meeting', '· 3 days'])
    expect([...node.querySelectorAll('.app-row .app-num')].map((n) => n.textContent)).toEqual(['2h 05m · 3 commits', '40m'])
    const arcs = [...node.querySelectorAll('.arc-line')]
    expect(arcs.map((a) => a.querySelector('.arc-when').textContent)).toEqual(['Mon 5', 'Sun 4', 'Sat 3'])
    expect(arcs.map((a) => a.querySelectorAll('.arc-now').length)).toEqual([1, 0, 0])
    expect(arcs[1].querySelector('.arc-span-text').textContent).toBe('09:00–00:50')
  })

  it('says why when a part is missing instead of drawing a zero', () => {
    const node = drawToday({ date: '2026-10-05', brief: { none: 'No standup lines yet.' }, dial: { unavailable: 'Nothing was observed on 2026-10-05, so there is no shape to draw.' }, today: { projects: [] }, rhythm: { days: [] } })
    expect([...node.querySelectorAll('.surface-fail')].map((n) => n.textContent)).toEqual(['No standup lines yet.', 'Nothing was observed on 2026-10-05, so there is no shape to draw.', 'No project time observed.', 'No days observed in the window.'])
    expect(node.querySelector('svg')).toBeNull()
  })

  it('reads a waking-day minute as a clock time', () => {
    expect(clock(0)).toBe('04:00')
    expect(clock(1250)).toBe('00:50')
  })
})

describe('the figure page', () => {
  it('draws a figure with the web client\'s own renderer, and an unavailable one as its reason', () => {
    expect(drawFigure(dial).querySelector('svg')).not.toBeNull()
    const census = drawFigure({ kind: 'census', caption: 'census · the record', openIn: 'trust', rows: [{ label: 'moments', count: 412, total: null }, { label: 'facts verified', count: 7, total: 30 }] })
    expect(census.textContent).toContain('moments')
    expect(drawFigure({ unavailable: 'Nothing was observed.' }).querySelector('.surface-fail').textContent).toBe('Nothing was observed.')
  })
})

describe('the goals page', () => {
  it('draws every goal on one shared scale, live ones running to now', () => {
    const node = drawGoals(goals)
    expect(node.querySelector('.surface-because').textContent).toBe('· 2 open of 3')
    const rows = [...node.querySelectorAll('.app-row')]
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.querySelectorAll('.trail-now').length)).toEqual([1, 1, 0])
    expect(rows[0].querySelector('.app-state').textContent).toBe('doing · 1/7 steps · by 2026-10-31')
    expect(rows[1].querySelector('.app-state').textContent).toBe('open · quiet 40 days')
    expect(rows[2].querySelector('.app-name').textContent).toBe('Record the first tune')
    expect(rows[2].classList.contains('app-child')).toBe(true)
    expect(rows[0].querySelectorAll('.trail-said')).toHaveLength(1)
    expect(rows[0].querySelectorAll('.trail-did')).toHaveLength(1)
  })

  it('says so when there are none', () => {
    expect(drawGoals({ goals: [] }).querySelector('.surface-fail').textContent).toContain('No goals')
  })
})

describe('the page over the MCP Apps bridge', () => {
  it('takes the host\'s theme and variables, then draws the tool result it is sent', async () => {
    const [hostSide, appSide] = InMemoryTransport.createLinkedPair()
    const bridge = new AppBridge(null, { name: 'test-host', version: '0' }, {}, { hostContext: { theme: 'dark', styles: { variables: { '--color-text-primary': '#fafafa' } } } })
    await bridge.connect(hostSide)
    const root = document.createElement('main')
    document.body.append(root)
    const app = await boot('today', drawToday, { transport: appSide, root, autoResize: false })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.style.getPropertyValue('--color-text-primary')).toBe('#fafafa')

    await bridge.sendToolResult({ content: [{ type: 'text', text: 'Today · 2026-10-05' }], structuredContent: today })
    await new Promise((r) => setTimeout(r, 20))
    expect(root.querySelectorAll('.arc-line')).toHaveLength(3)

    await bridge.sendHostContextChange({ theme: 'light' })
    await new Promise((r) => setTimeout(r, 20))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    await app.close()
    await bridge.close()
  })

  it('falls back to JSON text when a result has no structuredContent, and to nothing when it is prose', () => {
    expect(dataOf({ content: [{ type: 'text', text: JSON.stringify({ goals: [] }) }] })).toEqual({ goals: [] })
    expect(dataOf({ content: [{ type: 'text', text: 'Today · nothing' }] })).toBeNull()
  })
})

const notices = {
  since: '2026-10-04T10:00:00.000Z',
  total: 3,
  notices: [
    { id: '01NOTICEAA', key: 'standup-soon', at: '2026-10-05T07:10:00.000Z', kind: 'meeting', text: 'Standup with Mira Bakker in 20 minutes; BOX-484 is still in review.', channel: 'banner', acts: ['banner'], seen: false },
    { id: '01NOTICEBB', key: 'late-night', at: '2026-10-04T23:40:00.000Z', kind: 'rhythm', text: 'Third late night this week.', channel: 'claude', acts: ['inject'], seen: true },
    { id: '01NOTICECC', key: 'failing-run', at: '2026-10-05T09:02:00.000Z', kind: 'build', text: 'The test run on puzzlebox-studio has failed twice.', channel: 'phone', acts: ['push'], seen: false },
  ],
}

const ledger = {
  groupBy: 'purpose', days: 7, from: '2026-09-29', to: '2026-10-05',
  rows: [
    { key: 'moment-judge', calls: 412, failed: 3, tokens: 1_204_000, cacheReadTokens: 900_000, billedOnFailureTokens: 9_000, costUsd: 1.9312, failedMs: 42_000 },
    { key: 'chat', calls: 38, failed: 0, tokens: 310_000, cacheReadTokens: 120_000, billedOnFailureTokens: 0, costUsd: 0.845, failedMs: 0 },
  ],
}

describe('the notices page', () => {
  it('lists newest first, and Seen asks the server to mark the notice through the host', async () => {
    const calls = []
    const app = { callServerTool: async (params) => (calls.push(params), { content: [] }) }
    const node = drawNotices(notices, app)
    expect(node.querySelector('.surface-because').textContent).toBe('· 3 delivered · 2 unseen')
    const rows = [...node.querySelectorAll('.app-notice')]
    expect(rows.map((r) => r.dataset.seen)).toEqual(['no', 'no', 'yes'])
    expect(rows[0].querySelector('.app-name').textContent).toContain('failed twice')
    expect(rows.map((r) => r.querySelectorAll('button.link').length)).toEqual([1, 1, 0])
    rows[0].querySelector('button.link').click()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([{ name: 'gnomon_notice_seen', arguments: { id: '01NOTICECC', surface: 'mcp-app' } }])
    expect(rows[0].dataset.seen).toBe('yes')
    expect(rows[0].querySelector('button.link')).toBeNull()
  })

  it('keeps the act when the host refused, and says so', async () => {
    const app = { callServerTool: async () => ({ isError: true, content: [] }) }
    const node = drawNotices(notices, app)
    const button = node.querySelector('button.link')
    button.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('Seen · try again')
    expect(node.querySelector('.app-notice').dataset.seen).toBe('no')
  })

  it('says so when nothing was delivered', () => {
    expect(drawNotices({ notices: [] }, {}).querySelector('.surface-fail').textContent).toBe('Nothing delivered in this window.')
  })
})

describe('the ledger page', () => {
  it('draws the rows as the web client\'s sortable grid, with the total in the head', () => {
    const node = drawLedger(ledger, { getHostContext: () => ({}) })
    expect(node.querySelector('.surface-because').textContent).toBe('· 2026-09-29 → 2026-10-05 · $2.78 at list price')
    expect([...node.querySelectorAll('table.grid th')].map((h) => h.textContent)).toEqual(columns('purpose').map((c) => c.label))
    expect([...node.querySelectorAll('table.grid th')][0].textContent).toBe('Purpose')
    const cells = [...node.querySelectorAll('tbody tr')[0].querySelectorAll('td')].map((c) => c.textContent)
    expect(cells).toEqual(['moment-judge', '412', '3', '1,204,000', '900,000', '9,000', '$1.93', '42.0s'])
    expect(node.querySelector('.surface-note').textContent).toContain('never a bill')
    expect(node.querySelector('button.link')).toBeNull()
  })

  it('offers Full screen only when the host has it', async () => {
    const asked = []
    const app = { getHostContext: () => ({ availableDisplayModes: ['inline', 'fullscreen'] }), requestDisplayMode: async (p) => (asked.push(p), { mode: 'fullscreen' }) }
    const node = drawLedger(ledger, app)
    node.querySelector('.surface-head button.link').click()
    expect(asked).toEqual([{ mode: 'fullscreen' }])
    expect(drawLedger({ rows: [] }, app).querySelector('.surface-fail').textContent).toBe('No model calls in this window.')
  })
})

describe('the ask page', () => {
  const open = { askId: 'ask-7', question: 'Who is the unnamed attendee of the design sync?', reason: 'They were in three meetings this month.', choices: ['Mira Bakker', 'someone else', 'skip'], waiting: false, ts: '2026-10-05T08:00:00.000Z' }

  it('offers each choice as an act, and one tap records the answer through the host', async () => {
    const calls = []
    const node = drawAsk({ open }, { callServerTool: async (p) => (calls.push(p), { content: [] }) })
    expect(node.querySelector('.app-question').textContent).toBe(open.question)
    expect([...node.querySelectorAll('.app-acts button')].map((b) => b.textContent)).toEqual(open.choices)
    node.querySelectorAll('.app-acts button')[0].click()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([{ name: 'gnomon_owner_answer', arguments: { askId: 'ask-7', answer: 'Mira Bakker' } }])
    expect(node.querySelector('.app-acts')).toBeNull()
    expect(node.textContent).toContain('You said "Mira Bakker"')
  })

  it('takes the owner\'s own words with Enter, and keeps the acts when the host refused', async () => {
    const calls = []
    const node = drawAsk({ open: { ...open, choices: [] } }, { callServerTool: async (p) => (calls.push(p), { isError: true, content: [] }) })
    expect(node.querySelector('.app-acts')).toBeNull()
    const input = node.querySelector('.app-input')
    input.value = 'Jonas from the studio'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(calls[0].arguments).toEqual({ askId: 'ask-7', answer: 'Jonas from the studio' })
    expect(node.querySelector('.app-free')).not.toBeNull()
    expect(node.querySelector('.app-free button').disabled).toBe(false)
  })

  it('says so when nothing is waiting', () => {
    expect(drawAsk({ open: null }, {}).querySelector('.surface-fail').textContent).toBe('Nothing is waiting on you right now.')
  })
})
