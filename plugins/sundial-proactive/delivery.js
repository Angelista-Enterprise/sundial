import { deliveryActs } from '@sundial/helpers/delivery-acts.js'
import { COMPANION_SESSION_ID } from '@sundial/helpers/vocab.js'
import { briefMessage, followupLine, noticeContext, wakeupPrompt } from './notice-message.js'

/**
 * Performs admitted notices: the acts the gate chose, in the chat it chose.
 *
 * The gate decides everything (W2): `payload.acts` is the list — inject, turn,
 * line, push, banner — and `payload.sessionId` the chat, null meaning the
 * conversation. This file only carries them out, and says what became of each
 * notice: `notice:delivered` or `notice:dropped` with a reason, so a notice that
 * never reached anyone is visible to the fold instead of lost. A payload with
 * no `acts` (a Notify journaled by an older build, the dev test hook) gets the
 * same acts the gate would have given it.
 *
 * Extracted from the plugin body so the channel behaviours — and the failure
 * modes that matter (a disposed companion, a thread that is gone, a notice with
 * no key, two notices in one tick) — are testable without a live agent registry.
 *
 * @param getCompanion - resolves the companion agent, creating it on first use.
 * @param getThread - resolves another chat's agent by id; throws or returns null when the thread is gone.
 * @param onDropCompanion - called when the held agent turns out to be disposed.
 * @param isDisposed - whether this plugin itself has been unloaded.
 * @param notifyNative - posts a native OS banner (a no-op unless the owner enabled them).
 * @param notifyPhone - posts to ntfy.
 * @param pushAtMac - only for a payload without `acts`.
 * @param record - appends an outcome signal: (type, payload).
 * @param brief - `gnomonKernel.brief`: a notice that wakes a turn is briefed first, with the notice as its cause (W1).
 * @param announce - says which notice was injected where: ({ noticeKey, observation, sessionId }), sessionId null = the conversation.
 * @param log / warn - injected for assertion in tests.
 */
/**
 * The two `Notify` channels the noticeGate produces. Everything else on the
 * `Notify` effect is a DIAGNOSTIC that happens to share the effect type —
 * `feedback-solicitation` (whose ask reaches the owner through
 * `state.feedback.solicitation`, not this channel) and
 * `file-watcher-capacity` (a log line naming a root that stopped being
 * watched). Neither carries a `noticeKey`, neither wants one, and neither
 * should ever spend the owner's attention budget.
 *
 * Kept as an explicit list rather than inferred from the key, so that a real
 * notice arriving without a key still warns loudly instead of being quietly
 * reclassified as a diagnostic.
 */
const NOTICE_CHANNELS = new Set(['phasic-notice', 'tonic-notice'])

