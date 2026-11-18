// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { bindCompare, bindGoals, bindLedger, bindPeople, bindPrs, bindThreads, bindWeek, bindWhere } from './bind.js'
import { checkSpec } from './spec.js'
import { fallbackSteps } from './storyboard.js'
import { build, createManager, dateOf, guessView, route } from './orchestrate.js'
import { readView, VIEWS } from './views.js'
import { changesSince, nodusNode, rebind } from './card.js'
import { drawBars, drawGraph, drawTable, fitted, GRAPH_MIN, layoutBars, layoutGraph } from './render-rows.js'
import { layoutTimeline } from './layout.js'
import { drawTimeline } from './render-timeline.js'
import { bindDay } from './bind.js'
import { DAY } from './fixture.test-data.js'

// Made-up rows in the shapes the tools answer.
const YESTERDAY = { ...DAY, date: '2026-03-08', projects: [{ name: 'puzzlebox-studio', minutes: 60 }, { name: 'tidewater', minutes: 120 }], noProjectMin: 30, meetings: [], breaks: [], coverage: { ...DAY.coverage, trackedMin: 210 } }
const LEDGER = { from: '2026-03-03', to: '2026-03-09', days: 7, rows: [{ key: 'intent', calls: 600, costUsd: 7.8, failed: 4 }, { key: 'judge', calls: 610, costUsd: 0.03 }, { key: 'visualize', calls: 2, costUsd: 0.05 }] }
const OPEN = { total: 3, commitments: [{ name: 'box-484', projectName: 'puzzlebox-studio', activeDays: 5, lastTouchedAt: '2026-03-08T10:00:00Z', promise: { counterparty: 'Mira Bakker' } }, { name: 'tide-fix', projectName: 'tidewater', activeDays: 1, lastTouchedAt: '2026-03-07T10:00:00Z' }, { name: 'box-490', projectName: 'puzzlebox-studio', activeDays: 2, lastTouchedAt: '2026-03-09T10:00:00Z' }] }
const GOALS = { goals: [{ goal: 'Ship the studio', state: 'doing', quietDays: 3, targetDate: null }, { goal: 'Learn the cello', state: 'open', quietDays: 40, targetDate: '2026-12-01' }, { goal: 'Old thing', state: 'done', quietDays: 90 }] }
const PRS = { open: 2, prs: [{ repo: 'acme/puzzlebox-studio', number: 485, title: 'BOX-485 keep the hint ratio', branch: 'fix/BOX-485', base: 'develop', state: 'OPEN', review: 'pending', checks: 'failure', additions: 66, deletions: 10, files: 5, openedAt: '2026-03-09T08:00:00Z', lastSeen: '2026-03-09T10:00:00Z', url: 'https://github.com/acme/puzzlebox-studio/pull/485' }, { repo: 'acme/tidewater', number: 12, title: 'Tide tables', branch: 'feat/tides', base: 'main', state: 'DRAFT', review: null, checks: null, additions: null, deletions: null, files: null, openedAt: '2026-03-05T08:00:00Z', lastSeen: '2026-03-09T10:00:00Z', url: null }] }
const PEOPLE = [{ name: 'Mira Bakker', id: 'person:mira-bakker', named: true, factCount: 6, metWith: 4 }, { name: null, id: 'person:person-0000000000', named: false, factCount: 1, metWith: 1 }, { name: 'Pat Doe', id: 'person:pat-doe', named: true, factCount: 1, metWith: 1 }]

const walked = (skeleton) => checkSpec({ ...skeleton, steps: fallbackSteps(skeleton) })
const reader = (map) => vi.fn(async (tool, args) => (typeof map[tool] === 'function' ? map[tool](args) : map[tool]))
const dayRead = reader({ gnomon_today_summary: (a) => (a.date === '2026-03-08' ? YESTERDAY : DAY), gnomon_llm_ledger: LEDGER, gnomon_open_commitments: OPEN, gnomon_goals: GOALS, gnomon_people: PEOPLE })

