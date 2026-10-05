// A tool's JSON, drawn for a person rather than dumped.
//
// The detail under a tool line used to be `name({…})` and the raw result in a
// monospace block — a wall of braces for a question like "what did I do
// yesterday". This reads the same JSON as: what was asked (a few key: value
// lines), and what came back — a list of objects as a small table, an object
// as labelled lines, a list of words as a sentence. The raw text stays one
// click away, because the shape is a reading aid, never a replacement.
//
// `jsonShape` is pure (and tested); `jsonNode` only draws what it decided.
//
// Named exports only.
import { el } from './surfaces.js'

const MAX_ROWS = 25
const MAX_COLS = 6
const MAX_KEYS = 24
const MAX_DEPTH = 2

const isPlain = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
const label = (key) => {
  const words = String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Parse a result's text, forgiving the "… (N more characters)" tail a long result is cut with. */
export function parseResult(text) {
  const raw = String(text ?? '').trim()
  for (const candidate of [raw, raw.replace(/\n… \(\d+ more characters\)$/, '')]) {
    try {
      return { ok: true, value: JSON.parse(candidate) }
    } catch {
      // not JSON, or cut mid-structure
    }
  }
  return { ok: false, value: raw }
}

/** A value → what to draw: text, list, table, fields. */
export function jsonShape(value, depth = 0) {
  if (isPlain(value)) return { kind: 'text', text: plainText(value) }
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'text', text: 'nothing', quiet: true }
    if (value.every(isPlain)) return { kind: 'list', items: value.slice(0, MAX_ROWS).map(plainText), more: Math.max(0, value.length - MAX_ROWS) }
    const objects = value.filter((v) => v !== null && typeof v === 'object' && !Array.isArray(v))
    if (objects.length === value.length) {
      // Columns: the keys that hold plain values, in first-seen order.
      // Machine ids and columns that are empty in every row are noise to a reader;
      // they stay in Raw.
      const keys = []
      for (const row of objects) for (const [k, v] of Object.entries(row)) if (isPlain(v) && !keys.includes(k)) keys.push(k)
      const worth = keys.filter((k) => !/^id$|Id$|_id$/.test(k) && objects.some((row) => row[k] !== null && row[k] !== undefined && row[k] !== ''))
      const columns = (worth.length > 0 ? worth : keys).slice(0, MAX_COLS)
      if (columns.length > 0) {
        return {
          kind: 'table',
          columns: columns.map(label),
          rows: objects.slice(0, MAX_ROWS).map((row) => columns.map((k) => (isPlain(row[k]) ? plainText(row[k]) : row[k] === undefined ? '' : compact(row[k])))),
          more: Math.max(0, value.length - MAX_ROWS),
        }
      }
    }
    return { kind: 'list', items: value.slice(0, MAX_ROWS).map(compact), more: Math.max(0, value.length - MAX_ROWS) }
  }
  if (depth >= MAX_DEPTH) return { kind: 'text', text: compact(value) }
  const entries = Object.entries(value)
  return {
    kind: 'fields',
    fields: entries.slice(0, MAX_KEYS).map(([k, v]) => ({ key: label(k), value: jsonShape(v, depth + 1) })),
    more: Math.max(0, entries.length - MAX_KEYS),
  }
}

/** A shape → nodes. */
export function jsonNode(shape) {
  switch (shape.kind) {
    case 'text':
      return el('span', { class: shape.quiet ? 'jv-text jv-quiet' : 'jv-text', text: shape.text })
    case 'list':
      return el('span', { class: 'jv-list' }, [el('span', { text: shape.items.join(' · ') }), more(shape.more)])
    case 'table':
      return el('div', { class: 'jv-table-wrap' }, [
        el('table', { class: 'jv-table' }, [
          el('thead', {}, [el('tr', {}, shape.columns.map((c) => el('th', { text: c })))]),
          el('tbody', {}, shape.rows.map((r) => el('tr', {}, r.map((cell) => el('td', { text: cell }))))),
        ]),
        more(shape.more, 'rows'),
      ])
    case 'fields':
      return el('dl', { class: 'jv-fields' }, [
        ...shape.fields.flatMap(({ key, value }) => [el('dt', { text: key }), el('dd', {}, [jsonNode(value)])]),
        ...(shape.more ? [el('dt', { text: '' }), el('dd', {}, [more(shape.more, 'fields')])] : []),
      ])
    default:
      return el('span', {})
  }
}

function more(n, what = 'more') {
  return n > 0 ? el('span', { class: 'jv-more', text: what === 'more' ? ` +${n} more` : `+${n} more ${what}` }) : null
}
function plainText(v) {
  if (v === null) return '—'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
  const s = String(v)
  // An ISO timestamp reads as a local time, not as a machine stamp.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  return s.length > 160 ? `${s.slice(0, 159)}…` : s
}
function compact(v) {
  const s = JSON.stringify(v)
  return s.length > 80 ? `${s.slice(0, 79)}…` : s
}
