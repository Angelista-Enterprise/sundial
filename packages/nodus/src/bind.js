// Compose: tool rows into the parts of a spec, with no model in between.
//
// The storyboard may only point at what is here, so every part a sentence can
// name is a row the record holds. One binder per dataset; the day comes first.

import { MAX_SCENE_LANES } from './spec.js'

const HOUR = 3_600_000
const MAX_PROJECT_LANES = 6

const at = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString()
const floorHour = (iso) => new Date(Math.floor(Date.parse(iso) / HOUR) * HOUR).toISOString()
const ceilHour = (iso) => new Date(Math.ceil(Date.parse(iso) / HOUR) * HOUR).toISOString()

/**
 * A day from `gnomon_today_summary`: a lane per project (the busiest first),
 * one for time outside a project, one for meetings, one for time away; every
 * session a bar that opens its moment, every meeting a band, every break a gap.
 *
 * Returns the spec without steps: the storyboard adds them.
 */
export function bindDay(day) {
  const first = day?.coverage?.firstActivity
  const last = day?.coverage?.lastActivity
  if (!first || !last) return null
  const window = { from: floorHour(first), to: ceilHour(last) }

  const projects = (day.projects ?? []).filter((p) => p.minutes > 0).sort((a, b) => b.minutes - a.minutes)
  const shown = projects.slice(0, MAX_PROJECT_LANES)
  const laneOf = new Map(shown.map((p) => [p.name, `p:${p.name}`]))
  const lanes = []
  const meetings = day.meetings ?? []
  if (meetings.length > 0) {
    const min = meetings.reduce((n, m) => n + Math.max(0, Date.parse(m.end) - Date.parse(m.start)) / 60_000, 0)
    lanes.push({ id: 'meetings', label: 'Meetings', role: 'meeting', value: Math.round(min), unit: 'min' })
  }
  for (const p of shown) lanes.push({ id: laneOf.get(p.name), label: p.name, role: 'project', value: p.minutes, unit: 'min' })
  lanes.push({ id: 'elsewhere', label: shown.length < projects.length ? 'Other work' : 'No project', role: 'project', value: day.noProjectMin ?? undefined, unit: 'min' })
  if ((day.breaks ?? []).length > 0) lanes.push({ id: 'away', label: 'Away', role: 'break' })

  const parts = []
  for (const s of day.sessions ?? []) {
    if (!s.start || !(s.min > 0)) continue
    parts.push({
      id: `s:${s.id}`,
      role: 'session',
      lane: laneOf.get(s.project) ?? 'elsewhere',
      from: s.start,
      to: at(s.start, s.min),
      label: s.process ?? 'session',
      // The intent is an earlier model's narration, so it is a note, not a label, and inferred.
      ...(s.intent ? { note: s.intent } : {}),
      mark: 'observed',
      ...(s.id ? { door: `moment:${s.id}` } : {}),
    })
  }
  meetings.forEach((m, i) => parts.push({ id: `m:${i}`, role: 'meeting', lane: 'meetings', from: m.start, to: m.end, label: m.title ?? 'Meeting', mark: 'observed' }))
  ;(day.breaks ?? []).forEach((b, i) => parts.push({ id: `b:${i}`, role: 'break', lane: 'away', from: b.start, to: b.end, label: `${b.durationMin} min away`, mark: 'observed' }))

  // Lanes nobody stands in are noise on the card.
  const used = new Set(parts.map((p) => p.lane))
  return {
    v: 1,
    form: 'timeline',
    title: dayTitle(day.date, day.timeZone),
    tz: day.timeZone ?? 'UTC',
    window,
    view: 'day',
    source: { view: 'day', args: { date: day.date } },
    lanes: lanes.filter((l) => used.has(l.id)),
    parts,
    links: [],
    steps: [],
    facts: {
      trackedMin: day.coverage.trackedMin ?? null,
      focus: day.focus ?? null,
      sessionCount: day.sessionCount ?? null,
      shownSessions: (day.sessions ?? []).length,
    },
  }
}

