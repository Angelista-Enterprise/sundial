// Notes stand in for a span only when they cover its last message; otherwise dsh's own summary runs.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { COMPACT_AT, KEEP_SHARE, NotesCompaction, readNotes, renderTail, spanAfterPrefix, transcript, writeNotes } from './chat-notes.js'

const owner = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const said = (id, text) => ({ id, role: 'assistant', content: [{ type: 'text', text }] })
const brief = { id: 'b', role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'Right now it is 09:55.' }] }
const call = { id: 'c', role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'gnomon_tickets', arguments: '{"key":"BOX-484"}' }] }
const result = { id: 'r', role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'text', text: 'x'.repeat(5000) }] }] }

function engine(reply = '## What the owner wants\n- the offsite on Saturday') {
  const asked = []
  const self = Object.create(NotesCompaction.prototype)
  self.dir = mkdtempSync(join(tmpdir(), 'chat-notes-'))
  self.updates = new Map()
  self.summaries = new Map()
  self.warned = new Set()
  self.compactAt = COMPACT_AT
  self.ctx = {
    llm: {
      async *stream(options) {
        asked.push(options)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  return { self, asked }
}

const session = (messages) => ({ id: 'chat/1', requestHeader: () => ({ config: { provider: 'tensorx-cloud', model: 'qwen/qwen3.8-flash-next' } }), deriveMessages: () => messages })

describe('transcript', () => {
  it('names who said what and clips long tool rows', () => {
    const text = transcript([brief, owner('o', 'Move it to Saturday'), call, result, said('a', 'Done.')])
    expect(text).not.toContain('Right now')
    expect(text).toContain('Owner: Move it to Saturday')
    expect(text).toContain('Gnomon called gnomon_tickets {"key":"BOX-484"}')
    expect(text).toContain('Gnomon: Done.')
    expect(text.length).toBeLessThan(1900)
  })

  it('dsh 0.2: a tool-role result is a tool row, and context of any other kind is left out', () => {
    const v4 = { id: 'r4', role: 'tool', toolCallId: 't1', isError: true, source: { kind: 'tool', callId: 't1' }, content: [{ type: 'text', text: 'no such ticket' }] }
    const reminder = { id: 'k', role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'c1' }, content: [{ type: 'text', text: 'Earlier: the owner planned an offsite.' }] }
    const text = transcript([reminder, owner('o', 'Which ticket?'), call, v4, said('a', 'None.')])
    expect(text).not.toContain('Earlier:')
    expect(text).toContain('Tool error: no such ticket')
    expect(text).toContain('Gnomon: None.')
  })

  it('mounts the engine with headroom that fits a 64k window', async () => {
    const { NOTES_COMPACTION_CONFIG } = await import('./chat-notes.js')
    expect(NOTES_COMPACTION_CONFIG).toEqual({ headroomTokens: 8192, maxTokens: 8192 })
    // The engine's own arithmetic (resolveCompactSpec): 0.8 × 64k capped by window − output − headroom; the tail is 0.16 of window − output.
    const window = 65_536, output = 8192
    const threshold = Math.min(window * 0.8, window - output - NOTES_COMPACTION_CONFIG.headroomTokens)
    expect(threshold).toBeGreaterThan(Math.floor((window - output) * 0.16))
    expect(window - output - 65_536).toBeLessThanOrEqual(0) // the default headroom leaves no pressure budget at all
  })
})

describe('updateNotes', () => {
  it('folds only the messages the notes do not cover yet, with the chat model, under its own purpose', async () => {
    const { self, asked } = engine()
    writeNotes(self.dir, 'chat/1', '- old', ['o1', 'a1'])
    await self.queueUpdate(session([owner('o1', 'Plan the offsite with Mira Bakker'), said('a1', 'Sure.'), owner('o2', 'Move it to Saturday'), said('a2', 'Moved.')]))
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ provider: 'tensorx-cloud', model: 'qwen/qwen3.8-flash-next', purpose: 'chat-notes' })
    const prompt = asked[0].messages[0].content[0].text
    expect(prompt).toContain('- old')
    expect(prompt).toContain('Move it to Saturday')
    expect(prompt).not.toContain('Plan the offsite')
    expect(readNotes(self.dir, 'chat/1')).toEqual({ notes: '## What the owner wants\n- the offsite on Saturday', covered: ['o1', 'a1', 'o2', 'a2'] })
  })

  it('makes no call when nothing is new', async () => {
    const { self, asked } = engine()
    writeNotes(self.dir, 'chat/1', '- old', ['o1'])
    await self.queueUpdate(session([owner('o1', 'hi')]))
    expect(asked).toHaveLength(0)
  })

  it('keeps the old notes when the model returns nothing', async () => {
    const { self } = engine('  ')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeNotes(self.dir, 'chat/1', '- old', [])
    await self.queueUpdate(session([owner('o1', 'hi')]))
    expect(readNotes(self.dir, 'chat/1').notes).toBe('- old')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no notes'))
    warn.mockRestore()
  })
})

