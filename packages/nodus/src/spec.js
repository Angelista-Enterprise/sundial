// The Nodus spec: the one typed shape every visual is, between the model that
// fills it and the renderer that draws it.
//
// A model may choose what to show and say; it may not choose a colour, a size
// or a position. Those come from a part's role and mark, in the renderer, so a
// weak storyboard still draws well and a good one draws the same way twice.
//
// Plain data, no DOM: the plugin (node) and the card (browser) both import it.

// timeline: things in time (a day). bars: how much of each, with `then` beside it
// for a comparison. graph: who and what connect. table: rows to read. scene: a
// set built from parts by an archetype's solver (lanes are its parts, links its
// joints), for a subject that is spatial. stages: a sequence read top to bottom
// (phases, eras, steps of an argument), each with a note and a few tags.
import { checkForm, PORTS } from './blocks.js'

export const FORMS = ['timeline', 'bars', 'graph', 'table', 'scene', 'stages']
export const ROLES = ['project', 'session', 'meeting', 'break', 'person', 'commitment', 'goal', 'marker', 'day', 'purpose']
// The redesign's uncertainty grammar: how a value was known, which is what colours it.
export const MARKS = ['observed', 'derived', 'inferred', 'absent', 'verified']
export const MAX_STEPS = 7
export const MAX_SCENE_LANES = 24
const MAX_SCENE_LINKS = 48

/**
 * A scene's vocabulary, shared by the prompt and the checker. An archetype
 * names the solver that places the parts; a kind names the part that draws
 * them; `value` means one thing per archetype (a gear's teeth, a body's mass).
 * The first kind is what an unknown kind is drawn as.
 */
export const ARCHETYPES = {
  // One thing and its parts, as an anatomy plate: every part stands on another at a named port (blocks.js), pulled apart to show how it is built.
  object: { kinds: ['part'], states: ['on', 'off', 'moving', 'still', 'hot', 'cold', 'lit', 'dark'], links: ['joins'], value: 'size' },
  system: { kinds: ['sphere', 'sun', 'light', 'cloud', 'rain', 'droplet', 'rainbow', 'ray', 'plane', 'ground', 'observer', 'prism', 'orbit', 'box', 'cylinder', 'cone', 'torus', 'arrow', 'field', 'contour', 'stack'], states: ['lit', 'dark', 'hot', 'cold', 'wet', 'moving', 'still'], links: ['cause', 'ray', 'touch'], value: 'size' },
  fluid: { kinds: ['tank', 'source', 'sink', 'pump', 'valve', 'reservoir'], states: ['full', 'empty', 'hot', 'cold', 'liquid', 'gas'], links: ['flow', 'return'], value: 'volume' },
  mechanism: { kinds: ['gear', 'shaft', 'belt', 'crank', 'lever', 'piston'], states: ['spinning', 'locked', 'driving'], links: ['mesh', 'belt', 'push'], value: 'teeth' },
  orbital: { kinds: ['body', 'center', 'moon', 'ring'], states: ['lit', 'dark', 'near', 'far'], links: ['orbit', 'tie'], value: 'mass' },
  // Time round a dial (a day of 24 hours, or a week of 168): events are arcs from `start` to `end`, in hours.
  clock: { kinds: ['event', 'dial', 'marker', 'hand'], states: ['done', 'now', 'next', 'missed'], links: ['next', 'clash'], value: 'hours' },
  // A way through places, seen from above: stops in order, at `lat`/`lon` when known, else `value` km from the stop before.
  route: { kinds: ['stop', 'start', 'end', 'turn'], states: ['done', 'now', 'next', 'late'], links: ['leg'], value: 'km' },
  // A floor plan: rooms packed by area, devices marked inside the room an `in` link names.
  plan: { kinds: ['room', 'device'], states: ['on', 'off', 'open', 'closed', 'alert'], links: ['in', 'adjacent'], value: 'area' },
}
/** What a `field` (a point cloud) or a `contour` (stacked level lines) is shaped as. */
export const SHAPES = { field: ['tree', 'cloud', 'crowd', 'forest'], contour: ['hill', 'island', 'valley'], dial: ['day', 'week'] }
const PANEL_KINDS = ['spark', 'number', 'status']
const MAX_PANELS = 4
export const MAX_PARTS = 240
/** Words that name a person, for the observer check. */
const PERSON = /\b(you|me|i|we|they|person|people|user|viewer|reader|rider|cyclist|driver|owner|customer|guest|child|man|woman|eye|eyes|friend|team|audience|listener|caller|player|worker|human|them|someone|everyone|crowd)\b/i
const MAX_SAY = 240

