// Storyboard: what the card says, step by step, and what each step points at.
//
// A model writes it from a digest of the parts (never the raw rows), and may
// only point at part ids the digest lists. Without a model, or when its answer
// does not hold, `fallbackSteps` narrates from the numbers, so a card always
// has a walk and the walk is always true.

import { BLOCKS, PORTS } from './blocks.js'
import { ARCHETYPES, MAX_STEPS, SHAPES } from './spec.js'

const DIGEST_SESSIONS = 24
/** What a model is asked to write: fewer, shorter steps come back sooner. */
const MODEL_STEPS = 5

export const hm = (iso, tz) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || 'UTC' })
const minutes = (p) => Math.round((Date.parse(p.to) - Date.parse(p.from)) / 60_000)
const span = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`)

const fmtValue = (l) => (l.value == null ? '' : `${l.value}${l.unit ? ` ${l.unit}` : ''}`)

/**
 * What is on the owner's screen as the ask lands, from the fold (never raw
 * lines): so "this" can mean the error in the terminal, and "my time" the
 * project whose ticket is open. Empty when nothing is known.
 */
export function screenLine(screen) {
  if (!screen) return ''
  const said = [['project', screen.project], ['app', screen.app], ['window', screen.title], ['ticket', screen.ticket], ['PR', screen.pr], ['error', screen.error], ['file', screen.file]].filter(([, v]) => v)
  return said.length ? `On screen as they asked: ${said.map(([k, v]) => `${k} ${v}`).join('; ')}` : ''
}

/** The parts as a model reads them: ids it may point at, with times in the owner's zone. */
export function digest(spec, ask, screen = null) {
  if (spec.form !== 'timeline') return [rowsDigest(spec, ask), screenLine(screen)].filter(Boolean).join('\n')
  const tz = spec.tz
  const sessions = spec.parts.filter((p) => p.role === 'session').sort((a, b) => minutes(b) - minutes(a)).slice(0, DIGEST_SESSIONS)
  const rest = spec.parts.filter((p) => p.role !== 'session')
  const f = spec.facts ?? {}
  return [
    `Ask: ${ask || 'show me the day'}`,
    `Day: ${spec.title}, ${hm(spec.window.from, tz)} to ${hm(spec.window.to, tz)} (${tz})`,
    f.trackedMin != null ? `Tracked: ${f.trackedMin} min.${f.focus ? ` Focus: deep ${f.focus.deepMin}, steady ${f.focus.steadyMin}, shallow ${f.focus.shallowMin} min.` : ''}` : '',
    'Lanes (id: label, minutes):',
    ...spec.lanes.map((l) => `- ${l.id}: ${l.label}${l.kind ? ` [${l.kind}]` : ''}${l.value != null ? `, ${l.value} min` : ''}`),
    `Parts (id: lane, start to end, label${sessions.length < (f.sessionCount ?? 0) ? `; the ${sessions.length} longest sessions` : ''}):`,
    ...[...rest, ...sessions].map((p) => `- ${p.id}: ${p.lane}, ${hm(p.from, tz)} to ${hm(p.to, tz)}, ${minutes(p)} min, ${p.label}${p.note ? ` (earlier note: ${p.note.slice(0, 80)})` : ''}`),
    screenLine(screen),
  ].filter(Boolean).join('\n')
}

/** A figure that is not on time: its rows, and for a graph what links them. */
function rowsDigest(spec, ask) {
  const f = spec.facts ?? {}
  return [
    `Ask: ${ask || 'show me this'}`,
    `Figure: ${spec.title} (${spec.form === 'scene' ? `a ${spec.archetype} scene` : spec.form}${spec.form === 'bars' && spec.lanes.some((l) => l.then != null) ? `, each row ${f.now ?? 'now'} beside ${f.then ?? 'then'}` : ''})`,
    Object.keys(f).length ? `Facts: ${Object.entries(f).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(', ')}` : '',
    'Rows (id: label, value):',
    ...spec.lanes.map((l) => `- ${l.id}: ${l.label}${l.kind ? ` [${l.kind}]` : ''}${l.value != null ? `, ${fmtValue(l)}` : ''}${l.then != null ? ` (then ${l.then} ${l.unit ?? ''})` : ''}${l.cells ? `, ${l.cells.filter(Boolean).join(', ')}` : ''}${l.note ? ` (${l.note})` : ''}`),
    spec.links?.length ? 'Links (from -> to):' : '',
    ...(spec.links ?? []).map((k) => `- ${k.from} -> ${k.to}${k.kind ? ` (${k.kind}${k.rate != null ? ` ${k.rate}` : ''})` : ''}`),
  ].filter(Boolean).join('\n')
}

const STORYBOARD_SYSTEM = [
  'You are Gnomon, and right now an artist and a teacher: you show the owner their own record on a card and walk them through it.',
  'You are not an assistant and never call yourself one. Say "you" to the owner. Warm, exact, dry; never servile.',
  `Write a walk of 3 to ${MODEL_STEPS} steps over the card. Each step points at one to three ids from the digest (a lane or a part) and says ONE thing to notice in one sentence of at most 20 words.`,
  'Every sentence names what it points at with the same word the card shows (the lane or part label), and uses at most one number, only if it matters.',
  'Begin with the shape of the whole, then what is worth a look, in reading order. Never describe the picture ("this chart", "the lane", "two parts", "a bar", "the row"); talk about the record itself, by the names the card shows: projects, meetings, apps, days, people, threads.',
  'An earlier note is a guess from another model, never a fact: do not repeat it as one.',
  'When the ask says "this", "here" or "now" and the digest says what is on screen, start from the part of the record that matches it (its project, its ticket); never quote the screen beyond that.',
  'No em dashes, no lists, no markdown. Reply with JSON only: {"title": "a few words", "steps": [{"focus": ["id"], "say": "..."}]}',
].join(' ')

export function storyboardMessages(spec, ask, problems = null, previous = null, examples = [], screen = null) {
  // Walks the critic passed for like asks: their voice and their order, never their ids.
  const shown = examples.length ? `\n\nWalks that worked for like asks (their voice and order only; the ids above are the only ones you may use):\n${examples.map((e) => `- "${e.ask}": ${e.steps.join(' / ')}`).join('\n')}` : ''
  const messages = [
    { role: 'system', content: STORYBOARD_SYSTEM },
    { role: 'user', content: digest(spec, ask, screen) + shown },
  ]
  if (problems?.length && previous) {
    messages.push({ role: 'assistant', content: previous })
    messages.push({ role: 'user', content: `That walk does not hold: ${problems.join('; ')}. Fix exactly those and reply with the JSON again.` })
  }
  return messages
}

/** The JSON object in a model's reply, tolerating a fence or a sentence around it; null when there is none. */
export function parseReply(text) {
  const s = String(text ?? '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const out = JSON.parse(s.slice(a, b + 1))
    // Focus ids and a sentence, nothing else: whatever else a step carries is dropped here.
    return Array.isArray(out?.steps) ? { title: typeof out.title === 'string' ? out.title : null, steps: out.steps.slice(0, MODEL_STEPS).map((x) => ({ focus: x?.focus, say: x?.say })) } : null
  } catch {
    return null
  }
}

/** A walk from the numbers alone, for when no model answers or its walk does not hold. */
export function fallbackSteps(spec, screen = null) {
  if (spec.form === 'scene') return sceneSteps(spec, screen)
  if (spec.form !== 'timeline') return rowSteps(spec)
  const tz = spec.tz
  const steps = []
  const projects = spec.lanes.filter((l) => l.role === 'project' && l.id !== 'elsewhere' && l.value > 0)
  const first = spec.parts.reduce((m, p) => (p.role !== 'break' && p.from < m ? p.from : m), spec.window.to)
  const last = spec.parts.reduce((m, p) => (p.role !== 'break' && p.to > m ? p.to : m), spec.window.from)
  const tracked = spec.facts?.trackedMin
  const outside = spec.lanes.find((l) => l.id === 'elsewhere')
  const opening = `${tracked ? `${span(tracked)} on the record` : 'The day ran'} from ${hm(first, tz)} to ${hm(last, tz)}`
  // Most of a day can sit outside every project; saying a project "took the most" would then be false.
  if (outside?.value > (projects[0]?.value ?? 0)) steps.push({ focus: ['elsewhere'], say: `${opening}, most of it with ${outside.label.toLowerCase()} behind it${projects[0] ? `; ${projects[0].label} led the projects` : ''}.` })
  else if (projects[0]) steps.push({ focus: [projects[0].id], say: `${opening}, and ${projects[0].label} took the most of it.` })
  const meeting = spec.parts.filter((p) => p.role === 'meeting').sort((a, b) => minutes(b) - minutes(a))[0]
  if (meeting) steps.push({ focus: [meeting.id], say: `${meeting.label} took ${span(minutes(meeting))}, from ${hm(meeting.from, tz)}.` })
  const longest = spec.parts.filter((p) => p.role === 'session').sort((a, b) => minutes(b) - minutes(a))[0]
  if (longest) steps.push({ focus: [longest.id], say: `Your longest stretch was in ${longest.label} at ${hm(longest.from, tz)}, ${span(minutes(longest))} without a switch.` })
  const away = spec.parts.filter((p) => p.role === 'break').sort((a, b) => minutes(b) - minutes(a))
  if (away[0]) steps.push({ focus: [away[0].id], say: `You stepped away ${away.length === 1 ? 'once' : `${away.length} times`}; the longest was ${span(minutes(away[0]))} at ${hm(away[0].from, tz)}.` })
  if (projects[1]) steps.push({ focus: [projects[1].id], say: `${projects[1].label} came second, with ${span(projects[1].value)}.` })
  if (steps.length === 0) steps.push({ focus: [spec.lanes[0].id], say: `${spec.lanes[0].label} is all the record holds for this day.` })
  return steps.slice(0, MAX_STEPS)
}

/**
 * Jev's questions over a storyboard: does the walk answer the ask, and does
 * each step earn its place. Typed answers, so the gate is a number, not prose.
 */
export function criticQuestions(steps, free = false) {
  return {
    fits: {
      type: 'score',
      instructions: free ? '`walk` is what Gnomon will say, step by step, over a drawn set of `digest` to answer `ask` about the world. How well does it explain what was asked, and is it true?' : '`walk` is what Gnomon will say, step by step, over a picture of `digest` to answer `ask`. How well does it answer the ask from that record?',
      criteria: [
        'Off topic or wrong: it says things the record does not hold, or answers another question.',
        'Weak: generic, or misses what stands out in the record.',
        'Good: true to the record and on the ask.',
        'Excellent: true, on the ask, and points at exactly what is worth a look.',
      ],
    },
    ...Object.fromEntries(steps.map((_, i) => [`s${i}`, { type: 'noul', instructions: `Does step \`s${i}\` of \`walk\` earn its place: a true fact or pattern from \`digest\` the owner would want pointed out? No if it is filler, a repeat, praise, or talk about the picture.` }])),
  }
}

