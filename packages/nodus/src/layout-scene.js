// A scene's layout: the archetype's solver over the checked lanes and links,
// and the sphere that frames the whole. Pure and deterministic, the one
// geometry both the stage (three.js) and the flat fallback (SVG) draw.

import { sphereOf } from './camera.js'
import { rngOf, seedOf } from './rng.js'
import { solveArc } from './solve-arc.js'
import { solveFlow } from './solve-flow.js'
import { solveForce } from './solve-force.js'
import { solveGears } from './solve-gears.js'
import { solveClock } from './solve-clock.js'
import { solvePlan } from './solve-plan.js'
import { solveRoute } from './solve-route.js'
import { solveObject, standOn } from './solve-object.js'

const SOLVERS = { object: (lanes, links, spec) => solveObject(lanes, links, spec, rngOf(spec)), system: solveArc, fluid: solveFlow, mechanism: solveGears, orbital: (lanes, links, spec) => solveForce(lanes, links, seedOf(spec)), clock: solveClock, route: (lanes, links, spec) => solveRoute(lanes, links, seedOf(spec)), plan: solvePlan }

/** The kinds a form (blocks.js) or a hand drawing may redraw: plain shapes, a person, a crowd, an object's part. */
export const PLAIN = new Set(['part', 'box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'prism', 'observer', 'droplet', 'field', 'cloud'])

/** Kinds that make a set read as a building or a landscape: drawn isometric, and pulled apart upward. */
const BUILT = ['stack', 'contour']

/** `{ nodes, edges, sphere, floor, archetype, view, axis }` for a checked scene spec; `view` names its camera in `VIEWS`. */
export function layoutScene(spec) {
  const archetype = SOLVERS[spec.archetype] ? spec.archetype : 'system'
  const { nodes, edges, floor, axis } = SOLVERS[archetype](spec.lanes, spec.links ?? [], spec)
  // A part's own form (blocks.js) or hand drawing (spec.js sketch) rides on its node for the kit; a part that stands on another is placed there, whatever the archetype.
  const lane = new Map(spec.lanes.map((l) => [l.id, l]))
  // Only a plain part takes them: a gear, a pipe, a tank or an orbit is the engine's own, solved and drawn to fit its train.
  for (const n of nodes) {
    // A terrain's picture is its height (white high, black sea): the kit draws its level lines from it.
    if (n.kind === 'contour' && lane.get(n.id)?.image) n.height = lane.get(n.id).image
    if (!PLAIN.has(n.kind)) continue
    if (lane.get(n.id)?.form && !n.placed) n.form = lane.get(n.id).form
    if (lane.get(n.id)?.sketch) n.sketch = lane.get(n.id).sketch
    if (lane.get(n.id)?.image) (n.image = lane.get(n.id).image), (n.words = lane.get(n.id).label)
    if (lane.get(n.id)?.mesh) n.mesh = lane.get(n.id).mesh
  }
  if (archetype !== 'object' && spec.lanes.some((l) => l.on)) standOn(nodes, spec.lanes)
  const built = archetype === 'system' && (spec.exploded === true || spec.lanes.some((l) => BUILT.includes(l.kind)))
  // A machine and a building read isometric; a fluid laid top to bottom (a day into its places) is a diagram, read face on.
  const view = archetype === 'object' ? 'object' : archetype === 'mechanism' || archetype === 'plan' || (archetype === 'fluid' && axis !== 'y') || built ? 'iso' : archetype
  return { archetype, nodes, edges, floor, axis: axis ?? null, view, built, sphere: sphereOf(nodes) }
}

/**
 * Where each part drifts when the set is pulled apart (`exploded`, or a
 * step's `explode`), along one axis, as an exploded drawing lifts its parts:
 * a building's floors (and any system with stacked parts) upward, each level
 * higher than the one under it; a fluid along its flow, layer by layer; a
 * gear train along its shafts, each gear one step further out; an orbital's
 * bodies out from the center; anything else out from the middle. Offsets in
 * world units, keyed by id; pure.
 */
export function explodeOf(L) {
  const [cx, cy, cz] = L.sphere.center
  const gap = Math.max(0.7, L.sphere.radius * 0.28)
  const round = (off) => off.map((v) => Math.round(v * 1000) / 1000)
  // Distinct heights, low to high: parts on one level lift together.
  const levels = [...new Set(L.nodes.map((n) => Math.round(n.y * 100)))].sort((a, b) => a - b)
  return new Map(
    L.nodes.map((n, i) => {
      const d = [n.x - cx, n.y - cy, n.z - cz]
      const off =
        n.drift && L.archetype === 'object' ? n.drift
        : L.built ? [0, levels.indexOf(Math.round(n.y * 100)) * gap, 0]
        : L.archetype === 'fluid' ? (L.axis === 'y' ? [0, -(n.layer ?? 0) * gap * 0.6, 0] : [(n.layer ?? 0) * gap * 0.6, 0, 0])
        : L.archetype === 'mechanism' ? [0, 0, i * gap * 0.5]
        : L.archetype === 'orbital' ? [d[0] * 0.35, 0, d[2] * 0.35]
        : L.archetype === 'clock' || L.archetype === 'route' ? [0, n.kind === 'event' || n.kind === 'stop' ? gap * 0.3 : 0, 0]
        : L.archetype === 'plan' ? [0, n.kind === 'device' ? gap * 0.8 : 0, 0]
        : d.map((v) => v * 0.35)
      return [n.id, round(off)]
    }),
  )
}
