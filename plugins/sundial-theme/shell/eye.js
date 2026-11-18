// The locator: where on the screen Gnomon's act is, and what it is on, inside the slip. A 72 px outline of the screen
// with the window's outline in it and the acted part as the one ochre mark at its true relative place, beside two lines:
// what ("File · menu in the menu bar") and where ("Finder · notes · top left of the screen"). While Gnomon acts it stands
// above the last steps; on an ask it stands right of the gate's sentence and marks the part the yes will press. Nothing
// at rest. It points the eye at the ring Gnomon draws on the real screen; it never draws the window's parts.
//
// The data is the newest look (`/gnomon/api/eye`, host/read-eye.js), read when server.js pushes a new `eye` key. Values
// arrive sanitized at ingest; the read sends only the acted part's label, role, area and frame, the window's frame and
// title, the app and the screen's frame. A look at a private app gives no locator and no names.
import { el, svg } from './surfaces.js'

/** What changes the drawing: the look, the act, the marks. server.js pushes it as the `eye` frame; /gnomon/api/eye answers with it. */
export const eyeKey = (marks) => [marks?.lastLook?.id, marks?.lastAct?.id, ...(marks?.now ?? []).map((m) => m.id)].join('|')

const ok = (f) => Array.isArray(f) && f.length === 4 && f.every(Number.isFinite) && f[2] > 0 && f[3] > 0
/** The part's role as one word: a menu, a button, a field, a row, else a part. */
export const roleWord = (role) => {
  const r = String(role ?? '')
  return /MenuBarItem|MenuItem/.test(r) ? 'menu' : /Button/.test(r) ? 'button' : /Field|TextArea|ComboBox/.test(r) ? 'field' : /Row|Cell/.test(r) ? 'row' : 'part'
}

/**
 * Where a part is, in words: thirds across and down of the screen (a menu-bar item) or of its window. "top left",
 * "left side", "bottom middle", "middle". Frames are in the same points; `screen` and `win` are [x, y, w, h].
 */
export function posWord(part, win, screen) {
  const menu = /MenuBar/.test(String(part?.role ?? '')) || !ok(win)
  const [X, Y, W, H] = menu ? screen : win
  const [x, y, w, h] = part.frame
  const cx = (x + w / 2 - X) / W
  const cy = (y + h / 2 - Y) / H
  const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'middle'
  const row = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'middle'
  const where = row === 'middle' && col === 'middle' ? 'middle' : row === 'middle' ? `${col} side` : col === 'middle' ? `${row} middle` : `${row} ${col}`
  return `${where} of the ${menu ? 'screen' : 'window'}`
}

/**
 * The locator's facts from a read, or null when there is nothing true to show: no look, a private app, no part. `ask`:
 * the part the waiting yes presses (its ask mark on this look), else the part the newest act was on. Frames become
 * relative to the screen's origin, so the mark sits where the part sits on that display.
 */
export function locatorOf(data, { ask = false } = {}) {
  const look = data?.look
  const part = ask ? data?.asked : data?.acted
  const screen = data?.screen
  if (!look || look.refused || !part || !ok(part.frame) || !ok(screen)) return null
  const at = ([x, y, w, h]) => [x - screen[0], y - screen[1], w, h]
  const win = ok(look.frame) ? at(look.frame) : null
  const frame = at(part.frame)
  const area = part.area && part.area !== look.window ? part.area : ''
  return {
    label: part.label || roleWord(part.role),
    role: roleWord(part.role),
    area,
    app: look.app ?? '',
    window: look.window && look.window !== look.app ? look.window : '',
    pos: posWord({ role: part.role, frame }, win, [0, 0, screen[2], screen[3]]),
    screen: [screen[2], screen[3]],
    win,
    frame,
  }
}

