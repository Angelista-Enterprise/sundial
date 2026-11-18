// The stage: a scene drawn in WebGL inside its card, no frame and no program.
// The layout is the solver's, the parts are the kit's, and the camera goes
// where the step is: it glides to the sphere of what a step lights, dims the
// rest to 0.3 (0.55 over the owner's screen), and edges the lit parts in
// ochre. Labels are DOM over the canvas (`.nd-label3d[data-id]`), standing in
// the margins beside (or above and below) the figure, each with a hairline leader to a dot on its part
// (labels.js `marginLabels`); the figure is drawn only inside the margins, so
// no label ever sits on it. A part with a door carries `data-explore`, so the
// page's one door listener opens it.
//
// The camera never moves on its own. A step glides it; the owner's hand moves
// it: drag to orbit, wheel or pinch to zoom, click a part to frame it (a
// second click on a framed part opens its door), double click for the whole
// figure. Taking the camera says `nodus:hold` and a double click `nodus:home`
// (both bubble), so the card pauses its walk or goes back to the whole. A step
// may `explode`: the parts lift apart along the set's axis, dashed guides
// showing where each came from, and close on the next step; a scene marked
// `exploded` rests apart. Hovering a part shows its value and unit.
//
// A page holds at most four live renderers: a fifth scene freezes the oldest
// to an image of its last frame until the owner's hand comes back to it.
// Off screen, a stage does not draw; with reduced motion it draws one still
// frame per change.
//
// Drawn as a plate: a body's surface writes depth, so what stands behind it is
// hidden, and a hidden outline shows dashed and faint (kit `bold`); a part
// small on screen is its silhouette alone, its details coming in nearer; a
// building pulled apart shows its floors' cut faces hatched.

import { eyeFor, frameFor, project, sphereOf, VIEWS } from './camera.js'
import { layoutForm } from './blocks.js'
import { createKit, readPalette, retheme } from './kit.js'
import { leaderPath, marginLabels, marginsFor } from './labels.js'
import { explodeOf, layoutScene } from './layout-scene.js'
import { rngOf, seedOf } from './rng.js'
import { ARCHETYPES } from './spec.js'

const MAX_LIVE = 4
const DIM = 0.3
/** Over the owner's screen a dimmed part still has to read: it never fades below this. */
const DIM_OVER = 0.55
const dimOf = () => (document.documentElement.hasAttribute('data-overlay') ? DIM_OVER : DIM)
const TWEEN_MS = 320
const EXPLODE_MS = 420
/** How far the hand may turn the set up or down (radians of elevation), and zoom in or out. */
const EL = [-0.15, 1.45]
const ZOOM = [0.35, 3]
const DRAG_PX = 4
/** A part smaller than this on screen (its radius, in pixels) is drawn as its silhouette alone: seams, spokes and inner lines come in nearer. */
const LOD_PX = 26
const live = []

/**
 * Hand a renderer to a new stage, freezing the oldest beyond the cap and
 * forgetting stages no longer on the page. Only a stage that was on the page
 * is forgotten: one still being built (a large board, a card opened from a
 * link) is not on it yet, and disposing it left a blank stage, labels piled
 * top left.
 */
function claim(stage) {
  for (const s of live.filter((x) => x.shown && !x.node.isConnected && x !== stage)) s.dispose()
  live.splice(0, live.length, ...live.filter((x) => x !== stage && !x.disposed), stage)
  while (live.length > MAX_LIVE) live.shift().freeze()
}

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - (1 - x) ** 3)
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v))
/**
 * The fact under a part's label, small and in capitals: its note (the
 * blueprint's few words), else an amount that has a unit. A bare value is a
 * relative weight for the solver, and a state a cue for the drawing: neither
 * tells a reader anything, so neither is printed.
 */
