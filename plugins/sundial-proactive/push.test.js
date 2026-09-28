import { describe, expect, it, vi } from 'vitest'
import { createPush } from './push.js'

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
    expect(await broken.post({ title: 'x', body: 'y' })).toEqual({ pushed: false, reason: 'error' })
  })

  it('carries up to three ntfy actions as a JSON header', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }))
    const push = createPush({ url: 'https://ntfy.sh/t', fetchImpl, log: () => {} })
    const actions = [{ action: 'http', label: 'Useful', url: 'https://m/verdict' }, { action: 'http', label: 'Not now', url: 'https://m/verdict' }]
    await push.post({ title: 'Gnomon', body: 'A notice', actions })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].headers.actions)).toEqual(actions)
  })
})
