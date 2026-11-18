import { describe, it, expect } from 'vitest'
import { saidOnly, serializeMessages, serializeRequest, translate } from './index.js'

/**
 * This adapter refused every image outright until 2026-09-10, on the assumption
 * that the route's models were text-only. Measured against the live endpoint
 * that was wrong: a solid-red PNG sent as an OpenAI `image_url` part came back
 * described as "Red" by `qwen/qwen3.8-flash-next` and by `moonshotai/kimi-k3`.
 * End to end through the shell, a green PNG came back "Green".
 */

const ref = { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 96, height: 96, bytes: 221 }
const dataUri = 'data:image/png;base64,AAAA'
const withData = () => new Map([[ref.attachmentId, dataUri]])

const user = (content) => ({ role: 'user', content })

describe('serializeMessages', () => {
  it('sends a plain string when there is no image', () => {
    expect(serializeMessages([user([{ type: 'text', text: 'hello' }])])).toEqual([{ role: 'user', content: 'hello' }])
  })

  /**
   * The string form is kept for text-only messages on purpose: every request
   * this adapter has ever sent used it, and switching all of them to the parts
   * form to serve the rare message with a picture would change every call.
   */
  it('sends content PARTS only when the message carries an image', () => {
    const wire = serializeMessages([user([{ type: 'text', text: 'what colour?' }, { type: 'image', attachment: ref }])], withData())

    expect(wire).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what colour?' },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ])
  })

  it('sends an image with no words — "look at this" is a message', () => {
    const wire = serializeMessages([user([{ type: 'image', attachment: ref }])], withData())
    expect(wire[0].content).toEqual([{ type: 'image_url', image_url: { url: dataUri } }])
  })

  /**
   * An `ImageBlock` carries a content-addressed ref, not bytes, so the bytes
   * can be unreadable by the time a turn runs — a pruned attachment root, a
   * replayed transcript. The rest of the question is still answerable.
   */
  it('drops an unreadable image with a marker instead of failing the turn', () => {
    const wire = serializeMessages([user([{ type: 'text', text: 'what colour?' }, { type: 'image', attachment: ref }])], new Map())

    expect(wire[0].content).toEqual([
      { type: 'text', text: '[1 image could not be read and are not shown]' },
      { type: 'text', text: 'what colour?' },
    ])
  })

  // Images stay a USER-content thing. `ImageBlock`'s own doc calls assistant
  // images forward compatibility, and this route's models emit text.
  it('still refuses an image in system, assistant or tool content', () => {
    for (const message of [
      { role: 'system', content: [{ type: 'image', attachment: ref }] },
      { role: 'assistant', content: [{ type: 'image', attachment: ref }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', attachment: ref }] }] },
    ]) {
      expect(() => serializeMessages([message], withData())).toThrow(/does not support image content/)
    }
  })

  it('leaves a tool result alone', () => {
    const wire = serializeMessages([
      user([{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '{"ok":true}' }] }]),
    ])
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' }])
  })

  it('dsh 0.2: a tool-role message answers its call id, an empty one says so, and developer reads as system', () => {
    const wire = serializeMessages([
      { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: '{"ok":true}' }] },
      { role: 'tool', toolCallId: 'c2', isError: true, source: { kind: 'tool', callId: 'c2' }, content: [] },
      { role: 'developer', source: { kind: 'user' }, content: [{ type: 'text', text: 'A new tool joined.' }] },
    ])
    expect(wire).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'c2', content: '(no output)' },
      { role: 'system', content: 'A new tool joined.' },
    ])
    expect(() => serializeMessages([{ role: 'tool', toolCallId: 'c3', content: [{ type: 'image', attachment: ref }] }], withData())).toThrow(/does not support image content/)
  })
})

