// The catalogue: the ways Gnomon can show an answer (idioms: a timeline, a
// flow, a building pulled apart, a contour...), each with one example of its
// own silhouette and when to reach for it, the planned ones as sketches; then,
// folded, the engine's own terms. Every item has a question box and notes.
//
// Opened from the thread picker (app.js) or by Sundial.app's overlay
// (`openCatalogue()`), it takes the conversation's place in the ghost, so it
// works on the board and in the overlay's dock alike, and Back returns to the
// thread. The URL's `#catalogue` is its route: a reload opens it again.
//
// The idioms are written by hand (they are a promise about what an answer can
// look like); under the hood is read from the code that draws (Nodus's FORMS,
// ARCHETYPES and VIEWS, the board's CARDS), so a form or a view added there is
// listed the day it exists. Every demo is drawn
// from made-up rows (Nodus's fixtures, plus a ledger and goals below), never
// the record: a door inside a demo is the one way to the real thing, and the
// owner opens it on purpose.
//
// A comment is a note: a `note:` card placed through the board's one write
// route with `filters: { catalogue: <item id> }`, so it is a `board:place` in
// the log like any note, Gnomon sees it on the board, and removing it is the
// board's own veto. No new event, no new table.

import { ARCHETYPES, FORMS, checkSpec } from '@sundial/nodus/spec.js'
// The whole module too, for what may not be there yet (a kind's shapes).
import * as Spec from '@sundial/nodus/spec.js'
import { VIEWS } from '@sundial/nodus/views.js'
import { fallbackSteps } from '@sundial/nodus/storyboard.js'
import { cardSpec, nodusNode } from '@sundial/nodus/card.js'
import { MODES } from '@sundial/nodus/modes/index.js'
import { DAY, PLATES, SCENES, fixtureRead } from '@sundial/nodus/fixture.test-data.js'
import { MENU, cardOf } from './cards.js'
import { el, newestFirst } from './surfaces.js'
import { onChange } from './stage.js'

export { fixtureRead }

/** A checked spec with a walk: the model's when it has one, else the walk from the numbers. */
export function demoSpec(input) {
  if (!input) return null
  const steps = input.steps?.length ? input.steps : fallbackSteps(checkSpec({ ...input, steps: [] }).spec ?? input)
  return checkSpec({ ...input, steps }).spec
}

/** A view drawn from the fixtures, through the same binder the record uses. */
const view = (name, args = {}) => async () => demoSpec(await VIEWS[name].read(fixtureRead, { date: DAY.date, ...args }))

// ── The hand-written lines ─────────────────────────────────────────────────

const FORM_ABOUT = {
  timeline: 'Things in time: lanes on an hour axis, every session a bar, meetings as navy bands, time away dashed.',
  bars: 'How much of each, the most first; a comparison draws the other day beside it in grey.',
  graph: 'Who and what connect: projects, threads and people in three columns, joined by hairlines.',
  table: 'Rows to read: the name is a door, the numbers line up.',
  scene: "A set built from parts by an archetype's solver: lanes are its parts, links its joints, the camera yours.",
}

const ARCHETYPE_ABOUT = {
  system: 'Weather and light: parts placed on an arc, one sun and one ground, things that cause, shine on or touch each other.',
  fluid: 'Pipes and tanks: flow laid out in layers from a source, a pipe as wide as its rate, a return routed under.',
  mechanism: 'Gears and linkages: meshing gears solved so their teeth interleave and turn opposite ways.',
  orbital: 'Bodies round a center: rings by mass, moons on small circles, the inner ones faster.',
  clock: 'A day round one dial: events as arcs on the hours, a marker, the hand at now.',
  route: 'A way through stops: legs drawn in order, each with its minutes.',
  plan: 'Rooms as walls sized by area, devices placed in the room they stand in.',
}

