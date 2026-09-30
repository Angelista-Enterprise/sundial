// Exploring the record.
//
// Every name on every pane is a door. Click a project, a person, a moment, and
// it opens INSIDE the card you are reading, over what was there, with a way
// back at its head — digging deeper never leaves the surface and never lands in
// the chat. A door with no card around it (the chat's prose) opens as its own
// card. The Explore pane itself is one field over
// the same retriever the model uses, plus the roster of everything Gnomon holds
// a belief about, by kind.
//
// Reads go through `/gnomon/api/read`, which runs the SAME read-only tools the
// model has — so what the owner can see here and what Gnomon can say are one
// record read two ways.
import { ASSERTABLE_ENTITY_KINDS } from '@sundial/helpers/vocab.js'
import { el } from './surfaces.js'
import { flatten, momentDetail, momentRow, momentSentence, projectName } from './moment-detail.js'
import { factLine, factSentence, ownerFirst } from './blocks.js'
import { focusPane, pane } from './stage.js'
import { lensesPanel, peopleSection } from './views.js'

const headers = { accept: 'application/json' }
const json = async (url) => {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}
const read = (tool, args) => json(`/gnomon/api/read?tool=${tool}&args=${encodeURIComponent(JSON.stringify(args))}`)

const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—')
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—')
const words = (key) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase()

/** One `label → value` row, the grammar the instruments already use. */
const row = (label, value, hint, attrs = {}) =>
  el('div', { class: 'panel-row', ...attrs }, [
    el('span', { class: 'panel-label', text: label }),
    value instanceof Node ? value : el('span', { class: 'panel-value', text: value }),
    hint ? el('span', { class: 'panel-hint', text: hint }) : null,
  ])

const reading = () => el('div', { class: 'reading', text: 'Reading…' })
const none = (text) => el('div', { class: 'none', text })

/**
 * A layer pushed over a card's body: a head with the way back, then the detail.
 * Layers stack, so a door inside a drill drills again; Back peels one.
 */
function drill(host, title, node) {
  const heading = el('h2', { class: 'drill-title', text: title })
  const when = el('span', { class: 'panel-hint drill-when' })
  const layer = el('div', { class: 'drill', role: 'region', 'aria-label': title }, [
    el('div', { class: 'drill-head' }, [el('button', { type: 'button', class: 'link drill-back', text: '← back', onclick: () => layer.remove() }), heading, when]),
    node,
  ])
  host.append(layer)
  // The HOST, not the layer. A drill is positioned against the card's content
  // box, so a card left scrolled halfway down its own content opens the drill
  // halfway down too — the detail's head above the top of the frame.
  host.scrollTop = 0
  return {
    title: (text, hint = '') => {
      heading.textContent = text
      when.textContent = hint
    },
  }
}

/** Where a detail goes: into the card it was opened from, else a card of its own. */
function seat(host, id, title, node, quiet) {
  if (host) return drill(host, title, node)
  pane(id, { title, node })
  if (!quiet) focusPane(id)
  return { title: (text, hint = '') => pane(id, { title: text, node, reading: hint }) }
}

// ── One search ────────────────────────────────────────────────────────────
// A search answers twice: the hits, and Gnomon's reading of them. The hits are
// the durable half and land first; the reading is a model call over exactly
// those hits and lands when it lands. Both arrive on one SSE stream from
// `/gnomon/api/search` — the same grammar the live channel and a turn already
// speak — so the list is never held back by the sentence about it.

/**
 * A hit's `text` is what the retriever indexes, and it opens with the tag the
 * ranking needs — `[moment <iso>]`, `[insight <iso>]`. On screen that tag is
 * the same instant already set beside the label, so it reads as the row saying
 * everything twice. Trimmed here, at the boundary, and nowhere upstream: BM25
 * still gets the whole string.
 */
const evidence = (text) => String(text ?? '').replace(/^\[[^\]]*\]\s*/, '')

/** One hit from the record: kind, what it is, when, what it says, how close it ranked. */
const recordHit = (h, i, top) =>
  el(
    'button',
    {
      type: 'button',
      class: 'hit',
      style: { '--i': i },
      'data-explore': h.refType === 'moment' ? `moment:${h.refId}` : null,
      onclick: h.refType === 'moment' ? null : (e) => e.currentTarget.toggleAttribute('data-open'),
    },
    [
      el('span', { class: 'hit-kind', text: String(h.refType ?? '').replace('_', ' ') }),
      el('span', { class: 'hit-line' }, [
        el('span', { class: 'hit-label', text: h.label ?? '' }),
        h.at ? el('span', { class: 'hit-when', text: `${day(h.at)} ${clock(h.at)}` }) : null,
      ]),
      el('span', { class: 'hit-text', text: evidence(h.text) }),
      el('span', { class: 'hit-score' }, [el('span', { class: 'hit-score-fill', style: { width: `${Math.round(((h.score ?? 0) / top) * 100)}%` } })]),
    ],
  )

