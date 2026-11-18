import { describe, expect, it, vi } from 'vitest'
import { briefFor, surfaceTexts } from './index.js'

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
    expect(sections).toHaveBeenCalledWith(state, expect.anything())
    expect(out.text).toContain('The board is looking at today.')
    // What stands first, the clock with the changing facts after it (BRIEF_VERSION 6).
    expect(out.text.split('\n')[0]).toBe('The board is looking at today.')
    expect(out.text.split('\n')[1]).toMatch(/^Right now it is /)
    expect(appendSignal).toHaveBeenCalledTimes(1)
    const [type, payload] = appendSignal.mock.calls[0]
    expect(type).toBe('chat:shown')
    expect(payload).toMatchObject({ sessionId: 'session-7f', briefId: out.briefId, v: 6, cause: { kind: 'owner', noticeKey: null, askId: null } })
    expect(payload.facts.map((f) => f.key)).toEqual(['git.unpushed'])
    expect(out.present).toMatch(/^Right now: 263 commits not pushed yet/)
    expect(out.text.split('\n').at(-1)).toMatch(/^How to reply:/)
  })

  it('tells a chat each unchanged part once, until compaction; a work brief is always whole', async () => {
    const memory = { now: '2026-09-29T12:00:00.000Z', ownerFacts: [], goals: [{ name: 'Ship puzzlebox-studio', facts: [] }], commitments: [], wakeups: [], recentKnowledge: [], today: null }
    let board = 'The board is looking at today.'
    const brief = briefFor({ getState: () => ({}), appendSignal: async () => {} }, { gather: async () => memory, sections: () => [board] })
    const first = (await brief({ sessionId: 's1', cause: { kind: 'owner' } })).text
    expect(first).toContain('Ship puzzlebox-studio')
    expect(first).toContain(board)
    board = 'The board is looking at 2026-09-28.'
    const second = (await brief({ sessionId: 's1', cause: { kind: 'owner' } })).text
    expect(second).not.toContain('Ship puzzlebox-studio')
    expect(second).not.toContain('Standing context from your memory')
    expect(second).toContain(board)
    expect(second).toMatch(/How to reply:/)
    expect((await brief({ sessionId: 's2', cause: { kind: 'owner' } })).text).toContain('Ship puzzlebox-studio')
    expect((await brief({ sessionId: 's1', cause: { kind: 'work' } })).text).toContain('Ship puzzlebox-studio')
    brief.forget('s2')
    expect((await brief({ sessionId: 's1', cause: { kind: 'owner' } })).text).not.toContain('Ship puzzlebox-studio')
    brief.forget('s1')
    expect((await brief({ sessionId: 's1', cause: { kind: 'owner' } })).text).toContain('Ship puzzlebox-studio')
  })

  it('after a compaction re-sends only what left the history: a kept first brief keeps its parts (Set 2 Round 2 item 3)', async () => {
    const memory = { now: '2026-09-29T12:00:00.000Z', ownerFacts: [], goals: [{ name: 'Ship puzzlebox-studio', facts: [] }], commitments: [], wakeups: [], recentKnowledge: [], today: null }
    let board = 'The board is looking at today.'
    const brief = briefFor({ getState: () => ({}), appendSignal: async () => {} }, { gather: async () => memory, sections: () => [board] })
    const first = (await brief({ sessionId: 's1', cause: { kind: 'owner' } })).text
    board = 'The board is looking at 2026-09-28.'
    const second = (await brief({ sessionId: 's1', cause: { kind: 'owner' } })).text
    expect(second).toContain(board)
    // The compaction kept the first brief and summarized the second away: the goal stays given, the newer board goes.
    brief.kept('s1', [first, 'This is an automatically generated checkpoint ...'])
    const third = (await brief({ sessionId: 's1', cause: { kind: 'owner' } })).text
    expect(third).not.toContain('Ship puzzlebox-studio')
    expect(third).toContain(board)
    // A compaction that kept neither: whole again.
    brief.kept('s1', ['This is an automatically generated checkpoint ...'])
    expect((await brief({ sessionId: 's1', cause: { kind: 'owner' } })).text).toContain('Ship puzzlebox-studio')
  })

  it('reads the texts on a dsh surface, user messages only', () => {
    const events = { 1: { type: 'system/message', data: { message: { content: [{ type: 'text', text: 'persona' }] } } }, 2: { type: 'user/message', data: { content: [{ type: 'text', text: 'brief' }] } }, 3: { type: 'assistant/message', data: { message: { content: [] } } } }
    expect(surfaceTexts({ surface: { nodes: [1, 2, 3] }, eventAt: (seq) => events[seq] })).toEqual(['brief'])
    expect(surfaceTexts(null)).toEqual([])
  })

  it('reads a store written before the per-brief rows, and drops it at the next compaction', async () => {
    const memory = { now: '2026-09-29T12:00:00.000Z', ownerFacts: [], goals: [{ name: 'Ship puzzlebox-studio', facts: [] }], commitments: [], wakeups: [], recentKnowledge: [], today: null }
    let saved = {}
    const store = { load: () => saved, save: (value) => { saved = JSON.parse(JSON.stringify(value)) } }
    const runtime = { getState: () => ({}), appendSignal: async () => {} }
    await briefFor(runtime, { gather: async () => memory, store })({ sessionId: 's1', cause: { kind: 'owner' } })
    saved = { s1: saved.s1.flatMap(([, ...parts]) => parts) } // the old shape: the session's part prints, flat
    const restarted = briefFor(runtime, { gather: async () => memory, store })
    expect((await restarted({ sessionId: 's1', cause: { kind: 'owner' } })).text).not.toContain('Ship puzzlebox-studio')
    restarted.kept('s1', [])
    expect((await restarted({ sessionId: 's1', cause: { kind: 'owner' } })).text).toContain('Ship puzzlebox-studio')
  })

  it('remembers what a session was given across a restart, through its store', async () => {
    const memory = { now: '2026-09-29T12:00:00.000Z', ownerFacts: [], goals: [{ name: 'Ship puzzlebox-studio', facts: [] }], commitments: [], wakeups: [], recentKnowledge: [], today: null }
    let saved = {}
    const store = { load: () => saved, save: (value) => { saved = JSON.parse(JSON.stringify(value)) } }
    const runtime = { getState: () => ({}), appendSignal: async () => {} }
    expect((await briefFor(runtime, { gather: async () => memory, store })({ sessionId: 's1', cause: { kind: 'owner' } })).text).toContain('Ship puzzlebox-studio')
    expect(JSON.stringify(saved)).not.toContain('puzzlebox') // fingerprints, not the text
    const restarted = briefFor(runtime, { gather: async () => memory, store })
    expect((await restarted({ sessionId: 's1', cause: { kind: 'owner' } })).text).not.toContain('Ship puzzlebox-studio')
  })

  it('a failed memory read still briefs the turn, without the memory', async () => {
    const out = await briefFor({ getState: () => ({}), appendSignal: async () => {} }, { gather: async () => { throw new Error('db gone') } })({ sessionId: 's' })
    expect(out.text).toMatch(/How to reply:/)
  })

  it('reads the learned routes for the turn and prints them; a failed read still briefs it (Round 2, item 4)', async () => {
    const state = {}
    const routes = vi.fn(async () => [{ app: 'Notes', text: 'Worked here before in Notes: press New Note' }])
    const input = { sessionId: 's', text: 'a note in Notes' }
    const out = await briefFor({ getState: () => state, appendSignal: async () => {} }, { gather: async () => null, routes })(input)
    expect(routes).toHaveBeenCalledWith(state, input)
    expect(out.text).toContain('Learned in Notes, from your own past steps:\nWorked here before in Notes: press New Note')
    const failed = await briefFor({ getState: () => ({}), appendSignal: async () => {} }, { gather: async () => null, routes: async () => { throw new Error('db gone') } })({ sessionId: 's' })
    expect(failed.text).toMatch(/How to reply:/)
  })
})
