// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENGINE_TABS, PANEL_KEYS, answerDoor, briefLine, briefParts, dayPanel, heardInPassing, jobWords, resumeDetails, span, todayParts, whatItSaw } from './views.js'
import { INSTRUMENT_KEYS } from './cards.js'

describe('briefLine', () => {
  it('says the day in one sentence', () => {
    const line = briefLine({ date: '2026-09-15', observedMin: 214, projects: [{ name: 'a', minutes: 7 }, { name: 'b', minutes: 73 }], meetings: 1, noticed: 2 })
    expect(line).toBe('Tuesday. 3h 34m observed, most of it on b, 1 meeting. Gnomon noticed 2 things.')
    expect(briefLine({ date: '2026-09-15', observedMin: 0 })).toBe('Tuesday. Nothing observed yet.')
  })
})

describe('heardInPassing', () => {
  it('lists what was said to the list today, newest first, without interruptions or questions', () => {
    const row = (noticeKey, channel, kind = 'work-shelved', observation = `said ${noticeKey}`) => ({ noticeKey, channel, kind, observation })
    const said = [row('a', 'tonic'), row('b', 'phasic'), row('c', 'tonic', 'owner-question'), row('d', 'tonic'), row('e', 'tonic'), row('f', 'tonic'), row('g', 'tonic', 'x', null)]
    expect(heardInPassing({ said }).map((r) => r.noticeKey)).toEqual(['f', 'e', 'd'])
    expect(heardInPassing(null)).toEqual([])
    // The moment block draws a return line itself (U2-F8).
    expect(heardInPassing({ said: [row('r', 'tonic', 'return-from-break')] })).toEqual([])
  })
})

describe('resumeDetails', () => {
  it('says what the line left out, then the links (U2-F16 F20)', () => {
    const pieces = { leftFromAgent: true, intent: { text: 'Fixing the retry test' }, agent: { lastPrompt: 'why does it flake' }, unpushed: { ahead: 2, branch: 'main' } }
    const links = [{ piece: 'tab', label: 'Open it', href: 'https://example.test/' }]
    expect(resumeDetails({ pieces, links }).map((d) => d.label)).toEqual(['Before it: Fixing the retry test', 'You last asked it: “why does it flake”', '2 commits not pushed on main', 'Open it'])
    expect(resumeDetails(null)).toEqual([])
    // The use counts carry their n (U2-F36).
    const use = { pieces: { tab: { shown: 4, opened: 1 }, intent: { shown: 9, opened: 0 } }, lines: 9, followed: 5 }
    expect(resumeDetails({ pieces: {}, links }, use)[0].label).toBe('Opened so far: tab 1 of 4; back on the project within 10 min after 5 of 9 lines')
    // Back after days, the digest of the last lines on the project (U2-F38).
    expect(resumeDetails({ pieces: {}, digest: [{ at: '2026-01-03T09:00:00.000Z', what: 'Fixing the export' }] })[0].label).toMatch(/— Fixing the export$/)
  })
})

/** Two moments off the same day, in the shape `/gnomon/day` answers with. */
const day = {
  date: '2026-09-17',
  timeZone: 'Europe/Amsterdam',
  count: 2,
  moments: [
    {
      id: 'm1',
      startTime: '2026-09-17T17:00:00.000Z',
      endTime: '2026-09-17T17:30:00.000Z',
      durationMs: 1_800_000,
      durationMin: 30,
      activeMin: 20,
      processName: 'Code',
      projectId: '/x/sundial',
      intent: 'writing the day panel',
      data: { activeMs: 1_200_000, shellCommandCount: 12, spokenExcerpt: 'it goes into the memory', windowTitles: ['views.js'] },
    },
    {
      id: 'm2',
      startTime: '2026-09-17T19:00:00.000Z',
      endTime: '2026-09-17T19:10:00.000Z',
      durationMs: 600_000,
      durationMin: 10,
      activeMin: 0,
      processName: 'Arc',
      projectId: null,
      intent: null,
      data: { activeMs: 0, shellCommandCount: 4 },
    },
  ],
}