function dayTitle(date, tz, short = false) {
  if (!date) return 'The day'
  const d = new Date(`${date}T12:00:00Z`)
  return d.toLocaleDateString('en-GB', short ? { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' } : { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
}

// ── The other shapes of the record ─────────────────────────────────────────
// One binder per dataset, each a pure function of tool rows. Every row a
// sentence may name is a lane here, with the label the card prints.

const MAX_ROWS = 12
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'x'
const meetingMin = (day) => Math.round((day?.meetings ?? []).reduce((n, m) => n + Math.max(0, Date.parse(m.end) - Date.parse(m.start)) / 60_000, 0))
const awayMin = (day) => (day?.breaks ?? []).reduce((n, b) => n + (b.durationMin ?? 0), 0)
const base = (form, view, title, tz, args, rest) => ({ v: 1, form, view, title, tz: tz ?? 'UTC', window: {}, source: { view, args }, lanes: [], parts: [], links: [], steps: [], ...rest })

/** Minutes by where they went in one day: each project, outside any project, meetings, away. */
function dayRows(day) {
  const rows = (day?.projects ?? []).filter((p) => p.minutes > 0).map((p) => ({ id: `p:${p.name}`, label: p.name, role: 'project', value: p.minutes, door: `entity:${p.name}` }))
  if (day?.noProjectMin > 0) rows.push({ id: 'elsewhere', label: 'No project', role: 'project', value: day.noProjectMin })
  if (meetingMin(day) > 0) rows.push({ id: 'meetings', label: 'Meetings', role: 'meeting', value: meetingMin(day) })
  if (awayMin(day) > 0) rows.push({ id: 'away', label: 'Away', role: 'break', value: awayMin(day) })
  return rows
}

/** Where a day's time went, the most first. */
export function bindWhere(day) {
  if (!day?.date) return null
  const lanes = dayRows(day).sort((a, b) => b.value - a.value).slice(0, MAX_ROWS).map((l) => ({ ...l, unit: 'min' }))
  return base('bars', 'where', `Where the time went, ${dayTitle(day.date, day.timeZone)}`, day.timeZone, { date: day.date }, { lanes, facts: { trackedMin: day.coverage?.trackedMin ?? null } })
}

/** A day beside another: `value` is the day asked about, `then` the one it is held against. */
export function bindCompare(day, other) {
  if (!day?.date || !other?.date) return null
  const now = new Map(dayRows(day).map((r) => [r.id, r]))
  const then = new Map(dayRows(other).map((r) => [r.id, r]))
  const lanes = [...new Set([...now.keys(), ...then.keys()])]
    .map((id) => ({ ...(now.get(id) ?? then.get(id)), value: now.get(id)?.value ?? 0, then: then.get(id)?.value ?? 0, unit: 'min' }))
    .sort((a, b) => Math.max(b.value, b.then) - Math.max(a.value, a.then))
    .slice(0, MAX_ROWS)
  const a = dayTitle(day.date, day.timeZone)
  const b = dayTitle(other.date, day.timeZone)
  return base('bars', 'compare', `${a} beside ${b}`, day.timeZone, { date: day.date, other: other.date }, { lanes, facts: { now: a, then: b, trackedMin: day.coverage?.trackedMin ?? null, thenTrackedMin: other.coverage?.trackedMin ?? null } })
}

/** Seven days, oldest first, each with its tracked time and the project that led it. */
export function bindWeek(days) {
  const held = (days ?? []).filter((d) => d?.date)
  if (held.length === 0) return null
  const tz = held[0].timeZone
  const lanes = held.map((d) => {
    const lead = [...(d.projects ?? [])].sort((a, b) => b.minutes - a.minutes)[0]
    return { id: `d:${d.date}`, label: dayTitle(d.date, tz, true), role: 'day', value: d.coverage?.trackedMin ?? 0, unit: 'min', door: `day:${d.date}`, ...(lead?.minutes > 0 ? { note: `${lead.name}, ${lead.minutes} min` } : {}) }
  })
  const last = held.at(-1)
  return base('bars', 'week', `The week to ${dayTitle(last.date, tz)}`, tz, { date: last.date }, { lanes, facts: { trackedMin: lanes.reduce((n, l) => n + l.value, 0) } })
}

/** What Gnomon's own thinking cost, by purpose, the most first (list price, an estimate); the long tail folded into one row. */
export function bindLedger(ledger) {
  const usd = (r) => Math.round((r.costUsd ?? 0) * 100) / 100
  const rows = [...(ledger?.rows ?? [])].filter((r) => r.calls > 0).sort((a, b) => usd(b) - usd(a) || b.calls - a.calls)
  if (rows.length === 0) return null
  const shown = rows.slice(0, MAX_ROWS - 1)
  const rest = rows.slice(MAX_ROWS - 1)
  const lanes = shown.map((r) => ({ id: `u:${r.key}`, label: r.key, role: 'purpose', value: usd(r), unit: 'USD', note: `${r.calls} calls${r.failed ? `, ${r.failed} failed` : ''}` }))
  if (rest.length) lanes.push({ id: 'u:rest', label: 'Everything else', role: 'purpose', value: Math.round(rest.reduce((n, r) => n + usd(r), 0) * 100) / 100, unit: 'USD', note: `${rest.reduce((n, r) => n + r.calls, 0)} calls` })
  return base('bars', 'ledger', `What the thinking cost, ${ledger.from} to ${ledger.to}`, 'UTC', { days: ledger.days ?? 7 }, { lanes, facts: { calls: rows.reduce((n, r) => n + r.calls, 0), costUsd: Math.round(rows.reduce((n, r) => n + (r.costUsd ?? 0), 0) * 100) / 100, price: 'list price, an estimate' } })
}

/** Open threads of work as a graph: the project each sits in, and whoever a promise ties to it. */
export function bindThreads(open) {
  const threads = (open?.commitments ?? []).slice(0, MAX_ROWS * 2)
  if (threads.length === 0) return null
  const lanes = []
  const links = []
  const seen = new Set()
  const node = (l) => (seen.has(l.id) ? null : (seen.add(l.id), lanes.push(l)))
  for (const t of threads) {
    const id = `c:${slug(t.name)}`
    node({ id, label: t.name, role: 'commitment', value: t.activeDays ?? 0, unit: 'days', note: `last touched ${String(t.lastTouchedAt ?? '').slice(0, 10)}`, door: `search:${t.name}` })
    if (t.projectName) {
      node({ id: `p:${t.projectName}`, label: t.projectName, role: 'project', door: `entity:${t.projectName}` })
      links.push({ from: `p:${t.projectName}`, to: id })
    }
    const who = t.promise?.counterparty ?? null
    if (typeof who === 'string' && who !== '') {
      node({ id: `w:${slug(who)}`, label: who, role: 'person', door: `entity:${who}` })
      links.push({ from: id, to: `w:${slug(who)}` })
    }
  }
  return base('graph', 'threads', 'What you are in the middle of', 'UTC', {}, { lanes, links, facts: { open: open.total ?? threads.length } })
}

/** The owner's goals that are still alive, the longest unmoved first (undated last), as rows to read. */
export function bindGoals(answer) {
  // The registry answers a list ({ goal, status: 'open, why', since }); the MCP app a richer { goals: [{ state, quietDays }] }.
  const all = (Array.isArray(answer) ? answer : answer?.goals ?? []).map((g) => ({ ...g, state: g.state ?? String(g.status ?? 'open').split(/[\s,.\u2014-]/)[0].toLowerCase(), since: String(g.movedAt ?? g.since ?? '').slice(0, 10) }))
  const live = all.filter((g) => g.goal && g.state !== 'done' && g.state !== 'dropped').sort((a, b) => (a.since || '9').localeCompare(b.since || '9'))
  if (live.length === 0) return null
  const target = (g) => g.targetDate ?? (g.otherFacts ?? []).map((f) => String(f).match(/^targetDate (\S+)/)?.[1]).find(Boolean) ?? ''
  const lanes = live.slice(0, MAX_ROWS).map((g) => ({ id: `g:${slug(g.goal)}`, label: g.goal, role: 'goal', door: `entity:${g.goal}`, cells: [g.state, g.since, target(g)], ...(g.quietDays != null ? { value: g.quietDays, unit: 'days quiet' } : {}) }))
  return base('table', 'goals', 'Your goals, where each stands', 'UTC', {}, { lanes, columns: ['Goal', 'State', 'Since', 'Target'], facts: { live: live.length, done: all.filter((g) => g.state === 'done').length } })
}

const REVIEW = { pending: 'awaiting review', commented: 'commented', changes_requested: 'changes asked', approved: 'approved' }
const CHECKS = { pending: 'checks running', success: 'checks green', failure: 'checks red', cancelled: 'checks cancelled' }
const ago = (iso, now) => {
  const h = Math.max(0, (now - Date.parse(iso)) / HOUR)
  return !Number.isFinite(h) ? '' : h < 1 ? `${Math.round(h * 60)} min ago` : h < 36 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`
}

/** The owner's pull requests as rows to read: branch into base, how long open, the size of the change, and where review and checks stand. */
export function bindPrs(answer, now = Date.now()) {
  const prs = (answer?.prs ?? []).filter((p) => Number.isInteger(p.number))
  if (prs.length === 0) return null
  const open = prs.filter((p) => p.state === 'OPEN' || p.state === 'DRAFT').length
  const lanes = prs.slice(0, MAX_ROWS).map((p) => {
    const size = (p.additions ?? 0) + (p.deletions ?? 0)
    const state = p.state === 'OPEN' ? [REVIEW[p.review], CHECKS[p.checks]].filter(Boolean).join(', ') || 'open' : p.state === 'UNCONFIRMED' ? `open ${ago(p.lastSeen, now)}, not seen since` : p.state.toLowerCase()
    return {
      id: `pr:${slug(p.repo ?? '')}-${p.number}`,
      label: `${String(p.repo ?? '').split('/').pop()} #${p.number} ${p.title}`,
      role: 'commitment',
      door: `search:${p.title || `#${p.number}`}`,
      ...(p.additions != null ? { value: size, unit: 'lines' } : {}),
      note: `opened ${String(p.openedAt).slice(0, 16).replace('T', ' ')} UTC, last seen ${ago(p.lastSeen, now)}`,
      cells: [p.branch ? `${p.branch}${p.base ? ` → ${p.base}` : ''}` : '', ago(p.openedAt, now), p.additions != null ? `+${p.additions} −${p.deletions ?? 0}, ${p.files ?? 0} files` : '', state],
    }
  })
  return base('table', 'prs', `${open} open pull request${open === 1 ? '' : 's'}`, 'UTC', {}, { lanes, columns: ['Pull request', 'Branch', 'Opened', 'Change', 'Where it stands'], facts: { open, closed: prs.length - open } })
}

