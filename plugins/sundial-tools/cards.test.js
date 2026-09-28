import { describe, it, expect } from 'vitest'
import { CARD_KINDS, normKind } from '@sundial/rules/board-track.js'
import { CARDS, INSTRUMENT_KEYS, INSTRUMENT_ROUTES, cardOf, checkFilters, describeCard } from '../sundial-theme/shell/cards.js'
import { cleanFilters } from '@sundial/rules/board-track.js'

describe('the card catalog', () => {
  it('has an entry for every kind the record can hold, and names nothing the record cannot', () => {
    const catalogKinds = new Set(CARDS.map((c) => normKind(c.id.startsWith('inst:') ? 'inst' : c.id.replace(/:$/, ''))))
    expect(CARD_KINDS.filter((k) => !catalogKinds.has(k)), 'kinds with no catalog entry').toEqual([])
    expect([...catalogKinds].filter((k) => !CARD_KINDS.includes(k)), 'catalog entries the record cannot place').toEqual([])
  })

  it('gives every card a title, a question and what it shows, and every instrument a route and search words', () => {
    for (const c of CARDS) {
      expect(c.title && c.question && c.shows, c.id).toBeTruthy()
      if (c.id.startsWith('inst:')) expect(c.route && c.keywords && c.band, c.id).toBeTruthy()
    }
    expect(Object.keys(INSTRUMENT_ROUTES)).toEqual(INSTRUMENT_KEYS)
  })

  it('no longer holds Intro, and has one card titled "The day"', () => {
    expect(cardOf('intro')).toBeNull()
    expect(CARDS.filter((c) => c.title === 'The day').map((c) => c.id)).toEqual(['dial'])
  })

  it('describes a card on the board by what it is, and a moment by when it started', () => {
    expect(describeCard('engine')).toContain('Is Gnomon working, affordable and honest?')
    expect(describeCard('entity:alex morgan')).toContain('"Entity: alex morgan"')
    // 01M36YR8W0… is a real moment id; its ULID clock is 2026-09-23.
    expect(describeCard('moment:01M36YR8W0MFABCDEFGHJKMNPQ')).toMatch(/"Moment at 2026-09-2\d \d\d:\d\dZ"/)
  })

  it('accepts only the filters a card can honour, and says which it takes', () => {
    expect(checkFilters('dial', { date: '2026-09-22' }).ok).toBe(true)
    expect(checkFilters('dial', { date: 'yesterday' }).reason).toBe('date is YYYY-MM-DD')
    expect(checkFilters('play', { project: 'sundial' }).ok).toBe(true)
    expect(checkFilters('ledger', { purpose: 'ask' }).reason).toContain('takes none')
    expect(checkFilters('dial', null)).toEqual({ ok: true, filters: null })
  })

  it('tells the agent what a card is set to and what it can be set to', () => {
    const line = describeCard('dial', { filters: { date: '2026-09-22' } })
    expect(line).toContain('Set to date=2026-09-22.')
    expect(line).toContain('Filters: date (')
  })

  it('stores filters as short strings, and nothing as a clear', () => {
    expect(cleanFilters({ date: '2026-09-22', tab: '', n: 3 })).toEqual({ date: '2026-09-22', n: '3' })
    expect(cleanFilters({})).toBeNull()
    expect(cleanFilters(null)).toBeNull()
  })

  it('gives every fact one owner, and Kanban none', () => {
    const owners = new Map()
    for (const c of CARDS.filter((card) => card.owns)) for (const item of c.owns) owners.set(item, [...(owners.get(item) ?? []), c.id])
    expect([...owners].filter(([, ids]) => ids.length > 1), 'facts on two cards').toEqual([])
    expect(cardOf('kanban').owns).toEqual([])
    expect(CARDS.filter((c) => c.owns).map((c) => c.id).sort()).toEqual(['dial', 'engine', 'explore', 'kanban', 'play', 'rhythm', 'shelf', 'today', 'voice', 'work'])
  })
})
