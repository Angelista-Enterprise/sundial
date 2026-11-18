// Plate: the model draws the figure itself; the engine makes it one of ours.
//
// A model plans the figure (its parts, what each is, how they relate, the
// walk) and draws it as plain line art on a flat sheet, each part its own
// named group, no words. The engine keeps only plain shapes, checks every
// planned part was drawn, and sets the sheet in a little 3D space: each part
// on its own thin layer, the sheet tilted, its names in the margins with
// leaders, the step words on the links, a step lifting what it names toward
// the eye. Record asks get their own data handed in, exact, to draw true.
//
//   build(ask, ctx) → { kind: 'plate', title, parts, links, steps, svg, facts, problems }
//   draw(host, product, { onSettled }) → { node, focus(ids), snapshot(), dispose() }

import { readView, VIEWS } from '../views.js'

export const W = 1200
export const H = 720
export const TIMEOUT = 240_000
const OPTS = { maxTokens: 9000 }
const MAX_FACTS = 6000
const SHAPES = new Set(['line', 'polyline', 'polygon', 'path', 'circle', 'ellipse', 'rect', 'g'])
const ATTRS = new Set(['id', 'd', 'points', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'transform', 'stroke-dasharray', 'stroke-width', 'data-value', 'data-unit', 'data-tone'])

export const PLAN_SYSTEM = [
  'You are Gnomon, an illustrator and a teacher. You answer a question with one technical figure, a plate of thin line art read in one look. First you plan it. Someone else draws nothing: you will draw it next, from this plan.',
  'Decide the manner that explains it best: "scene" (a near-real picture of the thing or the moment: a cave, a trolley at a fork, a machine as it stands), "schematic" (an abstract flow or structure: a payment, a request and its reply, a cycle), "chart" (amounts compared or over time; it may be inventive, a familiar object, as long as every size is true to its number), or "isometric" (a thing with depth, drawn at a light 30 degree angle: a building, a device, a layered body).',
  'Reply with JSON only: {"title": "a short headline that answers", "manner": "scene"|"schematic"|"chart"|"isometric", "parts": [{"id": "short-lower-case", "label": "two or three words", "note": "2 to 5 words, the fact worth knowing, a number with its unit when there is one", "layer": 0 to 3}], "links": [{"from": "id", "to": "id", "label": "2 to 4 words: what passes or happens"}], "steps": [{"focus": ["id", ...], "say": "one sentence, at most 20 words, naming what it shows"}]}. 3 to 7 parts (fewer is clearer), 3 to 5 steps, links in the order things happen. layer: 0 lies on the sheet, 3 stands furthest out (what the eye should meet first).',
].join('\n')

export const DRAW_SYSTEM = [
  'You are Gnomon, an illustrator. You draw one technical figure as thin line art on a flat sheet, from a plan you wrote. Someone else writes every word (the names, the facts, the step words): the drawing holds NO text at all.',
  'Every part is drawn as itself: its own recognisable outline and the inner detail that makes it that thing (a key has a bow and a bitted blade; a heart has four chambers with vessels leaving it; a lung is lobed; a gear has teeth; a piston sits in a cylinder with a rod). A plain rectangle, circle or blob standing in for a part is a fault, even inside an isometric scene: give each part at least its silhouette and two or three inner lines. Draw the real things and how they sit: people as simple figures, objects by their true outline, places by their walls and floors. Make the arrangement explain the answer: who faces what, what is inside, on, or wound around what, what moves where (arrows: a line with a small open V at its tip), what comes first and what follows. In the isometric manner, verticals stay vertical and the ground axes run at 30 degrees; draw solids as isometric blocks. In a chart, every bar, slice, block or mark that stands for a number carries data-value="the number" and data-unit="its unit", and its size follows that number.',
  'Everything is drawn in one ink. Two accents exist, and only for meaning: data-tone="warm" (hot, active, oxygen-rich, charged, the thing to notice) and data-tone="cool" (cold, inactive, depleted, spent, the other side of a contrast) on a shape or a group. Use them where two things must be told apart or a contrast is the point; most shapes carry no tone.',
  'SVG rules: viewBox="0 0 1200 720". Every part of the plan is one <g id="its id"> holding its shapes; anything that belongs to no part (a ground line, a frame of the scene) stays outside the groups. Only line, polyline, polygon, path, circle, ellipse and rect; strokes only (fill="none"); no text, no images, no gradients, no scripts, no styles. Fill the sheet: the drawing spans most of it, nothing tiny in a corner; leave the outer 40 px empty.',
  'Reply with the SVG only.',
].join('\n')

