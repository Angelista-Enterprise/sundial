// Views: the record's shapes a figure can bind to, and how each is read.
//
// A view is a name, the tool rows it reads and the binder that turns them into
// a spec without steps. The same table runs in the plugin (the first draw) and
// in the browser (the live lens re-reading a card), with `read` the only
// difference: TOOL_REGISTRY in node, `/gnomon/api/read` in the page. Nothing
// here calls a model, so a re-read is free and the same rows draw the same.

import { bindCompare, bindDay, bindGoals, bindPrs, bindHome, bindLedger, bindPeople, bindPeopleScene, bindSchedule, bindThreads, bindThreadsScene, bindWeek, bindWeekScene, bindWhere, bindWhereScene } from './bind.js'

/** The day's sessions come in pages the tool's size budget cuts (two or three a page on a day of long intents). */
const MAX_PAGES = 24
const DAY_MS = 86_400_000
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

/** The whole day: the first page, with the sessions of the pages after it. */
export async function readDay(read, date) {
  const args = { ...(isDate(date) ? { date } : {}), limit: 200 }
  const day = await read('gnomon_today_summary', args)
  const sessions = [...(day?.sessions ?? [])]
  // An offset that does not move past the last one read is the same page again: stop.
  let prev = 0
  let next = day?.nextSessionOffset
  for (let page = 1; Number.isInteger(next) && next > prev && page < MAX_PAGES; page++) {
    const more = await read('gnomon_today_summary', { ...args, date: day.date, offset: next })
    sessions.push(...(more?.sessions ?? []))
    prev = next
    next = more?.nextSessionOffset
  }
  return day ? { ...day, sessions } : day
}

/**
 * A day's meetings from the flight recorder: the calendar's own rows (their
 * data carries `startDate`) and the moments held in one (`meetingTitle`), one
 * page each. Narrowed at the source: the whole day's timeline is a heavy read.
 */
async function readMeetings(read, date) {
  const args = { ...(isDate(date) ? { date } : {}), limit: 200 }
  const pages = await Promise.all(['startdate', 'meetingtitle'].map((contains) => read('gnomon_timeline', { ...args, contains }).catch(() => null)))
  return { rows: pages.flatMap((p) => p?.rows ?? []) }
}

/** A day's totals only: one page, no sessions, for the views that count rather than place. */
const dayTotals = (read, date) => read('gnomon_today_summary', { ...(isDate(date) ? { date } : {}), limit: 1 })

/** The binder for the shape asked: a view with a `scene` binder draws it when `args.as` is 'scene'. */
const as = (a, rows, scene) => (a.as === 'scene' && scene ? scene : rows)

/**
 * Every view. `about` is what the route gate reads to pick one, so it says
 * what the figure answers, not what it looks like. `tools` are the reads it
 * rests on: an answer that reads another view's tools gets that view instead. `scene` names the views
 * that can also be drawn as a scene (`args.as === 'scene'`), and how.
 */
export const VIEWS = {
  day: { form: 'timeline', tools: ['gnomon_today_summary'], about: 'one day in time: when each session, meeting and time away happened, hour by hour', read: async (read, a) => bindDay(await readDay(read, a.date)) },
  where: { form: 'bars', scene: 'fluid', tools: ['gnomon_today_summary'], about: 'where the time of one day went: minutes per project, meetings, away', read: async (read, a) => as(a, bindWhere, bindWhereScene)(await dayTotals(read, a.date)) },
  compare: {
    form: 'bars',
    tools: ['gnomon_today_summary'],
    about: 'one day beside another (yesterday by default): what grew, what shrank',
    read: async (read, a) => {
      const day = await dayTotals(read, a.date)
      if (!day?.date) return null
      return bindCompare(day, await dayTotals(read, isDate(a.other) ? a.other : shift(day.date, -1)))
    },
  },
  week: {
    form: 'bars',
    tools: ['gnomon_today_summary'],
    scene: 'fluid',
    about: 'the last seven days: tracked time per day and the project that led each',
    read: async (read, a) => {
      const last = await dayTotals(read, a.date)
      if (!last?.date) return null
      // The six days before are independent reads: in parallel.
      const before = await Promise.all([6, 5, 4, 3, 2, 1].map((n) => dayTotals(read, shift(last.date, -n)).catch(() => null)))
      return as(a, bindWeek, bindWeekScene)([...before, last])
    },
  },
  ledger: { form: 'bars', tools: ['gnomon_llm_ledger'], about: "Gnomon's own model calls and their cost, by purpose, over the last days", read: async (read, a) => bindLedger(await read('gnomon_llm_ledger', { days: Number.isInteger(a.days) ? a.days : 7, groupBy: 'purpose' })) },
  threads: { form: 'graph', scene: 'orbital', tools: ['gnomon_open_commitments'], about: 'open threads of work and promises: which project each sits in and who it is owed to', read: async (read, a) => as(a, bindThreads, bindThreadsScene)(await read('gnomon_open_commitments', { limit: 24 })) },
  prs: { form: 'table', tools: ['gnomon_pull_requests'], about: "the owner's pull requests: how many are open, each one's branch, when it was opened, how big the change is, and where review and checks stand", read: async (read, a) => bindPrs(await read('gnomon_pull_requests', { all: a.all === true }), Date.now()) },
  goals: { form: 'table', tools: ['gnomon_goals'], about: "the owner's goals that are still open and how long each has been quiet", read: async (read) => bindGoals(await read('gnomon_goals', {})) },
  // Only ever a scene: a day's meetings round a 24 hour dial (route is not here: the record holds no places).
  schedule: {
    form: 'scene',
    tools: ['gnomon_today_summary', 'gnomon_timeline'],
    about: "one day's meetings and appointments round the clock: what is on when, what clashes, what is next",
    read: async (read, a) => {
      const [day, timeline] = await Promise.all([dayTotals(read, a.date), readMeetings(read, a.date)])
      return bindSchedule(day, timeline, Date.now())
    },
  },
  // Shaped for Home Assistant's rooms and devices; nothing reads them yet, so it draws nothing and says why.
  home: { form: 'scene', about: "the owner's home: its rooms and the devices in them, on or off", unavailable: 'Home Assistant is not connected yet: there are no rooms or devices to draw.', read: async () => bindHome(null) },
  people: { form: 'table', scene: 'orbital', tools: ['gnomon_people'], about: 'the people the owner meets and how much the record holds about each', read: async (read, a) => as(a, bindPeople, bindPeopleScene)(await read('gnomon_people', {})) },
}

export const VIEW_NAMES = Object.keys(VIEWS)

/** The view a read tool is the source of: the first view that reads it. */
export const VIEW_OF_TOOL = Object.fromEntries(Object.entries(VIEWS).flatMap(([name, v]) => (v.tools ?? []).map((t) => [t, name])).reverse())

/** A view's skeleton from the record; null when the view is unknown or the record holds nothing for it. */
export async function readView(view, args, read) {
  const v = VIEWS[view]
  return v ? v.read(read, args ?? {}) : null
}
