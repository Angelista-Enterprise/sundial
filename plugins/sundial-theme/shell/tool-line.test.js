import { describe, it, expect } from 'vitest'
import { elapsed, resultGist, toolLine } from './tool-line.js'

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

  it('clips a long argument', () => {
    expect(toolLine('gnomon_run_shell', { command: 'x'.repeat(200) }).detail.length).toBeLessThanOrEqual(48)
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