const KIND_ABOUT = {
  sphere: 'A plain ball.', sun: 'A disc of light with its glow; the lit source of a system.', light: 'A soft glow that lights what sits near it.', cloud: 'A drifting cloud.',
  rain: 'Rain falling from above.', droplet: 'A single drop, its inside showing.', rainbow: 'An arc in the muted spectrum, the one place colour is the subject.',
  ray: 'A beam from one thing toward another.', plane: 'A flat sheet something lands on.', ground: 'The floor a system stands on; one per scene.',
  observer: 'You, looking; always turned toward the camera.', prism: 'A glass prism that splits what passes through it.', orbit: 'A ring path with a body travelling it.',
  box: 'A plain box.', cylinder: 'A plain cylinder.', cone: 'A plain cone.', torus: 'A plain ring, solid.', arrow: 'A direction, drawn as a ray.',
  tank: 'Holds a volume; its edge grows with the cube root of it.', source: 'Where the flow starts; every fluid has one.', sink: 'Where the flow ends.',
  pump: 'Pushes the flow on; its blades turn.', valve: 'Narrows the flow between two pipes.', reservoir: 'A tank kept full: a store rather than a stage.',
  gear: 'A toothed wheel, 6 to 120 teeth; gears that mesh turn opposite ways.', shaft: 'A rod turned by what pushes it.', belt: 'A loop carrying a turn from one wheel to another.',
  crank: 'An arm that turns round its axle.', lever: 'A beam that rocks on its pivot.', piston: 'A head that rises and falls.',
  field: 'A dense point cloud inside a silhouette.', contour: 'A terrain as stacked level lines, small trees and huts on its slopes.', stack: "A building's floor: its slab, a plan of walls, posts up to the storey's rim.",
  event: 'An arc on the dial from its start to its end hour; done, now, next or missed.', dial: 'The face the day is read on.', marker: 'One moment on the dial.', hand: 'Now.',
  start: 'Where the way begins.', end: 'Where it arrives.', stop: 'A stop on the way, with its minutes.', turn: 'A turn along a leg.',
  room: 'A room, as large as its area.', device: 'A thing in a room, with its state: on, off, closed.',
  body: 'A planet; its mass sets its ring and its speed.', center: 'What everything orbits; the heaviest part.', moon: 'A small body circling a body.', ring: 'A ring round a body.',
}

const step = (focus, say, extra = {}) => ({ focus, say, ...extra })
const scene = (archetype, title, lanes, links, steps, extra = {}) => ({ v: 1, form: 'scene', archetype, title, lanes, links, steps, ...extra })

// One made-up example per idiom, each with its own silhouette: no two are the
// same figure redrawn. The scenes below use the kit's engraver's parts (field,
// contour, stack) and the walk's `explode`; the clock, the route and the plan
// are Nodus's own fixtures.
const BUILDING = scene('system', 'A house, floor by floor', [
  { id: 'street', label: 'Street', kind: 'ground' },
  { id: 'cellar', label: 'Cellar', kind: 'stack', value: 2 },
  { id: 'living', label: 'Living floor', kind: 'stack', value: 2 },
  { id: 'sleep', label: 'Bedrooms', kind: 'stack', value: 2 },
  { id: 'attic', label: 'Attic', kind: 'stack', value: 1 },
], [{ from: 'cellar', to: 'living', kind: 'touch' }, { from: 'living', to: 'sleep', kind: 'touch' }, { from: 'sleep', to: 'attic', kind: 'touch' }, { from: 'street', to: 'cellar', kind: 'touch' }], [
  step(['living'], 'The living floor sits on the cellar, the bedrooms above it.'),
  step(['sleep'], 'Pulled apart, the bedrooms show their walls and the posts that carry the attic.', { explode: true }),
  step(['attic'], 'The attic closes the house under its roof.'),
])
const WOODS = scene('system', 'A walk through the woods', [
  { id: 'forest', label: 'Forest', kind: 'field', shape: 'forest', value: 3 },
  { id: 'oak', label: 'Old oak', kind: 'field', shape: 'tree', value: 2 },
  { id: 'crowd', label: 'Walkers', kind: 'field', shape: 'crowd' },
  { id: 'sky', label: 'Rain cloud', kind: 'field', shape: 'cloud' },
  { id: 'path', label: 'Path', kind: 'ground' },
], [{ from: 'sky', to: 'forest', kind: 'cause' }, { from: 'crowd', to: 'oak', kind: 'touch' }], [
  step(['forest'], 'The forest is thousands of points, dense where the canopy closes.'),
  step(['oak', 'crowd'], 'The walkers gather under the old oak.'),
  step(['sky'], 'A rain cloud drifts in from the west.'),
])
const ISLAND = scene('system', 'An island and its hills', [
  { id: 'isle', label: 'Island', kind: 'contour', shape: 'island', value: 3 },
  { id: 'hill', label: 'Lookout hill', kind: 'contour', shape: 'hill', value: 2 },
  { id: 'vale', label: 'Green valley', kind: 'contour', shape: 'valley', value: 2 },
], [{ from: 'hill', to: 'vale', kind: 'touch' }], [
  step(['isle'], 'The island rises in rings from the shore to its spine.'),
  step(['hill'], 'Lookout hill is the highest ring, close lines where it is steep.'),
  step(['vale'], 'The green valley sinks between them, its lines far apart.'),
])
/** Then and now, with the day's numbers docked under it: two bars a row, not one. */
const compareDemo = async () => {
  const spec = await VIEWS.compare.read(fixtureRead, { date: DAY.date })
  return demoSpec({ ...spec, panels: [{ label: 'Tracked', kind: 'number', value: 312, unit: 'min', note: 'against 211 the day before' }, { label: 'The week', kind: 'spark', series: [180, 240, 211, 312, 260, 90, 120] }, { label: 'Shape', kind: 'status', word: 'busier' }] })
}

/**
 * The planned idioms are not faked with a figure that exists: each is a
 * hairline sketch of what it will be, marked planned. Drawn in currentColor so
 * both papers take it.
 */
