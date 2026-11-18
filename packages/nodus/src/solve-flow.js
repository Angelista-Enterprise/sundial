// The fluid archetype's solver, in the xy plane, read left to right (or top to
// bottom, when that fills the plate better). A depth
// first walk from the sources turns every edge that closes a loop into a
// return pipe (it runs under the set); what is left is a DAG, layered by
// longest path, each layer ordered once by the barycenter of what feeds it. A
// tank's edge grows with the cube root of its volume, a pipe's width with the
// square root of its rate, so a big number does not swallow the picture.

const PITCH_X = 2.6
const PITCH_Y = 1.7
const SIZE = { source: 0.45, sink: 0.4, pump: 0.4, valve: 0.3, tank: 0.5, reservoir: 0.6 }
const round3 = (v) => Math.round(v * 1000) / 1000

export function solveFlow(lanes, links) {
  const held = (l) => ['tank', 'reservoir'].includes(l.kind)
  const maxV = Math.max(1, ...lanes.filter(held).map((l) => l.value ?? 0))
  const maxRate = Math.max(1, ...links.map((k) => k.rate ?? 1))
  const nodes = lanes.map((l) => {
    const grow = l.value != null && held(l) ? 0.45 + 0.85 * Math.cbrt(l.value / maxV) : 1
    return { id: l.id, kind: l.kind, label: l.label, state: l.state ?? null, x: 0, y: 0, z: 0, r: round3((SIZE[l.kind] ?? 0.4) * grow), layer: 0 }
  })
  const at = new Map(nodes.map((n) => [n.id, n]))
  const out = (id) => links.filter((k) => k.from === id && k.kind === 'flow')

  // Depth first from the sources (then anything unreached): an edge into a node on the stack is a back edge.
  const back = new Set()
  const state = new Map()
  const visit = (id) => {
    state.set(id, 1)
    for (const k of out(id)) {
      if (state.get(k.to) === 1) back.add(k)
      else if (!state.has(k.to)) visit(k.to)
    }
    state.set(id, 2)
  }
  for (const n of [...nodes.filter((n) => n.kind === 'source'), ...nodes]) if (!state.has(n.id)) visit(n.id)
  const forward = links.filter((k) => k.kind === 'flow' && !back.has(k))

  // Longest path layering: a node stands one layer past the furthest thing feeding it.
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false
    for (const k of forward) {
      const want = at.get(k.from).layer + 1
      if (at.get(k.to).layer < want) {
        at.get(k.to).layer = want
        moved = true
      }
    }
    if (!moved) break
  }
  const layers = []
  for (const n of nodes) (layers[n.layer] ??= []).push(n)
  const fed = (n) => forward.filter((k) => k.to === n.id).map((k) => at.get(k.from))
  // One barycenter pass: a node sits level with the mean of what feeds it.
  const order = (layer, coord) => {
    const rank = (n) => {
      const feeds = fed(n).map(coord)
      return feeds.length ? feeds.reduce((a, b) => a + b, 0) / feeds.length : 0
    }
    const keyed = layer.map((n, j) => [rank(n), j, n]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    layer.splice(0, layer.length, ...keyed.map((x) => x[2]))
  }
  // Read left to right when that fills a wide plate; a few layers of many parts (a day into its places) read top to bottom instead.
  const tall = Math.max(...layers.map((l) => l.length))
  const axis = (layers.length - 1) * PITCH_X >= (tall - 1) * PITCH_Y * 1.2 ? 'x' : 'y'
  if (axis === 'x') {
    layers.forEach((layer, i) => {
      if (i > 0) order(layer, (n) => n.y)
      layer.forEach((n, j) => {
        n.x = round3(i * PITCH_X)
        n.y = round3(((layer.length - 1) / 2 - j) * PITCH_Y)
      })
    })
  } else {
    // Rows, each as wide as its parts; a row of fewer parts spreads over the widest, and every part stands on its row's line.
    const GAP = 0.7
    const spanOf = (layer) => layer.reduce((n, p) => n + p.r * 2, 0) + GAP * (layer.length - 1)
    const widest = Math.max(...layers.map(spanOf))
    let base = 0
    layers.forEach((layer, i) => {
      if (i > 0) order(layer, (n) => n.x)
      const extra = layer.length > 1 ? (widest - spanOf(layer)) / (layer.length - 1) : 0
      let x = layer.length > 1 ? -widest / 2 : 0
      const tallest = Math.max(...layer.map((n) => n.r))
      for (const n of layer) {
        n.x = round3(layer.length > 1 ? x + n.r : 0)
        n.y = round3(base - tallest * 2 + n.r)
        x += n.r * 2 + GAP + extra
      }
      // Under a row run its pipes, one track per part that pours, so no two share a run.
      const pours = layer.filter((n) => forward.some((k) => k.from === n.id)).length
      base -= tallest * 2 + Math.max(1.8, 0.9 + 0.24 * pours)
    })
  }
  const floor = round3(Math.min(...nodes.map((n) => n.y - n.r)) - 0.6)
  const width = (k) => round3(0.03 + 0.07 * Math.sqrt((k.rate ?? 1) / maxRate))
  const right = Math.max(...nodes.map((n) => n.x + n.r))
  // Where along a part's side each of its pipes meets it: spread, in the order of what is at the other end.
  const spread = (n, list, other, room) => {
    const sorted = [...list].sort((a, b) => other(a) - other(b))
    return (k) => (sorted.length < 2 ? 0 : (sorted.indexOf(k) - (sorted.length - 1) / 2) * Math.min(0.16, room / sorted.length))
  }
  const outOf = new Map(nodes.map((n) => [n.id, spread(n, forward.filter((k) => k.from === n.id), (k) => (axis === 'x' ? -at.get(k.to).y : at.get(k.to).x), n.r * 1.4)]))
  const inOf = new Map(nodes.map((n) => [n.id, spread(n, forward.filter((k) => k.to === n.id), (k) => (axis === 'x' ? -at.get(k.from).y : at.get(k.from).x), n.r * 1.6)]))
  const pourers = nodes.filter((n) => forward.some((k) => k.from === n.id))
  const edges = links.map((k, i) => {
    const a = at.get(k.from)
    const b = at.get(k.to)
    const ret = back.has(k) || k.kind === 'return'
    let points
    if (ret) {
      // A return leaves to the right, runs round the set, and comes back in, each on its own track so two never share a run.
      const under = floor - 0.25 * (i % 4)
      const out = (axis === 'x' ? a.x + a.r + 0.35 : right + 0.5) + 0.15 * (i % 4)
      points = axis === 'x' ? [[a.x + a.r, a.y, 0], [out, a.y, 0], [out, under, 0], [b.x, under, 0], [b.x, b.y - b.r, 0]] : [[a.x + a.r, a.y, 0], [out, a.y, 0], [out, b.y, 0], [b.x + b.r, b.y, 0]]
    } else if (axis === 'x') {
      const mid = a.x + a.r + (b.x - b.r - a.x - a.r) * (0.5 + outOf.get(a.id)(k))
      points = [[a.x + a.r, a.y + outOf.get(a.id)(k), 0], [mid, a.y + outOf.get(a.id)(k), 0], [mid, b.y + inOf.get(b.id)(k), 0], [b.x - b.r, b.y + inOf.get(b.id)(k), 0]]
    } else {
      // Down from the part, along its own track, and down into the next: two elbows.
      const track = a.y - a.r - 0.45 - 0.22 * (pourers.indexOf(a) % 8)
      const x0 = a.x + outOf.get(a.id)(k)
      const x1 = b.x + inOf.get(b.id)(k)
      points = [[x0, a.y - a.r, 0], [x0, track, 0], [x1, track, 0], [x1, b.y + b.r, 0]]
    }
    return { from: k.from, to: k.to, kind: ret ? 'return' : k.kind, label: k.label ?? null, width: width(k), rate: k.rate ?? 1, points: points.map((p) => p.map(round3)) }
  })
  return { nodes, edges, floor: round3(floor - 1), axis }
}
