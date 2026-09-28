import { describe, expect, it } from 'vitest'
import { QUIET_AFTER_DAYS, foldDuplicates, formatSteps, groupByParent, lastMoved, linkMovement, nextStepState, parseSteps, quietDays, splitStatus, stepProgress, stepsFromCommits } from './goals.js'

describe('splitStatus', () => {
  it('splits the state from the why the owner wrote into the same field', () => {
    // Verbatim from the live record.
    expect(splitStatus('open — easy to toggle, like Notion; with or without a meeting')).toEqual({
      state: 'open',
      why: 'easy to toggle, like Notion; with or without a meeting',
    })
  })

  it('leaves a bare state without a why', () => {
    expect(splitStatus('done')).toEqual({ state: 'done', why: '' })
    expect(splitStatus('dropped')).toEqual({ state: 'dropped', why: '' })
  })

  it('reads an all-prose status as an open goal whose why is the whole string', () => {
    // `Consistent sleep rhythm` on the live record has no state word at all.
    const stored = 'Bring the momentum-driven bedtime "in check" — owner wants evening end-hours less variable'
    expect(splitStatus(stored)).toEqual({ state: 'open', why: stored })
  })

  it('knows the states the card can now set', () => {
    for (const state of ['doing', 'paused']) expect(splitStatus(`${state} — because`).state).toBe(state)
  })
})

describe('linkMovement', () => {
  const commitments = [
    { branch: 'ledger-failure-views', name: 'ledger-failure-views', projectName: 'sundial', lastTouchedAt: '2026-09-17T17:24:11.156Z', touches: 4 },
    { branch: 'board-audit', name: 'board-audit', projectName: 'puzzlebox-studio', lastTouchedAt: '2026-09-17T22:57:33.652Z', touches: 1 },
    { branch: 'chore/dsh-0.1.5-rc.1', name: 'DSH-0', projectName: 'sundial', lastTouchedAt: '2026-09-13T09:22:06.899Z', touches: 66 },
  ]
  const commits = [
    { branch: 'ledger-failure-views', commitLine: '94cb291 ledger(L1): retry lineage on the call ledger [1/7]' },
    { branch: 'ledger-failure-views', commitLine: 'edfcd87 ledger: failure views complete [7/7]' },
    { branch: 'ledger-failure-views', commitLine: '828c36b ledger(L6): lost answers [6/7]' },
    { branch: 'main', commitLine: 'b061c5a fix(day): the fold adds [1/9]' },
  ]

  it('links a goal to the branch its own name contains, and reads the progress token', () => {
    const link = linkMovement('Ledger failure views (L1–L7)', commitments, commits)
    expect(link).toMatchObject({ branch: 'ledger-failure-views', project: 'sundial', lastAt: '2026-09-17T17:24:11.156Z', touches: 4, commits: 3, done: 7, total: 7 })
  })

  it('carries that branch commits back, newest first, and nobody elses', () => {
    const link = linkMovement('Ledger failure views (L1–L7)', commitments, commits)
    expect(link.log.map((c) => c.commitLine)).toEqual([commits[2].commitLine, commits[1].commitLine, commits[0].commitLine])
    expect(link.log.some((c) => c.branch === 'main')).toBe(false)
  })

  it('takes the furthest token, not the last commit', () => {
    const backwards = [commits[2], commits[1], commits[0]]
    expect(linkMovement('Ledger failure views (L1–L7)', commitments, backwards)?.done).toBe(7)
  })

  it('links a goal whose words differ from the branch only in punctuation', () => {
    expect(linkMovement('gnomon board audit', commitments, commits)?.branch).toBe('board-audit')
  })

  it('reports a branch with no progress token as commits, not as 0 of 0', () => {
    const link = linkMovement('board audit', commitments, commits)
    expect(link).not.toHaveProperty('total')
    expect(link?.commits).toBe(0)
  })

  it('refuses a short branch slug, which would match half the sentences anyone writes', () => {
    // `dsh-0` is five characters; a goal named "Push the rc branch" must not
    // claim it, and nothing else should either.
    expect(linkMovement('Push the rc branch', commitments, commits)).toBeNull()
    expect(linkMovement('Strip auth tokens from stored URLs', commitments, commits)).toBeNull()
  })

  it('has nothing to say when there is nothing to link', () => {
    expect(linkMovement('Consistent sleep rhythm', commitments, commits)).toBeNull()
    expect(linkMovement('anything', [], [])).toBeNull()
  })
})

