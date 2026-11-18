// Studio: the free mode. The model writes a scene program against the Studio
// runtime (three.js, the kit, the ink helpers), the program runs in a sandboxed
// frame on an opaque origin with no network (studio-runtime.html), the frame
// critic judges the first settled frame, and one repair round fixes what broke
// or what did not read.
//
// The reply is a title, the walk as STEP lines, then the program in a fence:
// the walk is read from the text, so the server never runs model code. The
// program runs only in the browser's sandbox; `ctx.trial(product)` is how a
// host that has one hands back `{ error }` or `{ jpeg, labels }`, and without
// it the build stops after the syntax check, and the card's own settled frame
// goes to `critique` and `repair` later.

import { criticQuestions, FRAME_ASSET, FRAME_SET, frameQuestions, frameVerdict, screenLine, tailor } from '../storyboard.js'

/** A program longer than this is not drawn: it would not finish, or not be read. */
export const MAX_CODE = 9000
export const MAX_STEPS = 6
const OPTS = { maxTokens: 2200, temperature: 0.4 }
/** Per stage, so one stuck call lowers the ladder instead of holding the turn. */
export const TIMEOUT = { program: 60_000, trial: 25_000, critic: 12_000 }
/** The frame critic's floor: under either, one repair round. */
const MIN_SHOWS = 1
const MIN_LEGIBLE = 0.5
/** How long a frame may take to load and answer ready before it is swapped for a fresh one. */
const BOOT_MS = 6_000

const within = (ms, promise) => {
  let timer
  return Promise.race([Promise.resolve(promise), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]).finally(() => clearTimeout(timer))
}

export const PARTS = 'sun{r} light{r} (a beam toward the middle) cloud{r} rain{r} droplet{r} rainbow{r} ray{r} ground{r} observer{r} (a person, r is height) prism{r} sphere box cylinder cone torus{r} field{r, shape: tree|cloud|crowd|forest} contour{r, shape: hill|island|valley} stack{r} (a floor) source sink tank{r, state: full|half|empty} reservoir pump valve gear{r, teeth} shaft crank lever piston belt{r} center{r} body{r} moon{r}'

const RUNTIME_DOC = [
  'Write ONE function, no imports: function scene(api) { ...build the set... }',
  'It runs once, in a sandbox with three.js r160 and no network, DOM or timers; it must finish in well under a second.',
  'api.add(id, object, { label }) puts a part on the set. The id is short and plain (heart, valve-a); the label is the 1 to 3 words a reader needs. Labels stand in the margin with a leader to the part: never draw text yourself.',
  `api.part(kind, { at: [x, y, z], r, ...params }) gives a ready part in the house style; pass it to api.add. Kinds: ${PARTS}.`,
  'api.ink, in the page\'s ink: solid(geometry, tone?, fill?) a body as drawn (light wash, bold outline, its hidden edges dashed), edges(geometry, tone?), path(points, tone?), loop(points, tone?), arrow(from, to, tone?), dashed(points, tone?), hidden(geometry or points, tone?) a line that runs behind something, hatch([[x, y], ...], tone?) a cut face in the xy plane (rotate the group for another plane), text(words, [x, y, z]) a margin note on a point, line(tone, opacity) and wash(tone, opacity) materials.',
  'api.pipe(points, { width, back }) a pipe with real bends (back: a dashed return). api.THREE for geometry (LatheGeometry, TubeGeometry, ExtrudeGeometry, CatmullRomCurve3, Shape). api.V(x, y, z).',
  'Tones: api.colors.ink, muted, faint, ochre (light, heat, what moves), navy (cold, water), page. Nothing else; api.spectrum only where colour itself is the subject (a rainbow, a spectrum).',
  'api.onFrame((t, dt) => ...) for motion: slow, readable, looping. api.door(id, "search:<term>") makes a part\'s label open a search of the owner\'s record (only when the ask is about their own work).',
  'Camera: framed on the parts for you and never turning. api.cam.view("system" | "iso" | "front" | "top") picks the angle; iso for a machine or a building, front for a section.',
].join('\n')

