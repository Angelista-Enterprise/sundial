// A lens, drawn: the card that keeps a view alive.
//
// The spec (see lens-core.js) says which read tool, which rows, which shape.
// This draws it, and re-reads on the board's live beat, redrawing only when
// the rows changed — so a lens Gnomon placed on Tuesday still tells the truth
// on Friday, and says when it last checked.
import { chart, el, grid } from './surfaces.js'
import { runLens } from './lens-core.js'

const read = async (tool, args) => {
  const r = await fetch(`/gnomon/api/read?tool=${encodeURIComponent(tool)}&args=${encodeURIComponent(JSON.stringify(args ?? {}))}`, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(String(r.status))
  return r.json()
}

const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : String(v))

/** The first numeric column, for a shape that needs one number per row. */
const numericColumn = (columns, rows) => columns.find((c) => rows.some((r) => typeof r[c] === 'number')) ?? null
/** The first text column, for the label beside it. */
const labelColumn = (columns, rows, not) => columns.find((c) => c !== not && rows.some((r) => typeof r[c] === 'string')) ?? columns[0]

function draw(spec, result) {
  const { columns, rows, total } = result
  if (rows.length === 0) return el('div', { class: 'none', text: spec.empty ?? 'Nothing matches this lens right now.' })
  const show = spec.show ?? 'table'
  if (show === 'stat') {
    const col = numericColumn(columns, rows) ?? columns[0]
    // One number: the aggregate if grouped to one row, else the first row's value.
    const value = rows.length === 1 ? rows[0][col] : rows.reduce((n, r) => n + (typeof r[col] === 'number' ? r[col] : 0), 0)
    return el('div', { class: 'lens-stat' }, [el('span', { class: 'numeral', text: fmt(value) }), el('span', { class: 'observed', text: spec.unit ?? col })])
  }
  if (show === 'bars') {
    const col = numericColumn(columns, rows)
    const lab = labelColumn(columns, rows, col)
    if (col === null) return grid({ columns: columns.map((key) => ({ key, label: key })), rows })
    return chart({ x: rows.map((r) => fmt(r[lab])), series: [{ label: col, values: rows.map((r) => (typeof r[col] === 'number' ? r[col] : null)), mark: 'observed', unit: spec.unit ?? '' }] })
  }
  if (show === 'dots') {
    // A time list: when, then what. The first date-like column is the when.
    const when = columns.find((c) => rows.some((r) => /^\d{4}-\d\d-\d\d/.test(String(r[c])))) ?? columns[0]
    const what = columns.filter((c) => c !== when).slice(0, 2)
    return el(
      'div',
      { class: 'lens-dots' },
      rows.map((r) => el('div', { class: 'row' }, [el('span', { class: 'moment-when', text: fmt(r[when]) }), el('span', { class: 'row-name', text: what.map((c) => fmt(r[c])).join(' · ') })])),
    )
  }
  return el('div', {}, [
    grid({ columns: columns.map((key) => ({ key, label: key, type: rows.some((r) => typeof r[key] === 'number') ? 'number' : 'text' })), rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, fmt(r[c])]))) }),
    total > rows.length ? el('p', { class: 'panel-note', text: `${total - rows.length} more not shown.` }) : null,
  ])
}

/** The node for one lens card. Fills itself, and follows the live beat. */
export function lensNode(spec) {
  const body = el('div', { class: 'lens-body' }, [el('div', { class: 'reading', text: 'Reading…' })])
  const foot = el('div', { class: 'lens-foot' })
  const node = el('div', { class: 'lens' }, [
    spec.note ? el('p', { class: 'lens-note', text: spec.note }) : null,
    body,
    foot,
  ])
  let last = ''
  const refresh = async () => {
    try {
      const data = await read(spec.source.tool, spec.source.args)
      const result = runLens(spec, data)
      const key = JSON.stringify(result.rows)
      if (key !== last) {
        last = key
        // A shape may be one node or several (a chart and its legend).
        body.replaceChildren(...[].concat(draw(spec, result)).filter(Boolean))
      }
      // The recipe, and the word LIVE.
      //
      // A lens pasted onto the board as plain text is a frozen lie — it was
      // right at the minute it was written and says nothing about when. This
      // card is the opposite and had no way to say so, so the two were
      // indistinguishable on the same board. The recipe beside it (tool →
      // filters → group → sort) is what makes wrong-looking output checkable
      // without opening the spec.
      foot.replaceChildren(
        el('span', { class: 'lens-live', text: 'LIVE' }),
        el('span', {
          text: `${spec.source.tool.replace(/^gnomon_/, '')}${spec.where?.length ? ` · ${spec.where.length} filter${spec.where.length === 1 ? '' : 's'}` : ''}${spec.group ? ` · by ${spec.group}` : ''}${spec.sort ? ` · sorted ${spec.sort}` : ''} · re-read ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
        }),
      )
    } catch {
      if (last === '') body.replaceChildren(el('div', { class: 'none', text: 'This lens could not be read.' }))
    }
  }
  refresh()
  // The board's beat, from app.js; the listener dies with the node.
  const onBeat = () => (node.isConnected ? refresh() : document.removeEventListener('gnomon:beat', onBeat))
  document.addEventListener('gnomon:beat', onBeat)
  return node
}

/** Parse a lens card's text; null when it is not a lens. */
export function lensSpec(text) {
  try {
    const spec = JSON.parse(text ?? '')
    return spec && typeof spec === 'object' && spec.source ? spec : null
  } catch {
    return null
  }
}
