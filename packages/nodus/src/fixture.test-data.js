// A made-up day in the shape `gnomon_today_summary` answers. No value here comes
// from a real record.
export const DAY = {
  date: '2026-03-09',
  timeZone: 'Europe/Amsterdam',
  coverage: { trackedMin: 312, wallClockMin: 400, firstActivity: '2026-03-09T07:12:00.000Z', lastActivity: '2026-03-09T13:40:00.000Z' },
  projects: [
    { name: 'puzzlebox-studio', minutes: 140, momentCount: 12 },
    { name: 'tidewater', minutes: 55, momentCount: 5 },
    { name: 'quiet-repo', minutes: 0, momentCount: 1 },
  ],
  noProjectMin: 117,
  focus: { deepMin: 80, steadyMin: 90, shallowMin: 142 },
  meetings: [
    { title: 'Standup', start: '2026-03-09T08:00:00.000Z', end: '2026-03-09T08:15:00.000Z' },
    { title: 'Planning with Mira Bakker', start: '2026-03-09T10:00:00.000Z', end: '2026-03-09T11:00:00.000Z' },
  ],
  breaks: [{ start: '2026-03-09T11:30:00.000Z', end: '2026-03-09T12:05:00.000Z', durationMin: 35, kind: 'micro' }],
  sessions: [
    { id: '01M6AAAAAAAAAAAAAAAAAAAAA1', start: '2026-03-09T07:15:00.000Z', min: 42, process: 'Code', project: 'puzzlebox-studio', intent: 'Fix the BOX-484 layout bug' },
    { id: '01M6AAAAAAAAAAAAAAAAAAAAA2', start: '2026-03-09T08:20:00.000Z', min: 95, process: 'Code', project: 'puzzlebox-studio' },
    { id: '01M6AAAAAAAAAAAAAAAAAAAAA3', start: '2026-03-09T12:10:00.000Z', min: 50, process: 'Terminal', project: 'tidewater' },
    { id: '01M6AAAAAAAAAAAAAAAAAAAAA4', start: '2026-03-09T13:00:00.000Z', min: 30, process: 'Mail', project: null },
  ],
  sessionCount: 4,
}