/**
 * One hit from a past conversation. No score bar: this index is a literal text
 * match, and a bar drawn from nothing would read as a ranking that does not
 * exist. The em-dash rule, applied to a measurement that was never taken.
 *
 * Opening it is the session's business, not Explore's — `app.js` owns the
 * conversation and listens for this.
 */
const talkHit = (h, i) =>
  el(
    'button',
    {
      type: 'button',
      class: 'hit hit-said',
      style: { '--i': i },
      onclick: () => document.dispatchEvent(new CustomEvent('gnomon:open-session', { detail: { id: h.sessionId } })),
    },
    [
      el('span', { class: 'hit-kind', text: h.role === 'user' ? 'you said' : 'gnomon said' }),
      el('span', { class: 'hit-label', text: h.at ? `${day(h.at)} ${clock(h.at)}` : '—' }),
      el('span', { class: 'hit-text', text: h.excerpt ?? '' }),
    ],
  )

/** A named run of hits under its own eyebrow, so "what I did" never reads as "what we said". */
const group = (title, count, body) =>
  el('section', { class: 'found' }, [
    el('div', { class: 'found-head' }, [el('h2', { class: 'panel-title', text: title }), el('span', { class: 'panel-hint', text: count })]),
    body,
  ])

/**
 * Gnomon's reading of what the search returned, in the block its voice already
 * owns everywhere else: the 2px ochre rule over sunken paper. It sits ABOVE the
 * hits because it is the answer and they are the evidence — and every line it
 * could have drawn on is a few pixels below it, which is what keeps it
 * checkable.
 */
function readingSeat() {
  const body = el('p', { class: 'found-reading-text', text: 'Reading what came back…' })
  const seat = el('section', { class: 'found-reading', 'data-waiting': '' }, [
    el('div', { class: 'found-reading-head' }, [el('span', { text: 'Gnomon reads' })]),
    body,
  ])
  return {
    node: seat,
    said: (text) => {
      seat.removeAttribute('data-waiting')
      body.textContent = text
    },
    failed: (why) => {
      seat.removeAttribute('data-waiting')
      seat.setAttribute('data-unavailable', '')
      body.textContent = why
    },
    drop: () => seat.remove(),
  }
}

/**
 * The stream of the search being read right now. A second search while the
 * first is still thinking must not leave two model calls running, and only the
 * newest answer belongs on screen.
 */
let searching = null

/**
 * The roster as the Explore card last read it, so a NAME is searchable.
 *
 * The record search is semantic — it ranks moments and insights by what they
 * are about — and an entity is neither. Typing "Pat" therefore found
 * everything that mentioned him and never the thing Gnomon actually holds
 * beliefs about, which the owner could see sitting in the roster directly
 * below. These rows close that: matched here, in the client, from the list the
 * card already loaded, so they land instantly and cost no read.
 */
let held = []

/** Entity names matching `q`, as rows that open the entity — or null when none do. */
function memoryHits(q) {
  const needle = q.trim().toLowerCase()
  if (needle === '') return null
  const rows = held
    .filter((e) => String(e.canonicalName ?? e.id ?? '').toLowerCase().includes(needle))
    .sort((a, b) => (b.factCount ?? 0) - (a.factCount ?? 0))
    .slice(0, 8)
  if (rows.length === 0) return null
  return group(
    'In memory',
    `${rows.length} ${rows.length === 1 ? 'name' : 'names'} Gnomon holds beliefs about`,
    el(
      'div',
      { class: 'roster-list' },
      rows.map((e, i) =>
        el('button', { type: 'button', class: 'roster-item', style: { '--i': i }, 'data-explore': `entity:${e.canonicalName ?? e.id}` }, [
          el('span', { class: 'roster-name', text: e.canonicalName ?? e.id }),
          el('span', { class: 'roster-n', text: String(e.factCount ?? 0) }),
        ]),
      ),
    ),
  )
}

