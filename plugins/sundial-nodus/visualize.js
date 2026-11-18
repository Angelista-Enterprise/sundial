// gnomon_visualize: Gnomon draws a part of the record as a Nodus card.
//
// The engine (packages/nodus) is pure and takes its hands as arguments; this
// file is where those hands are Sundial's own. Reads go through TOOL_REGISTRY,
// the storyboard through the one budget gate and the one ledger writer (purpose
// `visualize`), the route and the walk's check through `judgeNow` (purpose
// `judge`, which falls back to the text model without a Jev key, or to
// nothing). The card is a `board:place` like any other, so the owner removes
// it like any other, and the fold shelves its recipe so it can come back.

import { createManager, FORM_NAMES } from '@sundial/nodus/orchestrate.js'
import { ARCHETYPES, undash } from '@sundial/nodus/spec.js'
import { VIEW_NAMES } from '@sundial/nodus/views.js'
import { CHOICES, modeOf, wrap } from '@sundial/nodus/modes/index.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const VISUALIZE_TOOL_NAME = 'gnomon_visualize'
const QUESTION_SET = 'nodus.walk.v1'

export const DESCRIPTION = [
  'Draw a part of the record as a figure on the board, with a walk you narrate over it. Call it whenever the answer has a shape (time, amounts, a change, connections), whatever words the owner used; omit view and the ask picks one.',
  'Views: day (hour by hour), where (where the time went), compare (a day beside another), week (seven days), ledger (your model calls and cost), threads (open work and who it is owed to), prs (pull requests), goals, people; free draws something in the world, not the record (a rainbow, a heat pump), built by the archetype you name.',
  'If it is already drawing one for this ask, it returns that card. preview returns the spec without placing it. After placing, say in one line what the card shows and link it: [the figure](board:<the id returned>); do not repeat the walk.',
].join(' ')

export const PARAMETERS = {
  ask: { type: 'string', required: true, description: 'The owner\'s question, in their words; the walk answers it.' },
  view: { type: 'string', enum: [...VIEW_NAMES, 'free'], description: 'Which figure; free for something in the world rather than the record. Omit to let the ask decide.' },
  form: { type: 'string', enum: FORM_NAMES, description: 'rows, scene or both. Only where, week, threads and people can be a scene; omit to let the ask decide.' },
  archetype: { type: 'string', enum: Object.keys(ARCHETYPES), description: 'A scene\'s kind of set. A record view picks its own (where and week fluid, threads and people orbital); naming one asks for a scene; with view free, the set to build (system for how light, weather or a building works, orbital, fluid, mechanism).' },
  date: { type: 'string', description: 'The day, YYYY-MM-DD in the owner\'s zone; omit for today (or the day the ask names).' },
  other: { type: 'string', description: 'compare only: the day to hold it against, YYYY-MM-DD; omit for the day before.' },
  mode: { type: 'string', enum: CHOICES, description: 'How to draw it; omit for the thread\'s choice (the owner\'s, in the thread bar), and name one only when the owner asks for a way of drawing in words.' },
  preview: { type: 'boolean', description: 'true = return the spec and do not place a card.' },
  near: { type: 'string', description: 'A card id to land beside.' },
}

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

/**
 * Sundial's hands for the engine: a budgeted model call and a judge.
 *
 * @param kernel the `gnomonKernel` service: reserveLlmCall, judgeNow
 * @param call (options) → runAuditedLlmCall's result
 */
export function engineHands({ kernel, call }) {
  // `opts` (maxTokens, temperature, timeoutMs): a mode that knows its own room, Studio's program being the longest.
  const complete = async (messages, opts = {}) => {
    const callId = await kernel.reserveLlmCall('visualize', { caller: VISUALIZE_TOOL_NAME })
    if (!callId) return null
    // A blueprint (the free path) carries a set and its walk: more room than a walk alone.
    const blueprint = /Worked blueprints/.test(messages[0]?.content ?? '')
    const out = await call({ purpose: 'visualize', momentId: null, callId, messages, maxTokens: opts.maxTokens ?? (blueprint ? 1400 : 600), temperature: opts.temperature ?? (blueprint ? 0.3 : 0.4), timeoutMs: opts.timeoutMs ?? 45_000 })
    return out.content
  }
  // `{ state, questions, set, assets }`: an image (a frame) rides as an asset, never logged.
  const judge = async ({ state, questions, set, assets }) => (await kernel.judgeNow({ purpose: 'judge', questionSetId: set ?? QUESTION_SET, momentId: null, state, questions, caller: VISUALIZE_TOOL_NAME, ...(assets ? { assets } : {}) }))?.answers ?? null
  return { complete, judge }
}

