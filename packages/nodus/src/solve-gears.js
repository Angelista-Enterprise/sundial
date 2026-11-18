// The mechanism archetype's solver, in the xy plane (the set faces the
// camera). A gear's pitch radius comes from its teeth; the train is laid out
// breadth first from the driving gear, each gear tangent to the one it meshes
// with at the first angle of a fixed fan where it touches nothing else. A gear
// meshing with two placed gears sits where both circles meet. Each mesh flips
// the spin and interleaves the teeth; a belt keeps the spin and stands at
// three radii. Parts that are not gears stand beside what pushes them.

export const MODULE = 0.1
const ADD = MODULE // a tooth reaches this far past the pitch circle
const FAN = Array.from({ length: 24 }, (_, i) => (i % 2 ? -1 : 1) * Math.ceil(i / 2) * (Math.PI / 12))
const SIZE = { shaft: 0.15, crank: 0.4, lever: 0.6, piston: 0.4, belt: 0.3 }
const round3 = (v) => Math.round(v * 1000) / 1000

export function solveGears(lanes, links) {
  const nodes = lanes.map((l) => {
    const gear = l.kind === 'gear'
    const teeth = gear ? l.value ?? 12 : 0
    return { id: l.id, kind: l.kind, label: l.label, state: l.state ?? null, x: 0, y: 0, z: 0, r: gear ? (teeth * MODULE) / 2 : SIZE[l.kind] ?? 0.4, teeth, spin: 0, speed: 0, phase: 0 }
  })
  const at = new Map(nodes.map((n) => [n.id, n]))
  const near = (id) => links.filter((k) => k.from === id || k.to === id).map((k) => ({ k, other: at.get(k.from === id ? k.to : k.from) }))
  const outer = (n) => n.r + (n.kind === 'gear' ? ADD : 0)
  const placed = []
  const meshed = (a, b) => links.some((k) => k.kind === 'mesh' && ((k.from === a.id && k.to === b.id) || (k.from === b.id && k.to === a.id)))
  const clear = (n, x, y) => placed.every((p) => (meshed(n, p) ? Math.abs(Math.hypot(p.x - x, p.y - y) - (p.r + n.r)) < 1e-6 : Math.hypot(p.x - x, p.y - y) >= outer(p) + outer(n) + 0.12))
  const distance = (k, a, b) => (k.kind === 'mesh' ? a.r + b.r : k.kind === 'belt' ? 3 * Math.max(a.r, b.r) : outer(a) + outer(b) + 0.4)
  const put = (n, x, y) => {
    n.x = x
    n.y = y
    placed.push(n)
  }

  const order = [...nodes.filter((n) => n.state === 'driving'), ...nodes.filter((n) => n.state !== 'driving')]
  for (const root of order) {
    if (placed.includes(root)) continue
    // A new train starts to the right of everything placed.
    const right = placed.length ? Math.max(...placed.map((p) => p.x + outer(p))) : 0
    put(root, placed.length ? right + outer(root) + 0.8 : 0, 0)
    Object.assign(root, { spin: root.state === 'locked' ? 0 : 1, speed: 1 })
    const queue = [root]
    while (queue.length) {
      const a = queue.shift()
      for (const { k, other: b } of near(a.id)) {
        if (placed.includes(b)) continue
        const want = distance(k, a, b)
        let spot = null
        // Two placed partners in mesh: where both pitch circles meet, if that is clear.
        const second = near(b.id).find(({ k: k2, other }) => other !== a && placed.includes(other) && k2.kind === 'mesh' && k.kind === 'mesh')?.other
        if (second) {
          const d = Math.hypot(second.x - a.x, second.y - a.y)
          const r1 = a.r + b.r
          const r2 = second.r + b.r
          const along = (d * d + r1 * r1 - r2 * r2) / (2 * d)
          const h = Math.sqrt(Math.max(0, r1 * r1 - along * along))
          if (d > 0 && h > 0) {
            for (const s of [1, -1]) {
              const x = a.x + (along * (second.x - a.x)) / d - (s * h * (second.y - a.y)) / d
              const y = a.y + (along * (second.y - a.y)) / d + (s * h * (second.x - a.x)) / d
              if (!spot && clear(b, x, y)) spot = [x, y]
            }
          }
        }
        for (const angle of FAN) {
          if (spot) break
          const x = a.x + Math.cos(angle) * want
          const y = a.y + Math.sin(angle) * want
          if (clear(b, x, y)) spot = [x, y]
        }
        // Nothing clear on the fan: further out on its first angle, until clear (a push or belt only, a mesh must touch).
        for (let far = want; !spot; far += 0.5) {
          if (k.kind === 'mesh' && far > want) {
            const right = Math.max(...placed.map((p) => p.x + outer(p)))
            spot = [right + outer(b) + 0.8, 0]
            break
          }
          if (clear(b, a.x + far, a.y)) spot = [a.x + far, a.y]
        }
        put(b, ...spot)
        const alpha = Math.atan2(b.y - a.y, b.x - a.x)
        if (k.kind === 'mesh' && Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - (a.r + b.r)) < 1e-6) {
          b.spin = -a.spin
          b.speed = (a.speed * a.teeth) / b.teeth
          // Teeth interleave at the contact point: a tooth of one sits in a gap of the other.
          b.phase = alpha + Math.PI - Math.PI / b.teeth + ((alpha - a.phase) * a.teeth) / b.teeth
        } else {
          b.spin = a.spin
          b.speed = k.kind === 'belt' ? (a.speed * a.r) / b.r : a.speed
        }
        queue.push(b)
      }
    }
  }
  for (const n of nodes) for (const k of ['x', 'y', 'r', 'speed', 'phase']) n[k] = round3(n[k])
  const edges = links.filter((k) => k.kind !== 'mesh').map((k) => {
    const a = at.get(k.from)
    const b = at.get(k.to)
    return { from: k.from, to: k.to, kind: k.kind, label: k.label ?? null, points: [[a.x, a.y, 0], [b.x, b.y, 0]] }
  })
  return { nodes, edges, floor: Math.min(...nodes.map((n) => n.y - outer(n))) - 0.4 }
}