const SKETCH = {
  gauges: [0, 1, 2, 3].map((i) => `<g transform="translate(${30 + i * 82} 30)"><path d="M0 60 A34 34 0 0 1 68 60"/><path d="M34 60 L${34 + Math.round(30 * Math.cos(Math.PI * (1 - (i + 1) / 5)))} ${60 - Math.round(30 * Math.sin(Math.PI * (1 - (i + 1) / 5)))}"/><text x="10" y="84">${['heat', 'sleep', 'spend', 'power'][i]}</text></g>`).join(''),
  calendar: Array.from({ length: 35 }, (_, i) => `<rect x="${40 + (i % 7) * 40}" y="${14 + Math.floor(i / 7) * 26}" width="34" height="20"${[3, 9, 10, 17, 24, 25, 31].includes(i) ? ' fill="currentColor" fill-opacity=".14"' : ''}/>`).join(''),
}
/** A planned idiom's sketch, as plain SVG text the slot parses. */
export const sketchOf = (key) => `<svg class="cat-sketch" viewBox="0 0 360 160" role="img" aria-label="A sketch, planned" fill="none" stroke="currentColor" stroke-width="1">${SKETCH[key]}</svg>`

/** The spec sheet: every kind of an archetype on one plate, at one scale (Nodus's PLATES). */
const PLATE_LIST = Object.values(PLATES ?? {})

const IDIOMS = [
  { key: 'timeline', title: 'Timeline', use: 'the question is when: a day, hour by hour.', about: 'Lanes on an hour axis; every session a bar that opens its moment, meetings in navy, time away dashed.', demo: view('day') },
  { key: 'distribution', title: 'Distribution', use: 'the question is where something went: time, money, attention.', about: 'The most first, each a bar as long as its share.', demo: view('where') },
  { key: 'flow', title: 'Flow', use: 'something moves from a source through stages: hours into projects, heat through a pump.', about: 'Tanks and pipes solved in layers, a pipe as wide as what runs through it.', demo: () => demoSpec(SCENES.fluid) },
  { key: 'exploded', title: 'Exploded', use: 'the answer is inside something: a machine, a building, floor by floor.', about: 'A step pulls the set apart along its own axes, so its inside shows. Walk to the second step.', demo: () => demoSpec(BUILDING) },
  { key: 'orbit', title: 'Orbit', use: 'who and what circles you, and how much each weighs.', about: 'Bodies on rings by weight, moons round their bodies, the inner ones faster.', demo: () => demoSpec(SCENES.orbital) },
  { key: 'field', title: 'Particle field', use: 'the subject is organic or many: a forest, a crowd, weather.', about: 'Dense seeded points inside a silhouette: a tree, a forest, a crowd, a cloud.', demo: () => demoSpec(WOODS) },
  { key: 'contour', title: 'Contour', use: 'things come in heights or layers: terrain, depth, effort piling up.', about: 'Stacked level lines from a seeded height, close where it is steep.', demo: () => demoSpec(ISLAND) },
  { key: 'network', title: 'Network', use: 'things connect: threads, the projects they sit in, who a promise is owed to.', about: 'Three columns joined by hairlines; a lit node lights its wires.', demo: view('threads') },
  { key: 'table', title: 'Table', use: 'the answer is to be read, row by row.', about: 'Flat rows, the name a door, the numbers lined up.', demo: view('goals') },
  { key: 'comparison', title: 'Comparison', use: 'then against now: today beside yesterday.', about: 'Two bars a row, the earlier in grey, with the day’s numbers docked under it.', demo: compareDemo },
  { key: 'route', title: 'Map route', use: 'the question is a way: your route to work with its stops and times.', about: 'A line through the stops you take, each leg with its minutes. Drawn; nothing reads your real route into it yet.', demo: () => demoSpec(SCENES.route) },
  { key: 'clock', title: 'Radial clock', use: 'the question is a schedule: the day as a dial.', about: 'Events as arcs round the hours, a clash where two overlap, the hand at now. Drawn; your calendar does not feed it yet.', demo: () => demoSpec(SCENES.clock) },
  { key: 'plan', title: 'Floor plan', use: 'the question is a place: rooms and what is in them.', about: 'Rooms sized by area, devices where they stand with their state. Drawn; Home Assistant is not connected to it yet.', demo: () => demoSpec(SCENES.plan) },
  { key: 'gauges', title: 'Gauge wall', use: 'many readings at once: sensors, health, money.', about: 'A wall of small dials, each a reading with its range, the odd one lit.', planned: true, sketch: 'gauges' },
  { key: 'calendar', title: 'Calendar grid', use: 'the question spans weeks: what fills which day.', about: 'Weeks as rows of days, each filled as full as it was.', planned: true, sketch: 'calendar' },
]

// ── The structure ──────────────────────────────────────────────────────────

/**
 * The sections: what Gnomon can show first, then the engine's own terms under
 * the hood (`hood: true`, drawn folded). An item's `demo` returns a spec or a
 * list of specs; a planned idiom has a `sketch` instead.
 */
