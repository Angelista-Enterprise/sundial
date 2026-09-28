// The surface renderers, as plain DOM.
//
// These used to live inside dsh's client bundle as React components reachable
// only through a slot. Here they are ordinary functions returning elements,
// which is the whole point of owning the client: a surface is a first-class
// thing the canvas draws, not a widget dsh's message renderer makes room for.
//
// One rule holds the set together and is enforced by every function below: the
// renderer colours from the MARK the data carries, so a component can never
// invent certainty the record does not have. `null` is "not observed" and draws
// as an em dash or a 2px stub — never as a zero.

const C = {
  ink: 'var(--ink)',
  ochre: 'var(--ochre)',
  green: 'var(--green)',
  superseded: 'var(--superseded)',
  faint: 'var(--ink-faint)',
  panel: 'var(--panel)',
  border: 'var(--border)',
}

const MARK_FILL = {
  observed: C.ink,
  verified: C.green,
  derived: C.ochre,
  inferred: C.ochre,
  absent: C.superseded,
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Element helper. `attrs` sets attributes; children may be nodes or strings. */
/**
 * What a list of things that happened is sorted by.
 *
 * Newest first, and whatever is LIVE above all of it. The audit found the same
 * complaint on four surfaces — the day ran oldest-first, the Day detail ran
 * oldest-first while every other moment list ran the other way, the thread rail
 * put the session the owner was speaking in fourth, and the fact list buried
 * what the owner said. A default nobody has to remember is the only fix that
 * stays fixed.
 *
 * `at` picks the instant off a row, so a caller names its own field rather than
 * this knowing every shape. A row with no instant sorts last: it is not older,
 * it is unknown, and unknown does not belong at the top.
 */
export function newestFirst(rows, at = (r) => r?.at) {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const x = at(a) ?? ''
    const y = at(b) ?? ''
    if (x === y) return 0
    if (x === '') return 1
    if (y === '') return -1
    // Instants are ISO strings or epoch milliseconds; compare like with like.
    return typeof x === 'number' && typeof y === 'number' ? y - x : String(y).localeCompare(String(x))
  })
}

/**
 * The same, with the live one pinned on top.
 *
 * A thread the owner is speaking in RIGHT NOW is not just the newest thing, it
 * is the only one they can act on. It sat fourth in creation order during the
 * audit, which is what started this.
 */
export function liveFirst(rows, at = (r) => r?.at, isLive = (r) => r?.live === true) {
  const sorted = newestFirst(rows, at)
  return [...sorted.filter(isLive), ...sorted.filter((r) => !isLive(r))]
}

/**
 * A `style` object, applied so that CUSTOM properties actually land.
 *
 * `Object.assign(node.style, { '--i': 3 })` puts a plain JS property on the
 * CSSStyleDeclaration and nothing on the element: a custom property only
 * exists if it goes through `setProperty`. Every `style: { '--i': i }` in this
 * client — the row staggers the design doc describes, on the rosters, the hits
 * and the strata layers — was therefore silently doing nothing, and every
 * `animation-delay: calc(var(--i) * 22ms)` resolved to zero. `svg()` was worse
 * still: it ran the object through `setAttribute`, so the element carried
 * `style="[object Object]"`.
 */
function applyStyle(node, style) {
  for (const [key, value] of Object.entries(style)) {
    if (value === null || value === undefined) continue
    if (key.startsWith('--')) node.style.setProperty(key, String(value))
    else node.style[key] = value
  }
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'style' && typeof value === 'object') applyStyle(node, value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  // FLAT, not one level deep. Several renderers here hand back a PAIR — `grid`
  // returns its table and its note, `chart` its figure and its legend — so a
  // caller that nests one inside another surface passes an array as a child.
  // `append` does not recurse: it stringified the array, and the card read
  // "[object HTMLDivElement]," where its table should have been.
  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child)
  }
  return node
}