export const MANNERS = ['scene', 'schematic', 'chart', 'isometric']

/** Jev's one typed choice: the manner that explains this ask best (the plan prompt's own words, as criteria). */
export function mannerQuestions() {
  return {
    manner: {
      type: 'choice',
      instructions: 'The owner asked `ask` and one technical figure will answer it. In which manner should it be drawn?',
      criteria: {
        scene: 'a near-real picture of the thing or the moment: a cave, a trolley at a fork, a machine as it stands, a body and its organs',
        schematic: 'an abstract flow or structure: a payment, a request and its reply, a cycle, who deals with whom',
        chart: 'amounts compared or over time: money, shares, sizes, counts, the owner\'s own day and hours',
        isometric: 'a thing with depth drawn at a light angle: a building, a device, a layered or stacked thing',
      },
    },
  }
}

/** The manner for an ask: Jev's typed choice when it can say, else null (the model picks in its plan). */
export async function chooseManner(ask, judge) {
  if (!judge) return null
  const answers = await within(8_000, Promise.resolve(judge({ state: { ask: String(ask ?? '').slice(0, 400) }, questions: mannerQuestions(), set: 'nodus.manner.v1' }))).catch(() => null)
  const v = answers?.manner?.choice
  return MANNERS.includes(v) ? v : null
}

// Feature-first: each part names what makes it that thing before anything is drawn.
const LOOKS = '\n\nFor every part add "looks": 3 to 5 visual features, comma separated, that make it that thing and not a look-alike (a sun: "disc, rays all round, no base, no filament"; a key: "round bow with a hole, long blade, bitted teeth on one edge").'

/** The messages for the plan: the ask, the facts when it is a record ask, the manner when one was chosen for it, and the looks when asked for. */
export function planMessages(ask, facts = null, manner = null, looks = false) {
  const given = facts ? `\n\nFacts from the owner's own record (exact; draw them true, make up nothing):\n${JSON.stringify(facts).slice(0, MAX_FACTS)}` : ''
  const told = manner ? `\n\nDraw it in the "${manner}" manner (chosen for this question; keep it).` : ''
  return [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: `${String(ask).slice(0, 400)}${given}${told}${looks ? LOOKS : ''}` }]
}

/** The messages for the drawing: the ask and the plan; a second round's faults with the last drawing. */
export function drawMessages(ask, plan, facts = null, previous = null, problems = []) {
  const given = facts ? `\n\nFacts (exact; every mark that stands for a number carries data-value and data-unit):\n${JSON.stringify(facts).slice(0, MAX_FACTS)}` : ''
  const looks = plan.parts?.some((p) => p.looks) ? '\n\nDraw each part with exactly its "looks": every feature named there, visible.' : ''
  const messages = [{ role: 'system', content: DRAW_SYSTEM }, { role: 'user', content: `${String(ask).slice(0, 400)}\n\nThe plan:\n${JSON.stringify(plan)}${given}${looks}` }]
  if (previous && problems.length) messages.push({ role: 'assistant', content: String(previous).slice(0, 30_000) }, { role: 'user', content: `Fix these and reply with the whole SVG again:\n- ${problems.join('\n- ')}` })
  return messages
}

/** The drawing out of a reply, or null. */
export function parseSvg(text) {
  const s = String(text ?? '')
  const at = s.indexOf('<svg')
  const end = s.lastIndexOf('</svg>')
  return at < 0 || end < at ? null : s.slice(at, end + 6)
}

/** The plan out of a reply, or null. */
export function parsePlan(text) {
  const s = String(text ?? '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(s.slice(a, b + 1))
  } catch {
    return null
  }
}

/**
 * The drawing cut down to plain shapes: every element and attribute not on the
 * lists is dropped, values lose anything that could break out of them. What a
 * model wrote never runs: only lines, outlines and their numbers come through.
 */
