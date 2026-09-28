// The day dial.
//
// Authored against the same 1000×150 plate as the design's Dial.swift (kept
// verbatim in ../design/, and pinned by palette.test.js), so the drawing and
// the design cannot drift apart. The figure the host serves carries no project
// band or break notches, so those two layers of the original are simply ABSENT
// here rather than faked from what is available — a dial that invents a layer
// is worse than one that admits it has fewer.
import { el, svg } from './surfaces.js'

export const PLATE_W = 1000
export const PLATE_H = 150
export const BASELINE_Y = 130
export const CURVE_TOP_Y = 18
export const DEEP_Y = 132
export const DEEP_H = 6
export const BAND_Y = 141
export const BAND_H = 5

/**
 * The strip renders the 150-unit plate into 82 CSS pixels, so a plate unit is a
 * bit over half a pixel. Anything authored as a hairline — the baseline
 * especially — lands below one device pixel and disappears.
 *
 * Expressed as the plate units that survive the scale rather than as pixels, so
 * the geometry above stays the single authority for WHERE things sit.
 */
const RENDER_SCALE = 82 / PLATE_H
const units = (px) => px / RENDER_SCALE
const BASELINE_H = units(1)

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * `energyCurve.score` is an INTEGER 0…100, not a fraction — the same conversion
 * DialModel.swift does at its own boundary. Treating it as a fraction clamps
 * every hour to full height and draws the day as one solid block, which is
 * exactly what it looked like before this existed.
 */
export const ENERGY_FULL_SCALE = 100
export const energyFraction = (score) => clamp01((Number(score) || 0) / ENERGY_FULL_SCALE)

/**
 * The height that fraction is DRAWN at. A display transform, not a second
 * definition of the score.
 *
 * 0–100 is the score's honest range and 100 is reachable in principle: an hour
 * of unbroken, heavily-typed work scores near it. No real hour goes there.
 * Measured over this machine's own record, hourly scores run about 2 to 33 —
 * because `computeFocusScore` is duration-led and this owner's moments are
 * short, which is a true fact about the day and not a bug in the score. Drawn
 * linearly, every day on the plate is therefore the same flat line at the
 * bottom, and a curve that is flat for everyone on every day says nothing.
 *
 * The square root spends the plate where the variation actually is. It is
 * strictly monotonic, so no two hours ever swap places and the shape of the day
 * is the shape of the data; it never clamps, so an exceptional hour still has
 * somewhere to go; and it is one fixed transform, so two days stay comparable —
 * the thing per-day normalisation would have destroyed. On the numbers above a
 * quiet hour lands near a seventh of the plate and a strong one near half.
 *
 * What keeps this honest rather than flattering is the hover: every sampled
 * hour carries its true score in a tooltip (`energy 10 of 100`), so the exact
 * value is one pointer away from the shape.
 */
export const plateFraction = (score) => Math.sqrt(energyFraction(score))

const clampHour = (hour, from, to) => (hour < from ? from : hour > to ? to : hour)

/** `13.25` → `13:15`. Fractional hours are how the figure carries a clock time. */
const hhmm = (hour) => `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`

/** Hour → plate x, on the figure's own window rather than a fixed 0–24. */
function makeScale(fromHour, toHour) {
  const span = Math.max(0.0001, toHour - fromHour)
  return (hour) => ((clampHour(hour, fromHour, toHour) - fromHour) / span) * PLATE_W
}

/**
 * The attention curve as one smoothed path.
 *
 * Quadratic segments through the midpoints of the sample polyline: the curve is
 * a DERIVED quantity, and a hard polyline would claim the samples are the shape
 * rather than evidence for it.
 */
function curvePath(points, x, closed) {
  if (points.length < 2) return ''
  const pt = (p) => [x(p.hour), BASELINE_Y - plateFraction(p.score) * (BASELINE_Y - CURVE_TOP_Y)]
  const first = pt(points[0])
  let d = `M ${first[0].toFixed(2)} ${first[1].toFixed(2)}`
  for (let i = 1; i < points.length; i += 1) {
    const [px, py] = pt(points[i - 1])
    const [cx, cy] = pt(points[i])
    d += ` Q ${px.toFixed(2)} ${py.toFixed(2)} ${((px + cx) / 2).toFixed(2)} ${((py + cy) / 2).toFixed(2)}`
  }
  const last = pt(points[points.length - 1])
  d += ` L ${last[0].toFixed(2)} ${last[1].toFixed(2)}`
  if (closed) d += ` L ${last[0].toFixed(2)} ${BASELINE_Y} L ${first[0].toFixed(2)} ${BASELINE_Y} Z`
  return d
}

