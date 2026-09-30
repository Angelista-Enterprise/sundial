import { describe, expect, it, vi } from 'vitest'
import { briefFor } from './index.js'

describe('gnomonKernel.brief (W1)', () => {
  it('appends exactly one chat:shown carrying the brief id it returns, and returns the rendered text', async () => {
    const appendSignal = vi.fn(async () => {})
    const state = { git: { unpushed: { '~/Projects/puzzlebox-studio': { branch: 'main', ahead: 263, since: '2026-09-29T11:00:00.000Z', updatedAt: '2026-09-29T12:00:00.000Z' } } } }
    const gather = vi.fn(async () => null)
    const sections = vi.fn(() => ['The board is looking at today.'])
    const out = await briefFor({ getState: () => state, appendSignal }, { now: () => Date.parse('2026-09-29T12:02:10.000Z'), gather, sections })({ sessionId: 'session-7f', cause: { kind: 'owner' }, text: 'status?' })
    await out.recorded
    // W1 step 5: the memory is read once per brief, from the same state; the sections are rendered in.
    expect(gather).toHaveBeenCalledWith(state)
    expect(sections).toHaveBeenCalledWith(state)
    expect(out.text).toContain('The board is looking at today.')
    expect(out.text.split('\n')[0]).toMatch(/^Right now it is /)
    expect(appendSignal).toHaveBeenCalledTimes(1)
    const [type, payload] = appendSignal.mock.calls[0]
    expect(type).toBe('chat:shown')
    expect(payload).toMatchObject({ sessionId: 'session-7f', briefId: out.briefId, v: 1, cause: { kind: 'owner', noticeKey: null, askId: null } })
    expect(payload.facts.map((f) => f.key)).toEqual(['git.unpushed'])
    expect(out.present).toMatch(/^Right now: 263 commits not pushed yet/)
    expect(out.text.split('\n').at(-1)).toMatch(/^How to reply:/)
  })

  it('a failed memory read still briefs the turn, without the memory', async () => {
    const out = await briefFor({ getState: () => ({}), appendSignal: async () => {} }, { gather: async () => { throw new Error('db gone') } })({ sessionId: 's' })
    expect(out.text).toMatch(/How to reply:/)
  })
})
