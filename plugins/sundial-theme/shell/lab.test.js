import { describe, expect, it } from 'vitest'
import { OUTCOME, STALE_AFTER_DAYS, labCensus, lifeDays, study, conclusion } from './lab.js'

/** The live record's five goals, as `mind.goals` stores them. */
const GOALS = [
  { id: 'project-rate:~/Projects/hub', label: 'the project hub', openedAt: '2026-09-11T22:07:31.747Z', closedAt: '2026-09-12T22:13:51.490Z', outcome: 'superseded', openedWith: { n: 5, excessLoss: 0.09507 }, closedWith: { n: 5 }, finding: null },
  { id: 'project-rate:~/Projects/sundial', label: 'the project sundial', openedAt: '2026-08-18T22:00:18.463Z', closedAt: '2026-08-20T22:15:05.133Z', outcome: 'learned', openedWith: { n: 5, excessLoss: 0.05672 }, closedWith: { n: 8 }, finding: null },
  { id: 'project-rate:~/Projects/doe', label: 'the project doe', openedAt: '2026-08-04T22:00:42.701Z', closedAt: '2026-08-05T22:00:27.403Z', outcome: 'learned', openedWith: { n: 5, excessLoss: 0.04071 }, closedWith: { n: 7 }, finding: null },
]

describe('one study', () => {
  it('reads the outcome under either name the system gives it', () => {
    // `mind.goals` calls the field `outcome`; the `/gnomon/lab` route renames
    // it `status`. Reading one name printed "closed" on every row and zeroed
    // the census, on a card whose entire subject is how studies ended.
    // A tested variable, so the stored word stands — see the K0.4 block below
    // for what happens to a `learned` row with nothing behind it.
    const tested = { finding: { variable: 'weekend', gain: 0.3, arms: null } }
    expect(study({ closedAt: '2026-08-20T00:00:00Z', outcome: 'learned', ...tested }).word).toBe('answered')
    expect(study({ closedAt: '2026-08-20T00:00:00Z', status: 'learned', ...tested }).word).toBe('answered')
  })

  it('carries the evidence the outcome rests on', () => {
    // The whole reason this function exists. Both studies that closed
    // "learned" did so on two and three new observations, against thresholds
    // that let a goal open on 0.02 nats and win on 0.006 of one. The word
    // without the count is the card repeating a claim the record cannot back.
    const [, sundial, doe] = GOALS.map(study)
    // K0.4 re-read these two: the record labels them `learned` and nothing was
    // ever tested on either, so they report the ending they actually had.
    expect(sundial.word).toBe('sorted itself out')
    expect(sundial.grew, 'n 5 → 8').toBe(3)
    expect(doe.grew, 'n 5 → 7').toBe(2)
  })

  it('never lets "superseded" read as an answer', () => {
    // It is the outcome that most looks like a result and least is one: the
    // cell fell off a top-five list, which says nothing about the question.
    const [hub] = GOALS.map(study)
    expect(hub.word).toBe('dropped')
    expect(OUTCOME.superseded.means).toContain('never answered')
    expect(new Set(Object.values(OUTCOME).map((o) => o.word)).size, 'and no two endings share a word').toBe(Object.keys(OUTCOME).length)
  })

  it('measures a life in whole days against the budget it was given', () => {
    expect(lifeDays('2026-08-18T22:00:18Z', '2026-08-20T22:15:05Z')).toBe(2)
    expect(lifeDays('2026-08-04T22:00:42Z', '2026-08-05T22:00:27Z')).toBe(1)
    expect(lifeDays('nonsense', '2026-08-05T22:00:27Z')).toBe(null)
    expect(STALE_AFTER_DAYS, 'the budget `researchGoals` actually allows').toBe(21)
  })
})