/** The frame critic's question set (plan step 5), and the id the image rides under. */
export const FRAME_SET = 'nodus.frame.v1'
export const FRAME_ASSET = 'frame-1'

/**
 * Jev looks at the drawn frame itself (labels and leaders burnt in): does the
 * picture show what was asked, and can it be read. The state names the image by
 * its asset id; the image rides beside it and is never logged.
 */
export function frameQuestions() {
  return {
    shows_intent: {
      type: 'score',
      instructions: 'The image `frame` is a drawing made to answer `ask`, titled `title`; `parts` are what it names and `step` what is being pointed at, if anything. How well does the picture itself show what was asked?',
      criteria: [
        'No: the picture shows something else, or nothing can be made out.',
        'Weak: the subject is there but what was asked does not show.',
        'Good: what was asked shows, with its parts where a reader expects them.',
        'Excellent: what was asked is plain at a glance, and the step points at it.',
      ],
    },
    legible: { type: 'noul', instructions: 'In the image `frame`, can every label be read, and does every label sit clear of the drawing and of the other labels, with its leader running to its own part?' },
  }
}

/** Jev's answers about a frame: the score in 0..3 and the probability it reads; null when it did not answer. */
export function frameVerdict(answers) {
  const score = answers?.shows_intent?.score
  if (typeof score !== 'number' || !Number.isFinite(score)) return null
  const legible = answers?.legible?.noul
  return { shows_intent: Math.round(Math.min(3, Math.max(0, score)) * 100) / 100, legible: typeof legible === 'number' ? Math.min(1, Math.max(0, legible)) : null }
}

