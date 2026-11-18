// Atlas mode, the parts that run without a page: which asks it takes, the
// plan, the pick (a fake judge), the layers, Jev's boxes, the walk, a GLB's
// parts, and the ink's geometry (weld, edges, the outline seen from an eye).
// The drawing itself is checked in a browser: plugins/sundial-nodus/scripts/atlas-draw.py.
import { describe, expect, it, vi } from 'vitest'
import { boxOf, build, frameScale, glbNodes, layersOf, objStats, parsePlan, parseWalk, pickQuestions, plain, planOf, scoreCandidates, supports, tissueOf, walkOf } from './modes/atlas.js'
import { creaseAngleFor, edgeTable, silhouette, weld } from './atlas-ink.js'

// A unit cube as an OBJ, and a ring of points around an axis (a made-up muscle at some distance in front).
const CUBE = ['v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'v 0 0 1', 'v 1 0 1', 'v 1 1 1', 'v 0 1 1', 'f 1 3 2', 'f 1 4 3', 'f 5 6 7', 'f 5 7 8', 'f 1 2 6', 'f 1 6 5', 'f 2 3 7', 'f 2 7 6', 'f 3 4 8', 'f 3 8 7', 'f 4 1 5', 'f 4 5 8'].join('\n')
const slab = (front, n = 40) => Array.from({ length: n }, (_, i) => [Math.cos(i) * 10, front + Math.sin(i), i])

describe('which asks Atlas takes', () => {
  it('takes a real thing and leaves the record to Sketch', () => {
    expect(supports('Show me a bicep and the layers under it')).toBe(true)
    expect(supports('Show me the human heart')).toBe(true)
    expect(supports('What does a Dutch windmill look like inside')).toBe(true)
    expect(supports('how did my day go')).toBe(false)
    expect(supports('show me the bicep', { view: 'day' })).toBe(false)
    expect(supports('anything', { mode: 'atlas' })).toBe(true)
  })
})

describe('the plan', () => {
  it('reads the model\'s JSON, structures outside in', () => {
    const plan = parsePlan('Sure: {"subject": "bicep", "kind": "anatomy", "inside": true, "parts": ["biceps brachii", "brachialis", "humerus"], "query": "biceps brachii", "drawing": "biceps brachii plate"}')
    expect(plan).toEqual({ subject: 'bicep', kind: 'anatomy', anatomy: true, inside: true, parts: ['biceps brachii', 'brachialis', 'humerus'], query: 'biceps brachii', drawing: 'biceps brachii plate' })
    expect(parsePlan('no JSON here')).toBeNull()
  })
  it('falls back to the ask\'s own words without a model', () => {
    expect(planOf('Show me a bicep and the layers under it')).toMatchObject({ subject: 'bicep', anatomy: true, inside: true, parts: ['bicep'] })
    expect(planOf('What does a Dutch windmill look like inside?')).toMatchObject({ subject: 'Dutch windmill', anatomy: false, drawing: 'Dutch windmill cutaway' })
  })
})

const CANDS = [
  { id: 'a', kind: 'mesh', source: 'BodyParts3D', title: 'BodyParts3D: Biceps brachii, Humerus', parts: [{}, {}] },
  { id: 'b', kind: 'plate', source: 'Wikimedia Commons', title: 'Gray411.png', thumb: 'b' },
  { id: 'c', kind: 'mesh', source: 'Poly Pizza', title: 'Arm' },
]

describe('the pick', () => {
  it('asks one typed choice, images named in their criteria', () => {
    const q = pickQuestions(CANDS, [null, { data_base64: 'x' }, null])
    expect(q.best.type).toBe('choice')
    expect(Object.keys(q.best.criteria)).toEqual(['c0', 'c1', 'c2', 'none'])
    expect(q.best.criteria.c1).toMatch(/^Image `img1`: Wikimedia Commons \(a picture\)/)
  })
  it('weighs Jev with what the ask wants: anatomy keeps the meshes, an inside a plate', () => {
    const jev = { choice: 'c1', probabilities: { c0: 0.3, c1: 0.5, c2: 0.15, none: 0.05 } }
    expect(scoreCandidates(CANDS, jev, { anatomy: true }).map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(scoreCandidates(CANDS, jev, { anatomy: false }).map((c) => c.id)).toEqual(['b', 'a', 'c'])
    expect(scoreCandidates(CANDS, { choice: 'none', probabilities: { none: 0.8, c0: 0.1 } }, { anatomy: false })).toEqual([])
    // Without Jev the order is the sources' own, the priors still count.
    expect(scoreCandidates(CANDS, null, { anatomy: true })[0].id).toBe('a')
  })
})

describe('the layers', () => {
  it('lays skin, soft tissue by how far forward, then bone; close parts share a layer', () => {
    const parts = [
      { id: 'humerus', label: 'Humerus', sample: slab(0) },
      { id: 'brachialis', label: 'Brachialis', sample: slab(10) },
      { id: 'biceps', label: 'Biceps brachii', sample: slab(20) },
      { id: 'coraco', label: 'Coracobrachialis', sample: slab(19) },
      { id: 'skin', label: 'Skin', sample: slab(5) },
    ]
    expect(layersOf(parts, [0, 1, 0])).toEqual([['skin'], ['biceps', 'coraco'], ['brachialis'], ['humerus']])
    expect(tissueOf('right humerus')).toBe('bone')
    expect(tissueOf('aorta')).toBe('soft')
  })
  it('reads an OBJ for its size and a sample', () => {
    const s = objStats(CUBE, 4)
    expect(s).toMatchObject({ vertices: 8, triangles: 12, centroid: [0.5, 0.5, 0.5], min: [0, 0, 0], max: [1, 1, 1] })
    expect(s.sample).toHaveLength(4)
  })
})

describe('Jev\'s boxes', () => {
  it('reads fractions, pixels or an array, and refuses an empty box', () => {
    expect(boxOf({ box: { top: 0.14, bottom: 0.46, left: 0.19, right: 0.42 }, confidence: 0.33 })).toEqual({ left: 0.19, top: 0.14, right: 0.42, bottom: 0.46, confidence: 0.33 })
    expect(boxOf({ box: [100, 50, 300, 150] }, 400, 200)).toEqual({ left: 0.25, top: 0.25, right: 0.75, bottom: 0.75, confidence: 1 })
    expect(boxOf({ box: { left: 0.5, right: 0.5, top: 0, bottom: 1 } })).toBeNull()
    expect(boxOf({})).toBeNull()
  })
})

describe('the walk', () => {
  const parts = [{ id: 'biceps-brachii', label: 'Biceps brachii' }, { id: 'brachialis', label: 'Brachialis' }, { id: 'humerus', label: 'Humerus' }]
  const layers = [['biceps-brachii'], ['brachialis'], ['humerus']]
  it('walks the layers outside in, lifting one more each step', () => {
    const steps = walkOf('bicep', parts, layers)
    expect(steps.map((s) => s.explode ?? 0)).toEqual([0, 1, 2])
    expect(steps[2].say).toBe('Lift Brachialis away and Humerus lies deepest.')
  })
  it('keeps a model step only when it names what it points at, in the house voice', () => {
    const reply = JSON.stringify({
      title: 'The arm, layer by layer',
      steps: [
        { focus: ['biceps-brachii'], say: 'The biceps brachii bends the elbow and turns the palm up.' },
        { focus: ['brachialis'], say: 'Under it \u2014 the brachialis does most of the bending.', explode: 1 },
        { focus: ['humerus'], say: 'This chart shows a bone.' },
        { focus: ['nothing'], say: 'Nothing named.' },
        { focus: ['humerus'], say: 'The radius is elsewhere.' },
      ],
    })
    const walk = parseWalk(reply, parts, layers)
    expect(walk.title).toBe('The arm, layer by layer')
    expect(walk.steps).toEqual([
      { focus: ['biceps-brachii'], say: 'The biceps brachii bends the elbow and turns the palm up.' },
      { focus: ['brachialis'], say: 'Under it, the brachialis does most of the bending.', explode: 1 },
    ])
  })
})

describe('a GLB\'s parts', () => {
  it('reads the named nodes that hold meshes from its JSON chunk', () => {
    const json = new TextEncoder().encode(JSON.stringify({ nodes: [{ name: 'Mill', children: [1, 2] }, { name: 'Sails-Mesh', mesh: 0 }, { name: 'Cap_geo', mesh: 1 }] }).padEnd(120, ' '))
    const buf = new Uint8Array(20 + json.length)
    const v = new DataView(buf.buffer)
    v.setUint32(0, 0x46546c67, true)
    v.setUint32(12, json.length, true)
    buf.set(json, 20)
    expect(glbNodes(buf)).toEqual([
      { index: 1, name: 'Sails-Mesh', label: 'Sails', parent: 'Mill' },
      { index: 2, name: 'Cap_geo', label: 'Cap', parent: 'Mill' },
    ])
  })
})

describe('build, with a stub store and judge', () => {
  const store = (over = {}) => ({
    search: vi.fn(async (q, kind) => (kind === 'mesh' ? { candidates: [{ id: 'm', kind: 'mesh', format: 'obj', source: 'BodyParts3D', license: 'CC BY-SA 2.1 JP', credit: 'BodyParts3D', url: 'u', title: 'BodyParts3D: Biceps brachii, Humerus', up: 'z', parts: [{ label: 'Biceps brachii', bytes: 10, files: ['f1'] }, { label: 'Humerus', bytes: 10, files: ['f2'] }] }], skipped: [] } : { candidates: [{ id: 'p', kind: 'plate', image: 'p', thumb: 'p', source: 'Wikimedia Commons', license: 'Public domain', credit: 'Henry Vandyke Carter', url: 'u2', title: 'Gray411.png' }], skipped: [{ source: 'Poly Pizza', reason: 'down' }] })),
    file: vi.fn(async () => ({ size: 100, cached: false })),
    bytes: vi.fn(async (id) => Buffer.from(id === 'f1' ? 'v 0 -20 0\nv 1 -21 0\nv 0 -20 1\nf 1 2 3' : 'v 0 0 0\nv 1 0 0\nv 0 0 1\nf 1 2 3')),
    image: vi.fn(async () => ({ data_base64: 'AAAA', format: 'png', w: 400, h: 400 })),
    ...over,
  })
  it('picks the meshes for the body, fetches them once, and lays them outside in', async () => {
    const judge = vi.fn(async ({ set }) => (set === 'nodus.atlas.pick.v1' ? { best: { choice: 'c1', probabilities: { c0: 0.4, c1: 0.55, none: 0.05 } } } : { fits: { score: 2.4 }, s0: { noul: 0.9 }, s1: { noul: 0.9 } }))
    const assets = store()
    const out = await build('Show me a bicep and the layers under it', { assets, judge, complete: null })
    expect(out).toMatchObject({ kind: 'asset', mode: 'atlas', assets: [{ source: 'BodyParts3D', kind: 'mesh', license: 'CC BY-SA 2.1 JP', parts: [{ id: 'biceps-brachii', mesh: ['f1'] }, { id: 'humerus', mesh: ['f2'] }] }], layers: [['biceps-brachii'], ['humerus']] })
    expect(out.steps).toHaveLength(2)
    expect(out.by).toMatchObject({ storyboard: 'fallback', plan: 'words', critic: { fits: 2.4 } })
    expect(out.by.skipped[0].source).toBe('Poly Pizza')
    // The plate's thumbnail rode to Jev as an image; the pick named its set.
    const pick = judge.mock.calls.find(([a]) => a.set === 'nodus.atlas.pick.v1')[0]
    expect(Object.keys(pick.assets)).toEqual(['img1'])
    expect(assets.file).toHaveBeenCalledTimes(2)
  })
  it('locates a plate\'s parts with one Jev call of boxes', async () => {
    const judge = vi.fn(async ({ set }) => (set === 'nodus.atlas.pick.v1' ? { best: { choice: 'c0', probabilities: { c0: 0.9, none: 0.1 } } } : set === 'nodus.atlas.locate.v1' ? { p0: { box: { left: 0.1, top: 0.1, right: 0.4, bottom: 0.5 }, confidence: 0.4 }, p1: { box: { left: 0.5, top: 0.5, right: 0.6, bottom: 0.6 }, confidence: 0.1 } } : null))
    const complete = vi.fn(async (messages) => (messages[0].content.startsWith('You read a request') ? '{"subject": "windmill", "kind": "machine", "inside": true, "parts": ["sails", "millstones"], "query": "windmill", "drawing": "windmill cutaway"}' : 'no'))
    const assets = store({ search: vi.fn(async (q, kind) => ({ candidates: kind === 'plate' ? [{ id: 'p', kind: 'plate', image: 'p', thumb: 'p', source: 'Wikimedia Commons', license: 'CC BY 4.0', credit: 'Wellcome', url: 'u', title: 'Windmill cutaway' }] : [], skipped: [] })) })
    const out = await build('What does a windmill look like inside', { assets, judge, complete })
    expect(out.assets[0]).toMatchObject({ kind: 'plate', image: 'p', w: 400, h: 400, parts: [{ id: 'sails', label: 'Sails', box: { left: 0.1, confidence: 0.4 } }] })
    expect(judge.mock.calls.filter(([a]) => a.set === 'nodus.atlas.locate.v1')).toHaveLength(1)
    expect(assets.search.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['windmill cutaway', 'windmill']))
  })
  it('says so when nothing true was found, and never draws a stand-in', async () => {
    const out = await build('Show me a unicorn', { assets: store({ search: async () => ({ candidates: [], skipped: [{ source: 'Wikimedia Commons', reason: 'offline' }] }) }) })
    expect(out).toEqual({ ok: false, reason: 'no open library had unicorn (Wikimedia Commons could not be reached)' })
  })
})

describe('the frame Jev is sent', () => {
  it('fits 280 to 1568 px a side, or sends nothing', () => {
    expect(frameScale(1070, 502)).toBe(1)
    expect(frameScale(2000, 900)).toBe(0.64)
    expect(frameScale(1000, 200)).toBeCloseTo(1.4)
    expect(frameScale(1600, 200)).toBeNull()
    expect(frameScale(1, 1)).toBeNull()
  })
})

describe('the ink\'s geometry', () => {
  it('thins crease lines on a dense mesh by raising the angle', () => {
    expect(creaseAngleFor(500)).toBe(20)
    expect(creaseAngleFor(8000)).toBe(44)
    expect(creaseAngleFor(1e6)).toBe(75)
  })
  it('welds an OBJ\'s repeated corners and finds each edge\'s two faces', () => {
    // Two triangles sharing an edge, as a loader gives them: six corners, four points.
    const { points, index } = weld(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]))
    expect(points.length / 3).toBe(4)
    const table = edgeTable(points, index)
    expect(table.a.length).toBe(5)
    expect([...table.f2].filter((f) => f >= 0)).toHaveLength(1)
  })
  it('turns the outline to the eye: a cube seen face on shows its rim, not its face\'s diagonal', () => {
    const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]
    const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
    const flat = new Float32Array(faces.flat().flatMap((i) => corners.slice(i * 3, i * 3 + 3)))
    const { points, index } = weld(flat)
    const out = new Float32Array(600)
    const n = silhouette(edgeTable(points, index), points, [0.5, 0.5, 10], out)
    // Seen along z, the outline is the front face's four sides, where it meets the sides turned away; never its diagonal.
    expect(n).toBe(4)
    for (let i = 0; i < n; i++) expect(out[i * 6] === out[i * 6 + 3] || out[i * 6 + 1] === out[i * 6 + 4]).toBe(true)
  })
})

describe('the credit line', () => {
  it('keeps a source\'s metadata as text: tags, cut-off tags and entities dropped', () => {
    expect(plain('Wellcome Collection gallery (2018-03-21): <a rel="nofollow" class="external free" href=" <a rel="nofollow"')).toBe('Wellcome Collection gallery (2018-03-21):')
    expect(plain('<span>Henry &amp; Carter</span>')).toBe('Henry & Carter')
  })
})