/** The people the record knows best, as rows to read. Unnamed attendees stay unnamed. */
export function bindPeople(roster) {
  const people = (Array.isArray(roster) ? roster : roster?.people ?? []).filter((p) => p.named && p.name).sort((a, b) => b.factCount + b.metWith - (a.factCount + a.metWith))
  if (people.length === 0) return null
  const lanes = people.slice(0, MAX_ROWS).map((p) => ({ id: `w:${slug(p.id ?? p.name)}`, label: p.name, role: 'person', value: p.factCount ?? 0, unit: 'facts', door: `entity:${p.name}`, cells: [String(p.metWith ?? 0), String(p.factCount ?? 0)] }))
  return base('table', 'people', 'Who the record knows', 'UTC', {}, { lanes, columns: ['Person', 'Met', 'Facts'], facts: { people: people.length, unnamed: (Array.isArray(roster) ? roster : []).filter((p) => !p.named).length } })
}

// ── The same shapes as scenes (`args.as === 'scene'`) ──────────────────────
// Time as water and attention as gravity: a day pours its minutes into the
// projects that took them; what you are in the middle of circles you. Same
// rows, same doors, so the live lens re-reads a scene like any figure.

const MAX_TANKS = 9
/** Minutes as the panels say them: hours past two, else minutes. */
const asTime = (min) => (min >= 120 ? { value: Math.round(min / 6) / 10, unit: 'h' } : { value: min, unit: 'min' })
const SCENE = { as: 'scene' }
const TANK = { elsewhere: 'reservoir', away: 'sink' }

