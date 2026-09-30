// The quiet lines a `mark` frame draws (frames.js `markFrame`): what dsh did
// around a turn — a compaction, a provider retry, a /command, a workflow, a
// goal, a past approval. Neither Gnomon's words nor a tool, so quieter than both.
import { el } from './surfaces.js'

/**
 * One `mark` frame into the transcript. One line per key: a later frame of the
 * same work updates the line it opened — its status, and its label when it has
 * one. `lines` is the key → line map the caller clears with the canvas; `into`
 * returns the turn to append to, and is only asked when a line is new.
 */
export function drawLogLine(frame, lines, into) {
  let line = frame.key ? lines.get(frame.key) : undefined
  if (line === undefined) {
    line = el('div', { class: 'log-line' }, [el('span', { class: 'log-line-label' }), el('span', { class: 'log-line-status' })])
    if (frame.key) lines.set(frame.key, line)
    into().append(line)
  }
  if (frame.label) line.firstChild.textContent = frame.label
  line.lastChild.textContent = frame.status ?? ''
  line.toggleAttribute('data-failed', frame.failed === true)
  // A long status is cut to one line; the whole of it (or the approval's reason) is on hover.
  line.title = frame.title || frame.status || ''
  return line
}
