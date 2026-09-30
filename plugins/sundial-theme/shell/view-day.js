// One day, read back: what the sensors saw and the day's columns.
import { el, newestFirst } from './surfaces.js'
import { momentBrief } from './moment-detail.js'
import { hm, panel, table } from './view-kit.js'

/**
 * What the day AMOUNTED to, not what the request was.
 *
 * The three fields here were date, count and timezone — two of them the
 * question rather than the answer. These are read off the moments the panel
 * already has: no route, no second query. Wall time and active time are kept
 * apart for the reason the table keeps them apart, and "understood" is the
 * ratio the trust card promised and never showed on a day.
 */
export function whatItSaw(d) {
  const moments = Array.isArray(d.moments) ? d.moments : []
  const sum = (pick) => moments.reduce((total, m) => total + (typeof pick(m) === 'number' ? pick(m) : 0), 0)
  const distinct = (pick) => new Set(moments.map(pick).filter((v) => typeof v === 'string' && v !== '')).size
  const understood = moments.filter((m) => typeof m.intent === 'string' && m.intent !== '').length
  const spoken = moments.filter((m) => typeof m.data?.spokenExcerpt === 'string' && m.data.spokenExcerpt !== '').length
  const commands = sum((m) => m.data?.shellCommandCount)
  const apps = distinct((m) => m.processName)
  const projects = distinct((m) => m.projectId)
  return [
    [['day', 'Date'], d.date ?? '—', d.timeZone ?? ''],
    [['seen', 'Watched'], moments.length === 0 ? '—' : `${hm(sum((m) => m.durationMin))} over ${moments.length} moments`, moments.length ? `${hm(sum((m) => m.activeMin))} of it active` : ''],
    // The honest ratio: a moment with no intent is one Gnomon logged and never
    // read. Shown on the day it happened, not only in the trust summary.
    [['read', 'Understood'], moments.length === 0 ? '—' : `${understood} of ${moments.length}`, moments.length ? `${Math.round((understood / moments.length) * 100)}%` : ''],
    [['project', 'Where'], moments.length === 0 ? '—' : `${apps} app${apps === 1 ? '' : 's'}${projects ? ` · ${projects} project${projects === 1 ? '' : 's'}` : ''}`, ''],
    commands > 0 ? [['terminal', 'Commands'], String(commands), 'shell'] : null,
    spoken > 0 ? [['heard', 'Heard'], `${spoken} moment${spoken === 1 ? '' : 's'} with speech`, ''] : null,
  ].filter(Boolean)
}

export const hhmm = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * Both ends of a moment, as one span.
 *
 * On a 12-hour locale "10:17 AM–10:18 AM" says AM twice; the marker belongs on
 * the end that settles it. On a 24-hour locale there is no marker and this is
 * simply the two clocks. A span that rounds to the same minute is one clock.
 */
export function span(startTime, endTime) {
  const from = hhmm(startTime)
  if (!endTime) return from
  const to = hhmm(endTime)
  if (to === from) return from
  const marker = to.match(/\s\S+$/)?.[0]
  return `${marker && from.endsWith(marker) ? from.slice(0, -marker.length) : from}–${to}`
}

/** What the Day's table already has a column for, and the fold must not repeat. */
export const DAY_COLUMNS = ['when', 'long', 'focus', 'app', 'project', 'intent']

export function dayPanel(d) {
  return [
    panel('What it saw', whatItSaw(d), 'Open a row to see what stands behind it.'),
    d.moments?.length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'Moments' }),
          table(
            [
              // Both ends in the one cell. The fold used to repeat the span as
              // its own line, which put the same clock on screen three times;
              // it belongs in the timestamp, which is where the eye already is.
              { label: 'When', cell: (r) => el('span', { class: r.id ? 'door' : null, 'data-explore': r.id ? `moment:${r.id}` : null, tabindex: r.id ? '0' : null, role: r.id ? 'link' : null, text: span(r.startTime, r.endTime) }) },
              // Duration and ACTIVE are kept apart on purpose: a long moment
              // with no active minutes is a window that stayed open, not work.
              { label: 'For', num: true, cell: (r) => hm(r.durationMin) },
              { label: 'Active', num: true, cell: (r) => hm(r.activeMin) },
              { label: 'App', cell: (r) => r.processName ?? '—' },
              { label: 'Project', cell: (r) => r.projectId ?? '—' },
              { label: 'Focus', cell: (r) => r.focusQuality ?? '—' },
              { label: 'Intent', cell: (r) => r.intent ?? '—' },
            ],
            // Newest on top. The route answers in chronological order, which is
            // right for building a day's story and wrong for reading one.
            newestFirst(d.moments, (m) => m.startTime).slice(0, 60),
            // The fold adds; it does not repeat. Six of this table's columns
            // are named here so the brief leaves them out — a fold carrying the
            // time, duration, focus, app, project and intent printed the same
            // moment three times over. What is left is what has no column:
            // branch, commits, commands, windows, speech, cost, context.
            (r) => {
              const parts = momentBrief(r, { omit: DAY_COLUMNS, sentence: false })
              return parts.length === 0 ? [] : [el('div', { class: 'moment-brief' }, parts)]
            },
          ),
        ])
      : el('div', { class: 'none', text: 'Nothing recorded for this day yet.' }),
  ]
}
