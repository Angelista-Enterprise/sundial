// The three things Gnomon says without being asked: the day, what its thinking
// costs, and whether its thinking is any good.
//
// WHERE THEY LIVE, and why.
//
// Today is not a page. It is the canvas's ZERO STATE — the first block of a
// fresh session, above the first thing you say. That is the honest place for
// it: the day is what Gnomon has to tell you before you tell it anything, and
// once you start talking the conversation grows underneath your own day rather
// than replacing it. It was a page before only because dsh's landing screen was
// the only seat a plugin could reach.
//
// The Ledger and the Instruments are not pages either, and they are not
// overlays. They are the canvas showing something other than a conversation,
// reached from the rail's foot. An overlay was the old shape because the old
// client could not have the canvas; owning it means a view switch, which is one
// less layer to reason about and cannot end up stacked under another page.
//
// None of these recompute anything. Every number here is a projection of a
// route that already existed and had no reader.
import { el, newestFirst, svg } from './surfaces.js'
import { INSTRUMENT_ROUTES, TODAY_PARTS as CATALOG_TODAY_PARTS } from './cards.js'
import { postVerdict, verdictActs } from './verdicts.js'
import { strata } from './strata.js'
import { sundial } from './sundial.js'
import { boardLink, renderMarkdown } from './markdown.js'
import { read, whenVisible } from './read.js'
import { momentBrief, momentRow } from './moment-detail.js'
import { factLine, factSentence, ownerFirst, stackedBlock } from './blocks.js'
import { icon, iconLabel } from './icons.js'
import { status, statusWord } from './status.js'
import { formatSteps, nextStepState, stepProgress } from './goals.js'
import { goalTrail, trailScale } from './goal-trail.js'
import { dayClock, dayScale, scaleHours } from './day-clock.js'
import { KIND_WORDS, askCensus, askGist, askQuieting, askSubject, minuteOfDay, routePrefill, waitMinutes } from './asks.js'
import { GATE_DAILY_BUDGET, barsFor, biasSentence, gateCensus, outcomeOf, placedWeight, weightAt, weightScale, whySentence } from './gate.js'
import { gateLadder } from './gate-ladder.js'
import { SPEECH, sensorRoster, switchedOn } from './sensors.js'
import { coverageGrid, coverageWeeks, weekdayOf, weekdayTypical } from './coverage-grid.js'
import { MIN_SCORED, calibrationLine, coverage, lean, reliability } from './calibration.js'
import { STALE_AFTER_DAYS, labCensus, study } from './lab.js'
import { RUNGS, VERDICT, byVerdict, capability, registry, tightenedByConfig, usedSentence, usedTitle, usedWord, verdictAt } from './reach.js'
import { arcHours, bedtimeBand, dayArc, typicalDay } from './day-arc.js'
import { bedtimeCensus, bedtimeWeeks } from './bedtime.js'
import { reliabilityPlot } from './reliability.js'
import { DOING, FAMILIES, compositionBar, doing, journalDays, share } from './trace.js'

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

const num = (value, digits = 0) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—')
/** A duration in milliseconds, as seconds — the unit every latency on the Ledger is read in. */
const secs = (ms) => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : '—')
/** An instant, in the reader's own locale. Dropped to a dash rather than "Invalid Date" when a row carries no timestamp. */
const when = (iso) => {
  const at = iso ? new Date(iso) : null
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'
}
const pct = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—')

// Every reading goes through the shared reader: one request per route however
// many cards want it, and a name in the head while it is in flight. See read.js.
const json = (url) => read(url)

/**
 * A titled block of `label → value` rows. The grammar every instrument uses.
 *
 * A label may be a plain string or `[iconName, string]`, which draws the icon
 * beside the word. Never the icon alone — see `icons.js`.
 */
function panel(title, rows, note) {
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
function table(columns, rows, expand) {
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

// ── Today ─────────────────────────────────────────────────────────────────

/** Motion is a courtesy, not a requirement: honour the system's request to skip it. */
const stillness = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A number that arrives rather than appears. Counts from zero to the value over
 * `ms`, formatting each frame with `format`. Under reduced motion it just lands.
 */
function countUp(node, value, format, ms = 700) {
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
function shareBar(share, className = '') {
  const fill = el('span', { class: 'share-fill', style: { width: '0%' } })
  const bar = el('span', { class: `share ${className}` }, [fill])
  requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`)))
  return bar
}

/** Staggered arrival: each child of `node` rises in a beat after the one before. */
function stagger(node, from = 0) {
  let i = from
  for (const child of node.children) {
    child.classList.add('arrive')
    child.style.setProperty('--i', String(i++))
  }
  return node
}

/** `HH:MM` in the reader's own zone. The one clock in this file. */
export const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const shortDay = (ymd) => {
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
function weekStrip(shape, todayYmd) {
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

/**
 * Open commitments — the branches with work on them — ordered by how recently
 * they were touched. The quiet ones fade, because a branch nobody has touched
 * in a week is a different kind of open.
 */
function inPlay(habits, onAsk, project = null) {
  const all = Array.isArray(habits?.commitments?.open) ? [...habits.commitments.open] : []
  const open = project ? all.filter((c) => c.project === project) : all
  if (open.length === 0) return null
  const shown = newestFirst(open, (t) => t.lastTouchedAt)
  return el('div', { class: 'col' }, [
    el('div', { class: 'col-head' }, [el('h3', { class: 'col-title', text: 'In play' }), el('span', { class: 'col-hint', text: `${open.length} open` })]),
    stagger(
      el(
        'div',
        {},
        shown.map((c) =>
          el(
            'button',
            {
              type: 'button',
              class: `row row-ask${(c.quietDays ?? 0) >= 5 ? ' row-faint' : ''}`,
              title: `${c.branch ?? c.name} in ${c.project ?? '?'} — touched ${c.touches ?? 0}× over ${c.activeDays ?? 0} day(s)`,
              'data-explore': `search:${c.name}`,
            },
            [
              el('span', { class: 'row-name' }, [el('span', { text: c.source === 'speech' ? `“${c.name}”` : c.name }), c.project ? el('span', { class: 'row-sub', text: ` · ${c.project}` }) : null, c.source === 'speech' ? el('span', { class: 'row-sub', text: ' · heard' }) : null]),
              // J4.4: a promise heard aloud has no branch to go quiet on; the
              // owner's word closes it. One act, settling into the word it did.
              c.source === 'speech' ? doneAct(c.id) : el('span', { class: 'row-value', text: c.quietDays === 0 ? 'today' : `${c.quietDays}d quiet` }),
            ],
          ),
        ),
      ),
    ),
  ])
}

/**
 * In play — what the owner is in the middle of, and what they are aiming at.
 * The one owner of goals and open commitments: Activity's In play tab, the
 * Goals instrument and Habits' open threads each showed a slice of this, and
 * the same branch on three cards read as three facts. `project` narrows the
 * commitments to one project (goals carry no project, so they stay).
 */
export async function inPlayCard(onAsk, filters = null) {
  const [goals, habits] = await Promise.all([json('/gnomon/goals').catch(() => null), json('/gnomon/habits').catch(() => null)])
  const project = filters?.project ?? null
  return el('section', { class: 'today today-part' }, [
    inPlay(habits, onAsk, project) ?? el('div', { class: 'none', text: project ? `Nothing open on ${project}.` : 'Nothing open.' }),
    goalsSection(goals),
  ])
}

/**
 * Rhythm — what the owner's days look like over time. The one owner of the
 * fortnight's shape: This week, Strata, the Rhythm instrument and Habits each
 * held a view of the same days. Strata leads; `view` opens it on one section.
 */
const RHYTHM_VIEWS = ['strata', 'days', 'arcs', 'habits']
export async function rhythmCard(filters = null) {
  const [shape, rhythm, habits] = await Promise.all([json('/gnomon/shape').catch(() => null), json('/gnomon/rhythm').catch(() => null), json('/gnomon/habits').catch(() => null)])
  const sections = {
    strata: shape ? [strata(shape)] : [],
    days: shape ? [weekStrip(shape, new Date().toISOString().slice(0, 10))] : [],
    arcs: rhythm ? rhythmPanel(rhythm) : [],
    habits: habits ? habitsPanel(habits) : [],
  }
  const view = RHYTHM_VIEWS.includes(filters?.view) ? filters.view : null
  const shown = (view ? sections[view] : RHYTHM_VIEWS.flatMap((k) => sections[k])).filter(Boolean)
  return el('section', { class: 'view-body rhythm-card' }, shown.length ? shown : [el('div', { class: 'none', text: 'Fewer than two days on the record.' })])
}

/**
 * Voice — what Gnomon noticed, what it said, held back or dropped and why,
 * and what it asked and heard back. The Unsaid and Asks instruments and the
 * day's Noticed column each held part of this; `view` opens one half.
 */
export async function voiceCard(filters = null) {
  const [unsaid, asks] = await Promise.all([json('/gnomon/unsaid').catch(() => null), json('/gnomon/asks').catch(() => null)])
  const sections = { noticing: unsaid ? unsaidPanel(unsaid) : [], asks: asks ? [asksPanel(asks)] : [] }
  const view = sections[filters?.view] ? filters.view : null
  const shown = (view ? sections[view] : [...sections.noticing, ...sections.asks]).filter(Boolean)
  return el('section', { class: 'view-body' }, shown.length ? shown : [el('div', { class: 'none', text: 'Gnomon has not noticed anything yet.' })])
}

/**
 * The Engine room — is Gnomon working, affordable and honest. The Ledger and
 * the five About-Gnomon instruments, one step back from the floor, as tabs.
 * A tab pressed is written to the record as the card's `tab` filter, so the
 * owner's choice and Gnomon's pointing are one setting.
 */
export const ENGINE_TABS = [
  ['cost', 'Cost'],
  ['trust', 'Trust'],
  ['calibration', 'Calibration'],
  ['lab', 'Lab'],
  ['reach', 'Reach'],
  ['trace', 'Trace'],
]
// The tab on screen, kept across the card's rebuild: a tab press writes the
// filter to the record and the card is drawn anew, and a new tab starts as
// one "Reading…" line. The old tab stays in place until the new one has its
// reading, then the new one fades over it — no collapse, no jump.
let shownTab = null
export async function engineCard(filters = null, onTab = () => {}) {
  const tab = ENGINE_TABS.some(([k]) => k === filters?.tab) ? filters.tab : 'cost'
  const when = el('span', { class: 'view-when' })
  const strip = el('div', { class: 'tabs' }, ENGINE_TABS.map(([k, label]) => el('button', { type: 'button', class: 'tab', text: label, 'aria-current': String(k === tab), onclick: () => k !== tab && onTab(k) })))
  const body = tab === 'cost' ? await ledgerView(undefined, when) : (await instrumentPane(tab)).node
  const old = shownTab
  const stack = el('div', { class: 'tab-stack' }, old ? [old, body] : [body])
  const settle = () => {
    if (body.querySelector('.reading')) return false
    old?.remove()
    body.classList.remove('tab-next')
    shownTab = body
    return true
  }
  if (old) {
    body.classList.add('tab-next')
    const watch = new MutationObserver(() => settle() && watch.disconnect())
    watch.observe(body, { childList: true, subtree: true })
    setTimeout(() => settle() || (old.remove(), body.classList.remove('tab-next'), (shownTab = body), watch.disconnect()), 8000)
  } else shownTab = body
  return el('div', { class: 'view engine' }, [el('div', { class: 'view-head engine-head' }, [strip, when]), stack])
}

/** The owner closing a heard promise: `commitment:closed` through the kernel, then the row says so. */
function doneAct(id) {
  const act = el('button', {
    type: 'button',
    class: 'act act-small',
    text: 'Done',
    title: 'Close this promise — you kept it, or it no longer stands',
    onclick: async (e) => {
      e.stopPropagation()
      act.disabled = true
      const ok = await fetch('/gnomon/api/commitment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, close: true }) }).then((r) => r.ok).catch(() => false)
      act.replaceWith(el('span', { class: 'verdict-done', text: ok ? 'closed' : 'not recorded' }))
    },
  })
  return act
}


/**
 * The files worked in most today, with the share of all changes. The file
 * watcher records thirteen thousand changes a week; until this they fed a ring
 * in state and one line of the presence strip.
 */
function filesToday(hotFiles, onAsk) {
  const files = Array.isArray(hotFiles) ? hotFiles.filter((f) => (f.changes ?? 0) >= 2).slice(0, 6) : []
  if (files.length === 0) return null
  const total = files.reduce((n, f) => n + (f.changes ?? 0), 0)
  return el('section', { class: 'files' }, [
    el('div', { class: 'col-head' }, [el('h3', { class: 'col-title', text: 'Files today' }), el('span', { class: 'col-hint', text: `${total} saves across ${files.length} files` })]),
    stagger(
      el(
        'div',
        {},
        files.map((f) =>
          el(
            'button',
            {
              type: 'button',
              class: 'row row-ask file-row',
              title: `${f.project}/${f.path} — ${f.changes} saves, ${f.focusedChanges ?? 0} while focused`,
              'data-explore': `search:${f.path.split('/').pop()}`,
            },
            [
              el('span', { class: 'row-name' }, [el('span', { class: 'file-name', text: f.path.split('/').pop() }), el('span', { class: 'row-sub', text: ` · ${f.project}${f.path.includes('/') ? ` / ${f.path.split('/').slice(0, -1).join('/')}` : ''}` })]),
              el('span', { class: 'row-value', text: `${f.changes}×` }),
              shareBar(total > 0 ? (f.changes ?? 0) / total : 0),
            ],
          ),
        ),
      ),
    ),
  ])
}

/**
 * Untracked time, and what to call it.
 *
 * The kernel times every unattributed focus period by host or app
 * (`attributionPropose`); this is where the biggest become a question the owner
 * can answer in one click. A card names the place, how much time it took, what
 * it looked like, and offers the projects the owner already has — the likeliest
 * first. "Track as X" writes a rule and applies it from the next window on;
 * "Not work" and "Ignore" are decisions too, so the card does not come back.
 * Nothing here is inferred as fact: it is the residue of refusing to guess,
 * handed to the one person who knows.
 */
function proposalsSection(data, onAsk) {
  const proposals = Array.isArray(data?.proposals) ? data.proposals : []
  if (proposals.length === 0) return null
  const projects = Array.isArray(data?.projects) ? data.projects : []

  /**
   * One card, one place, and a SCOPE — because a place is not always one
   * project. figma.com carries Northwind, Puzzles and overture; localhost:8080
   * carries a puzzles path and a hub path. The scope rows are the whole place
   * plus each part Gnomon timed separately, so the owner answers the question
   * they can actually answer: "this path is Northwind", not "figma is Northwind".
   *
   * The two other answers are first-class, not an afterthought: Slack, Meet and
   * the shared vault are WORK BUT NOT ONE PROJECT, and Spotify is not work at
   * all. Before this the only options were a wrong rule or Ignore, so a
   * hundred minutes of Obsidian sat in "untracked" for ever.
   */
  const card = (pr) => {
    const wrap = el('article', { class: 'proposal', 'data-kind': pr.kind })
    const parts = Array.isArray(pr.parts) ? pr.parts : []
    // null = the whole place; otherwise the partKey being assigned.
    let scope = null
    let chosen = pr.suggested ?? null

    const scopes = el('div', { class: 'proposal-scopes' })
    const chips = el('div', { class: 'proposal-chips' })
    const other = el('input', { class: 'proposal-other', type: 'text', placeholder: 'or a new name…', 'aria-label': 'Another project name', maxlength: '60' })
    const track = el('button', { type: 'button', class: 'act act-small proposal-track', disabled: true })

    const scopeLabel = () => (scope === null ? pr.label : (parts.find((part) => part.partKey === scope)?.label ?? pr.label))
    const refreshTrack = () => {
      track.disabled = chosen === null || chosen === ''
      track.textContent = chosen ? `Track ${scopeLabel()} as ${chosen}` : 'Track as…'
    }
    const setScope = (next) => {
      scope = next
      for (const row of scopes.querySelectorAll('.proposal-scope')) row.setAttribute('aria-pressed', String((row.dataset.part || null) === next))
      // A part carries its own guess — `/file/eteck1` suggests northwind where the
      // host suggests nothing.
      const suggested = next === null ? pr.suggested : (parts.find((part) => part.partKey === next)?.suggested ?? pr.suggested)
      if (suggested) setChosen(suggested)
      else refreshTrack()
    }
    const setChosen = (name) => {
      chosen = name
      for (const chip of chips.querySelectorAll('.chip-pick')) chip.setAttribute('aria-pressed', String(chip.dataset.name === name))
      if (name !== null && other.value !== name) other.value = ''
      refreshTrack()
    }

    if (parts.length > 1) {
      scopes.append(
        el('button', { type: 'button', class: 'proposal-scope', 'data-part': '', 'aria-pressed': 'true', title: 'The whole place, one project', onclick: () => setScope(null) }, [
          el('span', { class: 'scope-label', text: `all of ${pr.label}` }),
          el('span', { class: 'scope-time', text: hm(pr.minutes) }),
        ]),
      )
      for (const part of parts) {
        scopes.append(
          el('button', { type: 'button', class: 'proposal-scope', 'data-part': part.partKey, 'aria-pressed': 'false', title: `${part.visits} visit${part.visits === 1 ? '' : 's'} — assign just this ${part.kind}`, onclick: () => setScope(part.partKey) }, [
            el('span', { class: `scope-label scope-${part.kind}`, text: part.kind === 'meeting' ? `meeting: ${part.label}` : part.label }),
            el('span', { class: 'scope-time', text: hm(part.minutes) }),
          ]),
        )
      }
    }

    const ordered = [...(pr.suggested ? [pr.suggested] : []), ...projects.filter((n) => n !== pr.suggested)].slice(0, 7)
    for (const name of ordered) {
      chips.append(
        el('button', {
          type: 'button',
          class: `chip-pick${name === pr.suggested ? ' chip-pick-suggested' : ''}`,
          'data-name': name,
          'aria-pressed': String(name === chosen),
          title: name === pr.suggested ? "Gnomon's guess, from the titles" : `Track as ${name}`,
          text: name,
          onclick: () => setChosen(name),
        }),
      )
    }
    other.addEventListener('input', () => {
      const v = other.value.trim()
      if (v !== '') {
        chosen = v
        for (const chip of chips.querySelectorAll('.chip-pick')) chip.setAttribute('aria-pressed', 'false')
        refreshTrack()
      } else setChosen(pr.suggested ?? null)
    })
    other.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !track.disabled) {
        e.preventDefault()
        track.click()
      }
    })

    const acts = el('div', { class: 'proposal-acts' })
    const settle = (text, cls) => {
      wrap.setAttribute('data-settled', '')
      if (cls) wrap.classList.add(cls)
      acts.replaceChildren()
      wrap.querySelector('.proposal-head').append(el('span', { class: 'proposal-outcome', text }))
      setTimeout(() => wrap.setAttribute('data-folded', ''), 900)
    }
    const decide = async (decision) => {
      const scopedPart = decision === 'assign' ? scope : null
      const label = scopeLabel()
      for (const b of wrap.querySelectorAll('button, input')) b.disabled = true
      let ok = false
      try {
        const res = await fetch('/gnomon/attribution/decide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: pr.key, decision, ...(decision === 'assign' ? { project: chosen } : {}), ...(scopedPart ? { partKey: scopedPart } : {}) }),
        })
        ok = res.ok
      } catch {
        ok = false
      }
      if (!ok) {
        for (const b of wrap.querySelectorAll('button, input')) b.disabled = false
        acts.prepend(el('span', { class: 'proposal-fail', text: 'Not recorded — try again.' }))
        return
      }
      if (decision === 'assign' && scopedPart) settle(`${label} is ${chosen} from now on. The rest of ${pr.label} is still open.`, 'proposal-kept')
      else if (decision === 'assign') settle(`Tracked as ${chosen} from now on. Past time stays as it was.`, 'proposal-kept')
      else if (decision === 'shared') settle('Shared work — counted, never asked about again.', 'proposal-kept')
      else if (decision === 'personal') settle('Your own time. It stops counting as work.', 'proposal-dim')
      else if (decision === 'ambient') settle('Background. It plays while you work and counts as neither.', 'proposal-dim')
      else settle('Ignored. It will not be proposed again.', 'proposal-dim')
    }
    track.addEventListener('click', () => decide('assign'))
    acts.append(
      track,
      el('button', { type: 'button', class: 'act act-small', text: 'Shared work', title: 'Work, but no single project — Slack, Meet, the shared vault', onclick: () => decide('shared') }),
      el('button', { type: 'button', class: 'act act-small', text: 'Personal', title: 'Not work — private browsing, errands', onclick: () => decide('personal') }),
      el('button', { type: 'button', class: 'act act-small', text: 'Background', title: 'Music or audio playing while you work — not leisure, not a project', onclick: () => decide('ambient') }),
      el('button', { type: 'button', class: 'act act-small', text: 'Ignore', title: 'Not worth tracking either way', onclick: () => decide('ignore') }),
    )

    const titles = (pr.titles ?? []).filter((t) => t && t !== pr.label && !parts.some((part) => part.label === t))
    wrap.append(
      el('div', { class: 'proposal-head' }, [
        el('span', { class: 'proposal-kind', text: pr.kind === 'host' ? 'site' : 'app' }),
        el('button', {
          type: 'button',
          class: 'proposal-label row-ask',
          title: 'Find this in the record',
          text: pr.label,
          'data-explore': `search:${pr.label}`,
        }),
        el('span', { class: 'proposal-time' }, [el('span', { class: 'proposal-min', text: hm(pr.minutes) }), el('span', { text: ` · ${pr.visits} visit${pr.visits === 1 ? '' : 's'} · ${pr.days} day${pr.days === 1 ? '' : 's'}` })]),
      ]),
      el('div', { class: 'proposal-fold' }, [
        el('div', { class: 'proposal-fold-inner' }, [
          parts.length > 1 ? el('p', { class: 'proposal-hint', text: 'Several places under one name. Pick one to answer just that, or answer the whole thing. A meeting or a page title makes a rule that survives a port change; a bare localhost cannot.' }) : null,
          parts.length > 1 ? scopes : null,
          titles.length > 0 ? el('ul', { class: 'proposal-titles' }, titles.slice(0, 3).map((t) => el('li', { text: t }))) : null,
          el('div', { class: 'proposal-pick' }, [chips, other]),
          acts,
        ]),
      ]),
    )
    setScope(null)
    return wrap
  }

  const settled = data?.settled ?? {}
  const settledParts = [
    settled.assigned ? `${settled.assigned} rule${settled.assigned === 1 ? '' : 's'} written` : null,
    settled.shared ? `${settled.shared} shared` : null,
    settled.personal ? `${settled.personal} personal` : null,
  ].filter(Boolean)

  return el('section', { class: 'proposals' }, [
    el('div', { class: 'col-head' }, [
      el('h3', { class: 'col-title', text: 'Untracked time' }),
      el('span', { class: 'col-hint', text: `${hm(data.totalUntrackedMin)} across ${data.candidates} place${data.candidates === 1 ? '' : 's'} · ${proposals.length} worth a rule${settledParts.length > 0 ? ` · ${settledParts.join(', ')}` : ''}` }),
    ]),
    el('p', { class: 'proposals-why', text: 'Time no rule could place. Name it and Gnomon writes the rule and tracks it from the next window on. A place that carries several projects can be answered one path at a time; one that is work but no single project is shared.' }),
    stagger(el('div', { class: 'proposal-cards' }, proposals.map(card))),
  ])
}

/**
 * The day, as the canvas's zero state.
 *
 * `onAsk` makes every row a question waiting to be asked, which is what stops
 * this being a dashboard: the row knows which project it is, and the input bar
 * only knows which page it is on. The unattributed row earns it most — it is
 * the part of the day Gnomon could NOT explain, which is exactly where the
 * owner knows something it does not.
 *
 * Everything below the dial is a projection of a route that already existed:
 * the shape of the week, the open branches, the last moments, the routine
 * forecast, the gate's silence. Nothing is computed here; a section whose
 * route is down simply is not drawn.
 */
/**
 * Today, as separate surfaces. The face (sundial, focus, projects, noticed)
 * is the permanent one; the shelf and the proposals are the actionable ones;
 * the week is a figure; the activity card holds what is informative but not
 * urgent — what is in play, what just happened, which files — behind tabs.
 * One fetch feeds all five, so summoning a second part costs nothing.
 */
const partsByDay = new Map()
/** `date` (YYYY-MM-DD) makes the day-bound parts read another day; null is today. One fetch per day, cached. */
export function todayParts(onAsk, date = null) {
  const key = date ?? ''
  if (!partsByDay.has(key)) partsByDay.set(key, buildTodayParts(onAsk, date))
  return partsByDay.get(key)
}
export const TODAY_PARTS = CATALOG_TODAY_PARTS


async function buildTodayParts(onAsk, forDate = null) {
  const get = (path) => json(path).catch(() => null)
  const on = forDate ? `?date=${forDate}` : ''
  const [figure, today, shelf, day, shape, habits, unsaid, proposals, suggested, drafts, asks] = await Promise.all([
    get(`/gnomon/dial${on}`),
    get(`/gnomon/today${on}`),
    get('/gnomon/shelf'),
    get(`/gnomon/day${on}`),
    get('/gnomon/shape'),
    get('/gnomon/habits'),
    get('/gnomon/unsaid'),
    get('/gnomon/attribution/proposals'),
    get('/gnomon/assistant/proposals'),
    get('/gnomon/drafts'),
    get('/gnomon/asks'),
  ])
  if (figure === null && today === null) return null

  const coverage = today?.coverage ?? null
  const observedMin = coverage ? coverage.trackedMin : figure?.observedMin
  const wallMin = coverage ? coverage.wallClockMin : figure?.wallClockMin
  const drawable = figure && !figure.unavailable && Array.isArray(figure.curve)
  const projects = today?.projects ?? []
  const noticed = today?.noticed ?? []
  const noProject = today?.noProjectMin ?? 0
  const attributed = projects.reduce((n, p) => n + (p.minutes ?? 0), 0) + noProject
  const date = today?.date ?? figure?.date


  const askRow = (className, label, value, place, question, weak, extra = {}) =>
    el('button', { type: 'button', class: `row row-ask ${className}`, title: `Open ${label}`, 'data-explore': extra.door ?? `search:${label}` }, [
      el('span', { class: 'row-name' }, [
        el('span', { text: label, class: extra.door ? 'door' : null, 'data-explore': extra.door ?? null, tabindex: extra.door ? '0' : null, role: extra.door ? 'link' : null }),
        extra.commits ? el('span', { class: 'chip', title: `${extra.commits} commit${extra.commits === 1 ? '' : 's'} today`, text: `${extra.commits}⎇` }) : null,
      ]),
      weak ? el('span', { class: 'row-weak', title: 'weak attribution', text: '~' }) : null,
      el('span', { class: 'row-value', text: value }),
      attributed > 0 ? shareBar((extra.minutes ?? 0) / attributed, className.includes('row-faint') ? 'share-faint' : '') : null,
    ])

  const projectsCol = el('div', { class: 'col' }, [
    el('div', { class: 'col-head' }, [el('h3', { class: 'col-title', text: 'Projects' }), today?.meetings ? el('span', { class: 'col-hint', text: `${today.meetings} meeting${today.meetings === 1 ? '' : 's'}` }) : null]),
    stagger(
      el('div', {}, [
        ...projects.map((p) =>
          askRow(
            '',
            p.name,
            hm(p.minutes),
            `Today — ${p.name}, ${hm(p.minutes)}${p.confidence === 'weak' ? ' (weak attribution)' : ''}`,
            `What did I actually do on ${p.name} today?`,
            p.confidence === 'weak',
            { minutes: p.minutes, commits: p.commits, door: `entity:${p.name}` },
          ),
        ),
        noProject > 0
          ? askRow('row-faint', 'unattributed', hm(noProject), `Today — ${hm(noProject)} carrying no project`, 'What was the unattributed time today? Show me what you saw during it.', false, {
              minutes: noProject,
            })
          : null,
        projects.length === 0 && noProject === 0 ? el('div', { class: 'none', text: 'Nothing attributed yet.' }) : null,
      ]),
    ),
  ])

  // What Gnomon noticed, said and held back lives on Voice, and what usually
  // comes next on the live strip: one line here says how much, and opens Voice.
  const noticedCol = el('div', { class: 'col' }, [
    el('h3', { class: 'col-title', text: 'Noticed' }),
    el('p', { class: 'brief-left' }, [boardLink('voice', [document.createTextNode(noticed.length ? `${noticed.length} noticed — on Voice` : 'Nothing noticed yet — Voice')])]),
  ])


  // The face carries the date and the numeral itself; the head is gone.
  // The day, whole: the face, then what Gnomon saw, the one list of the day's
  // moments, and the files touched. The Day instrument and Activity's Just now
  // and Files each held a copy of one of these; this card owns them now.
  const files = filesToday(today?.hotFiles, onAsk)
  const face = el('section', { class: 'today' }, [
    drawable || day ? sundial(figure, day, { onAsk }) : el('div', { class: 'dial-empty', text: figure?.unavailable || 'Nothing observed yet today.' }),
    focusBar(today?.focus, onAsk),
    el('div', { class: 'today-cols' }, [projectsCol, noticedCol]),
    ...(day ? dayPanel(day) : []),
    files ? el('section', { class: 'panel' }, [files]) : null,
  ])
  // Left for you owns everything that waits on the owner's verdict — the
  // shelf, the proposals, the drafts, Gnomon's open questions — and ONLY what
  // still waits: what is answered folds away under one line. Proposals was its
  // own card and Today repeated the shelf; both now point here.
  const items = shelf?.items ?? []
  const unanswered = items.filter((i) => i.verdict === null || i.verdict === undefined)
  const answered = items.filter((i) => i.verdict !== null && i.verdict !== undefined)
  const openAsks = (asks?.asks ?? []).filter((a) => !a.outcome)
  const openDrafts = { open: drafts?.open ?? [], closed: [] }
  const openSuggested = { proposals: suggested?.proposals ?? [], resolved: [] }
  const waitingCount = unanswered.length + (proposals?.proposals?.length ?? 0) + openSuggested.proposals.length + openDrafts.open.length + openAsks.length
  const asksNode = openAsks.length
    ? el('section', { class: 'panel' }, [
        el('h3', { class: 'col-title', text: 'Gnomon asks' }),
        ...openAsks.map((a) => el('div', { class: 'row' }, [el('span', { class: 'row-name', text: a.question }), el('span', { class: 'row-value', text: 'answer in the chat' })])),
      ])
    : null
  const leftNodes = [shelfSection({ ...shelf, items: unanswered, working: null }, onAsk), proposalsSection(proposals, onAsk), assistantProposalsSection(openSuggested), draftsSection(openDrafts), asksNode].filter(Boolean)
  const answeredNode = answered.length ? el('details', { class: 'shelf-answered' }, [el('summary', { text: `${answered.length} answered` }), shelfSection({ ...shelf, items: answered, working: null }, onAsk)]) : null
  // The face people actually read: one sentence about the day, then what
  // Gnomon left that still waits for a verdict. The dial and the columns are
  // one summon away, under "The day". Cheaper than a brief from the model,
  // and never stale.
  // B4: the moment of the day, from the same situation the agent reads. Only
  // for today — another day has no "now".
  const moment = forDate ? null : await momentBlock(onAsk)
  const brief = el('section', { class: 'today brief' }, [
    el('p', { class: 'brief-line', text: briefLine({ date, observedMin, projects, meetings: today?.meetings, noticed: noticed.length }) }),
    // The live line (#strip) moves in here from app.js; for another day there is no "now".
    forDate ? null : el('div', { class: 'brief-now' }),
    moment,
    // One line, not a second copy of the shelf: the count, and a door to the card that owns it.
    waitingCount
      ? el('p', { class: 'brief-left' }, [boardLink('shelf', [document.createTextNode(`${waitingCount} wait${waitingCount === 1 ? 's' : ''} for you`)])])
      : el('div', { class: 'none', text: 'Nothing left for you.' }),
  ])
  return {
    today: brief,
    dial: face,
    shelf: el('section', { class: 'today today-part' }, [...(leftNodes.length ? leftNodes : [el('div', { class: 'none', text: 'Nothing waits for you.' })]), answeredNode]),
  }
}

/**
 * What this moment of the day asks, answered — the Today card following the
 * situation (S1) and its phase (S2). The question leads; the answer is the
 * record's, a few lines, each a door to the card that owns the rest. The owner
 * asked these in chat at these moments ~70 times; this answers them first.
 */
async function momentBlock(onAsk) {
  // Today's parts are built once per day and cached, so the moment keeps
  // itself current: it re-reads the situation every minute while it is shown.
  const box = el('section', { class: 'brief-moment' })
  const draw = async () => {
    const drawn = await momentRows(onAsk)
    box.replaceChildren(...(drawn ?? []))
    box.hidden = drawn === null
  }
  await draw()
  // One Today per page, so one timer; it skips a minute when the block is not in the page.
  setInterval(() => box.isConnected && draw(), 60_000)
  return box
}

async function momentRows(onAsk) {
  const sit = await json('/gnomon/situation').catch(() => null)
  if (!sit?.phase) return null
  const rows = []
  const row = (name, value = '', attrs = {}) => rows.push(el('div', { class: 'row', ...attrs }, [el('span', { class: 'row-name', text: name }), value ? el('span', { class: 'row-value', text: value }) : null]))
  // A time for today, a date for anything older: "11:51 AM" read as this morning for a Tuesday a week back.
  const clock = (iso) => {
    const d = new Date(iso)
    return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  }
  const inMin = (m) => (m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)}h ${m % 60}m`)
  const here = sit.now?.project
  const openRows = () => {
    // The three most recent, each opening In play set to this project — In play owns the rest.
    const toPlay = async () => {
      await fetch('/gnomon/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'place', id: 'play', kind: 'play', filters: { project: here.name } }) }).catch(() => {})
      document.dispatchEvent(new CustomEvent('gnomon:card', { detail: 'play' }))
    }
    for (const c of (sit.openHere?.commitments ?? []).slice(0, 3)) row(c.name, c.quietDays === 0 ? 'today' : `${c.quietDays}d quiet`, { class: 'row row-ask', role: 'link', tabindex: '0', onclick: toPlay })
    const left = (sit.leftOff ?? []).find((l) => l.projectId === here?.id)
    if (left) row(`Left off: ${left.what}`, clock(left.at))
    if (sit.openHere?.hotFiles?.length) row(`In ${sit.openHere.hotFiles.slice(0, 2).map((f) => f.split('/').pop()).join(', ')}`)
  }

  if (sit.phase === 'morning') {
    const y = new Date(Date.parse(sit.at) - 86_400_000)
    const ymd = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
    const yesterday = await json(`/gnomon/today?date=${ymd}`).catch(() => null)
    if (yesterday?.coverage?.trackedMin) row(briefLine({ date: ymd, observedMin: yesterday.coverage.trackedMin, projects: yesterday.projects ?? [], meetings: yesterday.meetings ?? 0 }), '', { 'data-explore': `day:${ymd}`, role: 'link', tabindex: '0' })
    for (const l of (sit.leftOff ?? []).slice(0, 3)) row(`${l.projectName} — ${l.what}`, clock(l.at))
  } else if (sit.phase === 'meeting-soon' && sit.next) {
    row(`${sit.next.title} ${inMin(sit.next.startsInMin)}`, sit.next.with.slice(0, 4).join(', '))
    rows.push(el('p', { class: 'brief-left' }, [boardLink('shelf', [document.createTextNode('A brief may be waiting in Left for you')])]))
  } else if (sit.phase === 'meeting-ended') {
    if (sit.waitingForYou?.question) row(sit.waitingForYou.question, 'answer in the chat')
    else row('The meeting just ended — tell Gnomon what to keep.')
  } else if (sit.phase === 'evening') {
    rows.push(el('p', { class: 'brief-left' }, [boardLink('dial', [document.createTextNode('The whole day, hour by hour')])]))
  } else if (here) {
    row(`${here.name}${sit.now.branch ? ` · ${sit.now.branch}` : ''}`, sit.now.projectIsSticky ? 'last project' : '')
    openRows()
  }
  // What is next, when it is not already the point.
  if (sit.next && sit.phase !== 'meeting-soon' && sit.next.startsInMin <= 240) row(`Next: ${sit.next.title} ${inMin(sit.next.startsInMin)}`, sit.next.with.slice(0, 3).join(', '))
  if (rows.length === 0) return null
  return [el('h3', { class: 'col-title', text: sit.question }), ...rows]
}

/** The day in one sentence. Pure, so it can be tested without a DOM. */
export function briefLine({ date, observedMin, projects = [], meetings = 0, noticed = 0 }) {
  const weekday = date ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' }) : 'Today'
  if (!observedMin) return `${weekday}. Nothing observed yet.`
  const top = [...projects].sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0))[0]
  const parts = [`${hm(observedMin)} observed`]
  if (top?.minutes) parts.push(`most of it on ${top.name}`)
  if (meetings) parts.push(`${meetings} meeting${meetings === 1 ? '' : 's'}`)
  const said = noticed ? ` Gnomon noticed ${noticed} thing${noticed === 1 ? '' : 's'}.` : ''
  return `${weekday}. ${parts.join(', ')}.${said}`
}

/** Kept for callers that want only the face. */
export async function todayBlock(onAsk) {
  return (await todayParts(onAsk)).today
}

/**
 * What the assistant proposed, and the owner's yes or no.
 *
 * The missing half of `gnomon_propose`. That tool writes an `assistant:proposal`
 * signal and `assistantTrack` folds it into `state.assistant.recent`, which
 * before this had exactly two readers — `context.ts` and `ambient-context.ts`,
 * both prompt builders. So a proposal travelled from the model into the model's
 * own next prompt and nowhere else, while the tool result told it "the owner can
 * accept or reject it". Twenty-three went that way.
 *
 * `assistantAcceptanceRate` divides accepted by resolved and is shown to the
 * model as its own track record. With nothing able to resolve a proposal, that
 * number was measuring a loop with no human in it; these two buttons are what
 * close it.
 */
/** Today shows at most this many; the rest wait rather than pushing the page down. */
const MAX_PROPOSALS_ON_TODAY = 3

/**
 * J4.3 — what it drafted for you to send. The draft sits beside the evidence
 * it was written from and the judge's read of it (grounded, tone). Send opens
 * YOUR mail client with the draft filled in — the tap is yours, nothing leaves
 * this machine on Gnomon's word. Dismiss puts it away.
 */
function draftsSection(data) {
  const open = Array.isArray(data?.open) ? data.open : []
  const closed = Array.isArray(data?.closed) ? data.closed : []
  if (open.length === 0 && closed.length === 0) return null
  const TONE = ['wrong', 'off', 'fit', 'right']
  const card = (d) => {
    const wrap = el('article', { class: 'proposal draft', 'data-kind': d.kind })
    const acts = el('div', { class: 'proposal-chips' })
    const settle = async (outcome) => {
      for (const b of acts.querySelectorAll('button')) b.disabled = true
      const ok = await fetch('/gnomon/api/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: d.id, outcome }) }).then((r) => r.ok).catch(() => false)
      acts.replaceChildren(el('span', { class: 'panel-note', text: ok ? (outcome === 'sent' ? 'Handed to your mail client.' : 'Dismissed.') : 'That could not be recorded.' }))
    }
    if (d.kind === 'email') {
      acts.append(
        el('button', {
          type: 'button',
          class: 'act act-small',
          text: 'Send…',
          title: 'Opens your mail client with this draft filled in. You press send there.',
          onclick: () => {
            window.open(`mailto:${encodeURIComponent(d.to ?? '')}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`, '_blank')
            void settle('sent')
          },
        }),
      )
    } else {
      acts.append(
        el('button', {
          type: 'button',
          class: 'act act-small',
          text: 'Copy',
          title: 'Copies the note to your clipboard.',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(`${d.subject}\n\n${d.body}`)
            } catch {
              /* the text is on screen either way */
            }
            void settle('sent')
          },
        }),
      )
    }
    acts.append(el('button', { type: 'button', class: 'act act-small', text: 'Dismiss', onclick: () => settle('dismissed') }))
    const judge = d.judged
      ? `grounded ${d.judged.grounded === null ? '—' : d.judged.grounded.toFixed(2)} · tone ${d.judged.tone === null ? '—' : TONE[d.judged.tone] ?? d.judged.tone}`
      : 'being judged…'
    wrap.append(
      el('div', { class: 'proposal-label' }, [el('b', { text: d.kind === 'email' ? `To ${d.to ?? '—'}: ` : 'Note: ' }), d.subject]),
      el('pre', { class: 'draft-body', text: d.body }),
      d.evidence.length ? el('ul', { class: 'draft-evidence' }, d.evidence.map((e) => el('li', { text: e }))) : el('p', { class: 'panel-note', text: 'No evidence was named for this draft.' }),
      el('p', { class: 'panel-note draft-judge', text: `The judge: ${judge}.` }),
      acts,
    )
    return wrap
  }
  return el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title', text: 'It drafted' }),
    el('p', { class: 'panel-note', text: 'Written from the evidence shown under each one. Send opens your own mail client; nothing is sent for you.' }),
    ...open.map(card),
    closed.length ? el('h3', { class: 'col-title', text: 'This week' }) : null,
    ...closed.map((d) => el('div', { class: 'row' }, [el('span', { class: 'row-name', text: d.subject }), el('span', { class: 'row-value', text: d.status })])),
  ])
}

