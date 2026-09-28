import { noticeContext, wakeupPrompt } from './notice-message.js'

/**
 * Turns admitted notices into acts on the companion agent.
 *
 * Extracted from the plugin body so the two channel behaviours — and the
 * failure modes that matter (a disposed companion, a notice with no key, two
 * notices in one tick) — are testable without a live agent registry.
 *
 * @param getCompanion - resolves the companion agent, creating it on first use.
 * @param onDropCompanion - called when the held agent turns out to be disposed.
 * @param isDisposed - whether this plugin itself has been unloaded.
 * @param notifyNative - posts a native OS banner. PHASIC ONLY, and a no-op
 *   unless the owner enabled it. A tonic notice is ambient context by
 *   definition; a banner for one would be an interruption the gate never
 *   priced.
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

export function createDelivery({ getCompanion, onDropCompanion, isDisposed = () => false, notifyNative, log = console.log, warn = console.warn }) {
  // One promise chain. Two notices admitted in the same tick would otherwise
  // race to create the companion, producing two agents over one session id.
  let queue = Promise.resolve()

  async function deliver({ channel, payload } = {}) {
    if (isDisposed()) return { delivered: false, reason: 'disposed' }

    // A diagnostic riding the same effect type. Not an error, and not the
    // owner's business — it was already logged by the executor.
    if (!NOTICE_CHANNELS.has(channel)) return { delivered: false, reason: 'not-a-notice-channel' }

    if (payload === null || typeof payload !== 'object' || typeof payload.noticeKey !== 'string' || payload.noticeKey === '') {
      warn('[sundial-proactive] ignoring a notice with no noticeKey:', payload)
      return { delivered: false, reason: 'no-notice-key' }
    }

    const companion = await getCompanion()

    // An agent disposed out from under us (session closed in the UI, HMR
    // unload mid-flight) must not take the kernel's effect loop with it.
    if (companion === null || companion === undefined || companion.status === 'disposed') {
      warn('[sundial-proactive] companion was disposed; dropping this notice and rebuilding on the next one')
      onDropCompanion?.()
      return { delivered: false, reason: 'companion-disposed' }
    }

    const phasic = channel === 'phasic-notice'
    companion.inject(noticeContext(payload, phasic ? 'phasic' : 'tonic'))
    if (phasic) {
      companion.followup(wakeupPrompt(payload))
      // Second channel, not a second decision. The turn above already happened;
      // the banner only makes it visible when no chat window is open. A
      // notifier that throws must not cost the owner the turn they were owed.
      try {
        notifyNative?.(payload)
      } catch (error) {
        warn(`[sundial-proactive] native notify failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    log(`[sundial-proactive] ${phasic ? 'woke the companion for' : 'injected'} ${payload.noticeKey}`)
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
        return { delivered: false, reason: 'error' }
      })
      return queue
    },
  }
}
