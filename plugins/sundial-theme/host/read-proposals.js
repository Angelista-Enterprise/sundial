// Set 5 R3: what Gnomon's learners put to the owner (`readProposals`), each with the two routes that answer it.
// Every answer goes through a route that already wrote it before this card: a skill through the assistant verdict,
// a review's fix through the shelf's feedback, a chore offer through the slip's offer press. Only a "not again" on a
// chore and an app note's keep or drop are new, and they are one signal (`/gnomon/proposals/answer`).
import { readProposals } from '@sundial/kernel/read/proposals.js'

const own = (kind, key, verdict) => ({ path: '/gnomon/proposals/answer', body: { kind, key, verdict } })

/** The accept and dismiss of one proposal: a route and its body, and the words on the two buttons. */
function answers(p) {
  switch (p.via) {
    case 'skill':
      return { accept: { path: '/gnomon/assistant/verdict', body: { proposalId: p.id, verdict: 'accepted' }, label: 'Keep as a skill' }, dismiss: { path: '/gnomon/assistant/verdict', body: { proposalId: p.id, verdict: 'rejected' }, label: 'No' } }
    case 'review':
      return { accept: { path: '/gnomon/api/feedback', body: { artifactKind: 'knowledge_entry', artifactId: p.id, verdict: 'useful' }, label: p.kind === 'fact' ? 'Record it' : p.kind === 'app-note' ? 'Add the note' : p.kind === 'rule' ? 'Turn it on' : 'Drop it' }, dismiss: { path: '/gnomon/api/feedback', body: { artifactKind: 'knowledge_entry', artifactId: p.id, verdict: 'wrong' }, label: 'No' } }
    case 'chore':
      return { accept: { path: '/gnomon/api/offer', body: { noticeKey: p.key }, label: 'Show me' }, dismiss: { ...own('chore', p.key.replace(/^chore:/, ''), 'dismissed'), label: 'Not again' } }
    case 'app-note':
      return { accept: { ...own('app-note', p.key, 'accepted'), label: 'Keep' }, dismiss: { ...own('app-note', p.key, 'dismissed'), label: 'Drop' } }
  }
}

export function readProposalsView({ state, now }) {
  const { items, trustN } = readProposals(state, new Date(now).toISOString())
  return { items: items.map((p) => ({ ...p, ...answers(p) })), trustN }
}

/** The one new write: a "not again" on a chore offer, or the owner's keep or drop of an app note in use. Null when it is no proposal on the card. */
export function proposalAnswer(state, now, body) {
  const kind = body?.kind
  const key = typeof body?.key === 'string' ? body.key : ''
  const verdict = body?.verdict === 'accepted' ? 'accepted' : body?.verdict === 'dismissed' ? 'dismissed' : null
  if (verdict === null || (kind !== 'chore' && kind !== 'app-note')) return null
  const { items } = readProposals(state, new Date(now).toISOString())
  const known = items.some((p) => (kind === 'chore' ? p.via === 'chore' && p.key === `chore:${key}` && verdict === 'dismissed' : p.via === 'app-note' && p.key === key))
  return known ? { kind, key, verdict } : null
}