describe('the binders, each a form the record’s shape asks for', () => {
  it('every one of them binds a spec the checker passes with the walk from its own numbers', () => {
    const all = [bindWhere(DAY), bindCompare(DAY, YESTERDAY), bindWeek([YESTERDAY, DAY]), bindLedger(LEDGER), bindThreads(OPEN), bindGoals(GOALS), bindPeople(PEOPLE), bindPrs(PRS, Date.parse('2026-03-09T12:00:00Z'))]
    for (const s of all) {
      const out = walked(s)
      expect(out.problems, s.view).toEqual([])
      expect(out.spec.source.view).toBe(s.view)
    }
  })

  it('where: minutes per place, the most first, each project a door to its entity', () => {
    const s = bindWhere(DAY)
    expect(s.lanes.map((l) => [l.id, l.value])).toEqual([['p:puzzlebox-studio', 140], ['elsewhere', 117], ['meetings', 75], ['p:tidewater', 55], ['away', 35]])
    expect(s.lanes[0].door).toBe('entity:puzzlebox-studio')
  })

  it('compare: the day and the one before on every row, and a walk that names what grew and what shrank', () => {
    const s = bindCompare(DAY, YESTERDAY)
    expect(s.lanes.find((l) => l.id === 'p:tidewater')).toMatchObject({ value: 55, then: 120 })
    const says = fallbackSteps(s).map((x) => x.say).join(' ')
    expect(says).toMatch(/puzzlebox-studio led Monday 9 March, 2 h 20 min against 1 h 0 min on Sunday 8 March/)
    expect(says).toMatch(/tidewater shrank the most, from 2 h 0 min to 55 min/)
  })

  it('ledger: calls by purpose; graph: threads under their projects, with whoever a promise ties to them', () => {
    expect(bindLedger(LEDGER).lanes.map((l) => [l.label, l.value])).toEqual([['intent', 7.8], ['visualize', 0.05], ['judge', 0.03]])
    expect(fallbackSteps(bindLedger(LEDGER))[0].say).toBe('intent took the most, $7.80 of $7.88.')
    const g = bindThreads(OPEN)
    expect(g.links).toContainEqual({ from: 'p:puzzlebox-studio', to: 'c:box-484' })
    expect(g.links).toContainEqual({ from: 'c:box-484', to: 'w:mira-bakker' })
    expect(fallbackSteps(g)[0].say).toBe('puzzlebox-studio holds 2 of your 3 open threads.')
  })

  it('pull requests: one row each, with branch into base, age, size and where it stands', () => {
    const t = bindPrs(PRS, Date.parse('2026-03-09T12:00:00Z'))
    expect(t.title).toBe('2 open pull requests')
    expect(t.lanes.map((l) => [l.label, ...l.cells])).toEqual([
      ['puzzlebox-studio #485 BOX-485 keep the hint ratio', 'fix/BOX-485 → develop', '4 h ago', '+66 −10, 5 files', 'awaiting review, checks red'],
      ['tidewater #12 Tide tables', 'feat/tides → main', '4 d ago', '', 'draft'],
    ])
    expect(t.lanes[0]).toMatchObject({ value: 76, unit: 'lines' })
    expect(bindPrs({ prs: [] })).toBeNull()
    expect(guessView('how many pr’s do we have open right now?')).toBe('prs')
  })

  it('tables: only the goals still alive, and never an unnamed attendee by their hash', () => {
    expect(bindGoals(GOALS).lanes.map((l) => l.label)).toEqual(['Ship the studio', 'Learn the cello'])
    expect(bindPeople(PEOPLE).lanes.map((l) => l.label)).toEqual(['Mira Bakker', 'Pat Doe'])
    // The registry's own shape: a list with a status sentence and a since.
    const listed = bindGoals([{ goal: 'Ship the studio', status: 'open, alongside the day job', since: '2026-02-01T10:00:00Z', otherFacts: ['targetDate 2026-06-01'] }, { goal: 'Old thing', status: 'done' }, { goal: 'Learn the cello', status: 'doing', since: '2026-01-05T10:00:00Z' }])
    expect(listed.lanes.map((l) => [l.label, ...l.cells])).toEqual([['Learn the cello', 'doing', '2026-01-05', ''], ['Ship the studio', 'open', '2026-02-01', '2026-06-01']])
    expect(walked(listed).problems).toEqual([])
  })

  it('the week reads its seven days in parallel, oldest first', async () => {
    const read = reader({ gnomon_today_summary: (a) => ({ ...DAY, date: a.date ?? '2026-03-09' }) })
    const s = await readView('week', {}, read)
    expect(s.lanes.map((l) => l.id)).toEqual(['d:2026-03-03', 'd:2026-03-04', 'd:2026-03-05', 'd:2026-03-06', 'd:2026-03-07', 'd:2026-03-08', 'd:2026-03-09'])
    expect(s.lanes[0].door).toBe('day:2026-03-03')
    expect(read.mock.calls.every((c) => c[1].limit === 1)).toBe(true)
  })
})