const readout = (lane) => {
  const note = String(lane?.note ?? '').trim()
  if (note) return (note.length > 34 ? `${note.slice(0, 33)}…` : note).toUpperCase()
  return lane?.unit && Number.isFinite(lane?.value) ? `${Math.round(lane.value * 100) / 100} ${lane.unit}`.toUpperCase() : ''
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Draw a checked scene spec.
 * @param opts.three the three.js module (three-loader.js)
 * @returns `{ node, focus(ids), update(spec), snapshot(), dispose() }`
 */
export function drawScene(input, { three: T } = {}) {
  let spec = input
  const node = document.createElement('div')
  node.className = 'nd-stage'
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', spec.title ?? 'A scene')
  const layer = document.createElement('div')
  layer.className = 'nd-labels'
  const NS = 'http://www.w3.org/2000/svg'
  const leaders = document.createElementNS(NS, 'svg')
  leaders.setAttribute('class', 'nd-leaders')
  leaders.setAttribute('aria-hidden', 'true')
  node.append(leaders, layer)
  // A whole picture behind the labels (spec.backdrop): sized to the stage, under the leaders.
  const backdrop = document.createElement('img')
  backdrop.className = 'nd-backdrop'
  backdrop.alt = ''
  node.prepend(backdrop)
  node.tabIndex = -1

  const scene = new T.Scene()
  const camera = new T.PerspectiveCamera(36, 16 / 9, 0.05, 500)
  // The lab's tests (globalThis.NODUS_VARIANT) read the set and the eye, to hand them to another renderer.
  if (globalThis.NODUS_VARIANT) globalThis.NODUS_STAGE = { scene, camera, node }
  const raycaster = new T.Raycaster()
  let pal = readPalette(T)
  // Where pinned parts stand on the backdrop, 0 to 1 of the stage, by id.
  const pinOf = new Map((input.lanes ?? []).filter((l) => l.pin).map((l) => [l.id, l.pin]))
  let L = null
  let view = VIEWS.system
  let parts = new Map()
  let joints = []
  let labels = []
  // What passes along a link (its label), numbered in the order things happen, at the link's middle.
  let words = []
  let guides = []
  // Labels above and below the figure (a set wider than the plate) or beside it; the figure's own rect inside the margins.
  let wide = false
  let inner = { x0: 0, y0: 0, x1: 1, y1: 1 }
  let glide = null
  let target = null
  let hot = new Set()
  let born = 0
  let tween = null
  // The owner's hand: offsets to the view's angle and distance, eased toward `aim` (a step sends them home).
  const hand = { az: 0, el: 0, zoom: 1, aim: { az: 0, el: 0, zoom: 1 } }
  let framed = null
  // When the camera was last aimed, and whether the frame it settles on has been told (`nodus:settled`, for the frame critic).
  let aimedAt = 0
  let told = true
  let apart = { at: 0, from: 0, to: 0 }
  let drift = new Map()
  const tip = document.createElement('span')
  tip.className = 'nd-tip'
  tip.hidden = true
  let renderer = null
  let nudge = null
  const buffer = new T.Vector2()
  let still = null
  let w = 1
  let h = 1
  let running = false
  let visible = true
  const reduced = reducedMotion()

  const stage = { node, disposed: false, freeze, dispose }

  function wake() {
    if (renderer || stage.disposed) return
    renderer = new T.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' })
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2))
    renderer.setSize(w, h, false)
    still?.remove()
    still = null
    node.prepend(renderer.domElement)
    claim(stage)
    kick()
  }
  // Frozen: the last frame as an image, the labels (and their doors) stay live over it, until the owner's hand reaches the card.
  function freeze() {
    if (!renderer) return
    const card = node.closest('.pane') ?? node
    card.addEventListener('pointerenter', wake, { once: true })
    card.addEventListener('focusin', wake, { once: true })
    still = document.createElement('img')
    still.alt = ''
    still.src = renderer.domElement.toDataURL('image/png')
    renderer.domElement.replaceWith(still)
    renderer.dispose()
    renderer.forceContextLoss()
    renderer = null
  }

  function build() {
    backdrop.hidden = !spec.backdrop
    if (spec.backdrop) {
      backdrop.onload = () => kick()
      backdrop.src = spec.backdrop
    }
    L = layoutScene(spec)
    view = VIEWS[L.view]
    camera.fov = view.fov ?? 36
    camera.updateProjectionMatrix()
    const flat = L.nodes.map((n) => project([n.x, n.y, n.z], view))
    const spanX = Math.max(...flat.map((p, i) => p.x + L.nodes[i].r)) - Math.min(...flat.map((p, i) => p.x - L.nodes[i].r))
    const spanY = Math.max(...flat.map((p, i) => p.y + L.nodes[i].r)) - Math.min(...flat.map((p, i) => p.y - L.nodes[i].r))
    // A fluid laid top to bottom names its rows above and below it; any set much wider than the plate does too.
    wide = L.axis === 'y' || spanX / Math.max(0.1, spanY) > 2.4
    const rnd = rngOf(spec)
    const kit = createKit(T, pal, rnd, { layoutForm, redraw: () => kick() })
    nudge = kit.nudge
    const middle = new T.Vector3(...L.sphere.center)
    const at = new Map(L.nodes.map((n) => [n.id, n]))
    const lanes = new Map(spec.lanes.map((l) => [l.id, l]))
    for (const n of L.nodes) {
      // A part's source: its model, else its picture, else its hand drawing, else its blocks, else its kind's stock part.
      const made = (n.mesh ? kit.mesh : n.image ? kit.picture : n.sketch ? kit.sketch : n.form || n.placed ? kit.form : kit.parts[n.kind] ?? kit.parts.sphere)(n, { toward: middle.clone().sub(new T.Vector3(n.x, n.y, n.z)), center: L.archetype === 'orbital' ? () => parts.get(L.nodes.find((x) => x.kind === 'center')?.id)?.group.position ?? middle : () => middle })
      made.node.position.set(n.x, n.y, n.z)
      // An invisible ball to click: lines are too thin to hit, and a backdrop must not swallow the click.
      const hit = new T.Mesh(new T.SphereGeometry(Math.min(Math.max(n.r, 0.3), 1), 12, 8), new T.MeshBasicMaterial({ visible: false }))
      hit.userData.id = n.id
      made.node.add(hit)
      scene.add(made.node)
      // Its details: the plain ink lines of a part that has a bold outline (never the outline's own passes, never a coloured line).
      const details = []
      let outlined = false
      const cuts = []
      made.node.traverse((o) => {
        if (o.userData.bold) outlined = true
        if (o.userData.cut) cuts.push(o)
        if (o.isLine && !o.userData.bold && !o.userData.pass && ['ink', 'muted', 'faint'].includes(o.material?.userData?.tone) && !o.parent?.userData?.bold) details.push(o)
      })
      parts.set(n.id, { n, group: made.node, update: made.update, hit, focus: 1, aim: 1, details: outlined ? details : [], cuts })
      if (L.archetype === 'orbital' && n.orbit) scene.add(Object.assign(kit.loop(n.orbit, 'faint', 0.5, 'xz'), { userData: { around: n.around, ring: true } }))
    }
    for (const e of L.edges) {
      const j = kit.joint(e, at)
      scene.add(j.node)
      joints.push({ ...j, e })
    }
    words = (spec.links ?? []).filter((k) => k.label && parts.has(k.from) && parts.has(k.to)).map((k, i) => {
      const el = document.createElement('span')
      el.className = 'nd-linkword'
      el.dataset.ix = String(i + 1)
      el.textContent = k.label
      layer.append(el)
      return { el, from: k.from, to: k.to }
    })
    labels = L.nodes.map((n, i) => {
      const el = document.createElement('span')
      el.className = 'nd-label3d'
      el.dataset.id = n.id
      // When the links carry the numbered steps, the parts are named without numbers: one count on the plate, not two.
      if (!(spec.links ?? []).some((k) => k.label)) el.dataset.ix = String(i + 1).padStart(2, '0')
      const read = readout(lanes.get(n.id))
      if (read) el.dataset.read = read
      el.textContent = n.label
      const door = lanes.get(n.id)?.door
      if (door) {
        el.dataset.explore = door
        el.setAttribute('role', 'link')
        el.tabIndex = 0
      }
      layer.append(el)
      const lead = document.createElementNS(NS, 'path')
      const dot = document.createElementNS(NS, 'circle')
      lead.setAttribute('class', 'nd-leader')
      dot.setAttribute('class', 'nd-anchor')
      dot.setAttribute('r', '2')
      dot.dataset.id = n.id
      const ring = document.createElementNS(NS, 'circle')
      ring.setAttribute('class', 'nd-ring')
      ring.setAttribute('r', '6')
      leaders.append(lead, ring, dot)
      return { el, lead, dot, ring, id: n.id, r: n.r, size: null }
    })
    for (const o of scene.children) o.traverse((x) => [x.material].flat().forEach((m) => m && (m.userData.base ??= m.opacity)))
    drift = explodeOf(L)
    // Dashed guides from where each part rests to where it lifts to, shown as the set comes apart.
    if (L.archetype !== 'orbital') {
      for (const n of L.nodes) {
        const d = drift.get(n.id)
        if (!d || Math.hypot(...d) < 1e-3) continue
        const g = kit.guide([n.x, n.y, n.z], [n.x + d[0], n.y + d[1], n.z + d[2]])
        scene.add(g)
        guides.push(g)
      }
    }
    if (spec.exploded) apart = { at: 0, from: 1, to: 1 }
    layer.append(tip)
    born = performance.now()
  }

  function clear() {
    scene.traverse((o) => {
      o.geometry?.dispose?.()
      for (const m of [o.material].flat()) m?.dispose?.()
    })
    scene.clear()
    layer.replaceChildren()
    leaders.replaceChildren()
    marked = ''
    parts = new Map()
    joints = []
    labels = []
    words = []
    guides = []
  }

  /** Where a part is right now: orbiting parts move along their solved circles. */
  function placeOrbits(t) {
    const done = new Map()
    const pos = (n) => {
      if (done.has(n.id)) return done.get(n.id)
      let p = [n.x, n.y, n.z]
      if (n.orbit && n.around) {
        const c = pos(parts.get(n.around).n)
        const a = n.phase + n.speed * t
        p = [c[0] + Math.cos(a) * n.orbit, c[1], c[2] + Math.sin(a) * n.orbit]
      } else if (n.kind === 'ring' && n.around) p = pos(parts.get(n.around).n)
      done.set(n.id, p)
      return p
    }
    for (const part of parts.values()) part.group.position.set(...pos(part.n))
    for (const o of scene.children) if (o.userData.ring && done.has(o.userData.around)) o.position.set(...done.get(o.userData.around))
    for (const j of joints) {
      if (j.e.kind !== 'tie') continue
      const a = done.get(j.e.from)
      const b = done.get(j.e.to)
      const line = j.node.children[0]
      line.geometry.setFromPoints([new T.Vector3(...a), new T.Vector3(...b)])
    }
  }

  function aimCamera(only = null) {
    // Framed where the parts will stand: a set pulled apart is framed apart.
    const nodes = L.nodes.map((n) => {
      const at = parts.get(n.id).group.position
      const d = (drift.get(n.id) ?? [0, 0, 0]).map((v) => v * apart.to)
      return { ...n, x: (L.archetype === 'orbital' ? at.x : n.x) + d[0], y: (L.archetype === 'orbital' ? at.y : n.y) + d[1], z: (L.archetype === 'orbital' ? at.z : n.z) + d[2] }
    })
    const lit = nodes.filter((n) => (only ? n.id === only : hot.has(n.id)))
    // The joints count too: a return pipe routed under the set must not leave the frame.
    const runs = L.archetype === 'orbital' ? [] : L.edges.flatMap((e) => (e.points ?? []).map(([x, y, z]) => ({ x, y, z, r: Math.max(0.05, (e.width ?? 0) / 2) })))
    target = frameFor(lit, [...nodes, ...runs], view)
    if (!glide || reduced) glide = { ...target, center: [...target.center] }
    aimedAt = performance.now()
    told = false
    for (const p of parts.values()) p.aim = hot.size === 0 || hot.has(p.n.id) ? 1 : dimOf()
  }

  const tmp = () => new T.Vector3()
  function frame(now) {
    // A frame stamped before a rebuild comes in with a time before `born`: no part runs backwards.
    const t = reduced ? 0 : Math.max(0, now - born) / 1000
    const dt = 1 / 60
    if (L.archetype === 'orbital') placeOrbits(t)
    let fade = 1
    if (tween) {
      const k = ease((now - tween.at) / TWEEN_MS)
      for (const [id, from] of tween.from) {
        const p = parts.get(id)
        if (p) p.group.position.set(...from.map((v, i) => v + ([p.n.x, p.n.y, p.n.z][i] - v) * k))
      }
      fade = k
      if (k >= 1) tween = null
    } else if (L.archetype !== 'orbital') for (const p of parts.values()) p.group.position.set(p.n.x, p.n.y, p.n.z)
    // Apart: every part drifts along its own axis; the joints thin out so the inside shows.
    const e = reduced ? apart.to : apart.from + (apart.to - apart.from) * ease((now - apart.at) / EXPLODE_MS)
    if (e > 0) for (const p of parts.values()) p.group.position.add(tmp().set(...(drift.get(p.n.id) ?? [0, 0, 0])).multiplyScalar(e))
    for (const j of joints) j.node.traverse((o) => [o.material].flat().forEach((m) => m && (m.opacity = m.userData.base * fade * (1 - 0.75 * e))))
    for (const g of guides) g.material.opacity = 0.7 * e
    // The margins the labels need, and the figure's rect inside them: the camera frames into it, and nothing is drawn outside it.
    const m = marginsFor(labels.map((l) => (l.real ? l.size : (l.size = measure(l)))), { w, h }, wide)
    inner = { x0: m.x, y0: m.y, x1: w - m.x, y1: h - m.y }
    renderer?.setScissorTest(true)
    renderer?.setScissor(inner.x0, h - inner.y1, inner.x1 - inner.x0, inner.y1 - inner.y0)
    // The glide: the camera eases toward the step's sphere, and the hand's offsets toward theirs.
    const pull = reduced ? 1 : 0.06
    glide.center = glide.center.map((v, i) => v + (target.center[i] - v) * pull)
    for (const k of ['radius', 'rx', 'ry', 'rz']) glide[k] += (target[k] - glide[k]) * pull
    for (const k of ['az', 'el', 'zoom']) hand[k] += (hand.aim[k] - hand[k]) * (reduced ? 1 : 0.2)
    const eye = eyeFor(glide, { ...view, az: view.az + hand.az, el: view.el + hand.el }, t, w / h, [(inner.x1 - inner.x0) / w, (inner.y1 - inner.y0) / h])
    camera.position.set(...eye.map((v, i) => glide.center[i] + (v - glide.center[i]) * hand.zoom))
    camera.lookAt(...glide.center)
    for (const p of parts.values()) {
      // Reduced motion still turns the drawn outlines to the camera, at time 0.
      p.update?.(t, reduced ? 0 : dt, camera)
      const near = pxOf(p.group.position, p.n.r) >= LOD_PX
      for (const d of p.details) d.visible = near
      for (const c of p.cuts) c.visible = e > 0.05
      p.focus += (p.aim - p.focus) * (reduced ? 1 : 0.1)
      const heat = hot.has(p.n.id) ? Math.min(1, (p.focus - dimOf()) / (1 - dimOf())) : 0
      p.group.traverse((o) => {
        for (const m of [o.material].flat()) {
          if (!m || m.userData.base == null) continue
          m.opacity = m.userData.base * p.focus
          if (m.userData.edge) m.color.lerpColors(pal.ink, pal.ochre, heat)
        }
      })
    }
    for (const j of joints) j.update?.(t, reduced ? 0 : dt, camera)
    if (renderer && nudge) {
      renderer.getDrawingBufferSize(buffer)
      nudge.value.set(2 / buffer.x, -2 / buffer.y)
    }
    // A backdrop stands in for the set: its own parts are not drawn, the picture is (an <img> under the labels).
    scene.visible = !spec.backdrop
    renderer?.render(scene, camera)
    placeLabels()
    // Settled: the glide, the hand and the set apart or together have all come to rest; said once per aim.
    const rest = Math.hypot(...glide.center.map((v, i) => v - target.center[i])) < 0.01 * target.radius && Math.abs(glide.radius - target.radius) < 0.01 * target.radius && Math.abs(hand.zoom - hand.aim.zoom) < 0.005
    if (!told && renderer && rest && (reduced || (now - aimedAt > 400 && now - apart.at > EXPLODE_MS))) {
      told = true
      node.dispatchEvent(new CustomEvent('nodus:settled', { bubbles: true }))
    }
  }

  // Measured once the label is on the page; a guess from its letters until then.
  const measure = (l) => ((l.real = l.el.offsetWidth > 0), [l.el.offsetWidth || l.el.textContent.length * 7.5 + 8, l.el.offsetHeight || 15])
  /** How far a part reaches on screen, in pixels, from the camera's distance to it. */
  const pxOf = (pos, r) => (r * h) / (2 * Math.max(0.01, camera.position.distanceTo(pos)) * Math.tan((camera.fov * Math.PI) / 360))
  let laid = []
  function placeLabels() {
    const items = []
    const discs = []
    for (const l of labels) {
      const pos = parts.get(l.id).group.position
      const v = tmp().copy(pos).project(camera)
      // A pinned part (located on a backdrop) is named where it stands in the picture, not where the solver put it.
      const pin = pinOf.get(l.id)
      const x = pin ? pin[0] * w : ((v.x + 1) / 2) * w
      const y = pin ? pin[1] * h : ((1 - v.y) / 2) * h
      // A part outside the figure's rect (a step looking closer) is not named: its label would stand on nothing.
      l.out = v.z > 1 || x < inner.x0 - 1 || x > inner.x1 + 1 || y < inner.y0 - 1 || y > inner.y1 + 1
      if (l.out) continue
      discs.push({ x, y, r: Math.min(pxOf(pos, l.r), w) })
      items.push({ id: l.id, x, y, w: l.size[0], h: l.size[1], hot: hot.has(l.id), l })
    }
    laid = marginLabels(items, { inner, w, h }, { wide, discs })
    laid.forEach((at, i) => {
      const { l } = items[i]
      Object.assign(l, { x: at.x, y: at.y, side: at.side, leader: at.leader })
      l.el.style.translate = `${at.x.toFixed(1)}px ${at.y.toFixed(1)}px`
      l.el.dataset.side = at.side
      l.lead.setAttribute('d', leaderPath(at))
      for (const el of [l.dot, l.ring]) {
        el.setAttribute('cx', at.leader[1][0].toFixed(1))
        el.setAttribute('cy', at.leader[1][1].toFixed(1))
      }
    })
    for (const l of labels) {
      const f = parts.get(l.id).focus
      const o = l.out ? '0' : String(f < 1 ? Math.max(0.35, f) : 1)
      l.el.style.opacity = o
      l.lead.style.opacity = o
      l.dot.style.opacity = o
      l.ring.style.opacity = o
      for (const el of [l.el, l.lead, l.dot, l.ring]) el.classList.toggle('nd-hot', hot.has(l.id))
    }
    // A word stands on its link where nothing else is: clear of the parts, their names and the other words. It slides along the link
    // from the middle outward to the first free spot, and only steps below when the whole link is taken.
    const taken = [...discs.map((d) => ({ x: d.x, y: d.y, w: d.r * 1.6, h: d.r * 1.6 })), ...laid.map((at, i) => ({ x: at.x + items[i].w / 2, y: at.y + items[i].h / 2, w: items[i].w, h: items[i].h }))]
    const free = (x, y, bw, bh) => !taken.some((t) => Math.abs(t.x - x) < (t.w + bw) / 2 + 2 && Math.abs(t.y - y) < (t.h + bh) / 2 + 1)
    for (const wd of words) {
      const [bw, bh] = [wd.el.offsetWidth || wd.el.textContent.length * 6.5 + 20, wd.el.offsetHeight || 15]
      const a = parts.get(wd.from).group.position
      const b = parts.get(wd.to).group.position
      const spot = (t) => {
        const v = tmp().copy(a).lerp(b, t).project(camera)
        return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h, v.z]
      }
      let [x, y, z] = spot(0.5)
      const open = [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8].map(spot).find(([px, py]) => free(px, py, bw, bh))
      if (open) [x, y, z] = open
      else for (let guard = 0; guard < 8 && !free(x, y, bw, bh); guard++) y += bh + 2
      taken.push({ x, y, w: bw, h: bh })
      const out = z > 1 || x < inner.x0 || x > inner.x1 || y < inner.y0 || y > inner.y1
      wd.el.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`
      wd.el.style.opacity = out ? '0' : String(Math.max(0.35, Math.min(parts.get(wd.from).focus, parts.get(wd.to).focus)))
      wd.el.classList.toggle('nd-hot', hot.has(wd.from) || hot.has(wd.to))
    }
    plateMarks()
  }

  // The plate's quiet furniture: crop marks at the figure's corners, a ruler along its foot, and its number.
  const marks = document.createElementNS(NS, 'g')
  marks.setAttribute('class', 'nd-marks')
  const caption = document.createElementNS(NS, 'text')
  caption.setAttribute('class', 'nd-micro')
  const ticks = document.createElementNS(NS, 'path')
  ticks.setAttribute('class', 'nd-plate-tick')
  marks.append(ticks, caption)
  let marked = ''
  function plateMarks() {
    if (!marks.isConnected) leaders.prepend(marks)
    const key = `${inner.x0}|${inner.y0}|${inner.x1}|${inner.y1}`
    if (key === marked) return
    marked = key
    const { x0, y0, x1, y1 } = inner
    const c = 9
    let d = `M${x0},${y0 + c}V${y0}H${x0 + c}M${x1 - c},${y0}H${x1}V${y0 + c}M${x1},${y1 - c}V${y1}H${x1 - c}M${x0 + c},${y1}H${x0}V${y1 - c}`
    for (let x = x0 + 20, k = 0; x < x1 - 20; x += 8, k++) d += `M${x},${y1}v${k % 5 ? -2.5 : -5}`
    ticks.setAttribute('d', d)
    caption.setAttribute('x', String(x0 + 20))
    caption.setAttribute('y', String(y1 - 9))
    // Only the plate's number: counts and camera angles read as interface, not as the picture.
    caption.textContent = `FIG ${seedOf(spec).toString(16).toUpperCase().padStart(4, '0').slice(-4)}`
  }

  function loop(now) {
    if (stage.disposed || !renderer || !visible || !node.isConnected) {
      running = false
      return
    }
    frame(now)
    requestAnimationFrame(loop)
  }
  function kick() {
    if (stage.disposed || !L || !renderer) return
    if (reduced) return void requestAnimationFrame((now) => frame(now))
    if (!running && visible) {
      running = true
      requestAnimationFrame(loop)
    }
  }

  const resize = () => {
    stage.shown ||= node.isConnected
    w = Math.max(1, node.clientWidth)
    h = Math.max(1, node.clientHeight)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer?.setSize(w, h, false)
    kick()
  }
  const sizes = new ResizeObserver(resize)
  sizes.observe(node)
  const seen = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting
    // A frozen stage scrolled or opened into view draws again (it may have frozen before its first frame).
    if (visible) wake()
    kick()
  })
  seen.observe(node)
  // The paper changed (the owner's setting, or the system's): every token is read again.
  const onTheme = () => {
    pal = readPalette(T)
    retheme(scene, pal)
    kick()
  }
  const themes = new MutationObserver(onTheme)
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const scheme = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
  scheme?.addEventListener?.('change', onTheme)

  // ── The owner's hand ──────────────────────────────────────────────────────
  // The stage itself counts: a pointer it captured sends its click and double click there.
  const onPlate = (event) => event.target === node || event.target instanceof HTMLCanvasElement || event.target instanceof HTMLImageElement
  /** The part under a point of the plate, or null. */
  function partAt(event) {
    const box = node.getBoundingClientRect()
    raycaster.setFromCamera(new T.Vector2(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1), camera)
    return raycaster.intersectObjects([...parts.values()].map((p) => p.hit), false)[0]?.object.userData.id ?? null
  }
  const hold = () => node.dispatchEvent(new CustomEvent('nodus:hold', { bubbles: true }))
  const pointers = new Map()
  let press = null
  node.addEventListener('pointerdown', (event) => {
    if (!onPlate(event)) return
    pointers.set(event.pointerId, [event.clientX, event.clientY])
    press = { x: event.clientX, y: event.clientY, moved: false, pinch: pointers.size === 2 ? pinchOf() : null, zoom: hand.aim.zoom }
    node.setPointerCapture?.(event.pointerId)
  })
  const pinchOf = () => Math.hypot(...[...pointers.values()].reduce((a, b) => [a[0] - b[0], a[1] - b[1]]))
  node.addEventListener('pointermove', (event) => {
    if (!press || !pointers.has(event.pointerId)) return void hover(event)
    const was = pointers.get(event.pointerId)
    pointers.set(event.pointerId, [event.clientX, event.clientY])
    if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_PX) return
    if (!press.moved) hold()
    press.moved = true
    tip.hidden = true
    if (pointers.size === 2 && press.pinch) hand.aim.zoom = clamp(press.zoom * (press.pinch / Math.max(1, pinchOf())), ZOOM)
    else {
      hand.aim.az -= (event.clientX - was[0]) * 0.008
      hand.aim.el = clamp(hand.aim.el + (event.clientY - was[1]) * 0.006, [EL[0] - view.el, EL[1] - view.el])
      hand.az = hand.aim.az
      hand.el = hand.aim.el
    }
    kick()
  })
  const release = (event) => {
    pointers.delete(event.pointerId)
    if (pointers.size > 0 || !press) return
    const click = !press.moved
    press = null
    if (!click) return
    // A click frames the part; a click on the part already framed opens its door.
    const id = partAt(event)
    if (!id) return
    if (framed === id) return void labels.find((l) => l.id === id && l.el.dataset.explore)?.el.click()
    hold()
    framed = id
    hand.aim = { az: hand.aim.az, el: hand.aim.el, zoom: 1 }
    aimCamera(id)
    kick()
  }
  node.addEventListener('pointerup', release)
  node.addEventListener('pointercancel', (event) => (pointers.delete(event.pointerId), (press = null)))
  node.addEventListener(
    'wheel',
    (event) => {
      // ⌘ with the wheel zooms the board, as everywhere on it; a plain wheel or a pinch (ctrl) zooms the set.
      if (!onPlate(event) || event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      hold()
      hand.aim.zoom = clamp(hand.aim.zoom * Math.exp(event.deltaY * 0.0015), ZOOM)
      kick()
    },
    { passive: false },
  )
  node.addEventListener('dblclick', (event) => {
    if (!onPlate(event)) return
    home()
    node.dispatchEvent(new CustomEvent('nodus:home', { bubbles: true }))
  })
  /** A small note with the part's value and unit, while the pointer rests on it. */
  function hover(event) {
    const id = onPlate(event) ? partAt(event) : null
    const lane = id && spec.lanes.find((l) => l.id === id)
    if (!lane || lane.value == null) return void (tip.hidden = true)
    const box = node.getBoundingClientRect()
    const unit = lane.unit ?? ARCHETYPES[spec.archetype]?.value ?? ''
    tip.textContent = `${lane.label} · ${lane.value} ${lane.value === 1 ? unit.replace(/s$/, '') : unit}`.trim()
    tip.style.translate = `${(event.clientX - box.left + 12).toFixed(0)}px ${(event.clientY - box.top + 12).toFixed(0)}px`
    tip.hidden = false
  }
  node.addEventListener('pointerleave', () => (tip.hidden = true))
  // Where the camera stands, for the browser check (e2e.py) and nothing else.
  node.camera = () => ({ az: hand.aim.az, el: hand.aim.el, zoom: hand.aim.zoom, framed, apart: apart.to, view: L.view, wide, inner })
  /** The camera 20 percent further back (the critic found the frame hard to read); the labels repack on the next frame, which is told again when it settles. */
  function back() {
    hand.aim.zoom = clamp(hand.aim.zoom * 1.2, ZOOM)
    aimedAt = performance.now()
    told = false
    kick()
  }
  /** The whole figure, the hand let go. */
  function home() {
    framed = null
    hand.aim = { az: 0, el: 0, zoom: 1 }
    hot = new Set()
    node.classList.remove('nd-has-focus')
    pull(spec.exploded === true)
    aimCamera()
    kick()
  }
  node.addEventListener('pointerenter', wake)
  node.addEventListener('focusin', wake)

  /** Pull the set apart, or close it, from wherever it is now. */
  function pull(on) {
    const to = on ? 1 : 0
    if (apart.to !== to) {
      const now = performance.now()
      const e = apart.from + (apart.to - apart.from) * ease((now - apart.at) / EXPLODE_MS)
      apart = { at: now, from: e, to }
    }
    node.dataset.apart = String(to)
  }

  /** A step: light what it names, let go of the hand, glide there; pull the set apart when the step says so, close it when the next does not. */
  function focus(ids, _named, explode = false) {
    hot = ids instanceof Set ? new Set(ids) : new Set(ids ?? [])
    node.classList.toggle('nd-has-focus', hot.size > 0)
    framed = null
    hand.aim = { az: 0, el: 0, zoom: 1 }
    pull(explode || spec.exploded === true)
    aimCamera()
    kick()
  }

  /** Fresh rows: solve again; parts that stay move to their new places over 320 ms, the joints fade in. */
  function update(fresh) {
    const from = new Map([...parts].map(([id, p]) => [id, [p.group.position.x, p.group.position.y, p.group.position.z]]))
    spec = fresh
    clear()
    build()
    for (const [id, p] of parts) if (from.has(id)) p.group.position.set(...from.get(id))
    tween = reduced ? null : { at: performance.now(), from }
    aimCamera()
    kick()
  }

  /** A JPEG of what is on screen, labels burnt in: for the frame critic. */
  function snapshot(maxW = 1280) {
    const k = Math.min(1, maxW / w)
    const c = document.createElement('canvas')
    c.width = Math.round(w * k)
    c.height = Math.round(h * k)
    const ctx = c.getContext('2d')
    ctx.fillStyle = `#${pal.page.getHexString()}`
    ctx.fillRect(0, 0, c.width, c.height)
    const src = renderer?.domElement ?? still
    if (src) ctx.drawImage(src, 0, 0, c.width, c.height)
    ctx.textBaseline = 'top'
    ctx.font = `500 ${11 * k}px Inter Tight, system-ui, sans-serif`
    ctx.lineWidth = 1
    for (const l of labels) {
      if (l.out || !l.leader) continue
      const tone = `#${(hot.has(l.id) ? pal.ochre : pal.muted).getHexString()}`
      ctx.fillStyle = tone
      ctx.strokeStyle = tone
      ctx.stroke(new Path2D(leaderPath(l, k)))
      ctx.fillText(`${l.el.dataset.ix}  ${l.el.textContent.toUpperCase()}`, l.x * k, l.y * k)
      if (l.el.dataset.read) ctx.fillText(l.el.dataset.read, l.x * k, (l.y + 15) * k)
    }
    return c.toDataURL('image/jpeg', 0.85)
  }

  function dispose() {
    if (stage.disposed) return
    stage.disposed = true
    sizes.disconnect()
    seen.disconnect()
    themes.disconnect()
    scheme?.removeEventListener?.('change', onTheme)
    clear()
    renderer?.dispose()
    renderer?.forceContextLoss()
    renderer = null
    const i = live.indexOf(stage)
    if (i >= 0) live.splice(i, 1)
  }

  build()
  aimCamera()
  wake()
  return { node, focus, update, snapshot, dispose, home, back, hand, layout: L, sphere: sphereOf(L.nodes), get target() { return target } }
}
