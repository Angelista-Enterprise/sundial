// The timeline, drawn: a thin map from `layoutTimeline` to SVG. Every colour is
// a class the theme's tokens paint (app.css, `.nd-*`), so light and dark paper
// both hold and nothing here names a colour.

import { layoutTimeline, tagFor } from './layout.js'
import { hm } from './storyboard.js'

const NS = 'http://www.w3.org/2000/svg'
const s = (tag, attrs = {}, children = []) => {
  const node = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, String(v))
  for (const c of children) if (c) node.append(c)
  return node
}
const txt = (tag, attrs, text) => {
  const node = s(tag, attrs)
  node.textContent = text
  return node
}

/** The SVG for a timeline spec, and a `focus(ids)` that lights those parts and dims the rest. */
export function drawTimeline(spec, opts = {}) {
  const L = layoutTimeline(spec, opts)
  const parts = new Map(spec.parts.map((p) => [p.id, p]))
  const tz = spec.tz
  const root = s('svg', { class: 'nd-svg', viewBox: `0 0 ${L.width} ${L.height}`, role: 'img', 'aria-label': spec.title })

  const grid = s('g', { class: 'nd-grid' })
  for (const t of L.ticks) {
    grid.append(s('line', { class: t.major ? 'nd-tick nd-tick-major' : 'nd-tick', x1: t.x, x2: t.x, y1: 18, y2: L.height }))
    if (t.major) grid.append(txt('text', { class: 'nd-hour', x: t.x, y: 12, 'text-anchor': 'middle' }, hm(t.at, tz)))
  }
  root.append(grid)

  const lanes = s('g', { class: 'nd-lanes' })
  for (const l of L.lanes) {
    lanes.append(s('rect', { class: `nd-lane nd-lane-${l.role}`, 'data-id': l.id, x: L.x0, y: l.y, width: L.x1 - L.x0, height: l.h }))
    // A lane with a value says it under its name, both in the gutter: side by side they met in a narrow one.
    const mid = l.y + l.h / 2
    lanes.append(txt('text', { class: 'nd-lane-label', 'data-id': l.id, x: 0, y: l.value ? mid - 8 : mid }, l.label.length > L.cut ? `${l.label.slice(0, L.cut - 1)}…` : l.label))
    if (l.value) lanes.append(txt('text', { class: 'nd-lane-value', 'data-id': l.id, x: 0, y: mid + 9 }, `${l.value}${l.unit ? ` ${l.unit}` : ''}`))
  }
  root.append(lanes)

  const bars = s('g', { class: 'nd-bars' })
  const byId = new Map()
  for (const b of L.bars) {
    const p = parts.get(b.id)
    const rect = s('rect', { class: `nd-bar nd-${b.role} nd-mark-${b.mark}`, 'data-id': b.id, x: b.x, y: b.y, width: b.w, height: b.h })
    rect.append(txt('title', {}, `${b.label}, ${hm(p.from, tz)} to ${hm(p.to, tz)}${p.note ? `\n${p.note}` : ''}`))
    // A session is a door to its moment, like a mark on the sundial's ring.
    if (p.door) {
      rect.setAttribute('data-explore', p.door)
      rect.setAttribute('tabindex', '0')
      rect.setAttribute('role', 'link')
    }
    bars.append(rect)
    byId.set(b.id, b)
  }
  root.append(bars)

  const labels = s('g', { class: 'nd-labels' })
  for (const l of L.labels) labels.append(txt('text', { class: 'nd-label', 'data-id': l.id, x: l.x, y: l.y }, l.text))
  root.append(labels)
  const tags = s('g', { class: 'nd-tags' })
  root.append(tags)

  // `ids` light; only `named` (the step's own focus) say their name, packed so two never overlap.
  const focus = (ids, named = []) => {
    const hot = ids instanceof Set ? ids : new Set(ids ?? [])
    root.classList.toggle('nd-has-focus', hot.size > 0)
    for (const node of root.querySelectorAll('[data-id]')) node.classList.toggle('nd-hot', hot.has(node.getAttribute('data-id')))
    tags.replaceChildren()
    const placed = []
    for (const id of named) {
      const b = byId.get(id)
      if (b?.role !== 'session') continue
      const t = tagFor(b, L)
      if (placed.some((q) => Math.abs(q.y - t.y) < 12 && t.x < q.x + q.w && t.x + t.w > q.x)) continue
      placed.push(t)
      tags.append(txt('text', { class: 'nd-tag', x: t.x, y: t.y }, b.label))
    }
  }
  return { node: root, focus, layout: L }
}
