// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { dayClock, dayScale, scaleHours } from './day-clock.js'

describe('dayScale', () => {
  it('never narrows below the working day', () => {
    expect(dayScale([{ startMin: 10 * 60, endMin: 11 * 60 }])).toEqual({ from: 8 * 60, to: 20 * 60 })
  })

  it('widens to whatever was actually seen, both ends', () => {
    // The strata's own fault: a hardcoded 6→24 silently dropped the 00:00–03:00
    // work a late night puts in the record.
    expect(dayScale([{ startMin: 4, endMin: 7 * 60 + 25 }, { startMin: 23 * 60, endMin: 24 * 60 }])).toEqual({ from: 0, to: 24 * 60 })
  })

  it('survives a list with nothing in it', () => {
    expect(dayScale([])).toEqual({ from: 8 * 60, to: 20 * 60 })
    expect(dayScale(undefined)).toEqual({ from: 8 * 60, to: 20 * 60 })
  })
})

describe('scaleHours', () => {
  it('names every third hour and always both ends', () => {
    expect(scaleHours({ from: 8 * 60, to: 20 * 60 })).toEqual([8, 9, 12, 15, 18, 20])
  })

  it('does not print an end hour twice when it is already a multiple of three', () => {
    expect(scaleHours({ from: 9 * 60, to: 21 * 60 })).toEqual([9, 12, 15, 18, 21])
  })
})

describe('dayClock', () => {
  const scale = { from: 8 * 60, to: 20 * 60 }
  const marks = (node) => [...node.children].map((c) => c.getAttribute('class'))

  it('draws the band and the tick that starts it', () => {
    expect(marks(dayClock({ startMin: 9 * 60, endMin: 11 * 60 }, scale))).toEqual(['clock-axis', 'clock-band', 'clock-start'])
  })

  it('draws the tick alone when there is a start and no end', () => {
    // An ask that expired unanswered. Both marks used to live inside one
    // branch, so this row drew a bare axis — "nothing happened" said about the
    // one case where nothing happening is the whole finding.
    expect(marks(dayClock({ startMin: 9 * 60, endMin: null }, scale))).toEqual(['clock-axis', 'clock-start'])
  })

  it('runs a band that outlasts the scale to the edge, rather than off it', () => {
    // A question asked at 22:08 and answered at 07:38 the next morning is 570
    // minutes of waiting, which has no end on a single day's clock. It is
    // clamped to the right-hand edge and the row's own meta says how long.
    const node = dayClock({ startMin: 19 * 60, endMin: 19 * 60 + 570, width: 380 }, scale)
    const band = node.querySelector('.clock-band')
    expect(Number(band.getAttribute('x')) + Number(band.getAttribute('width'))).toBeLessThanOrEqual(380)
  })
})