/** The screen at `w` px wide, the menu bar's hairline, the window's outline, the part as one ochre mark (never under 5 by 4 px). */
export function drawLocator(loc, w = 72) {
  const [sw, sh] = loc.screen
  const s = w / sw
  const [x, y, pw, ph] = loc.frame
  const mw = Math.max(5 / s, pw)
  const mh = Math.max(4 / s, ph)
  const round = (n) => +n.toFixed(1)
  // Centred on the part, kept inside the screen's outline (a menu title at the top edge would hang above it).
  const clamp = (v, max) => Math.min(Math.max(0, v), Math.max(0, max))
  return svg('svg', { class: 'ov-loc', viewBox: `0 0 ${sw} ${sh}`, width: w, height: Math.round(sh * s), role: 'img', 'aria-label': `${loc.label} at the ${loc.pos}` }, [
    svg('rect', { class: 'ov-loc-scr', x: 0, y: 0, width: sw, height: sh }),
    svg('line', { class: 'ov-loc-bar', x1: 0, y1: 24, x2: sw, y2: 24 }),
    loc.win ? svg('rect', { class: 'ov-loc-win', x: loc.win[0], y: loc.win[1], width: loc.win[2], height: loc.win[3] }) : null,
    svg('rect', { class: 'ov-loc-hit', x: round(clamp(x + pw / 2 - mw / 2, sw - mw)), y: round(clamp(y + ph / 2 - mh / 2, sh - mh)), width: round(mw), height: round(mh) }),
  ])
}

/**
 * The two places the locator stands, for overlay.js to put in the slip: `doing` (beside the two lines, above the last steps)
 * and `ask` (a figure right of the gate's sentence). `show(mode, { step })`: mode 'doing', 'ask' or null (nothing at rest).
 * Shown, it reads the look once, then again each time app.js sets the root's `data-eye` to a key it has not read.
 */
export function mountLocator({ get = (url) => fetch(url, { headers: { accept: 'application/json' } }).then((r) => r.json()), root = document.documentElement } = {}) {
  const st = { data: null, drawn: null, asking: false, mode: null, step: null }
  const stag = el('span', { class: 'ov-stag', hidden: true })
  const what = el('b')
  const kind = el('span', { class: 'ov-loc-kind' })
  const where = el('p')
  const doingMap = el('span', { class: 'ov-loc-box' })
  const doing = el('div', { class: 'ov-loc-row', hidden: true }, [doingMap, el('div', {}, [el('p', { class: 'ov-loc-what' }, [stag, what, kind]), where])])
  const askMap = el('span', { class: 'ov-loc-box' })
  // One line, never broken mid-phrase: the label gives way (an ellipsis), the place on the screen stays whole.
  const capWhat = el('span')
  const capWhere = el('span')
  const ask = el('figure', { class: 'ov-askloc', hidden: true }, [askMap, el('figcaption', {}, [capWhat, capWhere])])
  const put = (node, key, value) => node[key] !== value && (node[key] = value)
  const draw = () => {
    const loc = st.mode ? locatorOf(st.data, { ask: st.mode === 'ask' }) : null
    put(doing, 'hidden', !loc || st.mode !== 'doing')
    put(ask, 'hidden', !loc || st.mode !== 'ask')
    const key = loc ? JSON.stringify([st.mode, st.step, loc]) : ''
    if (!loc || key === st.drawn) return
    // Every write is a mutation, and the slip redraws on mutations: only when what is shown changed.
    st.drawn = key
    const map = drawLocator(loc)
    if (st.mode === 'doing') {
      doingMap.replaceChildren(map)
      put(stag, 'hidden', !st.step)
      put(stag, 'textContent', st.step ? String(st.step) : '')
      put(what, 'textContent', loc.label)
      put(kind, 'textContent', `· ${loc.role}${loc.area ? ` in the ${loc.area}` : ''}`)
      put(where, 'textContent', [loc.app, loc.window, loc.pos].filter(Boolean).join(' · '))
    } else {
      askMap.replaceChildren(map)
      put(capWhat, 'textContent', loc.label)
      put(capWhat, 'title', loc.label)
      put(capWhere, 'textContent', ` · ${loc.pos.replace(/ of the (window|screen)$/, '')}`)
    }
  }
  const sync = async () => {
    if (!st.mode || st.asking || (st.data && (root.dataset.eye ?? st.data.key) === st.data.key)) return
    const want = root.dataset.eye
    st.asking = true
    const got = await Promise.resolve().then(() => get('/gnomon/api/eye')).catch(() => null)
    st.asking = false
    if (got && !got.unavailable) st.data = got
    draw()
    if (root.dataset.eye !== want) void sync()
  }
  new MutationObserver(() => void sync()).observe(root, { attributes: true, attributeFilter: ['data-eye'] })
  function show(mode, { step = null } = {}) {
    Object.assign(st, { mode: mode ?? null, step })
    draw()
    if (st.mode) void sync()
  }
  return { doing, ask, show }
}
