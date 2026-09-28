import { describe, it, expect } from 'vitest'
import { serializeMessages } from './index.js'

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
})

describe('background purposes', () => {
  it('switch reasoning off for the thread namer and compaction, and leave a chat turn alone', async () => {
    const { serializeRequest } = await import('./index.js')
    const base = { model: 'm', messages: [] }
    expect(serializeRequest({ ...base, purpose: 'session-title' }).reasoning_effort).toBe('none')
    expect(serializeRequest({ ...base, purpose: 'compaction' }).reasoning_effort).toBe('none')
    expect(serializeRequest({ ...base, purpose: 'ask' }).reasoning_effort).toBeUndefined()
    expect(serializeRequest({ ...base, purpose: 'compaction', reasoningEffort: 'high' }).reasoning_effort).toBe('high')
  })
})