/** Where a day's time went as a fluid: the day a source, each place a tank, a pipe as wide as its minutes. */
export function bindWhereScene(day) {
  if (!day?.date) return null
  const rows = dayRows(day).sort((a, b) => b.value - a.value).slice(0, MAX_TANKS)
  if (rows.length === 0) return null
  const source = { id: `d:${day.date}`, label: dayTitle(day.date, day.timeZone, true), role: 'day', kind: 'source', value: rows.reduce((n, r) => n + r.value, 0), unit: 'min', door: `day:${day.date}` }
  const lanes = [source, ...rows.map((r) => ({ ...r, kind: TANK[r.id] ?? 'tank', unit: 'min' }))]
  const links = rows.map((r) => ({ from: source.id, to: r.id, kind: 'flow', rate: r.value }))
  const tracked = day.coverage?.trackedMin ?? source.value
  const top = rows.find((r) => r.id !== 'away')
  const panels = [
    { label: 'Tracked', kind: 'number', ...asTime(tracked) },
    ...(top ? [{ label: 'Most went to', kind: 'status', word: top.label, note: `${asTime(top.value).value} ${asTime(top.value).unit}` }] : []),
    { label: 'Places', kind: 'number', value: rows.length },
    ...(rows.length > 2 ? [{ label: 'Minutes by place', kind: 'spark', series: rows.map((r) => r.value), note: 'most to least' }] : []),
  ]
  return base('scene', 'where', `Where the time went, ${dayTitle(day.date, day.timeZone)}`, day.timeZone, { date: day.date, ...SCENE }, { archetype: 'fluid', lanes, links, panels, facts: { trackedMin: day.coverage?.trackedMin ?? null } })
}

