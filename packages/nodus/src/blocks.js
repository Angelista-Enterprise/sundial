// Composable blocks: a part's shape built from a few primitives, nested and
// attached at named ports, so a camera, a robot arm or a cell comes from
// mixing blocks rather than from new code. A model names the blocks, their
// sizes against their parent, where each attaches and how many; it never gives
// a position or a coordinate. This module is pure (no three.js): it checks a
// form and lays it out as placed primitives the kit turns into geometry.
//
//   { shape: 'cylinder', size: [1, 0.3, 1], parts: [
//       { shape: 'rod', at: 'top', size: 'l', parts: [{ shape: 'sphere', at: 'top', size: 's' }] },
//       { shape: 'box', at: 'inside', size: 'm', count: 3 } ] }

/** Each shape with its proportions (width, height, depth) when a size is one word, and whether it runs along an axis (turned to point out of a side port). */
export const BLOCKS = {
  box: { aspect: [1, 1, 1] },
  slab: { aspect: [1, 0.25, 1] },
  panel: { aspect: [1, 0.7, 0.06] },
  wedge: { aspect: [1, 0.6, 1] },
  rod: { aspect: [0.14, 1, 0.14], long: true },
  cylinder: { aspect: [0.6, 1, 0.6], long: true },
  capsule: { aspect: [0.4, 1, 0.4], long: true },
  cone: { aspect: [0.8, 1, 0.8], long: true },
  spring: { aspect: [0.4, 1, 0.4], long: true },
  disc: { aspect: [1, 0.12, 1] },
  gear: { aspect: [1, 0.2, 1] },
  ring: { aspect: [1, 0.1, 1] },
  torus: { aspect: [1, 0.3, 1] },
  sphere: { aspect: [1, 1, 1] },
  dome: { aspect: [1, 0.5, 1] },
  lens: { aspect: [0.6, 0.6, 0.18] },
}
/** Where a block attaches to its parent: the face, its outward normal, and the axis a row of several runs along. */
export const PORTS = { top: [0, 1, 0], bottom: [0, -1, 0], left: [-1, 0, 0], right: [1, 0, 0], front: [0, 0, 1], back: [0, 0, -1], inside: [0, 0, 0], around: [0, 0, 0], center: [0, 0, 0] }
const ROW_AXIS = { top: 0, bottom: 0, front: 0, back: 0, left: 2, right: 2 }
/** A size in one word, as a share of the whole object's largest side (so a chain of arms keeps its scale); three numbers are against the parent's sides. */
const SIZES = { xs: 0.18, s: 0.32, m: 0.5, l: 0.72, xl: 0.95 }
const MAX_BLOCKS = 64
const MAX_DEPTH = 5
const MAX_COUNT = 12

/**
 * A form as written, checked: unknown shapes become boxes, sizes and counts
 * are held to their ranges, depth and the total are capped. `problems` are
 * worded for a model to act on. Null when nothing usable is there.
 */
export function checkForm(input, problems = [], where = 'form') {
  let total = 0
  const walk = (b, depth, path) => {
    if (!b || typeof b !== 'object' || total >= MAX_BLOCKS || depth > MAX_DEPTH) return null
    const shape = BLOCKS[b.shape] ? b.shape : 'box'
    if (b.shape !== shape) problems.push(`${path}: shape "${b.shape}" is not one of ${Object.keys(BLOCKS).join(', ')}; drawn as a box`)
    const at = PORTS[b.at] ? b.at : depth === 0 ? 'center' : 'top'
    if (depth > 0 && b.at !== undefined && !PORTS[b.at]) problems.push(`${path}: at "${b.at}" is not one of ${Object.keys(PORTS).join(', ')}; put on top`)
    const size = Array.isArray(b.size) && b.size.length === 3 && b.size.every(Number.isFinite) ? b.size.map((v) => Math.min(3, Math.max(0.04, v))) : SIZES[b.size] ? b.size : 'm'
    const count = Number.isInteger(b.count) ? Math.min(MAX_COUNT, Math.max(1, b.count)) : 1
    total += count * (b.mirror === true ? 2 : 1)
    const parts = (Array.isArray(b.parts) ? b.parts : []).map((p, i) => walk(p, depth + 1, `${path}.parts[${i}]`)).filter(Boolean)
    return { shape, size, at, count, ...(b.mirror === true ? { mirror: true } : {}), ...(parts.length ? { parts } : {}) }
  }
  const out = walk(input, 0, where)
  if (total >= MAX_BLOCKS) problems.push(`${where}: at most ${MAX_BLOCKS} blocks in one form; the rest were dropped`)
  return out
}

