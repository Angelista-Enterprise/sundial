// The sundial.
//
// Today's face is the instrument the product is named for. The hours run along
// a half-circle, the gnomon stands at its centre, and its shadow falls on the
// hour it is now — or on the hour under your hand, because the face is a time
// machine: move across the arc and the shadow, the readout and the moments lit
// on the ring follow you; move the day ruler and the whole face becomes that
// day, from the record.
//
// Every layer is a claim the record makes and nothing else: the energy curve
// is height, moments are marks on the ring (each a door to its own pane),
// meetings are navy ticks, the hours not yet lived are a wash. The shadow is
// the one moving part.
import { el, svg } from './surfaces.js'
import { plateFraction } from './dial.js'
import { hm, longDate } from './views.js'

const W = 1200
const H = 560
const CX = 600
const CY = 520
const R = 458 // the hour arc
const R0 = 296 // the energy floor
const RH = 128 // full-scale energy height
const R_MOMENTS = 268
const R_DEEP = 246

const DAYS_BACK = 13

const json = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const localHour = (iso) => {
  const d = new Date(iso)
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
}
const clock = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`

/** Polar helpers over the face's hour range. */
function geometry(from, to) {
  const span = Math.max(1, to - from)
  const theta = (h) => Math.PI - (Math.PI * (h - from)) / span
  const at = (h, r) => [CX + r * Math.cos(theta(h)), CY - r * Math.sin(theta(h))]
  const arc = (h1, h2, r) => {
    const [x1, y1] = at(h1, r)
    const [x2, y2] = at(h2, r)
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`
  }
  /** A closed band between two radii over an hour range. */
  const band = (h1, h2, rIn, rOut) => {
    const [ax, ay] = at(h1, rOut)
    const [bx, by] = at(h2, rOut)
    const [cx2, cy2] = at(h2, rIn)
    const [dx, dy] = at(h1, rIn)
    return `M ${ax} ${ay} A ${rOut} ${rOut} 0 0 1 ${bx} ${by} L ${cx2} ${cy2} A ${rIn} ${rIn} 0 0 0 ${dx} ${dy} Z`
  }
  const hourAt = (x, y) => {
    const a = Math.atan2(CY - y, x - CX) // 0 right … π left
    return from + ((Math.PI - a) / Math.PI) * span
  }
  return { theta, at, arc, band, hourAt, from, to }
}

