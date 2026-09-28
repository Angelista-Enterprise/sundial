// The flow surface's column layout is the one piece of real algorithm in the
// browser half, so it gets real tests.
//
// It used to be lifted out of client.js's source and evaluated, because that
// bundle is a hand-written module registration with no exports. Gnomon's own
// client is made of ordinary ES modules, so this now IMPORTS the function the
// browser actually runs — the same code, reached the honest way.
//
// `surfaces.js` touches the DOM only inside its element helpers, never at
// module scope, which is what makes importing it here safe.
import { describe, expect, it } from 'vitest'
import { rankFlowNodes } from './shell/surfaces.js'

const ids = (columns) => columns.map((column) => column.map((node) => node.id))
const nodes = (...list) => list.map((id) => ({ id, label: id }))

describe('rankFlowNodes', () => {
  it('puts a straight pipeline in one node per column, in order', () => {
    const columns = rankFlowNodes(nodes('signal', 'reduce', 'effect'), [
      ['signal', 'reduce'],
      ['reduce', 'effect'],
    ])
    expect(ids(columns)).toEqual([['signal'], ['reduce'], ['effect']])
  })

  it('stacks a fan-out in one column, so it reads as one split', () => {
    const columns = rankFlowNodes(nodes('log', 'moments', 'facts', 'embeddings'), [
      ['log', 'moments'],
      ['log', 'facts'],
      ['log', 'embeddings'],
    ])
    expect(ids(columns)).toEqual([['log'], ['moments', 'facts', 'embeddings']])
  })

  // The reason it is the LONGEST path and not the shortest: a step that waits
  // for two inputs must be drawn after both, or the diagram claims it can run
  // before its own evidence exists.
  it('places a join after everything that feeds it, not beside its first input', () => {
    const columns = rankFlowNodes(nodes('a', 'b', 'c', 'join'), [
      ['a', 'join'],
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'join'],
    ])
    expect(ids(columns)).toEqual([['a'], ['b'], ['c'], ['join']])
  })

  it('draws a single step with no edges at all', () => {
    expect(ids(rankFlowNodes(nodes('only'), []))).toEqual([['only']])
  })

  it('leaves a disconnected node in the first column rather than dropping it', () => {
    const columns = rankFlowNodes(nodes('a', 'b', 'orphan'), [['a', 'b']])
    expect(ids(columns)).toEqual([['a', 'orphan'], ['b']])
  })

  // A cycle is honest data — a pipeline that feeds itself is worth seeing — so
  // this must terminate AND stay compact. Unclamped, three nodes in a cycle
  // relaxed out to rank 9 and drew seven empty columns between them.
  it('terminates on a cycle without opening empty columns', () => {
    const columns = rankFlowNodes(nodes('a', 'b', 'c'), [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
    ])
    expect(columns.flat()).toHaveLength(3)
    expect(columns.length).toBeLessThanOrEqual(3)
    expect(columns.every((column) => column.length > 0)).toBe(true)
  })

  it('never opens an empty column on ordinary shapes either', () => {
    const shapes = [
      [nodes('a', 'b', 'c'), [['a', 'b'], ['b', 'c']]],
      [nodes('a', 'b', 'c', 'd'), [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]],
      [nodes('a', 'b'), []],
    ]
    for (const [list, edges] of shapes) {
      expect(rankFlowNodes(list, edges).every((column) => column.length > 0)).toBe(true)
    }
  })

  it('never loses or duplicates a node', () => {
    const list = nodes('a', 'b', 'c', 'd', 'e')
    const columns = rankFlowNodes(list, [
      ['a', 'c'],
      ['b', 'c'],
      ['c', 'd'],
      ['c', 'e'],
    ])
    expect(columns.flat().map((node) => node.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})
