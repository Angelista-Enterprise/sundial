import { describe, it, expect } from 'vitest'
import { jsonShape, parseResult } from './json-view.js'

describe('parseResult', () => {
  it('reads JSON, forgives the cut tail, and falls back to text', () => {
    expect(parseResult('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseResult('[1,2]\n… (40 more characters)')).toEqual({ ok: true, value: [1, 2] })
    expect(parseResult('Error: nope').ok).toBe(false)
  })
})

describe('jsonShape', () => {
  it('draws a list of objects as a table of their plain columns', () => {
    const shape = jsonShape([{ project: 'sundial', commits: 42, files: ['a'] }, { project: 'puzzles', commits: 6 }])
    expect(shape.kind).toBe('table')
    expect(shape.columns).toEqual(['Project', 'Commits'])
    expect(shape.rows).toEqual([['sundial', '42'], ['puzzles', '6']])
  })

  it('draws an object as labelled fields, nested one level', () => {
    const shape = jsonShape({ totalMinutes: 341, projects: [{ name: 'sundial', min: 300 }], ok: true })
    expect(shape.kind).toBe('fields')
    expect(shape.fields.map((f) => f.key)).toEqual(['Total minutes', 'Projects', 'Ok'])
    expect(shape.fields[1].value.kind).toBe('table')
    expect(shape.fields[2].value.text).toBe('yes')
  })

  it('leaves machine ids and empty columns to Raw', () => {
    const shape = jsonShape([{ id: '01M3', sessionId: null, kind: 'window', note: null }, { id: '01M4', sessionId: null, kind: 'event', note: null }])
    expect(shape.columns).toEqual(['Kind'])
  })

  it('says nothing came back for an empty list, and caps long ones', () => {
    expect(jsonShape([])).toMatchObject({ kind: 'text', text: 'nothing' })
    expect(jsonShape(Array.from({ length: 30 }, (_, i) => i))).toMatchObject({ kind: 'list', more: 5 })
  })
})