export function catalogue() {
  // The catalog's own words, with its dashes turned to commas: the house style has none on a page.
  const plain = (t) => String(t ?? '').replace(/\s*\u2014\s*/g, ', ')
  const card = (id) => cardOf(id) ?? { id, title: id, question: '', shows: '' }
  const cardItem = (key, id, title) => {
    const c = card(id)
    return { id: `card.${key}`, title: title ?? c.title, about: plain(`${/[.?!]$/.test(c.question) ? c.question : `${c.question}.`} Shows ${c.shows}.`), params: c.filters ? Object.entries(c.filters).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]) : [] }
  }
  return [
    {
      id: 'modes',
      title: 'Three ways to draw',
      about: 'Every thread draws in one of three ways, or Auto picks per question; switch it in the thread bar. Here is one question drawn all three ways, with how long each took and how it was checked.',
      items: [{ id: 'modes.compare', title: 'One question, three ways', about: 'Sketch reads your record and draws fast; Studio invents an animated scene; Atlas finds real pictures and models and redraws them in this style.', render: renderModes }],
    },
    {
      id: 'show',
      title: 'What Gnomon can show',
      about: 'Each way of showing, with one example drawn from made-up rows and when to reach for it. The planned ones are sketches, not yet drawn.',
      items: IDIOMS.map(({ key, ...i }) => ({ id: `idiom.${key}`, ...i })),
    },
    {
      id: 'forms',
      hood: true,
      title: 'Forms',
      about: 'The five ways the engine draws. A model picks what to show and say; the form decides every colour, size and place.',
      items: FORMS.map((form) => ({ id: `form.${form}`, title: form, about: FORM_ABOUT[form] ?? `The ${form} form.` })),
    },
    {
      id: 'archetypes',
      hood: true,
      title: 'Scene archetypes',
      about: 'A scene names an archetype, and the archetype names the solver that places its parts.',
      items: Object.entries(ARCHETYPES).map(([name, a]) => ({
        id: `archetype.${name}`,
        title: name,
        about: ARCHETYPE_ABOUT[name] ?? `The ${name} archetype.`,
        params: [['kinds', a.kinds.join(', ')], ['links', a.links.join(', ')], ['states', a.states.join(', ')], ['value', a.value]],
      })),
    },
    {
      id: 'parts',
      hood: true,
      title: 'Parts',
      about: "Every kind in the stage kit, by archetype, each on its own. A part's value means one thing per archetype; the first kind is what an unknown kind is drawn as.",
      items: [
        { id: 'part.plate', title: 'The spec sheet', about: `Every kind of an archetype on one plate, at one scale: ${Object.keys(PLATES ?? {}).join(', ')}. The kinds below are listed with what each one takes.`, demo: PLATE_LIST.length ? () => PLATE_LIST.map(demoSpec) : null },
        ...Object.entries(ARCHETYPES).flatMap(([name, a]) =>
        a.kinds.map((kind, i) => ({
          id: `part.${name}.${kind}`,
          title: kind,
          group: name,
          about: `${KIND_ABOUT[kind] ?? 'Drawn from the kit.'}${i === 0 ? ` The ${name} default.` : ''}`,
          params: [['archetype', name], ['value', a.value], ['states', a.states.join(', ')], ['links', a.links.join(', ')], ...(Spec.SHAPES?.[kind] ? [['shapes', Spec.SHAPES[kind].join(', ')]] : [])],
        })),
        ),
      ],
    },
    {
      id: 'views',
      hood: true,
      title: 'Views',
      about: 'The shapes of the record a figure binds to. Each reads its rows through the same tools Gnomon reads, so a figure re-reads itself.',
      items: Object.entries(VIEWS).map(([name, v]) => ({
        id: `view.${name}`,
        title: name,
        about: `${v.about[0].toUpperCase()}${v.about.slice(1)}.`,
        params: [['form', v.form ?? 'any'], ...(v.scene ? [['also as', `${/^[aeiou]/.test(v.scene) ? 'an' : 'a'} ${v.scene} scene`]] : [])],
      })),
    },
    {
      id: 'cards',
      hood: true,
      title: 'Cards',
      about: 'What a card on the board can be.',
      items: [
        cardItem('nodus', 'nodus:'),
        cardItem('lens', 'lens:'),
        cardItem('moment', 'moment:'),
        cardItem('person', 'entity:', 'Person'),
        cardItem('note', 'note:'),
        { id: 'card.instruments', title: 'Instruments', about: 'The cards the foot lists by name, each the one home of its facts.', params: MENU.map((id) => [card(id).title, plain(card(id).question)]) },
      ],
    },
    {
      id: 'walk',
      hood: true,
      title: 'Walk and controls',
      about: 'How a figure is read: a walk of sentences over it, and the hands you have on it. Every example above has them.',
      items: [
        { id: 'walk.steps', title: 'Steps', about: 'One to seven sentences, each lighting what it names. It plays once at reading pace; Back, Next and the arrow keys take over, Home is the whole figure.' },
        { id: 'walk.focus', title: 'Focus', about: 'Naming a thing lights it: a word the sentence and a label share, never a colour a model picked. The rest dims.' },
        { id: 'walk.camera', title: 'Camera hand', about: 'In a scene, drag orbits and the wheel zooms; a click frames a part, a second opens its door, a double click is the whole figure. The walk waits while your hand is on it.' },
        { id: 'walk.doors', title: 'Doors', about: 'A part may carry a door to a moment, a name, a day or a search; clicking it opens that card from the record.' },
        { id: 'walk.live', title: 'Live lens', about: "A figure bound to a view re-reads the record when it opens and on the board's beat, at most once a minute, and says what changed since you looked. Offline, it keeps what it drew." },
        { id: 'walk.shelf', title: 'Shelf', about: 'A figure taken off the board keeps its recipe on the shelf; a link to it, or Put it up, brings it back reading fresh rows.' },
        { id: 'walk.library', title: 'Library', about: 'Walks the critic scored 2 of 3 or more are kept on this machine, and a like ask borrows the nearest two as examples.' },
        { id: 'walk.overlay', title: 'Overlay', about: 'Sundial.app puts one slip over any app: Gnomon’s line, a field, and hold the key to talk. It rings what it points at, asks before it acts, and shows a Nodus card beside it; what you were looking at rides along as the turn’s place.' },
      ],
    },
  ]
}

