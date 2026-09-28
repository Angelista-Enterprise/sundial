// @vitest-environment jsdom
// Pure geometry, but `stage.js` now draws a mark beside a card's name, and the
// icon catalogue builds its SVG at module load. A DOM to import into is cheaper
// than making the catalogue lazy for the sake of one arithmetic test.
import { describe, expect, it } from 'vitest'
import { fitCamera, freeSpot, visible } from './stage.js'

describe('the board geometry', () => {
  const cards = { a: { x: 0, y: 0, w: 960, h: 620 }, b: { x: 1000, y: 0, w: 720, h: 640 } }

  it('fits every card into the viewport, centred, never past 1:1', () => {
    const cam = fitCamera(Object.values(cards), 1400, 800)
    expect(cam.s).toBeLessThan(1)
    // The union spans 0…1720 × 0…640; at this scale it is centred.
    const left = 0 * cam.s + cam.x
    const right = 1720 * cam.s + cam.x
    expect(left).toBeCloseTo(1400 - right, 3)
    expect(fitCamera([{ x: 0, y: 0, w: 100, h: 100 }], 1400, 800).s).toBe(1)
  })

  it('places a new card to the right of everything', () => {
    expect(freeSpot(cards, 320, 200)).toEqual({ x: 1720 + 12, y: 0, w: 320, h: 200 })
    expect(freeSpot({}, 320, 200)).toEqual({ x: 0, y: 0 })
  })

  it('knows when a card is mostly in view', () => {
    const cam = { x: 0, y: 0, s: 1 }
    expect(visible(cards.a, cam, 1400, 800)).toBe(true)
    expect(visible(cards.b, cam, 1400, 800)).toBe(false)
    expect(visible(cards.b, { x: -1000, y: 0, s: 1 }, 1400, 800)).toBe(true)
  })
})