function hourLabels(fromHour, toHour, x) {
  const labels = []
  const step = toHour - fromHour > 12 ? 3 : 2
  for (let hour = Math.ceil(fromHour / step) * step; hour <= toHour; hour += step) {
    labels.push(
      svg(
        'text',
        {
          x: x(hour),
          y: PLATE_H - 2,
          fill: 'var(--ink-faint)',
          'font-size': 15,
          'text-anchor': hour === toHour ? 'end' : hour === fromHour ? 'start' : 'middle',
          style: 'letter-spacing:0.04em',
        },
        [String(hour).padStart(2, '0')],
      ),
    )
  }
  return labels
}

/** The plate: curve, shadow, baseline, observed work, meetings, and the gnomon. */
export function dialPlate(figure) {
  const x = makeScale(figure.fromHour, figure.toHour)
  const now = typeof figure.nowHour === 'number' ? figure.nowHour : null
  const curve = Array.isArray(figure.curve) ? figure.curve : []
  const layers = []

  if (curve.length > 1) {
    layers.push(svg('path', { d: curvePath(curve, x, true), fill: 'var(--panel)' }))
    layers.push(svg('path', { d: curvePath(curve, x, false), fill: 'none', stroke: 'var(--ochre)', 'stroke-width': 2, 'stroke-linejoin': 'round' }))
  }

  // The shadow over the hours that cannot be known yet. Never filled in and
  // never truncated: it is a claim about evidence, not a progress bar.
  if (now !== null) {
    layers.push(svg('rect', { x: x(now), y: 0, width: Math.max(0, PLATE_W - x(now)), height: BASELINE_Y, fill: 'var(--wash)' }))
  }

  layers.push(svg('rect', { x: 0, y: BASELINE_Y, width: PLATE_W, height: BASELINE_H, fill: 'var(--ink)' }))

  // Observed work sits under the baseline in ink; a meeting is a navy hairline
  // through the whole plate.
  for (const block of figure.deepBlocks ?? []) {
    layers.push(svg('rect', { x: x(block.startHour), y: DEEP_Y, width: Math.max(1, x(block.endHour) - x(block.startHour)), height: DEEP_H, fill: 'var(--ink)' }))
  }
  for (const meeting of figure.meetings ?? []) {
    layers.push(svg('rect', { x: x(meeting.startHour) - 1.5, y: 0, width: 3, height: BASELINE_Y, fill: 'var(--navy)', opacity: 0.55 }))
    layers.push(
      svg('rect', {
        x: x(meeting.startHour),
        y: BAND_Y,
        width: Math.max(1, x(meeting.endHour) - x(meeting.startHour)),
        height: BAND_H,
        fill: 'var(--navy)',
        opacity: 0.55,
      }),
    )
  }

  // The gnomon: the shadow-casting edge, and the only thing on the plate that
  // moves. Line and base are one group so they cannot desync.
  if (now !== null) {
    layers.push(
      svg('g', {}, [
        svg('rect', { x: x(now) - units(1), y: CURVE_TOP_Y - 8, width: units(2), height: BASELINE_Y - CURVE_TOP_Y + 8, fill: 'var(--ink)' }),
        svg('rect', { x: x(now) - units(5), y: BASELINE_Y - BASELINE_H, width: units(10), height: units(3), fill: 'var(--ink)' }),
      ]),
    )
  }

  layers.push(svg('g', {}, hourLabels(figure.fromHour, figure.toHour, x)))

  // One transparent band per sampled hour, last so it sits over everything and
  // catches the pointer. The curve is a smoothed DERIVED shape, so the honest
  // tooltip is the sample it was drawn from, not a value read off the path.
  const half = curve.length > 1 ? Math.abs(x(curve[1].hour) - x(curve[0].hour)) / 2 : PLATE_W / 24
  for (const point of curve) {
    layers.push(
      svg('rect', { x: Math.max(0, x(point.hour) - half), y: 0, width: half * 2, height: BASELINE_Y, fill: 'transparent' }, [
        svg('title', {}, [`${String(Math.floor(point.hour)).padStart(2, '0')}:00 · energy ${point.score} of ${ENERGY_FULL_SCALE}`]),
      ]),
    )
  }
  for (const meeting of figure.meetings ?? []) {
    layers.push(
      svg('rect', { x: x(meeting.startHour) - 3, y: 0, width: Math.max(6, x(meeting.endHour) - x(meeting.startHour)), height: BASELINE_Y, fill: 'transparent' }, [
        svg('title', {}, [`meeting · ${hhmm(meeting.startHour)}–${hhmm(meeting.endHour)}`]),
      ]),
    )
  }

  return el('div', { class: 'plate' }, [
    svg(
      'svg',
      { viewBox: `0 0 ${PLATE_W} ${PLATE_H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': figure.caption || 'The day so far' },
      layers,
    ),
  ])
}