describe('quietDays', () => {
  const now = Date.parse('2026-09-18T12:00:00Z')

  it('counts from whichever moved last — the owner or the branch', () => {
    expect(lastMoved('2026-09-08T09:00:00Z', { lastAt: '2026-09-17T17:00:00Z' })).toBe('2026-09-17T17:00:00Z')
    expect(quietDays('2026-09-08T09:00:00Z', { lastAt: '2026-09-17T17:00:00Z' }, now)).toBe(0)
  })

  it('counts whole days from the goal alone when no branch is linked', () => {
    expect(quietDays('2026-09-04T12:00:00Z', null, now)).toBe(14)
    expect(quietDays('2026-09-04T12:00:00Z', null, now)).toBeGreaterThanOrEqual(QUIET_AFTER_DAYS)
  })

  it('says nothing rather than zero when nothing is dated', () => {
    expect(quietDays(null, null, now)).toBeNull()
  })
})

describe('foldDuplicates', () => {
  it('folds the two ids one goal was split across, keeping the newest status', () => {
    const folded = foldDuplicates([
      { id: 'goal:Ask team whether moving standup to 9:30 still stands', goal: 'Ask team whether moving standup to 9:30 still stands', status: 'dropped', since: '2026-09-11T10:47:11.484Z' },
      { id: 'goal:ask-team-whether-moving-standup-to-9-30-still-stands', goal: 'Ask team whether moving standup to 9:30 still stands', status: 'done', since: '2026-09-10T08:07:42.372Z' },
    ])
    expect(folded).toHaveLength(1)
    expect(folded[0].id).toBe('goal:ask-team-whether-moving-standup-to-9-30-still-stands')
    expect(folded[0].status).toBe('dropped')
    expect(folded[0].alsoStored).toEqual(['done'])
  })

  it('leaves a goal that was never split exactly as it was', () => {
    const one = [{ id: 'goal:consistent-sleep-rhythm', goal: 'Consistent sleep rhythm', status: 'open', since: '2026-09-12T19:19:56.888Z' }]
    expect(foldDuplicates(one)).toEqual(one)
  })
})

describe('groupByParent', () => {
  const goal = (id, state, partOf = null, movedAt = '2026-09-01T00:00:00Z') => ({ id, goal: id, state, partOf, movedAt })

  it('puts a child under its parent', () => {
    const grouped = groupByParent([
      goal('goal:gnomon-screen-recording', 'open', 'goal:enhance-gnomon-with-recording-features'),
      goal('goal:enhance-gnomon-with-recording-features', 'open'),
      goal('goal:gnomon-voice-recording-with-transcripts', 'open', 'goal:enhance-gnomon-with-recording-features'),
    ])
    expect(grouped.map((g) => g.id)).toEqual([
      'goal:enhance-gnomon-with-recording-features',
      'goal:gnomon-screen-recording',
      'goal:gnomon-voice-recording-with-transcripts',
    ])
    expect(grouped.slice(1).every((g) => g.child)).toBe(true)
  })

  it('leaves a child whose parent is not here as a root, rather than dropping it', () => {
    const grouped = groupByParent([goal('goal:a', 'open', 'goal:gone')])
    expect(grouped).toHaveLength(1)
    expect(grouped[0].child).toBeUndefined()
  })

  it('does not let a goal parent itself into nothing', () => {
    expect(groupByParent([goal('goal:a', 'open', 'goal:a')])).toHaveLength(1)
  })

  it('runs live before settled, then most recently moved', () => {
    const grouped = groupByParent([
      goal('goal:done', 'done', null, '2026-09-17T00:00:00Z'),
      goal('goal:old-open', 'open', null, '2026-09-01T00:00:00Z'),
      goal('goal:doing', 'doing', null, '2026-09-02T00:00:00Z'),
      goal('goal:new-open', 'open', null, '2026-09-16T00:00:00Z'),
    ])
    expect(grouped.map((g) => g.id)).toEqual(['goal:doing', 'goal:new-open', 'goal:old-open', 'goal:done'])
  })
})

