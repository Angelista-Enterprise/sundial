// Every card the board can hold, in one place — what it is called, the one
// question it answers, what it shows, and what it can be set to.
//
// Read by BOTH halves: the client draws titles and instrument menus from it,
// and `plugins/sundial-tools` imports it by path to tell the agent what each card
// is. Before this file the agent saw `inst:goals at (4540, 18)` and guessed the
// rest from the name — and on 2026-09-21 described the Ledger two different
// wrong ways in one hour. Five hand-kept lists (the tool's kinds and tabs, the
// reader's routes, the client's panels and names) had already drifted: `shape`
// existed in the tool and nowhere else, `rhythm` and `lenses` nowhere in it.
//
// Plain data, no DOM: node must be able to import it.
//
// `id` is the board id; a family (`entity:`, `moment:`, `note:`, `web:`,
// `lens:`, `surface:`, `figure:`) ends in a colon and takes a `key`.
// `span: true` means the card follows the board's date span (one span for the
// whole board — the owner asked for global time). `filters` are what ONE card
// can be set to when it is placed or pointed at: each is applied by the card
// and shown on it as a chip, so none is listed that the card cannot honour.
// A list is the allowed values. `owns` names the facts a main card is the one
// home of; no fact is owned twice (a test holds it), and every other card links
// to the owner instead of copying it. Kanban owns none on purpose.

