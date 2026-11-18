import { describe, it, expect } from 'vitest'
import { argsText, callArgs, elapsed, resultGist, toolLine } from './tool-line.js'

describe('toolLine', () => {
  it('says what a known tool is doing, with its argument', () => {
    expect(toolLine('gnomon_today_summary', { date: '2026-09-22' })).toEqual({ verb: 'Reading the day', detail: '2026-09-22' })
    expect(toolLine('gnomon_semantic_search', { query: 'credit line' })).toEqual({ verb: 'Searching memory', detail: '“credit line”' })
  })

  it('reads gnomon_call as the tool it calls', () => {
    expect(toolLine('gnomon_call', { name: 'gnomon_people', args: '{}' }).verb).toBe('Reading the people roster')
  })

  it('names an owner service and humanizes an unknown tool', () => {
    expect(toolLine('mcp__obsidian__search_vault_simple', { query: 'gnomon' })).toEqual({ verb: 'Obsidian: search vault simple', detail: 'gnomon' })
    expect(toolLine('gnomon_new_thing', {}).verb).toBe('New thing')
  })

  it('says a screen step by its goal and its reason, so the slip shows the task while it works', () => {
    expect(toolLine('gnomon_call', { name: 'screen_act', args: { goal: 'send a mail', because: 'Press Send', ref: 'e7@3c4d' } })).toEqual({ verb: 'Send a mail', detail: 'Press Send' })
    expect(toolLine('screen_act', { app: 'Obsidian', window: 'puzzlebox', action: 'raise' })).toEqual({ verb: 'Working in Obsidian', detail: 'raise' })
    expect(toolLine('screen_act', { action: 'raise' }).verb).toBe('Working on the screen')
    // run200: "Await · job-0acb1c8e". What is waited for, in words, never the id.
    expect(toolLine('gnomon_await', { job: 'job-0acb1c8e' })).toEqual({ verb: 'Waiting for the background job', detail: null })
    expect(toolLine('gnomon_await', { app: 'Zen', gone: 'loading', seconds: 30 })).toEqual({ verb: 'Waiting for Zen', detail: 'until "loading" is gone' })
    expect(toolLine('gnomon_await', { file: '/tmp/gnomon-job.log', seconds: 100 }).verb).toBe('Waiting for a file')
    expect(toolLine('screen_act', { app: 'Notes', goal: 'new note', steps: [{}, {}, {}] })).toEqual({ verb: 'New note', detail: '3 steps' })
    expect(toolLine('screen_look', { app: 'Obsidian', window: 'puzzlebox' })).toEqual({ verb: 'Looking at', detail: 'Obsidian, puzzlebox' })
  })

  it('clips a long argument', () => {
    expect(toolLine('gnomon_run_shell', { command: 'x'.repeat(200) }).detail.length).toBeLessThanOrEqual(48)
  })
})

describe('callArgs', () => {
  it('finds a call\'s arguments by its own id, and one made through gnomon_call under the outer call', () => {
    const act = { ref: 'e7@3c4d', action: 'press' }
    const rows = new Map([['c1', { _args: { command: 'ls' } }], ['c2', { _args: { name: 'screen_act', args: act } }], ['c3', { _args: { name: 'screen_act', args: JSON.stringify(act) } }]])
    expect(callArgs(rows, 'c1')).toEqual({ command: 'ls' })
    expect(callArgs(rows, 'c2:screen_act')).toEqual(act)
    expect(callArgs(rows, 'c3:screen_act')).toEqual(act)
    expect(callArgs(rows, 'c9:screen_act')).toBeUndefined()
    expect(argsText(act)).toContain('"ref": "e7@3c4d"')
    expect(argsText({})).toBeNull()
  })
})

describe('resultGist', () => {
  it('counts rows and says why a call failed', () => {
    expect(resultGist('[1,2,3]')).toBe('3 results')
    expect(resultGist('{"moments":[]}')).toBe('nothing found')
    expect(resultGist('Error: the owner stopped this tool call.', true)).toBe('failed: the owner stopped this tool call.')
    expect(resultGist('{"a":1,"b":2}')).toBeNull()
  })
})

describe('elapsed', () => {
  it('reads like a person says it', () => {
    expect(elapsed(400)).toBe('0.4s')
    expect(elapsed(12_300)).toBe('12s')
    expect(elapsed(125_000)).toBe('2m 5s')
  })
})
