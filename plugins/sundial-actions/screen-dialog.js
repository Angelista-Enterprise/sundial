// A step the screen did not take, told apart from one that failed: a dialog the keys never reach, and a pick already made.
//
// Named exports only.
import { actionFor, prune, roleOf } from './screen-look.js'

const norm = (s) => String(s ?? '').trim().toLowerCase()

/**
 * Run 219 T19: TextEdit's Save sheet runs in a process of its own and the keys sent to the app never reach it: Return changed
 * nothing five times, Save listed in every look, and the copy was never saved. A dialog's one plain default button (Save, OK,
 * Open, Choose, Done, Continue: no final's words) is what Return would have pressed; two of them, or none, is no guess.
 */
export function defaultButton(look) {
  const plain = look?.dialog === true ? prune(look.elements).filter((e) => roleOf(e) === 'button' && e.enabled !== false && /^(save|ok|open|choose|done|continue)$/.test(norm(e.label))) : []
  return plain.length === 1 ? plain[0] : null
}

/**
 * screen_act's step `r` after it ran: a Return or Enter that changed nothing in a dialog presses its plain default button by
 * name instead. `look()`: the app's newest look, read (or null); `press(plan)`: screen_act's own step.
 */
export async function pressDefault(plan, r, look, press) {
  // S5R2 (plan 2B): the Return of a panel's "Go to the folder" field (screen-save.js) only moves the panel. When it changed nothing,
  // the keys missed the panel: Save by name now would write the file in the folder the panel remembered (run 224), so the chain stops.
  if (plan.given?.goTo) return !r.refused && r.same ? { refused: `refused: nothing on screen changed after the Return in the ${plan.app} panel's "Go to the folder" field: the keys may not have reached the panel, so it may not show ${JSON.stringify(plan.given.goTo)}, and nothing after it ran (no Save). screen_look ${plan.app} to see the folder it shows; if the keys do not reach it, say so plainly.`, reason: 'panel-keys' } : r
  const seen = !r.refused && r.same && plan.verb === 'key' && /^(return|enter|kp[_-]?enter)$/.test(norm(plan.command.value)) ? await look() : null
  const one = defaultButton(seen)
  const pressed = one && (await press({ ...plan, verb: 'press', thing: { role: 'button', name: one.label }, command: { look: seen.id, ref: one.ref, action: actionFor(one, 'press') ?? 'click' } }))
  return !pressed || pressed.refused ? r : { ...pressed, note: `Return changed nothing in the ${plan.app} dialog (keys do not reach it), so its ${JSON.stringify(one.label)} button was pressed by name` }
}

/**
 * Run 222 T22: a pick on the menu item "Large" of a pop-up that already showed Large was refused as stale (its menu had
 * closed), and the Gift wrap and the Submit after it never ran. A choice the pop-up already shows needs no press: the step
 * is done. `look()`: a fresh look of the app, read (or null).
 */
export async function alreadyChosen(plan, r, look) {
  const name = norm(plan.thing?.name)
  const chosen = r.reason === 'look again' && /menu item/.test(plan.thing?.role ?? '') && name ? prune((await look())?.elements).find((e) => /pop up|combo box/.test(roleOf(e)) && norm(e.value) === name) : null
  return chosen ? { same: false, text: '', note: `${JSON.stringify(chosen.value)} is already chosen in its pop-up: nothing was pressed` } : r
}