describe('whatItSaw', () => {
  it('answers what the day amounted to, not what was asked for', () => {
    // Labels are `[iconName, word]`; the word is what the owner reads.
    const rows = Object.fromEntries(whatItSaw(day).map(([label, value, hint]) => [label[1], [value, hint]]))
    expect(rows.Watched[0]).toBe('40m over 2 moments')
    expect(rows.Watched[1]).toBe('20m of it active')
    // The ratio the trust card promised and never showed on a day: one of the
    // two moments was logged and never read.
    expect(rows.Understood).toEqual(['1 of 2', '50%'])
    expect(rows.Where[0]).toBe('2 apps · 1 project')
    expect(rows.Commands[0]).toBe('16')
    expect(rows.Heard[0]).toBe('1 moment with speech')
  })

  it('says nothing rather than zero on an empty day', () => {
    const rows = Object.fromEntries(whatItSaw({ date: '2026-09-17', moments: [] }).map(([label, value]) => [label[1], value]))
    expect(rows.Watched).toBe('—')
    expect(rows.Understood).toBe('—')
    expect(rows.Commands).toBeUndefined()
  })
})

describe('the day table folds open', () => {
  const rowsOf = (nodes) => nodes.find((n) => n.querySelector?.('table.grid')).querySelectorAll('tbody tr')

  it('builds the moment detail on first open, not on render', () => {
    const rows = rowsOf(dayPanel(day))
    // Newest first, each summary row trailed by its own folded row.
    expect(rows.length).toBe(4)
    // Newest first, so m2 leads; m1 is the one with speech and commands.
    const [, , summary, fold] = rows
    expect(summary.classList.contains('grid-openable')).toBe(true)
    expect(fold.hidden).toBe(true)
    expect(fold.textContent).toBe('')

    summary.click()
    expect(fold.hidden).toBe(false)
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    // The fold ADDS. Everything the table has a column for is left out of it:
    // the clock, the duration, the focus word, the app, the project, the
    // intent. What is left is what has no column.
    const said = fold.textContent
    expect(fold.querySelector('.mb-sentence')).toBeNull()
    expect(said).not.toContain('Code')
    expect(said).not.toContain('shallow')
    expect(said).not.toContain('writing the day panel')
    expect(said).toContain('12 commands')
    expect(said).toContain('it goes into the memory')

    summary.click()
    expect(fold.hidden).toBe(true)
  })

  it('offers no fold on a row the record has nothing to add to', () => {
    const bare = { ...day.moments[1], data: {} }
    const rows = rowsOf(dayPanel({ ...day, moments: [bare], count: 1 }))
    expect(rows.length).toBe(1)
    expect(rows[0].classList.contains('grid-openable')).toBe(false)
    // But it keeps its place in the gutter: every row of a foldable table is
    // marked, so none of them steps out of the column.
    expect(rows[0].classList.contains('grid-row')).toBe(true)
    expect(rows[0].classList.contains('grid-quiet')).toBe(true)
    expect(rows[0].title).toBe('Nothing recorded beyond this row')
  })

  it('puts both ends of the moment in the one timestamp', () => {
    const [summary] = rowsOf(dayPanel(day))
    expect(summary.querySelector('td').textContent).toContain('–')
  })

  it('leaves a door inside the row alone', () => {
    const [summary, fold] = rowsOf(dayPanel(day))
    summary.querySelector('[data-explore]').click()
    expect(fold.hidden).toBe(true)
  })
})

describe('span', () => {
  it('says the marker once, on the end that settles it', () => {
    // toLocaleTimeString follows the runner's locale, so the shape is asserted
    // rather than the literal: whatever suffix the locale puts on the second
    // clock must not also sit on the first.
    const out = span('2026-09-17T09:17:00.000Z', '2026-09-17T09:48:00.000Z')
    const marker = out.split('–')[1].match(/\s\S+$/)?.[0]
    if (marker) expect(out.split('–')[0]).not.toContain(marker.trim())
    expect(out).toContain('–')
  })

  it('is one clock when the moment does not cross a minute, or never ended', () => {
    expect(span('2026-09-17T09:17:10.000Z', '2026-09-17T09:17:50.000Z')).not.toContain('–')
    expect(span('2026-09-17T09:17:10.000Z', null)).not.toContain('–')
  })
})