function assistantProposalsSection(data) {
  const all = Array.isArray(data?.proposals) ? data.proposals : []
  const resolved = Array.isArray(data?.resolved) ? data.resolved : []
  if (all.length === 0 && resolved.length === 0) return null
  const proposals = all.slice(0, MAX_PROPOSALS_ON_TODAY)

  const section = el('section', { class: 'panel' })
  const card = (pr) => {
    const wrap = el('article', { class: 'proposal', 'data-kind': pr.kind ?? 'proposal' })
    const acts = el('div', { class: 'proposal-chips' })
    const verdict = async (choice) => {
      for (const button of acts.querySelectorAll('button')) button.disabled = true
      try {
        await fetch('/gnomon/assistant/verdict', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ proposalId: pr.id, verdict: choice }),
        })
        acts.replaceChildren(el('span', { class: 'panel-note', text: choice === 'accepted' ? 'Accepted.' : 'Rejected.' }))
      } catch {
        acts.replaceChildren(el('span', { class: 'panel-note', text: 'That verdict could not be recorded.' }))
      }
    }

    if (pr.outcome === 'open') {
      acts.append(
        el('button', { type: 'button', class: 'act act-small', text: 'Accept', onclick: () => verdict('accepted') }),
        el('button', { type: 'button', class: 'act act-small', text: 'Reject', onclick: () => verdict('rejected') }),
      )
    } else {
      // Today's route sends open proposals only, so this branch draws a card
      // the owner just answered without a refetch.
      acts.append(el('span', { class: 'panel-note', text: pr.outcome === 'accepted' ? 'Accepted.' : 'Rejected.' }))
    }

    wrap.append(el('div', { class: 'proposal-label', text: pr.summary ?? '' }), acts)
    return wrap
  }

  // `.filter(Boolean)` because `replaceChildren` is not `el`: `el` drops a null
  // child, `replaceChildren` coerces it and appends the literal text "null",
  // which is what the remainder line below did on its first outing. The
  // instruments dispatch filters for the same reason.
  section.replaceChildren(
    ...[
      el('h2', { class: 'panel-title', text: 'It suggested' }),
      el('p', { class: 'panel-note', text: 'Your yes or no is what teaches it. A no is as useful as a yes.' }),
      ...proposals.map(card),
      all.length > proposals.length ? el('p', { class: 'panel-note', text: `${all.length - proposals.length} more waiting.` }) : null,
      // What was decided this week: without it an accepted proposal left the
      // card blank, as if nothing had ever been suggested.
      resolved.length ? el('h3', { class: 'col-title', text: 'Decided this week' }) : null,
      ...resolved.map((pr) => el('div', { class: 'row' }, [el('span', { class: 'row-name', text: pr.summary ?? '' }), el('span', { class: 'row-value', text: statusWord(pr.outcome) })])),
    ].filter(Boolean),
  )
  return section
}

/**
 * What the owner said they want.
 *
 * Their goals were data with no surface: `goal` entities each carrying a real
 * `status` fact, reachable by no route and no tool. Then they had a surface with
 * no door — the owner's first words on it were "how do I add a goal", and the
 * answer was that you could not, from here. Everything on this card is now
 * writable from it, and every write goes out through `/gnomon/api/assert` as an
 * assertion, because a goal is the owner's own word and nothing else.
 *
 * Distinct from the research goal in the Unsaid instrument, which is GNOMON'S
 * open question about its own forecasts. These are the owner's.
 *
 * Four rules from the audit meet here. A goal has a why, so it is a stacked
 * block and not a table row. Its state is a word from `status.js`. What moved is
 * shown from the record, never invented. And what has not moved for a fortnight
 * greys out and asks.
 */
function goalsSection(data) {
  const goals = Array.isArray(data?.goals) ? data.goals : []
  const quietAfter = Number(data?.quietAfterDays) || 14
  // ONE scale for the list. Computed here and handed to every row, because the
  // whole point is that the column of trails is comparable — thirteen rows each
  // fitted to their own extent would be thirteen pictures, not one.
  const scale = trailScale(goals)
  const section = el('section', { class: 'panel' })
  const names = goals.map((g) => g.goal)

  /**
   * One door for every write on this card.
   *
   * `/gnomon/api/assert` is the same door `gnomon assert` and the chat use, so a
   * goal the owner types here and a goal they say out loud land on the same
   * entity. Two doors is what split four goals across two ids each.
   */
  const assert = (name, predicate, object) =>
    fetch('/gnomon/api/assert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entityKind: 'goal', canonicalName: name, predicate, object }),
    }).then((r) => {
      if (!r.ok) throw new Error(String(r.status))
      return r
    })

  const since = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null)

  // ── Adding one ───────────────────────────────────────────────────────────
  // Folded to a single line until asked for. The card is read far more often
  // than it is written to, and a permanent four-field form above nine goals
  // makes the goals the second thing on their own surface.
  const form = el('form', { class: 'goal-form', hidden: true })
  const open = el('button', { type: 'button', class: 'act act-small', text: '+ Goal' })
  const field = (name, label, attrs = {}) =>
    el('label', { class: 'goal-field' }, [el('span', { text: label }), el('input', { class: 'proposal-other', name, ...attrs })])
  const parent = el('select', { class: 'select', name: 'partOf' }, [el('option', { value: '', text: 'on its own' }), ...names.map((n) => el('option', { value: n, text: n }))])
  const said = el('p', { class: 'panel-note' })
  form.replaceChildren(
    field('name', 'What do you want?', { type: 'text', maxlength: '160', required: true, placeholder: 'in your own words…' }),
    field('why', 'Why does it matter?', { type: 'text', maxlength: '400', placeholder: 'the reason you will read back in a month' }),
    el('div', { class: 'goal-form-row' }, [
      field('targetDate', 'By when?', { type: 'date' }),
      el('label', { class: 'goal-field' }, [el('span', { text: 'Part of' }), parent]),
      // The one verb on the form, so it is the filled one. Everything else here
      // is a field; this is the thing that happens.
      el('button', { type: 'submit', class: 'act act-small act-on', text: 'Record it' }),
    ]),
    said,
  )
  open.onclick = () => {
    form.hidden = !form.hidden
    open.textContent = form.hidden ? '+ Goal' : 'Never mind'
    if (!form.hidden) form.querySelector('input')?.focus()
  }
  form.onsubmit = async (event) => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(form).entries())
    const name = String(values.name ?? '').trim()
    if (name === '') return
    const submit = form.querySelector('button[type=submit]')
    submit.disabled = true
    said.textContent = ''
    try {
      // The state first, so a goal exists even if a later field is refused by
      // the fold's own shape gate. Each predicate is its own assertion — the
      // record has no compound write and should not grow one for a form.
      await assert(name, 'status', 'open')
      for (const [predicate, value] of [
        ['why', String(values.why ?? '').trim()],
        ['targetDate', String(values.targetDate ?? '').trim()],
        ['partOf', String(values.partOf ?? '').trim()],
      ])
        if (value !== '') await assert(name, predicate, value)
      said.textContent = `Recorded. It appears here on the next read.`
      form.reset()
    } catch {
      said.textContent = 'That could not be recorded.'
    }
    submit.disabled = false
  }

  /** What this row's marks mean, for the hand that stops on it. */
  const trailTitle = (goal) => {
    const said = (goal.life ?? []).filter((e) => e.kind === 'said').length
    const did = (goal.life ?? []).filter((e) => e.kind === 'did').length
    if (said === 0 && did === 0) return 'nothing dated'
    const parts = [said ? `you said something ${said} time${said === 1 ? '' : 's'}` : null, did ? `${did} commit${did === 1 ? '' : 's'} on its branch` : null].filter(Boolean)
    return `${parts.join(', ')} — last ${goal.movedAt ? since(goal.movedAt) : 'unknown'}`
  }

  // ── One goal ─────────────────────────────────────────────────────────────
  // The whole row is the accordion, not just its tail. The first version put
  // the why, four buttons and a meta line on every one of thirteen goals at
  // rest, and the owner's word for it was "a lot of information shown at once":
  // a page of paragraphs and fifty-two controls to answer "what am I trying to
  // do". So closed is a LINE — mark, name, state, and the small facts — and
  // everything that is a paragraph, a list or a verb waits inside.
  //
  // Same shape as a moment: `momentRow` in a list, the page one click on. The
  // stale question is the one thing that stays outside, because a nudge nobody
  // opens the row to see is not a nudge.
  const block = (goal, index) => {
    const state = status(goal.state)
    const acts = el('div', { class: 'goal-acts' })
    const set = async (next, label) => {
      for (const button of acts.querySelectorAll('button')) button.disabled = true
      try {
        // The why rides along with the state, because they share one stored
        // field. Dropping it on a status change would silently delete the
        // owner's reason for the goal.
        await assert(goal.goal, 'status', goal.why ? `${next} — ${goal.why}` : next)
        acts.replaceChildren(el('span', { class: 'goal-said', text: `${label}.` }))
      } catch {
        acts.replaceChildren(el('span', { class: 'goal-said', text: 'Not recorded.' }))
      }
    }
    // Only the states it is not already in — a button that changes nothing is a
    // button the owner has to think about. `Keep` is the same state again, and
    // only appears where saying it again means something: on a goal that has
    // gone quiet, where re-asserting it is how the owner answers the question.
    if (goal.stale) acts.append(el('button', { type: 'button', class: 'act act-small', text: 'Keep', title: 'Say it still stands', onclick: () => set(goal.state, 'Kept') }))
    for (const [next, label] of [
      ['doing', 'Doing'],
      ['paused', 'Paused'],
      ['done', 'Done'],
      ['dropped', 'Drop'],
    ])
      if (next !== goal.state) acts.append(el('button', { type: 'button', class: 'act act-small', text: label, onclick: () => set(next, label === 'Drop' ? 'Dropped' : label) }))

    // What actually moved. Nothing here is computed from the goal alone: the
    // branch is one the goal NAMES, the count is its own commits, and `[6/7]`
    // is a token the owner put in those commit subjects on purpose.
    const move = goal.movement
    const at = goal.progress ?? { done: 0, total: 0 }
    // The closed line's small facts. The state is NOT among them — it is
    // already beside the name — and neither is the why, which is a paragraph.
    // The trail says WHEN, better than a date can: it shows the whole life, not
    // the last touch. So the date, the branch and the commit count all came off
    // the closed line once the trail went on it — a fold adds, it never repeats,
    // and that rule holds sideways as well as downwards. What is left is the one
    // thing the picture cannot say, which is how far through the steps it is,
    // and a deadline, which is in the future and therefore off the axis.
    const meta = [
      at.total ? iconLabel('done', `${at.done} of ${at.total}`) : null,
      goal.targetDate ? iconLabel('day', `by ${since(goal.targetDate)}`) : null,
    ].filter(Boolean)

    // ── Inside: the steps and the commits ─────────────────────────────────
    // Two lists, and they are NOT the same list even when one was derived from
    // the other. The steps are the work as the owner thinks of it; the commits
    // are the record's own evidence that it happened, with the hash and the
    // date the steps deliberately leave out. Kept apart under their own heads.
    let steps = Array.isArray(goal.steps) ? goal.steps.map((s) => ({ ...s })) : []
    const stepList = el('ol', { class: 'goal-steps' })
    const none = el('p', { class: 'none', text: 'No steps yet.' })
    const saveSteps = async (next) => {
      steps = next
      drawSteps()
      try {
        await assert(goal.goal, 'steps', formatSteps(next))
      } catch {
        none.textContent = 'That could not be saved.'
      }
    }
    function drawSteps() {
      none.hidden = steps.length > 0
      stepList.replaceChildren(
        ...steps.map((step, i) =>
          el('li', { class: 'goal-step', 'data-state': step.state }, [
            // The mark IS the control: one tap moves the step on. A separate
            // button beside a tick would be two things saying one thing.
            el('button', {
              type: 'button',
              class: 'goal-step-mark',
              title: `${statusWord(step.state === 'todo' ? 'open' : step.state === 'skip' ? 'dropped' : step.state)} — tap to move it on`,
              'aria-label': `${step.text}: ${step.state}`,
              onclick: () => saveSteps(steps.map((x, k) => (k === i ? { ...x, state: nextStepState(x.state) } : x))),
            }),
            el('span', { class: 'goal-step-text', text: step.text }),
            el('button', { type: 'button', class: 'goal-step-drop', title: 'Take this step off the list', 'aria-label': `Remove ${step.text}`, text: '×', onclick: () => saveSteps(steps.filter((_, k) => k !== i)) }),
          ]),
        ),
      )
    }
    drawSteps()
    const addStep = el('input', { class: 'goal-step-add', type: 'text', maxlength: '120', placeholder: 'add a step…', 'aria-label': `Add a step to ${goal.goal}` })
    addStep.onkeydown = (event) => {
      if (event.key !== 'Enter' || addStep.value.trim() === '') return
      event.preventDefault()
      saveSteps([...steps, { state: 'todo', text: addStep.value.trim() }])
      addStep.value = ''
    }

    const log = move?.log ?? []
    const summary = el('summary', { class: 'goal-line' }, [
      // Every row carries a mark at the same place, foldable or not — without
      // it a row steps out of the column the others line up in.
      el('span', { class: 'goal-caret' }, [icon('more')]),
      el('span', { class: 'goal-name', text: goal.goal }),
      el('span', { class: 'goal-state', 'data-tone': state.tone, text: state.word }),
      meta.length ? el('span', { class: 'goal-meta' }, meta) : el('span'),
      // The life, last, so its axis ends at the same x on every row — the whole
      // point is that the column of them is one picture. The `title` carries
      // what the marks mean for this row; the key is named once at the head,
      // which is the rule for a number in a picture.
      el('span', { class: 'goal-trail-cell', title: trailTitle(goal) }, [
        goalTrail({ life: goal.life, live: ['open', 'doing', 'waiting', 'blocked'].includes(goal.state), width: 200 }, scale),
      ]),
      // The nudge goes in the SUMMARY, not in the fold. Anything else inside
      // `<details>` is hidden while the row is closed, which is every row the
      // owner has not opened — a question nobody can see until they go looking
      // is not a question. It is the only thing allowed to make this row two
      // lines tall, and it earns that by being the one row that wants an answer.
      goal.stale ? el('p', { class: 'goal-nudge', text: `Quiet for ${goal.quietDays} days — keep it, pause it, or drop it?` }) : null,
    ])

    const node = el('details', { class: 'goal', 'data-tone': goal.stale ? 'quiet' : null, style: { '--i': index } }, [
      summary,
      el('div', { class: 'goal-open' }, [
        // The why is the valuable part, so it keeps the quote rule it had.
        goal.why ? el('div', { class: 'sb-body' }, [el('p', { class: 'sb-text', text: goal.why })]) : null,
        el('div', { class: 'goal-open-meta' }, [
          goal.saidBy === 'owner' ? 'you said so' : goal.saidBy === 'conversation' ? 'from a conversation' : null,
          goal.movedAt ? `last moved ${since(goal.movedAt)}` : null,
          goal.alsoStored?.length ? `also stored, under an older id: ${goal.alsoStored.filter(Boolean).join(', ')}` : null,
        ].filter(Boolean).map((t) => el('span', { text: t }))),
        acts,
        el('div', { class: 'goal-part' }, [
          el('h4', { class: 'goal-part-title', text: 'Steps' }),
          // Said once, at the top: these were read off the commit tokens and
          // nobody agreed to them. The first edit writes the real list.
          goal.stepsAreDerived ? el('p', { class: 'goal-derived', text: 'Read from the [n/7] tokens in the commits. Change anything and it becomes your list.' }) : null,
          stepList,
          none,
          addStep,
        ]),
        log.length
          ? el('div', { class: 'goal-part' }, [
              el('h4', { class: 'goal-part-title' }, [el('span', { text: 'Commits' }), el('span', { class: 'goal-part-note', text: move.branch })]),
              el(
                'ul',
                { class: 'goal-commits' },
                log.map((c) =>
                  el('li', { class: 'goal-commit' }, [
                    el('code', { class: 'goal-commit-hash', text: String(c.commitLine ?? '').slice(0, 7) }),
                    el('span', { class: 'goal-commit-text', text: String(c.commitLine ?? '').replace(/^[0-9a-f]{7,40}\s+/, '') }),
                    el('span', { class: 'goal-commit-when', text: since(c.timestamp) ?? '' }),
                  ]),
                ),
              ),
            ])
          : null,
      ]),
    ])
    return node
  }

  const list = el('div', { class: 'goal-list' })
  goals.forEach((goal, index) => {
    const node = block(goal, index)
    if (goal.child) node.classList.add('goal-child')
    list.append(node)
  })

  const live = goals.filter((g) => ['open', 'doing', 'waiting', 'blocked'].includes(g.state)).length
  const quiet = goals.filter((g) => g.stale).length

  // No second title. The pane's head already says Goals, beside the mark; what
  // belongs at the top of the body is the identity line, which is what the head
  // cannot say. The pin goes in it: goals do not obey the board's span on
  // purpose — one set in July is not less true in a seven-day window, and a span
  // of Today would empty the card every morning.
  section.replaceChildren(
    el('div', { class: 'goal-panel-head' }, [
      el('p', {
        class: 'panel-note',
        text: goals.length
          ? `${live} still in play of ${goals.length}${quiet ? `, ${quiet} of them quiet for over ${quietAfter} days` : ''}. Every goal, whatever span the board is on — Gnomon reads these before it offers to help.`
          : 'Gnomon reads these before it offers to help — a goal it cannot see is one it will not bring up.',
      }),
      open,
    ]),
    // The axis, named once, where a legend on every row would be thirteen
    // legends. Tall mark, short mark, and the one ochre dot — three words.
    goals.length
      ? el('div', { class: 'goal-legend' }, [
          el('span', { class: 'goal-legend-span', text: `${scale.days} days` }),
          el('span', { class: 'goal-legend-key' }, [
            el('span', { class: 'lk lk-said' }),
            el('span', { text: 'you said' }),
            el('span', { class: 'lk lk-did' }),
            el('span', { text: 'a commit' }),
            el('span', { class: 'lk lk-now' }),
            el('span', { text: 'still running' }),
          ]),
        ])
      : null,
    form,
    goals.length ? list : el('div', { class: 'none', text: 'Nothing recorded yet. Press + Goal, or just tell Gnomon what you are trying to do.' }),
  )
  return section
}