// ── The modes, side by side ────────────────────────────────────────────────

/** The question the modes page draws: a muscle once Atlas is in, else a machine. */
export const COMPARE_ASK = { atlas: 'the bicep and the layers under it', other: 'how a heat pump works' }

/** The newest drawing of `ask` per mode, from the board and the shelf. `{ sketch: { id, spec } | null, ... }` */
export function drawingsOf(board, ask) {
  const want = String(ask).trim().toLowerCase()
  const texts = [...Object.values(board?.cards ?? {}).filter((c) => c.kind === 'nodus').map((c) => [c.id, c.text, c.at ?? '']), ...Object.entries(board?.lenses ?? {}).filter(([id]) => id.startsWith('nodus:')).map(([id, l]) => [id, l.spec, l.at ?? ''])]
  const out = Object.fromEntries(Object.keys(MODES).map((m) => [m, null]))
  for (const [id, text, at] of texts.sort((a, b) => String(a[2]).localeCompare(String(b[2])))) {
    const spec = cardSpec(text)
    if (!spec || String(spec.ask ?? '').trim().toLowerCase() !== want) continue
    out[spec.mode && MODES[spec.mode] ? spec.mode : 'sketch'] = { id, spec }
  }
  return out
}

/** Three columns: each mode's drawing of the one question, its time, and when to reach for it; a Draw it act where there is none yet. */
async function renderModes(slot) {
  const [modes, b] = await Promise.all([fetch('/gnomon/api/nodus-mode').then((r) => r.json()).catch(() => ({ modes: [] })), readBoard().catch(() => null)])
  const ready = Object.fromEntries((modes.modes ?? []).map((m) => [m.id, m.ready]))
  const ask = ready.atlas ? COMPARE_ASK.atlas : COMPARE_ASK.other
  const got = drawingsOf(b, ask)
  const column = (m) => {
    const d = got[m.id]
    const ms = d?.spec.by?.ms?.total
    const draw = el('button', {
      type: 'button',
      class: 'act',
      text: `Draw it in ${m.label}`,
      onclick: async (e) => {
        e.currentTarget.disabled = true
        e.currentTarget.textContent = `Drawing in ${m.label}…`
        await fetch('/gnomon/api/nodus-try', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ask, mode: m.id }) }).catch(() => null)
        delete slot.dataset.mounted
        void mountDemo(slot, slot.demo)
      },
    })
    return el('div', { class: 'cat-mode', 'data-mode': m.id }, [
      el('h4', { class: 'cat-mode-name', text: m.label }),
      el('p', { class: 'cat-use' }, [el('span', { class: 'cat-use-label', text: 'Use it for ' }), m.when[0].toLowerCase() + m.when.slice(1)]),
      d ? el('div', { class: 'cat-figure' }, [nodusNode(d.spec, { id: d.id, text: JSON.stringify(d.spec) })]) : el('p', { class: 'none', text: ready[m.id] === false ? `${m.label} is not ready yet.` : 'Not drawn yet.' }),
      el('p', { class: 'cat-mode-time', text: d ? (ms ? `${(ms / 1000).toFixed(1)} s to draw` : 'Time not kept') : '' }),
      !d && ready[m.id] !== false ? draw : null,
    ])
  }
  slot.replaceChildren(el('p', { class: 'cat-mode-ask' }, [el('span', { class: 'cat-use-label', text: 'Asked: ' }), ask]), el('div', { class: 'cat-modes' }, Object.values(MODES).map(column)))
}

