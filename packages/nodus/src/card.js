// A Nodus card's body: the headline and its state, the figure on its plate,
// the walk under it. A live lens: the figure re-reads its view when it opens
// and on the board's beat, says what changed since the owner last looked, and
// keeps the last rows it drew when the record cannot be read.
//
// The walk plays itself once, at reading pace, and stops the moment the owner
// touches it; after that the owner sets the pace (Back/Next, or the arrow
// keys with the card focused; Home is the whole figure). Reduced motion never
// plays. A hand on a scene's camera only pauses it: Next walks on.
//
// A figure is placed with the walk from the numbers (`by.pending`, "Reading")
// and the model's walk arrives later as a new text for the same card (the
// board's `sync`): it fades in over the walk, the figure stays put.

import { dwell, focusOf } from './focus.js'
import { drawTimeline } from './render-timeline.js'
import { drawBars, drawGraph, drawStages, drawTable, fitted } from './render-rows.js'
import { drawSceneSvg } from './render-scene-svg.js'
import { drawScene } from './stage.js'
import { loadThree } from './three-loader.js'
import { checkSpec } from './spec.js'
import { fallbackSteps, hm } from './storyboard.js'
import { readView } from './views.js'
import { MODES, modeOf } from './modes/index.js'

export { specOf } from './spec.js'

/**
 * A scene, lazily: "Loading the stage" until three.js is in, then the stage;
 * the flat drawing when it will not load or the page has no WebGL. The walk
 * may light a step before either lands; the last one is replayed on arrival.
 */
function drawSceneLazy(spec) {
  const node = h('div', { class: 'nd-stage-host' }, [h('div', { class: 'reading', text: 'Loading the stage' })])
  let figure = null
  let latest = spec
  let lit = [new Set(), []]
  const swap = (next) => {
    figure?.dispose?.()
    figure = next
    node.replaceChildren(next.node)
    next.focus(...lit)
  }
  loadThree()
    .then((T) => swap(drawScene(latest, { three: T })))
    .catch(() => swap(drawSceneSvg(latest)))
  return {
    node,
    focus: (ids, named, explode) => {
      lit = [ids, named, explode]
      figure?.focus(ids, named, explode)
    },
    // Fresh rows: the stage re-solves and tweens; the flat drawing is drawn again.
    update: (fresh) => {
      latest = fresh
      if (figure?.update) figure.update(fresh)
      else if (figure) swap(drawSceneSvg(fresh))
    },
    snapshot: () => figure?.snapshot?.() ?? null,
    back: () => figure?.back?.(),
    dispose: () => figure?.dispose?.(),
  }
}

// Drawn at the plate's own width (a 380 px dock as the board); a table is HTML and flows by itself.
const DRAW = { timeline: fitted(drawTimeline), bars: fitted(drawBars), graph: fitted(drawGraph), table: drawTable, scene: drawSceneLazy, stages: fitted(drawStages) }
const NS = 'http://www.w3.org/2000/svg'
const svg = (tag, attrs) => {
  const node = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}
const fmt = (v) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-GB') : String(Math.round(v * 10) / 10))

