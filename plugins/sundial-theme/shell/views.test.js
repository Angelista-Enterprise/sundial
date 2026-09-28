// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ENGINE_TABS, PANEL_KEYS, briefLine, dayPanel, span, whatItSaw } from './views.js'
import { INSTRUMENT_KEYS } from './cards.js'

describe('briefLine', () => {
  it('says the day in one sentence', () => {
    const line = briefLine({ date: '2026-09-15', observedMin: 214, projects: [{ name: 'a', minutes: 7 }, { name: 'b', minutes: 73 }], meetings: 1, noticed: 2 })
    expect(line).toBe('Tuesday. 3h 34m observed, most of it on b, 1 meeting. Gnomon noticed 2 things.')
    expect(briefLine({ date: '2026-09-15', observedMin: 0 })).toBe('Tuesday. Nothing observed yet.')
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
      data: { activeMs: 1_200_000, shellCommandCount: 12, spokenExcerpt: 'keep that into its memory', windowTitles: ['views.js'] },
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
    expect(said).toContain('keep that into its memory')

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
