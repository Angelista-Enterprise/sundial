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

  it('run 227 T32: the day line the slip said with no turn is one overlay:day-said row, its line bounded', async () => {
    const line = 'Gnomon did 4 steps in 2 apps today, asked 2 times, you said yes 1.'
    expect(await call(routes, '/gnomon/api/overlay', { body: { type: 'day-said', summonId: 'S-1', line } })).toEqual({ status: 200, out: { recorded: true } })
    expect(appended()).toEqual(['overlay:day-said', { summonId: 'S-1', line }])
    await call(routes, '/gnomon/api/overlay', { body: { type: 'day-said', line: 'x'.repeat(400) } })
    expect(appended()).toEqual(['overlay:day-said', { summonId: '', line: 'x'.repeat(240) }])
    expect((await call(routes, '/gnomon/api/overlay', { body: { type: 'day-said', line: '  ' } })).status).toBe(400)
  })

  it('a resume link opened, and a note', async () => {
    expect((await call(routes, '/gnomon/api/resume', { body: { opened: 'agent' } })).out).toEqual({ opened: 'agent' })
    expect((await call(routes, '/gnomon/api/resume', { body: { note: '  next: BOX-484  ' } })).out).toEqual({ noted: 'next: BOX-484' })
    expect((await call(routes, '/gnomon/api/resume', { body: {} })).status).toBe(400)
  })
})