// ── Comments: notes bound to an item ───────────────────────────────────────

/** The notes on one item, newest first, from the board's cards. */
export function commentsFor(board, itemId) {
  return newestFirst(Object.values(board?.cards ?? {}).filter((c) => c.kind === 'note' && c.filters?.catalogue === itemId && (c.text ?? '').trim() !== ''))
}

const boardPost = (body) => fetch('/gnomon/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const readBoard = () => fetch('/gnomon/api/board', { headers: { accept: 'application/json' } }).then((r) => r.json())

/** A note on the board, bound to the item: the existing note path, one `board:place`. */
export const addComment = (itemId, text) => boardPost({ action: 'place', id: `note:cat-${Date.now().toString(36)}`, kind: 'note', text, filters: { catalogue: itemId } })
export const removeComment = (id) => boardPost({ action: 'remove', id })

// ── The page ───────────────────────────────────────────────────────────────

/** What app.js lends: `say(text, place)` sends a turn, `show()` brings the conversation forward. */
let hooks = { say: null, show: null }
let root = null
let board = null
let observer = null
const commentLists = new Map()

export function wireCatalogue(next) {
  hooks = { ...hooks, ...next }
}

/** Draw one item's demo into its slot: a figure per spec, each with its walk. */
export async function mountDemo(slot, item) {
  if (slot.dataset.mounted !== undefined) return
  slot.dataset.mounted = ''
  if (item.render) return item.render(slot)
  try {
    const specs = [await item.demo()].flat().filter(Boolean)
    if (specs.length === 0) throw new Error('nothing')
    slot.replaceChildren(...specs.map((spec) => el('div', { class: 'cat-figure' }, [nodusNode(spec, { read: fixtureRead })])))
  } catch {
    slot.replaceChildren(el('p', { class: 'none', text: 'This one has no demo yet.' }))
  }
}

const time = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function drawComments(itemId) {
  const list = commentLists.get(itemId)
  if (!list) return
  const notes = commentsFor(board, itemId)
  list.closest('.cat-item')?.querySelector('.cat-count')?.replaceChildren(notes.length ? String(notes.length) : '')
  list.replaceChildren(
    ...notes.map((n) =>
      el('li', { class: 'cat-comment' }, [
        el('p', { class: 'cat-comment-text', text: n.text }),
        el('span', { class: 'cat-comment-meta' }, [
          el('span', { text: `${n.by === 'gnomon' ? 'Gnomon' : 'You'}, ${time(n.at)}` }),
          el('button', { type: 'button', class: 'cat-quiet', text: 'Remove', 'aria-label': `Remove the note: ${n.text.slice(0, 40)}`, onclick: (e) => ((e.currentTarget.disabled = true), removeComment(n.id).then(refresh, refresh)) }),
        ]),
      ]),
    ),
  )
}

/** Re-read the board; only the newest read draws, so a read that left before a write cannot undo it. */
let reads = 0
async function refresh() {
  const n = ++reads
  let next
  try {
    next = await readBoard()
  } catch {
    return
  }
  if (n !== reads) return
  board = next
  for (const id of commentLists.keys()) drawComments(id)
}

/** A one-line field and its button: Enter or the button sends, and the field clears on success. */
function field({ label, placeholder, button, send }) {
  const input = el('input', { type: 'text', class: 'cat-field', placeholder, 'aria-label': label, maxlength: 600 })
  const go = el('button', { type: 'button', class: 'act cat-go', text: button })
  const fire = async () => {
    const text = input.value.trim()
    if (text === '' || go.disabled) return
    go.disabled = true
    input.disabled = true
    try {
      if ((await send(text)) !== false) input.value = ''
    } finally {
      go.disabled = false
      input.disabled = false
      input.focus({ preventScroll: true })
    }
  }
  go.addEventListener('click', fire)
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), fire())
  })
  return el('div', { class: 'cat-row' }, [input, go])
}

/** Ask about this: a turn in the conversation with the item as its place; the reply grows here as it is written. */
function askBox(item) {
  const reply = el('div', { class: 'cat-reply', 'aria-live': 'polite', hidden: true })
  const ask = async (text) => {
    if (!hooks.say) return false
    const canvas = document.getElementById('canvas')
    const before = canvas?.querySelectorAll('.turn').length ?? 0
    const said = el('p', { class: 'cat-reply-text', text: 'Gnomon is reading…' })
    reply.replaceChildren(el('p', { class: 'cat-asked', text }), said, el('button', { type: 'button', class: 'cat-quiet', text: 'Open in the conversation', onclick: () => closeCatalogue({ show: true }) }))
    reply.hidden = false
    // The thread draws the turn as always; this only reads its words back.
    const copy = () => {
      const turns = canvas?.querySelectorAll('.turn') ?? []
      const turn = turns.length > before ? turns[turns.length - 1] : null
      const words = [...(turn?.querySelectorAll('.prose') ?? [])].map((p) => p.textContent.trim()).filter(Boolean).join('\n\n')
      if (words) said.textContent = words
    }
    const watch = canvas ? new MutationObserver(copy) : null
    watch?.observe(canvas, { childList: true, subtree: true, characterData: true })
    try {
      await hooks.say(text, `the Catalogue, ${item.id} (${item.title}): ${item.about}`.slice(0, 200))
    } finally {
      // The words can outlive the POST (the thread's watch carries the rest), so the reading stays on a while.
      setTimeout(() => watch?.disconnect(), 60_000)
      copy()
      if (said.textContent === 'Gnomon is reading…') said.textContent = 'No words came back here; the answer is in the conversation.'
    }
  }
  return el('div', { class: 'cat-ask' }, [field({ label: `Ask Gnomon about ${item.title}`, placeholder: 'Ask about this…', button: 'Ask', send: ask }), reply])
}

