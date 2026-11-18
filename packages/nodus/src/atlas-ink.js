// Atlas's ink: any mesh from an open library (a BodyParts3D muscle, a Poly
// Pizza windmill, a museum scan) redrawn as one of our plates. No texture, no
// light: a wash at 0.06, the outline turned to the eye (the silhouette, worked
// out again whenever the eye moves), crease lines where the surface folds, a
// dashed faint twin of the outline where it stands behind another part, and a
// hatch on the cut face where a layer's plane clips the mesh.
//
// Crease lines are an EdgesGeometry whose angle grows with the mesh's density
// (a dense scan at 20 degrees is a grey felt; at 60 it is its folds), so a
// dense mesh is decimated by angle, not by dropping triangles. Every material
// carries its token (`userData.tone`) and its resting opacity
// (`userData.base`), like the kit's, so `retheme` recolours it in place and the
// stage dims what a step is not about. The seed only phases the hatch.
//
// The pure half (weld, edge table, silhouette, angle) runs in node for the
// tests; `inkMesh` needs three.js and is the browser's.

/** How strong a hidden line is: a dashed hint of what stands behind (the kit's value). */
export const HIDDEN = 0.28
const WASH = 0.06

/** The crease angle for a mesh of this many triangles: 20 degrees at 2k, 12 more per doubling, 75 at most. */
export function creaseAngleFor(triangles) {
  return Math.round(Math.min(75, Math.max(20, 20 + 12 * Math.log2(Math.max(1, triangles) / 2000))))
}

/** Merge vertices closer than `eps` (OBJ meshes repeat every corner): `{ points, index }`. */
export function weld(positions, eps = 1e-4) {
  const key = new Map()
  const points = []
  const index = new Uint32Array(positions.length / 3)
  const q = (v) => Math.round(v / eps)
  for (let i = 0; i < index.length; i++) {
    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    const z = positions[i * 3 + 2]
    const k = `${q(x)},${q(y)},${q(z)}`
    let at = key.get(k)
    if (at === undefined) {
      at = points.length / 3
      key.set(k, at)
      points.push(x, y, z)
    }
    index[i] = at
  }
  return { points: Float32Array.from(points), index }
}

/** Every edge of a welded triangle mesh with the faces on each side (-1 for a border), and each face's normal and a point on it. */
export function edgeTable(points, index) {
  const faces = index.length / 3
  const normals = new Float32Array(faces * 3)
  const at = new Float32Array(faces * 3)
  const edges = new Map()
  for (let f = 0; f < faces; f++) {
    const [a, b, c] = [index[f * 3], index[f * 3 + 1], index[f * 3 + 2]]
    const p = (i, k) => points[i * 3 + k]
    const u = [0, 1, 2].map((k) => p(b, k) - p(a, k))
    const v = [0, 1, 2].map((k) => p(c, k) - p(a, k))
    normals.set([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], f * 3)
    at.set([p(a, 0), p(a, 1), p(a, 2)], f * 3)
    for (const [i, j] of [[a, b], [b, c], [c, a]]) {
      const k = i < j ? i * 4294967296 + j : j * 4294967296 + i
      const e = edges.get(k)
      if (e) e.push(f)
      else edges.set(k, [Math.min(i, j), Math.max(i, j), f])
    }
  }
  const n = edges.size
  const out = { a: new Uint32Array(n), b: new Uint32Array(n), f1: new Int32Array(n), f2: new Int32Array(n), normals, at }
  let i = 0
  for (const e of edges.values()) {
    out.a[i] = e[0]
    out.b[i] = e[1]
    out.f1[i] = e[2]
    // A seam welded from more than two faces keeps its first two; a border has none on the other side.
    out.f2[i] = e.length > 3 ? e[3] : -1
    i++
  }
  return out
}

/**
 * The outline seen from `eye` (in the mesh's own space): the edges between a
 * face turned to the eye and one turned away, and every border. Writes the
 * segments into `out` (6 floats each) and returns how many.
 */
export function silhouette(table, points, eye, out) {
  const { a, b, f1, f2, normals, at } = table
  const facing = (f) => normals[f * 3] * (eye[0] - at[f * 3]) + normals[f * 3 + 1] * (eye[1] - at[f * 3 + 1]) + normals[f * 3 + 2] * (eye[2] - at[f * 3 + 2]) > 0
  let n = 0
  for (let i = 0; i < a.length && (n + 1) * 6 <= out.length; i++) {
    if (f2[i] >= 0 && facing(f1[i]) === facing(f2[i])) continue
    out.set([points[a[i] * 3], points[a[i] * 3 + 1], points[a[i] * 3 + 2], points[b[i] * 3], points[b[i] * 3 + 1], points[b[i] * 3 + 2]], n * 6)
    n++
  }
  return n
}

const tag = (m, tone, base, edge = false) => {
  m.userData = { tone, base, edge }
  return m
}

/**
 * One mesh as a plate. Returns `{ node, update(camera), clip(planes), triangles, angle }`;
 * `node` replaces the mesh (same transform), `update` turns the outline to the camera.
 * @param T three.js
 * @param mesh a THREE.Mesh as a loader gave it
 * @param pal readPalette(T): token name to THREE.Color
 * @param opts.seed phases the cut face's hatch
 * @param opts.nudge `{ value: Vector2 }` the stage sets from its drawing buffer: the outline drawn twice, a device pixel apart
 */
