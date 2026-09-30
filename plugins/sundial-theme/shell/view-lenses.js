// The shelf of lenses: the questions a lens card encodes, kept past the card.
import { el } from './surfaces.js'
import { stackedBlock } from './blocks.js'

/**
 * The shelf: every lens ever composed, whether or not its card is up.
 *
 * A lens is a question someone worked out how to ask — which read tool, which
 * filters, which shape. The card was always disposable (remove, clear, load a
 * scene all take it) and the question went with it, so the same lens had to be
 * invented again from prose. The rows were always re-read, so nothing kept here
 * is stale: what is kept is the recipe, and putting one back is one press.
 */
export function lensesPanel(d) {
  const rows = Array.isArray(d.lenses) ? d.lenses : []
  if (rows.length === 0) return [el('div', { class: 'none', text: 'No lens yet. Ask Gnomon to show something as a shape — a ranking, a count over time, a filtered list — and it lands here.' })]

  // The recipe, in the same words the card's own foot uses, so a lens reads the
  // same on the shelf as it does on the board.
  const recipe = (spec) =>
    [
      String(spec.source?.tool ?? '').replace(/^gnomon_/, ''),
      spec.where?.length ? `${spec.where.length} filter${spec.where.length === 1 ? '' : 's'}` : null,
      spec.group ? `by ${spec.group}` : null,
      spec.sort ? `sorted ${spec.sort}` : null,
      spec.show && spec.show !== 'table' ? spec.show : null,
    ]
      .filter(Boolean)
      .join(' · ')

  const putUp = (row) =>
    el('button', {
      type: 'button',
      class: 'act',
      text: 'Put it up',
      onclick: (event) => {
        event.currentTarget.disabled = true
        fetch('/gnomon/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'place', id: row.id, kind: 'lens', text: row.spec }) }).catch(() => {})
      },
    })

  const block = (row, i) => {
    let spec = {}
    // A spec that will not parse still belongs on the shelf under its title;
    // the card is the half that fails to draw, and it says so itself.
    try {
      spec = JSON.parse(row.spec)
    } catch {}
    return stackedBlock({
      index: i,
      headline: row.title || row.id,
      subline: spec.note ?? null,
      meta: [recipe(spec), row.at ? new Date(row.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null],
      acts: row.up ? el('span', { class: 'verdict-done', text: 'on the board' }) : putUp(row),
    })
  }

  return [
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `${rows.length} lens${rows.length === 1 ? '' : 'es'}, newest first` }),
      el('div', { class: 'blocks' }, rows.map(block)),
    ]),
  ]
}
