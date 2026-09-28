import { describe, expect, it } from 'vitest'
import { threadModelOf } from './thread-model.js'

describe('threadModelOf', () => {
  it('reads the last route the thread went out on, and null before its first request', () => {
    const events = [
      { type: 'user/message', data: {} },
      { type: 'request/context', data: { provider: 'tensorx', model: 'qwen/qwen3.8-flash-next' } },
      { type: 'request/context', data: { provider: 'tensorx', model: 'deepseek/deepseek-v4-flash-0731' } },
      { type: 'turn/end', data: {} },
    ]
    expect(threadModelOf(events)).toEqual({ provider: 'tensorx', model: 'deepseek/deepseek-v4-flash-0731' })
    expect(threadModelOf([{ type: 'user/message', data: {} }])).toBeNull()
    expect(threadModelOf([{ type: 'request/context', data: { provider: '', model: 'x' } }])).toBeNull()
    expect(threadModelOf(undefined)).toBeNull()
  })
})