const add = (a, b) => a.map((v, i) => v + b[i])
const mul = (a, k) => a.map((v) => v * k)

/** A block's own sides (width, height, depth) before it is turned: from its size, against the parent's sides (three numbers) or the whole's (one word). */
function sidesOf(b, parent, whole) {
  if (Array.isArray(b.size)) return parent ? b.size.map((v, i) => v * parent[i]) : b.size
  const a = BLOCKS[b.shape].aspect
  const top = Math.max(...a)
  const base = (whole ?? 2) * (SIZES[b.size] ?? 0.5)
  return a.map((v) => (v / top) * base)
}

/** Turned to point out of a side port, a long block lies along that axis: its height becomes the port's axis. */
function turn(sides, shape, at) {
  if (!BLOCKS[shape].long) return { sides, axis: 'y' }
  if (at === 'left' || at === 'right') return { sides: [sides[1], sides[0], sides[2]], axis: 'x' }
  if (at === 'front' || at === 'back') return { sides: [sides[0], sides[2], sides[1]], axis: 'z' }
  return { sides, axis: 'y' }
}

/**
 * A checked form laid out: every primitive with its centre, its sides (as
 * placed), its axis and its depth (0 the root). A child touches its parent at
 * its port; several spread along the face; `around` rings them about the
 * parent's height; `inside` sits them within it (drawn as the x-ray's inner
 * parts); `mirror` repeats them on the opposite port. The whole is scaled so
 * its largest side is `2r` and centred on the origin. Seeded by `rnd` only for
 * where several parts inside one fall.
 */
export function layoutForm(form, r = 1, rnd = Math.random) {
  const out = []
  const place = (b, center, sides, axis, depth, inner, tag = null) => {
    tag = b.tag ?? tag
    out.push({ shape: b.shape, center, sides, axis, depth, inner, tag, port: b.tag ? b.at : undefined })
    for (const c of b.parts ?? []) {
      for (const at of c.mirror ? [c.at, OPPOSITE[c.at] ?? c.at] : [c.at]) {
        const raw = sidesOf(c, sides, whole)
        const turned = turn(raw, c.shape, at)
        const ax = turned.axis
        // A part inside another fits within it.
        const s = at === 'inside' ? turned.sides.map((v, k) => Math.min(v, sides[k] * 0.8)) : turned.sides
        for (let i = 0; i < c.count; i++) {
          let pos
          if (at === 'inside' || at === 'center') {
            const spread = c.count > 1 && at === 'inside' ? sides.map((v, k) => (rnd() - 0.5) * Math.max(0, v - s[k]) * 0.8) : [0, 0, 0]
            pos = add(center, spread)
          } else if (at === 'around') {
            const a = (i / c.count) * Math.PI * 2
            const rad = Math.max(sides[0], sides[2]) / 2 + Math.max(s[0], s[2]) / 2
            pos = add(center, [Math.cos(a) * rad, 0, Math.sin(a) * rad])
          } else {
            const n = PORTS[at]
            pos = add(center, n.map((v, k) => v * (sides[k] / 2 + s[k] / 2)))
            if (c.count > 1) {
              const k = ROW_AXIS[at]
              const span = sides[k] * 0.8
              pos[k] += -span / 2 + (span * i) / (c.count - 1)
            }
          }
          place(c, pos, s, ax, depth + 1, inner || at === 'inside', tag)
        }
      }
    }
  }
  const root = sidesOf(form, null)
  const whole = Math.max(...root)
  place(form, [0, 0, 0], root, 'y', 0, false)
  // Centre and scale the whole into a part of radius r.
  const lo = [0, 1, 2].map((k) => Math.min(...out.map((p) => p.center[k] - p.sides[k] / 2)))
  const hi = [0, 1, 2].map((k) => Math.max(...out.map((p) => p.center[k] + p.sides[k] / 2)))
  const mid = lo.map((v, k) => (v + hi[k]) / 2)
  const k = (2 * r) / Math.max(1e-6, ...hi.map((v, i) => v - lo[i]))
  const r3 = (v) => Math.round(v * 1000) / 1000
  return out.map((p) => ({ ...p, center: mul(p.center.map((v, i) => v - mid[i]), k).map(r3), sides: mul(p.sides, k).map(r3) }))
}
const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left', front: 'back', back: 'front' }