/** The whole answer to one query, as a node that fills itself as the stream arrives. */
function hitsFor(q) {
  // Drawn before the stream is even open: a name Gnomon already holds is an
  // answer, and it should not wait behind a semantic search and a model call.
  const mem = memoryHits(q)
  const found = el('div', { class: 'found-all' }, [mem, reading()].filter((part) => part instanceof Node))
  searching?.close()
  const stream = new EventSource(`/gnomon/api/search?q=${encodeURIComponent(q)}`)
  searching = stream
  const stop = () => {
    stream.close()
    if (searching === stream) searching = null
  }

  let seat = null
  // An EventSource raises `error` on an ORDINARY close too — the browser sees
  // the socket end and means to reconnect. Without this the successful answer
  // that just arrived would be overwritten by "cut off" a tick later.
  let settled = false
  stream.onmessage = (event) => {
    let frame
    try {
      frame = JSON.parse(event.data)
    } catch {
      return
    }
    if (frame.type === 'hits') {
      const record = Array.isArray(frame.record) ? frame.record : []
      const said = Array.isArray(frame.conversations) ? frame.conversations : []
      const shut = typeof frame.conversationsUnavailable === 'string' ? frame.conversationsUnavailable : null
      if (record.length === 0 && said.length === 0 && shut === null) {
        // A matched name is still an answer, so the empty line goes beneath it
        // rather than over it.
        return found.replaceChildren(...[mem, none('Nothing close to that, in the record or in anything you have said.')].filter((part) => part instanceof Node))
      }
      const top = Math.max(...record.map((h) => h.score ?? 0), 0.0001)
      // Nothing was found, but a corpus is down: there is no reading to wait
      // for, only the reason the half is missing.
      seat = record.length === 0 && said.length === 0 ? null : readingSeat()
      const parts = [mem, seat?.node]
      if (record.length > 0) {
        parts.push(group('In the record', `${record.length} of what you did`, el('div', { class: 'hits' }, record.map((h, i) => recordHit(h, i, top)))))
      }
      // A half that could not be searched keeps its heading and says why. It is
      // not the same as a half that was searched and found nothing, and the
      // owner has to be able to tell the two apart — both draw as no rows.
      if (shut !== null) parts.push(group('In conversation', 'not searched', none(shut)))
      else if (said.length > 0) parts.push(group('In conversation', `${said.length} of what was said`, el('div', { class: 'hits' }, said.map(talkHit))))
      // `replaceChildren` turns a null child into the word "null".
      found.replaceChildren(...parts.filter((part) => part instanceof Node))
    } else if (frame.type === 'reading') {
      settled = true
      if (typeof frame.text === 'string') seat?.said(frame.text)
      else seat?.failed(frame.unavailable ?? 'Gnomon could not read these.')
    } else if (frame.type === 'done') {
      settled = true
      stop()
    }
  }
  stream.onerror = () => {
    const wasOpen = stream.readyState !== EventSource.CLOSED
    stop()
    if (settled) return
    // Hits already drawn are the answer; only the sentence about them is lost.
    if (seat !== null) seat.failed('The reading was cut off.')
    else if (wasOpen) found.replaceChildren(none('The record could not be searched.'))
  }
  return found
}

// ── Said ──────────────────────────────────────────────────────────────────
// What was heard near the machine, one day at a time, and inside one meeting
// when a meeting is picked. The rows are `gnomon_signals` audio rows — the same
// read the model makes for "what did Alex say in standup" — so the owner and
// Gnomon read one transcript. The meetings are the calendar's own times
// (`/gnomon/meetings`), not the day context's, which stitches them from moments.

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5)
const shift = (date, n) => ymd(new Date(new Date(`${date}T12:00:00`).getTime() + n * 86_400_000))
const PAGE = 60

