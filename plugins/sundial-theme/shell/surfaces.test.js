// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { el, liveFirst, newestFirst, svg } from './surfaces.js'

/**
 * The same complaint reached the audit from four surfaces: the day ran
 * oldest-first, the Day detail ran oldest-first while every other moment list
 * ran the other way, the thread rail put the session the owner was speaking in
 * fourth, and the fact list buried what the owner said. One comparator, so the
 * default is not something each surface has to remember.
 */
describe('el', () => {
  // `grid` and `chart` hand back a PAIR, so nesting one inside another surface
  // passes an array as a child. `append` stringifies what it cannot recurse
  // into, and the lens card read "[object HTMLDivElement]," where its table
  // should have been.
  it('takes a nested array of children rather than stringifying it', () => {
    const node = el('div', {}, [[el('p', { text: 'one' }), null], el('p', { text: 'two' })])
    expect([...node.children].map((c) => c.textContent)).toEqual(['one', 'two'])
    expect(node.textContent).not.toContain('[object')
  })

  it('does the same in SVG', () => {
    const node = svg('g', {}, [[svg('rect', {}), null]])
    expect(node.children.length).toBe(1)
  })
})

describe('newestFirst', () => {
  const rows = [{ at: '2026-09-15T09:00:00.000Z' }, { at: '2026-09-17T09:00:00.000Z' }, { at: '2026-09-16T09:00:00.000Z' }]

  it('puts the most recent at the top', () => {
    expect(newestFirst(rows).map((r) => r.at.slice(8, 10))).toEqual(['17', '16', '15'])
  })

  it('takes the instant off whatever field the caller names', () => {
    const moments = [{ startTime: '2026-09-15T09:00:00.000Z' }, { startTime: '2026-09-17T09:00:00.000Z' }]
    expect(newestFirst(moments, (m) => m.startTime)[0].startTime).toContain('09-17')
  })

  it('compares epoch milliseconds as numbers, not as text', () => {
    // dsh keeps session times as epoch ms. Compared as strings, `9` sorts above
    // `10` and the list is quietly wrong for a decade at a time.
    const epochs = [{ at: 1_700_000_000_000 }, { at: 999_999_999_999 }, { at: 1_800_000_000_000 }]
    expect(newestFirst(epochs).map((r) => r.at)).toEqual([1_800_000_000_000, 1_700_000_000_000, 999_999_999_999])
  })

  it('sorts a row with no instant last: unknown is not old', () => {
    const mixed = [{ at: null }, { at: '2026-09-15T09:00:00.000Z' }, {}]
    expect(newestFirst(mixed)[0].at).toBe('2026-09-15T09:00:00.000Z')
  })

  it('leaves the caller\'s array alone', () => {
    const original = [...rows]
    newestFirst(rows)
    expect(rows).toEqual(original)
  })

  it('has an answer for nothing at all', () => {
    expect(newestFirst(null)).toEqual([])
    expect(newestFirst(undefined)).toEqual([])
  })
})

describe('liveFirst', () => {
  it('pins what is live above the newest', () => {
    // A thread the owner is speaking in is not merely the newest thing; it is
    // the only one they can act on. It sat fourth in creation order.
    const rows = [
      { id: 'old-live', at: '2026-09-10T09:00:00.000Z', live: true },
      { id: 'newest', at: '2026-09-17T09:00:00.000Z' },
      { id: 'middle', at: '2026-09-14T09:00:00.000Z' },
    ]
    expect(liveFirst(rows).map((r) => r.id)).toEqual(['old-live', 'newest', 'middle'])
  })

  it('keeps several live ones newest-first among themselves', () => {
    const rows = [
      { id: 'a', at: '2026-09-10T09:00:00.000Z', live: true },
      { id: 'b', at: '2026-09-16T09:00:00.000Z', live: true },
      { id: 'c', at: '2026-09-17T09:00:00.000Z' },
    ]
    expect(liveFirst(rows).map((r) => r.id)).toEqual(['b', 'a', 'c'])
  })

  it('lets the caller say what counts as live', () => {
    const rows = [{ id: 'a', at: '2026-09-10T09:00:00.000Z' }, { id: 'b', at: '2026-09-17T09:00:00.000Z' }]
    expect(liveFirst(rows, (r) => r.at, (r) => r.id === 'a').map((r) => r.id)).toEqual(['a', 'b'])
  })
})

/**
 * The staggers. DESIGN.md describes "a per-row stagger of about 22ms" and the
 * surfaces all write `style: { '--i': i }` for it — and none of it ran. A
 * custom property only exists if it goes through `setProperty`; assigning it
 * onto `node.style` puts a JS property on the CSSStyleDeclaration and nothing
 * on the element, so every `calc(var(--i) * 22ms)` resolved to zero. `svg()`
 * did not read a style object at all and stamped `[object Object]`.
 */
describe('the style object', () => {
  it('lands a custom property on an element, not on the JS object beside it', () => {
    expect(el('div', { style: { '--i': 3 } }).style.getPropertyValue('--i')).toBe('3')
  })

  it('lands one on an SVG node too, and keeps ordinary attributes as attributes', () => {
    const node = svg('rect', { style: { '--h': 7 }, width: 4 })
    expect(node.style.getPropertyValue('--h')).toBe('7')
    expect(node.getAttribute('style')).not.toContain('object Object')
    expect(node.getAttribute('width')).toBe('4')
  })

  it('still sets ordinary declarations', () => {
    expect(el('div', { style: { width: '10px' } }).style.width).toBe('10px')
  })
})
