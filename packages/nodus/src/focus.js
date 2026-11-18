// Which parts a step lights: the prototype's rule, kept because it is what
// made the picture and the sentence one thing. The ids a step names, every
// part standing in a lane it names, and any lane or meeting whose label the
// sentence says aloud. Sessions are not matched by name: "Slack" would light
// twenty bars, and the step points at the one it means.
//
// In a scene a word two parts' labels share does not light either: "Hour
// wheel" lights the hour wheel and not the belt wheel, and "Mar" in "Tue 3 Mar"
// no day of the week. A label made only of shared words lights when the
// sentence says all of them. A scene's words match whole (or plural), so
// "rain" lights the rain shower and not the raindrop or the rainbow.

import { names, words } from './spec.js'

/** Does the sentence name this label, by its own words? */
function namer(spec) {
  if (spec.form !== 'scene') return names
  const seen = new Map()
  for (const l of spec.lanes) for (const w of new Set(words(l.label))) seen.set(w, (seen.get(w) ?? 0) + 1)
  const whole = (said, w) => said.some((x) => x === w || x === `${w}s` || `${x}s` === w)
  return (say, label) => {
    const all = words(label)
    if (all.length === 0) return names(say, label)
    const said = words(say)
    const own = all.filter((w) => seen.get(w) === 1)
    return own.length ? own.some((w) => whole(said, w)) : all.every((w) => whole(said, w))
  }
}

export function focusOf(spec, step) {
  const hot = new Set(step?.focus ?? [])
  const say = step?.say ?? ''
  const named = namer(spec)
  for (const l of spec.lanes) if (named(say, l.label)) hot.add(l.id)
  for (const p of spec.parts) if (p.role === 'meeting' && names(say, p.label)) hot.add(p.id)
  for (const p of spec.parts) if (hot.has(p.lane)) hot.add(p.id)
  // A part lights its own lane's label, so the eye finds the row.
  for (const p of spec.parts) if (hot.has(p.id)) hot.add(p.lane)
  return hot
}

/** How long a step stands while the walk plays itself: reading time, never under 2.4 s. */
export const dwell = (say) => Math.max(2400, String(say).split(/\s+/).length * 330)