/** The week as a fluid: each day a source, the projects that took it tanks, the rest one tank. Time away is not poured. */
export function bindWeekScene(days) {
  const held = (days ?? []).filter((d) => d?.date)
  if (held.length === 0) return null
  const tz = held[0].timeZone
  const flows = held.flatMap((d) => dayRows(d).filter((r) => r.id !== 'away').map((r) => ({ day: d.date, ...r })))
  const total = new Map()
  for (const f of flows) total.set(f.id, (total.get(f.id) ?? 0) + f.value)
  const top = new Set([...total].sort((a, b) => b[1] - a[1]).slice(0, MAX_TANKS - 1).map(([id]) => id))
  const into = (f) => (top.has(f.id) ? f.id : 'rest')
  const tanks = new Map()
  for (const f of flows) {
    const id = into(f)
    const t = tanks.get(id) ?? (id === 'rest' ? { id, label: 'Other work', role: 'project', value: 0 } : { id, label: f.label, role: f.role, value: 0, ...(f.door ? { door: f.door } : {}) })
    t.value += f.value
    tanks.set(id, t)
  }
  const pipes = new Map()
  for (const f of flows) {
    const key = `d:${f.day}>${into(f)}`
    pipes.set(key, { from: `d:${f.day}`, to: into(f), kind: 'flow', rate: (pipes.get(key)?.rate ?? 0) + f.value })
  }
  // The widest pipes when there are more than a scene holds, in the days' order.
  const kept = new Set([...pipes.values()].sort((a, b) => b.rate - a.rate).slice(0, 48))
  const sources = held.map((d) => ({ id: `d:${d.date}`, label: dayTitle(d.date, tz, true), role: 'day', kind: 'source', value: d.coverage?.trackedMin ?? 0, unit: 'min', door: `day:${d.date}` }))
  const lanes = [...sources, ...[...tanks.values()].sort((a, b) => b.value - a.value).map((t) => ({ ...t, kind: TANK[t.id] ?? (t.id === 'rest' ? 'reservoir' : 'tank'), unit: 'min' }))]
  const last = held.at(-1)
  const busiest = sources.reduce((a, b) => (b.value > a.value ? b : a), sources[0])
  const tracked = sources.reduce((n, l) => n + l.value, 0)
  const lead = [...tanks.values()].sort((a, b) => b.value - a.value)[0]
  const panels = [
    { label: 'Minutes per day', kind: 'spark', series: sources.map((l) => l.value), note: `${sources[0].label} to ${sources.at(-1).label}` },
    { label: 'Tracked this week', kind: 'number', ...asTime(tracked) },
    { label: 'Busiest day', kind: 'status', word: busiest.label, note: `${asTime(busiest.value).value} ${asTime(busiest.value).unit}` },
    ...(lead ? [{ label: 'Led the week', kind: 'status', word: lead.label, note: `${asTime(lead.value).value} ${asTime(lead.value).unit}` }] : []),
  ]
  return base('scene', 'week', `The week to ${dayTitle(last.date, tz)}`, tz, { date: last.date, ...SCENE }, { archetype: 'fluid', lanes, links: [...pipes.values()].filter((k) => kept.has(k)), panels, facts: { trackedMin: sources.reduce((n, l) => n + l.value, 0) } })
}

