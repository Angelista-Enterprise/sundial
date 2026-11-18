// The manager: one place that owns the stages, their budgets, timeouts,
// retries and fallbacks, and the cache that keeps a figure from being built
// twice.
//
//   route ─▶ read ─▶ place ─▶ storyboard ─▶ critic ─▶ check
//   Jev      views    numbers   model+repair   Jev       spec.js
//
// Place at once, narrate later: as soon as the rows are read the figure is
// handed out with the walk from the numbers (`by.pending`), and the model's
// walk follows it as `later`, which the placer swaps in on the same card. A
// verified walk the library kept for the same figure within the hour is
// reused as it is: no model call at all.
//
// Nothing here knows a transport, a budget or a key. The plugin passes `read`
// (a TOOL_REGISTRY read), `complete` (an audited, budgeted model call that
// resolves to text, or null when refused), `judge` (Jev through `judgeNow`,
// null when judging is off) and `examples` (walks the library kept for like
// asks). Each may be missing, and each missing one only lowers the ladder: no
// model means the walk from the numbers, no judge means an ungated walk, never
// no card.

import { ARCHETYPES, checkSpec } from './spec.js'
import { blueprintMessages, blueprintSpec, criticQuestions, digest, fallbackSteps, parseBlueprint, parseReply, routeQuestions, screenLine, storyboardMessages, tailor } from './storyboard.js'
import { VIEWS, readView } from './views.js'
import { resolvePictures } from './edit.js'
import { BUILD_LIMIT_MS, buildDown, MODES, pick, wrap } from './modes/index.js'

/** A walk under this Jev score (of 3) does not answer the ask: the walk from the numbers replaces it. */
const MIN_FITS = 1
/**
 * The route gate draws when Jev's pick is a view and words are this unlikely.
 * Not the pick's own confidence: eight views split the mass, so "threads" can
 * win at 0.29 while words sit at 0.05, and that ask clearly wants a figure.
 */
export const MAX_WORDS = 0.4
const ROUNDS = 2
/** Per stage, so one stuck call lowers the ladder instead of holding the turn. */
export const TIMEOUT = { route: 8_000, read: 20_000, examples: 3_000, storyboard: 50_000, blueprint: 50_000, critic: 10_000 }
/** A figure asked for twice inside this long is the same figure: the second ask joins the first. */
const FRESH_MS = 120_000
/** A mode that has not drawn in this long places a card that says it is building, and swaps the figure in later. */
const PENDING_MS = 400

const within = (ms, promise) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]).finally(() => clearTimeout(timer))
}
const DAY_MS = 86_400_000
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/**
 * The day an ask names, from its words alone: an ISO date, today, yesterday,
 * or a weekday (the last one). Undefined when it names none, which means today.
 */
export function dateOf(ask, today) {
  const s = String(ask ?? '').toLowerCase()
  const iso = s.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (iso) return iso[1]
  if (!today) return undefined
  const at = Date.parse(`${today}T12:00:00Z`)
  const back = (n) => new Date(at - n * DAY_MS).toISOString().slice(0, 10)
  // "today" named beside another day (compare today with yesterday) keeps today the day asked about.
  if (/\b(today|vandaag)\b/.test(s)) return undefined
  if (/\b(day before yesterday|eergisteren)\b/.test(s)) return back(2)
  if (/\b(yesterday|gisteren)\b/.test(s)) return back(1)
  const wd = WEEKDAYS.findIndex((d) => new RegExp(`\\b(last )?${d}\\b`).test(s))
  if (wd >= 0) return back(((new Date(at).getUTCDay() - wd + 7) % 7) || 7)
  return undefined
}

/**
 * The view an ask is about when no judge can say: a fallback by the record's
 * own nouns, so an explicit call still lands on a sensible form. Day when
 * nothing else is named.
 */
