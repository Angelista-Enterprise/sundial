// The plan archetype's solver: rooms packed into one rectangle by area, as a
// floor plan seen from above (the xz plane), the largest room first; slice and
// dice by turns, so every room is a rectangle and the plan has no gaps. Each
// device stands inside the room its `in` link names, on a small grid. Rooms
// marked adjacent are not yet placed side by side: the packing reads areas
// only (a later pass may swap rooms to honour adjacency).

const SIDE = 7
const round3 = (v) => Math.round(v * 1000) / 1000

/** Pack areas into the rectangle (x, z, w, d), alternating the cut; returns a rect per area, in order. */
function slice(items, x, z, w, d, across = w >= d) {
  if (items.length === 1) return [{ ...items[0], x, z, w, d }]
  const total = items.reduce((n, it) => n + it.area, 0)
  let k = 0
  let acc = 0
  while (k < items.length - 1 && acc + items[k].area <= total / 2) acc += items[k++].area
  if (k === 0) acc = items[k++].area
  const f = acc / total
  return across
    ? [...slice(items.slice(0, k), x, z, w * f, d, !across), ...slice(items.slice(k), x + w * f, z, w * (1 - f), d, !across)]
    : [...slice(items.slice(0, k), x, z, w, d * f, !across), ...slice(items.slice(k), x, z + d * f, w, d * (1 - f), !across)]
}

export function solvePlan(lanes, links) {
  const rooms = lanes.filter((l) => l.kind === 'room').map((l) => ({ id: l.id, area: Math.max(1, l.value ?? 10) })).sort((a, b) => b.area - a.area)
  const total = rooms.reduce((n, r) => n + r.area, 0)
  const w = SIDE * Math.sqrt(1.5)
  const d = (SIDE * SIDE) / w
  const rects = new Map(slice(rooms, -w / 2, -d / 2, w, d).map((r) => [r.id, r]))
  const nodes = []
  for (const l of lanes.filter((x) => x.kind === 'room')) {
    const r = rects.get(l.id)
    nodes.push({ id: l.id, kind: 'room', label: l.label, state: l.state ?? null, x: round3(r.x + r.w / 2), y: 0, z: round3(r.z + r.d / 2), r: round3(Math.min(r.w, r.d) / 2), w: round3(r.w), d: round3(r.d), area: Math.round((r.area / total) * 1000) / 1000 })
  }
  const at = new Map(nodes.map((n) => [n.id, n]))
  const inRoom = new Map()
  for (const dev of lanes.filter((x) => x.kind === 'device')) {
    const room = at.get(links.find((k) => k.kind === 'in' && k.from === dev.id)?.to) ?? nodes[0]
    const list = inRoom.get(room.id) ?? []
    list.push(dev)
    inRoom.set(room.id, list)
  }
  for (const [id, devs] of inRoom) {
    const room = at.get(id)
    const cols = Math.ceil(Math.sqrt(devs.length))
    const rows = Math.ceil(devs.length / cols)
    devs.forEach((dev, i) => {
      const cx = room.x - room.w / 2 + ((i % cols) + 0.5) * (room.w / cols)
      const cz = room.z - room.d / 2 + (Math.floor(i / cols) + 0.5) * (room.d / rows)
      nodes.push({ id: dev.id, kind: 'device', label: dev.label, state: dev.state ?? null, x: round3(cx), y: 0.15, z: round3(cz), r: 0.14, room: id })
    })
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges = links.filter((k) => k.kind === 'adjacent' && byId.has(k.from) && byId.has(k.to)).map((k) => ({ from: k.from, to: k.to, kind: 'adjacent', label: null, points: [[byId.get(k.from).x, 0.02, byId.get(k.from).z], [byId.get(k.to).x, 0.02, byId.get(k.to).z]] }))
  return { nodes, edges, floor: -0.5 }
}