/** A sparkline: the series as one hairline over its own range, the last point in ochre. */
function spark(series) {
  const lo = Math.min(...series)
  const hi = Math.max(...series)
  const W = 120
  const H = 24
  const pts = series.map((v, i) => [(i / (series.length - 1)) * W, H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4)])
  const root = svg('svg', { class: 'nd-spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' })
  root.append(svg('line', { class: 'nd-spark-base', x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }), svg('polyline', { class: 'nd-spark-line', points: pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ') }))
  const [x, y] = pts.at(-1)
  root.append(svg('ellipse', { class: 'nd-spark-dot', cx: x.toFixed(1), cy: y.toFixed(1), rx: 1.6, ry: 1.6 }))
  return root
}

/** The figure's small panels (spec.panels): a sparkline, a number with its unit, or a word; null when it has none. */
export function panelsNode(spec) {
  if (!spec.panels?.length) return null
  return h(
    'div',
    { class: 'nodus-panels' },
    spec.panels.map((p) =>
      h('div', { class: `nd-panel nd-panel-${p.kind}` }, [
        h('span', { class: 'nd-panel-label', text: p.label }),
        p.kind === 'spark' ? spark(p.series) : p.kind === 'number' ? h('span', { class: 'nd-panel-value', text: fmt(p.value) }, [p.unit ? h('span', { class: 'nd-panel-unit', text: p.unit }) : null]) : h('span', { class: 'nd-panel-value', text: p.word }),
        p.note ? h('span', { class: 'nd-panel-note', text: p.note }) : null,
      ]),
    ),
  )
}

/** The live beat can come every few seconds; a figure re-reads at most this often. */
const REREAD_MS = 60_000
/** The walk fades out and back in this long when the model's walk replaces the one from the numbers (app.css `.nodus-swap`). */
const SWAP_MS = 320

const h = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c) node.append(c)
  return node
}
const pad = (n) => String(n).padStart(2, '0')
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** A card's text as a figure: a full spec, or a recipe off the shelf (no rows yet). Null when it is neither. */
export function cardSpec(text) {
  try {
    const parsed = JSON.parse(text ?? '')
    // Studio and Atlas: their product rides as it is; lanes, parts and steps are always arrays, so a reader of specs reads it too.
    if (modeOf(parsed)) return { ...parsed, steps: Array.isArray(parsed.steps) ? parsed.steps.filter((s) => typeof s?.say === 'string') : [], lanes: [], parts: [], by: parsed.by ?? {} }
    const { spec } = checkSpec(parsed)
    return spec?.form && (spec.lanes.length > 0 || spec.source) ? spec : null
  } catch {
    return null
  }
}

/** The page's read: the theme's read route, the same TOOL_REGISTRY the plugin read. */
const pageRead = async (tool, args) => {
  const r = await fetch(`/gnomon/api/read?tool=${encodeURIComponent(tool)}&args=${encodeURIComponent(JSON.stringify(args ?? {}))}`, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(String(r.status))
  return r.json()
}

/** Fresh rows under the walk that was written for older ones: a step stays while what it points at is still there. */
export function rebind(spec, skeleton) {
  const known = new Set([...skeleton.lanes.map((l) => l.id), ...(skeleton.parts ?? []).map((p) => p.id)])
  const kept = spec.steps.filter((s) => s.focus.some((id) => known.has(id))).map((s) => ({ ...s, focus: s.focus.filter((id) => known.has(id)) }))
  const steps = kept.length > 0 ? kept : fallbackSteps(skeleton)
  return checkSpec({ ...skeleton, ask: spec.ask, headline: kept.length > 0 ? spec.headline : '', steps, by: spec.by }).spec
}

/** What a figure holds, as numbers to tell apart: a value per lane and the parts by id. */
const snapshot = (spec) => ({ lanes: Object.fromEntries(spec.lanes.map((l) => [l.id, l.value ?? null])), parts: spec.parts.map((p) => p.id) })

/** Since the owner last looked: new parts, and the lanes whose number moved, biggest first. */
export function changesSince(seen, spec) {
  if (!seen) return null
  const now = snapshot(spec)
  const fresh = now.parts.filter((id) => !seen.parts.includes(id)).length
  const moved = spec.lanes
    .filter((l) => l.value != null && seen.lanes[l.id] !== l.value)
    .map((l) => ({ l, d: l.value - (seen.lanes[l.id] ?? 0) }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .slice(0, 2)
    .map(({ l, d }) => `${l.label} ${d > 0 ? '+' : ''}${Math.round(d)}${l.unit ? ` ${l.unit}` : ''}`)
  const said = [fresh ? `${fresh} new` : null, ...moved].filter(Boolean)
  return said.length ? `Since you looked at ${clock(seen.at)}: ${said.join(', ')}.` : null
}

const store = {
  get: (id) => {
    try {
      return JSON.parse(localStorage.getItem(`nodus-seen:${id}`) ?? 'null')
    } catch {
      return null
    }
  },
  set: (id, spec) => {
    try {
      localStorage.setItem(`nodus-seen:${id}`, JSON.stringify({ at: Date.now(), ...snapshot(spec) }))
    } catch {}
  },
}

/** Jev reads a frame 280 to 1568 px a side: every mode's snapshot is drawn again into that window, as a JPEG. */
const FRAME_PX = [280, 1568]
export async function fitFrame(dataUrl) {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const k = Math.min(FRAME_PX[1] / Math.max(img.width, img.height), Math.max(1, FRAME_PX[0] / Math.min(img.width, img.height)))
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * k)
  c.height = Math.round(img.height * k)
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.85)
}

/** The frame critic's one call, for every mode: `{ shows_intent, legible }`, or null when Jev did not judge it. */
async function judgeFrame(snapshot, spec, step = null, parts = []) {
  const jpeg = await fitFrame(snapshot)
  const r = await fetch('/gnomon/api/nodus-frame', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jpeg, ask: spec.ask ?? spec.title, title: spec.title, step, parts }) })
  const v = await r.json()
  return typeof v.shows_intent === 'number' ? v : null
}

