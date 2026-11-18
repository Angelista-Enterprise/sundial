// @vitest-environment jsdom
// Set 5 R3: "Gnomon proposes" on Left for you. Every value is made up.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { learnedSection } from './view-proposals.js'

const item = (over = {}) => ({
  id: 's1',
  kind: 'skill',
  title: 'Keep "play the album" in Spotify as a skill?',
  evidence: 'It ran clean 3 times on 2 days, with no failed step.',
  n: 3,
  accept: { path: '/gnomon/assistant/verdict', body: { proposalId: 's1', verdict: 'accepted' }, label: 'Keep as a skill' },
  dismiss: { path: '/gnomon/assistant/verdict', body: { proposalId: 's1', verdict: 'rejected' }, label: 'No' },
  ...over,
})

describe('learnedSection', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows nothing when nothing is proposed', () => {
    expect(learnedSection({ items: [] })).toBeNull()
    expect(learnedSection(null)).toBeNull()
  })

  it('says each proposal, what it stands on with its n, and says a bar under n 20 is not trusted yet', () => {
    const node = learnedSection({ items: [item(), item({ id: 'c1', kind: 'chore', n: 24, evidence: 'A chore.' })], trustN: 20 })
    const notes = [...node.querySelectorAll('article .panel-note')].map((p) => p.textContent)
    expect(notes).toEqual(['It ran clean 3 times on 2 days, with no failed step. (n 3, too few to trust the bar yet)', 'A chore. (n 24)'])
    expect([...node.querySelectorAll('article')[0].querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Keep as a skill', 'No'])
  })

  it('an answer posts the body the host named to the route it named, and settles into one line', async () => {
    const fetch = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    const node = learnedSection({ items: [item()] })
    node.querySelectorAll('button')[1].click()
    await vi.waitFor(() => expect(node.querySelector('.proposal-chips').textContent).toBe('Noted; it will not come back.'))
    expect(fetch).toHaveBeenCalledWith('/gnomon/assistant/verdict', expect.objectContaining({ method: 'POST', body: JSON.stringify({ proposalId: 's1', verdict: 'rejected' }) }))
  })
})