/** The face for one day: the drawing, and the two things that move on it. */
function face(figure, moments, { isToday }) {
  const from = Math.max(0, Math.floor(figure.fromHour ?? 6))
  const to = Math.min(24, Math.ceil(figure.toHour ?? 22))
  const g = geometry(from, to)
  const now = isToday && typeof figure.nowHour === 'number' ? figure.nowHour : null
  const lastSeen = moments.reduce((m, x) => Math.max(m, localHour(x.startTime) + (x.durationMin ?? 0) / 60), from)
  const rest = now ?? Math.min(to, lastSeen)

  const layers = []

  // Hours not yet lived: a wash, never a fill. A claim about evidence.
  if (now !== null && now < to) layers.push(svg('path', { class: 'sd-notyet', d: g.band(now, to, R0, R) }))

  // The energy curve as height off the floor.
  const curve = Array.isArray(figure.curve) ? figure.curve.filter((p) => typeof p.hour === 'number') : []
  if (curve.length > 1) {
    const pts = curve.map((p) => g.at(p.hour + 0.5, R0 + plateFraction(p.score) * RH))
    const [fx, fy] = g.at(curve[0].hour + 0.5, R0)
    const [lx, ly] = g.at(curve[curve.length - 1].hour + 0.5, R0)
    const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
    layers.push(svg('path', { class: 'sd-energy', d: `${line} L ${lx} ${ly} A ${R0} ${R0} 0 0 0 ${fx} ${fy} Z` }))
    layers.push(svg('path', { class: 'sd-energy-line', d: line }))
  }

  // Floors and the hour arc.
  layers.push(svg('path', { class: 'sd-floor', d: g.arc(from, to, R0) }))
  layers.push(svg('path', { class: 'sd-rim', d: g.arc(from, to, R) }))

  // Graduations: a tick every quarter, a longer one and a numeral every hour.
  const ticks = svg('g', { class: 'sd-ticks' })
  for (let h = from; h <= to; h += 0.25) {
    const whole = Number.isInteger(h)
    const [x1, y1] = g.at(h, whole ? R - 16 : R - 7)
    const [x2, y2] = g.at(h, R)
    ticks.append(svg('line', { x1, y1, x2, y2, class: whole ? 'sd-tick-h' : 'sd-tick-q' }))
    if (whole && h < to && (to - from <= 14 || h % 2 === 0)) {
      const [tx, ty] = g.at(h, R + 26)
      ticks.append(svg('text', { x: tx, y: ty, class: 'sd-hour', 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'data-h': h }, [String(h).padStart(2, '0')]))
    }
  }
  layers.push(ticks)

  // Meetings: a reference mark through the band, in the reserved navy.
  for (const meeting of figure.meetings ?? []) {
    if (typeof meeting.startHour !== 'number') continue
    const [x1, y1] = g.at(meeting.startHour, R0 - 4)
    const [x2, y2] = g.at(meeting.startHour, R)
    layers.push(svg('line', { class: 'sd-meeting', x1, y1, x2, y2 }))
  }

  // Observed work under the floor, and the moments ring: each mark a door.
  for (const block of figure.deepBlocks ?? []) {
    layers.push(svg('path', { class: 'sd-work', d: g.arc(block.startHour, Math.max(block.startHour + 0.02, block.endHour), R_DEEP) }))
  }
  const ring = svg('g', { class: 'sd-moments' })
  const marks = []
  for (const m of moments) {
    const min = m.activeMin || m.durationMin || 0
    if (min < 1) continue
    const h1 = Math.max(from, localHour(m.startTime))
    const h2 = Math.min(to, h1 + Math.max((m.durationMin ?? 0) / 60, 0.06))
    if (h2 <= h1) continue
    const mark = svg('path', {
      class: `sd-moment sd-${m.focusQuality ?? 'shallow'}`,
      d: g.arc(h1, h2, R_MOMENTS),
      'data-explore': `moment:${m.id}`,
      tabindex: '0',
      role: 'link',
    })
    mark._span = [h1, h2]
    mark._m = m
    mark.append(svg('title', {}, [`${clock(h1)} · ${m.intent ?? m.title ?? m.processName ?? ''} · ${hm(min)}`]))
    marks.push(mark)
    ring.append(mark)
  }
  layers.push(ring)

  // The shadow: from the gnomon's foot to the rim, with the now-mark at its tip.
  const shadow = svg('line', { class: 'sd-shadow', x1: CX, y1: CY })
  const tip = svg('rect', { class: 'sd-tip', width: 10, height: 10 })
  // The readout rides the tip, outside the numerals: the hour, and what the
  // record holds under it.
  const readHour = svg('text', { class: 'sd-read-hour', 'dominant-baseline': 'middle' })
  const readWhat = svg('text', { class: 'sd-read-what', 'dominant-baseline': 'middle' })
  layers.push(shadow, tip, readHour, readWhat)

  const drawing = svg('svg', { class: 'sd-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `The day as a sundial, ${from}:00 to ${to}:00` }, layers)

  /** Move the shadow to an hour; light the moments under it. */
  const setHour = (h, { reading = true } = {}) => {
    const hh = Math.min(to, Math.max(from, h))
    const [x2, y2] = g.at(hh, R - 20)
    shadow.setAttribute('x2', x2)
    shadow.setAttribute('y2', y2)
    const [tx, ty] = g.at(hh, R - 20)
    tip.setAttribute('x', tx - 5)
    tip.setAttribute('y', ty - 5)
    for (const t of ticks.querySelectorAll('.sd-hour')) t.classList.toggle('sd-hour-lit', Number(t.dataset.h) === Math.floor(hh))
    // Left half reads outward to the left, right half to the right, so the text never crosses the arc.
    const left = hh < (from + to) / 2
    const [rx, ry] = g.at(hh, R + 58)
    for (const t of [readHour, readWhat]) {
      t.setAttribute('x', rx)
      t.setAttribute('text-anchor', left ? 'end' : 'start')
    }
    readHour.setAttribute('y', ry - 9)
    readWhat.setAttribute('y', ry + 11)
    let under = null
    for (const mark of marks) {
      const lit = hh >= mark._span[0] && hh <= mark._span[1]
      mark.classList.toggle('sd-lit', lit)
      if (lit) under = under ?? mark._m
    }
    if (reading) {
      readHour.textContent = clock(hh)
      const what = under ? [under.intent ?? under.title ?? under.processName, under.projectId ? under.projectId.split('/').pop() : null].filter(Boolean).join(' · ') : now !== null && hh > now ? 'not yet' : ''
      readWhat.textContent = what.length > 38 ? `${what.slice(0, 37)}…` : what
    }
  }

  // The hand: hover scrubs, leaving returns to now (or to the last hour seen).
  let pinned = null
  drawing.addEventListener('pointermove', (event) => {
    if (pinned !== null) return
    const rect = drawing.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * W
    const y = ((event.clientY - rect.top) / rect.height) * H
    if (y > CY) return
    setHour(g.hourAt(x, y))
  })
  drawing.addEventListener('pointerleave', () => pinned === null && setHour(rest))
  // A click on the face (not on a mark) pins the shadow; a second one frees it.
  drawing.addEventListener('click', (event) => {
    if (event.target.closest('.sd-moment')) return
    const rect = drawing.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * W
    const y = ((event.clientY - rect.top) / rect.height) * H
    pinned = pinned === null ? g.hourAt(x, y) : null
    drawing.classList.toggle('sd-pinned', pinned !== null)
    setHour(pinned ?? rest)
  })

  setHour(rest)

  // Arrival: the shadow sweeps from dawn to now, once. Meaning is in the end
  // state, so reduced motion simply starts there.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && rest > from) {
    const t0 = performance.now()
    const D = 900
    const ease = (t) => 1 - Math.pow(1 - t, 3)
    const step = (t) => {
      const k = Math.min(1, (t - t0) / D)
      setHour(from + (rest - from) * ease(k), { reading: k === 1 })
      if (k < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  return { drawing, from, to }
}

/**
 * The sundial block for Today: the face for a day, the day ruler under it, the
 * gnomon standing at its centre, and the reading in the open middle.
 *
 * `figure` and `day` are today's, already fetched; another day is fetched here
 * when the ruler moves. Every fetch is the same two routes Today already reads.
 */
export function sundial(figure, day, { onAsk } = {}) {
  const today = figure?.date ?? day?.date ?? ymd(new Date())
  const box = el('div', { class: 'sundial' })
  const stageEl = el('div', { class: 'sd-stage' })
  const gnomon = el('div', { class: 'sd-gnomon', 'aria-hidden': 'true' }, [
    svg('svg', { viewBox: '0 0 40 60', width: 40, height: 60 }, [
      svg('ellipse', { class: 'sd-plate', cx: 20, cy: 56, rx: 17, ry: 3.5 }),
      svg('line', { class: 'sd-rod', x1: 20, y1: 56, x2: 20, y2: 8 }),
      svg('rect', { class: 'sd-rodtip', x: 17, y: 5, width: 6, height: 6 }),
    ]),
  ])
  const numeral = el('span', { class: 'numeral sd-numeral' })
  const dateLine = el('span', { class: 'eyebrow sd-date' })
  const ofLine = el('span', { class: 'observed sd-of' })
  const reading = el('div', { class: 'sd-reading' }, [dateLine, numeral, ofLine])

  // The day ruler: a native range, drawn as a graduated rule with the weekday
  // initials beneath. Today is the right end.
  const labels = el('div', { class: 'sd-days' })
  const range = el('input', { class: 'sd-range', type: 'range', min: String(-DAYS_BACK), max: '0', step: '1', value: '0', 'aria-label': 'Which day the face shows' })
  const base = new Date(`${today}T12:00:00`)
  for (let i = -DAYS_BACK; i <= 0; i++) {
    const d = new Date(base)
    d.setDate(base.getDate() + i)
    labels.append(el('span', { class: `sd-day${i === 0 ? ' sd-day-today' : ''}`, text: d.toLocaleDateString(undefined, { weekday: 'narrow' }), title: ymd(d) }))
  }
  const ruler = el('div', { class: 'sd-ruler' }, [range, labels])

  const cache = new Map([[today, { figure, day }]])
  let shown = null

  const render = (date, f, d) => {
    shown = date
    // The calendar's today, not the figure's date: a card set to another day
    // (its `date` filter) passes that day's figure in, and said "Today" over it.
    const isToday = date === ymd(new Date())
    const moments = Array.isArray(d?.moments) ? d.moments : []
    stageEl.replaceChildren()
    if (!f || f.unavailable || !Array.isArray(f.curve)) {
      stageEl.append(el('div', { class: 'dial-empty', text: f?.unavailable || 'Nothing observed that day.' }))
    } else stageEl.append(face(f, moments, { isToday }).drawing)
    stageEl.append(gnomon, reading)
    numeral.textContent = hm(f?.observedMin ?? 0)
    numeral.dataset.value = hm(f?.observedMin ?? 0)
    dateLine.textContent = isToday ? `Today · ${longDate(date)}` : longDate(date)
    ofLine.textContent = f?.wallClockMin ? `observed of ${hm(f.wallClockMin)}` : ''
    for (const l of labels.children) l.classList.toggle('sd-day-shown', l.title === date)
    box.dataset.today = String(isToday)
  }

  range.addEventListener('input', async () => {
    const d = new Date(base)
    d.setDate(base.getDate() + Number(range.value))
    const date = ymd(d)
    if (date === shown) return
    if (!cache.has(date)) {
      dateLine.textContent = `${longDate(date)} · reading…`
      const [f, dd] = await Promise.all([json(`/gnomon/dial?date=${date}`).catch(() => null), json(`/gnomon/day?date=${date}`).catch(() => null)])
      cache.set(date, { figure: f, day: dd })
      if (Number(range.value) !== Math.round((d - base) / 86_400_000)) return
    }
    const c = cache.get(date)
    render(date, c.figure, c.day)
  })

  render(today, figure, day)
  box.append(stageEl, ruler)
  if (onAsk) {
    box.addEventListener('dblclick', (event) => {
      if (event.target.closest('.sd-moment, .sd-ruler')) return
      onAsk(`the face for ${shown}`, shown === today ? 'How is today going, in one breath?' : `How did ${shown} go?`)
    })
  }
  return box
}