function commentBox(item) {
  const list = el('ul', { class: 'cat-comments' })
  commentLists.set(item.id, list)
  const send = async (text) => {
    const r = await addComment(item.id, text).catch(() => null)
    if (!r?.ok) return false
    await refresh()
  }
  return el('div', { class: 'cat-notes' }, [field({ label: `A note on ${item.title}`, placeholder: 'Leave a note…', button: 'Add', send }), list])
}

/** One item: its name, its line, its parameters, its demo, then the two boxes behind two quiet acts. */
function itemNode(item) {
  const ask = el('div', { class: 'cat-drawer', hidden: true }, [askBox(item)])
  const notes = el('div', { class: 'cat-drawer', hidden: true }, [commentBox(item)])
  const toggle = (drawer, other) => (e) => {
    other.hidden = true
    drawer.hidden = !drawer.hidden
    for (const b of e.currentTarget.parentNode.children) b.setAttribute('aria-expanded', String(b === e.currentTarget && !drawer.hidden))
    if (!drawer.hidden) drawer.querySelector('input')?.focus({ preventScroll: true })
  }
  const slot = item.demo || item.render ? el('div', { class: 'cat-demo', 'data-item': item.id }, [el('p', { class: 'none', text: 'Drawn when you reach it.' })]) : null
  if (slot) slot.demo = item
  const sketch = item.sketch ? el('div', { class: 'cat-demo cat-planned', 'data-item': item.id }) : null
  if (sketch) sketch.innerHTML = sketchOf(item.sketch)
  const status = item.planned ? 'Planned' : null
  const node = el('article', { class: 'cat-item', id: `cat-${item.id}`, 'aria-labelledby': `cat-h-${item.id}`, 'data-planned': item.planned || null }, [
    el('header', { class: 'cat-item-head' }, [el('h3', { class: 'cat-item-title', id: `cat-h-${item.id}`, text: item.title }), status ? el('span', { class: 'cat-status', text: status }) : null, el('code', { class: 'cat-id', text: item.id })]),
    item.use ? el('p', { class: 'cat-use' }, [el('span', { class: 'cat-use-label', text: 'Use it when ' }), item.use]) : null,
    el('p', { class: 'cat-about', text: item.about }),
    item.params?.length ? el('dl', { class: 'cat-params' }, item.params.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])) : null,
    slot,
    sketch,
    el('div', { class: 'cat-acts' }, [
      el('button', { type: 'button', class: 'cat-quiet', 'aria-expanded': 'false', text: 'Ask about this', onclick: toggle(ask, notes) }),
      el('button', { type: 'button', class: 'cat-quiet', 'aria-expanded': 'false', onclick: toggle(notes, ask) }, ['Notes ', el('span', { class: 'cat-count' })]),
    ]),
    ask,
    notes,
  ])
  return node
}

