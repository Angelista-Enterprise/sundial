// The thread bar's way of drawing (app.js drawThreadBar): Auto, Sketch, Studio
// or Atlas for this thread, kept by sundial-nodus (`/gnomon/api/nodus-mode`).
// The board and the overlay share the bar, so one switch serves both.
import { el } from './surfaces.js'
import { SWITCH } from '@sundial/nodus/modes/index.js'

/** What the server last said per thread, so a bar drawn again shows it at once; `writes` counts presses, so an older read never undoes a newer press. */
const known = new Map()
const writes = new Map()
/** The newest bar drawn per thread (the one on screen), so a press that lands marks it even when the bar was drawn again meanwhile. */
const bars = new Map()
const ask = (url, init) => fetch(url, { headers: { accept: 'application/json', 'content-type': 'application/json' }, ...init }).then((r) => (r.ok ? r.json() : null)).catch(() => null)

/**
 * How this thread draws: Auto, Sketch, Studio or Atlas, one small segmented
 * control, remembered with the thread. A press is marked only once the server
 * has kept it. A mode whose engine is not in yet is greyed, "not ready yet".
 */
export function modeSwitch(id, current = () => true) {
  const group = el('span', { class: 'mode-switch', role: 'radiogroup', 'aria-label': 'How this thread draws' })
  if (id === null) return group
  const draw = (body) => {
    if (!current() || !body?.modes) return
    known.set(id, body)
    group.replaceChildren(
      ...body.modes.map((m) =>
        el('button', {
          type: 'button',
          class: 'mode-opt',
          role: 'radio',
          'aria-checked': String(m.id === body.mode),
          'aria-disabled': m.ready ? null : 'true',
          'data-mode': m.id,
          title: m.ready ? m.blurb : `${m.label} is not ready yet.`,
          text: m.label,
          onclick: async (event) => {
            if (!m.ready || m.id === body.mode || group.getAttribute('aria-busy') === 'true') return
            writes.set(id, (writes.get(id) ?? 0) + 1)
            group.setAttribute('aria-busy', 'true')
            event.currentTarget.dataset.pending = ''
            const kept = await ask('/gnomon/api/nodus-mode', { method: 'POST', body: JSON.stringify({ sessionId: id, mode: m.id }) })
            group.removeAttribute('aria-busy')
            const now = kept?.mode ? kept : body
            draw(now)
            if (bars.get(id) !== draw) bars.get(id)?.(now)
          },
        }),
      ),
    )
  }
  bars.set(id, draw)
  // From the first paint: what the server last said, else Auto (a thread with no choice draws in Auto) until it answers.
  draw(known.get(id) ?? { mode: 'auto', modes: [...known.values()].at(-1)?.modes ?? SWITCH.map((m) => ({ ...m, ready: true })) })
  const seen = writes.get(id) ?? 0
  void ask(`/gnomon/api/nodus-mode?session=${encodeURIComponent(id)}`).then((body) => (writes.get(id) ?? 0) === seen && group.getAttribute('aria-busy') !== 'true' && draw(body))
  return group
}
