import { describe, expect, it } from 'vitest'
import { lensProblem, runLens } from './lens-core.js'

const isReadTool = (name) => name.startsWith('gnomon_')

/**
 * The lens is the one surface where Gnomon composes a view rather than reading
 * one, so a lens that renders nonsense is Gnomon telling the owner something
 * untrue in its own words. These cover the two ways that happened.
 */
describe('runLens', () => {
  const data = { days: [{ key: '2026-09-17', calls: 12 }, { key: '2026-09-16', calls: 3 }] }

  it('names the columns the rows do not have, and the ones they do', () => {
    // Live, 2026-09-17: a lens asked for `day` when the field is `key`. Every
    // cell drew an em dash, the tool's own renderer printed the literal word
    // `undefined` down every row, and the model read that back as data.
    const got = runLens({ title: 't', source: { tool: 'gnomon_llm_ledger' }, pick: 'days', columns: ['day', 'calls'] }, data)
    expect(got.unknown).toEqual(['day'])
    expect(got.fields).toEqual(['key', 'calls'])
  })

  it('says nothing about columns when the spec named none, when grouping, or when nothing came back', () => {
    // Three ways a column can be absent without the spec being wrong: it was
    // never asked for, `group` names its own columns, and no rows means no
    // evidence either way — an empty answer must not read as a bad spec.
    expect(runLens({ title: 't', source: { tool: 'gnomon_llm_ledger' }, pick: 'days' }, data).unknown).toEqual([])
    expect(runLens({ title: 't', source: { tool: 'gnomon_llm_ledger' }, pick: 'days', group: 'key', columns: ['nope'] }, data).unknown).toEqual([])
    expect(runLens({ title: 't', source: { tool: 'gnomon_llm_ledger' }, pick: 'days', columns: ['nope'] }, { days: [] }).unknown).toEqual([])
  })

  it('counts a column present on some rows as present', () => {
    const sparse = { rows: [{ a: 1 }, { a: 2, b: null }] }
    expect(runLens({ title: 't', source: { tool: 'gnomon_x' }, pick: 'rows', columns: ['a', 'b'] }, sparse).unknown).toEqual([])
  })
})

describe('lensProblem', () => {
  it('refuses a spec that cannot be run, and passes one that can', () => {
    expect(lensProblem({ title: 't', source: { tool: 'gnomon_llm_ledger' } }, isReadTool)).toBeNull()
    expect(lensProblem({ source: { tool: 'gnomon_llm_ledger' } }, isReadTool)).toBe('a lens needs a title')
    expect(lensProblem({ title: 't', source: { tool: 'rm_rf' } }, isReadTool)).toBe('rm_rf is not a read tool')
  })
})