/**
 * Who Gnomon has met, and what it calls them.
 *
 * The surface that makes automatic naming safe to run. `identity-resolve` names
 * a hashed attendee from addresses already on the machine, and a derivation can
 * be imperfect — `alexm@example.com` yields "Alexm", which is a real improvement on
 * `person-c205ca11f2` and still not what anyone calls him. Before this page the
 * only way to correct that was to answer a question Gnomon chose to ask, at a
 * time Gnomon chose; now it is two seconds whenever the owner looks.
 *
 * A rename writes the same `knownAs` fact `gnomon_assert` writes, with the same
 * `assertion` provenance — the owner's word, superseding a derived name on one
 * observation rather than three.
 */
export function peopleSection(data) {
  const people = Array.isArray(data?.people) ? data.people : []
  const unnamed = Array.isArray(data?.unnamed) ? data.unnamed : []
  const notPeople = Array.isArray(data?.notPeople) ? data.notPeople : []
  const section = el('section', { class: 'panel' })

  // ONE scale for the whole list, exactly as the goals card does it. The column
  // of trails is the point: thirty rows each fitted to their own extent would be
  // thirty pictures and no comparison.
  const scale = trailScale([...people, ...unnamed])
  const names = people.map((p) => p.name)
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null)

  /**
   * The ONE write on this card, and it is the door that already existed.
   *
   * A rename and a merge are the same act — saying what this entity should
   * answer to — so they are the same `knownAs` assertion through
   * `/gnomon/people/name`. The merge is only a rename whose text the owner did
   * not have to type: naming `Alex` "Alex Morgan" makes both rows resolve
   * to one name, and the fold on the next read does the rest. Nothing is
   * rewritten, nothing is deleted, and no `entity:merge` signal exists — an
   * alias leaves every fact where it was and only changes the answer to "who is
   * this".
   */
  const name = (alias, value) =>
    fetch('/gnomon/people/name', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias, name: value }) }).then((r) => {
      if (!r.ok) throw new Error(String(r.status))
      return r
    })

  /**
   * Who else was in those rooms, as a sentence and then as a column.
   *
   * The sentence first, because "always with" is the whole finding and a reader
   * should not have to count marks to get it. Everyone whose count equals this
   * person's meeting count was in EVERY room — that is a team, or a standing
   * pair, and it is the difference between a colleague and an acquaintance that
   * a flat meeting count cannot express.
   *
   * Someone the owner only ever sees alone gets that said out loud rather than
   * an empty heading: Marco Kuiper has three meetings and no company, and "you
   * see them one to one" is a better fact than a blank.
   */
  const company = (person) => {
    const all = Array.isArray(person.with) ? person.with : []
    if (person.meetings === 0) return []
    if (all.length === 0) return [el('p', { class: 'person-alone', text: 'Nobody else on the record was in those rooms — you see them one to one.' })]
    const always = all.filter((w) => w.shared === person.meetings)
    const say = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
    const label = (w) => (w.unnamed ? 'someone still unnamed' : w.name)
    return [
      el('p', {
        class: 'person-with-lead',
        text:
          always.length && person.meetings > 1
            ? `Every time, also in the room: ${say(always.map(label))}.`
            : `Also in the room: ${say(all.slice(0, 3).map(label))}${all.length > 3 ? `, and ${all.length - 3} more` : ''}.`,
      }),
      el(
        'ul',
        { class: 'person-with-list' },
        all.map((w) =>
          el('li', { 'data-unnamed': w.unnamed ? '' : null }, [
            // A hash never reaches the page as a name — the rule this whole card
            // exists to enforce — but the row stays, because they were really
            // there and the count is real.
            el('span', { class: 'person-with-name', text: w.unnamed ? 'an unnamed attendee' : w.name }),
            el('span', { class: 'person-with-count', text: `${w.shared} of ${person.meetings}` }),
            el('span', { class: 'person-trail-cell', title: `in ${w.shared} of ${person.meetings} rooms with them` }, [goalTrail({ life: w.life, width: 200 }, scale)]),
          ]),
        ),
      ),
      person.withMore ? el('p', { class: 'person-with-more', text: `and ${person.withMore} more, each in one room` }) : null,
    ].filter(Boolean)
  }

  /** What this row's marks mean, for the hand that stops on it. */
  const trailTitle = (person) => {
    if (!person.meetings) return 'never in a timed meeting with you'
    const ago = person.daysSince
    return `${person.meetings} meeting${person.meetings === 1 ? '' : 's'} with you — last ${when(person.lastSeen)}`
  }

  // ── One person ───────────────────────────────────────────────────────────
  // A foldable row, the shape the goals card landed and DESIGN.md now names.
  // Closed is a LINE: mark, name, how long ago, the trail. Everything that is a
  // list or a verb — the meetings themselves, the other ids this row folded in,
  // the rename and the merge — waits inside, because thirty rows carrying four
  // controls each is a hundred and twenty boxes drawn over a list of colleagues.
  const row = (person, index) => {
    const acts = el('div', { class: 'goal-acts' })
    const said = el('span', { class: 'goal-said', hidden: true })
    const call = async (alias, value, label) => {
      for (const control of acts.querySelectorAll('button, input, select')) control.disabled = true
      try {
        await name(alias, value)
        said.textContent = `${label} It appears on the next read.`
      } catch {
        said.textContent = 'That could not be recorded.'
      }
      said.hidden = false
    }

    // The merge, where the record can suggest one. "Alex" under "Alex
    // Morgan" is one tap; "Jordan" fits two colleagues, so it asks instead of
    // choosing — the audit's own duplicate list had those three as one human and
    // they are not.
    const hint = person.hint
    if (hint?.sure) acts.append(el('button', { type: 'button', class: 'act act-small', text: `Same as ${hint.could[0]}`, onclick: () => call(person.alias, hint.could[0], 'Merged.') }))
    else if (hint) for (const other of hint.could) acts.append(el('button', { type: 'button', class: 'act act-small', text: `Same as ${other}`, onclick: () => call(person.alias, other, 'Merged.') }))

    // Anyone else on the list, for the duplicates no prefix can see — Mateo and
    // Mark Janssen share four letters and nothing a machine may act on.
    const pick = el('select', { class: 'select person-pick', 'aria-label': `Say who ${person.name} really is` }, [el('option', { value: '', text: 'same as…' }), ...names.filter((n) => n !== person.name).map((n) => el('option', { value: n, text: n }))])
    pick.onchange = () => pick.value && call(person.alias, pick.value, 'Merged.')
    acts.append(pick)

    const field = el('input', { class: 'proposal-other', type: 'text', maxlength: '60', placeholder: 'or call them…', 'aria-label': `A name for ${person.name}` })
    field.onkeydown = (event) => {
      if (event.key !== 'Enter' || field.value.trim().length < 2) return
      event.preventDefault()
      call(person.alias, field.value.trim(), 'Saved.')
    }
    acts.append(field, said)

    const ago = person.daysSince
    const summary = el('summary', { class: 'person-line' }, [
      el('span', { class: 'goal-caret' }, [icon('more')]),
      el('span', { class: 'person-name', text: person.name }),
      // How long ago, in the words the owner used to ask the question. A date
      // is a lookup; "2 weeks ago" is the answer.
      el('span', { class: 'person-ago', 'data-cold': ago === null || ago > 14 ? '' : null, text: ago === null ? 'never met' : ago === 0 ? 'today' : ago === 1 ? 'yesterday' : ago < 14 ? `${ago} days ago` : `${Math.floor(ago / 7)} weeks ago` }),
      el('span', { class: 'person-met', text: person.meetings ? `${person.meetings}×` : '' }),
      el('span', { class: 'person-trail-cell', title: trailTitle(person) }, [goalTrail({ life: person.life, width: 200 }, scale)]),
      // The question goes in the SUMMARY, for the same reason the goals card's
      // stale nudge does: inside the fold it is invisible on every row the owner
      // has not opened, which is all of them. "Alex" sitting at the bottom of
      // the list with nothing on it is the duplicate the owner came to fix, and
      // it was the one row saying nothing. The verbs stay inside; only the
      // question comes out.
      hint ? el('p', { class: 'person-nudge', text: hint.sure ? `Probably ${hint.could[0]} — open the row to say so.` : `Could be ${hint.could.join(' or ')} — open the row to say which.` }) : null,
    ])

    return el('details', { class: 'person', style: { '--i': index } }, [
      summary,
      el('div', { class: 'goal-open' }, [
        // The rooms, and each one carrying its own tick in the trail column —
        // the same column, at the same x, as the trail on the line above. That
        // tick is what wires the list to the picture: the reader can see which
        // mark on the header is which meeting without being told.
        person.met?.length
          ? el(
              'ul',
              { class: 'person-met-list' },
              person.met.map((m) =>
                el('li', {}, [
                  el('span', { class: 'person-met-title', text: m.title }),
                  el('span', { class: 'person-met-when', text: when(m.at) ?? '' }),
                  el('span', { class: 'person-trail-cell' }, [goalTrail({ life: [{ at: m.at, kind: 'met' }], width: 200 }, scale)]),
                ]),
              ),
            )
          : el('p', { class: 'none', text: 'No timed meeting on the record — this name arrived some other way.' }),
        // ── Who else was in the room ────────────────────────────────────────
        // The one connection this record holds. A person carries two predicates
        // and neither is about another person, but an event carries an attendee
        // LIST — so "you and Isa were both in Puzzlez - Refinement" was already
        // written down twice and nothing read it.
        //
        // Drawn on the SAME axis as everything above, so the shape of a working
        // relationship is legible at a glance: three people whose marks sit
        // under every one of hers are the team she comes with, and one whose
        // mark appears once is someone who was in a room that day.
        ...company(person),
        person.aliases?.length > 1 ? el('p', { class: 'goal-derived', text: `Already folded together from: ${person.aliases.join(', ')}` }) : null,
        acts,
      ]),
    ])
  }

  // ── The unnamed ──────────────────────────────────────────────────────────
  // ONE bucket, not eight rows at the top of the list. They are the same
  // question asked eight times, and the meeting they were in is the only clue
  // the record can offer — which turns out to be a good one: "Pitch prep",
  // "Lichtinstallatie Event Space bedenken met Djuna". A hash with a meeting
  // title beside it is a question the owner can actually answer.
  const ghosts = () => {
    const list = el('div', { class: 'person-ghosts' })
    for (const ghost of unnamed) {
      const said = el('span', { class: 'goal-said', hidden: true })
      const field = el('input', { class: 'proposal-other', type: 'text', maxlength: '60', placeholder: 'who is this?', 'aria-label': `Who is ${ghost.alias}` })
      field.onkeydown = async (event) => {
        if (event.key !== 'Enter' || field.value.trim().length < 2) return
        event.preventDefault()
        field.disabled = true
        try {
          await name(ghost.alias, field.value.trim())
          said.textContent = 'Saved.'
        } catch {
          said.textContent = 'That could not be saved.'
        }
        said.hidden = false
      }
      list.append(
        el('div', { class: 'person-ghost' }, [
          // The clue, not the hash. The hash is what the machine calls them and
          // says nothing to anyone; the meeting is what the owner remembers.
          el('span', { class: 'person-ghost-clue', text: ghost.met?.length ? ghost.met.map((m) => m.title).join(' · ') : 'no meeting on the record' }),
          el('span', { class: 'person-ghost-when', text: ghost.lastSeen ? (when(ghost.lastSeen) ?? '') : '' }),
          field,
          said,
        ]),
      )
    }
    return el('details', { class: 'person person-bucket' }, [
      el('summary', { class: 'person-line' }, [
        el('span', { class: 'goal-caret' }, [icon('more')]),
        el('span', { class: 'person-name', text: `${unnamed.length} unnamed ${unnamed.length === 1 ? 'attendee' : 'attendees'}` }),
        el('span', { class: 'person-ago', text: 'an address this machine could not match' }),
        el('span'),
        el('span'),
      ]),
      el('div', { class: 'goal-open' }, [list]),
    ])
  }

  const cold = people.filter((p) => p.daysSince !== null && p.daysSince > 14).length
  const seen = people.filter((p) => p.meetings > 0).length

  // No second title — the head says People beside its mark. What belongs here is
  // the identity line, and the honest one is about the span: this card is pinned
  // to the whole record, because a colleague you have not seen for a month is
  // exactly the row you came for and a seven-day span would delete them.
  section.replaceChildren(
    ...[
    el('p', {
      class: 'panel-note',
      text: [
        `${people.length} people, most recently seen first${cold ? `, ${cold} of them not for a fortnight` : ''}.`,
        `Every meeting on the record, whatever span the board is on — ${seen} of them have been in a room with you.`,
        // Named, not silently dropped: three rows that vanish are three rows the
        // owner cannot find again and has no way to know were ever there.
        notPeople.length ? `${notPeople.map((n) => n.name).join(', ')} left out — ${[...new Set(notPeople.map((n) => n.why))].join(' and ')}, not people.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    }),
    people.length
      ? el('div', { class: 'goal-legend' }, [
          el('span', { class: 'goal-legend-span', text: `${scale.days} days` }),
          el('span', { class: 'goal-legend-key' }, [el('span', { class: 'lk lk-met' }), el('span', { text: 'a meeting with you' })]),
        ])
      : null,
    el('div', { class: 'goal-list' }, [...people.map(row), unnamed.length ? ghosts() : null].filter(Boolean)),
    people.length + unnamed.length ? null : el('div', { class: 'none', text: 'Nobody on the record yet.' }),
    ].filter(Boolean),
  )
  return section
}

/**
 * The shelf: what Gnomon made while the owner was away, waiting with Keep /
 * Not now. The tab is the desk — this is where its own work is left. Nothing
 * here is asserted as fact; every card carries its sources and the owner's
 * verdict is what teaches (`useful` reinforces, `wrong` retracts).
 *
 * A card that has been answered folds to its title: the owner has read it, and
 * a shelf of open books is a shelf nobody can see the end of. The title
 * unfolds it again; the small "ask" beside it loads the question.
 */
/**
 * "Wrong" asks one question: why. Resolves with the owner's line, or undefined
 * when they send nothing — the verdict is recorded either way, so a reader in a
 * hurry is never held up by a field they did not want.
 */
function askWhy(host) {
  return new Promise((resolve) => {
    const field = el('input', { class: 'proposal-other', type: 'text', maxlength: '300', placeholder: 'what was wrong? (optional)', 'aria-label': 'Why this was wrong' })
    const send = el('button', { type: 'button', class: 'act act-small', text: 'Send' })
    const done = () => resolve(field.value.trim() || undefined)
    send.onclick = done
    field.onkeydown = (e) => {
      if (e.key === 'Enter') done()
      else if (e.key === 'Escape') resolve(undefined)
    }
    host.replaceChildren(field, send)
    field.focus()
  })
}

function shelfSection(shelf, onAsk) {
  const items = Array.isArray(shelf?.items) ? shelf.items : []
  const working = shelf?.working ?? null
  if (items.length === 0 && working === null) return null
  const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  const WORDS = { useful: 'kept', 'not-now': 'later', wrong: 'removed' }
  const card = (item) => {
    const answered = item.verdict !== null && item.verdict !== undefined
    const wrap = el('article', { class: `shelf-card${item.verdict === 'useful' ? ' shelf-card-kept' : ''}${answered && item.verdict !== 'useful' ? ' shelf-card-dim' : ''}` })
    const acts = el('span', { class: 'verdicts' })
    const body = el('div', { class: 'shelf-body' })
    body.append(renderMarkdown(item.body ?? ''))
    const fold = el('div', { class: 'shelf-fold' }, [el('div', { class: 'shelf-fold-inner' }, [body, acts])])

    const setOpen = (open) => {
      wrap.setAttribute('data-open', String(open))
      title.setAttribute('aria-expanded', String(open))
    }
    const settle = (text) => {
      acts.replaceChildren(el('span', { class: 'verdict-done', text }))
      mark.textContent = text
      mark.hidden = false
    }
    const title = el('button', { type: 'button', class: 'shelf-title', title: 'Show or hide', text: item.title, onclick: () => setOpen(wrap.getAttribute('data-open') !== 'true') })
    const mark = el('span', { class: 'shelf-mark', hidden: !answered, text: answered ? WORDS[item.verdict] ?? item.verdict : '' })

    if (answered) settle(WORDS[item.verdict] ?? item.verdict)
    for (const [verdict, label] of answered ? [] : [
      ['useful', 'Keep'],
      ['not-now', 'Not now'],
      ['wrong', 'Wrong'],
    ]) {
      acts.append(
        el('button', {
          type: 'button',
          class: 'act act-small',
          text: label,
          onclick: async () => {
            for (const b of acts.querySelectorAll('button')) b.disabled = true
            // "Wrong" alone says no; the note says why, and the next job reads
            // it as a standing instruction. Asked for here, once, rather than
            // left to a place the owner would have to go and find.
            const note = verdict === 'wrong' ? await askWhy(acts) : undefined
            const ok = await postVerdict('knowledge_entry', item.id, verdict, note)
            settle(ok ? WORDS[verdict] : 'not recorded')
            if (!ok) return
            if (verdict === 'useful') wrap.classList.add('shelf-card-kept')
            else wrap.classList.add('shelf-card-dim')
            // Answered: fold to the title, a beat after the word lands so the
            // owner sees what they did before it goes.
            setTimeout(() => setOpen(false), 420)
          },
        }),
      )
    }
    wrap.append(
      el('div', { class: 'shelf-head' }, [
        el('span', { class: 'shelf-chev', 'aria-hidden': 'true' }),
        title,
        mark,
        el('span', { class: 'shelf-when', text: when(item.createdAt) }),
      ]),
      fold,
    )
    setOpen(!answered)
    return wrap
  }
  const open = items.filter((i) => i.verdict === null || i.verdict === undefined).length
  return el('section', { class: 'shelf' }, [
    el('div', { class: 'col-head' }, [
      el('h3', { class: 'col-title', text: 'Left for you' }),
      el('span', { class: 'col-hint', text: open > 0 ? `${open} waiting · ${items.length - open} answered` : `${items.length} answered` }),
    ]),
    working ? el('div', { class: 'shelf-working', text: `Working on it: ${working.subject} — ${working.reason}` }) : null,
    stagger(el('div', { class: 'shelf-cards' }, items.map(card))),
  ])
}

// ── The Ledger ────────────────────────────────────────────────────────────

/**
 * What Gnomon's own thinking costs.
 *
 * Prices are LIST prices for the model a call actually used, not a bill. The
 * page says so on its face rather than in a tooltip, because a number that
 * looks like an invoice and is not one is the kind of thing an owner remembers
 * being misled by.
 */
export async function ledgerView(rerender, spanLine = null) {
  // Something stands here before the first read: the card now waits until it is
  // on screen, like every instrument, and a pane with no children at all reads
  // as a broken card rather than a card that has not looked yet.
  // No head of its own: in the Engine room the tab strip is the head of every
  // tab, and a Ledger title row only here made the page jump on Cost ↔ Trust.
  const view = el('div', { class: 'view' }, [el('div', { class: 'view-body' }, [el('div', { class: 'reading', text: 'Reading…' })])])

  const draw = async () => {
    // No window strip. It was a private control: `7d` here meant nothing to the
    // card beside it, so the board could show a fortnight of activity next to a
    // week of spend and say neither. The span in the foot moves both now, and
    // the strip's span line reports which one it is, not a second choice.
    // A re-read keeps what is drawn until the new reading replaces it, rather
    // than blanking to "Reading…" first. The span line is the strip's (`spanLine`).

    let data = null
    try {
      data = await json('/gnomon/ledger')
    } catch {
      view.lastChild.replaceChildren(el('div', { class: 'none', text: 'The ledger could not be read.' }))
      return
    }

    const s = data.summary ?? {}
    const wasted = data.wasted ?? {}
    const lost = data.lostAnswers ?? []
    const unanswered = lost.filter((r) => !r.answeredBy)
    if (spanLine) spanLine.textContent = data.window === 'all' ? 'all time' : data.window === 'today' ? 'today' : `the last ${data.window}`
    // Filtered, because `replaceChildren` is native and throws on a null —
    // and every optional panel below is a `cond ? node : null`. That was a
    // latent blank page waiting for the first machine with no `models` row;
    // the leak panel, which is null on every HEALTHY machine, would have made
    // it the normal case.
    view.lastChild.replaceChildren(
      ...[
      // Above everything, and only when it is not zero. A credential sitting in
      // a stored error string is the one thing on this page that is not an
      // accounting question.
      s.unredactedErrorCount
        ? panel(
            'A stored error still holds a credential',
            [['Rows', s.unredactedErrorCount]],
            'An error message named an endpoint and that endpoint carried a key. New rows are stripped at the write path, so these were written by something that bypasses it — find that caller before clearing them.',
          )
        : null,
      panel(
        'This window',
        [
          ['Calls', s.calls ?? 0],
          ['Failed', s.failedCount ?? 0, s.calls ? pct(1 - (s.successRate ?? 1)) : null],
          // Was labelled "Median" and was never one — it is the mean, and a
          // mean of call latencies is dragged by a few long tool loops. The
          // real median is per purpose, in the table below.
          ['Mean latency', secs(s.avgLatencyMs)],
          ['Tokens', (s.totalTokens ?? 0).toLocaleString()],
          ['At list price', `$${num(s.estimatedCostUsd, 2)}`],
          ['On this machine', `${s.localCalls ?? 0} of ${s.calls ?? 0}`],
        ],
        'List price for the model each call actually used — an estimate of what the thinking would cost, never a bill.',
      ),
      // ── Lost answers ────────────────────────────────────────────────
      // The question the ledger could not answer, directly above the money.
      // A failed call and a call that was retried and succeeded read the same,
      // so a reader could not tell a broken Gnomon from a slow one.
      lost.length
        ? el('section', { class: 'panel' }, [
            el('h2', { class: 'panel-title', text: 'Lost answers' }),
            table(
              [
                { label: 'Purpose', cell: (r) => r.purpose },
                { label: 'When', cell: (r) => when(r.requestedAt) },
                { label: 'Why', cell: (r) => r.errorClass ?? 'unknown' },
                // The class is what you count; the message is what you read
                // when the count looks strange. It was shown nowhere after the
                // class replaced it, which is how 93 rows kept an endpoint URL
                // that no readout mentioned any more.
                { label: 'Said', cell: (r) => (r.message ? (r.message.length > 64 ? `${r.message.slice(0, 64)}…` : r.message) : '—') },
                // The tail of the id, not the whole 26 characters. It is a
                // reference for gnomon_moment_detail, not a value to read, and
                // at full width it was the widest column on the page.
                // `absent` is not a dead link: a moment's id is minted when it
                // OPENS and a moment under twenty seconds is dropped rather than
                // written, so the pointer is real and the moment was never kept.
                // Chasing one of these from here read as a broken reader during
                // the audit, so the card says which it is.
                { label: 'Moment', cell: (r) => (r.momentId ? (r.momentState === 'absent' ? `…${r.momentId.slice(-6)} · not kept` : `…${r.momentId.slice(-6)}`) : '—') },
                { label: 'Try', num: true, cell: (r) => String(r.attempt ?? 1) },
                // The whole point of the section: did anything answer in its place?
                { label: 'Answered', cell: (r) => (r.answeredBy ? 'yes, later' : 'no') },
              ],
              // Newest first, and only a screen of them: fifty rows of failure
              // buried every panel under it, and the count below says the rest.
              lost.slice(0, 12),
            ),
            el('p', {
              class: 'panel-note',
              text: `${unanswered.length} of the last ${lost.length} failures were never answered by anything${lost.length > 12 ? '; the 12 most recent are shown' : ''}. A later call counts as the answer when it retried this one, or asked the same purpose about the same moment within fifteen minutes.`,
            }),
          ])
        : null,
      // ── Wasted money ────────────────────────────────────────────────
      panel(
        'Wasted money',
        [
          ['Uploaded into failures', `${(wasted.billedOnFailureTokens ?? 0).toLocaleString()} tokens`, `$${num(wasted.billedOnFailureUsd, 2)}`],
          ['Paid twice on retries', `$${num(wasted.retrySpendUsd, 2)}`],
          ['Time spent failing', hm(Math.round((wasted.failedMs ?? 0) / 60000))],
          ['Last failure', wasted.lastFailureAt ? when(wasted.lastFailureAt) : 'none in this window'],
        ],
        'A dead request still uploaded its prompt, and the provider bills what it received. The upload is estimated from the prompt text — the answer that would have counted it never arrived.',
      ),
      el('section', { class: 'panel' }, [
        el('h2', { class: 'panel-title', text: 'By purpose' }),
        table(
          [
            { label: 'Purpose', cell: (r) => r.purpose },
            { label: 'Calls', num: true, cell: (r) => String(r.calls) },
            { label: 'Failed', num: true, cell: (r) => String(r.failedCount ?? 0) },
            // The mean alone described no call that was ever made: companion
            // reads 323s average because a few minutes-long tool loops drag it.
            // p50 is what a call is like, p95 what the bad ones are like.
            { label: 'Typical', num: true, cell: (r) => secs(r.p50LatencyMs) },
            { label: 'Slowest 5%', num: true, cell: (r) => secs(r.p95LatencyMs) },
            { label: 'Mean', num: true, cell: (r) => secs(r.avgLatencyMs) },
            { label: 'Tokens', num: true, cell: (r) => (r.totalTokens ?? 0).toLocaleString() },
            { label: 'Cost', num: true, cell: (r) => `$${num(r.estimatedCostUsd, 2)}` },
          ],
          data.byPurpose ?? [],
        ),
      ]),
      data.models?.length
        ? el('section', { class: 'panel' }, [
            el('h2', { class: 'panel-title', text: 'By model' }),
            table(
              [
                { label: 'Model', cell: (r) => r.model ?? '—' },
                { label: 'Where', cell: (r) => r.provider ?? '—' },
                { label: 'Calls', num: true, cell: (r) => String(r.calls) },
                { label: 'Tokens', num: true, cell: (r) => (r.totalTokens ?? 0).toLocaleString() },
                // An unpriced model is not a free one. Saying "$0.00" for it
                // would understate the bill by exactly the amount nobody knows.
                { label: 'Cost', num: true, cell: (r) => (r.unpriced ? 'no price' : `$${num(r.estimatedCostUsd, 2)}`) },
              ],
              data.models,
            ),
            data.unpricedRemoteModels?.length
              ? el('p', {
                  class: 'panel-note',
                  text: `No list price on record for ${data.unpricedRemoteModels
                    .map((m) => `${m.model} (${(m.totalTokens ?? 0).toLocaleString()} tokens)`)
                    .join(', ')} — those tokens are real and are missing from the total above.`,
                })
              : null,
          ])
        : null,
      data.budgets?.purposes?.length
        ? el('section', { class: 'panel' }, [
            el('h2', {
              class: 'panel-title',
              // The window's total says whether this is expensive; only today's
              // says whether it is expensive right now.
              text: `Today's budget · ${data.budgets.day ?? ''} · ${data.budgets.calls ?? 0} calls, $${num(data.budgets.spentUsd, 2)}`,
            }),
            table(
              [
                { label: 'Purpose', cell: (r) => r.purpose },
                { label: 'Used', num: true, cell: (r) => String(r.used ?? 0) },
                { label: 'Cap', num: true, cell: (r) => (r.cap === null || r.cap === undefined ? 'uncapped' : String(r.cap)) },
              ],
              data.budgets.purposes,
            ),
          ])
        : null,
      data.failureReasons?.length
        ? el('section', { class: 'panel' }, [
            el('h2', { class: 'panel-title', text: 'Why calls failed' }),
            table(
              [
                { label: 'Reason', cell: (r) => r.reason },
                { label: 'Times', num: true, cell: (r) => String(r.count) },
              ],
              data.failureReasons,
            ),
          ])
        : null,
      ].filter(Boolean),
    )
  }

  // Registered like every instrument, which it was not before: it drew once and
  // then sat there. So it re-reads when the span moves, and when the call log
  // moves, and only while the owner can see it.
  whenVisible(view, draw, '/gnomon/ledger')
  return view
}

