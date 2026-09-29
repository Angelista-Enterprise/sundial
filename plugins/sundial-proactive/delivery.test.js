// The delivery half of the notice gate: what a phasic admission does to the
// companion agent that a tonic one does not.
import { describe, it, expect, vi } from 'vitest'
import { createDelivery } from './delivery.js'

function fakeAgent(status = 'idle') {
  return { id: 'gnomon-companion', status, inject: vi.fn(), followup: vi.fn() }
}

function notice(channel, overrides = {}) {
  return {
    channel,
    payload: { kind: 'absent', observation: 'No break since 13:20.', evidence: ['focus block since 15:40'], weight: 1.84, noticeKey: 'absent:break', ...overrides },
  }
}

function harness(agent = fakeAgent(), options = {}) {
  const dropped = vi.fn()
  // Captured rather than discarded: "did this warn?" is itself an assertion —
  // a diagnostic channel that logs a defect is the bug, not the drop.
  const warnings = []
  const delivery = createDelivery({
    getCompanion: async () => agent,
    onDropCompanion: dropped,
    log: () => {},
    warn: (...args) => warnings.push(args.join(' ')),
    ...options,
  })
  return { delivery, agent, dropped, warnings }
}

describe('createDelivery', () => {
  it('wakes the companion on a phasic notice — injection alone would leave an idle agent idle', async () => {
    const { delivery, agent } = harness()
    const result = await delivery.deliver(notice('phasic-notice'))

    expect(result).toEqual({ delivered: true, channel: 'phasic' })
    expect(agent.inject).toHaveBeenCalledTimes(1)
    expect(agent.followup).toHaveBeenCalledTimes(1)
  })

  it('a plain phasic notice is its own sentence: the banner and push, no model turn (UC4 §10)', async () => {
    const native = vi.fn()
    const { delivery, agent } = harness(fakeAgent(), { notifyNative: native })
    await delivery.deliver(notice('phasic-notice', { plain: true }))
    expect(agent.followup).not.toHaveBeenCalled()
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('injects a tonic notice WITHOUT waking anyone — the ambient channel never interrupts', async () => {
    const { delivery, agent } = harness()
    const result = await delivery.deliver(notice('tonic-notice'))

    expect(result).toEqual({ delivered: true, channel: 'tonic' })
    expect(agent.inject).toHaveBeenCalledTimes(1)
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('carries the observation, the evidence and the key into the injected context', async () => {
    const { delivery, agent } = harness()
    await delivery.deliver(notice('tonic-notice'))

    const text = agent.inject.mock.calls[0][0].content[0].text
    expect(text).toContain('No break since 13:20.')
    expect(text).toContain('focus block since 15:40')
    expect(text).toContain('absent:break')
  })

  it('leaves the rating to the buttons: the wake-up asks for no key-bearing sign-off line', async () => {
    const { delivery, agent } = harness()
    await delivery.deliver(notice('phasic-notice'))

    const text = agent.followup.mock.calls[0][0].content[0].text
    expect(text).not.toContain('final line')
    expect(text).toContain('no sign-off')
  })

  it('marks injected context as a plugin notice, not as something the owner said', async () => {
    const { delivery, agent } = harness()
    await delivery.deliver(notice('tonic-notice'))

    const { source } = agent.inject.mock.calls[0][0]
    expect(source.kind).toBe('plugin')
    expect(source.form).toBe('notice')
    expect(source.summary).toContain('No break since 13:20')
  })

  it('drops a notice with no key rather than delivering an unratable one', async () => {
    const { delivery, agent } = harness()
    const result = await delivery.deliver({ channel: 'phasic-notice', payload: { observation: 'something' } })

    expect(result).toEqual({ delivered: false, reason: 'no-notice-key' })
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it.each(['feedback-solicitation', 'file-watcher-capacity'])('ignores the %s diagnostic without warning about a missing key', async (channel) => {
    const { delivery, agent, warnings } = harness()
    // These ride the `Notify` effect but are not notices: the solicitation reaches
    // the owner through `state.feedback.solicitation`, and the capacity line is a
    // log entry naming a root that stopped being watched. Warning about their
    // missing `noticeKey` reported a defect that was not there.
    const result = await delivery.deliver({ channel, payload: { question: 'Was this useful?' } })

    expect(result).toEqual({ delivered: false, reason: 'not-a-notice-channel' })
    expect(agent.inject).not.toHaveBeenCalled()
    expect(warnings).toEqual([])
  })

  it('releases a disposed companion instead of speaking into it, and rebuilds next time', async () => {
    const { delivery, agent, dropped } = harness(fakeAgent('disposed'))
    const result = await delivery.deliver(notice('phasic-notice'))

    expect(result).toEqual({ delivered: false, reason: 'companion-disposed' })
    expect(agent.inject).not.toHaveBeenCalled()
    expect(dropped).toHaveBeenCalledTimes(1)
  })

  it('says nothing once the plugin itself is unloaded', async () => {
    const { delivery, agent } = harness(fakeAgent(), { isDisposed: () => true })
    const result = await delivery.deliver(notice('phasic-notice'))

    expect(result).toEqual({ delivered: false, reason: 'disposed' })
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('builds the companion exactly once when two notices arrive in the same tick', async () => {
    const agent = fakeAgent()
    const getCompanion = vi.fn(async () => agent)
    const delivery = createDelivery({ getCompanion, log: () => {}, warn: () => {} })

    // Not awaited individually — this is the race the queue exists to prevent.
    delivery.enqueue(notice('phasic-notice'))
    await delivery.enqueue(notice('tonic-notice', { noticeKey: 'drift:deploy' }))

    expect(agent.inject).toHaveBeenCalledTimes(2)
    // Serialized, so the second call observes the first's companion.
    expect(getCompanion).toHaveBeenCalledTimes(2)
  })

  it('posts a native banner for a phasic notice — the chat turn is invisible with no window open', async () => {
    const notifyNative = vi.fn()
    const { delivery } = harness(fakeAgent(), { notifyNative })
    await delivery.deliver(notice('phasic-notice'))

    expect(notifyNative).toHaveBeenCalledTimes(1)
    expect(notifyNative.mock.calls[0][0].noticeKey).toBe('absent:break')
  })

  it('posts NO banner for a tonic notice — ambient context that interrupts is not ambient', async () => {
    const notifyNative = vi.fn()
    const { delivery } = harness(fakeAgent(), { notifyNative })
    await delivery.deliver(notice('tonic-notice'))

    expect(notifyNative).not.toHaveBeenCalled()
  })

  it('still delivers the turn when the banner throws — the second channel must not cost the first', async () => {
    const notifyNative = vi.fn(() => {
      throw new Error('no bundle identity')
    })
    const { delivery, agent, warnings } = harness(fakeAgent(), { notifyNative })
    const result = await delivery.deliver(notice('phasic-notice'))

    expect(result).toEqual({ delivered: true, channel: 'phasic' })
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(warnings.join(' ')).toContain('native notify failed')
  })

  // lane D — #6 the right channel
  it('pushes every phasic notice to ntfy, and the banner on every route but phone', async () => {
    const sent = async (route, options = {}) => {
      const notifyNative = vi.fn()
      const notifyPhone = vi.fn()
      const { delivery, agent } = harness(fakeAgent(), { notifyNative, notifyPhone, ...options })
      await delivery.deliver(notice('phasic-notice', route ? { route } : {}))
      expect(agent.followup).toHaveBeenCalledTimes(1)
      return [notifyNative.mock.calls.length, notifyPhone.mock.calls.length]
    }
    expect(await sent('mac')).toEqual([1, 1])
    expect(await sent('phone')).toEqual([0, 1])
    expect(await sent(undefined)).toEqual([1, 1])
    // Banner-only at the Mac, when the owner chose it.
    expect(await sent('mac', { pushAtMac: false })).toEqual([1, 0])
  })

  it('pushes to the phone even when the banner throws', async () => {
    const notifyPhone = vi.fn()
    const notifyNative = vi.fn(() => {
      throw new Error('no bundle identity')
    })
    const { delivery } = harness(fakeAgent(), { notifyNative, notifyPhone })
    await delivery.deliver(notice('phasic-notice'))
    expect(notifyPhone).toHaveBeenCalledTimes(1)
  })

  it('never rejects into the effect executor when delivery throws', async () => {
    const delivery = createDelivery({
      getCompanion: async () => {
        throw new Error('registry is gone')
      },
      log: () => {},
      warn: () => {},
    })

    await expect(delivery.enqueue(notice('phasic-notice'))).resolves.toEqual({ delivered: false, reason: 'error' })
  })
})
