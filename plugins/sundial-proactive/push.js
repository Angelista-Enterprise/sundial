// The push. The tab is the room Gnomon keeps; the phone is where the owner is.
//
// One POST to an ntfy URL, the owner's own topic. It carries a title and a few
// lines of already-sanitized text — a notice the gate admitted, or the title of
// something shelved — and nothing else. Off when `notifications.ntfy` is unset.
// Never awaited by the caller: a push that fails is a lost push, not a broken
// turn, exactly like the banner.

/** @param {{ url?: string, log?: Function, warn?: Function, fetchImpl?: typeof fetch }} opts */
export function createPush({ url = '', log = console.log, warn = console.warn, fetchImpl = fetch } = {}) {
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
        })
        if (!res.ok) throw new Error(`ntfy answered ${res.status}`)
        log(`[sundial-proactive] pushed "${title}"`)
        return { pushed: true }
      } catch (error) {
        warn(`[sundial-proactive] could not push: ${error instanceof Error ? error.message : String(error)}`)
        return { pushed: false, reason: 'error' }
      }
    },
  }
}
