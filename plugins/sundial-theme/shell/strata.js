// Strata — the fortnight as a core sample.
//
// The sundial is one day seen from above. Strata is fourteen days seen from the
// side: each day a layer, newest on top, every hour a cell whose ink AND height
// are how much energy the record saw there — so the sample reads as rock, with
// soft and hard bands, rather than as a grey smear. Meetings sit on a layer as
// brackets, deep stretches as the hard seam under it. A vertical borehole
// follows the pointer through all the layers at once, so "what is 14:00 usually
// like?" is answered by looking, not asking. Every layer is a door into its day.
//
// The picture is drawn at ONE USER UNIT PER PIXEL. It used to be drawn in a
// fixed 1200-wide viewBox scaled down to whatever the card was, so an 11px
// label landed on screen at about 8px and the owner could not read it — and the
// height, being `auto`, left a third of the card empty. Measuring the slab and
// drawing into it fixes both at once: a 15px label is 15px, and the layers are
// as thick as the card has room for.
//
// Reads the same routes the day and the week read (`/gnomon/dial?date`,
// `/gnomon/shape`), so nothing here can disagree with them.
import { el, svg } from './surfaces.js'
import { read } from './read.js'

// The sample is never narrower than the working day, and widens to hold
// whatever the record actually saw — the old fixed 6→24 silently dropped the
// 00:00–03:00 work that shows up on a late night.
const DAY_FROM = 6
const DAY_TO = 24
const GUTTER_L = 96
const GUTTER_R = 250
const TOP = 46
const BOTTOM = 10
const GAP = 5
const ROW_MIN = 18
const ROW_MAX = 64
const COL_W = 74
const BAR_W = 46

