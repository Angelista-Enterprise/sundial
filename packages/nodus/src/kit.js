// The stage kit: the lab's parts (nodus-lab, kit.js), ported to draw from a
// solved layout. Ink on paper, ochre for light, a muted spectrum only where
// the subject is colour itself. Every material carries the token it was drawn
// in (`userData.tone`), so a theme change recolours the set in place
// (`retheme`), and its resting opacity (`userData.base`), so the stage can dim
// what a step is not about. Every part returns `{ node, update?(t, dt, camera) }`
// with t in seconds; nothing here calls Math.random (the scene's seeded rng).

const SPECTRUM = ['#c9412d', '#d98a2b', '#d4b520', '#4f8a3c', '#2f6f9f', '#3d4a9a', '#6a3f8f']
/** How strong a hidden line is: a dashed hint of what stands behind. */
const HIDDEN = 0.28
const TOKENS = { ink: '--ink', muted: '--ink-muted', faint: '--ink-faint', ochre: '--ochre', navy: '--navy', page: '--page' }

/** The page's tokens as three.js colours, read now (light or dark, whichever the page is in). */
export function readPalette(T) {
  const css = getComputedStyle(document.documentElement)
  return Object.fromEntries(Object.entries(TOKENS).map(([k, name]) => [k, new T.Color(css.getPropertyValue(name).trim() || '#000')]))
}

/** Recolour every material in `root` from its token, after a theme change. */
export function retheme(root, pal) {
  root.traverse((o) => {
    for (const m of [o.material].flat()) if (m?.userData?.tone && pal[m.userData.tone]) m.color.copy(pal[m.userData.tone])
  })
}

let softTex = null
let beamTex = null
let hatchTex = null
function textures(T) {
  if (softTex) return
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  // No 2d canvas (jsdom, the tests): the parts draw without their soft glow.
  if (!g) return
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  r.addColorStop(0, 'rgba(255,255,255,1)')
  r.addColorStop(0.5, 'rgba(255,255,255,.35)')
  r.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = r
  g.fillRect(0, 0, 128, 128)
  softTex = new T.CanvasTexture(c)
  const b = document.createElement('canvas')
  b.width = 256
  b.height = 32
  const gb = b.getContext('2d')
  const lr = gb.createLinearGradient(0, 0, 256, 0)
  lr.addColorStop(0, 'rgba(255,255,255,.9)')
  lr.addColorStop(1, 'rgba(255,255,255,0)')
  gb.fillStyle = lr
  gb.fillRect(0, 0, 256, 32)
  const vr = gb.createLinearGradient(0, 0, 0, 32)
  vr.addColorStop(0, 'rgba(0,0,0,1)')
  vr.addColorStop(0.5, 'rgba(0,0,0,0)')
  vr.addColorStop(1, 'rgba(0,0,0,1)')
  gb.globalCompositeOperation = 'destination-out'
  gb.fillStyle = vr
  gb.fillRect(0, 0, 256, 32)
  beamTex = new T.CanvasTexture(b)
  // A section's hatch: thin diagonals, white on transparent so the material's token colours them; five to a world unit (UVs in world units).
  const hc = document.createElement('canvas')
  hc.width = hc.height = 64
  const gh = hc.getContext('2d')
  gh.strokeStyle = '#fff'
  gh.lineWidth = 3
  for (let k = -64; k <= 64; k += 32) {
    gh.beginPath()
    gh.moveTo(k, 64)
    gh.lineTo(k + 64, 0)
    gh.stroke()
  }
  hatchTex = new T.CanvasTexture(hc)
  hatchTex.wrapS = hatchTex.wrapT = T.RepeatWrapping
  hatchTex.repeat.set(2.5, 2.5)
  // No mipmaps: a hatch averaged down is a grey wash, not lines.
  hatchTex.generateMipmaps = false
  hatchTex.minFilter = T.LinearFilter
}

/**
 * Is a point inside a field's silhouette (radius r, centred on the part)? Pure
 * shapes: balls, a trunk, cones; the seeded rng only picks where points fall.
 */
export function silhouette(shape, r) {
  const ball = (x, y, z, [cx, cy, cz, rr, sy = 1]) => (x - cx) ** 2 + ((y - cy) / sy) ** 2 + (z - cz) ** 2 < rr * rr
  const tree = (x, y, z, [tx, tz, s]) => {
    const [dx, dz] = [x - tx, z - tz]
    const trunk = Math.hypot(dx, dz) < s * (0.07 + 0.05 * Math.max(0, -y / s)) && y < 0 && y > -s
    const crown = [[0, 0.25, 0, 0.55], [-0.32, 0.12, 0.1, 0.36], [0.34, 0.16, -0.08, 0.38], [0.05, 0.62, 0.05, 0.36], [0, 0.2, 0.32, 0.34]].some(([cx, cy, cz, rr]) => ball(dx, y, dz, [cx * s, cy * s, cz * s, rr * s]))
    return trunk || crown
  }
  if (shape === 'cloud') return (x, y, z) => y > -0.35 * r && [[-0.5, -0.05, 0, 0.42], [0, 0.12, 0, 0.55], [0.5, 0, 0.05, 0.42], [0.2, -0.1, -0.25, 0.38]].some((b) => ball(x, y, z, b.map((v) => v * r)))
  if (shape === 'crowd') {
    const people = Array.from({ length: 13 }, (_, i) => [Math.cos(i * 2.4) * r * 0.75 * Math.sqrt((i + 0.5) / 13), Math.sin(i * 2.4) * r * 0.75 * Math.sqrt((i + 0.5) / 13)])
    return (x, y, z) => people.some(([px, pz]) => ball(x, y, z, [px, -0.1 * r, pz, 0.07 * r]) || (Math.hypot(x - px, z - pz) < 0.08 * r * (1 - (y + 0.2 * r) / (0.8 * r)) && y < -0.2 * r && y > -r))
  }
  if (shape === 'forest') {
    const trees = Array.from({ length: 7 }, (_, i) => [Math.cos(i * 2.4) * r * 0.62 * Math.sqrt((i + 0.5) / 7), Math.sin(i * 2.4) * r * 0.62 * Math.sqrt((i + 0.5) / 7), r * (0.34 + 0.08 * (i % 3))])
    return (x, y, z) => trees.some(([tx, tz, s]) => tree(x, y + r - s, z, [tx, tz, s]))
  }
  return (x, y, z) => tree(x, y + r * 0.1, z, [0, 0, r])
}

/**
 * The kit for one scene.
 * @param T three.js
 * @param pal readPalette(T)
 * @param rnd the scene's seeded rng (rng.js)
 * @param opts.redraw asks the stage for a frame: a picture that loads after a still frame (reduced motion) must still show
 * @param opts.layoutForm blocks.js's layout, handed in (Studio's frame loads this file alone, so it imports nothing)
 */