// ── The Instruments ───────────────────────────────────────────────────────

/**
 * Twelve readings, in two bands.
 *
 * They were one flat strip of twelve words, in the order they happened to be
 * written, and the first of them was `Trust` — a page about embedding counts
 * and redaction totals. So the first thing the owner met, every time, was the
 * engine's own health, and the seven pages that are actually ABOUT them were
 * scattered through the same row as the five that are about the machine.
 *
 * Two bands, and the owner's band first. The split is not cosmetic: these
 * answer different questions on different days ("what does it know about my
 * life" versus "is the thing working"), and a reader scanning twelve nouns for
 * one of them was reading all twelve every time.
 */
/**
 * The instruments, as `[tab, label, mark, keywords]`.
 *
 * **The fourth slot is why this comment exists.** The owner typed "rhythm"
 * into Find and got nothing, because the palette matched a card's one-word
 * NAME and nothing else — and a name is the last thing somebody reaches for
 * when they want a surface. They search for what it is about. Every card in
 * this series already has a subject sentence at the top of its body; these are
 * the words out of it, so "sleep" and "bedtime" reach Rhythm, "permissions"
 * and "obsidian" reach Reach, and "forecast" reaches Calibration.
 *
 * The words live in the card catalog (`cards.js`), the one place an
 * instrument is declared — the agent reads the same entry. Pinned by
 * *views.test.js*, which holds every tab against `PANELS` in both directions
 * and refuses one with no keywords.
 */


/**
 * How much of your life Gnomon actually saw, and what it could not.
 *
 * **The card's subject, and the two things it had to stop doing.** It shipped
 * as an inventory — five volume counts, an embedding tally, a redaction tally
 * and a 96-row list called "Sensors, quietest first" — and none of that
 * answers the question an owner puts to a local-first agent. The question is
 * how much it saw. So the volume counts are GONE (the audit sends them to the
 * ledger, beside what the thinking cost), and the silence ranking is gone too,
 * for a reason worth keeping:
 *
 * **Ranking sensors by silence measures the owner's week, not the machine.**
 * 69 of that list's 96 rows were not sensors at all — `board:step`,
 * `llm:dispatched`, `clock:tick` — because it was derived from every event
 * type in the log, and its quietest rows were a one-off consent grant and the
 * Ask surface I7 deleted. Worse, among the real sensors silence means three
 * different things and only one of them is a fault: see `sensors.js`. The
 * audit's "64 live / 18 quiet / 8 dead" is therefore not a number that was
 * wrong, it is a number that cannot be computed.
 *
 * **What the record CAN answer is the heartbeat, and that is the hero.** One
 * sensor emits on a clock whatever happens, so its density is elapsed watched
 * time; 2026-09-20 holds 0.15 hours against a usual nine or ten, and that is
 * what "something was wrong" looks like here. Drawn as a calendar rather than
 * a strip, because the audit also asked for a weekday rhythm and a rhythm is a
 * question you ask down a column.
 */
function trustPanel(d) {
  const pipe = d.pipeline ?? {}
  const emb = d.embeddings ?? {}
  const red = d.redaction ?? {}
  const fb = d.feedback ?? {}
  const counts = fb.countsByVerdict ?? {}
  const audit = d.beliefAudit ?? {}
  const align = d.aliasAlignment ?? {}
  const suggestions = align.suggestions ?? []
  const retracted = audit.retracted ?? []
  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never')

  const observed = Array.isArray(d.observed) ? d.observed : []
  const weeks = coverageWeeks(observed)
  const typical = weekdayTypical(observed)
  const roster = sensorRoster(d.sensors ?? [], d.optIn ?? {})
  const on = switchedOn(roster)
  const todayRow = observed.find((day) => day.date === d.today) ?? null
  const todayTypical = d.today ? typical[weekdayOf(d.today)] : null
  const hours = (n) => (n === null || n === undefined ? '—' : `${n.toFixed(1)}h`)
  const count = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`

  // The days the heartbeat nearly stopped. Named, not just drawn pale: the
  // calendar shows THAT it happened and the sentence says WHEN, which is what
  // the owner needs to go and remember why.
  const thin = observed.filter((day) => day.hours < 3).slice(-4)

  // ── The calendar ─────────────────────────────────────────────────────────
  const slab = el('div', { class: 'cov-slab' })
  const picture = svg('svg', { class: 'cov', preserveAspectRatio: 'none', role: 'img', 'aria-label': `hours watched on each of the last ${observed.length} days` })
  slab.append(picture)
  const note = el('p', { class: 'cov-picked' })
  const paint = () =>
    coverageGrid(picture, {
      weeks,
      typical,
      today: d.today,
      // Width only. The height comes BACK from the drawing, so the cells keep
      // their proportion instead of being squashed into a box somebody picked
      // — the owner's "doesn't scale well" on the first draw.
      width: Math.round(slab.clientWidth),
      onPick: (day) => {
        note.textContent = `${new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} — ${day.hours === null ? 'nothing in the log at all; Gnomon was not running' : `${day.hours.toFixed(1)} hours watched`}.`
      },
    })
  let queued = 0
  new ResizeObserver(() => {
    cancelAnimationFrame(queued)
    queued = requestAnimationFrame(paint)
  }).observe(slab)
  // And once, synchronously. The observer fires on observe, but through a
  // frame — and a frame does not come while the pane is hidden, which is
  // exactly when an instrument first draws itself.
  paint()

  // ── The roster ───────────────────────────────────────────────────────────
  // Grouped by what makes a sensor speak, because that is the only thing that
  // makes its silence readable. Within a group, longest-quiet last: a sensor
  // heard from recently is the uninteresting one.
  const quiet = (min) => (min === null ? 'never' : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)}h ago` : `${Math.round(min / 1440)} days ago`)
  const group = (key) => {
    const mine = roster.filter((sensor) => sensor.speech === key).sort((a, b) => (a.quietMin ?? Infinity) - (b.quietMin ?? Infinity))
    if (mine.length === 0) return null
    return el('div', { class: 'sensor-group' }, [
      el('h3', { class: 'sensor-group-head', text: `Speaks ${SPEECH[key].word}` }),
      el('p', { class: 'sensor-group-note', text: SPEECH[key].means }),
      el(
        'ul',
        { class: 'sensor-list' },
        mine.map((sensor) =>
          el('li', { class: 'sensor', 'data-off': sensor.optIn && !sensor.on ? 'yes' : null }, [
            el('span', { class: 'sensor-name', text: sensor.name }),
            el('span', { class: 'sensor-does', text: sensor.does }),
            el('span', {
              class: 'sensor-heard',
              // A stream that has NEVER spoken is a different fact from a quiet
              // one, and on the phone it is four of five streams — which is the
              // card's own finding about that path.
              text: sensor.optIn && !sensor.on ? 'switched off' : sensor.silentEvents.length === sensor.events.length ? 'never heard' : quiet(sensor.quietMin),
            }),
          ]),
        ),
      ),
    ])
  }

  return [
    el('section', { class: 'panel' }, [
      el('p', {
        class: 'panel-lead',
        text: observed.length
          ? `How much of your life Gnomon actually saw. ${count(observed.length, 'day')} in the record; one sensor reports on a clock whether or not anything happens, so the darkness of a square is the hours it was genuinely watching — not how busy you were.`
          : 'Nothing has been watched yet.',
      }),
      observed.length
        ? el('div', { class: 'cov-figure' }, [
            slab,
            note,
            el('div', { class: 'cov-says' }, [
              // Today against a typical one of the same weekday. MEDIAN, not
              // mean: Wednesday runs 1.8 to 23.9 hours on this record and a
              // mean describes neither end.
              todayRow && todayTypical?.median !== null
                ? el('p', {
                    text: `Today: ${hours(todayRow.hours)} watched, against ${hours(todayTypical.median)} on a usual ${todayTypical.label} — ${todayRow.hours >= todayTypical.median ? 'more' : 'less'} than usual, over ${count(todayTypical.n, 'sample')}.`,
                  })
                : el('p', { text: 'Today has not been watched long enough to compare.' }),
              // The gaps, named. This is the only genuine health signal the
              // record carries, so it gets a sentence rather than a pale cell
              // the eye can skip.
              thin.length
                ? el('p', {
                    class: 'cov-gaps',
                    text: `${count(thin.length, 'day')} in the record hold under three hours — ${thin.map((day) => `${new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${hours(day.hours)}`).join(', ')}. An empty square is a day with nothing in the log at all, which is Gnomon not running rather than Gnomon seeing nothing.`,
                  })
                : null,
              el('p', {
                text: `Of ${(pipe.moments ?? 0).toLocaleString()} sessions, ${pct((pipe.momentsWithIntent ?? 0) / (pipe.moments || 1))} got a reading of what you were doing and ${pct((pipe.momentsWithProject ?? 0) / (pipe.moments || 1))} could be tied to a project. The rest were watched and never understood.`,
              }),
            ]),
          ])
        : null,
    ]),

    // ── The sensors ────────────────────────────────────────────────────────
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `${count(roster.length, 'sensor')}, by what makes them speak` }),
      el('p', {
        class: 'panel-note',
        text: on.length
          ? `${on.map((sensor) => sensor.name).join(' and ')} ${on.length === 1 ? 'is' : 'are'} off by default and you have switched ${on.length === 1 ? 'it' : 'them'} on.`
          : 'Every sensor that is off by default is still off.',
      }),
      ...['heartbeat', 'state', 'event'].map(group),
    ]),

    // ── Redaction ──────────────────────────────────────────────────────────
    // The audit asked for three before→after samples. **There is no before.**
    // Redaction happens once, at ingest, and the privacy signal records only
    // `{properties: {name: count}, total, sourceType}` — a tally of which field
    // was scrubbed, never the value. That is `sanitize-at-ingest` working as
    // designed, and the honest version of the ask is the AFTER: which fields
    // are being scrubbed, how often, and on what.
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `What was scrubbed, last ${red.windowHours ?? 24}h` }),
      el('p', {
        class: 'panel-note',
        text: `${(red.totalRedactions ?? 0).toLocaleString()} values removed from ${(red.redactableEvents ?? 0).toLocaleString()} events, across ${count((red.properties ?? []).length, 'field')}: ${(red.properties ?? []).join(', ')}. It happens once, at ingest — the original never reaches the log, so there is nothing here to show you a "before" of, and every read boundary after this trims a value that was already safe.`,
      }),
      (red.bySource ?? []).length
        ? table(
            [
              { label: 'From', cell: (r) => r.sourceType },
              { label: 'Values removed', num: true, cell: (r) => r.redactions.toLocaleString() },
              { label: 'Events', num: true, cell: (r) => r.events.toLocaleString() },
            ],
            red.bySource,
          )
        : el('p', { class: 'panel-note', text: 'Nothing has needed scrubbing in this window.' }),
      el('p', {
        class: 'panel-note',
        text: `Retrieval is ${emb.total ? `${emb.total.toLocaleString()} vectors from ${emb.model}` : 'not built yet'}, computed on this machine over text that was already scrubbed. There is no remote-embedding path.${emb.hashFallback ? ' The local model is not loaded, so retrieval is running on a hash fallback and is quietly worse than it looks.' : ''}`,
      }),
    ]),

    // The owner's taps, by verdict. The one number every learned threshold
    // hangs off (J0.8): a Trust page that cannot say how many verdicts exist
    // cannot say whether anything is calibrated.
    panel(
      'Your verdicts',
      [
        ['Useful', counts.useful ?? 0],
        ['Not now', counts['not-now'] ?? 0],
        ['Wrong', counts.wrong ?? 0],
        ['Last', fb.lastVerdictAt ? new Date(fb.lastVerdictAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never'],
      ],
      'Every shown line has three taps, and so does a push on the phone. Thresholds start moving at twenty.',
    ),
    // J5.4 / J5.2: the judge, graded by the owner. One row per question that
    // has been asked; the deciles show where its probabilities landed and how
    // often the owner then said useful — the two lining up IS calibration.
    selfEvaluation(d.judgement ?? {}, d.perception ?? null),
    // J2.3: retractions with evidence. The audit's answers travel with the
    // row; a fact the owner tapped wrong has none, and says so.
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `Belief audit · last run ${when(audit.lastRunAt)}` }),
      retracted.length
        ? table(
            [
              { label: 'Retracted belief', cell: (r) => `${r.canonicalName} ${r.predicate} ${r.object}` },
              { label: 'is false', num: true, cell: (r) => (r.audit ? num(r.audit.is_false, 2) : '—') },
              { label: 'artifact', num: true, cell: (r) => (r.audit ? num(r.audit.is_artifact, 2) : '—') },
              { label: 'By', cell: (r) => (r.audit ? 'audit' : 'your tap') },
              { label: 'When', cell: (r) => new Date(r.retractedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) },
            ],
            retracted,
          )
        : el('p', { class: 'panel-note', text: 'Nothing retracted yet.' }),
      el('p', { class: 'panel-note', text: 'Every live inferred belief goes to the judge nightly. A belief is retracted only when it reads as malformed — subject and object swapped, a room as a person — at 0.7 or above; the bench found zero false alarms there. The judge cannot see a plausible misattribution, so it never retracts one.' }),
    ]),
    // J2.4: two names, one thing? Listed, never merged by a model. A same-name
    // pair is exact (two real roots for one project name); a judged pair is
    // the judge's probability. Adding the alias to projectAliases merges it.
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `Possible aliases · last run ${when(align.lastRunAt)}` }),
      suggestions.length
        ? table(
            [
              { label: 'Kind', cell: (r) => r.kind },
              // Two real roots for one name ARE the same string; the path is what tells them apart.
              { label: 'This', cell: (r) => (r.basis === 'same-name' ? r.aId : r.a) },
              { label: 'May be', cell: (r) => (r.basis === 'same-name' ? r.bId : r.b) },
              { label: 'P(same)', num: true, cell: (r) => num(r.p, 2) },
              { label: 'Basis', cell: (r) => (r.basis === 'same-name' ? 'same name' : 'judge') },
            ],
            suggestions,
          )
        : el('p', { class: 'panel-note', text: 'No pair looks like one thing under two names.' }),
      el('p', { class: 'panel-note', text: 'Nothing here is merged on its own. A project pair merges when you add the alias to projectAliases in ~/.sundial/config.json; a synthetic named: project beside its real root is folded in nightly without asking. People are listed only — there is no person merge yet.' }),
    ]),
  ]
}

/**
 * Is it getting better? The judge's questions, each with the threshold it
 * decides on (default until twenty verdicts, then learned), the owner's
 * verdicts on the answers behind what they saw, and the reliability deciles.
 * Questions nobody has graded yet are counted, not listed: a table of zeros
 * says less than the sentence.
 */
