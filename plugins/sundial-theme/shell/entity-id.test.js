import { describe, expect, it } from 'vitest'
import { entityId, entitySlug } from './entity-id.js'

describe('entitySlug', () => {
  it('folds the two ids the record split a goal across', () => {
    // The live wreckage: the card wrote the raw name, the chat wrote the slug.
    expect(entitySlug('Ask team whether moving standup to 9:30 still stands')).toBe('ask-team-whether-moving-standup-to-9-30-still-stands')
    expect(entitySlug('ask-team-whether-moving-standup-to-9-30-still-stands')).toBe('ask-team-whether-moving-standup-to-9-30-still-stands')
  })

  it('is idempotent, so folding an already-folded id is safe', () => {
    const once = entitySlug('Ledger failure views (L1–L7)')
    expect(once).toBe('ledger-failure-views-l1-l7')
    expect(entitySlug(once)).toBe(once)
  })

  it('matches the slug the assert route writes', () => {
    expect(entityId('goal', 'Consistent sleep rhythm')).toBe('goal:consistent-sleep-rhythm')
  })

  it('has nothing to say about nothing', () => {
    expect(entitySlug(null)).toBe('')
    expect(entitySlug('   ')).toBe('')
  })
})
