// The board's summary cards: In play, Rhythm, Voice and the Engine room's tabs.
import { instrumentPane } from './views.js'
import { el, newestFirst } from './surfaces.js'
import { strata } from './strata.js'
import { keepCurrent } from './read.js'
import { json, stagger, weekStrip, when } from './view-kit.js'
import { doneAct, promiseRow } from './view-today.js'
import { goalsSection } from './view-goals.js'
import { ledgerView } from './view-ledger.js'
import { rhythmPanel } from './view-rhythm.js'
import { habitsPanel } from './view-habits.js'
import { asksPanel } from './view-asks.js'
import { unsaidPanel } from './view-unsaid.js'

export function inPlay(habits, onAsk, project = null) {
  const all = Array.isArray(habits?.commitments?.open) ? [...habits.commitments.open] : []
  const open = project ? all.filter((c) => c.project === project) : all
  if (open.length === 0) return null
  // Promises first, soonest due first: they have a person waiting on them.
  const promises = open.filter((c) => c.promise).sort((a, b) => (a.promise.due ?? '9').localeCompare(b.promise.due ?? '9'))
  const shown = [...promises, ...newestFirst(open.filter((c) => !c.promise), (t) => t.lastTouchedAt)]
  return el('div', { class: 'col' }, [
    el('div', { class: 'col-head' }, [el('h3', { class: 'col-title', text: 'In play' }), el('span', { class: 'col-hint', text: `${open.length} open` })]),
    stagger(
      el(
        'div',
        {},
        shown.map((c) =>
          c.promise ? promiseRow(c, onAsk) : el(
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
  const build = async () => {
    const [goals, habits] = await Promise.all([json('/gnomon/goals').catch(() => null), json('/gnomon/habits').catch(() => null)])
    const project = filters?.project ?? null
    return el('section', { class: 'today today-part' }, [
      inPlay(habits, onAsk, project) ?? el('div', { class: 'none', text: project ? `Nothing open on ${project}.` : 'Nothing open.' }),
      goalsSection(goals),
    ])
  }
  return keepCurrent(await build(), build, ['/gnomon/goals', '/gnomon/habits'])
}

/**
 * Rhythm — what the owner's days look like over time. The one owner of the
 * fortnight's shape: This week, Strata, the Rhythm instrument and Habits each
 * held a view of the same days. Strata leads; `view` opens it on one section.
 */
export const RHYTHM_VIEWS = ['strata', 'days', 'arcs', 'habits']

export async function rhythmCard(filters = null) {
  const build = () => rhythmNode(filters)
  return keepCurrent(await build(), build, ['/gnomon/shape', '/gnomon/rhythm', '/gnomon/habits'])
}

export async function rhythmNode(filters) {
  const [shape, rhythm, habits] = await Promise.all([json('/gnomon/shape').catch(() => null), json('/gnomon/rhythm').catch(() => null), json('/gnomon/habits').catch(() => null)])
  const sections = {
    strata: shape ? [strata(shape)] : [],
    // Today in the owner's zone, which the shape carries: a UTC date put the
    // evening on the next day's week.
    days: shape ? [weekStrip(shape, new Date().toLocaleDateString('en-CA', { timeZone: shape.timeZone }))] : [],
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
  const build = () => voiceNode(filters)
  return keepCurrent(await build(), build, ['/gnomon/unsaid', '/gnomon/asks'])
}

export async function voiceNode(filters) {
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
export let shownTab = null

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