function selfEvaluation(j, perception) {
  const questions = Array.isArray(j.questions) ? j.questions : []
  const graded = questions.filter((q) => q.n > 0).sort((a, b) => b.n - a.n || a.set.localeCompare(b.set))
  const learned = questions.filter((q) => q.learned).length
  const mins = Math.round((j.degradedMs ?? 0) / 60_000)
  const mode = j.degraded === 'none' ? 'on its own model' : j.degraded === 'local-fallback' ? `on the local fallback since ${new Date(j.degradedSince).toLocaleTimeString(undefined, { timeStyle: 'short' })}` : `off since ${new Date(j.degradedSince).toLocaleTimeString(undefined, { timeStyle: 'short' })}`
  const deciles = (q) =>
    el(
      'div',
      { class: 'bins bins-tight', role: 'img', 'aria-label': `${q.n} graded answers by probability decile; the mark is the share the owner found useful` },
      q.bins.n.map((n, i) =>
        n === 0
          ? null
          : el('div', { class: 'bin' }, [
              el('span', { class: 'bin-label', text: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}` }),
              el('div', { class: 'bin-track' }, [el('div', { class: 'bin-fill', style: `width:${Math.round((n / q.n) * 100)}%` }), el('div', { class: 'bin-tick', style: `left:${Math.round((q.bins.hits[i] / n) * 100)}%` })]),
              el('span', { class: 'bin-n', text: `${q.bins.hits[i]}/${n} useful` }),
            ]),
      ),
    )
  return el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title', text: 'Self-evaluation' }),
    el('p', {
      class: 'panel-note',
      text: `${questions.length} question${questions.length === 1 ? '' : 's'} have been asked; ${graded.length} ${graded.length === 1 ? 'has' : 'have'} a verdict behind ${graded.length === 1 ? 'it' : 'them'}, ${learned} ${learned === 1 ? 'has' : 'have'} earned ${learned === 1 ? 'its' : 'their'} own threshold (that takes ${j.learnsAt ?? 20}). The judge is ${mode}; ${mins === 0 ? 'no time' : `${mins} min`} spent off it so far.`,
    }),
    // J2.1: the owner-state filter against the owner's taps — the bar it must
    // clear before it may price an interruption.
    perception
      ? el('p', {
          class: 'panel-note',
          text:
            perception.n === 0
              ? 'How-is-it-going taps: none yet. The strip asks three times a day; the filter is scored against each one, and may enter the gate only after 14 days at a Brier of 0.15 or under.'
              : `How-is-it-going taps: ${perception.n} over ${perception.days} day${perception.days === 1 ? '' : 's'} of ${perception.target.days}; Brier ${perception.brier.toFixed(3)} against the ${perception.target.brier} bar. ${perception.inGateCost ? 'The filter prices interruptions.' : 'The filter does not price interruptions yet.'}`,
        })
      : null,
    graded.length
      ? table(
          [
            { label: 'Question', cell: (q) => `${q.set} · ${q.key}` },
            { label: 'θ', num: true, cell: (q) => `${num(q.threshold, 1)}${q.learned ? '' : ' (default)'}` },
            { label: 'Verdicts', num: true, cell: (q) => `${q.n}` },
            { label: 'Useful', num: true, cell: (q) => `${q.hits}/${q.n}` },
            { label: 'Last', cell: (q) => (q.lastVerdictAt ? new Date(q.lastVerdictAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—') },
          ],
          graded,
          (q) => [deciles(q)],
        )
      : el('p', { class: 'panel-note', text: 'No verdict has reached a judgement yet. A tap on a moment line grades its fan-out and its line judge; a tap on a notice grades the gate features behind it; a tap on a belief grades its audit.' }),
  ])
}

/**
 * Is it right?
 *
 * The bins are the point, and the honest reading is usually uncomfortable: a
 * forecaster can be perfectly calibrated and carry almost no information, if
 * nearly every prediction sits in the lowest bin.
 */
/**
 * Whether Gnomon's confidence is worth anything.
 *
 * **Three questions, in order: does it mean what it says, is it better than
 * guessing, and is it still learning.** The card answered none of the three
 * honestly, and two of the faults were arithmetic rather than layout.
 *
 * **The reliability chart pooled three forecasters into one curve.**
 * `day-ending` bets 910 times at a 4.7% base rate, `hour-fragmented` 568 at
 * 20.8%, `project-touched` 165 at 37%. Averaged, the shape belongs to
 * whichever bets most and describes none of them — and the thing worth seeing,
 * that `day-ending` sits hard above the diagonal and was right on all 37 of
 * the bets where it committed, vanished. Calibration is a property OF a
 * forecaster; there is no calibration of a card. Three plots now, one scale.
 *
 * **And it binned the newest 500 of 1,649 resolved rows** while the tally
 * beside it counted all of them. Aggregated in SQL now — see
 * `getCalibrationBins`.
 *
 * **The skill figure had a three-sample denominator and hid the two best
 * forecasters.** See `skillVsConstant` in `calibration.js`.
 *
 * The third question answers itself and the answer is no: every cell on the
 * uncertainty map is ineligible, four of five because there is nothing
 * correctable left in them, and no goal has opened since 11 September. That is
 * the card's own finding and it is stated rather than left as an empty table.
 */
function calibrationPanel(d) {
  const tally = (d.tally ?? []).filter((row) => row.n > 0)
  const bins = d.bins ?? []
  const retired = d.retired ?? {}
  const goals = d.goals ?? []
  const gaps = d.gaps ?? []
  const openGoals = goals.filter((goal) => goal.closedAt === null)

  const pctOf = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`
  const count = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`
  // A target's name as the owner would say it, not as the enum spells it.
  const TARGET = {
    'day-ending': 'whether you are done for the day',
    'hour-fragmented': 'whether the next hour will be scattered',
    'project-touched': 'whether you will touch a project today',
  }

  // Every forecaster with enough bets to be worth a picture, best first. One
  // scale across all of them, so a mark of the same size means the same number
  // of bets on every plot — computed per plot, a 45-bet decile would be drawn
  // as big as an 873-bet one and the row would claim they were comparable.
  const withRows = tally
    .map((row) => ({ ...row, rows: reliability(bins.filter((bin) => bin.kind === row.kind && bin.forecaster === row.forecaster)) }))
    .sort((a, b) => b.n - a.n)
  // A forecaster with three bets gets a sentence, not a plot. Drawn, its two
  // marks sat on a full-size pair of axes beside a 910-bet one and claimed the
  // same standing — which is the pooling fault again, one level up.
  const scored = withRows.filter((row) => row.n >= MIN_SCORED)
  const tooNew = withRows.filter((row) => row.n < MIN_SCORED)
  const note = el('p', { class: 'rel-picked' })

  const plot = (row) => {
    const node = svg('svg', { class: 'rel', preserveAspectRatio: 'none', role: 'img', 'aria-label': `${row.forecaster}: what it said against what happened` })
    const holder = el('div', { class: 'rel-slab' }, [node])
    // This plot's own heaviest decile. Shared across the three the range is
    // 873 to 1 and every mark clamps to the same minimum — see the note on
    // `reliabilityPlot`.
    const busiest = Math.max(1, ...row.rows.map((bin) => bin.n))
    const paint = () => reliabilityPlot(node, { rows: row.rows, width: Math.round(holder.clientWidth), height: Math.round(holder.clientHeight), busiest, label: 'it said, %', onPick: (bin) => {
      note.textContent = `${row.forecaster}: on ${count(bin.n, 'bet')} it said ${Math.round(bin.from * 100)}–${Math.round(bin.to * 100)}%, and it happened ${Math.round(bin.observed * 100)}% of the time.`
    } })
    let queued = 0
    new ResizeObserver(() => {
      cancelAnimationFrame(queued)
      queued = requestAnimationFrame(paint)
    }).observe(holder)
    paint()

    const bias = lean(row.rows)
    const band = coverage(row.rows)
    const isRetired = (retired[row.kind] ?? []).includes(row.forecaster)
    return el('figure', { class: 'rel-figure' }, [
      el('figcaption', { class: 'rel-head' }, [
        el('span', { class: 'rel-target', text: TARGET[row.kind] ?? row.kind }),
        el('span', { class: 'rel-who', text: isRetired ? `${row.forecaster} · retired` : row.forecaster }),
      ]),
      holder,
      // What calibration MEANS here, built from the claim this forecaster
      // actually makes most often rather than from a hypothetical 3%.
      el('p', { class: 'rel-says', text: calibrationLine(row.rows) ?? 'It has not said anything yet.' }),
      el('div', { class: 'rel-facts' }, [
        // Skill first: it is the only number that answers "is this worth
        // having". Refused under thirty bets rather than printed small.
        el('span', { class: 'rel-fact' }, [
          el('span', { class: 'rel-fact-label', text: 'better than guessing by' }),
          el('span', { class: 'rel-fact-value', 'data-tone': row.skill === null || row.n < MIN_SCORED ? 'quiet' : null, text: row.n < MIN_SCORED ? `only ${row.n} bets` : row.skill === null ? 'not measurable' : pctOf(row.skill) }),
        ]),
        el('span', { class: 'rel-fact' }, [el('span', { class: 'rel-fact-label', text: 'bets' }), el('span', { class: 'rel-fact-value', text: `${row.n} · ${row.hits} came true` })]),
        // K0.3 — the same question against the opponent it could actually have
        // bet. Drawn only where rows carry one, and always with its own n:
        // the figure above is over every bet and this one is over the bets
        // written since the baseline was recorded, and two populations sharing
        // a label is the fault this card was rebuilt out of.
        row.fairN > 0
          ? el('span', { class: 'rel-fact' }, [
              el('span', { class: 'rel-fact-label', text: 'and against a fair opponent' }),
              el('span', {
                class: 'rel-fact-value',
                'data-tone': row.fairSkill === null || row.fairN < MIN_SCORED ? 'quiet' : null,
                title: 'Scored against the base rate as it stood before each bet, rather than against one fitted with hindsight to the same bets.',
                text: row.fairN < MIN_SCORED ? `only ${row.fairN} so far` : row.fairSkill === null ? 'not measurable' : `${pctOf(row.fairSkill)} on ${row.fairN}`,
              }),
            ])
          : null,
        bias
          ? el('span', { class: 'rel-fact' }, [
              el('span', { class: 'rel-fact-label', text: 'and it leans' }),
              el('span', {
                class: 'rel-fact-value',
                // The BAND, not just the word. "Under-confident" on its own is
                // a property of a forecaster; "under-confident above 80%" is
                // something the owner can go and look at.
                title: bias.word === 'honest' ? null : `on ${bias.n} bets in that band it was ${Math.round(Math.abs(bias.gap) * 100)} points out`,
                text: bias.word === 'honest' ? 'honest' : `${bias.word} at ${Math.round(bias.from * 100)}–${Math.round(bias.to * 100)}%`,
              }),
            ])
          : null,
      ]),
      // The band it never enters — the audit's "confidence coverage", and it
      // only means anything per forecaster. `hour-fragmented` has never once
      // said more than 57% on 568 bets, which is a real limit on what it can
      // ever be useful for and was invisible pooled.
      // Only where the ceiling is genuinely low. `day-ending` tops out at 87%,
      // which IS close to certain, and a line saying it never gets there would
      // be a finding invented out of a decile boundary.
      band && band.hi <= 0.7
        ? el('p', { class: 'rel-coverage', text: `It has never once said more than ${Math.round(band.hi * 100)}%, so it can tell you something is unlikely but never that it is close to certain.` })
        : null,
    ])
  }

  return [
    el('section', { class: 'panel' }, [
      el('p', {
        class: 'panel-lead',
        text: scored.length
          ? `Gnomon makes three kinds of guess about you, and puts a number on each. This is whether those numbers mean anything. The diagonal is a guess that means exactly what it says: a mark above it hedged — the thing happened more often than promised — and a mark below it overclaimed. The big mark on each is where nearly all of that forecaster's bets are; sizes compare within a plot, not between them.`
          : 'Nothing has been forecast yet.',
      }),
      scored.length ? el('div', { class: 'rel-grid' }, scored.map(plot)) : null,
      note,
      // The ones with too few bets to draw, named rather than dropped: a
      // forecaster the tournament is still trying out is a fact about the
      // system, and an empty plot is not.
      tooNew.length
        ? el('p', {
            class: 'panel-note',
            text: `${tooNew.map((row) => `${row.forecaster} has bet ${count(row.n, 'time')} on ${TARGET[row.kind] ?? row.kind}`).join('; ')} — too few to score, so there is no picture. A forecaster needs ${MIN_SCORED} before anything here means anything.`,
          })
        : null,
      el('p', {
        class: 'panel-note',
        text: '“Better than guessing” is against always saying that target’s own base rate — its Brier score divided by the best a constant could have done. That base rate is worked out with hindsight over the same bets, so it is a slightly generous opponent; on the target it can be checked against, it agrees with the offline measurement to within a point. Since 23 September every bet also records the base rate as it stood BEFORE it, which is the opponent a forecaster could actually have bet against — that is the “fair opponent” figure, and it carries its own count because it covers only the bets made since.',
      }),
    ]),

    // ── What it is claiming right now ────────────────────────────────────
    // A forecaster with no visible open position is one whose resolution
    // nobody can check against what it actually said.
    d.open?.length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: `In flight · ${count(d.open.length, 'open bet')}` }),
          table(
            [
              { label: 'Target', cell: (r) => TARGET[r.kind] ?? r.kind },
              { label: 'About', cell: (r) => r.about },
              { label: 'Says', num: true, cell: (r) => pct(r.priorProb) },
              { label: 'Since', cell: (r) => new Date(r.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) },
            ],
            d.open,
          ),
        ])
      : null,

    // ── Is it still learning? ────────────────────────────────────────────
    // The answer on this record is no, and the card says it in a sentence
    // rather than showing an empty table of open goals and letting the owner
    // work out why. The gaps list is filtered to the eligible, per the audit —
    // which on this record leaves nothing, and that IS the finding.
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'What it is trying to learn' }),
      el('p', {
        class: 'panel-note',
        text: openGoals.length
          ? `It is working on ${count(openGoals.length, 'question')} right now.`
          : gaps.length
            ? `Nothing, for now. It studies one cell at a time and only opens a question where there is something correctable left — and ${gaps.filter((gap) => !gap.eligible).length} of ${count(gaps.length, 'cell')} on the map say there is not: the error that remains is the day's own randomness, which no amount of watching removes. The last question closed on ${goals.length ? (goals.map((goal) => goal.closedAt).filter(Boolean).sort().at(-1) ?? '').slice(0, 10) : '—'}.`
            : 'It has no map of its own ignorance yet.',
      }),
      // Eligible cells only, per the audit. An ineligible one is not a thing
      // the owner can act on, and the reason it is ineligible is a sentence
      // rather than a row.
      gaps.filter((gap) => gap.eligible).length
        ? table(
            [
              { label: 'Cell', cell: (r) => r.label },
              { label: 'Forecaster', cell: (r) => r.forecaster },
              { label: 'n', num: true, cell: (r) => String(r.n) },
              { label: 'Correctable', num: true, cell: (r) => `${(r.excessLoss ?? 0).toFixed(3)} / ${(r.expectedLoss ?? 0).toFixed(2)}` },
            ],
            gaps.filter((gap) => gap.eligible),
          )
        : null,
      goals.length
        ? el('details', { class: 'rel-history' }, [
            el('summary', { text: `every question it has set itself · ${goals.length}` }),
            table(
              [
                { label: 'Question', cell: (r) => r.question ?? r.label },
                { label: 'Opened', cell: (r) => (r.openedAt ?? '').slice(0, 10) },
                {
                  label: 'Outcome',
                  cell: (r) =>
                    r.closedAt !== null
                      ? el('span', { class: r.outcome === 'learned' ? 'gap-ready' : 'gap-waiting', text: statusWord(r.outcome ?? 'closed') })
                      : r.progress === null
                        ? el('span', { class: 'gap-waiting', text: 'cell left the map — not measurable' })
                        : el('span', { class: 'goal-bar', title: `${(r.nowExcess ?? 0).toFixed(3)} nats correctable now, from ${(r.openedWith?.excessLoss ?? 0).toFixed(3)} at open. Closes as learned at ${(r.targetExcess ?? 0).toFixed(3)}.` }, [
                            el('span', { class: 'goal-fill', style: { width: `${Math.round(r.progress * 100)}%` } }),
                          ]),
                },
                { label: 'Hypothesis', cell: (r) => r.hypothesis?.variable ?? (r.tried?.length ? `tried ${r.tried.join(', ')}` : '\u2014') },
              ],
              goals,
            ),
          ])
        : null,
    ]),

    // The cells are the model. Small enough to print, so print them — folded,
    // because raw stats are the thing the audit asked to demote.
    d.cells?.length
      ? el('section', { class: 'panel' }, [
          el('details', { class: 'rel-history' }, [
            el('summary', { text: `the model itself · ${count(d.cells.length, 'cell')}` }),
            table(
              [
                { label: 'Target', cell: (r) => TARGET[r.kind] ?? r.kind },
                { label: 'Cell', cell: (r) => r.cell },
                { label: 'n', num: true, cell: (r) => String(r.n) },
                { label: 'Hits', num: true, cell: (r) => String(r.hits) },
                { label: 'Rate', num: true, cell: (r) => (r.rate === null || r.rate === undefined ? '—' : pct(r.rate)) },
              ],
              d.cells,
            ),
          ]),
        ])
      : null,
  ]
}

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
const DAY_COLUMNS = ['when', 'long', 'focus', 'app', 'project', 'intent']

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

/**
 * What the owner's days actually look like.
 *
 * **The card this replaces was a nine-column table of counters** — switches,
 * same-app, thrash, interrupts, shell, commits, churn — one row a day, and
 * nothing in it answered the question a card called Shape is for. The audit
 * renamed it Rhythm and named the hero: stacked day-arcs, first touch to last
 * activity, today against typical. That is what leads now, and the counters
 * are a ribbon underneath.
 *
 * **Three of the brief's items were refused by the record, and one was a
 * defect the brief had already spotted.**
 *
 * `observedHours` reported a flat **24 on every single day** — a claim that
 * the daemon watched every hour of every one of them. The log says 13.3, 11.9
 * and 12.2 for the same three days. The brief's "`observedHours` hatch like
 * day, never a flat 24" was right, and the fix is to read the same log the
 * Trust card's calendar reads rather than to hatch a wrong number.
 *
 * **The "bedtime-spread band" was refused on a premise that did not hold, and
 * K0.6 overturned it.** The refusal said a moment belongs to the local day it
 * STARTS in, so a night past midnight ends the old day at 23:59 and opens the
 * next at 00:00, and nine of forty-one days carried such a mark — nine nights
 * in the same place, the "every case lands in the same place" tell. Measured,
 * **not one moment in the record ends at 23:59.** Nothing is clipped. What the
 * nine days actually were: seven whose FIRST moment falls between 00:00 and
 * 00:05, which is the previous evening continuing, and the "clip" was a
 * heuristic looking for an end within five minutes of midnight.
 *
 * Read against `WAKING_DAY_START_HOUR` those seven are ordinary late nights
 * ending at 00:04, 00:16, 00:24, 00:33, 01:04, 01:23 and 02:00 — a real spread.
 * So the open arrows are gone, nothing is excluded from the typical day, and
 * the bedtime band the audit asked for is now buildable. It is not built here:
 * this item moved the boundary and proved the measure, and a band is its own
 * piece of work.
 *
 * And the "focus sparkline (longest unbroken stretch vs median)" has no
 * measure behind it: a moment closes on a context switch, so the longest
 * moment of a day is the longest stretch in ONE app, not the longest stretch
 * of work. The card shows active minutes against the span instead, which is
 * the same question the record can actually answer.
 */
function rhythmPanel(d) {
  const days = Array.isArray(d.days) ? d.days : []
  const attention = d.attention ?? {}
  const totals = attention.totals ?? {}
  const typical = typicalDay(days)
  const count = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`
  const clock = (min) => (Number.isFinite(min) ? `${String(Math.floor(min / 60 + startsAt) % 24).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}` : '—')
  const hm2 = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`)
  const dayName = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const today = days.find((day) => day.date === d.today) ?? null
  // K0.6 — served by the route on the waking axis. Computed here from the
  // host clock it was four hours out on every row, and the card has no way to
  // know the owner's zone.
  const nowMin = typeof d.nowMin === 'number' ? d.nowMin : null
  // Minutes on this bar count from 04:00, so a label has to add it back.
  const startsAt = typeof d.dayStartsAt === 'number' ? d.dayStartsAt : 4

  // ── One day ─────────────────────────────────────────────────────────────
  // Newest first, because the question "when did I start today" is asked far
  // more often than "when did I start three weeks ago".
  const ARC_WIDTH = 420
  const row = (day, index) =>
    el('div', { class: 'arc-line', 'data-today': day.date === d.today ? 'yes' : null, style: { '--i': index } }, [
      el('span', { class: 'arc-when', text: dayName(day.date) }),
      el('span', {
        class: 'arc-cell',
        title: `${clock(day.firstMin)} to ${clock(day.lastMin)} · ${hm2(day.activeMin)} active · ${day.observedHours.toFixed(1)}h watched${day.lastMin > 20 * 60 ? ' · ran past midnight' : ''}`,
      }, [dayArc({ day, width: ARC_WIDTH, now: day.date === d.today ? nowMin : null })]),
      el('span', { class: 'arc-span-text', text: `${clock(day.firstMin)}–${clock(day.lastMin)}` }),
      el('span', { class: 'arc-active', text: hm2(day.activeMin) }),
    ])

  return [
    el('section', { class: 'panel' }, [
      el('p', {
        class: 'panel-lead',
        text: days.length
          ? `The shape of your days — when work started, when it stopped, and how much of that Gnomon was actually running for. ${count(days.length, 'day')} in the window. The bar is the span and the pale blocks behind it are the hours Gnomon was running, one cell each. A day here runs from ${String(startsAt).padStart(2, '0')}:00 to ${String(startsAt).padStart(2, '0')}:00, not midnight to midnight, so a night that goes past twelve stays on the evening it belongs to.`
          : 'No day has been watched yet.',
      }),
      typical
        ? el('p', {
            class: 'panel-note',
            // Quartiles rather than a mean, and the n said out loud. K0.6: no
            // day is left out any more — the seven that used to be excluded
            // were the late nights, which is exactly what this measure is about.
            text: `A usual day starts between ${clock(typical.firstLo)} and ${clock(typical.firstHi)} — ${clock(typical.firstMid)} is the middle — and stops between ${clock(typical.lastLo)} and ${clock(typical.lastHi)}. That is over ${count(typical.n, 'day')}, with none left out.`,
          })
        : null,
      // Today against that, which is the delta callout the brief asked for.
      today && typical
        ? el('p', {
            class: 'arc-today',
            text: `Today you started at ${clock(today.firstMin)}, ${Math.abs(today.firstMin - typical.firstMid) < 15 ? 'about when you usually do' : today.firstMin < typical.firstMid ? `${hm2(typical.firstMid - today.firstMin)} earlier than usual` : `${hm2(today.firstMin - typical.firstMid)} later than usual`} — ${hm2(today.activeMin)} active so far, over a span of ${hm2(today.lastMin - today.firstMin)}.`,
          })
        : null,
      // The axis ABOVE the rows. Below twenty-three of them it is an axis the
      // reader has to scroll past the picture to find, which is no axis.
      days.length
        ? el('div', { class: 'arc-head' }, [
            el('span'),
            // K0.6 — `at` is the position on the 04:00-to-04:00 bar and `label`
            // is the clock hour there. They differ by four, and reading one as
            // the other names the wrong hour on every tick.
            el('span', { class: 'arc-cell arc-hours' }, arcHours(ARC_WIDTH).map((hour) => el('span', { class: 'ritual-hour', style: { '--at': `${(hour.at / 24) * 100}%` }, text: hour.label }))),
            el('span'),
            el('span'),
          ])
        : null,
      days.length ? el('div', { class: 'arc-list' }, [...days].reverse().map(row)) : null,
    ]),

    // ── When you stop ───────────────────────────────────────────────────
    // The band the audit asked for twice and was refused twice, both times on
    // a premise K0.6 measured and found false. It sits under the arcs and on
    // their axis, so a reader can drop a line through both.
    (() => {
      const weeks = bedtimeWeeks(days)
      const c = bedtimeCensus(weeks)
      if (weeks.length === 0) return null
      const said = d.intent?.object ?? null
      return el('section', { class: 'panel' }, [
        el('h2', { class: 'panel-title', text: 'When you stop' }),
        el('p', {
          class: 'panel-lead',
          text: c
            ? `The middle half of each week's stop times, with the median marked. Typically ${hm2(c.typicalSpread)} wide — your quietest week's middle sat at ${clock(c.earliestMid)} and your latest at ${clock(c.latestMid)}.`
            : 'Not enough nights yet to say when a week typically ends.',
        }),
        // No target line, and the record is what refuses it. DESIGN.md's rule
        // about asking the policy, pointed at the owner's own assertion.
        said
          ? el('p', {
              class: 'panel-note',
              text: `There is no line to measure this against, because you have said there is no target: “${said}”. So the band is drawn for its width rather than its distance from anything — the only reference on it is midnight.`,
            })
          : el('p', {
              class: 'panel-note',
              text: 'There is no target line here. The record holds no stated bedtime to draw one from, and a line invented for the picture would be a goal you never set.',
            }),
        el(
          'div',
          { class: 'arc-list' },
          [...weeks].reverse().map((week, index) =>
            el('div', { class: 'arc-line', 'data-thin': week.thin ? 'yes' : null, style: { '--i': index } }, [
              el('span', { class: 'arc-when', text: `week of ${new Date(`${week.from}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` }),
              el('span', { class: 'arc-cell', title: `${clock(week.lo)} to ${clock(week.hi)}, middle ${clock(week.mid)} · ${count(week.n, 'night')}` }, [bedtimeBand({ week, width: ARC_WIDTH })]),
              el('span', { class: 'arc-span-text', text: `${clock(week.lo)}–${clock(week.hi)}` }),
              // The n travels with the band, because a two-night week's middle
              // half is not a habit — DESIGN.md's rule that a verdict carries
              // the evidence it rests on, applied to a picture.
              el('span', { class: 'arc-active', text: count(week.n, 'night') }),
            ]),
          ),
        ),
        c && c.thin
          ? el('p', { class: 'panel-note', text: `${count(c.thin, 'week has', 'weeks have')} fewer than four nights in the record and ${c.thin === 1 ? 'is' : 'are'} drawn pale; ${c.thin === 1 ? 'it is' : 'they are'} left out of the figures above.` })
          : null,
      ])
    })(),

    // ── The attention ribbon ────────────────────────────────────────────
    // Everything the old card was, demoted to what it is: counters about how
    // scattered the work was, under the picture of when it happened.
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'How scattered it was' }),
      el('p', {
        class: 'panel-note',
        text: `${(totals.switches ?? 0).toLocaleString()} moves between windows over ${count(totals.days ?? 0, 'day')}, about ${totals.switchesPerHour ?? 0} an active hour, and ${totals.sameAppSwitches ?? 0} of them were between two windows of the SAME app. ${((totals.shellFailureRate ?? 0) * 100).toFixed(0)}% of ${(totals.shellRuns ?? 0).toLocaleString()} shell commands failed.`,
      }),
      // Thrashing, WITH its definition and its threshold, which is what the
      // audit asked for. The detector was corrected on 2026-09-22 — it had
      // been counting window TITLE changes and firing at five of them — so the
      // bursts split into ones the corrected measure can read and ones it
      // cannot, and the card says which rather than summing them together.
      (() => {
        const bursts = (attention.days ?? []).reduce((sum, day) => sum + (day.thrashingBursts ?? 0), 0)
        const measured = (attention.days ?? []).reduce((sum, day) => sum + (day.thrashingBurstsMeasured ?? 0), 0)
        const flips = (attention.days ?? []).reduce((sum, day) => sum + (day.thrashingFlips ?? 0), 0)
        if (bursts === 0) return el('p', { class: 'panel-note', text: 'No burst of app-flipping was recorded in this window.' })
        return el('p', {
          class: 'panel-note',
          text: measured === 0
            ? `${bursts.toLocaleString()} bursts of flipping were recorded, and none of them can be read: all were written before the detector was corrected on 22 September, when it counted window TITLE changes and fired at five of them — so a terminal re-titling itself during a build scored as thrashing. New bursts need nine flips between DIFFERENT apps inside ninety seconds, which is the top tenth of working windows on your own record.`
            : `${measured.toLocaleString()} of ${bursts.toLocaleString()} bursts carry the corrected measure, ${flips.toLocaleString()} app-to-app flips between them. A burst is nine flips between different apps inside ninety seconds — the top tenth of working windows on your own record. The rest were written before 22 September, when the detector counted window TITLE changes and fired at five, so a terminal re-titling itself during a build scored as thrashing.`,
        })
      })(),
      (attention.suspects ?? []).length
        ? el('p', {
            class: 'panel-note',
            text: `The apps most often in front when a move happened: ${attention.suspects.slice(0, 4).map((s) => `${s.app} (${count(s.present, 'time')})`).join(', ')}.`,
          })
        : null,
    ]),
  ]
}

/**
 * Everything Gnomon has actually done, and what set it off.
 *
 * The argument for the card's subject is in `trace.js`'s own head; what
 * follows is what the record refused and what it could not be asked.
 *
 * **The heading was wrong and the route made it wrong.** It read "Rules that
 * fired, last 120 minutes" over a `window` that was `triggers.length` — a ROW
 * COUNT — while `getRecentRuleTriggers(120)` returned 120 rows, which on this
 * record span twenty-one minutes. Row-limited and time-windowed are different
 * cards and it was drawn as both. This one is neither: it is pinned to the
 * WHOLE journal and says its own dates on its face, because the journal begins
 * on 17 September (when the harness executor first ran) against a log that
 * begins on 30 July, and nothing in the system ever prunes it. A board span of
 * a month would draw twenty-five empty days; a span of a day would hide the
 * only history there is.
 *
 * **"fired / suppressed / errored" is not three things this table holds, and
 * each is refused for its own reason.** There is no `errored` status — the
 * column's three values are `started`, `completed` and `indeterminate` — and
 * the finding is not that a column is missing. When an effect THROWS, the
 * exception leaves `executeEffects` with the row still `started`; the next
 * boot consults the delivery guarantee, finds `at-least-once` (which every
 * variant in the union is), runs it again and marks it `completed`. A failure
 * heals into a success. `indeterminate` is only ever written for an
 * `at-most-once` effect and nothing is classified that way yet. So all 27,029
 * rows saying `completed` is not "nothing has ever failed" — it is that this
 * journal has nowhere to record a failure, which is what the card says instead
 * of a green tick. And "suppressed" is not in this table at all: a rule that
 * decided to do nothing writes no row anywhere. `noticeGate` is the single
 * exception, with its own `gate_decisions` table and its own card, so the
 * audit's example — "noticeGate evaluated 43, suppressed 40" — is answerable
 * for exactly one of the fifty-five rules here. The card points at Unsaid
 * rather than inventing a denominator for the other fifty-four.
 *
 * **The call-trees are one level deep, because that is all the record holds.**
 * Grouping by `event_id` works and the fan-out is real — one event reaches
 * twenty-one effects at its widest. But 17,581 of 20,839 events produce
 * exactly one effect, so a tree drawn per row would be a single node 84% of
 * the time: it is the row's FOLD instead, which says nothing extra where there
 * is nothing extra. The deeper tree is not recoverable at all. An `EmitEvent`
 * effect is journalled as `EmitEvent <type>` and never carries the id of the
 * event it emitted, so the chain from one sensor reading through three
 * internal hops cannot be rebuilt — and that chain is most of the traffic:
 * 16,884 of the 20,839 events Gnomon acted on, Gnomon caused itself.
 *
 * **No write door, and there should not be one.** A trace is a record of what
 * already happened; there is no field here the owner knows better than the
 * machine does, and a verdict on an effect that ran is an opinion about
 * arithmetic. Same answer as the Calibration card, for the same reason.
 */
function tracePanel(d) {
  const total = d.total ?? 0
  const families = d.families ?? []
  const you = families.find((f) => f.family === 'you')
  const itself = families.find((f) => f.family === 'itself')
  const days = journalDays(d.span?.firstAt, d.span?.lastAt)
  const since = d.span?.firstAt ? new Date(d.span.firstAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : null

  return [
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'What Gnomon has done' }),
      el('p', { class: 'panel-lead' }, [
        el('span', {
          text: total
            ? `${total.toLocaleString()} side effects, from ${(d.events ?? 0).toLocaleString()} events${since ? `, since ${since}` : ''}${days ? ` — about ${Math.round(total / days).toLocaleString()} a day` : ''}.`
            : 'The journal is empty.',
        }),
      ]),
      compositionBar(families, total),
      el(
        'div',
        { class: 'trace-legend' },
        families
          .filter((f) => f.count > 0)
          .map((f) =>
            el('div', { class: 'trace-key' }, [
              el('span', { class: 'trace-swatch', style: { background: FAMILIES[f.family]?.ink ?? 'var(--ink)' } }),
              el('span', { class: 'trace-key-label', text: FAMILIES[f.family]?.label ?? f.family }),
              el('span', { class: 'trace-key-value', text: `${f.count.toLocaleString()} · ${share(f.count, total)}` }),
              el('span', { class: 'trace-key-says', text: FAMILIES[f.family]?.says ?? '' }),
            ]),
          ),
      ),
      // The hairline IS the finding, so it is said in words as well: a band
      // under a pixel is drawn at a pixel, which understates it.
      you && total
        ? el('p', {
            class: 'panel-note',
            text: `${you.count} of those ${total.toLocaleString()} left the machine towards you — ${share(you.count, total)} of everything Gnomon has ever done. Its band above is a hairline, and it is floored at one pixel so it cannot vanish on a narrow card — which draws it smaller than its share rather than larger. ${itself ? `Another ${share(itself.count, total)} was Gnomon telling itself something, which then set off more rules.` : ''}`,
          })
        : null,
      // K0.5 — the journal can report a failure now, and the sentence has to
      // keep saying what its silence means for the rows that predate it.
      // `failures: 0` on an old row is "never counted", not "never failed".
      (d.byStatus ?? []).length
        ? el('p', {
            class: 'panel-note',
            text: (d.failed?.rows ?? 0) > 0
              ? `${(d.failed.rows).toLocaleString()} of these threw at least once — ${(d.failed.throws).toLocaleString()} ${d.failed.throws === 1 ? 'throw' : 'throws'} in all — and every one was retried on the next boot. Before 23 September there was nowhere to record that: a thrown effect was re-run and stamped done, so a failure healed into a success and the older rows say nothing about it either way.`
              : `Nothing has thrown since Gnomon started counting throws, on 23 September. Before then there was nowhere to record one: an effect that threw was re-run on the next boot and stamped done, so a failure healed into a success and the older rows cannot say whether anything went wrong.`,
          })
        : null,
    ]),

    // What set it off. The origin word comes from the Trust card's sensor
    // roster — the list `sensors.test.js` holds against `packages/sensors/src`
    // — rather than from a second table of event types written here.
    (d.byEventType ?? []).length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'What set it off' }),
          el('p', {
            class: 'panel-note',
            text: `${(d.origin?.world?.events ?? 0).toLocaleString()} of these events came from a sensor — something you or your machine did. The other ${(d.origin?.gnomon?.events ?? 0).toLocaleString()} Gnomon raised itself, in answer to one of the first.${
              (d.emitEdges?.emits ?? 0) > 0
                ? ` ${(d.emitEdges.withEdge ?? 0) === 0 ? 'None of those' : `${d.emitEdges.withEdge.toLocaleString()} of the ${d.emitEdges.emits.toLocaleString()}`} emissions record which event they became, so the chain can only be followed where they do — the rest were written before Gnomon kept that link.`
                : ''
            }`,
          }),
          table(
            [
              { label: 'Event', cell: (r) => r.eventType },
              { label: 'From', cell: (r) => (r.origin === 'world' ? 'the world' : 'Gnomon itself') },
              { label: 'Times', num: true, cell: (r) => r.events.toLocaleString() },
              { label: 'Effects', num: true, cell: (r) => r.effects.toLocaleString() },
              { label: 'Each', num: true, cell: (r) => (r.events > 0 ? (r.effects / r.events).toFixed(1) : '—') },
            ],
            d.byEventType,
          ),
        ])
      : null,

    // The rules, with what KIND of thing each does beside the count — which is
    // the whole repair. Ranked by count alone the first row is 39% of the
    // table and says nothing about itself.
    (d.byRule ?? []).length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'Which rules acted' }),
          el('p', {
            class: 'panel-note',
            text: `${d.byRule.length} rules have caused an effect since the journal began. A rule missing from this list is not a rule that did nothing: the journal records EFFECTS, and a rule that only folds something into Gnomon's working memory — which is most of the trackers — never writes a row here at all.`,
          }),
          table(
            [
              { label: 'Rule', cell: (r) => r.rule },
              { label: 'Does', cell: (r) => (r.kinds ?? []).map((k) => DOING[k] ?? k).join(', ') },
              { label: 'Effects', num: true, cell: (r) => r.count.toLocaleString() },
            ],
            d.byRule,
          ),
        ])
      : null,

    // The tail. A row's fold is the rest of its own event — the call-tree, one
    // level, which is the only level the record holds.
    (d.recent ?? []).length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: `The last ${d.recent.length} things it did` }),
          table(
            [
              { label: 'When', cell: (r) => new Date(r.appliedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) },
              { label: 'Because of', cell: (r) => r.eventType },
              { label: 'Rule', cell: (r) => r.ruleName },
              {
                label: 'Did',
                cell: (r) =>
                  r.moment
                    ? el('span', { class: 'door', 'data-explore': `moment:${r.moment}`, tabindex: '0', role: 'link', text: doing(r.effectDetail) })
                    : doing(r.effectDetail),
              },
            ],
            d.recent,
            (r) => {
              const kin = (d.siblings?.[r.eventId] ?? []).filter((s) => s.effectIndex !== r.effectIndex)
              // K0.5 — one hop down the chain, where the record now holds it.
              const born = r.emittedEventId ? (d.children?.[r.emittedEventId] ?? []) : []
              return [
                // The exact journal line, which the closed row deliberately
                // does not carry: "say the thing, not its storage" upstairs,
                // and the storage down here, where someone debugging looks.
                el('p', { class: 'trace-raw', text: r.effectDetail }),
                // A failure is said in the fold and not on the row: it is rare,
                // it is a paragraph, and the row is a scan line.
                r.failures > 0
                  ? el('p', { class: 'panel-note', text: `This threw ${r.failures === 1 ? 'once' : `${r.failures} times`} before it ran${r.lastError ? `. The last error: ${String(r.lastError).split('\n')[0]}` : '.'}` })
                  : null,
                born.length
                  ? el('div', { class: 'trace-kin' }, [
                      el('p', { class: 'panel-note', text: `What it told itself then caused ${born.length === 1 ? 'one more thing' : `${born.length} more things`}:` }),
                      el(
                        'ul',
                        {},
                        born.map((c) =>
                          el('li', {}, [
                            el('span', { class: 'trace-kin-rule', text: c.ruleName }),
                            c.moment
                              ? el('span', { class: 'door', 'data-explore': `moment:${c.moment}`, tabindex: '0', role: 'link', text: doing(c.effectDetail) })
                              : el('span', { text: doing(c.effectDetail) }),
                          ]),
                        ),
                      ),
                    ])
                  : null,
                kin.length
                  ? el('div', { class: 'trace-kin' }, [
                      el('p', { class: 'panel-note', text: `The same event also caused ${kin.length === 1 ? 'one other thing' : `${kin.length} other things`}:` }),
                      el(
                        'ul',
                        {},
                        kin.map((s) =>
                          el('li', {}, [
                            el('span', { class: 'trace-kin-rule', text: s.ruleName }),
                            s.moment
                              ? el('span', { class: 'door', 'data-explore': `moment:${s.moment}`, tabindex: '0', role: 'link', text: doing(s.effectDetail) })
                              : el('span', { text: doing(s.effectDetail) }),
                          ]),
                        ),
                      ),
                    ])
                  : el('p', { class: 'panel-note', text: 'This event caused nothing else.' }),
              ]
            },
          ),
        ])
      : null,

    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'What this cannot tell you' }),
      el('p', {
        class: 'panel-note',
        text: 'Whether anything failed before 23 September — until then a thrown effect was re-run on the next boot and recorded as a success, and nothing was kept. What a rule decided NOT to do — nothing is written when a rule declines, except by the noticing gate, which keeps its own record on the Unsaid card. And the chain through any emission written before that same date, which named the kind of event a rule raised but not which event it became.',
      }),
      el('p', { class: 'panel-note', text: 'Nothing on this card can be corrected, so nothing on it asks you to. It is a record of what happened.' }),
    ]),
  ]
}

