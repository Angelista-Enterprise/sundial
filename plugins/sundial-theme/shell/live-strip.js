// The live strip: every thread other than this one with a turn running (the live channel's `run` frames).
//
// Named exports only.

import { el } from './surfaces.js'
import { elapsed } from './tool-line.js'

const RUN_DONE = { complete: 'done', aborted: 'stopped', error: 'failed' }

/** Wire the strip; hand back how to draw it and how to take the live channel's `runs` and `run` frames. */
export function mountLiveStrip({ state, $, COMPANION_SESSION_ID, openSession, openThreads }) {
  const runs = new Map()
  let runClock = null
  function drawRuns() {
    const strip = $('live-strip')
    const shown = document.documentElement.dataset.overlay ? [] : [...runs.values()].filter((run) => run.id !== state.sessionId)
    const name = (run) => (run.id === COMPANION_SESSION_ID ? 'Gnomon' : state.rows.find((row) => row.id === run.id)?.title || run.title || 'Side thread')
    strip.hidden = shown.length === 0
    strip.replaceChildren(
      ...shown.slice(0, 3).map((run) =>
        el('button', { type: 'button', class: 'live-run', 'data-done': run.done, title: `${name(run)}: ${run.step ?? 'starting'}`, onclick: () => openSession(run.id) }, [
          el('span', { class: 'dot' }),
          el('span', { class: 'live-run-name', text: name(run) }),
          el('span', { class: 'live-run-time', text: run.done !== null ? RUN_DONE[run.done] ?? 'ended' : elapsed(Date.now() - run.since), 'data-since': run.done === null ? run.since : null }),
          el('span', { class: 'live-run-step', text: run.step ?? 'Starting…' }),
        ]),
      ),
      ...(shown.length > 3 ? [el('button', { type: 'button', class: 'live-more', text: `+${shown.length - 3}`, title: 'All threads', onclick: () => openThreads(true) })] : []),
    )
    const ticking = shown.some((run) => run.done === null)
    if (ticking && runClock === null) runClock = setInterval(() => { for (const t of strip.querySelectorAll('[data-since]')) t.textContent = elapsed(Date.now() - Number(t.dataset.since)) }, 1000)
    if (!ticking && runClock !== null) {
      clearInterval(runClock)
      runClock = null
    }
  }
  function runFrame(frame) {
    if (frame.type === 'runs') {
      runs.clear()
      for (const run of frame.runs ?? []) runs.set(run.id, run)
    } else {
      runs.set(frame.id, frame)
      // Done shows for a moment, then goes (unless a new turn took its place).
      if (frame.done !== null) setTimeout(() => runs.get(frame.id) === frame && runs.delete(frame.id) && drawRuns(), 4000)
    }
    drawRuns()
  }
  return { drawRuns, runFrame }
}
