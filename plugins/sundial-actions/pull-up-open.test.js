// S5R2: pull-up raised a window that was closed before it opened the file: 11 "no-such-window" rows in 8 tasks (runs 211-221),
// each one a failure in the task's list that the model then talked about. The newest look's window list says first. Made-up values.
import { describe, expect, it } from 'vitest'
import { lookOf } from './screen-look.js'
import { openNow, pullUpTool } from './pull-up.js'

const NOW = Date.parse('2026-11-16T09:00:00.000Z')
const at = (s) => new Date(NOW - s * 1000).toISOString()
const screen = { windows: [{ processName: 'Zen', windowTitle: 'Testbox', front: true }, { processName: 'TextEdit', windowTitle: 'Untitled (scratch copy)' }, { processName: 'TextEdit', windowTitle: 'Save' }] }
const ZEN = { id: 'look-0000beef', processName: 'Zen', windowTitle: 'Testbox', windows: [{ windowTitle: 'Testbox' }], screen, elements: [] }
const EDIT = { id: 'look-0000cafe', processName: 'TextEdit', windowTitle: 'Untitled (scratch copy)', windows: [{ windowTitle: 'Untitled (scratch copy)' }, { windowTitle: 'Brief Onyx.txt', minimized: true }], screen, elements: [] }

describe('openNow: is the window open, by the newest look', () => {
  it('the app\'s own window list when the look is of the app (minimized too), else the windows on screen', () => {
    expect(openNow(lookOf(EDIT), 'TextEdit', 'Brief Onyx.txt', at(10), NOW)).toBe(true)
    expect(openNow(lookOf(EDIT), 'TextEdit', 'Log Fennel.txt', at(10), NOW)).toBe(false)
    expect(openNow(lookOf(ZEN), 'TextEdit', 'Brief Onyx.txt', at(150), NOW)).toBe(false)
    expect(openNow(lookOf(ZEN), 'textedit', 'scratch copy', at(150), NOW)).toBe(true)
  })

  it('cannot say: no look, an old look, no title, or a look with no screen list of another app', () => {
    expect(openNow(null, 'TextEdit', 'Brief Onyx.txt', at(10), NOW)).toBeNull()
    expect(openNow(lookOf(ZEN), 'TextEdit', 'Brief Onyx.txt', at(400), NOW)).toBeNull()
    expect(openNow(lookOf(ZEN), 'TextEdit', '', at(10), NOW)).toBeNull()
    expect(openNow(lookOf({ ...ZEN, screen: undefined }), 'TextEdit', 'Brief Onyx.txt', at(10), NOW)).toBeNull()
  })
})

describe('pull-up skips the raise of a closed window', () => {
  /** A pull-up whose newest look is `look`, taken `ago` seconds before; the live window from the log has a path. */
  const run = async (look, ago) => {
    const calls = []
    const state = { marks: { lastLook: { id: look.id, app: look.processName, at: new Date(Date.now() - ago * 1000).toISOString() } } }
    const recent = [{ signalType: 'window', eventType: 'changed', capturedAt: new Date(Date.now() - 60_000).toISOString(), data: { processName: 'TextEdit', windowTitle: 'Brief Onyx.txt', documentPath: '~/fix/Brief%20Onyx.txt' } }]
    const tools = {
      schemas: () => [{ name: 'gnomon_run_shell' }],
      execute: async (req) => {
        calls.push(req.name)
        if (req.name === 'screen_act') return { isError: true, error: { message: 'refused: no-such-window.' } }
        if (req.name === 'gnomon_run_shell') return { value: { exitCode: 0 } }
        return { content: [{ type: 'text', text: 'done' }] }
      },
    }
    const tool = pullUpTool({ tools, getState: () => state, appendSignal: async () => {}, readLook: async (id) => (id === look.id ? look : null), readRecent: async () => recent })
    await tool.execute({ what: 'the brief onyx document' }, { callId: 'c1', agent: { session: { id: 's1' } } })
    return calls
  }

  it('the newest look shows no such window: the file is opened again at once, no raise first', async () => {
    expect(await run(ZEN, 150)).toEqual(['gnomon_run_shell', 'gnomon_await', 'screen_look'])
  })

  it('a look that cannot say (too old) keeps the raise first', async () => {
    expect((await run(ZEN, 900))[0]).toBe('screen_act')
  })
})