describe('the bench, counted', () => {
  it('reports that not one study has a written conclusion', () => {
    // `finding` is a field on every `ResearchGoal` and, until K0.4, only the
    // never-fired trial path wrote it. The audit asked that every closed
    // question owe one conclusion line; this is the count that says none of
    // the record's five has paid.
    const c = labCensus(GOALS)
    expect(c.total).toBe(3)
    expect(c.concluded).toBe(0)
  })

  it('counts a conclusion by reading it, not by its type', () => {
    // K0.4 fixed a count that was right by accident. It tested
    // `typeof finding === 'string'`, and `finding` has always been an OBJECT —
    // so the figure was structurally zero and would have stayed zero on the
    // day the first conclusion landed, on the card whose whole subject is that
    // none has.
    const faded = { ...GOALS[1], outcome: 'faded', finding: { variable: null, gain: 0.02, arms: null, excessFrom: 0.06, excessTo: 0.02, newObservations: 3 } }
    expect(labCensus([faded]).concluded).toBe(1)
    expect(labCensus([{ ...GOALS[1], finding: 'it happens on weekdays' }]).concluded, 'a bare string is not a finding').toBe(0)
  })

  it('reports the best-evidenced answer, not the count of answers', () => {
    // "Two answered" flatters; "the best of them rests on three new
    // observations" is the same fact and cannot be misread.
    const c = labCensus(GOALS)
    expect(c.answered, 'nothing here was ever tested, so nothing was answered').toBe(0)
    expect(c.faded).toBe(2)
    expect(c.bestGrowth).toBe(3)
    expect(c.longestDays).toBe(2)
    expect(labCensus([GOALS[0]]).bestGrowth, 'no answered study, so no figure').toBe(null)
  })

  it('counts an open study as open rather than as an outcome', () => {
    const c = labCensus([{ ...GOALS[0], closedAt: null, outcome: undefined }])
    expect(c.open).toBe(1)
    expect(c.dropped).toBe(0)
    expect(study({ ...GOALS[0], closedAt: null, outcome: undefined }).word).toBe('running')
  })
})

describe('the two endings (K0.4)', () => {
  it('keeps "answered" for a tested hypothesis and gives the threshold close its own word', () => {
    // The item's whole point. Nothing is tested on the threshold path — the
    // cell's correctable error simply falls past a bar that two coin flips can
    // clear — and not one of the record's five goals ever formed a hypothesis.
    // Reporting it is right; calling it understanding is not.
    expect(OUTCOME.learned.word).toBe('answered')
    expect(OUTCOME.faded.word).not.toBe(OUTCOME.learned.word)
    // DESIGN.md: no two endings share a word.
    const words = Object.values(OUTCOME).map((o) => o.word)
    expect(new Set(words).size).toBe(words.length)
  })

  it('counts a faded goal apart from an answered one', () => {
    const rows = [
      { ...GOALS[1], outcome: 'faded', closedAt: '2026-08-20T22:15:05Z' },
      { ...GOALS[1], outcome: 'learned', closedAt: '2026-08-20T22:15:05Z', finding: { variable: 'weekend', gain: 0.3, arms: null } },
    ]
    const c = labCensus(rows)
    expect(c.answered, 'only a tested hypothesis is an answer').toBe(1)
    expect(c.faded).toBe(1)
  })

  it('says what a gap that closed on its own actually concluded', () => {
    // The sentence the threshold path was already building for its notice and
    // throwing away: what came down, from what to what, over how much new
    // evidence. It must NOT read as understanding.
    const said = conclusion({ variable: null, gain: 0.04, arms: null, excessFrom: 0.06, excessTo: 0.02, newObservations: 3 })
    expect(said).toContain('0.06')
    expect(said).toContain('3 more observations')
    expect(said).toContain('nothing tested')
  })

  it('names the variable where one was actually tested', () => {
    const said = conclusion({ variable: 'prev-day-ran-late', gain: 0.12, arms: { when: { n: 4, hits: 3 }, otherwise: { n: 9, hits: 1 } }, newObservations: 13 })
    expect(said).toContain('prev-day-ran-late')
    expect(said).toContain('0.12')
  })

  it('has nothing to say about a goal closed before any of this', () => {
    // Five rows on the live record carry `null`, and the card must say so in
    // words rather than render an empty cell — a blank reads as a layout fault.
    expect(conclusion(null)).toBeNull()
    expect(conclusion(undefined)).toBeNull()
    expect(conclusion('it happens on weekdays')).toBeNull()
  })
})

describe('a goal labelled before the endings were told apart (K0.4)', () => {
  it('reads a learned row with nothing tested as faded, and marks it', () => {
    // The two goals the live record calls `learned` were closed by the
    // threshold path, before the words differed. Left alone the card would go
    // on saying "answered — a hypothesis proposed, tested and accepted" about
    // questions that never formed one, which is the claim this item deletes.
    // No backfill is needed: the evidence is on the row.
    const s = study(GOALS[1])
    expect(s.outcome).toBe('faded')
    expect(s.legacy).toBe(true)
    expect(labCensus(GOALS).answered, 'and the census stops counting them as answers').toBe(0)
  })

  it('leaves a genuinely tested goal alone', () => {
    const tested = { ...GOALS[1], finding: { variable: 'weekend', gain: 0.31, arms: { when: { n: 5, hits: 4 }, otherwise: { n: 8, hits: 0 } }, newObservations: 13 } }
    expect(study(tested).outcome).toBe('learned')
    expect(study(tested).legacy).toBe(false)
  })
})