/** A door opens a card the explore layer resolves: a moment, an entity, a day, or a search. */
const DOOR = /^(moment:[0-9A-Z]{10,40}|entity:[^\n]{1,120}|day:\d{4}-\d{2}-\d{2}|search:[^\n]{1,120})$/
const door = (v) => (typeof v === 'string' && DOOR.test(v) ? v : null)
const num = (v) => (Number.isFinite(v) ? v : undefined)

const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null)
/** The house style has no em dash: every text a card shows says a comma instead (a model writes them anyway). */
export const undash = (v) => String(v ?? '').replace(/\s*\u2014\s*/g, ', ')
const text = (v, n) => (typeof v === 'string' && v.trim() !== '' ? undash(v.trim()).slice(0, n) : null)

/** Lower-case words of three letters or more, minus the glue; how a sentence names a part. */
const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'into', 'then', 'than', 'your', 'you', 'each', 'when', 'what', 'they', 'them', 'have', 'more', 'part', 'parts', 'was', 'were', 'for', 'are', 'its', 'one'])
export const words = (s) => String(s ?? '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu)?.filter((w) => !STOP.has(w)) ?? []

/** Does `say` name `label`? A shared word, or one a prefix of the other (meeting, meetings). */
export function names(say, label) {
  const said = words(say)
  // A label of glue words alone ("You", a scene's center) is named by saying it.
  if (words(label).length === 0) return String(label ?? '').trim() !== '' && new RegExp(`\\b${String(label ?? '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(say ?? ''))
  return words(label).some((w) => said.some((x) => x === w || (x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x)))))
}

/**
 * Sentences Gnomon may not say on a card: the assistant persona, talk about
 * the picture instead of the day, and the em dash the house style forbids.
 */
export function voiceProblem(say) {
  // A name with the word in it (a thread called home-assistant) is a name, not the persona.
  if (/(?<![\w-])assistant(?![\w-])|\bas an ai\b/i.test(say)) return 'speaks as an assistant'
  if (/\b(this|the) (visual|visualization|chart|figure|diagram|card)\b|\blanes?\b|\b(the|this|that|these|two|three|one|a) (parts?|entry|entries|bars?)\b/i.test(say)) return 'talks about the picture instead of the day (no "lane", "part", "bar" or "entry": name the thing itself)'
  return null
}

/**
 * Check a spec and return the one a renderer may draw.
 *
 * Lenient on purpose where a fix is obvious (times clipped to the window, an
 * em dash turned into a comma, a part with no lane dropped) and strict where it
 * is not (a step pointing at nothing). `problems` are worded for a model to
 * act on, because a repair round reads them.
 */
export function checkSpec(input) {
  const problems = []
  if (!input || typeof input !== 'object') return { ok: false, spec: null, problems: ['the spec is not an object'] }
  if (input.v !== 1) problems.push('v must be 1')
  const form = FORMS.includes(input.form) ? input.form : null
  if (!form) problems.push(`form must be one of ${FORMS.join(', ')}`)
  const title = text(input.title, 120)
  if (!title) problems.push('title is required')
  // Only a timeline is drawn on time; the other forms may carry a window to say what they cover.
  const from = iso(input.window?.from)
  const to = iso(input.window?.to)
  if (form === 'timeline' && (!from || !to || from >= to)) problems.push('window needs from < to, both ISO instants')

  const lanes = []
  const laneIds = new Set()
  for (const l of Array.isArray(input.lanes) ? input.lanes : []) {
    const id = text(l?.id, 80)
    if (!id || laneIds.has(id)) continue
    if (form === 'scene' && lanes.length === MAX_SCENE_LANES) {
      problems.push(`a scene holds at most ${MAX_SCENE_LANES} parts; the rest were dropped`)
      break
    }
    laneIds.add(id)
    const cells = Array.isArray(l.cells) ? l.cells.slice(0, 4).map((c) => text(String(c ?? ''), 60) ?? '') : null
    const extra = { value: num(l.value), then: num(l.then), unit: text(l.unit, 12) ?? undefined, note: text(l.note, 160) ?? undefined, door: door(l.door) ?? undefined, cells: cells ?? undefined }
    if (form === 'scene') Object.assign(extra, { kind: text(l.kind, 20) ?? undefined, state: text(l.state, 20) ?? undefined, shape: text(l.shape, 20) ?? undefined, mark: MARKS.includes(l.mark) ? l.mark : undefined, start: num(l.start), end: num(l.end), lat: num(l.lat), lon: num(l.lon), on: text(l.on, 80) ?? undefined, at: PORTS[l.at] ? l.at : undefined, form: l.form && typeof l.form === 'object' ? checkForm(l.form, problems, `${id}.form`) ?? undefined : undefined, sketch: sketchOf(l.sketch, problems, id), picture: text(l.picture, 140) ?? undefined, pin: Array.isArray(l.pin) && l.pin.length === 2 && l.pin.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ? l.pin : undefined, image: typeof l.image === 'string' && /^\/[\w./-]{1,200}$/.test(l.image) ? l.image : undefined, mesh: typeof l.mesh === 'string' && /^\/[\w./-]{1,200}$/.test(l.mesh) ? l.mesh : undefined })
    lanes.push({ id, label: text(l.label, 60) ?? id, role: ROLES.includes(l.role) ? l.role : 'marker', ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)) })
  }
  if (lanes.length === 0) problems.push('at least one lane is required')
  let links = (Array.isArray(input.links) ? input.links : []).filter((k) => laneIds.has(k?.from) && laneIds.has(k?.to)).slice(0, 400).map((k) => ({ from: k.from, to: k.to }))
  const archetype = form === 'scene' ? (ARCHETYPES[input.archetype] ? input.archetype : (problems.push(`archetype must be one of ${Object.keys(ARCHETYPES).join(', ')}; drawn as system`), 'system')) : undefined
  if (archetype) links = checkScene(archetype, lanes, input, problems)

  const parts = []
  const partIds = new Set()
  for (const p of (Array.isArray(input.parts) ? input.parts : []).slice(0, MAX_PARTS)) {
    const id = text(p?.id, 80)
    if (!id || partIds.has(id) || laneIds.has(id) || !laneIds.has(p.lane) || !ROLES.includes(p.role)) continue
    let a = iso(p.from)
    let b = iso(p.to) ?? a
    if (!a || (from && b < from) || (to && a > to)) continue
    if (from && a < from) a = from
    if (to && b > to) b = to
    partIds.add(id)
    const d = door(p.door)
    parts.push({ id, role: p.role, lane: p.lane, from: a, to: b, label: text(p.label, 80) ?? '', ...(text(p.note, 160) ? { note: text(p.note, 160) } : {}), mark: MARKS.includes(p.mark) ? p.mark : 'observed', ...(d ? { door: d } : {}) })
  }

  const known = new Set([...laneIds, ...partIds])
  const labelOf = new Map([...lanes, ...parts].map((x) => [x.id, x.label]))
  const steps = []
  for (const [i, s] of (Array.isArray(input.steps) ? input.steps : []).slice(0, MAX_STEPS).entries()) {
    const say = text(String(s?.say ?? '').replace(/\s*[\u2014\u2013]\s*/g, ', '), MAX_SAY)
    const focus = (Array.isArray(s?.focus) ? s.focus : []).map(String).filter((id) => known.has(id))
    if (!say) {
      problems.push(`step ${i + 1} has nothing to say`)
      continue
    }
    const voice = voiceProblem(say)
    if (voice) problems.push(`step ${i + 1} ${voice}`)
    if (focus.length === 0) problems.push(`step ${i + 1} focuses no known part or lane`)
    else if (!focus.some((id) => names(say, labelOf.get(id)))) problems.push(`step ${i + 1} does not name what it focuses (say one of: ${focus.map((id) => labelOf.get(id)).slice(0, 3).join(', ')})`)
    // A scene's step may pull its parts apart so the inside shows (stage.js); the next step closes them.
    steps.push({ focus, say, ...(form === 'scene' && s.explode === true ? { explode: true } : {}) })
  }
  if (steps.length === 0) problems.push('at least one step is required')

  const spec = {
    v: 1,
    form,
    title,
    headline: text(input.headline, 90) ?? '',
    ask: text(input.ask, 200) ?? '',
    tz: text(input.tz, 60) ?? 'UTC',
    view: text(input.view, 20) ?? sourceOf(input.source)?.view ?? null,
    window: { from, to },
    source: sourceOf(input.source),
    lanes,
    parts,
    ...(archetype ? { archetype, ...(Number.isFinite(input.seed) ? { seed: input.seed >>> 0 } : {}), ...(input.exploded === true ? { exploded: true } : {}) } : {}),
    // A whole picture behind the plate (a rendered or generated plate): the stage shows it in place of its own parts, labels at their pins.
    ...(typeof input.backdrop === 'string' && /^\/[\w./-]{1,200}$/.test(input.backdrop) ? { backdrop: input.backdrop } : {}),
    // Whether the subject is a physical thing (pictures are drawn only for one); absent when the blueprint did not say.
    ...(typeof input.concrete === 'boolean' ? { concrete: input.concrete } : {}),
    links,
    columns: Array.isArray(input.columns) ? input.columns.slice(0, 5).map((c) => text(String(c ?? ''), 30) ?? '') : [],
    steps,
    // The binder's numbers and names the walk and the legend speak from (a compare's two days), primitives only.
    facts: Object.fromEntries(Object.entries(input.facts && typeof input.facts === 'object' ? input.facts : {}).filter(([, v]) => ['string', 'number'].includes(typeof v)).slice(0, 12)),
    panels: panelsOf(input.panels),
    by: input.by && typeof input.by === 'object' ? input.by : {},
  }
  return { ok: problems.length === 0, spec, problems }
}

/**
 * A part drawn by hand: up to 16 polylines, each a flat list of x, y pairs in
 * a 0 to 100 box (y down), at most 80 points a line. The engine draws them as
 * the part, in the house's hairline; the model never sets a colour or a width.
 */
const MAX_SKETCH_LINES = 16
function sketchOf(input, problems, id) {
  if (!Array.isArray(input)) return undefined
  const lines = input.slice(0, MAX_SKETCH_LINES).map((l) => (Array.isArray(l) ? l.filter(Number.isFinite).slice(0, 160).map((v) => Math.min(100, Math.max(0, Math.round(v * 10) / 10))) : [])).map((l) => l.slice(0, l.length - (l.length % 2))).filter((l) => l.length >= 4)
  if (input.length > MAX_SKETCH_LINES) problems.push(`${id}.sketch: at most ${MAX_SKETCH_LINES} lines; the rest were dropped`)
  return lines.length ? lines : undefined
}

/**
 * The small panels docked under a figure (card.js), at most four: a sparkline
 * of a series, a number with its unit, or a status word, each with a label
 * and an optional note. Numbers only from the binder; nothing here is drawn
 * by position.
 */
function panelsOf(input) {
  const out = []
  for (const p of Array.isArray(input) ? input : []) {
    const label = text(p?.label, 32)
    if (!label || !PANEL_KINDS.includes(p.kind) || out.length === MAX_PANELS) continue
    const series = Array.isArray(p.series) ? p.series.slice(0, 60).map((v) => (Number.isFinite(v) ? v : 0)) : null
    if (p.kind === 'spark' && !(series?.length >= 2)) continue
    if (p.kind === 'number' && !Number.isFinite(p.value)) continue
    if (p.kind === 'status' && !text(p.word, 40)) continue
    out.push({ label, kind: p.kind, ...(p.kind === 'spark' ? { series } : {}), ...(Number.isFinite(p.value) ? { value: p.value } : {}), ...(text(p.unit, 12) ? { unit: text(p.unit, 12) } : {}), ...(text(p.word, 40) ? { word: text(p.word, 40) } : {}), ...(text(p.note, 60) ? { note: text(p.note, 60) } : {}) })
  }
  return out
}

/**
 * A scene's own rules, per archetype: coerce what can be coerced (an unknown
 * kind, a gear with too many teeth) and drop what cannot be drawn (a mesh that
 * would lock the train), saying each in words a model can act on. Mutates the
 * lanes in place and returns the scene's links.
 */
function checkScene(archetype, lanes, input, problems) {
  const A = ARCHETYPES[archetype]
  const free = !sourceOf(input.source)
  for (const l of lanes) {
    if (!A.kinds.includes(l.kind)) {
      problems.push(`${l.id}: kind ${l.kind ? `"${l.kind}" ` : ''}is not a ${archetype} kind (${A.kinds.join(', ')}); drawn as ${A.kinds[0]}`)
      l.kind = A.kinds[0]
    }
    if (l.shape !== undefined && !SHAPES[l.kind]?.includes(l.shape)) {
      if (SHAPES[l.kind]) problems.push(`${l.id}: shape "${l.shape}" is not one of ${SHAPES[l.kind].join(', ')}`)
      delete l.shape
    }
    if (l.state !== undefined && !A.states.includes(l.state)) {
      problems.push(`${l.id}: state "${l.state}" is not one of ${A.states.join(', ')}`)
      delete l.state
    }
    // A free scene is not bound to the record, so it may only search it.
    if (free && l.door && !l.door.startsWith('search:')) {
      problems.push(`${l.id}: a scene not read from the record may only carry a search: door`)
      delete l.door
    }
  }
  const byId = new Map(lanes.map((l) => [l.id, l]))
  let links = []
  for (const k of Array.isArray(input.links) ? input.links : []) {
    if (!byId.has(k?.from) || !byId.has(k?.to) || k.from === k.to) continue
    const kind = A.links.includes(k.kind) ? k.kind : A.links[0]
    if (k.kind !== undefined && kind !== k.kind) problems.push(`${k.from} to ${k.to}: link kind "${k.kind}" is not one of ${A.links.join(', ')}; drawn as ${kind}`)
    const rate = num(k.rate)
    const label = text(k.label, 40)
    links.push({ from: k.from, to: k.to, kind, ...(rate !== undefined ? { rate } : {}), ...(label ? { label } : {}) })
  }
  if (links.length > MAX_SCENE_LINKS) {
    problems.push(`a scene holds at most ${MAX_SCENE_LINKS} links; the rest were dropped`)
    links = links.slice(0, MAX_SCENE_LINKS)
  }
  const ofKind = (kind) => lanes.filter((l) => l.kind === kind)

  if (archetype === 'mechanism') {
    // Teeth given as a ratio (a small model writes 1 and 3 for a chainring three times the cog): scaled so the biggest has 48.
    const given = ofKind('gear').map((l) => l.value).filter((v) => Number.isFinite(v) && v > 0)
    if (given.length && Math.max(...given) < 6) for (const l of ofKind('gear')) if (l.value > 0) l.value = Math.round((l.value * 48) / Math.max(...given))
    for (const l of ofKind('gear')) {
      const teeth = Math.round(l.value ?? 12)
      const kept = Math.min(120, Math.max(6, teeth))
      if (l.value !== undefined && kept !== l.value) problems.push(`${l.id}: a gear has 6 to 120 teeth; drawn with ${kept}`)
      l.value = kept
    }
    // Meshed gears turn opposite ways, so an odd ring of them cannot turn at
    // all. Two-colour the mesh graph as links arrive; a link joining two gears
    // of one colour in one train would lock it, and is dropped.
    const parent = new Map()
    const find = (id) => {
      let p = id
      let parity = 0
      while (parent.has(p)) {
        parity ^= parent.get(p)[1]
        p = parent.get(p)[0]
      }
      return [p, parity]
    }
    links = links.filter((k) => {
      if (k.kind !== 'mesh') return true
      if (byId.get(k.from).kind !== 'gear' || byId.get(k.to).kind !== 'gear') {
        problems.push(`${k.from} to ${k.to}: only a gear meshes with a gear; dropped (use push or belt)`)
        return false
      }
      const [ra, pa] = find(k.from)
      const [rb, pb] = find(k.to)
      if (ra !== rb) {
        parent.set(ra, [rb, pa ^ pb ^ 1])
        return true
      }
      if (pa === pb) {
        problems.push(`${k.from} to ${k.to}: this mesh closes an odd ring of gears, which would lock; dropped`)
        return false
      }
      return true
    })
  }

  if (archetype === 'fluid') {
    if (ofKind('source').length === 0) {
      problems.push(`a fluid scene needs at least one source; ${lanes[0]?.id} drawn as one`)
      if (lanes[0]) lanes[0].kind = 'source'
    }
    for (const k of links) {
      if (k.rate === undefined || k.rate > 0) continue
      problems.push(`${k.from} to ${k.to}: a flow rate is above 0; drawn as 1`)
      k.rate = 1
    }
  }

  if (archetype === 'orbital') {
    const centers = ofKind('center')
    if (centers.length !== 1) {
      const pool = centers.length ? centers : lanes
      const heaviest = pool.reduce((a, b) => ((b.value ?? 0) > (a.value ?? 0) ? b : a), pool[0])
      problems.push(`an orbital scene has exactly one center; ${heaviest?.id} (the heaviest) is the one`)
      for (const c of centers) c.kind = 'body'
      if (heaviest) heaviest.kind = 'center'
    }
    // An orbit link reads "from orbits to": turned around when it names the inner thing first.
    const RANK = { center: 0, body: 1, moon: 2, ring: 2 }
    for (const k of links) if (k.kind === 'orbit' && RANK[byId.get(k.from).kind] < RANK[byId.get(k.to).kind]) [k.from, k.to] = [k.to, k.from]
    const center = ofKind('center')[0]
    const bodies = ofKind('body')
    for (const l of lanes) {
      if (l === center || links.some((k) => k.kind === 'orbit' && k.from === l.id)) continue
      const around = l.kind === 'body' || bodies.length === 0 ? center : bodies.reduce((a, b) => ((b.value ?? 0) > (a.value ?? 0) ? b : a), bodies[0])
      problems.push(`${l.id}: every ${l.kind} needs an orbit link; it orbits ${around.id}`)
      links.push({ from: l.id, to: around.id, kind: 'orbit' })
    }
  }

  if (archetype === 'clock') {
    // One dial; its shape sets the span. An event is an arc of hours on it; one that runs past the span's end wraps.
    const dial = ofKind('dial')[0]
    for (const l of ofKind('dial').slice(1)) {
      problems.push(`${l.id}: a clock has one dial; drawn as a marker`)
      l.kind = 'marker'
    }
    const span = dial?.shape === 'week' ? 168 : 24
    for (const l of lanes.filter((x) => x.kind !== 'dial')) {
      if (l.start === undefined || l.start < 0 || l.start >= span) {
        problems.push(`${l.id}: start is the hour it begins, 0 to ${span}; drawn at 0`)
        l.start = 0
      }
      if (l.kind === 'event' && (l.end === undefined || l.end === l.start)) {
        problems.push(`${l.id}: an event needs an end hour after its start; drawn an hour long`)
        l.end = l.start + 1
      }
      if (l.end !== undefined && l.end < l.start) l.end += span
    }
  }

  if (archetype === 'route') {
    for (const l of lanes) {
      if ((l.lat === undefined) !== (l.lon === undefined)) {
        problems.push(`${l.id}: give lat and lon together, or neither`)
        delete l.lat
        delete l.lon
      }
    }
    for (const kind of ['start', 'end']) {
      for (const l of ofKind(kind).slice(1)) {
        problems.push(`${l.id}: a route has one ${kind}; drawn as a stop`)
        l.kind = 'stop'
      }
    }
  }

  if (archetype === 'plan') {
    const rooms = ofKind('room')
    if (rooms.length === 0) {
      problems.push(`a plan needs at least one room; ${lanes[0]?.id} drawn as one`)
      if (lanes[0]) lanes[0].kind = 'room'
    }
    for (const l of ofKind('room')) if (!(l.value > 0)) l.value = 10
    // A device stands in one room: an `in` link to it (from the device to the room), else the first room.
    links = links.filter((k) => k.kind !== 'in' || (byId.get(k.from).kind === 'device' && byId.get(k.to).kind === 'room') || (problems.push(`${k.from} to ${k.to}: in runs from a device to a room; dropped`), false))
    for (const d of ofKind('device')) {
      if (links.some((k) => k.kind === 'in' && k.from === d.id)) continue
      const room = ofKind('room')[0]
      problems.push(`${d.id}: a device needs an in link to its room; put in ${room.id}`)
      links.push({ from: d.id, to: room.id, kind: 'in' })
    }
  }

  // A part may stand on another (any archetype): the one it names must be there, and the chain may not loop.
  for (const l of lanes) {
    if (l.on === undefined) continue
    let p = byId.get(l.on)
    const seen = new Set([l.id])
    while (p && !seen.has(p.id)) (seen.add(p.id), (p = p.on !== undefined ? byId.get(p.on) : null))
    if (!byId.has(l.on) || p) {
      problems.push(`${l.id}: on "${l.on}" ${byId.has(l.on) ? 'loops back to itself' : 'is not a part'}; stands alone`)
      delete l.on
      delete l.at
    } else l.at ??= 'top'
  }

  if (archetype === 'object' && lanes.length && !lanes.some((l) => l.on === undefined)) {
    problems.push(`an object needs one part that stands on nothing (the body); ${lanes[0].id} is the body`)
    delete lanes[0].on
  }

  if (archetype === 'system') {
    // An observer is a person: one whose label names no one (a camera, a sensor) is a device, drawn as a box.
    for (const l of ofKind('observer')) {
      if (PERSON.test(l.label)) continue
      problems.push(`${l.id}: an observer is a person and "${l.label}" is not one; drawn as a box`)
      l.kind = 'box'
    }
    for (const kind of ['sun', 'ground']) {
      for (const l of ofKind(kind).slice(1)) {
        problems.push(`${l.id}: a system scene has at most one ${kind}; drawn as a sphere`)
        l.kind = 'sphere'
      }
    }
  }
  return links
}

/**
 * The binding a figure re-reads: a view (views.js) and its arguments. A slice-1
 * card named the tool itself (`gnomon_today_summary`), which is the day view.
 */
function sourceOf(source) {
  if (!source || typeof source !== 'object') return null
  const args = source.args && typeof source.args === 'object' ? source.args : {}
  if (typeof source.view === 'string') return { view: source.view, args }
  if (source.tool === 'gnomon_today_summary') return { view: 'day', args }
  return null
}

/** A card's text back into a spec a renderer may draw; null when it is not one. */
export function specOf(cardText) {
  try {
    const out = checkSpec(JSON.parse(cardText ?? ''))
    return out.spec?.form && out.spec.lanes.length > 0 ? out.spec : null
  } catch {
    return null
  }
}
