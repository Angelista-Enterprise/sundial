// S5R2 (plan 2H): a line break inside `type` cost a model step each time it was refused (wall 223, 224; handoff 228). In an
// editor's text area, where Return only adds a line (gate-finals.js returnAddsLine), the step types its lines.
// Review S5R2 H1: as ONE act. Sundial.app types a line break as Return (key 36, ScreenLook.swift `type`), and the gate judges
// the act as that type, then key return at its thing (gate-finals.js withReturns). The act focuses its thing first and does not
// read whether that worked: a sheet that took the keyboard after the last look would take the text and every Return. So a look
// of the app is taken just before it, and the act runs only when that look shows no sheet or dialog, the same window, and the
// thing (or, with none named, the part the keyboard is in) still a text area whose Return only adds a line.
//
// Named exports only.

import { returnAddsLine } from './gate-finals.js'

/** Review S5R2 L2: the most lines one type may hold; a longer text is a set-value, or parts. */
export const MAX_LINES = 40

/** Why a type with line breaks may not run now, given `now`, the app's look taken just before it; null when it may. */
export function linesRefusal(plan, now) {
  if (!now || now.refused) return `no look of ${plan.app} came, so where its keyboard is now is not known`
  if (now.dialog === true) return `a sheet or dialog holds the keyboard in ${plan.app}`
  if (plan.inWindow && now.window !== plan.inWindow) return `the window in front is now ${JSON.stringify(now.window ?? '')}, not ${JSON.stringify(plan.inWindow)}`
  const ref = plan.command?.ref ?? now.focused
  const el = (now.elements ?? []).find((e) => e.ref === ref)
  return returnAddsLine(plan.app, now, el) ? null : `${el ? 'its text area' : 'the part it types into'} is not one where Return only adds a line`
}

/** The step's refusal: nothing was typed and no Return pressed. */
export const linesRefused = (why) => ({ refused: `refused: nothing typed, no Return pressed: ${why}. Look again; or type the text with no line break and send return as its own key step.`, reason: 'lines-unsafe' })