export const CARDS = [
  // ── The day ──────────────────────────────────────────────────────────────
  { id: 'today', owns: ['the day in one sentence', 'the live strip', 'what usually comes next', 'the moment of the day', 'what is next', 'where I left off'], title: 'Today', question: 'What is happening right now — and what does this moment ask?', shows: 'one-sentence brief of the day; the live strip (app, project, moment length, focus, branch, place); the moment of the day and its question answered — in the morning yesterday and where each project was left off, after a switch or a break the project\'s open work, before a meeting who is in it, in the evening a door to the day; what is next; and how many things wait for the owner, linked to Left for you' },
  { id: 'dial', owns: ['the day face', 'focus split', 'minutes per project today', 'meetings today', 'what Gnomon saw', 'the moments of a day', 'files touched'], title: 'The day', group: 'today', question: 'How did the day go?', shows: 'the sundial (energy by hour, meetings, deep blocks), the focus bar, minutes and commits per project, how much Gnomon noticed (linked to Voice), what Gnomon saw (watched vs active, how much it understood, apps, commands, what it heard), every moment of the day as a table (newest first, each opens), and the files touched', span: true, filters: { date: 'a day, YYYY-MM-DD — draws that day instead of the board span' } },
  { id: 'shelf', owns: ['shelf items waiting', 'untracked time', 'suggestions waiting', 'drafts waiting', 'open questions'], title: 'Left for you', group: 'today', question: 'What waits on my verdict?', shows: 'only what still waits: finished work from jobs, untracked time to file, Gnomon\'s suggestions, drafts to send, and Gnomon\'s open questions — with what is already answered folded under one line' },
  { id: 'play', owns: ['open commitments', 'goals'], title: 'In play', question: 'What am I in the middle of, and what am I aiming at?', shows: 'every open commitment (branches and promises heard aloud), active first, quiet ones faded, with Done for a promise; and the goals with their steps and trail, and a way to add one', filters: { project: 'a project name — only its commitments' } },
  { id: 'rhythm', owns: ['the fortnight by hour', 'the days as a table', 'day arcs', 'bedtime', 'switches', 'rituals', 'day end', 'what recurs'], title: 'Rhythm', question: 'What do my days look like over time?', keywords: 'strata energy hours week days arc sleep bedtime wake switching focus habits rituals routines recurring usual', shows: 'the fortnight by hour (energy, meetings, deep seams), the days as a table (active hours, commits, switches, shell failures, interruptions), day arcs and bedtime by week, context switches and the apps behind them, what usually comes next, rituals, when the day ends and what recurs', span: true, filters: { view: ['strata', 'days', 'arcs', 'habits'] } },
  { id: 'voice', owns: ['noticing decisions', 'said held dropped', 'question history'], title: 'Voice', question: 'What did Gnomon notice, say or hold back — and what did it ask me?', keywords: 'noticing gate bar weight quiet said dropped held threshold notices questions answers asks interruptions', shows: 'each noticing decision with its weight against the bar, habituation and budget; what it said, held and dropped, with reasons; and every question it asked with the answer and the fact drawn from it', span: true, filters: { view: ['noticing', 'asks'] } },
  { id: 'kanban', owns: [], title: 'Kanban', question: 'Everything open, at a glance', shows: 'columns: goals, commitments being worked on, what waits on the owner, quiet commitments, shelved results — an overview whose rows open the card that owns each' },

  // ── Gnomon itself ────────────────────────────────────────────────────────
  { id: 'chat', title: 'Gnomon', question: 'The conversation', shows: 'the chat transcript, thread list, context meter, Listen and Ask/Auto chips' },
  { id: 'threads', title: 'Threads', question: 'Which conversations have we had?', shows: 'the list of chat threads' },
  { id: 'work', owns: ['the running job', 'job history', 'wake-ups', 'what Gnomon can do'], title: 'Work', question: 'What is Gnomon doing for me — and what can it do?', keywords: 'jobs background working plan wakeups reminders coming up what can you do capabilities tools help examples', shows: 'the running job and its plan, where the work stands, other jobs and their tool calls, the wake-ups it has set itself (time and reason), and what it can do — groups with example questions and a count of its tools', filters: { view: ['now', 'history', 'wakeups', 'can'], job: 'a job id — its row in Other jobs is marked' } },
  { id: 'engine', owns: ['llm cost', 'coverage and trust', 'calibration', 'experiments', 'tools', 'effect journal'], title: 'Engine room', question: 'Is Gnomon working, affordable and honest?', keywords: 'ledger cost spend tokens dollars budget failures latency trust sensors coverage privacy redaction calibration forecast brier lab experiments reach tools permissions integrations trace effects rules machinery', shows: 'tabs — cost: LLM calls, failures, latency, tokens and list-price dollars by purpose and model against today\'s budget (not verdicts or actions); trust: how much it saw and understood, sensors, redaction, the belief audit; calibration: how good its forecasts are; lab: what it is testing about itself; reach: every tool, which were used, the Ask/Auto rungs; trace: every effect with its cause', span: true, filters: { tab: ['cost', 'trust', 'calibration', 'lab', 'reach', 'trace'] }, routes: { trust: '/gnomon/trust', calibration: '/gnomon/calibration', lab: '/gnomon/lab', reach: '/gnomon/reach', trace: '/gnomon/trace' } },
  { id: 'settings', title: 'Settings', question: 'How is Gnomon tuned?', shows: 'autonomy, notice bias with a test bench, auto-advance, motion, paper, blur, permissions, services' },

  // ── Browse ───────────────────────────────────────────────────────────────
  { id: 'explore', owns: ['search', 'entities', 'what was said', 'people', 'merge suggestions', 'saved lenses'], title: 'Explore', question: 'Who and what does Gnomon know — and what was said?', keywords: 'said heard speech transcript spoken meeting standup words', shows: 'search over the record and conversations; every entity Gnomon holds beliefs about, by kind; Said — what was heard near the machine, a day at a time, all day or inside one of the day\'s meetings, narrowed to words; people with the meetings shared, "same as" merge suggestions, unnamed attendees and what is not a person; and the saved lenses', filters: { query: 'words to search for — the card opens with those results', kind: ['person', 'project', 'tool', 'topic', 'goal', 'task'], date: 'a day, YYYY-MM-DD — Said opens on what was heard that day', meeting: 'a meeting title on that day, e.g. Standup — Said shows only what was heard inside it' } },
  { id: 'entity:', title: 'Entity', question: 'What does Gnomon know about this name?', shows: 'current and superseded facts, aliases, and the moments the name appeared in (meeting, said, screen)', key: 'the name' },
  { id: 'moment:', title: 'Moment', question: 'What happened in this stretch?', shows: 'how Gnomon read the moment, its narrative, focus, evidence (titles, screen, heard) and what it cost', key: 'the moment id' },

  // ── Made on the spot ─────────────────────────────────────────────────────
  { id: 'note:', title: 'Note', question: 'A note', shows: 'free text written onto the board' },
  { id: 'web:', title: 'Web page', question: 'A web page', shows: 'a page excerpt and the page itself', key: 'the url' },
  { id: 'browser:', title: 'Gnomon\'s browser', question: 'What is Gnomon doing on a web page?', shows: 'a page Gnomon keeps open in its own browser, live, with the step it just took there; the owner can click, type and scroll in it (which is also how they log in)', key: 'the page id' },
  { id: 'lens:', title: 'Lens', question: 'A live question over the record', shows: 'rows a lens spec draws, re-read as the record changes', key: 'the lens name' },
  { id: 'surface:', title: 'Surface', question: 'A drawn answer', shows: 'a grid, chart or flow Gnomon drew in an answer' },
  { id: 'figure:', title: 'Figure', question: 'A drawn answer', shows: 'a chart Gnomon composed in an answer' },

]

/**
 * Cards folded into another (Phase 3). A retired card still on a board is
 * replaced by the card that now owns its facts, once, by the client.
 */
