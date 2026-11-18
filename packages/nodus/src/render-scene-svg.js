// A scene drawn flat: the same solved layout, projected through the same view
// the stage's camera takes, every part a simple glyph by kind. It is what a
// page without WebGL shows, what shows while three.js loads, and what jsdom
// draws in the tests. Same contract as the other renderers: `{ node, focus }`,
// every colour a class the theme paints, doors as `data-explore`, labels in
// the margins with a leader to their part, as on the stage.

import { project, VIEWS } from './camera.js'
import { marginLabels } from './labels.js'
import { layoutScene } from './layout-scene.js'

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
const f1 = (v) => Math.round(v * 10) / 10
/** An uppercase 11px label with its tracking, as the stage's labels are set. */
const LABEL_W = (text) => text.length * 7.6 + 8
const LABEL_H = 14

/** The glyph for a kind, centred at (x, y) with radius r in pixels. */
function glyph(n, x, y, r) {
  const at = { 'data-id': n.id, class: `nd-glyph nd-kind-${n.kind}` }
  if (['tank', 'reservoir', 'box', 'plane'].includes(n.kind)) return s('rect', { ...at, x: f1(x - r), y: f1(y - r), width: f1(r * 2), height: f1(r * 2) })
  if (n.kind === 'ground') return s('line', { ...at, x1: f1(x - r * 2), y1: f1(y), x2: f1(x + r * 2), y2: f1(y) })
  if (n.kind === 'rainbow') return s('path', { ...at, d: `M${f1(x - r)},${f1(y)} A${f1(r)},${f1(r)} 0 0 1 ${f1(x + r)},${f1(y)}` })
  if (['valve', 'cone', 'sink', 'prism'].includes(n.kind)) return s('path', { ...at, d: `M${f1(x - r)},${f1(y - r)} L${f1(x + r)},${f1(y - r)} L${f1(x)},${f1(y + r)} Z` })
  if (n.kind === 'gear') {
    const pts = []
    for (let i = 0; i < n.teeth * 2; i++) {
      const a = n.phase + (i / (n.teeth * 2)) * Math.PI * 2
      const q = i % 2 ? r * 0.88 : r * 1.06
      pts.push(`${f1(x + Math.cos(a) * q)},${f1(y - Math.sin(a) * q)}`)
    }
    return s('polygon', { ...at, points: pts.join(' ') })
  }
  return s('circle', { ...at, cx: f1(x), cy: f1(y), r: f1(Math.max(3, r)) })
}

export function drawSceneSvg(spec, { width = 1080 } = {}) {
  const L = layoutScene(spec)
  const view = VIEWS[L.view]
  const flat = L.nodes.map((n) => ({ n, ...project([n.x, n.y, n.z], view) }))
  const lo = { x: Math.min(...flat.map((p) => p.x - p.n.r)), y: Math.min(...flat.map((p) => p.y - p.n.r)) }
  const hi = { x: Math.max(...flat.map((p) => p.x + p.n.r)), y: Math.max(...flat.map((p) => p.y + p.n.r)) }
  // The figure in the middle, the labels' margins round it: beside it, or above and below a wide set.
  const wide = L.axis === 'y' || (hi.x - lo.x) / Math.max(0.1, hi.y - lo.y) > 2.4
  const mx = wide ? 24 : Math.min(width * 0.28, Math.max(...L.nodes.map((n) => LABEL_W(n.label))) + 24)
  const my = wide ? LABEL_H + 28 : 16
  const k = Math.min((width - mx * 2) / Math.max(1, hi.x - lo.x), 440 / Math.max(1, hi.y - lo.y))
  const px = (p) => ({ x: mx + (p.x - lo.x) * k, y: my + (p.y - lo.y) * k })
  const height = my * 2 + (hi.y - lo.y) * k

  const root = s('svg', { class: 'nd-svg nd-scene', role: 'img', 'aria-label': spec.title, viewBox: `0 0 ${width} ${f1(height)}` })
  const wires = s('g', { class: 'nd-links' })
  const at = new Map(flat.map((p) => [p.n.id, px(p)]))
  for (const e of L.edges) {
    const d = e.points.map((q, i) => {
      const p = px(project(q, view))
      return `${i ? 'L' : 'M'}${f1(p.x)},${f1(p.y)}`
    })
    wires.append(s('path', { class: `nd-link nd-link-${e.kind}`, 'data-id': e.from, 'data-to': e.to, d: d.join(' ') }))
  }
  root.append(wires)

  const lanes = new Map(spec.lanes.map((l) => [l.id, l]))
  const inner = { x0: mx, y0: my, x1: width - mx, y1: height - my }
  const placed = marginLabels(flat.map(({ n }) => ({ id: n.id, x: at.get(n.id).x, y: at.get(n.id).y, w: LABEL_W(n.label), h: LABEL_H })), { inner, w: width, h: height }, { wide, discs: flat.map(({ n }) => ({ ...at.get(n.id), r: n.r * k })) })
  flat.forEach(({ n }, i) => {
    const p = at.get(n.id)
    const door = lanes.get(n.id)?.door
    const g = s('g', { class: 'nd-node nd-scene-part', ...(door ? { 'data-explore': door, tabindex: '0', role: 'link' } : {}) })
    const [[x0, y0], [x1, y1]] = placed[i].leader
    const left = placed[i].side === 'left'
    g.append(
      txt('title', {}, n.label),
      glyph(n, p.x, p.y, n.r * k),
      s('path', { class: 'nd-leader', 'data-id': n.id, d: `M${f1(x0)},${f1(y0)} L${f1(x1)},${f1(y1)}` }),
      s('circle', { class: 'nd-anchor', 'data-id': n.id, cx: f1(x1), cy: f1(y1), r: 2.5 }),
      txt('text', { class: 'nd-label nd-label-scene', 'data-id': n.id, 'data-side': placed[i].side, x: f1(left ? placed[i].x + LABEL_W(n.label) - 4 : placed[i].x + 4), y: f1(placed[i].y + LABEL_H - 3), 'text-anchor': left ? 'end' : 'start' }, n.label.toUpperCase()),
    )
    root.append(g)
  })

  // Light the step's parts; a lit part lights its joints.
  const focus = (ids) => {
    const hot = new Set(ids instanceof Set ? ids : ids ?? [])
    root.classList.toggle('nd-has-focus', hot.size > 0)
    for (const el of root.querySelectorAll('[data-id]')) {
      const id = el.getAttribute('data-id')
      const to = el.getAttribute('data-to')
      el.classList.toggle('nd-hot', hot.has(id) || (to !== null && hot.has(to)))
    }
  }
  return { node: root, focus, layout: L, update: null }
}