/** Keep the steps Jev let through, two at the least, in their order. */
export function tailor(steps, answers) {
  if (!answers || steps.length <= 2) return steps
  const scored = steps.map((s, i) => ({ s, i, p: answers[`s${i}`]?.noul ?? 1 }))
  let kept = scored.filter((x) => x.p >= 0.45)
  if (kept.length < 2) kept = [...scored].sort((a, b) => b.p - a.p).slice(0, 2).sort((a, b) => a.i - b.i)
  return kept.map((x) => x.s)
}

const amount = (n, unit) => (unit === 'min' ? span(n) : unit === 'USD' ? `$${n.toFixed(2)}` : `${n} ${unit ?? ''}`.trim())

/** The walk from the numbers for bars, a graph or a table: the most, the change, the tie that matters. */
function rowSteps(spec) {
  const rows = spec.lanes
  const steps = []
  if (spec.form === 'bars' && rows.some((l) => l.then != null)) {
    const f = spec.facts ?? {}
    const top = [...rows].sort((a, b) => b.value - a.value)[0]
    if (top) steps.push({ focus: [top.id], say: `${top.label} led ${f.now ?? 'this day'}, ${amount(top.value, top.unit)} against ${amount(top.then, top.unit)} on ${f.then ?? 'the other'}.` })
    const delta = [...rows].sort((a, b) => b.value - b.then - (a.value - a.then))
    const up = delta[0]
    const down = delta.at(-1)
    if (up && up.value > up.then && up !== top) steps.push({ focus: [up.id], say: `${up.label} grew the most, from ${amount(up.then, up.unit)} to ${amount(up.value, up.unit)}.` })
    if (down && down.value < down.then) steps.push({ focus: [down.id], say: `${down.label} shrank the most, from ${amount(down.then, down.unit)} to ${amount(down.value, down.unit)}.` })
  } else if (spec.form === 'bars') {
    const sorted = [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    const total = sorted.reduce((n, l) => n + (l.value ?? 0), 0)
    const [a, b] = sorted
    if (a) steps.push({ focus: [a.id], say: `${a.label} took the most, ${amount(a.value, a.unit)} of ${amount(total, a.unit)}.` })
    if (b) steps.push({ focus: [b.id], say: `${b.label} came next, with ${amount(b.value, b.unit)}.` })
    const low = sorted.at(-1)
    if (low && sorted.length > 2) steps.push({ focus: [low.id], say: `${low.label} had the least, ${amount(low.value, low.unit)}.` })
  } else if (spec.form === 'graph') {
    const degree = (id) => spec.links.filter((k) => k.from === id || k.to === id).length
    const hub = rows.filter((l) => l.role === 'project').sort((a, b) => degree(b.id) - degree(a.id))[0]
    if (hub) steps.push({ focus: [hub.id], say: `${hub.label} holds ${degree(hub.id)} of your ${rows.filter((l) => l.role === 'commitment').length} open threads.` })
    const kept = rows.filter((l) => l.role === 'commitment').sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]
    if (kept) steps.push({ focus: [kept.id], say: `${kept.label} is the thread you keep returning to, on ${kept.value} days.` })
    const person = rows.find((l) => l.role === 'person')
    const owed = person && spec.links.find((k) => k.to === person.id)
    if (owed) steps.push({ focus: [person.id, owed.from], say: `${rows.find((l) => l.id === owed.from).label} is a promise to ${person.label}.` })
  } else if (spec.form === 'stages') {
    // A sequence: where it starts, where it turns, where it ends.
    const [a] = rows
    const mid = rows[Math.floor(rows.length / 2)]
    const z = rows.at(-1)
    if (a) steps.push({ focus: [a.id], say: `${a.label} comes first${a.note ? `: ${a.note}` : '.'}` })
    if (mid && mid !== a && mid !== z) steps.push({ focus: [mid.id], say: `${mid.label} is the turn${mid.note ? `: ${mid.note}` : '.'}` })
    if (z && z !== a) steps.push({ focus: [z.id], say: `${z.label} comes last, ${rows.length} stages in all.` })
  } else {
    // A table is in its reading order already: the first row is the one to see first.
    const [a, b] = rows
    if (a) steps.push({ focus: [a.id], say: a.value != null ? `${a.label} stands first, with ${amount(a.value, a.unit)}.` : `${a.label} stands first${a.cells?.[1] ? `, since ${a.cells[1]}` : ''}.` })
    if (b) steps.push({ focus: [b.id], say: `${b.label} comes next, and ${rows.length - 1} in all follow ${a.label}.` })
  }
  if (steps.length === 0 && rows[0]) steps.push({ focus: [rows[0].id], say: `${rows[0].label} is all the record holds here.` })
  return steps.slice(0, MAX_STEPS)
}