export function createDelivery({ getCompanion, getThread = async () => null, onDropCompanion, isDisposed = () => false, notifyNative, notifyPhone, pushAtMac = true, record = () => {}, brief = null, announce = () => {}, log = console.log, warn = console.warn }) {
  // One promise chain. Two notices admitted in the same tick would otherwise
  // race to create the companion, producing two agents over one session id.
  let queue = Promise.resolve()

  const dropped = (payload, sessionId, reason) => {
    record('notice:dropped', { noticeKey: typeof payload?.noticeKey === 'string' ? payload.noticeKey : '', sessionId, reason, kind: typeof payload?.kind === 'string' ? payload.kind : '' })
    return { delivered: false, reason }
  }

  /**
   * A line is drawn in the thread NOW. An idle agent would leave an injected
   * message pending until its next wake, so the line goes straight onto the
   * session's log (live frame, replay and the model's next turn all read it
   * there); a running agent takes it at its next step, as any injection.
   */
  const drawLine = (agent, message) => {
    if (agent.status === 'idle' && typeof agent.session?.append === 'function') agent.session.append('user/message', message, { surfaceOp: 'append' })
    else agent.inject(message)
  }

  async function deliver({ channel, payload } = {}) {
    if (isDisposed()) return { delivered: false, reason: 'disposed' }

    // A diagnostic riding the same effect type. Not an error, and not the
    // owner's business — it was already logged by the executor.
    if (!NOTICE_CHANNELS.has(channel)) return { delivered: false, reason: 'not-a-notice-channel' }

    if (payload === null || typeof payload !== 'object' || typeof payload.noticeKey !== 'string' || payload.noticeKey === '') {
      warn('[sundial-proactive] ignoring a notice with no noticeKey:', payload)
      return dropped(payload, null, 'no-notice-key')
    }

    const phasic = channel === 'phasic-notice'
    const sessionId = typeof payload.sessionId === 'string' && payload.sessionId !== '' && payload.sessionId !== COMPANION_SESSION_ID ? payload.sessionId : null
    const acts = Array.isArray(payload.acts) ? payload.acts : deliveryActs(phasic ? 'phasic' : 'tonic', payload.route, payload.plain === true, payload.sessionId, { pushAtMac })

    let agent
    if (sessionId === null) agent = await getCompanion()
    else {
      try {
        agent = await getThread(sessionId)
      } catch {
        agent = null
      }
      if (agent === null || agent === undefined || agent.status === 'disposed') return dropped(payload, sessionId, 'session-gone')
    }

    // An agent disposed out from under us (session closed in the UI, HMR
    // unload mid-flight) must not take the kernel's effect loop with it.
    if (agent === null || agent === undefined || agent.status === 'disposed') {
      warn('[sundial-proactive] companion was disposed; dropping this notice and rebuilding on the next one')
      onDropCompanion?.()
      return dropped(payload, null, 'companion-disposed')
    }

    // W1: a reply is briefed like any turn, and the notice is its cause: `chat:shown` has folded
    // before the turn starts, so the words it says are bound to this notice even across a restart.
    const told = acts.includes('turn') && brief ? await brief({ sessionId: sessionId ?? COMPANION_SESSION_ID, cause: { kind: 'notice', noticeKey: payload.noticeKey, askId: typeof payload.askId === 'string' ? payload.askId : null } }) : null
    await told?.recorded

    // In the order the acts were always done: the context, the turn, then the two outside channels.
    for (const act of acts) {
      if (act === 'inject') {
        agent.inject(noticeContext(payload, phasic ? 'phasic' : 'tonic'))
        announce({ noticeKey: payload.noticeKey, observation: typeof payload.observation === 'string' ? payload.observation : '', sessionId })
      }
      else if (act === 'line') drawLine(agent, followupLine(payload))
      else if (act === 'turn') {
        if (told) agent.inject(briefMessage(told))
        agent.followup(wakeupPrompt(payload))
      }
      else if (act === 'push') notifyPhone?.(payload)
      else if (act === 'banner') {
        // A notifier that throws must not cost the owner the turn they were owed.
        try {
          notifyNative?.(payload)
        } catch (error) {
          warn(`[sundial-proactive] native notify failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    record('notice:delivered', { noticeKey: payload.noticeKey, sessionId, acts })
    log(`[sundial-proactive] ${acts.join('+')} ${payload.noticeKey}${sessionId ? ` in ${sessionId}` : ''}`)
    return { delivered: true, channel: phasic ? 'phasic' : 'tonic' }
  }

  return {
    deliver,
    /**
     * Queue one notice. Never rejects: a notice that cannot be spoken is a lost
     * notice, not a broken fold — this runs inside the kernel's effect executor.
     */
    enqueue(notice) {
      queue = queue.then(() => deliver(notice)).catch((error) => {
        warn(`[sundial-proactive] delivery failed: ${error instanceof Error ? error.message : String(error)}`)
        return dropped(notice?.payload, typeof notice?.payload?.sessionId === 'string' ? notice.payload.sessionId : null, 'error')
      })
      return queue
    },
  }
}
