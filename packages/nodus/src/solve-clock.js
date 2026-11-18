// The clock archetype's solver, on a dial face on (the xy plane): a day of 24
// hours or a week of 168, midnight (or Monday) at the top, time running
// clockwise. Each event is an arc on a ring; events that overlap take rings
// further out, first come first ringed, so no two arcs share a stretch of one
// ring. A marker sits on the rim at its hour; a hand points at its hour.

const R = 2.2
const RING = 0.34
const round3 = (v) => Math.round(v * 1000) / 1000
/** The angle of an hour on a dial of `span` hours: 0 at the top, clockwise. */
const angleOf = (h, span) => Math.PI / 2 - (h / span) * Math.PI * 2

export function solveClock(lanes) {
  const dial = lanes.find((l) => l.kind === 'dial')
  const span = dial?.shape === 'week' ? 168 : 24
  // Rings, greedily: an event takes the first ring whose last arc ended before it starts.
  const ends = []
  const ringOf = new Map()
  for (const l of [...lanes.filter((x) => x.kind === 'event')].sort((a, b) => a.start - b.start || a.end - b.end)) {
    let k = ends.findIndex((e) => e <= l.start)
    if (k < 0) k = ends.push(-Infinity) - 1
    ends[k] = l.end
    ringOf.set(l.id, k)
  }
  const outer = R + Math.max(1, ends.length) * RING
  const nodes = lanes.map((l) => {
    const base = { id: l.id, kind: l.kind, label: l.label, state: l.state ?? null, shape: l.shape ?? null, z: 0, span }
    // The dial frames as far as its ticks reach.
    if (l.kind === 'dial') return { ...base, x: 0, y: 0, r: round3(outer + 0.45), inner: round3(R - 0.1), outer: round3(outer), rings: Math.max(1, ends.length) }
    if (l.kind === 'event') {
      const r0 = R + ringOf.get(l.id) * RING
      const mid = angleOf((l.start + l.end) / 2, span)
      const rm = r0 + RING / 2
      return { ...base, x: round3(Math.cos(mid) * rm), y: round3(Math.sin(mid) * rm), r: RING / 2, arc: { r0: round3(r0 + 0.03), r1: round3(r0 + RING - 0.03), a0: round3(angleOf(l.start, span)), a1: round3(angleOf(l.end, span)) } }
    }
    const a = angleOf(l.start, span)
    const rr = l.kind === 'hand' ? R * 0.55 : outer + 0.12
    return { ...base, x: round3(Math.cos(a) * rr), y: round3(Math.sin(a) * rr), r: 0.12, angle: round3(a) }
  })
  const edges = []
  return { nodes, edges, floor: round3(-outer - 0.5) }
}
