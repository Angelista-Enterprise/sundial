// Framing, as plain math over the solved layout (no three.js here): the
// bounding sphere of some parts, how far a camera stands to see it, and where
// a step's camera goes. The stage glides to it; the flat fallback projects
// through the same view, so both pictures agree on what is in front.

/**
 * Each archetype's angle on its set: azimuth and elevation in radians. None
 * turns on its own: the camera moves on a step, or under the owner's hand.
 * (`turn` stays a field so a turning view could come back; all are 0.)
 */
export const VIEWS = {
  // A long lens for a plate: near flat, framed tight (a wide one stood back for depth and left the subject a third of the plate).
  system: { az: 0.6, el: 0.25, turn: 0, fov: 19, tight: 0.85 },
  orbital: { az: 0.5, el: 0.85, turn: 0 },
  fluid: { az: 0.18, el: 0.18, turn: 0 },
  mechanism: { az: 0.12, el: 0.12, turn: 0 },
  // An object a little from above and to one side, as an anatomy plate draws it.
  // tight: a part's sphere overstates a rod's or a plate's reach, so these views stand closer than the spheres say.
  object: { az: 0.55, el: 0.32, turn: 0, fov: 16, tight: 0.72 },
  // A dial face on, a route from above like a map.
  clock: { az: 0, el: 0.08, turn: 0 },
  route: { az: 0, el: 1.15, turn: 0 },
  // The engraver's isometric: a fixed corner (45 degrees round, 35 up) and a long lens, so depth reads by stacking, not by perspective.
  iso: { az: Math.PI / 4, el: 0.611, turn: 0, fov: 12 },
}

/**
 * The sphere that frames some parts. A backdrop (rain, the ground, a long
 * beam) must not push the subject away, so it frames the spread of the parts'
 * centres plus a typical part's size, never more than the true bounds. A part
 * may carry its own `frame` (a body's whole orbit).
 */
export function sphereOf(nodes) {
  const balls = nodes.map((n) => n.frame ?? { center: [n.x, n.y, n.z], radius: n.r })
  if (balls.length === 0) return { center: [0, 0, 0], radius: 4 }
  const clo = [0, 1, 2].map((i) => Math.min(...balls.map((b) => b.center[i])))
  const chi = [0, 1, 2].map((i) => Math.max(...balls.map((b) => b.center[i])))
  const center = clo.map((v, i) => (v + chi[i]) / 2)
  const full = Math.max(...balls.map((b) => Math.hypot(...b.center.map((v, i) => v - center[i])) + b.radius))
  const spread = Math.hypot(...chi.map((v, i) => v - clo[i])) / 2
  const sizes = balls.map((b) => b.radius).sort((a, b) => a - b)
  const med = sizes[Math.floor(sizes.length / 2)]
  return { center, radius: Math.max(1.2, Math.min(full, spread + Math.max(med, 0.6) * 1.5)) }
}

/** How far a camera with this vertical field of view (degrees) stands to hold a sphere of `radius`. */
function distanceFor(radius, fov = 36, aspect = 16 / 9) {
  const v = (fov * Math.PI) / 360
  const h = Math.atan(Math.tan(v) * aspect)
  return Math.max(radius / Math.sin(v), radius / Math.sin(h)) * 1.15
}

/**
 * How far some parts reach across and up the picture from `center`, seen along
 * a view. A wide set (a gear train, a run of pipes) is framed by its width and
 * not by a sphere, which would leave the plate half empty above and below it.
 * A turning view sees every side in turn, so its width is the sphere's.
 */
function extent(nodes, center, view, radius) {
  let rx = 0
  let ry = 0
  let rz = 0
  const eye = [Math.sin(view.az) * Math.cos(view.el), Math.sin(view.el), Math.cos(view.az) * Math.cos(view.el)]
  for (const n of nodes) {
    const b = n.frame ?? { center: [n.x, n.y, n.z], radius: n.r }
    const d = b.center.map((v, i) => v - center[i])
    const p = project(d, view)
    rx = Math.max(rx, Math.abs(p.x) + b.radius)
    ry = Math.max(ry, Math.abs(p.y) + b.radius)
    // How far toward the camera the parts come: the camera stands that much further back.
    rz = Math.max(rz, d.reduce((sum, v, i) => sum + v * eye[i], 0) + b.radius * Math.cos(view.el))
  }
  return { rx: view.turn ? Math.max(rx, radius) : rx, ry, rz: view.turn ? Math.max(rz, radius * 0.5) : rz }
}

/**
 * Where a step's camera goes: the whole set always stays in view (the margins
 * name every part, and a part cut by the frame would be named for nothing);
 * a step only leans the middle a little toward what it lights.
 */
export function frameFor(hot, all, view = VIEWS.system) {
  const whole = sphereOf(all)
  const mid = middleOf(all, whole.center, view)
  const center = hot.length ? sphereOf(hot).center.map((v, i) => v + (mid[i] - v) * 0.85) : mid
  return { center, radius: whole.radius, ...extent(all, center, view, whole.radius) }
}

/**
 * The set's middle as the picture sees it: the centre of its projected box,
 * not of its sphere. A lopsided set (a row of parts that turns down at one
 * end) framed on its sphere leaves the far side of the plate empty, since the
 * frame must reach its longest side both ways. A turning view keeps the sphere.
 */
function middleOf(nodes, center, view) {
  if (view.turn || !nodes.length) return center
  const lo = [Infinity, Infinity]
  const hi = [-Infinity, -Infinity]
  for (const n of nodes) {
    const b = n.frame ?? { center: [n.x, n.y, n.z], radius: n.r }
    const p = project(b.center.map((v, i) => v - center[i]), view)
    ;[p.x, p.y].forEach((v, k) => ((lo[k] = Math.min(lo[k], v - b.radius)), (hi[k] = Math.max(hi[k], v + b.radius))))
  }
  const [ox, oy] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2]
  // The projection is a rotation: back to the world along its own two rows.
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => project(e, view))
  return center.map((v, i) => v + ox * axes[i].x + oy * axes[i].y)
}

/**
 * The camera's position for a framing and a view, `t` seconds into a turning
 * one. `fit` is the share of the plate's width and height the figure may
 * take: the rest is the margins the labels stand in.
 */
export function eyeFor(frame, view, t = 0, aspect = 16 / 9, fit = [1, 1]) {
  const fov = view.fov ?? 36
  const v = (fov * Math.PI) / 360
  // Room for the parts nearer the camera than the middle (a long lens needs little).
  const d = frame.rx != null ? Math.max(frame.rx / (Math.tan(v) * aspect * fit[0]), (frame.ry * 1.06) / (Math.tan(v) * fit[1])) * 1.06 + Math.max(0, frame.rz) * (fov < 20 ? 0.1 : 0.5) : distanceFor(frame.radius, fov, aspect * fit[0] / fit[1]) / fit[1]
  const a = view.az + t * view.turn
  const near = d * (view.tight ?? 1)
  const [cx, cy, cz] = frame.center
  return [cx + Math.sin(a) * Math.cos(view.el) * near, cy + Math.sin(view.el) * near, cz + Math.cos(a) * Math.cos(view.el) * near]
}

/** Orthographic projection along a view: world to the flat picture's x (right) and y (down). */
export function project([x, y, z], view) {
  const ca = Math.cos(view.az)
  const sa = Math.sin(view.az)
  const right = x * ca - z * sa
  const depth = x * sa + z * ca
  return { x: right, y: -(y * Math.cos(view.el) - depth * Math.sin(view.el)), depth }
}