export function guessView(ask) {
  const s = String(ask ?? '').toLowerCase()
  if (/\b(compare|versus|vs|beside|than yesterday|against)\b/.test(s)) return 'compare'
  if (/\b(week|seven days|7 days)\b/.test(s)) return 'week'
  if (/\b(cost|spend|ledger|model calls?|tokens?)\b/.test(s)) return 'ledger'
  if (/\b(pull requests?|prs?|pr['’]s)\b/.test(s)) return 'prs'
  if (/\b(goals?)\b/.test(s)) return 'goals'
  if (/\b(people|who do i|person|colleagues?)\b/.test(s)) return 'people'
  if (/\b(threads?|commitments?|promises?|middle of|unfinished)\b/.test(s)) return 'threads'
  if (/\b(where .*time|split|share|distribution|how much time)\b/.test(s)) return 'where'
  return 'day'
}

export const FORM_NAMES = ['rows', 'scene', 'both']
/** A day becomes a scene (where its time went) only when Jev is this sure of the shape: it reads most day asks as pictures, a timeline being one. */
export const DAY_SCENE = 0.85


/**
 * Route: Jev's typed choice of a view, or words, and for a view that can be a
 * scene, its shape. `screen` (what is on screen, from the fold) lets "this"
 * mean something. Null when there is no judge or it fails.
 */
export async function route(ask, judge, screen = null) {
  if (!judge || !String(ask ?? '').trim()) return null
  const on = screenLine(screen)
  const answers = await within(TIMEOUT.route, judge({ state: { ask: String(ask).slice(0, 400), ...(on ? { screen: on } : {}) }, questions: routeQuestions(VIEWS), set: 'nodus.route.v1' })).catch(() => null)
  const v = answers?.view
  if (!v?.choice) return null
  const p = v.confidence ?? v.probabilities?.[v.choice] ?? 0
  const words = v.probabilities?.words ?? (v.choice === 'words' ? p : 1 - p)
  // Something in the world, not the record: a free scene of the archetype picked.
  const free = /^scene_/.test(v.choice) && ARCHETYPES[v.choice.slice(6)] ? v.choice.slice(6) : null
  if (free) return { view: 'free', archetype: free, p, words, form: 'scene' }
  const view = v.choice === 'words' ? null : v.choice
  // The shape counts for a view that has a scene; a day turns into one (where its time went) only when Jev is sure.
  const shape = answers.shape
  const sure = view !== 'day' || (shape?.probabilities?.scene ?? shape?.confidence ?? 0) >= DAY_SCENE
  const form = (VIEWS[view]?.scene || view === 'day') && FORM_NAMES.includes(shape?.choice) && sure && !(view === 'day' && shape.choice === 'rows') ? shape.choice : null
  return { view, p, words, ...(form ? { form } : {}) }
}

/**
 * Build one figure: read the view, storyboard it, gate it, check it.
 * Returns `{ ok, spec, problems }`, or `{ ok: false, reason }` when the record
 * holds nothing for it. `spec.by.ms` carries every stage's time.
 *
 * `early(out)` hears the figure as soon as it can be drawn, walked by the
 * numbers and marked `by.pending`, while the model writes; `reuse(source)` may
 * hand back a kept walk `{ at, steps, title, fits }` for the same figure, and
 * then no model is asked.
 */
export async function build({ ask = '', view = 'day', args = {}, screen = null } = {}, { read, complete = null, judge = null, examples = null, reuse = null, early = null, now = Date.now } = {}) {
  const t0 = now()
  const ms = {}
  const lap = (stage, since) => (ms[stage] = now() - since)
  if (!VIEWS[view]) return { ok: false, reason: `no view called ${view}` }

  // The read and the library lookup do not depend on each other: in parallel.
  let t = now()
  const readOnce = () => within(TIMEOUT.read, readView(view, args, read))
  const [skeleton, like] = await Promise.all([
    readOnce().catch(() => readOnce()).catch(() => null),
    examples ? within(TIMEOUT.examples, Promise.resolve(examples(ask, view))).catch(() => []) : [],
  ])
  lap('read', t)
  if (!skeleton || skeleton.lanes.length === 0) return { ok: false, reason: VIEWS[view].unavailable ?? `The record holds nothing to draw for ${args.date ?? (view === 'day' || view === 'where' ? 'today' : view)}.` }

  // Reuse before generating: the same figure walked and verified within the hour.
  const kept = reuse ? await Promise.resolve(reuse(skeleton.source)).catch(() => null) : null
  const again = kept && checkSpec({ ...skeleton, steps: kept.steps })
  if (again?.ok) {
    ms.total = now() - t0
    const { spec } = checkSpec({ ...skeleton, ask, headline: kept.title ?? '', steps: again.spec.steps, by: { storyboard: 'library', reused: kept.at, critic: { fits: kept.fits ?? null }, ms } })
    return { ok: true, spec, problems: [] }
  }

  // Placed at once with the walk from the numbers; the model's walk follows.
  if (early && (complete || judge)) {
    ms.place = now() - t0
    early({ ok: true, spec: checkSpec({ ...skeleton, ask, steps: fallbackSteps(skeleton, screen), by: { storyboard: 'fallback', pending: true, critic: null, ms: { ...ms } } }).spec, problems: [] })
  }

  // Storyboard: the model's walk, repaired once against the checker's own words.
  t = now()
  let steps = null
  let headline = ''
  let storyboard = 'fallback'
  let problems = []
  let previous = null
  for (let round = 0; complete && round < ROUNDS && !steps; round++) {
    const reply = await within(TIMEOUT.storyboard, complete(storyboardMessages(skeleton, ask, problems, previous, like ?? [], screen))).catch(() => null)
    if (reply == null) break
    previous = reply
    const parsed = parseReply(reply)
    if (!parsed) {
      problems = ['the reply was not the JSON object asked for']
      continue
    }
    const check = checkSpec({ ...skeleton, steps: parsed.steps })
    if (check.ok) {
      steps = check.spec.steps
      headline = parsed.title ?? ''
      storyboard = 'model'
      problems = []
    } else problems = check.problems
  }
  if (!steps) steps = fallbackSteps(skeleton, screen)
  lap('storyboard', t)

  // Critic: does the walk answer the ask, and which steps earn their place.
  t = now()
  let critic = null
  if (judge) {
    const state = { ask: ask || 'show me this', digest: digest(skeleton, ask, screen), walk: Object.fromEntries(steps.map((s, i) => [`s${i}`, s.say])) }
    const answers = await within(TIMEOUT.critic, judge({ state, questions: criticQuestions(steps) })).catch(() => null)
    if (answers) {
      critic = { fits: answers.fits?.score ?? null }
      if (storyboard === 'model' && critic.fits !== null && critic.fits < MIN_FITS) {
        steps = fallbackSteps(skeleton, screen)
        headline = ''
        storyboard = 'fallback'
      } else steps = tailor(steps, answers)
    }
    lap('critic', t)
  }
  ms.total = now() - t0

  const { spec } = checkSpec({ ...skeleton, ask, headline, steps, by: { storyboard, critic, ms } })
  return { ok: true, spec, problems }
}

/**
 * Build a free scene: one model call writes the blueprint (archetype, parts,
 * joints, walk), repaired once against the checker's own words; the set is
 * handed out as soon as it checks, walked by the numbers (`by.pending`), and
 * the model's walk, gated by the critic, follows. No record is read; doors
 * only search it. `{ ok: false, reason }` without a model or a blueprint.
 */
export async function buildFree({ ask = '', archetype = null } = {}, { complete = null, judge = null, early = null, picture = null, now = Date.now } = {}) {
  const t0 = now()
  const ms = {}
  if (!complete) return { ok: false, reason: 'drawing something from the world needs a model, and none answered' }
  let problems = []
  let previous = null
  let checked = null
  for (let round = 0; round < ROUNDS && !checked?.ok; round++) {
    const reply = await within(TIMEOUT.blueprint, complete(blueprintMessages(ask, archetype, problems, previous, { pictures: Boolean(picture) }))).catch(() => null)
    if (reply == null) break
    previous = reply
    const bp = parseBlueprint(reply)
    if (!bp) {
      problems = ['the reply was not the JSON blueprint asked for']
      continue
    }
    const check = checkSpec(blueprintSpec(bp, ask))
    // A blueprint that draws (parts, a form) is kept even when a repair is asked: the checker coerced what it could.
    if (check.spec?.lanes.length) checked = check
    problems = check.problems
  }
  ms.blueprint = now() - t0
  if (!checked) return { ok: false, reason: 'no blueprint came back that could be drawn' }
  // Parts drawn from a generated picture (when a source is handed in): fetched before the set is placed.
  if (picture) {
    const t = now()
    const failed = await resolvePictures(checked.spec, picture, 6, { auto: true })
    if (failed.length) checked.problems = [...checked.problems, ...failed.map((f) => `picture ${f}`)]
    ms.pictures = now() - t
  }
  const set = checked.spec
  let steps = set.steps.length ? set.steps : fallbackSteps(set)
  let storyboard = set.steps.length ? 'model' : 'fallback'
  if (early && judge) {
    ms.place = now() - t0
    early({ ok: true, spec: checkSpec({ ...set, steps: fallbackSteps(set), by: { storyboard: 'fallback', pending: true, critic: null, problems, ms: { ...ms } } }).spec, problems })
  }
  let critic = null
  if (judge) {
    const t = now()
    const state = { ask: ask || 'show me this', digest: digest(set, ask), walk: Object.fromEntries(steps.map((x, i) => [`s${i}`, x.say])) }
    const answers = await within(TIMEOUT.critic, judge({ state, questions: criticQuestions(steps, true) })).catch(() => null)
    if (answers) {
      critic = { fits: answers.fits?.score ?? null }
      if (storyboard === 'model' && critic.fits !== null && critic.fits < MIN_FITS) {
        steps = fallbackSteps(set)
        storyboard = 'fallback'
      } else steps = tailor(steps, answers)
    }
    ms.critic = now() - t
  }
  ms.total = now() - t0
  const { spec } = checkSpec({ ...set, steps, by: { storyboard, critic, problems, ms } })
  return { ok: true, spec, problems }
}

/** Slice 1's entry, kept: a day, built. */
export const visualize = ({ ask = '', date } = {}, deps = {}) => build({ ask, view: 'day', args: date ? { date } : {} }, deps)

/** One read for two figures of the same rows (`both`): a tool asked twice with the same arguments is read once. */
const sharedRead = (read) => {
  const held = new Map()
  return (tool, args) => {
    const k = `${tool}|${JSON.stringify(args ?? {})}`
    if (!held.has(k)) held.set(k, Promise.resolve().then(() => read(tool, args)))
    return held.get(k)
  }
}

/**
 * The manager: route and build behind one cache, so the same figure asked for
 * by the route gate and by Gnomon's own tool call is built once.
 *
 * `draw({ ask, view?, form?, date? })` picks the view (given, else Jev's route,
 * else `guessView`) and the form (given, else the route's shape, else rows),
 * then builds or joins the build in flight under `view|form|args`. It resolves
 * as soon as the figure can be placed; `later` is the model's walk to swap in.
 * `both` resolves the rows, with `scene` the scene built after them from the
 * same read. `routeOnly(ask)` is the gate alone, for a turn nobody asked to draw.
 *
 * deps.screen () → what is on screen now (`screenLine`'s fields), or null.
 */
export function createManager(deps, { now = Date.now, today = () => undefined } = {}) {
  const flights = new Map()
  const key = (view, form, args) => `${view}|${form}|${JSON.stringify(args)}`
  // The route of an ask, once: the gate's and the tool's for the same words are one call.
  const routes = new Map()
  const routeOf = (ask, screen) => {
    const k = String(ask ?? '').trim()
    const held = routes.get(k)
    if (held && now() - held.at < FRESH_MS) return held.promise
    const promise = route(ask, deps.judge, screen)
    routes.set(k, { at: now(), promise })
    for (const [k2, r] of routes) if (now() - r.at > FRESH_MS) routes.delete(k2)
    return promise
  }

  async function choose({ ask, view, screen }) {
    if (view === 'free') return { view, routed: null }
    // A view named outright still takes the shape the route gave this ask, when the route picked the same view.
    if (VIEWS[view]) {
      const held = routes.get(String(ask ?? '').trim())
      const routed = held ? await held.promise : null
      return { view, routed: routed?.view === view || (routed?.view === 'day' && view === 'where') ? routed : null }
    }
    const routed = await routeOf(ask, screen)
    return { view: routed?.view ?? guessView(ask), routed }
  }

  function drawOne({ ask, view, form, args, screen, routeMs, routed, archetype }, read) {
    const full = form === 'scene' ? { ...args, as: 'scene' } : args
    // A free scene is the ask itself: its key is the words, and nothing is read.
    const k = view === 'free' ? key('free', 'scene', { ask: String(ask).trim().toLowerCase() }) : key(view, form, args)
    const held = flights.get(k)
    if (held && now() - held.at < FRESH_MS) return held.promise
    const stamp = (out) => {
      if (out.ok) out.spec.by.ms = { route: routeMs, ...out.spec.by.ms }
      return { ...out, routed }
    }
    const promise = new Promise((resolve) => {
      const hands = { ...deps, read, now, early: (quick) => resolve({ ...stamp(quick), later }) }
      const later = (view === 'free' ? buildFree({ ask, archetype }, hands) : build({ ask, view, args: full, screen }, hands)).then((out) => {
        const done = stamp(out)
        // Asked again within the flight's life, the figure comes with its finished walk.
        if (!out.ok) flights.delete(k)
        else if (flights.get(k)?.promise === promise) flights.set(k, { at: flights.get(k).at, promise: Promise.resolve(done) })
        return done
      })
      later.then(resolve, () => resolve({ ok: false, reason: 'the figure could not be built' }))
    })
    flights.set(k, { at: now(), promise })
    for (const [k2, f] of flights) if (now() - f.at > FRESH_MS) flights.delete(k2)
    return promise
  }

  async function draw({ ask = '', view, form, date, other, archetype } = {}) {
    const t = now()
    const screen = deps.screen?.() ?? null
    const chosen = await choose({ ask, view, screen })
    const routeMs = now() - t
    if (chosen.view === 'free') return drawOne({ ask, view: 'free', form: 'scene', args: {}, screen, routeMs, routed: chosen.routed, archetype: ARCHETYPES[archetype] ? archetype : chosen.routed?.archetype ?? null }, deps.read)
    // Today named outright is today left unnamed: one key, one build.
    const named = date ?? dateOf(ask, today())
    const day = named === today() ? undefined : named
    const args = { ...(day ? { date: day } : {}), ...(other ? { other } : {}) }
    // A day asked for as a scene outright (the tool's form) is where its time went; any other view with no scene binder is rows.
    const asked = FORM_NAMES.includes(form) ? form : chosen.routed?.form ?? 'rows'
    const name = asked !== 'rows' && chosen.view === 'day' ? 'where' : chosen.view
    const shape = VIEWS[name].scene ? asked : 'rows'
    const req = { ask, view: name, args, screen, routeMs, routed: chosen.routed }
    if (shape !== 'both') return drawOne({ ...req, form: shape }, deps.read)
    const read = sharedRead(deps.read)
    const rows = await drawOne({ ...req, form: 'rows' }, read)
    return rows.ok ? { ...rows, scene: drawOne({ ...req, form: 'scene' }, read) } : rows
  }

  /**
   * Draw in a mode (`auto`, `sketch`, `studio`, `atlas`): the record and
   * Sketch are `draw` as ever; another mode builds down its ladder. It
   * resolves as soon as there is something to place: the product the mode
   * handed early (an asset already cached), the finished one if it came within
   * `PENDING_MS`, else a card that says it is being built, with `later` the
   * finished figure (or the failure, which the card shows as words).
   */
  async function drawIn({ ask = '', mode = 'auto', ...rest } = {}) {
    // A plain spec is Sketch's product: the card says so without a tag, and the same build stays the same card.
    if (mode === 'sketch') return draw({ ask, ...rest })
    const t = now()
    const routed = rest.view && rest.view !== 'free' ? { view: rest.view } : await routeOf(ask, deps.screen?.() ?? null)
    const ctx = { route: rest.view === 'free' ? { view: 'free' } : routed, judge: deps.judge, complete: deps.complete, assets: deps.assets, screen: deps.screen?.() ?? null, now, read: deps.read, args: rest.date ? { date: rest.date } : {}, mannerJudge: deps.mannerJudge ?? deps.judge, looks: deps.looks }
    const picked = await pick(mode, ask, ctx)
    if (picked.mode === 'sketch') {
      const out = await draw({ ask, ...rest })
      // Only Sketch reads the record: a thread set to another mode is told why (the card's foot).
      // ponytail: stamped on the build's own spec, so the same build stays the same card.
      const stamp = (o) => o?.ok && picked.by === 'record' && MODES[mode] && (o.spec.by.asked = mode)
      stamp(out)
      void out.later?.then(stamp)
      return out
    }
    // One build per ask and mode in a turn is the gate's (`gate.join`): asked again later, it is drawn again.
    return new Promise((resolve) => {
      const by = (extra = {}) => ({ asked: mode, picked: picked.by, ms: { route: t0 - t, total: now() - t }, ...extra })
      const t0 = now()
      let placed = false
      const early = (product) => {
        if (placed || !product) return
        placed = true
        resolve({ ok: true, spec: wrap({ mode: picked.mode, product, ask, by: by({ early: true }) }), later })
      }
      // A build that never ends (a model that does not answer) still settles: the card says it could not draw, with Retry.
      const limit = BUILD_LIMIT_MS[picked.mode]
      const stuck = new Promise((r) => setTimeout(r, limit, { ok: false, reason: `${MODES[picked.mode].label} took longer than ${limit / 1000} s`, tried: [] }).unref?.())
      const later = Promise.race([buildDown(picked, ask, { ...ctx, early, sketch: () => draw({ ask, ...rest }) }), stuck]).then(async (out) => {
        if (!out.ok) {
          return { ok: true, spec: wrap({ mode: picked.mode, ask, by: by({ tried: out.tried }), failed: out.reason }) }
        }
        // Down to Sketch: its own finished walk, so the card is swapped once.
        if (out.mode === 'sketch') {
          const done = out.product.later ? await out.product.later : out.product
          return done.ok ? { ...done, spec: { ...done.spec, by: { ...done.spec.by, mode: 'sketch', asked: mode, tried: out.tried } } } : done
        }
        return { ok: true, spec: wrap({ mode: out.mode, product: out.product, ask, by: by({ tried: out.tried }) }) }
      })
      later.then((done) => {
        if (placed) return
        placed = true
        resolve(done)
      })
      setTimeout(() => {
        if (placed) return
        placed = true
        resolve({ ok: true, spec: wrap({ mode: picked.mode, ask, by: by(), pending: true }), later })
      }, PENDING_MS)
    })
  }

  return { draw, drawIn, routeOnly: (ask) => routeOf(ask, deps.screen?.() ?? null), flights }
}
