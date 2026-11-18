// The frame critic's route: a JPEG frame to Jev through judgeNow, with the image as an asset; nothing without Jev.
import { describe, expect, it, vi } from 'vitest'
import { mountNodus, jpegOf } from './api-nodus.js'

const JPEG = `data:image/jpeg;base64,${'A'.repeat(400)}`

function mounted(judgeNow) {
  const routes = new Map()
  const ctx = { effect: (fn) => fn(), webServer: { register: (r) => routes.set(r.path, r) }, connection: { requestRejection: () => undefined }, gnomonKernel: { judgeNow } }
  mountNodus(ctx)
  return async (body, method = 'POST') => {
    const req = Object.assign((async function* () { yield JSON.stringify(body) })(), { method, url: '/gnomon/api/nodus-frame', headers: {} })
    let status = 0
    let out = null
    await routes.get('/gnomon/api/nodus-frame').handler(req, { headersSent: false, writeHead: (s) => (status = s), end: (t) => (out = JSON.parse(t)) })
    return { status, out }
  }
}

describe('the frame critic route', () => {
  it('sends the frame to Jev as an image asset under nodus.frame.v1 and answers the score and legibility', async () => {
    const judgeNow = vi.fn(async () => ({ answers: { shows_intent: { score: 2.34 }, legible: { noul: 0.81 } }, model: 'jev' }))
    const call = mounted(judgeNow)
    const r = await call({ jpeg: JPEG, ask: 'How does a heat pump work', title: 'A heat pump', step: 'The compressor.', parts: ['Compressor', 'Coil'] })
    expect(r).toEqual({ status: 200, out: { shows_intent: 2.34, legible: 0.81 } })
    const [opts] = judgeNow.mock.calls[0]
    expect(opts).toMatchObject({ purpose: 'judge', questionSetId: 'nodus.frame.v1', momentId: null, caller: 'nodus-frame', state: { frame: 'frame-1', ask: 'How does a heat pump work', parts: ['Compressor', 'Coil'] } })
    expect(Object.keys(opts.questions)).toEqual(['shows_intent', 'legible'])
    expect(opts.questions.shows_intent.criteria).toHaveLength(4)
    expect(opts.questions.legible.type).toBe('noul')
    expect(opts.assets['frame-1']).toEqual({ type: 'image', data_base64: 'A'.repeat(400), format: 'jpeg' })
  })

  it('says unavailable when Jev does not judge (off, out of budget), and refuses what is not a JPEG', async () => {
    expect((await mounted(async () => null)({ jpeg: JPEG })).out).toEqual({ unavailable: 'Jev did not judge this frame.' })
    const judgeNow = vi.fn()
    const call = mounted(judgeNow)
    expect((await call({ jpeg: 'data:image/png;base64,AAAA' })).status).toBe(400)
    expect((await call({ jpeg: JPEG }, 'GET')).status).toBe(405)
    expect(judgeNow).not.toHaveBeenCalled()
    expect(jpegOf('data:image/jpeg;base64,abc')).toBeNull()
  })
})