describe('the manager', () => {
  it('reads the day an ask names, and today when it names none', () => {
    expect(dateOf('how was yesterday', '2026-03-09')).toBe('2026-03-08')
    expect(dateOf('show me 2026-02-01', '2026-03-09')).toBe('2026-02-01')
    expect(dateOf('what about friday', '2026-03-09')).toBe('2026-03-06')
    expect(dateOf('my day', '2026-03-09')).toBeUndefined()
    expect(dateOf('compare today with yesterday', '2026-03-09')).toBeUndefined()
  })

  it('without a judge, still lands an explicit ask on a sensible view', () => {
    expect(guessView('compare today with yesterday')).toBe('compare')
    expect(guessView('what did the thinking cost this week')).toBe('week')
    expect(guessView('what is my model spend')).toBe('ledger')
    expect(guessView('how did it go')).toBe('day')
  })

  it('routes by Jev’s typed choice over the views, and says words when no figure helps', async () => {
    const judge = vi.fn(async ({ questions }) => ({ view: { choice: Object.keys(questions.view.criteria).includes('threads') ? 'threads' : 'words', confidence: 0.8 } }))
    expect(await route('what am I in the middle of', judge)).toMatchObject({ view: 'threads', p: 0.8 })
    expect((await route('x', async () => ({ view: { choice: 'threads', confidence: 0.29, probabilities: { threads: 0.29, words: 0.05 } } }))).words).toBe(0.05)
    expect(judge.mock.calls[0][0].set).toBe('nodus.route.v1')
    expect(Object.keys(judge.mock.calls[0][0].questions.view.criteria)).toEqual(['words', ...Object.keys(VIEWS), 'scene_system', 'scene_orbital', 'scene_fluid', 'scene_mechanism', 'scene_object'])
    expect(await route('hi', async () => ({ view: { choice: 'words', confidence: 0.9 } }))).toEqual({ view: null, p: 0.9, words: 0.9 })
    expect(await route('anything', null)).toBeNull()
  })

  it('builds a figure asked for twice once: the gate and the tool share one flight', async () => {
    const complete = vi.fn(async () => null)
    const m = createManager({ read: dayRead, complete }, { today: () => '2026-03-09' })
    const [a, b, c] = await Promise.all([m.draw({ ask: 'my day', view: 'where' }), m.draw({ ask: 'where did my time go', view: 'where' }), m.draw({ ask: 'my day', view: 'where', date: '2026-03-09' })])
    expect(a).toBe(b)
    expect(c).toBe(a)
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('times every stage, and falls through a read that hangs to a retry', async () => {
    let n = 0
    const read = async (tool, args) => (n++ === 0 ? new Promise(() => {}) : dayRead(tool, args))
    vi.useFakeTimers()
    const out = build({ view: 'where' }, { read })
    await vi.advanceTimersByTimeAsync(21_000)
    vi.useRealTimers()
    const done = await out
    expect(done.ok).toBe(true)
    expect(Object.keys(done.spec.by.ms)).toEqual(expect.arrayContaining(['read', 'storyboard', 'total']))
  })

  it('hands the library’s walks for a like ask to the storyboard, as voice and order only', async () => {
    const complete = vi.fn(async () => null)
    await build({ ask: 'where did my time go', view: 'where' }, { read: dayRead, complete, examples: async () => [{ ask: 'where did the hours go', steps: ['Most of it went to puzzlebox-studio.'] }] })
    expect(complete.mock.calls[0][0][1].content).toMatch(/Walks that worked for like asks.*"where did the hours go": Most of it went to puzzlebox-studio\./s)
  })
})

describe('the renderers that are not on time', () => {
  it('bars keep every row on its own pitch, so labels never meet, and scale the longest to the plot', () => {
    const L = layoutBars(walked(bindCompare(DAY, YESTERDAY)).spec)
    const ys = L.rows.map((r) => r.y)
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(30)
    expect(Math.max(...L.rows.map((r) => Math.max(r.w, r.then ?? 0)))).toBeCloseTo(L.x1 - L.x0)
  })

  it('a comparison names its two days in the legend, from the facts the check keeps', () => {
    const f = drawBars(walked(bindCompare(DAY, YESTERDAY)).spec)
    expect([...f.node.querySelectorAll('.nd-hour')].map((t) => t.textContent)).toEqual(['Monday 9 March', 'Sunday 8 March'])
  })

  it('bars light what a step names and keep every colour a class', () => {
    const spec = walked(bindWhere(DAY)).spec
    const f = drawBars(spec)
    f.focus(new Set(['p:tidewater']))
    expect([...f.node.querySelectorAll('.nd-hot')].every((n) => n.getAttribute('data-id') === 'p:tidewater')).toBe(true)
    expect(f.node.querySelectorAll('[data-explore]')).toHaveLength(2)
    expect(f.node.outerHTML).not.toMatch(/fill="#|stroke="#|style=/)
  })

  it('the graph stands projects, threads and people in three columns and lights a node’s wires', () => {
    const spec = walked(bindThreads(OPEN)).spec
    expect([...new Set(layoutGraph(spec).nodes.map((n) => `${n.role}:${n.col}`))].sort()).toEqual(['commitment:1', 'person:2', 'project:0'])
    const f = drawGraph(spec)
    f.focus(['w:mira-bakker'])
    expect(f.node.querySelectorAll('.nd-link.nd-hot')).toHaveLength(1)
  })

  it('lays out at the width it is given: narrow bars put the label over its bar, a narrow graph keeps its columns and scrolls, a narrow day labels fewer hours', () => {
    const spec = walked(bindWhere(DAY)).spec
    const wide = layoutBars(spec, { width: 1080 })
    const dock = layoutBars(spec, { width: 380 })
    expect(wide.narrow).toBe(false)
    expect(wide.x0).toBeGreaterThan(100)
    expect(dock.narrow).toBe(true)
    expect(dock.x0).toBe(0)
    expect(dock.label).toBe(380)
    for (const r of dock.rows) expect(r.lift).toBeGreaterThanOrEqual(16)
    // The longest bar and its value fit the dock.
    expect(dock.x1 + 96).toBeLessThanOrEqual(380)
    expect(layoutGraph(walked(bindThreads(OPEN)).spec, { width: 380 }).width).toBe(GRAPH_MIN)
    const day = checkSpec({ ...bindDay(DAY), steps: fallbackSteps(bindDay(DAY)) }).spec
    const narrowDay = layoutTimeline(day, { width: 380 })
    const majors = narrowDay.ticks.filter((t) => t.major).map((t) => t.x)
    for (let i = 1; i < majors.length; i++) expect(majors[i] - majors[i - 1]).toBeGreaterThanOrEqual(48)
    expect(narrowDay.gutter).toBeLessThan(layoutTimeline(day).gutter)
  })

  it('a fitted figure is drawn at its host’s width, one unit a pixel, and keeps its focus when drawn again', () => {
    let seen = null
    const was = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(fn) {
        seen = fn
      }
      observe() {}
      disconnect() {}
    }
    try {
      const f = fitted(drawBars)(walked(bindWhere(DAY)).spec)
      f.focus(new Set(['p:tidewater']))
      seen([{ contentRect: { width: 380 } }])
      expect(f.node.querySelector('svg').getAttribute('viewBox')).toMatch(/^0 0 380 /)
      expect(f.node.querySelectorAll('.nd-hot').length).toBeGreaterThan(0)
      const g = fitted(drawGraph)(walked(bindThreads(OPEN)).spec)
      seen([{ contentRect: { width: 380 } }])
      expect(g.node.querySelector('svg').style.minWidth).toBe(`${GRAPH_MIN}px`)
    } finally {
      globalThis.ResizeObserver = was
    }
  })

  it('a table is rows to read, each name a door', () => {
    const t = drawTable(walked(bindGoals(GOALS)).spec)
    expect([...t.node.querySelectorAll('th')].map((x) => x.textContent)).toEqual(['Goal', 'State', 'Since', 'Target'])
    expect(t.node.querySelector('[data-explore]').getAttribute('data-explore')).toBe('entity:Ship the studio')
  })
})

describe('the live lens', () => {
  const where = () => walked(bindWhere(DAY)).spec

  it('keeps the walk over fresh rows while what it points at is still there', () => {
    const spec = where()
    const fresh = bindWhere({ ...DAY, projects: [{ name: 'puzzlebox-studio', minutes: 200 }] })
    const next = rebind(spec, fresh)
    expect(next.lanes.find((l) => l.id === 'p:puzzlebox-studio').value).toBe(200)
    expect(next.steps.every((s) => s.focus.every((id) => next.lanes.some((l) => l.id === id)))).toBe(true)
  })

  it('says what changed since the owner last looked, the biggest move first', () => {
    const before = where()
    const seen = { at: Date.parse('2026-03-09T10:00:00Z'), lanes: Object.fromEntries(before.lanes.map((l) => [l.id, l.value])), parts: [] }
    const after = rebind(before, bindWhere({ ...DAY, projects: [{ name: 'puzzlebox-studio', minutes: 180 }, { name: 'tidewater', minutes: 60 }] }))
    expect(changesSince(seen, after)).toMatch(/: puzzlebox-studio \+40 min, tidewater \+5 min\.$/)
    expect(changesSince(seen, before)).toBeNull()
    expect(changesSince(null, after)).toBeNull()
  })

  it('a recipe off the shelf reads its rows and draws them; offline it says so and keeps what it has', async () => {
    const { lanes, parts, ...recipe } = where()
    const card = nodusNode({ ...recipe, lanes: [], parts: [] }, { read: dayRead })
    expect(card.querySelector('.reading').textContent).toMatch(/Reading the record/)
    await vi.waitFor(() => expect(card.querySelectorAll('.nd-row')).toHaveLength(lanes.length))
    const down = nodusNode(where(), { read: async () => { throw new Error('offline') } })
    await down.refresh()
    expect(down.querySelector('.nodus-state').textContent).toBe('Offline · as drawn')
    expect(down.querySelectorAll('.nd-row')).toHaveLength(lanes.length)
  })

  it('walks with the arrow keys, and Home is the whole figure', () => {
    const card = nodusNode(where(), { read: dayRead })
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(card.dataset.step).toBe('1')
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(card.dataset.step).toBe('-1')
  })

  it('states what checked the walk', () => {
    const spec = where()
    const card = nodusNode({ ...spec, by: { ...spec.by, critic: { fits: 2.4 } } }, { read: dayRead })
    expect(card.querySelector('.nodus-state')).toMatchObject({ textContent: 'Checked 2.4 of 3' })
    expect(card.querySelector('.nodus-state').dataset.kind).toBe('verified')
  })
})
