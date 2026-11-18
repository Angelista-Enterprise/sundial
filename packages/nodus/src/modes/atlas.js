// Atlas mode: real things in true detail, from open libraries, re-inked as
// our plates. "Show me a bicep and the layers under it" is BodyParts3D's
// biceps brachii, brachialis and humerus, each a mesh, laid in layers from the
// outside in and pulled apart one layer at a time, every structure named from
// the margin. "What does a windmill look like inside" is a plate: a drawing
// from Wikimedia Commons, each named part found on it by Jev (`box`), the
// walk zooming to what each sentence is about.
//
// build (node): a model reads the ask for the thing and the parts worth
// naming (a text call: the ask leaves the Mac, nothing else), the asset store
// searches the libraries with those words, Jev picks among the candidates by
// their thumbnails and descriptions, the files are fetched once into the
// store, the layers are worked out from the meshes themselves, and a model
// narrates with the parts' own names; Jev tailors the walk.
//
// draw (browser): three.js and the vendored loaders, every mesh redrawn by
// atlas-ink.js, labels in the margins (labels.js) with hairline leaders, the
// camera from camera.js. A plate is the image, leaders to Jev's boxes, and the
// lab's zoom into the box a step is about.
//
// The store (`ctx.assets`) is the host's (plugins/sundial-theme/host/api-assets.js):
// `search(q, kind, { names })`, `bytes(id)`, `image(id)`, `file(id)`.

import { criticQuestions, tailor } from '../storyboard.js'
import { names as namesIn, voiceProblem } from '../spec.js'

const SETS = { plan: 'nodus.atlas.plan.v1', pick: 'nodus.atlas.pick.v1', locate: 'nodus.atlas.locate.v1', walk: 'nodus.atlas.walk.v1' }
export const MAX_PARTS = 9
export const MAX_STEPS = 5
/** A whole mesh set is at most this much text to fetch and draw. */
const SET_BYTES = 20 * 2 ** 20
/** Jev's box under this confidence names nothing (the lab zoomed from 0.35; on a plate's labels Jev answers 0.3 for a true box). */
const BOX_MIN = 0.25

const ANATOMY = /\b(anatomy|bicep|biceps|tricep|triceps|quad|quads|hamstring|calf|muscles?|bones?|skeleton|skull|heart|lungs?|liver|kidneys?|brain|stomach|spine|vertebra|pelvis|ribs?|femur|humerus|tibia|fibula|radius|ulna|scapula|clavicle|sternum|knee|shoulder|elbow|hip|ankle|wrist|hand|foot|eye|ear|jaw|tendon|ligament|artery|arteries|veins?|aorta|nerves?|organs?|brachialis|deltoid|pectoralis|gluteus|abdominal)\b/i
const REAL = /\b(show me|what does|what do|looks? like|inside|layers?|under(neath)?|exploded|cut ?away|cross[- ]section|structure of|parts of|how is .* built|anatomy of|species|machine|engine|building)\b/i
const RECORD = /\b(today|yesterday|this week|last week|my day|meetings?|hours|my time|projects?|tickets?|commits?|calendar|threads?|goals?|ledger)\b/i

/** Is this ask about a real thing Atlas can draw from a library (the body, an object, a place, a machine, a species)? */
export function supports(ask, route = null) {
  if (route?.mode === 'atlas') return true
  // A figure of the record is never an atlas plate.
  if (route?.view && route.view !== 'free') return false
  const s = String(ask ?? '')
  if (ANATOMY.test(s)) return true
  return REAL.test(s) && !RECORD.test(s)
}

const sentence = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'part'

// ── What a structure is made of, and how deep it lies ─────────────────────────

const BONE = /\b(bones?|humerus|radius|ulna|femur|tibia|fibula|patella|scapula|clavicle|sternum|ribs?|vertebra|vertebrae|skull|cranium|mandible|maxilla|pelvis|hip bone|sacrum|coccyx|phalanx|phalanges|carpal|metacarpal|tarsal|metatarsal|calcaneus|talus|hyoid|ilium|ischium|pubis)\b/i
/** Outermost first: skin, then the soft tissue (muscle, vessels, organs) by depth, cartilage, bone. */
export function tissueOf(name) {
  const s = String(name ?? '').toLowerCase()
  if (/\b(skin|integument)\b/.test(s)) return 'skin'
  if (/\bcartilage\b/.test(s)) return 'cartilage'
  if (BONE.test(s)) return 'bone'
  return 'soft'
}
const RANK = { skin: 0, soft: 1, cartilage: 2, bone: 3 }

/** An OBJ's vertices, read for size and depth: the count, triangles, centroid, bounds, and an even sample of at most `keep` points. */
export function objStats(text, keep = 1500) {
  const pts = []
  let tris = 0
  for (const line of String(text).split('\n')) {
    if (line.startsWith('v ')) {
      const v = line.trim().split(/\s+/)
      pts.push(+v[1], +v[2], +v[3])
    } else if (line.startsWith('f ')) tris += line.trim().split(/\s+/).length - 3
  }
  const n = pts.length / 3
  const c = [0, 0, 0]
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      const x = pts[i * 3 + k]
      c[k] += x
      lo[k] = Math.min(lo[k], x)
      hi[k] = Math.max(hi[k], x)
    }
  const step = Math.max(1, Math.ceil(n / keep))
  const sample = []
  for (let i = 0; i < n; i += step) sample.push([pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]])
  return { vertices: n, triangles: tris, centroid: n ? c.map((x) => x / n) : [0, 0, 0], min: lo, max: hi, sample }
}

/**
 * The layers of a set, outside in, as the eye meets them from the front:
 * skin, the soft tissue by how far forward it stands (its points' mean along
 * `front`), cartilage, bone. Measured on the live arm, the distance from the
 * bone's axis did not tell the biceps (19 mm) from the brachialis (17 mm);
 * how far forward does (89 against 75). Soft parts within an eighth of the
 * set's depth of each other share a layer.
 * @param parts `[{ id, label, sample: [[x, y, z]] }]`
 * @param front the direction the set faces, in its own frame (BodyParts3D: -y)
 * @returns `[[ids]]`, outermost first
 */
export function layersOf(parts, front = [0, 0, 1]) {
  if (!parts.length) return []
  const along = (q) => q[0] * front[0] + q[1] * front[1] + q[2] * front[2]
  const depth = new Map(parts.map((p) => [p.id, (p.sample ?? []).reduce((s, q) => s + along(q), 0) / Math.max(1, p.sample?.length ?? 0)]))
  const all = parts.flatMap((p) => p.sample ?? []).map(along)
  const range = all.length ? Math.max(...all) - Math.min(...all) : 1
  const order = [...parts].sort((a, b) => RANK[tissueOf(a.label)] - RANK[tissueOf(b.label)] || depth.get(b.id) - depth.get(a.id))
  const layers = []
  let head = null
  for (const p of order) {
    const t = tissueOf(p.label)
    const join = head && tissueOf(head.label) === t && (t !== 'soft' || depth.get(head.id) - depth.get(p.id) < range / 8)
    if (join) layers.at(-1).push(p.id)
    else {
      layers.push([p.id])
      head = p
    }
  }
  return layers
}

