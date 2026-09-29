// The Kanban: the one section anchor that is not the day. A pinned card that
// reads routes which already exist and holds no facts of its own — every row
// opens the card that owns it.
import { el } from './surfaces.js'
import { keepCurrent, read } from './read.js'
import { hm } from './views.js'

// The shared reader: these two cards ask for goals, habits, asks, unsaid and
// the proposals, and so do the instruments and Today. One request serves them
// all. See read.js.
const get = (url) => read(url).catch(() => null)
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—')

// ── Kanban ─────────────────────────────────────────────────────────────────

/** Open things across five columns, each item a door or a question. */
export async function kanbanCard(onAsk) {
  const build = () => kanbanNode(onAsk)
  return keepCurrent(await build(), build, ['/gnomon/goals', '/gnomon/habits', '/gnomon/attribution/proposals', '/gnomon/assistant/proposals', '/gnomon/asks', '/gnomon/shelf'])
}
async function kanbanNode(onAsk) {
  const [goals, habits, proposals, suggested, asks, shelf] = await Promise.all([
    get('/gnomon/goals'),
    get('/gnomon/habits'),
    get('/gnomon/attribution/proposals'),
    get('/gnomon/assistant/proposals'),
    get('/gnomon/asks'),
    get('/gnomon/shelf'),
  ])
  const open = Array.isArray(habits?.commitments?.open) ? habits.commitments.open : []
  const item = (title, sub, attrs = {}) =>
    el('button', { type: 'button', class: 'kb-item', ...attrs }, [el('span', { class: 'kb-title', text: title }), sub ? el('span', { class: 'kb-sub', text: sub }) : null])
  // Kanban holds no facts of its own: a row that waits on the owner opens the
  // card that owns it, where it can be answered.
  const toCard = (id) => ({ onclick: () => document.dispatchEvent(new CustomEvent('gnomon:card', { detail: id })), title: 'Open where this is answered' })
  const column = (label, items, hint) =>
    el('div', { class: 'kb-col' }, [
      el('div', { class: 'col-head' }, [el('h3', { class: 'col-title', text: label }), el('span', { class: 'col-hint', text: String(items.length) })]),
      items.length ? el('div', { class: 'kb-items' }, items) : el('div', { class: 'none', text: hint }),
    ])

  const explore = (goals?.goals ?? [])
    .filter((g) => g.state === 'open' || g.status === 'open')
    .map((g) => item(g.goal, `since ${day(g.since)} · ${g.saidBy === 'owner' ? 'you said' : 'noted'}`, toCard('play')))
  const doing = open
    .filter((c) => (c.quietDays ?? 0) <= 1)
    .sort((a, b) => String(b.lastTouchedAt).localeCompare(String(a.lastTouchedAt)))
    .map((c) => item(c.name, `${c.project ?? ''} · ${c.touches ?? 0} sessions`, toCard('play')))
  const quiet = open
    .filter((c) => (c.quietDays ?? 0) >= 2)
    .sort((a, b) => (a.quietDays ?? 0) - (b.quietDays ?? 0))
    .map((c) => item(c.name, `${c.project ?? ''} · ${c.quietDays}d quiet`, toCard('play')))
  const waiting = [
    ...(proposals?.proposals ?? []).map((p) => item(p.label ?? p.place ?? 'Untracked time', `${hm(p.minutes)} · where did this go?`, toCard('shelf'))),
    // A suggestion's words are its `summary`; the old code read `title`, which it never has, and printed "A proposal" three times.
    ...(suggested?.proposals ?? []).map((p) => item(p.summary ?? p.title ?? p.text ?? 'A suggestion', 'Gnomon suggests', toCard('shelf'))),
    ...(asks?.asks ?? []).filter((a) => !a.outcome).map((a) => item(a.question, a.reason ?? 'Gnomon asks', toCard('shelf'))),
  ]
  const shelved = (shelf?.items ?? []).slice(0, 8).map((s) => item(s.title, s.verdict ? `kept · ${s.verdict}` : 'waiting for your verdict', toCard('shelf')))

  return el('section', { class: 'kb' }, [
    column('Explore', explore, 'No open goals. Tell Gnomon one.'),
    column('Doing', doing, 'Nothing touched in the last day.'),
    column('Waiting', waiting, 'Nothing waits on you.'),
    column('Quiet', quiet, 'No thread has gone quiet.'),
    column('Shelved', shelved, 'Gnomon has left nothing yet.'),
  ])
}
