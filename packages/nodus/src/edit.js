// Steering: a figure changed by typed edits instead of drawn again. A judge's
// note on the rendered picture, or the owner's, becomes a short list of edits
// (add a part, drop one, relabel, give it a fact, redraw it from blocks or by
// hand, stand it on another, resize, rewrite the walk); the engine applies
// them to the spec and checks the result. Everything the model may say is a
// name, a word or a block: never a position, a colour or a size in units.
//
// Pure: the plugin and the lab both import it.

import { ARCHETYPES, checkSpec } from './spec.js'
import { BLOCKS, PORTS } from './blocks.js'

export const EDIT_OPS = ['add', 'drop', 'label', 'note', 'form', 'sketch', 'picture', 'stock', 'move', 'size', 'link', 'unlink', 'title', 'walk', 'panels']
const MAX_EDITS = 16

/**
 * A spec with `edits` applied, checked again. `applied` and `skipped` say what
 * happened to each edit, in words a repair round can read. The spec handed in
 * is not changed.
 */
export function applyEdits(spec, edits) {
  const s = structuredClone(spec)
  const applied = []
  const skipped = []
  const lane = (id) => s.lanes.find((l) => l.id === id)
  const skip = (e, why) => skipped.push(`${e.op ?? '?'} ${e.id ?? ''}: ${why}`.trim())
  for (const e of (Array.isArray(edits) ? edits : []).slice(0, MAX_EDITS)) {
    if (!e || !EDIT_OPS.includes(e.op)) {
      skip(e ?? {}, `not an edit (${EDIT_OPS.join(', ')})`)
      continue
    }
    const l = e.id ? lane(e.id) : null
    if (['drop', 'label', 'note', 'form', 'sketch', 'picture', 'stock', 'move', 'size'].includes(e.op) && !l) {
      skip(e, 'no part has that id')
      continue
    }
    switch (e.op) {
      case 'add': {
        const p = e.part
        if (!p?.id || !p.label || lane(p.id)) {
          skip({ op: 'add', id: p?.id }, p?.id && lane(p.id) ? 'a part with that id is there already' : 'a part needs an id and a label')
          continue
        }
        s.lanes.push({ role: 'marker', ...p, kind: p.kind ?? (s.archetype ? ARCHETYPES[s.archetype]?.kinds[0] : undefined) })
        break
      }
      case 'drop':
        s.lanes = s.lanes.filter((x) => x !== l)
        s.links = (s.links ?? []).filter((k) => k.from !== e.id && k.to !== e.id)
        for (const x of s.lanes) if (x.on === e.id) delete x.on
        s.steps = s.steps.map((st) => ({ ...st, focus: st.focus.filter((f) => f !== e.id) })).filter((st) => st.focus.length)
        break
      case 'label':
        l.label = String(e.label ?? l.label)
        break
      case 'note':
        e.note ? (l.note = String(e.note)) : delete l.note
        break
      case 'form':
        l.form = e.form
        delete l.sketch
        break
      case 'sketch':
        l.sketch = e.sketch
        break
      case 'picture':
        l.picture = String(e.picture ?? '')
        delete l.image
        break
      case 'stock':
        delete l.form
        delete l.sketch
        delete l.picture
        delete l.image
        if (e.kind) l.kind = e.kind
        break
      case 'move':
        if (e.on) {
          l.on = e.on
          l.at = PORTS[e.at] ? e.at : 'top'
        } else {
          delete l.on
          delete l.at
        }
        break
      case 'size':
        if (Number.isFinite(e.value) && e.value > 0) l.value = e.value
        else skip(e, 'a size is a number above 0')
        break
      case 'link':
        if (lane(e.from) && lane(e.to)) s.links = [...(s.links ?? []), { from: e.from, to: e.to, ...(e.kind ? { kind: e.kind } : {}), ...(e.label ? { label: e.label } : {}) }]
        else skip(e, 'both ends must be parts')
        break
      case 'unlink':
        s.links = (s.links ?? []).filter((k) => !(k.from === e.from && k.to === e.to))
        break
      case 'title':
        if (e.title) (s.title = String(e.title)), (s.headline = String(e.title))
        break
      case 'walk':
        if (Array.isArray(e.steps) && e.steps.length) s.steps = e.steps
        break
      case 'panels':
        if (Array.isArray(e.panels)) s.panels = e.panels
        break
    }
    applied.push(`${e.op}${e.id ? ` ${e.id}` : e.part?.id ? ` ${e.part.id}` : ''}`)
  }
  const out = checkSpec(s)
  return { ...out, applied, skipped }
}

/** The figure as the repair model reads it: what each part is, where it stands, what it says. Never the solver's coordinates. */
export function blueprintOf(spec) {
  return {
    form: spec.form,
    ...(spec.archetype ? { archetype: spec.archetype } : {}),
    title: spec.title,
    parts: spec.lanes.map((l) => Object.fromEntries(Object.entries({ id: l.id, label: l.label, kind: l.kind, on: l.on, at: l.at, value: l.value, unit: l.unit, then: l.then, note: l.note, tags: l.cells, form: l.form, sketch: l.sketch ? `${l.sketch.length} lines` : undefined, picture: l.picture }).filter(([, v]) => v !== undefined))),
    links: (spec.links ?? []).map((k) => ({ from: k.from, to: k.to, kind: k.kind })),
    walk: spec.steps.map((st) => ({ focus: st.focus, say: st.say })),
    panels: spec.panels ?? [],
  }
}

