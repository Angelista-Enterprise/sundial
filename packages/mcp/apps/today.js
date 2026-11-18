// The Today app: the standup brief, today's dial, the day's numbers, and the last two weeks' rhythm.
//
// Draws `gnomon_today`'s structuredContent: `{ date, timeZone, brief, dial, today, rhythm }`,
// each part exactly what the web client's own route returns for it (gnomon_brief standup,
// the dial-slice figure, /gnomon/today, /gnomon/rhythm), so this card and the web client's
// Today cannot disagree. The Claude mod draws the same object in its band.
import { dayArc } from '../../../plugins/sundial-theme/shell/day-arc.js'
import { dialPlate } from '../../../plugins/sundial-theme/shell/dial.js'
import { el } from '../../../plugins/sundial-theme/shell/surfaces.js'
import { clock, frame, hm } from './lib.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const when = (date) => `${DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()]} ${Number(date.slice(8, 10))}`

export function brief(data) {
  const lines = Array.isArray(data?.lines) ? data.lines : []
  if (lines.length === 0) return el('div', { class: 'surface-fail', text: data?.unavailable ?? data?.none ?? 'Nothing on the record for a standup yet.' })
  return el('ul', { class: 'app-list' }, lines.map((line) => el('li', { class: 'app-line', text: String(line) })))
}

export function dial(figure) {
  if (!figure || typeof figure.kind !== 'string') return el('div', { class: 'surface-fail', text: figure?.unavailable ?? 'No dial for this day.' })
  return el('div', { class: 'plate' }, dialPlate(figure))
}

export function projects(today) {
  const rows = Array.isArray(today?.projects) ? today.projects : []
  if (rows.length === 0) return el('div', { class: 'surface-fail', text: 'No project time observed.' })
  return el('div', { class: 'app-rows' }, rows.map((p) => el('div', { class: 'app-row' }, [el('span', { class: 'app-name', text: p.name }), el('span', { class: 'app-num', text: `${hm(p.minutes)}${p.commits ? ` · ${p.commits} commit${p.commits === 1 ? '' : 's'}` : ''}` })])))
}

export function rhythm(data) {
  const days = Array.isArray(data?.days) ? data.days : []
  if (days.length === 0) return el('div', { class: 'surface-fail', text: 'No days observed in the window.' })
  const start = data.dayStartsAt ?? 4
  return el('div', { class: 'arc-list' }, [...days].reverse().map((day, i) => {
    const isToday = day.date === data.today
    return el('div', { class: 'arc-line', 'data-today': isToday ? 'yes' : 'no', style: { '--i': i } }, [
      el('span', { class: 'arc-when', text: when(day.date) }),
      el('span', { class: 'arc-cell' }, dayArc({ day, width: 420, now: isToday ? data.nowMin ?? null : null })),
      el('span', { class: 'arc-span-text', text: `${clock(day.firstMin, start)}–${clock(day.lastMin, start)}` }),
      el('span', { class: 'arc-active', text: typeof day.observedHours === 'number' ? `${day.observedHours}h seen` : '' }),
    ])
  }))
}

export function draw(data) {
  const caption = typeof data?.dial?.caption === 'string' ? data.dial.caption.split(' · ').slice(1).join(' · ') : ''
  return el('div', {}, [
    frame('Today', data?.date ?? '', brief(data?.brief)),
    frame('Dial', caption, dial(data?.dial)),
    frame('Projects', data?.today?.meetings ? `${data.today.meetings} meeting${data.today.meetings === 1 ? '' : 's'}` : '', projects(data?.today)),
    frame('Rhythm', data?.rhythm?.days?.length ? `${data.rhythm.days.length} days` : '', rhythm(data?.rhythm)),
  ])
}