/** The SVG twin of `el`. Namespaced, because `createElement` would not draw. */
export function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'style' && typeof value === 'object') applyStyle(node, value)
    else node.setAttribute(key, String(value))
  }
  for (const child of [children].flat(Infinity)) if (child) node.append(child)
  return node
}

/** The wire may hand a json argument over as its raw string. Accept both. */
function payloadOf(args) {
  const payload = args?.payload
  if (typeof payload !== 'string') return payload ?? null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

// ── chart ─────────────────────────────────────────────────────────────────
export function chart(payload) {
  const x = payload.x
  const series = payload.series
  const W = 1000
  const H = 260
  const baseline = H - 20
  const slot = W / x.length
  const barW = Math.min(100, slot * 0.7)
  const primary = series[0]
  const secondary = series.length > 1 ? series[1] : null

  let max = 0
  for (const s of series) for (const v of s.values) if (typeof v === 'number' && v > max) max = v
  if (max === 0) max = 1

  const bars = []
  x.forEach((_, i) => {
    const left = i * slot + (slot - barW) / 2
    const value = primary.values[i]
    if (typeof value !== 'number') {
      // Not observed. A 2px stub, never a zero-height bar that reads as "none".
      bars.push(
        svg('rect', { x: left, y: baseline - 2, width: barW, height: 2, fill: C.superseded }, [svg('title', {}, [`${x[i]} · nothing observed`])]),
      )
      return
    }
    const h = Math.max(2, (value / max) * (baseline - 24))
    bars.push(
      svg('rect', { x: left, y: baseline - h, width: barW, height: h, fill: MARK_FILL[primary.mark] ?? C.ink }, [
        // The exact number, on hover. A bar says "more than that one"; the
        // owner asking "how much" should not have to open the tool row.
        svg('title', {}, [`${x[i]} · ${value}${primary.unit ? ` ${primary.unit}` : ''} · ${primary.mark}`]),
      ]),
    )
    if (secondary !== null) {
      const cap = secondary.values[i]
      if (typeof cap === 'number' && cap > 0) {
        const capH = Math.max(3, (cap / max) * (baseline - 24) * 0.12 + 3)
        bars.push(svg('rect', { x: left, y: baseline - h - capH - 3, width: barW, height: 4, fill: MARK_FILL[secondary.mark] ?? C.ochre }))
      }
    }
  })

  const every = Math.max(1, Math.ceil(x.length / 8))
  return [
    svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', style: 'height:150px;width:100%', role: 'img' }, [
      svg('path', { d: `M0 ${baseline} H${W}`, stroke: C.ink, 'stroke-width': 1 }),
      ...bars,
    ]),
    el(
      'div',
      { class: 'axis' },
      x.map((label, i) => el('span', { style: { width: `${100 / x.length}%` }, text: i % every === 0 ? String(label).slice(5) || String(label) : '' })),
    ),
    el('div', { class: 'legend' }, [
      ...series.map((s, i) =>
        el('span', {}, [
          el('span', { class: 'swatch', style: { background: MARK_FILL[s.mark] ?? C.ink, height: i === 0 ? '5px' : '3px' } }),
          `${s.name}${s.unit ? ` (${s.unit})` : ''} · ${s.mark}`,
        ]),
      ),
      el('span', {}, [el('span', { class: 'swatch', style: { background: C.superseded, height: '2px' } }), 'nothing observed']),
    ]),
    payload.note ? el('div', { class: 'surface-note', text: payload.note }) : null,
  ]
}

// ── grid ──────────────────────────────────────────────────────────────────
/**
 * A table of anything: people, places, files, commits, sessions — whatever the
 * answer is a list of. This is the general one; the other kinds each say one
 * specific thing, and a list that is genuinely a list should not be bent into
 * a chart to be shown.
 *
 * Sorting is DONE here, not merely advertised. The tool description has told
 * the model "sorting and filtering happen client-side, send the rows once"
 * since the surface shipped, and the renderer drew a static table — so a model
 * that sent a hundred rows on that promise handed the owner a wall they could
 * not reorder. A description a renderer does not honour is the same
 * false-success defect as a tool result that reports a delivery that did not
 * happen.
 */
