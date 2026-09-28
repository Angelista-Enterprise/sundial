// A thread's own model (J1.10).
//
// dsh records the route every request went out on as a `request/context`
// event in the session's log. So a thread that switched models does not need
// a second store to remember it across a restart: its log already says which
// model served its last step. Pure; `events` in, a selection or null out.
export function threadModelOf(events) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'request/context') continue
    const provider = event.data?.provider
    const model = event.data?.model
    if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') return { provider, model }
  }
  return null
}
