// The hint a screen act's refusal carries, by the app's reason: what to do next (moved out of screen-tools.js, S5R2).
//
// Named exports only.
import { isRedactedPlaceholder } from '@sundial/helpers/redact/redact-policy.js'
import { PRIVATE_SAY } from './gate.js'
import { submenuHint } from './screen-look.js'

/** What to do after a refusal, by the app's reason. */
export const NEXT = {
  'look again': 'The screen changed since the look: call screen_look, then act on a ref from it.',
  covered: 'Another window lies over it, or the app is not in front: open the app ({app} alone), look again, then act.',
  'unknown-action': 'That thing does not take that action: use a verb from its look line, or click.',
  'unknown-key': 'Keys: return, tab, escape, space, delete, up, down, left, right, page-up, page-down, a letter or a digit, with cmd+, shift+, alt+, ctrl+ before it.',
  'refused-key': 'That key is never pressed for the owner: say it, and let them press it.',
  'owner-moved': 'The owner moved the mouse or typed: ask before you try again.',
  'private app': PRIVATE_SAY,
  'focus-unknown': 'The app could not say where the keyboard is: focus the field (action focus on its ref), then type.',
  'bad-click': 'button is left or right; modifiers are cmd, shift, alt, ctrl.',
  'secure-input': 'A password is being typed somewhere: wait for the owner to finish, then try again.',
  'secure-field': 'That is a password field: the owner types it.',
  'sign-in': 'That is a sign-in window: the owner does it.',
  'protected-app': 'Nothing is done for the owner in that app: say the step, and let them do it.',
  'app-changed': 'Another app came to the front: open the app ({app} alone), look again, then act.',
  'not-responding': 'The app did not answer: wait a few seconds and look again; if it still does not answer, tell the owner.',
  'not-in-text': 'That text, or that line, is not in the field: copy the words exactly as its value shows them, or give line (1 is the first).',
  'no-access': 'Sundial has no Accessibility grant: the owner turns it on in System Settings, Privacy & Security.',
  'not-found': 'Nothing by that name shows: screen_look {app}, then act on a ref from it.',
  // Doc 31 (run 254 T19): TextEdit still starting after a double-click read as no-window, and Gnomon gave up.
  'no-window': 'The app has no window open: if a step just opened a file in it, it may still be starting (a first start can take 20 s): wait a few seconds and look again. Else open one first (pick-menu, or a key), then look.',
  'not-running': 'The app is not running: open it ({app} alone), then look.',
  'no-such-app': 'No app by that name is on this Mac: use the name as the owner sees it.',
  'no-such-window': 'No window of that app has that in its title: the look\'s "Other windows" line names them.',
  'cannot-raise': 'The window was found but did not come to the front (another desktop, a full-screen space): ask the owner to bring it up.',
  ax: 'The app did not take it: look again, then try click on the same thing.',
  'outside-window': 'The point is outside the window as it is now: screen_look again, then give x and y from the window\'s top left.',
  'bad-drag': 'A drag needs to: a ref of the same look, or [x, y] in the window.',
  ambiguous: 'More than one menu item has that name: send the pick-menu again with the path of the one you mean as its value.',
}
/** The hint for a refusal, with the menu words the app read for it (`names`): a submenu's first items, or the paths of items alike. `step`: the app and the name a submenu refusal fills in. */
export const next = (reason, names, step = {}) => {
  const name = String(step.name ?? '<the item>')
  const hint = reason === 'submenu' ? submenuHint(step.app, name.includes('>') ? name : `<its menu> > ${name}`) : NEXT[reason] ?? (/^ax-/.test(reason ?? '') ? NEXT.ax : '')
  const words = (names ?? []).filter((n) => typeof n === 'string' && n && !isRedactedPlaceholder(n)).map((n) => JSON.stringify(n))
  return hint ? `. ${hint}${words.length ? ` ${reason === 'ambiguous' ? 'The paths' : 'Its first items'}: ${words.join(', ')}.` : ''}` : ''
}