/**
 * The walk from the numbers over a scene, one rule per archetype: the
 * heaviest body, the widest pipe, the driving gear, the lit part. A step on a
 * part many others hang from pulls the set apart (`explode`) so its inside
 * shows; a fluid stays whole, its pipes are what it says. When the screen names a project the scene holds, that is a step too.
 */
export function sceneSteps(spec, screen = null) {
  const lanes = spec.lanes
  const by = new Map(lanes.map((l) => [l.id, l]))
  const links = spec.links ?? []
  const degree = (id) => links.filter((k) => k.from === id || k.to === id).length
  const heavy = (xs) => [...xs].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const of = (...kinds) => lanes.filter((l) => kinds.includes(l.kind))
  const steps = []
  // A part already stepped on keeps its step; asked to pull apart again, that step does.
  const add = (focus, say, explode = false) => {
    const ids = focus.map((l) => l.id)
    const had = steps.find((s) => s.focus.join() === ids.join())
    if (had) return explode && (had.explode = true)
    steps.push({ focus: ids, say, ...(explode ? { explode: true } : {}) })
  }
  if (spec.archetype === 'fluid') {
    const sources = heavy(of('source'))
    const tanks = heavy(lanes.filter((l) => l.kind !== 'source'))
    const total = tanks.reduce((n, l) => n + (l.value ?? 0), 0)
    const unit = tanks[0]?.unit
    if (sources.length === 1) add([sources[0]], `${sources[0].label} poured ${amount(total, unit)} into ${tanks.length} places.`)
    else if (sources[0]) add([sources[0]], `${sources[0].label} poured the most, ${amount(sources[0].value ?? 0, sources[0].unit)}, of ${sources.length} days.`)
    if (tanks[0]) add([tanks[0]], `${tanks[0].label} filled the most, ${amount(tanks[0].value ?? 0, unit)}${total ? `, ${Math.round(((tanks[0].value ?? 0) / total) * 100)} percent` : ''}.`)
    const wide = [...links].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0]
    if (wide && sources.length > 1) add([by.get(wide.from), by.get(wide.to)], `The widest flow ran from ${by.get(wide.from).label} into ${by.get(wide.to).label}, ${amount(wide.rate ?? 0, unit)}.`)
    if (tanks[1]) add([tanks[1]], `${tanks[1].label} came next, with ${amount(tanks[1].value ?? 0, unit)}.`)
    if (tanks.length > 2) add([tanks.at(-1)], `${tanks.at(-1).label} took the least, ${amount(tanks.at(-1).value ?? 0, unit)}.`)
  } else if (spec.archetype === 'orbital') {
    const center = of('center')[0]
    const bodies = heavy(of('body'))
    const moonsOf = (id) => links.filter((k) => k.kind === 'orbit' && k.to === id && by.get(k.from)?.kind === 'moon').length
    if (center && bodies[0]) add([bodies[0]], `${bodies[0].label} weighs the most around ${center.label}, ${amount(bodies[0].value ?? 0, bodies[0].unit)}.`)
    const family = [...bodies].sort((a, b) => moonsOf(b.id) - moonsOf(a.id))[0]
    if (family && moonsOf(family.id) >= 2) add([family], `${family.label} holds ${moonsOf(family.id)} of what circles it, closest in.`, true)
    const tie = links.find((k) => k.kind === 'tie')
    if (tie) add([by.get(tie.from), by.get(tie.to)], `${by.get(tie.from).label} is tied to ${by.get(tie.to).label}.`)
    if (bodies.length > 2) add([bodies.at(-1)], `${bodies.at(-1).label} is the lightest, furthest out.`)
  } else if (spec.archetype === 'mechanism') {
    const drive = of('gear').find((l) => l.state === 'driving') ?? heavy(of('gear'))[0] ?? lanes[0]
    add([drive], `${drive.label} drives the rest${degree(drive.id) ? `, through ${degree(drive.id)} joints` : ''}.`, degree(drive.id) >= 3)
    for (const k of links.filter((x) => x.from === drive.id || x.to === drive.id).slice(0, 2)) {
      const other = by.get(k.from === drive.id ? k.to : k.from)
      add([other], `${other.label} turns with ${drive.label} by ${k.kind}.`)
    }
  } else if (spec.archetype === 'clock') {
    // A day round the dial: what is on or next, the longest, a clash, how much of it.
    const events = of('event').filter((l) => l.id !== 'record')
    const clock = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`
    const on = events.find((l) => l.state === 'now') ?? events.find((l) => l.state === 'next')
    if (on) add([on], `${on.label} is ${on.state === 'now' ? 'on now' : 'next'}, at ${clock(on.start)}.`)
    const longest = [...events].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]
    if (longest) add([longest], `${longest.label} is the longest, ${amount(Math.round((longest.value ?? 0) * 60), 'min')}, from ${clock(longest.start)}.`)
    const clash = links.find((k) => k.kind === 'clash')
    if (clash) add([by.get(clash.from), by.get(clash.to)], `${by.get(clash.from).label} runs into ${by.get(clash.to).label}.`)
    const record = by.get('record')
    if (record) add([record], `The record was on from ${clock(record.start)} to ${clock(record.end)}${events.length ? `, ${events.length} ${events.length === 1 ? 'meeting' : 'meetings'} in it` : ', with no meeting in it'}.`)
  } else {
    const lit = lanes.find((l) => l.state === 'lit' || l.kind === 'sun' || l.kind === 'light') ?? lanes[0]
    add([lit], `${lit.label} is where it starts.`, degree(lit.id) >= 3)
    for (const k of links.filter((x) => x.from === lit.id).slice(0, 2)) add([by.get(k.to)], `${by.get(k.to).label} comes from ${lit.label}.`)
  }
  // The screen names a project this scene holds: the walk points at it, second.
  const shown = screen?.project && lanes.find((l) => l.label === screen.project)
  if (shown && !steps.some((s) => s.focus.includes(shown.id))) steps.splice(Math.min(1, steps.length), 0, { focus: [shown.id], say: `${shown.label}, on your screen now, ${shown.value != null ? `holds ${amount(shown.value, shown.unit)}` : 'is here'}.` })
  if (steps.length === 0 && lanes[0]) steps.push({ focus: [lanes[0].id], say: `${lanes[0].label} is all the record holds here.` })
  return steps.slice(0, MODEL_STEPS)
}

/** The free scenes the route may pick, by what each explains (never the words of an ask). */
const SCENE_ROUTES = {
  scene_system: 'how something in the world works or is built, not from the record: light and weather, a body, a building or a landscape, what causes what',
  scene_orbital: 'things in the world that circle a center: planets and moons, an atom, satellites',
  scene_fluid: 'something in the world that flows between parts: water, heat, air, blood or current through pipes, pumps and tanks',
  scene_mechanism: 'a machine of moving parts in the world: gears, shafts, belts, levers, pistons, a clock, an engine',
  scene_object: 'one thing in the world and its parts, to see how it is built: a device, an instrument, an organ, a robot, a vehicle',
}

/**
 * The route gate: would a figure answer this, and which. One typed Jev
 * choice over the views' own descriptions, so the answer follows what is
 * asked, never the words used to ask it.
 */
export function routeQuestions(views) {
  // A day has no scene of its own; asked as one it is where its time went (orchestrate.js).
  const scenes = Object.keys(views).filter((k) => views[k].scene || k === 'day')
  return {
    view: {
      type: 'choice',
      instructions: 'The owner said `ask` to Gnomon, who keeps a record of their days. Which figure would answer it best and be easiest to take in? Any question about their time, days, week, projects, threads of work, promises, goals, people or what Gnomon costs has a figure from the record. A request to see, show, draw or explain how something in the world works or is built has a scene of it (scene_*). Choose words only when no picture helps: a greeting, an instruction, or one fact.',
      criteria: { words: 'no figure: a greeting, thanks, a request to do something, chat, or a one-fact or yes/no answer', ...Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.about])), ...SCENE_ROUTES },
    },
    // Read only when the view picked is one of these: the same record as rows to read, as a picture to take in, or both.
    ...(scenes.length ? {
      shape: {
        type: 'choice',
        instructions: `Only if the figure is ${scenes.join(', ')}: should it be rows to read, a scene to take in at a glance, or both? \`screen\` is what is on the owner's screen right now, when known.`,
        criteria: { rows: 'exact amounts to read, compare and rank', scene: 'the shape at a glance: where the time flowed, who the owner works with and how close each is, how things hang together', both: 'the exact amounts and the shape, both asked for' },
      },
    } : {}),
  }
}