export function grid(payload) {
  const columns = payload.columns
  const cell = (value) => (value === null || value === undefined || value === '' ? '—' : String(value))
  const numeric = (c) => c.align === 'right' || c.type === 'number'
  const body = el('tbody', {})

  /** `null` is not observed, so it sorts LAST in both directions rather than as a zero or an empty string. */
  const compare = (a, b, column, direction) => {
    const av = a[column.key]
    const bv = b[column.key]
    const missing = (v) => v === null || v === undefined || v === ''
    if (missing(av) && missing(bv)) return 0
    if (missing(av)) return 1
    if (missing(bv)) return -1
    const order = numeric(column) ? Number(av) - Number(bv) : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' })
    return direction === 'descending' ? -order : order
  }

  const draw = (rows) =>
    body.replaceChildren(...rows.map((row) => el('tr', {}, columns.map((c) => el('td', { class: numeric(c) ? 'num' : null, text: cell(row[c.key]) })))))

  const heads = columns.map((column) =>
    el('th', { class: numeric(column) ? 'num' : null, 'aria-sort': 'none', scope: 'col' }, [
      el('button', {
        type: 'button',
        class: 'grid-sort',
        title: `Sort by ${column.label}`,
        text: column.label,
        onclick: () => {
          // Third click restores the order the rows arrived in: that order is
          // itself a claim (newest first, strongest first) and losing it for
          // the rest of the session would cost more than the sort gains.
          const current = heads[columns.indexOf(column)].getAttribute('aria-sort')
          const next = current === 'none' ? 'ascending' : current === 'ascending' ? 'descending' : 'none'
          for (const head of heads) head.setAttribute('aria-sort', 'none')
          heads[columns.indexOf(column)].setAttribute('aria-sort', next)
          draw(next === 'none' ? payload.rows : [...payload.rows].sort((a, b) => compare(a, b, column, next)))
        },
      }),
    ]),
  )

  draw(payload.rows)
  return [
    el('div', { style: { overflowX: 'auto' } }, [el('table', { class: 'grid' }, [el('thead', {}, el('tr', {}, heads)), body])]),
    payload.note ? el('div', { class: 'surface-note', text: payload.note }) : null,
  ]
}

// ── flow ──────────────────────────────────────────────────────────────────
/**
 * Rank each node by the LONGEST path that reaches it, so a step waits for
 * everything that feeds it rather than sitting beside its own input — a diagram
 * that puts a step before its own evidence is telling a lie about the pipeline.
 *
 * Clamped to |nodes| - 1, the exact bound for a DAG, which is also what makes a
 * cycle terminate; empty ranks are then dropped, because a cycle skips ranks
 * even when clamped and an empty column draws as an arrow pointing at nothing.
 */
export function rankFlowNodes(nodes, edges) {
  const rank = new Map(nodes.map((n) => [n.id, 0]))
  const ceiling = nodes.length - 1
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false
    for (const [from, to] of edges) {
      const next = Math.min(rank.get(from) + 1, ceiling)
      if (next > rank.get(to)) {
        rank.set(to, next)
        moved = true
      }
    }
    if (!moved) break
  }
  const columns = []
  for (const node of nodes) {
    const depth = rank.get(node.id)
    while (columns.length <= depth) columns.push([])
    columns[depth].push(node)
  }
  return columns.filter((column) => column.length > 0)
}