/**
 * The frame critic, remembered per viewer and card: which frames were judged
 * (at most `FRAMES`) and the last score. A frame is the first one a scene
 * settles on, then each step the owner reaches by hand.
 */
const FRAMES = 6
const frames = {
  get: (id) => {
    try {
      return JSON.parse(localStorage.getItem(`nodus-frame:${id}`) ?? 'null') ?? { keys: [], fits: null }
    } catch {
      return { keys: [], fits: null }
    }
  },
  set: (id, mem) => {
    try {
      localStorage.setItem(`nodus-frame:${id}`, JSON.stringify(mem))
    } catch {}
  },
}

/** Does this figure's view still move? A named past day does not; today (named or not), the ledger and the threads do. */
const today = () => new Date().toLocaleDateString('en-CA')
const isLive = (spec) => Boolean(spec.source) && !(['day', 'where', 'compare'].includes(spec.source.view) && spec.source.args?.date && spec.source.args.date !== today())

/**
 * The card body for a spec (or a recipe), on the card `id`.
 * @param opts.read (tool, args) → rows; the page's read route by default
 * @param opts.text the card's text on the board, so the board's `sync` knows when it changed
 */
export function nodusNode(input, { id = null, read = pageRead, text = null } = {}) {
  if (modeOf(input)) return modeNode(input, { id, text })
  let spec = input
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const state = h('span', { class: 'nodus-state', 'aria-live': 'polite' })
  const since = h('p', { class: 'nodus-since' })
  const headline = h('p', { class: 'nodus-headline' })
  const plate = h('div', { class: 'nodus-plate' })
  const say = h('p', { class: 'nodus-say', 'aria-live': 'polite' })
  const count = h('span', { class: 'nodus-count' })
  const back = h('button', { type: 'button', class: 'board-act', text: 'Back', 'aria-keyshortcuts': 'ArrowLeft', onclick: () => (stop(), go(k - 1)) })
  // Next after the hand held the camera picks the walk up where it paused.
  const next = h('button', {
    type: 'button',
    class: 'board-act nodus-next',
    text: 'Next',
    'aria-keyshortcuts': 'ArrowRight',
    onclick: () => {
      const resume = paused
      stop()
      if (k >= spec.steps.length - 1) return go(-1)
      go(k + 1)
      if (resume) timer = setTimeout(play, dwell(spec.steps[k].say))
    },
  })
  const scrub = h('input', { type: 'range', class: 'nodus-scrub', min: 0, max: 1000, value: 1000, 'aria-label': 'Show the day up to' })
  const scrubAt = h('span', { class: 'nodus-scrub-at' })
  const scrubRow = h('label', { class: 'nodus-scrub-row' }, [h('span', { class: 'nodus-eyebrow', text: 'Up to' }), scrub, scrubAt])
  const walk = h('div', { class: 'nodus-walk' }, [h('div', { class: 'nodus-walk-head' }, [h('span', { class: 'nodus-eyebrow', text: 'Gnomon walks you through' }), count]), say, h('div', { class: 'nodus-acts' }, [back, next])])
  const foot = h('p', { class: 'nodus-foot' })
  // A set of something in the world (no record behind it) can be drawn another way, beside this one.
  const tries = !input.source && id && input.ask ? tryActs(input.ask, 'sketch', id) : null
  // `text` is the card's text as the board holds it: a new one arrives as `sync`.
  const node = h('div', { class: 'nodus', tabindex: '0', 'data-text': text ?? '' }, [h('div', { class: 'nodus-head' }, [headline, state]), since, plate, scrubRow, walk, foot, tries])

  let figure = null
  let k = -1
  let timer = null
  let paused = false
  let readAt = 0

  function draw() {
    if (figure?.update && figure.form === spec.form) figure.update(spec)
    else {
      figure?.dispose?.()
      figure = (DRAW[spec.form] ?? drawTimeline)(spec)
      figure.form = spec.form
      plate.replaceChildren(figure.node)
    }
    // The panels docked under the figure follow the numbers.
    plate.querySelector(':scope > .nodus-panels')?.remove()
    const panels = panelsNode(spec)
    if (panels) plate.append(panels)
    chrome()
  }
  /** Everything around the figure: the headline, the walk, the foot. */
  function chrome() {
    headline.textContent = spec.headline || spec.title
    walk.hidden = spec.steps.length === 0
    scrubRow.hidden = spec.form !== 'timeline'
    const by = spec.by ?? {}
    const ms = by.pending ? (by.ms?.place != null ? ` · placed in ${(by.ms.place / 1000).toFixed(1)} s, Gnomon's walk on its way` : '') : by.ms?.total ? ` · built in ${(by.ms.total / 1000).toFixed(1)} s` : ''
    const who = { model: 'Gnomon', library: 'Gnomon, kept from earlier' }[by.storyboard] ?? 'the numbers'
    // Asked in another mode and drawn here: say why, in a word.
    const fell = (by.tried ?? []).filter((t) => t.mode !== 'sketch').map((t) => `${MODES[t.mode]?.label ?? t.mode} ${t.why === 'not ready' ? 'not ready yet' : 'could not draw it'}`)
    // A record ask in a thread set to Studio or Atlas: only Sketch reads the record.
    const mine = fell.length === 0 && MODES[by.asked] && by.asked !== 'sketch' ? ' (your record)' : ''
    foot.textContent = `Drawn in Sketch${mine} · ${spec.view ?? spec.archetype ?? spec.form}${spec.form === 'scene' && spec.view ? ` as ${spec.archetype}` : ''} · ${spec.lanes.length} ${spec.form === 'scene' ? 'parts' : 'rows'}${spec.parts.length ? ` · ${spec.parts.length} marks` : ''} · walk by ${who}${ms}${fell.length ? ` · ${fell.join(', ')}` : ''}`
    go(Math.min(k, spec.steps.length - 1))
  }
  function setState(word, kind) {
    state.textContent = word
    state.dataset.kind = kind
  }
  function verdict() {
    if (spec.by?.pending) return setState('Reading', 'busy')
    const fits = spec.by?.critic?.fits
    // The walk's check, then the picture's own (the frame critic), when Jev has looked at it.
    const framed = spec.form === 'scene' && id ? frames.get(id).fits : null
    const look = framed != null ? `Framed ${framed.toFixed(1)} of 3` : null
    if (fits != null) setState([`Checked ${fits.toFixed(1)} of 3`, look].filter(Boolean).join(' · '), fits >= 2 ? 'verified' : 'checked')
    else setState(look ?? 'Unchecked', look ? (framed >= 2 ? 'verified' : 'checked') : 'unchecked')
  }

  // ── The frame critic ──────────────────────────────────────────────────────
  // A scene that settles sends what it shows (a JPEG, labels burnt in) to Jev:
  // the first frame, then each step the owner reaches by hand, six at most per
  // card. A frame that does not read pulls the camera back a fifth and is
  // judged once more. Without Jev the route says `unavailable` and the card
  // says nothing.
  let judging = false
  let again = false
  node.addEventListener('nodus:settled', async () => {
    if (!id || spec.form !== 'scene' || judging || !figure?.snapshot) return
    const mem = frames.get(id)
    const key = again ? `${k}+` : String(k)
    const retry = again
    again = false
    if (mem.keys.includes(key) || mem.keys.length >= FRAMES || (mem.keys.length > 0 && timer && !retry)) return
    const jpeg = figure.snapshot()
    if (!jpeg) return
    mem.keys.push(key)
    frames.set(id, mem)
    judging = true
    try {
      const v = await judgeFrame(jpeg, spec, spec.steps[k]?.say ?? null, spec.lanes.map((l) => l.label))
      if (!v) return
      frames.set(id, { ...frames.get(id), fits: v.shows_intent, legible: v.legible })
      verdict()
      if (!retry && v.legible != null && v.legible < 0.5) {
        again = true
        figure.back?.()
      }
    } catch {
      // Unreachable: the card keeps what it says.
    } finally {
      judging = false
    }
  })

  function go(i) {
    k = Math.max(-1, Math.min(i, spec.steps.length - 1))
    const step = spec.steps[k]
    figure.focus(step ? focusOf(spec, step) : new Set(), step?.focus ?? [], step?.explode === true)
    say.textContent = step ? step.say : 'The whole figure. Next walks you through it.'
    count.textContent = step ? `${pad(k + 1)} / ${pad(spec.steps.length)}` : `${pad(spec.steps.length)} steps`
    back.disabled = k < 0
    next.textContent = k >= spec.steps.length - 1 ? 'Done' : 'Next'
    node.dataset.step = String(k)
  }
  function stop() {
    clearTimeout(timer)
    timer = null
    paused = false
  }
  /** The owner's hand on the camera: the walk waits where it is, and Next picks it up. */
  function pause() {
    if (timer) paused = true
    clearTimeout(timer)
    timer = null
  }
  function play() {
    if (!node.isConnected || k >= spec.steps.length - 1) return stop()
    go(k + 1)
    timer = setTimeout(play, dwell(spec.steps[k].say))
  }

  // Time scrubbing: the day up to a moment; what came after stays as a faint trace.
  scrub.addEventListener('input', () => {
    stop()
    const a = Date.parse(spec.window.from)
    const t = a + (Number(scrub.value) / 1000) * (Date.parse(spec.window.to) - a)
    scrubAt.textContent = Number(scrub.value) >= 1000 ? 'the end' : hm(new Date(t).toISOString(), spec.tz)
    const later = new Set(spec.parts.filter((p) => Date.parse(p.from) > t).map((p) => p.id))
    for (const el of plate.querySelectorAll('[data-id]')) el.classList.toggle('nd-later', later.has(el.getAttribute('data-id')))
  })

  node.addEventListener('pointerdown', (event) => (plate.contains(event.target) ? pause() : event.target.closest?.('.nodus-next') ? null : stop()))
  // The stage says when the hand takes the camera, and when it asks for the whole figure (a double click).
  node.addEventListener('nodus:hold', pause)
  node.addEventListener('nodus:home', () => (stop(), go(-1)))

  /** The model's walk for the same figure, as the card's new text: faded in over the old one. */
  node.addEventListener('sync', (event) => {
    node.dataset.text = event.detail ?? ''
    const fresh = cardSpec(event.detail)
    if (!fresh || fresh.lanes.length === 0 || spec.lanes.length === 0) return
    const playing = Boolean(timer)
    walk.classList.add('nodus-swap')
    setTimeout(() => {
      const same = JSON.stringify(snapshot(fresh)) === JSON.stringify(snapshot(spec)) && fresh.form === spec.form
      spec = fresh
      if (same) chrome()
      else draw()
      verdict()
      walk.classList.remove('nodus-swap')
      stop()
      go(k < 0 ? -1 : 0)
      if (playing && spec.steps.length > 1) timer = setTimeout(play, dwell(spec.steps[0].say))
    }, reduced ? 0 : SWAP_MS)
  })
  node.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.altKey || event.metaKey || event.ctrlKey) return
    const to = { ArrowRight: k + 1, ArrowLeft: k - 1, Home: -1, End: spec.steps.length - 1 }[event.key]
    if (to === undefined) return
    event.preventDefault()
    event.stopPropagation()
    stop()
    go(to)
  })

  async function refresh() {
    if (!spec.source || Date.now() - readAt < REREAD_MS) return
    readAt = Date.now()
    if (spec.lanes.length === 0) setState('Reading', 'busy')
    try {
      const skeleton = await readView(spec.source.view, spec.source.args, read)
      if (!skeleton) throw new Error('nothing')
      const was = JSON.stringify(snapshot(spec))
      const fresh = rebind(spec, skeleton)
      if (JSON.stringify(snapshot(fresh)) !== was) {
        spec = fresh
        draw()
      }
      verdict()
      state.textContent += isLive(spec) ? ` · live ${clock(readAt)}` : ''
    } catch {
      // Offline, or the record will not answer: the figure keeps what it last drew.
      if (spec.lanes.length === 0) {
        plate.replaceChildren(h('div', { class: 'none', text: 'This figure could not be read right now. It comes back when the record answers.' }))
        walk.hidden = true
      }
      setState(spec.lanes.length ? `Offline · as drawn` : 'Offline', 'offline')
    }
    if (id) {
      since.textContent = changesSince(store.get(id), spec) ?? ''
      store.set(id, spec)
    }
  }

  if (spec.lanes.length > 0) {
    draw()
    verdict()
    if (id) {
      since.textContent = changesSince(store.get(id), spec) ?? ''
      store.set(id, spec)
    }
  } else {
    plate.replaceChildren(h('div', { class: 'reading', text: 'Reading the record…' }))
    walk.hidden = true
    scrubRow.hidden = true
    headline.textContent = spec.headline || spec.title
  }
  // A figure opened again re-reads at once; one just built is as fresh as it gets.
  if (spec.lanes.length === 0 || isLive(spec)) {
    readAt = spec.lanes.length === 0 ? 0 : Date.now()
    if (spec.lanes.length === 0) void refresh()
  }
  // The board's beat (app.js); the listener dies with the node.
  const onBeat = () => (node.isConnected ? isLive(spec) && void refresh() : document.removeEventListener('gnomon:beat', onBeat))
  document.addEventListener('gnomon:beat', onBeat)

  if (!reduced && spec.steps.length > 1 && spec.lanes.length > 0) {
    go(0)
    timer = setTimeout(play, dwell(spec.steps[0].say))
  } else if (spec.lanes.length > 0) go(spec.steps.length > 0 ? 0 : -1)
  node.refresh = () => ((readAt = 0), refresh())
  return node
}