/** What you are in the middle of as an orbital: you at the center, projects round you, their threads their moons, a promise a tie to its person. */
export function bindThreadsScene(open) {
  const threads = [...(open?.commitments ?? [])].sort((a, b) => (b.activeDays ?? 0) - (a.activeDays ?? 0))
  if (threads.length === 0) return null
  const you = { id: 'you', label: 'You', role: 'marker', kind: 'center' }
  const bodies = new Map()
  const moons = []
  const people = new Map()
  const links = []
  const count = () => 1 + bodies.size + moons.length + people.size
  for (const t of threads) {
    const project = t.projectName ? `p:${t.projectName}` : null
    const who = typeof t.promise?.counterparty === 'string' && t.promise.counterparty !== '' ? t.promise.counterparty : null
    if (count() + 1 + (project && !bodies.has(project)) + (who && !people.has(`w:${slug(who)}`)) > MAX_SCENE_LANES) continue
    const id = `c:${slug(t.name)}`
    if (moons.some((m) => m.id === id) || bodies.has(id)) continue
    const mass = Math.max(1, t.activeDays ?? 0)
    const thread = { id, label: t.name, role: 'commitment', value: mass, unit: 'days', note: `last touched ${String(t.lastTouchedAt ?? '').slice(0, 10)}`, door: `search:${t.name}` }
    if (project) {
      const p = bodies.get(project) ?? { id: project, label: t.projectName, role: 'project', kind: 'body', value: 0, unit: 'days', door: `entity:${t.projectName}` }
      p.value += mass
      bodies.set(project, p)
      moons.push({ ...thread, kind: 'moon' })
      links.push({ from: id, to: project, kind: 'orbit' })
    } else {
      bodies.set(id, { ...thread, kind: 'body' })
      links.push({ from: id, to: 'you', kind: 'orbit' })
    }
    if (who) {
      const w = `w:${slug(who)}`
      if (!people.has(w)) {
        people.set(w, { id: w, label: who, role: 'person', kind: 'body', value: 1, unit: 'promises', door: `entity:${who}` })
        links.push({ from: w, to: 'you', kind: 'orbit' })
      } else people.get(w).value += 1
      links.push({ from: id, to: w, kind: 'tie' })
    }
  }
  for (const b of bodies.values()) if (b.role === 'project') links.push({ from: b.id, to: 'you', kind: 'orbit' })
  // Ring order is blueprint order: the heaviest nearest you.
  const ring = [...bodies.values(), ...people.values()].sort((a, b) => b.value - a.value)
  const promises = links.filter((k) => k.kind === 'tie').length
  const heaviest = ring.find((b) => b.role === 'project') ?? ring[0]
  const panels = [
    { label: 'Open threads', kind: 'number', value: open.total ?? threads.length },
    { label: 'Open promises', kind: 'number', value: promises, note: promises ? `to ${people.size} ${people.size === 1 ? 'person' : 'people'}` : 'none owed' },
    ...(heaviest ? [{ label: 'Pulls hardest', kind: 'status', word: heaviest.label, note: `${heaviest.value} active days` }] : []),
    ...(threads.length > 2 ? [{ label: 'Active days per thread', kind: 'spark', series: threads.slice(0, 24).map((t) => t.activeDays ?? 0), note: 'most to least' }] : []),
  ]
  return base('scene', 'threads', 'What you are in the middle of', 'UTC', SCENE, { archetype: 'orbital', lanes: [you, ...ring, ...moons], links, panels, facts: { open: open.total ?? threads.length } })
}

/** Who you work with as an orbital: you at the center, each named person a body as heavy as the meetings you shared. */
export function bindPeopleScene(roster) {
  const people = (Array.isArray(roster) ? roster : roster?.people ?? []).filter((p) => p.named && p.name).sort((a, b) => (b.metWith ?? 0) - (a.metWith ?? 0) || (b.factCount ?? 0) - (a.factCount ?? 0)).slice(0, 10)
  if (people.length === 0) return null
  const lanes = [{ id: 'you', label: 'You', role: 'marker', kind: 'center' }, ...people.map((p) => ({ id: `w:${slug(p.id ?? p.name)}`, label: p.name, role: 'person', kind: 'body', value: p.metWith ?? 0, unit: 'meetings', note: `${p.factCount ?? 0} facts`, door: `entity:${p.name}` }))]
  const met = people.reduce((n, p) => n + (p.metWith ?? 0), 0)
  const panels = [
    { label: 'People', kind: 'number', value: people.length },
    { label: 'Meetings shared', kind: 'number', value: met },
    { label: 'Closest', kind: 'status', word: people[0].name, note: `${people[0].metWith ?? 0} meetings` },
    ...(people.length > 2 ? [{ label: 'Meetings per person', kind: 'spark', series: people.map((p) => p.metWith ?? 0), note: 'closest to furthest' }] : []),
  ]
  return base('scene', 'people', 'Who you work with', 'UTC', SCENE, { archetype: 'orbital', lanes, links: lanes.slice(1).map((l) => ({ from: l.id, to: 'you', kind: 'orbit' })), panels, facts: { people: people.length } })
}