// One made-up scene per archetype, the blueprints a model would write: kinds and
// links, never a position. Shared by the scene tests and the browser check.
const step = (focus, say) => ({ focus, say })
export const SCENES = {
  system: {
    v: 1, form: 'scene', archetype: 'system', title: 'Inside a raindrop',
    lanes: [
      { id: 'sun', label: 'Sunlight', kind: 'sun', state: 'lit' },
      { id: 'drop', label: 'Raindrop', kind: 'droplet', value: 2 },
      { id: 'bow', label: 'Rainbow', kind: 'rainbow' },
      { id: 'eye', label: 'You', kind: 'observer', door: 'search:rainbow' },
      { id: 'cloud', label: 'Cloud', kind: 'cloud' },
    ],
    links: [{ from: 'sun', to: 'drop', kind: 'ray' }, { from: 'drop', to: 'bow', kind: 'cause' }, { from: 'bow', to: 'eye', kind: 'ray' }],
    steps: [step(['sun'], 'Sunlight enters the raindrop and bends.'), step(['drop'], 'Inside the raindrop it reflects off the back.'), step(['bow', 'eye'], 'Each colour leaves at its own angle, so you see a rainbow.')],
  },
  orbital: {
    v: 1, form: 'scene', archetype: 'orbital', title: 'Our solar system',
    lanes: [
      { id: 'sun', label: 'Sun', kind: 'center', value: 1000 },
      { id: 'mercury', label: 'Mercury', kind: 'body', value: 3 },
      { id: 'venus', label: 'Venus', kind: 'body', value: 8 },
      { id: 'earth', label: 'Earth', kind: 'body', value: 10, door: 'search:earth' },
      { id: 'moon', label: 'Moon', kind: 'moon', value: 1 },
      { id: 'mars', label: 'Mars', kind: 'body', value: 5 },
      { id: 'jupiter', label: 'Jupiter', kind: 'body', value: 300 },
      { id: 'saturn', label: 'Saturn', kind: 'body', value: 95 },
      { id: 'rings', label: 'Saturn rings', kind: 'ring' },
    ],
    links: [{ from: 'mercury', to: 'sun', kind: 'orbit' }, { from: 'venus', to: 'sun', kind: 'orbit' }, { from: 'sun', to: 'earth', kind: 'orbit' }, { from: 'moon', to: 'earth', kind: 'orbit' }, { from: 'mars', to: 'sun', kind: 'orbit' }, { from: 'jupiter', to: 'sun', kind: 'orbit' }, { from: 'saturn', to: 'sun', kind: 'orbit' }, { from: 'rings', to: 'saturn', kind: 'orbit' }],
    steps: [step(['sun'], 'The Sun holds everything here by its pull.'), step(['earth', 'moon'], 'Earth takes a year to go round, the Moon a month round Earth.'), step(['jupiter'], 'Jupiter outweighs every other planet put together.')],
  },
  fluid: {
    v: 1, form: 'scene', archetype: 'fluid', title: 'How a heat pump works',
    lanes: [
      { id: 'air', label: 'Outside air', kind: 'source', state: 'cold' },
      { id: 'evap', label: 'Evaporator', kind: 'tank', state: 'gas', value: 4 },
      { id: 'comp', label: 'Compressor', kind: 'pump' },
      { id: 'cond', label: 'Condenser', kind: 'tank', state: 'hot', value: 6 },
      { id: 'valve', label: 'Expansion valve', kind: 'valve' },
      { id: 'home', label: 'Your home', kind: 'sink', state: 'hot', door: 'search:heating' },
    ],
    links: [{ from: 'air', to: 'evap', kind: 'flow', rate: 2 }, { from: 'evap', to: 'comp', kind: 'flow', rate: 4 }, { from: 'comp', to: 'cond', kind: 'flow', rate: 4 }, { from: 'cond', to: 'home', kind: 'flow', rate: 3 }, { from: 'cond', to: 'valve', kind: 'flow', rate: 4 }, { from: 'valve', to: 'evap', kind: 'flow', rate: 4 }],
    steps: [step(['air', 'evap'], 'The evaporator takes heat from the outside air, even cold air.'), step(['comp'], 'The compressor squeezes the gas until it is hot.'), step(['cond', 'home'], 'The condenser gives that heat to your home.')],
  },
  mechanism: {
    v: 1, form: 'scene', archetype: 'mechanism', title: 'A clock train',
    lanes: [
      { id: 'motor', label: 'Drive gear', kind: 'gear', value: 12, state: 'driving' },
      { id: 'mid', label: 'Middle gear', kind: 'gear', value: 36 },
      { id: 'small', label: 'Pinion', kind: 'gear', value: 8 },
      { id: 'big', label: 'Hour wheel', kind: 'gear', value: 48 },
      { id: 'hand', label: 'Hand shaft', kind: 'shaft' },
      { id: 'pull', label: 'Belt wheel', kind: 'gear', value: 20 },
    ],
    links: [{ from: 'motor', to: 'mid', kind: 'mesh' }, { from: 'mid', to: 'small', kind: 'mesh' }, { from: 'small', to: 'big', kind: 'mesh' }, { from: 'big', to: 'hand', kind: 'push' }, { from: 'motor', to: 'pull', kind: 'belt' }],
    steps: [step(['motor'], 'The drive gear turns fast with few teeth.'), step(['mid', 'small'], 'The middle gear slows it, and the pinion passes it on.'), step(['big', 'hand'], 'The hour wheel turns the hand shaft once an hour.')],
  },
  clock: {
    v: 1, form: 'scene', archetype: 'clock', title: 'A Tuesday round the dial',
    lanes: [
      { id: 'face', label: 'The day', kind: 'dial', shape: 'day' },
      { id: 'stand', label: 'Standup', kind: 'event', start: 9, end: 9.25, state: 'done' },
      { id: 'deep', label: 'Deep work', kind: 'event', start: 9.5, end: 12, state: 'done' },
      { id: 'lunch', label: 'Lunch', kind: 'event', start: 12, end: 13, state: 'done' },
      { id: 'review', label: 'Review', kind: 'event', start: 13, end: 14.5, state: 'now' },
      { id: 'pair', label: 'Pairing', kind: 'event', start: 14, end: 15.5, state: 'next' },
      { id: 'gym', label: 'Gym', kind: 'event', start: 18, end: 19.5, state: 'missed' },
      { id: 'sleep', label: 'Sleep', kind: 'event', start: 23, end: 7 },
      { id: 'train', label: 'Train in', kind: 'marker', start: 8.25 },
      { id: 'now', label: 'Now', kind: 'hand', start: 14.2 },
    ],
    links: [{ from: 'review', to: 'pair', kind: 'clash' }],
    steps: [step(['deep'], 'Deep work held the morning, two and a half hours.'), step(['review', 'pair'], 'Review runs into Pairing for half an hour.'), step(['gym'], 'Gym was missed.')],
  },
  route: {
    v: 1, form: 'scene', archetype: 'route', title: 'The way to work',
    lanes: [
      { id: 'home', label: 'Home', kind: 'start' },
      { id: 'corner', label: 'Bakery corner', kind: 'turn', value: 0.4 },
      { id: 'station', label: 'Station', kind: 'stop', value: 0.8, state: 'done' },
      { id: 'change', label: 'Change trains', kind: 'stop', value: 9, state: 'now' },
      { id: 'office', label: 'Office', kind: 'end', value: 5 },
    ],
    links: [{ from: 'home', to: 'corner', kind: 'leg', label: '4 min walk' }, { from: 'corner', to: 'station', kind: 'leg', label: '8 min walk' }, { from: 'station', to: 'change', kind: 'leg', label: '14 min train' }, { from: 'change', to: 'office', kind: 'leg', label: '9 min train' }],
    steps: [step(['home', 'station'], 'From Home to the Station is twelve minutes on foot.'), step(['change'], 'Change trains halfway; the second train is shorter.'), step(['office'], 'The Office is 35 minutes from the door.')],
  },
  plan: {
    v: 1, form: 'scene', archetype: 'plan', title: 'Home, room by room',
    lanes: [
      { id: 'living', label: 'Living room', kind: 'room', value: 32 },
      { id: 'kitchen', label: 'Kitchen', kind: 'room', value: 14 },
      { id: 'bed', label: 'Bedroom', kind: 'room', value: 16 },
      { id: 'study', label: 'Study', kind: 'room', value: 10 },
      { id: 'bath', label: 'Bathroom', kind: 'room', value: 7 },
      { id: 'hall', label: 'Hall', kind: 'room', value: 6 },
      { id: 'lamp', label: 'Floor lamp', kind: 'device', state: 'on' },
      { id: 'speaker', label: 'Speaker', kind: 'device', state: 'off' },
      { id: 'thermo', label: 'Thermostat', kind: 'device', state: 'on' },
      { id: 'door', label: 'Front door', kind: 'device', state: 'closed' },
      { id: 'night', label: 'Night light', kind: 'device', state: 'off' },
    ],
    links: [{ from: 'lamp', to: 'living', kind: 'in' }, { from: 'speaker', to: 'kitchen', kind: 'in' }, { from: 'thermo', to: 'hall', kind: 'in' }, { from: 'door', to: 'hall', kind: 'in' }, { from: 'night', to: 'bed', kind: 'in' }, { from: 'living', to: 'kitchen', kind: 'adjacent' }],
    steps: [step(['living', 'lamp'], 'The Living room is the largest, its floor lamp on.'), step(['hall', 'thermo', 'door'], 'The Hall holds the thermostat and the front door.'), step(['bed', 'night'], 'The Bedroom night light is off.')],
  },
}