describe('summarize', () => {
  const agent = { session: { id: 'chat/1' } }

  it('uses notes that cover the span, with no model call', async () => {
    const { self } = engine()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const model = vi.spyOn(BasicCompactionEngine.prototype, 'summarize')
    writeNotes(self.dir, 'chat/1', '- the notes', ['o1', 'a1'])
    const out = await self.summarize({ messages: [owner('o1', 'hi'), said('a1', 'hello')] }, agent)
    expect(out.summary).toEqual([{ type: 'text', text: '- the notes' }])
    expect(model).not.toHaveBeenCalled()
    model.mockRestore()
  })

  it('runs the model summary when the notes stop short of the span', async () => {
    const { self } = engine()
    const model = vi.spyOn(BasicCompactionEngine.prototype, 'summarize').mockResolvedValue({ summary: [{ type: 'text', text: 'model' }] })
    writeNotes(self.dir, 'chat/1', '- the notes', ['o1'])
    const out = await self.summarize({ messages: [owner('o1', 'hi'), said('a1', 'hello')] }, agent)
    expect(out.summary[0].text).toBe('model')
    model.mockRestore()
  })
})

describe('after the turn', () => {
  const tool = (id, chars) => ({ id, role: 'tool', toolCallId: id, source: { kind: 'tool', callId: id }, content: [{ type: 'text', text: 'y'.repeat(chars) }] })

  it('a rendered tail keeps the newest messages that fit, oldest first, tool output clipped', () => {
    const text = renderTail([owner('o1', 'first'), owner('o2', 'second'), tool('t', 5000), said('a', 'third')], 250)
    expect(text).not.toContain('first')
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('third'))
    expect(text.length).toBeLessThanOrEqual(250)
  })

  const system = { id: 's', role: 'system', content: [{ type: 'text', text: 'You are Gnomon. '.repeat(400) }] }

  /** A chat measured at `sizes` tokens in turn (the last one sticks); `replaced` is what compactNow would replace. */
  function chat(self, sizes, { window = 1_048_576, replaced = 50_000 } = {}) {
    const events = new Map()
    const appended = []
    const messages = [system, owner('o1', 'Move the offsite to Saturday'), said('a1', 'Moved.')]
    const session = {
      id: 'chat/1',
      requestHeader: () => ({ config: { provider: 'tensorx-cloud', model: 'z-ai/glm-5.3-flash' } }),
      deriveMessages: () => messages,
      eventAt: (seq) => events.get(seq),
      deriveEventMessage: (event) => event.data.message,
      append: (type, data, meta) => appended.push({ type, data, meta }),
    }
    const agent = { session, maintenance: 0, compacted: 0, runMaintenance: async (job) => { agent.maintenance += 1; return job() } }
    self.ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: window } })
    const nodes = [{ seq: 0, tokens: 2000 }, { seq: 1, tokens: replaced }, { seq: 2, tokens: 10 }]
    self.ctx.tokenMeter = { measure: () => ({ totalTokens: sizes.length > 1 ? sizes.shift() : sizes[0], nodes }), estimateMessage: (m) => Math.ceil(JSON.stringify(m.content).length / 4) }
    self.compactNow = async () => { agent.compacted += 1; agent.summary = self.summaries.get('chat/1') }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    return { session, agent, events, appended }
  }

  it('does nothing below the compaction point', async () => {
    const { self } = engine()
    const { agent } = chat(self, [COMPACT_AT - 1])
    await self.compactAfterTurn(agent)
    expect(agent.maintenance + agent.compacted).toBe(0)
  })

  it('then lets the notes and a rendered tail replace the rest, when the notes cover the chat', async () => {
    const { self } = engine()
    const { agent } = chat(self, [COMPACT_AT])
    writeNotes(self.dir, 'chat/1', '- the notes', ['s', 'o1', 'a1'])
    await self.compactAfterTurn(agent)
    expect(agent.compacted).toBe(1)
    expect(agent.summary).toContain('- the notes')
    expect(agent.summary).toContain('Owner: Move the offsite to Saturday')
    expect(agent.summary).not.toContain('You are Gnomon')
    expect(agent.summary).not.toContain('Moved.') // the last reply stays a real message
    expect(self.summaries.size).toBe(0)
  })

  it('keeps the tail to a few thousand characters however long the chat', async () => {
    const { self } = engine()
    const { agent, session } = chat(self, [COMPACT_AT])
    const long = session.deriveMessages()
    for (let i = 0; i < 200; i++) long.splice(-1, 0, owner(`x${i}`, `message ${i} `.repeat(100)))
    writeNotes(self.dir, 'chat/1', '- the notes', long.map((m) => m.id))
    await self.compactAfterTurn(agent)
    expect(agent.summary.length).toBeLessThan(4200)
  })

  it('drops the tail, then skips with one log line, when the summary would not shrink the span', async () => {
    const { self } = engine()
    const notes = 'n'.repeat(2000)
    const small = chat(self, [COMPACT_AT], { replaced: 715 })
    writeNotes(self.dir, 'chat/1', notes, ['s', 'o1', 'a1'])
    await self.compactAfterTurn(small.agent)
    expect(small.agent.summary).toBe(notes)
    const tiny = chat(self, [COMPACT_AT], { replaced: 600 })
    await self.compactAfterTurn(tiny.agent)
    await self.compactAfterTurn(tiny.agent)
    expect(tiny.agent.compacted).toBe(0)
    expect(console.log.mock.calls.filter(([line]) => /would not be smaller/.test(line))).toHaveLength(1)
  })

  it('waits for the next turn when the notes lag, rather than make the owner wait on a summary', async () => {
    const { self } = engine()
    const { agent } = chat(self, [COMPACT_AT])
    writeNotes(self.dir, 'chat/1', '- the notes', ['o1'])
    await self.compactAfterTurn(agent)
    expect(agent.compacted).toBe(0)
  })

  it('compacts at half the declared window when that comes first', async () => {
    const { self } = engine()
    const { agent } = chat(self, [32_000], { window: 64_000 })
    writeNotes(self.dir, 'chat/1', '- the notes', ['s', 'o1', 'a1'])
    await self.compactAfterTurn(agent)
    expect(agent.compacted).toBe(1)
  })

  it('summarize lands the prepared summary only for an after-turn compaction', async () => {
    const { self } = engine()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    writeNotes(self.dir, 'chat/1', '- the notes', ['o1', 'a1'])
    const input = { messages: [owner('o1', 'Move it to Saturday'), said('a1', 'Moved.')] }
    const agent = { session: { id: 'chat/1' } }
    expect((await self.summarize(input, agent)).summary[0].text).toBe('- the notes')
    self.summaries.set('chat/1', '- the notes\n\nOwner: Move it to Saturday')
    expect((await self.summarize(input, agent)).summary[0].text).toContain('Owner: Move it to Saturday')
  })

  it('a system prompt at the head of the input is not the owner speaking', () => {
    const text = transcript([system, owner('o1', 'hi')])
    expect(text).toBe('Owner: hi')
  })

  /**
   * A chat with a real surface: each spec is `[type, tokens, source?, toolCalls?]`, seq = index. The fake applies a
   * replace op the way dsh does, so a second compaction sees the first one's checkpoint.
   */
  function surfaceChat(self, specs, total = COMPACT_AT) {
    const events = specs.map(([type, tokens, source, calls = 0], seq) => ({
      seq,
      type,
      tokens,
      data: type === 'user/message' ? { role: 'user', source, content: [{ type: 'text', text: `${source.kind} ${seq}` }] } : type === 'assistant/message' ? { message: { role: 'assistant', content: Array.from({ length: calls }, (_, i) => ({ type: 'tool-call', id: `t${seq}.${i}` })) } } : type === 'system/message' ? { message: { role: 'system', content: [] } } : {},
    }))
    const appended = []
    let nodes = events.map((e) => e.seq)
    const session = {
      id: 'chat/1',
      get seq() { return events.length },
      surface: { get nodes() { return nodes } },
      requestHeader: () => ({ config: { provider: 'tensorx-cloud', model: 'z-ai/glm-5.3-flash' } }),
      deriveMessages: () => nodes.map((seq) => ({ id: `m${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `message ${seq}` }] })),
      eventAt: (seq) => events[seq],
      append(type, data, meta) {
        const event = { seq: events.length, type, data, tokens: 300 }
        events.push(event)
        appended.push({ type, data, meta })
        if (meta?.surfaceOp === 'append') nodes = [...nodes, event.seq]
        if (meta?.surfaceOp?.op === 'replace') nodes = [...nodes.slice(0, nodes.indexOf(meta.surfaceOp.startSeq)), event.seq, ...nodes.slice(nodes.indexOf(meta.surfaceOp.endSeq) + 1)]
        return event
      },
    }
    const agent = { session, compacted: 0, runMaintenance: async (job) => job() }
    self.keepFront = true
    self.ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 1_048_576 } })
    self.ctx.sessions = { flush: async () => {} }
    self.ctx.tokenMeter = { measure: () => ({ totalTokens: total, nodes: nodes.map((seq) => ({ seq, tokens: events[seq].tokens, heuristicTokens: events[seq].tokens })) }), estimateMessage: (m) => Math.ceil(JSON.stringify(m.content).length / 4) }
    self.compactNow = async () => { agent.compacted += 1 }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    writeNotes(self.dir, 'chat/1', '- the notes', [...Array(200).keys()].map((i) => `m${i}`))
    return { session, agent, appended, nodes: () => nodes }
  }
  const brief = { kind: 'sundial-shell', form: 'notice' }
  const ownerSays = { kind: 'user' }
  const turn = (calls = 1) => [['user/message', 4000, brief], ['user/message', 100, ownerSays], ['assistant/message', 200, null, calls], ...Array.from({ length: calls }, () => ['tool/result', 6000]), ['assistant/message', 300]]

  it('keeps the system prompt and the first brief as they were, and replaces only what follows (Set 2 Round 2 item 3)', async () => {
    const { self } = engine()
    const { agent, appended, nodes } = surfaceChat(self, [['system/message', 8000], ...turn(2), ...turn(1)])
    await self.compactAfterTurn(agent)
    expect(agent.compacted).toBe(0) // not dsh's whole-chat compactNow
    expect(appended.map((a) => a.type)).toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
    const [start, summary, checkpoint, end] = appended
    expect(checkpoint.meta.surfaceOp).toEqual({ op: 'replace', startSeq: 2, endSeq: 10 })
    expect(summary.data.shadowedSeqs).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(summary.data).toMatchObject({ compactionId: start.data.compactionId, shadowedRange: { start: 2, end: 10 }, provider: 'sundial', model: 'chat-notes' })
    expect(checkpoint.data.source).toEqual({ kind: 'compact-checkpoint', compactionId: start.data.compactionId })
    expect(checkpoint.data.content.map((b) => b.text).join('')).toContain('- the notes')
    expect(end.data).toEqual({ compactionId: start.data.compactionId, turn: null })
    // The front is the same nodes, the checkpoint comes after it, and the last reply stays a real message.
    expect(nodes()).toEqual([0, 1, 14, 11])
  })

  it('with llm.compactKeepFront off (the default), compacts the whole chat as before', async () => {
    const { self } = engine()
    const { agent, appended } = surfaceChat(self, [['system/message', 8000], ...turn(2), ...turn(1)])
    self.keepFront = false
    await self.compactAfterTurn(agent)
    expect(agent.compacted).toBe(1)
    expect(appended).toHaveLength(0)
  })

  it('appends the next checkpoint behind the last, leaving the earlier one as it was', async () => {
    const { self } = engine()
    const { agent, appended, nodes, session } = surfaceChat(self, [['system/message', 8000], ...turn(1)])
    await self.compactAfterTurn(agent)
    const first = nodes()
    for (const spec of turn(1)) session.append(spec[0], spec[0] === 'user/message' ? { role: 'user', source: spec[2], content: [{ type: 'text', text: 'x' }] } : spec[0] === 'assistant/message' ? { message: { content: Array.from({ length: spec[3] ?? 0 }, () => ({ type: 'tool-call' })) } } : {}, { surfaceOp: 'append' })
    appended.length = 0
    await self.compactAfterTurn(agent)
    expect(appended.map((a) => a.type)).toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
    // System, first brief, first checkpoint: untouched; the second checkpoint is appended behind them.
    expect(nodes().slice(0, 3)).toEqual(first.slice(0, 3))
    expect(appended[2].meta.surfaceOp.startSeq).toBe(first[3])
    expect(nodes()).toHaveLength(5)
  })

  it('compacts the whole chat once the kept front outgrows its share, or when the chat has no brief', async () => {
    const big = engine()
    const tooMuch = surfaceChat(big.self, [['system/message', 8000], ['user/message', COMPACT_AT * KEEP_SHARE + 1, brief], ['user/message', 100, ownerSays], ['assistant/message', 200, null, 1], ['tool/result', 9000], ['assistant/message', 300]])
    await big.self.compactAfterTurn(tooMuch.agent)
    expect(tooMuch.agent.compacted).toBe(1)
    expect(tooMuch.appended).toHaveLength(0)
    const none = engine()
    const plain = surfaceChat(none.self, [['system/message', 8000], ['user/message', 100, ownerSays], ['assistant/message', 200, null, 1], ['tool/result', 9000], ['assistant/message', 300]])
    await none.self.compactAfterTurn(plain.agent)
    expect(plain.agent.compacted).toBe(1)
  })

  it('never cuts between a tool call and its result', () => {
    const { self } = engine()
    const { session } = surfaceChat(self, [['system/message', 8000], ['user/message', 4000, brief], ['user/message', 100, ownerSays], ['assistant/message', 200, null, 1], ['tool/result', 9000], ['assistant/message', 200, null, 2], ['tool/result', 9000], ['assistant/message', 300]])
    // One of the second step's two calls has no result: the span ends before that step.
    const span = spanAfterPrefix(session, session.surface.nodes.map((seq) => ({ seq, tokens: 1 })), COMPACT_AT)
    expect(span.map((n) => n.seq)).toEqual([2, 3, 4])
  })

  it('runs after the notes update, in the same queue', async () => {
    const { self } = engine()
    const order = []
    self.updateNotes = async () => order.push('notes')
    self.compactAfterTurn = async () => order.push('compact')
    await self.queueUpdate({ id: 'chat/1' }, {})
    expect(order).toEqual(['notes', 'compact'])
  })
})