export function inkMesh(T, mesh, pal, { seed = 1, nudge = null, tone = 'ink', fill = WASH } = {}) {
  const raw = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry
  const { points, index } = weld(raw.getAttribute('position').array)
  const geo = new T.BufferGeometry()
  geo.setAttribute('position', new T.BufferAttribute(points, 3))
  geo.setIndex(new T.BufferAttribute(index, 1))
  const triangles = index.length / 3
  const angle = creaseAngleFor(triangles)
  const table = edgeTable(points, index)
  const node = new T.Group()
  node.name = mesh.name
  node.position.copy(mesh.position)
  node.quaternion.copy(mesh.quaternion)
  node.scale.copy(mesh.scale)

  const clipped = []
  const clips = (m) => (clipped.push(m), m)
  // The body: written to depth only, a hair behind itself, so what stands behind is hidden and its own lines stay in front.
  const occluder = new T.Mesh(geo, clips(tag(new T.MeshBasicMaterial({ colorWrite: false, depthWrite: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: T.DoubleSide }), null, null)))
  occluder.userData.pass = 'occlude'
  const wash = new T.Mesh(geo, clips(tag(new T.MeshBasicMaterial({ color: pal[tone], transparent: true, opacity: fill, depthWrite: false, side: T.FrontSide }), tone, fill)))
  // The cut face: what shows of the inside where a plane clips the mesh, hatched in screen space so it never swims with the mesh's own scale.
  const hatchMat = clips(tag(new T.MeshBasicMaterial({ color: pal[tone], transparent: true, opacity: 0.55, side: T.BackSide, depthWrite: false }), tone, 0.55))
  const phase = (seed % 7) + 0.5
  hatchMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'void main() {\n\tif (mod(gl_FragCoord.x + gl_FragCoord.y + ' + phase.toFixed(1) + ', 7.0) > 1.6) discard;')
  }
  hatchMat.customProgramCacheKey = () => `atlas-hatch-${phase}`
  const hatch = new T.Mesh(geo, hatchMat)
  hatch.visible = false
  hatch.userData.cut = true
  const crease = new T.LineSegments(new T.EdgesGeometry(geo, angle), clips(tag(new T.LineBasicMaterial({ color: pal.muted, transparent: true, opacity: 0.55 }), 'muted', 0.55)))
  crease.userData.crease = true

  // The outline: one buffer, refilled when the eye moves; a solid pass, a nudged twin, and the dashed hidden twin under them.
  const out = new Float32Array(Math.min(table.a.length, 60000) * 6)
  const outline = new T.BufferGeometry()
  outline.setAttribute('position', new T.BufferAttribute(out, 3).setUsage(T.DynamicDrawUsage))
  outline.setDrawRange(0, 0)
  const solid = new T.LineSegments(outline, clips(tag(new T.LineBasicMaterial({ color: pal[tone], transparent: true, opacity: 1 }), tone, 1, true)))
  solid.userData.bold = true
  const passes = [solid]
  if (nudge) {
    const m = clips(tag(new T.LineBasicMaterial({ color: pal[tone], transparent: true, opacity: 1 }), tone, 1, true))
    m.onBeforeCompile = (sh) => {
      sh.uniforms.nudge = nudge
      sh.vertexShader = sh.vertexShader.replace('void main() {', 'uniform vec2 nudge;\nvoid main() {').replace('#include <project_vertex>', '#include <project_vertex>\n\tgl_Position.xy += nudge * gl_Position.w;')
    }
    m.customProgramCacheKey = () => 'nodus-bold'
    const twin = new T.LineSegments(outline, m)
    twin.userData.pass = 'nudge'
    passes.push(twin)
  }
  const hidden = new T.LineSegments(outline, tag(new T.LineDashedMaterial({ color: pal[tone], transparent: true, opacity: HIDDEN, depthTest: false, depthWrite: false, dashSize: 0.07, gapSize: 0.06 }), tone, HIDDEN))
  hidden.renderOrder = -1
  hidden.userData.pass = 'hidden'
  node.add(occluder, wash, hatch, crease, hidden, ...passes)

  const eye = new T.Vector3()
  const last = new T.Vector3(Infinity, Infinity, Infinity)
  const inverse = new T.Matrix4()
  let radius = null
  /** Turn the outline to the camera; cheap when the eye has not moved. */
  function update(camera) {
    node.updateWorldMatrix(true, false)
    eye.copy(camera.position).applyMatrix4(inverse.copy(node.matrixWorld).invert())
    if (radius == null) {
      geo.computeBoundingSphere()
      radius = geo.boundingSphere.radius || 1
    }
    if (eye.distanceTo(last) < radius * 1e-3) return false
    last.copy(eye)
    const n = silhouette(table, points, [eye.x, eye.y, eye.z], out)
    outline.setDrawRange(0, n * 2)
    outline.getAttribute('position').needsUpdate = true
    outline.computeBoundingSphere()
    hidden.computeLineDistances()
    return true
  }
  /** Clip by these planes (world space) and show the cut face hatched; none to close it. */
  function clip(planes = null) {
    for (const m of clipped) {
      m.clippingPlanes = planes?.length ? planes : null
      m.needsUpdate = true
    }
    hatch.visible = Boolean(planes?.length)
  }
  return { node, update, clip, triangles, angle, geometry: geo }
}