// Made-up rows in the shapes `gnomon_open_commitments` and `gnomon_people` answer.
export const OPEN = {
  total: 4,
  commitments: [
    { name: 'box-484', projectName: 'puzzlebox-studio', activeDays: 5, lastTouchedAt: '2026-03-08T10:00:00Z', promise: { counterparty: 'Mira Bakker' } },
    { name: 'box-490', projectName: 'puzzlebox-studio', activeDays: 2, lastTouchedAt: '2026-03-09T10:00:00Z' },
    { name: 'tide-fix', projectName: 'tidewater', activeDays: 1, lastTouchedAt: '2026-03-07T10:00:00Z' },
    { name: 'tax return', projectName: null, activeDays: 3, lastTouchedAt: '2026-03-06T10:00:00Z' },
  ],
}
export const PEOPLE = [
  { name: 'Mira Bakker', id: 'person:mira-bakker', named: true, factCount: 6, metWith: 4 },
  { name: null, id: 'person:person-0000000000', named: false, factCount: 1, metWith: 1 },
  { name: 'Pat Doe', id: 'person:pat-doe', named: true, factCount: 1, metWith: 1 },
  { name: 'Ida Sol', id: 'person:ida-sol', named: true, factCount: 3, metWith: 0 },
]

// The parts plate: every kind of each archetype on one plate at one scale, like
// a maker's spec sheet. Unlinked where joints would hide a part; the catalogue
// shows them under the hood, the browser check draws them for a close look.
const part = (id, kind, extra = {}) => ({ id, label: extra.label ?? id[0].toUpperCase() + id.slice(1), kind, ...extra })
export const PLATES = {
  system: {
    v: 1, form: 'scene', archetype: 'system', title: 'Parts plate: light, weather and things',
    lanes: [part('sun', 'sun', { state: 'lit' }), part('cloud', 'cloud'), part('rain', 'rain'), part('droplet', 'droplet'), part('rainbow', 'rainbow'), part('observer', 'observer', { label: 'Observer' }), part('prism', 'prism'), part('tree', 'field', { shape: 'tree', label: 'Tree' }), part('forest', 'field', { shape: 'forest', label: 'Forest' }), part('hill', 'contour', { shape: 'hill', label: 'Hill' }), part('floor', 'stack', { label: 'Floor' }), part('roof', 'stack', { label: 'Upper floor' })],
    links: [], steps: [step(['droplet'], 'The droplet bends light into its colours.')],
  },
  fluid: {
    v: 1, form: 'scene', archetype: 'fluid', title: 'Parts plate: vessels and fittings',
    lanes: [part('source', 'source', { label: 'Source' }), part('tank', 'tank', { value: 4, label: 'Tank' }), part('hot', 'tank', { value: 9, state: 'hot', label: 'Hot tank' }), part('pump', 'pump'), part('valve', 'valve'), part('reservoir', 'reservoir', { value: 6 }), part('sink', 'sink')],
    links: [{ from: 'source', to: 'pump', kind: 'flow', rate: 3 }, { from: 'pump', to: 'tank', kind: 'flow', rate: 2 }, { from: 'pump', to: 'hot', kind: 'flow', rate: 3 }, { from: 'tank', to: 'valve', kind: 'flow', rate: 2 }, { from: 'hot', to: 'reservoir', kind: 'flow', rate: 3 }, { from: 'valve', to: 'sink', kind: 'flow', rate: 1 }],
    steps: [step(['pump'], 'The pump drives the flow into each tank.')],
  },
  mechanism: {
    v: 1, form: 'scene', archetype: 'mechanism', title: 'Parts plate: gears and linkages',
    lanes: [part('drive', 'gear', { value: 14, state: 'driving', label: 'Drive gear' }), part('wheel', 'gear', { value: 42, label: 'Wheel' }), part('pinion', 'gear', { value: 9, label: 'Pinion' }), part('shaft', 'shaft'), part('crank', 'crank'), part('lever', 'lever'), part('piston', 'piston')],
    links: [{ from: 'drive', to: 'wheel', kind: 'mesh' }, { from: 'wheel', to: 'pinion', kind: 'mesh' }, { from: 'pinion', to: 'shaft', kind: 'push' }, { from: 'drive', to: 'crank', kind: 'push' }, { from: 'crank', to: 'piston', kind: 'push' }, { from: 'wheel', to: 'lever', kind: 'push' }],
    steps: [step(['drive'], 'The drive gear turns the wheel.')],
  },
  orbital: {
    v: 1, form: 'scene', archetype: 'orbital', title: 'Parts plate: bodies',
    lanes: [part('star', 'center', { state: 'lit', label: 'Star', value: 1000 }), part('planet', 'body', { value: 5, label: 'Planet' }), part('giant', 'body', { value: 60, label: 'Giant' }), part('moon', 'moon', { value: 0.5 }), part('ring', 'ring', { label: 'Ring' })],
    links: [{ from: 'planet', to: 'star', kind: 'orbit' }, { from: 'giant', to: 'star', kind: 'orbit' }, { from: 'moon', to: 'planet', kind: 'orbit' }, { from: 'ring', to: 'giant', kind: 'orbit' }],
    steps: [step(['giant'], 'The giant carries the ring.')],
  },
  // The three idioms that are read whole: their scenes already hold every kind, so the plate is the scene under its plate's name.
  clock: { ...SCENES.clock, title: 'Parts plate: a dial, its events, a marker and the hand' },
  route: { ...SCENES.route, title: 'Parts plate: a start, a turn, stops and an end, joined by legs' },
  plan: { ...SCENES.plan, title: 'Parts plate: rooms and the devices in them' },
}

