// The three ways Nodus draws, and Auto, which picks one per ask.
//
//   sketch  today's engine: the record's views and free sets, solved and walked
//   studio  the model writes a scene program for the Stage Runtime (studio.js)
//   atlas   real assets, fetched, cached and re-inked in our style (atlas.js)
//   plate   the model plans and draws the figure as line art; the engine cleans,
//           names and sets it in light 3D (plate.js). Reads the record too.
//
// Every mode is `{ id, label, blurb, when, build(ask, ctx), draw(host, product),
// supports(ask, route), ready() }`. `build` runs where the model is (the
// plugin), `draw` where the page is; both load the mode's module on first use,
// so a mode whose file is not there yet is `ready() === false` and the ladder
// steps past it. A product is what `build` resolved:
//
//   sketch  the manager's out, `{ ok, spec, later? }`; the card's text is the spec itself
//   studio  `{ kind: 'program', code, steps, title }`
//   atlas   `{ kind: 'asset', assets, layers, steps, title }`
//
// and `draw(host, product, { onSettled })` returns `{ node, ready?, focus(ids, say),
// snapshot() → jpeg | Promise<jpeg> | null, dispose() }`; `onSettled({ error })` says the drawing failed.
// A studio or atlas product rides on the card as `wrap()`'s
// `{ v: 1, form: 'scene', mode, product, ... }`, so the shelf, the library,
// the overlay and the catalogue keep reading one shape.
//
// ctx for build: { route, judge, complete, early(product), now, sketch() → the sketch out }.
// Plain data and lazy imports only: the plugin (node) and the card (browser) both load it.

import { VIEWS } from '../views.js'
import { undash } from '../spec.js'

export const MODE_IDS = ['sketch', 'studio', 'atlas', 'plate']
export const CHOICES = ['auto', ...MODE_IDS]
/** When a mode fails or is not there, the next one down. */
const LADDER = ['atlas', 'studio', 'sketch']
// Plate steps straight down to Sketch: a slow model drawing is no fallback for another mode.
export const ladder = (mode) => (mode === 'plate' ? ['plate', 'sketch'] : LADDER.slice(Math.max(0, LADDER.indexOf(mode))))
const MODE_SET = 'nodus.mode.v1'
/** How long a card may say "Building in X" before it says it could not draw this, with Retry. */
export const BUILD_LIMIT_MS = { studio: 120_000, atlas: 60_000, plate: 480_000, sketch: 30_000 }
const TIMEOUT = 8_000

/** A record view is the owner's own data: only Sketch reads the record. */
const fromRecord = (route) => Boolean(route?.view && VIEWS[route.view])
// ponytail: a word list, for when Jev cannot say; the typed choice is the real pick.
const SEEN = /\b(muscles?|bones?|biceps?|triceps?|skeleton|skull|spine|organs?|heart|brain|lungs?|liver|kidneys?|eye|ear|hand|knee|anatomy|tendons?|ligaments?|nerves?|skin|teeth|tooth|statue|sculpture|fossil|specimen|insect|bird|flower|engine block|artifact|artefact|monument|cathedral|temple)\b/i

/** A file beside this one, by a name no bundler resolves ahead: it may not be there yet. */
const beside = (name) => import(/* @vite-ignore */ new URL(name, import.meta.url).href)

/** One mode's module, loaded once; a missing file is "not ready", asked again next time. */
function lazy(load, names) {
  let held = null
  // The contract's names (buildStudio, drawStudio), or a module's plain build and draw.
  const fn = (m, k) => m[names[k]] ?? m[k]
  const get = () => (held ??= load().then((m) => (typeof fn(m, 'build') === 'function' && typeof fn(m, 'draw') === 'function' ? m : Promise.reject(new Error('not ready')))).catch((e) => ((held = null), Promise.reject(e))))
  return {
    ready: () => get().then(() => true, () => false),
    build: async (ask, ctx) => fn(await get(), 'build')(ask, ctx),
    draw: async (host, product, opts) => fn(await get(), 'draw')(host, product, opts),
  }
}

const sketch = {
  id: 'sketch',
  label: 'Sketch',
  blurb: 'Quick, clean drawings. Best for your own days, time, work and people.',
  when: 'Your own record: days, time, threads, people, costs. Fast, and it stays live.',
  supports: () => true,
  ready: async () => true,
  build: (ask, ctx) => ctx.sketch(ask),
  draw: async (host, spec) => {
    const { nodusNode } = await import('../card.js')
    const node = nodusNode(spec)
    host?.replaceChildren?.(node)
    return { node, focus: () => {}, snapshot: () => null, dispose: () => node.remove() }
  },
}
const studio = {
  id: 'studio',
  label: 'Studio',
  blurb: 'Invents an animated scene. Best for how something works.',
  when: 'A concept, a process or a scene to invent: how a heat pump works, why the sky is blue.',
  supports: (_ask, route) => !fromRecord(route),
  ...lazy(() => beside('./studio.js'), { build: 'buildStudio', draw: 'drawStudio' }),
}
const atlas = {
  id: 'atlas',
  label: 'Atlas',
  blurb: 'Real pictures and models. Best for things you need to see in detail, like the body.',
  when: 'A real thing to see in true detail: a muscle and its layers, an object, a place.',
  supports: (_ask, route) => !fromRecord(route),
  ...lazy(() => beside('./atlas.js'), { build: 'buildAtlas', draw: 'drawAtlas' }),
}
const plate = {
  id: 'plate',
  label: 'Plate',
  blurb: 'Drawn by the model as a technical plate, names and steps set by us. For ideas, scenes, machines and your own data.',
  when: 'Anything: a concept, a scene, a mechanism, a chart of the record (its data handed in exact).',
  supports: () => true,
  ...lazy(() => beside('./plate.js'), { build: 'build', draw: 'draw' }),
}
export const MODES = { sketch, studio, atlas, plate }