export const RETIRED = {
  proposals: 'shelf',
  'inst:goals': 'play',
  activity: 'dial',
  'inst:day': 'dial',
  week: 'rhythm',
  'inst:strata': 'rhythm',
  'inst:rhythm': 'rhythm',
  'inst:habits': 'rhythm',
  'inst:memory': 'explore',
  'inst:people': 'explore',
  'inst:lenses': 'explore',
  'inst:unsaid': 'voice',
  'inst:asks': 'voice',
  ledger: 'engine',
  mood: 'voice',
  'inst:trust': { id: 'engine', filters: { tab: 'trust' } },
  'inst:calibration': { id: 'engine', filters: { tab: 'calibration' } },
  'inst:lab': { id: 'engine', filters: { tab: 'lab' } },
  'inst:reach': { id: 'engine', filters: { tab: 'reach' } },
  'inst:trace': { id: 'engine', filters: { tab: 'trace' } },
}

/** Where a retired id went: its heir's id, and the filters that open the heir on the same view. */
export const heirOf = (id) => {
  const heir = RETIRED[id]
  return heir === undefined ? null : typeof heir === 'string' ? { id: heir, filters: null } : heir
}

/** The catalog entry for a board id: exact, else its family (`entity:x` → `entity:`). */
export function cardOf(id) {
  const s = String(id ?? '')
  return CARDS.find((c) => c.id === s) ?? CARDS.find((c) => c.id.endsWith(':') && !c.id.startsWith('inst:') && s.startsWith(c.id)) ?? null
}

/** The Engine room's tabs past cost → the route each reads, for its pane and its reading both. */
export const INSTRUMENT_ROUTES = CARDS.find((c) => c.id === 'engine').routes

/** Those tab keys, in order. */
export const INSTRUMENT_KEYS = Object.keys(INSTRUMENT_ROUTES)

/** The cards the foot's Cards menu and Find list by name, in reading order. */
export const MENU = ['dial', 'shelf', 'play', 'rhythm', 'explore', 'work', 'voice', 'engine', 'kanban']

/** The day's parts beside Today, in order. */
export const TODAY_PARTS = CARDS.filter((c) => c.group === 'today').map((c) => [c.id, c.title])

/**
 * One line the agent reads per card on the board: what it is and what it
 * answers. The key of a family card (the entity's name, the moment's start)
 * rides along, because `moment:01M36…` alone says nothing.
 */
export function describeCard(id, placed = null) {
  const card = cardOf(id)
  if (!card) return `${id} — a card with no catalog entry`
  const key = card.id.endsWith(':') ? String(id).slice(card.id.length) : ''
  const label = card.id === 'moment:' ? `Moment at ${momentTime(key) ?? key}` : key && ['entity:', 'web:', 'lens:'].includes(card.id) ? `${card.title}: ${key}` : card.title
  const question = /[.?!]$/.test(card.question) ? card.question : `${card.question}.`
  const set = placed?.filters ? Object.entries(placed.filters).map(([k, v]) => `${k}=${v}`).join(', ') : ''
  const can = card.filters ? Object.entries(card.filters).map(([k, v]) => (Array.isArray(v) ? `${k} (${v.join(' / ')})` : `${k} (${v})`)).join('; ') : ''
  return `${id} "${label}" — ${question} Shows ${card.shows}.${set ? ` Set to ${set}.` : ''}${can ? ` Filters: ${can}.` : ''}`
}

/**
 * The filters a card accepts, checked: unknown keys and values outside a list
 * are refused with the reason, so the agent hears why instead of a chip that
 * lies. `null` clears.
 */
export function checkFilters(id, filters) {
  if (filters === null) return { ok: true, filters: null }
  const card = cardOf(id)
  const allowed = card?.filters ?? {}
  if (typeof filters !== 'object' || Array.isArray(filters)) return { ok: false, reason: 'filters is an object, e.g. {"date":"2026-09-22"}' }
  for (const [k, v] of Object.entries(filters)) {
    if (!(k in allowed)) return { ok: false, reason: `${card?.title ?? id} takes no "${k}" filter${Object.keys(allowed).length ? ` — it takes ${Object.keys(allowed).join(', ')}` : ' — it takes none'}` }
    if (Array.isArray(allowed[k]) && !allowed[k].includes(String(v))) return { ok: false, reason: `${k} must be one of ${allowed[k].join(', ')}` }
    if (k === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return { ok: false, reason: 'date is YYYY-MM-DD' }
  }
  return { ok: true, filters }
}

/** A ULID's first ten characters are its millisecond clock; a moment id is a ULID. */
function momentTime(id) {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const head = String(id).toUpperCase().slice(0, 10)
  if (head.length < 10) return null
  let ms = 0
  for (const ch of head) {
    const v = A.indexOf(ch)
    if (v < 0) return null
    ms = ms * 32 + v
  }
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 16).replace('T', ' ') + 'Z'
}