function saidSection() {
  const at = { date: ymd(new Date()), meeting: null, words: '' }
  const title = el('span', { class: 'panel-hint' })
  const dayLabel = el('span', { class: 'said-day' })
  const meets = el('div', { class: 'said-meets' })
  const list = el('div', { class: 'said-list' })
  const words = el('input', { class: 'said-field', type: 'search', placeholder: 'Only rows with these words', 'aria-label': 'Words the speech must hold', autocomplete: 'off' })
  const step = (n) => el('button', { type: 'button', class: 'said-step', 'aria-label': n < 0 ? 'The day before' : 'The day after', text: n < 0 ? '←' : '→', onclick: () => show({ date: shift(at.date, n), meeting: null }) })
  const next = step(1)
  words.addEventListener('keydown', (e) => e.key === 'Enter' && show({ words: words.value.trim() }))
  let asked = 0

  // The language is marked where it changes, not on every row: a Dutch standup
  // tagged "nl" sixty times says nothing sixty times.
  let lang = null
  const utterance = (s, i) => {
    const said = s.data?.language ?? null
    const switched = said !== lang
    lang = said
    return el('div', { class: 'said-row', style: { '--i': i } }, [
      el('span', { class: 'said-at', text: hhmm(s.data?.utteranceStartedAt ?? s.capturedAt) }),
      el('span', { class: 'said-text', text: s.data?.spokenText ?? '' }),
      s.data?.channel === 'system' ? el('span', { class: 'said-lang', text: 'call', title: 'Heard from the call (what the Mac played), not the room' }) : null,
      switched && said ? el('span', { class: 'said-lang', text: said === 'dutch' ? 'nl' : said === 'english' ? 'en' : said, title: `Heard as ${said}` }) : null,
    ])
  }

  async function page(offset, n) {
    const m = at.meeting
    const args = { date: at.date, signalType: 'audio:transcript', limit: PAGE, offset, ...(m ? { from: hhmm(m.start), to: hhmm(m.end) } : {}), ...(at.words ? { contains: at.words } : {}) }
    const r = await read('gnomon_signals', args)
    if (n !== asked) return
    const rows = (r.signals ?? []).filter((s) => s.type === 'audio:transcript')
    list.querySelector('.said-more')?.remove()
    if (offset === 0) {
      lang = null
      title.textContent = `${r.total ?? 0} heard${m ? ` in ${m.title}` : ''}${at.words ? ` with “${at.words}”` : ''}`
      if (rows.length === 0) return list.replaceChildren(none(at.words ? 'Nothing said with those words.' : m ? 'Nothing heard in this meeting.' : 'Nothing heard on this day.'))
      list.replaceChildren()
    }
    list.append(...rows.map((s, i) => utterance(s, i)))
    if (r.nextOffset) list.append(el('button', { type: 'button', class: 'link said-more', text: `${r.total - r.nextOffset} more`, onclick: () => page(r.nextOffset, n) }))
  }

  async function show(change = {}) {
    const dayChanged = change.date !== undefined && change.date !== at.date
    Object.assign(at, change)
    const n = ++asked
    words.value = at.words
    dayLabel.textContent = longDay(at.date)
    next.disabled = at.date >= ymd(new Date())
    list.replaceChildren(reading())
    if (dayChanged || meets.dataset.date !== at.date) {
      meets.dataset.date = at.date
      meets.replaceChildren()
      const d = await json(`/gnomon/meetings?date=${at.date}`).catch(() => ({ meetings: [] }))
      if (n !== asked) return
      at.meetings = d.meetings ?? []
    }
    // A meeting asked for by name (the card's `meeting` filter) is a title.
    if (typeof at.meeting === 'string') at.meeting = (at.meetings ?? []).find((m) => m.title.toLowerCase().includes(at.meeting.toLowerCase())) ?? null
    const chip = (m, label) =>
      el('button', { type: 'button', class: 'said-meet', 'aria-pressed': String(at.meeting === m), onclick: () => show({ meeting: m }) }, label)
    meets.replaceChildren(
      chip(null, [el('span', { text: 'All day' })]),
      ...(at.meetings ?? []).map((m) => chip(m, [el('span', { class: 'said-meet-at', text: `${hhmm(m.start)}–${hhmm(m.end)}` }), el('span', { class: 'said-meet-title', text: m.title })])),
    )
    await page(0, n).catch(() => n === asked && list.replaceChildren(none('What was said could not be read.')))
  }

  const node = el('section', { class: 'said' }, [
    el('div', { class: 'found-head' }, [el('h2', { class: 'panel-title', text: 'Said' }), title]),
    el('div', { class: 'said-bar' }, [step(-1), dayLabel, next, words]),
    meets,
    list,
  ])
  return { node, show }
}

// ── Explore ───────────────────────────────────────────────────────────────

let explore = null