export const AUTO = { id: 'auto', label: 'Auto', blurb: 'Picks the best way for each question.' }
/** The labels the thread bar shows, in order. */
export const SWITCH = [AUTO, sketch, studio, atlas, plate].map(({ id, label, blurb }) => ({ id, label, blurb }))

/** Jev's one typed choice: which mode serves this ask best. */
export function modeQuestions() {
  return {
    mode: {
      type: 'choice',
      instructions: 'The owner asked `ask` and a picture will answer it. Which way of drawing serves it best?',
      criteria: {
        sketch: "data from the owner's own record: their days, time, projects, threads of work, people, goals or costs",
        atlas: 'a real thing that must be seen in true detail: anatomy (a muscle and its layers, bones, organs), a real object, a place',
        studio: 'a concept, a process or a scene to invent: how something works, flows, moves or changes',
      },
    },
  }
}

/** Without Jev: the record is Sketch, a thing to see is Atlas, the rest of the world Studio. */
export const guessMode = (ask, route = null) => (fromRecord(route) ? 'sketch' : SEEN.test(String(ask ?? '')) ? 'atlas' : route?.view === 'free' ? 'studio' : 'sketch')

const within = (ms, promise) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]).finally(() => clearTimeout(timer))
}

/**
 * Auto: the record is Sketch without asking; an ask about the world is Jev's
 * one typed choice; without a route, or when Jev cannot say, the guess. `{ mode, by: 'record' | 'jev' | 'guess', p? }`.
 */
export async function chooseMode(ask, { route = null, judge = null } = {}) {
  if (fromRecord(route)) return { mode: 'sketch', by: 'record' }
  // Only an ask the route read as about the world is worth the question; no route at all is guessed.
  const answers = judge && route?.view === 'free' ? await within(TIMEOUT, Promise.resolve(judge({ state: { ask: String(ask ?? '').slice(0, 400) }, questions: modeQuestions(), set: MODE_SET }))).catch(() => null) : null
  const v = answers?.mode
  if (MODE_IDS.includes(v?.choice)) return { mode: v.choice, by: 'jev', p: v.confidence ?? v.probabilities?.[v.choice] ?? null }
  return { mode: guessMode(ask, route), by: 'guess' }
}

/** What the owner picked for the thread, as a mode to start the ladder at; a record ask is Sketch whatever was picked. */
export async function pick(choice, ask, ctx = {}) {
  // Plate reads the record itself (its data handed to the model exact); every other mode leaves the record to Sketch.
  if (fromRecord(ctx.route) && choice !== 'plate') return { mode: 'sketch', by: 'record' }
  return MODES[choice] ? { mode: choice, by: 'owner' } : chooseMode(ask, ctx)
}

const isProduct = (p) => p && typeof p === 'object' && (p.kind === 'program' || p.kind === 'asset' || p.kind === 'plate' || p.spec)

/**
 * Build down the ladder from `picked.mode`: a mode that does not take this ask,
 * is not there yet, throws or returns nothing gives way to the next. Resolves
 * `{ ok: true, mode, product, tried, ms }` or `{ ok: false, reason, tried }`.
 */
export async function buildDown(picked, ask, ctx = {}) {
  const now = ctx.now ?? Date.now
  const tried = []
  for (const id of ladder(picked.mode)) {
    const m = MODES[id]
    if (!m.supports(ask, ctx.route)) {
      tried.push({ mode: id, why: 'not for this ask' })
      continue
    }
    if (!(await m.ready())) {
      tried.push({ mode: id, why: 'not ready' })
      continue
    }
    const t = now()
    try {
      const product = await m.build(ask, ctx)
      if (isProduct(product) && product.ok !== false) return { ok: true, mode: id, product, tried, ms: now() - t }
      tried.push({ mode: id, why: product?.reason ?? 'nothing came back' })
    } catch (error) {
      tried.push({ mode: id, why: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok: false, reason: tried.map((t) => `${MODES[t.mode].label}: ${t.why}`).join('; ') || 'nothing could draw this', tried }
}

const stepsOf = (steps) =>
  (Array.isArray(steps) ? steps : [])
    .map((s) => (typeof s === 'string' ? { say: undash(s), focus: [] } : s && typeof s.say === 'string' ? { ...s, say: undash(s.say), focus: Array.isArray(s.focus) ? s.focus : [] } : null))
    .filter(Boolean)
    .slice(0, 7)

/**
 * A studio or atlas product as a card's text: the shared shape plus what the
 * walk, the reader and the shelf need. `pending` while it is being built,
 * `failed` with the reason when nothing could draw it (the card shows words).
 */
export function wrap({ mode, product = null, ask = '', by = {}, pending = false, failed = null }) {
  ask = undash(ask)
  const title = undash(product?.title).trim() || ask.trim().slice(0, 80) || 'A figure'
  return {
    v: 1,
    form: 'scene',
    mode,
    product,
    ask,
    title,
    headline: title,
    steps: stepsOf(product?.steps),
    lanes: [],
    parts: [],
    by: { storyboard: mode, ...by, ...(pending ? { pending: true } : {}), ...(failed ? { failed } : {}) },
  }
}

/** A card's parsed text as a mode product (studio, atlas, or one being built or failed), else null. */
export const modeOf = (spec) => (spec && typeof spec === 'object' && spec.v === 1 && MODES[spec.mode] && spec.mode !== 'sketch' ? spec : null)