describe('the checklist', () => {
  it('reads back what it wrote', () => {
    const steps = [
      { state: 'done', text: 'retry lineage on the call ledger' },
      { state: 'doing', text: 'a failure class' },
      { state: 'todo', text: 'billed tokens' },
      { state: 'skip', text: 'the eighth thing' },
    ]
    expect(parseSteps(formatSteps(steps))).toEqual(steps)
  })

  it('splits on the first colon only, so a step may contain others', () => {
    expect(parseSteps('todo: fix this: then that')).toEqual([{ state: 'todo', text: 'fix this: then that' }])
  })

  it('treats a line with no known state as outstanding, not as junk', () => {
    // A hand-edited fact, or one written before this format existed.
    expect(parseSteps('just do the thing\nnotastate: hmm')).toEqual([
      { state: 'todo', text: 'just do the thing' },
      { state: 'todo', text: 'notastate: hmm' },
    ])
  })

  it('refuses to grow past a plan, because the assert route caps the object', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ state: 'todo', text: `step ${i}` }))
    expect(formatSteps(many).split('\n')).toHaveLength(20)
  })

  it('counts progress without letting a skipped step drag the total', () => {
    expect(stepProgress([{ state: 'done' }, { state: 'todo' }, { state: 'skip' }])).toEqual({ done: 1, total: 2 })
    expect(stepProgress([])).toEqual({ done: 0, total: 0 })
  })

  it('moves a step on, and never cycles into skip by accident', () => {
    expect(nextStepState('todo')).toBe('doing')
    expect(nextStepState('doing')).toBe('done')
    expect(nextStepState('done')).toBe('todo')
    expect(nextStepState('skip')).toBe('todo')
  })
})

describe('stepsFromCommits', () => {
  const commits = [
    { commitLine: '94cb291 ledger(L1): retry lineage on the call ledger [1/7]' },
    { commitLine: 'ca7bd62 ledger(L2): a failure class decided where the error still is one [2/7]' },
    { commitLine: 'edfcd87 ledger: failure views complete [7/7]' },
  ]

  it('turns the tokens back into the checklist they stood for', () => {
    const steps = stepsFromCommits(commits)
    expect(steps).toHaveLength(7)
    // The hash, the conventional-commit prefix and the token are all stripped —
    // what is left is the work.
    expect(steps[0]).toEqual({ state: 'done', text: 'retry lineage on the call ledger' })
    expect(steps[1]).toEqual({ state: 'done', text: 'a failure class decided where the error still is one' })
    expect(steps[6]).toEqual({ state: 'done', text: 'failure views complete' })
  })

  it('leaves the indices nobody committed standing as outstanding steps', () => {
    const steps = stepsFromCommits(commits)
    expect(steps.slice(2, 6).every((s) => s.state === 'todo')).toBe(true)
    expect(steps[2].text).toBe('step 3')
    expect(stepProgress(steps)).toEqual({ done: 3, total: 7 })
  })

  it('has nothing to say about commits with no token', () => {
    expect(stepsFromCommits([{ commitLine: 'abc1234 fix(board): a thing' }])).toEqual([])
    expect(stepsFromCommits([])).toEqual([])
    expect(stepsFromCommits(null)).toEqual([])
  })
})