describe('background purposes', () => {
  it('switch reasoning off for the thread namer and compaction, and leave a chat turn alone', async () => {
    const { serializeRequest } = await import('./index.js')
    const base = { model: 'm', messages: [] }
    expect(serializeRequest({ ...base, purpose: 'session-title' }).reasoning_effort).toBe('none')
    expect(serializeRequest({ ...base, purpose: 'compaction' }).reasoning_effort).toBe('none')
    // The notes call on glm-5.3-flash spent all 8,192 tokens reasoning and returned no notes, 22 times in 22 (2026-11-12).
    expect(serializeRequest({ ...base, purpose: 'chat-notes' }).reasoning_effort).toBe('none')
    expect(serializeRequest({ ...base, purpose: 'ask' }).reasoning_effort).toBeUndefined()
    expect(serializeRequest({ ...base, purpose: 'compaction', reasoningEffort: 'high' }).reasoning_effort).toBe('high')
  })

  it('a chat turn (a session, no purpose) takes llm.chatReasoning; unset leaves the model its own default', async () => {
    const { serializeRequest } = await import('./index.js')
    const turn = { model: 'm', messages: [], sessionId: 's1' }
    expect(serializeRequest(turn, new Map(), 'low').reasoning_effort).toBe('low')
    expect(serializeRequest(turn, new Map(), 'off').reasoning_effort).toBe('none')
    expect(serializeRequest(turn).reasoning_effort).toBeUndefined()
    expect(serializeRequest({ ...turn, purpose: 'compaction' }, new Map(), 'high').reasoning_effort).toBe('none')
    expect(serializeRequest({ model: 'm', messages: [] }, new Map(), 'low').reasoning_effort).toBeUndefined()
  })
})

/**
 * Run 192 T09: gnomon_pull_up raised the document and rang it, then 9 more model steps. The `llm/stream` listener that was
 * to send the next call without tools never could: cordis's waterfall calls every listener with the original arguments
 * (what a listener hands `next` is dropped) and dsh freezes the request. The body this adapter writes is where it holds.
 */
describe('serializeRequest after an answering tool', () => {
  const owner = { role: 'user', content: [{ type: 'text', text: 'pull up the memo' }] }
  const called = { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'gnomon_pull_up', arguments: '{"what":"the memo"}' }] }
  const pulled = { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'Say exactly this: "Here is Brief Onyx.txt in TextEdit."' }] }
  const tools = [{ name: 'screen_look', description: 'look', parameters: {} }]
  it('the chat call right after a worked gnomon_pull_up carries no tools; another call, or before it, keeps them', () => {
    expect(serializeRequest({ model: 'm', sessionId: 's1', messages: [owner, called, pulled], tools }).tools).toBeUndefined()
    expect(serializeRequest({ model: 'm', sessionId: 's1', purpose: 'compaction', messages: [owner, called, pulled], tools }).tools).toHaveLength(1)
    expect(serializeRequest({ model: 'm', sessionId: 's1', messages: [owner], tools }).tools).toHaveLength(1)
  })
})

/**
 * Run 209 T12: on the tool-less call after a worked pull-up, the model printed its tool-call syntax as text and that text
 * was said to the owner. Nothing from the markup on is streamed, and the kept message is the pull-up's own sentence.
 */
