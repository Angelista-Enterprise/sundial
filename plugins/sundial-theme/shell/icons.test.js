// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ICONS, icon, iconLabel } from './icons.js'

/**
 * The roster. An icon added to the catalogue is added here, which is the point
 * where someone has to decide whether the board needs a fourteenth glyph or
 * whether one of these already means that.
 */
const ROSTER = [
  'time', 'seen', 'day',
  'app', 'project', 'branch', 'commit', 'terminal',
  'heard', 'note', 'read', 'cost', 'goal', 'person', 'search', 'chart', 'layers', 'repeat', 'known',
  'ask', 'done', 'failed', 'paused', 'live', 'flag', 'open', 'more',
]

describe('the icon catalogue', () => {
  it('holds exactly the roster', () => {
    expect(Object.keys(ICONS).sort()).toEqual([...ROSTER].sort())
  })

  it('draws every one of them, on the same grid and in the same weight', () => {
    for (const name of ROSTER) {
      const node = icon(name)
      expect(node, name).not.toBeNull()
      expect(node.getAttribute('viewBox'), name).toBe('0 0 16 16')
      expect(node.getAttribute('stroke'), name).toBe('currentColor')
      expect(node.getAttribute('stroke-linecap'), name).toBe('square')
      expect(node.childNodes.length, name).toBeGreaterThan(0)
    }
  })

  it('is decorative unless it is given something to say', () => {
    expect(icon('done').getAttribute('aria-hidden')).toBe('true')
    expect(icon('done').querySelector('title')).toBeNull()
    const spoken = icon('done', { label: 'Done' })
    expect(spoken.getAttribute('aria-hidden')).toBeNull()
    expect(spoken.querySelector('title').textContent).toBe('Done')
  })

  it('returns nothing for a name that is not in the catalogue', () => {
    expect(icon('sparkle-rocket')).toBeNull()
  })

  it('ships beside a word, never instead of one', () => {
    const node = iconLabel('project', 'Where')
    expect(node.textContent).toBe('Where')
    expect(node.querySelector('svg')).not.toBeNull()
  })
})
