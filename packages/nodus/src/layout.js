// The timeline's geometry, as a pure function of a checked spec: no DOM, so it
// is tested in node and the SVG is a thin map over it.
//
// Every position here is the renderer's, never the model's. Labels go through
// one packer per lane, so two labels never overlap: a label that fits nowhere
// is left to the bar's hover title rather than drawn over its neighbour.

const HOUR = 3_600_000
// Lane heights by weight, scaled so the lanes fill the figure's height: a meeting lane carries its band and a row of names under it.
const WEIGHT = { meeting: 1.6, project: 1, break: 0.6 }
const LANE = [26, 64]
const GAP = 8
const AXIS = 26
const PAD = 20
/** Average advance of a 12px Inter Tight glyph, measured on the shell's own labels. */
const CHAR_W = 6.4

export const textWidth = (s) => String(s).length * CHAR_W

export function layoutTimeline(spec, { width = 1080, height = Math.round(Math.min(520, Math.max(240, width * 0.48))), gutter = Math.min(168, Math.max(96, Math.round(width * 0.24))) } = {}) {
  const t0 = Date.parse(spec.window.from)
  const t1 = Date.parse(spec.window.to)
  const x0 = gutter
  const x1 = width - PAD
  const x = (iso) => x0 + ((Date.parse(iso) - t0) / (t1 - t0)) * (x1 - x0)

  const hours = (t1 - t0) / HOUR
  // A labelled hour every 1, 2, 3 or 6 hours: as often as the hours read, never closer than an hour label's width.
  const every = [1, 2, 3, 6].find((k) => k >= (hours > 16 ? 3 : hours > 9 ? 2 : 1) && ((x1 - x0) / hours) * k >= 48) ?? 6
  const ticks = []
  for (let t = Math.ceil(t0 / HOUR) * HOUR; t <= t1; t += HOUR) {
    const hour = Math.round((t - t0) / HOUR)
    ticks.push({ x: x0 + ((t - t0) / (t1 - t0)) * (x1 - x0), at: new Date(t).toISOString(), major: hour % every === 0 })
  }

  const weights = spec.lanes.map((l) => WEIGHT[l.role] ?? WEIGHT.project)
  const unit = Math.min(LANE[1], Math.max(LANE[0], (height - AXIS - GAP * spec.lanes.length) / weights.reduce((a, b) => a + b, 0)))
  let y = AXIS
  const lanes = spec.lanes.map((l, i) => {
    const h = Math.round(unit * weights[i])
    const lane = { id: l.id, label: l.label, role: l.role, value: l.value ?? null, unit: l.unit ?? '', y, h }
    y += h + GAP
    return lane
  })
  const laneById = new Map(lanes.map((l) => [l.id, l]))

  const bars = spec.parts.map((p) => {
    const lane = laneById.get(p.lane)
    const a = x(p.from)
    const w = Math.max(2, x(p.to) - a)
    // Sessions sit inside their lane; a break fills it; a meeting's band takes the top, its name the row under it.
    if (p.role === 'meeting') return { id: p.id, role: p.role, lane: p.lane, mark: p.mark, label: p.label, x: a, w, y: lane.y, h: Math.round(lane.h * 0.5) }
    const inset = p.role === 'session' ? Math.round(lane.h * 0.22) : 0
    return { id: p.id, role: p.role, lane: p.lane, mark: p.mark, label: p.label, x: a, w, y: lane.y + inset, h: lane.h - inset * 2 }
  })

  // Meeting labels are always shown (there are few, and they are what a day is
  // planned around); session labels only on focus, placed by `tagFor`.
  const labels = []
  const taken = new Map()
  // Longest first, so the meeting that shaped the day keeps its name when two compete.
  for (const b of bars.filter((b) => b.role === 'meeting').sort((a, c) => c.w - a.w)) {
    const lane = laneById.get(b.lane)
    const spot = place(taken, b.lane, b, textWidth(b.label) + 10, x0, x1)
    if (spot) labels.push({ id: b.id, text: b.label, x: spot.x, y: lane.y + lane.h * 0.78 })
  }

  return { width, height: y + 4, gutter, x0, x1, ticks, lanes, bars, labels, cut: Math.max(4, Math.floor((gutter - 12) / 8.2)) }
}

/**
 * First free interval in a lane's name row for a label of width `w`: from the
 * band's start, then ending at its end, then nudged right past what is taken.
 * Null when nothing fits: the band's hover title still names it.
 */
function place(taken, lane, bar, w, x0, x1) {
  const used = taken.get(lane) ?? []
  const clear = (a) => a >= x0 && a + w <= x1 && !used.some(([u, v]) => a < v && a + w > u)
  const after = used.filter(([, v]) => v > bar.x).map(([, v]) => v + 4).sort((a, b) => a - b)
  const at = [bar.x, bar.x + bar.w - w, ...after].find(clear)
  if (at === undefined) return null
  used.push([at, at + w])
  taken.set(lane, used)
  return { x: at }
}

/** Where a focused session's label stands: above its bar, kept inside the plot. */
export function tagFor(bar, layout) {
  const w = textWidth(bar.label) + 10
  const x = Math.min(Math.max(bar.x, layout.x0), layout.x1 - w)
  return { x, y: bar.y - 4, w }
}