export const SYSTEM = [
  'You are Gnomon, and right now an artist, a teacher and a companion: curious, warm, exact. You explain by showing, you notice what is beautiful about how a thing works. You are not an assistant and never call yourself one.',
  'You draw a technical plate, ink on warm paper, that answers the ask, and you write the walk a reader follows over it.',
  'The bar: close to the real thing. Real proportions and real parts in their real places (a bicep has its tendons at the elbow and the shoulder, a heat pump its compressor, coils, valve and refrigerant loop). Detail where it explains, nothing ornamental.',
  'Plate conventions: one clear subject in the middle of the set, about 8 to 12 units across; outlines bold, hidden lines dashed (api.ink.hidden), cut faces hatched (api.ink.hatch), layers shown by a cutaway or by pulling them a little apart along one axis with dashed guides, flow by arrows in ochre (warm) or navy (cold). Wash, never fill; no lights, no shading, no textures.',
  `Name 4 to 9 parts, the ones the walk speaks about. Walk 3 to ${MAX_STEPS} steps; each step is one spoken sentence of at most 24 words that names its part with the label's words, in the language of the ask.`,
  'No em dashes, no markdown outside the fence, no lists in the sentences.',
  '',
  'The Studio runtime:',
  RUNTIME_DOC,
  '',
  'Reply in exactly this form:',
  'TITLE: two to five words',
  'STEP [id, id]: one sentence',
  '(one STEP line per step; the ids are parts the program adds)',
  '```js',
  'function scene(api) { ... }',
  '```',
  `Keep the program under 120 lines and ${MAX_CODE} characters.`,
].join('\n')

/** The messages for an ask: the system, the ask with what is on screen and a like walk, and a repair turn when there is one. */
export function studioMessages(ask, ctx = {}, previous = null, problem = null) {
  const screen = typeof ctx.screen === 'string' ? ctx.screen : screenLine(ctx.screen)
  const like = (ctx.like ?? []).filter((e) => e?.ask && e?.steps?.length).slice(0, 2)
  const user = [
    `Ask: ${String(ask ?? '').slice(0, 400)}`,
    screen && `${screen} (use it only if the ask points at it)`,
    like.length && `Walks that worked for like asks (their voice and order only):\n${like.map((e) => `- "${e.ask}": ${e.steps.map((s) => s.say ?? s).join(' / ')}`).join('\n')}`,
  ].filter(Boolean).join('\n\n')
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }]
  if (previous != null && problem) messages.push({ role: 'assistant', content: previous }, { role: 'user', content: repairNote(problem) })
  return messages
}

/** What the model is told when its program broke or its frame did not read. */
export function repairNote(problem) {
  if (problem.error) return `That program failed in the runtime: ${String(problem.error).slice(0, 500)}\nFix exactly that and send the whole reply again in the same form.`
  if (problem.problems) return `That reply cannot be drawn: ${problem.problems.join('; ')}.\nFix exactly that and send the whole reply again in the same form.`
  const v = problem.verdict ?? {}
  const asks = []
  if (v.shows_intent != null && v.shows_intent < MIN_SHOWS) asks.push('the picture does not show what was asked: draw the thing itself, close to the real one, its named parts where a reader expects them')
  if (v.legible != null && v.legible < MIN_LEGIBLE) asks.push('the labels do not read: fewer and shorter labels, parts spread so each label clears the drawing')
  return `A critic looked at the drawn frame: shows what was asked ${v.shows_intent ?? '?'} of 3, labels legible ${v.legible ?? '?'} of 1. ${asks.join('; ')}.\nSend the whole reply again in the same form, better.`
}

