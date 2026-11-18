// The route gate: Gnomon draws when a figure is the better answer, whatever
// words the owner used.
//
// Every owner message is put to Jev once (one typed choice, ~150 ms on the
// judge purpose) while the chat model starts its turn. When Jev picks a view
// and words are unlikely, the manager starts building it at once, so a
// `gnomon_visualize` call in the same turn joins the build already running
// instead of starting one. When the build lands and Gnomon has not drawn in
// the turn so far, the gate places the figure itself, while the chat model is
// still talking: the owner asked for something with a shape and gets the
// shape in seconds. A draw by Gnomon in the same turn joins the same build
// and the same card. A greeting, an instruction, a question a sentence answers:
// words, no card, no storyboard spent.
//
// The guess reads one sentence; the answer reads the record. When Gnomon's
// first read is the source of another view (it asked gnomon_pull_requests
// while the gate drew threads), the card turns into that view in place: the
// figure rests on the same rows as the words, a second or two later.
//
// Observe-only on the session stream, like the chat recorder; the only write
// is the same `board:place` the tool makes, through the same placer.

import { MAX_WORDS } from '@sundial/nodus/orchestrate.js'
import { VIEW_OF_TOOL, VIEWS } from '@sundial/nodus/views.js'

const DRAW_TOOLS = new Set(['gnomon_visualize'])

/**
 * @param manager the plugin's manager (route + single-flight build)
 * @param place (out) → card id, the tool's own placer
 * @param canPlace () → whether the owner's staging setting lets Gnomon place cards
 * @param isOwner (data) → whether a `user/message` is the owner's own words
 * @param textOf (data) → its text
 */
export function createGate({ manager, place, canPlace, isOwner, textOf, modeFor = () => 'auto', log = console.log, warn = console.warn }) {
  /** Open turns by session: the build the gate started, and whether Gnomon drew on its own. */
  const turns = new Map()

  async function open(sessionId, ask, turn) {
    const routed = await manager.routeOnly(ask)
    turn.routed = routed
    log(`[sundial-nodus] route: ${routed?.view ?? 'words'} (${routed ? `${routed.p.toFixed(2)}, words ${routed.words.toFixed(2)}` : 'no judge'}) for ${sessionId}`)
    // A record view, or a free scene of something in the world (`view: 'free'`).
    if (!routed?.view || !(VIEWS[routed.view] || routed.view === 'free') || !(routed.words < MAX_WORDS)) return null
    // In the way of drawing the owner set for this thread (Auto when none).
    const out = await manager.drawIn({ ask, view: routed.view, form: routed.form, archetype: routed.archetype, mode: turn.mode })
    if (!out.ok) log(`[sundial-nodus] nothing to draw for ${routed.view}: ${out.reason}`)
    return out
  }

  function onSessionEvent(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || session?.header?.origin === 'subagent') return
    const type = event?.type
    const data = event?.data ?? {}
    if (type === 'user/message') {
      if (!isOwner(data)) return
      const ask = String(textOf(data) ?? '').trim()
      if (ask === '' || !canPlace()) return
      const turn = { drew: false, mode: modeFor(sessionId), ask }
      turns.set(sessionId, turn)
      turn.build = open(sessionId, ask, turn)
      const failed = (error) => warn(`[sundial-nodus] the gate could not draw: ${error instanceof Error ? error.message : String(error)}`)
      turn.landed = turn.build
        .then(async (out) => {
          if (!out?.ok || turn.drew || !canPlace()) return
          turn.placed = await place(out)
          const id = turn.placed
          log(`[sundial-nodus] the gate placed ${id} (${out.spec.mode ?? 'sketch'}: ${out.spec.view ?? ''} ${out.spec.form}) in ${out.spec.by.ms?.place ?? out.spec.by.ms?.total ?? '?'} ms`)
          // Both: the scene of the same rows, beside them.
          void out.scene?.then(async (scene) => {
            if (scene?.ok && !turn.drew && canPlace()) log(`[sundial-nodus] the gate placed ${await place(scene, { near: id })} (${scene.spec.view} scene) beside it`)
          }).catch(failed)
        })
        .catch(failed)
      return
    }
    const turn = turns.get(sessionId)
    if (!turn) return
    if (type === 'tool/call') {
      const name = data.name === 'gnomon_call' ? (safeName(data.arguments) ?? data.name) : data.name
      if (DRAW_TOOLS.has(name)) turn.drew = true
      else if (!turn.settled) void follow(sessionId, turn, name).catch((error) => warn(`[sundial-nodus] the gate could not follow the answer: ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    if (type === 'turn/end') turns.delete(sessionId)
  }
  /**
   * The answer's first read that settles the card: one of the drawn view's
   * own tools keeps it; the source of another view redraws the card as that
   * view, on the same id. A read no view rests on settles nothing.
   */
  async function follow(sessionId, turn, tool) {
    const other = VIEW_OF_TOOL[tool]
    if (!other) return
    turn.settled = true
    await turn.landed
    const drawn = turn.routed?.view
    const id = turn.placed
    if (!id || turn.drew || !VIEWS[drawn] || VIEWS[drawn].tools?.includes(tool) || !canPlace()) return
    const out = await manager.drawIn({ ask: turn.ask, view: other, mode: turn.mode })
    if (!out?.ok || turn.drew || turn.placed !== id) return
    turn.routed = { view: other }
    turn.build = Promise.resolve(out)
    await place(out, { id })
    log(`[sundial-nodus] the answer read ${tool}: card ${id} redrawn from ${drawn} to ${other} for ${sessionId}`)
  }

  /**
   * Gnomon drew in a turn the gate had already drawn in: the card the gate
   * placed, if any, so the tool can take its place (Gnomon read the ask with
   * the whole conversation; the gate read one sentence).
   */
  onSessionEvent.takeOver = (sessionId) => {
    const turn = turns.get(sessionId)
    const id = turn?.placed ?? null
    if (turn) turn.placed = null
    return id
  }
  /**
   * The build the gate started for this turn's ask, when Gnomon asks for the
   * same figure (no view, or the gate's) in the same mode: one build, one card,
   * whatever words Gnomon put the ask in. Null when there is none to join.
   */
  onSessionEvent.join = async (sessionId, { view, mode }) => {
    const turn = turns.get(sessionId)
    if (!turn?.build || mode !== turn.mode) return null
    const out = await turn.build.catch(() => null)
    return out?.ok && (!view || view === turn.routed?.view) ? out : null
  }
  /** The shape the gate's route gave this turn's ask, so Gnomon drawing the same view in other words draws it the same way. */
  onSessionEvent.shapeFor = (sessionId, view) => {
    const routed = turns.get(sessionId)?.routed
    return routed?.form && (!view || view === routed.view) ? routed.form : undefined
  }
  return onSessionEvent
}

function safeName(args) {
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args
    return typeof parsed?.name === 'string' ? parsed.name : null
  } catch {
    return null
  }
}
