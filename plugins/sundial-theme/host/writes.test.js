// The owner's writes through post(): the method, the bounded body, what is missing, what is appended.
import { describe, expect, it, vi } from 'vitest'
import { fakeCtx } from './mount.test.js'

async function call(routes, path, { method = 'POST', body } = {}) {
  const req = Object.assign((async function* () { if (body !== undefined) yield JSON.stringify(body) })(), { method, url: path, headers: {} })
  let status = 0
  let out = null
  await routes.get(path).handler(req, { headersSent: false, writeHead: (s) => (status = s), end: (t) => (out = JSON.parse(t)) })
  return { status, out }
}

describe('owner writes', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const { apply } = await import('../index.js')
  const state = { config: { ownerAliases: ['Mira Bakker', 'mira'] }, board: null }
  const { ctx, routes } = fakeCtx(state)
  apply(ctx)
  const appended = () => ctx.gnomonKernel.appendSignal.mock.calls.at(-1)

  it('a verdict: 405 for a GET, 400 with what is missing, else one feedback:verdict', async () => {
    expect(await call(routes, '/gnomon/api/feedback', { method: 'GET' })).toEqual({ status: 405, out: { unavailable: 'A verdict takes a POST.' } })
    expect((await call(routes, '/gnomon/api/feedback', { body: { artifactKind: 'notice' } })).status).toBe(400)
    expect(await call(routes, '/gnomon/api/feedback', { body: { artifactKind: 'notice', artifactId: 'k1', verdict: 'useful' } })).toEqual({ status: 200, out: { recorded: true, artifactKind: 'notice', artifactId: 'k1', verdict: 'useful' } })
    expect(appended()).toEqual(['feedback:verdict', { artifactKind: 'notice', artifactId: 'k1', verdict: 'useful' }])
    await call(routes, '/gnomon/api/feedback', { body: { seen: true, artifactKind: 'notice', artifactId: 'k1' } })
    expect(appended()).toEqual(['notice:seen', { noticeKey: 'k1', surface: 'page' }])
  })

  it('an assertion about the owner lands on the owner entity', async () => {
    const r = await call(routes, '/gnomon/api/assert', { body: { entityKind: 'person', canonicalName: 'mira', predicate: 'worksOn', object: 'puzzlebox-studio' } })
    expect(r.out).toMatchObject({ offered: true, triple: 'Mira Bakker worksOn puzzlebox-studio' })
    expect(appended()[1]).toMatchObject({ entityKind: 'owner', canonicalName: 'Mira Bakker', provenance: 'assertion', confidence: 100 })
  })

  it('a resume link opened, and a note', async () => {
    expect((await call(routes, '/gnomon/api/resume', { body: { opened: 'agent' } })).out).toEqual({ opened: 'agent' })
    expect((await call(routes, '/gnomon/api/resume', { body: { note: '  next: BOX-484  ' } })).out).toEqual({ noted: 'next: BOX-484' })
    expect((await call(routes, '/gnomon/api/resume', { body: {} })).status).toBe(400)
  })
})

describe('answers, verdicts and names', async () => {
  const { apply } = await import('../index.js')
  const { ctx, routes } = fakeCtx({ config: { ownerAliases: [] } })
  apply(ctx)
  it('keep their messages and signals', async () => {
    expect((await call(routes, '/gnomon/ask/answer', { body: { askId: 'a1', answer: 'yes' } })).out).toEqual({ recorded: true, askId: 'a1' })
    expect(await call(routes, '/gnomon/ask/answer', { body: { askId: 'a1', answer: 'x'.repeat(9000) } })).toEqual({ status: 413, out: { unavailable: 'That answer is too long for a tap — say it in the chat.' } })
    expect((await call(routes, '/gnomon/people/name', { body: { alias: 'person-0a1b2c3d4e', name: 'in which meeting?' } })).out).toEqual({ unavailable: 'That does not read like a name.' })
    expect((await call(routes, '/gnomon/assistant/verdict', { body: { proposalId: 'p1', verdict: 'accepted' } })).out).toEqual({ recorded: true, proposalId: 'p1', verdict: 'accepted' })
    expect(ctx.gnomonKernel.appendSignal.mock.calls.map(([t]) => t)).toEqual(['ask:owner-answered', 'assistant:response'])
  })
})

describe('the conversation\'s small posts', async () => {
  const { apply } = await import('../index.js')
  const { ctx, routes } = fakeCtx({ config: { ownerAliases: [] } })
  apply(ctx)
  it('answer 404 for what no longer waits, and a stale approval is inert', async () => {
    expect(await call(routes, '/gnomon/api/tool/stop', { body: { callId: 'c1' } })).toEqual({ status: 404, out: { unavailable: 'That call is no longer running.' } })
    expect(await call(routes, '/gnomon/api/question', { body: { sessionId: 's1', answers: [] } })).toEqual({ status: 404, out: { unavailable: 'That question is no longer waiting.' } })
    expect(await call(routes, '/gnomon/api/approve', { body: { id: 'r1', outcome: 'allowed-once' } })).toEqual({ status: 200, out: { answered: false } })
    expect(await call(routes, '/gnomon/api/work/stop', { body: {} })).toEqual({ status: 400, out: { unavailable: 'Which job?' } })
    expect(await call(routes, '/gnomon/api/work/stop', { method: 'GET' })).toEqual({ status: 405, out: { unavailable: 'Stopping takes a POST.' } })
  })
})