// ── The day round the clock, and the home ───────────────────────────────────

/** An instant as hours past the owner's midnight (9.5 is half past nine), in their own zone. */
const hourOf = (iso, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  return Number(p.hour) + Number(p.minute) / 60
}
const clockOf = (hm) => {
  const [h, m] = hm.split(':').map(Number)
  return h + m / 60
}
/** A calendar line of `gnomon_timeline`: "Title 10:00–11:00, 4 invited". */
const CALENDAR = /^(.*) (\d{1,2}:\d{2})[–-](\d{1,2}:\d{2})(?:, \d+ invited)?$/
const round2 = (v) => Math.round(v * 100) / 100

/**
 * One day's meetings on a 24 hour dial (the `clock` idiom), from
 * `gnomon_today_summary` (the meetings the record saw, and the span it was
 * on) and `gnomon_timeline` (the calendar's own, upcoming ones too). Each
 * meeting is a door to the moment it was held in when there is one, else a
 * search for it. `now` (ms) puts the hand on the dial when it falls on that
 * day, and says which meeting is done, on, or next.
 */
export function bindSchedule(day, timeline, now = null) {
  if (!day?.date) return null
  const tz = day.timeZone ?? 'UTC'
  const rows = (timeline?.rows ?? timeline?.lines ?? []).filter((r) => r.kind === 'meeting')
  // A meeting held is a moment whose line says "in <title>": its door.
  const momentFor = (title) => rows.find((r) => !CALENDAR.test(r.text) && r.text.toLowerCase().includes(`in ${title.toLowerCase()}`))?.id ?? null
  const events = []
  const add = (title, start, end, id) => {
    if (!(end !== start) || events.some((e) => e.title.toLowerCase() === title.toLowerCase() && Math.abs(e.start - start) < 0.25)) return
    events.push({ title, start: round2(start), end: round2(end), id })
  }
  ;(day.meetings ?? []).forEach((m, i) => m.start && m.end && add(m.title ?? 'Meeting', hourOf(m.start, tz), hourOf(m.end, tz), `m:${i}`))
  for (const r of rows) {
    const c = CALENDAR.exec(r.text)
    // A calendar title can be a whole invitation's subject: the margin takes its first 40 letters.
    const title = c?.[1].trim()
    if (c) add(title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title, clockOf(c[2]), clockOf(c[3]), `c:${slug(r.id ?? c[1])}`)
  }
  events.sort((a, b) => a.start - b.start)
  const today = now != null && new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(now)) === day.date
  const at = today ? round2(hourOf(new Date(now).toISOString(), tz)) : null
  const stateOf = (e) => (at == null ? 'done' : e.end <= at && e.start < at ? 'done' : e.start <= at ? 'now' : 'next')
  const first = day.coverage?.firstActivity
  const last = day.coverage?.lastActivity
  // When each thing is, as the note under its name: a dial alone does not say a meeting's hours.
  const hm = (h) => `${String(Math.floor(h % 24)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`
  const lanes = [{ id: 'face', label: dayTitle(day.date, tz, true), kind: 'dial', shape: 'day', door: `day:${day.date}` }]
  // The span the record was on, under the meetings: the working day they sit in.
  if (first && last) lanes.push({ id: 'record', label: 'On the record', kind: 'event', start: round2(hourOf(first, tz)), end: round2(hourOf(last, tz)), note: `${hm(hourOf(first, tz))} to ${hm(hourOf(last, tz))}`, state: 'done', value: Math.round((day.coverage.trackedMin ?? 0) / 6) / 10, unit: 'h', door: `day:${day.date}` })
  for (const e of events.slice(0, MAX_SCENE_LANES - 3)) {
    const moment = momentFor(e.title)
    lanes.push({ id: e.id, label: e.title, role: 'meeting', kind: 'event', start: e.start, end: e.end, note: `${hm(e.start)} to ${hm(e.end)}`, state: stateOf(e), value: round2((e.end - e.start + 24) % 24), unit: 'h', door: moment ? `moment:${moment}` : `search:${e.title}` })
  }
  if (at != null) lanes.push({ id: 'now', label: 'Now', kind: 'hand', start: at })
  const meetings = lanes.filter((l) => l.role === 'meeting')
  const links = []
  for (let i = 0; i < meetings.length; i++) for (let j = i + 1; j < meetings.length; j++) if (meetings[j].start < meetings[i].end && meetings[i].start < meetings[j].end) links.push({ from: meetings[i].id, to: meetings[j].id, kind: 'clash' })
  const next = meetings.find((m) => m.state === 'next' || m.state === 'now')
  const minutes = Math.round(meetings.reduce((n, m) => n + m.value * 60, 0))
  const panels = [
    { label: 'Meetings', kind: 'number', value: meetings.length },
    { label: 'In meetings', kind: 'number', ...asTime(minutes) },
    ...(next ? [{ label: next.state === 'now' ? 'On now' : 'Next', kind: 'status', word: next.label, note: `${String(Math.floor(next.start)).padStart(2, '0')}:${String(Math.round((next.start % 1) * 60)).padStart(2, '0')}` }] : []),
  ]
  return base('scene', 'schedule', `${dayTitle(day.date, tz)} round the clock`, tz, { date: day.date }, { archetype: 'clock', lanes, links: links.slice(0, 48), panels, facts: { meetings: meetings.length, meetingMin: minutes, trackedMin: day.coverage?.trackedMin ?? null } })
}