/** A GLB's own description (its JSON chunk): the named nodes that hold meshes, with their parents. */
export function glbNodes(buffer) {
  const view = new DataView(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67) return null
  const len = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + 20, len)))
  const nodes = json.nodes ?? []
  const parent = new Map()
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)))
  const named = (i) => (nodes[i]?.name ?? '').replace(/[-_](mesh|Mesh|MESH|geo|Geo|primitive\d*)$/, '').replace(/[_.]+/g, ' ').replace(/\s*\d+$/, '').trim()
  return nodes.flatMap((n, i) => (n.mesh == null ? [] : [{ index: i, name: n.name ?? `node ${i}`, label: named(i), parent: parent.has(i) ? named(parent.get(i)) : null }]))
}

// ── The pick ──────────────────────────────────────────────────────────────────

/** Jev's question over the candidates; images ride as assets named in their criteria. */
export function pickQuestions(cands, images) {
  const criteria = Object.fromEntries(cands.map((c, i) => [`c${i}`, `${images[i] ? `Image \`img${i}\`: ` : ''}${c.source} (${c.kind === 'plate' ? 'a picture' : 'a 3D model'}): ${c.title}. ${c.description ?? ''}`.slice(0, 300)]))
  criteria.none = 'None of them shows what was asked.'
  return {
    best: {
      type: 'choice',
      instructions: 'Which candidate best shows `wanted`, to answer `ask`? For the human body prefer the anatomical meshes (BodyParts3D). For what something looks like inside prefer a drawn cutaway, section or plate. For an object, a clear model or drawing of the thing itself. Never a logo, a map, text or a crowd.',
      criteria,
    },
  }
}

/**
 * Order the candidates: Jev's probability for each, and a prior for what
 * the ask wants (anatomy: the BodyParts3D set; inside or a look: a plate).
 * Empty when Jev is sure none fits and nothing has a prior.
 */
export function scoreCandidates(cands, answer, plan = {}) {
  const p = answer?.probabilities ?? {}
  const none = p.none ?? (answer?.choice === 'none' ? answer.confidence ?? 1 : 0)
  const scored = cands.map((c, i) => {
    // What the ask wants (the body's meshes, a plate of an inside), and a small nudge toward a set with named parts.
    const wanted = (plan.anatomy && c.source === 'BodyParts3D' ? 0.6 : 0) + (plan.inside && !plan.anatomy && c.kind === 'plate' ? 0.3 : 0)
    const jev = p[`c${i}`] ?? (answer?.choice === `c${i}` ? answer.confidence ?? 1 : answer ? 0 : 1 / (i + 2))
    // A prior is earned only where Jev sees something (live: a hospital interior Jev gave 2 percent rode a plate prior past the windmill it chose).
    return { c, score: jev + wanted * Math.min(1, jev / 0.15) + (c.kind === 'mesh' && (c.parts?.length ?? 0) > 1 ? 0.05 : 0), wanted }
  })
  if (none >= 0.6 && !scored.some((s) => s.wanted > 0)) return []
  return scored.sort((a, b) => b.score - a.score).map((s) => ({ ...s.c, score: Math.round(s.score * 1000) / 1000 }))
}

/** Jev's box as fractions of the image (it may answer pixels or an array), or null. */
export function boxOf(answer, w = 1, h = 1) {
  let b = answer?.box
  if (!b) return null
  if (Array.isArray(b)) b = { left: b[0], top: b[1], right: b[2], bottom: b[3] }
  let { left, top, right, bottom } = { left: b.left ?? b.x0 ?? b.x, top: b.top ?? b.y0 ?? b.y, right: b.right ?? b.x1 ?? (b.x ?? 0) + (b.width ?? b.w ?? 0), bottom: b.bottom ?? b.y1 ?? (b.y ?? 0) + (b.height ?? b.h ?? 0) }
  if (![left, top, right, bottom].every(Number.isFinite)) return null
  if (Math.max(left, top, right, bottom) > 1.5) [left, right, top, bottom] = [left / w, right / w, top / h, bottom / h]
  const c = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
  if (right <= left || bottom <= top) return null
  return { left: c(left), top: c(top), right: c(right), bottom: c(bottom), confidence: answer.confidence ?? 1 }
}

// ── The plan and the walk (text in, text out) ─────────────────────────────────

const PLAN_SYSTEM = [
  'You read a request to see a real thing and say what to fetch from open libraries of 3D models and drawings. Reply with one JSON object and nothing else:',
  '{"subject": "the thing, two to four plain words", "kind": "anatomy" | "object" | "machine" | "place" | "species", "inside": true if the ask is about its inside or its layers, "parts": [...], "query": "two to four search words for the thing itself", "drawing": "two to four search words for a drawing, plate or cutaway of it"}',
  'parts: for the human body, two to seven structures by their FMA English names, the asked one first and what lies under it after, outside in (for a bicep and the layers under it: "biceps brachii", "brachialis", "coracobrachialis", "humerus"; for the heart: "right atrium", "right ventricle", "left atrium", "left ventricle", "ascending aorta", "arch of aorta", "pulmonary trunk", "superior vena cava"; name the part of a long vessel that belongs to the thing, never the whole vessel). For anything else, three to seven parts a reader would want pointed out on a picture of it, in plain words.',
  'query and drawing: plain English words a picture library would file it under (a windmill cutaway, not a sentence), never a person, a place of the asker or anything private.',
].join('\n')

/** The model's plan, or null when it is not one. */
export function parsePlan(text) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ''))
  if (!m) return null
  try {
    const o = JSON.parse(m[0])
    const parts = (Array.isArray(o.parts) ? o.parts : []).map((p) => String(p).replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean).slice(0, MAX_PARTS)
    const subject = String(o.subject ?? '').trim().slice(0, 60)
    if (!subject) return null
    const query = String(o.query ?? subject).replace(/\s+/g, ' ').trim().slice(0, 80)
    return { subject, kind: String(o.kind ?? 'object'), anatomy: o.kind === 'anatomy', inside: o.inside === true, parts, query, drawing: String(o.drawing ?? query).replace(/\s+/g, ' ').trim().slice(0, 80) }
  } catch {
    return null
  }
}

/** Without a model: the ask's own words. */
export function planOf(ask) {
  const s = String(ask ?? '')
  const anatomy = ANATOMY.test(s)
  const subject = s.replace(/^(please\s+)?(show me|draw|what does|what do|how does|let me see)\s+/i, '').replace(/\b(look like|looks like|and the layers under it|inside|exploded|please)\b.*$/i, '').replace(/^(a|an|the|my)\s+/i, '').replace(/[?.!]+$/, '').trim().slice(0, 60) || s.slice(0, 60)
  const parts = anatomy ? [...s.toLowerCase().matchAll(new RegExp(ANATOMY.source, 'gi'))].map((m) => m[0]).filter((w) => !/^(anatomy|muscles?|bones?|organs?|skeleton)$/.test(w)) : []
  const inside = /\b(inside|layers?|under|cut ?away|section)\b/i.test(s)
  return { subject, kind: anatomy ? 'anatomy' : 'object', anatomy, inside, parts: [...new Set(parts)], query: subject, drawing: inside && !anatomy ? `${subject} cutaway` : subject }
}

const WALK_SYSTEM = [
  'You are an artist and a teacher, and a companion: curious, warm, exact. You walk someone through a drawing of a real thing, one sentence per step. You are not an assistant and never call yourself one.',
  'Reply with one JSON object and nothing else: {"title": "a few words", "steps": [{"focus": ["part ids"], "say": "one sentence", "explode": 0}]}.',
  'Two to five steps. Each sentence names the part it is about with that part\'s own label, says one true thing about it (what it does, what it attaches to, what lies under it), at most twenty words. "explode" is how many layers are lifted away for that step, outermost first (0 for the whole), only when layers are given. Talk about the thing, never the picture. No em dashes, no lists, no markdown.',
].join('\n')

/** The model's walk over these parts, kept to what it may say; null when nothing is left. */
export function parseWalk(text, parts, layers = []) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ''))
  if (!m) return null
  let o
  try {
    o = JSON.parse(m[0])
  } catch {
    return null
  }
  const ids = new Set(parts.map((p) => p.id))
  const label = new Map(parts.map((p) => [p.id, p.label]))
  const steps = (Array.isArray(o.steps) ? o.steps : [])
    .map((s) => ({ focus: (Array.isArray(s?.focus) ? s.focus : []).map(String).filter((id) => ids.has(id)), say: String(s?.say ?? '').replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/\s+/g, ' ').trim(), ...(layers.length > 1 && Number.isInteger(s?.explode) && s.explode > 0 ? { explode: Math.min(s.explode, layers.length - 1) } : {}) }))
    .filter((s) => s.focus.length && s.say && s.say.split(/\s+/).length <= 30 && !voiceProblem(s.say) && s.focus.some((id) => namesIn(s.say, label.get(id))))
    .slice(0, MAX_STEPS)
  return steps.length ? { title: String(o.title ?? '').trim().slice(0, 80), steps } : null
}

/** The walk from the layers (or the parts in reading order), no model. */
export function walkOf(subject, parts, layers = []) {
  const label = new Map(parts.map((p) => [p.id, p.label]))
  const names = (ids) => ids.map((id) => label.get(id)).join(' and ')
  if (layers.length > 1)
    return layers.slice(0, MAX_STEPS).map((ids, i) =>
      i === 0 ? { focus: ids, say: `${names(ids)} ${ids.length > 1 ? 'are' : 'is'} the outer layer of the ${subject}.` } : { focus: ids, say: `Lift ${names(layers[i - 1])} away and ${names(ids)} ${i === layers.length - 1 ? 'lies deepest' : 'lies under it'}.`, explode: i },
    )
  if (parts.length === 1) return [{ focus: [parts[0].id], say: `Here is the ${subject.toLowerCase()}, whole.` }]
  return parts.slice(0, MAX_STEPS).map((p, i) => ({ focus: [p.id], say: i === 0 ? `${p.label} stands out first on the ${subject.toLowerCase()}.` : `Here is the ${p.label.toLowerCase()}.` }))
}

const within = (ms, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timed out')), ms))])

// ── build ─────────────────────────────────────────────────────────────────────

/**
 * Build an atlas product: the asset picked, fetched, layered, located and walked.
 * @param ctx.assets the host's store; ctx.complete(messages) → text; ctx.judge({ state, questions, set, assets? }) → answers
 * @returns the product, or `{ ok: false, reason }` when nothing true could be found
 */
export async function build(ask, ctx = {}) {
  const now = ctx.now ?? (() => performance.now())
  const t0 = now()
  const ms = {}
  const lap = (k, t) => (ms[k] = Math.round(now() - t))
  // The host's store; without one handed in, the theme's own (the same files the route serves). Node only: build never runs in the page.
  const store = ctx.assets ?? (await import(/* @vite-ignore */ new URL('../../../../plugins/sundial-theme/host/api-assets.js', import.meta.url).href).then((m) => m.sharedAssetStore()).catch(() => null))
  if (!store?.search) return { ok: false, reason: 'the asset store is not here' }

  // 1. What thing, which parts, which search words: the ask is the only thing sent.
  let t = now()
  const said = ctx.complete ? await within(30_000, ctx.complete([{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: String(ask).slice(0, 400) }])).catch(() => null) : null
  const plan = parsePlan(said) ?? planOf(ask)
  plan.by = said && parsePlan(said) ? 'model' : 'words'
  lap('plan', t)

  // 2. Candidates from every source that answers.
  t = now()
  const [mesh, plate] = await Promise.all([
    store.search(plan.query, 'mesh', { names: plan.anatomy ? plan.parts : [] }).catch((e) => ({ candidates: [], skipped: [{ source: 'mesh', reason: e.message }] })),
    // Plates by the drawing's words, the thing's words, (for the body) Gray's, and (for an inside) the bare noun's cutaway: each its own search, merged in turn.
    Promise.all([...new Set([plan.anatomy ? `Gray's Anatomy ${plan.query}` : null, plan.drawing, plan.query, plan.inside && !plan.anatomy ? `${plan.subject.split(' ').filter((w) => !/^(interior|inside|inner|internal|workings|mechanism|of|the|a|an)$/i.test(w)).at(-1) ?? plan.subject} cutaway` : null].filter(Boolean))].map((q) => store.search(q, 'plate').catch((e) => ({ candidates: [], skipped: [{ source: 'plate', reason: e.message }] })))).then((all) => ({
      candidates: [...new Map(all.flatMap((r, i) => r.candidates.map((c, k) => [k * 10 + i, c])).sort((a, b) => a[0] - b[0]).map(([, c]) => [c.id, c])).values()],
      skipped: all.flatMap((r) => r.skipped),
    })),
  ])
  const cands = [...mesh.candidates.filter((c) => c.source === 'BodyParts3D'), ...plate.candidates.slice(0, 5), ...mesh.candidates.filter((c) => c.source !== 'BodyParts3D').slice(0, 3)].slice(0, 8)
  const skipped = [...mesh.skipped, ...plate.skipped]
  lap('search', t)
  if (!cands.length) return { ok: false, reason: `no open library had ${plan.subject}${skipped.length ? ` (${[...new Set(skipped.map((s) => s.source))].join(', ')} could not be reached)` : ''}` }

  // 3. Jev picks by thumbnails and descriptions.
  t = now()
  const images = await Promise.all(cands.map((c) => (c.thumb && store.image ? store.image(c.thumb).catch(() => null) : null)))
  const assets = Object.fromEntries(images.flatMap((img, i) => (img ? [[`img${i}`, { type: 'image', data_base64: img.data_base64, format: img.format }]] : [])))
  const answers = ctx.judge ? await within(15_000, ctx.judge({ state: { ask: String(ask).slice(0, 400), wanted: plan.subject, candidates: cands.map((_, i) => `c${i}`) }, questions: pickQuestions(cands, images), set: SETS.pick, ...(Object.keys(assets).length ? { assets } : {}) })).catch(() => null) : null
  const ranked = scoreCandidates(cands, answers?.best, plan)
  lap('pick', t)
  if (!ranked.length) return { ok: false, reason: `nothing found in the open libraries shows ${plan.subject}` }

  // 4. The first candidate that can be fetched and drawn; the next when one fails.
  t = now()
  let asset = null
  let layers = []
  const fetched = { files: 0, bytes: 0, cached: 0 }
  const failures = []
  for (const c of ranked.slice(0, 3)) {
    try {
      const made = c.kind === 'plate' ? await platePrep(c, plan, { ...ctx, assets: store }, ms) : c.format === 'glb' ? await glbPrep(c, plan, store, fetched) : await objPrep(c, store, fetched)
      if (!made) continue
      ;({ asset, layers } = made)
      break
    } catch (e) {
      failures.push(`${c.source}: ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }
  lap('fetch', t)
  if (!asset) return { ok: false, reason: `the files for ${plan.subject} could not be fetched (${failures.join('; ') || 'none drew'})` }

  // 5. The walk: by the layers, then the model's with the parts' own names, tailored by Jev.
  t = now()
  const parts = asset.parts
  let steps = walkOf(plan.subject, parts, layers)
  let title = sentence(plan.subject)
  let storyboard = 'fallback'
  if (ctx.complete && parts.length) {
    const brief = { ask: String(ask).slice(0, 400), subject: plan.subject, source: asset.source, parts: parts.map((p) => ({ id: p.id, label: p.label })), ...(layers.length > 1 ? { layers: layers.map((ids) => ids.map((id) => parts.find((p) => p.id === id).label)) } : {}) }
    const reply = await within(30_000, ctx.complete([{ role: 'system', content: WALK_SYSTEM }, { role: 'user', content: JSON.stringify(brief) }])).catch(() => null)
    const walk = parseWalk(reply, parts, layers)
    if (walk) {
      steps = walk.steps
      title = walk.title || title
      storyboard = 'model'
    }
  }
  lap('narrate', t)
  t = now()
  let critic = null
  if (ctx.judge && steps.length) {
    const state = { ask: String(ask).slice(0, 400), digest: `${asset.source}: ${plan.subject}; ${parts.map((p) => p.label).join(', ')}`, walk: Object.fromEntries(steps.map((s, i) => [`s${i}`, s.say])) }
    const verdict = await within(10_000, ctx.judge({ state, questions: criticQuestions(steps, true), set: SETS.walk })).catch(() => null)
    if (verdict) {
      critic = { fits: verdict.fits?.score ?? null }
      if (storyboard === 'model' && critic.fits !== null && critic.fits < 1) {
        steps = walkOf(plan.subject, parts, layers)
        storyboard = 'fallback'
      } else steps = tailor(steps, verdict)
    }
    lap('critic', t)
  }
  ms.total = Math.round(now() - t0)
  return { kind: 'asset', mode: 'atlas', title, ask: String(ask), subject: plan.subject, assets: [asset], layers, steps, by: { ms, critic, storyboard, plan: plan.by, pick: { source: asset.source, score: ranked.find((c) => c.id === asset.candidate)?.score ?? null, ranked: ranked.slice(0, 3).map((c) => ({ source: c.source, title: String(c.title).slice(0, 60), score: c.score })) }, fetched, ...(skipped.length ? { skipped } : {}), ...(failures.length ? { failures } : {}) } }
}

const credit = (c) => ({ id: c.id, candidate: c.id, source: c.source, license: c.license, credit: c.credit, url: c.url, title: c.title })

async function objPrep(c, store, fetched) {
  // Which files each structure draws (a file two share is drawn once, with the first that names it), under the set's cap; then every file at once.
  let total = 0
  const used = new Set()
  const chosen = (c.parts ?? []).flatMap((p) => {
    const own = p.files.filter((id) => !used.has(id))
    if (!own.length || total + p.bytes > SET_BYTES) return []
    own.forEach((id) => used.add(id))
    total += p.bytes
    return [{ ...p, own }]
  })
  const parts = await Promise.all(chosen.map(async (p) => {
    const texts = await Promise.all(p.own.map(async (id) => {
      const f = await store.file(id)
      fetched.files++
      fetched.bytes += f.size
      if (f.cached) fetched.cached++
      return (await store.bytes(id)).toString('utf8')
    }))
    const stats = texts.map((x) => objStats(x, Math.ceil(1500 / texts.length)))
    return { id: slug(p.label), label: p.label, mesh: p.own, door: `search:${p.label}`, sample: stats.flatMap((s) => s.sample), triangles: stats.reduce((s, x) => s + x.triangles, 0) }
  }))
  if (!parts.length) return null
  const layers = layersOf(parts, c.source === 'BodyParts3D' ? [0, -1, 0] : [0, 0, 1])
  return { asset: { ...credit(c), kind: 'mesh', format: 'obj', up: c.up ?? 'y', front: c.source === 'BodyParts3D' ? '-y' : '+z', parts: parts.map(({ sample, ...p }) => p) }, layers }
}

async function glbPrep(c, plan, store, fetched) {
  const f = await store.file(c.file)
  fetched.files++
  fetched.bytes += f.size
  if (f.cached) fetched.cached++
  const nodes = glbNodes(await store.bytes(c.file)) ?? []
  // Named parts when the model has them (at most nine, the largest groups first); one part, the thing itself, when it does not.
  const groups = new Map()
  for (const n of nodes) {
    const key = nodes.length > MAX_PARTS ? n.parent || n.label : n.label
    if (key && !/^(scene|root|node|object|mesh)$/i.test(key)) (groups.get(key) ?? groups.set(key, []).get(key)).push(n.name)
  }
  const named = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_PARTS)
  const parts = named.length > 1 ? named.map(([label, list]) => ({ id: slug(label), label: sentence(label), node: list, door: `search:${label}` })) : [{ id: slug(plan.subject), label: sentence(plan.subject), node: nodes.map((n) => n.name), door: `search:${plan.subject}` }]
  return { asset: { ...credit(c), kind: 'mesh', format: 'glb', file: c.file, up: 'y', front: '+z', parts }, layers: [parts.map((p) => p.id)] }
}

async function platePrep(c, plan, ctx, ms) {
  const img = await ctx.assets.image(c.image)
  if (!img) {
    // Too large or too small for Jev to look at: still a true picture, named for its subject alone.
    await ctx.assets.file(c.image)
    return { asset: { ...credit(c), kind: 'plate', image: c.image, w: c.w, h: c.h, parts: [] }, layers: [] }
  }
  const t = performance.now()
  const labels = (plan.parts.length ? plan.parts : [plan.subject]).slice(0, MAX_PARTS).map(sentence)
  const questions = Object.fromEntries(labels.map((l, i) => [`p${i}`, { type: 'box', instructions: `the ${l.toLowerCase()} in \`img\`, a picture of ${plan.subject}` }]))
  const located = ctx.judge ? await within(15_000, ctx.judge({ state: { img: 'img', ask: plan.subject }, questions, set: SETS.locate, assets: { img: { type: 'image', data_base64: img.data_base64, format: img.format } } })).catch(() => null) : null
  ms.locate = Math.round(performance.now() - t)
  const parts = labels.flatMap((label, i) => {
    const box = boxOf(located?.[`p${i}`], img.w, img.h)
    return box && box.confidence >= BOX_MIN ? [{ id: slug(label), label, box, door: `search:${label}` }] : []
  })
  return { asset: { ...credit(c), kind: 'plate', image: c.image, w: img.w, h: img.h, parts }, layers: [] }
}