describe('the Engine room', () => {
  it('draws a panel for every tab past cost, and lists every panel as a tab', () => {
    // The catalog's routes, the drawn panels and the tab strip are three views
    // of one list; a tab added to one and not the others goes missing somewhere.
    expect(PANEL_KEYS.slice().sort()).toEqual(INSTRUMENT_KEYS.slice().sort())
    expect(ENGINE_TABS.map(([k]) => k)).toEqual(['cost', ...INSTRUMENT_KEYS])
  })
})

describe('briefParts (lane B)', () => {
  it('heads the standup draft and a prep by their meeting, adds the week, and is empty without either', () => {
    expect(briefParts(null)).toEqual([])
    expect(briefParts({ before: null, week: null })).toEqual([])
    const parts = briefParts({ before: { kind: 'standup-draft', title: 'Standup', start: '2026-09-30T07:00:00.000Z', lines: ['Yesterday: 2 commits on puzzlebox-studio.'] }, week: { lines: ['Shipped: 8 commits on puzzlebox-studio.'] } })
    expect(parts.map((p) => p.title)).toEqual([expect.stringMatching(/^For Standup, /), 'The week'])
    expect(briefParts({ before: { kind: 'meeting-prep', title: 'BOX-484 review', start: '2026-09-30T12:00:00.000Z', lines: ['Open: the draft for Mira Bakker.'] } })[0].title).toMatch(/^Before BOX-484 review, /)
  })

  it('carries the notice key a brief was raised under, so it can take a verdict (L9)', () => {
    const key = 'meeting-prep:BOX-484 review|2026-09-30T12:00:00.000Z'
    expect(briefParts({ before: { kind: 'meeting-prep', title: 'BOX-484 review', start: '2026-09-30T12:00:00.000Z', lines: ['x'], key } })[0].key).toBe(key)
    expect(briefParts({ week: { lines: ['y'] } })[0].key).toBeNull()
  })
})

describe('jobWords (L9)', () => {
  it('says a job kind in words, where the workbench wrote its slug', () => {
    expect(jobWords('I left "Standup brief" on your shelf (meeting-brief · puzzlebox-studio).')).toBe('I left "Standup brief" on your shelf (meeting brief · puzzlebox-studio).')
    expect(jobWords('owner-request · pnpm — you asked\n\nBody')).toBe('your request · pnpm — you asked\n\nBody')
    // A slug that is part of something else is left alone.
    expect(jobWords('see topic-brief.md')).toBe('see topic-brief.md')
    expect(jobWords(null)).toBe('')
  })
})

describe('todayParts (L2)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('builds today again once the page has crossed midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 28, 23, 50))
    const fetchMock = vi.fn(async (url) => ({ ok: true, json: async () => (String(url).startsWith('/gnomon/dial') ? { date: '2026-09-28', unavailable: 'nothing yet' } : {}) }))
    vi.stubGlobal('fetch', fetchMock)
    const first = await todayParts(() => {})
    expect(await todayParts(() => {})).toBe(first)
    const reads = fetchMock.mock.calls.length
    vi.setSystemTime(new Date(2026, 8, 29, 0, 10))
    const next = await todayParts(() => {})
    expect(next).not.toBe(first)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(reads)
  })
})

describe('answerDoor (L5)', () => {
  it('is a button that opens the conversation on the question, not a label', () => {
    const door = answerDoor()
    expect(door.tagName).toBe('BUTTON')
    expect(door.textContent).toBe('Answer in the chat')
    const heard = vi.fn()
    document.addEventListener('gnomon:answer', heard)
    door.click()
    expect(heard).toHaveBeenCalledTimes(1)
    document.removeEventListener('gnomon:answer', heard)
  })
})