export function createKit(T, pal, rnd, { layoutForm = null, redraw = null } = {}) {
  textures(T)
  const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z)
  const tag = (m, tone, base) => {
    m.userData = { tone, base, edge: tone === 'ink' }
    return m
  }
  // Ink and muted lines that carry the drawing stand at full strength: WebGL draws a line one pixel wide, and a 0.9 one read at 2 to 1 on paper.
  const firm = (tone, opacity) => ((tone === 'ink' || tone === 'muted') && opacity >= 0.6 ? 1 : opacity)
  const line = (tone = 'ink', opacity = 0.9) => tag(new T.LineBasicMaterial({ color: pal[tone], transparent: true, opacity: firm(tone, opacity) }), tone, firm(tone, opacity))
  // A primary outline drawn twice, the second one device pixel right and down (the stage sets `nudge` from its drawing buffer): two pixels wide without a line addon.
  const nudge = { value: new T.Vector2() }
  const bold = (o) => {
    const m = o.material.clone()
    m.onBeforeCompile = (sh) => {
      sh.uniforms.nudge = nudge
      sh.vertexShader = sh.vertexShader.replace('void main() {', 'uniform vec2 nudge;\nvoid main() {').replace('#include <project_vertex>', '#include <project_vertex>\n\tgl_Position.xy += nudge * gl_Position.w;')
    }
    m.customProgramCacheKey = () => 'nodus-bold'
    const twin = new o.constructor(o.geometry, m)
    twin.userData.pass = 'nudge'
    // The hidden line: where a part stands behind another (whose body writes depth, `occlude`), its outline still shows, dashed and faint, drawn under the solid line.
    const hidden = new o.constructor(o.geometry, tag(new T.LineDashedMaterial({ color: pal[m.userData.tone] ?? pal.ink, transparent: true, opacity: HIDDEN, depthTest: false, depthWrite: false, dashSize: 0.07, gapSize: 0.06 }), m.userData.tone, HIDDEN))
    hidden.computeLineDistances()
    hidden.renderOrder = -1
    hidden.userData.pass = 'hidden'
    o.userData.bold = true
    o.add(twin, hidden)
    return o
  }
  /** A body's surface written to depth only (no colour), a hair behind itself, so lines on it still show and what is behind it is hidden. */
  const occluder = tag(new T.MeshBasicMaterial({ colorWrite: false, depthWrite: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: T.DoubleSide }), null, null)
  const occlude = (mesh, shrink = 1) => {
    const o = new T.Mesh(mesh.geometry, occluder)
    // A body of revolution hides with a slightly thinner self: its own outline (the meridian turned to the eye) and its near seams stay in front of it.
    o.scale.set(shrink, 1, shrink)
    o.userData.pass = 'occlude'
    mesh.add(o)
    return mesh
  }
  /** A cut face: the token's hatch on transparent, for a section (a vessel's wall, a floor pulled apart). */
  const hatch = (geo, tone = 'ink', opacity = 0.55) => new T.Mesh(geo, tag(new T.MeshBasicMaterial({ map: hatchTex, color: pal[tone], transparent: true, opacity, depthWrite: false, side: T.DoubleSide }), tone, opacity))
  const wash = (tone = 'ink', opacity = 0.05) => tag(new T.MeshBasicMaterial({ color: pal[tone], transparent: true, opacity, depthWrite: false, side: T.DoubleSide }), tone, opacity)
  const flat = (tone, opacity = 0.9, extra = {}) => tag(new T.MeshBasicMaterial({ color: pal[tone], transparent: true, opacity, depthWrite: false, side: T.DoubleSide, ...extra }), tone, opacity)
  const hue = (c, opacity) => tag(new T.MeshBasicMaterial({ color: new T.Color(c), transparent: true, opacity, depthWrite: false, side: T.DoubleSide }), null, opacity)
  const edges = (geo, tone = 'ink', opacity = 0.9) => new T.LineSegments(new T.EdgesGeometry(geo, 20), line(tone, opacity))
  const solid = (geo, tone = 'ink', fill = 0.05) => {
    const g = new T.Group()
    g.add(occlude(new T.Mesh(geo, wash(tone, fill))), bold(edges(geo, tone)))
    const r = ribs(geo, tone)
    if (r) g.add(r)
    return g
  }
  /**
   * A body's sections, the x-ray's inner lines: level cuts through it every
   * step of its height and a few across it, as faint hairlines (a part's
   * details, so they come in only when it is near enough to read).
   */
  const ribs = (geo, tone = 'ink', levels = 7, across = 3) => {
    const pos = geo.toNonIndexed().attributes.position
    if (pos.count < 9) return null
    geo.computeBoundingBox()
    const { min, max } = geo.boundingBox
    const out = []
    const cut = (axis, c) => {
      for (let i = 0; i < pos.count; i += 3) {
        const tri = [0, 1, 2].map((k) => V(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)))
        const hit = []
        for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
          const [da, db] = [a[axis] - c, b[axis] - c]
          if ((da < 0) !== (db < 0)) hit.push(a.clone().lerp(b, da / (da - db)))
        }
        if (hit.length === 2) out.push(...hit)
      }
    }
    for (let k = 1; k <= levels; k++) cut('y', min.y + ((max.y - min.y) * k) / (levels + 1))
    for (let k = 1; k <= across; k++) cut('x', min.x + ((max.x - min.x) * k) / (across + 1))
    if (!out.length) return null
    return new T.LineSegments(new T.BufferGeometry().setFromPoints(out), line(tone === 'ochre' ? 'ochre' : 'faint', 0.32))
  }
  /** A ghost box: the dotted bounds a draughtsman sets out before the part, faint. */
  const ghost = (geo) => {
    geo.computeBoundingBox()
    const size = geo.boundingBox.getSize(V()).multiplyScalar(1.12)
    const box = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(size.x, size.y, size.z)), tag(new T.LineDashedMaterial({ color: pal.faint, transparent: true, opacity: 0.22, dashSize: 0.04, gapSize: 0.05 }), 'faint', 0.22))
    box.computeLineDistances()
    box.position.copy(geo.boundingBox.getCenter(V()))
    return box
  }
  const path = (pts, tone = 'ink', opacity = 0.9) => new T.Line(new T.BufferGeometry().setFromPoints(pts), line(tone, opacity))
  const circle = (r, n = 64, plane = 'xy') => new T.Path().absarc(0, 0, r, 0, Math.PI * 2, false).getSpacedPoints(n).map((q) => (plane === 'xy' ? V(q.x, q.y, 0) : V(q.x, 0, q.y)))
  const loop = (r, tone = 'ink', opacity = 0.9, plane = 'xy') => new T.LineLoop(new T.BufferGeometry().setFromPoints(circle(r, 64, plane)), line(tone, opacity))
  const arrowHead = (at, dir, tone, size = 0.12) => {
    const cone = new T.Mesh(new T.ConeGeometry(size * 0.45, size, 10), flat(tone, 0.95))
    cone.position.copy(at)
    cone.quaternion.setFromUnitVectors(V(0, 1, 0), dir.clone().normalize())
    return cone
  }
  // A beam of light: a textured plate that always faces the camera, fading along its length.
  const beam = (from, to, width, opacity) => {
    const len = from.distanceTo(to)
    const m = new T.Mesh(new T.PlaneGeometry(len, width), tag(new T.MeshBasicMaterial({ map: beamTex, color: pal.ochre, transparent: true, opacity, depthWrite: false, side: T.DoubleSide }), 'ochre', opacity))
    const mid = from.clone().lerp(to, 0.5)
    const dir = to.clone().sub(from).normalize()
    m.matrixAutoUpdate = false
    m.userData.face = (camera, at = V()) => {
      const toCam = camera.position.clone().sub(at).sub(mid).normalize()
      const side = new T.Vector3().crossVectors(dir, toCam).normalize()
      const up = new T.Vector3().crossVectors(side, dir).normalize()
      m.matrix.makeBasis(dir, side, up).setPosition(mid)
    }
    return m
  }
  const sprite = (tone, opacity, scale) => {
    const s = new T.Sprite(tag(new T.SpriteMaterial({ map: softTex, color: pal[tone], transparent: true, opacity, depthWrite: false }), tone, opacity))
    s.scale.setScalar(scale)
    return s
  }
  /** A few mono characters standing in the set, always facing the camera (a dial's hours): white on transparent, coloured by its token. */
  const text = (str, height = 0.22, tone = 'muted') => {
    const c = document.createElement('canvas')
    const g = c.getContext?.('2d')
    if (!g) return new T.Group()
    const px = 64
    g.font = `400 ${px}px ui-monospace, Menlo, monospace`
    c.width = Math.ceil(g.measureText(str).width) + 8
    c.height = px + 16
    g.font = `400 ${px}px ui-monospace, Menlo, monospace`
    g.fillStyle = '#fff'
    g.textBaseline = 'middle'
    g.fillText(str, 4, c.height / 2)
    const s = new T.Sprite(tag(new T.SpriteMaterial({ map: new T.CanvasTexture(c), color: pal[tone], transparent: true, opacity: 0.85, depthWrite: false }), tone, 0.85))
    s.scale.set((height * c.width) / c.height, height, 1)
    return s
  }
  const spin = (g, speed = 0.15) => ({ node: g, update: (t) => (g.rotation.y = t * speed) })
  const shape = (geo) => {
    const g = solid(geo, 'ink', 0.04)
    g.add(ghost(geo))
    return spin(g)
  }

  /** One primitive of a form as geometry, its height along y, sized to its sides (w, h, d). */
  const primitive = (shape, [w, h, d]) => {
    const r = Math.min(w, d) / 2
    switch (shape) {
      case 'rod':
      case 'cylinder':
        return new T.CylinderGeometry(r, r, h, 20)
      case 'disc':
        return new T.CylinderGeometry(r, r, h, 32)
      case 'gear': {
        // A toothed wheel: the outline of a rim with teeth, extruded.
        const teeth = Math.max(8, Math.round(r * 24))
        const sh = new T.Shape()
        for (let i = 0; i <= teeth * 2; i++) {
          const a = (i / (teeth * 2)) * Math.PI * 2
          const rr = i % 2 ? r * 0.86 : r
          i === 0 ? sh.moveTo(Math.cos(a) * rr, Math.sin(a) * rr) : sh.lineTo(Math.cos(a) * rr, Math.sin(a) * rr)
        }
        return new T.ExtrudeGeometry(sh, { depth: h, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, -h / 2, 0)
      }
      case 'capsule':
        return new T.CapsuleGeometry(r, Math.max(0.01, h - 2 * r), 6, 16)
      case 'cone':
        return new T.ConeGeometry(r, h, 20)
      case 'sphere':
        return new T.SphereGeometry(0.5, 20, 14).scale(w, h, d)
      case 'dome':
        return new T.SphereGeometry(0.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(w, h * 2, d).translate(0, -h / 2, 0)
      case 'lens':
        return new T.SphereGeometry(0.5, 20, 12).scale(w, h, d)
      case 'torus':
      case 'ring':
        return new T.TorusGeometry(r - h / 2, h / 2, 10, 40).rotateX(Math.PI / 2)
      case 'wedge': {
        const sh = new T.Shape().moveTo(-w / 2, -h / 2).lineTo(w / 2, -h / 2).lineTo(-w / 2, h / 2).lineTo(-w / 2, -h / 2)
        return new T.ExtrudeGeometry(sh, { depth: d, bevelEnabled: false }).translate(0, 0, -d / 2)
      }
      default:
        return new T.BoxGeometry(w, h, d)
    }
  }
  /**
   * A part built from its form (blocks.js): each primitive drawn as the stage
   * draws a body (a wash, a bold outline, its section ribs), turned along its
   * axis; parts inside another drawn fainter, as the x-ray's inner things; a
   * spring as a helix line. Sized so the whole is the node's radius.
   */
  const form = (n) => {
    if (!n.placed && !layoutForm) return K.part(n)
    const g = new T.Group()
    for (const p of n.placed ?? layoutForm(n.form, n.r, rnd)) {
      const tone = p.inner ? 'muted' : 'ink'
      const sides = p.axis === 'x' ? [p.sides[1], p.sides[0], p.sides[2]] : p.axis === 'z' ? [p.sides[0], p.sides[2], p.sides[1]] : p.sides
      let o
      if (p.shape === 'spring') {
        const turns = 7
        const pts = Array.from({ length: turns * 24 + 1 }, (_, i) => {
          const a = (i / 24) * Math.PI * 2
          return V(Math.cos(a) * sides[0] / 2, -sides[1] / 2 + (i / (turns * 24)) * sides[1], Math.sin(a) * sides[2] / 2)
        })
        o = path(pts, tone, 0.9)
      } else o = solid(primitive(p.shape, sides), tone, p.inner ? 0.03 : 0.05)
      if (p.axis === 'x') o.rotation.z = Math.PI / 2
      if (p.axis === 'z') o.rotation.x = Math.PI / 2
      o.position.set(...p.center)
      g.add(o)
    }
    return { node: g }
  }

  /**
   * A part drawn by hand (spec.js `sketch`): its polylines in a 0 to 100 box,
   * drawn as hairlines on a plate that always faces the camera, sized to the
   * node's radius; the first line bold, as its outline.
   */
  const sketch = (n) => {
    const g = new T.Group()
    const k = (2 * n.r) / 100
    n.sketch.forEach((l, i) => {
      const pts = []
      for (let j = 0; j + 1 < l.length; j += 2) pts.push(V((l[j] - 50) * k, (50 - l[j + 1]) * k, 0))
      const o = path(pts, i === 0 ? 'ink' : 'muted', i === 0 ? 0.95 : 0.7)
      g.add(i === 0 ? bold(o) : o)
    })
    return { node: g, update: (t, dt, cam) => g.quaternion.copy(cam.quaternion) }
  }

  /**
   * A picture's strokes as line segments, sized to `size`: the image at 512
   * a side, its light strokes outlined by marching squares at one
   * brightness, each outline simplified (Ramer, Douglas, Peucker) and the
   * shortest dropped, so a thin white line becomes a crisp hairline pair.
   * `T0` is the brightness outlined (a heightmap's level); `blur` (px) keeps
   * only the large shapes.
   */
  const traceLines = (img, size, T0 = 0.24, blur = 0) => {
    const { W, H, lines } = traceLoops(img, T0, blur)
    const sc = size / Math.max(W, H)
    const out = []
    for (const s2 of lines) for (let i = 0; i + 1 < s2.length; i++) out.push(V((s2[i][0] - W / 2) * sc, (H / 2 - s2[i][1]) * sc, 0), V((s2[i + 1][0] - W / 2) * sc, (H / 2 - s2[i + 1][1]) * sc, 0))
    return out
  }

  /** A picture at 512 a side, read as brightness 0 to 1 per pixel (0 outside it); `blur` in px. */
  const pixels = (img, blur = 0) => {
    const k = 512 / Math.max(img.width, img.height)
    const W = Math.max(2, Math.round(img.width * k))
    const H = Math.max(2, Math.round(img.height * k))
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const x = c.getContext('2d')
    if (!x) return null
    if (blur) x.filter = `blur(${blur}px)`
    x.drawImage(img, 0, 0, W, H)
    const d = x.getImageData(0, 0, W, H).data
    return { W, H, lum: (i, j) => (i < 0 || j < 0 || i >= W || j >= H ? 0 : (d[(j * W + i) * 4] * 0.3 + d[(j * W + i) * 4 + 1] * 0.59 + d[(j * W + i) * 4 + 2] * 0.11) / 255) }
  }

  /** The outlines where a picture crosses brightness T0, in its pixels, simplified, the shortest dropped. */
  const traceLoops = (img, T0 = 0.24, blur = 0) => {
    const px = pixels(img, blur)
    if (!px) return { W: 2, H: 2, lines: [] }
    const { W, H, lum } = px
    // Marching squares: per cell, the edge crossings joined in pairs.
    const segs = []
    const mid = (i0, j0, i1, j1) => {
      const a = lum(i0, j0)
      const b = lum(i1, j1)
      const f = Math.abs(b - a) < 1e-6 ? 0.5 : (T0 - a) / (b - a)
      return [i0 + (i1 - i0) * f, j0 + (j1 - j0) * f]
    }
    for (let j = -1; j < H; j++) {
      for (let i = -1; i < W; i++) {
        const tl = lum(i, j) > T0, tr = lum(i + 1, j) > T0, br = lum(i + 1, j + 1) > T0, bl = lum(i, j + 1) > T0
        const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0)
        if (code === 0 || code === 15) continue
        const top = () => mid(i, j, i + 1, j), right = () => mid(i + 1, j, i + 1, j + 1), bottom = () => mid(i, j + 1, i + 1, j + 1), left = () => mid(i, j, i, j + 1)
        const pairs = { 1: [[left, bottom]], 2: [[bottom, right]], 3: [[left, right]], 4: [[top, right]], 5: [[left, top], [bottom, right]], 6: [[top, bottom]], 7: [[left, top]], 8: [[left, top]], 9: [[top, bottom]], 10: [[top, right], [left, bottom]], 11: [[top, right]], 12: [[left, right]], 13: [[bottom, right]], 14: [[left, bottom]] }[code]
        for (const [p, q] of pairs) segs.push([p(), q()])
      }
    }
    // Join the segments into lines by their shared ends, then simplify each.
    const key = ([a, b]) => `${Math.round(a * 100)},${Math.round(b * 100)}`
    const ends = new Map()
    segs.forEach((sg, n2) => [0, 1].forEach((e) => ends.set(key(sg[e]), [...(ends.get(key(sg[e])) ?? []), n2])))
    const used = new Set()
    const lines = []
    for (let n2 = 0; n2 < segs.length; n2++) {
      if (used.has(n2)) continue
      used.add(n2)
      const pts = [segs[n2][0], segs[n2][1]]
      for (const grow of ['end', 'start']) {
        for (;;) {
          const tip = grow === 'end' ? pts.at(-1) : pts[0]
          const next = (ends.get(key(tip)) ?? []).find((m) => !used.has(m))
          if (next === undefined) break
          used.add(next)
          const sg = segs[next]
          const far = key(sg[0]) === key(tip) ? sg[1] : sg[0]
          grow === 'end' ? pts.push(far) : pts.unshift(far)
        }
      }
      lines.push(pts)
    }
    const rdp = (pts, eps) => {
      if (pts.length < 3) return pts
      const [a, b] = [pts[0], pts.at(-1)]
      // A closed loop (start on end) is split at its farthest point, else it would fold into a dot.
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) {
        let at = 1
        for (let i = 1; i < pts.length - 1; i++) if (Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]) > Math.hypot(pts[at][0] - a[0], pts[at][1] - a[1])) at = i
        return [...rdp(pts.slice(0, at + 1), eps).slice(0, -1), ...rdp(pts.slice(at), eps)]
      }
      const dx = b[0] - a[0], dy = b[1] - a[1]
      const len = Math.hypot(dx, dy) || 1
      let far = 0, at = 0
      for (let i = 1; i < pts.length - 1; i++) {
        const dist = Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / len
        if (dist > far) (far = dist), (at = i)
      }
      return far > eps ? [...rdp(pts.slice(0, at + 1), eps).slice(0, -1), ...rdp(pts.slice(at), eps)] : [a, b]
    }
    return { W, H, lines: lines.filter((l) => l.length >= 6).map((l) => rdp(l, 0.8)) }
  }

  /**
   * A picture made a body that turns with the scene, so parts drawn from
   * pictures sit in one space with the engine's own: its silhouette turned on
   * a lathe when it is round (left and right mirror each other), else pushed
   * out to a slab with its strokes on the front face. Null when no outline.
   */
  const ROUND_WORDS = /\b(coils?|winding|cylinders?|tubes?|pipes?|drums?|barrels?|tanks?|cans?|bottles?|cups?|bowls?|vases?|jars?|lens|balls?|spheres?|globes?|cones?|domes?|wheels?|discs?|rings?|columns?|towers?|pillars?|chimney|funnel|bulb|cell|nucleus|planet|moon|sun|star|heart|kidney|egg|seed|trunk|stem|boiler|piston|shaft|spindle|rotor)\b/i
  const solidOf = (img, n) => {
    const px = pixels(img, 2)
    if (!px) return null
    const { W, H, lum } = px
    const s = (2.6 * n.r) / Math.max(W, H)
    const rows = []
    for (let j = 0; j < H; j += 4) {
      let a = -1, b = -1
      for (let i = 0; i < W; i++) if (lum(i, j) > 0.12) (a < 0 && (a = i), (b = i))
      if (a >= 0 && b - a > 2) rows.push([j, a, b])
    }
    if (rows.length < 4) return null
    const cx = rows.reduce((m, [, a, b]) => m + (a + b) / 2, 0) / rows.length
    const wide = Math.max(...rows.map(([, a, b]) => b - a))
    // Round when its kind or its words say so and every row's middle sits near one axis (a box seen face on mirrors too).
    const round = (['cylinder', 'sphere', 'cone', 'torus', 'droplet'].includes(n.kind) || ROUND_WORDS.test(n.words ?? '')) && rows.every(([, a, b]) => Math.abs((a + b) / 2 - cx) < wide * 0.08)
    const g = new T.Group()
    if (round) {
      const prof = [V(0, (H / 2 - rows[0][0]) * s, 0), ...rows.map(([j, a, b]) => new T.Vector2(((b - a) / 2) * s, (H / 2 - j) * s)), new T.Vector2(0, (H / 2 - rows.at(-1)[0]) * s)].map((p) => new T.Vector2(p.x, p.y))
      const body = solid(new T.LatheGeometry(prof, 28), 'ink', 0.05)
      body.position.x = (cx - W / 2) * s
      g.add(body)
      return g
    }
    const { lines } = traceLoops(img, 0.12, 2)
    const outline = lines.sort((p, q) => q.length - p.length)[0]
    if (!outline || outline.length < 8) return null
    const depth = wide * s * 0.3
    const shape = new T.Shape(outline.map(([x, y]) => new T.Vector2((x - W / 2) * s, (H / 2 - y) * s)))
    const geo = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 })
    geo.translate(0, 0, -depth / 2)
    g.add(solid(geo, 'ink', 0.05))
    const strokes = traceLines(img, 2.6 * n.r)
    if (strokes.length) {
      const face = new T.LineSegments(new T.BufferGeometry().setFromPoints(strokes), line('ink', 0.7))
      face.position.z = depth / 2 + 0.002
      g.add(face)
    }
    return g
  }

  /**
   * A part drawn from a picture (spec.js `image`): the image traced into the
   * house's line in the page (its light parts become ink, the black ground
   * nothing), on a plate that always faces the camera, sized to the node's
   * radius. Until it loads, nothing; a picture that will not load stays empty.
   */
  const picture = (n) => {
    const g = new T.Group()
    const img = new Image()
    img.onload = () => {
      // The lab's test of a body (globalThis.NODUS_VARIANT 'solid'): the picture's silhouette as a solid in the scene, not a plate.
      if (globalThis.NODUS_VARIANT === 'solid') {
        const body = solidOf(img, n)
        if (body) {
          g.add(body)
          g.userData.solid = true
          return redraw?.()
        }
      }
      // The lab's test of a vector trace (globalThis.NODUS_VARIANT 'vector'): the picture's strokes as the engine's own lines.
      if (globalThis.NODUS_VARIANT === 'vector') {
        const segs = traceLines(img, 2.6 * n.r)
        if (segs.length) g.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(segs), line('ink', 0.9)))
        return redraw?.()
      }
      const side = 512
      const k = side / Math.max(img.width, img.height)
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * k)
      c.height = Math.round(img.height * k)
      const x = c.getContext('2d')
      if (!x) return
      x.drawImage(img, 0, 0, c.width, c.height)
      const px = x.getImageData(0, 0, c.width, c.height)
      // Light is line: alpha from brightness, lifted hard so a hairline survives being drawn small; the colour is the token's.
      for (let i = 0; i < px.data.length; i += 4) {
        const v = (px.data[i] * 0.3 + px.data[i + 1] * 0.59 + px.data[i + 2] * 0.11) / 255
        px.data[i] = px.data[i + 1] = px.data[i + 2] = 255
        px.data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, (v - 0.15) * 3)))
      }
      x.putImageData(px, 0, 0)
      const tex = new T.CanvasTexture(c)
      // A little larger than the part's sphere: a picture's drawing stops short of its frame.
      const w = (2.6 * n.r * c.width) / Math.max(c.width, c.height)
      const h = (2.6 * n.r * c.height) / Math.max(c.width, c.height)
      tex.anisotropy = 4
      const m = tag(new T.MeshBasicMaterial({ map: tex, color: pal.ink, transparent: true, opacity: 1, depthWrite: false, side: T.DoubleSide }), 'ink', 1)
      m.userData.edge = true
      g.add(new T.Mesh(new T.PlaneGeometry(w, h), m))
      redraw?.()
    }
    img.src = n.image
    return { node: g, update: (t, dt, cam) => g.userData.solid || g.quaternion.copy(cam.quaternion) }
  }

  /**
   * A part from a 3D model (spec.js `mesh`: points and faces as JSON), drawn
   * as the house's x-ray body, centred and sized so its largest side is 2.4
   * radii. It turns with the set. Until it loads, nothing.
   */
  const mesh = (n) => {
    const g = new T.Group()
    fetch(n.mesh)
      .then((r) => r.json())
      .then(({ v, f }) => {
        const geo = new T.BufferGeometry()
        geo.setAttribute('position', new T.BufferAttribute(new Float32Array(v), 3))
        geo.setIndex(f)
        geo.computeBoundingBox()
        const size = geo.boundingBox.getSize(V())
        const mid = geo.boundingBox.getCenter(V())
        geo.translate(-mid.x, -mid.y, -mid.z)
        geo.scale(...Array(3).fill((2.4 * n.r) / Math.max(size.x, size.y, size.z, 1e-6)))
        geo.computeVertexNormals()
        g.add(solid(geo, 'ink', 0.05))
        redraw?.()
      })
      .catch(() => {})
    return { node: g }
  }

  // Each part by kind: `n` is the solved node (r, state, and the solver's own fields), `ctx.toward` the set's middle from it.
  const K = {
    // ── system: the lab's weather and light ──
    sun(n, ctx) {
      const g = new T.Group()
      const disc = new T.Mesh(new T.CircleGeometry(n.r, 48), flat('ochre', 0.9))
      g.add(disc, sprite('ochre', 0.35, n.r * 6))
      const beams = []
      for (let i = 0; i < 9; i++) {
        const dir = ctx.toward.clone().add(V((rnd() - 0.5) * 2.2, (rnd() - 0.5) * 1.4, (rnd() - 0.5) * 2.2)).normalize()
        const b = beam(V(), dir.multiplyScalar(ctx.toward.length() * (0.8 + rnd() * 0.6)), 0.18 + rnd() * 0.35, 0.16 + rnd() * 0.12)
        b.userData.phase = rnd() * 6
        g.add(b)
        beams.push(b)
      }
      return {
        node: g,
        update: (t, dt, cam) => {
          disc.lookAt(cam.position)
          for (const b of beams) {
            b.userData.face(cam, g.position)
            b.material.userData.base = 0.14 + 0.1 * (0.5 + 0.5 * Math.sin(t * 0.4 + b.userData.phase))
          }
        },
      }
    },
    light(n, ctx) {
      const g = new T.Group()
      const b = beam(V(), ctx.toward.clone(), n.r * 0.75, 0.35)
      g.add(b)
      return { node: g, update: (t, dt, cam) => b.userData.face(cam, g.position) }
    },
    cloud(n) {
      const g = new T.Group()
      const s = n.r
      for (let i = 0; i < 8; i++) {
        const p = sprite('faint', 0.22, s * (0.9 + rnd() * 0.8))
        p.position.set((rnd() - 0.5) * s * 2.2, (rnd() - 0.3) * s * 0.7, (rnd() - 0.5) * s)
        g.add(p)
      }
      const x0 = n.x
      return { node: g, update: (t) => (g.position.x = x0 + Math.sin(t * 0.12) * 0.3) }
    },
    rain(n) {
      const count = 500
      const area = V(n.r * 4, n.r * 3, n.r * 3)
      const pos = new Float32Array(count * 6)
      const speed = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        const x = (rnd() - 0.5) * area.x
        const y = (rnd() - 0.5) * area.y
        const z = (rnd() - 0.5) * area.z
        pos.set([x, y, z, x, y - 0.22, z], i * 6)
        speed[i] = 2.2 + rnd() * 1.6
      }
      const geo = new T.BufferGeometry()
      geo.setAttribute('position', new T.BufferAttribute(pos, 3))
      const ls = new T.LineSegments(geo, line('muted', 0.45))
      ls.userData.solid = false
      return {
        node: ls,
        update: (t, dt) => {
          const a = geo.attributes.position.array
          const half = area.y / 2
          for (let i = 0; i < count; i++) {
            const d = speed[i] * dt
            a[i * 6 + 1] -= d
            a[i * 6 + 4] -= d
            if (a[i * 6 + 1] < -half) {
              a[i * 6 + 1] += area.y
              a[i * 6 + 4] += area.y
            }
          }
          geo.attributes.position.needsUpdate = true
        },
      }
    },
    droplet(n) {
      const g = new T.Group()
      const r = n.r
      g.add(new T.Mesh(new T.IcosahedronGeometry(r, 3), wash('ink', 0.05)))
      const cage = edges(new T.IcosahedronGeometry(r, 1), 'ink', 0.35)
      g.add(cage, new T.LineLoop(new T.BufferGeometry().setFromPoints(circle(r, 96)), line('ink', 0.9)))
      // Sunlight enters, refracts, reflects off the back, refracts out, and fans into the spectrum.
      const inDir = V(-1, 0.45, 0).normalize().negate()
      const entry = inDir.clone().negate().multiplyScalar(r).applyAxisAngle(V(0, 0, 1), -0.55)
      const back = entry.clone().applyAxisAngle(V(0, 0, 1), Math.PI * 0.82)
      const exit = back.clone().applyAxisAngle(V(0, 0, 1), Math.PI * 0.82)
      const start = entry.clone().sub(inDir.clone().multiplyScalar(r * 3.2))
      g.add(path([start, entry, back, exit], 'ochre', 0.95), arrowHead(entry.clone().lerp(start, 0.35), entry.clone().sub(start), 'ochre', r * 0.18))
      const outDir = exit.clone().sub(back).normalize()
      SPECTRUM.forEach((c, i) => {
        const d = outDir.clone().applyAxisAngle(V(0, 0, 1), (i - 3) * 0.045)
        g.add(new T.Line(new T.BufferGeometry().setFromPoints([exit, exit.clone().add(d.multiplyScalar(r * 3.4))]), tag(new T.LineBasicMaterial({ color: new T.Color(c), transparent: true, opacity: 0.85 }), null, 0.85)))
      })
      return { node: g, update: (t) => (cage.rotation.y = t * 0.15) }
    },
    rainbow(n) {
      const g = new T.Group()
      const w = 0.13
      SPECTRUM.forEach((c, i) => g.add(new T.Mesh(new T.TorusGeometry(n.r - i * w, w * 0.48, 6, 96, Math.PI), hue(c, 0.72))))
      return { node: g }
    },
    ray(n) {
      // Standing on a part's side (a force on a body), it points out of that side, from the surface; else across.
      const d = n.dir && Math.hypot(...n.dir) > 0 ? V(...n.dir).normalize() : V(1, 0, 0)
      const from = n.dir ? d.clone().multiplyScalar(-n.r * 0.9) : V(-n.r * 1.5, 0, 0)
      const to = n.dir ? d.clone().multiplyScalar(n.r * 1.1) : V(n.r * 1.5, 0, 0)
      const g = new T.Group()
      const dot = new T.Mesh(new T.SphereGeometry(0.04, 8, 8), flat('ochre', 1))
      g.add(path([from, to], 'ochre'), arrowHead(to.clone().lerp(from, 0.06), to.clone().sub(from), 'ochre', 0.16), dot)
      let k = rnd()
      return {
        node: g,
        update: (t, dt) => {
          k = (k + dt * 0.35) % 1
          dot.position.lerpVectors(from, to, k)
        },
      }
    },
    plane(n) {
      const g = new T.Group()
      const geo = new T.PlaneGeometry(n.r * 2.5, n.r * 1.6)
      g.add(new T.Mesh(geo, wash('ink', 0.05)), bold(edges(geo, 'ink', 0.8)))
      return { node: g }
    },
    ground(n) {
      const g = new T.Group()
      const size = Math.round(n.r * 3)
      const grid = new T.GridHelper(size, size, pal.faint, pal.faint)
      tag(grid.material, 'faint', 0.22)
      grid.material.transparent = true
      grid.material.opacity = 0.22
      g.add(grid)
      return { node: g }
    },
    observer(n) {
      const g = new T.Group()
      const h = n.r * 1.7
      const pts = []
      const seg = (a, b) => pts.push(V(...a), V(...b))
      seg([0, h * 0.62, 0], [0, h * 0.2, 0])
      seg([0, h * 0.2, 0], [-h * 0.16, 0, 0])
      seg([0, h * 0.2, 0], [h * 0.16, 0, 0])
      seg([-h * 0.2, h * 0.5, 0], [h * 0.2, h * 0.5, 0])
      const head = loop(h * 0.11)
      head.position.y = h * 0.74
      g.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(pts), line('ink', 0.95)), head)
      return { node: g, update: (t, dt, cam) => g.lookAt(cam.position.x, g.position.y, cam.position.z) }
    },
    prism(n) {
      const g = solid(new T.CylinderGeometry(n.r * 0.7, n.r * 0.7, n.r * 1.2, 3))
      g.rotation.z = Math.PI / 2
      return { node: g }
    },
    orbit(n) {
      const g = new T.Group()
      const body = new T.Mesh(new T.SphereGeometry(0.15, 16, 16), flat('ink', 1))
      g.add(loop(n.r, 'faint', 0.8, 'xz'), body)
      return { node: g, update: (t) => body.position.set(Math.cos(t * 0.25) * n.r, 0, Math.sin(t * 0.25) * n.r) }
    },
    // An object's part with no form of its own: a plain block.
    part: (n) => ({ node: solid(new T.BoxGeometry(n.r * 1.2, n.r * 1.2, n.r * 1.2), 'ink', 0.04) }),
    sphere: (n) => shape(new T.IcosahedronGeometry(n.r * 0.85, 1)),
    box: (n) => shape(new T.BoxGeometry(n.r * 1.2, n.r * 1.2, n.r * 1.2)),
    cylinder: (n) => shape(new T.CylinderGeometry(n.r * 0.6, n.r * 0.6, n.r * 1.4, 14)),
    cone: (n) => shape(new T.ConeGeometry(n.r * 0.75, n.r * 1.4, 14)),
    torus(n) {
      const geo = new T.TorusGeometry(n.r * 0.8, n.r * 0.28, 8, 24)
      const g = new T.Group()
      g.add(new T.Mesh(geo, wash('ink', 0.04)), new T.LineSegments(new T.WireframeGeometry(geo), line('ink', 0.6)))
      return spin(g)
    },
    arrow: (n) => K.ray(n),

    // ── the engraver's parts: a point cloud, stacked level lines, a building's floor ──
    // A dense seeded point cloud inside a silhouette: a tree, a cloud, a crowd, a forest.
    field(n) {
      const r = n.r
      const inside = silhouette(n.shape ?? 'cloud', r)
      const pts = []
      for (let tries = 0; pts.length < 2600 * 3 && tries < 60000; tries++) {
        const x = (rnd() * 2 - 1) * r
        const y = (rnd() * 2 - 1) * r
        const z = (rnd() * 2 - 1) * r
        if (inside(x, y, z)) pts.push(x, y, z)
      }
      const geo = new T.BufferGeometry()
      geo.setAttribute('position', new T.BufferAttribute(new Float32Array(pts), 3))
      const cloud = new T.Points(geo, tag(new T.PointsMaterial({ color: pal.ink, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.75, depthWrite: false }), 'ink', 0.75))
      return { node: cloud }
    },
    // A terrain as stacked level lines from a seeded height (a hill, an island, a valley), with tiny trees and huts on its slopes.
    contour(n) {
      const g = new T.Group()
      const levels = 11
      const H = n.r * 0.55
      // From a heightmap (n.height, seen from above): each level is where the picture crosses that brightness, laid flat at its height.
      if (n.height) {
        const img = new Image()
        img.onload = () => {
          for (let j = 0; j < levels; j++) {
            const t = j / (levels - 1)
            const segs = traceLines(img, 2.4 * n.r, 0.06 + t * 0.86, 6).map((p) => V(p.x, -H / 2 + t * H, -p.y))
            if (segs.length) g.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(segs), line(j === 0 ? 'ink' : 'muted', j === 0 ? 0.9 : 0.7)))
          }
          redraw?.()
        }
        img.src = n.height
        return { node: g }
      }
      const waves = [2, 3, 5].map((k) => [k, 0.05 + rnd() * 0.07, rnd() * Math.PI * 2])
      const rim = (a) => n.r * (1 + waves.reduce((sum, [k, amp, ph]) => sum + amp * Math.cos(k * a + ph), 0))
      const valley = n.shape === 'valley'
      // How far out a level reaches at an angle: t is 0 at the foot and 1 at the top (a valley turns it inside out).
      const reach = (a, t) => rim(a) * (valley ? 0.25 + 0.75 * t : Math.pow(1 - t * 0.94, 0.8))
      for (let j = 0; j < levels; j++) {
        const t = j / (levels - 1)
        const wob = rnd() * Math.PI * 2
        const ring = Array.from({ length: 97 }, (_, i) => {
          const a = (i / 96) * Math.PI * 2
          const q = reach(a, t) * (1 + 0.025 * Math.sin(4 * a + wob))
          return V(Math.cos(a) * q, -H / 2 + t * H, Math.sin(a) * q)
        })
        g.add(j === 0 ? bold(path(ring, 'ink', 0.9)) : path(ring, 'muted', 0.7))
      }
      if (n.shape === 'island') g.add(new T.LineLoop(new T.BufferGeometry().setFromPoints(circle(n.r * 1.25, 96, 'xz').map((p) => p.setY(-H / 2))), tag(new T.LineDashedMaterial({ color: pal.faint, transparent: true, opacity: 0.6, dashSize: 0.08, gapSize: 0.06 }), 'faint', 0.6)).computeLineDistances())
      // Tiny line trees and two huts on the lower slopes.
      const marks = []
      const seg = (a, b) => marks.push(V(...a), V(...b))
      for (let i = 0; i < 18; i++) {
        const a = rnd() * Math.PI * 2
        const t = 0.1 + rnd() * 0.45
        const q = reach(a, t) * (0.9 + rnd() * 0.08)
        const [x, y, z] = [Math.cos(a) * q, -H / 2 + t * H, Math.sin(a) * q]
        const s = n.r * 0.05
        if (i < 2) {
          // A hut: a box's front and its roof.
          seg([x - s, y, z], [x + s, y, z]), seg([x - s, y, z], [x - s, y + s, z]), seg([x + s, y, z], [x + s, y + s, z])
          seg([x - s * 1.2, y + s, z], [x, y + s * 1.8, z]), seg([x, y + s * 1.8, z], [x + s * 1.2, y + s, z])
        } else {
          seg([x, y, z], [x, y + s * 0.8, z]), seg([x - s * 0.6, y + s * 0.6, z], [x, y + s * 2, z]), seg([x, y + s * 2, z], [x + s * 0.6, y + s * 0.6, z])
        }
      }
      g.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(marks), line('ink', 0.8)))
      return { node: g }
    },
    // A building's floor: its slab, a seeded plan of walls on it, posts up to the storey's rim.
    stack(n) {
      const g = new T.Group()
      const w = n.r * 2
      const d = n.r * 1.3
      const up = 0.62
      g.add(solid(new T.BoxGeometry(w, 0.07, d), 'ink', 0.06))
      const lines = []
      const seg = (a, b) => lines.push(V(...a), V(...b))
      const top = 0.035
      for (let i = 0; i < 2 + Math.floor(rnd() * 2); i++) {
        const x = (rnd() - 0.5) * w * 0.8
        const z0 = (rnd() - 0.5) * d * 0.3
        rnd() < 0.5 ? seg([x, top, -d / 2], [x, top, z0]) : seg([x, top, z0], [x, top, d / 2])
      }
      const zw = (rnd() - 0.5) * d * 0.5
      seg([-w / 2, top, zw], [-w * 0.1, top, zw])
      const posts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1]]
      for (const [px, pz] of posts) seg([(px * w) / 2, top, (pz * d) / 2], [(px * w) / 2, up, (pz * d) / 2])
      for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0]]) seg([(posts[a][0] * w) / 2, up, (posts[a][1] * d) / 2], [(posts[b][0] * w) / 2, up, (posts[b][1] * d) / 2])
      g.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(lines), line('ink', 0.75)))
      // The floor's cut face: hatched, shown while the building is pulled apart (the stage toggles `cut`).
      if (hatchTex) {
        const plane = new T.PlaneGeometry(w, d)
        const uv = plane.attributes.uv
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * d)
        const cutFace = hatch(plane, 'ink', 0.5)
        cutFace.rotation.x = -Math.PI / 2
        cutFace.position.y = 0.036
        cutFace.userData.cut = true
        cutFace.visible = false
        g.add(cutFace)
      }
      return { node: g }
    },

    // ── fluid: front-on, the pipes run in the xy plane ──
    source(n) {
      const g = new T.Group()
      g.add(loop(n.r), path([V(n.r * 0.2, 0, 0), V(n.r, 0, 0)]), arrowHead(V(n.r * 0.9, 0, 0), V(1, 0, 0), 'ink', n.r * 0.3))
      const wave = path(Array.from({ length: 13 }, (_, i) => V(-n.r * 0.6 + i * 0.1 * n.r, Math.sin(i) * 0.08 * n.r, 0)), 'muted')
      g.add(wave)
      return { node: g, update: (t) => (wave.position.y = Math.sin(t * 2) * 0.05 * n.r) }
    },
    tank(n) {
      const g = new T.Group()
      const s = n.r * 2
      const level = n.state === 'full' ? 0.85 : n.state === 'empty' ? 0.12 : 0.55
      const fill = new T.Mesh(new T.BoxGeometry(s * 0.96, s * level, s * 0.6), wash(n.state === 'hot' ? 'ochre' : 'muted', n.state === 'gas' ? 0.08 : 0.18))
      fill.position.y = -s / 2 + (s * level) / 2
      const top = path([V(-s / 2, fill.position.y + (s * level) / 2, s * 0.3), V(s / 2, fill.position.y + (s * level) / 2, s * 0.3)], 'muted', 0.9)
      g.add(edges(new T.BoxGeometry(s, s, s * 0.6)), fill, top)
      return { node: g }
    },
    reservoir: (n) => K.tank({ ...n, state: n.state ?? 'full' }),
    pump(n) {
      const g = new T.Group()
      const blades = new T.LineSegments(new T.BufferGeometry().setFromPoints([0, 1, 2, 3].flatMap((i) => [V(), V(Math.cos((i * Math.PI) / 2) * n.r * 0.8, Math.sin((i * Math.PI) / 2) * n.r * 0.8, 0)])), line('ink', 0.9))
      g.add(new T.Mesh(new T.CircleGeometry(n.r, 48), wash('ink', 0.05)), loop(n.r), blades)
      return { node: g, update: (t) => (blades.rotation.z = -t * 3) }
    },
    valve(n) {
      const r = n.r
      const pts = [V(-r, -r * 0.6), V(r, r * 0.6), V(r, -r * 0.6), V(-r, r * 0.6), V(-r, -r * 0.6)]
      const g = new T.Group()
      g.add(path(pts), path([V(0, 0), V(0, r * 1.1)]), path([V(-r * 0.5, r * 1.1), V(r * 0.5, r * 1.1)]))
      return { node: g }
    },
    sink(n) {
      const g = solid(new T.ConeGeometry(n.r, n.r * 1.4, 18, 1, true))
      g.rotation.z = Math.PI
      return { node: g }
    },

    // ── mechanism: front-on gears; each turns at its solved speed and phase ──
    // A spur gear: trapezoid teeth round the pitch circle, the rim, a hub with its bore and keyway, spokes on a large one; front and back faces, so its width shows.
    gear(n) {
      const g = new T.Group()
      const tip = n.r + 0.1
      const root = n.r - 0.12
      const pts = []
      for (let i = 0; i < n.teeth; i++) {
        const a = (i / n.teeth) * Math.PI * 2
        const w = Math.PI / n.teeth
        for (const [da, r] of [[-w * 0.5, root], [-w * 0.3, tip], [w * 0.3, tip], [w * 0.5, root]]) pts.push(V(Math.cos(a + da) * r, Math.sin(a + da) * r, 0))
      }
      const depth = Math.min(0.18, 0.05 + n.r * 0.12)
      const hub = Math.max(0.07, n.r * 0.2)
      const bore = hub * 0.45
      const faceOf = (z, o) => {
        const f = new T.Group()
        const teeth = new T.LineLoop(new T.BufferGeometry().setFromPoints(pts), line('ink', 0.9 * o))
        f.add(o === 1 ? bold(teeth) : teeth, loop(hub, 'ink', 0.85 * o), loop(bore, 'ink', 0.8 * o))
        f.position.z = z
        return f
      }
      g.add(occlude(new T.Mesh(new T.ShapeGeometry(new T.Shape(pts.map((p) => new T.Vector2(p.x, p.y)))), wash('ink', 0.05))), faceOf(depth / 2, 1), faceOf(-depth / 2, 0.4))
      // The keyway: a small notch in the bore.
      g.add(path([V(-bore * 0.3, bore * 0.95, depth / 2), V(-bore * 0.3, bore * 1.35, depth / 2), V(bore * 0.3, bore * 1.35, depth / 2), V(bore * 0.3, bore * 0.95, depth / 2)], 'ink', 0.8))
      if (n.r > 0.5) {
        const rim = root - 0.1
        g.add(loop(rim, 'ink', 0.6))
        const spokes = []
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2
          for (const s2 of [-1, 1]) {
            const off = s2 * Math.min(0.06, n.r * 0.06)
            const nx = -Math.sin(a) * off
            const ny = Math.cos(a) * off
            spokes.push(V(Math.cos(a) * hub + nx, Math.sin(a) * hub + ny, depth / 2), V(Math.cos(a) * rim + nx, Math.sin(a) * rim + ny, depth / 2))
          }
        }
        g.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(spokes), line('ink', 0.55)))
      }
      g.rotation.z = n.phase
      return { node: g, update: (t) => (g.rotation.z = n.phase + n.spin * n.speed * t * 0.6) }
    },
    // A shaft: a rod along its axis (z), its two ends and a collar.
    shaft(n) {
      const g = new T.Group()
      const r = Math.max(0.05, n.r * 0.5)
      const len = 1.2
      const made = vessel([[r, -len / 2], [r, len / 2]], { seams: [0, 1] })
      made.node.rotation.x = Math.PI / 2
      const collar = loop(r * 1.8, 'ink', 0.8)
      g.add(made.node, collar)
      return { node: g, update: (t, dt, cam) => made.update(t, dt, cam) }
    },
    crank(n) {
      const g = new T.Group()
      const arm = new T.Group()
      arm.add(path([V(), V(n.r, 0)]), new T.Mesh(new T.CircleGeometry(0.06, 16), flat('ink', 1)))
      arm.children[1].position.x = n.r
      g.add(loop(n.r * 0.35), arm)
      return { node: g, update: (t) => (arm.rotation.z = n.spin * n.speed * t * 0.6) }
    },
    lever(n) {
      const g = new T.Group()
      const bar = solid(new T.BoxGeometry(n.r * 2.4, 0.08, 0.08))
      const fulcrum = path([V(-0.15, -0.3), V(0, -0.04), V(0.15, -0.3), V(-0.15, -0.3)])
      g.add(bar, fulcrum)
      return { node: g, update: (t) => (bar.rotation.z = Math.sin(t * n.speed * 1.2) * 0.18) }
    },
    piston(n) {
      const g = new T.Group()
      const head = solid(new T.BoxGeometry(n.r * 1.1, n.r * 0.5, 0.1))
      g.add(path([V(-n.r * 0.6, -n.r * 1.1), V(-n.r * 0.6, n.r * 1.1)]), path([V(n.r * 0.6, -n.r * 1.1), V(n.r * 0.6, n.r * 1.1)]), head)
      return { node: g, update: (t) => (head.position.y = Math.sin(t * n.speed * 2) * n.r * 0.5) }
    },
    belt: (n) => ({ node: loop(n.r) }),

    // ── orbital: seen from above; the stage moves the bodies along their orbits ──
    center(n) {
      const g = solid(new T.IcosahedronGeometry(n.r, 2), 'ink', 0.06)
      if (n.state !== 'dark') g.add(sprite('faint', 0.3, n.r * 4))
      return spin(g, 0.05)
    },
    body: (n) => spin(solid(new T.IcosahedronGeometry(n.r, 1), 'ink', n.state === 'dark' ? 0.2 : 0.05), 0.3),
    moon: (n) => ({ node: solid(new T.IcosahedronGeometry(n.r, 1), 'ink', 0.12) }),
    ring(n) {
      const geo = new T.RingGeometry(n.r * 0.8, n.r, 64)
      const m = new T.Mesh(geo, wash('ink', 0.08))
      m.rotation.x = -Math.PI / 2 + 0.35
      const g = new T.Group()
      g.add(m)
      return { node: g }
    },
  }

  // ── Drawn as a technical plate ─────────────────────────────────────────────
  // Real proportions from simple solids: a vessel is a lathe of its profile,
  // drawn as its seams and its outline (two profile lines turned to the eye
  // every frame, which is where a body of revolution's silhouette is), with a
  // light wash. Flat outlines (a cloud, a figure, a planet's disc) face the eye.
  const face = (g) => (t, dt, cam) => g.quaternion.copy(cam.quaternion)
  /** A body of revolution from its profile `[[r, y], ...]` (bottom to top), with rings at `seams` (indices into the profile). */
  const vessel = (profile, { seams = [], fill = 0.05, tone = 'ink', cut = 0, closed = false } = {}) => {
    const g = new T.Group()
    // Only a closed vessel hides what is behind it: an open one (a reservoir, a sink) is seen into, and a droplet shows the light inside it.
    const body = new T.Mesh(new T.LatheGeometry(profile.map(([r, y]) => new T.Vector2(Math.max(r, 1e-3), y)), 48), wash(tone, fill))
    g.add(closed ? occlude(body, 0.9) : body)
    for (const i of seams) {
      const ring = loop(Math.max(profile[i][0], 1e-3), tone, 0.85, 'xz')
      ring.position.y = profile[i][1]
      g.add(ring)
    }
    const outline = new T.Group()
    outline.add(bold(path(profile.map(([r, y]) => V(r, y, 0)), tone, 0.9)), bold(path(profile.map(([r, y]) => V(-r, y, 0)), tone, 0.9)))
    // A cut view: the wall's section on each side of the outline, `cut` thick, hatched (a vessel drawn as a sectioned plate).
    if (cut > 0 && hatchTex) {
      for (const side of [1, -1]) {
        const wall = new T.Shape([...profile.map(([r, y]) => new T.Vector2(side * r, y)), ...[...profile].reverse().map(([r, y]) => new T.Vector2(side * Math.max(0, r - cut), y))])
        outline.add(hatch(new T.ShapeGeometry(wall)))
      }
    }
    g.add(outline)
    // The outline turns about the vessel's own axis to face the eye.
    const at = V()
    return { node: g, update: (t, dt, cam) => (g.getWorldPosition(at), (outline.rotation.y = Math.atan2(cam.position.x - at.x, cam.position.z - at.z))) }
  }
  /** A short nozzle (flange and neck) standing out of a vessel, along `dir`. */
  const nozzle = (at, dir, r) => {
    const g = new T.Group()
    const len = r * 2.2
    g.add(path([V(-r, 0, 0), V(-r, len, 0)], 'ink', 0.85), path([V(r, 0, 0), V(r, len, 0)], 'ink', 0.85))
    const flange = loop(r * 1.7, 'ink', 0.85, 'xz')
    flange.position.y = len
    g.add(flange)
    g.position.copy(at)
    g.quaternion.setFromUnitVectors(V(0, 1, 0), dir.clone().normalize())
    return g
  }
  /** A circle's union outline: the arcs of each circle not inside another (a cloud's lumped edge). */
  const lumps = (circles) => {
    const pts = []
    for (const [cx, cy, r] of circles) {
      let run = []
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2
        const p = [cx + Math.cos(a) * r, cy + Math.sin(a) * r]
        const hidden = circles.some(([x, y, rr]) => (x !== cx || y !== cy) && Math.hypot(p[0] - x, p[1] - y) < rr - 1e-6) || p[1] < -0.32 * circles[0][2]
        if (!hidden) run.push(V(p[0], p[1], 0))
        if ((hidden || i === 72) && run.length > 1) pts.push(run)
        if (hidden) run = []
      }
    }
    return pts
  }
  /** A sphere as drawn: its outline facing the eye, the half away from the light hatched, the terminator between. */
  const globe = (n, ctx, { hatch = 7, fill = 0.04 } = {}) => {
    const g = new T.Group()
    const disc = new T.Group()
    const r = n.r
    disc.add(occlude(new T.Mesh(new T.CircleGeometry(r, 48), wash('ink', fill))), bold(loop(r, 'ink', 0.9)))
    const shade = new T.Group()
    const lines = []
    for (let i = 1; i <= hatch; i++) {
      const d = (i / (hatch + 1)) * r
      const half = Math.sqrt(r * r - d * d)
      lines.push(V(-half, -d, 0), V(half, -d, 0))
    }
    shade.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(lines), line('muted', 0.45)), path([V(-r, 0, 0), V(r, 0, 0)], 'muted', 0.6))
    disc.add(shade)
    g.add(disc)
    const at = V()
    const toLight = V()
    return {
      node: g,
      update: (t, dt, cam) => {
        disc.quaternion.copy(cam.quaternion)
        // The dark half is the one turned from the center (the light): its direction on the eye's plane sets the hatch.
        g.getWorldPosition(at)
        toLight.copy(ctx.center?.() ?? V()).sub(at)
        if (toLight.lengthSq() < 1e-6) return void (shade.visible = false)
        shade.visible = n.state !== 'lit'
        const local = toLight.applyQuaternion(cam.quaternion.clone().invert())
        shade.rotation.z = Math.atan2(local.y, local.x) - Math.PI / 2
      },
    }
  }
  /** A ring of rays round a disc, long and short by turns: the sun as engravers draw it. */
  const corona = (r, tone = 'ochre') => {
    const pts = []
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      const out = r * (i % 2 ? 1.45 : 1.8)
      pts.push(V(Math.cos(a) * r * 1.18, Math.sin(a) * r * 1.18, 0), V(Math.cos(a) * out, Math.sin(a) * out, 0))
    }
    return new T.LineSegments(new T.BufferGeometry().setFromPoints(pts), line(tone, 0.85))
  }
  // A standing figure's outline, seven and a half heads tall, facing the eye: x across, y up, from the ground.
  const FIGURE = [[0.06, 0], [0.1, 0.46], [0.12, 0.52], [0.16, 0.8], [0.19, 0.6], [0.22, 0.6], [0.2, 0.82], [0.17, 0.84], [0.06, 0.85], [0.055, 0.88], [0.09, 0.92], [0.09, 0.98], [0.05, 1.0], [0, 1.0]]

  Object.assign(K, {
    // A vessel: a cylinder with a dished head, a skirt, the fill line where its level is, an inlet on top and an outlet low on its side.
    tank(n) {
      const r = n.r * 0.78
      const h = n.r * 1.6
      const head = Array.from({ length: 7 }, (_, i) => [r * Math.cos((i / 6) * (Math.PI / 2)), h / 2 + r * 0.38 * Math.sin((i / 6) * (Math.PI / 2))])
      const made = vessel([[r * 0.92, -h / 2 - n.r * 0.12], [r, -h / 2], [r, h / 2], ...head.slice(1)], { seams: [0, 1, 2], cut: r * 0.08, closed: true })
      const level = n.state === 'full' ? 0.85 : n.state === 'empty' ? 0.12 : 0.55
      const fill = new T.Mesh(new T.CylinderGeometry(r * 0.985, r * 0.985, h * level, 40, 1, true), wash(n.state === 'hot' ? 'ochre' : 'muted', n.state === 'gas' ? 0.06 : 0.16))
      fill.position.y = -h / 2 + (h * level) / 2
      const line = loop(r * 0.99, n.state === 'hot' ? 'ochre' : 'muted', 0.9, 'xz')
      line.position.y = -h / 2 + h * level
      made.node.add(fill, line, nozzle(V(0, h / 2 + r * 0.38, 0), V(0, 1, 0), r * 0.14), nozzle(V(r, -h / 2 + r * 0.35, 0), V(1, 0, 0), r * 0.12))
      return made
    },
    // A reservoir: wide and low, open at the top, its rim drawn.
    reservoir(n) {
      const r = n.r * 1.05
      const h = n.r * 0.9
      const made = vessel([[r * 0.97, -h / 2], [r, -h / 2 + 0.04], [r, h / 2], [r * 1.05, h / 2]], { seams: [0, 2, 3], cut: r * 0.06 })
      const fill = new T.Mesh(new T.CylinderGeometry(r * 0.98, r * 0.98, h * 0.7, 40, 1, true), wash('muted', 0.14))
      fill.position.y = -h / 2 + h * 0.35
      const surface = loop(r * 0.98, 'muted', 0.8, 'xz')
      surface.position.y = -h / 2 + h * 0.7
      made.node.add(fill, surface)
      return made
    },
    // A centrifugal pump: the volute's spiral round the impeller, its outlet tangent, on a base plate.
    pump(n) {
      const g = new T.Group()
      const r = n.r
      const spiral = Array.from({ length: 65 }, (_, i) => {
        const a = (i / 64) * Math.PI * 2
        const q = r * (0.72 + 0.28 * (i / 64))
        return V(Math.cos(a) * q, Math.sin(a) * q, 0)
      })
      const end = spiral.at(-1)
      const outlet = [V(end.x, end.y, 0), V(end.x, end.y + r * 0.55, 0), V(end.x - r * 0.3, end.y + r * 0.55, 0), V(end.x - r * 0.3, spiral[0].y + r * 0.72, 0)]
      const casing = new T.Group()
      casing.add(new T.Mesh(new T.CircleGeometry(r * 0.9, 40), wash('ink', 0.05)), bold(path(spiral)), bold(path(outlet)), loop(r * 0.22))
      const back = casing.clone()
      back.position.z = -r * 0.5
      back.traverse((o) => o.material && (o.material = o.material.clone(), (o.material.opacity *= 0.45), (o.material.userData = { ...o.material.userData, base: o.material.opacity })))
      const blades = new T.Group()
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        blades.add(path(Array.from({ length: 6 }, (_, k) => {
          const q = r * (0.24 + 0.1 * k)
          const b = a + k * 0.12
          return V(Math.cos(b) * q, Math.sin(b) * q, 0.01)
        }), 'ink', 0.6))
      }
      const base = edges(new T.BoxGeometry(r * 1.9, r * 0.12, r * 0.9))
      base.position.set(0, -r * 1.02, -r * 0.25)
      g.add(back, casing, blades, base)
      return { node: g, update: (t) => (blades.rotation.z = -t * 3) }
    },
    // A gate valve: its body between two flanges, the bonnet, the stem and the handwheel on top.
    valve(n) {
      const g = new T.Group()
      const r = n.r
      const bodyProfile = [[r * 0.32, -r], [r * 0.5, -r * 0.4], [r * 0.5, r * 0.4], [r * 0.32, r]]
      const body = vessel(bodyProfile, { seams: [1, 2] })
      body.node.rotation.z = Math.PI / 2
      for (const sx of [-1, 1]) {
        const flange = loop(r * 0.42, 'ink', 0.9, 'xz')
        flange.position.set(sx * r, 0, 0)
        flange.rotation.z = Math.PI / 2
        g.add(flange)
      }
      const bonnet = vessel([[r * 0.28, 0], [r * 0.28, r * 0.5], [r * 0.12, r * 0.6]], { seams: [1] })
      bonnet.node.position.y = r * 0.45
      const wheel = new T.Group()
      const rim = new T.Mesh(new T.TorusGeometry(r * 0.45, r * 0.035, 6, 40), wash('ink', 0.3))
      rim.rotation.x = Math.PI / 2
      wheel.add(rim, loop(r * 0.45, 'ink', 0.9, 'xz'))
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2
        wheel.add(path([V(0, 0, 0), V(Math.cos(a) * r * 0.45, 0, Math.sin(a) * r * 0.45)], 'ink', 0.8))
      }
      wheel.position.y = r * 1.35
      g.add(body.node, bonnet.node, path([V(0, r * 1.05, 0), V(0, r * 1.45, 0)]), wheel)
      return { node: g, update: (t, dt, cam) => (body.update(t, dt, cam), bonnet.update(t, dt, cam)) }
    },
    // A source: a flanged inlet with the water's surface over it.
    source(n) {
      const g = new T.Group()
      const r = n.r
      const made = vessel([[r * 0.55, -r * 0.7], [r * 0.6, -r * 0.6], [r * 0.6, r * 0.25], [r * 0.85, r * 0.25], [r * 0.85, r * 0.4], [r * 0.6, r * 0.4]], { seams: [1, 2, 3, 4] })
      const waves = new T.Group()
      for (let k = 0; k < 3; k++) waves.add(path(Array.from({ length: 17 }, (_, i) => V(-r * 0.6 + i * 0.075 * r, r * (0.62 + k * 0.17) + Math.sin(i * 0.9 + k) * 0.05 * r, 0)), k ? 'muted' : 'ink', k ? 0.6 : 0.85))
      g.add(made.node, waves)
      return { node: g, update: (t, dt, cam) => (made.update(t, dt, cam), waves.quaternion.copy(cam.quaternion), (waves.position.y = Math.sin(t * 1.5) * 0.03 * r)) }
    },
    // A sink: a drain's funnel with its grate.
    sink(n) {
      const r = n.r
      const made = vessel([[r * 0.18, -r * 0.9], [r * 0.18, -r * 0.4], [r * 0.95, r * 0.35], [r, r * 0.42]], { seams: [1, 2, 3] })
      const bars = []
      for (let i = -2; i <= 2; i++) bars.push(V(i * r * 0.3, r * 0.4, -Math.sqrt(Math.max(0, r * r * 0.9 - (i * r * 0.3) ** 2))), V(i * r * 0.3, r * 0.4, Math.sqrt(Math.max(0, r * r * 0.9 - (i * r * 0.3) ** 2))))
      made.node.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(bars), line('muted', 0.6)))
      return made
    },

    // ── system: light and weather, drawn ──
    // The sun: a disc and its corona of rays, in the one colour that points.
    sun(n, ctx) {
      const g = new T.Group()
      const disc = new T.Group()
      disc.add(new T.Mesh(new T.CircleGeometry(n.r, 48), flat('ochre', 0.25)), loop(n.r, 'ochre', 0.95), corona(n.r))
      const rays = new T.Group()
      for (let i = 0; i < 5; i++) {
        const dir = ctx.toward.clone().normalize().applyAxisAngle(V(0, 1, 0), (i - 2) * 0.09).applyAxisAngle(V(0, 0, 1), (i - 2) * 0.05)
        rays.add(path([dir.clone().multiplyScalar(n.r * 2), dir.clone().multiplyScalar(ctx.toward.length() * 0.75)], 'ochre', 0.35))
      }
      g.add(disc, rays)
      return { node: g, update: (t, dt, cam) => disc.quaternion.copy(cam.quaternion) }
    },
    // A cloud: the lumped edge of a few seeded rounds, flat underneath, a few inner folds.
    cloud(n) {
      const g = new T.Group()
      const s = n.r
      const circles = [[0, 0, s * 0.55], [-s * 0.55, -s * 0.12, s * 0.4], [s * 0.6, -s * 0.1, s * 0.42], [-s * 0.2 + rnd() * s * 0.2, s * 0.32, s * 0.38], [s * 0.3, s * 0.22, s * 0.35]]
      const flatG = new T.Group()
      for (const run of lumps(circles)) flatG.add(bold(path(run, 'ink', 0.8)))
      flatG.add(path([V(-s * 0.9, -s * 0.18, 0), V(s * 0.98, -s * 0.18, 0)], 'ink', 0.8))
      for (const [cx, cy, r] of circles.slice(3)) flatG.add(path(Array.from({ length: 9 }, (_, i) => V(cx + Math.cos(Math.PI * (0.15 + i * 0.09)) * r * 0.8, cy + Math.sin(Math.PI * (0.15 + i * 0.09)) * r * 0.8 - r * 0.25, 0)), 'muted', 0.5))
      g.add(flatG)
      const x0 = n.x
      return { node: g, update: (t, dt, cam) => (flatG.quaternion.copy(cam.quaternion), (g.position.x = x0 + Math.sin(t * 0.12) * 0.3)) }
    },
    // A droplet: a teardrop turned on its axis, the light's path drawn inside it.
    droplet(n) {
      const r = n.r
      const profile = Array.from({ length: 25 }, (_, i) => {
        const a = Math.PI * (i / 24)
        // A sphere below, drawn up to a point: the classic drop.
        const y = -Math.cos(a) * r
        const k = y > 0 ? 1 - Math.pow(y / r, 1.6) * 0.55 : 1
        return [Math.sin(a) * r * k, y + (y > 0 ? (y / r) ** 2 * r * 0.55 : 0)]
      })
      const made = vessel(profile, { fill: 0.04 })
      const g = made.node
      const inDir = V(-1, 0.45, 0).normalize().negate()
      const entry = inDir.clone().negate().multiplyScalar(r).applyAxisAngle(V(0, 0, 1), -0.55)
      const back = entry.clone().applyAxisAngle(V(0, 0, 1), Math.PI * 0.82)
      const exit = back.clone().applyAxisAngle(V(0, 0, 1), Math.PI * 0.82)
      const start = entry.clone().sub(inDir.clone().multiplyScalar(r * 3.2))
      const inside = new T.Group()
      inside.add(path([start, entry, back, exit], 'ochre', 0.95), arrowHead(entry.clone().lerp(start, 0.35), entry.clone().sub(start), 'ochre', r * 0.18))
      const outDir = exit.clone().sub(back).normalize()
      SPECTRUM.forEach((c, i) => {
        const d = outDir.clone().applyAxisAngle(V(0, 0, 1), (i - 3) * 0.045)
        inside.add(new T.Line(new T.BufferGeometry().setFromPoints([exit, exit.clone().add(d.multiplyScalar(r * 3.4))]), tag(new T.LineBasicMaterial({ color: new T.Color(c), transparent: true, opacity: 0.85 }), null, 0.85)))
      })
      g.add(inside)
      return { node: g, update: (t, dt, cam) => (made.update(t, dt, cam), inside.quaternion.copy(cam.quaternion)) }
    },
    // The one watching: a standing figure's outline, in proportion.
    observer(n) {
      const g = new T.Group()
      const h = n.r * 1.9
      const side = FIGURE.map(([x, y]) => V(x * h, y * h - h * 0.5, 0))
      const outline = [...side, ...[...side].reverse().map((v) => V(-v.x, v.y, 0))]
      const fig = new T.Group()
      fig.add(new T.Mesh(new T.ShapeGeometry(new T.Shape(outline.map((v) => new T.Vector2(v.x, v.y)))), wash('ink', 0.06)), bold(path(outline, 'ink', 0.9)), path([V(0, -h * 0.5, 0), V(0, -h * 0.04, 0)], 'ink', 0.6))
      g.add(fig)
      return { node: g, update: face(fig) }
    },

    // ── orbital: spheres drawn with their dark side hatched ──
    center(n, ctx) {
      if (n.state === 'lit') {
        const g = new T.Group()
        const disc = new T.Group()
        disc.add(new T.Mesh(new T.CircleGeometry(n.r, 48), flat('ochre', 0.2)), loop(n.r, 'ochre', 0.95), corona(n.r))
        g.add(disc)
        return { node: g, update: face(disc) }
      }
      // A center that is not a star (you, a hub): a globe with a reticle, the axis everything turns round.
      const made = globe(n, ctx, { hatch: 0, fill: 0.06 })
      const marks = []
      for (const [a, b] of [[[-1.4, 0], [-1.1, 0]], [[1.1, 0], [1.4, 0]], [[0, -1.4], [0, -1.1]], [[0, 1.1], [0, 1.4]]]) marks.push(V(a[0] * n.r, a[1] * n.r, 0), V(b[0] * n.r, b[1] * n.r, 0))
      const reticle = new T.Group()
      reticle.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(marks), line('ink', 0.8)), loop(n.r * 0.55, 'muted', 0.6))
      made.node.add(reticle)
      return { node: made.node, update: (t, dt, cam) => (made.update(t, dt, cam), reticle.quaternion.copy(cam.quaternion)) }
    },
    // ── clock: a dial face on; each event an arc of its hours ──
    dial(n) {
      const g = new T.Group()
      const ticks = []
      const week = n.span === 168
      const count = week ? 28 : 24
      for (let i = 0; i < count; i++) {
        const a = Math.PI / 2 - (i / count) * Math.PI * 2
        const major = week ? i % 4 === 0 : i % 6 === 0
        const r0 = n.outer + 0.08
        const r1 = r0 + (major ? 0.28 : 0.12)
        ticks.push(V(Math.cos(a) * r0, Math.sin(a) * r0, 0), V(Math.cos(a) * r1, Math.sin(a) * r1, 0))
      }
      g.add(new T.Mesh(new T.CircleGeometry(n.outer, 96), wash('ink', 0.03)), bold(loop(n.outer, 'ink', 0.9)), loop(n.inner + 0.1, 'muted', 0.5), new T.LineSegments(new T.BufferGeometry().setFromPoints(ticks), line('ink', 0.8)))
      // The hours a reader finds a dial by: 00, 06, 12, 18 (a week: each day's start).
      for (let i = 0; i < count; i += week ? 4 : 6) {
        const a = Math.PI / 2 - (i / count) * Math.PI * 2
        const t = text(week ? ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'][i / 4] : String(i).padStart(2, '0'), 0.2)
        t.position.set(Math.cos(a) * (n.outer + 0.62), Math.sin(a) * (n.outer + 0.62), 0)
        g.add(t)
      }
      // The rings the events run on, faint.
      for (let k = 1; k < n.rings; k++) g.add(loop(n.inner + 0.1 + k * 0.34, 'faint', 0.5))
      g.add(new T.Mesh(new T.CircleGeometry(0.05, 16), flat('ink', 0.9)))
      return { node: g }
    },
    event(n) {
      const g = new T.Group()
      const { r0, r1, a0, a1 } = n.arc
      const len = a0 - a1
      const geo = new T.RingGeometry(r0, r1, Math.max(6, Math.round(len * 24)), 1, a1, len)
      const fill = new T.Mesh(geo, wash(n.state === 'now' ? 'ochre' : n.state === 'done' ? 'muted' : 'ink', n.state === 'missed' ? 0.03 : 0.12))
      const arc = (r) => Array.from({ length: 33 }, (_, i) => V(Math.cos(a1 + (len * i) / 32) * r, Math.sin(a1 + (len * i) / 32) * r, 0))
      const outline = [...arc(r0), ...arc(r1).reverse()]
      outline.push(outline[0])
      g.add(fill, n.state === 'missed' ? new T.Line(new T.BufferGeometry().setFromPoints(outline), tag(new T.LineDashedMaterial({ color: pal.ink, transparent: true, opacity: 0.8, dashSize: 0.06, gapSize: 0.05 }), 'ink', 0.8)).computeLineDistances() : bold(path(outline, 'ink', 0.9)))
      g.position.set(-n.x, -n.y, 0)
      const wrap = new T.Group()
      wrap.add(g)
      return { node: wrap }
    },
    marker(n) {
      const g = new T.Group()
      const s = 0.14
      const tri = [V(0, -s, 0), V(-s * 0.7, s * 0.6, 0), V(s * 0.7, s * 0.6, 0), V(0, -s, 0)]
      const m = new T.Group()
      m.add(new T.Mesh(new T.ShapeGeometry(new T.Shape(tri.map((p) => new T.Vector2(p.x, p.y)))), flat('ink', 0.7)), path(tri))
      m.rotation.z = (n.angle ?? 0) - Math.PI / 2 + Math.PI
      g.add(m)
      return { node: g }
    },
    hand(n) {
      const g = new T.Group()
      g.add(path([V(-n.x, -n.y, 0), V(0, 0, 0)], 'ochre', 0.95), new T.Mesh(new T.CircleGeometry(0.05, 16), flat('ochre', 1)))
      return { node: g }
    },

    // ── route: pins on the ground, a road between them ──
    stop(n) {
      const g = new T.Group()
      const head = new T.Group()
      head.add(new T.Mesh(new T.CircleGeometry(0.11, 24), flat(n.state === 'now' ? 'ochre' : 'page', 1)), loop(0.11, 'ink', 0.95))
      head.position.y = 0.55
      const foot = loop(0.07, 'ink', 0.8, 'xz')
      g.add(path([V(0, 0, 0), V(0, 0.44, 0)], 'ink', 0.85), head, foot)
      return { node: g, update: face(head) }
    },
    start(n) {
      const g = new T.Group()
      const flag = new T.Group()
      const cloth = [V(0, 0.7, 0), V(0.34, 0.6, 0), V(0, 0.5, 0)]
      flag.add(new T.Mesh(new T.ShapeGeometry(new T.Shape(cloth.map((p) => new T.Vector2(p.x, p.y)))), flat('ink', 0.18)), path([...cloth, cloth[0]]))
      g.add(path([V(0, 0, 0), V(0, 0.72, 0)], 'ink', 0.9), flag, loop(0.09, 'ink', 0.8, 'xz'))
      return { node: g, update: face(flag) }
    },
    end(n) {
      const g = new T.Group()
      const head = new T.Group()
      head.add(new T.Mesh(new T.CircleGeometry(0.15, 24), flat('page', 1)), loop(0.15, 'ink', 0.95), loop(0.08, 'ink', 0.95), new T.Mesh(new T.CircleGeometry(0.035, 12), flat('ink', 1)))
      head.position.y = 0.6
      g.add(path([V(0, 0, 0), V(0, 0.45, 0)], 'ink', 0.85), head, loop(0.09, 'ink', 0.8, 'xz'))
      return { node: g, update: face(head) }
    },
    turn: (n) => ({ node: path([V(-0.12, 0, 0), V(0, 0, -0.12), V(0.12, 0, 0), V(0, 0, 0.12), V(-0.12, 0, 0)], 'ink', 0.85) }),
    leg: () => ({ node: new T.Mesh(new T.CircleGeometry(0.03, 8), flat('muted', 0.8)) }),

    // ── plan: rooms as low walls round their floor, devices as fixture marks ──
    room(n) {
      const g = new T.Group()
      const wall = 0.32
      const geo = new T.BoxGeometry(Math.max(0.2, n.w - 0.08), wall, Math.max(0.2, n.d - 0.08))
      const box = bold(edges(geo, 'ink', 0.85))
      box.position.y = wall / 2
      const floor = new T.Mesh(new T.PlaneGeometry(Math.max(0.2, n.w - 0.08), Math.max(0.2, n.d - 0.08)), wash(n.state === 'alert' ? 'ochre' : 'ink', 0.05))
      floor.rotation.x = -Math.PI / 2
      // A doorway: a quarter swing on the wall nearest the middle of the plan.
      const sw = Math.min(0.45, n.w * 0.3)
      const swing = path(Array.from({ length: 9 }, (_, i) => V(-n.w / 2 + 0.06 + Math.cos((i / 8) * (Math.PI / 2)) * sw, 0.01, -n.d / 2 + 0.06 + Math.sin((i / 8) * (Math.PI / 2)) * sw)), 'muted', 0.6)
      g.add(floor, box, swing)
      return { node: g }
    },
    device(n) {
      const g = new T.Group()
      const mark = new T.Group()
      const s = 0.12
      mark.add(new T.Mesh(new T.CircleGeometry(s, 24), flat(n.state === 'on' ? 'ink' : 'page', n.state === 'on' ? 0.25 : 1)), loop(s, 'ink', 0.95), path([V(-s * 0.7, -s * 0.7, 0), V(s * 0.7, s * 0.7, 0)], 'ink', 0.8), path([V(-s * 0.7, s * 0.7, 0), V(s * 0.7, -s * 0.7, 0)], 'ink', 0.8))
      mark.position.y = 0.22
      g.add(path([V(0, 0, 0), V(0, 0.1, 0)], 'ink', 0.7), mark)
      return { node: g, update: face(mark) }
    },
    body: (n, ctx) => globe(n, ctx, { hatch: 7 }),
    moon: (n, ctx) => globe(n, ctx, { hatch: 4, fill: 0.08 }),
  })

  // Joints: a pipe, a belt, a rod, a beam of light, a tie. `points` are the solver's, world space.
  const joint = (e, at) => {
    const pts = e.points.map((p) => V(...p))
    const g = new T.Group()
    if (e.kind === 'flow' || e.kind === 'return') {
      // A pipe as drawn: its two walls, each corner a real bend, a light wash between; a return runs dashed, under the set.
      const half = Math.max(0.025, e.width / 2)
      const bend = Math.max(half * 2.5, 0.08)
      const run = [pts[0]]
      for (let i = 1; i < pts.length - 1; i++) {
        const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]]
        const k = Math.min(bend, a.distanceTo(b) / 2, b.distanceTo(c) / 2)
        if (k < 1e-3) continue
        const p0 = b.clone().add(a.clone().sub(b).normalize().multiplyScalar(k))
        const p1 = b.clone().add(c.clone().sub(b).normalize().multiplyScalar(k))
        for (let j = 0; j <= 6; j++) {
          const u = j / 6
          run.push(p0.clone().multiplyScalar((1 - u) ** 2).add(b.clone().multiplyScalar(2 * u * (1 - u))).add(p1.clone().multiplyScalar(u * u)))
        }
      }
      run.push(pts.at(-1))
      const clean = run.filter((p, i) => i === 0 || p.distanceTo(run[i - 1]) > 1e-4)
      // The walls: the run offset to each side in its own plane (pipes lie in the set's xy plane).
      const wall = (sgn) => clean.map((p, i) => {
        const prev = clean[Math.max(0, i - 1)]
        const next = clean[Math.min(clean.length - 1, i + 1)]
        const d = next.clone().sub(prev).normalize()
        return p.clone().add(V(-d.y, d.x, 0).multiplyScalar(sgn * half))
      })
      const curve = new T.CatmullRomCurve3(clean, false, 'catmullrom', 0)
      // Between the walls a dotted centreline, not a filled tube: the pipe stays two hairlines.
      g.add(new T.Line(new T.BufferGeometry().setFromPoints(curve.getSpacedPoints(Math.max(16, clean.length * 4))), tag(new T.LineDashedMaterial({ color: pal.faint, transparent: true, opacity: 0.4, dashSize: 0.02, gapSize: 0.05 }), 'faint', 0.4)).computeLineDistances())
      const walls = e.kind === 'return' ? [wall(1), wall(-1)].map((w) => new T.Line(new T.BufferGeometry().setFromPoints(w), tag(new T.LineDashedMaterial({ color: pal.muted, transparent: true, opacity: 0.7, dashSize: 0.1, gapSize: 0.07 }), 'muted', 0.7)).computeLineDistances()) : [path(wall(1), 'muted', 0.75), path(wall(-1), 'muted', 0.75)]
      g.add(...walls)
      // Which way it flows, without the motion: a head where it arrives and one halfway, in the wall's ink.
      for (const u of [0.5, 0.97]) g.add(arrowHead(curve.getPointAt(u), curve.getTangentAt(u), 'muted', Math.max(0.12, half * 2.4)))
      const dots = [0, 1, 2].map(() => new T.Mesh(new T.SphereGeometry(Math.max(0.025, half * 0.7), 8, 8), flat('ochre', 0.9)))
      g.add(...dots)
      const speed = 0.08 + 0.05 * Math.sqrt(e.rate ?? 1)
      return { node: g, update: (t) => dots.forEach((d, i) => d.position.copy(curve.getPointAt((t * speed + i / 3) % 1))) }
    }
    if (e.kind === 'leg') {
      // A road on the ground: two edges and a dashed middle line.
      const [a, b] = pts
      const d = b.clone().sub(a).normalize()
      const side = V(-d.z, 0, d.x).multiplyScalar(0.07)
      g.add(path([a.clone().add(side), b.clone().add(side)], 'ink', 0.75), path([a.clone().sub(side), b.clone().sub(side)], 'ink', 0.75))
      g.add(new T.Line(new T.BufferGeometry().setFromPoints([a, b]), tag(new T.LineDashedMaterial({ color: pal.muted, transparent: true, opacity: 0.7, dashSize: 0.1, gapSize: 0.08 }), 'muted', 0.7)).computeLineDistances())
      return { node: g }
    }
    if (e.kind === 'belt') {
      // The two outer tangents between the wheels.
      const A = at.get(e.from)
      const B = at.get(e.to)
      const a = V(A.x, A.y)
      const b = V(B.x, B.y)
      const d = a.distanceTo(b)
      const u = b.clone().sub(a).normalize()
      const nrm = V(-u.y, u.x)
      const beta = Math.asin(Math.max(-1, Math.min(1, (A.r - B.r) / d)))
      for (const s of [1, -1]) {
        const m = nrm.clone().multiplyScalar(s * Math.cos(beta)).add(u.clone().multiplyScalar(Math.sin(beta)))
        g.add(path([a.clone().add(m.clone().multiplyScalar(A.r + 0.1)), b.clone().add(m.clone().multiplyScalar(B.r + 0.1))], 'muted', 0.9))
      }
      return { node: g }
    }
    if (e.kind === 'ray' || e.kind === 'cause') {
      const A = at.get(e.from)
      const B = at.get(e.to)
      const dir = pts[1].clone().sub(pts[0]).normalize()
      const from = pts[0].clone().add(dir.clone().multiplyScalar(Math.min(A.r, 1)))
      const to = pts[1].clone().sub(dir.clone().multiplyScalar(Math.min(B.r, 1) + 0.05))
      const tone = e.kind === 'ray' ? 'ochre' : 'muted'
      g.add(path([from, to], tone, 0.8), arrowHead(to, dir, tone, 0.14))
      return { node: g }
    }
    g.add(path(pts, e.kind === 'tie' ? 'faint' : 'muted', 0.7))
    return { node: g }
  }

  /** A dashed guide from where a part rests to where it is lifted to, for an exploded set. */
  const guide = (from, to) => new T.Line(new T.BufferGeometry().setFromPoints([V(...from), V(...to)]), tag(new T.LineDashedMaterial({ color: pal.muted, transparent: true, opacity: 0, dashSize: 0.1, gapSize: 0.08 }), 'muted', 0)).computeLineDistances()

  return { parts: K, form, sketch, picture, mesh, joint, loop, path, line, guide, nudge }
}
