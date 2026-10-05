/**
 * One reader for every pane, and the rule for WHEN a pane reads.
 *
 * The board draws 29 cards and each used to fetch its own route the moment it
 * was built — at boot, all of them, whether or not the owner could see them.
 * The harness is one thread over a synchronous SQLite, so those reads cannot
 * overlap: they queue. Measured on the live record that was ~5 seconds of
 * board sitting blank, four of the routes fetched TWICE because two cards
 * wanted the same reading and neither knew about the other, and the same 5
 * seconds again on every 30-second beat for as long as the tab stayed open.
 *
 * Two rules fix all three, and neither needs the panes to know about each
 * other:
 *
 *   `read`         — one request per URL in flight, and a short memory after,
 *                    so two cards asking at once cost one read.
 *   `whenVisible`  — a card reads when it comes into view, not before, and
 *                    re-reads only while it is still in view.
 *   `markStale`    — and it re-reads only when the record moved in a table its
 *                    own reading is made of. `TABLES_BY_ROUTE` is the map; the
 *                    kernel names the tables, so there is no second vocabulary
 *                    to keep in step with the schema.
 *
 * `read` also announces what is in flight, which is what the head's reading
 * line draws. A page that is waiting should say what it is waiting for.
 */

/**
 * Which tables a route's reading is made of.
 *
 * This is the whole client half of the live channel. The kernel names the
 * tables it wrote (`tablesTouched`), this says which routes those tables
 * belong to, and a card re-reads only when its own reading moved. Matching is
 * by prefix, so `/gnomon/shape?days=14` finds `/gnomon/shape`.
 *
 * `state` is not a table; it is the fold's own shape, which almost every
 * reading is partly made of.
 *
 * A route missing from this map is never invalidated by a change — it keeps
 * the short `read` memory and nothing more. That is the safe direction to be
 * wrong in: a stale card, not a storm of reads.
 */
const TABLES_BY_ROUTE = {
  '/gnomon/today': ['moments', 'knowledge_entries', 'state'],
  '/gnomon/day': ['moments', 'knowledge_entries', 'state'],
  '/gnomon/dial': ['moments'],
  '/gnomon/shape': ['moments'],
  // The arcs come from `moments` and the watched underlay from `signals`,
  // which is deliberately NOT listed for the same reason the asks route does
  // not list it: a 443k-row log changes on every window title. A day's arc
  // moves when a moment closes, and that is the table named.
  '/gnomon/rhythm': ['moments'],
  '/gnomon/trace': ['signals', 'moments'],
  // Not `knowledge_entries`/`memory_embeddings`, which were listed here and
  // never read, and not `signals`/`moments`, which the proof join touches: a
  // fact's source moment is in its own past and cannot move, so re-reading 221
  // entities on every window change would buy nothing.
  '/gnomon/memory': ['entities', 'entity_facts'],
  '/gnomon/people': ['entities', 'entity_facts'],
  '/gnomon/habits': ['moments', 'state'],
  '/gnomon/reach': ['moments', 'entities', 'state'],
  '/gnomon/goals': ['state', 'predictions'],
  // `ask_threads` came off with the split — the asks route no longer reads it.
  // Deliberately NOT `signals`, although the route reads two kinds of them: a
  // verdict and an answer event both land there, and so does everything else
  // in a 443k-row log, so listing it would re-read this card on every beat for
  // a window title. An answer also writes its `owner_asks` row and a route
  // writes `entity_facts`, which covers both changes the card can show.
  '/gnomon/asks': ['owner_asks', 'entity_facts'],
  '/gnomon/unsaid': ['gate_decisions', 'state'],
  '/gnomon/calibration': ['predictions', 'gate_decisions'],
  '/gnomon/lab': ['predictions', 'gate_decisions'],
  '/gnomon/trust': ['entity_facts', 'knowledge_entries', 'predictions'],
  '/gnomon/ledger': ['llm_audit'],
  '/gnomon/shelf': ['knowledge_entries', 'state'],
  '/gnomon/assistant/proposals': ['state'],
  '/gnomon/attribution/proposals': ['state', 'projects'],
}