export function openExplore(query = '', { quiet = false, kind = null, date = null, meeting = null } = {}) {
  if (explore === null) {
    const field = el('input', { class: 'explore-field', type: 'search', placeholder: 'A person, a project, a topic, a day, something said…', 'aria-label': 'Search the record and every conversation', autocomplete: 'off' })
    const hits = el('div', { class: 'hits' })
    const roster = el('div', { class: 'roster' })
    field.addEventListener('keydown', (event) => event.key === 'Enter' && search(field.value.trim()))

    const search = (q) => q !== '' && hits.replaceChildren(hitsFor(q))

    // The roster: what Gnomon holds beliefs about, by kind. Counts first,
    // because "81 topics, 30 tasks" is itself a reading of where its attention went.
    json('/gnomon/memory')
      .then((m) => {
        const entities = Array.isArray(m?.entities) ? m.entities : []
        // The same list the search matches names against (`memoryHits`).
        held = entities
        // Opening Explore WITH a query — which is what the command bar does —
        // starts this read and the search in the same breath, and the search
        // wins. Run it again now that the names are here, or the first search
        // of a session would be the one search with no names in it.
        if (field.value.trim() !== '') search(field.value.trim())
        if (entities.length === 0) return
        const kinds = [...new Set(entities.map((e) => e.kind))].sort()
        const list = el('div', { class: 'roster-list' })
        const show = (kind) => {
          const rows = entities.filter((e) => e.kind === kind).sort((a, b) => (b.factCount ?? 0) - (a.factCount ?? 0)).slice(0, 40)
          list.replaceChildren(
            ...rows.map((e, i) =>
              el('button', { type: 'button', class: 'roster-item', style: { '--i': i }, 'data-explore': `entity:${e.canonicalName ?? e.id}` }, [
                el('span', { class: 'roster-name', text: e.canonicalName ?? e.id }),
                el('span', { class: 'roster-n', text: String(e.factCount ?? 0) }),
              ]),
            ),
          )
          for (const chip of roster.querySelectorAll('.roster-kind')) chip.setAttribute('aria-pressed', String(chip.dataset.kind === kind))
        }
        roster.replaceChildren(
          el(
            'div',
            { class: 'roster-kinds' },
            kinds.map((kind) =>
              el('button', { type: 'button', class: 'roster-kind', 'data-kind': kind, 'aria-pressed': 'false', onclick: () => show(kind) }, [
                el('span', { class: 'roster-kind-n', text: String(entities.filter((e) => e.kind === kind).length) }),
                el('span', { text: kind }),
              ]),
            ),
          ),
          list,
        )
        explore.show = show
        explore.kinds = kinds
        show(explore.kind && kinds.includes(explore.kind) ? explore.kind : kinds.includes('project') ? 'project' : kinds[0])
      })
      .catch(() => {})

    // Who and what Gnomon knows has one home: the People instrument (who, the
    // merges it suggests, the attendees nobody named) and the saved lenses
    // live here now, under the names, instead of on cards of their own.
    const people = el('div', { class: 'explore-more' })
    const lenses = el('div', { class: 'explore-more' })
    json('/gnomon/people').then((d) => people.replaceChildren(el('h2', { class: 'panel-title', text: 'People' }), peopleSection(d))).catch(() => {})
    // The lenses panel titles itself ("8 lenses, newest first").
    json('/gnomon/lenses').then((d) => lenses.replaceChildren(el('section', { class: 'panel' }, lensesPanel(d)))).catch(() => {})

    const said = saidSection()
    explore = { field, search, said, kind: null, node: el('div', { class: 'explore' }, [el('div', { class: 'explore-bar' }, [field, el('span', { class: 'explore-hint', text: 'Enter searches · any name on any pane opens · / anywhere for the command bar' })]), hits, roster, said.node, people, lenses]) }
    if (!date) said.show()
  }
  // Set to a day or a meeting (its `date` / `meeting` filters), Said opens on it.
  if (date || meeting) {
    explore.said.show({ ...(date ? { date } : {}), meeting: meeting ?? null })
    // The card's own body scrolls, never the board around it.
    requestAnimationFrame(() => {
      const body = explore.said.node.closest('.pane-body')
      if (body) body.scrollTop += explore.said.node.getBoundingClientRect().top - body.getBoundingClientRect().top
    })
  }
  // Set to a kind (its `kind` filter), the roster opens on it — now, or once the names arrive.
  if (kind) {
    explore.kind = kind
    if (explore.show && explore.kinds?.includes(kind)) explore.show(kind)
  }
  pane('explore', { title: 'Explore', node: explore.node, sticky: true, onFocus: () => explore.field.focus({ preventScroll: true }) })
  if (!quiet) focusPane('explore')
  if (query !== '') {
    explore.field.value = query
    explore.search(query)
  }
}

// ── An entity ─────────────────────────────────────────────────────────────

/** Kinds the assert route accepts; a fact on anything else is read-only here. */
const ASSERTABLE = new Set(ASSERTABLE_ENTITY_KINDS)
const JSON_HEADERS = { 'content-type': 'application/json' }

