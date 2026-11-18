// The forms that are not on time, drawn: bars (how much of each, with `then`
// beside it for a comparison), a graph (what connects) and a table (rows to
// read). Same contract as the timeline: `{ node, focus(ids, named) }`, every
// colour a class the theme paints, every position the renderer's.
//
// Labels cannot collide by construction: one row per lane, a fixed row pitch,
// and a label that does not fit its column is cut with an ellipsis and kept
// whole in the row's hover title.
//
// Every layout takes the width it is drawn at, and the card draws it at its
// host's width (`fitted`), so one unit is one CSS pixel and the type keeps its
// own size (12 px labels, 14 px values) in a 380 px dock as on the board:
// narrow bars put each label over its bar, a narrow graph keeps its three
// columns and scrolls sideways.

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
const h = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) k === 'text' ? (node.textContent = v) : node.setAttribute(k, String(v))
  for (const c of children) if (c) node.append(c)
  return node
}
/** Average advance of a 12px Inter Tight glyph (layout.js measures the same); a lane label is upper case and tracked, wider. */
const CHAR_W = 6.4
const CAPS_W = 8.2
const cut = (label, px, per = CHAR_W) => {
  const n = Math.max(4, Math.floor(px / per))
  return label.length > n ? `${label.slice(0, n - 1)}…` : label
}
const amount = (v, unit) => (v == null ? '' : unit === 'USD' ? `$${v.toFixed(2)}` : unit === 'min' && v >= 60 ? `${Math.floor(v / 60)} h ${v % 60} min` : `${Math.round(v * 10) / 10}${unit ? ` ${unit}` : ''}`)
const door = (node, d) => {
  if (!d) return node
  node.setAttribute('data-explore', d)
  node.setAttribute('tabindex', '0')
  node.setAttribute('role', 'link')
  return node
}

/** Light `ids`, dim the rest: the same classes the timeline uses. */
const focuser = (root) => (ids) => {
  const hot = ids instanceof Set ? ids : new Set(ids ?? [])
  root.classList.toggle('nd-has-focus', hot.size > 0)
  for (const node of root.querySelectorAll('[data-id]')) node.classList.toggle('nd-hot', hot.has(node.getAttribute('data-id')))
}

export const ROW = { pitch: 34, gutter: 230, pad: 20, valueW: 110 }
/** Below this width a bar's label stands over its bar instead of in a gutter beside it. */
export const NARROW = 520
/** The graph's three columns need this much; narrower, it scrolls sideways. */
export const GRAPH_MIN = 600

/** Bars: one row per lane, longest scale to the plot, `then` as a thin rule above when the spec compares. */
export function layoutBars(spec, { width = 1080 } = {}) {
  const compare = spec.lanes.some((l) => l.then != null)
  const max = Math.max(1, ...spec.lanes.map((l) => Math.max(l.value ?? 0, l.then ?? 0)))
  const narrow = width < NARROW
  // Narrow: the label takes a line of its own over the bar, and the bar the whole width.
  const lift = narrow ? 18 : 0
  const x0 = narrow ? 0 : Math.min(ROW.gutter, Math.max(140, Math.round(width * 0.26)))
  const x1 = width - ROW.pad - ROW.valueW
  const top = compare ? 30 : 8
  const pitch = ROW.pitch + lift
  const rows = spec.lanes.map((l, i) => {
    const y = top + i * pitch
    const w = ((l.value ?? 0) / max) * (x1 - x0)
    return { id: l.id, label: l.label, role: l.role, y, lift, w, then: l.then != null ? ((l.then ?? 0) / max) * (x1 - x0) : null, value: amount(l.value, l.unit), thenValue: l.then != null ? amount(l.then, l.unit) : null }
  })
  return { width, height: top + spec.lanes.length * pitch + 6, x0, x1, rows, compare, narrow, label: narrow ? width : x0 - 16 }
}

export function drawBars(spec, opts = {}) {
  const L = layoutBars(spec, opts)
  const root = s('svg', { class: 'nd-svg nd-rows', viewBox: `0 0 ${L.width} ${L.height}`, role: 'img', 'aria-label': spec.title })
  if (L.compare) {
    const f = spec.facts ?? {}
    root.append(s('rect', { class: 'nd-row-bar', x: L.x0, y: 6, width: 14, height: 10 }), txt('text', { class: 'nd-hour', x: L.x0 + 20, y: 15 }, f.now ?? 'now'))
    const at = L.x0 + 40 + Math.min(260, (f.now ?? 'now').length * CHAR_W)
    root.append(s('rect', { class: 'nd-row-then', x: at, y: 9, width: 14, height: 4 }), txt('text', { class: 'nd-hour', x: at + 20, y: 15 }, f.then ?? 'then'))
  }
  const byId = new Map(spec.lanes.map((l) => [l.id, l]))
  for (const r of L.rows) {
    const lane = byId.get(r.id)
    const g = door(s('g', { class: `nd-row nd-row-${r.role}` }), lane.door)
    g.append(txt('title', {}, `${lane.label}: ${r.value}${r.thenValue != null ? `, then ${r.thenValue}` : ''}${lane.note ? `\n${lane.note}` : ''}`))
    g.append(txt('text', { class: 'nd-lane-label', 'data-id': r.id, x: 0, y: r.y + (L.narrow ? 7 : 14) }, cut(r.label, L.label, CAPS_W)))
    const y = r.y + r.lift
    if (r.then != null) g.append(s('rect', { class: 'nd-row-then nd-bar', 'data-id': r.id, x: L.x0, y: y + 2, width: Math.max(1, r.then), height: 4 }))
    g.append(s('rect', { class: `nd-row-bar nd-bar nd-${r.role}`, 'data-id': r.id, x: L.x0, y: y + (r.then != null ? 9 : 4), width: Math.max(2, r.w), height: r.then != null ? 14 : 20 }))
    g.append(txt('text', { class: 'nd-lane-value', 'data-id': r.id, x: L.x0 + Math.max(2, r.w, r.then ?? 0) + 8, y: y + 16 }, r.thenValue != null ? `${r.value} (${r.thenValue})` : r.value))
    root.append(g)
  }
  return { node: root, focus: focuser(root), layout: L }
}