function flow(payload) {
  const columns = rankFlowNodes(payload.nodes, payload.edges ?? [])
  const arrow = () =>
    el('div', { class: 'flow-arrow', 'aria-hidden': 'true' }, [
      svg('svg', { width: 20, height: 9, viewBox: '0 0 20 9' }, [
        svg('path', { d: 'M0 4.5H15', stroke: 'currentColor', 'stroke-width': 1.2 }),
        svg('path', { d: 'M14 1l5 3.5-5 3.5', fill: 'currentColor' }),
      ]),
    ])
  const row = el('div', { class: 'flow' })
  columns.forEach((column, index) => {
    if (index > 0) row.append(arrow())
    row.append(
      el(
        'div',
        { class: 'flow-col' },
        column.map((node) =>
          el('div', { class: 'flow-node' }, [el('span', { class: 'flow-label', text: node.label }), node.kind ? el('span', { class: 'flow-kind', text: node.kind }) : null]),
        ),
      ),
    )
  })
  return [row, payload.note ? el('div', { class: 'surface-note', text: payload.note }) : null]
}

// ── gauge-row ─────────────────────────────────────────────────────────────
export function gaugeRow(payload) {
  return [
    el(
      'div',
      { class: 'gauges' },
      payload.readings.map((reading) => {
        const value = typeof reading.value === 'number' ? reading.value : null
        const typical = typeof reading.typical === 'number' ? reading.typical : null
        // The ceiling, in the order it can be trusted: what the reading says its
        // scale is, then enough headroom to see the value and the baseline
        // apart. Never the value itself — a bar pinned full every time reads as
        // a maximum rather than as a measurement.
        const ceiling = typeof reading.max === 'number' ? reading.max : Math.max(value ?? 0, typical ?? 0) * 1.3 || 1
        const pct = (n) => `${Math.max(0, Math.min(100, (n / ceiling) * 100))}%`
        const over = value !== null && typical !== null && typical !== 0 ? Math.round(((value - typical) / typical) * 100) : null
        return el('div', { title: `${reading.label}: ${value === null ? 'not observed' : `${value}${reading.unit ? ` ${reading.unit}` : ''}`}${typical === null ? '' : ` · usually ${typical}`} · ${reading.mark}` }, [
          el('div', { class: 'gauge-head' }, [
            el('span', { class: 'gauge-label', text: reading.label }),
            el('span', { class: 'gauge-value', style: { color: MARK_FILL[reading.mark] ?? C.ink } }, [
              value === null ? '—' : String(value),
              value !== null && reading.unit ? el('span', { class: 'gauge-unit', text: reading.unit }) : null,
            ]),
          ]),
          el('div', { class: 'gauge-track' }, [
            value === null ? null : el('div', { class: 'gauge-fill', style: { width: pct(value), background: MARK_FILL[reading.mark] ?? C.ink } }),
            typical === null ? null : el('div', { class: 'gauge-tick', style: { left: pct(typical) } }),
          ]),
          el('div', { class: 'gauge-foot' }, [
            el('span', { text: reading.mark }),
            el('span', { text: typical === null ? 'no baseline' : over === null ? `usually ${typical}` : `usually ${typical} · ${over >= 0 ? '+' : ''}${over}%` }),
            reading.note ? el('span', { text: reading.note }) : null,
          ]),
        ])
      }),
    ),
  ]
}

