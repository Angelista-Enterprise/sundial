// The route archetype's solver: a way through places seen from above, on the
// ground (the xz plane). Stops stand in the order the legs chain them (else
// the blueprint's). With lat and lon for every stop the plan is a map,
// projected flat and scaled to fit; without, each stop stands its `value` in
// km past the one before (spaced by its square root, so a short walk beside a
// long ride still shows), on a gently bending line whose bends are seeded. A
// leg is a node too (its label, at its middle), so the margin names it.

import { mulberry32 } from './rng.js'

const SPAN = 9
const round3 = (v) => Math.round(v * 1000) / 1000

export function solveRoute(lanes, links, seed = 1) {
  const rnd = mulberry32(seed)
  const legs = links.filter((k) => k.kind === 'leg')
  // The chain: from the start (or a stop no leg reaches), along the legs; anything left after.
  const next = new Map(legs.map((k) => [k.from, k.to]))
  const reached = new Set(legs.map((k) => k.to))
  const first = lanes.find((l) => l.kind === 'start') ?? lanes.find((l) => !reached.has(l.id) && next.has(l.id)) ?? lanes[0]
  const order = []
  for (let id = first?.id; id && !order.includes(id); id = next.get(id)) order.push(id)
  for (const l of lanes) if (!order.includes(l.id)) order.push(l.id)
  const byId = new Map(lanes.map((l) => [l.id, l]))
  const stops = order.map((id) => byId.get(id))
  let pts
  if (stops.every((l) => l.lat !== undefined)) {
    const lat0 = stops.reduce((n, l) => n + l.lat, 0) / stops.length
    const raw = stops.map((l) => [l.lon * Math.cos((lat0 * Math.PI) / 180), -l.lat])
    const lo = [0, 1].map((i) => Math.min(...raw.map((p) => p[i])))
    const hi = [0, 1].map((i) => Math.max(...raw.map((p) => p[i])))
    const k = SPAN / Math.max(1e-9, hi[0] - lo[0], hi[1] - lo[1])
    pts = raw.map(([x, z]) => [(x - (lo[0] + hi[0]) / 2) * k, (z - (lo[1] + hi[1]) / 2) * k])
  } else {
    // By distance: a line that bends a little at each stop, never doubling back.
    const total = stops.slice(1).reduce((n, l) => n + Math.sqrt(Math.max(0.1, l.value ?? 1)), 0) || 1
    let heading = 0
    let at = [0, 0]
    pts = stops.map((l, i) => {
      if (i > 0) {
        const d = (Math.sqrt(Math.max(0.1, l.value ?? 1)) / total) * SPAN
        heading = Math.max(-1, Math.min(1, heading + (rnd() - 0.5) * 1.1))
        at = [at[0] + Math.cos(heading) * d, at[1] + Math.sin(heading) * d]
      }
      return at
    })
    const mid = [0, 1].map((i) => (Math.min(...pts.map((p) => p[i])) + Math.max(...pts.map((p) => p[i]))) / 2)
    pts = pts.map((p) => [p[0] - mid[0], p[1] - mid[1]])
  }
  const nodes = stops.map((l, i) => ({ id: l.id, kind: l.kind, label: l.label, state: l.state ?? null, x: round3(pts[i][0]), y: 0, z: round3(pts[i][1]), r: l.kind === 'turn' ? 0.12 : 0.22, order: i }))
  const edges = []
  const count = nodes.length
  for (let i = 0; i + 1 < count; i++) {
    const [a, b] = [nodes[i], nodes[i + 1]]
    const leg = legs.find((k) => k.from === a.id && k.to === b.id) ?? legs.find((k) => k.from === b.id && k.to === a.id)
    edges.push({ from: a.id, to: b.id, kind: 'leg', label: leg?.label ?? null, rate: leg?.rate ?? null, points: [[a.x, 0, a.z], [b.x, 0, b.z]] })
    // The leg's own label stands at its middle, so the margin can name it.
    const said = leg?.label ?? (leg?.rate != null ? `${leg.rate} min` : null)
    if (said) nodes.push({ id: `leg:${a.id}>${b.id}`, kind: 'leg', label: said, state: null, x: round3((a.x + b.x) / 2), y: 0, z: round3((a.z + b.z) / 2), r: 0.08 })
  }
  return { nodes, edges, floor: -0.5 }
}
