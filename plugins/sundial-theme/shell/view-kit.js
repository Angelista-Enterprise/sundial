// The views' shared grammar: durations and dates as the owner reads them, a panel, a table, the focus bar and the week strip.
import { el } from './surfaces.js'
import { read } from './read.js'
import { iconLabel } from './icons.js'
import { share } from './trace.js'

/** `468` → `7h 48m`, and `0` → `—`: an absent value is a dash, never a zero. */
export function hm(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0))
  if (total === 0) return '—'
  const hours = Math.floor(total / 60)
  const rest = total % 60
  return hours > 0 ? `${hours}h ${String(rest).padStart(2, '0')}m` : `${rest}m`
}

export function longDate(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number)
  if (!y || !m || !d) return ''
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
}

export const num = (value, digits = 0) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—')

/** A duration in milliseconds, as seconds — the unit every latency on the Ledger is read in. */
export const secs = (ms) => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : '—')

/** An instant, in the reader's own locale. Dropped to a dash rather than "Invalid Date" when a row carries no timestamp. */
export const when = (iso) => {
  const at = iso ? new Date(iso) : null
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

export const pct = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—')

// Every reading goes through the shared reader: one request per route however
// many cards want it, and a name in the head while it is in flight. See read.js.
export const json = (url) => read(url)

/**
 * A titled block of `label → value` rows. The grammar every instrument uses.
 *
 * A label may be a plain string or `[iconName, string]`, which draws the icon
 * beside the word. Never the icon alone — see `icons.js`.
 */
export function panel(title, rows, note) {
  return el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title', text: title }),
    el(
      'div',
      { class: 'panel-rows' },
      rows
        .filter(Boolean)
        .map(([label, value, hint]) =>
          el('div', { class: 'panel-row' }, [
            Array.isArray(label) ? iconLabel(label[0], label[1], { className: 'panel-label' }) : el('span', { class: 'panel-label', text: label }),
            el('span', { class: 'panel-value', text: String(value) }),
            hint ? el('span', { class: 'panel-hint', text: hint }) : null,
          ]),
        ),
    ),
    note ? el('p', { class: 'panel-note', text: note }) : null,
  ])
}

/**
 * Rows, with an optional second row folded under each one.
 *
 * `expand(row)` returns the nodes for that fold. A table without it is the
 * table that was here before. With it, the row becomes the summary and the
 * fold carries the rest, so a list stays scannable AND a row can answer for
 * itself — the Day's table had eight columns and no way to ask a row anything,
 * which is what the owner met as "needs more info per row".
 *
 * `expand` returning an empty array means this row has nothing more to say, and
 * it stays a plain row — no marker, no cursor, no empty panel under it. That is
 * also why the fold's contents are built at render: whether there IS anything
 * is the same question as what it is. They are attached on first open, so the
 * cost is a few small nodes per row, not a laid-out panel per row.
 */
export function table(columns, rows, expand) {
  const body = el('tbody', {})
  for (const row of rows) {
    // A cell may return a Node (a pair of verdict acts, say) as well as text.
    const tr = el(
      'tr',
      {},
      columns.map((c) => {
        const value = c.cell(row)
        return value instanceof Node ? el('td', { class: c.num ? 'num' : null }, [value]) : el('td', { class: c.num ? 'num' : null, text: value })
      }),
    )
    body.append(tr)
    if (!expand) continue
    // Every row in a foldable table carries a mark, and they all start at the
    // same place. A row with nothing more to say gets the quiet one rather than
    // no mark at all — without it the row lost its indent and stepped out of
    // the column the others line up in.
    tr.classList.add('grid-row')
    const parts = expand(row)
    if (parts.length === 0) {
      tr.classList.add('grid-quiet')
      tr.title = 'Nothing recorded beyond this row'
      continue
    }
    const cell = el('td', { colspan: String(columns.length) })
    const fold = el('tr', { class: 'grid-fold', hidden: 'hidden' }, [cell])
    body.append(fold)
    tr.classList.add('grid-openable')
    tr.setAttribute('tabindex', '0')
    tr.setAttribute('role', 'button')
    tr.setAttribute('aria-expanded', 'false')
    const toggle = () => {
      // Built on first open, not on render: sixty of these drawn for the one
      // the owner will read is sixty times the work.
      if (cell.childNodes.length === 0) cell.append(...parts)
      fold.hidden = !fold.hidden
      tr.classList.toggle('is-open', !fold.hidden)
      tr.setAttribute('aria-expanded', String(!fold.hidden))
    }
    tr.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('[data-explore], a, button')) return
      toggle()
    })
    tr.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggle()
    })
  }
  return el('div', { style: { overflowX: 'auto' } }, [
    el('table', { class: 'grid' }, [el('thead', {}, el('tr', {}, columns.map((c) => el('th', { class: c.num ? 'num' : null, text: c.label })))), body]),
  ])
}

/** Motion is a courtesy, not a requirement: honour the system's request to skip it. */
export const stillness = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A number that arrives rather than appears. Counts from zero to the value over
 * `ms`, formatting each frame with `format`. Under reduced motion it just lands.
 */
