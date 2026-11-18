import { describe, expect, it } from 'vitest'
import { answered, GARBLED, sayable, unthought } from './answer-only.js'

// dsh 0.2's shapes: an assistant message with tool-call blocks, then one `tool` message per result.
const owner = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const called = (name, args) => ({ role: 'assistant', content: [{ type: 'tool-call', id: `c-${name}`, name, arguments: JSON.stringify(args) }] })
const result = (name, text, isError = false) => ({ role: 'tool', toolCallId: `c-${name}`, isError, content: [{ type: 'text', text }] })
const PULLED = 'Brief Onyx.txt in TextEdit is what the owner\'s newest message asks for. Say exactly this: "Here is Brief Onyx.txt in TextEdit."'

describe('answer-only after gnomon_pull_up (runs 179 and 183: right document, then 12 and 17 steps)', () => {
  it('the call right after a worked pull-up, direct or through gnomon_call, is an answer', () => {
    expect(answered([owner('pull up the memo'), called('gnomon_pull_up', { what: 'the memo' }), result('gnomon_pull_up', PULLED)])).toBe(true)
    expect(answered([owner('pull up the memo'), called('gnomon_call', { name: 'gnomon_pull_up', args: { what: 'the memo' } }), result('gnomon_call', PULLED)])).toBe(true)
    // The older log format: the result as a block inside a user message.
    expect(answered([owner('x'), called('gnomon_pull_up', {}), { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c-gnomon_pull_up', content: [{ type: 'text', text: PULLED }] }] }])).toBe(true)
  })

  it('anything else keeps its tools: another tool, a bad call, a new owner message, a call not answered yet', () => {
    expect(answered([owner('x'), called('screen_look', { app: 'TextEdit' }), result('screen_look', 'TextEdit, window …')])).toBe(false)
    expect(answered([owner('x'), called('gnomon_pull_up', {}), result('gnomon_pull_up', 'invalid arguments: what is the thing', true)])).toBe(false)
    expect(answered([owner('x'), called('gnomon_pull_up', {}), result('gnomon_pull_up', PULLED), owner('now send it to Mira')])).toBe(false)
    expect(answered([owner('x'), called('gnomon_pull_up', {})])).toBe(false)
    expect(answered([])).toBe(false)
  })
})

describe('sayable: the answering tool\'s line is the reply (Set 4 R1: the prompt held three runs in four)', () => {
  const pulled = [owner('pull up the memo'), called('gnomon_pull_up', { what: 'the memo' }), result('gnomon_pull_up', PULLED)]
  it('after a worked pull-up the reply is its sentence, first and alone', () => {
    expect(sayable('Sure! Here is Brief Onyx.txt in TextEdit. Anything else?', pulled)).toBe('Here is Brief Onyx.txt in TextEdit.')
    expect(sayable('<tool_call>screen_look', pulled)).toBe('Here is Brief Onyx.txt in TextEdit.')
  })
  it('elsewhere the words stay, cut at markup', () => {
    expect(sayable('Raised it.', [owner('x')])).toBe('Raised it.')
    expect(sayable('<tool_call>x', [owner('x')])).toBe(GARBLED)
    const notFound = [owner('x'), called('gnomon_pull_up', {}), result('gnomon_pull_up', 'I could not find the memo. Say so in one sentence.')]
    expect(sayable('I could not find the memo.', notFound)).toBe('I could not find the memo.')
  })
})

describe('unthought: a reasoning model\'s thought printed as text never reaches the owner (run 249 T21)', () => {
  it('a stray closing tag at the start: it and all before it go', () => {
    expect(unthought('\n</mm:think>\n The file is in Outbox.')).toBe('\n The file is in Outbox.')
    expect(unthought('let me look</think>Done.')).toBe('Done.')
  })
  it('every common form, paired, with what it holds', () => {
    for (const tag of ['think', 'mm:think', 'thinking', 'reasoning', 'THINK']) expect(unthought(`<${tag}>plan it</${tag}>Saved to Outbox.`)).toBe('Saved to Outbox.')
    expect(unthought('A<think>x</think> and B<reasoning>y</reasoning>.')).toBe('A and B.')
  })
  it('an opening tag never closed: all from it on goes, at the start too', () => {
    expect(unthought('Saved.<think>but was it')).toBe('Saved.')
    expect(unthought('<mm:think>oscillator at 500 Hz')).toBe('')
  })
  it('text with no tag stays exactly as it came', () => {
    expect(unthought('A < B and think > feel.')).toBe('A < B and think > feel.')
  })
  it('sayable: the thought goes, all thought is GARBLED, tool markup is still cut', () => {
    expect(sayable('\n</mm:think>\n Saved to Outbox.', [])).toBe('\n Saved to Outbox.')
    expect(sayable('<think>only this</think>', [])).toBe(GARBLED)
    expect(sayable('<think>x</think>Done. <tool_call> <invoke name="a">', [])).toBe('Done.')
  })
})
