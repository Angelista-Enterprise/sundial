// Parts that stand on parts: the object archetype's solver, and the placement
// any archetype's part gets when it names another to stand on (`on`, `at`). A
// part touches its parent at the port; several on one port stand in a row
// along the face; `around` rings them; `inside` sits them within. Each part
// also carries the way it drifts when the set is pulled apart (`drift`): out
// along its port, further for each step from the body.

import { layoutForm, PORTS } from './blocks.js'

const ROW = { top: 0, bottom: 0, front: 0, back: 0, left: 2, right: 2, inside: 0, center: 0, around: 0 }
const r3 = (v) => Math.round(v * 1000) / 1000

/** Place every part that stands on another, parents first, from where the parents already stand. Mutates `nodes`. */
export function standOn(nodes, lanes, gap = 0.9) {
  const lane = new Map(lanes.map((l) => [l.id, l]))
  const at = new Map(nodes.map((n) => [n.id, n]))
  const kids = new Map()
  for (const n of nodes) {
    const l = lane.get(n.id)
    if (!l?.on || !at.has(l.on)) continue
    const key = `${l.on}|${l.at ?? 'top'}`
    kids.set(key, [...(kids.get(key) ?? []), n])
  }
  const done = new Set(nodes.filter((n) => !lane.get(n.id)?.on || !at.has(lane.get(n.id).on)).map((n) => n.id))
  for (const n of nodes) if (done.has(n.id)) n.drift ??= [0, 0, 0]
  for (let pass = 0; pass < nodes.length && done.size < nodes.length; pass++) {
    for (const [key, list] of kids) {
      const [pid, port] = key.split('|')
      if (!done.has(pid) || list.every((n) => done.has(n.id))) continue
      const p = at.get(pid)
      const nrm = PORTS[port] ?? PORTS.top
      list.forEach((n, i) => {
        let pos
        if (port === 'around') {
          const a = (i / list.length) * Math.PI * 2
          pos = [p.x + Math.cos(a) * (p.r + n.r), p.y, p.z + Math.sin(a) * (p.r + n.r)]
        } else if (port === 'inside' || port === 'center') {
          const a = (i / Math.max(1, list.length)) * Math.PI * 2
          const k = list.length > 1 ? p.r * 0.45 : 0
          pos = [p.x + Math.cos(a) * k, p.y + Math.sin(a) * k * 0.6, p.z]
        } else {
          pos = [p.x, p.y, p.z].map((v, k) => v + nrm[k] * (p.r + n.r) * 0.92)
          const k = ROW[port]
          pos[k] += (i - (list.length - 1) / 2) * n.r * 2.3
        }
        ;[n.x, n.y, n.z] = pos.map(r3)
        // Pulled apart: out along the port, on top of the parent's own drift; an inner part comes forward, out of its shell.
        const out = port === 'inside' || port === 'center' ? [0, 0, 1] : port === 'around' ? [pos[0] - p.x, 0, pos[2] - p.z].map((v) => v / Math.max(1e-6, Math.hypot(pos[0] - p.x, pos[2] - p.z))) : nrm
        n.drift = p.drift.map((v, k) => r3(v + out[k] * gap))
        // Which way it faces out of its parent: an arrow on a side points that way.
        n.dir = out
        done.add(n.id)
      })
    }
  }
  return nodes
}

/**
 * The object archetype: the whole thing as one block tree, each part's form
 * attached to its parent's at its port (blocks.js), laid out once so parts
 * touch and keep one scale, then split back into a node per part: its
 * centre, its reach, and its own primitives (`placed`) about that centre.
 * Bodies that stand on nothing stand side by side.
 */
export function solveObject(lanes, links, spec, rnd = Math.random) {
  const kids = new Map()
  for (const l of lanes) if (l.on) kids.set(l.on, [...(kids.get(l.on) ?? []), l])
  // A part that stands on a port stands on the outermost block there: on the disc that tops the base, not inside it.
  const outer = (b, port) => {
    const last = (b.parts ?? []).filter((c) => c.at === port && !c.tag).at(-1)
    return last ? outer(last, port) : b
  }
  const tree = (l) => {
    const own = l.form ?? { shape: 'box', size: l.on ? 's' : 'l', at: 'center', count: 1 }
    const b = structuredClone({ ...own, count: 1, mirror: undefined, at: l.on ? l.at ?? 'top' : 'center', tag: l.id })
    for (const k of kids.get(l.id) ?? []) {
      const host = outer(b, k.at ?? 'top')
      host.parts = [...(host.parts ?? []), tree(k)]
    }
    return b
  }
  const roots = lanes.filter((l) => !l.on)
  // Several bodies: one tree, each body on an invisible spine, side by side.
  const whole = roots.length === 1 ? tree(roots[0]) : { shape: 'box', size: [0.01, 0.01, 0.01], tag: '_', parts: roots.map((l, i) => ({ ...tree(l), at: i % 2 ? 'left' : 'right' })) }
  const prims = layoutForm(whole, 2.4, rnd).filter((p) => p.tag !== '_')
  const nodes = lanes.map((l) => {
    const mine = prims.filter((p) => p.tag === l.id)
    const lo = [0, 1, 2].map((k) => Math.min(...mine.map((p) => p.center[k] - p.sides[k] / 2)))
    const hi = [0, 1, 2].map((k) => Math.max(...mine.map((p) => p.center[k] + p.sides[k] / 2)))
    const c = lo.map((v, k) => r3((v + hi[k]) / 2))
    return { id: l.id, kind: 'part', label: l.label, state: l.state ?? null, x: c[0], y: c[1], z: c[2], r: r3(Math.max(0.12, ...hi.map((v, k) => (v - lo[k]) / 2))), placed: mine.map((p) => ({ ...p, center: p.center.map((v, k) => r3(v - c[k])) })) }
  })
  // Pulled apart: each part out along its port, further for each step from its body; an inner part comes forward.
  const at = new Map(nodes.map((n) => [n.id, n]))
  const byId = new Map(lanes.map((l) => [l.id, l]))
  const drift = (l) => {
    const n = at.get(l.id)
    if (n.drift) return n.drift
    if (!l.on) return (n.drift = [0, 0, 0])
    const out = l.at === 'inside' || l.at === 'center' ? [0, 0, 1] : l.at === 'around' ? [n.x, 0, n.z].map((v) => v / Math.max(1e-6, Math.hypot(n.x, n.z))) : PORTS[l.at ?? 'top']
    return (n.drift = drift(byId.get(l.on)).map((v, k) => r3(v + out[k] * 0.7)))
  }
  for (const l of lanes) drift(l)
  const edges = links.filter((k) => at.has(k.from) && at.has(k.to)).map((k) => ({ from: k.from, to: k.to, kind: k.kind, label: k.label ?? null, points: [[at.get(k.from).x, at.get(k.from).y, at.get(k.from).z], [at.get(k.to).x, at.get(k.to).y, at.get(k.to).z]] }))
  return { nodes, edges, floor: Math.min(...nodes.map((n) => n.y - n.r)) - 0.2 }
}