/** What a Home Assistant entity is, as the plan's device states say it. */
const DEVICE_STATE = { on: 'on', off: 'off', open: 'open', closed: 'closed', unlocked: 'open', locked: 'closed', heat: 'on', cool: 'on', idle: 'off', playing: 'on', paused: 'off', unavailable: 'alert' }

/**
 * A home as a floor plan (the `plan` idiom), shaped for Home Assistant: its
 * areas as rooms, its entities as devices in their area, each with its state.
 * Nothing feeds it yet (Home Assistant is not connected: the `home` view says
 * so); `HOME` in the fixtures is the shape it will read. A room's size is its
 * `area` in square metres when the home says it, else grows with its devices.
 */
export function bindHome(home) {
  const areas = (home?.areas ?? []).filter((a) => a?.area_id && a.name).slice(0, 10)
  if (areas.length === 0) return null
  const known = new Set(areas.map((a) => a.area_id))
  const entities = (home.entities ?? []).filter((e) => e?.entity_id && known.has(e.area_id)).slice(0, MAX_SCENE_LANES - areas.length)
  const count = (id) => entities.filter((e) => e.area_id === id).length
  const lanes = [
    ...areas.map((a) => ({ id: `a:${slug(a.area_id)}`, label: a.name, role: 'room', kind: 'room', value: a.area ?? 6 + count(a.area_id) * 3, unit: 'm²' })),
    ...entities.map((e) => ({ id: `e:${slug(e.entity_id)}`, label: e.name ?? e.entity_id, role: 'device', kind: 'device', ...(DEVICE_STATE[e.state] ? { state: DEVICE_STATE[e.state] } : {}), note: e.entity_id })),
  ]
  const links = entities.map((e) => ({ from: `e:${slug(e.entity_id)}`, to: `a:${slug(e.area_id)}`, kind: 'in' }))
  const on = entities.filter((e) => DEVICE_STATE[e.state] === 'on' || DEVICE_STATE[e.state] === 'open').length
  const panels = [
    { label: 'Rooms', kind: 'number', value: areas.length },
    { label: 'Devices', kind: 'number', value: entities.length },
    { label: 'On or open', kind: 'number', value: on },
  ]
  return base('scene', 'home', 'Home, room by room', 'UTC', {}, { archetype: 'plan', lanes, links, panels, facts: { rooms: areas.length, devices: entities.length } })
}