// ── The free path: a scene of something in the world, not the record ────────
// One model call writes a blueprint: an archetype, the parts (kinds, states,
// relative values), how they join, and the walk. Never a position, a size in
// units, a colour or a camera: the solvers and the stage own those. Doors may
// only search the record.

/** Worked blueprints the prompt shows, and the tests hold to the checker. */
export const BLUEPRINTS = {
  'what happens inside a raindrop': {
    archetype: 'system', title: 'Inside a raindrop',
    nodes: [{ id: 'sun', label: 'Sunlight', kind: 'sun', state: 'lit' }, { id: 'drop', label: 'Raindrop', kind: 'droplet', state: 'wet' }, { id: 'bow', label: 'Rainbow', kind: 'rainbow' }, { id: 'eye', label: 'You', kind: 'observer' }],
    edges: [{ from: 'sun', to: 'drop', kind: 'ray', label: 'white light enters' }, { from: 'drop', to: 'bow', kind: 'cause', label: 'splits into colours' }, { from: 'bow', to: 'eye', kind: 'ray', label: 'one colour per angle' }],
    steps: [{ focus: ['sun', 'drop'], say: 'Sunlight enters the raindrop and bends.' }, { focus: ['drop'], say: 'Inside the raindrop it reflects off the back and bends again on the way out.' }, { focus: ['bow', 'eye'], say: 'Each colour leaves at its own angle, so you see a rainbow.' }],
  },
  'visualize our solar system': {
    archetype: 'orbital', title: 'The solar system',
    nodes: [{ id: 'sun', label: 'Sun', kind: 'center', state: 'lit', value: 333000 }, { id: 'earth', label: 'Earth', kind: 'body', value: 1 }, { id: 'moon', label: 'Moon', kind: 'moon', value: 0.012 }, { id: 'mars', label: 'Mars', kind: 'body', value: 0.11 }, { id: 'jupiter', label: 'Jupiter', kind: 'body', value: 318 }, { id: 'rings', label: 'Saturn', kind: 'body', value: 95 }],
    edges: [{ from: 'earth', to: 'sun', kind: 'orbit' }, { from: 'moon', to: 'earth', kind: 'orbit' }, { from: 'mars', to: 'sun', kind: 'orbit' }, { from: 'jupiter', to: 'sun', kind: 'orbit' }, { from: 'rings', to: 'sun', kind: 'orbit' }],
    steps: [{ focus: ['sun'], say: 'The Sun holds almost all the mass, so everything circles it.' }, { focus: ['earth', 'moon'], say: 'Earth takes a year to go round, the Moon a month round Earth.' }, { focus: ['jupiter'], say: 'Jupiter outweighs all the other planets together.' }],
  },
  'how does a heat pump work': {
    archetype: 'fluid', title: 'How a heat pump works',
    nodes: [{ id: 'air', label: 'Outside air', kind: 'source', state: 'cold' }, { id: 'evap', label: 'Evaporator', kind: 'tank', state: 'gas', value: 4 }, { id: 'comp', label: 'Compressor', kind: 'pump' }, { id: 'cond', label: 'Condenser', kind: 'tank', state: 'hot', value: 6 }, { id: 'valve', label: 'Expansion valve', kind: 'valve' }, { id: 'home', label: 'Your home', kind: 'sink', state: 'hot' }],
    edges: [{ from: 'air', to: 'evap', kind: 'flow', rate: 2, label: 'outdoor heat in' }, { from: 'evap', to: 'comp', kind: 'flow', rate: 4, label: 'warm gas' }, { from: 'comp', to: 'cond', kind: 'flow', rate: 4, label: 'squeezed hotter' }, { from: 'cond', to: 'home', kind: 'flow', rate: 3, label: 'heat to rooms' }, { from: 'cond', to: 'valve', kind: 'flow', rate: 4 }, { from: 'valve', to: 'evap', kind: 'return', rate: 4 }],
    steps: [{ focus: ['air', 'evap'], say: 'The evaporator takes heat from the outside air, even cold air.' }, { focus: ['comp'], say: 'The compressor squeezes the gas until it is hot.' }, { focus: ['cond', 'home'], say: 'The condenser hands that heat to your home.' }, { focus: ['valve'], say: 'The expansion valve drops the pressure and the loop starts again.' }],
  },
  'show me a robot arm': {
    archetype: 'object', title: 'A robot arm, joint by joint',
    nodes: [
      { id: 'base', label: 'Base', kind: 'part', note: 'turns 360 degrees', form: { shape: 'cylinder', size: [1, 0.35, 1], parts: [{ shape: 'disc', at: 'top', size: [0.8, 0.3, 0.8] }] } },
      { id: 'shoulder', label: 'Shoulder joint', kind: 'part', note: 'lifts the arm', on: 'base', at: 'top', state: 'moving', form: { shape: 'sphere', size: 'm', parts: [{ shape: 'ring', at: 'center', size: 'l' }] } },
      { id: 'upper', label: 'Upper arm', kind: 'part', note: 'about 60 cm', on: 'shoulder', at: 'top', form: { shape: 'box', size: [0.4, 1.6, 0.4], parts: [{ shape: 'rod', at: 'inside', size: 'l' }] } },
      { id: 'elbow', label: 'Elbow', kind: 'part', note: 'bends 150 degrees', on: 'upper', at: 'right', form: { shape: 'cylinder', size: 's' } },
      { id: 'fore', label: 'Forearm', kind: 'part', note: 'carries the wrist', on: 'elbow', at: 'right', form: { shape: 'capsule', size: 'l' } },
      { id: 'grip', label: 'Gripper', kind: 'part', note: 'two jaws, 5 kg grip', on: 'fore', at: 'right', form: { shape: 'slab', size: 's', parts: [{ shape: 'wedge', at: 'right', size: 'xs', count: 2 }] } },
    ],
    edges: [],
    steps: [{ focus: ['base', 'shoulder'], say: 'The base turns the whole arm, and the shoulder joint lifts it.' }, { focus: ['upper', 'elbow', 'fore'], say: 'The upper arm and forearm meet at the elbow, which bends to reach.' }, { focus: ['grip'], say: 'The gripper closes its two jaws on what the arm reaches.' }],
  },
  'show me a lighthouse, exploded': {
    archetype: 'system', title: 'A lighthouse, floor by floor', exploded: true,
    nodes: [{ id: 'base', label: 'Store room', kind: 'stack' }, { id: 'stairs', label: 'Keeper rooms', kind: 'stack' }, { id: 'watch', label: 'Watch room', kind: 'stack' }, { id: 'lamp', label: 'Lantern', kind: 'stack', state: 'lit' }, { id: 'rock', label: 'The rock', kind: 'contour', shape: 'island' }, { id: 'beam', label: 'Beam', kind: 'light', state: 'lit' }],
    edges: [{ from: 'base', to: 'stairs', kind: 'touch' }, { from: 'stairs', to: 'watch', kind: 'touch' }, { from: 'watch', to: 'lamp', kind: 'touch' }, { from: 'lamp', to: 'beam', kind: 'ray' }],
    steps: [{ focus: ['base', 'rock'], say: 'The store room sits on the rock, holding oil and spares.' }, { focus: ['stairs', 'watch'], say: 'The keeper rooms lead up to the watch room.' }, { focus: ['lamp', 'beam'], say: 'The lantern at the top throws the beam out to sea.' }],
    panels: [{ label: 'Range', kind: 'number', value: 20, unit: 'nm' }],
  },
}

