// The system archetype's solver: the lab's arc. Parts that have a place in
// any picture of weather or light take it (the sun up and to the left, the
// cloud overhead, the ground under everything, the one watching to the
// right); the rest stand left to right on a gentle arc in the middle. A second
// sun or cloud has no slot left and joins the arc.

/** Where a kind stands when it has a slot: x, y, z. */
const SLOTS = {
  sun: [-3.2, 2.8, -2],
  cloud: [0.4, 2.4, -1],
  rain: [0.4, 0.6, -1],
  rainbow: [2.6, -2, -3],
  ground: [0, -2, 0],
  observer: [4.2, -2, 1],
  light: [-2.4, 1.6, -1],
  contour: [0, -1.6, 0],
}
/** A building's floors: one column, bottom first in the blueprint's order, each this far above the last. */
const FLOOR = 0.95
/** A part's radius by kind, scaled by its value against the largest in the scene. */
const BASE = { contour: 2.6, field: 1.3, stack: 1.7, ground: 4, rainbow: 2.6, rain: 1.6, cloud: 1.2, sun: 0.55, observer: 0.7, plane: 1.2, light: 0.4, ray: 0.4, arrow: 0.4, orbit: 1.4 }

export function solveArc(lanes, links) {
  const max = Math.max(1, ...lanes.map((l) => l.value ?? 1))
  const taken = new Set()
  const nodes = []
  const arc = []
  const stacks = []
  for (const l of lanes) {
    const r = (BASE[l.kind] ?? 0.7) * (l.value ? 0.6 + 0.4 * Math.cbrt(l.value / max) : 1)
    const node = { id: l.id, kind: l.kind, label: l.label, state: l.state ?? null, shape: l.shape ?? null, x: 0, y: 0, z: 0, r: Math.round(r * 1000) / 1000 }
    if (l.kind === 'stack') {
      stacks.push(node)
      // On its ground when it has one: the contour's top is a little over its middle.
      node.y = (lanes.some((x) => x.kind === 'contour') ? -0.75 : -1.4) + (stacks.length - 1) * FLOOR
      // Floors share one footprint, the widest's, so the building stands straight.
    } else if (SLOTS[l.kind] && !taken.has(l.kind)) {
      taken.add(l.kind)
      ;[node.x, node.y, node.z] = SLOTS[l.kind]
    } else arc.push(node)
    nodes.push(node)
  }
  const n = arc.length
  const pitch = Math.max(1.7, ...arc.map((a) => a.r * 2 + 0.6))
  const foot = Math.max(0, ...stacks.map((f) => f.r))
  for (const f of stacks) f.r = foot
  // Beside a building, the rest stand to its right.
  const shift = stacks.length ? foot + 1.2 + ((n - 1) / 2) * pitch : 0
  arc.forEach((a, i) => {
    a.x = (i - (n - 1) / 2) * pitch + shift
    a.y = Math.sin((i / Math.max(1, n - 1)) * Math.PI) * 0.6 - 0.3
  })
  const at = new Map(nodes.map((d) => [d.id, d]))
  const edges = links.map((k) => {
    const a = at.get(k.from)
    const b = at.get(k.to)
    return { from: k.from, to: k.to, kind: k.kind, label: k.label ?? null, points: [[a.x, a.y, a.z], [b.x, b.y, b.z]] }
  })
  return { nodes, edges, floor: Math.min(-2, ...nodes.map((d) => d.y - d.r)) }
}