// Made-up rows in the shape `gnomon_timeline` answers, for the schedule: a calendar line (upcoming too) and the moment a meeting was held in.
export const TIMELINE = {
  rows: [
    { at: '09:00', kind: 'meeting', text: 'Standup 09:00–09:15, 5 invited', id: 'sig-cal-1' },
    { at: '11:00', kind: 'meeting', text: 'Planning with Mira Bakker 11:00–12:00, 2 invited', id: 'sig-cal-2' },
    { at: '11:00', kind: 'meeting', text: 'Zoom 58 min on puzzlebox-studio: in Planning with Mira Bakker', id: '01M6AAAAAAAAAAAAAAAAAAAAM1' },
    { at: '15:00', kind: 'meeting', text: 'Design review 15:00–16:00', id: 'sig-cal-3' },
    { at: '15:30', kind: 'meeting', text: 'Pairing 15:30–16:30, 1 invited', id: 'sig-cal-4' },
    { at: '10:02', kind: 'command', text: '$ pnpm test', id: 'sig-cmd-1' },
  ],
}

// Made-up rows in Home Assistant's shape (areas, and entities with an area and a state), for the plan of a home. Nothing reads Home Assistant yet.
export const HOME = {
  areas: [{ area_id: 'living_room', name: 'Living room', area: 32 }, { area_id: 'kitchen', name: 'Kitchen', area: 14 }, { area_id: 'bedroom', name: 'Bedroom' }, { area_id: 'hall', name: 'Hall' }],
  entities: [
    { entity_id: 'light.floor_lamp', name: 'Floor lamp', area_id: 'living_room', state: 'on' },
    { entity_id: 'media_player.speaker', name: 'Speaker', area_id: 'kitchen', state: 'paused' },
    { entity_id: 'climate.thermostat', name: 'Thermostat', area_id: 'hall', state: 'heat' },
    { entity_id: 'lock.front_door', name: 'Front door', area_id: 'hall', state: 'locked' },
    { entity_id: 'light.night', name: 'Night light', area_id: 'bedroom', state: 'off' },
    { entity_id: 'sensor.garage', name: 'Garage sensor', area_id: 'garage', state: 'on' },
  ],
}

