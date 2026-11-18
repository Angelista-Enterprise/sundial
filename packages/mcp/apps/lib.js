// What every Sundial MCP App shares: the bridge to the host, the host's theme, one frame.
//
// An app is one bundled HTML page the host draws in a sandboxed iframe when a
// tool with `_meta.ui.resourceUri` returns. It gets the tool's result over the
// MCP Apps bridge (`ontoolresult`), draws `structuredContent` with the shell's
// own drawing modules, and takes the host's theme (light or dark) and its
// `--color-*` variables, which palette.css maps onto Sundial's names.
//
// `boot` takes a transport so the test harness can drive the page without a
// window: in a browser the default is the host's postMessage channel. `draw`
// gets the app too, for a page with an act on it (Seen, Full screen).
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps'
import { el } from '../../../plugins/sundial-theme/shell/surfaces.js'

/** The surface frame the web client gives every drawing: a small title, the claim beside it, the body. */
export function frame(title, because, body) {
  return el('section', { class: 'surface' }, [
    el('div', { class: 'surface-head' }, [el('span', { class: 'surface-title', text: title }), because ? el('span', { class: 'surface-because', text: `· ${because}` }) : null]),
    el('div', { class: 'surface-body' }, body),
  ])
}

/** An act the owner can take on the page: the web client's own link-button. */
export function act(text, onclick) {
  return el('button', { type: 'button', class: 'link', text, onclick })
}

/** `2h 05m`, the way every other surface says a duration. */
export function hm(totalMinutes) {
  const h = Math.floor(totalMinutes / 60)
  const m = Math.round(totalMinutes % 60)
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** A clock time from a waking-day minute (minutes since `dayStartsAt`, 04:00 on every row). */
export function clock(min, dayStartsAt = 4) {
  const m = (dayStartsAt * 60 + Math.round(min)) % (24 * 60)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function applyTheme(context) {
  if (!context) return
  if (context.theme === 'light' || context.theme === 'dark') applyDocumentTheme(context.theme)
  const variables = context.styles?.variables ?? null
  if (variables && typeof variables === 'object') applyHostStyleVariables(variables)
}

/** The data a tool result carries: `structuredContent`, or the first text block when it is JSON. */
export function dataOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = result?.content?.find((c) => c.type === 'text')?.text
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

export async function boot(name, draw, { transport, root = document.getElementById('root'), autoResize = true } = {}) {
  const app = new App({ name: `sundial-${name}`, version: '0.1.0' }, {}, { autoResize })
  app.ontoolresult = (result) => {
    root.replaceChildren()
    const data = dataOf(result)
    root.append(data ? draw(data, app) : el('div', { class: 'surface-fail', text: 'Nothing to draw: the tool returned no data.' }))
  }
  app.onhostcontextchanged = applyTheme
  await app.connect(transport)
  applyTheme(app.getHostContext())
  return app
}