export async function openEntity(name, { quiet = false, host = null, id = `entity:${name.toLowerCase()}` } = {}) {
  const node = el('div', { class: 'entity' }, [reading()])
  seat(host, id, name, node, quiet)
  let matches = []
  try {
    matches = await read('gnomon_entity_history', { name })
  } catch {
    node.replaceChildren(none('That could not be read.'))
    return
  }
  if (!Array.isArray(matches) || matches.length === 0) {
    node.replaceChildren(none(`Nothing is held about “${name}”.`))
    return
  }
  // The exact name first; a substring match that is not it is still worth
  // seeing, below.
  matches.sort((a, b) => Number(b.entity?.canonicalName?.toLowerCase() === name.toLowerCase()) - Number(a.entity?.canonicalName?.toLowerCase() === name.toLowerCase()))
  node.replaceChildren(
    ...matches.slice(0, 4).map((m) => {
      const e = m.entity ?? {}
      const facts = Array.isArray(m.facts) ? [...m.facts] : []
      // What the owner said, then what Gnomon worked out, then what it no
      // longer believes. The owner's own `hasPendingFeature` sat below Photo
      // Booth before this.
      const ordered = ownerFirst(facts)
      const current = facts.filter((f) => f.validTo === null || f.validTo === undefined).length
      const label = e.canonicalName ?? name
      // The owner's hands on the memory. `Fix` asserts the same predicate with
      // a new object — the record supersedes, nothing is overwritten. `Wrong`
      // is the feedback verdict that retracts. Both go through the routes the
      // chat already uses, so a click here and a sentence there are one fact.
      const canAssert = ASSERTABLE.has(e.kind)
      const assert = (predicate, object) =>
        fetch('/gnomon/api/assert', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ entityKind: e.kind, canonicalName: label, predicate, object }) }).then((r) => r.ok)
      const retract = (factId, note) =>
        fetch('/gnomon/api/feedback', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ artifactKind: 'entity_fact', artifactId: factId, verdict: 'wrong', ...(note ? { note } : {}) }) }).then((r) => r.ok)
      // One sentence with its evidence, drawn by `blocks.js` — the same shape
      // the Memory instrument uses, because they are the same fact.
      const factRow = (f, i) => {
        const acts = el('span', { class: 'fact-acts' })
        const row = factLine(f, { subject: label, acts: f.validTo || !f.id ? null : acts, index: i })
        if (f.validTo || !f.id) return row
        const said = row.querySelector('.fact-sentence')
        const because = row.querySelector('.fact-because')
        const settle = (text) => {
          acts.replaceChildren(el('span', { class: 'verdict-done', text }))
          because.textContent = text
        }
        acts.append(
          el('button', {
            type: 'button',
            class: 'act act-small',
            text: 'Fix',
            title: 'Say what is true instead — your word supersedes this',
            hidden: !canAssert,
            onclick: async () => {
              const next = prompt(`${label} · ${words(String(f.predicate))} — what is true?`, String(f.object ?? ''))?.trim()
              if (!next || next === f.object) return
              for (const b of acts.querySelectorAll('button')) b.disabled = true
              const ok = await assert(f.predicate, next)
              if (ok) said.textContent = factSentence({ ...f, object: next }, label)
              settle(ok ? 'fixed · yours' : 'not recorded')
            },
          }),
          el('button', {
            type: 'button',
            class: 'act act-small',
            text: 'Wrong',
            title: 'Retract this — Gnomon stops believing it',
            onclick: async () => {
              for (const b of acts.querySelectorAll('button')) b.disabled = true
              const ok = await retract(f.id)
              if (ok) row.classList.add('fact-gone')
              settle(ok ? 'removed' : 'not recorded')
            },
          }),
        )
        row.append(acts)
        return row
      }
      const addRow = () => {
        const pred = el('input', { class: 'fact-field', placeholder: 'predicate (worksOn, knownAs, role…)', 'aria-label': 'Predicate' })
        const object = el('input', { class: 'fact-field fact-field-wide', placeholder: 'what is true', 'aria-label': 'Object' })
        const add = el('button', {
          type: 'button',
          class: 'act act-small',
          text: 'Add',
          onclick: async () => {
            const pr = pred.value.trim().replace(/\s+/g, '')
            const ob = object.value.trim()
            if (!pr || !ob) return
            add.disabled = true
            const ok = await assert(pr, ob)
            add.disabled = false
            if (!ok) return void (add.textContent = 'not recorded')
            pred.value = ''
            object.value = ''
            factsBox.prepend(factRow({ id: null, predicate: pr, object: ob, validFrom: new Date().toISOString(), validTo: null, provenance: 'assertion', confidence: 100 }, 0))
          },
        })
        object.addEventListener('keydown', (ev) => ev.key === 'Enter' && add.click())
        return el('div', { class: 'fact fact-add' }, [pred, object, add])
      }
      const factsBox = el('div', { class: 'facts' }, ordered.length ? ordered.slice(0, 80).map(factRow) : [none('No facts held.')])
      return el('section', { class: 'panel' }, [
        el('div', { class: 'panel-head entity-head' }, [
          el('h2', { class: 'panel-title', text: `${label} · ${e.kind ?? ''}` }),
          e.alias ? el('span', { class: 'panel-hint', text: e.alias }) : null,
          el('span', { class: 'panel-hint', text: `${current} held · ${facts.length - current} superseded` }),
          canAssert
            ? el('button', {
                type: 'button',
                class: 'act act-small',
                text: 'Also known as…',
                title: 'Give this name another name Gnomon should read as the same',
                onclick: async () => {
                  const other = prompt(`${label} is also known as…`)?.trim()
                  if (other && (await assert('knownAs', other))) factsBox.prepend(factRow({ id: null, predicate: 'knownAs', object: other, validFrom: new Date().toISOString(), validTo: null, provenance: 'assertion', confidence: 100 }, 0))
                },
              })
            : null,
        ]),
        canAssert ? addRow() : null,
        factsBox,
      ])
    }),
    appearedIn(matches[0]?.appearances),
  )
}