// A ledger and goals in the shapes their tools answer, and the one read every demo draws through.

const LEDGER = {
  from: '2026-03-03',
  to: '2026-03-09',
  days: 7,
  rows: [
    { key: 'chat', calls: 140, costUsd: 3.2 },
    { key: 'nightly', calls: 12, costUsd: 1.1 },
    { key: 'visualize', calls: 18, costUsd: 0.9, failed: 1 },
    { key: 'judge', calls: 610, costUsd: 0.4 },
  ],
}
const GOALS = [
  { goal: 'Ship the tidewater beta', status: 'open', since: '2026-02-12', targetDate: '2026-04-01' },
  { goal: 'Run twice a week', status: 'open', since: '2026-02-27' },
  { goal: 'Read one paper a week', status: 'open', since: '2026-03-05' },
]

const DAY_MS = 86_400_000
/** The fixture day moved to `date`, its minutes varied by the distance, so a week and a comparison have a shape. */
function dayOn(date) {
  const off = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${DAY.date}T12:00:00Z`)) / DAY_MS)
  if (!Number.isFinite(off) || off === 0) return DAY
  const f = 0.45 + (((off * 37) % 10) + 10) % 10 / 12
  const k = (n) => Math.round(n * f)
  return { ...DAY, date, coverage: { ...DAY.coverage, trackedMin: k(DAY.coverage.trackedMin) }, projects: DAY.projects.map((p, i) => ({ ...p, minutes: i === 1 ? k(p.minutes * 1.6) : k(p.minutes) })), noProjectMin: k(DAY.noProjectMin), sessions: [] }
}

/** The tool read every demo draws through: Nodus's own view code, over made-up rows. */
export async function fixtureRead(tool, args = {}) {
  if (tool === 'gnomon_today_summary') return dayOn(typeof args.date === 'string' ? args.date : DAY.date)
  if (tool === 'gnomon_open_commitments') return OPEN
  if (tool === 'gnomon_people') return PEOPLE
  if (tool === 'gnomon_llm_ledger') return LEDGER
  if (tool === 'gnomon_goals') return GOALS
  if (tool === 'gnomon_timeline') return TIMELINE
  return null
}