/**
 * When each day ended — as a sentence, because a picture of it would be a lie.
 *
 * This panel was a strip of leaning slabs and the owner's verdict was the
 * shortest in the audit: "I don't like this one at all with its 3d aspects."
 * Redrawing it honestly — a dot per day at its real date and its real time,
 * no lean, no floored heights, gaps in the record left as gaps — is what showed
 * WHY no chart of this will ever read: nineteen of the last twenty-one nights
 * fall between 23:43 and 23:59. Nineteen dots in a sixteen-minute band, one
 * outlier and today. There is no slope to see because there is no spread.
 *
 * And the flatness is the measurement, not the owner. `recordDayEnd`
 * (`packages/rules/src/expectations.ts:303`) keeps the LARGEST local minute
 * inside a local calendar day, so work at 00:30 becomes minute 30 of the NEXT
 * day and can never be the end of the one before it. A measure clipped at
 * midnight, given someone who works past midnight, reports 23:5x forever — and
 * this record has four days of 00:04–07:25 work that the panel cannot see.
 *
 * So the panel says the one thing the samples honestly support, names its two
 * exceptions, and states the clipping rather than drawing around it. Repairing
 * it is a kernel change — a day-end that closes on the first long silence
 * rather than on the calendar — and it belongs to I13 (Rhythm), whose subject
 * this is. Drawing a prettier chart over a clipped number is the bug this whole
 * audit exists to stop.
 */
function dayEndReading(days) {
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
  const when = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  // The band the bulk of the nights fall in, and whatever sits outside it. A
  // night is "late" here at 23:00 — past that the clipping owns the number.
  const late = days.filter((d) => d.minutes >= 23 * 60)
  const rest = days.filter((d) => d.minutes < 23 * 60)
  const lateMin = late.length ? Math.min(...late.map((d) => d.minutes)) : 0
  const lateMax = late.length ? Math.max(...late.map((d) => d.minutes)) : 0

  return el('div', { class: 'dayend' }, [
    el('p', { class: 'dayend-say', text: late.length ? `On ${late.length} of the last ${days.length} days the last thing recorded fell between ${hhmm(lateMin)} and ${hhmm(lateMax)}.` : `The last thing recorded ran from ${hhmm(Math.min(...days.map((d) => d.minutes)))} to ${hhmm(Math.max(...days.map((d) => d.minutes)))}.` }),
    rest.length
      ? el('ul', { class: 'dayend-rest' }, rest.map((d) => el('li', {}, [el('span', { text: when(d.day) }), el('span', { class: 'dayend-rest-at', text: hhmm(d.minutes) })])))
      : null,
    // The caveat is not a footnote: it is the reason the number above is the
    // shape it is, and without it the panel reads as a finding about bedtime.
    el('p', { class: 'dayend-caveat', text: 'That band is the measure, not the night. The day-end sample keeps the latest activity inside a calendar day, so anything after midnight is filed as the next morning and can never close the evening before it — and this record holds four days of work between 00:04 and 07:25 that this panel cannot see. A real bedtime needs a day that ends on a long silence rather than on the clock.' }),
  ].filter(Boolean))
}

/**
 * A ritual: a stretch of work the owner does at about the same time, for about
 * the same thing, again and again.
 *
 * The card used to lead with `Claude → Warp → Google Chrome, seen 123×`, and the
 * owner's question about it is the whole reason this section exists: "We miss
 * context. What information is that bringing across?" A trigram of app switches
 * is ACTIVITY. It has no when, no what-for and no length, so there is nothing in
 * it to grab. All three are on the moments, so the rituals are read from there
 * (`@sundial/kernel/rituals.js`) and the switch table is demoted to a detail.
 *
 * Closed is a LINE — the shape DESIGN.md names: name, the usual hours, how many
 * days, how long a sitting runs, and the window drawn on the clock the whole
 * list shares. Everything that is a list or a paragraph waits inside the fold.
 */
function ritualsSection(data) {
  const meta = data?.rituals ?? {}
  const list = Array.isArray(meta.list) ? meta.list : []
  const scale = dayScale(list)
  const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
  // Minutes from local midnight, right now — the one ochre mark on the picture,
  // and what makes the column answer "am I on my usual path" without a word.
  const at = new Date()
  const nowMin = at.getHours() * 60 + at.getMinutes()
  const daysSince = (day) => Math.floor((Date.now() - Date.parse(`${day}T12:00:00`)) / 86_400_000)
  const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  const row = (ritual, index) => {
    const cold = daysSince(ritual.lastDay)
    const busiest = Math.max(1, ...(ritual.weekdays ?? [1]))
    return el('details', { class: 'ritual', style: { '--i': index } }, [
      el('summary', { class: 'ritual-line' }, [
        el('span', { class: 'goal-caret' }, [icon('more')]),
        el('span', { class: 'ritual-name', text: ritual.name }),
        // The hours in words as well as in the picture: the owner asked for
        // "09:10–10:00" by name, and a band on an axis cannot be read to the
        // minute. This is the small table beside the picture, not more of it.
        el('span', { class: 'ritual-hours', text: `${hhmm(ritual.startMin)}–${hhmm(ritual.endMin)}` }),
        el('span', { class: 'ritual-facts', text: `${ritual.days} days · ${ritual.when} · about ${ritual.medianMin} min` }),
        el('span', { class: 'ritual-clock-cell', title: `${ritual.occurrences} sittings on ${ritual.days} days, usually ${hhmm(ritual.startMin)} to ${hhmm(ritual.endMin)}` }, [dayClock({ startMin: ritual.startMin, endMin: ritual.endMin, width: 380, now: nowMin }, scale)]),
        // The one question allowed out of the fold, for the same reason the
        // goals card's stale nudge is: inside `<details>` it is invisible on
        // every row the owner has not opened, which is all of them. A ritual
        // that stopped a month ago is the row they came to see.
        cold > 14 ? el('p', { class: 'ritual-nudge', text: `Nothing like this for ${Math.floor(cold / 7)} weeks — last on ${ritual.lastDay}.` }) : null,
      ]),
      el('div', { class: 'goal-open' }, [
        // The raw sequence, demoted to exactly where the audit put it: inside
        // the thing it is evidence for, rather than standing at the top of the
        // card as though it were the finding.
        el('p', { class: 'ritual-apps' }, [iconLabel('app', 'In front'), el('span', { text: (ritual.apps ?? []).join(' · ') })]),
        // Which days it lands on, as bars rather than as a seven-number list —
        // the comparison the eye was making anyway, scaled to this ritual's own
        // busiest day because the question is "which day", not "how many".
        el(
          'ul',
          { class: 'ritual-week' },
          WEEK.map((name, i) =>
            el('li', { 'data-none': (ritual.weekdays?.[i] ?? 0) === 0 ? '' : null, title: `${ritual.weekdays?.[i] ?? 0} on a ${name}` }, [
              el('span', { class: 'ritual-week-bar', style: { '--fill': `${Math.round(((ritual.weekdays?.[i] ?? 0) / busiest) * 100)}%` } }),
              el('span', { class: 'ritual-week-day', text: name[0] }),
            ]),
          ),
        ),
        // What it WAS, in the model's own sentences, ochre because a model wrote
        // them. This is the answer to "what information is that bringing across"
        // that no sequence of app names could give.
        (ritual.intents ?? []).length
          ? el('ul', { class: 'ritual-intents' }, ritual.intents.map((text) => el('li', { text })))
          : el('p', { class: 'none', text: 'No moment in this stretch was ever read, so there is nothing to say about what it was for.' }),
        el('p', { class: 'goal-derived', text: `${ritual.occurrences} sittings, last on ${ritual.lastDay}. Read from the moments each time this card opens — nothing here is stored, so correcting the record corrects this.` }),
      ]),
    ])
  }

  return el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title', text: `Rituals · ${list.length}` }),
    el('p', { class: 'panel-lead', text: `What you do again and again, read off ${(meta.observed ?? 0).toLocaleString()} moments from the last ${meta.weeks ?? 8} weeks. A stretch of work on one project counts as a ritual once it has happened on four separate days; anything Gnomon cannot put a project to is not shown, because a band it cannot name is a row you cannot use.` }),
    list.length
      ? el('div', { class: 'ritual-list' }, [
          // The hour labels, on the same track and at the same x as every band
          // below them. A shared axis with nothing naming it is a picture that
          // asks the reader to guess the scale.
          el('div', { class: 'ritual-head' }, [
            el('span', { class: 'ritual-head-label', text: 'through the day' }),
            el(
              'span',
              { class: 'ritual-clock-cell ritual-hours-row' },
              scaleHours(scale).map((hour) =>
                el('span', { class: 'ritual-hour', style: { '--at': `${((hour * 60 - scale.from) / (scale.to - scale.from)) * 100}%` }, text: String(hour).padStart(2, '0') }),
              ),
            ),
          ]),
          ...list.map(row),
        ])
      : el('div', { class: 'none', text: 'Nothing has recurred on four separate days yet.' }),
  ])
}

/**
 * What Gnomon has learned about how the owner works.
 *
 * Rituals first, because that is the question — what do I do again and again,
 * and what for. Then the switch table, demoted to what it actually is; then the
 * commitments and the expectations, which no comment on this card asked about.
 */
function habitsPanel(d) {
  const r = d.routines ?? {}
  const c = d.commitments ?? {}
  const x = d.expectations ?? {}
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—')
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

  // Day-end as a strip of ticks: one per day, height = minutes from midnight.
  // A slope is bedtime drift, which no surprise detector can see.
  const dayEnd = x.dayEnd ?? []
  const minM = dayEnd.length ? Math.min(...dayEnd.map((p) => p.minutes)) : 0
  const maxM = dayEnd.length ? Math.max(...dayEnd.map((p) => p.minutes)) : 1
  const span = Math.max(60, maxM - minM)
  const blind = r.unclassified ?? []

  return [
    ritualsSection(d),
    // "Right now" (the next-app forecast) lives on Today's live strip: it is
    // about this moment, and Rhythm is about the days over time.
    // ── The blind spot ──────────────────────────────────────────────────────
    // Named on the card, because a gap the owner cannot see is a gap they
    // cannot close, and this one is theirs to close: the taxonomy is config.
    blind.length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'What I cannot tell apart' }),
          el(
            'ul',
            { class: 'ritual-blind' },
            blind.slice(0, 6).map((b) => el('li', {}, [el('span', { class: 'ritual-blind-app', text: b.app }), el('span', { class: 'ritual-blind-n', text: `${b.blind} of ${b.seen} moments` })])),
          ),
          el('p', { class: 'panel-note', text: 'Every step above records an app and whether it was work or personal. That second half comes from leisureRules in ~/.sundial/config.json, and for these it came out blank: an app with no entry there, or a browser window whose title carries no address and no profile, records only that it happened. It is a config change and it is yours — nothing Gnomon observes can tell it what an unlisted app means to you. The rituals above are unaffected: those are read from projects, not from this taxonomy.' }),
        ])
      : null,
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `Switch sequences · ${r.learnedCount ?? 0} learned` }),
      el('p', { class: 'panel-lead', text: 'The raw tier, kept because it is what the forecast above is made of. It is activity, not habit: the apps you moved between, with no when and no what-for. The rituals are the reading.' }),
      (r.top ?? []).length
        ? table(
            [
              { label: 'Sequence', cell: (row) => row.label },
              { label: 'Seen', num: true, cell: (row) => `${row.support}×` },
              // A mirror pair is ONE oscillation counted from both ends, and the
              // card used to print it as two of the owner's strongest habits —
              // 123 and 110 for the same back-and-forth. The reverse is folded
              // in and named, rather than dropped, so the total stays honest.
              { label: 'Reversed', num: true, cell: (row) => (row.mirrored ? `+${row.mirrored}×` : '—') },
              { label: 'Last', cell: (row) => fmtDay(row.lastSeenAt) },
            ],
            r.top,
          )
        : el('div', { class: 'none', text: 'Nothing repeated often enough yet.' }),
      el('p', { class: 'panel-note', text: 'A step is an app plus whether it was work or personal, never a window title. Alternation (A → B → A) is refused on purpose: that is thinking, not procedure. So is a sequence and its own reverse, which is why the same oscillation is one row here.' }),
    ]),
    // Open threads live on In play now; one line says how many and opens it.
    el('p', { class: 'panel-note' }, [boardLink('play', [document.createTextNode(`${(c.open ?? []).length} open threads — on In play`)])]),
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `When the day ends · ${dayEnd.length} days` }),
      dayEnd.length >= 3 ? dayEndReading(dayEnd) : el('div', { class: 'none', text: 'Fewer than three days recorded.' }),
    ]),
    (x.recurring ?? []).length
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'What recurs' }),
          table(
            [
              { label: 'Stream', cell: (row) => row.stream },
              { label: 'Rhythm', cell: (row) => row.bucket },
              { label: 'Seen', num: true, cell: (row) => `${row.n}×` },
              { label: 'Every', num: true, cell: (row) => (row.meanIntervalMin >= 1440 ? `${(row.meanIntervalMin / 1440).toFixed(1)}d` : `${row.meanIntervalMin}m`) },
            ],
            x.recurring,
          ),
        ])
      : null,
  ]
}

/**
 * What Gnomon can touch outside its own record, and on what terms.
 *
 * One row per integration, mounted or not — WITH the reason, so "not mounted:
 * missing OBSIDIAN_API_KEY" is on this page and not in a log. Under each, its
 * tools with the verdict the gate will give: a read runs freely, a write asks.
 * The verdicts come from the same code the gate uses, so this page cannot lie
 * about what will and will not prompt.
 */
/**
 * What Gnomon can reach past this machine, and what happens when it tries.
 *
 * **Every verdict here is the gate's own.** The card asks
 * `ctx.gnomonReach.verdict(tool, preset)`, which runs the same `decideAction`
 * the `tools/pre-execute` hook runs. The surface it replaces wrote the answers
 * by hand — "On call: runs / asks", a column with the same word on all
 * twenty-eight of Gnomon's tools — and the foot said "under the
 * workspace-write preset every write above asks before it runs", which is a
 * sentence about a policy rather than the policy speaking. See `reach.js`.
 *
 * **Three of the audit's items were refused by the record, and each refusal is
 * on the card.** There is no destructive tier — the gate knows a read and a
 * not-read, so a delete and an append are the same thing to it, and badging a
 * tier it does not enforce is worse on a permission surface than badging none.
 * There is no usage telemetry — MCP calls append nothing, so of the record's
 * 120 action rows 119 are `run_shell` and one is `calendar_create`. And the
 * "+36 built-in tools" disclosure is now three: the registry has shrunk to 49
 * and Gnomon's own tools are 28 of them.
 */
