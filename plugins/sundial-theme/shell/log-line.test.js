// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { drawLogLine } from './log-line.js'
import { deliverableCard } from './deliverable.js'

describe('drawLogLine', () => {
  it('one key is one line: a later frame updates its status, keeps its label', () => {
    const turn = document.createElement('div')
    const lines = new Map()
    drawLogLine({ key: 'cmd:c1', label: '/permission', status: 'running…' }, lines, () => turn)
    drawLogLine({ key: 'cmd:c1', status: 'no permission to change', failed: true }, lines, () => turn)
    expect(turn.children).toHaveLength(1)
    expect(turn.textContent).toBe('/permissionno permission to change')
    expect(turn.firstChild.hasAttribute('data-failed')).toBe(true)
    expect(turn.firstChild.title).toBe('no permission to change')
  })
  it('a line with no key stands alone, and its reason is on hover', () => {
    const turn = document.createElement('div')
    const lines = new Map()
    drawLogLine({ label: 'Goal set', status: 'Tidy the board' }, lines, () => turn)
    drawLogLine({ label: 'Asked to run gnomon_board', status: 'refused', failed: true, title: 'a notice opened this turn' }, lines, () => turn)
    expect(turn.children).toHaveLength(2)
    expect(lines.size).toBe(0)
    expect(turn.lastChild.title).toBe('a notice opened this turn')
  })
})

describe('deliverableCard', () => {
  it('names each file and points at the session-checked route; no file, no card', () => {
    const card = deliverableCard({ files: [{ path: '/tmp/report.md', name: 'report.md', description: null }] }, 'session-1')
    expect(card.querySelector('.deliverable-head').textContent).toBe('Gnomon made you a file')
    expect(card.querySelector('a').getAttribute('href')).toBe('/gnomon/api/deliverable?session=session-1&path=%2Ftmp%2Freport.md')
    expect(deliverableCard({ files: [] }, 'session-1')).toBeNull()
  })
})
