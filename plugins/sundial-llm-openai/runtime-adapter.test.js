import { describe, expect, it } from 'vitest'
import { renderPersona, renderReplyRules } from '@sundial/kernel/persona.js'
import { REPLY_RULES } from '@sundial/kernel/turn-brief.js'
import { RuntimeAdapter, flattenDsh } from './runtime-adapter.js'

/** A runtime that plays a script and records the job. */
const scripted = (events) => {
  const jobs = []
  return { jobs, runtime: { id: 'claude', run: async function* (job) { jobs.push(job); yield* events }, authStatus: async () => ({ ok: true, detail: '' }), listModels: async () => ['sonnet', 'opus'] } }
}
const collect = async (iter) => { const out = []; for await (const c of iter) out.push(c); return out }
const user = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

describe('the chat on a vendor runtime', () => {
  it('streams the runtime\'s text, shows its tool calls as thinking, carries usage, and ends on stop', async () => {
    const { jobs, runtime } = scripted([
      { type: 'tool.call', id: 'c1', name: 'mcp__sundial__gnomon_tickets', arguments: '{"key":"BOX-484"}' },
      { type: 'tool.result', id: 'c1', text: '[]', isError: false },
      { type: 'text.delta', text: 'BOX-484 ' },
      { type: 'text.delta', text: 'is open.' },
      { type: 'usage', promptTokens: 120, completionTokens: 9, cacheReadTokens: 100, costUsd: 0.01 },
      { type: 'done', output: 'BOX-484 is open.' },
    ])
    const chunks = await collect(new RuntimeAdapter('claude', { home: '/h', runtime }).stream({ provider: 'claude', model: 'sonnet', system: 'You are Gnomon.', messages: [user('Which ticket is open?')] }))
    expect(chunks.map((c) => c.type)).toEqual(['block-start', 'reasoning-delta', 'block-start', 'text-delta', 'text-delta', 'block-end', 'block-end', 'usage', 'finish'])
    expect(chunks.filter((c) => c.type === 'block-start').map((c) => c.blockType)).toEqual(['reasoning', 'text'])
    expect(chunks.find((c) => c.type === 'usage').usage).toEqual({ inputTokens: 120, outputTokens: 9, cacheReadTokens: 100 })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.filter((c) => c.type === 'tool-call-delta')).toEqual([])
    // The job: the persona rendered for this runtime (never dsh's system prompt), Sundial's read tools, the chat folder under hands, the last owner message alone as the prompt.
    expect(jobs[0]).toMatchObject({ model: 'sonnet', system: renderPersona('runtime', 'claude-cli'), tools: 'read', home: '/h', cwd: '/h/.daemon/hands/chat', prompt: 'Which ticket is open?' })
    expect(jobs[0].system).not.toContain('You are Gnomon.')
    expect(jobs[0].system).toContain('mcp__sundial__gnomon_*')
    expect(jobs[0].system).not.toMatch(/show_surface|board|dsh harness|ask_user_question/)
  })

  it('swaps the brief\'s reply rules for the runtime rendering, in every brief of the history', async () => {
    const { jobs, runtime } = scripted([{ type: 'done', output: 'ok' }])
    const brief = (text) => ({ role: 'user', source: { kind: 'sundial-shell', form: 'brief' }, content: [{ type: 'text', text: `${text}\n${REPLY_RULES}` }] })
    await collect(new RuntimeAdapter('copilot', { home: '/h', runtime }).stream({ provider: 'copilot', model: 'gpt-5', system: 'dsh prompt', messages: [brief('Right now it is 09:55.'), user('hi'), { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'Hello.' }] }, brief('Right now it is 09:56.'), user('and?')] }))
    expect(jobs[0].prompt).not.toContain('todo_write')
    expect(jobs[0].prompt.split(renderReplyRules('runtime'))).toHaveLength(3)
    expect(jobs[0].system).toContain('sundial-gnomon_*')
  })

  it('a limit ends the turn as a 429 so the chat falls through; auth as a 401; no text as an empty response; a whole answer still gets its text block', async () => {
    const adapter = (events) => new RuntimeAdapter('claude', { home: '/h', runtime: scripted(events).runtime })
    const limit = await collect(adapter([{ type: 'error', kind: 'limit', message: "claude -p: You've hit your usage limit." }]).stream({ provider: 'claude', model: 'sonnet', messages: [user('q')] }))
    expect(limit.at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: "claude -p: You've hit your usage limit.", code: 'RATE_LIMIT', status: 429 } } })
    const auth = await collect(adapter([{ type: 'error', kind: 'auth', message: 'not signed in' }]).stream({ provider: 'claude', model: 'sonnet', messages: [user('q')] }))
    expect(auth.at(-1).reason.failure).toMatchObject({ code: 'AUTH', status: 401 })
    const empty = await collect(adapter([{ type: 'done', output: '' }]).stream({ provider: 'claude', model: 'sonnet', messages: [user('q')] }))
    expect(empty.at(-1).reason.failure.code).toBe('EMPTY_RESPONSE')
    const whole = await collect(adapter([{ type: 'done', output: 'All at once.' }]).stream({ provider: 'claude', model: '', messages: [user('q')] }))
    expect(whole.map((c) => c.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
    expect(whole[1].text).toBe('All at once.')
  })

  it('flattens the conversation: owner and assistant turns, tool calls and results, context left unlabelled; lists the runtime\'s models', async () => {
    const prompt = flattenDsh([
      { role: 'system', content: [{ type: 'text', text: 'S' }] },
      { role: 'user', source: { kind: 'sundial-shell', form: 'notice' }, content: [{ type: 'text', text: 'Right now it is 09:55.' }] },
      user('Which ticket?'),
      { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'c', name: 'gnomon_tickets', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c', isError: true, content: [{ type: 'text', text: 'no such ticket' }] },
      { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'None open.' }] },
      user('And yesterday?'),
    ])
    expect(prompt).toBe("Context:\nRight now it is 09:55.\n\nUser:\nWhich ticket?\n\nAssistant:\n\n(called gnomon_tickets({}))\n\nTool result (error):\nno such ticket\n\nAssistant:\nNone open.\n\nUser:\nAnd yesterday?\n\nAnswer as the assistant's next turn.")
    const listed = await new RuntimeAdapter('claude', { home: '/h', runtime: scripted([]).runtime }).listModels('claude')
    expect(listed.map((m) => m.id)).toEqual(['sonnet', 'opus'])
    expect(new RuntimeAdapter('copilot', { home: '/h' }).providerInfo('copilot')).toEqual({ id: 'copilot', name: 'GitHub Copilot' })
  })
})