const REPAIR_SYSTEM = [
  'You repair a figure Sundial drew. You get its blueprint (what was drawn) and a critique of the rendered picture (from a vision judge or from the owner). Reply with the few edits that fix what the critique names, and nothing else; the engine applies them and draws again.',
  'Edits (JSON objects):',
  '- {"op": "add", "part": {"id", "label", "kind"?, "on"?, "at"?, "note"?, "form"?, "sketch"?, "value"?, "unit"?}}: a missing part.',
  '- {"op": "drop", "id"}: a part that clutters or is wrong.',
  '- {"op": "label", "id", "label"} and {"op": "note", "id", "note"}: a name, or the 2 to 5 word fact under it (a number with its unit when there is one).',
  `- {"op": "form", "id", "form"}: redraw a part from blocks so it looks like itself. A block is {"shape", "size", "at", "count"?, "mirror"?, "parts"?}; shapes ${Object.keys(BLOCKS).join(', ')}; size xs, s, m, l, xl or [w, h, d]; at ${Object.keys(PORTS).join(', ')}.`,
  '- {"op": "sketch", "id", "sketch": [[x1, y1, x2, y2, ...], ...]}: draw a part by hand when no blocks can (a face, a leaf, a coastline): up to 16 polylines in a 0 to 100 box, y down, the first its outline.',
  '- {"op": "picture", "id", "picture"}: when pictures are on, draw a plain part from a generated image of the words given ("a human heart, front view"); Sundial traces it into its line.',
  '- {"op": "stock", "id", "kind"}: back to a stock kind of the archetype.',
  '- {"op": "move", "id", "on", "at"}: stand a part on another at a port (on: null frees it).',
  '- {"op": "size", "id", "value"}: its relative weight.',
  '- {"op": "link", "from", "to", "kind"?} and {"op": "unlink", "from", "to"}.',
  '- {"op": "title", "title"}, {"op": "walk", "steps": [{"focus": [ids], "say"}]}, {"op": "panels", "panels": [{"label", "kind": "number", "value", "unit"} or {"label", "kind": "status", "word"}]}.',
  'Rules: at most 8 edits. Fix the weakest thing first. Keep what works. Names are words the owner would say; facts are true. Never a position, a colour or a camera. No em dashes.',
  'Reply with JSON only: {"edits": [...]}',
].join('\n')

/** The messages for one repair: the blueprint, the critique, and what the last try could not do. */
export function repairMessages(spec, critique, skipped = []) {
  return [
    { role: 'system', content: REPAIR_SYSTEM },
    { role: 'user', content: `The question: ${spec.ask || spec.title}\n\nBlueprint:\n${JSON.stringify(blueprintOf(spec))}\n\nCritique of the rendered picture:\n${critique}${skipped.length ? `\n\nLast time these edits could not be applied: ${skipped.join('; ')}` : ''}` },
  ]
}

/**
 * Every plain part that asks for a picture and has none yet gets one from
 * `picture(words)` (an image URL, or null), at most `limit` per figure, in
 * parallel; with `auto`, every plain thing-like part asks for one. Mutates the spec's lanes; resolves what failed, in words.
 */
export async function resolvePictures(spec, picture, limit = 6, { auto = false } = {}) {
  // Pictures are for a concrete subject: an idea, a process or a flow is drawn in line and blocks only.
  if (!picture || spec.concrete === false) return []
  const plain = new Set(['part', 'box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'prism', 'observer', 'droplet', 'field', 'cloud', undefined])
  // Auto: with a picture source at hand, every plain thing-like part with no hand drawing is drawn from a picture of its own name;
  // an object's parts are one assembly, so they get a picture only when the blueprint asks.
  const thing = new Set(['box', 'sphere', 'cylinder', 'cone', 'torus', 'prism', 'observer', 'droplet'])
  if (auto) for (const l of spec.lanes) if (!l.picture && !l.sketch && thing.has(l.kind) && spec.form === 'scene') l.picture = `${l.label}, as drawn in a figure of ${spec.title}`
  const asked = spec.lanes.filter((l) => l.picture && !l.image && plain.has(l.kind)).slice(0, limit)
  const failed = []
  await Promise.all(asked.map(async (l) => {
    const url = await picture(l.picture).catch((e) => (failed.push(`${l.id}: ${e.message}`), null))
    if (url) l.image = url
  }))
  return failed
}

/** The edits out of a model's reply; [] when there are none. */
export function parseEdits(text) {
  const s = String(text ?? '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return []
  try {
    const out = JSON.parse(s.slice(a, b + 1))
    return Array.isArray(out?.edits) ? out.edits.filter((e) => e && typeof e === 'object') : []
  } catch {
    return []
  }
}