// ── graph-neighborhood ────────────────────────────────────────────────────
export function neighborhood(payload) {
  const edges = (payload.edges ?? []).slice(0, 10)
  const cx = 150
  const cy = 150
  const r = 96
  const nodes = edges.map((edge, i) => {
    const angle = (i / Math.max(edges.length, 1)) * Math.PI * 2 - Math.PI / 2
    return { edge, x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r }
  })
  return [
    // Wider than the ring: the labels now grow outward from it, and a viewBox
    // that stopped at the nodes clipped every long name on both sides.
    svg('svg', { viewBox: '-70 0 440 300', style: 'max-width:520px;width:100%', role: 'img' }, [
      // The edge's own grammar: a superseded link is greyed and dotted, an
      // inferred one dashed, a current observed one solid. The line IS the mark.
      ...nodes.map((n) =>
        svg('path', {
          d: `M${cx} ${cy} L${n.x.toFixed(1)} ${n.y.toFixed(1)}`,
          stroke: n.edge.superseded ? C.superseded : n.edge.inferred ? 'var(--ink-subtle)' : C.ink,
          'stroke-dasharray': n.edge.superseded ? '2 4' : n.edge.inferred ? '5 4' : null,
          'stroke-width': 1.2,
        }),
      ),
      svg('circle', { cx, cy, r: 13, fill: C.ochre }),
      svg('text', { x: cx, y: cy + 32, 'text-anchor': 'middle', 'font-size': 12, fill: C.ochre }, [payload.center?.name ?? '']),
      ...nodes.flatMap((n) => [
        svg('circle', { cx: n.x, cy: n.y, r: 8, fill: C.ink }, n.edge.title ? [svg('title', {}, [n.edge.title])] : []),
        // Labels are placed AWAY from the centre, not uniformly above the node.
        // With six or more edges two nodes land on the lower diagonals, and
        // their labels sat exactly on the centre's own label — a drawing whose
        // names cannot be read is not a drawing. Below the node when it is in
        // the lower half; anchored outward so a long name grows away from the
        // middle rather than across it.
        svg(
          'text',
          {
            x: n.x + (n.x > cx + 20 ? 12 : n.x < cx - 20 ? -12 : 0),
            y: n.y > cy + 4 ? n.y + 20 : n.y - 13,
            'text-anchor': n.x > cx + 20 ? 'start' : n.x < cx - 20 ? 'end' : 'middle',
            'font-size': 12,
            fill: C.ink,
          },
          [n.edge.toName ?? ''],
        ),
      ]),
    ]),
  ]
}

/**
 * A canvas: the model's own HTML and SVG, drawn in an iframe that runs nothing
 * and loads nothing. `sandbox` with no allowances means no scripts, no forms,
 * no same-origin; the CSP inside forbids every fetch except inline styles and
 * data: images. Fixed height, chosen by the model within bounds, because
 * without scripts the frame cannot report its own size.
 */
function canvas(p) {
  const height = typeof p.height === 'number' ? Math.min(900, Math.max(120, p.height)) : 320
  const doc = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:;">',
    '<style>html,body{margin:0}body{padding:12px;font:15px/1.5 system-ui,-apple-system,sans-serif;color:#1f1b15;background:transparent}svg{max-width:100%}</style>',
    '</head><body>',
    String(p.html ?? ''),
    '</body></html>',
  ].join('')
  const frame = el('iframe', { class: 'canvas-frame', sandbox: '', referrerpolicy: 'no-referrer', loading: 'lazy', title: 'canvas' })
  frame.setAttribute('srcdoc', doc)
  frame.style.height = `${height}px`
  return frame
}

const RENDERERS = {
  canvas: (p) => (typeof p?.html === 'string' ? canvas(p) : null),
  chart: (p) => (Array.isArray(p?.x) ? chart(p) : null),
  grid: (p) => (Array.isArray(p?.columns) ? grid(p) : null),
  flow: (p) => (Array.isArray(p?.nodes) ? flow(p) : null),
  'gauge-row': (p) => (Array.isArray(p?.readings) ? gaugeRow(p) : null),
  'graph-neighborhood': (p) => (Array.isArray(p?.edges) ? neighborhood(p) : null),
}

/**
 * One surface frame → the element that draws it.
 *
 * An unknown kind, or a payload that does not fit the kind it claims, says so
 * in one line rather than drawing something wrong. A surface that lies is worse
 * than a surface that is missing.
 */
export function renderSurface(frame) {
  const payload = payloadOf(frame.args)
  const body = RENDERERS[frame.kind]?.(payload) ?? null
  return el('section', { class: 'surface' }, [
    el('div', { class: 'surface-head' }, [
      el('span', { class: 'surface-title', text: frame.title }),
      frame.because ? el('span', { class: 'surface-because', text: `· ${frame.because}` }) : null,
    ]),
    el('div', { class: 'surface-body' }, body ?? el('div', { class: 'surface-fail', text: `No renderer for "${frame.kind}" yet.` })),
  ])
}
