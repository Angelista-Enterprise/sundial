import { describe, expect, it, vi } from 'vitest'
import { COMPANION_SESSION_ID, createRouteLog } from './route-log.js'

const owner = (text, id = 'u1') => ({ type: 'user/message', id, ts: '2026-09-22T11:00:00.000Z', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const call = (name) => ({ type: 'tool/call', data: { name, callId: 'c', arguments: '{}' } })
const end = () => ({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
const answers = { gnomon_current_context: { type: 'noul', noul: 0.91 }, gnomon_semantic_search: { type: 'noul', noul: 0.12 }, difficulty: { type: 'score', score: 1.2, probabilities: { 1: 0.7, 2: 0.3 } }, needs_live_data: { type: 'noul', noul: 0.8 }, about_the_assistant: { type: 'noul', noul: 0.05 } }
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('route log (J1.4b)', () => {
  it('predicts on the owner\'s message and records the loop\'s real calls at turn end, paired by turn id', async () => {
    const judgeNow = vi.fn(async () => ({ answers, model: 'typesafe/jev-latest' }))
    const appendSignal = vi.fn(async () => {})
    const on = createRouteLog({ judgeNow, appendSignal, log: () => {} })
    on({ id: 's1' }, owner('what am I doing right now? token=sk-abc'))
    await flush()
    on({ id: 's1' }, call('gnomon_current_context'))
    on({ id: 's1' }, call('gnomon_current_context'))
    on({ id: 's1' }, call('gnomon_recent_activity'))
    // A cold tool through the dispatch door counts as the tool behind it.
    on({ id: 's1' }, { type: 'tool/call', data: { name: 'gnomon_call', callId: 'c2', arguments: JSON.stringify({ name: 'gnomon_code_activity', args: { days: 7 } }) } })
    on({ id: 's1' }, end())
    await flush()
    expect(judgeNow.mock.calls[0][0]).toMatchObject({ purpose: 'rank', questionSetId: 'route-ask' })
    expect(judgeNow.mock.calls[0][0].state.question).toContain('what am I doing right now')
    const [predicted, actual] = appendSignal.mock.calls
    expect(predicted[0]).toBe('ask:route-predicted')
    expect(predicted[1]).toMatchObject({ sessionId: 's1', turnId: 'u1', query: 'what am I doing right now? token=sk-abc', difficulty: 1, difficultyP: 0.7, needsLive: 0.8, aboutAssistant: 0.05, model: 'typesafe/jev-latest' })
    expect(predicted[1].predicted).toMatchObject({ gnomon_current_context: 0.91, gnomon_semantic_search: 0.12, gnomon_goals: null })
    expect(actual).toEqual(['ask:route-actual', { sessionId: 's1', turnId: 'u1', tools: ['gnomon_current_context', 'gnomon_recent_activity', 'gnomon_code_activity'] }])
  })

  it('skips the companion, plugin-injected messages, and tool calls outside an open turn; a null judge records nothing predicted', async () => {
    const judgeNow = vi.fn(async () => null)
    const appendSignal = vi.fn(async () => {})
    const on = createRouteLog({ judgeNow, appendSignal, log: () => {} })
    on({ id: COMPANION_SESSION_ID }, owner('hello'))
    on({ id: 's2' }, { type: 'user/message', data: { source: { kind: 'plugin', form: 'notice' }, content: 'Notice key: x' } })
    on({ id: 's2' }, call('gnomon_signals'))
    on({ id: 's2' }, end())
    on({ id: 's2' }, owner('ok'))
    await flush()
    expect(judgeNow).toHaveBeenCalledTimes(0)
    on({ id: 's3' }, owner('what did I do yesterday afternoon?'))
    await flush()
    on({ id: 's3' }, end())
    await flush()
    expect(judgeNow).toHaveBeenCalledTimes(1)
    // No prediction row when the judge is off; the actual side is still logged.
    expect(appendSignal.mock.calls.map((c) => c[0])).toEqual(['ask:route-actual'])
  })
})