/** A graph in three columns, read left to right: projects, threads, people. Links are hairlines. */
export function layoutGraph(spec, { width: host = 1080 } = {}) {
  const width = Math.max(GRAPH_MIN, host)
  const cols = [['project'], ['commitment', 'goal', 'marker', 'session', 'meeting', 'break', 'day', 'purpose'], ['person']]
  const colW = (width - ROW.pad * 2) / 3
  const nodes = []
  let rowsMax = 0
  cols.forEach((roles, c) => {
    const here = spec.lanes.filter((l) => roles.includes(l.role))
    rowsMax = Math.max(rowsMax, here.length)
    here.forEach((l, i) => nodes.push({ id: l.id, label: l.label, role: l.role, door: l.door, note: l.note, value: l.value, unit: l.unit, col: c, x: ROW.pad + c * colW, y: 12 + i * ROW.pitch, w: colW - 40 }))
  })
  const at = new Map(nodes.map((n) => [n.id, n]))
  const links = spec.links.filter((k) => at.has(k.from) && at.has(k.to)).map((k) => {
    const a = at.get(k.from)
    const b = at.get(k.to)
    const [l, r] = a.col <= b.col ? [a, b] : [b, a]
    // A trunk per source, just before the next column, fanned by the source's row so two never share a line.
    const row = nodes.filter((n) => n.col === l.col).indexOf(l)
    return { from: k.from, to: k.to, x1: l.x + Math.min(l.w, l.label.length * CHAR_W) + 8, y1: l.y + 10, tx: r.x - 18 - row * 5, x2: r.x - 6, y2: r.y + 10 }
  })
  return { width, height: 12 + Math.max(1, rowsMax) * ROW.pitch, nodes, links }
}

export function drawGraph(spec, opts = {}) {
  const L = layoutGraph(spec, opts)
  const root = s('svg', { class: 'nd-svg nd-graph', viewBox: `0 0 ${L.width} ${L.height}`, role: 'img', 'aria-label': spec.title })
  const wires = s('g', { class: 'nd-links' })
  // Drawn like a flow map: out along the row, down its trunk, in at a right angle; a dot where each leaves.
  for (const k of L.links) {
    wires.append(s('path', { class: 'nd-link', 'data-id': k.from, 'data-to': k.to, d: `M${k.x1},${k.y1} H${k.tx} V${k.y2} H${k.x2} M${k.x2 - 5},${k.y2 - 3} L${k.x2},${k.y2} L${k.x2 - 5},${k.y2 + 3}` }))
    wires.append(s('circle', { class: 'nd-link-dot', 'data-id': k.from, cx: k.x1, cy: k.y1, r: 1.75 }))
  }
  root.append(wires)
  for (const n of L.nodes) {
    const g = door(s('g', { class: `nd-node nd-node-${n.role}` }), n.door)
    g.append(txt('title', {}, `${n.label}${n.value != null ? `, ${amount(n.value, n.unit)}` : ''}${n.note ? `\n${n.note}` : ''}`))
    g.append(s('rect', { class: `nd-bar nd-node-mark nd-${n.role}`, 'data-id': n.id, x: n.x, y: n.y + 5, width: 4, height: 12 }))
    g.append(txt('text', { class: 'nd-label nd-node-label', 'data-id': n.id, x: n.x + 12, y: n.y + 11 }, cut(n.label, n.w - 12)))
    root.append(g)
  }
  const base = focuser(root)
  // A lit node lights its wires, and the node at their other end stays readable.
  const focus = (ids) => {
    const hot = new Set(ids)
    for (const k of L.links) if (hot.has(k.from) || hot.has(k.to)) hot.add(`${k.from}>${k.to}`)
    base(hot)
    for (const w of wires.querySelectorAll('.nd-link')) w.classList.toggle('nd-hot', hot.has(`${w.getAttribute('data-id')}>${w.getAttribute('data-to')}`))
  }
  return { node: root, focus, layout: L }
}

