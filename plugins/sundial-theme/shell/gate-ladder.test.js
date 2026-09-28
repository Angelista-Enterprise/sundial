import { describe, expect, it } from 'vitest'
import { LADDER_COLUMNS, packColumn } from './gate-ladder.js'

/** A column 200 wide starting at x=100, with weight mapped straight to y. */
const BOX = { x: 100, width: 200, yOf: (w) => w }

describe('packing a column of decisions', () => {
  it('lays marks at the height their weight says', () => {
    const out = packColumn([{ weight: 40 }, { weight: 120 }], BOX)
    expect(out.map((m) => m.y)).toEqual([38.5, 118.5])
    expect(out.every((m) => m.x === 100), 'a lone mark sits at the column edge').toBe(true)
  })

  it('never lets a crowded rank run off its column', () => {
    // The one thing this picture must not do. A mark that overflowed its
    // column would sit under the NEIGHBOURING heading and claim the wrong
    // outcome for the decision it stands for — which is worse than a crowded
    // column, so the pitch compresses instead.
    const crowded = Array.from({ length: 60 }, () => ({ weight: 100 }))
    const out = packColumn(crowded, BOX)
    expect(out).toHaveLength(60)
    for (const mark of out) {
      expect(mark.x).toBeGreaterThanOrEqual(100)
      expect(mark.x + 9, 'the mark including its own width stays inside').toBeLessThanOrEqual(300)
    }
  })

  it('groups marks within a few pixels into one rank', () => {
    // Weights are continuous, so exact ties are rare and near-ties are the
    // normal case. Packed on exact equality only, 171 decisions would draw as
    // 171 marks in one vertical line, each hiding the one behind it.
    const near = [{ weight: 100 }, { weight: 102 }, { weight: 105 }]
    const out = packColumn(near, BOX)
    expect(new Set(out.map((m) => m.x)).size, 'three near weights get three x positions').toBe(3)
    const far = [{ weight: 100 }, { weight: 160 }]
    expect(new Set(packColumn(far, BOX).map((m) => m.x)).size, 'two distant ones both start at the edge').toBe(1)
  })

  it('names the three things the gate can do, in that order', () => {
    // The order a reader asks about them, and the same three words the row's
    // own state track uses — the picture and the list must not disagree about
    // what happened to a decision.
    expect(LADDER_COLUMNS.map((c) => c.key)).toEqual(['said', 'held', 'dropped'])
  })
})