// ── Studio and Atlas ───────────────────────────────────────────────────────

const tryPost = (body) => fetch('/gnomon/api/nodus-try', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())

/** "Try in Studio", "Try in Atlas", "Try in Sketch": the same ask drawn another way, placed beside this card. */
function tryActs(ask, mode, id) {
  const said = h('span', { class: 'nodus-try-said', 'aria-live': 'polite' })
  const acts = Object.values(MODES)
    .filter((m) => m.id !== mode)
    .map((m) =>
      h('button', {
        type: 'button',
        class: 'board-act nodus-try',
        text: `Try in ${m.label}`,
        title: m.blurb,
        'data-mode': m.id,
        onclick: async (event) => {
          const b = event.currentTarget
          b.disabled = true
          said.textContent = `Drawing in ${m.label}…`
          const got = await tryPost({ ask, mode: m.id, near: id }).catch(() => null)
          said.textContent = got?.done ? `Placed beside this one.` : `${m.label} could not draw this.`
          b.disabled = false
        },
      }),
    )
  // A mode whose engine is not in yet offers nothing.
  for (const b of acts) void MODES[b.dataset.mode].ready().then((ok) => (b.hidden = !ok))
  return h('div', { class: 'nodus-acts nodus-tries' }, [...acts, said])
}