/**
 * One moment, as a row: when it started, what it was, how deep, how long. The
 * same four-part grammar Today's "Just now" already uses, so a moment reads
 * identically wherever it is met — in a day, beside a name, or under a search.
 * `what` is the moment's own words; `meta` is where it happened.
 */
/** Where a name showed up in a moment, in the owner's words. */
const PLACE = { meeting: 'in a meeting', said: 'said aloud', screen: 'on screen', reading: "in Gnomon's summary" }

/**
 * The moments a name appears in — W4. It asked the retriever for the name and
 * kept the moment hits, and a similarity search on a person returns facts, so
 * the filter left nothing and the card said "No moments near it" about someone
 * named in 37. `gnomon_entity_history` now looks the moments up and says where
 * in each the name was, because a meeting and a name on screen are different
 * evidence — and Alex's 37 are mostly the second.
 */
function appearedIn(appearances) {
  const found = Array.isArray(appearances?.moments) ? appearances.moments : []
  const total = appearances?.total ?? found.length
  if (found.length === 0) return el('section', { class: 'panel' }, [el('h2', { class: 'panel-title', text: 'In the record' }), none('Not named in any moment.')])
  const lead = Object.entries(appearances?.byPlace ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `${n} ${PLACE[w] ?? w}`)
    .join(', ')
  return el('section', { class: 'panel' }, [
    el('h2', { class: 'panel-title', text: 'In the record' }),
    el('p', { class: 'panel-note', text: `Named in ${total} moment${total === 1 ? '' : 's'}${found.length < total ? `; the ${found.length} newest` : ''}: ${lead}.` }),
    el('div', {}, found.map((m) => momentRow({ id: m.id, startTime: m.startTime, durationMs: m.durationMs, intent: m.intent, processName: m.processName, meta: `${m.startTime ? day(m.startTime) : ''} · ${(m.where ?? []).map((w) => PLACE[w] ?? w).join(' · ')}` }))),
  ])
}

// ── A day ─────────────────────────────────────────────────────────────────
// A date is not a phrase, and searching the record for "2026-09-13" ranked
// moments from the 10th and the 11th above the day itself — the retriever
// doing exactly what it is for on a query it should never have been handed.
// A day has its own read path (`/gnomon/day`, the same one the Ledger's day
// view uses), so a day door opens the day.