describe('saidOnly: tool-call markup is never said', () => {
  const owner = { role: 'user', content: [{ type: 'text', text: 'pull up the memo' }] }
  const called = { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'gnomon_pull_up', arguments: '{"what":"the memo"}' }] }
  const pulled = { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'Brief Onyx.txt in TextEdit is in front. Say exactly this, nothing more: "Here is Brief Onyx.txt in TextEdit; "Q3 plan" is ringed."' }] }
  const run = async (parts, messages) => {
    const payloads = (async function* () {
      for (const content of parts) yield JSON.stringify({ choices: [{ delta: { content } }] })
      yield JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      yield '[DONE]'
    })()
    const out = []
    for await (const chunk of saidOnly(translate(payloads), messages)) out.push(chunk)
    return { streamed: out.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), kept: out.find((c) => c.type === 'block-end')?.block.text }
  }
  const markup = [']<]minimax[>[<tool_call> ]<]minimax[>[<invoke name="gnomon_call">', ']<]minimax[>[<name>screen_look]<]minimax[>[</name>', ']<]minimax[>[</invoke> ]<]minimax[>[</tool_call>']

  it('after a worked pull-up, a reply of markup becomes the pull-up\'s own sentence, and no markup is streamed', async () => {
    const said = 'Here is Brief Onyx.txt in TextEdit; "Q3 plan" is ringed.'
    expect(await run(markup, [owner, called, pulled])).toEqual({ streamed: said, kept: said })
    for (const other of ['<tool_call>{"name": "screen_look"}</tool_call>', '<|tool_call_begin|>screen_look', '```tool_code\nscreen_look(app="TextEdit")\n```', '<invoke name="screen_look">'])
      expect((await run([other], [owner, called, pulled])).kept, other).toBe(said)
  })

  it('elsewhere, prose before the markup is kept and markup alone becomes a short honest line', async () => {
    expect(await run(['Raised it. ', '<tool_call>', '<invoke name="screen_look">'], [owner])).toEqual({ streamed: 'Raised it. ', kept: 'Raised it.' })
    const honest = await run(markup, [owner])
    expect(honest.kept).toBe(honest.streamed)
    expect(honest.kept).not.toMatch(/tool_call|invoke|minimax/)
  })

  it('run 250 T19: a lone cursor ("█") is never streamed nor kept; a bar of blocks in prose stays', async () => {
    expect(await run(['█'], [owner])).toEqual({ streamed: '', kept: '' })
    expect(await run(['\n', '█', '\n\n', 'Saved.'], [owner])).toMatchObject({ kept: '\n\nSaved.' })
    expect(await run(['Mon ███'], [owner])).toEqual({ streamed: 'Mon ███', kept: 'Mon ███' })
  })

  it('Set 4 R1: after a worked pull-up the reply is the tool\'s line, first and alone, whatever the model writes', async () => {
    const said = 'Here is Brief Onyx.txt in TextEdit; "Q3 plan" is ringed.'
    expect(await run(['Sure, I found it. ', 'Here is Brief Onyx.txt in TextEdit; "Q3 plan" is ringed.', ' Want me to read it?'], [owner, called, pulled])).toEqual({ streamed: said, kept: said })
    expect(await run(['Here is ', 'Brief Onyx.txt in TextEdit.'], [owner, called, pulled])).toEqual({ streamed: said, kept: said })
    // A pull-up that failed, or a new owner message after it, leaves the model's words as they are.
    const failed = { ...pulled, isError: true }
    expect(await run(['It did not come up.'], [owner, called, failed])).toEqual({ streamed: 'It did not come up.', kept: 'It did not come up.' })
    expect(await run(['Sent.'], [owner, called, pulled, owner])).toEqual({ streamed: 'Sent.', kept: 'Sent.' })
  })

  it('run 219 T13: a real tool call back on the tool-less call after a worked pull-up is the pull-up\'s sentence, and the turn ends', async () => {
    const call = async (messages) => {
      const payloads = (async function* () {
        yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'k1', function: { name: 'gnomon_call', arguments: '{"name":"screen_look",' } }] } }] })
        yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"args":{"app":"TextEdit"}}' } }] } }] })
        yield JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
        yield '[DONE]'
      })()
      const out = []
      for await (const chunk of saidOnly(translate(payloads), messages)) out.push(chunk)
      return out
    }
    const said = 'Here is Brief Onyx.txt in TextEdit; "Q3 plan" is ringed.'
    const out = await call([owner, called, pulled])
    expect(out.filter((c) => c.blockType === 'tool-call' || c.type === 'tool-call-delta' || c.block?.type === 'tool-call')).toEqual([])
    expect(out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')).toBe(said)
    expect(out.find((c) => c.type === 'block-end')?.block).toEqual({ type: 'text', text: said })
    expect(out.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    // Anywhere else a tool call is a tool call.
    const elsewhere = await call([owner])
    expect(elsewhere.find((c) => c.type === 'block-end')?.block).toMatchObject({ type: 'tool-call', name: 'gnomon_call' })
    expect(elsewhere.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('plain prose streams and is kept unchanged, a held "<" or "`" included', async () => {
    const parts = ['Mira said 3 ', '< 4 and wrote `x', '` in the memo.']
    expect(await run(parts, [owner])).toEqual({ streamed: parts.join(''), kept: parts.join('') })
  })
})

/**
 * Runs 207 to 210: the route sent list arguments as {"item": [...]}, {"item": "x"} or a list of {"item": "x"}. web_search
 * refused every one, screen_act some: 3, 7, 9 and 6 calls a run went nowhere. The closed tool call carries the plain list.
 */
describe('translate: a list sent as {"item": ...} is a plain list', () => {
  // As dsh sends them: a `json` parameter (screen_act steps and values) goes with no type.
  const tools = [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: { queries: { type: 'array' }, query: { type: 'string' }, target: { type: 'object' }, steps: {}, values: {} } } } }]
  const closed = async (args) => {
    const payloads = (async function* () {
      yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'web_search', arguments: args } }] } }] })
      yield JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
      yield '[DONE]'
    })()
    for await (const chunk of translate(payloads, tools)) if (chunk.type === 'block-end') return chunk.block.arguments
  }

  it('unwraps the shapes runs 208 to 210 sent', async () => {
    const plain = async (args) => JSON.parse(await closed(args))
    expect(await plain('{"queries":{"item":["314159265","Kestrel"]}}')).toEqual({ queries: ['314159265', 'Kestrel'] })
    expect(await plain('{"queries":{"item":"capital of Peru"}}')).toEqual({ queries: ['capital of Peru'] })
    expect(await plain('{"queries":{"item":[{"item":"271828182"},{"item":"Kestrel"}]}}')).toEqual({ queries: ['271828182', 'Kestrel'] })
    expect(await plain('{"app":"Zen","steps":{"item":{"action":"press","label":"Send"}}}')).toEqual({ app: 'Zen', steps: [{ action: 'press', label: 'Send' }] })
    expect(await plain('{"app":"Zen","steps":{"item":{"item":[{"action":"click","label":"Shelf"}]}}}')).toEqual({ app: 'Zen', steps: [{ action: 'click', label: 'Shelf' }] })
  })

  it('leaves plain arguments, an object with more keys, the top level and text that is no object exactly as they came', async () => {
    for (const args of ['{"queries": ["a", "b"]}', '{"target":{"item":"x","role":"row"}}', '{"item":"top level"}', '"just text"', '{"broken":'])
      expect(await closed(args)).toBe(args)
  })

  it('keeps a field named "item": in a values map, deeper than an argument, in a step, and under a key the tool says is no list', async () => {
    for (const args of ['{"route":true,"values":{"item":"crate"}}', '{"target":{"item":"crate"}}', '{"query":{"item":"crate"}}', '{"steps":[{"action":"type","target":{"item":"crate"}}]}'])
      expect(await closed(args)).toBe(args)
  })
})

