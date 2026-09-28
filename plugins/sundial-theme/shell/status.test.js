import { describe, expect, it } from 'vitest'
import { needsReason, status, statusWord } from './status.js'

/**
 * Six enums, one set of words. The audit found the clash four times: the same
 * research question read "superseded" on the lab card and "open" on the
 * calibration card, and a finished job read "shelved", which the owner took to
 * mean abandoned.
 */
describe('status', () => {
  it('says what shelved actually means', () => {
    // The opposite of abandoned: the result is on the shelf, waiting.
    expect(statusWord('shelved')).toBe('done, on the shelf')
    expect(status('shelved').tone).toBe('done')
  })

  it('gives one word per state across all six vocabularies', () => {
    expect(statusWord('timed-out')).toBe('ran out of time')
    expect(statusWord('not-now')).toBe('not now')
    expect(statusWord('expired')).toBe('expired unanswered')
    expect(statusWord('learned')).toBe('learned')
    expect(statusWord('rejected')).toBe('rejected')
  })

  it('marks the states that are meaningless without a why', () => {
    // "failures owe a one-line why" — a surface drawing one of these is expected
    // to show the reason or say there is none.
    expect(needsReason('failed')).toBe(true)
    expect(needsReason('timed-out')).toBe(true)
    expect(needsReason('superseded')).toBe(true)
    expect(needsReason('blocked')).toBe(true)
    // A finished thing explains itself.
    expect(needsReason('shelved')).toBe(false)
    expect(needsReason('answered')).toBe(false)
  })

  it('sorts every state into one of four tones', () => {
    const tones = new Set(['done', 'open', 'held', 'bad'])
    for (const name of ['shelved', 'failed', 'timed-out', 'learned', 'stale', 'superseded', 'accepted', 'rejected', 'useful', 'wrong', 'not-now', 'answered', 'expired', 'open', 'paused', 'blocked', 'done', 'dropped']) {
      expect(tones.has(status(name).tone), `${name} has tone ${status(name).tone}`).toBe(true)
    }
  })

  it('lets an unknown state look unfamiliar rather than disappear', () => {
    // A state invented by a new rule should be visible on the page as something
    // nobody has named yet, not swallowed into a dash.
    expect(statusWord('half-shelved')).toBe('half shelved')
    expect(statusWord(null)).toBe('—')
    expect(statusWord('')).toBe('—')
  })
})