/** The whole page, built once. */
export function catalogueNode(sections = catalogue()) {
  const back = el('button', { type: 'button', class: 'act cat-back', text: 'Back to the conversation', onclick: () => closeCatalogue({ show: true }) })
  const scroller = el('div', { class: 'cat-scroll', tabindex: '-1' })
  const top = sections.filter((s) => !s.hood)
  const hood = el('details', { class: 'cat-hood', id: 'cat-hood' }, [el('summary', { class: 'cat-hood-title' }, [el('span', { text: 'Under the hood' }), el('span', { class: 'cat-hood-said', text: 'forms, archetypes, parts, views, cards and the walk, in the engine’s own terms' })])])
  const go = (target, open = false) => () => {
    if (open) hood.open = true
    const at = scroller.querySelector(target)
    // The scroller alone: scrollIntoView would also scroll the board the card stands on.
    if (at) scroller.scrollTo({ top: at.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 52, behavior: matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  // The idioms by name, then the way under the hood.
  const index = el('nav', { class: 'cat-index', 'aria-label': 'Catalogue sections' }, [
    ...top.flatMap((s) => s.items.map((i) => el('button', { type: 'button', class: 'cat-quiet', 'data-planned': i.planned || null, text: i.title, onclick: go(`[id="cat-${i.id}"]`) }))),
    el('button', { type: 'button', class: 'cat-quiet', text: 'Under the hood', onclick: go('#cat-hood', true) }),
  ])
  const sectionNode = (s) =>
    el('section', { class: 'cat-section', id: `cat-s-${s.id}`, 'aria-labelledby': `cat-sh-${s.id}` }, [
      el(s.hood ? 'h3' : 'h2', { class: s.hood ? 'cat-group cat-hood-section' : 'cat-section-title', id: `cat-sh-${s.id}`, text: s.title }),
      el('p', { class: 'cat-section-about', text: s.about }),
      ...groupItems(s.items),
    ])
  hood.append(...sections.filter((s) => s.hood).map(sectionNode))
  scroller.append(
    el('header', { class: 'cat-head' }, [
      el('div', { class: 'cat-head-line' }, [el('h2', { class: 'cat-title', text: 'Catalogue' }), back]),
      el('p', { class: 'cat-lede', text: 'The ways Gnomon can show an answer, each with one example drawn from made-up rows. Ask about any of them, or leave it a note.' }),
    ]),
    // A child of the scroller, not of the head: sticky holds only inside its parent.
    index,
    ...top.map(sectionNode),
    hood,
  )
  return el('section', { class: 'catalogue', id: 'catalogue', 'aria-label': 'Catalogue', hidden: true }, [scroller])
}

/** Parts come grouped by archetype: a subhead where the group changes. */
function groupItems(items) {
  let last = null
  return items.flatMap((item) => {
    const head = item.group && item.group !== last ? el('h4', { class: 'cat-group', text: item.group }) : null
    last = item.group ?? last
    return [head, itemNode(item)].filter(Boolean)
  })
}

/** Watch the demo slots: each is drawn the first time it comes near the view. */
function observe(node) {
  const slots = node.querySelectorAll('.cat-demo:not(.cat-planned)')
  if (typeof IntersectionObserver !== 'function') return
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        observer.unobserve(e.target)
        void mountDemo(e.target, e.target.demo)
      }
    },
    { root: node.querySelector('.cat-scroll'), rootMargin: '240px 0px' },
  )
  for (const s of slots) observer.observe(s)
}

/** Open the catalogue in the conversation's place: the board's chat card, or the overlay's dock. */
export function openCatalogue() {
  const ghost = document.getElementById('ghost')
  if (!ghost) return
  if (!root) {
    sheet()
    root = catalogueNode()
    ghost.append(root)
    observe(root)
  }
  hooks.show?.()
  root.hidden = false
  ghost.dataset.catalogue = ''
  void refresh()
  if (location.hash !== '#catalogue') history.replaceState(history.state, '', '#catalogue')
  root.querySelector('.cat-scroll')?.focus({ preventScroll: true })
}

/** Back to the thread. `show` also brings the conversation forward and gives it the cursor. */
export function closeCatalogue({ show = false } = {}) {
  if (!root || root.hidden) return
  root.hidden = true
  delete document.getElementById('ghost')?.dataset.catalogue
  if (location.hash === '#catalogue') history.replaceState(history.state, '', location.pathname + location.search)
  if (show) {
    hooks.show?.()
    document.getElementById('input')?.focus({ preventScroll: true })
  }
}

export const catalogueOpen = () => Boolean(root && !root.hidden)

/** The catalogue's own sheet, once; the entry needs it from the first frame. */
const sheet = () => document.querySelector('link[href$="/catalogue.css"]') ?? document.head.append(el('link', { rel: 'stylesheet', href: '/gnomon/app/catalogue.css' }))

/**
 * The thread picker's entry, for app.js to put above the threads, with what it
 * lends: `pick` closes the list, `say` and `show` as in `wireCatalogue`. The
 * list opening again closes the catalogue (the owner is choosing a thread),
 * and `#catalogue` in the URL opens it once the page has booted, or when
 * the hash changes to it.
 */
export function catalogueEntry({ pick, ...lent } = {}) {
  sheet()
  wireCatalogue(lent)
  const picker = document.getElementById('thread-picker')
  if (picker) new MutationObserver(() => !picker.hidden && closeCatalogue()).observe(picker, { attributes: true, attributeFilter: ['hidden'] })
  // After the importing module has run (its hooks are not ready inside this call), not on `load`, which a live stream can hold back.
  if (location.hash === '#catalogue') setTimeout(openCatalogue, 0)
  addEventListener('hashchange', () => location.hash === '#catalogue' && openCatalogue())
  return el('button', { type: 'button', class: 'cat-entry', title: 'What Sundial can draw, with live demos', onclick: () => (pick?.(), openCatalogue()) }, [
    el('span', { class: 'cat-entry-name', text: 'Catalogue' }),
    el('span', { class: 'cat-entry-said', text: 'forms, scenes, parts and views, base to complex' }),
  ])
}

// Comments written elsewhere (another tab, Gnomon) arrive with the board.
onChange(() => catalogueOpen() && void refresh())
