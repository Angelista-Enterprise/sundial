// Set 2 Round 2 item 3: a chat's request is a stable prefix plus what this turn adds. Two turns of one chat, with
// another time, front app and last look, through the real brief, the real persona and tool menu, and the real wire
// serializer: the system prompt and the tool block are the same bytes, turn 1's messages are a prefix of turn 2's,
// and the changing facts sit at the end of what the turn adds, next to the owner's words. Made-up values only.
import { describe, expect, it } from 'vitest'
import { serializeRequest } from '../sundial-llm-openai/index.js'
import { renderPersona } from '../../packages/kernel/src/persona.ts'
import { menuText, splitByHeat } from '../sundial-tools/layers.js'
import { briefFor } from './index.js'

const T1 = Date.parse('2026-09-03T14:00:00.000Z')
const T2 = T1 + 7 * 60_000
const at = (ms, app, look) => ({
  config: { timezone: 'Europe/Amsterdam' },
  window: { active: { processName: app, windowTitle: 'x', windowId: '1' } },
  moment: { id: 'm', startTime: new Date(ms - 20 * 60_000).toISOString(), processName: app, projectId: '~/Projects/puzzlebox-studio' },
  marks: { lastLook: { id: look, app, window: `${app} window`, n: 12, at: new Date(ms - 60_000).toISOString() } },
})
const memory = (ms, minutes) => ({ now: new Date(ms).toISOString(), ownerFacts: [{ predicate: 'worksAt', object: 'puzzlebox-studio', provenance: 'assertion', validFrom: '2026-01-01T00:00:00.000Z' }], goals: [{ name: 'Ship BOX-484', facts: [] }], today: { sessions: 3, minutes, mostRecentProcess: 'Code' }, commitments: [], wakeups: [], ownerAsk: { question: 'Which client is BOX-484 for?', askId: 'a1' }, researchGoal: null, recentKnowledge: [], assistant: null })
const schema = (name) => ({ name, description: `${name}: reads the record.`, parameters: { type: 'object', properties: {} } })
const registered = ['gnomon_today_summary', 'screen_look', 'screen_act', 'gnomon_tools', 'gnomon_call', 'gnomon_people', 'gnomon_tickets'].map(schema)
const user = (text, kind = 'user') => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] })
const reply = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })

describe('a chat request is a stable prefix plus the turn', () => {
  it('keeps the system prompt and tools byte-identical across turns with another time, app and look, and puts the changing facts last', async () => {
    let clock = T1
    let state = at(T1, 'Code', 'look-1')
    let mem = memory(T1, 180)
    const brief = briefFor({ getState: () => state, appendSignal: async () => {} }, { now: () => clock, gather: async () => mem, sections: () => ['The board is looking at today.'] })
    const { hot, cold } = splitByHeat(registered)
    // dsh's runtime-context snapshot: the menu, appended to the history only when it changes.
    const menu = user(menuText(cold), 'runtime-context')
    const request = (messages) => serializeRequest({ model: 'flash', system: renderPersona('api'), tools: hot, messages })

    const b1 = (await brief({ sessionId: 's', cause: { kind: 'owner' }, text: 'what am I doing?' })).text
    const turn1 = [user(b1, 'sundial-shell'), user('what am I doing?'), menu]
    const first = request(turn1)

    clock = T2
    state = at(T2, 'Notes', 'look-2')
    mem = memory(T2, 187)
    const b2 = (await brief({ sessionId: 's', cause: { kind: 'owner' }, text: 'and now?' })).text
    const second = request([...turn1, reply('You are in Code.'), user(b2, 'sundial-shell'), user('and now?')])

    // The system prompt and the tool block: the same bytes, and no per-turn value in either.
    expect(second.messages[0]).toEqual(first.messages[0])
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools))
    for (const value of ['14:00', '14:07', 'Notes', 'look-1', 'look-2', '180m', '187m']) expect(JSON.stringify([second.messages[0], second.tools])).not.toContain(value)
    // Append-only: everything turn 1 sent is a prefix of turn 2's request.
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages)
    // What turn 2 adds: the standing parts were given in turn 1, so its brief is the changing part alone, ending the
    // context right before the owner's words.
    const added = second.messages.at(-2).content
    expect(added).not.toContain('What you know about the owner')
    expect(added).not.toContain('The board is looking at today.')
    expect(added.startsWith('Right now it is')).toBe(true)
    for (const fact of ['Today so far: 3 activity session(s), about 187m', 'You are waiting on the owner', 'the owner is in Notes', 'you last looked at Notes']) expect(added).toContain(fact)
    expect(second.messages.at(-1)).toEqual({ role: 'user', content: 'and now?' })
  })
})