/** What a kind is for, in a few words: a small model picks a kind by its name alone, and drew a camera as a person. */
export const KIND_SAYS = {
  part: 'one part of the thing, built from blocks',
  sphere: 'a ball, a cell, a planet', light: 'a beam of light', ray: 'light travelling', plane: 'a flat screen, panel or sheet', ground: 'the ground under it all',
  observer: 'a person, and only a person', box: 'a device, a machine or a building', cylinder: 'a tank, a tower, a rack', cone: 'a funnel, a nozzle, a peak',
  torus: 'a ring, a wheel, a loop', arrow: 'a direction or a force', field: 'many small things: a crowd, a forest, data', contour: 'land: a hill, an island, a valley',
  stack: 'one floor or layer, bottom first', tank: 'a vessel that holds', source: 'where the flow comes from', sink: 'where it ends up', pump: 'what pushes the flow', valve: 'what lets it through or not', reservoir: 'a big store',
  gear: 'a toothed wheel', shaft: 'a turning rod', belt: 'a belt or chain', crank: 'a crank or pedal arm', lever: 'a lever', piston: 'a piston',
  stop: 'a place on the way', start: 'where it begins', end: 'where it arrives', turn: 'a change of direction',
}
const table = Object.entries(ARCHETYPES).map(([name, a]) => `- ${name}: kinds ${a.kinds.map((k) => (KIND_SAYS[k] ? `${k} (${KIND_SAYS[k]})` : k)).join(', ')}; states ${a.states.join(', ')}; links ${a.links.join(', ')}; value means ${a.value}`).join('\n')

