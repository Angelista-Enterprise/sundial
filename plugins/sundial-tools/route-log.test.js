import { describe, expect, it, vi } from 'vitest'
import { COMPANION_SESSION_ID } from '@sundial/helpers/vocab.js'
import { createRouteLog } from './route-log.js'

// The shapes a real dsh session log holds: `seq`/`time` on the event, the message id on `data`.
const T = Date.parse('2026-09-29T12:02:10.000Z')
const owner = (text, id = 'u1', time = T) => ({ type: 'user/message', seq: 1, time, data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const say = (text, turn = 1) => ({ type: 'assistant/message', seq: 2, time: T + 5_000, data: { turn, step: 0, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text }] } } })
const call = (name, args = '{}') => ({ type: 'tool/call', seq: 3, time: T + 1_000, data: { turn: 1, step: 0, callId: 'c', name, arguments: args } })
const end = (turn = 1) => ({ type: 'turn/end', seq: 4, time: T + 9_000, data: { turn, reason: { kind: 'completed' } } })
const flush = () => new Promise((r) => setTimeout(r, 0))
const setup = () => {
  const appendSignal = vi.fn(async () => {})
  return { appendSignal, on: createRouteLog({ appendSignal, log: () => {} }) }
}

describe('chat recorder (W1)', () => {
  it('records the owner and the reply, with the tools behind the dispatch door, at dsh\'s own times', async () => {
    const { appendSignal, on } = setup()
    const s = { id: 'session-7f', header: {} }
    on(s, owner('anything I forgot? token=sk-abc'))
    on(s, call('gnomon_current_context'))
    on(s, call('gnomon_call', JSON.stringify({ name: 'gnomon_code_activity', args: { days: 7 } })))
    on(s, say('263 commits not pushed yet.'))
    on(s, say('Push when ready.'))
    on(s, end())
    await flush()
    expect(appendSignal.mock.calls).toEqual([
      ['chat:owner', { sessionId: 'session-7f', turnId: 'u1', text: 'anything I forgot? token=sk-abc', chars: 31, images: 0 }, '2026-09-29T12:02:10.000Z'],
      ['chat:said', { sessionId: 'session-7f', turnId: 'u1', text: '263 commits not pushed yet.\n\nPush when ready.', chars: 45, tools: ['gnomon_current_context', 'gnomon_code_activity'] }, '2026-09-29T12:02:19.000Z'],
    ])
  })

  it('records the conversation too — a turn a notice woke has a reply and no owner — and never a subagent', async () => {
    const { appendSignal, on } = setup()
    on({ id: COMPANION_SESSION_ID, header: {} }, { type: 'user/message', time: T, data: { source: { kind: 'plugin', form: 'notice' }, content: 'Notice key: x' } })
    on({ id: COMPANION_SESSION_ID, header: {} }, say('Pushed: puzzlebox-studio is up to date.', 3))
    on({ id: COMPANION_SESSION_ID, header: {} }, end(3))
    on({ id: 'child', header: { origin: 'subagent' } }, owner('Count the commits in puzzlebox-studio'))
    on({ id: 'child', header: { origin: 'subagent' } }, say('48'))
    on({ id: 'child', header: { origin: 'subagent' } }, end())
    await flush()
    expect(appendSignal.mock.calls.map((c) => [c[0], c[1].sessionId, c[1].turnId])).toEqual([['chat:said', COMPANION_SESSION_ID, `${COMPANION_SESSION_ID}#3`]])
  })

  it('a turn that said nothing records only the owner', async () => {
    const { appendSignal, on } = setup()
    on({ id: 's2' }, owner('ok'))
    on({ id: 's2' }, call('gnomon_signals'))
    on({ id: 's2' }, end())
    await flush()
    expect(appendSignal.mock.calls.map((c) => c[0])).toEqual(['chat:owner'])
  })
})

describe('route prediction (J1.4b), retired (W5 step 8)', () => {
  it('an owner message makes no model call and records no prediction', async () => {
    const { appendSignal, on } = setup()
    on({ id: 's1' }, owner('what am I doing right now?'))
    await flush()
    expect(appendSignal.mock.calls.map((c) => c[0])).toEqual(['chat:owner'])
  })
})