/**
 * Stages: a sequence on a dashed spine, read top to bottom, each stage a node
 * on the spine with its number, name, note and tags standing out to one side,
 * the sides alternating. Narrow, every stage stands to the right.
 */
export function layoutStages(spec, { width = 1080 } = {}) {
  const narrow = width < 640
  const spine = narrow ? 28 : Math.round(width / 2)
  const pitch = 84
  const room = narrow ? width - spine - 40 : spine - 56
  const stages = spec.lanes.map((l, i) => {
    const right = narrow || i % 2 === 0
    return { id: l.id, label: l.label, note: l.note ?? '', tags: l.cells ?? [], door: l.door, ix: String(i + 1).padStart(2, '0'), y: 28 + i * pitch, right, x: right ? spine + 26 : spine - 26, room }
  })
  return { width, height: 28 + Math.max(1, stages.length) * pitch, spine, stages }
}

export function drawStages(spec, opts = {}) {
  const L = layoutStages(spec, opts)
  const root = s('svg', { class: 'nd-svg nd-stages', viewBox: `0 0 ${L.width} ${L.height}`, role: 'img', 'aria-label': spec.title })
  root.append(s('line', { class: 'nd-spine', x1: L.spine, x2: L.spine, y1: 8, y2: L.height - 8 }))
  for (const st of L.stages) {
    const g = door(s('g', { class: 'nd-stage' }), st.door)
    const anchor = st.right ? 'start' : 'end'
    const dx = st.right ? 1 : -1
    g.append(s('circle', { class: 'nd-stage-ring', 'data-id': st.id, cx: L.spine, cy: st.y, r: 7 }), s('circle', { class: 'nd-stage-dot', 'data-id': st.id, cx: L.spine, cy: st.y, r: 2.5 }))
    g.append(s('line', { class: 'nd-stage-arm', 'data-id': st.id, x1: L.spine + dx * 10, x2: st.x - dx * 4, y1: st.y, y2: st.y }))
    g.append(txt('text', { class: 'nd-stage-ix', 'data-id': st.id, x: st.x, y: st.y - 12, 'text-anchor': anchor }, st.ix))
    g.append(txt('text', { class: 'nd-label nd-stage-name', 'data-id': st.id, x: st.x, y: st.y + 1, 'text-anchor': anchor }, cut(st.label, st.room, 8.4)))
    if (st.note) g.append(txt('text', { class: 'nd-stage-note', 'data-id': st.id, x: st.x, y: st.y + 20, 'text-anchor': anchor }, cut(st.note, st.room)))
    // Tags as pills, laid along the row from the spine outward.
    let at = st.x
    for (const tag of st.tags) {
      const w = tag.length * 6.2 + 16
      const x = st.right ? at : at - w
      if (Math.abs(at - st.x) + w > st.room) break
      g.append(s('rect', { class: 'nd-stage-tag', 'data-id': st.id, x, y: st.y + 30, width: w, height: 17, rx: 8.5 }), txt('text', { class: 'nd-stage-tag-text', 'data-id': st.id, x: x + w / 2, y: st.y + 42, 'text-anchor': 'middle' }, tag))
      at += dx * (w + 6)
    }
    root.append(g)
  }
  return { node: root, focus: focuser(root), layout: L }
}

/** A table: the lane's label, then its cells, one row each. Flat: it is read. */
export function drawTable(spec) {
  const head = h('tr', {}, (spec.columns.length ? spec.columns : ['', 'Value']).map((c) => h('th', { text: c })))
  const rows = spec.lanes.map((l) => {
    const cells = l.cells ?? [amount(l.value, l.unit)]
    const name = door(h('td', { class: 'nd-cell-name', 'data-id': l.id, text: l.label, title: l.note ?? null }), l.door)
    return h('tr', { 'data-id': l.id, class: 'nd-trow' }, [name, ...cells.map((c) => h('td', { text: c }))])
  })
  const root = h('table', { class: 'nd-table' }, [h('thead', {}, [head]), h('tbody', {}, rows)])
  return { node: root, focus: focuser(root) }
}

/**
 * A rows figure drawn at its host's width, so one unit is one CSS pixel: drawn
 * again when the host's width changes by more than a few pixels, the last focus
 * replayed. A layout wider than its host (a narrow graph) scrolls sideways.
 */
export function fitted(draw) {
  return (spec) => {
    const node = h('div', { class: 'nd-fit' })
    let fig = null
    let width = 0
    let lit = []
    const paint = (w) => {
      width = w
      fig = draw(spec, { width: w })
      if (fig.layout?.width > w) fig.node.style.minWidth = `${fig.layout.width}px`
      node.replaceChildren(fig.node)
      fig.focus(...lit)
    }
    paint(720)
    const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width)
      if (w > 0 && Math.abs(w - width) >= 8) paint(w)
    }) : null
    sizes?.observe(node)
    return {
      node,
      focus: (...args) => {
        lit = args
        fig.focus(...args)
      },
      get layout() {
        return fig.layout
      },
      dispose: () => sizes?.disconnect(),
    }
  }
}