const ymdDate = (ymd) => new Date(`${ymd}T12:00:00`)
const weekday = (ymd) => ymdDate(ymd).toLocaleDateString(undefined, { weekday: 'short' })
const dayLabel = (ymd) => `${weekday(ymd)} ${Number(ymd.slice(8))}`
const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`
// Midnight at the end of the sample is 24, not 00: the scale runs left to
// right and a second `00` reads as the picture having wrapped round.
const hourMark = (h) => String(h > 24 ? h - 24 : h).padStart(2, '0')

/** One line of insight the numbers support; null when they do not. */
function insights(days, dials, byHour) {
  const out = []
  // The hour the fortnight is deepest at: highest mean score across days that were observed then.
  const mean = new Map()
  for (const d of dials) for (const c of d?.curve ?? []) if (typeof c.score === 'number') mean.set(c.hour, [...(mean.get(c.hour) ?? []), c.score])
  // Only hours seen on at least half the days may rank: one late night is not a habit.
  const floor = Math.ceil(dials.filter(Boolean).length / 2)
  const ranked = [...mean.entries()].map(([h, xs]) => [h, xs.reduce((a, b) => a + b, 0) / xs.length, xs.length]).filter(([, , n]) => n >= floor).sort((a, b) => b[1] - a[1])
  if (ranked.length) out.push(`Deepest hour of the fortnight: ${hh(ranked[0][0])}, over ${ranked[0][2]} days.`)
  // The weekday that runs longest.
  const byWd = new Map()
  for (const d of days) if (!d.inputBlind) byWd.set(weekday(d.date), [...(byWd.get(weekday(d.date)) ?? []), d.activeHours ?? 0])
  const wd = [...byWd.entries()].map(([k, xs]) => [k, xs.reduce((a, b) => a + b, 0) / xs.length]).sort((a, b) => b[1] - a[1])
  if (wd.length >= 2) out.push(`${wd[0][0]} runs longest at ${wd[0][1].toFixed(1)}h on average; ${wd[wd.length - 1][0]} shortest at ${wd[wd.length - 1][1].toFixed(1)}h.`)
  // Where the switching peaks.
  const sw = (Array.isArray(byHour) ? byHour : []).map((h) => [h.hour, h.switches ?? h.n ?? h.count ?? 0]).filter(([h]) => typeof h === 'number').sort((a, b) => b[1] - a[1])
  if (sw.length) out.push(`Switching peaks at ${hh(sw[0][0])}.`)
  // This week against last, on shell failures and commits.
  const half = Math.floor(days.length / 2)
  const [earlier, later] = [days.slice(0, half), days.slice(half)]
  const rate = (list) => {
    const runs = list.reduce((n, d) => n + (d.shellRuns ?? 0), 0)
    return runs ? list.reduce((n, d) => n + (d.shellFailures ?? 0), 0) / runs : null
  }
  const [r0, r1] = [rate(earlier), rate(later)]
  if (r0 !== null && r1 !== null) out.push(`Shell failures ${r1 < r0 ? 'fell' : r1 > r0 ? 'rose'  : 'held'}: ${Math.round(r0 * 100)}% → ${Math.round(r1 * 100)}% of runs.`)
  const c0 = earlier.reduce((n, d) => n + (d.commits ?? 0), 0)
  const c1 = later.reduce((n, d) => n + (d.commits ?? 0), 0)
  if (c0 || c1) out.push(`${c1} commits in the later week against ${c0} before.`)
  return out
}

/**
 * The three numbers down the right-hand edge. The owner could not say what
 * `26c` and `15sw` were, and neither had anything in the picture to check
 * against: a number with no unit and no mark is a number nobody reads twice.
 * So each one is named once at the top, and each carries a bar scaled to the
 * fortnight's own largest — the comparison the eye was doing anyway.
 */
const GUTTER_COLS = [
  { word: 'active', of: (d) => d.activeHours ?? 0, say: (v) => `${v}h`, reads: (v) => `${v} hours at the machine` },
  { word: 'commits', of: (d) => d.commits ?? 0, say: (v) => String(v), reads: (v) => `${v} commit${v === 1 ? '' : 's'}` },
  { word: 'switches/h', of: (d) => Math.round(d.switchesPerHour ?? 0), say: (v) => String(v), reads: (v) => `${v} app switches an hour` },
]

/**
 * The strata, as a node that fills itself. `shape` is `/gnomon/shape?days=14`;
 * the day layers are read one by one and drawn as they arrive.
 */
export function strata(shape) {
  const days = (Array.isArray(shape?.days) ? shape.days : []).slice(-14)
  // The identity line. The owner read this card and the Memory card as the same
  // thing, because both once drew lists of facts — so each now says on its face
  // which question it answers. This one is the days; Memory is the beliefs.
  const bore = el('div', { class: 'strata-bore', text: 'How your days have actually looked, one layer each. Memory is what Gnomon knows; this is what it watched. Move across the layers to read one hour through the fortnight.' })
  const picture = svg('svg', { class: 'strata-svg', role: 'img', 'aria-label': 'Fourteen days, one layer each, hours across' })
  const slab = el('div', { class: 'strata-slab' }, [picture])
  const insightList = el('ul', { class: 'strata-insights' }, [el('li', { class: 'reading', text: 'Reading the layers…' })])
  const node = el('div', { class: 'strata' }, [
    // No title. The card's head already says STRATA, and the name printed
    // again six millimetres under it is the same word twice. What is left is
    // the identity line: what this sample IS, which the head cannot say.
    el('div', { class: 'strata-head' }, [
      el('span', { class: 'strata-sub', text: `${days.length} days · ${shape?.totals?.activeHours ?? '—'}h active · newest on top` }),
    ]),
    slab,
    bore,
    insightList,
  ])
  if (days.length === 0) {
    node.replaceChildren(el('div', { class: 'none', text: 'No days recorded yet.' }))
    return node
  }

  const rows = [...days].reverse()
  const dials = new Array(rows.length).fill(null)

  // Everything the pointer needs, rebuilt by each paint: the picture is
  // redrawn whenever the card is resized, so the hit-testing cannot be closed
  // over one geometry.
  let geom = null
  // The sample settles ONCE, on the first drawing that has data. Every later
  // paint builds the same nodes again — a resize, a re-read — and without this
  // the whole fortnight would re-settle each time the owner dragged a corner.
  let settled = false

  const readingAt = (hour) => {
    const seen = dials.map((d) => d?.curve?.find((c) => c.hour === hour)?.score).filter((s) => typeof s === 'number')
    if (seen.length === 0) return `${hh(hour)} · nothing observed at this hour yet.`
    const scores = [...seen].sort((a, b) => a - b)
    const max = geom?.max ?? Math.max(1, ...scores)
    const deep = scores.filter((s) => s >= max * 0.6).length
    const median = scores[Math.floor(scores.length / 2)]
    const meetings = dials.filter((d) => d?.meetings?.some((m) => m.startHour < hour + 1 && (m.endHour ?? m.startHour) > hour)).length
    return `${hh(hour)} · deep on ${deep} of ${seen.length} days · usual energy ${median} of ${max}${meetings ? ` · in a meeting on ${meetings}` : ''}`
  }

  /**
   * Draw the whole sample at the slab's real size. Idempotent: called on mount,
   * again when each day's dial lands, and again whenever the card is resized.
   */
  function paint() {
    const w = Math.round(slab.clientWidth)
    const h = Math.round(slab.clientHeight)
    if (w < 240 || h < 120) return
    picture.setAttribute('viewBox', `0 0 ${w} ${h}`)
    picture.replaceChildren()

    // The hour span: the working day, widened by whatever the record saw
    // outside it. Never narrower, so the picture does not jump about.
    let from = DAY_FROM
    let to = DAY_TO
    for (const d of dials) for (const c of d?.curve ?? []) if (typeof c.score === 'number') { from = Math.min(from, c.hour); to = Math.max(to, c.hour + 1) }
    const span = to - from
    const colW = (w - GUTTER_L - GUTTER_R) / span
    const xOf = (hour) => GUTTER_L + (hour - from) * colW
    const pitch = Math.min(ROW_MAX + GAP, Math.max(ROW_MIN + GAP, (h - TOP - BOTTOM) / rows.length))
    const ROW = pitch - GAP
    const yOf = (i) => TOP + i * pitch
    const max = Math.max(1, ...dials.flatMap((d) => (d?.curve ?? []).map((c) => c.score ?? 0)))
    const colMax = GUTTER_COLS.map((c) => Math.max(1, ...rows.map((d) => c.of(d))))
    geom = { w, from, to, colW, xOf, max, top: TOP, bottom: yOf(rows.length - 1) + ROW }

    // The hour scale, and the words that name the right-hand numbers.
    const everyOther = colW < 26 ? 3 : colW < 40 ? 2 : 1
    for (let hour = from; hour <= to; hour += everyOther) {
      picture.append(svg('text', { x: xOf(hour), y: 18, class: 'strata-hour', 'text-anchor': 'middle' }, [hourMark(hour)]))
      picture.append(svg('line', { x1: xOf(hour), y1: TOP - 10, x2: xOf(hour), y2: geom.bottom + 4, class: 'strata-grid' }))
    }
    GUTTER_COLS.forEach((col, c) => {
      picture.append(svg('text', { x: w - GUTTER_R + 28 + c * COL_W, y: TOP - 12, class: 'strata-unit' }, [col.word]))
    })

    for (const [i, d] of rows.entries()) {
      const y = yOf(i)
      const g = svg('g', { class: `strata-layer${d.inputBlind ? ' strata-blind' : ''}`, style: { '--i': i }, 'data-explore': `day:${d.date}`, tabindex: '0', role: 'link' })
      // Only the action. The numbers are named on the face of the card now, so
      // a tooltip repeating them was a grey slab thrown over the picture at the
      // exact moment the owner was reading it.
      g.append(svg('title', {}, [`Open ${dayLabel(d.date)}`]))
      // The hit area is the full PITCH, edge to edge — the drawn layer plus
      // its half of the gap on each side, and the right-hand numbers too. The
      // layers are drawn with a gap between them, so a pointer moving down the
      // card fell into dead space between every pair and the bands flicked off
      // and on again. Hit areas tile; only the drawing has gaps.
      g.append(svg('rect', { x: 0, y: y - GAP / 2, width: w - GUTTER_R + 14, height: ROW + GAP, class: 'strata-hit' }))
      g.append(svg('rect', { x: GUTTER_L, y, width: w - GUTTER_L - GUTTER_R, height: ROW, class: 'strata-bed' }))
      // The floor of the layer. Without it the relief stands on nothing and
      // the fortnight reads as bars in mid-air rather than as bands of rock.
      g.append(svg('line', { x1: GUTTER_L, y1: y + ROW - 0.5, x2: w - GUTTER_R, y2: y + ROW - 0.5, class: 'strata-floor' }))
      g.append(svg('text', { x: GUTTER_L - 14, y: y + ROW / 2 + 5, class: 'strata-day', 'text-anchor': 'end' }, [dayLabel(d.date)]))

      // The relief: ink AND height, both from the same score. A band the eye
      // can feel the thickness of is the whole reason this card exists.
      for (const c of dials[i]?.curve ?? []) {
        if (typeof c.score !== 'number' || c.hour < from || c.hour >= to) continue
        const f = c.score / max
        const ch = Math.max(2, (ROW - 4) * (0.22 + 0.78 * f))
        g.append(svg('rect', { x: xOf(c.hour) + 1, y: y + ROW - 2 - ch, width: Math.max(1, colW - 2), height: ch, class: 'strata-cell', style: { '--h': c.hour - from }, opacity: (0.3 + 0.7 * f).toFixed(2) }))
      }
      // Meetings across the top of the layer; the deep seam hardens the gap
      // under it, where the relief leaves room for it.
      for (const m of dials[i]?.meetings ?? []) {
        if (typeof m.startHour !== 'number') continue
        g.append(svg('rect', { x: xOf(m.startHour), y: y + 1, width: Math.max(3, ((m.endHour ?? m.startHour) - m.startHour) * colW), height: 2, class: 'strata-meeting' }))
      }
      for (const b of dials[i]?.deepBlocks ?? []) {
        const at = b.startHour ?? b.fromHour
        const till = b.endHour ?? b.toHour
        if (typeof at !== 'number') continue
        g.append(svg('rect', { x: xOf(at) + 1, y: y + ROW + 1, width: Math.max(2, ((till ?? at) + 1 - at) * colW - 2), height: 3, class: 'strata-deep' }))
      }
      if (dials[i]?.missing) g.classList.add('strata-missing')

      // Each number is its own CELL, with its own hit area and its own box.
      // The boxes are the full column pitch, so they sit against each other —
      // three cells of one table, not three labels with air between them. And
      // reading one number is not reading the day: the cell takes the hover off
      // the layer, so the band over the grid lets go while it is lit.
      GUTTER_COLS.forEach((col, c) => {
        const v = col.of(d)
        const x = w - GUTTER_R + 28 + c * COL_W
        const cell = svg('g', { class: 'strata-count' })
        cell.append(svg('title', {}, [`${dayLabel(d.date)} · ${col.reads(v)}`]))
        cell.append(svg('rect', { x: x - 8, y: y - 2, width: COL_W, height: ROW + 4, class: 'strata-box' }))
        cell.append(svg('rect', { x: x - 8, y: y - GAP / 2, width: COL_W, height: ROW + GAP, class: 'strata-hit' }))
        // The bar sits on the layer's own floor, level with the relief, so it
        // reads as a measure rather than as an underline on the number.
        cell.append(svg('text', { x, y: y + ROW / 2, class: `strata-num${c ? ' strata-faint' : ''}` }, [col.say(v)]))
        cell.append(svg('rect', { x, y: y + ROW - 4, width: Math.max(1, BAR_W * (v / colMax[c])), height: 2, class: `strata-bar${c ? ' strata-faint-bar' : ''}` }))
        g.append(cell)
      })

      // The layer under the hand, across the GRID only and very light: the
      // borehole is the strong mark and there cannot be two. One reading runs
      // down an hour in ochre, the other across a day in a whisper.
      g.append(svg('rect', { x: GUTTER_L, y: y - 2, width: w - GUTTER_L - GUTTER_R, height: ROW + 4, class: 'strata-frame' }))
      picture.append(g)
    }

    // The borehole: one column, all layers. Last, so it sits over them.
    // Exactly as tall as the stack of row bands, so the two outlines meet at
    // the corners. It ran to the grid lines before, which put the ochre eight
    // pixels clear of the top layer with nothing to close it against.
    const hole = svg('rect', { x: 0, y: TOP - 2, width: colW, height: geom.bottom - TOP + 4, class: 'strata-hole', opacity: 0 })
    picture.append(hole)
    geom.hole = hole

    if (!settled && dials.some(Boolean)) {
      settled = true
      picture.setAttribute('data-settle', '')
      // Dropped once the sweep is over, so the attribute cannot outlive it and
      // animate a paint the owner caused. Longer than the sweep on purpose.
      setTimeout(() => picture.removeAttribute('data-settle'), 1200)
    }
  }

  const REST = 'Move across the layers to read one hour through the fortnight.'
  const letGo = () => {
    geom?.hole?.setAttribute('opacity', '0')
    bore.textContent = REST
  }
  picture.addEventListener('pointermove', (event) => {
    if (geom === null) return
    const box = picture.getBoundingClientRect()
    // One unit per pixel, so this is already the picture's own scale — the
    // ratio is kept only for the frame between a resize and the repaint.
    const x = (event.clientX - box.left) * (geom.w / box.width)
    const first = geom.xOf(geom.from)
    // Off the grid — in the day labels or over the right-hand numbers — and
    // the borehole LETS GO. It used to return early, which left it standing on
    // whichever hour the pointer last crossed: reading the numbers for Sat 5
    // pinned an ochre column over 23:00 and claimed it was the answer.
    if (x < first || x > first + (geom.to - geom.from) * geom.colW) return letGo()
    const hour = Math.min(geom.to - 1, Math.max(geom.from, Math.floor((x - first) / geom.colW) + geom.from))
    geom.hole.setAttribute('x', String(geom.xOf(hour)))
    geom.hole.setAttribute('opacity', '1')
    bore.textContent = readingAt(hour)
  })
  picture.addEventListener('pointerleave', letGo)

  // A card the owner drags wider is a card that should redraw, now that the
  // drawing is in pixels rather than in a scaled viewBox. One frame's worth of
  // coalescing, because a drag fires this continuously.
  let queued = 0
  const repaint = () => {
    cancelAnimationFrame(queued)
    queued = requestAnimationFrame(paint)
  }
  new ResizeObserver(repaint).observe(slab)
  repaint()

  // The dials, newest first so the top of the sample fills first — the whole
  // fortnight in ONE request. This asked fourteen times, and the harness is one
  // thread: fourteen round trips queued behind each other and behind everything
  // else the board wanted at that moment, which was most of the wait on a
  // board with this card in view. `days=N` on the same route does the same work
  // in one pass.
  ;(async () => {
    const batch = await read(`/gnomon/dial?date=${rows[0]?.date ?? ''}&days=${rows.length}`).catch(() => null)
    const byDate = new Map((batch?.days ?? []).map((d) => [d.date, d]))
    await Promise.all(
      rows.map(async (d, i) => {
        try {
          dials[i] = byDate.get(d.date) ?? (await read(`/gnomon/dial?date=${d.date}`))
        } catch {
          dials[i] = { curve: [], missing: true }
        }
      }),
    )
    repaint()
    insightList.replaceChildren(...insights(days, dials, shape?.switchesByHour).map((line) => el('li', { text: line })))
  })()

  return node
}
