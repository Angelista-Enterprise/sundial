// Today: the day's parts (the brief, the moments, the resume line, what was heard), built from the routes and kept current.
import { el } from './surfaces.js'
import { TODAY_PARTS as CATALOG_TODAY_PARTS } from './cards.js'
import { markSeen, verdictActs } from './verdicts.js'
import { sundial } from './sundial.js'
import { boardLink } from './markdown.js'
import { keepCurrent } from './read.js'
import { localToday } from './span.js'
import { statusWord } from './status.js'
import { coverage } from './calibration.js'
import { clock, focusBar, hm, json, shareBar, stagger, when } from './view-kit.js'
import { assistantProposalsSection, draftsSection, proposalsSection } from './view-proposals.js'
import { shelfSection } from './view-shelf.js'
import { dayPanel } from './view-day.js'

/** UC1 (U1-F29): close a promise with a reason; the act settles into the word it did. */
export function closeAct(id, text, reason, title) {
  const act = el('button', {
    type: 'button',
    class: 'act act-small',
    text,
    title,
    onclick: async (e) => {
      e.stopPropagation()
      act.disabled = true
      const ok = await fetch('/gnomon/api/commitment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, close: true, reason }) }).then((r) => r.ok).catch(() => false)
      act.parentElement?.replaceWith(el('span', { class: 'verdict-done', text: ok ? (reason === 'kept' ? 'kept' : 'dropped') : 'not recorded' }))
    },
  })
  return act
}

/** The owner closing a heard promise: `commitment:closed` through the kernel, then the row says so. */
export function doneAct(id) {
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
 * Open commitments — the branches with work on them — ordered by how recently
 * they were touched. The quiet ones fade, because a branch nobody has touched
 * in a week is a different kind of open.
 */
/** "Thu 17:00", or "today 17:00" — when a promise is due, in the owner's words. */
export function dueLabel(iso) {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? `today ${time}` : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`
}

/**
 * UC1 (U1-F34): a promise in play. Who it is owed to, when it is due and why
 * then, and four small acts: it was kept, it is dropped, move it, or keep it in
 * Reminders — the last two load a request into the composer, never send one,
 * so a date is the owner's and a reminder goes through the gate's ask.
 */
export function promiseRow(c, onAsk) {
  const p = c.promise
  const when = p.due ? (p.dueKind === 'next-meeting' && p.nextMeeting ? `at ${p.nextMeeting}, ${dueLabel(p.due)}` : `due ${dueLabel(p.due)}`) : ''
  const acts = el('span', { class: 'promise-acts' }, [
    closeAct(c.id, 'Kept', 'kept', 'You kept it'),
    closeAct(c.id, 'Drop', 'dropped', 'It no longer stands'),
    el('button', { type: 'button', class: 'act act-small', text: 'Move', title: 'Give it a new date', onclick: () => onAsk?.('play', `Move my promise "${c.name}" (${c.id}) to `) }),
    el('button', { type: 'button', class: 'act act-small', text: 'Remind', title: 'Keep it in Apple Reminders — Gnomon asks before it writes', onclick: () => onAsk?.('play', `Add my promise "${c.name}" (${c.id}) to Reminders${p.due ? `, due ${new Date(p.due).toISOString()}` : ''}.`) }),
  ])
  return el('div', { class: 'row', title: p.evidence?.length ? p.evidence.join(' · ') : c.name }, [
    el('span', { class: 'row-name' }, [el('span', { text: c.name }), when ? el('span', { class: 'row-sub', text: ` · ${when}` }) : null, p.confirmed ? null : el('span', { class: 'row-sub', text: ' · heard, not confirmed' })]),
    acts,
  ])
}

/**
 * The files worked in most today, with the share of all changes. The file
 * watcher records thirteen thousand changes a week; until this they fed a ring
 * in state and one line of the presence strip.
 */
export function filesToday(hotFiles, onAsk) {
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
export const partsByDay = new Map()

/**
 * `date` (YYYY-MM-DD) makes the day-bound parts read another day; null is today.
 * One build per day, cached — and "today" is keyed by the page's own date, so a
 * tab open past midnight builds the new day rather than serving yesterday's.
 * Each part then keeps itself current (`keepCurrent`): a change in the record
 * draws it again in place, from one shared rebuild.
 */
export function todayParts(onAsk, date = null) {
  const key = date ?? `today:${localToday()}`
  if (!partsByDay.has(key)) {
    // Yesterday's "today" is nobody's any more.
    for (const old of partsByDay.keys()) if (old.startsWith('today:') && old !== key) partsByDay.delete(old)
    partsByDay.set(key, buildTodayParts(onAsk, date).then((parts) => partsStayCurrent(parts, onAsk, date)))
  }
  return partsByDay.get(key)
}

/** What the parts of Today are read from, for `markStale`. */
export const PART_ROUTES = ['/gnomon/today', '/gnomon/day', '/gnomon/dial', '/gnomon/shelf', '/gnomon/asks', '/gnomon/unsaid', '/gnomon/attribution/proposals', '/gnomon/assistant/proposals']

/** One rebuild in flight per day, shared by the parts that all want it after the same frame. */
export const rebuilding = new Map()

export function rebuildParts(onAsk, date) {
  const key = date ?? `today:${localToday()}`
  if (!rebuilding.has(key)) rebuilding.set(key, buildTodayParts(onAsk, date).finally(() => rebuilding.delete(key)))
  return rebuilding.get(key)
}

export function partsStayCurrent(parts, onAsk, date) {
  if (!parts) return parts
  for (const [id, node] of Object.entries(parts)) {
    keepCurrent(node, async () => (await rebuildParts(onAsk, date))?.[id] ?? null, PART_ROUTES, {
      // The live line (#strip) that app.js moved into Today stays where it is.
      swap: (into, next) => {
        const live = into.querySelector('.brief-now > *')
        into.replaceChildren(...next.childNodes)
        if (live) into.querySelector('.brief-now')?.append(live)
      },
    })
  }
  return parts
}

export const TODAY_PARTS = CATALOG_TODAY_PARTS

export async function buildTodayParts(onAsk, forDate = null) {
  const get = (path) => json(path).catch(() => null)
  const on = forDate ? `?date=${forDate}` : ''
  const [figure, today, shelf, day, shape, habits, unsaid, proposals, suggested, drafts, asks, meetingBrief] = await Promise.all([
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
    // lane B
    forDate ? null : get('/gnomon/brief'),
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
        ...openAsks.map((a) => el('div', { class: 'row' }, [el('span', { class: 'row-name', text: a.question }), answerDoor()])),
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
  const passing = forDate ? null : heardBlock(unsaid)
  const briefNode = forDate ? null : briefBlock(meetingBrief)
  const brief = el('section', { class: 'today brief' }, [
    el('p', { class: 'brief-line', text: briefLine({ date, observedMin, projects, meetings: today?.meetings, noticed: noticed.length }) }),
    // The live line (#strip) moves in here from app.js; for another day there is no "now".
    forDate ? null : el('div', { class: 'brief-now' }),
    moment,
    briefNode,
    passing,
    // One line, not a second copy of the shelf: the count, and a door to the card that owns it.
    waitingCount
      ? el('p', { class: 'brief-left' }, [boardLink('shelf', [document.createTextNode(`${waitingCount} wait${waitingCount === 1 ? 's' : ''} for you`)])])
      : el('div', { class: 'none', text: 'Nothing left for you.' }),
  ])
  // Today off the board (the owner removed it on 09-24 and it stayed off) left
  // "Where was I", the meeting brief and In passing with nowhere to show. Left
  // for you leads with its own copy of the three; the sheet hides it whenever
  // Today is on the board, so the page never says them twice.
  const lead = forDate ? null : el('div', { class: 'shelf-lead' }, [await momentBlock(onAsk), briefBlock(meetingBrief), heardBlock(unsaid)])
  return {
    today: brief,
    dial: face,
    shelf: el('section', { class: 'today today-part' }, [lead, ...(leftNodes.length ? leftNodes : [el('div', { class: 'none', text: 'Nothing waits for you.' })]), answeredNode]),
  }
}

/**
 * "Answer in the chat", as a door rather than a label: it opens the
 * conversation with Gnomon's question in its seat above the composer and the
 * cursor under it. app.js answers `gnomon:answer`; this module has no hold on
 * the conversation, and should not.
 */
export function answerDoor() {
  return el('button', {
    type: 'button',
    class: 'link row-value',
    text: 'Answer in the chat',
    title: 'Open the conversation, with the question above the composer',
    onclick: (event) => {
      event.stopPropagation()
      document.dispatchEvent(new CustomEvent('gnomon:answer'))
    },
  })
}

/**
 * What this moment of the day asks, answered — the Today card following the
 * situation (S1) and its phase (S2). The question leads; the answer is the
 * record's, a few lines, each a door to the card that owns the rest. The owner
 * asked these in chat at these moments ~70 times; this answers them first.
 */
export async function momentBlock(onAsk) {
  // Today's parts are built once per day and cached, so the moment keeps
  // itself current: it re-reads the situation every minute while it is shown.
  const box = el('section', { class: 'brief-moment' })
  const draw = async () => {
    // Never redraw under the owner's typing: the note field would lose its text.
    if (box.contains(document.activeElement) && document.activeElement?.classList.contains('resume-note')) return
    const drawn = await momentRows(onAsk)
    box.replaceChildren(...(drawn ?? []))
    box.hidden = drawn === null
  }
  await draw()
  // One timer per block; it ends once the block has left the page (a redrawn Today builds a new one).
  const timer = setInterval(() => (box.isConnected ? draw() : clearInterval(timer)), 60_000)
  return box
}

export async function momentRows(onAsk) {
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

  // "Where was I" (UC2): the line built at the return leads, with its verdicts,
  // and replaces the generic back-from-break rows it improves on.
  const resume = sit.resume ? resumeBlock(sit.resume, onAsk, sit.resumeUse) : null
  if (resume) rows.push(...resume)
  if (resume && sit.phase === 'back-from-break') {
    // Nothing else: the line is the answer.
  } else if (sit.phase === 'morning') {
    const y = new Date(Date.parse(sit.at) - 86_400_000)
    const ymd = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
    const yesterday = await json(`/gnomon/today?date=${ymd}`).catch(() => null)
    if (yesterday?.coverage?.trackedMin) row(briefLine({ date: ymd, observedMin: yesterday.coverage.trackedMin, projects: yesterday.projects ?? [], meetings: yesterday.meetings ?? 0 }), '', { 'data-explore': `day:${ymd}`, role: 'link', tabindex: '0' })
    for (const l of (sit.leftOff ?? []).slice(0, 3)) row(`${l.projectName} — ${l.what}`, clock(l.at))
  } else if (sit.phase === 'meeting-soon' && sit.next) {
    row(`${sit.next.title} ${inMin(sit.next.startsInMin)}`, sit.next.with.slice(0, 4).join(', '))
    rows.push(el('p', { class: 'brief-left' }, [boardLink('shelf', [document.createTextNode('A brief may be waiting in Left for you')])]))
  } else if (sit.phase === 'meeting-ended') {
    if (sit.waitingForYou?.question) rows.push(el('div', { class: 'row' }, [el('span', { class: 'row-name', text: sit.waitingForYou.question }), answerDoor()]))
    else row('The meeting just ended — tell Gnomon what to keep.')
  } else if (sit.phase === 'evening') {
    rows.push(el('p', { class: 'brief-left' }, [boardLink('dial', [document.createTextNode('The whole day, hour by hour')])]))
  } else if (here) {
    row(`${here.name}${sit.now.branch ? ` · ${sit.now.branch}` : ''}`, sit.now.projectIsSticky ? 'last project' : '')
    openRows()
  }
  // What is next, when it is not already the point.
  if (sit.next && sit.phase !== 'meeting-soon' && sit.next.startsInMin <= 240) row(`Next: ${sit.next.title} ${inMin(sit.next.startsInMin)}`, sit.next.with.slice(0, 3).join(', '))
  const note = noteField(sit.note)
  if (rows.length === 0) return [note]
  return [el('h3', { class: 'col-title', text: resume && sit.phase === 'back-from-break' ? 'Where was I?' : sit.question }), ...rows, note]
}

/**
 * One line for the owner's next step before they leave (U2-F35): Enter keeps
 * it, and the next return leads with it. The research ranks a next step the
 * owner wrote above any summary of what they did.
 */
export function noteField(note) {
  const said = el('span', { class: 'row-value', text: note ? 'kept for your return' : '' })
  const input = el('input', {
    class: 'proposal-other resume-note',
    type: 'text',
    maxlength: '200',
    value: note?.text ?? null,
    placeholder: 'Next step, for when you’re back',
    'aria-label': 'A next step for your return',
    onkeydown: async (event) => {
      event.stopPropagation()
      if (event.key !== 'Enter') return
      event.preventDefault()
      const ok = await fetch('/gnomon/api/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: input.value }) }).then((r) => r.ok, () => false)
      said.textContent = !ok ? 'not kept' : input.value.trim() ? 'kept for your return' : 'cleared'
    },
  })
  return el('div', { class: 'row' }, [input, said])
}

/** The return line, a verdict on it under its notice key, and on demand the way back into each piece. */
export function resumeBlock(resume, onAsk, use) {
  const more = resumeDetails(resume, use)
  // Which piece the owner used (U2-F36); fire and forget.
  const opened = (piece) => fetch('/gnomon/api/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opened: piece }) }).catch(() => {})
  const restore = more.length
    ? el('details', { class: 'shelf-answered' }, [
        el('summary', { text: 'Restore' }),
        ...more.map((m) =>
          m.href
            ? el('a', { class: 'row row-ask', href: m.href, target: '_blank', rel: 'noopener', onclick: () => opened(m.piece) }, [el('span', { class: 'row-name', text: m.label })])
            : m.ask
              ? el('button', { type: 'button', class: 'row row-ask', title: 'Loads the request; Gnomon asks before it runs anything', onclick: () => (opened(m.piece), onAsk?.(m.ask)) }, [el('span', { class: 'row-name', text: m.label }), el('span', { class: 'row-value', text: 'ask' })])
              : el('div', { class: 'row' }, [el('span', { class: 'row-name row-sub', text: m.label })]),
        ),
      ])
    : null
  return [
    markSeen(
      el('div', { class: 'row' }, [
        el('span', { class: 'row-name', text: resume.line }),
        verdictActs('notice', resume.key, { words: { useful: statusWord('useful'), wrong: statusWord('wrong'), 'not-now': statusWord('not-now') } }),
      ]),
      resume.key,
      'where-was-i',
    ),
    restore,
  ].filter(Boolean)
}

/** What the line leaves out, then its restore links. Pure. */
export function resumeDetails(resume, use = null) {
  const p = resume?.pieces ?? {}
  const facts = []
  if (p.intent && p.leftFromAgent && p.agent) facts.push(`Before it: ${p.intent.text}`)
  if (p.agent?.lastPrompt) facts.push(`You last asked it: “${p.agent.lastPrompt}”`)
  if (p.badges?.length) facts.push(`While you were away: ${p.badges.map((b) => `${b.app} ${b.count}`).join(', ')}`)
  if (p.unpushed) facts.push(`${p.unpushed.ahead} commit${p.unpushed.ahead === 1 ? '' : 's'} not pushed${p.unpushed.branch ? ` on ${p.unpushed.branch}` : ''}`)
  if (p.failure) facts.push(`\`${p.failure.command}\` exited ${p.failure.exitCode} in ${p.failure.cwd}`)
  // Back after days: what the owner was doing there before, newest first (U2-F38).
  for (const d of resume?.digest ?? []) facts.push(`${new Date(d.at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} — ${d.what}`)
  // The code touched before the break, oldest first (U2-F40).
  for (const t of resume?.trail ?? []) facts.push(`${new Date(t.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} ${t.file}${t.symbols.length ? ` · ${t.symbols.slice(0, 3).join(', ')}` : ''}`)
  // What got used so far, each count with its sample (a verdict carries its n).
  const used = Object.entries(use?.pieces ?? {}).filter(([k]) => (resume?.links ?? []).some((l) => l.piece === k)).map(([k, v]) => `${k} ${v.opened} of ${v.shown}`)
  if (used.length) facts.push(`Opened so far: ${used.join(' · ')}; back on the project within 10 min after ${use.followed} of ${use.lines} lines`)
  return [...facts.map((label) => ({ label })), ...(resume?.links ?? [])]
}

/**
 * A work job's kind, in words. The workbench names its jobs by slug, and the
 * slug reached the page: "I left … on your shelf (meeting-brief · …)" and a
 * shelf item's first line. Words at the read boundary, for old rows as well
 * as new ones. Pure.
 */
export const JOB_WORDS = { 'topic-brief': 'brief', 'handoff-note': 'handoff note', 'meeting-brief': 'meeting brief', 'owner-request': 'your request', 'rule-idea': 'rule idea' }

export const jobWords = (text) => String(text ?? '').replace(/\b(topic-brief|handoff-note|meeting-brief|owner-request|rule-idea)\b(?= ·)/g, (slug) => JOB_WORDS[slug])

/**
 * What Gnomon said in passing today, newest first — the quiet lane made
 * visible. A tonic notice used to reach only the companion's context, so the
 * owner heard it only by chatting (UC2 finding 3). Interruptions and
 * questions already reach the owner on their own; this is the rest. Pure.
 */
export function heardInPassing(unsaid, limit = 3) {
  // A return line is drawn by the moment block, with its restore links.
  return (unsaid?.said ?? []).filter((r) => r.channel === 'tonic' && r.kind !== 'owner-question' && r.kind !== 'return-from-break' && r.observation).slice(-limit).reverse()
}

/** Today's "In passing": up to three lines, each with its verdict; re-read each minute while shown, gone when empty. */
export function heardBlock(initial) {
  const box = el('section', { class: 'brief-moment' })
  const draw = (unsaid) => {
    const rows = heardInPassing(unsaid)
    box.hidden = rows.length === 0
    box.replaceChildren(
      el('h3', { class: 'col-title', text: 'In passing' }),
      ...rows.map((r) =>
        markSeen(
          el('div', { class: 'row' }, [
            el('span', { class: 'row-name', text: jobWords(r.observation), title: (r.evidence ?? []).join(' · ') || null }),
            r.verdict ? el('span', { class: 'verdict-done', text: statusWord(r.verdict) }) : verdictActs('notice', r.noticeKey, { words: { useful: statusWord('useful'), wrong: statusWord('wrong'), 'not-now': statusWord('not-now') } }),
          ]),
          r.noticeKey,
          'in-passing',
        ),
      ),
    )
  }
  draw(initial)
  const timer = setInterval(() => (box.isConnected ? json('/gnomon/unsaid').then(draw, () => {}) : clearInterval(timer)), 60_000)
  return box
}

/**
 * Lane B: what to say at the next meeting — the standup draft or a meeting's
 * prep, until that meeting ends — and, from Friday afternoon, the week. Pure.
 */
export function briefParts(brief) {
  const parts = []
  const b = brief?.before
  if (b?.lines?.length) {
    const at = new Date(b.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    parts.push({ title: `${b.kind === 'standup-draft' ? 'For' : 'Before'} ${b.title}, ${at}`, lines: b.lines, key: b.key ?? null })
  }
  if (brief?.week?.lines?.length) parts.push({ title: 'The week', lines: brief.week.lines, key: null })
  return parts
}

/** Today's brief block: each part a heading and its lines; re-read each minute while shown, gone when empty. */
export function briefBlock(initial) {
  const box = el('section', { class: 'brief-moment' })
  const draw = (brief) => {
    const parts = briefParts(brief)
    box.hidden = parts.length === 0
    // A brief raised as a notice takes the owner's verdict under its key, like
    // every other line Gnomon says, and reports that it was seen.
    box.replaceChildren(
      ...parts.flatMap((p) => [
        p.key
          ? markSeen(el('div', { class: 'col-head' }, [el('h3', { class: 'col-title', text: p.title }), verdictActs('notice', p.key, { words: { useful: statusWord('useful'), wrong: statusWord('wrong'), 'not-now': statusWord('not-now') } })]), p.key, 'brief')
          : el('h3', { class: 'col-title', text: p.title }),
        ...p.lines.map((line) => el('div', { class: 'row' }, [el('span', { class: 'row-name', text: line })])),
      ]),
    )
  }
  draw(initial)
  const timer = setInterval(() => (box.isConnected ? json('/gnomon/brief').then(draw, () => {}) : clearInterval(timer)), 60_000)
  return box
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