function reachPanel(d) {
  const integrations = d.integrations ?? []
  const reg = registry(d)
  const count = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`
  const short = (text) => (text.length > 110 ? `${text.slice(0, 109)}…` : text)

  // The gate's verdict for one tool, at both rungs, as the two words the owner
  // reads on the chip. One cell, because it is one claim about one tool.
  const ladder = (tool) =>
    el(
      'span',
      { class: 'reach-ladder' },
      RUNGS.map((rung) => {
        const kind = verdictAt(tool, rung.preset)
        return el('span', { class: 'reach-rung', 'data-tone': VERDICT[kind].tone, title: tool.verdicts?.[rung.preset]?.reason ?? null }, [
          el('span', { class: 'reach-rung-word', text: rung.word }),
          el('span', { class: 'reach-rung-verdict', text: VERDICT[kind].word }),
        ])
      }),
    )

  const service = (i) => {
    const cap = capability(i)
    return el('section', { class: 'panel' }, [
      el('div', { class: 'reach-head' }, [
        el('h2', { class: 'panel-title', text: i.name }),
        el('span', { class: 'pill', 'data-on': i.mounted || null, text: i.mounted ? 'connected' : 'not connected' }),
        el('span', { class: 'reach-meta', text: `over ${i.transport}` }),
      ]),
      !i.mounted ? el('p', { class: 'panel-note', text: i.reason ?? 'Gnomon could not connect to it, and gave no reason.' }) : null,
      // The capability line the audit asked for, assembled from the gate's
      // verdicts rather than written down.
      i.mounted && i.tools.length
        ? el('p', {
            class: 'panel-lead',
            // Assembled from the verdicts, so the sentence cannot claim
            // something the gate would not do. The verb is written per rung
            // rather than patched out of the verdict word, which produced
            // "on Auto runs" with nothing to run.
            text: `${count(cap.reads, 'of its tools reads', 'of its tools read')}, and ${cap.readEverywhere ? 'Gnomon may use those whenever it likes' : 'some of those still stop for you'}. The other ${count(cap.writes, 'changes things in', 'change things in')} ${i.name} — ${cap.writeLadder
              .map((r) => `on ${r.word} it ${r.kind === null ? 'does nothing' : r.kind === 'allow' ? 'just runs' : r.kind === 'ask' ? 'stops for your nod' : 'is refused'}`)
              .join(', and ')}.`,
          })
        : null,
      // The half of that sentence that matters most, said on its own. The gate
      // has no destructive tier, so on Auto a delete goes through exactly like
      // an append, and nobody reading a permission card should have to work
      // that out from a table.
      i.mounted && cap.unpromptedWrites.length && cap.writes > 0
        ? el('p', {
            class: 'reach-warning',
            text: `On ${cap.unpromptedWrites.join(' and ')} that includes ${i.tools.filter((t) => !t.read && /delete|remove|overwrite/i.test(t.tool)).length ? 'deleting a file' : 'every one of those changes'}, with no prompt. Gnomon's gate sorts a service's tools into reads and everything-else; it has no separate rung for destroying something, so a delete travels the same road as an append.`,
          })
        : null,
      i.mounted && i.tools.length
        ? table(
            [
              { label: 'Tool', cell: (t) => t.tool },
              { label: 'Kind', cell: (t) => el('span', { class: 'reach-kind', 'data-read': t.read || null, text: t.read ? 'reads' : 'changes things' }) },
              { label: 'What the gate does', cell: ladder },
              // K0.1. A tool nothing has called says "not since" and not
              // "never": the counting started when the gate learned to write a
              // row, and everything before that is silence that means nothing.
              { label: 'Used', cell: (t) => el('span', { title: usedTitle(t.used), text: usedWord(t.used) }) },
              { label: 'What it does', cell: (t) => short(t.description) },
            ],
            i.tools,
          )
        : null,
      i.mounted && i.tools.length === 0 ? el('div', { class: 'none', text: 'Connected, but the server offered no tools.' }) : null,
      // K0.1. The counts live here and not in the Used column, which carries
      // the recency alone — see `usedWord` for the measurement that decided it.
      i.mounted && usedSentence(i.used) ? el('p', { class: 'panel-note', text: `Gnomon has reached this service ${usedSentence(i.used)}` }) : null,
      el('p', {
        class: 'panel-note',
        text: (i.reads ?? []).length
          ? `Gnomon decides which of these are reads by matching the name against ${i.reads.join(', ')} — the same match the gate makes when the tool is actually called. Anything else is a change.`
          : 'No read patterns are declared for this service, so the gate treats every one of its tools as a change.',
      }),
    ])
  }

  return [
    el('section', { class: 'panel' }, [
      el('p', {
        class: 'panel-lead',
        text: `What Gnomon can touch beyond this machine, and what happens when it reaches. ${count(reg.total, 'tool is', 'tools are')} on its bench: ${reg.own} it ships itself, ${reg.mcp} from ${count(integrations.filter((i) => i.mounted).length, 'service you have connected')}, and ${reg.builtIn} from the harness it runs in. Every verdict below is the gate's own answer, not a description of it.`,
      }),
      el('p', {
        class: 'panel-note',
        // Both rungs named as the chip names them, because that is the control
        // the owner actually has. `read-only` is in the gate's table and the
        // board cannot select it, which is worth one clause.
        text: `Ask and Auto are the two settings on the permission chip. The gate knows a third, read-only, which refuses everything outward — this board has no way to choose it.${d.autonomy && d.autonomy !== 'act' ? ` Your auto mode is "${d.autonomy}", which stops anything outward for your nod whatever the chip says.` : ''}`,
      }),
    ]),

    ...integrations.map(service),
    integrations.length === 0
      ? el('section', { class: 'panel' }, [
          el('h2', { class: 'panel-title', text: 'Nothing connected' }),
          el('div', { class: 'none', text: 'Gnomon reaches no service of yours. Add an `integrations` entry to ~/.sundial/config.json to give it one.' }),
        ])
      : null,

    // ── Gnomon's own hands ────────────────────────────────────────────────
    // Grouped by what the gate does with them, not listed. There are
    // twenty-eight, and the question is never "what does gnomon_shelve do" —
    // it is "what can this thing do without asking me".
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `Its own hands · ${reg.own}` }),
      // K0.1. One line rather than a usage column: the section below is
      // grouped by VERDICT, which is the question ("what can this do without
      // asking me"), and a per-tool count down the side would answer a
      // different one at the same size.
      (() => {
        const rows = Object.values(d.ownUsed ?? {}).filter(Boolean)
        if (rows.length === 0) return null
        const calls = rows.reduce((n, r) => n + r.calls, 0)
        const failed = rows.reduce((n, r) => n + r.failed, 0)
        return el('p', {
          class: 'panel-note',
          text: `${count(rows.length, 'of these has', 'of these have')} actually been used since the counting began — ${count(calls, 'call')}${failed ? `, ${failed} of which failed` : ', none of which failed'}.`,
        })
      })(),
      ...RUNGS.map((rung) =>
        el('div', { class: 'reach-group' }, [
          el('h3', { class: 'reach-group-head', text: `On ${rung.word}` }),
          ...byVerdict(d.own ?? [], rung.preset).map((group) =>
            el('p', { class: 'reach-line' }, [
              el('span', { class: 'reach-line-verdict', 'data-tone': group.tone, text: group.word }),
              el('span', { class: 'reach-line-tools' }, [
                el('span', { text: group.tools.map((t) => t.tool).join(', ') }),
                // A shell tool's verdict depends on the command, so the row
                // says so rather than implying the preset settles it.
                group.tools.some((t) => t.verdicts?.[rung.preset]?.argDependent)
                  ? el('span', { class: 'reach-depends', text: ' — for an ordinary command; a destructive one is refused whatever this says' })
                  : null,
              ]),
            ]),
          ),
        ]),
      ),
      // Why Auto changes nothing for two of them. Read off the gate's own
      // reason string rather than re-derived, and absent when the owner has
      // tightened nothing — a line saying "0 tools are tightened" is one the
      // eye learns to skip.
      tightenedByConfig(d.own ?? []).length
        ? el('p', {
            class: 'panel-note',
            text: `${tightenedByConfig(d.own ?? []).join(' and ')} stop for you on Auto as well as on Ask, because you have held ${tightenedByConfig(d.own ?? []).length === 1 ? 'it' : 'them'} tighter than the chip does in config.actions. That setting can only tighten; nothing in ~/.sundial/config.json can loosen what the preset allows.`,
          })
        : null,
      // The one thing the gate refuses whatever the chip says, because it is
      // the only promise this card can make.
      el('p', {
        class: 'panel-note',
        text: 'A destructive shell command — rm -rf, sudo, dd, a piped curl, a force push — is refused at both settings and at every auto mode. That check runs on the command itself, not on the preset, and it is the only thing here that Auto does not turn off.',
      }),
    ]),

    // ── What the record cannot say ────────────────────────────────────────
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'What this card cannot tell you' }),
      el('p', {
        class: 'panel-note',
        text: d.countingSince
          ? `What ran before ${new Date(d.countingSince).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}. Until then only two of Gnomon's own tools wrote a row when they acted, so of the record's first 120 action rows, 119 were shell runs and one was a calendar event — a call to a connected service appended nothing at all. The gate writes one row per call now, whatever the tool, so "not used" above means not since that date rather than never.`
          : 'When any of this was last used, or how often it failed. The gate now writes a row for every call it lets through, but none has been made since it started — so the counts above are empty because nothing has run, not because nobody wrote it down.',
      }),
    ]),
  ]
}

/**
 * What Gnomon said today, what it is holding for a better moment, and what it
 * decided not to say — with the numbers behind each decision.
 *
 * This is how the owner tunes the gate: not by editing thresholds but by seeing
 * what almost cleared them. A dropped row with weight 0.52 against a bar of
 * 0.55 is a different fact from one at 0.05, and the page shows both.
 */
/**
 * Every question Gnomon has put to the owner, and whether asking was worth it.
 *
 * **One object now, not two.** The card carried `owner_asks` and `ask_threads`
 * side by side and the audit read them as two things sharing a surface. The
 * split turned out to be a deletion rather than a move: `ask_threads` is not
 * the chat feed — the chat feed is the dsh sessions the threads card reads —
 * it is the retired macOS Ask surface's Q&A log, whose event last fired on
 * 2026-08-15. What is left is one subject with one question hanging over it,
 * which is what a card is: *asking costs the owner's attention before Gnomon
 * has said anything useful, so was it worth it?*
 *
 * **The precision figure the audit asked for is refused, and the refusal is on
 * the card.** `outcome` holds `answered` and `expired` and nothing else — 47
 * and 1 — and drawn as a percentage that is 98%, which flatters the asker.
 * Nothing in the record knows that two of those meetings were ones the owner
 * did not attend: a calendar carries an attendee list, which is an invitation.
 * So the verdict is theirs to give, through the door that already existed —
 * `feedback:verdict` gained `owner_ask` as an artifact kind, and its three
 * words land exactly on the three things that can be wrong with a question.
 * Until they press one the card says the number is not measured yet, rather
 * than printing a zero.
 *
 * **What the record can answer exactly is the SHAPE of the asking**, and
 * `askCensus` computes it with no model in the path: four templates, one of
 * them put fourteen times, and fifteen questions landing within an hour of
 * another of the same kind. A repeat count is a fact; a precision percentage
 * would have been a judgement wearing one.
 *
 * **The picture is the clock, because the audit's own example was a clock.**
 * "asked 07:32, answered 11:13 = a bad-moment ping" is two readings — where in
 * the day Gnomon interrupts, and how long the owner was left holding it — and
 * `dayClock` already draws both on one scale shared down a column. A date axis
 * was the other candidate and it was refused: the goals trail says WHEN in the
 * calendar, which the row's own date already says.
 *
 * **No `now` tick, unlike the habits card.** A ritual recurs, so "am I on my
 * usual path right now" is a question about today; an ask happened once, on a
 * day that is over, and an ochre line down every row would say that every
 * question is live.
 */