/** The tables a URL's reading depends on, or `null` when the route named none. */
const tablesFor = (url) => {
  const path = url.split('?')[0]
  return TABLES_BY_ROUTE[path] ?? null
}

/** Did `tables` (from a `stale` frame) move anything this URL (or any of these URLs) is made of? */
const affects = (tables, url) =>
  [].concat(url).some((one) => {
    const mine = tablesFor(one)
    return mine !== null && mine.some((table) => tables.includes(table))
  })

/** URL → the promise currently fetching it. */
const inflight = new Map()
/** URL → { at, value } for the last answer, honoured for `maxAge`. */
const recent = new Map()
const watchers = new Set()

/** `/gnomon/api/sessions?x=1` → `sessions`. The name the owner would use. */
const label = (url) =>
  url
    .replace(/^\/gnomon\//, '')
    .replace(/^api\//, '')
    .split('?')[0]
    .split('/')
    .pop()

const announce = () => {
  const names = [...new Set([...inflight.keys()].map(label))]
  for (const watch of watchers) watch(names)
}

/** Called with the names of the routes now in flight, every time that changes. */
export function onReading(watch) {
  watchers.add(watch)
  return () => watchers.delete(watch)
}

/**
 * Read a JSON route.
 *
 * `maxAge` is deliberately short. It exists to collapse the boot stampede and
 * a pane redrawn a moment later, NOT to keep a reading around: the beat is 30
 * seconds and must always see the record as it is.
 */
export function read(url, { maxAge = 2000 } = {}) {
  const hit = recent.get(url)
  if (hit !== undefined && Date.now() - hit.at < maxAge) return Promise.resolve(hit.value)
  const running = inflight.get(url)
  if (running !== undefined) return running

  const request = fetch(url, { headers: { accept: 'application/json' } })
    .then((response) => {
      if (response.status === 401) sayOut()
      if (!response.ok) throw new Error(String(response.status))
      return response.json()
    })
    .then((value) => {
      recent.set(url, { at: Date.now(), value })
      return value
    })
    .finally(() => {
      inflight.delete(url)
      announce()
    })
  inflight.set(url, request)
  announce()
  return request
}

// ── Signed out ─────────────────────────────────────────────────────────────
// dsh's session cookie ends after 30 days. A tab left open past that went quiet
// with no word: every read answered 401 and the live channel closed. Noticed
// here, once per page; app.js draws the one line that says what to do.
let out = false
function sayOut() {
  if (out || typeof document === 'undefined') return
  out = true
  document.dispatchEvent(new CustomEvent('gnomon:signed-out'))
}

/**
 * The live channel failed: signed out, or only a restart? An EventSource cannot
 * see the status it was refused with, so ask one guarded route. A network error
 * is a restart, and the browser reconnects the channel on its own.
 */
export function checkSignedIn() {
  if (out) return Promise.resolve(false)
  return fetch('/gnomon/api/board', { headers: { accept: 'application/json' } }).then(
    (response) => {
      if (response.status === 401) sayOut()
      return response.status !== 401
    },
    () => true,
  )
}

// ── When a card reads ──────────────────────────────────────────────────────

/** node → { run, on, done, url }. Weak, so a removed card's entry goes with it. */
const watched = new WeakMap()
/** The same entries, iterable, so a `stale` frame can find the cards it concerns. Pruned when a node leaves the page. */
const cards = new Set()

// `200px` of margin: the read starts while the card is still off the edge, so
// panning to it finds it already filled rather than mid-read. The board is one
// transformed world, and an IntersectionObserver measures the transformed rect,
// which is why this works on a zoomed, panned canvas without a scroll handler.
const observer =
  typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const state = watched.get(entry.target)
            if (state === undefined) continue
            // A node that left the page was pruned from `cards`; the same node can come back (Today's parts are kept per day).
            cards.add(state)
            state.on = entry.isIntersecting
            if (entry.isIntersecting && !state.done) {
              state.done = true
              state.run()
            }
          }
        },
        { rootMargin: '200px' },
      )
    : null