/** What a model reads back about a figure: the walk it may point at, never the parts. */
export const summaryOf = (spec) => spec.mode && spec.mode !== 'sketch' ? { title: spec.title, mode: spec.mode, steps: spec.steps.map((s) => s.say), drawing: spec.by.pending ? 'still being built; the card swaps in the figure when it is done' : spec.by.failed ? `could not draw: ${spec.by.failed}` : 'drawn', ms: spec.by.ms } : ({ title: spec.title, headline: spec.headline, view: spec.view, form: spec.form, ...(spec.archetype ? { archetype: spec.archetype } : {}), rows: spec.lanes.map((l) => l.label).slice(0, 12), parts: spec.parts.length, steps: spec.steps.map((s) => s.say), walkBy: spec.by.pending ? 'the numbers, Gnomon\'s walk on its way' : spec.by.storyboard, critic: spec.by.critic, ms: spec.by.ms })

/**
 * The placing half, shared by the tool and the route gate: one card per built
 * figure. A figure already on the board (the same build) is focused, not placed
 * again. A figure placed with the walk from the numbers gets the model's walk
 * on the same card when it lands (`out.later`), unless the owner removed it.
 * `place.settled(id)` is that swap, for whoever must wait for it.
 */
export function createPlacer({ kernel, library = null, emit = () => {}, now = Date.now }) {
  const placed = new WeakMap()
  const settling = new Map()
  // A figure asked for again is the same spec: kept once.
  const kept = new WeakSet()
  const keep = (spec) => !kept.has(spec) && (kept.add(spec), void library?.keep(spec).catch(() => {}))
  async function place(out, { near, id: fixed } = {}) {
    const { spec } = out
    let id = fixed ?? placed.get(spec)
    if (fixed || !id || !kernel.getState()?.board?.cards?.[id]) {
      id ??= `nodus:${now().toString(36)}`
      placed.set(spec, id)
      await kernel.appendSignal('board:place', { id, kind: 'nodus', text: JSON.stringify(spec), near, by: 'gnomon' })
      if (!out.later) keep(spec)
      else {
        const card = id
        settling.set(card, out.later.then(async (final) => {
          const cards = kernel.getState()?.board?.cards
          if (!final?.ok || (cards && !cards[card])) return null
          await kernel.appendSignal('board:place', { id: card, kind: 'nodus', text: JSON.stringify(final.spec), by: 'gnomon' })
          emit(kernel.getState()?.board ?? null)
          keep(final.spec)
          return final
        }).catch(() => null))
      }
    }
    await kernel.appendSignal('board:focus', { ids: [id], text: spec.headline || spec.title, by: 'gnomon' })
    // The theme's live channel relays the board to every open browser; without it the card waited for a reload.
    emit(kernel.getState()?.board ?? null)
    return id
  }
  place.settled = (id) => settling.get(id) ?? Promise.resolve(null)
  return place
}

/**
 * A card still "Building in X" when Sundial stopped: its build died with the
 * process, so it says at once that it could not draw this, with Retry.
 */
export function settleOrphans(kernel) {
  for (const [id, card] of Object.entries(kernel.getState()?.board?.cards ?? {})) {
    let spec = null
    try {
      spec = card?.kind === 'nodus' ? modeOf(JSON.parse(card.text)) : null
    } catch {}
    if (!spec?.by?.pending) continue
    const { pending, ...by } = spec.by
    void kernel.appendSignal('board:place', { id, kind: 'nodus', text: JSON.stringify(wrap({ ...spec, by, failed: 'Sundial restarted while this was being built' })), by: 'gnomon' })
  }
}

/**
 * What is on the owner's screen, from the fold alone (no sensor, no raw
 * lines): the window's title, the app and project of the open moment, and the
 * typed facts of the last capture (`screen-facts.ts`). Null when idle.
 */
export function screenOf(state) {
  const moment = state?.moment ?? null
  if (!moment) return null
  const facts = Array.isArray(state?.screen?.facts) ? state.screen.facts : []
  const first = (kind) => facts.find((f) => f?.kind === kind)?.value ?? null
  const refs = Array.isArray(state?.screen?.refs) ? state.screen.refs : []
  const project = typeof moment.projectId === 'string' ? moment.projectId.replace(/\/+$/, '').split('/').pop() || null : null
  const clip = (v, n) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, n) : null)
  const out = {
    title: clip(state?.window?.active?.windowTitle, 80),
    app: clip(state?.window?.active?.processName ?? moment.processName, 40),
    project,
    ticket: first('ticket') ?? refs.find((r) => !r.startsWith('#')) ?? null,
    pr: first('pr') ?? refs.find((r) => r.startsWith('#')) ?? null,
    error: clip(first('error'), 120),
    file: first('file'),
  }
  return Object.values(out).some(Boolean) ? out : null
}

