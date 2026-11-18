// Round 3: Routes Gnomon learned. What worked on screen, per app, each route with how often and when last, and a quiet
// Drop that waits a few seconds for an Undo before it writes `screen:route-dropped`.
import { el } from './surfaces.js'
import { keepCurrent } from './read.js'
import { json, stagger } from './view-kit.js'

/** How long a Drop can be taken back before it is written. */
export const UNDO_MS = 5000

const post = (body) => fetch('/gnomon/api/route-drop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.ok).catch(() => false)

/** "today", else "12 Nov". */
export const lastUsed = (iso, now = new Date()) => {
  const at = iso ? new Date(iso) : null
  if (!at || Number.isNaN(at.getTime())) return ''
  return at.toDateString() === now.toDateString() ? 'today' : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** One route: the goal, how often it worked, when last, and Drop. Drop greys the row and turns into Undo; after `UNDO_MS` it is written and `gone()` runs. */
export function routeRow(app, r, gone = () => {}) {
  let timer = 0
  const act = el('button', { type: 'button', class: 'act act-small', text: 'Drop', title: 'Gnomon never offers this route again' })
  const row = el('div', { class: 'row route' }, [
    el('span', { class: 'row-name route-goal', text: r.goal, title: r.goal }),
    el('span', { class: 'row-value route-n', text: `${r.n} ${r.n === 1 ? 'time' : 'times'}` }),
    el('span', { class: 'row-value route-when', text: lastUsed(r.at) }),
    el('span', { class: 'route-acts' }, [act]),
  ])
  act.onclick = () => {
    if (timer) {
      clearTimeout(timer)
      timer = 0
      row.classList.remove('route-dropping')
      return Object.assign(act, { textContent: 'Drop', title: 'Gnomon never offers this route again' })
    }
    row.classList.add('route-dropping')
    Object.assign(act, { textContent: 'Undo', title: 'Keep this route' })
    timer = setTimeout(async () => {
      act.disabled = true
      if (await post({ app, routeKey: r.key })) return gone(row)
      timer = 0
      act.disabled = false
      row.classList.remove('route-dropping')
      Object.assign(act, { textContent: 'Drop', title: 'That did not save. Press to try again.' })
    }, UNDO_MS)
  }
  return row
}

export function routesNode(d, redraw = () => {}) {
  const apps = Array.isArray(d?.apps) ? d.apps : []
  const count = apps.reduce((n, a) => n + a.routes.length, 0)
  // In a `.view`, which a pane pads, as the Engine room is.
  const card = (children) => el('div', { class: 'view' }, [el('section', { class: 'view-body routes' }, children)])
  if (apps.length === 0) return card([el('div', { class: 'none', text: 'Nothing learned yet. When Gnomon gets something done in an app, the steps that worked show here.' })])
  const lead = `${count} ${count === 1 ? 'route' : 'routes'} in ${apps.length} ${apps.length === 1 ? 'app' : 'apps'}, from the last ${d.days ?? 30} days. A dropped route is never offered again.`
  return card([
    el('p', { class: 'panel-lead', text: lead }),
    ...apps.map((a) =>
      el('div', { class: 'col' }, [
        el('div', { class: 'col-head' }, [el('h3', { class: 'col-title', text: a.app }), el('span', { class: 'col-hint', text: a.routes.length ? `${a.routes.length} ${a.routes.length === 1 ? 'route' : 'routes'}` : 'no route yet' })]),
        stagger(el('div', {}, a.routes.map((r) => routeRow(a.app, r, redraw)))),
        a.deadEnds.length ? el('p', { class: 'route-dead', text: `Did not work: ${a.deadEnds.map((x) => `${x.step} (${x.reason}${x.times > 1 ? `, ${x.times} times` : ''})`).join('; ')}` }) : null,
      ]),
    ),
  ])
}

export async function routesCard() {
  const build = async () => routesNode(await json('/gnomon/api/routes').catch(() => null), async () => node.replaceChildren(...(await build()).childNodes))
  const node = await build()
  return keepCurrent(node, build, ['/gnomon/api/routes'])
}