/** Set 4 R1: runs 208 to 210 were a slow hour with no name. OpenRouter says on every chunk which host served it. */
describe('translate: the upstream host rides on the finish', () => {
  const finish = async (extra) => {
    const payloads = (async function* () {
      yield JSON.stringify({ ...extra, choices: [{ delta: { content: 'hi' } }] })
      yield JSON.stringify({ ...extra, choices: [{ delta: {}, finish_reason: 'stop' }] })
      yield '[DONE]'
    })()
    for await (const chunk of translate(payloads)) if (chunk.type === 'finish') return chunk
  }
  it('names the provider OpenRouter reported, and nothing for a route that names none', async () => {
    expect((await finish({ provider: 'Kestrel Cloud' })).upstream).toBe('Kestrel Cloud')
    expect(await finish({})).not.toHaveProperty('upstream')
  })
})

describe('a chat reply with its thought printed as text (run 249 T21)', () => {
  it('nothing from a think tag on is streamed, and the block that ends is the reply without it', async () => {
    const run = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const text of ['\n', '</mm', ':think>\n Look', "'s look line says: oscillator at 500 Hz at 500 Hz at 500 Hz"]) yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: "\n</mm:think>\n Look's look line says: oscillator at 500 Hz at 500 Hz at 500 Hz" } }
    }
    const out = []
    for await (const chunk of saidOnly(run(), [])) out.push(chunk)
    const streamed = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    expect(streamed).not.toMatch(/think/)
    expect(out.at(-1).block.text).not.toMatch(/think/)
    expect(streamed).toBe(out.at(-1).block.text)
  })
})