function asksPanel(d) {
  const asks = newestFirst(Array.isArray(d?.asks) ? d.asks : [], (a) => a.askedAt)
  const c = askCensus(asks)
  const quieting = askQuieting(d?.quieted)
  const section = el('section', { class: 'panel' })

  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null)
  const held = (m) => (m === null ? null : m < 60 ? `${m} min` : hm(m))

  // One clock for the whole list, so a tick on row forty means the same hour as
  // a tick on row one — which is the only reason to draw it on a row at all.
  const scale = dayScale(asks.map((a) => ({ startMin: minuteOfDay(a.askedAt), endMin: minuteOfDay(a.askedAt) + (waitMinutes(a) ?? 0) })))

  /**
   * One door for a fact drawn out of an answer.
   *
   * `/gnomon/api/assert` is the door the goals and people cards use and the one
   * `gnomon assert` uses, so a fact typed here and a fact said out loud land on
   * the same entity — the split that cost four goals two ids each. It carries
   * the answer's own event id, which is what lets the next read say which
   * answers became something instead of the button looking like it did nothing.
   */
  const assert = (body) =>
    fetch('/gnomon/api/assert', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => {
      if (!r.ok) throw new Error(String(r.status))
      return r
    })

  // ── One question ─────────────────────────────────────────────────────────
  // Closed is a LINE — mark, question, state, when and how long, clock — and
  // the answer, the reason, the verdict and the routing door wait inside. I3's
  // rule on its fifth surface: a stacked block is what a row looks like OPEN,
  // and forty-eight of them standing open is the page of paragraphs the owner
  // has already rejected once.
  const row = (ask, index) => {
    const state = status(ask.verdict ?? ask.outcome)
    const wait = waitMinutes(ask)
    const gist = askGist(ask, factSentence)
    const summary = el('summary', { class: 'question-line' }, [
      el('span', { class: 'goal-caret' }, [icon('more')]),
      // Verbatim, hash and all. `Who is person-35941f3bc4?` breaks the rule
      // that no hash is shown to the owner, and it stays: this is not Gnomon
      // describing someone, it is the question it actually asked, and the
      // unreadability IS the finding the census counts fourteen times.
      // H5: the SUBJECT of the question, then what its answer holds. The card's
      // own review said the row repeated one template twenty-five times, so the
      // eleven boilerplate words come off (`askSubject`) and the space they
      // freed carries the finding instead. The hash stays verbatim where the
      // question had one — that unreadability is what the census counts
      // fourteen times, and it is not Gnomon describing someone, it is the
      // question it actually asked.
      el('span', { class: 'question-question', text: askSubject(ask.question) }),
      // Ochre, because a proposal is a model's reading and that is what ochre
      // means everywhere on this client. Rendered on every row so the track
      // holds its width down the column; empty where no model has looked yet,
      // which is a different row from one that read nothing.
      el('span', { class: 'question-gist', 'data-tone': gist?.empty ? 'quiet' : null, title: gist && !gist.empty ? gist.text : null }, [
        gist ? el('span', { text: gist.text }) : null,
        gist?.more ? el('span', { class: 'question-gist-more', text: `+${gist.more}` }) : null,
      ]),
      el('span', { class: 'question-state', 'data-tone': state.tone, text: state.word }),
      // The date and the wait, which the picture cannot say: its axis is a
      // time of DAY, so it carries neither which day nor how many minutes a
      // six-pixel band is. Different readings, not a repeat.
      el('span', { class: 'question-facts' }, [when(ask.askedAt) ?? '', wait === null ? '' : ` · held ${held(wait)}`].map((t) => el('span', { text: t }))),
      el('span', { class: 'question-clock-cell', title: wait === null ? 'asked, never answered' : `asked at this hour, answered ${held(wait)} later` }, [
        dayClock({ startMin: minuteOfDay(ask.askedAt), endMin: wait === null ? null : minuteOfDay(ask.askedAt) + wait, width: 380, now: null }, scale),
      ]),
    ])

    // The three things that can be wrong with a question, in the one display
    // vocabulary. The words are `status.js`'s and are not reworded here — what
    // changes with the subject is the `title`, not the vocabulary.
    const verdicts = el('div', { class: 'verdicts' })
    const settle = (text) => verdicts.replaceChildren(el('span', { class: 'verdict-done', text }))
    if (ask.verdict) settle(statusWord(ask.verdict))
    else
      for (const [verdict, title] of [
        ['useful', 'worth asking'],
        ['wrong', 'the wrong question — you were not in that meeting, or it could not be answered'],
        ['not-now', 'a fair question at a bad moment'],
      ])
        verdicts.append(
          el('button', {
            type: 'button',
            class: 'act act-small',
            text: statusWord(verdict),
            title,
            onclick: async () => {
              for (const b of verdicts.querySelectorAll('button')) b.disabled = true
              settle((await postVerdict('owner_ask', ask.id, verdict)) ? statusWord(verdict) : 'not recorded')
            },
          }),
        )

    // ── What the answer became ───────────────────────────────────────────
    // Read back from the record, never from the DOM. A retracted row is kept
    // and marked: the one auto-routed answer in the whole record stored a
    // counter-question as a person's name, and hiding it the moment the owner
    // corrected it would hide the evidence that auto-routing was the mistake.
    const became = (ask.routed ?? []).map((f) =>
      el('li', { class: 'question-became', 'data-tone': f.retracted ? 'quiet' : null }, [
        el('span', { text: factSentence(f, f.subject) }),
        f.retracted ? el('span', { class: 'question-became-gone', text: 'since corrected' }) : null,
      ]),
    )

    // ── The routing door ──────────────────────────────────────────────────
    // Measured before it was promised: about a dozen of the forty-seven
    // answers carry a decision, a name or a correction; the rest are "Fine,
    // nothing to keep". So this is a door on the rows that have one, not a
    // chip strip on all of them — and which rows those are is the owner's
    // judgement, not a keyword match.
    //
    // **The form is now filled in, and the form itself did not change.** H2's
    // `askHarvest` reads the answer and files its proposals BESIDE the ask;
    // this is the only thing that reads them. Still no extraction happening
    // here, and still no auto-route: the model fills the fields, the owner
    // reads the sentence and presses, and that press is the only thing that
    // writes. The id's own guarantee is the fallback — a who-is question is
    // about that alias and can only be `knownAs` — for every answer no model
    // has looked at yet.
    const proposals = Array.isArray(ask.proposals) ? ask.proposals : []
    const prefill = proposals[0] ?? routePrefill(ask)
    const form = el('form', { class: 'question-form', hidden: true })
    const opener = el('button', { type: 'button', class: 'act act-small', text: 'Route it →', title: 'Keep something from this answer as a fact' })
    const said = el('p', { class: 'panel-note' })
    const kind = el('select', { class: 'select', name: 'entityKind' }, ['person', 'project', 'tool', 'topic', 'goal', 'owner'].map((k) => el('option', { value: k, text: k, selected: k === prefill.entityKind })))
    const field = (name, label, value, attrs = {}) => el('label', { class: 'goal-field' }, [el('span', { text: label }), el('input', { class: 'proposal-other', name, value, ...attrs })])
    form.replaceChildren(
      el('div', { class: 'question-form-row' }, [el('label', { class: 'goal-field' }, [el('span', { text: 'About' }), kind]), field('canonicalName', 'Which one?', prefill.canonicalName, { type: 'text', maxlength: '160', required: true, placeholder: 'the name you would say' })]),
      field('predicate', 'Says what?', prefill.predicate, { type: 'text', maxlength: '60', required: true, placeholder: 'knownAs, decided, prefers…' }),
      // The model's object when it read one; otherwise the answer verbatim, as
      // it has always been — the field the owner edits, never the claim.
      field('object', 'Which is?', String(prefill.object ?? ask.answer ?? '').slice(0, 1000), { type: 'text', maxlength: '1000', required: true }),
      el('div', { class: 'question-form-row' }, [el('button', { type: 'submit', class: 'act act-small act-on', text: 'Keep it' }), said]),
    )
    opener.onclick = () => {
      form.hidden = !form.hidden
      opener.textContent = form.hidden ? 'Route it →' : 'Never mind'
      if (!form.hidden) form.querySelector('input')?.focus()
    }
    form.onsubmit = async (event) => {
      event.preventDefault()
      const values = Object.fromEntries(new FormData(form).entries())
      const submit = form.querySelector('button[type=submit]')
      submit.disabled = true
      try {
        await assert({ ...values, sourceEventId: ask.answerEventId })
        said.textContent = 'Kept. It appears under this question on the next read.'
        form.hidden = true
        opener.textContent = 'Route it →'
      } catch {
        said.textContent = 'That could not be kept.'
      }
      submit.disabled = false
    }

    // ── The model's other two readings ────────────────────────────────────
    // The first proposal is in the form above, where it can be edited. A
    // second and a third are extra lines with their own Keep, because an
    // answer that named three people should not cost three passes through one
    // form — and because a row the owner does not press is a row that never
    // becomes anything, which is the whole ratio this item exists to move.
    // Each is drawn as a SENTENCE and not as `predicate → object`: a row the
    // owner cannot say out loud has not been designed yet.
    const extras = proposals.slice(1).map((proposal) => {
      const note = el('span', { class: 'question-extra-said' })
      const keep = el('button', {
        type: 'button',
        class: 'act act-small',
        text: 'Keep it',
        onclick: async () => {
          keep.disabled = true
          try {
            await assert({ ...proposal, sourceEventId: ask.answerEventId })
            note.textContent = 'Kept. It appears under this question on the next read.'
          } catch {
            note.textContent = 'That could not be kept.'
            keep.disabled = false
          }
        },
      })
      return el('li', { class: 'question-extra' }, [el('span', { text: factSentence(proposal, proposal.canonicalName) }), keep, note])
    })

    return el('details', { class: 'question', 'data-tone': ask.answer ? null : 'quiet', style: { '--i': index } }, [
      summary,
      el('div', { class: 'question-open' }, [
        // A fold adds. The question, the state and the timing are all on the
        // line above, so what goes in here is the answer — the valuable part,
        // and therefore the one thing with the rule — the reason Gnomon gave
        // for asking, and the exact clock times the picture rounds off.
        stackedBlock({
          body: ask.answer ?? null,
          subline: ask.reason ? `Gnomon asked because: ${ask.reason}` : null,
          meta: [`asked ${when(ask.askedAt)}`, ask.answeredAt ? `answered ${when(ask.answeredAt)}` : 'never answered'],
        }),
        became.length ? el('ul', { class: 'question-becames' }, became) : null,
        el('div', { class: 'question-acts' }, [verdicts, ask.answer ? opener : null]),
        form,
        extras.length ? el('ul', { class: 'question-extras' }, extras) : null,
      ]),
    ])
  }

  const list = el('div', { class: 'question-list' }, asks.map(row))
  const count = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`

  section.replaceChildren(
    // No second title: the head already says Asks beside its mark. What belongs
    // here is what the head cannot say — which question this card answers, and
    // the pin, since asking is a habit measured over weeks and a span of Today
    // would empty the card most mornings.
    el('p', {
      class: 'panel-lead',
      text: asks.length
        ? `Every question Gnomon has put to you — ${count(c.total, 'question')}, whatever span the board is on. Asking spends your attention before it has said anything useful, so the only thing worth measuring here is whether it was worth it.`
        : 'Gnomon has never asked you anything.',
    }),
    asks.length
      ? el('div', { class: 'question-census' }, [
          // **The ratio, as the headline.** The card's own review settled what
          // it is for: an inbox for the owner's own words, whose one measure is
          // how many answers became beliefs. That number was the last clause of
          // the third sentence, where nobody read it. It is two counts and a
          // dot, and it is not a percentage — 1 of 49 as "2%" is a figure that
          // says the asking failed, when what it says is that routing by hand
          // cost thirty seconds an answer.
          el('p', { class: 'question-ratio' }, [
            el('strong', { text: count(c.total, 'asked', 'asked') }),
            el('span', { text: '·' }),
            el('strong', { 'data-tone': c.routed === 0 ? 'quiet' : null, text: `${c.routed} kept` }),
            // Absent, not zero, on both: a row with a proposal nobody has
            // pressed is work waiting, and an answer nobody has read yet is
            // not an answer that held nothing.
            c.waiting ? el('span', { text: `${c.waiting} waiting for a press` }) : null,
            c.unread ? el('span', { text: `${c.unread} not read yet` }) : null,
          ]),
          // Three sentences, and each one is a count rather than a judgement.
          el('p', {
            text:
              c.judged === 0
                ? `${c.answered} answered, ${c.expired} expired — which is everything the record stores, and it is not how good the questions were. Say so on a row and this line starts meaning something.`
                : `${c.answered} answered, ${c.expired} expired. Of the ${count(c.judged, 'question')} you have judged, ${c.worthAsking} ${c.worthAsking === 1 ? 'was' : 'were'} worth asking.`,
          }),
          el('p', {
            text: `${count(c.byKind.length, 'kind')} of question — ${c.byKind.map(([kind, n]) => `${n} ${KIND_WORDS[kind]}`).join('; ')}. ${c.repeated} of them came within an hour of another of the same kind.`,
          }),
          // What pressing a word has DONE, which until now was nothing: a
          // verdict on an ask lowers its whole CLASS, and B1 says the card has
          // to be able to read that back. Absent when nothing is quieted —
          // "you have quieted 0 kinds" would train the eye to skip the line.
          quieting.length
            ? el('p', {
                text: `You have called ${quieting.map((q) => `${q.words} the wrong question${q.fires > 1 ? ` ${q.fires} times` : ''}, so ${q.effect}`).join('; and ')}. ${quieting.length === 1 ? 'It comes' : 'Each comes'} back on its own over the following weeks.`,
              })
            : null,
          el('p', {
            text:
              c.medianWait === null
                ? 'Nothing has been answered yet.'
                // The kept count came OFF this sentence when it became the
                // headline: it was the last clause of the third line, and a
                // number said twice is a number read once.
                : `You usually answer within ${held(c.medianWait)}; the longest wait was ${held(c.longestWait)}, and ${count(c.slow, 'question')} sat over an hour.`,
          }),
        ])
      : null,
    // The axis, named once. The clock is a time of DAY: reading the column top
    // to bottom says when Gnomon interrupts, and the band says how long it left
    // the owner holding the question.
    asks.length
      ? el('div', { class: 'question-head' }, [
          // An empty leading cell: the head's first track stands in for the
          // caret, the question and the state, so the label lands over the
          // column it actually names.
          el('span'),
          el('span', { class: 'question-head-label', text: 'asked · held' }),
          el('span', { class: 'question-clock-cell question-hours-row' }, scaleHours(scale).map((hour) => el('span', { class: 'ritual-hour', style: { '--at': `${((hour * 60 - scale.from) / (scale.to - scale.from)) * 100}%` }, text: String(hour).padStart(2, '0') }))),
        ])
      : null,
    asks.length ? list : el('div', { class: 'none', text: 'Nothing to show.' }),
  )
  return section
}

/**
 * The noticing gate, and the one number the owner can move.
 *
 * **The subject of this card is the BAR, not the rows.** "Things Gnomon did
 * not say" is a log, and the counting says why a log would teach nothing here:
 * 94 of the 104 keys the gate has ever weighed appear on exactly one day,
 * because the key names one event — `return-from-break:2026-09-11`,
 * `work-shelved:01M2Q1G9M…`, `day-end-drift:w2957`. Nothing recurs, so nothing
 * on a row is a trend. What recurs is the threshold every one of them was
 * measured against, and the audit's own example is a statement about it: "a
 * dropped row with weight 0.52 against a bar of 0.55 is a different fact from
 * one at 0.05."
 *
 * So there is one picture, and it is the weight axis. Every row draws its own
 * decision on it, the whole list is SORTED by it, and the two bars are ruled
 * across the column where they fall. Reading the column top to bottom is the
 * distribution: the marks descend, and every place a colour breaks the run is
 * a decision the bar did not settle on weight alone — a budget that was gone,
 * a moment that cost too much, a key already worn down. Those breaks are the
 * card, and they needed no second hero picture to find.
 *
 * Three things the counting settled, each written where it applies:
 * `gate.js` for the asks coming off and the budget arithmetic; the census
 * below for what half the drops were worth; and `recurring` for habituation.
 */
function unsaidPanel(d) {
  const all = Array.isArray(d?.decisions) ? d.decisions : []
  // The axis IS the order. Everywhere else on this client a list is live-first
  // then newest, and that rule is for a feed: it says which row the owner can
  // act on. Here every row is finished and the question is where it sat against
  // the bar, so sorting by anything but weight would put the picture and the
  // list into two different readings of the same numbers.
  // Stamped once, here, so the picture and the list agree about which column a
  // decision belongs in — the two used to derive it separately.
  // Where the bars stand TODAY, served by the route off the owner's own dial.
  // Never the policy's shipped constants: see `barsFor`, and the five rows
  // that were drawn on the wrong side of a line before this was wired through.
  const bars = d?.bars ?? barsFor(0)
  // K0.2 — `placedAt` is the weight expressed against the bar this row
  // actually met, which is what the axis measures. Sorting by it rather than
  // by the raw weight keeps the list in the picture's order once rows from two
  // different dial settings sit on one card.
  const rows = all
    .map((r) => ({ ...r, outcome: outcomeOf(r), placedAt: placedWeight(r, bars.tonic) }))
    .sort((a, b) => (b.placedAt ?? 0) - (a.placedAt ?? 0))
  const c = gateCensus(all, bars)
  const scale = weightScale(bars)
  const budget = d?.budget ?? {}
  const bar = (n) => n.toFixed(2)

  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')
  const at = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
  const count = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`

  // ── One row ──────────────────────────────────────────────────────────────
  // Closed is a line: what Gnomon noticed, what it did, when, and where that
  // landed on the axis. The arithmetic, the evidence and the verdict wait
  // inside — I3's rule on its sixth surface.
  const row = (r, index) => {
    const outcome = r.outcome
    const summary = el('summary', { class: 'gate-line' }, [
      el('span', { class: 'goal-caret' }, [icon('more')]),
      // The title carries the WHOLE observation, because the track clips it at
      // 506px and the fold deliberately does not repeat it. "A fold adds" does
      // not license losing half a sentence.
      el('span', { class: 'gate-what', text: r.observation ?? r.noticeKey ?? 'Something', title: r.observation ?? null }),
      el('span', { class: 'gate-outcome', 'data-outcome': outcome, text: outcome }),
      // The weight as a NUMBER, in its own track. The picture above carries
      // the comparison, so a second copy of it on every row would be the same
      // reading twice — and a band per row is the shape every other card on
      // this board already uses, which is what the owner objected to.
      el('span', { class: 'gate-weight-value', 'data-side': r.weight >= bars.tonic ? 'over' : 'under', text: num(r.weight, 2) }),
      el('span', { class: 'gate-when', text: day(r.decidedAt) }),
    ])

    // The arithmetic, as the strip of terms it is. Not a sentence: five
    // numbers multiplied together read as five numbers, and this is the one
    // place on the client where the owner is meant to see the machine.
    const terms = [
      ['surprise', r.surprise],
      ['precision', r.precision],
      ['habituation', r.habituation],
      ['concern', r.concern],
    ]
      .filter(([, v]) => Number.isFinite(v))
      .map(([label, v]) => el('span', { class: 'gate-term' }, [el('span', { class: 'gate-term-label', text: label }), el('span', { class: 'gate-term-value', text: num(v, 2) })]))

    return el('details', { class: 'gate-row', 'data-outcome': outcome, 'data-id': r.id, style: { '--i': index } }, [
      summary,
      el('div', { class: 'gate-open' }, [
        el('p', { class: 'gate-why', text: `Gnomon ${outcome === 'said' ? 'said it because' : outcome === 'held' ? 'held it because' : 'dropped it because'} ${whySentence(r)}.` }),
        el('div', { class: 'gate-terms' }, [
          ...terms,
          el('span', { class: 'gate-term gate-term-sum' }, [el('span', { class: 'gate-term-label', text: 'weight' }), el('span', { class: 'gate-term-value', text: num(r.weight, 2) })]),
          r.channel === 'phasic' || r.reason === 'too-costly-now'
            ? el('span', { class: 'gate-term' }, [el('span', { class: 'gate-term-label', text: 'less the cost of breaking in' }), el('span', { class: 'gate-term-value', text: num(r.utility, 2) })])
            : null,
        ]),
        // The evidence the producer offered, which is what a weight was
        // computed from — absent, not empty, where a producer gave none.
        Array.isArray(r.evidence) && r.evidence.length ? el('ul', { class: 'gate-evidence' }, r.evidence.map((e) => el('li', { text: String(e) }))) : null,
        el('div', { class: 'gate-meta' }, [el('span', { text: at(r.decidedAt) }), el('span', { text: r.kind }), el('span', { class: 'gate-key', text: r.noticeKey })]),
        // Only what was SAID can be judged: a dropped notice never reached the
        // owner, so there is nothing for them to have an opinion about. The
        // one write door on this card, and it is the one that already existed
        // — `feedback:verdict` with `notice` as its kind and the GATE KEY as
        // its artifact id, which is what lets a `not-now` quiet that key.
        outcome === 'said' && r.noticeKey
          ? el('div', { class: 'gate-acts' }, [
              r.verdict ? el('span', { class: 'verdict-done', text: statusWord(r.verdict) }) : verdictActs('notice', r.noticeKey, { words: { useful: statusWord('useful'), wrong: statusWord('wrong'), 'not-now': statusWord('not-now') } }),
            ])
          : null,
      ]),
    ])
  }

  // ── The list, cut where the bar falls ────────────────────────────────────
  // ONE rule, and it is the ambient bar. That is the only reason to sort by
  // weight: the threshold stops being a number in a sentence and becomes a
  // place in the list.
  //
  // **Cut at the interrupt bar too and the card states a falsehood 46 times.**
  // `decide` settles the channel BEFORE any threshold, from the candidate's
  // own `valueHalfLifeMs`: something with a long shelf life is measured
  // against the ambient bar however heavy it is and never reaches the
  // interrupting path at all. 46 rows on this card sit above 0.80 and went out
  // as ambient, so a band labelled "heavy enough to interrupt you" would be
  // wrong about most of the rows under it. The interrupt bar is still ON the
  // axis, where a mark is a reference rather than a claim about the row.
  const list = el('div', { class: 'gate-list' })
  let band = null
  rows.forEach((r, index) => {
    const here = r.weight >= bars.tonic ? 'over' : 'under'
    if (here !== band) {
      band = here
      list.append(
        el('div', { class: 'gate-rule', 'data-band': here }, [
          el('span', {
            class: 'gate-rule-label',
            text: here === 'over' ? `worth more than ${bar(bars.tonic)} — the bar to say anything at all` : `${bar(bars.tonic)} · below this Gnomon stays quiet`,
          }),
        ]),
      )
    }
    list.append(row(r, index))
  })

  // ── The ladder ───────────────────────────────────────────────────────────
  // Drawn at the size the card actually is, and redrawn when the owner drags
  // it — one user unit per pixel, the strata's own idiom. A fixed viewBox
  // scaled to fit is the trap this client has already paid for once.
  const slab = el('div', { class: 'ladder-slab' })
  const picture = svg('svg', { class: 'ladder', preserveAspectRatio: 'none', role: 'img', 'aria-label': `${c.total} gate decisions by weight, against a bar of ${bar(bars.tonic)}` })
  slab.append(picture)
  const ladder = el('figure', { class: 'ladder-figure' }, [
    slab,
    el('figcaption', { class: 'ladder-caption', text: `Every decision by what it was worth. The rule at ${bar(bars.tonic)} is the bar to say anything; ${bar(bars.phasic)} is the bar to break in, and only the ${c.urgent} short-lived ones ever met it. Press a mark to open its row.` }),
  ])

  // Pressing a mark opens the row it stands for. Without this the picture is
  // something to look at rather than a way into the list — and the list is 171
  // rows long, so "which one was that" has no other answer.
  const pick = (r) => {
    const found = [...list.querySelectorAll('.gate-row')].find((node) => node.dataset.id === r.id)
    if (!found) return
    for (const open of list.querySelectorAll('.gate-row[open]')) if (open !== found) open.open = false
    found.open = true
    found.scrollIntoView({ block: 'center', behavior: 'smooth' })
    found.classList.add('gate-row-lit')
    setTimeout(() => found.classList.remove('gate-row-lit'), 1400)
  }

  const paint = () => gateLadder(picture, { rows, width: Math.round(slab.clientWidth), height: Math.round(slab.clientHeight), scale, bars, overlap: c.overlap, weightAt, onPick: pick })
  // One frame's worth of coalescing: a drag fires this continuously.
  let queued = 0
  new ResizeObserver(() => {
    cancelAnimationFrame(queued)
    queued = requestAnimationFrame(paint)
  }).observe(slab)

  const section = el('section', { class: 'panel' })
  section.replaceChildren(
    el('p', {
      class: 'panel-lead',
      text: rows.length
        ? `Everything Gnomon has ever noticed and what it decided to do about it — ${count(c.total, 'decision')} over ${count(c.days, 'day')}, whatever span the board is on. One number decides all of them — ${bar(bars.tonic)}, the weight a thing has to reach before Gnomon says it at all. A second, ${bar(bars.phasic)}, decides whether it may break into what you are doing, and only ${c.urgent} of these were ever eligible for that: the rest keep long enough to wait. This card is those two numbers, and every row is an argument about where they should sit.`
        : 'The gate has never weighed anything.',
    }),
    // ── The picture, and it comes FIRST ────────────────────────────────────
    // The axis turned ninety degrees, with the whole card's argument on it.
    // Above the census rather than below it, because the census is four
    // paragraphs explaining a shape — read before the shape they are four
    // paragraphs of assertion, and the owner scrolls past them. See
    // `gate-ladder.js` for why this is not a band per row.
    rows.length ? ladder : null,
    rows.length
      ? el('div', { class: 'gate-census' }, [
          // The headline, and it is the number the bar would be moved on.
          // Not a percentage: "50% of drops were near misses" is a ratio of a
          // subset of a subset, and the two counts say the same thing without
          // inviting the reader to work out what the denominator was.
          el('p', { class: 'gate-ratio' }, [
            el('strong', { text: count(c.said, 'said', 'said') }),
            el('span', { text: '·' }),
            el('strong', { text: `${c.dropped} dropped` }),
            c.overlap ? el('span', { text: `${c.overlap.said + c.overlap.refused} of them inside one band` }) : null,
            c.held ? el('span', { text: `${c.held} still held` }) : null,
          ]),
          // **The overlap, and it is the headline because the dial cannot
          // spoil it.** The first draw of this card counted near misses
          // against the bar, and the bar moves: 25 of 50 against 0.55, 43 of
          // 50 against the live 0.28, which is a figure that says whatever the
          // dial says. The band between the lightest thing ever admitted and
          // the heaviest ever refused is a fact about the rows alone.
          c.overlap
            ? el('p', {
                text: `Gnomon has said things worth as little as ${bar(c.overlap.lo)} and refused things worth as much as ${bar(c.overlap.hi)} — ${c.overlap.said} admissions and ${c.overlap.refused} refusals inside that one band. So no single weight separates them — and ${c.refusedAboveBar} of the ${c.dropped} it dropped were ABOVE the bar when it dropped them, while nothing it said was below. Whatever is keeping Gnomon quiet, it is mostly not the bar: it is the day's budget, the cost of breaking in, a key already worn down — and a bar that used to sit higher.`,
              })
            : el('p', { text: `The bar has been clean: nothing it refused was heavier than anything it admitted. ${count(c.belowThreshold, 'thing')} fell under it.` }),
          // Habituation, said once and not drawn per row. The gate's third
          // lever, and the record says it has almost nothing to act on.
          el('p', {
            text: `The gate has a third lever — it quiets a thing it has already said — and it has ${c.habituatedKeys === 0 ? 'never used it' : `used it on ${count(c.habituatedKeys, 'key')}`}. That is not restraint: ${c.oneDayKeys} of the ${count(c.keys, 'key')} it has weighed have only ever come up on ONE day, because the key names one event — a date, a week, a single piece of work. So on the next day the gate meets a key it has never seen, at full volume, and wearing a key down only works within its own day.`,
          }),
          // The dial, and what it cost the card. Absent where the dial has not
          // moved, and where it HAS the caveat has to be beside it: the
          // decision rows store no threshold column, so a row weighed under a
          // different setting is drawn against today's bar and can sit on the
          // wrong side of it. Said out loud, because unsaid it reads as a
          // rendering fault — which is exactly how it was caught.
          biasSentence(bars)
            ? el('p', {
                text: `${biasSentence(bars)} ${
                  c.movedBar
                    ? `${count(c.movedBar, 'row')} below ${c.movedBar === 1 ? 'was' : 'were'} decided before Gnomon recorded which bar it used, so ${c.movedBar === 1 ? 'it is' : 'they are'} drawn against today's line and can sit on the wrong side of it.${c.placedRows ? ` The other ${c.placedRows} carry their own bar and are placed against that.` : ''}`
                    : c.placedRows
                      ? `Every row carries the bar it was actually weighed against, so moving the dial moves the line without moving the marks.`
                      : ''
                }`.trim(),
              })
            : null,
          el('p', {
            text:
              c.judged === 0
                ? 'You have not judged any of these yet. Open one Gnomon said and say whether it was worth hearing — a “not now” is the only thing that quiets its key.'
                : `Of the ${count(c.judged, 'thing')} you have judged, ${c.worthSaying} ${c.worthSaying === 1 ? 'was' : 'were'} worth hearing. A “not now” quiets that key; the others are recorded and change nothing, which is right — they are calibration, not a claim about the world.`,
          }),
          // Today, in one line and in the gate's own counter. The audit's brief
          // wanted this as the header; it is a day's fact on a card about the
          // record, so it sits last. See `GATE_DAILY_BUDGET` for the three
          // things the brief's own version of this sentence got wrong.
          el('p', {
            class: 'gate-today',
            text: `Today: ${budget.spent ?? 0} of ${budget.of ?? GATE_DAILY_BUDGET} ambient notices spent${budget.refused ? `, and ${count(budget.refused, 'thing')} refused because it was gone` : ', and nothing refused for it'}. Anything heavy enough to interrupt is said whatever the budget holds.`,
          }),
        ])
      : null,
    rows.length ? list : el('div', { class: 'none', text: 'Nothing to show.' }),
    d.goal
      ? panel(
          'Gnomon is researching',
          [
            ['Question', d.goal.question],
            ['Since', at(d.goal.openedAt)],
            ['Hypothesis', d.goal.hypothesis ?? '—'],
          ],
          'A goal Gnomon set itself when its own forecast kept being wrong. It closes when it learns something, and says so.',
        )
      : null,
  )
  return [section]
}

/**
 * The lab: what Gnomon is doing to itself. Three read-only sections over one
 * joined reading (`LabReading`) — nothing here takes a verdict; the verdicts
 * are elsewhere, this is the ledger of them.
 */
/**
 * What Gnomon has tried to learn about itself, and what came of it.
 *
 * **The card's one finding: the lab has never completed a study.** Five
 * questions opened since 3 August. Three closed `superseded` within a day —
 * displaced off a top-five list, which is not an answer — and two closed
 * `learned` on three and two new observations respectively. Every one of the
 * five has `finding: null`. The audit asked that "every closed question owes
 * one conclusion line"; the honest answer is that none of them has one, and
 * the card says so per row rather than rendering a blank.
 *
 * So the outcome word never travels alone. "Answered" beside n 5 → 8 is a
 * reader's own judgement to make; "answered" on its own is the card repeating
 * a claim the record does not support. See `lab.js` for the thresholds that
 * make that possible — a goal may open on 0.02 nats of correctable error and
 * declare victory on 0.006 of one.
 *
 * **Two things it also stopped mis-stating.** `assistant.acceptedCount` is a
 * lifetime counter and was printed under a heading saying "this week", beside
 * notice counts that really were week-scoped — one heading over two spans.
 * And the bench read empty because it matched keys beginning `experiment-`,
 * while `weekly-self-audit`, the most lab-like thing Gnomon does, sat
 * scheduled on it.
 */
function labPanel(data) {
  const d = data?.lab ?? {}
  const studies = (Array.isArray(d.questions) ? d.questions : []).map(study).sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)))
  const c = labCensus(d.questions)
  const bench = Array.isArray(d.experiments) ? d.experiments : []
  const ever = d.proposalsEver ?? {}
  const week = d.thisWeek ?? {}
  const n = week.notices ?? {}
  const judged = (n.useful ?? 0) + (n.wrong ?? 0) + (n.notNow ?? 0)
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—')
  const count = (x, one, many) => `${x} ${x === 1 ? one : (many ?? `${one}s`)}`

  // ── One study ────────────────────────────────────────────────────────────
  // Closed is a line; the question, the arithmetic it opened on and what it
  // concluded wait inside. The outcome word carries its evidence in the same
  // cell, because they are one claim.
  const row = (s, index) =>
    el('details', { class: 'study', 'data-tone': s.tone, style: { '--i': index } }, [
      el('summary', { class: 'study-line' }, [
        el('span', { class: 'goal-caret' }, [icon('more')]),
        el('span', { class: 'study-label', text: s.label ?? s.id }),
        el('span', { class: 'study-outcome', 'data-tone': s.tone, text: s.word }),
        // The sample the outcome rests on, beside the outcome. On the two that
        // say "answered" this reads "on 3 more" and "on 2 more", which is the
        // whole reason it is here.
        el('span', { class: 'study-evidence', text: s.grew === null ? '' : s.grew === 0 ? 'on nothing new' : `on ${count(s.grew, 'more observation')}` }),
        el('span', { class: 'study-life', text: s.days === null ? '' : `${count(s.days, 'day')} of ${STALE_AFTER_DAYS}` }),
        el('span', { class: 'study-when', text: when(s.openedAt) }),
      ]),
      el('div', { class: 'study-open' }, [
        el('p', { class: 'study-question', text: s.question ?? '' }),
        el('p', {
          class: 'study-why',
          // K0.4 — where the word was re-read rather than stored, say so. The
          // record's own label is `learned`, and a reader comparing this card
          // to the raw goal would otherwise find a disagreement with no
          // explanation.
          text: `It ended because ${s.means}.${s.legacy ? ' The record calls this one “learned”; it was closed before the two endings were told apart, and nothing was ever tested on it.' : ''}`,
        }),
        // The conclusion, or the fact that there is not one — K0.4.
        //
        // `finding` is a field on every goal, and until K0.4 only the trial
        // path wrote it and that path has never fired: all five of the
        // record's closed goals carry null. Both endings write it now, so a
        // goal closed from here on has a line, and an older one says in words
        // why it has not. A blank would read as a layout fault.
        el('p', {
          class: 'study-finding',
          'data-tone': s.conclusion ? null : 'quiet',
          text:
            s.conclusion ??
            'No conclusion was written. Until 23 September only a tested hypothesis could record one, and no question here ever formed one — so what these studies found is not recorded anywhere, and cannot be recovered.',
        }),
        el('div', { class: 'study-meta' }, [
          el('span', { text: `${(s.excessAtOpen ?? 0).toFixed(3)} nats correctable at open` }),
          el('span', { text: s.openedN === null ? '' : `n ${s.openedN} → ${s.closedN ?? '?'}` }),
          el('span', { text: `opened ${when(s.openedAt)}${s.closedAt ? `, closed ${when(s.closedAt)}` : ''}` }),
          s.hypothesis?.variable ? el('span', { text: `tested ${s.hypothesis.variable}` }) : null,
          s.tried?.length ? el('span', { text: `tried ${s.tried.join(', ')}` }) : null,
        ]),
      ]),
    ])

  return [
    el('section', { class: 'panel' }, [
      // The header story the audit asked for — worst prediction, study opened,
      // what was found — told as counts, because told as a narrative on this
      // record it would have to invent the third part.
      el('p', {
        class: 'panel-lead',
        text: c.total
          ? `When Gnomon predicts one part of your life worse than the rest, it opens a question about it and watches. ${count(c.total, 'question has', 'questions have')} been opened. ${c.answered ? `${c.answered} closed as answered` : 'None closed as answered'}, ${c.dropped} fell off the list before ${c.dropped === 1 ? 'it' : 'they'} could be, and ${c.concluded === 0 ? 'not one of them has a written conclusion' : `${c.concluded} carry a conclusion`}.`
          : 'Gnomon has never set itself a question.',
      }),
      c.total
        ? el('p', {
            class: 'panel-note',
            // The number that decides how much to believe the word "answered",
            // stated once at the top rather than left for the reader to add up.
            // K0.4 — "answered" now means a hypothesis was tested, and the
            // threshold close has its own word, so this sentence says which
            // ending the record actually contains rather than warning the
            // reader off a word the card is still using.
            text: `The longest any of them ran was ${count(c.longestDays ?? 0, 'day')} of the ${STALE_AFTER_DAYS} allowed, and the best-evidenced ending rests on ${c.bestGrowth === null ? 'no' : count(c.bestGrowth, 'new observation')}. ${
              c.answered === 0
                ? 'Not one has been answered: answering means proposing a hypothesis, testing it against the record and having it accepted, and no question here has ever formed one.'
                : `${count(c.answered, 'was', 'were')} answered — a hypothesis proposed, tested and accepted.`
            } A question may open on two hundredths of a nat of correctable error and close on six thousandths of one, which is why a gap that closes untested is reported as exactly that.`,
          })
        : null,
      studies.length ? el('div', { class: 'study-list' }, studies.map(row)) : null,
    ]),

    // ── The bench ────────────────────────────────────────────────────────
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'On the bench' }),
      bench.length
        ? table(
            [
              { label: 'What', cell: (r) => r.name ?? r.key },
              { label: 'Due', cell: (r) => new Date(r.at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) },
              { label: 'Why', cell: (r) => r.reason ?? '' },
              { label: 'State', cell: (r) => el('span', { class: r.status === 'due' ? 'gap-ready' : 'gap-waiting', text: r.status }) },
            ],
            bench,
          )
        : // The audit asked that an empty bench say WHY. On this record the
          // reason is not "all cells understood" — it is that every cell is
          // now under the bar a question has to clear to be worth opening.
          el('p', {
            class: 'panel-note',
            text: `Nothing scheduled. Gnomon opens a new question only where there is correctable error left to remove, and every cell on its map is now under that bar — which is why nothing has opened since ${when(c.lastClosedAt)}. The next question waits on a part of your life it starts predicting badly.`,
          }),
    ]),

    // ── The self-audit ───────────────────────────────────────────────────
    // Two spans, named. They were one heading over a lifetime counter and a
    // week-scoped one, which is the kind of thing a Lab card least deserves.
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'What you have told it' }),
      el('p', {
        class: 'panel-note',
        text: ever.resolved
          ? `Since the beginning you have decided ${count(ever.resolved, 'proposal')} — ${ever.accepted} accepted, ${ever.rejected} turned down. That is every one, not this week's.`
          : 'You have not decided a proposal yet.',
      }),
      el('p', {
        class: 'panel-note',
        text: judged
          ? `This week you have judged ${count(judged, 'thing')} Gnomon said: ${n.useful ?? 0} useful, ${n.wrong ?? 0} wrong, ${n.notNow ?? 0} not now. That count is read from a fifty-entry ring, so it is a floor rather than a total.`
          : 'You have not judged anything Gnomon said this week.',
      }),
      (week.proposals ?? []).length
        ? table(
            [
              { label: 'Proposal', cell: (r) => r.summary },
              { label: 'Kind', cell: (r) => r.kind },
              { label: 'Verdict', cell: (r) => statusWord(r.outcome) },
              { label: 'When', cell: (r) => when(r.at) },
            ],
            week.proposals,
          )
        : null,
    ]),
  ]
}

/**
 * The shelf: every lens ever composed, whether or not its card is up.
 *
 * A lens is a question someone worked out how to ask — which read tool, which
 * filters, which shape. The card was always disposable (remove, clear, load a
 * scene all take it) and the question went with it, so the same lens had to be
 * invented again from prose. The rows were always re-read, so nothing kept here
 * is stale: what is kept is the recipe, and putting one back is one press.
 */
export function lensesPanel(d) {
  const rows = Array.isArray(d.lenses) ? d.lenses : []
  if (rows.length === 0) return [el('div', { class: 'none', text: 'No lens yet. Ask Gnomon to show something as a shape — a ranking, a count over time, a filtered list — and it lands here.' })]

  // The recipe, in the same words the card's own foot uses, so a lens reads the
  // same on the shelf as it does on the board.
  const recipe = (spec) =>
    [
      String(spec.source?.tool ?? '').replace(/^gnomon_/, ''),
      spec.where?.length ? `${spec.where.length} filter${spec.where.length === 1 ? '' : 's'}` : null,
      spec.group ? `by ${spec.group}` : null,
      spec.sort ? `sorted ${spec.sort}` : null,
      spec.show && spec.show !== 'table' ? spec.show : null,
    ]
      .filter(Boolean)
      .join(' · ')

  const putUp = (row) =>
    el('button', {
      type: 'button',
      class: 'act',
      text: 'Put it up',
      onclick: (event) => {
        event.currentTarget.disabled = true
        fetch('/gnomon/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'place', id: row.id, kind: 'lens', text: row.spec }) }).catch(() => {})
      },
    })

  const block = (row, i) => {
    let spec = {}
    // A spec that will not parse still belongs on the shelf under its title;
    // the card is the half that fails to draw, and it says so itself.
    try {
      spec = JSON.parse(row.spec)
    } catch {}
    return stackedBlock({
      index: i,
      headline: row.title || row.id,
      subline: spec.note ?? null,
      meta: [recipe(spec), row.at ? new Date(row.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null],
      acts: row.up ? el('span', { class: 'verdict-done', text: 'on the board' }) : putUp(row),
    })
  }

  return [
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: `${rows.length} lens${rows.length === 1 ? '' : 'es'}, newest first` }),
      el('div', { class: 'blocks' }, rows.map(block)),
    ]),
  ]
}

const RENDER = {
  trust: trustPanel,
  reach: reachPanel,
  calibration: calibrationPanel,
  lab: labPanel,
  trace: tracePanel,
}
/** Each instrument's route comes from the card catalog, shared with the agent's reader. */
const PANELS = Object.fromEntries(Object.entries(RENDER).map(([key, draw]) => [key, [INSTRUMENT_ROUTES[key], draw]]))

/** The panel keys, derived, so `views.test.js` holds them against the catalog's Engine room routes. */
export const PANEL_KEYS = Object.keys(PANELS)

/** One Engine room tab past cost as a body: a title and a node that fills itself and re-reads while visible. */
export async function instrumentPane(tab, filters = null) {
  const id = PANELS[tab] ? tab : PANEL_KEYS[0]
  const label = ENGINE_TABS.find(([k]) => k === id)?.[1] ?? id
  const mark = null
  const body = el('div', { class: 'view-body' }, [el('div', { class: 'reading', text: 'Reading…' })])
  const [route, render] = PANELS[id]
  // A day filter draws that day instead of the board span (the route takes `date`).
  const url = filters?.date ? `${route}?date=${filters.date}` : route
  // `refresh` re-reads and redraws only when the reading changed, so the pane
  // can ride the live beat without churning the DOM (or the owner's selection).
  let last = ''
  const refresh = async () => {
    try {
      const data = await json(url)
      const key = JSON.stringify(data)
      if (key === last) return
      // Stamped only once the drawing SUCCEEDED. Written before it, a renderer
      // that threw left the card saying "Reading…" for ever — the read had
      // happened, the key was already stored, so the catch below decided this
      // was a re-read failure worth leaving alone and the card never said a
      // word. Thirteen instruments shared that, and it cost half an hour on
      // this one. The reason is logged for the same reason.
      body.replaceChildren(...render(data).filter(Boolean))
      last = key
    } catch (error) {
      console.error(`[gnomon] ${id} could not be drawn:`, error)
      if (last === '') body.replaceChildren(el('div', { class: 'none', text: 'That instrument could not be read.' }))
    }
  }
  // The first read waits until the card is on screen, and a re-read only
  // happens while it still is AND the record moved in a table this reading is
  // made of — `url` is what tells `read.js` which those are. Thirteen
  // instruments on one board used to mean thirteen queued reads at boot and
  // thirteen more every thirty seconds, for cards the owner may never pan to.
  whenVisible(body, refresh, url)
  return { title: label, mark, node: el('div', { class: 'view' }, [body]) }
}