const minutes = (n) => (typeof n !== 'number' ? '—' : n < 60 ? `${n}m` : `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}m` : ''}`)
const longDay = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
/** Below this a moment is a glance, not a session: shown, but not before the work. */
const GLANCE_MIN = 2

export async function openDay(date, { quiet = false, host = null } = {}) {
  const id = `day:${date}`
  const node = el('div', { class: 'day-detail' }, [reading()])
  const at = seat(host, id, longDay(date), node, quiet)
  let d = null
  try {
    d = await json(`/gnomon/day?date=${encodeURIComponent(date)}`)
  } catch {
    node.replaceChildren(none('That day could not be read.'))
    return
  }
  // Newest first. It ran oldest-first here while every other list of moments on
  // the board ran the other way, which is the ordering the audit found three
  // times and the reason there is now one row builder rather than two.
  const all = (Array.isArray(d?.moments) ? [...d.moments] : []).sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))
  if (all.length === 0) {
    at.title(longDay(date), 'nothing recorded')
    node.replaceChildren(none('Nothing was recorded on this day.'))
    return
  }

  const mins = (m) => m.activeMin ?? m.durationMin ?? 0
  const active = all.reduce((n, m) => n + (m.activeMin ?? 0), 0)
  const projects = [...new Set(all.map((m) => m.projectId).filter(Boolean))]
  at.title(longDay(date), `${all.length} moment${all.length === 1 ? '' : 's'} · ${minutes(active)} active`)

  const asRow = (m) => momentRow(m)

  const work = all.filter((m) => mins(m) >= GLANCE_MIN)
  const glances = all.filter((m) => mins(m) < GLANCE_MIN)
  const list = el('div', {}, work.map(asRow))
  // The short ones are not hidden, they are folded: a day is 200 moments and
  // most are three seconds of a window passing. Saying how many were folded is
  // the part that keeps the list honest.
  const more =
    glances.length === 0
      ? null
      : el('button', {
          type: 'button',
          class: 'link day-more',
          text: `${glances.length} shorter than ${GLANCE_MIN} minutes`,
          onclick: (e) => {
            list.replaceChildren(...all.map(asRow))
            e.currentTarget.remove()
          },
        })

  node.replaceChildren(
    el('section', { class: 'panel' }, [
      row('Active', minutes(active), `of ${minutes(all.reduce((n, m) => n + (m.durationMin ?? 0), 0))} observed`),
      row('Moments', String(all.length), work.length === all.length ? null : `${work.length} over ${GLANCE_MIN} minutes`),
      projects.length
        ? row(
            'Projects',
            el(
              'span',
              { class: 'panel-value day-projects' },
              projects.slice(0, 6).map((p) => el('span', { class: 'door', 'data-explore': `entity:${p.split('/').pop()}`, tabindex: '0', role: 'link', text: p.split('/').pop() })),
            ),
          )
        : null,
    ]),
    el('section', { class: 'panel' }, [el('h2', { class: 'panel-title', text: 'Through the day' }), list, more]),
  )
}

// ── A moment ──────────────────────────────────────────────────────────────
// The drawing lives in `moment-detail.js`, shared with every other surface
// that shows a moment. This is only the door: read it, seat it, hand it over.

export async function openMoment(momentId, { quiet = false, host = null, id = `moment:${momentId}` } = {}) {
  const node = el('div', { class: 'moment-detail' }, [reading()])
  const at = seat(host, id, 'Moment', node, quiet)
  let m = null
  try {
    m = await read('gnomon_moment_detail', { momentId })
  } catch {
    node.replaceChildren(none('That moment could not be read.'))
    return
  }
  if (m === null || typeof m !== 'object' || typeof m.error === 'string') {
    node.replaceChildren(none(m?.error ?? 'No such moment.'))
    return
  }
  const f = flatten(m)
  // The head carries the sentence too, so a parked card says what it is without
  // being opened — and says the same thing it will say when it is.
  at.title(momentSentence(m).split(' — ')[1] ?? projectName(f.projectId) ?? f.processName ?? 'Moment', f.startTime ? `${day(f.startTime)} ${clock(f.startTime)}${f.endTime ? `–${clock(f.endTime)}` : ''}` : '')
  node.replaceChildren(
    ...momentDetail(m, {
      onDoor: true,
      // The owner's hand on which copy of the speech they read. Through the
      // kernel, like every other change, so the choice is in the record.
      onAccept: () => fetch('/gnomon/api/transcript-accept', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ momentId }) }).then((r) => r.ok, () => false),
    }),
  )
}

// ── The doors ─────────────────────────────────────────────────────────────
// One listener, in the capture phase, so a name inside an ask-row opens rather
// than asks: the door wins over the row it sits in.
export function open(ref, host = null) {
  const at = ref.indexOf(':')
  const kind = at === -1 ? 'search' : ref.slice(0, at)
  const key = at === -1 ? ref : ref.slice(at + 1)
  if (kind === 'entity') openEntity(key, { host })
  else if (kind === 'moment') openMoment(key, { host })
  else if (kind === 'day') openDay(key, { host })
  else if (host) drill(host, `“${key}”`, hitsFor(key))
  else openExplore(key)
}

const throughDoor = (event) => {
  const door = event.target instanceof Element ? event.target.closest('[data-explore]') : null
  if (door === null || door.closest('.wings') !== null) return
  if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  event.stopPropagation()
  open(door.dataset.explore, door.closest('.pane-body'))
}
document.addEventListener('click', throughDoor, true)
document.addEventListener('keydown', throughDoor, true)

// `/` is NOT bound here. It opens the command bar (palette.js), which knows
// every card and view by name and falls through to a search — and a search is
// what brings this card. One key, one door, and the door is the one that can
// answer "goals" as well as "Noah".