export function cleanSvg(svg) {
  // Templates (arrowheads, patterns), notes and styles are not drawing: their contents go with them.
  const bare = String(svg).replace(/<(defs|style|script|title|desc|metadata|foreignObject|text)\b[\s\S]*?<\/\1>/gi, '')
  // Always well formed (the page reads it as strict XML): shapes close themselves, groups are balanced.
  let open = 0
  const body = [...bare.matchAll(/<(\/?)([a-zA-Z]+)\b([^>]*?)(\/?)>/g)].map(([, close, tag, rest]) => {
    const t = tag.toLowerCase()
    if (!SHAPES.has(t)) return ''
    if (close) return t === 'g' && open > 0 ? (open--, '</g>') : ''
    // A name may carry a digit (x1, y2) and a value may stand in either quote.
    const kept = [...rest.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].filter(([, k]) => ATTRS.has(k.toLowerCase())).map(([, k, v, v1]) => `${k.toLowerCase()}="${(v ?? v1).replace(/[<>"&]/g, '').slice(0, 4000)}"`)
    const attrs = kept.length ? ` ${kept.join(' ')}` : ''
    if (t !== 'g') return `<${t}${attrs} />`
    open++
    return `<g${attrs}>`
  })
  body.push('</g>'.repeat(open))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${body.join('')}</svg>`
}

const idOf = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

/** The plan held to its shape: parts with ids, labels, notes and layers; links and steps that name real parts. */
export function checkPlan(plan) {
  const parts = (Array.isArray(plan?.parts) ? plan.parts : []).map((p) => ({ id: idOf(p.id), label: String(p.label ?? '').slice(0, 40), note: String(p.note ?? '').slice(0, 60), layer: Math.min(3, Math.max(0, Math.round(Number(p.layer) || 0))), ...(p.looks ? { looks: String(p.looks).slice(0, 160) } : {}) })).filter((p) => p.id && p.label).slice(0, 7)
  const ids = new Set(parts.map((p) => p.id))
  const links = (Array.isArray(plan?.links) ? plan.links : []).map((k) => ({ from: idOf(k.from), to: idOf(k.to), label: String(k.label ?? '').slice(0, 40) })).filter((k) => ids.has(k.from) && ids.has(k.to) && k.from !== k.to).slice(0, 12)
  const steps = (Array.isArray(plan?.steps) ? plan.steps : []).map((st) => ({ focus: (Array.isArray(st.focus) ? st.focus : []).map(idOf).filter((id) => ids.has(id)), say: String(st.say ?? '').slice(0, 200) })).filter((st) => st.focus.length && st.say).slice(0, 6)
  const manner = ['scene', 'schematic', 'chart', 'isometric'].includes(plan?.manner) ? plan.manner : 'scene'
  return { title: String(plan?.title ?? '').slice(0, 90), manner, parts, links, steps }
}

/** What is wrong with a plate, in words the model can act on: parts planned and not drawn, a plan too thin. */
export function platesProblems(plan, svg) {
  const problems = []
  const groups = new Set([...String(svg).matchAll(/<g\b[^>]*\bid="([^"]+)"/g)].map((m) => idOf(m[1])))
  const missing = plan.parts.filter((p) => !groups.has(p.id)).map((p) => p.id)
  if (missing.length) problems.push(`these parts are in the plan but have no <g id> in the drawing: ${missing.join(', ')}`)
  if (plan.parts.length < 3) problems.push('the plan needs at least 3 parts')
  if (plan.steps.length < 2) problems.push('the plan needs at least 2 steps that each focus real part ids')
  if (!/<(line|polyline|polygon|path|circle|ellipse|rect)\b/.test(svg)) problems.push('the drawing has no shapes')
  return problems
}

const within = (ms, promise) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]).finally(() => clearTimeout(timer))
}

/**
 * Build a plate for an ask. `ctx`: complete(messages, opts); for a record ask
 * read(tool, args) and route.view, whose data is handed in as facts. One round
 * of fixes when the first reply is missing parts. Null when nothing usable came.
 */
export async function build(ask, ctx = {}) {
  if (!ctx.complete) return null
  const view = VIEWS[ctx.route?.view] ? ctx.route.view : null
  const facts = view && ctx.read ? await readView(view, ctx.args ?? {}, ctx.read).catch(() => null) : null
  // The manner from Jev when it is there; then the plan, small and alone; then the drawing, with the model's whole attention on it.
  const manner = await chooseManner(ask, ctx.mannerJudge ?? ctx.judge)
  const planned = parsePlan(await within(TIMEOUT, ctx.complete(planMessages(ask, facts, manner, Boolean(ctx.looks)), { maxTokens: 2000 })).catch(() => null))
  if (!planned) return null
  const plan = checkPlan(manner ? { ...planned, manner } : planned)
  if (plan.parts.length < 3) return null
  const drawOnce = async (messages) => {
    const reply = await within(TIMEOUT, ctx.complete(messages, OPTS)).catch(() => null)
    const raw = parseSvg(reply)
    if (!raw) return { reply, problems: ['reply with the <svg> drawing'] }
    const svg = cleanSvg(raw)
    return { reply, svg, problems: platesProblems(plan, svg) }
  }
  let out = await drawOnce(drawMessages(ask, plan, facts))
  if (out.problems.length && out.reply) {
    const again = await drawOnce(drawMessages(ask, plan, facts, out.reply, out.problems))
    if (again.svg && (!out.svg || again.problems.length < out.problems.length)) out = again
  }
  if (!out.svg) return null
  return { kind: 'plate', title: plan.title, manner: plan.manner, mannerBy: manner ? 'jev' : 'model', parts: plan.parts, links: plan.links, steps: plan.steps, svg: out.svg, facts: Boolean(facts), problems: out.problems }
}

// ── The sheet in light 3D (browser only) ──

const SHEET = [12, 7.2]
const LAYER = 0.16
const LIFT = 0.45
const TILT = [-0.2, 0.1]
const INK_STYLE = '<style>*{fill:none;stroke:#fff;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}</style>'

/** One layer's markup drawn into an image twice the sheet's size (white lines; the material tints them). */
function layerImage(inner) {
  const img = new Image()
  img.decoding = 'async'
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 2}" height="${H * 2}">${INK_STYLE}${inner}</svg>`)}`
  return img.decode().then(() => img)
}

export async function draw(host, product, { onSettled = null } = {}) {
  const { loadThree } = await import('../three-loader.js')
  const { readPalette } = await import('../kit.js')
  const { marginLabels, marginsFor, leaderPath } = await import('../labels.js')
  const T = await loadThree()
  const NS = 'http://www.w3.org/2000/svg'
  const node = document.createElement('div')
  node.className = 'nd-stage nd-plate3d'
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', product.title || 'A figure')
  const leaders = document.createElementNS(NS, 'svg')
  leaders.setAttribute('class', 'nd-leaders')
  leaders.setAttribute('aria-hidden', 'true')
  const layer = document.createElement('div')
  layer.className = 'nd-labels'
  host?.replaceChildren?.(node)
  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1))
  node.append(renderer.domElement, leaders, layer)
  const pal = readPalette(T)
  const scene = new T.Scene()
  const camera = new T.PerspectiveCamera(26, 16 / 9, 0.1, 200)
  const sheet = new T.Group()
  // Flat, face on (a tilt cost the judge a little): depth comes from the drawing's own manner. The lab's 'tilt' variant keeps the tilt.
  if (globalThis.NODUS_VARIANT === 'tilt') sheet.rotation.set(TILT[0], TILT[1], 0)
  scene.add(sheet)

  // The drawing in the page, hidden, so each part's middle can be measured.
  const measure = new DOMParser().parseFromString(product.svg, 'image/svg+xml').documentElement
  const probe = document.createElementNS(NS, 'svg')
  probe.setAttribute('viewBox', `0 0 ${W} ${H}`)
  probe.setAttribute('style', `position:absolute;left:-9999px;top:0;width:${W}px;height:${H}px;visibility:hidden`)
  probe.innerHTML = measure.innerHTML
  document.body.append(probe)
  // Measured on the page, so a group's own transform counts: the probe is drawn 1:1 with the sheet.
  const origin = probe.getBoundingClientRect()
  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height }
  }
  // The drawing fitted to the sheet: whatever the model drew is scaled and centred to fill it, 40 px in from the edge.
  const all = rectOf(probe)
  const drawn = [...probe.querySelectorAll('line, polyline, polygon, path, circle, ellipse, rect')].map(rectOf).filter((r) => r.width || r.height)
  const span = drawn.length ? drawn.reduce((a, r) => ({ x0: Math.min(a.x0, r.x), y0: Math.min(a.y0, r.y), x1: Math.max(a.x1, r.x + r.width), y1: Math.max(a.y1, r.y + r.height) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }) : { x0: 0, y0: 0, x1: all.width || W, y1: all.height || H }
  const k = Math.min(3, (W - 80) / Math.max(1, span.x1 - span.x0), (H - 80) / Math.max(1, span.y1 - span.y0))
  const fit = { k, tx: (W - (span.x1 - span.x0) * k) / 2 - span.x0 * k, ty: (H - (span.y1 - span.y0) * k) / 2 - span.y0 * k }
  const fitted = (r) => ({ x: r.x * k + fit.tx, y: r.y * k + fit.ty, width: r.width * k, height: r.height * k })
  const wrap = (markup) => `<g transform="translate(${fit.tx.toFixed(2)} ${fit.ty.toFixed(2)}) scale(${k.toFixed(4)})">${markup}</g>`
  // A drawing's shapes by tone: the plain ink, the warm accent (ochre), the cool accent (navy); each a layer of its own.
  const TONES = { ink: 'ink', warm: 'ochre', cool: 'navy' }
  const byTone = (el) => {
    const out = {}
    for (const tone of Object.keys(TONES)) {
      const copy = el.cloneNode(true)
      for (const shape of [...copy.querySelectorAll('line, polyline, polygon, path, circle, ellipse, rect')]) {
        const own = shape.closest('[data-tone]')?.getAttribute('data-tone')
        if ((own === 'warm' || own === 'cool' ? own : 'ink') !== tone) shape.remove()
      }
      if (copy.querySelector('line, polyline, polygon, path, circle, ellipse, rect')) out[tone] = wrap(copy.innerHTML)
    }
    return out
  }
  const parts = new Map()
  for (const p of product.parts) {
    const g = probe.querySelector(`g[id="${p.id}"]`)
    const box = g && fitted(rectOf(g))
    if (!g || !box || (!box.width && !box.height)) continue
    const holder = document.createElementNS(NS, 'g')
    holder.append(g.cloneNode(true))
    parts.set(p.id, { ...p, layers: byTone(holder), box, lift: 0, aim: 0, dim: 1, aimDim: 1, hot: false, meshes: [] })
  }
  for (const id of parts.keys()) probe.querySelector(`g[id="${id}"]`)?.remove()
  const ground = byTone(probe)
  probe.remove()

  // Each part a plane of its own, a little in front of the sheet; the rest of the drawing on the sheet itself.
  const plane = new T.PlaneGeometry(...SHEET)
  const meshes = []
  const add = async (markup, z, tone, part = null) => {
    const tex = new T.Texture(await layerImage(markup))
    tex.needsUpdate = true
    tex.anisotropy = 4
    const m = new T.Mesh(plane, new T.MeshBasicMaterial({ map: tex, color: pal[TONES[tone]], transparent: true, depthWrite: false }))
    m.userData.tone = tone
    m.position.z = z
    m.renderOrder = Math.round(z * 100)
    sheet.add(m)
    meshes.push(m)
    if (part) part.meshes.push(m)
  }
  // The sheet's own edge: a faint frame, so the plane reads as a plane.
  const edge = new T.LineLoop(new T.BufferGeometry().setFromPoints([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new T.Vector3((x * SHEET[0]) / 2 * 1.02, (y * SHEET[1]) / 2 * 1.03, -0.02))), new T.LineBasicMaterial({ color: pal.faint, transparent: true, opacity: 0.45 }))
  sheet.add(edge)
  await Promise.all([...Object.entries(ground).map(([tone, markup]) => add(markup, 0, tone)), ...[...parts.values()].flatMap((p) => Object.entries(p.layers).map(([tone, markup]) => add(markup, 0.02 + p.layer * LAYER, tone, p)))])

  // A part's middle on the sheet, in the world: where its leader lands.
  const tmp = new T.Vector3()
  const anchorOf = (p) => {
    const x = ((p.box.x + p.box.width / 2) / W - 0.5) * SHEET[0]
    const y = (0.5 - (p.box.y + p.box.height / 2) / H) * SHEET[1]
    return sheet.localToWorld(tmp.set(x, y, p.meshes[0]?.position.z ?? 0).clone())
  }

  // Names in the margins, a fact under each; the step words on the links, numbered in the order they happen.
  const labels = [...parts.values()].map((p) => {
    const el = document.createElement('span')
    el.className = 'nd-label3d'
    el.dataset.id = p.id
    if (p.note) el.dataset.read = p.note
    el.textContent = p.label
    layer.append(el)
    const lead = document.createElementNS(NS, 'path')
    lead.setAttribute('class', 'nd-leader')
    const dot = document.createElementNS(NS, 'circle')
    dot.setAttribute('class', 'nd-anchor')
    dot.setAttribute('r', '2')
    leaders.append(lead, dot)
    return { p, el, lead, dot }
  })
  const words = product.links.filter((k) => k.label && parts.has(k.from) && parts.has(k.to)).map((k, i) => {
    const el = document.createElement('span')
    el.className = 'nd-linkword'
    el.dataset.ix = String(i + 1)
    el.textContent = k.label
    layer.append(el)
    return { el, k }
  })

  let w = 0
  let h = 0
  const toScreen = (v) => {
    const s = v.clone().project(camera)
    return [((s.x + 1) / 2) * w, ((1 - s.y) / 2) * h]
  }
  let fitFor = 0
  function place() {
    // A row of names never runs off the plate: each name may take its share of the row, and its note wraps under it.
    if (fitFor !== w) {
      fitFor = w
      const row = (l) => (l.p.box.y + l.p.box.height / 2 < H / 2 ? 'top' : 'bottom')
      const count = Object.groupBy(labels, row)
      for (const l of labels) l.el.style.maxWidth = `${Math.floor((w - 8) / count[row(l)].length - 14)}px`
    }
    const sizes = labels.map((l) => [l.el.offsetWidth || l.p.label.length * 7.5 + 8, l.el.offsetHeight || 27])
    // The names stand above and below the sheet (the stage's wide layout): side columns would squeeze a 16:9 sheet into half the plate and run long notes off its edge.
    const m = marginsFor(sizes, { w, h }, true)
    const inner = { x0: m.x, y0: m.y, x1: w - m.x, y1: h - m.y }
    // The camera stands where the tilted sheet fills the figure's rect.
    const fov = (camera.fov * Math.PI) / 180
    const room = [(inner.x1 - inner.x0) / w, (inner.y1 - inner.y0) / h]
    camera.aspect = w / h
    camera.position.set(0, 0, Math.max(SHEET[0] / (2 * Math.tan(fov / 2) * camera.aspect * room[0]), SHEET[1] / (2 * Math.tan(fov / 2) * room[1])) * 1.04)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    scene.updateMatrixWorld(true)
    const items = labels.map((l, i) => {
      const [x, y] = toScreen(anchorOf(l.p))
      return { id: l.p.id, x, y, w: sizes[i][0], h: sizes[i][1], hot: l.p.hot, l }
    })
    const discs = items.map((it) => ({ x: it.x, y: it.y, r: Math.max(8, (Math.max(it.l.p.box.width, it.l.p.box.height) / W) * (inner.x1 - inner.x0) * 0.35) }))
    const laid = marginLabels(items, { inner, w, h }, { wide: true, discs })
    laid.forEach((at, i) => {
      const { l } = items[i]
      l.el.style.translate = `${at.x.toFixed(1)}px ${at.y.toFixed(1)}px`
      l.el.dataset.side = at.side
      l.lead.setAttribute('d', leaderPath(at))
      l.dot.setAttribute('cx', at.leader[1][0].toFixed(1))
      l.dot.setAttribute('cy', at.leader[1][1].toFixed(1))
      for (const el of [l.el, l.lead, l.dot]) {
        el.classList.toggle('nd-hot', l.p.hot)
        el.style.opacity = String(Math.max(0.35, l.p.dim))
      }
    })
    // A word stands on its link where nothing else is: it slides along the link to the first free spot.
    const taken = laid.map((at, i) => ({ x: at.x + items[i].w / 2, y: at.y + items[i].h / 2, w: items[i].w, h: items[i].h }))
    // The drawn parts are taken too: a word stands beside its link, never over a part.
    for (const p of parts.values()) {
      const c = [[p.box.x, p.box.y], [p.box.x + p.box.width, p.box.y], [p.box.x, p.box.y + p.box.height], [p.box.x + p.box.width, p.box.y + p.box.height]].map(([sx, sy]) => toScreen(sheet.localToWorld(tmp.set((sx / W - 0.5) * SHEET[0], (0.5 - sy / H) * SHEET[1], p.meshes[0]?.position.z ?? 0).clone())))
      const xs = c.map((q) => q[0])
      const ys = c.map((q) => q[1])
      taken.push({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) })
    }
    // Free: on the plate, and clear of every name, part and word already placed.
    const free = (x, y, bw, bh) => x - bw / 2 >= 4 && x + bw / 2 <= w - 4 && y - bh / 2 >= 4 && y + bh / 2 <= h - 4 && !taken.some((t) => Math.abs(t.x - x) < (t.w + bw) / 2 + 2 && Math.abs(t.y - y) < (t.h + bh) / 2 + 1)
    for (const { el, k } of words) {
      const a = anchorOf(parts.get(k.from))
      const b = anchorOf(parts.get(k.to))
      const [bw, bh] = [el.offsetWidth || k.label.length * 6.5 + 20, el.offsetHeight || 15]
      let [x, y] = toScreen(a.clone().lerp(b, 0.5))
      const open = [0.5, 0.38, 0.62, 0.28, 0.72].map((t) => toScreen(a.clone().lerp(b, t))).find(([px, py]) => free(px, py, bw, bh))
      if (open) [x, y] = open
      else {
        // No free spot on the link: step away from its middle, below then above, until one is found.
        const [mx, my] = [x, y]
        let step = 1
        for (; step <= 40 && !free(x, y, bw, bh); step++) [x, y] = [mx, my + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * (bh + 2)]
        // Nowhere free on the plate: the word stays on its link, over a part rather than off the edge.
        if (step > 40) [x, y] = [mx, my]
      }
      taken.push({ x, y, w: bw, h: bh })
      el.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`
      el.style.opacity = String(Math.max(0.35, Math.min(parts.get(k.from).dim, parts.get(k.to).dim)))
      el.classList.toggle('nd-hot', parts.get(k.from).hot || parts.get(k.to).hot)
    }
  }

  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  let raf = 0
  function frame() {
    raf = 0
    const r = node.getBoundingClientRect()
    if (r.width && (Math.round(r.width) !== w || Math.round(r.height) !== h)) {
      w = Math.round(r.width)
      h = Math.round(r.height)
      renderer.setSize(w, h, false)
      leaders.setAttribute('viewBox', `0 0 ${w} ${h}`)
    }
    let moving = false
    for (const p of parts.values()) {
      const k = reduced ? 1 : 0.14
      p.lift += (p.aim - p.lift) * k
      p.dim += (p.aimDim - p.dim) * k
      if (Math.abs(p.aim - p.lift) > 0.002 || Math.abs(p.aimDim - p.dim) > 0.002) moving = true
      // A step lights a part's ink in the accent; its warm and cool shapes keep their tones.
      for (const m of p.meshes) {
        m.position.z = 0.02 + p.layer * LAYER + p.lift
        m.material.color.copy(m.userData.tone === 'ink' ? (p.hot ? pal.ochre : pal.ink) : pal[TONES[m.userData.tone]])
        m.material.opacity = p.dim
      }
    }
    if (w && h) {
      place()
      renderer.render(scene, camera)
    }
    if (moving) raf = requestAnimationFrame(frame)
  }
  const kick = () => (raf ||= requestAnimationFrame(frame))
  const watch = new ResizeObserver(kick)
  watch.observe(node)
  kick()
  onSettled?.({})

  return {
    node,
    // A step: what it names lifts toward the eye in the accent, the rest steps back; nothing named is the whole plate.
    focus(ids) {
      const lit = new Set(ids instanceof Set ? ids : Array.isArray(ids) ? ids : [])
      for (const p of parts.values()) {
        p.hot = lit.has(p.id)
        p.aim = p.hot ? LIFT : 0
        p.aimDim = !lit.size || p.hot ? 1 : 0.32
      }
      kick()
    },
    snapshot: () => {
      renderer.render(scene, camera)
      return renderer.domElement.toDataURL('image/jpeg', 0.85)
    },
    dispose() {
      cancelAnimationFrame(raf)
      watch.disconnect()
      for (const m of meshes) (m.material.map?.dispose(), m.material.dispose())
      plane.dispose()
      renderer.dispose()
      node.remove()
    },
  }
}
