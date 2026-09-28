// A lens: a small, declarative view over what a read tool returns.
//
// Gnomon composes one when it wants to EXPLAIN something with a shape rather
// than a paragraph — "commits per project this week", "moments after 22:00",
// "the ten longest stretches" — and the client draws it as a card that keeps
// re-reading, so the explanation stays true after the conversation moves on.
//
// Pure: the same module runs on the host (to validate and preview a lens
// before it is placed) and in the browser (to draw it). No DOM in here.

/** The shapes a lens can take. `table` is the honest default. */
export const LENS_SHOWS = ['table', 'bars', 'stat', 'dots']
/** The comparisons a `where` clause may use. */
export const LENS_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'since', 'exists']
/** The aggregates a `group` may fold with. */
export const LENS_AGGS = ['count', 'sum', 'avg', 'min', 'max']

/** `a.b[0].c` → the value at that path, or undefined. */
export function pick(value, path) {
  if (!path) return value
  return String(path)
    .split(/\.|\[(\d+)\]/)
    .filter((part) => part !== undefined && part !== '')
    .reduce((cur, key) => (cur === null || cur === undefined ? undefined : cur[key]), value)
}

/** The first array found in a tool's answer, when the lens does not say which. */
export function firstRows(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v
    for (const v of Object.values(value)) {
      const deeper = v && typeof v === 'object' ? firstRows(v) : []
      if (deeper.length) return deeper
    }
  }
  return []
}

/** `since` accepts an ISO instant or a relative span: 7d, 36h, 90m. */
function sinceMs(value, now) {
  const m = /^(\d+)([dhm])$/.exec(String(value))
  if (m) return now - Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2]]
  const t = Date.parse(String(value))
  return Number.isNaN(t) ? -Infinity : t
}

function test(row, clause, now) {
  const v = pick(row, clause.field)
  const want = clause.value
  switch (clause.op ?? 'eq') {
    case 'eq':
      return v == want // eslint-disable-line eqeqeq -- "3" and 3 are the same cell
    case 'ne':
      return v != want // eslint-disable-line eqeqeq
    case 'gt':
      return Number(v) > Number(want)
    case 'gte':
      return Number(v) >= Number(want)
    case 'lt':
      return Number(v) < Number(want)
    case 'lte':
      return Number(v) <= Number(want)
    case 'contains':
      return String(v ?? '').toLowerCase().includes(String(want).toLowerCase())
    case 'in':
      return Array.isArray(want) && want.some((w) => w == v) // eslint-disable-line eqeqeq
    case 'since':
      return Date.parse(String(v)) >= sinceMs(want, now)
    case 'exists':
      return v !== null && v !== undefined && v !== ''
    default:
      return true
  }
}

function fold(rows, spec) {
  const fn = spec.agg?.fn ?? 'count'
  const field = spec.agg?.field
  const groups = new Map()
  for (const row of rows) {
    const key = String(pick(row, spec.group) ?? '—')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const value = (list) => {
    if (fn === 'count') return list.length
    const nums = list.map((r) => Number(pick(r, field))).filter((n) => Number.isFinite(n))
    if (nums.length === 0) return null
    if (fn === 'sum') return nums.reduce((a, b) => a + b, 0)
    if (fn === 'avg') return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100
    if (fn === 'min') return Math.min(...nums)
    return Math.max(...nums)
  }
  const label = fn === 'count' ? 'count' : `${fn} ${field}`
  return {
    columns: [spec.group, label],
    rows: [...groups.entries()].map(([k, list]) => ({ [spec.group]: k, [label]: value(list) })),
  }
}

/**
 * Run a lens over a tool's answer. Returns `{ columns, rows, total }` — rows
 * after where/group/sort/limit, `total` the count before the limit.
 */
export function runLens(spec, data, now = Date.now()) {
  const source = spec.pick ? pick(data, spec.pick) : firstRows(data)
  let rows = Array.isArray(source) ? source.filter((r) => r !== null && typeof r === 'object') : []
  for (const clause of Array.isArray(spec.where) ? spec.where : []) rows = rows.filter((r) => test(r, clause, now))
  let columns = Array.isArray(spec.columns) && spec.columns.length ? spec.columns : [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => rows.some((r) => typeof r[k] !== 'object' || r[k] === null)).slice(0, 8)
  if (spec.group) ({ columns, rows } = fold(rows, spec))
  if (spec.sort) {
    const desc = String(spec.sort).startsWith('-')
    const key = String(spec.sort).replace(/^-/, '')
    rows = [...rows].sort((a, b) => {
      const av = pick(a, key)
      const bv = pick(b, key)
      const order = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true })
      return desc ? -order : order
    })
  }
  // Columns the spec asked for that no row has.
  //
  // `fmt(undefined)` draws an em dash and the tool's own renderer printed the
  // literal string `undefined`, so a lens asked for a field called `day` when
  // the field is `key` rendered a full table of nothing and read as data. The
  // check cannot live in `lensProblem` — it runs before the tool answers, and
  // only the answer knows the field names. Skipped when grouping (which names
  // its own columns) and when nothing came back (every column is absent from
  // no rows, which says nothing about the spec).
  const unknown = !spec.group && Array.isArray(spec.columns) && spec.columns.length && rows.length > 0 ? spec.columns.filter((c) => !rows.some((r) => c in r)) : []
  const total = rows.length
  const limit = Number.isInteger(spec.limit) && spec.limit > 0 ? spec.limit : 50
  return { columns, rows: rows.slice(0, limit), total, unknown, fields: [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 24) }
}

/** Why a spec cannot be a lens, or null when it can. */
export function lensProblem(spec, isReadTool) {
  if (!spec || typeof spec !== 'object') return 'a lens is an object'
  if (typeof spec.title !== 'string' || spec.title.trim() === '') return 'a lens needs a title'
  if (!spec.source || typeof spec.source.tool !== 'string') return 'a lens needs source.tool'
  if (!isReadTool(spec.source.tool)) return `${spec.source.tool} is not a read tool`
  if (spec.show !== undefined && !LENS_SHOWS.includes(spec.show)) return `show must be one of ${LENS_SHOWS.join(', ')}`
  for (const c of Array.isArray(spec.where) ? spec.where : []) {
    if (typeof c.field !== 'string') return 'every where clause needs a field'
    if (c.op !== undefined && !LENS_OPS.includes(c.op)) return `where.op must be one of ${LENS_OPS.join(', ')}`
  }
  if (spec.agg && !LENS_AGGS.includes(spec.agg.fn)) return `agg.fn must be one of ${LENS_AGGS.join(', ')}`
  if (spec.agg && spec.agg.fn !== 'count' && typeof spec.agg.field !== 'string') return `agg ${spec.agg.fn} needs a field`
  return null
}
