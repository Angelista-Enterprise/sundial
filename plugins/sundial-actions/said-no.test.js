import { describe, expect, it } from 'vitest'
import { finalOf } from './gate-finals.js'
import { REJECTED, saidNo, saidNoResult } from './said-no.js'

describe('a refused ask names the act, not the tool (runs 199-202: "You rejected the screen action")', () => {
  it('a refused send in an app reads as the owner saying no to sending it there', () => {
    const final = finalOf('screen_act', { app: 'Zen', steps: [{ action: 'press', label: 'Send' }] }, () => null, [{ verb: 'press', app: 'Zen', thing: { role: 'button', name: 'Send' } }])
    expect(final).toMatchObject({ kind: 'send', app: 'Zen' })
    const line = saidNo('screen_act', final)
    expect(line).toBe('Not done: the owner said no to sending it in Zen. Say it in their terms ("You said no to sending it in Zen."), never as a rejected tool or action.')
    expect(line).not.toContain('screen_act')
  })

  it('a plain act or a command names what the tool does; an ask nobody answered is not the owner refusing it', () => {
    expect(saidNo('gnomon_run_shell', null)).toContain('the owner said no to running that command')
    expect(saidNo('screen_act', null, true)).toBe('Not done: nobody answered the ask for that step on the screen. Say that plainly; the owner did not refuse it.')
  })

  it("matches dsh's rejection only, and knows its own line as a call that never ran", () => {
    expect(REJECTED.test('Error: the user rejected tool "screen_act"')).toBe(true)
    expect(REJECTED.test('Error: refused: not-found')).toBe(false)
    expect(saidNoResult({ isError: true, content: [{ type: 'text', text: `Error: ${saidNo('screen_act', null)}` }] })).toBe(true)
    expect(saidNoResult({ isError: true, content: [{ type: 'text', text: 'Error: refused: not-found' }] })).toBe(false)
  })
})
