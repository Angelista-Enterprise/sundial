// S5R1: a Return in a native window presses its default button (its sheet's or dialog's when one holds the keyboard): the look
// marks that button `default: true` (Sundial.app reads AXDefaultButton). Pure: no state, no model.

import { roleOf } from './screen-look.js'

/** A part that keeps its Return: a text area adds a line, a search field or a combo box runs or picks (S5R1). */
const KEEPS_RETURN = /text ?area|textbox|search|combo/
/** A role description or an editable mark that says a group takes typed text: Chromium's "text entry area", a message or compose box. */
const ENTRY = /text entry|editable|message|compose/i
/**
 * S5R1: the role a part is judged by. A web composer (contenteditable) can come as a group, an unknown or a web area: it is the
 * text area it acts as when the app says so (its role description, or `editable`), else when its value takes text (`settable`).
 */
export const boxRole = (e) => (/^(?:group|unknown|web area)$/.test(roleOf(e)) && (e?.editable === true || ENTRY.test(String(e?.roleDescription ?? '')) || e?.settable === true) ? 'text area' : roleOf(e))
/** A page's part is a web form's, which `formFinal` reads; a native default button is not what its Return presses. */
const inside = (a, b) => Array.isArray(a) && Array.isArray(b) && a[0] + a[2] / 2 >= b[0] && a[1] + a[3] / 2 >= b[1] && a[0] + a[2] / 2 <= b[0] + b[2] && a[1] + a[3] / 2 <= b[1] + b[3]

/**
 * The part a Return in `target` presses, the look's default button, or null. `target`: a ref of the look, a part of it, or a
 * plan's thing (`{ role, name }`); none is the part the look has the keyboard in, and nothing there (or a ref the look does not
 * hold) is the window itself. A one-line field, a checkbox, a row, a popup or a button all pass Return to the default button.
 * Null when the target keeps its Return or is a web page's, the look marks no default button, or that button is off.
 */
export function defaultFinal(look, target = look?.focused) {
  const elements = look?.elements ?? []
  const part = typeof target === 'string' ? elements.find((e) => e.ref === target) : target?.ref ? (elements.find((e) => e.ref === target.ref) ?? target) : target
  const web = (e) => elements.some((w) => /WebArea/.test(w.role ?? '') && inside(e.frame, w.frame)) || /^(web area|html content)$/i.test(e.in ?? '')
  if (part && (KEEPS_RETURN.test(boxRole(part)) || web(part))) return null
  const button = elements.find((e) => e.ref && e.ref === look.defaultButton?.ref) ?? elements.find((e) => e.default === true)
  return button && button.enabled !== false && !web(button) ? button : null
}
