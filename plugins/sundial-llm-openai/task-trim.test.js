import { describe, expect, it } from 'vitest'
import { serializeRequest } from './index.js'
import { RECOVERY_RULE } from '@sundial/kernel/turn-brief.js'
import { TRIM, trimSteps } from './task-trim.js'

// dsh V4 messages, made-up values: two turns of one chat, the second still running.
const user = (text, kind = 'user') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind } })
const call = (id, name, text = '') => ({ role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool-call', id, name, arguments: '{}' }], source: { kind: 'model' } })
const result = (id, text) => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text }], source: { kind: 'tool' } })
const reply = (text) => ({ role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } })
const task = { id: 't2', at: '2026-11-16T09:00:00.000Z', session: 's', said: 'append Kestrel to notes.txt', did: ['key "cmd+shift+s" in TextEdit'], failed: ['key "cmd+s" in TextEdit: refused, not-found'] }

const chat = [
  user('brief one', 'sundial-shell'), user('list the Testbox files'),
  call('c1', 'gnomon_run_shell', 'Listing.'), result('c1', 'a.txt\nb.txt\n'.repeat(200)),
  reply('Two files: a.txt and b.txt.'),
  user('brief two', 'sundial-shell'), user('append Kestrel to notes.txt'),
  call('c2', 'screen_act'), result('c2', 'refused: not-found'),
  call('c3', 'screen_act'), result('c3', 'saved as copy'.repeat(100)),
  call('c4', 'screen_look'), result('c4', 'TextEdit, window "notes copy.txt"'),
]
/** Set 4 R1's first trim, kept as a variant: settled turns lose every call, the turn in flight its earlier ones. */
const CUT = { keep: false, inflight: 'cut' }
const wire = (options, t = null) => serializeRequest({ sessionId: 's', model: 'm', messages: chat, ...options }, new Map(), undefined, t).messages

describe('the chat history behind the task object (Set 4 R1)', () => {
  it('cut: a settled turn keeps its words and its reply; the turn in flight keeps its last call, with the task object before it and the rule after it', () => {
    const out = trimSteps(chat, task, CUT)
    expect(out.map((m) => m.role + (m.toolCallId ? `:${m.toolCallId}` : ''))).toEqual(['user', 'user', 'assistant', 'assistant', 'user', 'user', 'user', 'assistant', 'tool:c4', 'user'])
    expect(out[2].content).toEqual([{ type: 'text', text: 'Listing.' }])
    expect(out[6].content[0].text).toContain('failed, do not repeat (1): key "cmd+s" in TextEdit: refused, not-found')
    expect(out[6].content[0].text.split('\n').length).toBeLessThanOrEqual(6)
    expect(out[7].content.at(-1).id).toBe('c4')
    // Fable L3: the rule is an instruction, apart from the data block.
    expect(out[6].content[0].text).not.toContain(RECOVERY_RULE)
    expect(out.at(-1).content[0].text).toBe(RECOVERY_RULE)
  })

  it('the default (Fable M2, benched in task-replay.mjs): the turn in flight stays whole, the rule rides last, and every call keeps its result', () => {
    expect(TRIM).toEqual({ keep: true, inflight: 'whole' })
    const ser = wire({}, task)
    const asked = ser.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? [])
    // c1: its reply is shorter than its result, so the settled turn keeps it.
    expect(asked).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(ser.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(asked)
    expect(ser.at(-1)).toEqual({ role: 'user', content: RECOVERY_RULE })
    expect(trimSteps(chat, { ...task, failed: [] }).at(-1)).toBe(chat.at(-1))
  })

  it('a follow-up: a settled web_search whose result the reply did not carry stays for the next turn; one the reply carried goes', () => {
    const found = 'Kestrel Cafe, Main Street 4, open until 22:00. Juniper Bar, Harbour 12, open until 01:00. '.repeat(4)
    const history = [
      user('find two places for dinner'), call('w1', 'web_search'), result('w1', found), reply('Two found: Kestrel Cafe and Juniper Bar.'),
      user('and the other one, when does it close?'),
    ]
    const out = trimSteps(history, null)
    expect(out.find((m) => m.role === 'tool')?.content[0].text).toContain('Juniper Bar, Harbour 12, open until 01:00')
    expect(out.flatMap((m) => m.content).filter((b) => b.type === 'tool-call').map((b) => b.id)).toEqual(['w1'])
    // The cut variant drops it: the follow-up would have to search again.
    expect(trimSteps(history, null, CUT).some((m) => m.role === 'tool')).toBe(false)
    // A reply that carried it all: the result goes.
    const told = [...history.slice(0, 3), reply(`Here they are: ${found}${found}`), history[4]]
    expect(trimSteps(told, null).some((m) => m.role === 'tool')).toBe(false)
  })

  it('no task object: the turn in flight stays whole, the settled turns are still cut; a background call is not cut at all', () => {
    expect(trimSteps(chat, null, CUT).filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['c2', 'c3', 'c4'])
    expect(trimSteps(chat, { ...task, did: [], failed: [] }, CUT).filter((m) => m.role === 'tool')).toHaveLength(3)
    expect(wire({ purpose: 'compaction' }, task).filter((m) => m.role === 'tool')).toHaveLength(4)
    const v3 = [user('hi'), { role: 'user', content: [{ type: 'tool-result', toolCallId: 'x', content: [] }] }]
    expect(trimSteps(v3, task)).toBe(v3)
  })

  it('a settled brief keeps what stands, up to its clock line, less the blocks a later brief sends again', () => {
    const board = (cards) => `The cards on the board (read one with gnomon_look):\n${cards.map((c) => `- ${c}`).join('\n')}`
    const one = `What you know about the owner:\n- works at puzzlebox-studio\n${board(['today', 'BOX-484'])}\nRight now it is Monday 16 November 2026 at 09:00 (Europe/Amsterdam).\nRight now: the owner is in Code.\nReply rules.`
    const two = `${board(['today'])}\nRight now it is Monday 16 November 2026 at 09:05 (Europe/Amsterdam).\nReply rules.`
    const history = [user(one, 'sundial-shell'), user('first'), reply('Done.'), user(two, 'sundial-shell'), user('second')]
    const out = trimSteps(history, null)
    expect(out[0].content[0].text).toBe('What you know about the owner:\n- works at puzzlebox-studio')
    expect(out[3]).toBe(history[3])
    // Nothing left standing: the brief goes.
    expect(trimSteps([user(two, 'sundial-shell'), user('first'), reply('Done.'), user(two, 'sundial-shell'), user('again')], null)).toHaveLength(4)
  })

  it('the first step of a turn has no step before it to stand in for', () => {
    expect(trimSteps(chat.slice(0, 7), task, CUT).at(-1)).toEqual(user('append Kestrel to notes.txt'))
  })
})