/**
 * A Studio or Atlas card: the same head, walk and foot as a Sketch card (the
 * overlay lends them alike), the mode's own drawing on the plate. Being built:
 * "Building in Studio" and a quiet line of seconds. Drawn: "Checking" while the
 * frame critic looks, then "Checked x of 3". Nothing could draw it: the walk as
 * words, and Retry.
 */
function modeNode(input, { id = null, text = null } = {}) {
  let spec = input
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const state = h('span', { class: 'nodus-state', 'aria-live': 'polite' })
  const headline = h('p', { class: 'nodus-headline' })
  const plate = h('div', { class: 'nodus-plate nodus-mode-plate' })
  const say = h('p', { class: 'nodus-say', 'aria-live': 'polite' })
  const count = h('span', { class: 'nodus-count' })
  const back = h('button', { type: 'button', class: 'board-act', text: 'Back', onclick: () => (stop(), go(k - 1)) })
  const next = h('button', { type: 'button', class: 'board-act nodus-next', text: 'Next', onclick: () => (stop(), go(k >= spec.steps.length - 1 ? -1 : k + 1)) })
  const walk = h('div', { class: 'nodus-walk' }, [h('div', { class: 'nodus-walk-head' }, [h('span', { class: 'nodus-eyebrow', text: 'Gnomon walks you through' }), count]), say, h('div', { class: 'nodus-acts' }, [back, next])])
  const foot = h('p', { class: 'nodus-foot' })
  const tries = h('div')
  const node = h('div', { class: 'nodus nodus-mode', tabindex: '0', 'data-text': text ?? '', 'data-mode': spec.mode }, [h('div', { class: 'nodus-head' }, [headline, state]), plate, walk, foot, tries])
  let figure = null
  let k = -1
  let timer = null
  let ticking = null
  const label = () => MODES[spec.mode]?.label ?? spec.mode
  const setState = (word, kind) => ((state.textContent = word), (state.dataset.kind = kind))
  const secs = () => ((spec.by?.ms?.total ?? 0) / 1000).toFixed(1)

  function go(i) {
    k = Math.max(-1, Math.min(i, spec.steps.length - 1))
    const step = spec.steps[k]
    try {
      figure?.focus?.(step?.focus ?? [], step?.say ?? '')
      // A figure that pulls apart (Atlas's layers) is told how far, by the step itself; the whole figure closes it.
      figure?.explode?.(step?.explode ?? 0)
    } catch {}
    say.textContent = step ? step.say : 'The whole figure. Next walks you through it.'
    count.textContent = step ? `${pad(k + 1)} / ${pad(spec.steps.length)}` : `${pad(spec.steps.length)} steps`
    back.disabled = k < 0
    next.textContent = k >= spec.steps.length - 1 ? 'Done' : 'Next'
    node.dataset.step = String(k)
  }
  function stop() {
    clearTimeout(timer)
    timer = null
  }
  function play() {
    if (!node.isConnected || k >= spec.steps.length - 1) return stop()
    go(k + 1)
    timer = setTimeout(play, dwell(spec.steps[k].say))
  }
  // Asked for the whole figure (as a Sketch card is): the walk stops, nothing is lit; asked before the picture lands, it stays so once it does.
  let home = false
  node.addEventListener('nodus:home', () => ((home = true), stop(), go(-1)))
  /** Nothing could draw it: what Gnomon would have walked, as words, and Retry. */
  function words() {
    const lines = spec.steps.length ? spec.steps.map((s) => h('li', { text: s.say })) : [h('li', { text: spec.ask || spec.title })]
    const retry = h('button', {
      type: 'button',
      class: 'board-act',
      text: 'Retry',
      onclick: async (event) => {
        event.currentTarget.disabled = true
        setState('Drawing', 'busy')
        const got = await tryPost({ ask: spec.ask, mode: spec.by?.asked ?? spec.mode, id }).catch(() => null)
        if (!got?.done) words()
      },
    })
    plate.replaceChildren(h('div', { class: 'nodus-words' }, [h('ul', {}, lines), id && spec.ask ? h('div', { class: 'nodus-acts' }, [retry]) : null]))
    walk.hidden = true
    setState('Could not draw this, showing words', 'offline')
    foot.textContent = spec.by?.failed ? `Tried ${String(spec.by.failed).slice(0, 160)}` : `Tried ${label()}`
  }
  /** The frame critic, once per card: the settled picture goes to Jev. */
  async function judge() {
    const mem = id ? frames.get(id) : { keys: [], fits: null }
    if (mem.fits != null) return setState(`Checked ${mem.fits.toFixed(1)} of 3`, mem.fits >= 2 ? 'verified' : 'checked')
    const jpeg = await Promise.resolve(figure?.snapshot?.()).catch(() => null)
    if (!jpeg || !id) return setState('Unchecked', 'unchecked')
    try {
      const v = await judgeFrame(jpeg, spec)
      if (!v) return setState('Unchecked', 'unchecked')
      frames.set(id, { keys: ['m'], fits: v.shows_intent, legible: v.legible })
      setState(`Checked ${v.shows_intent.toFixed(1)} of 3`, v.shows_intent >= 2 ? 'verified' : 'checked')
    } catch {
      setState('Unchecked', 'unchecked')
    }
  }
  async function draw() {
    stop()
    clearInterval(ticking)
    figure?.dispose?.()
    figure = null
    headline.textContent = spec.headline || spec.title
    tries.replaceChildren(...(id && spec.ask && !spec.by?.pending ? [tryActs(spec.ask, spec.mode, id)] : []))
    if (spec.by?.pending) {
      const since = Date.now()
      const line = h('p', { class: 'nodus-progress', text: 'Started just now' })
      plate.replaceChildren(h('div', { class: 'reading nodus-building' }, [h('span', { text: `Building in ${label()}` }), line]))
      ticking = setInterval(() => (node.isConnected ? (line.textContent = `${Math.round((Date.now() - since) / 1000)} s so far`) : clearInterval(ticking)), 1000)
      walk.hidden = true
      foot.textContent = `Building in ${label()}`
      return setState('Drawing', 'busy')
    }
    if (spec.by?.failed || !spec.product) return words()
    setState('Drawing', 'busy')
    const host = h('div', { class: 'nodus-mode-host' })
    plate.replaceChildren(host)
    // The picture settles (the mode says so), or fails, which shows the words.
    let settled = false
    const once = () => !settled && ((settled = true), void judge())
    try {
      figure = await MODES[spec.mode].draw(host, spec.product, { onSettled: (e) => (e?.error ? (figure?.dispose?.(), words()) : once()) })
      if (figure?.node && !host.contains(figure.node)) host.replaceChildren(figure.node)
    } catch {
      return words()
    }
    walk.hidden = spec.steps.length === 0
    foot.textContent = `Drawn in ${label()}${spec.by?.ms?.total ? ` · ${secs()} s` : ''}${spec.product?.assets?.length ? ` · ${spec.product.assets.length} source${spec.product.assets.length === 1 ? '' : 's'}` : ''}`
    go(spec.steps.length && !home ? 0 : -1)
    if (!reduced && !home && spec.steps.length > 1) timer = setTimeout(play, dwell(spec.steps[0].say))
    setState('Checking', 'busy')
    // A mode that never says: judged once it has had a few seconds.
    await Promise.resolve(figure?.ready).catch(() => {})
    setTimeout(once, 3000)
  }
  node.addEventListener('pointerdown', (event) => (plate.contains(event.target) ? stop() : null))
  node.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.altKey || event.metaKey || event.ctrlKey) return
    const to = { ArrowRight: k + 1, ArrowLeft: k - 1, Home: -1, End: spec.steps.length - 1 }[event.key]
    if (to === undefined) return
    event.preventDefault()
    event.stopPropagation()
    stop()
    go(to)
  })
  // The finished figure (or Sketch, when the ladder came down to it) arrives as the card's new text.
  node.addEventListener('sync', (event) => {
    node.dataset.text = event.detail ?? ''
    const fresh = cardSpec(event.detail)
    if (!fresh) return
    if (!modeOf(fresh)) {
      figure?.dispose?.()
      clearInterval(ticking)
      return node.replaceWith(nodusNode(fresh, { id, text: event.detail }))
    }
    spec = fresh
    node.dataset.mode = spec.mode
    void draw()
  })
  void draw()
  node.refresh = () => draw()
  return node
}