// ── draw (browser) ────────────────────────────────────────────────────────────

const NS = 'http://www.w3.org/2000/svg'
const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - (1 - x) ** 3)
const DIM = 0.3
const MOVE_MS = 420
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The labels and leaders over a plate or a stage, shared by both. */
function labelLayer(node, parts) {
  const leaders = document.createElementNS(NS, 'svg')
  leaders.setAttribute('class', 'nd-leaders')
  leaders.setAttribute('aria-hidden', 'true')
  // The labels' layer (the stage's .nd-labels, by style: a class with "label" in it reads as a label to the e2e's overlap check).
  const layer = document.createElement('div')
  layer.className = 'nd-tags'
  layer.style.cssText = 'position: absolute; inset: 0; pointer-events: none;'
  node.append(leaders, layer)
  const labels = parts.map((p) => {
    const el = document.createElement('span')
    el.className = 'nd-label3d'
    el.dataset.id = p.id
    el.textContent = p.label
    if (p.door) {
      el.dataset.explore = p.door
      el.setAttribute('role', 'link')
      el.tabIndex = 0
    }
    layer.append(el)
    const lead = document.createElementNS(NS, 'path')
    lead.setAttribute('class', 'nd-leader')
    const dot = document.createElementNS(NS, 'circle')
    dot.setAttribute('class', 'nd-anchor')
    dot.setAttribute('r', '2.5')
    leaders.append(lead, dot)
    return { id: p.id, el, lead, dot, size: null }
  })
  const size = (l) => (l.size && l.el.offsetWidth ? l.size : (l.size = [l.el.offsetWidth || l.el.textContent.length * 7.5 + 8, l.el.offsetHeight || 15]))
  /** Lay the labels for anchors `{ id: [x, y] }` (missing ones are hidden), inside a plate `inner`. */
  function lay(anchors, inner, w, h, hot, marginLabels, discs = []) {
    const items = labels.filter((l) => anchors[l.id]).map((l) => ({ id: l.id, x: anchors[l.id][0], y: anchors[l.id][1], w: size(l)[0], h: size(l)[1], hot: hot.has(l.id), l }))
    const laid = marginLabels(items, { inner, w, h }, { wide: false, discs })
    laid.forEach((at, i) => {
      const { l } = items[i]
      l.at = at
      l.el.style.translate = `${at.x.toFixed(1)}px ${at.y.toFixed(1)}px`
      l.el.dataset.side = at.side
      const [[x0, y0], [x1, y1]] = at.leader
      l.lead.setAttribute('d', `M${x0.toFixed(1)},${y0.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)}`)
      l.dot.setAttribute('cx', x1.toFixed(1))
      l.dot.setAttribute('cy', y1.toFixed(1))
    })
    for (const l of labels) {
      const on = Boolean(anchors[l.id])
      if (!on) l.at = null
      const o = !on ? '0' : hot.size && !hot.has(l.id) ? '0.45' : '1'
      for (const el of [l.el, l.lead, l.dot]) {
        el.style.opacity = o
        el.classList.toggle('nd-hot', hot.has(l.id))
      }
    }
  }
  /** Labels and leaders burnt into a 2d canvas (the frame critic sees what the owner sees). */
  function burn(ctx, k, hot, tones) {
    ctx.textBaseline = 'top'
    ctx.font = `500 ${11 * k}px Inter Tight, system-ui, sans-serif`
    ctx.lineWidth = 1
    for (const l of labels) {
      if (!l.at) continue
      const tone = hot.has(l.id) ? tones.ochre : tones.muted
      ctx.fillStyle = tone
      ctx.strokeStyle = tone
      ctx.beginPath()
      ctx.moveTo(l.at.leader[0][0] * k, l.at.leader[0][1] * k)
      ctx.lineTo(l.at.leader[1][0] * k, l.at.leader[1][1] * k)
      ctx.stroke()
      ctx.fillText(l.el.textContent.toUpperCase(), l.at.x * k, l.at.y * k)
    }
  }
  return { labels, lay, burn, leaders, sizes: () => labels.map(size) }
}

