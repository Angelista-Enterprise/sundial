// When a set-value may replace what a field holds (moved out of screen-tools.js, S5R1). A set-value never adds, it replaces all:
//   - Fable M4: a text area a look read in part (`cut`) is never replaced.
//   - S5R1 (Fable H3): nor one read whole with its blank lines, indents or runs of spaces folded (`folded`): the set-value would
//     put the owner's text back as one block. Gnomon's own text is the one exception: it knows that text exactly.
//   - Run 11 T07: a field that holds text is replaced only with replace: true, unless it holds Gnomon's own text.
// Gnomon's own text (`mine`): the field this chat last set-valued, in this chat's task now, the owner's hand still since, by a real
// label and role, and as long as what Gnomon set (S5R1, Fable M2). Sundial.app's `own` then decides at the act.
import { taskOf } from '@sundial/helpers/task-of.js'
import { roleOf } from './screen-look.js'

const url = (text) => /^(https?:\/\/\S|[\w-]+(\.[\w-]+)+(\/|\?|$))/i.test(String(text ?? '').trim())
const name = (e, or) => JSON.stringify(String(e.label || or).slice(0, 40))
/** The field's length: the look's words, or its real length when the look folded or cut them (never the text). */
const length = (e) => Number(e.chars ?? String(e.value ?? '').length)

const CUT = (e) => `${name(e, 'this text area')} was read in part (the last ${String(e.value ?? '').length} of ${e.cut} characters, spacing folded): a set-value would replace what was not read. Edit by click and type.`
const FOLDED = (e) => `${name(e, 'this text area')} holds blank lines, indents or runs of spaces the look folded (${length(e)} characters): a set-value, replace or not, would put it back as one block and lose that layout. Edit by click and type.`
const WIPES = (e) => `set-value replaces ALL the text in ${name(e, 'this field')} (${String(e.value).length} characters), it never adds. To add: click at the end and type, or append with the shell for a note file. To replace it all: replace: true.`

/** S5R1 (Fable M2): the field may hold Gnomon's own text, from this chat's last set-value (`marks.chats[session].set`), not stale. */
export function mine(e, state, session, app) {
  const set = state?.marks?.chats?.[session ?? '']?.set
  const task = taskOf(state, session)?.id
  const hand = Date.parse(state?.lifeEvent?.idle?.ownerHandAt ?? '')
  return Boolean(set && task && set.task === task && !(hand > Date.parse(set.at)) && e?.label && set.app === app && set.name === String(e.label) && set.role === roleOf(e) && set.chars === length(e))
}

// An address bar holding one address, given another, is navigation and not the owner's own writing: run 16 refused it twice,
// cost two calls and part of a task, and protected nothing.
const wipes = (e, given, own) => /TextArea|ComboBox|TextField/.test(e?.role ?? '') && String(e.value ?? '').trim() !== '' && given.replace !== true && !(url(e.value) && url(given.value)) && !own

/** Run 253 T19: two set-values sent `replace: "true"`, the string, were refused and the name never reached the Save panel. "true" and "false" are the booleans. */
export const replaceOf = (args) => (typeof args?.replace === 'string' && /^\s*(?:true|false)\s*$/i.test(args.replace) ? { ...args, replace: /true/i.test(args.replace) } : args)

/** Null when a set-value on `e` (a thing of the app's look) may go; else why not. `given`: the call's arguments as an object. */
export function setRefusal(e, verb, given, state, session, app) {
  if (verb !== 'set-value' || !e) return null
  if (e.cut) return CUT(e)
  const own = mine(e, state, session, app)
  if (e.folded && !own) return FOLDED(e)
  return wipes(e, given, own) ? WIPES(e) : null
}