export function countUp(node, value, format, ms = 700) {
  if (stillness() || !(value > 0)) {
    node.textContent = format(value)
    return
  }
  const t0 = performance.now()
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms)
    const eased = 1 - Math.pow(1 - k, 3)
    node.textContent = format(value * eased)
    if (k < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/**
 * A bar that grows to its share after it is on the page, so the growth is seen.
 * `share` is 0…1. The bar is a hairline of paper with an ink fill.
 */
export function shareBar(share, className = '') {
  const fill = el('span', { class: 'share-fill', style: { width: '0%' } })
  const bar = el('span', { class: `share ${className}` }, [fill])
  requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`)))
  return bar
}

/** Staggered arrival: each child of `node` rises in a beat after the one before. */
export function stagger(node, from = 0) {
  let i = from
  for (const child of node.children) {
    child.classList.add('arrive')
    child.style.setProperty('--i', String(i++))
  }
  return node
}

/** `HH:MM` in the reader's own zone. The one clock in this file. */
export const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export const shortDay = (ymd) => {
  const [y, m, d] = String(ymd).split('-').map(Number)
  return y ? new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }).slice(0, 2) : ''
}

/**
 * Deep / steady / shallow as one segmented bar. Three tones of the same ink,
 * not three hues: focus quality is a gradient of one thing, and the dial
 * already spends the ochre.
 */
export function focusBar(focus, onAsk) {
  const deep = focus?.deepMin ?? 0
  const steady = focus?.steadyMin ?? 0
  const shallow = focus?.shallowMin ?? 0
  const total = deep + steady + shallow
  if (total === 0) return null
  const seg = (min, cls, label) =>
    min > 0
      ? el('span', { class: `focus-seg ${cls}`, style: { flexGrow: String(min) }, title: `${label}: ${hm(min)} (${Math.round((min / total) * 100)}%)` }, [
          el('span', { class: 'focus-seg-label', text: min / total > 0.18 ? `${label} ${hm(min)}` : '' }),
        ])
      : null
  return el(
    'div',
    { class: 'focus', title: `Focus today: ${hm(deep)} deep, ${hm(steady)} steady, ${hm(shallow)} shallow` },
    [el('span', { class: 'focus-track' }, [seg(deep, 'focus-deep', 'deep'), seg(steady, 'focus-steady', 'steady'), seg(shallow, 'focus-shallow', 'shallow')])],
  )
}

/**
 * The last eight days as active hours, today at the right in ochre. A small
 * graph, not a chart: no axis, hover says the number.
 */
/**
 * The last two weeks as a ledger, this week first. One row per day: how long
 * the machine saw activity (a flat bar against the fortnight's busiest day),
 * commits, files, switches an hour, shell failures over runs, interruptions.
 * Each week carries its own totals in the head, so the two can be read against
 * each other. Every day is a door into the record. Flat on purpose: a tilted
 * slab hid the numbers, and the numbers are the point.
 */
export function weekStrip(shape, todayYmd) {
  const days = Array.isArray(shape?.days) ? shape.days : []
  if (days.length < 2) return null
  const ymd = (d) => d.toISOString().slice(0, 10)
  const mondayOf = (date) => {
    const d = new Date(`${date}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
    return d
  }
  const thisMonday = mondayOf(todayYmd ?? days[days.length - 1].date)
  const lastMonday = new Date(thisMonday)
  lastMonday.setUTCDate(lastMonday.getUTCDate() - 7)
  const [thisMon, lastMon] = [ymd(thisMonday), ymd(lastMonday)]
  const groups = [
    ['This week', days.filter((d) => d.date >= thisMon)],
    ['Last week', days.filter((d) => d.date >= lastMon && d.date < thisMon)],
  ].filter(([, list]) => list.length)
  const max = Math.max(1, ...days.map((d) => (d.inputBlind ? 0 : d.activeHours ?? 0)))
  const sum = (list, key) => list.reduce((n, d) => n + (d[key] ?? 0), 0)
  const dayLabel = (date) => `${shortDay(date)} ${Number(date.slice(8))}`
  const block = ([label, list]) => {
    // Rounded: a sum of tenths printed raw read "49.900000000000006h".
    const hours = Math.round(sum(list, 'activeHours') * 10) / 10
    const runs = sum(list, 'shellRuns')
    const fails = sum(list, 'shellFailures')
    const switches = sum(list, 'switches')
    return el('div', { class: 'wk' }, [
      el('div', { class: 'col-head' }, [
        el('h3', { class: 'col-title', text: label }),
        el('span', { class: 'col-hint', text: `${hours}h active · ${sum(list, 'commits')} commits · ${runs ? Math.round((fails / runs) * 100) : 0}% shell failures · ${hours ? Math.round(switches / hours) : '—'} switches/h` }),
      ]),
      table(
        [
          { label: 'Day', cell: (d) => el('span', { class: `door${d.date === todayYmd ? ' wk-today' : ''}`, 'data-explore': `day:${d.date}`, tabindex: '0', role: 'link', text: dayLabel(d.date) }) },
          {
            label: 'Active',
            cell: (d) =>
              d.inputBlind
                ? el('span', { class: 'panel-hint', text: 'input monitoring off' })
                : el('span', { class: 'wk-active' }, [shareBar((d.activeHours ?? 0) / max, d.date === todayYmd ? 'share-today' : ''), el('span', { class: 'wk-h', text: `${d.activeHours ?? 0}h` })]),
          },
          { label: 'Commits', num: true, cell: (d) => String(d.commits ?? 0) },
          { label: 'Files', num: true, cell: (d) => String(d.filesChanged ?? 0) },
          { label: 'Sw/h', num: true, cell: (d) => num(d.switchesPerHour, 0) },
          { label: 'Shell', num: true, cell: (d) => `${d.shellFailures ?? 0}/${d.shellRuns ?? 0}` },
          { label: 'Interr.', num: true, cell: (d) => String(d.interruptions ?? 0) },
        ],
        list,
      ),
    ])
  }
  return el('section', { class: 'week' }, groups.map(block))
}
