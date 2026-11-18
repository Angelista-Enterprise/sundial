// Set 3 R3: a look a chat's tool asks for is on the record under that chat (`screen:asked`), so privateReads files it there.
import { describe, expect, it } from 'vitest'
import { callChat } from './call-chat.js'

const rig = () => {
  const rows = []
  const sent = []
  const chat = callChat(async (type, payload) => void rows.push([type, payload]), (command) => sent.push(command))
  return { rows, sent, chat }
}

describe('callChat', () => {
  it('a look or an act asked in a chat\'s call is put on the record with that chat, through the call\'s awaits', async () => {
    const { rows, sent, chat } = rig()
    const tool = chat.wrap({ name: 'screen_look', isConcurrencySafe: () => false, execute: async () => { await new Promise((done) => setTimeout(done, 5)); chat.send({ type: 'look', id: 'look-1' }); chat.send({ type: 'act', id: 'act-2' }); return 'ok' } })
    expect(tool.name).toBe('screen_look')
    expect(tool.isConcurrencySafe()).toBe(false)
    expect(await tool.execute({}, { agent: { session: { id: 'chat-a' } } })).toBe('ok')
    expect(rows).toEqual([['screen:asked', { id: 'look-1', session: 'chat-a' }], ['screen:asked', { id: 'act-2', session: 'chat-a' }]])
    expect(sent.map((c) => c.id)).toEqual(['look-1', 'act-2'])
  })

  it('a look with no chat, or any other command, goes out with nothing on the record', async () => {
    const { rows, sent, chat } = rig()
    chat.send({ type: 'look', id: 'look-3' })
    await chat.wrap({ execute: async () => chat.send({ type: 'marks', marks: [] }) }).execute({}, { agent: { session: { id: 'chat-a' } } })
    await chat.wrap({ execute: async () => chat.send({ type: 'look', id: 'look-4' }) }).execute({}, {})
    expect(rows).toEqual([])
    expect(sent).toHaveLength(3)
  })

  it('two chats\' calls running at once keep their own chat', async () => {
    const { rows, chat } = rig()
    const tool = chat.wrap({ execute: async (args) => { await new Promise((done) => setTimeout(done, args.wait)); chat.send({ type: 'look', id: args.id }) } })
    await Promise.all([tool.execute({ id: 'look-a', wait: 10 }, { agent: { session: { id: 'chat-a' } } }), tool.execute({ id: 'look-b', wait: 1 }, { agent: { session: { id: 'chat-b' } } })])
    expect(Object.fromEntries(rows.map(([, p]) => [p.id, p.session]))).toEqual({ 'look-a': 'chat-a', 'look-b': 'chat-b' })
  })
})