/**
 * The tool's execute, over Sundial's services.
 *
 * @param deps.kernel the `gnomonKernel` service: getState, appendSignal, reserveLlmCall, judgeNow
 * @param deps.read (tool, args) → a TOOL_REGISTRY answer
 * @param deps.call (options) → runAuditedLlmCall's result
 * @param deps.manager a shared manager (the plugin's), else one is made here
 * @param deps.emit (board) → void, the theme's live board channel (`gnomon/board`)
 * @param deps.place a shared placer (the gate's), else one is made here
 * @param deps.takeOver (sessionId) → the card the route gate placed in this turn, or null
 * @param deps.shapeFor (sessionId, view) → the shape the gate's route gave this turn, or undefined
 * @param deps.join (sessionId, { view, mode }) → the gate's build for this turn's ask, to place instead of building again
 * @param deps.now () → ms, for the card id
 */
export function createVisualize({ kernel, read, call, manager = null, library = null, emit, place = null, takeOver = () => null, shapeFor = () => undefined, join = async () => null, modeFor = () => 'auto', today = () => undefined, now = Date.now }) {
  const m = manager ?? createManager({ read, ...engineHands({ kernel, call }), examples: library?.like, reuse: library?.reuse, screen: () => screenOf(kernel.getState()) }, { today, now })
  place ??= createPlacer({ kernel, library, emit, now })

  const execute = async function execute(args, exec) {
    if (args.date && !isDate(args.date)) return { done: false, reason: 'date is YYYY-MM-DD' }
    if (args.other && !isDate(args.other)) return { done: false, reason: 'other is YYYY-MM-DD' }
    // A model may send the flag as a string; "false" must not preview.
    const preview = args.preview === true || args.preview === 'true'
    // Placing is an act, as for a lens; a preview is a read.
    const level = kernel.getState()?.settings?.autonomy ?? 'act'
    if (!preview && level !== 'act') return { done: false, reason: `the owner set board staging to "${level}"; you may not place cards. Say what the figure would have shown instead.` }

    // No shape named: the one the route gate read for this turn, so Gnomon's card and the gate's are one.
    const form = FORM_NAMES.includes(args.form) ? args.form : ARCHETYPES[args.archetype] ? 'scene' : shapeFor(exec?.agent?.session?.id, args.view)
    console.log(`[sundial-nodus] gnomon_visualize: view ${args.view ?? 'by the ask'}, form ${args.form ?? `${form ?? 'rows'} (not named)`}`)
    // The owner's choice for the thread wins; in Auto, a mode Gnomon names (the owner asked in words) holds.
    const thread = modeFor(exec?.agent?.session?.id)
    const mode = thread !== 'auto' ? thread : CHOICES.includes(args.mode) ? args.mode : 'auto'
    const out = (await join(exec?.agent?.session?.id, { view: args.view, mode })) ?? await m.drawIn({ ask: undash(args.ask), mode, view: args.view, form, date: args.date, other: args.other, archetype: ARCHETYPES[args.archetype] ? args.archetype : undefined })
    if (!out.ok) return { done: false, reason: out.reason }
    if (preview) return { done: true, preview: true, ...summaryOf(out.spec), spec: out.spec }
    const id = await place(out, { near: args.near })
    // Both: the scene of the same rows lands beside them.
    const scene = out.scene ? await out.scene : null
    const sceneId = scene?.ok ? await place(scene, { near: id }) : null
    // One figure per answer: the gate's guess gives way to the one Gnomon chose (it stays on the shelf).
    // A card still being built stays: it never leaves the board mid-build.
    const guess = takeOver(exec?.agent?.session?.id)
    const held = kernel.getState()?.board?.cards?.[guess]
    if (guess && guess !== id && held && !/"pending":true/.test(held.text ?? '')) {
      await kernel.appendSignal('board:remove', { id: guess, by: 'gnomon' })
      emit?.(kernel.getState()?.board ?? null)
    }
    return { done: true, id, ...summaryOf(out.spec), ...(sceneId ? { scene: { id: sceneId, ...summaryOf(scene.spec) } } : {}) }
  }
  execute.manager = m
  execute.place = place
  return execute
}

/**
 * Each thread's way of drawing (Auto, Sketch, Studio, Atlas), remembered on
 * this machine beside the library: `{ sessionId: mode }` in one small file.
 * Auto when a thread never chose. No event: it is a preference of the
 * screen, like the model a thread talks to, not something that happened.
 */
export function createThreadModes({ file }) {
  const memo = { all: null }
  const load = () => {
    if (memo.all) return memo.all
    try {
      memo.all = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      memo.all = {}
    }
    return memo.all
  }
  const get = (sessionId) => (CHOICES.includes(load()[sessionId]) ? load()[sessionId] : 'auto')
  const set = (sessionId, mode) => {
    if (typeof sessionId !== 'string' || sessionId === '' || !CHOICES.includes(mode)) return false
    const all = load()
    if (mode === 'auto') delete all[sessionId]
    else all[sessionId] = mode
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(all), { mode: 0o600 })
    } catch (error) {
      console.warn(`[sundial-nodus] thread mode not saved: ${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }
  return { get, set }
}
