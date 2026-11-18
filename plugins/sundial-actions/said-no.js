// What the model reads when an ask was refused. dsh's own words name the tool ('the user rejected tool "screen_act"'),
// and the model said them back to the owner: "You rejected the screen action" (runs 199-202). index.js swaps them,
// in `tools/post-execute`, for a line that names the act the owner said no to.

/** dsh-tools `serviceAsk`'s result for an ask that came back rejected. */
export const REJECTED = /^Error: the user rejected tool "[^"]+"$/

const DOING = { send: 'sending it', delete: 'deleting it', discard: 'discarding it', pay: 'paying', submit: 'submitting it', post: 'posting it', update: 'installing the update' }
const PLAIN = { screen_act: 'that step on the screen', screen_undo: 'putting the old text back', gnomon_run_shell: 'running that command', bash: 'running that command', web_fetch: 'that web request', web_page: 'opening that page', web_act: 'that step on the page' }
const NOT_DONE = 'Not done:'

/**
 * The line for a refused ask: the act (a final's kind, else what the tool does) and its app, and how to say it.
 * `timeout`: nobody answered the ask, which dsh reports the same way.
 */
export function saidNo(toolName, final, timeout = false) {
  const what = `${DOING[final?.kind] ?? PLAIN[toolName] ?? 'that'}${final?.app ? ` in ${final.app}` : ''}`
  return timeout
    ? `${NOT_DONE} nobody answered the ask for ${what}. Say that plainly; the owner did not refuse it.`
    : `${NOT_DONE} the owner said no to ${what}. Say it in their terms ("You said no to ${what}."), never as a rejected tool or action.`
}

/** A result this module wrote: a call that never ran, like dsh's own rejection (gate.js `neverRan`). */
export const saidNoResult = (result) => result?.isError === true && (result.content ?? []).some((b) => typeof b?.text === 'string' && b.text.startsWith(`Error: ${NOT_DONE}`))
