// Set 5 R3: the proposals card's answers go through the routes that already wrote them; the one new write takes only
// a proposal that is on the card. Every value is made up.
import { describe, expect, it } from 'vitest'
import { createInitialState } from '@sundial/kernel/initial-state.js'
import { proposalAnswer, readProposalsView } from './read-proposals.js'

const NOW = Date.parse('2026-11-17T10:00:00.000Z')
const NOTE = 'Notes\nraise is refused here (no-such-window); open worked after it'

function state() {
  const s = createInitialState('d')
  s.config.timezone = 'UTC'
  s.selfReview = { pending: {}, seen: [], proposed: { s1: { kind: 'skill', app: 'Spotify', name: 'play', routeKey: 'press button "Play"' }, r1: { kind: 'fact', app: 'Notes', predicate: 'menuHolds', object: 'File > Export', n: 3 } }, routes: {}, skills: {}, notes: [] }
  s.notices.offers = { 'chore:prs': { tool: 'gnomon_pull_requests', args: {}, label: 'Show the pull requests', n: 6, kind: 'chore', at: '2026-11-17T08:30:00.000Z' } }
  s.appNotes = { open: {}, owner: { tally: {}, notes: [{ app: 'Notes', note: 'raise is refused here (no-such-window); open worked after it', n: 4, lastAt: '2026-11-17T07:00:00.000Z' }] }, rig: { tally: {}, notes: [] } }
  s.watch = { rules: [], runtime: {}, proposed: { w1: { id: 'slack-burst', title: 'Slack burst', when: { type: 'window:changed' }, say: 'Slack again', cooldownMin: 60 } }, proposedFrom: { w1: { at: '2026-11-17T09:00:00.000Z', seed: 'host:mail.example.com', days: 4 } } }
  return s
}

describe('the proposals card', () => {
  it('names, for each proposal, the existing route that accepts it and the one that dismisses it', () => {
    const by = Object.fromEntries(readProposalsView({ state: state(), now: NOW }).items.map((p) => [p.id, [p.accept, p.dismiss]]))
    expect(by.s1).toEqual([{ path: '/gnomon/assistant/verdict', body: { proposalId: 's1', verdict: 'accepted' }, label: 'Keep as a skill' }, { path: '/gnomon/assistant/verdict', body: { proposalId: 's1', verdict: 'rejected' }, label: 'No' }])
    expect(by.r1.map((a) => [a.path, a.body.verdict])).toEqual([['/gnomon/api/feedback', 'useful'], ['/gnomon/api/feedback', 'wrong']])
    // A rule idea: the shelf's own Keep (adopts it) and Wrong (drops it).
    expect(by.w1).toEqual([{ path: '/gnomon/api/feedback', body: { artifactKind: 'knowledge_entry', artifactId: 'w1', verdict: 'useful' }, label: 'Turn it on' }, { path: '/gnomon/api/feedback', body: { artifactKind: 'knowledge_entry', artifactId: 'w1', verdict: 'wrong' }, label: 'No' }])
    expect(by['chore:prs']).toEqual([{ path: '/gnomon/api/offer', body: { noticeKey: 'chore:prs' }, label: 'Show me' }, { path: '/gnomon/proposals/answer', body: { kind: 'chore', key: 'prs', verdict: 'dismissed' }, label: 'Not again' }])
    expect(by[`app-note:${NOTE}`].map((a) => a.body)).toEqual([{ kind: 'app-note', key: NOTE, verdict: 'accepted' }, { kind: 'app-note', key: NOTE, verdict: 'dismissed' }])
  })

  it('the new write takes only a proposal on the card', () => {
    expect(proposalAnswer(state(), NOW, { kind: 'chore', key: 'prs', verdict: 'dismissed' })).toEqual({ kind: 'chore', key: 'prs', verdict: 'dismissed' })
    expect(proposalAnswer(state(), NOW, { kind: 'app-note', key: NOTE, verdict: 'accepted' })).toEqual({ kind: 'app-note', key: NOTE, verdict: 'accepted' })
    expect(proposalAnswer(state(), NOW, { kind: 'chore', key: 'tickets', verdict: 'dismissed' }), 'no tickets offer today').toBeNull()
    expect(proposalAnswer(state(), NOW, { kind: 'chore', key: 'prs', verdict: 'accepted' }), 'a chore is accepted by its offer press').toBeNull()
    expect(proposalAnswer(state(), NOW, { kind: 'app-note', key: 'Notes\nsomething else', verdict: 'dismissed' })).toBeNull()
    expect(proposalAnswer(state(), NOW, { kind: 'skill', key: 's1', verdict: 'dismissed' })).toBeNull()
  })
})
