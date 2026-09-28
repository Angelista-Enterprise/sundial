import { describe, expect, it, vi } from 'vitest'
import { createRerank } from './rerank.js'

const hits = [
  { refType: 'knowledge_entry', refId: 'a', score: 0.9, label: 'A', text: 'about apples', at: 't' },
  { refType: 'moment', refId: 'b', score: 0.8, label: 'B', text: 'about branches', at: 't' },
  { refType: 'knowledge_entry', refId: 'c', score: 0.7, label: 'C', text: 'about cats', at: 't' },
]
const level = (p2, p3) => ({ type: 'score', score: 2, probabilities: { 0: 1 - p2 - p3, 1: 0, 2: p2, 3: p3 } })

describe('rerank (J1.3)', () => {
  it('keeps the candidates the judge says answer the question, ordered by relevance, top always kept', async () => {
    const judgeNow = vi.fn(async () => ({ answers: { c0: level(0.1, 0.1), c1: level(0.5, 0.4), c2: level(0.3, 0.0) }, model: 'typesafe/jev-latest' }))
    const rerank = createRerank({ judgeNow, getState: () => ({ judgement: { questions: {} } }), log: () => {} })
    const out = await rerank('which branch?', hits)
    expect(out.map((h) => h.refId)).toEqual(['b'])
    expect(out[0].relevance).toBe(0.9)
    const [call] = judgeNow.mock.calls[0]
    expect(call).toMatchObject({ purpose: 'rank', questionSetId: 'rank-evidence' })
    expect(call.state.candidates.c1).toBe('B: about branches')
    expect(Object.keys(call.questions)).toEqual(['c0', 'c1', 'c2'])
  })

  it('never returns empty when the retriever found something: the top hit survives a strict judge', async () => {
    const judgeNow = async () => ({ answers: { c0: level(0.1, 0), c1: level(0.2, 0), c2: level(0.05, 0) }, model: 'x' })
    const out = await createRerank({ judgeNow, getState: () => null, log: () => {} })('q', hits)
    expect(out.map((h) => h.refId)).toEqual(['b'])
  })

  it('reads a slot\'s learned threshold off state.judgement', async () => {
    const { questionId } = await import('@sundial/rules/questions/index.js')
    const { RANK_EVIDENCE_QUESTIONS } = await import('@sundial/rules/questions/rank-evidence.js')
    const strict = { judgement: { questions: { [questionId(RANK_EVIDENCE_QUESTIONS.c0)]: { threshold: 0.95 } } } }
    const judgeNow = async () => ({ answers: { c0: level(0.5, 0.4), c1: level(0.5, 0.45), c2: level(0, 0) }, model: 'x' })
    const out = await createRerank({ judgeNow, getState: () => strict, log: () => {} })('q', hits)
    // c0 at 0.9 is under ITS 0.95 bar and is not the top; c1 at 0.95 clears the default 0.5.
    expect(out.map((h) => h.refId)).toEqual(['b'])
  })

  it('falls back to the retriever\'s order when the judge is off, failing, or the list is too short to rank', async () => {
    const off = createRerank({ judgeNow: async () => null, getState: () => null, log: () => {} })
    expect(await off('q', hits)).toBe(hits)
    const one = [hits[0]]
    expect(await off('q', one)).toBe(one)
    const judgeNow = vi.fn(async () => null)
    await createRerank({ judgeNow, getState: () => null })('', hits)
    expect(judgeNow).not.toHaveBeenCalled()
  })

  it('a slot the judge did not answer is kept on the retriever\'s word', async () => {
    const judgeNow = async () => ({ answers: { c0: level(0.9, 0) }, model: 'x' })
    const out = await createRerank({ judgeNow, getState: () => null, log: () => {} })('q', hits)
    expect(out.map((h) => h.refId)).toEqual(['a', 'b', 'c'])
    expect(out[1].relevance).toBeUndefined()
  })
})
