// The gnomon.
//
// Gnomon's face is the thing it is named for: the rod of a sundial, on its
// plate, casting a shadow. The shadow is real — its angle is the time of day —
// and the moods are what the rod does: it leans toward you when you type, its
// shadow sweeps while it thinks, the tip lights when it has a question. No
// eyes, no smile. A colleague who is a stone instrument.
import { svg } from './surfaces.js'

const W = 72
const H = 44
const CX = 36
const BASE_Y = 34
const ROD_H = 26
const SHADOW_L = 26

export function mascot(button) {
  const shadow = svg('line', { class: 'gn-shadow', x1: CX, y1: BASE_Y, x2: CX, y2: BASE_Y + 5 })
  const rod = svg('g', { class: 'gn-rod' }, [
    svg('line', { x1: CX, y1: BASE_Y, x2: CX, y2: BASE_Y - ROD_H }),
    svg('rect', { class: 'gn-tip', x: CX - 2, y: BASE_Y - ROD_H - 2, width: 4, height: 4 }),
  ])
  const figure = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' }, [
    // The plate, with its hour graduations: a hairline ellipse and a few ticks.
    svg('ellipse', { class: 'gn-plate', cx: CX, cy: BASE_Y, rx: 30, ry: 6 }),
    ...[-24, -12, 0, 12, 24].map((dx) => svg('line', { class: 'gn-tick', x1: CX + dx, y1: BASE_Y + (dx === 0 ? 6 : 5.4), x2: CX + dx, y2: BASE_Y + (dx === 0 ? 8.5 : 7.4) })),
    shadow,
    rod,
  ])
  button.replaceChildren(figure)

  /** The shadow the sun would cast now: left in the morning, right in the evening, gone at night. */
  const tick = () => {
    const now = new Date()
    const hour = now.getHours() + now.getMinutes() / 60
    const up = hour >= 6 && hour <= 20
    figure.classList.toggle('gn-night', !up)
    if (!up) return
    const a = ((hour - 13) / 7) * (Math.PI / 2) // −90° at 6h … +90° at 20h
    const len = SHADOW_L * (0.35 + 0.65 * Math.abs(Math.sin(a)))
    shadow.setAttribute('x2', String(CX + len * Math.sin(a)))
    shadow.setAttribute('y2', String(BASE_Y + 5 * Math.cos(a) * 0.6 + 1))
  }
  tick()
  setInterval(tick, 60_000)

  return {
    /** idle | listening | thinking | speaking | asking | away */
    mood(name) {
      if (button.dataset.mood === name) return
      button.dataset.mood = name
      // The face's gnomon wears the same mood; the sheet reads it from the root.
      document.documentElement.dataset.mood = name
    },
  }
}
