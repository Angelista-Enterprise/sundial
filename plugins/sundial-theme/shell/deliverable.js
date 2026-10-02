// ── Deliverables ──────────────────────────────────────────────────────────
// A file Gnomon is handing over, drawn where it was handed over. This is the
// whole point of the `present` tool: a path in a sentence is not a delivery —
// the owner has to read it, remember it, and go somewhere else to open it.
//
// dsh copies nothing, so this card is a POINTER, not an attachment. The label
// says so, because "download" would promise a snapshot that does not exist:
// clicking tomorrow gives tomorrow's contents, and a file since deleted gives
// an honest 404 from the route rather than a stale copy.
import { el } from './surfaces.js'

/** The card for a `deliverable` frame of session `sessionId`, or null when it names no file. */
export function deliverableCard(frame, sessionId) {
  if (frame.files.length === 0) return null
  return el('div', { class: 'deliverable' }, [
    el('div', { class: 'deliverable-head', text: frame.files.length === 1 ? 'Gnomon made you a file' : `Gnomon made you ${frame.files.length} files` }),
    ...frame.files.map((file) =>
      el('div', { class: 'deliverable-file' }, [
        el('a', {
          class: 'deliverable-name',
          // The session is part of the request because the session log IS the
          // server's allowlist — the route will not serve a path this session
          // never presented.
          href: `/gnomon/api/deliverable?session=${encodeURIComponent(sessionId ?? '')}&path=${encodeURIComponent(file.path)}`,
          download: file.name,
          // The full path, because on this machine that is how the owner finds
          // it in a terminal or a Finder window.
          title: file.path,
          text: file.name,
        }),
        file.description ? el('p', { class: 'deliverable-why', text: file.description }) : null,
      ]),
    ),
  ])
}