/**
 * Run `load` the first time `node` is on screen.
 *
 * Returns a predicate: whether the node is on screen NOW. The beat asks it
 * before re-reading, so a card parked in a far corner of the board costs
 * nothing until the owner goes there.
 *
 * With no IntersectionObserver (no such browser today, but the board must not
 * go blank if there ever is one) it loads at once and always reports visible —
 * the old behaviour, which was correct and only slow.
 */
/** `url` may be one route or a list of them, for a card made of several readings. */
export function whenVisible(node, load, url = null) {
  if (observer === null) {
    load()
    return () => true
  }
  const entry = { node, run: load, on: false, done: false, url }
  watched.set(node, entry)
  cards.add(entry)
  observer.observe(node)
  return () => watched.get(node)?.on === true
}

/**
 * A `stale` frame landed: the record moved in these tables.
 *
 * Two things happen, in this order. The short memory of any affected route is
 * dropped, so the next read of it cannot be served from before the change. Then
 * every card on screen whose reading is made of one of those tables re-reads —
 * and only those. A card off screen is left alone; it reads when it is panned
 * to, which was already the rule.
 */
/**
 * The board is looking at a different WHEN: every reading on screen is now about
 * the wrong time.
 *
 * Not a table change, so `markStale` cannot express it — nothing in the record
 * moved, the question did. Every remembered reading is dropped and every card
 * on screen re-reads, because there is no such thing as a card the span does
 * not concern.
 */
export function rereadAll() {
  recent.clear()
  for (const card of [...cards]) {
    if (!card.node.isConnected) {
      cards.delete(card)
      continue
    }
    if (!card.on || !card.done) continue
    // The owner asked a new question and the old answer is still drawn: say
    // it is being re-read, or a slow read looks like a frozen card. Only here,
    // not in `markStale` — a live-beat re-read nobody asked for must not flash.
    card.node.setAttribute('aria-busy', 'true')
    Promise.resolve(card.run(true)).finally(() => card.node.removeAttribute('aria-busy'))
  }
}

export function markStale(tables) {
  if (!Array.isArray(tables) || tables.length === 0) return
  for (const url of [...recent.keys()]) if (affects(tables, url)) recent.delete(url)
  for (const card of [...cards]) {
    if (!card.node.isConnected) {
      cards.delete(card)
      continue
    }
    if (card.on && card.done && card.url !== null && affects(tables, card.url)) card.run()
  }
}

/**
 * A card that keeps itself current, for a card built from several readings at
 * once (Kanban, In play, Rhythm, Voice, the parts of Today). They used to read
 * once and then sit there for as long as the tab was open.
 *
 * `build()` draws the card; the node it returns is the one the pane holds for
 * good. After that, while the card is on screen, a `stale` frame naming a table
 * one of `urls` is made of draws it again and moves the new children into the
 * same node. Three rules keep that cheap and calm:
 *
 *   - at most once per `every` ms (the fold names `state` on every window
 *     change; a card of six readings must not follow that), with one trailing
 *     draw so the last change still lands. A new span or a new day (`rereadAll`)
 *     draws at once;
 *   - an identical drawing is not swapped in, so rows do not animate for nothing;
 *   - never under the owner's hand: a field with focus keeps its text.
 *
 * `swap(node, next)` moves the children; a caller that parks something of its
 * own inside the node (Today's live line) passes its own.
 */
export function keepCurrent(node, build, urls, { every = 30_000, swap = (into, next) => into.replaceChildren(...next.childNodes) } = {}) {
  if (!node) return node
  let seen = false
  let last = Date.now()
  let later = 0
  const draw = async () => {
    last = Date.now()
    const active = document.activeElement
    if (active && node.contains(active) && active.matches('input, textarea, select')) return
    const next = await build()
    if (!next || next.innerHTML === node.innerHTML) return
    swap(node, next)
    // A redraw is not an arrival: the sheet keeps its rows still (app.css).
    node.setAttribute('data-redrawn', '')
  }
  whenVisible(
    node,
    (now = false) => {
      clearTimeout(later)
      const first = !seen
      seen = true
      const wait = now === true ? 0 : last + every - Date.now()
      if (wait <= 0) return draw()
      // First sight of a card built a moment ago: there is nothing new to read.
      if (first) return
      later = setTimeout(() => node.isConnected && draw(), wait)
    },
    urls,
  )
  return node
}
