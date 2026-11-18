// Doc 27, section 3, items 2 and 8: two acts by place, not by a thing's own action. A click at a point of the window
// ({app, action: "click", at: [x, y]}, x and y in points from the window's top left, as its last look shows it), and a drag
// ({ref or at, action: "drag", to: a ref or [x, y]}) that presses, moves with the button held and lets go. Sundial.app reads
// the look's window (and a ref) again before it moves, and refuses a point outside the window.
//
// The gate judges them by what lies under the point (pointFinal): a final's words there ask as that final, a drop onto the
// Trash asks as a delete, and a point with no words under it is a final-unknown, which asks. Named exports only.
import { finalWord as FINAL } from './final-words.js'
import { looksLikeRef, lookOf, refOf, roleOf, tagOf } from './screen-look.js'

/** A drop onto these deletes: the Dock's and Finder's Trash, in the languages final-words.js knows. */
const TRASH = /^(?:trash|bin|recycle bin|prullenmand|papierkorb|corbeille|papelera|lixo|cestino)$/i

const bad = (why) => ({ error: `invalid arguments: ${why}` })
const area = (f) => f[2] * f[3]
const inside = (f, x, y) => Array.isArray(f) && f.length === 4 && x >= f[0] && y >= f[1] && x < f[0] + f[2] && y < f[1] + f[3]

/** [x, y] or {x, y} as two finite numbers, or null. */
export function pointOf(value) {
  const [x, y] = Array.isArray(value) ? value : value && typeof value === 'object' ? [value.x, value.y] : []
  return [x, y].every((n) => typeof n === 'number' && Number.isFinite(n)) ? [Math.round(x), Math.round(y)] : null
}

/** Whether a screen_act step is one of these: a drag, or a click (or a step with no action) at a point. */
export const pointAct = (args) => args?.action === 'drag' || (args?.at !== undefined && [undefined, '', 'click'].includes(args?.action))

/**
 * What lies under a point of the look's window (window points from its top left): the smallest thing whose frame holds it,
 * unless a bigger one round it carries a final's words, which then counts (fail closed: an icon inside a Delete button is the
 * Delete button). null when nothing in the look holds the point.
 */
export function under(look, [x, y], finalWord = FINAL) {
  const [wx, wy] = Array.isArray(look?.frame) ? look.frame : [0, 0]
  const holding = (look?.elements ?? []).filter((e) => !/^(?:ax)?(?:window|web ?area|scroll ?area|group|split ?group)$/i.test(String(e.role ?? '')) && inside(e.frame, wx + x, wy + y)).sort((a, b) => area(a.frame) - area(b.frame))
  return holding.find((e) => finalWord(e.label)) ?? holding[0] ?? null
}

/** A thing for the plan and the gate: its role and its words ('' when it shows none). */
const thingOf = (e) => ({ role: e ? (e.role === 'text' ? 'text' : roleOf(e)) : '', name: e && typeof e.label === 'string' && !looksLikeRef(e.label) ? e.label.trim() : '' })

/**
 * The plan of a point step, in the shape screen-tools' plan() gives (verb, app, thing, because, line, command), with `point`
 * set for the gate. `click`: the count, button and modifiers screen-tools read off the step. `finalWord`: final-words.js's
 * by default, so a final under the point is found. Reads this chat's newest look; a point is in that look's window.
 */
export async function pointPlan(args, last, readLook, click = {}, finalWord = FINAL) {
  if (click.error) return click
  if (!last) return bad('a step at a point, or a drag, needs a look first: screen_look {app}, then give x and y from the window\'s top left')
  const look = lookOf(await readLook(last.id, { at: last.at }))
  if (!look) return bad('the last look is gone: screen_look {app} again')
  if (args.app && String(args.app).toLowerCase() !== String(look.app ?? '').toLowerCase()) return bad(`the last look is of ${look.app}, not ${args.app}: screen_look {app: ${JSON.stringify(args.app)}} first`)
  const [w, h] = Array.isArray(look.frame) ? look.frame.slice(2) : [0, 0]
  const where = (value, name) => {
    if (typeof value === 'string') {
      const { ref, tag } = refOf(value)
      if (tag && tag !== tagOf(look)) return { error: `${value} is from another look than the last one: act on a ref from the last look, or give ${name} as [x, y]` }
      const e = (look.elements ?? []).find((x) => x.ref === ref)
      return e ? { ref, e } : { error: `no ${ref} in the last look` }
    }
    const p = pointOf(value)
    if (!p) return { error: `${name} is a ref ("e7@${tagOf(look)}") or [x, y] in points from the window's top left` }
    if (p[0] < 0 || p[1] < 0 || p[0] >= w || p[1] >= h) return { error: `${name} [${p}] is outside the window (${w} by ${h} points)` }
    return { at: p, e: under(look, p, finalWord) }
  }
  const app = look.app
  const inWindow = look.window ? { inWindow: look.window } : {}
  if (args.action !== 'drag') {
    const at = where(args.at, 'at')
    if (at.error) return bad(at.error)
    const thing = thingOf(at.e)
    const because = `click at [${at.at}]${thing.name ? ` on ${JSON.stringify(thing.name)}` : ''} in ${app}`
    return { verb: 'click', point: true, app, thing, because, line: `C${because.slice(1)}`, ...inWindow, command: { look: look.id, action: 'click', at: at.at, ...click } }
  }
  const from = where(args.ref ?? args.at, args.ref ? 'ref' : 'at')
  if (from.error) return bad(from.error)
  if (args.to === undefined) return bad('a drag needs to: the ref it is dropped on, or [x, y] in the window')
  const to = where(args.to, 'to')
  if (to.error) return bad(to.error)
  // The gate judges a drag by its drop target; the line names both ends.
  const thing = thingOf(to.e)
  const name = (end) => (end.e?.label ? JSON.stringify(end.e.label) : `[${end.at ?? end.ref}]`)
  const because = `drag ${name(from)} onto ${name(to)} in ${app}`
  return { verb: 'drag', point: true, app, thing, because, line: `D${because.slice(1)}`, ...inWindow, command: { look: look.id, action: 'drag', ...(from.ref ? { ref: from.ref } : { at: from.at }), to: to.ref ?? to.at } }
}

/**
 * The gate's reading of a point step (gate-finals.js finalOf): what the press or the drop lands on. A drop onto the Trash is a
 * delete; a thing with words is judged by them as any press is; no words, or a step nobody planned, is a final-unknown.
 */
export function pointFinal(p) {
  const name = String(p?.thing?.name ?? '').trim()
  if (p?.verb === 'drag' && TRASH.test(name)) return { app: p.app, kind: 'delete', what: `drop onto ${name}` }
  if (!name || looksLikeRef(name)) return { app: p?.app, unknown: true, why: p?.verb === 'drag' ? 'what the drop lands on shows no words' : 'what lies under the point shows no words' }
  return { app: p.app, role: p.thing.role, label: name }
}

/** The fields screen_act takes for these steps (its schema spreads them in). */
export const POINT_PARAMS = {
  at: { type: 'json', description: 'For a step where no ref fits (a canvas, a part with no words in the look): [x, y] in points from the window\'s top left, as its last look\'s frame gives the window; with action click (or no action) it clicks there. What lies under the point is judged as the thing pressed: no words there asks the owner. With action drag and no ref: where the drag starts.' },
  to: { type: 'json', description: 'For action drag: where it is dropped, a ref of the same look ("e9@a3f1") or [x, y] in the window. {ref, action: "drag", to}: press on the ref, move with the button held, let go on to. A drop is judged by what it lands on (a drop on the Trash deletes and asks).' },
}