/** The scale for a frame Jev can take (280 to 1568 px a side, at most `maxW` wide), or null when the plate is too small or too long for it. */
export function frameScale(w, h, maxW = 1280) {
  if (w < 50 || h < 50) return null
  let k = Math.min(1, maxW / w, 1568 / h)
  if (Math.min(w, h) * k < 280) k = 280 / Math.min(w, h)
  return Math.max(w, h) * k > 1568 ? null : k
}

const cssToken = (name, fallback) => (typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : '') || fallback
const tonesNow = () => ({ ink: cssToken('--ink', '#222'), muted: cssToken('--ink-muted', '#666'), ochre: cssToken('--ochre', '#b8862b'), page: cssToken('--page', '#fff') })

/** Which parts a sentence names, by their labels (when a step gives no ids). */
const named = (parts, sentenceText) => (sentenceText ? parts.filter((p) => namesIn(sentenceText, p.label)).map((p) => p.id) : [])

/** Source metadata as plain text: tags (closed or cut off) and entities dropped. */
export const plain = (v) => String(v ?? '').replace(/<[^>]*(>|$)/g, ' ').replace(/&(amp|quot|#0?39|[a-z]+);/g, (m, e) => ({ amp: '&', quot: '"', '#39': "'", '#039': "'" })[e] ?? ' ').replace(/\s+/g, ' ').trim()

/**
 * Draw an atlas product into `host` (appended), a mesh set or a plate.
 * @param opts.palette readPalette(T) (token to THREE.Color), read from the page when absent
 * @param opts.onSettled called once each time the picture comes to rest after a change
 * @param opts.base where the asset files are served (`/gnomon/api/assets/`)
 * @returns `{ node, focus(ids, sentence), snapshot(), update(product), dispose(), explode(level) }`
 */
export function draw(host, product, opts = {}) {
  const asset = product?.assets?.[0]
  // The plate above, the credit and licence under it: the plate gives up height so the credit always shows.
  const frame = document.createElement('div')
  frame.className = 'nd-atlas'
  frame.style.cssText = 'display: flex; flex-direction: column; min-height: 0;'
  const caption = document.createElement('p')
  caption.className = 'nd-credit'
  caption.style.cssText = 'flex: none; margin: 6px 0 0; font-size: 11px; line-height: 15px; color: var(--ink-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;'
  // A plate's file name says which plate; a mesh set's title only repeats its labels. The source once, in the credit when it is there.
  // The metadata is text only (a source's own HTML, even cut mid-tag, is dropped); the one link, to the source page, is built here.
  const say = (a) => {
    if (!a) return caption.replaceChildren()
    const credit = plain(a.credit)
    const source = plain(a.source)
    const link = document.createElement('a')
    link.textContent = credit.includes(source) ? 'source' : source
    if (/^https?:\/\//.test(a.url ?? '')) Object.assign(link, { href: a.url, target: '_blank', rel: 'noopener' })
    caption.replaceChildren(`${a.kind === 'plate' && a.title ? `${plain(a.title)} · ` : ''}${credit && credit !== 'unknown' ? `${credit} · ` : ''}`, link, ` · ${plain(a.license)}`)
  }
  say(asset)
  let figure = asset?.kind === 'plate' ? drawPlate(product, opts) : drawMesh(product, opts)
  const fit = (n) => ((n.style.flex = '1 1 auto'), (n.style.minHeight = '0'), n)
  frame.append(fit(figure.node), caption)
  host?.append?.(frame)
  return {
    node: frame,
    // A step lights its parts and lifts the layers it says (the card hands over the sentence; its step carries `explode`); the whole figure closes them.
    focus: (ids, sentenceText) => {
      const step = sentenceText ? product.steps?.find((s) => s.say === sentenceText) : null
      figure.explode(step?.explode ?? 0)
      figure.focus(ids, sentenceText)
    },
    explode: (level) => figure.explode(level),
    snapshot: (maxW) => figure.snapshot(maxW),
    update: (fresh) => {
      const next = fresh?.assets?.[0]
      // The same asset: the walk changed, the picture stays. Another asset: drawn again.
      if (next?.id === product.assets?.[0]?.id && next?.kind === product.assets?.[0]?.kind) {
        product = fresh
        figure.update?.(fresh)
        return
      }
      figure.dispose()
      product = fresh
      figure = next?.kind === 'plate' ? drawPlate(fresh, opts) : drawMesh(fresh, opts)
      frame.replaceChild(fit(figure.node), frame.firstChild)
      say(next)
    },
    dispose: () => figure.dispose(),
    get ready() {
      return figure.ready
    },
  }
}

function drawPlate(product, { onSettled = null, base = '/gnomon/api/assets/' } = {}) {
  const asset = product.assets[0]
  const parts = asset.parts ?? []
  const node = document.createElement('div')
  node.className = 'nd-stage nd-atlas-plate'
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', product.title ?? asset.title ?? 'A plate')
  // The image in a window the size of its fitted rect: zoomed, it never spills into the margins the labels stand in.
  const view = document.createElement('div')
  view.style.cssText = 'position: absolute; overflow: hidden;'
  const img = document.createElement('img')
  img.alt = asset.title ?? ''
  img.decoding = 'async'
  img.style.cssText = 'position: absolute; left: 0; top: 0; max-width: none; transform-origin: 0 0; transition: transform 420ms cubic-bezier(.2,.7,.2,1);'
  view.append(img)
  node.append(view)
  const { lay, burn, leaders } = labelLayer(node, parts)
  const boxes = document.createElementNS(NS, 'g')
  leaders.prepend(boxes)
  let hot = new Set()
  let zoom = { s: 1, x: 0, y: 0 }
  let fit = null
  let labelsMod = null
  const ready = Promise.all([import('../labels.js').then((m) => (labelsMod = m)), new Promise((ok, no) => ((img.onload = ok), (img.onerror = no), (img.src = `${base}${asset.image}`)))]).then(() => layout())
  ready.catch(() => node.append(Object.assign(document.createElement('div'), { className: 'reading', textContent: 'The plate could not be loaded' })))

  function layout() {
    if (!labelsMod || !img.naturalWidth) return
    const w = Math.max(1, node.clientWidth)
    const h = Math.max(1, node.clientHeight)
    const m = labelsMod.marginsFor(parts.map((p) => [p.label.length * 7.5 + 8, 15]), { w, h }, false)
    const inner = { x0: parts.length ? m.x : 0, y0: m.y, x1: w - (parts.length ? m.x : 0), y1: h - m.y }
    const k = Math.min((inner.x1 - inner.x0) / img.naturalWidth, (inner.y1 - inner.y0) / img.naturalHeight)
    const iw = img.naturalWidth * k
    const ih = img.naturalHeight * k
    fit = { x: inner.x0 + (inner.x1 - inner.x0 - iw) / 2, y: inner.y0 + (inner.y1 - inner.y0 - ih) / 2, w: iw, h: ih, inner }
    Object.assign(view.style, { left: `${fit.x}px`, top: `${fit.y}px`, width: `${iw}px`, height: `${ih}px` })
    img.style.width = `${iw}px`
    img.style.height = `${ih}px`
    // Zoom about the image's own rect, kept inside it (the lab's stepInto, in pixels).
    img.style.transform = `translate(${(zoom.x * iw).toFixed(1)}px, ${(zoom.y * ih).toFixed(1)}px) scale(${zoom.s.toFixed(3)})`
    const to = (u, v) => [fit.x + zoom.x * iw + u * iw * zoom.s, fit.y + zoom.y * ih + v * ih * zoom.s]
    const anchors = {}
    boxes.replaceChildren()
    for (const p of parts) {
      const [x, y] = to((p.box.left + p.box.right) / 2, (p.box.top + p.box.bottom) / 2)
      if (x >= fit.x - 1 && x <= fit.x + iw + 1 && y >= fit.y - 1 && y <= fit.y + ih + 1) anchors[p.id] = [x, y]
      if (hot.has(p.id)) {
        const [x0, y0] = to(p.box.left, p.box.top)
        const [x1, y1] = to(p.box.right, p.box.bottom)
        const r = document.createElementNS(NS, 'rect')
        r.setAttribute('class', 'nd-leader nd-hot')
        for (const [a, v] of Object.entries({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })) r.setAttribute(a, v.toFixed(1))
        boxes.append(r)
      }
    }
    lay(anchors, { x0: fit.x, y0: fit.y, x1: fit.x + iw, y1: fit.y + ih }, w, h, hot, labelsMod.marginLabels)
  }
  const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null
  sizes?.observe(node)
  let settleTimer = null
  // At rest once the image is in and the zoom has finished: a frame judged before the plate loads is a blank one.
  const settle = () =>
    ready.then(() => {
      clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        onSettled?.()
        node.dispatchEvent(new CustomEvent('nodus:settled', { bubbles: true }))
      }, reducedMotion() ? 0 : MOVE_MS + 40)
    }, () => onSettled?.({ error: 'the plate could not be loaded' }))
  function focus(ids, sentenceText) {
    const list = ids instanceof Set ? [...ids] : ids?.length ? ids : named(parts, sentenceText)
    hot = new Set(list)
    const lit = parts.filter((p) => hot.has(p.id))
    if (lit.length) {
      const b = { left: Math.min(...lit.map((p) => p.box.left)), top: Math.min(...lit.map((p) => p.box.top)), right: Math.max(...lit.map((p) => p.box.right)), bottom: Math.max(...lit.map((p) => p.box.bottom)) }
      const s = Math.min(1.6, Math.max(1.08, 0.55 / Math.max(b.right - b.left, b.bottom - b.top, 0.2)))
      const cx = (b.left + b.right) / 2
      const cy = (b.top + b.bottom) / 2
      // Centre the box, but never show past the image's edge.
      zoom = { s, x: Math.min(0, Math.max(1 - s, 0.5 - cx * s)), y: Math.min(0, Math.max(1 - s, 0.5 - cy * s)) }
    } else zoom = { s: 1, x: 0, y: 0 }
    node.classList.toggle('nd-has-focus', hot.size > 0)
    layout()
    settle()
  }
  function snapshot(maxW = 1280) {
    const w = node.clientWidth || 1
    const h = node.clientHeight || 1
    const k = frameScale(w, h, maxW)
    if (k == null) return null
    const c = document.createElement('canvas')
    c.width = Math.round(w * k)
    c.height = Math.round(h * k)
    const g = c.getContext('2d')
    const tones = tonesNow()
    g.fillStyle = tones.page
    g.fillRect(0, 0, c.width, c.height)
    if (fit && img.complete) {
      g.save()
      g.beginPath()
      g.rect(fit.x * k, fit.y * k, fit.w * k, fit.h * k)
      g.clip()
      g.drawImage(img, (fit.x + zoom.x * fit.w) * k, (fit.y + zoom.y * fit.h) * k, fit.w * zoom.s * k, fit.h * zoom.s * k)
      g.restore()
    }
    burn(g, k, hot, tones)
    return c.toDataURL('image/jpeg', 0.85)
  }
  return { node, focus, explode: () => {}, snapshot, update: () => {}, dispose: () => sizes?.disconnect(), ready }
}

function drawMesh(product, { palette = null, onSettled = null, base = '/gnomon/api/assets/' } = {}) {
  const asset = product.assets[0]
  const parts = asset.parts ?? []
  const node = document.createElement('div')
  node.className = 'nd-stage nd-atlas-mesh'
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', product.title ?? asset.title ?? 'A model')
  node.tabIndex = -1
  const loading = Object.assign(document.createElement('div'), { className: 'reading', textContent: 'Fetching the model' })
  node.append(loading)
  const { lay, burn, sizes: labelSizes } = labelLayer(node, parts)
  const reduced = reducedMotion()
  let hot = new Set()
  let level = 0
  const state = { disposed: false }
  let api = null
  const ready = (async () => {
    const [T, labelsMod, cam, ink, kitMod] = await Promise.all([import('../three-loader.js').then((m) => m.loadThree()), import('../labels.js'), import('../camera.js'), import('../atlas-ink.js'), import('../kit.js')])
    const Loader = asset.format === 'glb' ? (await import('@sundial/nodus/vendor/GLTFLoader.js')).GLTFLoader : (await import('@sundial/nodus/vendor/OBJLoader.js')).OBJLoader
    const pal = palette ?? kitMod.readPalette(T)
    // Every file once, as the loader reads it.
    const files = asset.format === 'glb' ? [asset.file] : [...new Set(parts.flatMap((p) => p.mesh ?? []))]
    const loaded = new Map(
      await Promise.all(
        files.map(async (id) => {
          const res = await fetch(`${base}${id}`)
          if (!res.ok) throw new Error(`asset ${id} answered ${res.status}`)
          if (asset.format === 'glb') {
            const buf = await res.arrayBuffer()
            return [id, await new Promise((ok, no) => new Loader().parse(buf, '', (g) => ok(g.scene), no))]
          }
          return [id, new Loader().parse(await res.text())]
        }),
      ),
    )
    if (state.disposed) return
    // Each part's meshes, baked into one frame: the library's up turned to ours, the set centred and four units across.
    const up = new T.Matrix4()
    if (asset.up === 'z') up.makeRotationX(-Math.PI / 2)
    const groups = new Map()
    const meshesOf = (p) => {
      const out = []
      if (asset.format === 'glb') {
        const root = loaded.get(asset.file)
        const want = new Set(p.node ?? [])
        root.updateMatrixWorld(true)
        root.traverse((o) => o.isMesh && (want.has(o.name) || want.has(o.parent?.name) || !want.size || parts.length === 1) && out.push(o))
      } else for (const id of p.mesh ?? []) loaded.get(id)?.traverse((o) => o.isMesh && out.push(o))
      return out
    }
    const box = new T.Box3()
    const partMeshes = new Map(parts.map((p) => [p.id, meshesOf(p)]))
    for (const list of partMeshes.values())
      for (const m of list) {
        m.updateMatrixWorld(true)
        // A geometry a model shares between meshes is baked once per mesh.
        m.geometry = m.geometry.clone()
        m.geometry.applyMatrix4(new T.Matrix4().multiplyMatrices(up, m.matrixWorld))
        m.geometry.computeBoundingBox()
        box.union(m.geometry.boundingBox)
      }
    const centre = box.getCenter(new T.Vector3())
    const span = Math.max(1e-6, box.getSize(new T.Vector3()).length() / 2)
    const norm = new T.Matrix4().makeScale(4 / span, 4 / span, 4 / span).multiply(new T.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z))
    const scene = new T.Scene()
    const nudge = { value: new T.Vector2() }
    const seed = [...String(product.title ?? '')].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
    const inked = new Map()
    for (const p of parts) {
      const g = new T.Group()
      g.userData.id = p.id
      const list = []
      for (const m of partMeshes.get(p.id)) {
        m.geometry.applyMatrix4(norm)
        m.position.set(0, 0, 0)
        m.quaternion.identity()
        m.scale.set(1, 1, 1)
        const made = ink.inkMesh(T, m, pal, { seed, nudge })
        g.add(made.node)
        list.push(made)
      }
      const sphere = new T.Box3().setFromObject(g).getBoundingSphere(new T.Sphere())
      // Where a leader lands: points on the part, the one nearest the eye and the middle wins.
      const sample = []
      for (const made of list) {
        const pos = made.geometry.getAttribute('position')
        const step = Math.max(1, Math.floor(pos.count / 300))
        for (let i = 0; i < pos.count; i += step) sample.push(new T.Vector3().fromBufferAttribute(pos, i))
      }
      scene.add(g)
      groups.set(p.id, { g, list, sphere, sample, offset: new T.Vector3(), from: new T.Vector3(), to: new T.Vector3() })
      inked.set(p.id, list)
    }
    for (const id of loaded.keys()) loaded.get(id).traverse((o) => o.isMesh && o !== null && o.geometry?.dispose?.())
    scene.traverse((o) => [o.material].flat().forEach((m) => m && m.userData.base != null && (m.userData.base0 = m.userData.base)))

    const view = asset.front === '-y' || asset.up === 'z' ? { az: 0, el: 0.12, turn: 0 } : { az: 0.6, el: 0.32, turn: 0 }
    const camera = new T.PerspectiveCamera(30, 16 / 9, 0.05, 500)
    const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' })
    renderer.localClippingEnabled = true
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2))
    loading.remove()
    node.prepend(renderer.domElement)
    const hand = { az: 0, el: 0, zoom: 1 }
    let w = 1
    let h = 1
    let glide = null
    let target = null
    let moving = { at: 0 }
    let told = false
    const eyeDir = () => new T.Vector3(Math.sin(view.az + hand.az) * Math.cos(view.el + hand.el), Math.sin(view.el + hand.el), Math.cos(view.az + hand.az) * Math.cos(view.el + hand.el))
    /** Outer layers lift toward the eye and aside, a set's radius apart per layer. */
    function aim() {
      const e = eyeDir()
      const right = new T.Vector3(0, 1, 0).cross(e).normalize()
      const dir = right.multiplyScalar(0.85).add(new T.Vector3(0, 0.2, 0)).add(e.clone().multiplyScalar(0.35)).normalize()
      const layers = product.layers?.length ? product.layers : [parts.map((p) => p.id)]
      const now = performance.now()
      for (const [id, gr] of groups) {
        const i = layers.findIndex((l) => l.includes(id))
        gr.from.copy(gr.g.position)
        gr.to.copy(i >= 0 && i < level ? dir.clone().multiplyScalar((level - i) * 3.2) : new T.Vector3())
      }
      moving = { at: now }
      const nodes = [...groups.entries()].map(([id, gr]) => ({ id, x: gr.sphere.center.x + gr.to.x, y: gr.sphere.center.y + gr.to.y, z: gr.sphere.center.z + gr.to.z, r: gr.sphere.radius }))
      target = cam.frameFor(nodes.filter((n) => hot.has(n.id)), nodes, { ...view, az: view.az + hand.az, el: view.el + hand.el })
      if (!glide || reduced) glide = { ...target, center: [...target.center] }
      for (const [id, gr] of groups) {
        const a = hot.size === 0 || hot.has(id) ? 1 : DIM
        gr.g.traverse((o) => [o.material].flat().forEach((m) => m && m.userData.base0 != null && (m.userData.aim = m.userData.base0 * a)))
        gr.heat = hot.has(id) ? 1 : 0
      }
      told = false
      kick()
    }
    let running = false
    let lastEye = null
    function frame(now) {
      const k = reduced ? 1 : ease((now - moving.at) / MOVE_MS)
      for (const gr of groups.values()) gr.g.position.lerpVectors(gr.from, gr.to, k)
      const pull = reduced ? 1 : 0.12
      glide.center = glide.center.map((v, i) => v + (target.center[i] - v) * pull)
      for (const key of ['radius', 'rx', 'ry', 'rz']) glide[key] += (target[key] - glide[key]) * pull
      const m = labelsMod.marginsFor(labelSizes(), { w, h }, false)
      const inner = { x0: m.x, y0: m.y, x1: w - m.x, y1: h - m.y }
      const eye = cam.eyeFor(glide, { ...view, az: view.az + hand.az, el: view.el + hand.el, fov: 30 }, 0, w / h, [(inner.x1 - inner.x0) / w, (inner.y1 - inner.y0) / h])
      camera.position.set(...eye.map((v, i) => glide.center[i] + (v - glide.center[i]) * hand.zoom))
      camera.lookAt(...glide.center)
      camera.updateMatrixWorld()
      // The lifted layers are sectioned by a plane through their middle, facing the eye: their near half goes, the cut face hatched.
      const e = eyeDir()
      for (const gr of groups.values()) {
        const lifted = gr.to.lengthSq() > 1e-6
        if (lifted) {
          const c = gr.sphere.center.clone().add(gr.g.position)
          const plane = (gr.plane ??= new T.Plane())
          plane.setFromNormalAndCoplanarPoint(e.clone().negate(), c)
          if (!gr.cut) for (const made of gr.list) made.clip([plane])
          gr.cut = true
        } else if (gr.cut) {
          for (const made of gr.list) made.clip(null)
          gr.cut = false
        }
        for (const made of gr.list) made.update(camera)
        gr.g.traverse((o) =>
          [o.material].flat().forEach((mat) => {
            if (!mat || mat.userData.aim == null) return
            mat.opacity += (mat.userData.aim - mat.opacity) * (reduced ? 1 : 0.2)
            if (mat.userData.edge) mat.color.lerpColors(pal.ink, pal.ochre, gr.heat ?? 0)
          }),
        )
      }
      renderer.getDrawingBufferSize(nudge.value)
      nudge.value.set(2 / nudge.value.x, -2 / nudge.value.y)
      renderer.setScissorTest(true)
      renderer.setScissor(inner.x0, h - inner.y1, inner.x1 - inner.x0, inner.y1 - inner.y0)
      renderer.render(scene, camera)
      placeLabels(inner)
      const rest = k >= 1 && Math.hypot(...glide.center.map((v, i) => v - target.center[i])) < 0.01 * target.radius && Math.abs(glide.radius - target.radius) < 0.01 * target.radius
      if (rest && !told) {
        told = true
        onSettled?.()
        node.dispatchEvent(new CustomEvent('nodus:settled', { bubbles: true }))
      }
      const eyeNow = camera.position.toArray().join()
      const still = rest && eyeNow === lastEye
      lastEye = eyeNow
      return !still
    }
    const v = new T.Vector3()
    function placeLabels(inner) {
      const anchors = {}
      const discs = []
      const toScreen = (p) => (v.copy(p).project(camera), [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h, v.z])
      for (const [id, gr] of groups) {
        const c = toScreen(gr.sphere.center.clone().add(gr.g.position))
        // The sample point nearest the middle on screen, nearer the eye on a tie: the leader lands on the part, not in it.
        let best = null
        for (const s of gr.sample) {
          const q = toScreen(s.clone().add(gr.g.position))
          const d = Math.hypot(q[0] - c[0], q[1] - c[1]) + q[2] * 40
          if (!best || d < best.d) best = { d, q }
        }
        const at = best?.q ?? c
        if (at[2] > 1 || at[0] < inner.x0 || at[0] > inner.x1 || at[1] < inner.y0 || at[1] > inner.y1) continue
        anchors[id] = [at[0], at[1]]
        const r = (gr.sphere.radius * h) / (2 * Math.max(0.01, camera.position.distanceTo(gr.sphere.center)) * Math.tan((camera.fov * Math.PI) / 360))
        discs.push({ x: c[0], y: c[1], r: Math.min(r, w) })
      }
      lay(anchors, inner, w, h, hot, labelsMod.marginLabels, discs)
    }
    function loop(now) {
      if (state.disposed) return void (running = false)
      if (frame(now)) requestAnimationFrame(loop)
      else running = false
    }
    function kick() {
      if (state.disposed || !glide) return
      if (!running) {
        running = true
        requestAnimationFrame(loop)
      }
    }
    const resize = () => {
      w = Math.max(1, node.clientWidth)
      h = Math.max(1, node.clientHeight)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, false)
      kick()
    }
    const sizes = new ResizeObserver(resize)
    sizes.observe(node)
    resize()
    const onTheme = () => {
      const fresh = kitMod.readPalette(T)
      Object.assign(pal, fresh)
      kitMod.retheme(scene, pal)
      kick()
    }
    const themes = new MutationObserver(onTheme)
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    // The hand: drag turns the set, the wheel zooms it, a double click is the whole figure again.
    let press = null
    node.addEventListener('pointerdown', (ev) => {
      if (!(ev.target instanceof HTMLCanvasElement)) return
      press = { x: ev.clientX, y: ev.clientY }
      node.setPointerCapture?.(ev.pointerId)
    })
    node.addEventListener('pointermove', (ev) => {
      if (!press) return
      hand.az -= (ev.clientX - press.x) * 0.008
      hand.el = Math.min(1.3, Math.max(-0.6, hand.el + (ev.clientY - press.y) * 0.006))
      press = { x: ev.clientX, y: ev.clientY }
      node.dispatchEvent(new CustomEvent('nodus:hold', { bubbles: true }))
      aim()
    })
    node.addEventListener('pointerup', () => (press = null))
    node.addEventListener(
      'wheel',
      (ev) => {
        if (!(ev.target instanceof HTMLCanvasElement) || ev.metaKey) return
        ev.preventDefault()
        hand.zoom = Math.min(3, Math.max(0.35, hand.zoom * Math.exp(ev.deltaY * 0.0015)))
        kick()
      },
      { passive: false },
    )
    node.addEventListener('dblclick', () => {
      hand.az = 0
      hand.el = 0
      hand.zoom = 1
      node.dispatchEvent(new CustomEvent('nodus:home', { bubbles: true }))
      aim()
    })

    api = {
      aim,
      snapshot(maxW = 1280) {
        const k = frameScale(w, h, maxW)
        if (k == null) return null
        const c = document.createElement('canvas')
        c.width = Math.round(w * k)
        c.height = Math.round(h * k)
        const g = c.getContext('2d')
        const tones = tonesNow()
        g.fillStyle = tones.page
        g.fillRect(0, 0, c.width, c.height)
        g.drawImage(renderer.domElement, 0, 0, c.width, c.height)
        burn(g, k, hot, tones)
        return c.toDataURL('image/jpeg', 0.85)
      },
      dispose() {
        sizes.disconnect()
        themes.disconnect()
        scene.traverse((o) => {
          o.geometry?.dispose?.()
          for (const m of [o.material].flat()) m?.dispose?.()
        })
        renderer.dispose()
        renderer.forceContextLoss()
      },
      camera: () => ({ az: hand.az, el: hand.el, zoom: hand.zoom, level, hot: [...hot], parts: [...groups.keys()], inked: [...inked].map(([id, l]) => ({ id, meshes: l.length, triangles: l.reduce((s, x) => s + x.triangles, 0), angle: l[0]?.angle })) }),
    }
    node.camera = api.camera
    aim()
  })()
  ready.catch((error) => {
    loading.textContent = 'The model could not be drawn'
    console.warn('[nodus] atlas', error)
    onSettled?.({ error: String(error?.message ?? error) })
  })
  return {
    node,
    ready,
    focus(ids, sentenceText) {
      const list = ids instanceof Set ? [...ids] : ids?.length ? ids : named(parts, sentenceText)
      hot = new Set(list)
      node.classList.toggle('nd-has-focus', hot.size > 0)
      api?.aim()
    },
    explode(n) {
      level = Math.max(0, Math.min(Number(n) || 0, Math.max(0, (product.layers?.length ?? 1) - 1)))
      node.dataset.apart = String(level)
      api?.aim()
    },
    snapshot: (maxW) => api?.snapshot(maxW) ?? null,
    update(fresh) {
      product = fresh
    },
    dispose() {
      state.disposed = true
      api?.dispose()
    },
  }
}