describe('dropping a route Gnomon learned', async () => {
  const { apply } = await import('../index.js')
  const { ctx, routes } = fakeCtx({ config: { ownerAliases: [] } })
  apply(ctx)
  it('appends one screen:route-dropped with the app and the key, and refuses what is missing or hidden', async () => {
    expect(await call(routes, '/gnomon/api/route-drop', { body: { app: ' Notes ', routeKey: 'make a note' } })).toEqual({ status: 200, out: { dropped: 'make a note', app: 'Notes' } })
    expect(ctx.gnomonKernel.appendSignal.mock.calls.at(-1)).toEqual(['screen:route-dropped', { app: 'Notes', routeKey: 'make a note', by: 'owner' }])
    expect((await call(routes, '/gnomon/api/route-drop', { body: { app: 'Notes' } })).status).toBe(400)
    expect((await call(routes, '/gnomon/api/route-drop', { body: { app: '[private]', routeKey: 'x' } })).status).toBe(400)
    expect((await call(routes, '/gnomon/api/route-drop', { method: 'GET' })).status).toBe(405)
  })
  it('the read and the drop both sit behind the fence', async () => {
    const fenced = fakeCtx({ config: { ownerAliases: [] } })
    fenced.ctx.connection = { requestRejection: () => 401 }
    apply(fenced.ctx)
    for (const path of ['/gnomon/api/routes', '/gnomon/api/route-drop']) {
      let status = 0
      await fenced.routes.get(path).handler({ method: 'POST', url: path, headers: {} }, { writeHead: (s) => (status = s), end: () => {} })
      expect(status, path).toBe(401)
    }
    expect(fenced.ctx.gnomonKernel.appendSignal).not.toHaveBeenCalled()
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
  it('take the MCP server\'s answer write through the same handler the tap uses', async () => {
    const { answerWrite } = await import('./api-writes.js')
    expect(await answerWrite(ctx, { askId: ' a2 ', answer: ' Mira Bakker ' })).toEqual({ recorded: true, askId: 'a2' })
    expect(ctx.gnomonKernel.appendSignal.mock.calls.at(-1)).toEqual(['ask:owner-answered', { askId: 'a2', answer: 'Mira Bakker' }])
    expect(await answerWrite(ctx, { askId: 'a3' })).toBe('An answer needs both an askId and an answer.')
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

describe("the owner host's rule writes (MCP, observatory §5)", async () => {
  const { adoptWrite, answerWrite, ingestWrite, revokeWrite, ruleOpWrite, ruleVerdictWrite } = await import('./api-writes.js')
  const spec = { title: 'Slack burst', when: { type: 'window:changed' }, say: 'x' }
  const kernel = (watch) => ({ gnomonKernel: { getState: () => ({ watch }), appendSignal: vi.fn(async () => {}) } })

  it('adopt checks the spec again and appends rule:adopted with via mcp-owner, the flow and the predicted rate', async () => {
    const ctx = kernel({ rules: [], runtime: {} })
    expect(await adoptWrite(ctx, { rule: spec, predicted: { fired: 3, days: 30, heard: 2 }, flow: { id: 'Commit Flow', title: 'Commit, published', step: 1 }, host: 'observatory' })).toEqual({ adopted: 'slack-burst' })
    expect(ctx.gnomonKernel.appendSignal.mock.calls[0]).toEqual(['rule:adopted', { rule: expect.objectContaining({ id: 'slack-burst' }), predicted: { fired: 3, days: 30, heard: 2 }, via: 'mcp-owner', flow: { id: 'commit-flow', title: 'Commit, published', step: 1 } }])
    expect(typeof (await adoptWrite(ctx, { rule: { title: 'x' } }))).toBe('string')
    expect(typeof (await adoptWrite(ctx, { rule: spec, flow: { id: 'f' } }))).toBe('string')
    expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalledTimes(1)
  })

  it('drop names one rule or every rule of a flow, and refuses what is not there', async () => {
    const watch = { rules: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], runtime: {}, stats: { a: { flow: { id: 'f1' } }, b: { flow: { id: 'f1' } } } }
    const ctx = kernel(watch)
    expect(await ruleOpWrite(ctx, 'dropped', { flow: 'f1' })).toEqual({ dropped: ['a', 'b'] })
    expect(await ruleOpWrite(ctx, 'dropped', { id: 'c' })).toEqual({ dropped: ['c'] })
    expect(await ruleOpWrite(ctx, 'dropped', { id: 'zz' })).toBe('No such rule or flow.')
    expect(ctx.gnomonKernel.appendSignal.mock.calls.map((c) => c[1].id)).toEqual(['a', 'b', 'c'])
    expect(ctx.gnomonKernel.appendSignal.mock.calls[0]).toEqual(['rule:dropped', { id: 'a', by: 'owner', via: 'mcp-owner' }])
  })

  it('adopt refuses a reach the action gate does not know (§3), and revoke only a reach run alone', async () => {
    const ctx = kernel({ rules: [], runtime: {}, stats: { p: { reach: { gnomon_calendar_create: { approvals: 5, auto: true } } } } })
    expect(await adoptWrite(ctx, { rule: { ...spec, do: [{ reach: { tool: 'mcp__nowhere__send', brief: 'b' } }] } })).toContain('not a tool the action gate knows')
    expect(await revokeWrite(ctx, { id: 'p', tool: 'gnomon_reminder_create' })).toBe('That rule does not run that reach alone.')
    expect(await revokeWrite(ctx, { id: 'p', tool: 'gnomon_calendar_create' })).toEqual({ revoked: { id: 'p', tool: 'gnomon_calendar_create' } })
    expect(ctx.gnomonKernel.appendSignal.mock.calls).toEqual([['rule:auto-revoked', { id: 'p', tool: 'gnomon_calendar_create', by: 'owner', via: 'mcp-owner' }]])
  })

  it('an inlet event is checked against inlets.json again and appended like a sensor row (§4)', async () => {
    const ctx = kernel({ rules: [], runtime: {} })
    const inlets = { 'ext:deploy': { fields: { service: 'string' } } }
    expect(await ingestWrite(ctx, { type: 'ext:deploy', payload: { service: 'api', extra: 1 } }, inlets)).toEqual({ ingested: 'ext:deploy' })
    expect(await ingestWrite(ctx, { type: 'ext:other', payload: {} }, inlets)).toContain('not declared')
    expect(ctx.gnomonKernel.appendSignal.mock.calls).toEqual([['ext:deploy', { service: 'api' }]])
  })

  it('a verdict on one fire is appended for an adopted rule only (§6)', async () => {
    const ctx = kernel({ rules: [{ id: 'a' }], runtime: {} })
    expect(await ruleVerdictWrite(ctx, { id: 'a', fireId: 'ev1', useful: true })).toEqual({ recorded: true, id: 'a', fireId: 'ev1' })
    expect(typeof (await ruleVerdictWrite(ctx, { id: 'b', fireId: 'ev1', useful: true }))).toBe('string')
    expect(typeof (await ruleVerdictWrite(ctx, { id: 'a', fireId: 'ev1', useful: 'yes' }))).toBe('string')
    expect(ctx.gnomonKernel.appendSignal.mock.calls).toEqual([['rule:verdict', { id: 'a', fireId: 'ev1', useful: true, by: 'owner' }]])
  })

  it("an answer to a watch rule's ask names the rule (§1)", async () => {
    const ctx = kernel({ rules: [], runtime: {} })
    await answerWrite(ctx, { askId: 'owner-ask:watch-ask-me-0a1b2c3d-2026-10-20T15:30', answer: 'Yes' })
    expect(ctx.gnomonKernel.appendSignal.mock.calls[0]).toEqual(['ask:owner-answered', { askId: 'owner-ask:watch-ask-me-0a1b2c3d-2026-10-20T15:30', answer: 'Yes', rule: 'ask-me' }])
  })
})