const BANNED = /\b(fetch|XMLHttpRequest|WebSocket|importScripts|localStorage|indexedDB|setTimeout|setInterval|eval)\s*\(|\b(document|window|globalThis|parent)\s*\.|\bimport\s*\(|\brequire\s*\(/

/**
 * A reply read: `{ title, code, steps }` and the problems that keep it from
 * being drawn (none when it may run). Nothing in it is executed: the program
 * is only compiled.
 */
export function parseProgram(text) {
  const s = String(text ?? '')
  const problems = []
  const title = s.match(/^\s*TITLE:\s*(.+)$/m)?.[1]?.trim().replace(/[*_#`]/g, '').slice(0, 60) ?? ''
  const steps = [...s.matchAll(/^\s*STEP\s*\[([^\]]*)\]\s*:?\s*(.+)$/gm)].map(([, ids, say]) => ({ say: say.trim().replace(/\s*[\u2013\u2014]\s*/g, ', ').slice(0, 240), focus: ids.split(',').map((x) => x.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean).slice(0, 4) }))
  const fence = s.match(/```(?:js|javascript)?\s*\n([\s\S]*?)(?:```|$)/)
  const code = (fence ? fence[1] : s.slice(s.search(/function\s+scene\s*\(/))).trim()
  if (!/function\s+scene\s*\(\s*api\s*\)/.test(code)) problems.push('there is no function scene(api)')
  else if (code.length > MAX_CODE) problems.push(`the program is ${code.length} characters; keep it under ${MAX_CODE}`)
  else {
    try {
      // Compiled, never called: a syntax error shows here and nothing runs.
      new Function('api', code)
    } catch (error) {
      problems.push(`syntax error: ${String(error?.message ?? error)}`)
    }
  }
  const banned = code.match(BANNED)
  if (banned) problems.push(`it uses ${banned[0].replace(/\s*\($/, '')}, which the runtime does not have`)
  if (steps.length < 2) problems.push('fewer than two STEP lines')
  // A step may only point at a part the program adds (a literal id, or one a template could make).
  const ids = [...code.matchAll(/api\.add\(\s*['"`]([^'"`$]+)/g)].map((m) => m[1])
  const known = (id) => ids.includes(id) || code.includes(`'${id}'`) || code.includes(`"${id}"`) || ids.some((x) => id.startsWith(x))
  const walk = steps.slice(0, MAX_STEPS).map((st) => ({ ...st, focus: st.focus.filter(known) }))
  if (!ids.length && !/api\.add\(/.test(code)) problems.push('it adds no parts with api.add')
  return { title: title || 'Studio', code, steps: walk, problems }
}

const product = (got, by) => ({ kind: 'program', title: got.title, code: got.code, steps: got.steps, by })

/** The frame critic: Jev looks at the settled frame (labels burnt in). `{ shows_intent, legible }` or null. */
async function critique(item, jpeg, ctx, { ask = '', step = null, labels = null } = {}) {
  const data = String(jpeg ?? '').replace(/^data:image\/jpeg;base64,/, '')
  if (!ctx?.judge || data.length < 200) return null
  const state = { frame: FRAME_ASSET, ask: String(ask || item.title).slice(0, 200), title: item.title, step, parts: (labels ?? []).slice(0, 24) }
  const answers = await within(TIMEOUT.critic, ctx.judge({ state, questions: frameQuestions(), set: FRAME_SET, assets: { [FRAME_ASSET]: { type: 'image', data_base64: data, format: 'jpeg' } } })).catch(() => null)
  return frameVerdict(answers)
}

/** One repair round: the previous reply and what went wrong, back to the model. The repaired product, or null. */
export async function repair(item, problem, ask, ctx) {
  if (!ctx?.complete || ctx.signal?.aborted) return null
  const previous = item.reply ?? `TITLE: ${item.title}\n${item.steps.map((s) => `STEP [${s.focus.join(', ')}]: ${s.say}`).join('\n')}\n\`\`\`js\n${item.code}\n\`\`\``
  const reply = await within(TIMEOUT.program, ctx.complete(studioMessages(ask, ctx, previous, problem), OPTS)).catch(() => null)
  const got = reply == null ? null : parseProgram(reply)
  return got && !got.problems.length ? { ...product(got, item.by), reply } : null
}

/** Which steps earn their place: Jev, as for a sketch; the walk as it was when Jev cannot say. */
async function tailorSteps(item, ask, ctx) {
  if (!ctx.judge || item.steps.length <= 2) return { steps: item.steps, fits: null }
  const state = { ask: String(ask || item.title).slice(0, 400), digest: `A drawn plate, "${item.title}", whose parts are: ${[...new Set(item.steps.flatMap((s) => s.focus))].join(', ')}`, walk: Object.fromEntries(item.steps.map((s, i) => [`s${i}`, s.say])) }
  const answers = await within(TIMEOUT.critic, ctx.judge({ state, questions: criticQuestions(item.steps, true) })).catch(() => null)
  return { steps: tailor(item.steps, answers), fits: answers?.fits?.score ?? null }
}

/**
 * Build a program for an ask. `ctx`: complete(messages, opts), judge({ state,
 * questions, set?, assets? }), screen, like, signal, and optionally trial(product) → { error } | { jpeg, labels } (a
 * sandbox that runs it). Null when no program came back that can be drawn.
 */
export async function build(ask, ctx = {}, { now = Date.now } = {}) {
  const t0 = now()
  const ms = {}
  const lap = (k, t) => (ms[k] = (ms[k] ?? 0) + now() - t)
  if (!ctx.complete) return null
  let t = now()
  const messages = studioMessages(ask, ctx)
  let reply = await within(TIMEOUT.program, ctx.complete(messages, OPTS)).catch(() => null)
  lap('program', t)
  if (reply == null || ctx.signal?.aborted) return null
  let got = parseProgram(reply)
  let repairs = 0
  let item = null
  if (got.problems.length) {
    repairs++
    t = now()
    item = await repair({ reply }, { problems: got.problems }, ask, ctx)
    lap('repair', t)
  } else item = { ...product(got, null), reply }
  if (!item) return null

  let critic = null
  let tried = null
  if (ctx.trial) {
    t = now()
    tried = await within(TIMEOUT.trial, ctx.trial(item)).catch((e) => ({ error: e.message }))
    lap('trial', t)
    if (tried?.error && repairs === 0 && !ctx.signal?.aborted) {
      repairs++
      t = now()
      const fixed = await repair(item, { error: tried.error }, ask, ctx)
      lap('repair', t)
      if (fixed) {
        item = fixed
        t = now()
        tried = await within(TIMEOUT.trial, ctx.trial(item)).catch((e) => ({ error: e.message }))
        lap('trial', t)
      }
    }
    if (tried?.error) return null
    if (tried?.jpeg) {
      t = now()
      critic = await critique(item, tried.jpeg, ctx, { ask, labels: tried.labels })
      lap('critic', t)
      if (critic && (critic.shows_intent < MIN_SHOWS || (critic.legible ?? 1) < MIN_LEGIBLE) && !ctx.signal?.aborted) {
        repairs++
        t = now()
        const fixed = await repair(item, { verdict: critic }, ask, ctx)
        lap('repair', t)
        const again = fixed ? await within(TIMEOUT.trial, ctx.trial(fixed)).catch((e) => ({ error: e.message })) : null
        const second = again?.jpeg ? await critique(fixed, again.jpeg, ctx, { ask, labels: again.labels }) : null
        // The repair stands only when it runs and the critic does not like it less.
        if (second && second.shows_intent >= critic.shows_intent) {
          item = fixed
          critic = { ...second, before: critic }
        }
      }
    }
  }
  t = now()
  const walk = await tailorSteps(item, ask, ctx)
  lap('tailor', t)
  ms.total = now() - t0
  const { reply: _r, ...rest } = item
  return { ...rest, steps: walk.steps, by: { ms, repairs, critic: { frame: critic, fits: walk.fits }, chars: item.code.length } }
}

// ── The browser half: the sandboxed frame ────────────────────────────────────

const TOKENS = { ink: '--ink', muted: '--ink-muted', faint: '--ink-faint', ochre: '--ochre', ochreText: '--ochre-text', navy: '--navy', green: '--green', page: '--card' }
/** The page's tokens, now (light or dark). `page` is what the frame paints behind the figure: the card's own tone, so no box shows in dark mode. */
const paletteNow = () => {
  const css = getComputedStyle(document.documentElement)
  const read = (v) => css.getPropertyValue(v).trim() || (v === '--card' ? css.getPropertyValue('--page').trim() : '')
  return Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [k, read(v)]).filter(([, v]) => /^#[0-9a-f]{3,8}$/i.test(v)))
}

let sources = null
/** three.js, the kit, labels.js, camera.js as text, and the face, once per page. */
const loadSources = () =>
  (sources ??= Promise.all([
    ...['../vendor/three.module.js', '../kit.js', '../labels.js', '../camera.js'].map((p) => fetch(new URL(p, import.meta.url)).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${p}: ${r.status}`))))),
    fetch('/gnomon/font/inter-tight.ttf').then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
  ]).then(([three, kit, labels, camera, font]) => ({ three, kit, labels, camera, font })).catch((e) => ((sources = null), Promise.reject(e))))

/**
 * The runtime in an iframe: boots it, runs a program, steps, snapshots. A run
 * that does not answer in `timeoutMs` throws the frame away and boots a fresh
 * one, so a runaway program only ever hangs its own frame.
 */
export function openRuntime(element, { palette = null, url = new URL('../studio-runtime.html', import.meta.url).href, load = loadSources, timeoutMs = 15_000 } = {}) {
  const waiters = new Map()
  let seq = 0
  let ready = null
  let up = null
  let frame = element
  const rt = { onSettled: null, onDoor: null, frame }
  const post = (m) => frame.contentWindow?.postMessage({ nodus: 'studio', ...m }, '*')
  const onMessage = async (e) => {
    const m = e.data
    if (e.source !== frame.contentWindow || m?.nodus !== 'studio') return
    if (m.type === 'boot') {
      try {
        post({ type: 'init', ...(await load()), palette: palette ?? paletteNow() })
      } catch (error) {
        up?.reject(error)
      }
    } else if (m.type === 'ready') up?.resolve()
    else if (m.type === 'settled') rt.onSettled?.(m.step)
    else if (m.type === 'door') rt.onDoor?.(String(m.ref ?? ''))
    else if (m.id && waiters.has(m.id)) {
      const w = waiters.get(m.id)
      waiters.delete(m.id)
      clearTimeout(w.t)
      m.type === 'error' ? w.reject(new Error(m.message)) : w.resolve(m)
    }
  }
  addEventListener('message', onMessage)
  // One try: the frame loads and answers ready, or is swapped for a fresh element.
  const once = (ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the studio runtime did not start')), ms)
      up = { resolve: () => (clearTimeout(t), resolve()), reject: (e) => (clearTimeout(t), reject(e)) }
      frame.src = url
    })
  // After a runaway program the first fresh frame may land in the dying process: a few tries, each a new element.
  const boot = () =>
    (ready ??= (async () => {
      for (let i = 0; ; i++) {
        try {
          return await once(BOOT_MS)
        } catch (error) {
          if (i >= 3) throw error
          swap()
        }
      }
    })().catch((e) => ((ready = null), Promise.reject(e))))
  const call = (type, payload, ms) => {
    const id = ++seq
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => (waiters.delete(id), reject(new Error(`studio ${type} timed out`))), ms)
      waiters.set(id, { resolve, reject, t })
      post({ type, id, ...payload })
    })
  }
  const swap = () => {
    if (!frame.parentNode) return void frame.removeAttribute('src')
    const fresh = frame.cloneNode(false)
    fresh.removeAttribute('src')
    frame.replaceWith(fresh)
    frame = rt.frame = fresh
  }
  /**
   * A frozen frame: thrown away, element and all, so its process holds no
   * frame and is shut down (navigating it would wait on the loop); the next
   * call boots a fresh one.
   */
  rt.reload = () => {
    ready = null
    for (const w of waiters.values()) (clearTimeout(w.t), w.reject(new Error('studio runtime reset')))
    waiters.clear()
    swap()
  }
  rt.run = async (item) => {
    await boot()
    try {
      return await call('run', { code: item.code, steps: item.steps }, timeoutMs)
    } catch (error) {
      if (/timed out/.test(error.message)) {
        rt.reload()
        throw new Error(`the program did not finish in ${timeoutMs / 1000} s: an endless loop or far too much work in scene(); build less and never loop forever`)
      }
      throw error
    }
  }
  rt.step = (index, ids, sentence) => ready && post({ type: 'step', index, ids, sentence })
  rt.snapshot = async (maxW = 1280) => (await boot(), (await call('snapshot', { maxW }, 8_000)).data)
  rt.theme = (p) => ready && post({ type: 'theme', palette: p })
  rt.dispose = () => {
    removeEventListener('message', onMessage)
    rt.reload()
  }
  return rt
}

/** A trial for `build`: run a product in a runtime (it may be hidden: the first frame is already framed) and hand back the frame or the error. */
export const trialIn = (rt) => async (item) => {
  try {
    const ran = await rt.run(item)
    return { jpeg: await rt.snapshot(), labels: ran.labels }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

/**
 * Draw a product in its own sandboxed frame. `onSettled({ step, snapshot })`
 * each time the camera comes to rest, `onSettled({ error })` when the program
 * fails. Returns `{ node, focus(ids, sentence), snapshot(), update(product), dispose() }`.
 */
export function draw(host, item, { palette = null, onSettled = null } = {}) {
  const node = document.createElement('div')
  node.className = 'nd-stage nd-studio'
  const frame = document.createElement('iframe')
  // Scripts only: an opaque origin, so the program can reach neither this page nor its cookies.
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.title = item.title ?? 'Studio'
  Object.assign(frame.style, { border: '0', width: '100%', height: '100%', display: 'block' })
  node.append(frame)
  if (host instanceof Element) host.append(node)
  const rt = openRuntime(frame, { palette })
  let current = item
  let lit = null
  rt.onSettled = (step) => onSettled?.({ step, snapshot: () => rt.snapshot() })
  // A door: the page's one door listener opens a label the program gave one, through a stand-in in this card.
  rt.onDoor = (ref) => {
    if (!/^search:.{1,80}$/.test(ref)) return
    const a = document.createElement('span')
    a.dataset.explore = ref
    a.hidden = true
    node.append(a)
    a.click()
    a.remove()
  }
  const start = () => (current?.code ? rt.run(current).then(() => lit && rt.step(...lit)).catch((e) => onSettled?.({ error: e.message })) : Promise.resolve())
  const onTheme = () => rt.theme(palette ?? paletteNow())
  const themes = new MutationObserver(onTheme)
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const scheme = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
  scheme?.addEventListener?.('change', onTheme)
  const ready = start()
  return {
    node,
    ready,
    focus(ids, sentence) {
      const i = current?.steps?.findIndex((s) => s.say === sentence) ?? -1
      lit = [i, [...(ids ?? [])], sentence ?? '']
      rt.step(...lit)
    },
    snapshot: () => rt.snapshot(),
    update(next) {
      current = next
      return start()
    },
    dispose() {
      themes.disconnect()
      scheme?.removeEventListener?.('change', onTheme)
      rt.dispose()
      node.remove()
    },
  }
}