const BLUEPRINT_SYSTEM = [
  'You are Gnomon, an artist and a teacher. The owner asked to see something in the world (not their own record). You write the blueprint of a set that explains it; Sundial builds, places, lights and frames it, never you.',
  'Pick the archetype that explains it best:',
  table,
  `A plain part (an object's part, or a system box, sphere, cylinder, cone, torus, plane, prism, observer, field or cloud) may carry a "form" so it looks like itself instead of a stock shape; gears, shafts, belts, pipes, tanks, orbits and dials are drawn by Sundial and take none: a block {"shape", "size", "at", "count"?, "mirror"?, "parts"?: [blocks]}. Shapes: ${Object.keys(BLOCKS).join(', ')}. size is xs, s, m, l or xl (against the whole thing) or [w, h, d] against its parent. at is where a block sits on its parent: ${Object.keys(PORTS).join(', ')} (inside shows it through the shell, as an x-ray). count repeats it along the face or around it. A camera is a box with a cylinder and a lens on its front; a cell a sphere with a sphere and capsules inside; a server rack a tall box with slabs inside. A part no blocks can draw (a face, a leaf, a bird, a coastline, a symbol) may carry "sketch" instead: up to 16 polylines [[x1, y1, x2, y2, ...], ...] in a 0 to 100 box, y down, the first its outline; Sundial draws them in its own line. Compose the picture by relations, in any archetype: a part stands where it belongs with "on" and "at" (an organ inside the body, a force as an arrow on the side of what it pushes, a server behind a router, the eye in front of the screen); a part with no on stands in the main row. A part may also stand on another part: "on": "<id>", "at": "<port>"; that is how a thing is built from its parts (archetype object: one body that stands on nothing, every other part on it).`,
  'When no set explains it, two more: bars (amounts to compare: money, sizes, counts, shares; one node per row with a value and a unit, "then" for an earlier value; no edges) and stages (a sequence read top to bottom: phases, eras, steps of a process or an argument; nodes in order, each with a short note of at most 12 words and up to three one-word tags; no edges). Anything can be drawn: a market, an idea, a cell, a galaxy.',
  `Shapes: a field (a dense point cloud) is one of ${SHAPES.field.join(', ')}; a contour (a terrain of stacked level lines, with tiny trees and huts) is one of ${SHAPES.contour.join(', ')}. A stack is one floor or layer: list floors bottom first.`,
  'Rules: 3 to 9 parts (fewer is clearer), ids short and lower case, labels two or three words the owner would say. value is relative (a big thing a bigger number); rate on a flow is relative. Never a position, a coordinate, a size in units, a colour, a camera or a view. Set "exploded": true only for a building or a machine shown pulled apart. A part may carry "door": "search:<words>" when the owner might have it in their own record; no other door.',
  'Give every part a "note": 2 to 5 words, the fact worth knowing about it, with a number and its unit when there is one ("30 frames a second", "about 120 ms", "holds the DNA"). It is printed under the part\'s name. value stays a relative weight for the layout and is never printed.',
  'When the question asks how or why, show it happening: connect the parts in the order things happen, an edge from each cause to its effect, and give each such edge a "label" of 2 to 4 words saying what passes or happens along it ("throws the hammer", "blue light scatters", "heat leaves the coil"). It is printed on the arrow, numbered in that order, so the process reads in one look; list the edges in that order.',
  'Then a walk of 3 to 5 steps, each focusing one to three ids and saying ONE thing to notice in a sentence of at most 20 words that names what it focuses with its label. Never talk about the picture ("this diagram", "the parts"). Say "you" to the owner; you are not an assistant. No em dashes.',
  'Optionally up to three panels of plain facts: {"label", "kind": "number", "value", "unit"} or {"label", "kind": "status", "word"}.',
  'Reply with JSON only: {"archetype", "title", "exploded"?, "nodes": [{"id", "label", "kind", "state"?, "value"?, "unit"?, "then"?, "note"?, "tags"?, "shape"?, "on"?, "at"?, "form"?, "sketch"?, "door"?}], "edges": [{"from", "to", "kind", "rate"?, "label"?}], "steps": [{"focus": ["id"], "say"}], "panels"?: [...]}',
].join('\n')

