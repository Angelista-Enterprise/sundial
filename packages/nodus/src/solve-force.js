// The orbital archetype's solver. The center at the origin; each body on a
// ring of its own, in the blueprint's order from the inside out, spread
// around by a fixed count of Fruchterman-Reingold rounds in the xz plane with
// a spring holding each body to its ring; moons on small circles around their
// body. Angular speed by Kepler's third law, so the outer ones move slower.
// Rings never cross: the gap between two is wider than anything inside it.

import { mulberry32 } from './rng.js'

const ROUNDS = 80
const round3 = (v) => Math.round(v * 1000) / 1000

export function solveForce(lanes, links, seed = 1) {
  const rnd = mulberry32(seed)
  const center = lanes.find((l) => l.kind === 'center') ?? lanes[0]
  // Bodies are sized against each other, not the center: a sun a third of a million times heavier would leave them specks.
  const max = Math.max(1e-9, ...lanes.filter((l) => l !== center).map((l) => l.value ?? 1))
  const parent = new Map(links.filter((k) => k.kind === 'orbit').map((k) => [k.from, k.to]))
  const size = (l) => (l === center ? 0.7 : l.kind === 'moon' ? 0.12 + 0.12 * Math.cbrt((l.value ?? 1) / max) : 0.16 + 0.4 * Math.cbrt((l.value ?? 1) / max))
  const nodes = lanes.map((l) => ({ id: l.id, kind: l.kind, label: l.label, state: l.state ?? null, x: 0, y: 0, z: 0, r: round3(size(l)), around: l === center ? null : parent.get(l.id) ?? center.id, orbit: 0, speed: 0, phase: 0 }))
  const at = new Map(nodes.map((n) => [n.id, n]))
  // A loop of orbits (two bodies round each other) reaches no center: such a body circles the center instead.
  for (const n of nodes) {
    let up = n.around
    for (let i = 0; up && up !== center.id && i < nodes.length; i++) up = at.get(up)?.around
    if (n.around && up !== center.id) n.around = center.id
  }
  const kids = (id) => nodes.filter((n) => n.around === id && n.kind !== 'ring')
  // How far each body's own family reaches from it: its moons' circles and a ring around it.
  const reach = (n) => kids(n.id).reduce((m, k, i) => Math.max(m, n.r + 0.35 + i * 0.3 + k.r), n.r * (nodes.some((x) => x.around === n.id && x.kind === 'ring') ? 1.7 : 1))
  const inner = nodes.filter((n) => n.around === center.id && n.kind !== 'ring')
  const gap = Math.max(1, ...inner.map((n) => 2 * reach(n) + 0.5))
  const c = at.get(center.id)
  inner.forEach((n, i) => {
    n.orbit = round3(c.r * 1.7 + 0.6 + gap / 2 + i * gap)
    const a = rnd() * Math.PI * 2
    n.x = Math.cos(a) * n.orbit
    n.z = Math.sin(a) * n.orbit
  })
  // Spread the bodies round the center: they push apart, their rings hold them.
  for (let k = 0; k < ROUNDS; k++) {
    const cool = 0.3 * (1 - k / ROUNDS)
    for (const a of inner) {
      let fx = 0
      let fz = 0
      for (const b of inner) {
        if (a === b) continue
        const dx = a.x - b.x
        const dz = a.z - b.z
        const d2 = Math.max(0.01, dx * dx + dz * dz)
        fx += (dx / d2) * gap
        fz += (dz / d2) * gap
      }
      const d = Math.hypot(a.x, a.z) || 1
      fx += (a.x / d) * (a.orbit - d)
      fz += (a.z / d) * (a.orbit - d)
      const f = Math.hypot(fx, fz) || 1
      a.x += (fx / f) * Math.min(f, cool * a.orbit)
      a.z += (fz / f) * Math.min(f, cool * a.orbit)
    }
  }
  for (const n of inner) {
    n.phase = Math.atan2(n.z, n.x)
    n.x = Math.cos(n.phase) * n.orbit
    n.z = Math.sin(n.phase) * n.orbit
    n.speed = 0.6 / Math.pow(n.orbit, 1.5)
  }
  // Moons and rings, outward from the center: placed once their body is.
  const done = new Set([center.id, ...inner.map((n) => n.id)])
  for (let pass = 0; pass < nodes.length && done.size < nodes.length; pass++) {
    for (const n of nodes) {
      if (done.has(n.id) || !done.has(n.around)) continue
      const p = at.get(n.around)
      if (n.kind === 'ring') {
        Object.assign(n, { x: p.x, y: p.y, z: p.z, r: round3(p.r * 1.7) })
      } else {
        const i = kids(p.id).indexOf(n)
        n.orbit = round3(p.r + 0.35 + i * 0.3)
        n.phase = (i * 2.4) % (Math.PI * 2)
        n.x = p.x + Math.cos(n.phase) * n.orbit
        n.y = p.y
        n.z = p.z + Math.sin(n.phase) * n.orbit
        n.speed = 1.2 / Math.pow(n.orbit, 1.5)
      }
      done.add(n.id)
    }
  }
  for (const n of nodes) {
    for (const k of ['x', 'y', 'z', 'orbit', 'phase']) n[k] = round3(n[k])
    n.speed = Math.round(n.speed * 1e6) / 1e6
    if (n.orbit) {
      const p = at.get(n.around)
      n.frame = { center: [p.x, p.y, p.z], radius: round3(n.orbit + n.r) }
    }
  }
  const edges = links.filter((k) => k.kind === 'tie').map((k) => ({ from: k.from, to: k.to, kind: k.kind, label: k.label ?? null, points: [[at.get(k.from).x, 0, at.get(k.from).z], [at.get(k.to).x, 0, at.get(k.to).z]] }))
  return { nodes, edges, floor: -1 }
}
