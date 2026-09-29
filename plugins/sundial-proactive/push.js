// The push. The tab is the room Gnomon keeps; the phone is where the owner is.
//
// One POST to an ntfy URL, the owner's own topic. It carries a title and a few
// lines of already-sanitized text — a notice the gate admitted, or the title of
// something shelved — and nothing else. Off when `notifications.ntfy` is unset.
// Never awaited by the turn: a push that fails is not a broken turn. Since lane H
// (H4) it is not a lost notice either — it has a 10 s deadline, and the caller
// reads the outcome to fall back to the banner and record `push:failed`.

/** lane H (H4): the taps a push offers. "Not now" first; a coding agent's wait is not something to rate. */
export const phoneVerdicts = (kind) => (typeof kind === 'string' && kind.startsWith('agent-') ? ['not-now'] : ['not-now', 'useful', 'wrong'])

/** How long ntfy gets before the push counts as failed. */
export const PUSH_TIMEOUT_MS = 10_000

/** @param {{ url?: string, log?: Function, warn?: Function, fetchImpl?: typeof fetch, timeoutMs?: number }} opts */
export function createPush({ url = '', log = console.log, warn = console.warn, fetchImpl = fetch, timeoutMs = PUSH_TIMEOUT_MS } = {}) {
  return {
    enabled: url !== '',
    /**
     * `actions` are ntfy action objects (`verdictActions` in
     * `@sundial/helpers/verdict-sign.js`): the three taps on the phone. Sent in
     * the `Actions` header in ntfy's JSON form; none means a one-way push.
     * @param {{ title: string, body: string, tags?: string, actions?: object[] }} message
     */
    async post({ title, body, tags = 'sundial', actions = [] }) {
      if (url === '') return { pushed: false, reason: 'disabled' }
      const text = String(body ?? '').trim().slice(0, 1200)
      if (text === '') return { pushed: false, reason: 'empty' }
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            title: String(title ?? 'Gnomon').slice(0, 120),
            tags,
            'content-type': 'text/plain; charset=utf-8',
            ...(actions.length > 0 ? { actions: JSON.stringify(actions.slice(0, 3)) } : {}),
          },
          body: text,
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) {
          warn(`[sundial-proactive] could not push: ntfy answered ${res.status}`)
          return { pushed: false, reason: `http-${res.status}` }
        }
        log(`[sundial-proactive] pushed "${title}"`)
        return { pushed: true }
      } catch (error) {
        warn(`[sundial-proactive] could not push: ${error instanceof Error ? error.message : String(error)}`)
        // A word, never the message: it can carry the topic URL.
        return { pushed: false, reason: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network' }
      }
    },
  }
}