/** Said only when a picture source is there: a plain part may be drawn from a generated image, traced into Sundial's line. */
const PICTURES = 'Say "concrete": true when the subject is a physical thing you could photograph (a volcano, a heart, a transformer, an espresso machine), and false for an idea, an argument, a process or a flow (an allegory, a web request, the stages of something). Only a concrete subject gets pictures. Pictures are on: every plain part that is a real thing (an animal, an organ, a cell, a plant, a tool, a device, a vehicle, a building, a person) is drawn from a generated picture, traced into Sundial\'s line. So for real things prefer the object or system archetype with plain parts, and give each such part a "picture": a few words naming that one thing, seen whole ("a human heart, front view", "a honeybee from above", "a stock exchange trading floor"). Up to 6 pictures; never for an arrow, a pipe, a gear or a bar. A part without a picture of its own is drawn from a picture of its name.'

/** The messages for one blueprint: the system, worked examples, the ask; and a repair round from the checker's own words. */
export function blueprintMessages(ask, archetype = null, problems = null, previous = null, { pictures = false } = {}) {
  const shown = Object.entries(BLUEPRINTS).map(([q, b]) => `"${q}":\n${JSON.stringify(b)}`).join('\n\n')
  const messages = [
    { role: 'system', content: `${BLUEPRINT_SYSTEM}${pictures ? `\n${PICTURES}` : ''}\n\nWorked blueprints:\n${shown}` },
    { role: 'user', content: `${String(ask).slice(0, 300)}${archetype ? `\n(Archetype: ${archetype}.)` : ''}` },
  ]
  if (problems?.length && previous) {
    messages.push({ role: 'assistant', content: previous })
    messages.push({ role: 'user', content: `That blueprint does not hold: ${problems.slice(0, 8).join('; ')}. Fix exactly those and reply with the JSON again.` })
  }
  return messages
}

/** A blueprint out of a model's reply (never `parseReply`: a walk is not a set); null when there is none. */
export function parseBlueprint(text) {
  const s = String(text ?? '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const out = JSON.parse(s.slice(a, b + 1))
    if (!Array.isArray(out?.nodes) || out.nodes.length === 0) return null
    // Only what a blueprint may say: a coordinate, a colour or a camera is not read, whatever the reply holds.
    const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]))
    return {
      archetype: typeof out.archetype === 'string' ? out.archetype : null,
      title: typeof out.title === 'string' ? out.title : null,
      exploded: out.exploded === true,
      ...(typeof out.concrete === 'boolean' ? { concrete: out.concrete } : {}),
      nodes: out.nodes.map((n) => pick(n, ['id', 'label', 'kind', 'state', 'value', 'unit', 'then', 'tags', 'shape', 'on', 'at', 'form', 'sketch', 'picture', 'door', 'note', 'start', 'end', 'lat', 'lon'])),
      edges: (Array.isArray(out.edges) ? out.edges : []).map((e) => pick(e, ['from', 'to', 'kind', 'rate', 'label'])),
      steps: (Array.isArray(out.steps) ? out.steps : []).slice(0, MODEL_STEPS).map((x) => ({ focus: x?.focus, say: x?.say })),
      panels: (Array.isArray(out.panels) ? out.panels : []).filter((p) => p?.kind !== 'spark').slice(0, 3),
    }
  } catch {
    return null
  }
}

/** The free blueprints drawn as rows rather than a set. */
const ROWS_FORMS = ['bars', 'stages']

/** A blueprint as a spec for the checker: no source (so doors only search), the ask kept. Bars and stages are rows, the rest a scene. */
export const blueprintSpec = (bp, ask = '') =>
  ROWS_FORMS.includes(bp.archetype)
    ? { v: 1, form: bp.archetype, view: 'free', ask, title: bp.title, lanes: bp.nodes.map(({ tags, ...n }) => ({ ...n, role: 'marker', ...(Array.isArray(tags) ? { cells: tags.slice(0, 3).map(String) } : {}) })), links: [], steps: bp.steps, panels: bp.panels }
    : { v: 1, form: 'scene', view: 'free', ask, archetype: bp.archetype, title: bp.title, ...(bp.exploded ? { exploded: true } : {}), ...(typeof bp.concrete === 'boolean' ? { concrete: bp.concrete } : {}), lanes: bp.nodes, links: bp.edges, steps: bp.steps, panels: bp.panels }
