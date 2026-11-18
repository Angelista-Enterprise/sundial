// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { bindDay } from './bind.js'
import { checkSpec } from './spec.js'
import { fallbackSteps } from './storyboard.js'
import { drawTimeline } from './render-timeline.js'
import { nodusNode } from './card.js'
import { DAY } from './fixture.test-data.js'

const spec = () => {
  const s = bindDay(DAY)
  return checkSpec({ ...s, steps: fallbackSteps(s) }).spec
}

describe('the timeline renderer', () => {
  it('draws one bar per part, coloured by role and mark classes, never by a colour', () => {
    const { node } = drawTimeline(spec())
    expect(node.querySelectorAll('.nd-bar')).toHaveLength(spec().parts.length)
    expect(node.querySelectorAll('.nd-session.nd-mark-observed')).toHaveLength(4)
    expect(node.outerHTML).not.toMatch(/fill="#|stroke="#|style=/)
  })

  it('makes every session a door to its moment', () => {
    const doors = [...drawTimeline(spec()).node.querySelectorAll('[data-explore]')]
    expect(doors.map((d) => d.getAttribute('data-explore'))).toContain('moment:01M6AAAAAAAAAAAAAAAAAAAAA2')
    expect(doors.every((d) => d.getAttribute('role') === 'link' && d.getAttribute('tabindex') === '0')).toBe(true)
  })

  it('lights what a step names, and only the step’s own session says its name', () => {
    const f = drawTimeline(spec())
    f.focus(new Set(['p:tidewater', 's:01M6AAAAAAAAAAAAAAAAAAAAA3']), ['s:01M6AAAAAAAAAAAAAAAAAAAAA3'])
    expect(f.node.classList.contains('nd-has-focus')).toBe(true)
    expect([...f.node.querySelectorAll('.nd-bar.nd-hot')].map((n) => n.getAttribute('data-id'))).toEqual(['s:01M6AAAAAAAAAAAAAAAAAAAAA3'])
    expect([...f.node.querySelectorAll('.nd-tag')].map((n) => n.textContent)).toEqual(['Terminal'])
    f.focus(new Set())
    expect(f.node.querySelectorAll('.nd-hot')).toHaveLength(0)
  })
})

describe('the card', () => {
  it('opens on the first step and pages through to the whole figure', () => {
    const s = spec()
    const card = nodusNode(s)
    const say = () => card.querySelector('.nodus-say').textContent
    expect(say()).toBe(s.steps[0].say)
    expect(card.querySelector('.nodus-count').textContent).toBe(`01 / ${String(s.steps.length).padStart(2, '0')}`)
    const next = card.querySelector('.nodus-next')
    for (let i = 1; i < s.steps.length; i++) next.click()
    expect(next.textContent).toBe('Done')
    next.click()
    expect(card.dataset.step).toBe('-1')
    expect(card.querySelectorAll('.nd-hot')).toHaveLength(0)
  })

  it('says in its foot what it read and who wrote the walk', () => {
    expect(nodusNode(spec()).querySelector('.nodus-foot').textContent).toBe('Drawn in Sketch · day · 5 rows · 7 marks · walk by the numbers')
  })
})
