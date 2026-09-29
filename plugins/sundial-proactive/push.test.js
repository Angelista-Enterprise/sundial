import { describe, expect, it, vi } from 'vitest'
import { createPush, phoneVerdicts } from './push.js'

describe('createPush', () => {
  it('is a no-op without a URL', async () => {
    const fetchImpl = vi.fn()
    expect(await createPush({ fetchImpl }).post({ title: 'x', body: 'y' })).toEqual({ pushed: false, reason: 'disabled' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('posts title and body to the URL, and survives a failure', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }))
    const push = createPush({ url: 'https://ntfy.sh/t', fetchImpl, log: () => {} })
    expect(await push.post({ title: 'Left for you', body: 'Standup brief' })).toEqual({ pushed: true })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://ntfy.sh/t')
    expect(fetchImpl.mock.calls[0][1].headers.title).toBe('Left for you')
    expect(fetchImpl.mock.calls[0][1].body).toBe('Standup brief')

    expect(fetchImpl.mock.calls[0][1].headers.actions).toBeUndefined()

    const broken = createPush({ url: 'https://ntfy.sh/t', fetchImpl: async () => ({ ok: false, status: 500 }), warn: () => {} })
    expect(await broken.post({ title: 'x', body: 'y' })).toEqual({ pushed: false, reason: 'http-500' })
  })

  // lane H (H4)
  it('gives up after its deadline and says why in a word', async () => {
    const hang = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    const slow = createPush({ url: 'https://ntfy.sh/t', fetchImpl: hang, warn: () => {}, timeoutMs: 20 })
    expect(await slow.post({ title: 'x', body: 'y' })).toEqual({ pushed: false, reason: 'timeout' })
    const down = createPush({ url: 'https://ntfy.sh/t', fetchImpl: async () => { throw new TypeError('fetch failed') }, warn: () => {} })
    expect(await down.post({ title: 'x', body: 'y' })).toEqual({ pushed: false, reason: 'network' })
  })

  it('carries up to three ntfy actions as a JSON header', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }))
    const push = createPush({ url: 'https://ntfy.sh/t', fetchImpl, log: () => {} })
    const actions = [{ action: 'http', label: 'Useful', url: 'https://m/verdict' }, { action: 'http', label: 'Not now', url: 'https://m/verdict' }]
    await push.post({ title: 'Gnomon', body: 'A notice', actions })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].headers.actions)).toEqual(actions)
  })
})

// lane H (H4)
describe('phoneVerdicts', () => {
  it('offers Not now first, and only Not now on an agent wait', () => {
    expect(phoneVerdicts('promise-fading')).toEqual(['not-now', 'useful', 'wrong'])
    expect(phoneVerdicts('agent-waiting')).toEqual(['not-now'])
  })
})
