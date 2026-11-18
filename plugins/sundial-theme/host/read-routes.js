// Round 3: the routes Gnomon learned on screen, per app, as screen_act is offered them (the rig's runs left out), each
// with how often it worked and when last, and the dead ends. The Routes card reads it; Drop appends `screen:route-dropped`.
import { countSignalsInRange, getSignalsInRange } from '@sundial/db/index.js'
import { TYPED, deadEndsOf, ownSteps, routesOf, stepsOf } from '@sundial/kernel/read/routes.js'

const QUERIES = { countSignalsInRange, getSignalsInRange }
const hid = (s) => /^\[(private|hidden)\]$/.test(String(s ?? ''))

/** A goal as the owner says it: what was typed is "…". */
export const goalWords = (goal) => (goal === null ? 'A task with no goal given' : hid(goal) ? 'A task, its words off the record' : goal.replaceAll(TYPED, '…'))

/** A step that did not work, in plain words: `press "Like"`. */
const stepWords = (s) => {
  const name = s.screenText?.[0] ?? ''
  return s.verb === 'key' ? `key ${s.key ?? ''}` : `${s.verb} ${name && !hid(name) ? `"${name}"` : (s.role ?? '')}`.trim()
}

/** Per app with anything learned, the app with the newest route first: `{ app, routes: [{ key, goal, n, at }], deadEnds: [{ step, reason, times }] }`. */
export async function readLearnedRoutes({ now, queries = QUERIES }) {
  const [from, to, types] = [new Date(now - 30 * 86_400_000).toISOString(), new Date(now + 5_000).toISOString(), ['screen:step']]
  // ponytail: the apps of the newest 2,000 steps; an app with no step among them has no route worth showing either.
  const total = await queries.countSignalsInRange(from, to, types)
  const recent = await queries.getSignalsInRange(from, to, 2000, types, Math.max(0, total - 2000))
  const apps = new Map()
  for (const row of recent.reverse()) {
    const app = String(row.data?.processName ?? '').trim()
    if (app && !app.startsWith('[') && !apps.has(app.toLowerCase())) apps.set(app.toLowerCase(), app)
  }
  const out = []
  for (const app of apps.values()) {
    const rows = ownSteps(await stepsOf(queries, app, now))
    const routes = routesOf(rows).map((r) => ({ key: r.key, goal: goalWords(r.goal), n: r.n, at: r.at ?? null }))
    const deadEnds = deadEndsOf(rows).map((s) => ({ step: stepWords(s), reason: String(s.reason ?? 'refused').replace(/-/g, ' '), times: s.times }))
    if (routes.length || deadEnds.length) out.push({ app, routes, deadEnds })
  }
  // The app with the newest route first (a rig run on an app does not lift it); an app with only dead ends last.
  return { days: 30, apps: out.sort((a, b) => String(b.routes[0]?.at ?? '').localeCompare(String(a.routes[0]?.at ?? ''))) }
}
