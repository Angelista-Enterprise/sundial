// The command bar. Press `/` (or click Find): type a few letters, pick, done.
//
// One box over the head that knows every card, instrument and view by name AND
// by what it is about, and falls back to searching the record for whatever you
// typed. It replaces
// no menu; it is the fast road beside them, for hands that prefer keys, and
// it needs no chord to remember.
import { el } from './surfaces.js'

let open = null

/**
 * @param {{ label: string, group: string, keywords?: string, run: () => void }[]} items
 * @param {(query: string) => void} onSearch — what to do with text that matched nothing
 */
export function openPalette(items, onSearch) {
  if (open) return void open.field.focus()
  const field = el('input', { class: 'palette-field', type: 'text', placeholder: 'Find a card, a person, a day…', 'aria-label': 'Find', autocomplete: 'off', spellcheck: 'false' })
  const list = el('div', { class: 'palette-list', role: 'listbox' })
  // The keys, written down. Nobody guesses a keyboard; a bar that says what the
  // three keys do costs one line and removes the whole question.
  const key = (k, what) => el('span', { class: 'palette-hint' }, [el('kbd', { text: k }), el('span', { text: what })])
  const foot = el('div', { class: 'palette-foot' }, [key('↑↓', 'move'), key('↵', 'open'), key('esc', 'close')])
  const box = el('div', { class: 'palette', role: 'dialog', 'aria-label': 'Find' }, [field, list, foot])
  const veil = el('div', { class: 'palette-veil' }, [box])
  let rows = []
  let at = 0
  const close = () => {
    veil.remove()
    open = null
  }
  const draw = () => {
    const q = field.value.trim().toLowerCase()
    // Name, band, AND what the card is about. Matching a name alone is why
    // the owner typed "rhythm" and got nothing: a name is the last thing
    // somebody reaches for when they want a surface — they search for the
    // subject. A label match sorts first so typing a card's own name still
    // puts it at the top rather than behind three cards that mention it.
    const named = q === '' ? items : items.filter((i) => i.label.toLowerCase().includes(q))
    const about = q === '' ? [] : items.filter((i) => !named.includes(i) && (i.group.toLowerCase().includes(q) || (i.keywords ?? '').toLowerCase().includes(q)))
    const hits = [...named, ...about]
    rows = hits.slice(0, 12).map((i) => ({ ...i }))
    if (q !== '' && rows.length < 12) rows.push({ label: `Search the record for “${field.value.trim()}”`, group: 'Explore', run: () => onSearch(field.value.trim()) })
    at = Math.min(at, Math.max(0, rows.length - 1))
    // Rows under their own heading, in the order they first appear. A kind named
    // once above its rows reads as a place you are in; the same word repeated
    // down the right edge of every row reads as noise.
    const nodes = []
    let cap = null
    rows.forEach((r, i) => {
      if (r.group !== cap) {
        cap = r.group
        nodes.push(el('div', { class: 'palette-cap', text: r.group }))
      }
      nodes.push(
        el('button', { type: 'button', class: 'palette-row', role: 'option', 'aria-selected': String(i === at), onclick: () => (close(), r.run()), onmousemove: () => i !== at && ((at = i), draw()) }, [
          el('span', { class: 'palette-label', text: r.label }),
          el('span', { class: 'palette-go', text: '↵' }),
        ]),
      )
    })
    list.replaceChildren(...(nodes.length ? nodes : [el('div', { class: 'palette-none', text: 'Nothing by that name.' })]))
    // Arrowing past the fold should not walk off the bottom of the box.
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }
  field.addEventListener('input', () => ((at = 0), draw()))
  field.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), (at = Math.min(rows.length - 1, at + 1)), draw())
    else if (e.key === 'ArrowUp') (e.preventDefault(), (at = Math.max(0, at - 1)), draw())
    else if (e.key === 'Enter') (e.preventDefault(), rows[at] && (close(), rows[at].run()))
    else if (e.key === 'Escape') (e.preventDefault(), close())
    e.stopPropagation()
  })
  veil.addEventListener('pointerdown', (e) => e.target === veil && close())
  document.body.append(veil)
  open = { field, close }
  draw()
  field.focus()
}
